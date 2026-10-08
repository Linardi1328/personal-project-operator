import assert from "node:assert/strict"
import fs, { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile, stat } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createDevelopmentRun, createPersonalProjectOperatorSelfDevelopmentRun,
  inspectDevelopmentRunReadOnly, transitionDevelopmentRun } from "./development-run-state.mjs"
import { listDevelopmentRunSummaries, diagnoseDevelopmentRunCatalog,
  MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED } from "./development-run-catalog.mjs"
import { assessSoftwareFactoryAdmission } from "./software-factory-admission.mjs"
import { createSoftwareFactoryManagerCycle } from "./software-factory-manager-cycle.mjs"
import { createSoftwareFactoryQueueDrainer } from "./software-factory-queue-drain.mjs"
import { createSoftwareFactoryAutonomousRunner } from "./software-factory-autonomous-run.mjs"

async function fixture(t, self = false) {
  const root = await mkdtemp(join(tmpdir(), "ppo-ric59-review-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { writeDataDir: root }
  const input = { task: "Synthetic review fixture", baseSha: "a".repeat(40) }
  const record = self ? await createPersonalProjectOperatorSelfDevelopmentRun(input, options)
    : await createDevelopmentRun({ ...input, projectId: "khlim-assist" }, options)
  return { root, options, record, records: join(root, "development-runs", "records"),
    canonical: join(root, "development-runs", "records", `${record.runId}.json`),
    versions: join(root, "development-runs", "versions"),
    versionDir: join(root, "development-runs", "versions", record.runId) }
}
async function assertBlocked(catalog) {
  let effects = 0
  const forbidden = async () => { effects++; throw new Error("unexpected side effect") }
  assert.throws(() => assessSoftwareFactoryAdmission("kynexa", catalog))
  const deps = { listRuns: async () => catalog, runFactory: forbidden, drainQueue: forbidden,
    readDisposition: forbidden, recordDisposition: forbidden, claim: forbidden, intake: forbidden,
    readRun: forbidden, continueRun: forbidden,
    listQueue: async () => [{ queueId: "pending", projectId: "kynexa", claimed: false }] }
  await assert.rejects(createSoftwareFactoryManagerCycle(deps)())
  await assert.rejects(createSoftwareFactoryQueueDrainer(deps)())
  await assert.rejects(createSoftwareFactoryAutonomousRunner(deps)("A".repeat(43)))
  assert.equal(effects, 0)
}

for (const terminal of [false, true]) {
  test(`marker-only ${terminal ? "terminal" : "active"} run blocks every factory path`, async t => {
    const f = await fixture(t)
    if (terminal) await transitionDevelopmentRun(f.record.runId, { expectedVersion: 0, status: "cancelled" }, f.options)
    await unlink(f.canonical)
    assert.deepEqual(await readdir(f.records), [])
    const snapshot = await inspectDevelopmentRunReadOnly(f.record.runId, f.options)
    assert.equal(snapshot.canonicalState, "canonical_missing")
    const catalog = await listDevelopmentRunSummaries(f.options)
    assert.equal(catalog.ok, false)
    assert.equal(catalog.code, "canonical_missing")
    assert.equal(catalog.diagnostics.scanned, 1)
    await assertBlocked(catalog)
    const diagnosis = await diagnoseDevelopmentRunCatalog(f.options)
    assert.deepEqual(diagnosis.failures, [{ runId: f.record.runId, code: "canonical_missing" }])
    await assert.rejects(stat(f.canonical), { code: "ENOENT" })
  })
}

for (const kind of ["empty", "malformed", "wrong-version", "symlink", "non-directory"]) {
  test(`marker-only ${kind} metadata cannot certify an empty catalog`, async t => {
    const f = await fixture(t)
    await unlink(f.canonical)
    const marker = join(f.versionDir, "000000.json")
    if (kind === "empty") await unlink(marker)
    if (kind === "malformed") await writeFile(marker, "SENSITIVE_TEST_SENTINEL")
    if (kind === "wrong-version") await fs.rename(marker, join(f.versionDir, "000001.json"))
    if (kind === "symlink" || kind === "non-directory") {
      await rm(f.versionDir, { recursive: true })
      if (kind === "symlink") await symlink(f.records, f.versionDir)
      else await writeFile(f.versionDir, "SENSITIVE_TEST_SENTINEL")
    }
    const catalog = await listDevelopmentRunSummaries(f.options)
    await assertBlocked(catalog)
    assert.equal(JSON.stringify(catalog).includes("SENSITIVE_TEST_SENTINEL"), false)
    assert.equal((await diagnoseDevelopmentRunCatalog(f.options)).ok, false)
  })
}

test("conflicting canonical/version records remain invalid", async t => {
  const f = await fixture(t)
  const other = await createDevelopmentRun({ projectId: "khlim-assist", task: "Conflict", baseSha: "b".repeat(40) }, f.options)
  const payload = JSON.parse(await readFile(join(f.versions, other.runId, "000000.json"), "utf8"))
  payload.runId = f.record.runId // synthetic internally valid but different history
  await writeFile(join(f.versionDir, "000000.json"), JSON.stringify(payload))
  const catalog = await listDevelopmentRunSummaries(f.options)
  assert.equal(catalog.diagnostics.invalid, 1)
  await assertBlocked(catalog)
})

test("healthy canonical and marker discovery deduplicates the run", async t => {
  const f = await fixture(t)
  const catalog = await listDevelopmentRunSummaries(f.options)
  assert.equal(catalog.ok, true)
  assert.equal(catalog.diagnostics.scanned, 1)
  assert.equal(catalog.summaries.length, 1)
  assert.equal(assessSoftwareFactoryAdmission("kynexa", catalog).ok, true)
})

for (const markerOnly of [false, true]) {
  test(`valid self-development remains out of ordinary scope (marker-only=${markerOnly})`, async t => {
    const f = await fixture(t, true)
    if (markerOnly) await unlink(f.canonical)
    const catalog = await listDevelopmentRunSummaries(f.options)
    assert.equal(catalog.ok, true)
    assert.equal(catalog.diagnostics.outOfScope, 1)
    assert.equal(catalog.diagnostics.invalid, 0)
    assert.equal(catalog.summaries.length, 0)
    assert.equal(assessSoftwareFactoryAdmission("kynexa", catalog).ok, true)
  })
}

test("discovery rejects concurrent additions to the version directory", async t => {
  const f = await fixture(t)
  const original = fs.readdir
  t.mock.method(fs, "readdir", async (...args) => {
    const entries = await original(...args)
    if (args[0] === f.versions) await mkdir(join(f.versions, "Z".repeat(43)), { recursive: true })
    return entries
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const catalog = await listDevelopmentRunSummaries(f.options)
  assert.equal(catalog.ok, false)
  assert.equal(catalog.code, "stale_observation")
  await assertBlocked(catalog)
})

test("union discovery retains the inspection bound", async t => {
  const f = await fixture(t)
  for (let i = 1; i <= MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED; i++) {
    await createDevelopmentRun({ projectId: "khlim-assist", task: "Bounded scan", baseSha: "a".repeat(40) },
      { ...f.options, randomBytesImpl: size => Buffer.alloc(size, i) })
  }
  const catalog = await listDevelopmentRunSummaries(f.options)
  assert.equal(catalog.diagnostics.scanned, MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED)
  assert.equal(catalog.diagnostics.truncated, true)
  await assertBlocked(catalog)
})

// Execute the documented block itself with synthetic paths, not a copied check.
const runbook = await readFile(new URL("./ric-59-owner-runbook.md", import.meta.url), "utf8")
const backupBlock = [...runbook.matchAll(/```bash\n([\s\S]*?)```/gu)]
  .map(match => match[1]).find(block => block.startsWith(': "${PPO_WRITE_DATA_DIR:'))
assert.ok(backupBlock)
for (const source of [undefined, "", "relative-store", "./relative-store", "../relative-store"]) {
  test(`runbook rejects ${JSON.stringify(source)} before backup operations`, async t => {
    const f = await fixture(t)
    await mkdir(join(f.root, "relative-store", "development-runs", "records"), { recursive: true })
    const env = { ...process.env }
    delete env.PPO_WRITE_DATA_DIR
    if (source !== undefined) env.PPO_WRITE_DATA_DIR = source
    const result = spawnSync("/bin/bash", ["-c", `mktemp() { echo UNEXPECTED_BACKUP; return 1; }\ncp() { echo UNEXPECTED_COPY; return 1; }\n${backupBlock}`],
      { cwd: f.root, env, encoding: "utf8" })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /UNEXPECTED/u)
    assert.deepEqual(await readdir(join(f.root, "relative-store")), ["development-runs"])
  })
}

test("runbook accepts an absolute path with spaces and keeps the backup private", async t => {
  const f = await fixture(t)
  const source = join(f.root, "absolute source")
  await mkdir(join(source, "development-runs", "records"), { recursive: true })
  await writeFile(join(source, "development-runs", "records", "fixture"), "synthetic")
  const backup = join(f.root, "private backup")
  const script = `mktemp() { mkdir "$PPO_RIC59_TEST_BACKUP" || return 1; printf '%s\\n' "$PPO_RIC59_TEST_BACKUP"; }\n${backupBlock}`
  const result = spawnSync("/bin/bash", ["-c", script], { cwd: f.root, encoding: "utf8",
    env: { ...process.env, PPO_WRITE_DATA_DIR: source, PPO_RIC59_TEST_BACKUP: backup } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await stat(backup)).mode & 0o777, 0o700)
  assert.equal(await readFile(join(backup, "write-data", "development-runs", "records", "fixture"), "utf8"), "synthetic")
})


test("runbook stops if private backup-directory creation fails", async t => {
  const f = await fixture(t)
  const result = spawnSync("/bin/bash", ["-c", `mktemp() { return 1; }\nmkdir() { echo UNEXPECTED_MKDIR; }\ncp() { echo UNEXPECTED_COPY; }\n${backupBlock}`],
    { cwd: f.root, env: { ...process.env, PPO_WRITE_DATA_DIR: f.root }, encoding: "utf8" })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /UNEXPECTED/u)
})
