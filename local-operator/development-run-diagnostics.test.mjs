import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createDevelopmentRun, transitionDevelopmentRun, diagnoseDevelopmentRunHistory,
  inspectDevelopmentRunReadOnly } from "./development-run-state.mjs"
import { diagnoseDevelopmentRunCatalog, listDevelopmentRunSummaries } from "./development-run-catalog.mjs"
import { assessSoftwareFactoryAdmission } from "./software-factory-admission.mjs"

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`
  return JSON.stringify(value)
}
// Rehash ONLY synthetic fixtures so deeper validation branches can be tested.
function rehashFixture(record) {
  let previous = null
  for (const event of record.history) {
    event.previousHistoryHash = previous
    const { eventHash, ...payload } = event
    event.eventHash = createHash("sha256").update(stable(payload)).digest("hex")
    previous = event.eventHash
  }
  record.historyHash = previous
}
async function fixture(t) {
  const writeDataDir = await mkdtemp(join(tmpdir(), "ppo-diagnostics-"))
  t.after(() => rm(writeDataDir, { recursive: true, force: true }))
  const options = { writeDataDir, now: () => new Date("2026-08-01T00:00:00.000Z") }
  let record = await createDevelopmentRun({ projectId: "khlim-assist", task: "Synthetic diagnostics", baseSha: "a".repeat(40) }, options)
  record = await transitionDevelopmentRun(record.runId, { expectedVersion: 0, status: "planning_in_progress" }, options)
  return { record, options, recordPath: join(writeDataDir, "development-runs", "records", `${record.runId}.json`) }
}
async function snapshot(root) {
  const result = {}
  async function walk(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name)
      const name = prefix + entry.name
      const info = await stat(next)
      result[name] = { mode: info.mode, mtimeMs: info.mtimeMs, size: info.size }
      if (entry.isDirectory()) await walk(next, name + "/")
      else result[name].bytes = await readFile(next, "utf8")
    }
  }
  await walk(root)
  return result
}

for (const [code, mutate, rehash] of [
  ["history_length_invalid", r => { r.history = [] }],
  ["history_event_shape_invalid", r => { r.history[0].reason = "SENSITIVE_TEST_SENTINEL token=secret" }],
  ["history_version_mismatch", r => { r.history[1].version = 5 }],
  ["history_previous_hash_mismatch", r => { r.history[1].previousHistoryHash = "0".repeat(64) }],
  ["history_event_hash_mismatch", r => { r.history[1].eventHash = "0".repeat(64) }],
  ["history_initial_event_invalid", r => { r.history[0].task = "Different initial task" }, true],
  ["history_order_invalid", r => { r.history[1].fromStatus = "planned" }, true],
  ["history_transition_invalid", r => { r.history[1].toStatus = "review_passed"; r.history[1].toStage = "review" }, true],
  ["history_same_status_invalid", r => { r.history[1].toStatus = "created"; r.history[1].toStage = "intake" }, true],
  ["history_attempts_invalid", r => { r.history[1].attempts.planning = 0 }, true],
  ["history_stage_invalid", r => { r.history[1].toStage = "review" }, true],
  ["history_timestamp_invalid", r => { r.history[1].timestamp = "2026-07-31T00:00:00.000Z" }, true],
  ["history_summary_mismatch", r => { r.historyHash = "0".repeat(64) }]
]) {
  test(`read-only redacted diagnostic: ${code}`, async t => {
    const f = await fixture(t)
    mutate(f.record)
    if (rehash) rehashFixture(f.record)
    await writeFile(f.recordPath, JSON.stringify(f.record))
    const before = await snapshot(f.options.writeDataDir)
    const result = await diagnoseDevelopmentRunHistory(f.record.runId, f.options)
    assert.deepEqual(result, { ok: false, runId: f.record.runId, code })
    const catalog = await diagnoseDevelopmentRunCatalog(f.options)
    assert.deepEqual(catalog.failures, [{ runId: f.record.runId, code }])
    assert.equal(catalog.ok, false)
    assert.equal(JSON.stringify(result).includes("SENSITIVE_TEST_SENTINEL"), false)
    assert.deepEqual(await snapshot(f.options.writeDataDir), before)
    const ordinary = await inspectDevelopmentRunReadOnly(f.record.runId, f.options)
    assert.equal(ordinary.ok, false)
    assert.equal(Object.hasOwn(ordinary, "validationFailure"), false)
    const list = await listDevelopmentRunSummaries(f.options)
    assert.equal(list.diagnostics.invalid, 1)
    assert.throws(() => assessSoftwareFactoryAdmission("kynexa", list), { code: "FACTORY_ADMISSION_CATALOG_UNAVAILABLE" })
  })
}

test("diagnostics validate immutable version markers, not only the canonical record", async t => {
  const f = await fixture(t)
  const marker = join(f.options.writeDataDir, "development-runs", "versions", f.record.runId, "000000.json")
  const record = JSON.parse(await readFile(marker, "utf8"))
  record.history[0].eventHash = "0".repeat(64)
  await writeFile(marker, JSON.stringify(record))
  const before = await snapshot(f.options.writeDataDir)
  assert.equal((await diagnoseDevelopmentRunHistory(f.record.runId, f.options)).code, "history_event_hash_mismatch")
  assert.deepEqual(await snapshot(f.options.writeDataDir), before)
})

test("diagnostics return no raw invalid ID or exception text", async t => {
  const f = await fixture(t)
  assert.deepEqual(await diagnoseDevelopmentRunHistory("../SENSITIVE_TEST_SENTINEL", f.options),
    { ok: false, runId: null, code: "invalid_run_id" })
})


for (const [label, malformedAttempts] of [
  ["null", () => null],
  ["array", () => []],
  ["missing keys", () => ({})],
  ["negative", attempts => ({ ...attempts, planning: -1 })],
  ["fractional", attempts => ({ ...attempts, planning: 0.5 })],
  ["sensitive string", () => "SENSITIVE_TEST_SENTINEL"]
]) {
  test(`malformed event attempts (${label}) use the dedicated redacted diagnostic`, async t => {
    const f = await fixture(t)
    f.record.history[1].attempts = malformedAttempts(f.record.history[1].attempts)
    await writeFile(f.recordPath, JSON.stringify(f.record))
    const before = await snapshot(f.options.writeDataDir)
    assert.deepEqual(await diagnoseDevelopmentRunHistory(f.record.runId, f.options),
      { ok: false, runId: f.record.runId, code: "history_attempts_invalid" })
    assert.deepEqual((await diagnoseDevelopmentRunCatalog(f.options)).failures,
      [{ runId: f.record.runId, code: "history_attempts_invalid" }])
    // The ordinary inspector keeps its previous fail-closed public contract.
    const ordinary = await inspectDevelopmentRunReadOnly(f.record.runId, f.options)
    assert.equal(ordinary.ok, false)
    assert.equal(ordinary.code, "record_invalid")
    assert.deepEqual(await snapshot(f.options.writeDataDir), before)
  })
}
