import {spawn, execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp, writeFile, readFile, appendFile, stat} from 'node:fs/promises'
import {tmpdir, arch, platform} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

// Opt-in baseline instrumentation of the SAME synthetic suite. It creates and
// destroys its own network-none database, never accepts a DSN or container ID.
if ((process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--baseline-2g')) || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' ||
    !/^[0-9]+$/.test(process.env.GITHUB_RUN_ID || '') || !/^[0-9]+$/.test(process.env.GITHUB_RUN_ATTEMPT || '')) {
  throw Error('Explicit disposable CI profile required')
}
const root = fileURLToPath(new URL('../../', import.meta.url))
const run = promisify(execFile)
const command = async (cmd, args, maxBuffer = 65536) =>
  (await run(cmd, args, {cwd: root, timeout: 10000, maxBuffer, encoding: 'utf8'})).stdout.trim()
const output = await mkdtemp(join(tmpdir(), 'ppo-resource-profile-'))
const peaks = join(output, 'node-peaks.jsonl'), samples = join(output, 'database-samples.jsonl')
const log = join(output, 'integration.log')
const memoryLimit = process.argv[2] === '--baseline-2g' ? 2147483648 : 536870912
await Promise.all([peaks, samples, log].map(p => writeFile(p, '', {mode: 0o600})))
const name = `ppo-authority-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
const report = {scope: 'instrumented-synthetic-baseline-only', productionQualified: false,
  commit: await command('git', ['rev-parse', 'HEAD']), platform: platform(), architecture: arch(),
  node: process.version,
  limits: {containerMemoryBytes: memoryLimit, cpus: 2, maxConnections: 16,
    statementMs: 15000, largeSnapshotStatementMs: 45000, profileWallMs: 1200000,
    sampleIntervalMs: 5000, maxSampleBytes: 2097152, maxLogBytes: 33554432},
  gaps: ['Instrumented suite is not an exhaustive worst-case retention/concurrency matrix.',
    'Cgroup memory peak includes page cache and observer clients, not PostgreSQL process RSS.',
    'Samples can miss short lock waits and transient disk use.',
    'No production operating budget is established by this baseline.']}
const sampleSql = `SET statement_timeout='1s'; SET lock_timeout='100ms';
SELECT json_build_object('at',clock_timestamp(),'databaseBytes',pg_database_size(current_database()),
'tempBytes',(SELECT temp_bytes FROM pg_stat_database WHERE datname=current_database()),
'tempFiles',(SELECT temp_files FROM pg_stat_database WHERE datname=current_database()),
'walBytes',(SELECT wal_bytes::text FROM pg_stat_wal),
'walStatsReset',(SELECT stats_reset FROM pg_stat_wal),
'walDirectoryBytes',(SELECT coalesce(sum(size),0) FROM pg_ls_waldir()),
'backends',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()),
'lockWaiters',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'),
'longestTransactionMs',(SELECT coalesce(max(extract(epoch FROM clock_timestamp()-xact_start)*1000),0) FROM pg_stat_activity WHERE datname=current_database()));`
let id, child, childExit, timer, stopping = false, sampleBytes = 0, logBytes = 0, logWrites = Promise.resolve()
let sampleCount = 0, observerErrors = 0
function stop(reason) {
  stopping = true
  if (reason && !report.stopReason) report.stopReason = String(reason).slice(0, 200)
  if (child && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 2000)
    kill.unref()
  }
}
process.once('SIGTERM', () => stop('SIGTERM'))
process.once('SIGINT', () => stop('SIGINT'))
const start = performance.now()
timer = setTimeout(() => stop('Whole profile deadline'), report.limits.profileWallMs)
try {
  id = await command('docker', ['run', '-d', '--network', 'none', '--name', name,
    '--memory', String(memoryLimit), '--cpus', '2', '-e', 'POSTGRES_DB=ppo_authority_ci',
    '-e', 'POSTGRES_PASSWORD=disposable-ci-only-not-a-secret', 'postgres:16',
    '-c', 'max_connections=16', '-c', 'shared_buffers=32MB', '-c', 'work_mem=4MB',
    '-c', 'maintenance_work_mem=32MB', '-c', 'track_io_timing=on'])
  report.containerId = id
  if (stopping) throw Error('Profile stopped during container startup')
  report.image = await command('docker', ['image', 'inspect', 'postgres:16', '--format', '{{json .RepoDigests}}'])
  let ready = false
  for (let i = 0; i < 60 && !stopping; i++) {
    try { ready = await command('docker', ['exec', id, 'psql', '-XqAt', '-U', 'postgres', '-d', 'ppo_authority_ci', '-c', 'SELECT 1']) === '1' } catch {}
    if (ready) break
    await new Promise(r => setTimeout(r, 1000))
  }
  if (!ready) throw Error('Owned disposable database unavailable')
  report.postgres = await command('docker', ['exec', id, 'psql', '-XqAt', '-U', 'postgres', '-d', 'ppo_authority_ci', '-c', 'SELECT version()'])
  if (stopping) throw Error('Profile stopped before suite startup')
  child = spawn(process.execPath, ['--require', fileURLToPath(new URL('../authority/resource-profile-preload.cjs', import.meta.url)),
    '--test', 'deployment/authority/phase1gb2-canonical-postgres.integration.mjs'],
    {cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env,
      NODE_OPTIONS: '', PPO_AUTHORITY_TEST_CONTAINER: name, PPO_LAB_NODE_PROFILE: peaks}})
  let spawnError
  const exited = childExit = new Promise(resolve => {
    child.once('error', error => {spawnError = error.message.slice(0, 200); stop('Node spawn failed')})
    child.once('close', (code, signal) => resolve({code, signal, ...(spawnError ? {spawnError} : {})}))
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    logBytes += chunk.length
    if (logBytes > report.limits.maxLogBytes) {stop('Integration log bound'); return}
    logWrites = logWrites.then(() => appendFile(log, chunk)).catch(error => stop('Integration log write: ' + error.code))
  })
  while (child.exitCode === null && child.signalCode === null && !stopping) {
    try {
      const [database, memory, memoryEvents] = await Promise.all([
        command('docker', ['exec', id, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'ppo_authority_ci', '-c', sampleSql]),
        command('docker', ['exec', id, 'sh', '-c', 'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes']),
        command('docker', ['exec', id, 'cat', '/sys/fs/cgroup/memory.events'])])
      const memoryBytes = Number(memory)
      if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) throw Error('Invalid cgroup memory sample')
      const events = Object.fromEntries(memoryEvents.split('\n').map(line => {
        const [key, count] = line.split(' ')
        if (!/^[a-z_]+$/.test(key) || !/^[0-9]+$/.test(count)) throw Error('Invalid memory event sample')
        return [key, count]
      }))
      const row = JSON.stringify({database: JSON.parse(database), cgroupPeakBytes: memoryBytes, memoryEvents: events}) + '\n'
      sampleBytes += Buffer.byteLength(row)
      if (sampleBytes > report.limits.maxSampleBytes) {stop('Sample output bound'); throw Error('Sample output bound')}
      await appendFile(samples, row); sampleCount++
    } catch { observerErrors++ }
    await Promise.race([exited, new Promise(r => setTimeout(r, report.limits.sampleIntervalMs))])
  }
  report.testExit = await exited
  await logWrites
  report.wallMs = Math.round(performance.now() - start)
  report.sampleCount = sampleCount; report.observerErrors = observerErrors
  report.nodeProcesses = (await readFile(peaks, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  report.nodeMaxRssKiB = Math.max(0, ...report.nodeProcesses.map(p => p.peakRssKiB))
  const observed = (await readFile(samples, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  report.sampledMaxima = Object.fromEntries(['databaseBytes', 'tempBytes', 'tempFiles', 'walDirectoryBytes', 'backends', 'lockWaiters', 'longestTransactionMs']
    .map(key => [key, Math.max(0, ...observed.map(row => Number(row.database[key])))]))
  report.sampledMaxima.cgroupPeakBytes = Math.max(0, ...observed.map(row => row.cgroupPeakBytes))
  report.sampledMaxima.walBytes = observed.reduce((max, row) => BigInt(row.database.walBytes) > BigInt(max) ? row.database.walBytes : max, '0')
  report.memoryEventMaxima = Object.fromEntries([...new Set(observed.flatMap(row => Object.keys(row.memoryEvents)))].map(key =>
    [key, observed.reduce((max, row) => BigInt(row.memoryEvents[key] || 0) > BigInt(max) ? row.memoryEvents[key] : max, '0')]))
  report.logBytes = (await stat(log)).size
  report.measurementComplete = report.testExit.code === 0 && !stopping && sampleCount > 0 &&
    report.nodeProcesses.length > 0 && !(await readFile(log, 'utf8')).includes('NODE_RESOURCE_PROFILE_INCOMPLETE')
  if (!report.measurementComplete) process.exitCode = 1
} catch (error) {report.error = error.message.slice(0, 300); process.exitCode = 1; stop()}
finally {
  clearTimeout(timer)
  report.wallMs = Math.round(performance.now() - start)
  if (childExit) {stop(); await childExit; await logWrites}
  if (id) try {
    const server = await run('docker', ['logs', '--tail', '150', id], {cwd: root, timeout: 10000, maxBuffer: 1048576, encoding: 'utf8'})
    const contents = server.stdout + server.stderr
    report.serverLogBytes = Buffer.byteLength(contents)
    await writeFile(join(output, 'postgres.log'), contents, {mode: 0o600})
  } catch (error) {report.serverLogUnavailable = true; report.serverLogUnavailableReason = String(error.code || error.name).slice(0, 100)}
  if (id) try { await command('docker', ['rm', '-fv', id]) } catch {report.cleanupFailed = true; process.exitCode = 1}
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600})
  process.stdout.write(JSON.stringify({output, complete: report.measurementComplete === true}) + '\n')
}
