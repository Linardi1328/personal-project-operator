import { createHash } from "node:crypto"
import {
  DEVELOPMENT_RUN_ID_PATTERN,
  DevelopmentRunStateError,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  readDevelopmentRun
} from "./development-run-state.mjs"
import { planExistingDevelopmentRun } from "./development-next-stage-planner.mjs"
import { prepareImplementationWorkspace } from "./development-workspace-manager.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  CODEX_EXECUTION_SANDBOX_ID,
  executeCodexImplementation
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  AUTOMATED_TEST_SANDBOX_ID,
  executeAutomatedTests
} from "./development-test-runner.mjs"
import { executeIndependentReview } from "./development-review-agent.mjs"
import { executeBoundedHardening } from "./development-hardening-orchestrator.mjs"
import {
  executePhase6GDelivery,
  executeShaPinnedMerge
} from "./github-delivery-agent.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"

export const DEVELOPMENT_CONTINUE_ORCHESTRATOR_ID = "phase-6k-controlled-ppo-continue-orchestrator"
export const PHASE_6K_CONTINUE_POLICY_ID = "phase-6k-controlled-ppo-continue"

const policyBoundary = Object.freeze({
  id: PHASE_6K_CONTINUE_POLICY_ID,
  orchestrator: DEVELOPMENT_CONTINUE_ORCHESTRATOR_ID,
  callerInput: Object.freeze(["runId"]),
  allowedProjects: Object.freeze(listPhase2GitHubProjects().map((project) => project.id)),
  maximumStatus: "merged",
  productionActions: false,
  backgroundExecution: false,
  modelRouting: false
})

export const PHASE_6K_CONTINUE_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(policyBoundary))
  .digest("hex")

const ordinaryProjectIds = new Set(policyBoundary.allowedProjects)
const forbiddenCallerOptionKeys = new Set([
  "expectedVersion",
  "project",
  "projectId",
  "task",
  "action",
  "stage",
  "status",
  "baseSha",
  "headSha",
  "branch",
  "repository",
  "remote",
  "prNumber",
  "pullRequest",
  "mergeMethod",
  "command",
  "executable",
  "workspace",
  "policy",
  "deploymentTarget",
  "service",
  "rollbackTarget",
  "confirmation",
  "env",
  "environment",
  "environmentOverride"
])

const orchestratorOptionKeys = new Set([
  "readRun",
  "childHandlers"
])

const statusActions = Object.freeze({
  created: Object.freeze({
    action: "phase-6b-plan",
    handler: "planExistingDevelopmentRun"
  }),
  planned: Object.freeze({
    action: "phase-6c-prepare-workspace",
    handler: "prepareImplementationWorkspace"
  }),
  implementation_in_progress: Object.freeze({
    action: "phase-6d-codex-implementation",
    handler: "executeCodexImplementation"
  }),
  implementation_ready: Object.freeze({
    action: "phase-6e-automated-tests",
    handler: "executeAutomatedTests"
  }),
  tests_in_progress: Object.freeze({
    action: "phase-6e-automated-test-retry",
    handler: "executeAutomatedTests"
  }),
  tests_passed: Object.freeze({
    action: "phase-6f-independent-review",
    handler: "executeIndependentReview"
  }),
  review_changes_requested: Object.freeze({
    action: "phase-6f-bounded-hardening",
    handler: "executeBoundedHardening"
  }),
  review_passed: Object.freeze({
    action: "phase-6g-delivery",
    handler: "executePhase6GDelivery"
  }),
  merge_ready: Object.freeze({
    action: "phase-6g-sha-pinned-merge",
    handler: "executeShaPinnedMerge"
  })
})

const blockedStatusReasons = Object.freeze({
  planning_in_progress: "planning_reconciliation_required",
  review_in_progress: "review_reconciliation_required",
  tests_failed: "automated_test_failure_recovery_not_routed",
  merged: "development_delivery_complete_production_local_only",
  deploy_in_progress: "production_workflow_local_only",
  deploy_failed: "production_workflow_local_only",
  deployed: "production_workflow_local_only",
  verification_in_progress: "production_workflow_local_only",
  verification_failed: "production_workflow_local_only",
  rollback_in_progress: "production_workflow_local_only",
  rollback_failed: "production_workflow_local_only",
  rolled_back: "production_workflow_local_only",
  verified: "terminal_or_complete",
  cancelled: "terminal_or_complete",
  failed: "terminal_or_complete"
})

const defaultChildHandlers = Object.freeze({
  planExistingDevelopmentRun,
  prepareImplementationWorkspace,
  executeCodexImplementation,
  executeAutomatedTests,
  executeIndependentReview,
  executeBoundedHardening,
  executePhase6GDelivery,
  executeShaPinnedMerge
})

const safeReasonPattern = /^[a-z][a-z0-9_:-]{0,79}$/u
const safeOutcomePattern = /^[a-z][a-z0-9_:-]{0,79}$/u
const shaPattern = /^[a-f0-9]{40}$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const safeIdPattern = /^[a-z0-9][a-z0-9_.:-]{0,79}$/u

export class DevelopmentContinueOrchestratorError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "DevelopmentContinueOrchestratorError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function continueError(code, safeMessage) {
  return new DevelopmentContinueOrchestratorError(code, safeMessage)
}

function normalizeRunId(runId) {
  if (typeof runId !== "string" || runId !== runId.trim() || !DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    throw continueError(
      "CONTINUE_INVALID_RUN_ID",
      "Development continue requires one opaque development run id."
    )
  }

  return runId
}

function assertNoCallerControlledOptions(options = {}) {
  for (const key of forbiddenCallerOptionKeys) {
    if (Object.hasOwn(options, key)) {
      throw continueError(
        "CONTINUE_CALLER_OPTION_REFUSED",
        "Development continue accepts only a run id from the caller."
      )
    }
  }
}

function safeReason(value, fallback = "owner_action_required") {
  const normalized = String(value || "").toLowerCase()

  return safeReasonPattern.test(normalized) ? normalized : fallback
}

function safeOutcome(value, fallback = "owner_action_required") {
  const normalized = String(value || "").toLowerCase()

  return safeOutcomePattern.test(normalized) ? normalized : fallback
}

function safeHeadSha(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : null

  return normalized && shaPattern.test(normalized) ? normalized : null
}

function currentRunSha(run) {
  return safeHeadSha(run?.headSha) || safeHeadSha(run?.baseSha)
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isBoundedSafeString(value, maxChars = 200) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !/[\u0000-\u001F\u007F-\u009F]/u.test(value)
  )
}

function projectIdFor(run) {
  return typeof run?.project?.id === "string" ? run.project.id : "unknown"
}

function isOrdinaryProject(run) {
  const projectId = projectIdFor(run)

  return (
    projectId !== PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id &&
    ordinaryProjectIds.has(projectId)
  )
}

function projectRefusedResult(run) {
  return baseResult({
    ok: false,
    runId: run.runId,
    project: projectIdFor(run),
    before: run.status,
    action: "none",
    outcome: "owner_action_required",
    after: run.status,
    headSha: run.headSha,
    reason: "project_refused"
  })
}

function latestMatchingEvidence(run, kind, predicate) {
  const entries = run?.evidence?.[kind]

  if (!Array.isArray(entries)) {
    throw continueError(
      "CONTINUE_DURABLE_EVIDENCE_INVALID",
      "Development continue could not validate durable attempt evidence."
    )
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (predicate(entry)) {
      return entry
    }
  }

  return null
}

function branchMatches(run, metadata) {
  return !run.branch || metadata.branch === undefined || metadata.branch === run.branch
}

function isCodexAttemptLooking(entry) {
  const outcome = entry?.metadata?.outcome

  return (
    entry?.source === CODEX_EXECUTION_ADAPTER_ID ||
    entry?.metadata?.adapter === CODEX_EXECUTION_ADAPTER_ID ||
    outcome === "execution_started" ||
    outcome === "execution_failed"
  )
}

function isTrustedCodexAttemptEvidence(run, entry) {
  const metadata = entry?.metadata || {}
  const expectedSha = currentRunSha(run)
  const attempt = run?.attempts?.implementation

  if (!expectedSha || !isPositiveInteger(attempt)) {
    return false
  }

  if (
    entry?.kind !== "implementation" ||
    entry?.source !== CODEX_EXECUTION_ADAPTER_ID ||
    safeHeadSha(entry?.sha) !== expectedSha ||
    metadata.adapter !== CODEX_EXECUTION_ADAPTER_ID ||
    metadata.project !== projectIdFor(run) ||
    metadata.attempt !== attempt ||
    metadata.sandbox !== CODEX_EXECUTION_SANDBOX_ID ||
    metadata.network !== "none" ||
    metadata.remotePolicy !== "deny" ||
    !branchMatches(run, metadata) ||
    !sha256Pattern.test(String(metadata.promptHash || "")) ||
    !isBoundedSafeString(metadata.startedAt, 80)
  ) {
    return false
  }

  if (!isBoundedSafeString(metadata.workspaceId, 120) || !isBoundedSafeString(metadata.workspaceRef, 160)) {
    return false
  }

  if (metadata.backend !== undefined && !isBoundedSafeString(metadata.backend, 80)) {
    return false
  }

  if (metadata.platform !== undefined && !isBoundedSafeString(metadata.platform, 40)) {
    return false
  }

  if (metadata.outcome === "execution_started") {
    return metadata.endedAt === undefined
  }

  if (metadata.outcome === "execution_failed") {
    return isBoundedSafeString(metadata.endedAt, 80)
  }

  return false
}

function validateImplementationAttemptBoundary(run, action) {
  const latestAttempt = latestMatchingEvidence(run, "implementation", isCodexAttemptLooking)

  if (!latestAttempt) {
    return null
  }

  if (!isTrustedCodexAttemptEvidence(run, latestAttempt)) {
    return ownerActionResult(run, action, "codex_evidence_invalid")
  }

  if (latestAttempt.metadata.outcome === "execution_started") {
    return ownerActionResult(run, action, "codex_reconciliation_required")
  }

  if (latestAttempt.metadata.outcome === "execution_failed") {
    return null
  }

  return ownerActionResult(run, action, "codex_evidence_invalid")
}

function isAutomatedTestAttemptLooking(entry) {
  const outcome = entry?.metadata?.outcome

  return (
    entry?.source === AUTOMATED_TEST_RUNNER_ID ||
    entry?.metadata?.runner === AUTOMATED_TEST_RUNNER_ID ||
    outcome === "testing_started" ||
    outcome === "failed"
  )
}

function hasTrustedTestEvidenceBase(run, entry) {
  const metadata = entry?.metadata || {}
  const expectedSha = safeHeadSha(run?.headSha)
  const attempt = run?.attempts?.test

  return (
    Boolean(expectedSha) &&
    isPositiveInteger(attempt) &&
    entry?.kind === "test" &&
    entry?.source === AUTOMATED_TEST_RUNNER_ID &&
    safeHeadSha(entry?.sha) === expectedSha &&
    metadata.runner === AUTOMATED_TEST_RUNNER_ID &&
    metadata.project === projectIdFor(run) &&
    metadata.attempt === attempt &&
    safeHeadSha(metadata.implSha) === expectedSha &&
    metadata.sandbox === AUTOMATED_TEST_SANDBOX_ID &&
    metadata.network === "none" &&
    safeIdPattern.test(String(metadata.policyId || "")) &&
    sha256Pattern.test(String(metadata.policyHash || "")) &&
    branchMatches(run, metadata) &&
    isBoundedSafeString(metadata.startedAt, 80)
  )
}

function isTrustedOpenTestingEvidence(run, entry) {
  const metadata = entry?.metadata || {}

  return (
    hasTrustedTestEvidenceBase(run, entry) &&
    metadata.outcome === "testing_started" &&
    metadata.endedAt === undefined &&
    isBoundedSafeString(metadata.workspaceId, 120) &&
    isBoundedSafeString(metadata.workspaceRef, 160)
  )
}

function isTrustedDefinitiveTestFailureEvidence(run, entry) {
  const metadata = entry?.metadata || {}

  if (!hasTrustedTestEvidenceBase(run, entry) || metadata.outcome !== "failed") {
    return false
  }

  if (metadata.testId !== undefined || !isBoundedSafeString(metadata.endedAt, 80)) {
    return false
  }

  if (
    !isPositiveInteger(metadata.total) ||
    !isNonNegativeInteger(metadata.passed) ||
    !isNonNegativeInteger(metadata.failed) ||
    !isNonNegativeInteger(metadata.ambiguous)
  ) {
    return false
  }

  return metadata.passed + metadata.failed + metadata.ambiguous <= metadata.total
}

function validateAutomatedTestRetryBoundary(run, action) {
  const latestAttempt = latestMatchingEvidence(run, "test", isAutomatedTestAttemptLooking)

  if (!latestAttempt) {
    return ownerActionResult(run, action, "automated_test_reconciliation_required")
  }

  if (isTrustedOpenTestingEvidence(run, latestAttempt)) {
    return ownerActionResult(run, action, "automated_test_reconciliation_required")
  }

  if (isTrustedDefinitiveTestFailureEvidence(run, latestAttempt)) {
    return null
  }

  return ownerActionResult(run, action, "automated_test_evidence_invalid")
}

function validateAttemptBoundary(run, boundary) {
  if (run.status === "implementation_in_progress") {
    return validateImplementationAttemptBoundary(run, boundary.action)
  }

  if (run.status === "tests_in_progress") {
    return validateAutomatedTestRetryBoundary(run, boundary.action)
  }

  return null
}

function childOptions(options, expectedVersion) {
  const forwarded = {}

  for (const [key, value] of Object.entries(options)) {
    if (orchestratorOptionKeys.has(key) || forbiddenCallerOptionKeys.has(key)) {
      continue
    }

    forwarded[key] = value
  }

  return {
    ...forwarded,
    expectedVersion
  }
}

function childHandlers(options = {}) {
  return {
    ...defaultChildHandlers,
    ...(options.childHandlers || {})
  }
}

async function readRun(runId, options = {}) {
  const reader = options.readRun || readDevelopmentRun
  return await reader(runId, options)
}

function baseResult({
  ok,
  runId,
  project,
  before,
  action = "none",
  outcome,
  after = before,
  headSha = null,
  reason = null
}) {
  return {
    ok,
    project,
    runId,
    before,
    status: before,
    action,
    outcome: safeOutcome(outcome),
    after,
    headSha: safeHeadSha(headSha),
    reason: reason ? safeReason(reason) : null,
    policyId: PHASE_6K_CONTINUE_POLICY_ID,
    policyHash: PHASE_6K_CONTINUE_POLICY_HASH
  }
}

function ownerActionResult(run, action, reason) {
  return baseResult({
    ok: false,
    runId: run.runId,
    project: projectIdFor(run),
    before: run.status,
    action,
    outcome: "owner_action_required",
    after: run.status,
    headSha: run.headSha,
    reason
  })
}

function blockedStatusResult(run) {
  const reason = blockedStatusReasons[run.status] || "unsupported_status"
  const ok = run.status === "merged" || run.status === "verified"

  return baseResult({
    ok,
    runId: run.runId,
    project: projectIdFor(run),
    before: run.status,
    action: "none",
    outcome: ok ? "complete" : "owner_action_required",
    after: run.status,
    headSha: run.headSha,
    reason
  })
}

function staleStateResult(run, action) {
  return baseResult({
    ok: false,
    runId: run.runId,
    project: projectIdFor(run),
    before: run.status,
    action,
    outcome: "stale_state",
    after: run.status,
    headSha: run.headSha,
    reason: "run_changed_before_dispatch"
  })
}

function safeFailureResult(runId, error) {
  const code = error instanceof DevelopmentContinueOrchestratorError
    ? error.code
    : error instanceof DevelopmentRunStateError
      ? error.code
      : typeof error?.code === "string"
        ? error.code
        : "CONTINUE_UNEXPECTED_FAILURE"
  const reason = code === "STALE_RUN_VERSION" ? "stale_run_version" : safeReason(code.toLowerCase(), "owner_action_required")

  return baseResult({
    ok: false,
    runId: typeof runId === "string" && DEVELOPMENT_RUN_ID_PATTERN.test(runId) ? runId : "unknown",
    project: "unknown",
    before: "unknown",
    action: "none",
    outcome: code === "STALE_RUN_VERSION" ? "stale_state" : "owner_action_required",
    after: "unknown",
    reason
  })
}

async function childFailureResult(run, action, error, options = {}) {
  const code = typeof error?.code === "string" ? error.code : "CHILD_OPERATION_FAILED"
  const stale = code === "STALE_RUN_VERSION"
  let observed = null

  try {
    const reloaded = await readRun(run.runId, options)

    if (reloaded?.runId === run.runId && isOrdinaryProject(reloaded)) {
      observed = reloaded
    }
  } catch {
    observed = null
  }

  if (!observed && !stale) {
    return baseResult({
      ok: false,
      runId: run.runId,
      project: projectIdFor(run),
      before: run.status,
      action,
      outcome: "owner_action_required",
      after: run.status,
      headSha: run.headSha,
      reason: "child_state_reload_failed"
    })
  }

  return baseResult({
    ok: false,
    runId: run.runId,
    project: projectIdFor(run),
    before: run.status,
    action,
    outcome: stale ? "stale_state" : safeOutcome(error?.outcome || error?.safeOutcome, "owner_action_required"),
    after: observed?.status || run.status,
    headSha: observed?.headSha || run.headSha,
    reason: stale
      ? "stale_run_version"
      : safeReason(error?.reasonCode || error?.reason || code.toLowerCase(), "child_operation_refused")
  })
}

function childResultToContinueResult(beforeRun, action, childResult, afterRun = null) {
  const run = childResult?.run && typeof childResult.run === "object"
    ? childResult.run
    : afterRun || beforeRun
  const childOk = childResult?.ok === true
  const outcome = childOk
    ? childResult?.outcome || "continued"
    : childResult?.outcome || "owner_action_required"

  return baseResult({
    ok: childOk,
    runId: beforeRun.runId,
    project: projectIdFor(beforeRun),
    before: beforeRun.status,
    action,
    outcome,
    after: run.status || beforeRun.status,
    headSha: run.headSha || beforeRun.headSha,
    reason: childOk ? null : childResult?.reason || childResult?.reasonCode || "child_operation_refused"
  })
}

async function executeDevelopmentContinueInternal(runId, options = {}) {
  assertNoCallerControlledOptions(options)
  const normalizedRunId = normalizeRunId(runId)
  const initial = await readRun(normalizedRunId, options)

  if (!isOrdinaryProject(initial)) {
    return projectRefusedResult(initial)
  }

  const boundary = statusActions[initial.status]

  if (!boundary) {
    return blockedStatusResult(initial)
  }

  const current = await readRun(normalizedRunId, options)

  if (!isOrdinaryProject(current)) {
    return projectRefusedResult(current)
  }

  if (current.version !== initial.version || current.status !== initial.status) {
    return staleStateResult(current, boundary.action)
  }

  const openAttempt = validateAttemptBoundary(current, boundary)

  if (openAttempt) {
    return openAttempt
  }

  const handler = childHandlers(options)[boundary.handler]

  if (typeof handler !== "function") {
    throw continueError(
      "CONTINUE_CHILD_HANDLER_UNAVAILABLE",
      "Development continue child operation is unavailable."
    )
  }

  try {
    const childResult = await handler(normalizedRunId, childOptions(options, current.version))
    let afterRun = null

    if (!childResult?.run) {
      try {
        afterRun = await readRun(normalizedRunId, options)
      } catch {
        afterRun = null
      }
    }

    return childResultToContinueResult(current, boundary.action, childResult, afterRun)
  } catch (error) {
    return await childFailureResult(current, boundary.action, error, options)
  }
}

export async function executeDevelopmentContinue(runId, options = {}) {
  try {
    return await executeDevelopmentContinueInternal(runId, options)
  } catch (error) {
    return safeFailureResult(runId, error)
  }
}

export function formatDevelopmentContinueResult(result) {
  const lines = [
    "PPO Development Continue",
    `Run: ${result.runId || "unknown"}`,
    `Project: ${result.project || "unknown"}`
  ]

  if (result.before && result.before !== "unknown" && result.action !== "none") {
    lines.push(`Before: ${result.before}`)
    lines.push(`Action: ${result.action}`)
    lines.push(`Outcome: ${result.outcome}`)
    lines.push(`After: ${result.after || result.before}`)
    lines.push(`Head: ${result.headSha || "none"}`)
  } else {
    lines.push(`Status: ${result.status || result.before || "unknown"}`)
    lines.push(`Outcome: ${result.outcome}`)

    if (result.reason) {
      lines.push(`Reason: ${result.reason}`)
    }
  }

  return `${lines.join("\n")}\n`
}

export async function handlePpoDevelopmentContinueCommand(runId, options = {}) {
  const result = await executeDevelopmentContinue(runId, options)

  return {
    ok: result.ok,
    result,
    output: formatDevelopmentContinueResult(result)
  }
}
