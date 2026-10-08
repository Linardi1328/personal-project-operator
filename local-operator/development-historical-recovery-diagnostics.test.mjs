import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
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
  const backupDir = await mkdtemp(join(await realpath(tmpdir()), "ppo-historical-diagnostic-"))
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

test("CLI semantic argument errors exit 2, unavailable backups exit 1", async t => {
  const f = await fixture(t)
  for (const selection of ["0", "100", "14,14"]) {
    const result = spawnSync(process.execPath, [CLI, "--backup-dir", f.backupDir, "--run-id", f.run.runId, "--events", selection], { encoding: "utf8" })
    assert.equal(result.status, 2)
    assert.deepEqual(JSON.parse(result.stdout), { code: "invalid_diagnostic_request" })
  }
  const invalidId = spawnSync(process.execPath, [CLI, "--backup-dir", f.backupDir, "--run-id", "../SENSITIVE_TEST_SENTINEL", "--events", "14"], { encoding: "utf8" })
  assert.equal(invalidId.status, 2)
  assert.deepEqual(JSON.parse(invalidId.stdout), { code: "invalid_diagnostic_request" })
  const unavailable = spawnSync(process.execPath, [CLI, "--backup-dir", join(f.backupDir, "missing"), "--run-id", f.run.runId, "--events", "14"], { encoding: "utf8" })
  assert.equal(unavailable.status, 1)
  assert.deepEqual(JSON.parse(unavailable.stdout), { code: "backup_unavailable" })
})

test("fixtures work under a macOS-style symlinked temporary root", async t => {
  const f = await fixture(t)
  const alias = `${f.backupDir}-tmp-alias`
  t.after(() => rm(alias, { force: true }))
  await symlink(await realpath(tmpdir()), alias)
  const child = spawnSync(process.execPath, ["--test", "--test-name-pattern=^current healthy recovery history", "local-operator/development-historical-recovery-diagnostics.test.mjs"], {
    encoding: "utf8", env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias }
  })
  assert.equal(child.status, 0, child.stdout + child.stderr)
})


for (const surface of ["historical", "ordinary"]) {
  for (const target of ["canonical", "marker"]) {
    test(`opened descriptor rejects restored ancestor substitution: ${surface}/${target}`, async t => {
      const f = await fixture(t, false)
      const targetPath = target === "canonical" ? f.recordPath : join(f.versionDir, "000000.json")
      const targetDirectory = dirname(targetPath)
      const heldDirectory = `${targetDirectory}-held`
      const replacementDirectory = join(f.backupDir, "adversarial-replacement")
      await fs.mkdir(replacementDirectory, { mode: 0o700 })
      const replacementPath = join(replacementDirectory, basename(targetPath))
      // Identical valid bytes, different inode: content validation cannot detect
      // the substitution. Only the test performs these synthetic rename writes.
      await writeFile(replacementPath, await readFile(targetPath), { mode: 0o600 })
      const before = await snapshot(f)
      const beforeStat = await fs.lstat(targetPath)
      const replacementBefore = await readFile(replacementPath)
      const originalOpen = fs.open
      const originalRename = fs.rename
      let injected = false
      let foreignReads = 0
      let foreignCloses = 0
      let unexpectedWrites = 0
      for (const method of ["writeFile", "appendFile", "truncate", "mkdir", "chmod", "unlink", "link", "rename", "rm"]) {
        t.mock.method(fs, method, async () => {
          unexpectedWrites += 1
          throw new Error("SENSITIVE_TEST_SENTINEL unexpected diagnostic write")
        })
      }
      t.mock.method(fs, "open", async (path, flags, ...rest) => {
        assert.equal(flags, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
        if (path !== targetPath || injected) return originalOpen(path, flags, ...rest)
        injected = true
        await originalRename(targetDirectory, heldDirectory)
        await originalRename(replacementDirectory, targetDirectory)
        let foreign
        try {
          foreign = await originalOpen(path, flags, ...rest)
        } finally {
          // Restore the original path before production receives the handle.
          await originalRename(targetDirectory, replacementDirectory)
          await originalRename(heldDirectory, targetDirectory)
        }
        const foreignRead = foreign.readFile.bind(foreign)
        const foreignClose = foreign.close.bind(foreign)
        t.mock.method(foreign, "readFile", async (...args) => {
          foreignReads += 1
          return foreignRead(...args)
        })
        t.mock.method(foreign, "close", async () => {
          foreignCloses += 1
          return foreignClose()
        })
        return foreign
      })
      syncBuiltinESMExports()
      let result
      try {
        result = surface === "historical" ? await f.diagnose()
          : await inspectDevelopmentRunReadOnly(f.run.runId, f.options)
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
      }
      assert.equal(injected, true)
      assert.equal(foreignReads, 0, "replacement contents must not be read")
      assert.equal(foreignCloses, 1, "rejected descriptor must be closed")
      assert.equal(unexpectedWrites, 0)
      assert.equal(result.code, "stale_observation")
      if (surface === "historical") assert.deepEqual(result, { code: "stale_observation" })
      else assert.equal(result.ok, false)
      // Ancestor renames leave the original file's path identity unchanged.
      // Without fstat, pre/post file observations can both see this same inode.
      const afterStat = await fs.lstat(targetPath)
      for (const key of ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"]) assert.equal(afterStat[key], beforeStat[key])
      assert.deepEqual(await snapshot(f), before)
      assert.deepEqual(await readFile(replacementPath), replacementBefore)
      assert.deepEqual((await fs.readdir(f.backupDir)).sort(), ["adversarial-replacement", "development-runs"])
    })
  }
}
