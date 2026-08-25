import {
  DEVELOPMENT_RUN_ID_PATTERN,
  DevelopmentRunStateError,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  classifyCodexExecutionAttemptEvidence,
  reconcileCodexExecution
} from "./development-codex-execution-adapter.mjs"
import {
  loadDevelopmentRecoveryRuntimeProfile
} from "./development-continue-runtime-profile.mjs"

export const CODEX_NO_CHANGE_RECOVERY_ID = "phase-6d-definitive-no-change-cancellation"
export const CODEX_NO_CHANGE_RECOVERY_CONFIRMATION = "cancel-phase6d-definitive-no-change-v1"
export const CODEX_NO_CHANGE_RECOVERY_ACTOR = "phase-6d-definitive-no-change-recovery"
export const CODEX_NO_CHANGE_RECOVERY_REASON = "phase-6d-definitive-no-change-cancellation"

const shaPattern = /^[a-f0-9]{40}$/u

export class DevelopmentCodexNoChangeRecoveryError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentCodexNoChangeRecoveryError"
  }
}

function recoveryError(code, safeMessage) {
  return new DevelopmentCodexNoChangeRecoveryError(code, safeMessage)
}

function normalizeRunId(value) {
  if (typeof value !== "string" || value !== value.trim() || !DEVELOPMENT_RUN_ID_PATTERN.test(value)) {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_INVALID_RUN_ID",
      "Codex no-change recovery requires one opaque development run id."
    )
  }

  return value
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_EXPECTED_VERSION_REQUIRED",
      "Codex no-change recovery requires the exact development run version."
    )
  }

  return value
}

function normalizeExpectedAttempt(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_EXPECTED_ATTEMPT_REQUIRED",
      "Codex no-change recovery requires the exact implementation attempt."
    )
  }

  return value
}

function normalizeExpectedHeadSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_EXPECTED_HEAD_REQUIRED",
      "Codex no-change recovery requires the exact implementation head SHA."
    )
  }

  return normalized
}

function runStateOptions(options = {}) {
  const normalized = {}

  if (typeof options.writeDataDir === "string") {
    normalized.writeDataDir = options.writeDataDir
  }

  if (typeof options.now === "function") {
    normalized.now = options.now
  }

  return normalized
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
    phase: "6D",
    operation: "definitive-no-change-cancellation",
    recovery: CODEX_NO_CHANGE_RECOVERY_ID
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
      "CODEX_NO_CHANGE_RECOVERY_PROFILE_UNAVAILABLE",
      "Trusted workspace registry is unavailable for Codex no-change recovery."
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

function assertMatchingReconciliation(result, run, expectedHeadSha) {
  if (
    !result ||
    result.ok !== true ||
    result.outcome !== "codex_execution_reconciled" ||
    result.status !== "unchanged" ||
    result.run?.runId !== run.runId ||
    result.run?.version !== run.version ||
    result.run?.status !== run.status ||
    result.run?.project !== run.project.id ||
    result.facts?.headSha !== expectedHeadSha ||
    result.facts?.expectedStartSha !== expectedHeadSha ||
    result.facts?.dirty !== false
  ) {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_RECONCILIATION_FAILED",
      "Codex no-change recovery requires an unchanged clean workspace at the exact run head."
    )
  }
}

async function recoverCodexNoChangeRunInternal(request = {}, options = {}) {
  const runId = normalizeRunId(request.runId)
  const expectedVersion = normalizeExpectedVersion(request.expectedVersion)
  const expectedHeadSha = normalizeExpectedHeadSha(request.expectedHeadSha)
  const expectedAttempt = normalizeExpectedAttempt(request.expectedAttempt)

  if (request.confirmation !== CODEX_NO_CHANGE_RECOVERY_CONFIRMATION) {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_CONFIRMATION_REQUIRED",
      "Exact confirmation is required for Codex no-change recovery."
    )
  }

  const readRun = options.readRun || readDevelopmentRun
  const run = await readRun(runId, runStateOptions(options))

  if (
    run.version !== expectedVersion ||
    run.status !== "implementation_in_progress" ||
    run.stage !== "implementation" ||
    run.headSha !== expectedHeadSha ||
    run.attempts?.implementation !== expectedAttempt
  ) {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_STATE_MISMATCH",
      "Development run state does not match the confirmed Codex no-change recovery target."
    )
  }

  if (classifyCodexExecutionAttemptEvidence(run) !== "definitive_failed") {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_EVIDENCE_MISMATCH",
      "Codex no-change recovery requires one closed definitive-failure attempt."
    )
  }

  const profile = await loadRecoveryProfile(run, options)
  const reconcile = options.reconcileCodex || reconcileCodexExecution
  const reconciliation = await reconcile(runId, reconciliationOptions(options, profile))

  assertMatchingReconciliation(reconciliation, run, expectedHeadSha)

  const transition = options.transitionRun || transitionDevelopmentRun
  const recovered = await transition(runId, {
    expectedVersion,
    status: "cancelled",
    actor: CODEX_NO_CHANGE_RECOVERY_ACTOR,
    reason: CODEX_NO_CHANGE_RECOVERY_REASON
  }, runStateOptions(options))

  if (
    recovered.version !== expectedVersion + 1 ||
    recovered.status !== "cancelled" ||
    recovered.stage !== "closed" ||
    recovered.headSha !== expectedHeadSha ||
    recovered.attempts?.implementation !== expectedAttempt
  ) {
    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_STATE_INVALID",
      "Codex no-change recovery did not produce the expected cancelled state."
    )
  }

  return {
    ok: true,
    outcome: "codex_no_change_run_cancelled",
    before: {
      version: run.version,
      status: run.status,
      headSha: run.headSha,
      implementationAttempt: run.attempts.implementation
    },
    run: {
      runId: recovered.runId,
      project: recovered.project.id,
      version: recovered.version,
      status: recovered.status,
      stage: recovered.stage,
      headSha: recovered.headSha,
      implementationAttempt: recovered.attempts.implementation
    }
  }
}

export async function recoverCodexNoChangeRun(request = {}, options = {}) {
  try {
    return await recoverCodexNoChangeRunInternal(request, options)
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw recoveryError(
      "CODEX_NO_CHANGE_RECOVERY_UNAVAILABLE",
      "Codex no-change recovery is unavailable; no run-state write was confirmed."
    )
  }
}

export function formatCodexNoChangeRecovery(result) {
  return [
    "PPO Phase 6D Codex No-Change Recovery",
    `Run: ${result.run.runId}`,
    `Project: ${result.run.project}`,
    `Before: ${result.before.status} (version ${result.before.version})`,
    `After: ${result.run.status} (version ${result.run.version})`,
    `Head: ${result.run.headSha}`,
    `Implementation attempts: ${result.run.implementationAttempt}`,
    `Outcome: ${result.outcome}`,
    `Next command: /ppo start ${result.run.project}`
  ].join("\n") + "\n"
}

export function formatCodexNoChangeRecoveryError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO Phase 6D recovery error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO Phase 6D recovery error: unexpected local failure."
}
