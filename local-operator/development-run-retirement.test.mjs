import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createDevelopmentRun, transitionDevelopmentRun, recordDevelopmentRunProgress,
  inspectDevelopmentRunReadOnly } from "./development-run-state.mjs"
import { acquireDevelopmentOperationLease, relinquishDevelopmentOperationLease } from "./development-operation-lease.mjs"
import { createDevelopmentRunRetirementSession, inspectDevelopmentRunRetirement, RETIREMENT_TTL_MS,
  RETIREMENT_ACTOR } from "./development-run-retirement.mjs"
import { inspectDevelopmentRunCancellationEligibility } from "./development-run-cancellation.mjs"
import { listDevelopmentRunSummaries } from "./development-run-catalog.mjs"
import { assessSoftwareFactoryAdmission } from "./software-factory-admission.mjs"
import { createSoftwareFactoryManagerCycle } from "./software-factory-manager-cycle.mjs"

const RUN_A = "JKjs4fO20mMh3kwO93uTHx3PMV-X--wWPSv9nedHb7U"
const RUN_B = "kqA2X9fEomYXqKy4fZdE_6bilD8KLTGhREhjp-uwRLk"
const SHA = "b".repeat(40)
const clock = () => new Date("2026-10-08T12:00:00.000Z")
const approve = async ({ challenge }) => challenge
function guard(overrides = {}) {
  return { workersQuiescent: true, deliveryQuiescent: true, exclusive: true,
    assertHeld: async () => true, release: async () => {}, ...overrides }
}
function session(overrides = {}) {
  return createDevelopmentRunRetirementSession({ now: clock, confirmOwner: approve,
    acquireQuiescenceGuard: async () => guard(), ...overrides })
}
async function fixture(t, runId = RUN_A, projectId = "khlim-assist") {
  const writeDataDir = await mkdtemp(join(tmpdir(), "ppo-retirement-"))
  t.after(() => rm(writeDataDir, { recursive: true, force: true }))
  const options = { writeDataDir, now: clock }
  let record = await createDevelopmentRun({ projectId, task: "Synthetic retirement fixture", baseSha: SHA, headSha: SHA },
    { ...options, randomBytesImpl: () => Buffer.from(runId, "base64url") })
  const path = ["planning_in_progress", "planned", "implementation_in_progress", "implementation_ready", "tests_in_progress"]
  if (runId === RUN_B) path.push("tests_passed", "review_in_progress", "review_passed")
  for (const status of path) {
    record = await transitionDevelopmentRun(runId, { expectedVersion: record.version, status }, options)
    if (status === "implementation_in_progress") {
      for (let i = 0; i < (runId === RUN_B ? 5 : 2); i++) {
        record = await recordDevelopmentRunProgress(runId, { expectedVersion: record.version, reason: "Synthetic progress" }, options)
      }
    }
  }
  const recordPath = join(writeDataDir, "development-runs", "records", `${runId}.json`)
  return { writeDataDir, options, record, recordPath }
}
async function bytesUnder(root) {
  const result = {}
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${name}/`)
      else result[name] = await readFile(join(dir, entry.name), "utf8")
    }
  }
  await walk(root)
  return result
}

for (const runId of [RUN_A, RUN_B]) {
  test(`retirement appends audited terminal state for exact target ${runId}`, async (t) => {
    const f = await fixture(t, runId)
    // Preserve unrelated previously cancelled KHLIM Digital runs byte for byte.
    for (let i = 1; i <= 3; i++) {
      const other = await createDevelopmentRun({ projectId: "khlim-digital-ecosystem", task: `Prior cancelled run ${i}`, baseSha: SHA },
        { ...f.options, randomBytesImpl: size => Buffer.alloc(size, i) })
      await transitionDevelopmentRun(other.runId, { expectedVersion: 0, status: "cancelled" }, f.options)
    }
    const before = await bytesUnder(f.writeDataDir)
    let released = 0
    const api = session({ acquireQuiescenceGuard: async () => guard({ release: async () => { released++ } }) })
    const staged = await api.stage(runId, f.options)
    assert.equal(staged.ok, true)
    const result = await api.confirm(staged.requestId)
    assert.equal(result.code, "retired")
    assert.equal(released, 1)
    const after = await inspectDevelopmentRunReadOnly(runId, f.options)
    assert.equal(after.ok, true)
    assert.equal(after.record.version, f.record.version + 1)
    assert.deepEqual(after.record.history.slice(0, -1), f.record.history)
    assert.deepEqual(after.record.evidence, f.record.evidence)
    assert.deepEqual(after.record.attempts, f.record.attempts)
    const event = after.record.history.at(-1)
    assert.equal(event.actor, RETIREMENT_ACTOR)
    assert.ok(event.reason.includes(staged.requestId))
    const filesAfter = await bytesUnder(f.writeDataDir)
    for (const [name, content] of Object.entries(before)) {
      if (name !== `development-runs/records/${runId}.json`) assert.equal(filesAfter[name], content, name)
    }
    assert.equal(Object.keys(filesAfter).length, Object.keys(before).length + 1)
    assert.equal((await api.confirm(staged.requestId)).code, "retirement_request_unavailable")
    assert.equal((await api.stage(runId, f.options)).code, "retirement_state_mismatch")
    const catalog = await listDevelopmentRunSummaries(f.options)
    assert.equal(assessSoftwareFactoryAdmission("khlim-assist", catalog).ok, true)
    let resumed = 0
    const cycle = createSoftwareFactoryManagerCycle({ listRuns: async () => catalog,
      runFactory: async () => { resumed++ }, drainQueue: async () => ({ ok: true, outcome: "queue_empty" }) })
    await cycle(f.options)
    assert.equal(resumed, 0)
  })
}

test("ordinary cancellation still refuses both statuses", async t => {
  for (const id of [RUN_A, RUN_B]) {
    const f = await fixture(t, id)
    assert.equal((await inspectDevelopmentRunCancellationEligibility(id, f.options)).ok, false)
  }
})

test("exact-ID, project and explicit-store restrictions", async t => {
  const f = await fixture(t, RUN_A, "ledgerpilot-ai")
  const api = session()
  assert.equal((await api.stage(RUN_A)).code, "retirement_explicit_store_required")
  for (const id of ["A".repeat(43), "../secret", "toString", "mbd-YnAdRpZoCjdmXKZc1mz1m9hn7RZuO9ewsKctfZ4"]) {
    assert.equal((await api.stage(id, f.options)).code, "retirement_out_of_scope")
  }
  assert.equal((await api.stage(RUN_A, f.options)).code, "retirement_state_mismatch")
})

for (const [label, override, code] of [
  ["missing owner authentication", { confirmOwner: undefined }, "retirement_owner_approval_required"],
  ["wrong one-time approval", { confirmOwner: async () => "yes" }, "retirement_owner_approval_required"],
  ["missing host quiescence authority", { acquireQuiescenceGuard: undefined }, "retirement_quiescence_unverifiable"],
  ["active worker", { acquireQuiescenceGuard: async () => guard({ workersQuiescent: false }) }, "retirement_quiescence_unverifiable"],
  ["unknown delivery", { acquireQuiescenceGuard: async () => guard({ deliveryQuiescent: null }) }, "retirement_quiescence_unverifiable"],
  ["no exclusive fence", { acquireQuiescenceGuard: async () => guard({ exclusive: false }) }, "retirement_quiescence_unverifiable"],
  ["lost guard", { acquireQuiescenceGuard: async () => guard({ assertHeld: async () => false }) }, "retirement_quiescence_unverifiable"],
  ["throwing probe", { acquireQuiescenceGuard: async () => { throw new Error("SENSITIVE_TEST_SENTINEL") } }, "retirement_unavailable"]
]) {
  test(`${label} blocks without record/evidence writes and consumes approval`, async t => {
    const f = await fixture(t)
    const before = await bytesUnder(f.writeDataDir)
    const api = session(override)
    const staged = await api.stage(RUN_A, f.options)
    const result = await api.confirm(staged.requestId)
    assert.deepEqual(result, { ok: false, code })
    assert.equal((await api.confirm(staged.requestId)).code, "retirement_request_unavailable")
    assert.deepEqual(await bytesUnder(f.writeDataDir), before)
  })
}

test("production readiness cannot turn absence of a lease into proven quiescence", async t => {
  const f = await fixture(t)
  const before = await bytesUnder(f.writeDataDir)
  assert.equal((await inspectDevelopmentRunRetirement(RUN_A, f.options)).code, "retirement_quiescence_unverifiable")
  assert.deepEqual(await bytesUnder(f.writeDataDir), before)
})

for (const elapsed of [-1, RETIREMENT_TTL_MS, RETIREMENT_TTL_MS + 1]) {
  test(`clock movement ${elapsed} invalidates one-time approval`, async t => {
    const f = await fixture(t)
    let time = clock().getTime()
    const api = session({ now: () => new Date(time) })
    const staged = await api.stage(RUN_A, f.options)
    time += elapsed
    assert.equal((await api.confirm(staged.requestId)).code, "retirement_approval_expired")
  })
}

test("approval expiring during owner prompt is rejected", async t => {
  const f = await fixture(t)
  let time = clock().getTime()
  const api = session({ now: () => new Date(time), confirmOwner: async ({ challenge }) => {
    time += RETIREMENT_TTL_MS; return challenge
  } })
  const staged = await api.stage(RUN_A, f.options)
  assert.equal((await api.confirm(staged.requestId)).code, "retirement_approval_expired")
})

test("concurrent confirmation is single use and restart cannot replay", async t => {
  const f = await fixture(t)
  const api = session()
  const staged = await api.stage(RUN_A, f.options)
  assert.equal((await session().confirm(staged.requestId)).code, "retirement_request_unavailable")
  const results = await Promise.all([api.confirm(staged.requestId), api.confirm(staged.requestId)])
  assert.deepEqual(results.map(r => r.code).sort(), ["retired", "retirement_request_unavailable"].sort())
})

test("approval for a second run cannot be reused for the first", async t => {
  const a = await fixture(t, RUN_A)
  const b = await fixture(t, RUN_B)
  const api = session({ confirmOwner: async () => "RETIRE another run" })
  const staged = await api.stage(RUN_A, a.options)
  const unrelated = await api.stage(RUN_B, b.options)
  assert.notEqual(staged.challenge, unrelated.challenge)
  assert.equal((await api.confirm(staged.requestId)).code, "retirement_owner_approval_required")
})

for (const stale of [false, true]) {
  test(`existing ${stale ? "stale" : "active"} operation lease blocks retirement`, async t => {
    const f = await fixture(t)
    const lease = await acquireDevelopmentOperationLease({ runId: RUN_A, phase: "6E", action: "run-tests", attempt: 1, headSha: SHA }, f.options)
    if (stale) await relinquishDevelopmentOperationLease(lease, f.options)
    const before = await bytesUnder(f.writeDataDir)
    assert.equal((await session().stage(RUN_A, f.options)).code, "retirement_operation_lease_present")
    assert.deepEqual(await bytesUnder(f.writeDataDir), before)
  })
}

test("malformed lease blocks retirement without attempting repair", async t => {
  const f = await fixture(t)
  const dir = join(f.writeDataDir, "development-runs", "operation-leases")
  await mkdir(dir)
  await writeFile(join(dir, `${RUN_A}.json`), "SENSITIVE_TEST_SENTINEL", { mode: 0o600 })
  assert.equal((await session().stage(RUN_A, f.options)).code, "retirement_operation_lease_untrusted")
})

test("record tampering after approval staging is rejected", async t => {
  const f = await fixture(t)
  const api = session()
  const staged = await api.stage(RUN_A, f.options)
  const record = JSON.parse(await readFile(f.recordPath, "utf8"))
  record.history[0].eventHash = "0".repeat(64)
  await writeFile(f.recordPath, JSON.stringify(record))
  const before = await bytesUnder(f.writeDataDir)
  assert.equal((await api.confirm(staged.requestId)).code, "retirement_integrity_untrusted")
  assert.deepEqual(await bytesUnder(f.writeDataDir), before)
})

test("version change between staging and confirmation rejects stale authorization", async t => {
  const f = await fixture(t)
  const api = session()
  const staged = await api.stage(RUN_A, f.options)
  await recordDevelopmentRunProgress(RUN_A, { expectedVersion: 7, reason: "Concurrent test progress" }, f.options)
  assert.equal((await api.confirm(staged.requestId)).code, "retirement_state_mismatch")
})

test("CAS rejects a racing version update at the final guard check", async t => {
  const f = await fixture(t)
  let calls = 0
  const api = session({ acquireQuiescenceGuard: async () => guard({ assertHeld: async () => {
    if (++calls === 2) await recordDevelopmentRunProgress(RUN_A, { expectedVersion: 7 }, f.options)
    return true
  } }) })
  const staged = await api.stage(RUN_A, f.options)
  assert.equal((await api.confirm(staged.requestId)).code, "retirement_version_conflict")
  assert.equal((await inspectDevelopmentRunReadOnly(RUN_A, f.options)).record.status, "tests_in_progress")
})

test("guard loss immediately before commit blocks and releases guard", async t => {
  const f = await fixture(t)
  let calls = 0, releases = 0
  const api = session({ acquireQuiescenceGuard: async () => guard({ assertHeld: async () => ++calls === 1,
    release: async () => { releases++ } }) })
  const staged = await api.stage(RUN_A, f.options)
  assert.equal((await api.confirm(staged.requestId)).code, "retirement_quiescence_lost")
  assert.equal(releases, 1)
})

test("guard-release failure reports committed state and never retries", async t => {
  const f = await fixture(t)
  const api = session({ acquireQuiescenceGuard: async () => guard({ release: async () => { throw new Error("private") } }) })
  const staged = await api.stage(RUN_A, f.options)
  assert.deepEqual(await api.confirm(staged.requestId), { ok: false, code: "retirement_guard_release_failed", stateCommitted: true })
  assert.equal((await api.confirm(staged.requestId)).code, "retirement_request_unavailable")
})

test("retirement does not hide or repair an unrelated invalid catalog record", async t => {
  const f = await fixture(t)
  const invalid = await createDevelopmentRun({ projectId: "khlim-assist", task: "Synthetic invalid record", baseSha: SHA }, f.options)
  const path = join(f.writeDataDir, "development-runs", "records", `${invalid.runId}.json`)
  invalid.historyHash = "0".repeat(64)
  const payload = JSON.stringify(invalid)
  await writeFile(path, payload)
  const api = session()
  const staged = await api.stage(RUN_A, f.options)
  assert.equal((await api.confirm(staged.requestId)).code, "retired")
  assert.equal(await readFile(path, "utf8"), payload)
  const catalog = await listDevelopmentRunSummaries(f.options)
  assert.equal(catalog.diagnostics.invalid, 1)
  assert.throws(() => assessSoftwareFactoryAdmission("khlim-assist", catalog), { code: "FACTORY_ADMISSION_CATALOG_UNAVAILABLE" })
  let work = 0
  const cycle = createSoftwareFactoryManagerCycle({ listRuns: async () => catalog,
    runFactory: async () => { work++ }, drainQueue: async () => { work++ } })
  await assert.rejects(cycle(f.options), { code: "FACTORY_CYCLE_CATALOG_UNAVAILABLE" })
  assert.equal(work, 0)
})
