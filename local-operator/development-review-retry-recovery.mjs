import {
  DEVELOPMENT_RUN_ID_PATTERN,
  DevelopmentRunStateError,
  REVIEW_RUNTIME_FAILURE_RECOVERY_ACTOR,
  REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION,
  readDevelopmentRun,
  recoverDevelopmentRunReviewRuntimeFailureState
} from "./development-run-state.mjs"
import {
  REVIEW_DECISIONS,
  reconcileIndependentReview
} from "./development-review-agent.mjs"
import {
  loadDevelopmentRecoveryRuntimeProfile
} from "./development-continue-runtime-profile.mjs"

export const REVIEW_RUNTIME_FAILURE_RECOVERY_ID = REVIEW_RUNTIME_FAILURE_RECOVERY_ACTOR

const shaPattern = /^[a-f0-9]{40}$/u

export class DevelopmentReviewRuntimeRecoveryError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentReviewRuntimeRecoveryError"
  }
}

function recoveryError(code, safeMessage) {
  return new DevelopmentReviewRuntimeRecoveryError(code, safeMessage)
}

function normalizeRunId(value) {
  if (typeof value !== "string" || value !== value.trim() || !DEVELOPMENT_RUN_ID_PATTERN.test(value)) {
    throw recoveryError(
      "REVIEW_RUNTIME_RECOVERY_INVALID_RUN_ID",
      "Review runtime failure recovery requires one opaque development run id."
    )
  }

  return value
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw recoveryError(
      "REVIEW_RUNTIME_RECOVERY_EXPECTED_VERSION_REQUIRED",
      "Review runtime failure recovery requires the exact development run version."
    )
  }

  return value
}

function normalizeExpectedHeadSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw recoveryError(
      "REVIEW_RUNTIME_RECOVERY_EXPECTED_HEAD_REQUIRED",
      "Review runtime failure recovery requires the exact implementation head SHA."
    )
  }

  return normalized
}

function runStateOptions(options = {}) {
  return typeof options.writeDataDir === "string"
    ? { writeDataDir: options.writeDataDir }
    : {}
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
    operation: "review-runtime-failure-retry",
    recovery: REVIEW_RUNTIME_FAILURE_RECOVERY_ID
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
      "REVIEW_RUNTIME_RECOVERY_PROFILE_UNAVAILABLE",
      "Trusted workspace registry is unavailable for review runtime failure recovery."
    )
  }

  return {
    workspaceRegistry: profile.workspaceRegistry
  }
}

function reconciliationOptions(options, profile) {
  const normalized = {
    ...runStateOptions(options),
    workspaceRegistry: profile.workspaceRegistry
  }

  if (typeof options.gitRunner === "function") {
    normalized.gitRunner = options.gitRunner
  }

  if (typeof options.workspaceGitRunner === "function") {
    normalized.workspaceGitRunner = options.workspaceGitRunner
  }

  return normalized
}

function assertMatchingReviewReconciliation(result, run, expectedHeadSha) {
  if (
    !result ||
    result.ok !== true ||
    result.outcome !== "independent_review_reconciled" ||
    result.status !== "matching" ||
    result.openAttempt !== false ||
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
    result.evidence?.latestDecision !== REVIEW_DECISIONS.OWNER_ACTION_REQUIRED ||
    result.evidence?.latestOutcome !== "owner_action_required" ||
    result.evidence?.latestAttempt !== run.attempts.review ||
    result.evidence?.latestSha !== expectedHeadSha
  ) {
    throw recoveryError(
      "REVIEW_RUNTIME_RECOVERY_RECONCILIATION_FAILED",
      "Review runtime failure recovery requires matching workspace, implementation, test, and owner-action review evidence."
    )
  }
}

async function recoverReviewRuntimeFailureInternal(request = {}, options = {}) {
  const runId = normalizeRunId(request.runId)
  const expectedVersion = normalizeExpectedVersion(request.expectedVersion)
  const expectedHeadSha = normalizeExpectedHeadSha(request.expectedHeadSha)

  if (request.confirmation !== REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION) {
    throw recoveryError(
      "REVIEW_RUNTIME_RECOVERY_CONFIRMATION_REQUIRED",
      "Exact confirmation is required for review runtime failure recovery."
    )
  }

  const readRun = options.readRun || readDevelopmentRun
  const run = await readRun(runId, runStateOptions(options))

  if (
    run.version !== expectedVersion ||
    run.status !== "review_changes_requested" ||
    run.stage !== "review" ||
    run.headSha !== expectedHeadSha
  ) {
    throw recoveryError(
      "REVIEW_RUNTIME_RECOVERY_STATE_MISMATCH",
      "Development run state does not match the confirmed review runtime recovery target."
    )
  }

  const profile = await loadRecoveryProfile(run, options)
  const reconcile = options.reconcileReview || reconcileIndependentReview
  const reconciliation = await reconcile(runId, reconciliationOptions(options, profile))

  assertMatchingReviewReconciliation(reconciliation, run, expectedHeadSha)

  const recoverState = options.recoverState || recoverDevelopmentRunReviewRuntimeFailureState
  const recovered = await recoverState(runId, {
    expectedVersion,
    expectedHeadSha,
    reviewAttempt: run.attempts.review,
    confirmation: request.confirmation
  }, runStateOptions(options))

  if (
    recovered.version !== expectedVersion + 1 ||
    recovered.status !== "tests_passed" ||
    recovered.stage !== "test" ||
    recovered.headSha !== expectedHeadSha ||
    recovered.attempts.review !== run.attempts.review
  ) {
    throw recoveryError(
      "REVIEW_RUNTIME_RECOVERY_STATE_INVALID",
      "Review runtime failure recovery did not produce the expected retry-ready state."
    )
  }

  return {
    ok: true,
    outcome: "review_runtime_failure_recovered",
    before: {
      version: run.version,
      status: run.status,
      headSha: run.headSha
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

export async function recoverReviewRuntimeFailure(request = {}, options = {}) {
  try {
    return await recoverReviewRuntimeFailureInternal(request, options)
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw recoveryError(
      "REVIEW_RUNTIME_RECOVERY_UNAVAILABLE",
      "Review runtime failure recovery is unavailable; no run-state write was confirmed."
    )
  }
}

export function formatReviewRuntimeFailureRecovery(result) {
  return [
    "PPO Phase 6F Review Runtime Recovery",
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

export function formatReviewRuntimeFailureRecoveryError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO Phase 6F recovery error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO Phase 6F recovery error: unexpected local failure."
}
