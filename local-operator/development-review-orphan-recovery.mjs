import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  DEVELOPMENT_RUN_ID_PATTERN,
  DevelopmentRunStateError,
  REVIEW_ORPHAN_RECOVERY_ACTOR,
  REVIEW_ORPHAN_RECOVERY_CONFIRMATION,
  readDevelopmentRun,
  recoverDevelopmentRunReviewOrphanState
} from "./development-run-state.mjs"
import {
  reconcileIndependentReview
} from "./development-review-agent.mjs"
import {
  loadDevelopmentRecoveryRuntimeProfile
} from "./development-continue-runtime-profile.mjs"

const execFileAsync = promisify(execFile)
const shaPattern = /^[a-f0-9]{40}$/u
const reviewerProcessPattern = "ppo-independent-reviewer|codex exec|development-review-agent|ppo-command"
export const MIN_REVIEW_ORPHAN_AGE_MS = 60 * 1000
export const REVIEW_ORPHAN_RECOVERY_ID = REVIEW_ORPHAN_RECOVERY_ACTOR

export class DevelopmentReviewOrphanRecoveryError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentReviewOrphanRecoveryError"
  }
}

function recoveryError(code, safeMessage) {
  return new DevelopmentReviewOrphanRecoveryError(code, safeMessage)
}

function normalizeRunId(value) {
  if (typeof value !== "string" || value !== value.trim() || !DEVELOPMENT_RUN_ID_PATTERN.test(value)) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_INVALID_RUN_ID",
      "Orphaned review recovery requires one opaque development run id."
    )
  }

  return value
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_EXPECTED_VERSION_REQUIRED",
      "Orphaned review recovery requires the exact development run version."
    )
  }

  return value
}

function normalizeExpectedReviewAttempt(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_ATTEMPT_REQUIRED",
      "Orphaned review recovery requires the exact review attempt."
    )
  }

  return value
}

function normalizeExpectedHeadSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_EXPECTED_HEAD_REQUIRED",
      "Orphaned review recovery requires the exact implementation head SHA."
    )
  }

  return normalized
}

function stateOptions(options = {}) {
  return {
    ...(typeof options.writeDataDir === "string"
      ? { writeDataDir: options.writeDataDir }
      : {}),
    ...(options.allowPersonalProjectOperatorSelfDevelopmentProject === true
      ? { allowPersonalProjectOperatorSelfDevelopmentProject: true }
      : {})
  }
}

async function loadRecoveryProfile(run, options = {}) {
  const loader = options.loadRuntimeProfile || (async (request) => {
    return await loadDevelopmentRecoveryRuntimeProfile(request, {
      includeTestPolicy: false,
      platform: options.platform
    })
  })
  const profile = await loader({
    run,
    phase: "6F",
    operation: "review-orphan-retry",
    recovery: REVIEW_ORPHAN_RECOVERY_ID
  })

  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile) ||
    !profile.workspaceRegistry ||
    typeof profile.workspaceRegistry !== "object" ||
    Array.isArray(profile.workspaceRegistry)
  ) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_PROFILE_UNAVAILABLE",
      "Trusted workspace registry is unavailable for orphaned review recovery."
    )
  }

  return profile.workspaceRegistry
}

export async function probeActiveReviewerProcesses(options = {}) {
  const uid = typeof options.uid === "number"
    ? options.uid
    : typeof process.getuid === "function"
      ? process.getuid()
      : null

  if (!Number.isInteger(uid) || uid < 0) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_PROCESS_PROBE_FAILED",
      "Reviewer process state could not be verified."
    )
  }

  try {
    const result = await execFileAsync(
      options.pgrepPath || "/usr/bin/pgrep",
      ["-u", String(uid), "-f", reviewerProcessPattern],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        shell: false
      }
    )

    return {
      active: String(result.stdout ?? "").trim().length > 0
    }
  } catch (error) {
    if (error?.code === 1) {
      return { active: false }
    }

    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_PROCESS_PROBE_FAILED",
      "Reviewer process state could not be verified."
    )
  }
}

function assertReconciliation(result, run, expectedHeadSha, expectedReviewAttempt) {
  const latestOutcome = result?.evidence?.latestOutcome
  const classifiedAmbiguity = latestOutcome === "review_execution_ambiguous"

  if (
    !result ||
    result.ok !== true ||
    result.outcome !== "independent_review_reconciled" ||
    result.approvalValid !== false ||
    result.implementationEvidenceValid !== true ||
    result.testPassEvidenceValid !== true ||
    result.run?.runId !== run.runId ||
    result.run?.version !== run.version ||
    result.run?.status !== run.status ||
    result.run?.project !== run.project.id ||
    result.run?.headSha !== expectedHeadSha ||
    result.facts?.headSha !== expectedHeadSha ||
    result.facts?.expectedHeadSha !== expectedHeadSha ||
    result.facts?.dirty !== false ||
    !["review_started", "review_execution_ambiguous"].includes(latestOutcome) ||
    result.evidence?.latestAttempt !== expectedReviewAttempt ||
    result.evidence?.latestSha !== expectedHeadSha ||
    (classifiedAmbiguity
      ? result.ambiguousAttempt !== true || result.status !== "ambiguous_attempt"
      : result.openAttempt !== true || result.status !== "open_attempt")
  ) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_RECONCILIATION_FAILED",
      "Orphaned review recovery requires matching workspace, implementation, test, and unfinished review evidence."
    )
  }
}

function assertAttemptAge(run, expectedReviewAttempt, options = {}) {
  const latest = [...(run.evidence?.review || [])]
    .reverse()
    .find((entry) => entry?.source === "phase-6f-independent-review-agent")
  const startedAt = Date.parse(latest?.metadata?.startedAt || "")
  const now = options.now instanceof Function ? options.now() : new Date()
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN

  if (
    latest?.metadata?.attempt !== expectedReviewAttempt ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(nowMs) ||
    nowMs - startedAt < MIN_REVIEW_ORPHAN_AGE_MS
  ) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_ATTEMPT_NOT_STALE",
      "Review attempt is not old enough to be confirmed orphaned."
    )
  }
}

async function recoverReviewOrphanInternal(request = {}, options = {}) {
  const runId = normalizeRunId(request.runId)
  const expectedVersion = normalizeExpectedVersion(request.expectedVersion)
  const expectedHeadSha = normalizeExpectedHeadSha(request.expectedHeadSha)
  const expectedReviewAttempt = normalizeExpectedReviewAttempt(request.expectedReviewAttempt)

  if (request.confirmation !== REVIEW_ORPHAN_RECOVERY_CONFIRMATION) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_CONFIRMATION_REQUIRED",
      "Exact confirmation is required for orphaned review recovery."
    )
  }

  const readRun = options.readRun || readDevelopmentRun
  const run = await readRun(runId, stateOptions(options))

  if (
    run.version !== expectedVersion ||
    run.status !== "review_in_progress" ||
    run.stage !== "review" ||
    run.headSha !== expectedHeadSha ||
    run.attempts.review !== expectedReviewAttempt
  ) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_STATE_MISMATCH",
      "Development run state does not match the confirmed orphaned review target."
    )
  }

  assertAttemptAge(run, expectedReviewAttempt, options)

  const workspaceRegistry = await loadRecoveryProfile(run, options)
  const reconcile = options.reconcileReview || reconcileIndependentReview
  const reconciliation = await reconcile(runId, {
    ...stateOptions(options),
    workspaceRegistry
  })

  assertReconciliation(reconciliation, run, expectedHeadSha, expectedReviewAttempt)

  const processProbe = options.processProbe || probeActiveReviewerProcesses
  const processState = await processProbe(options)

  if (!processState || processState.active !== false) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_PROCESS_ACTIVE",
      "A reviewer process may still be active; orphaned review recovery was refused."
    )
  }

  const recoverState = options.recoverState || recoverDevelopmentRunReviewOrphanState
  const recovered = await recoverState(runId, {
    expectedVersion,
    expectedHeadSha,
    reviewAttempt: expectedReviewAttempt,
    confirmation: request.confirmation
  }, stateOptions(options))

  if (
    recovered.version !== expectedVersion + 1 ||
    recovered.status !== "tests_passed" ||
    recovered.stage !== "test" ||
    recovered.headSha !== expectedHeadSha ||
    recovered.attempts.review !== expectedReviewAttempt
  ) {
    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_STATE_INVALID",
      "Orphaned review recovery did not produce the expected retry-ready state."
    )
  }

  return {
    ok: true,
    outcome: "review_orphan_recovered",
    before: {
      version: run.version,
      status: run.status,
      reviewAttempt: run.attempts.review
    },
    run: {
      runId: recovered.runId,
      project: recovered.project.id,
      version: recovered.version,
      status: recovered.status,
      stage: recovered.stage,
      headSha: recovered.headSha,
      reviewAttempt: recovered.attempts.review
    }
  }
}

export async function recoverReviewOrphan(request = {}, options = {}) {
  try {
    return await recoverReviewOrphanInternal(request, options)
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw recoveryError(
      "REVIEW_ORPHAN_RECOVERY_UNAVAILABLE",
      "Orphaned review recovery is unavailable; no run-state write was confirmed."
    )
  }
}

export function formatReviewOrphanRecovery(result) {
  return [
    "PPO Phase 6F Orphaned Review Recovery",
    `Run: ${result.run.runId}`,
    `Project: ${result.run.project}`,
    `Before: ${result.before.status} (version ${result.before.version})`,
    `After: ${result.run.status} (version ${result.run.version})`,
    `Head: ${result.run.headSha}`,
    `Review attempts: ${result.run.reviewAttempt}`,
    `Outcome: ${result.outcome}`,
    `Next command: /ppo continue ${result.run.runId}`
  ].join("\n") + "\n"
}

export function formatReviewOrphanRecoveryError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO Phase 6F orphan recovery error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO Phase 6F orphan recovery error: unexpected local failure."
}
