import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import {
  DevelopmentRunStateError,
  REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION,
  createDevelopmentRun,
  readDevelopmentRun,
  recoverDevelopmentRunReviewRuntimeFailureState,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  formatReviewRuntimeFailureRecovery,
  recoverReviewRuntimeFailure
} from "./development-review-retry-recovery.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "8aee7be8ab8e9e2a84f1ac7c1a7157a26b15500d"
const REVIEWER = "phase-6f-independent-review-agent"
const CLI_PATH = resolve("deployment/scripts/recover-phase6f-review-runtime-failure.mjs")

function makeClock() {
  let tick = 0
  const start = Date.parse("2026-08-25T11:39:22.127Z")

  return () => {
    const value = new Date(start + tick * 1000)
    tick += 1
    return value
  }
}

async function tempWriteDataDir() {
  return await mkdtemp(join(tmpdir(), "ppo-phase6f-retry-"))
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

function reviewEvidence(
  decision = "OWNER_ACTION_REQUIRED",
  runtimeFailureClass = decision === "OWNER_ACTION_REQUIRED" ? "runtime" : null
) {
  const genuineFindings = decision === "CHANGES_REQUESTED"
  const blockers = genuineFindings ? ["Fix a real review blocker."] : []
  const outcome = genuineFindings ? "changes_requested" : "owner_action_required"

  return [
    {
      kind: "review",
      sha: HEAD_SHA,
      source: REVIEWER,
      summary: "Independent review validated bounded findings for remediation.",
      metadata: {
        project: "khlim-digital-ecosystem",
        reviewer: REVIEWER,
        attempt: 1,
        reviewedSha: HEAD_SHA,
        decision,
        mergeAllowed: false,
        blockers: blockers.length,
        securityFindings: 0,
        testsRequired: 0,
        blockerItems: blockers,
        securityItems: [],
        testItems: [],
        findingHash: "f".repeat(64),
        outcome: "review_findings"
      }
    },
    {
      kind: "review",
      sha: HEAD_SHA,
      source: REVIEWER,
      summary: "Independent review completed with metadata-only decision.",
      metadata: {
        project: "khlim-digital-ecosystem",
        reviewer: REVIEWER,
        attempt: 1,
        reviewedSha: HEAD_SHA,
        promptHash: "e".repeat(64),
        decision,
        mergeAllowed: false,
        blockers: blockers.length,
        securityFindings: 0,
        testsRequired: 0,
        ...(runtimeFailureClass ? {} : { summaryHash: "d".repeat(64) }),
        startedAt: "2026-08-25T11:38:00.000Z",
        endedAt: "2026-08-25T11:39:00.000Z",
        outcome,
        ...(runtimeFailureClass ? { runtimeFailureClass } : {}),
        sandbox: "phase-6f-no-outbound-network-review-sandbox",
        network: "none"
      }
    }
  ]
}

async function makeReviewFailureRun(
  decision = "OWNER_ACTION_REQUIRED",
  runtimeFailureClass = decision === "OWNER_ACTION_REQUIRED" ? "runtime" : null
) {
  const writeDataDir = await tempWriteDataDir()
  const now = makeClock()
  let run = await createDevelopmentRun({
    projectId: "khlim-digital-ecosystem",
    task: "Prepare the Phase 1 monorepo foundation.",
    baseSha: BASE_SHA,
    branch: "ppo/khlim-digital-ecosystem/implementation/3794ac7d1fca8280",
    headSha: HEAD_SHA,
    actor: "test-planner"
  }, {
    writeDataDir,
    now
  })

  for (const status of [
    "planning_in_progress",
    "planned",
    "implementation_in_progress",
    "implementation_ready",
    "tests_in_progress",
    "tests_passed",
    "review_in_progress"
  ]) {
    run = await transitionDevelopmentRun(run.runId, {
      expectedVersion: run.version,
      status,
      actor: "test-agent",
      ...(status === "tests_passed" ? {
        evidence: [{
          kind: "test",
          sha: HEAD_SHA,
          source: "phase-6e-automated-test-runner",
          summary: "Exact-SHA automated test policy passed.",
          metadata: {
            project: "khlim-digital-ecosystem",
            implSha: HEAD_SHA,
            outcome: "passed",
            total: 1,
            passed: 1,
            failed: 0,
            ambiguous: 0
          }
        }]
      } : {})
    }, {
      writeDataDir,
      now
    })
  }

  run = await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "review_changes_requested",
    actor: REVIEWER,
    reason: "phase-6f-independent-review-owner_action_required",
    evidence: reviewEvidence(decision, runtimeFailureClass)
  }, {
    writeDataDir,
    now
  })

  return {
    writeDataDir,
    now,
    run
  }
}

function matchingReconciliation(run, overrides = {}) {
  return {
    ok: true,
    outcome: "independent_review_reconciled",
    status: "matching",
    openAttempt: false,
    approvalValid: false,
    implementationEvidenceValid: true,
    testPassEvidenceValid: true,
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id,
      headSha: run.headSha
    },
    facts: {
      branch: run.branch,
      headSha: run.headSha,
      expectedHeadSha: run.headSha,
      dirty: false
    },
    evidence: {
      latestOutcome: "owner_action_required",
      latestDecision: "OWNER_ACTION_REQUIRED",
      latestAttempt: run.attempts.review,
      latestSha: run.headSha
    },
    ...overrides
  }
}

function recoveryRequest(run, confirmation = REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION) {
  return {
    runId: run.runId,
    expectedVersion: run.version,
    expectedHeadSha: run.headSha,
    confirmation
  }
}

function recoveryOptions(fixture, reconciliation = matchingReconciliation(fixture.run)) {
  return {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now,
    loadRuntimeProfile: async () => ({
      workspaceRegistry: {
        "khlim-digital-ecosystem": {
          workspaceRoot: "/var/lib/personal-project-operator/development-workspaces"
        }
      }
    }),
    reconcileReview: async () => reconciliation
  }
}

test("confirmed runtime failure recovery returns the exact run to tests_passed", async () => {
  const fixture = await makeReviewFailureRun()
  const result = await recoverReviewRuntimeFailure(
    recoveryRequest(fixture.run),
    recoveryOptions(fixture)
  )

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "review_runtime_failure_recovered")
  assert.equal(result.before.version, fixture.run.version)
  assert.equal(result.before.status, "review_changes_requested")
  assert.equal(result.run.version, fixture.run.version + 1)
  assert.equal(result.run.status, "tests_passed")
  assert.equal(result.run.stage, "test")
  assert.equal(result.run.headSha, HEAD_SHA)
  assert.equal(result.run.reviewAttempt, 1)

  const stored = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(stored.status, "tests_passed")
  assert.equal(stored.headSha, HEAD_SHA)
  assert.equal(stored.attempts.review, 1)
  assert.equal(stored.attempts.implementation, fixture.run.attempts.implementation)
  assert.equal(stored.attempts.test, fixture.run.attempts.test)
  assert.equal(stored.evidence.test.length, fixture.run.evidence.test.length)
  assert.deepEqual(stored.evidence.test, fixture.run.evidence.test)
  assert.equal(stored.evidence.test.at(-1).sha, HEAD_SHA)
  assert.equal(stored.evidence.test.at(-1).metadata.implSha, HEAD_SHA)
  assert.equal(stored.evidence.test.at(-1).metadata.outcome, "passed")
  assert.equal(stored.evidence.review.filter((entry) => entry.metadata?.outcome === "hardening_started").length, 0)
  assert.equal(stored.evidence.review.at(-1).source, "phase-6f-review-runtime-failure-recovery")
  assert.equal(stored.evidence.review.at(-1).metadata.outcome, "review_runtime_failure_recovered")
  assert.equal(stored.evidence.review.some((entry) => entry.metadata?.decision === "APPROVED"), false)
})

test("recovery formatter supports the terminal-only self-development continuation route", () => {
  const output = formatReviewRuntimeFailureRecovery({
    outcome: "review_runtime_failure_recovered",
    before: { version: 12, status: "review_changes_requested" },
    run: {
      runId: "S".repeat(43),
      project: "personal-project-operator",
      version: 13,
      status: "tests_passed",
      headSha: HEAD_SHA,
      reviewAttempt: 1
    }
  }, {
    nextCommand: "ppo-self-development continue"
  })

  assert.match(output, new RegExp(`Next command: ppo-self-development continue ${"S".repeat(43)}`, "u"))
  assert.doesNotMatch(output, /Next command: \/ppo continue/u)
})

test("ordinary transitions still refuse review_changes_requested to tests_passed", async () => {
  const fixture = await makeReviewFailureRun()

  await assertRejectsCode(transitionDevelopmentRun(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    status: "tests_passed",
    actor: "untrusted-recovery"
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  }), "INVALID_RUN_TRANSITION")
})

test("recovery refuses missing confirmation without changing state", async () => {
  const fixture = await makeReviewFailureRun()

  await assertRejectsCode(recoverReviewRuntimeFailure(
    recoveryRequest(fixture.run, "wrong-confirmation"),
    recoveryOptions(fixture)
  ), "REVIEW_RUNTIME_RECOVERY_CONFIRMATION_REQUIRED")

  const stored = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(stored.version, fixture.run.version)
  assert.equal(stored.status, "review_changes_requested")
})

test("recovery refuses dirty or mismatched reconciliation without changing state", async () => {
  const fixture = await makeReviewFailureRun()
  const reconciliation = matchingReconciliation(fixture.run, {
    facts: {
      branch: fixture.run.branch,
      headSha: HEAD_SHA,
      expectedHeadSha: HEAD_SHA,
      dirty: true
    }
  })

  await assertRejectsCode(recoverReviewRuntimeFailure(
    recoveryRequest(fixture.run),
    recoveryOptions(fixture, reconciliation)
  ), "REVIEW_RUNTIME_RECOVERY_RECONCILIATION_FAILED")

  const stored = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(stored.version, fixture.run.version)
  assert.equal(stored.status, "review_changes_requested")
})

test("state recovery refuses genuine CHANGES_REQUESTED findings", async () => {
  const fixture = await makeReviewFailureRun("CHANGES_REQUESTED")

  await assertRejectsCode(recoverDevelopmentRunReviewRuntimeFailureState(
    fixture.run.runId,
    {
      expectedVersion: fixture.run.version,
      expectedHeadSha: HEAD_SHA,
      reviewAttempt: fixture.run.attempts.review,
      confirmation: REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION
    },
    {
      writeDataDir: fixture.writeDataDir,
      now: fixture.now
    }
  ), "REVIEW_RUNTIME_RECOVERY_NOT_ALLOWED")

  const stored = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(stored.version, fixture.run.version)
  assert.equal(stored.status, "review_changes_requested")
})

test("state recovery refuses unclassified owner ambiguity with empty findings", async () => {
  const fixture = await makeReviewFailureRun("OWNER_ACTION_REQUIRED", null)

  await assertRejectsCode(recoverDevelopmentRunReviewRuntimeFailureState(
    fixture.run.runId,
    {
      expectedVersion: fixture.run.version,
      expectedHeadSha: HEAD_SHA,
      reviewAttempt: fixture.run.attempts.review,
      confirmation: REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION
    },
    {
      writeDataDir: fixture.writeDataDir,
      now: fixture.now
    }
  ), "REVIEW_RUNTIME_RECOVERY_NOT_ALLOWED")

  const stored = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(stored.version, fixture.run.version)
  assert.equal(stored.status, "review_changes_requested")
})

test("recovery CLI refuses malformed invocation before reading run state", () => {
  const result = spawnSync(process.execPath, [CLI_PATH], {
    encoding: "utf8",
    env: {}
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: recover-phase6f-review-runtime-failure\.mjs/u)
})


test("recovery refuses a stale version or mismatched head without changing state", async () => {
  for (const requestOverride of [
    { expectedVersion: 0 },
    { expectedHeadSha: "b".repeat(40) }
  ]) {
    const fixture = await makeReviewFailureRun()
    const request = {
      ...recoveryRequest(fixture.run),
      ...requestOverride
    }

    await assertRejectsCode(recoverReviewRuntimeFailure(
      request,
      recoveryOptions(fixture)
    ), "REVIEW_RUNTIME_RECOVERY_STATE_MISMATCH")

    const stored = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })
    assert.equal(stored.version, fixture.run.version)
    assert.equal(stored.status, "review_changes_requested")
    assert.equal(stored.headSha, HEAD_SHA)
  }
})

test("recovery requires valid implementation and test evidence", async () => {
  for (const evidenceOverride of [
    { implementationEvidenceValid: false },
    { testPassEvidenceValid: false }
  ]) {
    const fixture = await makeReviewFailureRun()
    const reconciliation = matchingReconciliation(fixture.run, evidenceOverride)

    await assertRejectsCode(recoverReviewRuntimeFailure(
      recoveryRequest(fixture.run),
      recoveryOptions(fixture, reconciliation)
    ), "REVIEW_RUNTIME_RECOVERY_RECONCILIATION_FAILED")

    const stored = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })
    assert.equal(stored.version, fixture.run.version)
    assert.equal(stored.status, "review_changes_requested")
  }
})
