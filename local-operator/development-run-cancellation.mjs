import { createHash } from "node:crypto"
import {
  DEVELOPMENT_RUN_CATALOG_ID,
  PHASE_6N_RUN_CATALOG_POLICY_HASH,
  PHASE_6N_RUN_CATALOG_POLICY_ID,
  inspectDevelopmentRunSummary
} from "./development-run-catalog.mjs"
import { DEVELOPMENT_RUN_ID_PATTERN } from "./development-run-id.mjs"
import {
  DEVELOPMENT_RUN_STATUSES,
  DevelopmentRunStateError,
  isDevelopmentRunTerminalStatus,
  stageForDevelopmentRunStatus,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import { getPhase2GitHubProject, listPhase2GitHubProjects } from "./github-project-registry.mjs"

export const DEVELOPMENT_RUN_CANCELLATION_ID = "phase-6p-quiescent-development-run-cancellation"
export const PHASE_6P_RUN_CANCELLATION_POLICY_ID = "phase-6p-quiescent-development-run-cancellation-policy"
export const DEVELOPMENT_RUN_CANCELLATION_ACTOR = "phase-6p-quiescent-cancellation"
export const DEVELOPMENT_RUN_CANCELLATION_REASON = "owner_requested_quiescent_cancellation"

export const DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES = Object.freeze([
  "created",
  "planned",
  "implementation_ready",
  "tests_failed",
  "tests_passed",
  "review_changes_requested"
])

export const DEVELOPMENT_RUN_CANCELLATION_IN_PROGRESS_STATUSES = Object.freeze([
  "planning_in_progress",
  "implementation_in_progress",
  "tests_in_progress",
  "review_in_progress"
])

export const DEVELOPMENT_RUN_CANCELLATION_DELIVERY_STATUSES = Object.freeze([
  "review_passed",
  "merge_ready",
  "merged"
])

export const DEVELOPMENT_RUN_CANCELLATION_PRODUCTION_STATUSES = Object.freeze([
  "deploy_in_progress",
  "deploy_failed",
  "deployed",
  "verification_in_progress",
  "verification_failed",
  "rollback_in_progress",
  "rollback_failed",
  "rolled_back"
])

const eligibleStatusSet = new Set(DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES)
const inProgressStatusSet = new Set(DEVELOPMENT_RUN_CANCELLATION_IN_PROGRESS_STATUSES)
const deliveryStatusSet = new Set(DEVELOPMENT_RUN_CANCELLATION_DELIVERY_STATUSES)
const productionStatusSet = new Set(DEVELOPMENT_RUN_CANCELLATION_PRODUCTION_STATUSES)
const statusSet = new Set(DEVELOPMENT_RUN_STATUSES)
const terminalStatuses = Object.freeze(DEVELOPMENT_RUN_STATUSES.filter((status) => isDevelopmentRunTerminalStatus(status)))
const shaPattern = /^[a-f0-9]{40}$/u
const cancellationRequestIdPattern = /^[A-Za-z0-9_-]{43}$/u
const policyHashPattern = /^[a-f0-9]{64}$/u
const unsafeTextPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = new RegExp([
  "SENSITIVE_TEST_SENTINEL",
  `gi${"thub_pat_"}[A-Za-z0-9_]+`,
  `${"g"}${"h"}[opusr]_[A-Za-z0-9_]+`,
  "sk-[A-Za-z0-9_-]{8,}",
  "BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY",
  "authorization\\s*:",
  "password\\s*[=:]",
  "token\\s*[=:]",
  "secret\\s*[=:]",
  "credential\\s*[=:]",
  "PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD)"
].join("|"), "iu")
const pathLikeTextPattern = /(?:^\.{1,2}(?:\/|$)|\/|\\|[A-Za-z]:\\|~\/)/u

const safeCancellationCodes = new Set([
  "cancellation_ready",
  "cancellation_staged",
  "cancelled",
  "invalid_run_id",
  "invalid_request_id",
  "run_not_found",
  "project_out_of_scope",
  "state_not_quiescent",
  "delivery_state_out_of_scope",
  "production_state_out_of_scope",
  "terminal_state",
  "canonical_recovery_required",
  "stale_state",
  "request_expired",
  "request_not_found",
  "request_already_consumed",
  "store_unavailable",
  "cancellation_unavailable"
])

const canonicalRecoveryCodes = new Set([
  "canonical_behind",
  "canonical_missing",
  "canonical_conflict",
  "record_invalid",
  "history_invalid",
  "stale_observation",
  "store_missing",
  "store_unavailable"
])

const cancellationContract = Object.freeze({
  cancellation: DEVELOPMENT_RUN_CANCELLATION_ID,
  policy: PHASE_6P_RUN_CANCELLATION_POLICY_ID,
  schemaVersion: 1,
  ordinaryProjects: listPhase2GitHubProjects().map((project) => project.id).sort(),
  statusClassification: {
    eligible: DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES,
    refusedInProgress: DEVELOPMENT_RUN_CANCELLATION_IN_PROGRESS_STATUSES,
    refusedDelivery: DEVELOPMENT_RUN_CANCELLATION_DELIVERY_STATUSES,
    refusedProduction: DEVELOPMENT_RUN_CANCELLATION_PRODUCTION_STATUSES,
    refusedTerminal: terminalStatuses,
    refusalCodes: {
      inProgress: "state_not_quiescent",
      delivery: "delivery_state_out_of_scope",
      production: "production_state_out_of_scope",
      terminal: "terminal_state"
    }
  },
  canonicalStateRequired: "canonical_current",
  expectedVersionRequired: true,
  targetStatus: "cancelled",
  fixedActor: DEVELOPMENT_RUN_CANCELLATION_ACTOR,
  fixedReason: DEVELOPMENT_RUN_CANCELLATION_REASON,
  evidence: false,
  cleanup: false,
  processInterruption: false,
  githubActions: false,
  hostedSourceActions: false,
  productionActions: false,
  engine: {
    catalog: DEVELOPMENT_RUN_CATALOG_ID,
    policy: {
      id: PHASE_6N_RUN_CATALOG_POLICY_ID,
      hash: PHASE_6N_RUN_CATALOG_POLICY_HASH
    }
  }
})

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

export const PHASE_6P_RUN_CANCELLATION_POLICY_HASH = createHash("sha256")
  .update(stableStringify(cancellationContract))
  .digest("hex")

export function developmentRunCancellationPolicy() {
  return {
    id: PHASE_6P_RUN_CANCELLATION_POLICY_ID,
    hash: PHASE_6P_RUN_CANCELLATION_POLICY_HASH
  }
}

function hasOnlyKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const allowed = new Set(keys)
  const actual = Object.keys(value)

  return actual.length === keys.length && actual.every((key) => allowed.has(key))
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isSafeScalar(value, maxChars = 120) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !unsafeTextPattern.test(value) &&
    !sensitiveTextPattern.test(value) &&
    !pathLikeTextPattern.test(value)
  )
}

function isNullableHeadSha(value) {
  return value === null || (typeof value === "string" && shaPattern.test(value))
}

function formatHeadShaLine(headSha) {
  return `Head: ${headSha === null ? "(none)" : headSha}`
}

function safeCode(code) {
  return typeof code === "string" && safeCancellationCodes.has(code)
    ? code
    : "cancellation_unavailable"
}

export function makeDevelopmentRunCancellationFailure(code) {
  return {
    schemaVersion: 1,
    cancellation: DEVELOPMENT_RUN_CANCELLATION_ID,
    policy: developmentRunCancellationPolicy(),
    ok: false,
    code: safeCode(code),
    outcome: safeCode(code)
  }
}

function validateSummaryForCancellation(summary) {
  if (!summary || typeof summary !== "object") {
    return false
  }

  return (
    summary.schemaVersion === 1 &&
    DEVELOPMENT_RUN_ID_PATTERN.test(summary.runId) &&
    getPhase2GitHubProject(summary.project) !== null &&
    statusSet.has(summary.status) &&
    stageForDevelopmentRunStatus(summary.status) === summary.stage &&
    Number.isInteger(summary.version) &&
    summary.version >= 0 &&
    isNullableHeadSha(summary.headSha) &&
    summary.canonicalState === "canonical_current"
  )
}

export function classifyDevelopmentRunCancellationStatus(status) {
  if (!statusSet.has(status)) {
    return "cancellation_unavailable"
  }

  if (eligibleStatusSet.has(status)) {
    return "eligible"
  }

  if (isDevelopmentRunTerminalStatus(status)) {
    return "terminal_state"
  }

  if (inProgressStatusSet.has(status)) {
    return "state_not_quiescent"
  }

  if (deliveryStatusSet.has(status)) {
    return "delivery_state_out_of_scope"
  }

  if (productionStatusSet.has(status)) {
    return "production_state_out_of_scope"
  }

  return "cancellation_unavailable"
}

function catalogOptions(options = {}) {
  const next = {}

  if (Object.prototype.hasOwnProperty.call(options, "writeDataDir")) {
    next.writeDataDir = options.writeDataDir
  }

  if (typeof options.__readOnlyBeforeFinalCheck === "function") {
    next.__readOnlyBeforeFinalCheck = options.__readOnlyBeforeFinalCheck
  }

  return next
}

function cancellationOptions(options = {}) {
  const next = {}

  if (Object.prototype.hasOwnProperty.call(options, "writeDataDir")) {
    next.writeDataDir = options.writeDataDir
  }

  if (typeof options.now === "function") {
    next.now = options.now
  }

  return next
}

function catalogApi(options = {}) {
  const injected = options.catalogApi && typeof options.catalogApi === "object" ? options.catalogApi : {}

  return {
    inspectDevelopmentRunSummary: typeof injected.inspectDevelopmentRunSummary === "function"
      ? injected.inspectDevelopmentRunSummary
      : inspectDevelopmentRunSummary
  }
}

function transitionApi(options = {}) {
  const injected = options.stateApi && typeof options.stateApi === "object" ? options.stateApi : {}

  return {
    transitionDevelopmentRun: typeof injected.transitionDevelopmentRun === "function"
      ? injected.transitionDevelopmentRun
      : transitionDevelopmentRun
  }
}

function mapCatalogFailure(result) {
  if (result?.code === "project_out_of_scope") {
    return makeDevelopmentRunCancellationFailure("project_out_of_scope")
  }

  if (result?.code === "run_not_found") {
    return makeDevelopmentRunCancellationFailure("run_not_found")
  }

  if (canonicalRecoveryCodes.has(result?.code) || canonicalRecoveryCodes.has(result?.canonicalState)) {
    return makeDevelopmentRunCancellationFailure(
      result?.code === "store_unavailable" || result?.canonicalState === "store_unavailable"
        ? "store_unavailable"
        : "canonical_recovery_required"
    )
  }

  return makeDevelopmentRunCancellationFailure("cancellation_unavailable")
}

export async function inspectDevelopmentRunCancellationEligibility(runId, options = {}) {
  if (typeof runId !== "string" || !DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    return makeDevelopmentRunCancellationFailure("invalid_run_id")
  }

  let inspected

  try {
    inspected = await catalogApi(options).inspectDevelopmentRunSummary(runId, catalogOptions(options))
  } catch {
    return makeDevelopmentRunCancellationFailure("cancellation_unavailable")
  }

  if (!inspected?.ok) {
    return mapCatalogFailure(inspected)
  }

  const summary = inspected.summary

  if (summary?.canonicalState !== "canonical_current") {
    return makeDevelopmentRunCancellationFailure("canonical_recovery_required")
  }

  if (!validateSummaryForCancellation(summary)) {
    return makeDevelopmentRunCancellationFailure("cancellation_unavailable")
  }

  const statusClass = classifyDevelopmentRunCancellationStatus(summary.status)

  if (statusClass !== "eligible") {
    return makeDevelopmentRunCancellationFailure(statusClass)
  }

  return {
    schemaVersion: 1,
    cancellation: DEVELOPMENT_RUN_CANCELLATION_ID,
    policy: developmentRunCancellationPolicy(),
    ok: true,
    code: "cancellation_ready",
    outcome: "cancellation_ready",
    runId: summary.runId,
    project: summary.project,
    beforeStatus: summary.status,
    expectedVersion: summary.version,
    headSha: summary.headSha,
    canonicalState: summary.canonicalState
  }
}

function normalizePreparedCancellation(input) {
  if (!hasOnlyKeys(input, ["runId", "expectedVersion", "projectId", "beforeStatus"])) {
    return null
  }

  if (
    !DEVELOPMENT_RUN_ID_PATTERN.test(input.runId) ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !getPhase2GitHubProject(input.projectId) ||
    !eligibleStatusSet.has(input.beforeStatus)
  ) {
    return null
  }

  return {
    runId: input.runId,
    expectedVersion: input.expectedVersion,
    projectId: input.projectId,
    beforeStatus: input.beforeStatus
  }
}

export async function executeDevelopmentRunCancellation(preparedCancellation, options = {}) {
  const prepared = normalizePreparedCancellation(preparedCancellation)

  if (!prepared) {
    return makeDevelopmentRunCancellationFailure("cancellation_unavailable")
  }

  let inspected

  try {
    inspected = await catalogApi(options).inspectDevelopmentRunSummary(prepared.runId, catalogOptions(options))
  } catch {
    return makeDevelopmentRunCancellationFailure("cancellation_unavailable")
  }

  if (!inspected?.ok) {
    return mapCatalogFailure(inspected)
  }

  const summary = inspected.summary

  if (summary?.canonicalState !== "canonical_current") {
    return makeDevelopmentRunCancellationFailure("canonical_recovery_required")
  }

  if (!validateSummaryForCancellation(summary)) {
    return makeDevelopmentRunCancellationFailure("cancellation_unavailable")
  }

  if (
    summary.project !== prepared.projectId ||
    summary.version !== prepared.expectedVersion ||
    summary.status !== prepared.beforeStatus ||
    classifyDevelopmentRunCancellationStatus(summary.status) !== "eligible"
  ) {
    return makeDevelopmentRunCancellationFailure("stale_state")
  }

  try {
    if (typeof options.__afterCancellationRevalidation === "function") {
      await options.__afterCancellationRevalidation({
        runId: prepared.runId,
        expectedVersion: prepared.expectedVersion,
        projectId: prepared.projectId,
        beforeStatus: prepared.beforeStatus
      })
    }

    const next = await transitionApi(options).transitionDevelopmentRun(prepared.runId, {
      expectedVersion: prepared.expectedVersion,
      status: "cancelled",
      actor: DEVELOPMENT_RUN_CANCELLATION_ACTOR,
      reason: DEVELOPMENT_RUN_CANCELLATION_REASON
    }, cancellationOptions(options))

    return {
      schemaVersion: 1,
      cancellation: DEVELOPMENT_RUN_CANCELLATION_ID,
      policy: developmentRunCancellationPolicy(),
      ok: true,
      code: "cancelled",
      outcome: "cancelled",
      runId: next.runId,
      project: next.project.id,
      beforeStatus: prepared.beforeStatus,
      afterStatus: next.status,
      beforeVersion: prepared.expectedVersion,
      afterVersion: next.version,
      headSha: next.headSha,
      reason: DEVELOPMENT_RUN_CANCELLATION_REASON
    }
  } catch (error) {
    if (error instanceof DevelopmentRunStateError && error.code === "STALE_RUN_VERSION") {
      return makeDevelopmentRunCancellationFailure("stale_state")
    }

    return makeDevelopmentRunCancellationFailure("cancellation_unavailable")
  }
}

function validPolicy(value) {
  return (
    hasOnlyKeys(value, ["id", "hash"]) &&
    value.id === PHASE_6P_RUN_CANCELLATION_POLICY_ID &&
    value.hash === PHASE_6P_RUN_CANCELLATION_POLICY_HASH &&
    policyHashPattern.test(value.hash)
  )
}

function validFailureResult(result) {
  return (
    hasOnlyKeys(result, ["schemaVersion", "cancellation", "policy", "ok", "code", "outcome"]) &&
    result.schemaVersion === 1 &&
    result.cancellation === DEVELOPMENT_RUN_CANCELLATION_ID &&
    validPolicy(result.policy) &&
    result.ok === false &&
    safeCancellationCodes.has(result.code) &&
    result.code !== "cancellation_ready" &&
    result.code !== "cancellation_staged" &&
    result.code !== "cancelled" &&
    result.outcome === result.code
  )
}

function validReadyResult(result) {
  return (
    hasOnlyKeys(result, [
      "schemaVersion",
      "cancellation",
      "policy",
      "ok",
      "code",
      "outcome",
      "runId",
      "project",
      "beforeStatus",
      "expectedVersion",
      "headSha",
      "canonicalState"
    ]) &&
    result.schemaVersion === 1 &&
    result.cancellation === DEVELOPMENT_RUN_CANCELLATION_ID &&
    validPolicy(result.policy) &&
    result.ok === true &&
    result.code === "cancellation_ready" &&
    result.outcome === "cancellation_ready" &&
    DEVELOPMENT_RUN_ID_PATTERN.test(result.runId) &&
    isSafeScalar(result.runId, 43) &&
    getPhase2GitHubProject(result.project) !== null &&
    eligibleStatusSet.has(result.beforeStatus) &&
    Number.isInteger(result.expectedVersion) &&
    result.expectedVersion >= 0 &&
    isNullableHeadSha(result.headSha) &&
    result.canonicalState === "canonical_current"
  )
}

function validStagedResult(result) {
  return (
    hasOnlyKeys(result, [
      "schemaVersion",
      "cancellation",
      "policy",
      "ok",
      "code",
      "outcome",
      "runId",
      "project",
      "beforeStatus",
      "expectedVersion",
      "headSha",
      "requestId",
      "createdAt",
      "expiresAt"
    ]) &&
    result.schemaVersion === 1 &&
    result.cancellation === DEVELOPMENT_RUN_CANCELLATION_ID &&
    validPolicy(result.policy) &&
    result.ok === true &&
    result.code === "cancellation_staged" &&
    result.outcome === "cancellation_staged" &&
    DEVELOPMENT_RUN_ID_PATTERN.test(result.runId) &&
    isSafeScalar(result.runId, 43) &&
    getPhase2GitHubProject(result.project) !== null &&
    eligibleStatusSet.has(result.beforeStatus) &&
    Number.isInteger(result.expectedVersion) &&
    result.expectedVersion >= 0 &&
    isNullableHeadSha(result.headSha) &&
    typeof result.requestId === "string" &&
    cancellationRequestIdPattern.test(result.requestId) &&
    isSafeScalar(result.requestId, 43) &&
    isIsoTimestamp(result.createdAt) &&
    isIsoTimestamp(result.expiresAt) &&
    Date.parse(result.expiresAt) > Date.parse(result.createdAt)
  )
}

function validCancelledResult(result) {
  return (
    hasOnlyKeys(result, [
      "schemaVersion",
      "cancellation",
      "policy",
      "ok",
      "code",
      "outcome",
      "runId",
      "project",
      "beforeStatus",
      "afterStatus",
      "beforeVersion",
      "afterVersion",
      "headSha",
      "reason"
    ]) &&
    result.schemaVersion === 1 &&
    result.cancellation === DEVELOPMENT_RUN_CANCELLATION_ID &&
    validPolicy(result.policy) &&
    result.ok === true &&
    result.code === "cancelled" &&
    result.outcome === "cancelled" &&
    DEVELOPMENT_RUN_ID_PATTERN.test(result.runId) &&
    isSafeScalar(result.runId, 43) &&
    getPhase2GitHubProject(result.project) !== null &&
    eligibleStatusSet.has(result.beforeStatus) &&
    result.afterStatus === "cancelled" &&
    Number.isInteger(result.beforeVersion) &&
    Number.isInteger(result.afterVersion) &&
    result.afterVersion === result.beforeVersion + 1 &&
    isNullableHeadSha(result.headSha) &&
    result.reason === DEVELOPMENT_RUN_CANCELLATION_REASON
  )
}

function unavailableCancellationOutput() {
  return [
    "PPO Development Run Cancellation",
    "Status: unavailable"
  ].join("\n")
}

export function formatDevelopmentRunCancellation(result) {
  try {
    if (validFailureResult(result)) {
      return [
        "PPO Development Run Cancellation",
        "Status: unavailable",
        `Outcome: ${result.outcome}`
      ].join("\n")
    }

    if (validReadyResult(result)) {
      return [
        "PPO Development Run Cancellation",
        "Status: ready",
        `Run: ${result.runId}`,
        `Project: ${result.project}`,
        `Before: ${result.beforeStatus}`,
        `Version: ${result.expectedVersion}`,
        formatHeadShaLine(result.headSha)
      ].join("\n")
    }

    if (validStagedResult(result)) {
      return [
        "PPO Development Run Cancellation",
        "Status: staged",
        `Run: ${result.runId}`,
        `Project: ${result.project}`,
        `Before: ${result.beforeStatus}`,
        `Version: ${result.expectedVersion}`,
        formatHeadShaLine(result.headSha),
        `Request: ${result.requestId}`,
        `Expires: ${result.expiresAt}`,
        `Confirm: /ppo cancel-confirm ${result.requestId}`
      ].join("\n")
    }

    if (validCancelledResult(result)) {
      return [
        "PPO Development Run Cancellation",
        "Status: cancelled",
        `Run: ${result.runId}`,
        `Project: ${result.project}`,
        `Before: ${result.beforeStatus}`,
        `After: ${result.afterStatus}`,
        `Version: ${result.beforeVersion} -> ${result.afterVersion}`,
        formatHeadShaLine(result.headSha),
        `Reason: ${result.reason}`
      ].join("\n")
    }

    return unavailableCancellationOutput()
  } catch {
    return unavailableCancellationOutput()
  }
}
