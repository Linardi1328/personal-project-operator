import { createHash } from "node:crypto"
import {
  DEVELOPMENT_RUN_ID_PATTERN,
  DevelopmentRunStateError,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  readDevelopmentRun,
  readPersonalProjectOperatorSelfDevelopmentRun
} from "./development-run-state.mjs"
import {
  planExistingDevelopmentRun,
  planExistingPersonalProjectOperatorSelfDevelopmentRun
} from "./development-next-stage-planner.mjs"
import { prepareImplementationWorkspace } from "./development-workspace-manager.mjs"
import {
  CODEX_EXECUTION_FAILURE_CLASSES,
  classifyCodexExecutionAttemptEvidence,
  executeCodexImplementation
} from "./development-codex-execution-adapter.mjs"
import {
  classifyAutomatedTestAttemptEvidence,
  executeAutomatedTests,
  resolveAutomatedTestPolicyIdentity
} from "./development-test-runner.mjs"
import { executeIndependentReview } from "./development-review-agent.mjs"
import { executeBoundedHardening } from "./development-hardening-orchestrator.mjs"
import {
  executePhase6GDelivery,
  executeShaPinnedMerge
} from "./github-delivery-agent.mjs"
import { listOrdinaryDevelopmentProjects } from "./github-project-registry.mjs"
import { safeDevelopmentBuildSummary } from "./development-build-summary.mjs"

export const DEVELOPMENT_CONTINUE_ORCHESTRATOR_ID = "phase-6k-controlled-ppo-continue-orchestrator"
export const PHASE_6K_CONTINUE_POLICY_ID = "phase-6k-controlled-ppo-continue"
export const PPO_SELF_DEVELOPMENT_CONTINUE_ORCHESTRATOR_ID = "stage-0-local-ppo-self-development-continue-orchestrator"
export const PPO_SELF_DEVELOPMENT_CONTINUE_POLICY_ID = "stage-0-local-ppo-self-development-continue"

const policyBoundary = Object.freeze({
  id: PHASE_6K_CONTINUE_POLICY_ID,
  orchestrator: DEVELOPMENT_CONTINUE_ORCHESTRATOR_ID,
  callerInput: Object.freeze(["runId"]),
  allowedProjects: Object.freeze(listOrdinaryDevelopmentProjects().map((project) => project.id)),
  maximumStatus: "merged",
  productionActions: false,
  backgroundExecution: false,
  modelRouting: false
})

export const PHASE_6K_CONTINUE_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(policyBoundary))
  .digest("hex")

const selfDevelopmentPolicyBoundary = Object.freeze({
  id: PPO_SELF_DEVELOPMENT_CONTINUE_POLICY_ID,
  orchestrator: PPO_SELF_DEVELOPMENT_CONTINUE_ORCHESTRATOR_ID,
  callerInput: Object.freeze(["runId"]),
  allowedProjects: Object.freeze([PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id]),
  localOnly: true,
  openClawRoute: false,
  maximumStatus: "merged",
  productionActions: false,
  backgroundExecution: false,
  modelRouting: false
})

export const PPO_SELF_DEVELOPMENT_CONTINUE_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(selfDevelopmentPolicyBoundary))
  .digest("hex")

const ordinaryProjectIds = new Set(policyBoundary.allowedProjects)
const ordinaryScope = Object.freeze({
  id: "ordinary",
  policyId: PHASE_6K_CONTINUE_POLICY_ID,
  policyHash: PHASE_6K_CONTINUE_POLICY_HASH,
  reader: readDevelopmentRun,
  allowProject: (run) => {
    const projectId = projectIdFor(run)
    return projectId !== PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id && ordinaryProjectIds.has(projectId)
  },
  childOptions: Object.freeze({}),
  nextCommand: "/ppo continue"
})
const selfDevelopmentScope = Object.freeze({
  id: "self-development",
  policyId: PPO_SELF_DEVELOPMENT_CONTINUE_POLICY_ID,
  policyHash: PPO_SELF_DEVELOPMENT_CONTINUE_POLICY_HASH,
  reader: readPersonalProjectOperatorSelfDevelopmentRun,
  allowProject: (run) => projectIdFor(run) === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id,
  childOptions: Object.freeze({
    allowPersonalProjectOperatorSelfDevelopmentProject: true
  }),
  nextCommand: "ppo-self-development continue"
})
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
  "executablePath",
  "workspace",
  "workspaceRegistry",
  "workspaceRoot",
  "sourceRepoPath",
  "policy",
  "codexConfig",
  "testPolicyRegistry",
  "reviewConfig",
  "githubClient",
  "gitRunner",
  "workspaceGitRunner",
  "sandboxRunner",
  "codexRunner",
  "reviewRunner",
  "runtimeProfile",
  "runtimeProvider",
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
  "childHandlers",
  "trustedRuntimeProfileProvider"
])

const runtimeProfileOptionKeys = new Set([
  "workspaceRegistry",
  "codexConfig",
  "testPolicyRegistry",
  "reviewConfig",
  "githubClient",
  "gitRunner",
  "workspaceGitRunner",
  "sandboxRunner",
  "codexRunner",
  "reviewRunner",
  "platform",
  "now"
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
const codexFailureClasses = new Set(CODEX_EXECUTION_FAILURE_CLASSES)

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

function projectIdFor(run) {
  return typeof run?.project?.id === "string" ? run.project.id : "unknown"
}

function isAllowedProject(run, scope) {
  return scope.allowProject(run) === true
}

function projectRefusedResult(run, scope) {
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
  }, scope)
}

function validateImplementationAttemptBoundary(run, action, scope) {
  const classification = classifyCodexExecutionAttemptEvidence(run)

  if (classification === "invalid") {
    return ownerActionResult(run, action, "codex_evidence_invalid", scope)
  }

  if (classification === "open") {
    return ownerActionResult(run, action, "codex_reconciliation_required", scope)
  }

  if (classification === "none" || classification === "definitive_failed") {
    return null
  }

  return ownerActionResult(run, action, "codex_evidence_invalid", scope)
}

function resolveCurrentTestPolicyIdentity(run, action, runtimeOptions, scope) {
  try {
    return {
      ok: true,
      identity: resolveAutomatedTestPolicyIdentity(run, runtimeOptions)
    }
  } catch {
    return {
      ok: false,
      result: ownerActionResult(run, action, "continue_runtime_not_ready", scope)
    }
  }
}

function validateAutomatedTestRetryBoundary(run, action, runtimeOptions, scope) {
  const policy = resolveCurrentTestPolicyIdentity(run, action, runtimeOptions, scope)

  if (!policy.ok) {
    return policy.result
  }

  const classification = classifyAutomatedTestAttemptEvidence(run, policy.identity)

  if (classification === "none") {
    return ownerActionResult(run, action, "automated_test_reconciliation_required", scope)
  }

  if (classification === "open") {
    return ownerActionResult(run, action, "automated_test_reconciliation_required", scope)
  }

  if (classification === "definitive_failed") {
    return null
  }

  return ownerActionResult(run, action, "automated_test_evidence_invalid", scope)
}

function validateAttemptBoundary(run, boundary, runtimeOptions = {}, scope = ordinaryScope) {
  if (run.status === "implementation_in_progress") {
    return validateImplementationAttemptBoundary(run, boundary.action, scope)
  }

  if (run.status === "tests_in_progress") {
    return validateAutomatedTestRetryBoundary(run, boundary.action, runtimeOptions, scope)
  }

  return null
}

function childOptions(options, expectedVersion, runtimeOptions = {}, scope = ordinaryScope) {
  const forwarded = {}

  for (const [key, value] of Object.entries(options)) {
    if (orchestratorOptionKeys.has(key) || forbiddenCallerOptionKeys.has(key)) {
      continue
    }

    forwarded[key] = value
  }

  return {
    ...forwarded,
    ...runtimeOptions,
    ...scope.childOptions,
    expectedVersion
  }
}

function childHandlers(options = {}, scope = ordinaryScope) {
  return {
    ...defaultChildHandlers,
    ...(scope.id === "self-development" ? {
      planExistingDevelopmentRun: planExistingPersonalProjectOperatorSelfDevelopmentRun
    } : {}),
    ...(options.childHandlers || {})
  }
}

async function readRun(runId, options = {}, scope = ordinaryScope) {
  const reader = options.readRun || scope.reader
  return await reader(runId, options)
}

function normalizeRuntimeProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw continueError(
      "CONTINUE_RUNTIME_NOT_READY",
      "Trusted Phase 6K runtime profile is not ready."
    )
  }

  const normalized = {}

  for (const [key, value] of Object.entries(profile)) {
    if (!runtimeProfileOptionKeys.has(key)) {
      throw continueError(
        "CONTINUE_RUNTIME_NOT_READY",
        "Trusted Phase 6K runtime profile is not ready."
      )
    }

    normalized[key] = value
  }

  return normalized
}

async function resolveRuntimeOptions(run, boundary, options = {}, scope = ordinaryScope) {
  if (typeof options.trustedRuntimeProfileProvider !== "function") {
    return {
      ok: true,
      runtimeOptions: {}
    }
  }

  try {
    const profile = await options.trustedRuntimeProfileProvider({
      run,
      action: boundary.action,
      handler: boundary.handler,
      policyId: scope.policyId,
      policyHash: scope.policyHash
    })

    return {
      ok: true,
      runtimeOptions: normalizeRuntimeProfile(profile)
    }
  } catch (error) {
    const reason = error?.failureClass === "authentication"
      ? "codex_authentication_failed"
      : "continue_runtime_not_ready"
    return {
      ok: false,
      result: ownerActionResult(run, boundary.action, reason)
    }
  }
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
  reason = null,
  buildSummary = null
}, scope = ordinaryScope) {
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
    buildSummary: safeDevelopmentBuildSummary(buildSummary),
    reason: reason ? safeReason(reason) : null,
    policyId: scope.policyId,
    policyHash: scope.policyHash
  }
}

function ownerActionResult(run, action, reason, scope = ordinaryScope) {
  return baseResult({
    ok: false,
    runId: run.runId,
    project: projectIdFor(run),
    before: run.status,
    action,
    outcome: "owner_action_required",
    after: run.status,
    headSha: run.headSha,
    buildSummary: run.task,
    reason
  }, scope)
}

function blockedStatusResult(run, scope = ordinaryScope) {
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
    buildSummary: run.task,
    reason
  }, scope)
}

function staleStateResult(run, action, scope = ordinaryScope) {
  return baseResult({
    ok: false,
    runId: run.runId,
    project: projectIdFor(run),
    before: run.status,
    action,
    outcome: "stale_state",
    after: run.status,
    headSha: run.headSha,
    buildSummary: run.task,
    reason: "run_changed_before_dispatch"
  }, scope)
}

function safeFailureResult(runId, error, scope = ordinaryScope) {
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
  }, scope)
}

async function childFailureResult(run, action, error, options = {}, scope = ordinaryScope) {
  const code = typeof error?.code === "string" ? error.code : "CHILD_OPERATION_FAILED"
  const stale = code === "STALE_RUN_VERSION"
  const codexFailureClass = (
    code === "CODEX_EXECUTION_FAILED" &&
    typeof error?.failureClass === "string" &&
    codexFailureClasses.has(error.failureClass)
  ) ? error.failureClass : null
  const reviewFailureClass = (
    code === "REVIEW_EXECUTION_FAILED" &&
    (error?.failureClass === "authentication" || error?.failureClass === "runtime")
  ) ? error.failureClass : null
  let observed = null

  try {
    const reloaded = await readRun(run.runId, options, scope)

    if (reloaded?.runId === run.runId && isAllowedProject(reloaded, scope)) {
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
      buildSummary: run.task,
      reason: "child_state_reload_failed"
    }, scope)
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
    buildSummary: observed?.task || run.task,
    reason: stale
      ? "stale_run_version"
      : safeReason(
        codexFailureClass
          ? `codex_${codexFailureClass}_failed`
          : reviewFailureClass
            ? `reviewer_${reviewFailureClass}_failed`
            : error?.reasonCode || error?.reason || code.toLowerCase(),
        "child_operation_refused"
      )
  }, scope)
}

function childResultToContinueResult(beforeRun, action, childResult, afterRun = null, scope = ordinaryScope) {
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
    buildSummary: run.task || beforeRun.task,
    reason: childOk ? null : childResult?.reason || childResult?.reasonCode || "child_operation_refused"
  }, scope)
}

async function executeDevelopmentContinueInternal(runId, options = {}, scope = ordinaryScope) {
  assertNoCallerControlledOptions(options)
  const normalizedRunId = normalizeRunId(runId)
  const initial = await readRun(normalizedRunId, options, scope)

  if (!isAllowedProject(initial, scope)) {
    return projectRefusedResult(initial, scope)
  }

  const boundary = statusActions[initial.status]

  if (!boundary) {
    return blockedStatusResult(initial, scope)
  }

  const current = await readRun(normalizedRunId, options, scope)

  if (!isAllowedProject(current, scope)) {
    return projectRefusedResult(current, scope)
  }

  if (current.version !== initial.version || current.status !== initial.status) {
    return staleStateResult(current, boundary.action, scope)
  }

  const runtime = await resolveRuntimeOptions(current, boundary, options, scope)

  if (!runtime.ok) {
    return runtime.result
  }

  const openAttempt = validateAttemptBoundary(current, boundary, runtime.runtimeOptions, scope)

  if (openAttempt) {
    return openAttempt
  }

  const handler = childHandlers(options, scope)[boundary.handler]

  if (typeof handler !== "function") {
    throw continueError(
      "CONTINUE_CHILD_HANDLER_UNAVAILABLE",
      "Development continue child operation is unavailable."
    )
  }

  try {
    const childResult = await handler(normalizedRunId, childOptions(options, current.version, runtime.runtimeOptions, scope))
    let afterRun = null

    if (!childResult?.run) {
      try {
        afterRun = await readRun(normalizedRunId, options, scope)
      } catch {
        afterRun = null
      }
    }

    return childResultToContinueResult(current, boundary.action, childResult, afterRun, scope)
  } catch (error) {
    return await childFailureResult(current, boundary.action, error, options, scope)
  }
}

export async function executeDevelopmentContinue(runId, options = {}) {
  try {
    return await executeDevelopmentContinueInternal(runId, options)
  } catch (error) {
    return safeFailureResult(runId, error)
  }
}

export async function executePersonalProjectOperatorSelfDevelopmentContinue(runId, options = {}) {
  try {
    return await executeDevelopmentContinueInternal(runId, options, selfDevelopmentScope)
  } catch (error) {
    return safeFailureResult(runId, error, selfDevelopmentScope)
  }
}

function formatDevelopmentContinueResultForScope(result, scope) {
  const lines = [
    scope.id === "self-development" ? "PPO Self-Development Continue" : "PPO Development Continue",
    `Run: ${result.runId || "unknown"}`,
    `Project: ${result.project || "unknown"}`
  ]

  const buildSummary = safeDevelopmentBuildSummary(result.buildSummary)

  if (buildSummary) {
    lines.push(`Build summary: ${buildSummary}`)
  }

  if (result.before && result.before !== "unknown" && result.action !== "none") {
    lines.push(`Before: ${result.before}`)
    lines.push(`Action: ${result.action}`)
    lines.push(`Outcome: ${result.outcome}`)
    lines.push(`After: ${result.after || result.before}`)
    lines.push(`Head: ${result.headSha || "none"}`)
    if (result.ok === false && result.reason) {
      lines.push(`Reason: ${result.reason}`)
    }
  } else {
    lines.push(`Status: ${result.status || result.before || "unknown"}`)
    lines.push(`Outcome: ${result.outcome}`)

    if (result.reason) {
      lines.push(`Reason: ${result.reason}`)
    }
  }

  const runId = typeof result.runId === "string" && DEVELOPMENT_RUN_ID_PATTERN.test(result.runId)
    ? result.runId
    : null

  if (runId && result.ok === true && Object.hasOwn(statusActions, result.after)) {
    lines.push(`Next command: ${scope.nextCommand} ${runId}`)
  } else if (runId && result.ok === false) {
    lines.push(`Next command: ${scope.id === "self-development" ? "ppo-self-development status" : "/ppo run"} ${runId}`)
  }

  return `${lines.join("\n")}\n`
}

export function formatDevelopmentContinueResult(result) {
  return formatDevelopmentContinueResultForScope(result, ordinaryScope)
}

export function formatPersonalProjectOperatorSelfDevelopmentContinueResult(result) {
  return formatDevelopmentContinueResultForScope(result, selfDevelopmentScope)
}

export async function handlePpoDevelopmentContinueCommand(runId, options = {}) {
  const result = await executeDevelopmentContinue(runId, options)

  return {
    ok: result.ok,
    result,
    output: formatDevelopmentContinueResult(result)
  }
}
