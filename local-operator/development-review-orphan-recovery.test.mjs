import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import {
  DevelopmentRunStateError,
  REVIEW_ORPHAN_RECOVERY_CONFIRMATION,
  createDevelopmentRun,
  readDevelopmentRun,
  recordDevelopmentRunProgress,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  MIN_REVIEW_ORPHAN_AGE_MS,
  recoverReviewOrphan
} from "./development-review-orphan-recovery.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "8aee7be8ab8e9e2a84f1ac7c1a7157a26b15500d"
const REVIEWER = "phase-6f-independent-review-agent"
const CLI_PATH = resolve("deployment/scripts/recover-phase6f-review-orphan.mjs")
const START = Date.parse("2026-08-25T12:14:10.102Z")

function makeClock() {
  let tick = 0

  return () => {
    const value = new Date(START + tick * 1000)
    tick += 1
    return value
  }
}

async function tempWriteDataDir() {
  return await mkdtemp(join(tmpdir(), "ppo-phase6f-orphan-"))
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

function reviewStartedEvidence(attempt = 1) {
  return {
    kind: "review",
    sha: HEAD_SHA,
    source: REVIEWER,
    summary: "Independent review attempt reserved.",
    metadata: {
      project: "khlim-digital-ecosystem",
      reviewer: REVIEWER,
      attempt,
      reviewedSha: HEAD_SHA,
      promptHash: "e".repeat(64),
      startedAt: new Date(START).toISOString(),
      outcome: "review_started",
      sandbox: "phase-6f-no-outbound-network-review-sandbox",
      backend: "codex-native-linux",
      platform: "linux",
      network: "none",
      readOnlyWorkspace: true,
      branch: "ppo/khlim-digital-ecosystem/implementation/3794ac7d1fca8280",
      workspaceId: "3794ac7d1fca8280",
      workspaceRef: "khlim-digital-ecosystem-3794ac7d1fca8280"
    }
  }
}

async function makeOrphanRun({ classified = false } = {}) {
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
    "tests_passed"
  ]) {
    run = await transitionDevelopmentRun(run.runId, {
      expectedVersion: run.version,
      status,
      actor: "test-agent"
    }, {
      writeDataDir,
      now
    })
  }

  run = await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "review_in_progress",
    actor: REVIEWER,
    reason: "phase-6f-independent-review-attempt",
    evidence: [reviewStartedEvidence(1)]
  }, {
    writeDataDir,
    now
  })

  if (classified) {
    run = await recordDevelopmentRunProgress(run.runId, {
      expectedVersion: run.version,
      status: "review_in_progress",
      actor: REVIEWER,
      reason: "phase-6f-independent-review-ambiguous",
      evidence: [{
        kind: "review",
        sha: HEAD_SHA,
        source: REVIEWER,
        summary: "Independent review execution ended ambiguously with bounded classification.",
        metadata: {
          project: "khlim-digital-ecosystem",
          reviewer: REVIEWER,
          attempt: 1,
          reviewedSha: HEAD_SHA,
          startedAt: new Date(START).toISOString(),
          endedAt: new Date(START + 30_000).toISOString(),
          outcome: "review_execution_ambiguous",
          failureClass: "stderr_overflow",
          timedOut: false,
          killed: true,
          outputOverflow: true,
          decisionOverflow: false,
          progressOverflow: true,
          signal: "SIGTERM",
          sandbox: "phase-6f-no-outbound-network-review-sandbox",
          network: "none"
        }
      }]
    }, {
      writeDataDir,
      now
    })
  }

  return {
    writeDataDir,
    run
  }
}

function reconciliation(run, classified = false) {
  return {
    ok: true,
    outcome: "independent_review_reconciled",
    status: classified ? "ambiguous_attempt" : "open_attempt",
    openAttempt: !classified,
    ambiguousAttempt: classified,
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
      latestOutcome: classified ? "review_execution_ambiguous" : "review_started",
      latestDecision: null,
      latestAttempt: run.attempts.review,
      latestSha: run.headSha
    }
  }
}

function request(run, confirmation = REVIEW_ORPHAN_RECOVERY_CONFIRMATION) {
  return {
    runId: run.runId,
    expectedVersion: run.version,
    expectedHeadSha: run.headSha,
    expectedReviewAttempt: run.attempts.review,
    confirmation
  }
}

function options(fixture, classified = false, overrides = {}) {
  return {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date(START + MIN_REVIEW_ORPHAN_AGE_MS + 10_000),
    loadRuntimeProfile: async () => ({
      workspaceRegistry: {
        "khlim-digital-ecosystem": {
          workspaceRoot: "/var/lib/personal-project-operator/development-workspaces"
        }
      }
    }),
    reconcileReview: async () => reconciliation(fixture.run, classified),
    processProbe: async () => ({ active: false }),
    ...overrides
  }
}

for (const classified of [false, true]) {
  test(`confirmed orphan recovery returns ${classified ? "classified" : "legacy"} attempt to tests_passed`, async () => {
    const fixture = await makeOrphanRun({ classified })
    const result = await recoverReviewOrphan(
      request(fixture.run),
      options(fixture, classified)
    )

    assert.equal(result.ok, true)
    assert.equal(result.run.version, fixture.run.version + 1)
    assert.equal(result.run.status, "tests_passed")
    assert.equal(result.run.stage, "test")
    assert.equal(result.run.headSha, HEAD_SHA)
    assert.equal(result.run.reviewAttempt, 1)

    const stored = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(stored.status, "tests_passed")
    assert.equal(stored.attempts.review, 1)
    assert.equal(stored.evidence.review.at(-1).metadata.outcome, "review_orphan_recovered")
    assert.equal(
      stored.evidence.review.some((entry) => entry.metadata?.decision === "APPROVED"),
      false
    )
  })
}

test("orphan recovery refuses an active reviewer without changing state", async () => {
  const fixture = await makeOrphanRun()

  await assertRejectsCode(recoverReviewOrphan(
    request(fixture.run),
    options(fixture, false, {
      processProbe: async () => ({ active: true })
    })
  ), "REVIEW_ORPHAN_RECOVERY_PROCESS_ACTIVE")

  const stored = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(stored.version, fixture.run.version)
  assert.equal(stored.status, "review_in_progress")
})

test("orphan recovery refuses missing confirmation and a fresh attempt", async () => {
  const fixture = await makeOrphanRun()

  await assertRejectsCode(recoverReviewOrphan(
    request(fixture.run, "wrong-confirmation"),
    options(fixture)
  ), "REVIEW_ORPHAN_RECOVERY_CONFIRMATION_REQUIRED")

  await assertRejectsCode(recoverReviewOrphan(
    request(fixture.run),
    options(fixture, false, {
      now: () => new Date(START + MIN_REVIEW_ORPHAN_AGE_MS - 1)
    })
  ), "REVIEW_ORPHAN_RECOVERY_ATTEMPT_NOT_STALE")
})

test("ordinary transition still refuses review_in_progress to tests_passed", async () => {
  const fixture = await makeOrphanRun()

  await assertRejectsCode(transitionDevelopmentRun(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    status: "tests_passed",
    actor: "untrusted-recovery"
  }, {
    writeDataDir: fixture.writeDataDir
  }), "INVALID_RUN_TRANSITION")
})

test("orphan recovery CLI refuses malformed invocation", () => {
  const result = spawnSync(process.execPath, [CLI_PATH], {
    encoding: "utf8",
    env: {}
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: recover-phase6f-review-orphan\.mjs/u)
})
