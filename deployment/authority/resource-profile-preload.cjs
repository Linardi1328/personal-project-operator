// Explicit disposable profiler only; never loaded by normal application code.
const fs = require('node:fs')
const path = require('node:path')
const output = process.env.PPO_LAB_NODE_PROFILE
if (process.env.CI !== 'true' || !output || !/^node-peaks\.jsonl$/.test(path.basename(output))) {
  throw Error('Disposable resource profiler required')
}
process.on('exit', () => {
  const row = JSON.stringify({pid: process.pid, parentPid: process.ppid,
    peakRssKiB: process.resourceUsage().maxRSS, finalMemoryBytes: process.memoryUsage()}) + '\n'
  try {
    if (fs.statSync(output).size + Buffer.byteLength(row) > 65536) throw Error('profile output bound')
    fs.appendFileSync(output, row)
  } catch { process.stderr.write('NODE_RESOURCE_PROFILE_INCOMPLETE\n') }
})
