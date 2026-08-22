import { createHash } from "node:crypto"
import {
  DEVELOPMENT_RUN_ID_PATTERN,
  DEVELOPMENT_RUN_STATUSES,
  DevelopmentRunStateError,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  readDevelopmentRun,
  readPersonalProjectOperatorSelfDevelopmentRun
} from "./development-run-state.mjs"
import { inspectImplementationWorkspace } from "./development-workspace-manager.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  CODEX_EXECUTION_SANDBOX_ID,
  reconcileCodexExecution
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  AUTOMATED_TEST_SANDBOX_ID,
  reconcileAutomatedTesting,
  resolveAutomatedTestPolicyIdentity
} from "./development-test-runner.mjs"
import { reconcileIndependentReview } from "./development-review-agent.mjs"
import { reconcileGitHubDelivery } from "./github-delivery-agent.mjs"
import { loadDevelopmentRecoveryRuntimeProfile } from "./development-continue-runtime-profile.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"

export const DEVELOPMENT_RECOVERY_COORDINATOR_ID = "phase-6l-readonly-development-recovery-coordinator"
export const PHASE_6L_RECOVERY_POLICY_ID = "phase-6l-readonly-development-recovery-policy"

const ordinaryProjects = listPhase2GitHubProjects()
const ordinaryProjectById = new Map(ordinaryProjects.map((project) => [project.id, project]))
const productionStatuses = new Set([
  "deploy_in_progress",
  "deploy_failed",
  "deployed",
  "verification_in_progress",
  "verification_failed",
  "rollback_in_progress",
  "rollback_failed",
  "rolled_back",
  "verified"
])
const terminalStatuses = new Set(["cancelled", "failed"])

export const PHASE_6L_RECOVERY_STATUS_CONTRACT = Object.freeze({
  created: Object.freeze({ phase: "none", operation: "none" }),
  planning_in_progress: Object.freeze({ phase: "6B", operation: "planning-interrupted" }),
  planned: Object.freeze({ phase: "6C", operation: "inspect-implementation-workspace" }),
  implementation_in_progress: Object.freeze({ phase: "6D", operation: "reconcile-codex-execution" }),
  implementation_ready: Object.freeze({ phase: "none", operation: "none" }),
  tests_in_progress: Object.freeze({ phase: "6E", operation: "reconcile-automated-testing" }),
  tests_failed: Object.freeze({ phase: "6E", operation: "reconcile-automated-testing" }),
  tests_passed: Object.freeze({ phase: "none", operation: "none" }),
  review_in_progress: Object.freeze({ phase: "6F", operation: "reconcile-independent-review" }),
  review_changes_requested: Object.freeze({ phase: "none", operation: "none" }),
  review_passed: Object.freeze({ phase: "6G", operation: "reconcile-github-delivery" }),
  merge_ready: Object.freeze({ phase: "6G", operation: "reconcile-github-delivery" }),
  merged: Object.freeze({ phase: "none", operation: "none" }),
  deploy_in_progress: Object.freeze({ phase: "none", operation: "none" }),
  deploy_failed: Object.freeze({ phase: "none", operation: "none" }),
  deployed: Object.freeze({ phase: "none", operation: "none" }),
  verification_in_progress: Object.freeze({ phase: "none", operation: "none" }),
  verification_failed: Object.freeze({ phase: "none", operation: "none" }),
  rollback_in_progress: Object.freeze({ phase: "none", operation: "none" }),
  rollback_failed: Object.freeze({ phase: "none", operation: "none" }),
  rolled_back: Object.freeze({ phase: "none", operation: "none" }),
  verified: Object.freeze({ phase: "none", operation: "none" }),
  cancelled: Object.freeze({ phase: "none", operation: "none" }),
  failed: Object.freeze({ phase: "none", operation: "none" })
})

const policyBoundary = Object.freeze({
  id: PHASE_6L_RECOVERY_POLICY_ID,
  coordinator: DEVELOPMENT_RECOVERY_COORDINATOR_ID,
  callerInput: Object.freeze(["runId"]),
  allowedProjects: Object.freeze(ordinaryProjects.map((project) => project.id)),
  statusContract: PHASE_6L_RECOVERY_STATUS_CONTRACT,
  readOnly: true,
  routeExposed: false,
  productionActions: false,
  mutationActions: false
})

export const PHASE_6L_RECOVERY_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(policyBoundary))
  .digest("hex")

const forbiddenCallerOptionKeys = new Set([
  "project",
  "projectId",
  "expectedVersion",
  "status",
  "stage",
  "action",
  "sha",
  "baseSha",
  "headSha",
  "branch",
  "repository",
  "remote",
  "workspace",
  "workspaceRegistry",
  "sourceRepoPath",
  "workspaceRoot",
  "prNumber",
  "pullRequest",
  "command",
  "executable",
  "executablePath",
  "policy",
  "testPolicyRegistry",
  "codexConfig",
  "reviewConfig",
  "service",
  "deploymentTarget",
  "rollbackTarget",
  "confirmation",
  "environment",
  "environmentOverride",
  "env"
])

const defaultReconcilers = Object.freeze({
  inspectImplementationWorkspace,
  reconcileCodexExecution,
  reconcileAutomatedTesting,
  reconcileIndependentReview,
  reconcileGitHubDelivery
})

const safeIdPattern = /^[a-z][a-z0-9_-]{0,79}$/u
const shaPattern = /^[a-f0-9]{40}$/u
const sha256Pattern = /^[a-f0-9]{64}$/u

const allowedOutcomes = new Set([
  "recovery_not_required",
  "recovery_observed",
  "owner_action_required",
  "production_recovery_out_of_scope",
  "terminal_state",
  "stale_recovery_observation",
  "recovery_state_changed",
  "recovery_unavailable"
])

const allowedObservations = new Set([
  "not_applicable",
  "planning_interrupted",
  "workspace_missing",
  "workspace_matching",
  "workspace_state_ahead",
  "workspace_mismatched",
  "codex_attempt_open",
  "codex_workspace_missing",
  "codex_workspace_unchanged",
  "codex_workspace_advanced",
  "codex_workspace_mismatched",
  "codex_evidence_invalid",
  "test_attempt_open",
  "test_failure_recorded",
  "test_pass_evidence_present",
  "test_workspace_matching",
  "test_workspace_missing",
  "test_workspace_changed",
  "test_workspace_dirty",
  "test_workspace_mismatched",
  "test_evidence_untrusted",
  "review_attempt_open",
  "review_approval_evidence_present",
  "review_workspace_matching",
  "review_workspace_changed",
  "review_workspace_dirty",
  "review_workspace_mismatched",
  "delivery_branch_observed",
  "delivery_pr_observed",
  "delivery_ci_observed",
  "delivery_merge_ready",
  "delivery_remote_merged",
  "delivery_state_unavailable",
  "project_out_of_scope",
  "project_identity_invalid",
  "state_changed",
  "malformed_child_result"
])

export class DevelopmentRecoveryCoordinatorError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "DevelopmentRecoveryCoordinatorError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function recoveryError(code, safeMessage) {
  return new DevelopmentRecoveryCoordinatorError(code, safeMessage)
}

function normalizeRunId(runId) {
  if (typeof runId !== "string" || runId !== runId.trim() || !DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    throw recoveryError(
      "RECOVERY_INVALID_RUN_ID",
      "Development recovery requires one opaque development run id."
    )
  }

  return runId
}

function assertNoCallerControlledOptions(options = {}) {
  for (const key of forbiddenCallerOptionKeys) {
    if (Object.hasOwn(options, key)) {
      throw recoveryError(
        "RECOVERY_CALLER_OPTION_REFUSED",
        "Development recovery accepts only a run id from the caller."
      )
    }
  }
}

function runStateOptions(options = {}) {
  const forwarded = {}

  if (typeof options.writeDataDir === "string") {
    forwarded.writeDataDir = options.writeDataDir
  }

  return forwarded
}

function projectIdFor(run) {
  return typeof run?.project?.id === "string" ? run.project.id : "unknown"
}

function safeHeadSha(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : null

  return normalized && shaPattern.test(normalized) ? normalized : null
}

function currentRunSha(run) {
  return safeHeadSha(run?.headSha) || safeHeadSha(run?.baseSha)
}

function safeOperation(value) {
  return safeIdPattern.test(value) ? value : "none"
}

function safePhase(value) {
  return /^(?:6B|6C|6D|6E|6F|6G|none)$/u.test(value) ? value : "none"
}

function sanitizeOutcome(value) {
  return allowedOutcomes.has(value) ? value : "recovery_unavailable"
}

function sanitizeObservation(value) {
  return allowedObservations.has(value) ? value : "malformed_child_result"
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isBoundedSafeText(value, maxChars = 160) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !/[\u0000-\u001F\u007F-\u009F]/u.test(value) &&
    !/(?:SENSITIVE_TEST_SENTINEL|github_pat_|gh[opusr]_|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:])/iu.test(value)
  )
}

function branchMatches(run, metadata) {
  return !run.branch || metadata.branch === undefined || metadata.branch === run.branch
}

function resultRunSummary(run) {
  return {
    runId: typeof run?.runId === "string" && DEVELOPMENT_RUN_ID_PATTERN.test(run.runId) ? run.runId : "unknown",
    project: projectIdFor(run),
    version: Number.isInteger(run?.version) ? run.version : null,
    status: typeof run?.status === "string" ? run.status : "unknown",
    headSha: safeHeadSha(run?.headSha)
  }
}

function baseResult({
  ok,
  run,
  phase,
  operation,
  outcome,
  observation,
  ownerActionRequired = false,
  continuationCandidate = false
}) {
  return {
    schemaVersion: 1,
    coordinator: DEVELOPMENT_RECOVERY_COORDINATOR_ID,
    policyId: PHASE_6L_RECOVERY_POLICY_ID,
    policyHash: PHASE_6L_RECOVERY_POLICY_HASH,
    ok: ok === true,
    run: resultRunSummary(run),
    phase: safePhase(phase),
    operation: safeOperation(operation),
    outcome: sanitizeOutcome(outcome),
    observation: sanitizeObservation(observation),
    ownerActionRequired: ownerActionRequired === true,
    continuationCandidate: continuationCandidate === true
  }
}

function unavailableResult(run, phase = "none", operation = "none", observation = "malformed_child_result") {
  return baseResult({
    ok: false,
    run,
    phase,
    operation,
    outcome: "recovery_unavailable",
    observation,
    ownerActionRequired: true
  })
}

function stateFingerprint(run) {
  const evidenceCounts = {}

  for (const [kind, entries] of Object.entries(run?.evidence || {})) {
    evidenceCounts[kind] = Array.isArray(entries) ? entries.length : -1
  }

  return JSON.stringify({
    version: run?.version,
    status: run?.status,
    attempts: run?.attempts || {},
    evidenceCounts,
    historyLength: Array.isArray(run?.history) ? run.history.length : -1
  })
}

function childRunClaimsStateChange(before, childResult) {
  const childRun = childResult?.run

  return Boolean(
    childRun &&
    typeof childRun === "object" &&
    (childRun.version !== before.version || childRun.status !== before.status)
  )
}

function validateRunProject(run) {
  const projectId = projectIdFor(run)

  if (projectId === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id) {
    return { ok: false, reason: "self_development" }
  }

  const expected = ordinaryProjectById.get(projectId)

  if (!expected) {
    return { ok: false, reason: "unknown" }
  }

  const fullName = `${expected.owner}/${expected.repo}`

  if (
    run.project.displayName !== expected.displayName ||
    run.project.owner !== expected.owner ||
    run.project.repo !== expected.repo ||
    run.project.fullName !== fullName
  ) {
    return { ok: false, reason: "identity" }
  }

  return { ok: true }
}

async function readRun(runId, options = {}) {
  const stateOptions = runStateOptions(options)

  if (typeof options.readRun === "function") {
    return await options.readRun(runId, stateOptions)
  }

  try {
    return await readDevelopmentRun(runId, stateOptions)
  } catch (error) {
    if (error instanceof DevelopmentRunStateError && (error.code === "UNKNOWN_PROJECT" || error.code === "RUN_RECORD_INVALID")) {
      return await readPersonalProjectOperatorSelfDevelopmentRun(runId, stateOptions)
    }

    throw error
  }
}

function reconcilers(options = {}) {
  return {
    ...defaultReconcilers,
    ...(options.reconcilers || {})
  }
}

function normalizeRecoveryProfile(profile, includeTestPolicy) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw recoveryError(
      "RECOVERY_PROFILE_UNAVAILABLE",
      "Development recovery trusted read-only profile is unavailable."
    )
  }

  const allowedKeys = includeTestPolicy
    ? new Set(["workspaceRegistry", "testPolicyRegistry"])
    : new Set(["workspaceRegistry"])
  const normalized = {}

  for (const [key, value] of Object.entries(profile)) {
    if (!allowedKeys.has(key)) {
      throw recoveryError(
        "RECOVERY_PROFILE_UNAVAILABLE",
        "Development recovery trusted read-only profile is unavailable."
      )
    }

    normalized[key] = value
  }

  if (!normalized.workspaceRegistry || typeof normalized.workspaceRegistry !== "object") {
    throw recoveryError(
      "RECOVERY_PROFILE_UNAVAILABLE",
      "Development recovery trusted read-only profile is unavailable."
    )
  }

  if (includeTestPolicy && (!normalized.testPolicyRegistry || typeof normalized.testPolicyRegistry !== "object")) {
    throw recoveryError(
      "RECOVERY_PROFILE_UNAVAILABLE",
      "Development recovery trusted read-only profile is unavailable."
    )
  }

  return normalized
}

async function resolveRecoveryProfile(run, boundary, options = {}) {
  const includeTestPolicy = boundary.phase === "6E"
  const provider = options.recoveryRuntimeProfileProvider || (async (request) => await loadDevelopmentRecoveryRuntimeProfile(request, {
    includeTestPolicy,
    platform: options.platform
  }))
  const profile = await provider({
    run,
    phase: boundary.phase,
    operation: boundary.operation,
    policyId: PHASE_6L_RECOVERY_POLICY_ID,
    policyHash: PHASE_6L_RECOVERY_POLICY_HASH,
    includeTestPolicy
  })

  return normalizeRecoveryProfile(profile, includeTestPolicy)
}

function childOptions(options, profile, includeGithub = false) {
  const forwarded = {
    ...runStateOptions(options),
    workspaceRegistry: profile.workspaceRegistry
  }

  if (profile.testPolicyRegistry) {
    forwarded.testPolicyRegistry = profile.testPolicyRegistry
  }

  if (typeof options.gitRunner === "function") {
    forwarded.gitRunner = options.gitRunner
  }

  if (typeof options.workspaceGitRunner === "function") {
    forwarded.workspaceGitRunner = options.workspaceGitRunner
  }

  if (includeGithub && options.githubClient && typeof options.githubClient === "object") {
    forwarded.githubClient = options.githubClient
  }

  return forwarded
}

function latestMatchingEvidence(run, kind, predicate) {
  const entries = run?.evidence?.[kind]

  if (!Array.isArray(entries)) {
    return { malformed: true, entry: null }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (predicate(entry)) {
      return { malformed: false, entry }
    }
  }

  return { malformed: false, entry: null }
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

function claimsCurrentCodexAttempt(run, entry) {
  if (!isCodexAttemptLooking(entry)) {
    return false
  }

  const attempt = entry?.metadata?.attempt

  return attempt === run?.attempts?.implementation
}

function trustedCodexAttemptState(run) {
  const latest = latestMatchingEvidence(run, "implementation", (entry) => claimsCurrentCodexAttempt(run, entry))

  if (latest.malformed) {
    return "invalid"
  }

  if (!latest.entry) {
    return "none"
  }

  const entry = latest.entry
  const metadata = entry?.metadata || {}
  const expectedSha = currentRunSha(run)

  if (
    !expectedSha ||
    !isPositiveInteger(run?.attempts?.implementation) ||
    entry?.kind !== "implementation" ||
    entry?.source !== CODEX_EXECUTION_ADAPTER_ID ||
    safeHeadSha(entry?.sha) !== expectedSha ||
    metadata.adapter !== CODEX_EXECUTION_ADAPTER_ID ||
    metadata.project !== projectIdFor(run) ||
    metadata.attempt !== run.attempts.implementation ||
    metadata.sandbox !== CODEX_EXECUTION_SANDBOX_ID ||
    metadata.network !== "none" ||
    metadata.remotePolicy !== "deny" ||
    !branchMatches(run, metadata) ||
    !sha256Pattern.test(String(metadata.promptHash || "")) ||
    !isBoundedSafeText(metadata.startedAt, 80)
  ) {
    return "invalid"
  }

  if (metadata.outcome === "execution_started" && metadata.endedAt === undefined) {
    return "open"
  }

  if (metadata.outcome === "execution_failed" && isBoundedSafeText(metadata.endedAt, 80)) {
    return "failed"
  }

  return "invalid"
}

function isAutomatedTestAttemptLooking(entry) {
  const outcome = entry?.metadata?.outcome

  return (
    entry?.source === AUTOMATED_TEST_RUNNER_ID ||
    entry?.metadata?.runner === AUTOMATED_TEST_RUNNER_ID ||
    outcome === "testing_started" ||
    outcome === "failed" ||
    outcome === "passed"
  )
}

function hasTrustedTestEvidenceBase(run, entry, policyIdentity) {
  const metadata = entry?.metadata || {}
  const expectedSha = safeHeadSha(run?.headSha)

  return (
    Boolean(expectedSha) &&
    isPositiveInteger(run?.attempts?.test) &&
    entry?.kind === "test" &&
    entry?.source === AUTOMATED_TEST_RUNNER_ID &&
    safeHeadSha(entry?.sha) === expectedSha &&
    metadata.runner === AUTOMATED_TEST_RUNNER_ID &&
    metadata.project === projectIdFor(run) &&
    metadata.attempt === run.attempts.test &&
    safeHeadSha(metadata.implSha) === expectedSha &&
    metadata.sandbox === AUTOMATED_TEST_SANDBOX_ID &&
    metadata.network === "none" &&
    metadata.policyId === policyIdentity?.policyId &&
    metadata.policyHash === policyIdentity?.policyHash &&
    branchMatches(run, metadata) &&
    isBoundedSafeText(metadata.startedAt, 80)
  )
}

function trustedTestEvidenceObservation(run, policyIdentity) {
  const latest = latestMatchingEvidence(run, "test", isAutomatedTestAttemptLooking)

  if (latest.malformed) {
    return "test_evidence_untrusted"
  }

  if (!latest.entry) {
    return null
  }

  const entry = latest.entry
  const metadata = entry?.metadata || {}
  const trustedBase = hasTrustedTestEvidenceBase(run, entry, policyIdentity)

  if (trustedBase && metadata.outcome === "testing_started" && metadata.endedAt === undefined) {
    return "test_attempt_open"
  }

  if (trustedBase && metadata.outcome === "failed" && metadata.testId === undefined && isBoundedSafeText(metadata.endedAt, 80)) {
    if (
      isPositiveInteger(metadata.total) &&
      isNonNegativeInteger(metadata.passed) &&
      isNonNegativeInteger(metadata.failed) &&
      isNonNegativeInteger(metadata.ambiguous) &&
      metadata.total === policyIdentity.requiredTestCount &&
      metadata.passed + metadata.failed + metadata.ambiguous <= metadata.total
    ) {
      return "test_failure_recorded"
    }
  }

  if (trustedBase && metadata.outcome === "passed" && metadata.testId === undefined && isBoundedSafeText(metadata.endedAt, 80)) {
    if (
      metadata.total === policyIdentity.requiredTestCount &&
      metadata.passed === policyIdentity.requiredTestCount &&
      metadata.failed === 0 &&
      metadata.ambiguous === 0
    ) {
      return "test_pass_evidence_present"
    }
  }

  return "test_evidence_untrusted"
}

function requireChildOutcome(childResult, expectedOutcome) {
  if (
    !childResult ||
    typeof childResult !== "object" ||
    childResult.ok !== true ||
    childResult.outcome !== expectedOutcome
  ) {
    return false
  }

  return true
}

function mapWorkspaceInspection(run, childResult) {
  if (!requireChildOutcome(childResult, "workspace_inspected")) {
    return unavailableResult(run, "6C", "inspect-implementation-workspace")
  }

  if (childResult.status === "missing" && childResult.exists === false) {
    return baseResult({
      ok: true,
      run,
      phase: "6C",
      operation: "inspect-implementation-workspace",
      outcome: "recovery_not_required",
      observation: "workspace_missing",
      continuationCandidate: true
    })
  }

  if (childResult.status === "matching" && childResult.matches === true) {
    return baseResult({
      ok: true,
      run,
      phase: "6C",
      operation: "inspect-implementation-workspace",
      outcome: "owner_action_required",
      observation: "workspace_state_ahead",
      ownerActionRequired: true
    })
  }

  if (childResult.status === "mismatch") {
    return baseResult({
      ok: false,
      run,
      phase: "6C",
      operation: "inspect-implementation-workspace",
      outcome: "owner_action_required",
      observation: "workspace_mismatched",
      ownerActionRequired: true
    })
  }

  return unavailableResult(run, "6C", "inspect-implementation-workspace")
}

function mapCodexReconciliation(run, childResult) {
  if (!requireChildOutcome(childResult, "codex_execution_reconciled")) {
    return unavailableResult(run, "6D", "reconcile-codex-execution")
  }

  const evidenceState = trustedCodexAttemptState(run)

  if (evidenceState === "invalid") {
    return unavailableResult(run, "6D", "reconcile-codex-execution", "codex_evidence_invalid")
  }

  if (evidenceState === "open") {
    return baseResult({
      ok: true,
      run,
      phase: "6D",
      operation: "reconcile-codex-execution",
      outcome: "recovery_observed",
      observation: "codex_attempt_open",
      ownerActionRequired: true
    })
  }

  const observationByStatus = {
    missing: "codex_workspace_missing",
    unchanged: "codex_workspace_unchanged",
    advanced: "codex_workspace_advanced",
    mismatched: "codex_workspace_mismatched"
  }
  const observation = observationByStatus[childResult.status]

  if (!observation) {
    return unavailableResult(run, "6D", "reconcile-codex-execution")
  }

  return baseResult({
    ok: childResult.status !== "mismatched",
    run,
    phase: "6D",
    operation: "reconcile-codex-execution",
    outcome: childResult.status === "mismatched" ? "owner_action_required" : "recovery_observed",
    observation,
    ownerActionRequired: true
  })
}

function mapAutomatedTesting(run, childResult, profile) {
  if (!requireChildOutcome(childResult, "automated_testing_reconciled")) {
    return unavailableResult(run, "6E", "reconcile-automated-testing")
  }

  let policyIdentity

  try {
    policyIdentity = resolveAutomatedTestPolicyIdentity(run, {
      testPolicyRegistry: profile.testPolicyRegistry
    })
  } catch {
    return unavailableResult(run, "6E", "reconcile-automated-testing")
  }

  const evidenceObservation = trustedTestEvidenceObservation(run, policyIdentity)
  const observationByStatus = {
    open_attempt: "test_attempt_open",
    passed_valid: "test_pass_evidence_present",
    matching: "test_workspace_matching",
    missing: "test_workspace_missing",
    head_changed: "test_workspace_changed",
    dirty: "test_workspace_dirty",
    mismatch: "test_workspace_mismatched"
  }
  const observation = evidenceObservation || observationByStatus[childResult.status]

  if (!observation) {
    return unavailableResult(run, "6E", "reconcile-automated-testing")
  }

  return baseResult({
    ok: !["test_evidence_untrusted", "test_workspace_mismatched"].includes(observation),
    run,
    phase: "6E",
    operation: "reconcile-automated-testing",
    outcome: observation === "test_evidence_untrusted" ? "owner_action_required" : "recovery_observed",
    observation,
    ownerActionRequired: true
  })
}

function mapIndependentReview(run, childResult) {
  if (!requireChildOutcome(childResult, "independent_review_reconciled")) {
    return unavailableResult(run, "6F", "reconcile-independent-review")
  }

  const observationByStatus = {
    open_attempt: "review_attempt_open",
    approval_valid: "review_approval_evidence_present",
    matching: "review_workspace_matching",
    head_changed: "review_workspace_changed",
    dirty: "review_workspace_dirty",
    mismatch: "review_workspace_mismatched"
  }
  const observation = observationByStatus[childResult.status]

  if (!observation) {
    return unavailableResult(run, "6F", "reconcile-independent-review")
  }

  return baseResult({
    ok: !["review_workspace_mismatched"].includes(observation),
    run,
    phase: "6F",
    operation: "reconcile-independent-review",
    outcome: "recovery_observed",
    observation,
    ownerActionRequired: true
  })
}

function mapGitHubDelivery(run, childResult) {
  if (!requireChildOutcome(childResult, "github_delivery_reconciled")) {
    return unavailableResult(run, "6G", "reconcile-github-delivery")
  }

  const delivery = childResult.delivery || {}
  let observation = "delivery_state_unavailable"

  if (delivery.mergeStatus === "merged_remote") {
    observation = "delivery_remote_merged"
  } else if (delivery.mergeStatus === "merge_ready") {
    observation = "delivery_merge_ready"
  } else if (delivery.ciStatus === "passed") {
    observation = "delivery_ci_observed"
  } else if (Number.isInteger(delivery.prNumber) && delivery.prNumber > 0) {
    observation = "delivery_pr_observed"
  } else if (safeHeadSha(delivery.remoteBranchSha)) {
    observation = "delivery_branch_observed"
  }

  return baseResult({
    ok: observation !== "delivery_state_unavailable",
    run,
    phase: "6G",
    operation: "reconcile-github-delivery",
    outcome: observation === "delivery_state_unavailable" ? "recovery_unavailable" : "recovery_observed",
    observation,
    ownerActionRequired: true
  })
}

function noRecoveryResult(run) {
  return baseResult({
    ok: true,
    run,
    phase: "none",
    operation: "none",
    outcome: "recovery_not_required",
    observation: "not_applicable",
    continuationCandidate: !["merged", "verified"].includes(run.status)
  })
}

function planningInterruptedResult(run) {
  return baseResult({
    ok: false,
    run,
    phase: "6B",
    operation: "planning-interrupted",
    outcome: "owner_action_required",
    observation: "planning_interrupted",
    ownerActionRequired: true
  })
}

function productionOutOfScopeResult(run) {
  return baseResult({
    ok: false,
    run,
    phase: "none",
    operation: "none",
    outcome: "production_recovery_out_of_scope",
    observation: "project_out_of_scope",
    ownerActionRequired: true
  })
}

function terminalResult(run) {
  return baseResult({
    ok: true,
    run,
    phase: "none",
    operation: "none",
    outcome: "terminal_state",
    observation: "not_applicable"
  })
}

function projectOutOfScopeResult(run) {
  const selfDevelopment = projectIdFor(run) === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id

  return baseResult({
    ok: false,
    run,
    phase: "none",
    operation: "none",
    outcome: selfDevelopment ? "production_recovery_out_of_scope" : "recovery_unavailable",
    observation: selfDevelopment ? "project_out_of_scope" : "project_identity_invalid",
    ownerActionRequired: true
  })
}

function staleObservationResult(run, boundary) {
  return baseResult({
    ok: false,
    run,
    phase: boundary.phase,
    operation: boundary.operation,
    outcome: "stale_recovery_observation",
    observation: "state_changed",
    ownerActionRequired: true
  })
}

function stateChangedResult(run, boundary) {
  return baseResult({
    ok: false,
    run,
    phase: boundary.phase,
    operation: boundary.operation,
    outcome: "recovery_state_changed",
    observation: "state_changed",
    ownerActionRequired: true
  })
}

async function runChildRecovery(run, boundary, options = {}) {
  let profile

  try {
    profile = await resolveRecoveryProfile(run, boundary, options)
  } catch {
    return unavailableResult(run, boundary.phase, boundary.operation)
  }

  const child = reconcilers(options)[{
    "inspect-implementation-workspace": "inspectImplementationWorkspace",
    "reconcile-codex-execution": "reconcileCodexExecution",
    "reconcile-automated-testing": "reconcileAutomatedTesting",
    "reconcile-independent-review": "reconcileIndependentReview",
    "reconcile-github-delivery": "reconcileGitHubDelivery"
  }[boundary.operation]]

  if (typeof child !== "function") {
    return unavailableResult(run, boundary.phase, boundary.operation)
  }

  let childResult

  try {
    childResult = await child(run.runId, childOptions(options, profile, boundary.phase === "6G"))
  } catch {
    return unavailableResult(run, boundary.phase, boundary.operation)
  }

  if (childRunClaimsStateChange(run, childResult)) {
    return stateChangedResult(run, boundary)
  }

  let after

  try {
    after = await readRun(run.runId, options)
  } catch {
    return unavailableResult(run, boundary.phase, boundary.operation)
  }

  if (stateFingerprint(after) !== stateFingerprint(run)) {
    return staleObservationResult(after, boundary)
  }

  if (boundary.operation === "inspect-implementation-workspace") {
    return mapWorkspaceInspection(run, childResult)
  }

  if (boundary.operation === "reconcile-codex-execution") {
    return mapCodexReconciliation(run, childResult)
  }

  if (boundary.operation === "reconcile-automated-testing") {
    return mapAutomatedTesting(run, childResult, profile)
  }

  if (boundary.operation === "reconcile-independent-review") {
    return mapIndependentReview(run, childResult)
  }

  if (boundary.operation === "reconcile-github-delivery") {
    return mapGitHubDelivery(run, childResult)
  }

  return unavailableResult(run, boundary.phase, boundary.operation)
}

async function executeDevelopmentRecoveryInternal(runId, options = {}) {
  assertNoCallerControlledOptions(options)
  const normalizedRunId = normalizeRunId(runId)
  const run = await readRun(normalizedRunId, options)
  const projectValidation = validateRunProject(run)

  if (!projectValidation.ok) {
    return projectOutOfScopeResult(run)
  }

  if (!DEVELOPMENT_RUN_STATUSES.includes(run.status)) {
    return unavailableResult(run)
  }

  const boundary = PHASE_6L_RECOVERY_STATUS_CONTRACT[run.status]

  if (!boundary) {
    return unavailableResult(run)
  }

  if (run.status === "planning_in_progress") {
    return planningInterruptedResult(run)
  }

  if (productionStatuses.has(run.status)) {
    return productionOutOfScopeResult(run)
  }

  if (terminalStatuses.has(run.status)) {
    return terminalResult(run)
  }

  if (boundary.operation === "none") {
    return noRecoveryResult(run)
  }

  return await runChildRecovery(run, boundary, options)
}

export async function executeDevelopmentRecovery(runId, options = {}) {
  try {
    return await executeDevelopmentRecoveryInternal(runId, options)
  } catch (error) {
    return baseResult({
      ok: false,
      run: {
        runId: typeof runId === "string" && DEVELOPMENT_RUN_ID_PATTERN.test(runId) ? runId : "unknown",
        project: "unknown",
        version: null,
        status: "unknown",
        headSha: null
      },
      phase: "none",
      operation: "none",
      outcome: "recovery_unavailable",
      observation: "malformed_child_result",
      ownerActionRequired: true
    })
  }
}

export function formatDevelopmentRecoveryResult(result) {
  const run = result?.run || {}
  const ownerAction = result?.ownerActionRequired === true ? "required" : "not-required"
  const lines = [
    "PPO Development Recovery",
    `Run: ${run.runId || "unknown"}`,
    `Project: ${run.project || "unknown"}`,
    `Status: ${run.status || "unknown"}`,
    `Phase: ${result?.phase || "none"}`,
    `Observation: ${sanitizeObservation(result?.observation)}`,
    `Outcome: ${sanitizeOutcome(result?.outcome)}`,
    `Owner action: ${ownerAction}`
  ]

  return `${lines.join("\n")}\n`
}
