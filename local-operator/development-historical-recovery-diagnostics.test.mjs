import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createDevelopmentRun, transitionDevelopmentRun, recordDevelopmentRunProgress,
  recoverDevelopmentRunReviewRuntimeFailureState, recoverDevelopmentRunReviewOrphanState,
  REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION, REVIEW_ORPHAN_RECOVERY_CONFIRMATION,
  diagnoseHistoricalReviewRecovery, inspectDevelopmentRunReadOnly
} from "./development-run-state.mjs"

const HEAD = "b".repeat(40)
const REVIEWER = "phase-6f-independent-review-agent"
const INDICES = [14, 17, 20]
const CLI = "deployment/scripts/diagnose-ppo-historical-recovery.mjs"
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value)
const hash = value => createHash("sha256").update(value).digest("hex")
const emptyHash = hash(stable({ reviewedSha: HEAD, decision: "OWNER_ACTION_REQUIRED", blockers: [], securityFindings: [], testsRequired: [] }))
const summaryHash = hash("Independent review could not produce a valid approval decision.")
const evidence = metadata => ({ kind: "review", sha: HEAD, source: REVIEWER, summary: "Synthetic review evidence.", metadata })
const common = { project: "khlim-assist", reviewedSha: HEAD, attempt: 1, decision: "OWNER_ACTION_REQUIRED", mergeAllowed: false,
  blockers: 0, securityFindings: 0, testsRequired: 0 }

async function fixture(t, legacy = true) {
  const backupDir = await mkdtemp(join(tmpdir(), "ppo-historical-diagnostic-"))
  t.after(() => rm(backupDir, { recursive: true, force: true }))
  let tick = Date.parse("2026-08-26T00:00:00.000Z")
  const options = { writeDataDir: backupDir, now: () => new Date(tick += 120_000) }
  let run = await createDevelopmentRun({ projectId: "khlim-assist", task: "Synthetic historical diagnostics", baseSha: "a".repeat(40), headSha: HEAD }, options)
  for (const status of ["planning_in_progress", "planned", "implementation_in_progress", "implementation_ready", "tests_in_progress", "tests_passed", "review_in_progress"]) {
    run = await transitionDevelopmentRun(run.runId, { expectedVersion: run.version, status }, options)
  }
  for (let i = 0; i < 5; i++) run = await recordDevelopmentRunProgress(run.runId, { expectedVersion: run.version, status: run.status }, options)
  run = await transitionDevelopmentRun(run.runId, { expectedVersion: run.version, status: "review_changes_requested", evidence: [
    evidence({ ...common, blockerItems: [], securityItems: [], testItems: [], findingHash: emptyHash, outcome: "review_findings" }),
    evidence({ ...common, runtimeFailureClass: "runtime", outcome: "owner_action_required" })
  ] }, options)
  run = await recoverDevelopmentRunReviewRuntimeFailureState(run.runId, {
    expectedVersion: run.version, expectedHeadSha: HEAD, reviewAttempt: run.attempts.review, confirmation: REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION
  }, options)
  for (let i = 0; i < 2; i++) {
    run = await transitionDevelopmentRun(run.runId, { expectedVersion: run.version, status: "review_in_progress", evidence: [evidence({
      project: "khlim-assist", reviewedSha: HEAD, attempt: run.attempts.review + 1,
      startedAt: new Date(tick).toISOString(), outcome: "review_started"
    })] }, options)
    run = await recordDevelopmentRunProgress(run.runId, { expectedVersion: run.version, status: run.status }, options)
    run = await recoverDevelopmentRunReviewOrphanState(run.runId, {
      expectedVersion: run.version, expectedHeadSha: HEAD, reviewAttempt: run.attempts.review, confirmation: REVIEW_ORPHAN_RECOVERY_CONFIRMATION
    }, options)
  }
  assert.equal(run.version, 20)
  const recordPath = join(backupDir, "development-runs", "records", `${run.runId}.json`)
  const versionDir = join(backupDir, "development-runs", "versions", run.runId)
  const f = { backupDir, run, recordPath, versionDir, options,
    diagnose: extra => diagnoseHistoricalReviewRecovery(run.runId, { backupDir, eventIndices: INDICES, ...extra }) }
  if (legacy) {
    const metadata = run.history[13].evidence[1].metadata
    delete metadata.runtimeFailureClass
    metadata.summaryHash = summaryHash
    await rewriteSyntheticFixture(f)
  }
  return f
}

// Only generated test records are altered. Rebuild every synthetic version to
// exercise semantic checks independently of cryptographic corruption checks.
async function rewriteSyntheticFixture(f) {
  let previous = null
  const accumulated = Object.fromEntries(Object.keys(f.run.evidence).map(k => [k, []]))
  for (const [index, event] of f.run.history.entries()) {
    event.version = index
    event.previousHistoryHash = previous
    const { eventHash, ...payload } = event
    event.eventHash = hash(stable(payload))
    previous = event.eventHash
    for (const entry of event.evidence) accumulated[entry.kind].push(entry)
    const record = { ...f.run, version: index, status: event.toStatus, stage: event.toStage, branch: event.branch, headSha: event.headSha,
      attempts: event.attempts, evidence: structuredClone(accumulated), history: f.run.history.slice(0, index + 1), historyHash: previous,
      timestamps: { createdAt: f.run.history[0].timestamp, updatedAt: event.timestamp, statusChangedAt: event.timestamp, terminalAt: null } }
    const payloadText = JSON.stringify(record)
    await writeFile(join(f.versionDir, `${String(index).padStart(6, "0")}.json`), payloadText)
    if (index === f.run.history.length - 1) {
      f.run = record
      await writeFile(f.recordPath, payloadText)
    }
  }
}

async function snapshot(f) {
  return Promise.all([f.recordPath, ...(await readdir(f.versionDir)).map(name => join(f.versionDir, name))].map(path => readFile(path, "utf8")))
}

test("legacy runtime and later orphan candidates are local matches, never globally valid or provenance verified", async t => {
  const f = await fixture(t)
  const before = await snapshot(f)
  const result = await f.diagnose({ independentProvenanceVerified: true, provenance: { trusted: true } })
  assert.equal(result.code, "diagnostic_complete")
  assert.equal(result.recordStructureValid, true)
  assert.equal(result.immutableVersionMarkersAgree, true)
  assert.equal(result.historicalReplayValid, false)
  assert.equal(result.independentProvenance, "unverified")
  for (const [i, event] of result.events.entries()) {
    assert.equal(event.eventIndex, INDICES[i])
    assert.equal(event.localRecoveryContractMatches, true)
    assert.equal(event.historicalReplayValid, false)
    assert.equal(event.priorHistoryUnresolved, i !== 0)
    assert.equal(event.independentProvenance, "unverified")
    assert.equal(event.historicalWorkerQuiescence, "unknown")
    assert.equal(event.legacyRuntimeShapeMatches, i === 0 ? true : "not_assessed")
  }
  assert.equal(result.events[0].runtimeFailureClassPresent, false)
  assert.equal((await inspectDevelopmentRunReadOnly(f.run.runId, f.options)).ok, false)
  assert.deepEqual(await snapshot(f), before)
})

test("current healthy recovery history can validate without claiming historical operational proof", async t => {
  const f = await fixture(t, false)
  const result = await f.diagnose()
  assert.equal(result.historicalReplayValid, true)
  assert.equal(result.events.every(e => e.historicalReplayValid), true)
  assert.equal(result.events[0].legacyRuntimeShapeMatches, false)
  assert.equal(result.events[1].historicalOwnerConfirmation, "unknown")
})

for (const [label, mutate, check, eventPosition = 0] of [
  ["ordinary owner ambiguity", r => { r.history[13].evidence[1].metadata.summaryHash = hash("Owner must choose a product direction.") }, "legacyFailureSummaryMatches"],
  ["missing findings", r => { r.history[13].evidence.shift() }, "legacyFindingsContractMatches"],
  ["mismatched findings", r => { r.history[13].evidence[0].metadata.attempt = 2 }, "legacyFindingsContractMatches"],
  ["nonempty findings", r => { r.history[13].evidence[0].metadata.blockerItems = ["A real blocker."] }, "legacyFindingsContractMatches"],
  ["wrong findings decision", r => { r.history[13].evidence[0].metadata.decision = "CHANGES_REQUESTED" }, "legacyFindingsContractMatches"],
  ["incorrect findings hash", r => { r.history[13].evidence[0].metadata.findingHash = "c".repeat(64) }, "legacyFindingsHashMatches"],
  ["unauthorized recovery actor", r => { r.history[14].actor = "ordinary-owner" }, "recoveryEnvelopeMatches"],
  ["wrong recovery attempt", r => { r.history[14].evidence[0].metadata.reviewAttempt = 2 }, "recoveryEnvelopeMatches"],
  ["wrong prior decision SHA", r => { r.history[13].evidence[1].metadata.reviewedSha = "c".repeat(40) }, "precedingDecisionMatches"],
  ["invalid present classification", r => { r.history[13].evidence[1].metadata.runtimeFailureClass = "unknown" }, "legacyRuntimeShapeMatches"],
  ["wrong orphan actor", r => { r.history[17].actor = "ordinary-owner" }, "recoveryEnvelopeMatches", 1],
  ["wrong orphan outcome", r => { r.history[17].evidence[0].metadata.previousOutcome = "approved" }, "recoveryEnvelopeMatches", 1],
  ["wrong orphan attempt", r => { r.history[15].evidence[0].metadata.attempt = 1 }, "orphanAttemptMatches", 1],
  ["young orphan", r => { r.history[15].evidence[0].metadata.startedAt = r.history[17].timestamp }, "orphanMinimumAgeMatches", 1],
  ["wrong event head", r => { r.history[17].headSha = "d".repeat(40) }, "precedingStateBindingMatches", 1]
]) test(`refuses local match: ${label}`, async t => {
  const f = await fixture(t)
  mutate(f.run)
  await rewriteSyntheticFixture(f)
  const result = await f.diagnose()
  const event = result.events[eventPosition]
  assert.equal(event[check], false)
  assert.equal(event.localRecoveryContractMatches, false)
  assert.equal(result.code, "diagnostic_complete")
})

test("later evidence cannot satisfy an earlier candidate", async t => {
  const f = await fixture(t)
  const findings = f.run.history[13].evidence.shift()
  f.run.history[19].evidence.push(findings)
  await rewriteSyntheticFixture(f)
  const result = await f.diagnose()
  assert.equal(result.events[0].legacyFindingsContractMatches, false)
  assert.equal(result.events[0].localRecoveryContractMatches, false)
})

for (const [label, mutate] of [
  ["tampered event", r => { r.history[13].eventHash = "d".repeat(64) }],
  ["missing history prefix", r => { r.history.splice(5, 1) }],
  ["malformed attempts", r => { r.history[12].attempts = null }],
  ["secret in evidence", r => { r.history[13].evidence[1].summary = "SENSITIVE_TEST_SENTINEL token=secret" }]
]) test(`structural corruption prevents prefix reconstruction: ${label}`, async t => {
  const f = await fixture(t)
  mutate(f.run)
  await writeFile(f.recordPath, JSON.stringify(f.run))
  const result = await f.diagnose()
  // Secret validation may reject the entire envelope before reconstruction.
  assert.equal(result.historicalReplayValid ?? false, false)
  for (const event of result.events || []) assert.equal(event.localRecoveryContractMatches, "not_assessed")
  assert.equal(JSON.stringify(result).includes("SENSITIVE_TEST_SENTINEL"), false)
})

for (const index of [0, 14, 17, 20]) test(`missing immutable version ${index} is reported`, async t => {
  const f = await fixture(t)
  await rm(join(f.versionDir, `${String(index).padStart(6, "0")}.json`))
  const result = await f.diagnose()
  assert.equal(result.immutableVersionMarkersAgree, false)
  assert.equal(result.historicalReplayValid, false)
  assert.equal(result.events.find(e => e.eventIndex >= index).immutableVersionMarkersAgree, false)
})

test("conflicting or malformed older marker is not hidden by latest marker", async t => {
  const f = await fixture(t)
  await writeFile(join(f.versionDir, "000003.json"), '{"secret":"SENSITIVE_TEST_SENTINEL"}')
  const result = await f.diagnose()
  assert.equal(result.immutableVersionMarkersAgree, false)
  assert.equal(result.events.every(e => !e.immutableVersionMarkersAgree), true)
  assert.equal(JSON.stringify(result).includes("SENSITIVE_TEST_SENTINEL"), false)
})

test("missing candidate event is explicitly not assessed", async t => {
  const f = await fixture(t)
  const result = await f.diagnose({ eventIndices: [21] })
  assert.equal(result.events[0].code, "prefix_unassessable_or_event_missing")
})

for (const target of ["record", "marker", "ancestor"]) test(`refuses symlink: ${target}`, async t => {
  const f = await fixture(t)
  if (target === "ancestor") {
    const alias = `${f.backupDir}-alias`
    t.after(() => rm(alias, { force: true }))
    await symlink(f.backupDir, alias)
    assert.equal((await f.diagnose({ backupDir: alias })).code, "diagnostic_unavailable")
  } else {
    const path = target === "record" ? f.recordPath : join(f.versionDir, "000000.json")
    await rm(path)
    await symlink(target === "record" ? join(f.versionDir, "000020.json") : f.recordPath, path)
    assert.equal((await f.diagnose()).code, "diagnostic_unavailable")
  }
})

test("concurrent mutation of an older marker invalidates the entire observation", async t => {
  const f = await fixture(t)
  const result = await f.diagnose({ __readOnlyBeforeFinalCheck: async () => {
    const path = join(f.versionDir, "000003.json")
    await writeFile(path, `${await readFile(path, "utf8")} `)
  } })
  assert.deepEqual(result, { code: "stale_observation" })
})

test("unexpected marker entry fails closed and scan is bounded", async t => {
  const f = await fixture(t)
  await writeFile(join(f.versionDir, "unexpected.tmp"), "unused")
  assert.equal((await f.diagnose()).code, "diagnostic_unavailable")
})

test("requires private backup permissions and explicit bounded requests", async t => {
  const f = await fixture(t)
  for (const extra of [{ backupDir: "relative" }, { eventIndices: [14, 14] }, { eventIndices: [100] }, { eventIndices: Array.from({ length: 11 }, (_, i) => i + 1) }]) {
    assert.deepEqual(await f.diagnose(extra), { code: "invalid_diagnostic_request" })
  }
  await chmod(f.backupDir, 0o755)
  assert.deepEqual(await f.diagnose(), { code: "private_backup_required" })
})

test("CLI outputs only bounded codes, booleans and indices; no caller provenance bypass", async t => {
  const f = await fixture(t)
  const result = spawnSync(process.execPath, [CLI, "--backup-dir", f.backupDir, "--run-id", f.run.runId, "--events", "14,17,20"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stderr, "")
  const parsed = JSON.parse(result.stdout)
  const allowed = new Set(["diagnostic_complete", "candidate_assessed", "not_assessed", "unknown", "unverified"])
  function inspect(value, key) {
    if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) inspect(v, k)
    else assert.ok(typeof value === "boolean" || (typeof value === "number" && key === "eventIndex" && INDICES.includes(value)) || allowed.has(value))
  }
  inspect(parsed)
  for (const extra of [[], ["--provenance-verified", "true"]]) {
    const bad = spawnSync(process.execPath, [CLI, "--backup-dir", "relative", "--run-id", f.run.runId, "--events", "14,17,20", ...extra], { encoding: "utf8" })
    assert.equal(bad.status, 2)
    assert.deepEqual(JSON.parse(bad.stdout), { code: "invalid_diagnostic_request" })
  }
})

test("more than 100 marker entries stops the bounded scan", async t => {
  const f = await fixture(t)
  for (let i = 21; i <= 100; i++) await writeFile(join(f.versionDir, `${String(i).padStart(6, "0")}.json`), "{}")
  assert.deepEqual(await f.diagnose(), { code: "diagnostic_unavailable" })
})

test("well-shaped but conflicting immutable prefix is rejected", async t => {
  const f = await fixture(t)
  const path = join(f.versionDir, "000014.json")
  const marker = JSON.parse(await readFile(path, "utf8"))
  marker.history[14].reason = "different-recovery-reason"
  const { eventHash, ...payload } = marker.history[14]
  marker.history[14].eventHash = hash(stable(payload))
  marker.historyHash = marker.history[14].eventHash
  await writeFile(path, JSON.stringify(marker))
  const result = await f.diagnose()
  assert.equal(result.recordStructureValid, true)
  assert.equal(result.events[0].immutableVersionMarkersAgree, false)
})

test("recovery prerequisites use preceding implementation and test evidence", async t => {
  const f = await fixture(t)
  const initial = await f.diagnose()
  assert.equal(initial.events[0].precedingImplementationEvidenceMatches, false)
  assert.equal(initial.events[0].precedingTestPassEvidenceMatches, false)
  f.run.history[4].evidence.push({ kind: "implementation", recordedAt: f.run.history[4].timestamp, sha: HEAD, source: "phase-6d-codex-execution-adapter", summary: "Synthetic implementation.",
    metadata: { project: "khlim-assist", adapter: "phase-6d-codex-execution-adapter", attempt: 1, outcome: "implementation_ready" } })
  f.run.history[6].evidence.push({ kind: "test", recordedAt: f.run.history[6].timestamp, sha: HEAD, source: "phase-6e-automated-test-runner", summary: "Synthetic tests.",
    metadata: { implSha: HEAD, outcome: "passed" } })
  await rewriteSyntheticFixture(f)
  const result = await f.diagnose()
  assert.equal(result.events[0].precedingImplementationEvidenceMatches, true)
  assert.equal(result.events[0].precedingTestPassEvidenceMatches, true)
  f.run.history[19].evidence.push(...f.run.history[6].evidence.splice(0))
  await rewriteSyntheticFixture(f)
  const later = await f.diagnose()
  assert.equal(later.events[0].precedingTestPassEvidenceMatches, false)
  assert.equal(later.events[2].precedingTestPassEvidenceMatches, true)
})
