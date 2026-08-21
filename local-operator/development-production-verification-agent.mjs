import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  DEVELOPMENT_DEPLOYMENT_AGENT_ID,
  PHASE_6H_DEPLOYMENT_POLICY_HASH,
  PHASE_6H_DEPLOYMENT_POLICY_ID,
  PHASE_6H_PPO_DEPLOYMENT_PROFILE,
  resolveApprovedDeploymentProfile
} from "./development-deployment-agent.mjs"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD
} from "./github-delivery-agent.mjs"

const execFileAsync = promisify(execFile)

export const DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID = "phase-6i-production-verification-agent"
export const PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID = "phase-6i-readonly-ppo-production-verification-policy"
export const MAX_PRODUCTION_VERIFICATION_OUTPUT_BYTES = 32 * 1024
export const MAX_PRODUCTION_VERIFICATION_TIMEOUT_MS = 2 * 60 * 1000
export const PHASE_6I_PRODUCTION_VERIFICATION_SCRIPT =
  `${PHASE_6H_PPO_DEPLOYMENT_PROFILE.installDir}/deployment/scripts/verify-production-readonly.sh`

const shaPattern = /^[a-f0-9]{40}$/u
const safeResultClassPattern = /^[a-z][a-z0-9_-]{0,79}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const allowedResultClasses = new Set(["passed", "failed", "not_run", "not_applicable"])
const verificationResultKeys = new Set([
  "schemaVersion",
  "ok",
  "failureClass",
  "observedCheckoutSha",
  "serviceName",
  "serviceEnabled",
  "serviceActive",
  "serviceRunning",
  "serviceMainPidNonZero",
  "repository",
  "checkout",
  "clean",
  "previousRevision",
  "runtimePreflight",
  "openclawVersion",
  "serviceIdentity",
  "unitContract",
  "permissionContract",
  "bridge",
  "rollbackInvoked",
  "deploymentInvoked",
  "restartInvoked",
  "githubWriteInvoked",
  "modelInvoked",
  "routeInvoked"
])
const resultClassKeys = Object.freeze([
  "repository",
  "checkout",
  "clean",
  "previousRevision",
  "runtimePreflight",
  "openclawVersion",
  "serviceIdentity",
  "unitContract",
  "permissionContract",
  "bridge"
])
const callerTargetOptionKeys = Object.freeze([
  "deploymentSha",
  "checkoutSha",
  "observedCheckoutSha",
  "targetSha",
  "verificationTarget",
  "expectedDeploymentSha",
  "repository",
  "repositoryFullName",
  "remoteUrl",
  "service",
  "serviceName",
  "installDir",
  "stateDir",
  "deploymentProfile",
  "profile",
  "verificationPolicy",
  "policy",
  "command",
  "executable",
  "executablePath",
  "script",
  "scriptPath",
  "verificationCommand"
])

const productionVerificationPolicyContract = Object.freeze({
  phase: "6I",
  source: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
  startsFrom: "deployed",
  stopsAt: "verified",
  profile: PHASE_6H_PPO_DEPLOYMENT_PROFILE,
  verificationScript: PHASE_6I_PRODUCTION_VERIFICATION_SCRIPT,
  requiredChecks: Object.freeze([
    "fixed_repository_origin",
    "exact_deployed_head",
    "detached_checkout",
    "clean_worktree",
    "previous_revision_marker",
    "runtime_preflight",
    "openclaw_version",
    "systemd_enabled_active_running",
    "systemd_identity",
    "reviewed_unit_match",
    "permission_contract",
    "ppo_local_help_bridge"
  ])
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

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex")
}

export const PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH = sha256Text(stableStringify(productionVerificationPolicyContract))

export class DevelopmentProductionVerificationAgentError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentProductionVerificationAgentError"
  }
}

function verificationError(code, safeMessage) {
  return new DevelopmentProductionVerificationAgentError(code, safeMessage)
}

function safeProductionVerificationFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return verificationError(
    "PRODUCTION_VERIFICATION_AGENT_UNAVAILABLE",
    "Production verification agent is unavailable; no raw failure was stored."
  )
}

function timestamp(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString()
  }

  return date.toISOString()
}

function normalizeSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw verificationError(
      "PRODUCTION_VERIFICATION_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeOptionalSha(value, fieldName = "SHA") {
  if (value === null || value === undefined || String(value).trim() === "") {
    return ""
  }

  return normalizeSha(value, fieldName)
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw verificationError(
      "PRODUCTION_VERIFICATION_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required before production verification."
    )
  }

  return value
}

function normalizeSafeResultClass(value, fallback = "operation_failed") {
  const normalized = String(value || fallback).trim()

  if (!safeResultClassPattern.test(normalized) || sensitiveTextPattern.test(normalized) || unsafeControlPattern.test(normalized)) {
    return fallback
  }

  return normalized
}

function assertStrictSafeResultClass(value, fieldName) {
  const normalized = String(value ?? "").trim()

  if (
    !safeResultClassPattern.test(normalized) ||
    sensitiveTextPattern.test(normalized) ||
    unsafeControlPattern.test(normalized)
  ) {
    throw ambiguousProductionVerificationError(`${fieldName} was not a safe result class.`)
  }

  return normalized
}

function assertNoCallerVerificationTarget(options) {
  for (const key of callerTargetOptionKeys) {
    if (Object.hasOwn(options, key)) {
      throw verificationError(
        "PRODUCTION_VERIFICATION_TARGET_FROM_CALLER_REFUSED",
        "Production verification target and policy must come only from Phase 6H deployed evidence and the fixed PPO profile."
      )
    }
  }
}

function latestEvidence(run, kind, predicate) {
  const evidence = Array.isArray(run?.evidence?.[kind]) ? run.evidence[kind] : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (predicate(entry)) {
      return entry
    }
  }

  return null
}

function latestPhase6GMergedEvidence(run) {
  return latestEvidence(run, "merge", (entry) => (
    entry?.source === GITHUB_DELIVERY_AGENT_ID &&
    entry?.metadata?.agent === GITHUB_DELIVERY_AGENT_ID &&
    entry?.metadata?.outcome === "merged"
  ))
}

function latestPhase6HDeploymentEvidence(run) {
  return latestEvidence(run, "deploy", (entry) => (
    entry?.source === DEVELOPMENT_DEPLOYMENT_AGENT_ID &&
    entry?.metadata?.agent === DEVELOPMENT_DEPLOYMENT_AGENT_ID
  ))
}

function latestProductionVerificationEvidence(run, outcome = null) {
  return latestEvidence(run, "verification", (entry) => (
    entry?.source === DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID &&
    entry?.metadata?.agent === DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID &&
    (outcome === null || entry?.metadata?.outcome === outcome)
  ))
}

function assertProjectMatchesProfile(run, profile) {
  if (
    run?.project?.id !== profile.projectId ||
    run?.project?.fullName !== profile.repositoryFullName ||
    run?.project?.owner !== "Linardi1328" ||
    run?.project?.repo !== "personal-project-operator"
  ) {
    throw verificationError(
      "PRODUCTION_VERIFICATION_PROJECT_REFUSED",
      "Production verification supports only the approved personal-project-operator production profile."
    )
  }
}

function deployedEvidenceFacts(run, profile) {
  assertProjectMatchesProfile(run, profile)

  const runHeadSha = normalizeSha(run.headSha, "Run head SHA")
  const merged = latestPhase6GMergedEvidence(run)

  if (
    !merged ||
    merged.sha !== runHeadSha ||
    merged.metadata?.implementationSha !== runHeadSha ||
    merged.metadata?.expectedHeadSha !== runHeadSha ||
    merged.metadata?.mergeMethod !== PHASE_6G_APPROVED_MERGE_METHOD ||
    merged.metadata?.policyId !== PHASE_6G_DELIVERY_POLICY_ID ||
    merged.metadata?.policyHash !== PHASE_6G_DELIVERY_POLICY_HASH
  ) {
    throw verificationError(
      "PRODUCTION_VERIFICATION_SHA_CHAIN_INVALID",
      "Valid Phase 6G merge evidence is required before production verification."
    )
  }

  const deployed = latestPhase6HDeploymentEvidence(run)
  const deploymentSha = normalizeSha(deployed?.metadata?.deploymentSha, "Phase 6H deployment SHA")

  if (
    !deployed ||
    deployed.kind !== "deploy" ||
    deployed.sha !== deploymentSha ||
    deployed.metadata?.outcome !== "deployed" ||
    deployed.metadata?.project !== profile.projectId ||
    deployed.metadata?.policyId !== PHASE_6H_DEPLOYMENT_POLICY_ID ||
    deployed.metadata?.policyHash !== PHASE_6H_DEPLOYMENT_POLICY_HASH ||
    deployed.metadata?.checkoutSha !== deploymentSha ||
    deployed.metadata?.service !== profile.serviceName ||
    deployed.metadata?.preflight !== "passed" ||
    deployed.metadata?.restart !== "completed"
  ) {
    throw verificationError(
      "PRODUCTION_VERIFICATION_DEPLOYED_EVIDENCE_INVALID",
      "Valid Phase 6H deployed evidence is required before production verification."
    )
  }

  if (
    normalizeSha(merged.metadata?.mergeCommitSha, "Phase 6G merge commit SHA") !== deploymentSha ||
    merged.metadata?.mainSha !== deploymentSha
  ) {
    throw verificationError(
      "PRODUCTION_VERIFICATION_SHA_CHAIN_INVALID",
      "Phase 6H deployed SHA must equal the Phase 6G merge commit SHA."
    )
  }

  return {
    deploymentSha,
    previousInstalledSha: normalizeOptionalSha(deployed.metadata?.previousInstalledSha, "Previous installed SHA"),
    deployed,
    merged
  }
}

function stateApi(options = {}) {
  const runStateOptions = {
    ...options,
    allowPersonalProjectOperatorSelfDevelopmentProject: true
  }

  return {
    read: async (runId) => await (options.readDevelopmentRun || readDevelopmentRun)(runId, runStateOptions),
    transition: async (runId, transition) => await (options.transitionDevelopmentRun || transitionDevelopmentRun)(runId, transition, runStateOptions)
  }
}

function isUncertainOutcome(value) {
  return (
    value?.ambiguous === true ||
    value?.uncertain === true ||
    value?.interrupted === true ||
    value?.timedOut === true ||
    value?.killed === true ||
    typeof value?.signal === "string" ||
    value?.code === "ETIMEDOUT" ||
    value?.code === "ABORT_ERR" ||
    value?.code === "ENOBUFS" ||
    value?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  )
}

function ambiguousProductionVerificationError(detail = null) {
  const error = verificationError(
    "PRODUCTION_VERIFICATION_AMBIGUOUS",
    "Production verification outcome is ambiguous; reconcile read-only before retry."
  )
  error.ambiguous = true
  error.detail = detail
  return error
}

async function runTrustedProcess(executablePath, args, options = {}) {
  try {
    const result = await execFileAsync(executablePath, args, {
      cwd: "/",
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
      },
      encoding: "utf8",
      maxBuffer: MAX_PRODUCTION_VERIFICATION_OUTPUT_BYTES,
      timeout: MAX_PRODUCTION_VERIFICATION_TIMEOUT_MS,
      shell: false,
      ...options
    })

    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr
    }
  } catch (error) {
    if (isUncertainOutcome(error)) {
      throw ambiguousProductionVerificationError()
    }

    throw verificationError(
      "PRODUCTION_VERIFICATION_OPERATION_FAILED",
      "Approved production verification operation failed; no raw process output was stored."
    )
  }
}

function parseTrustedVerificationOutput(stdout) {
  let parsed

  try {
    parsed = JSON.parse(String(stdout || ""))
  } catch {
    throw ambiguousProductionVerificationError("verification output was not valid JSON")
  }

  return parsed
}

async function defaultProductionVerificationRunner(invocation) {
  if (invocation.kind !== "verify-production" && invocation.kind !== "inspect-production") {
    throw verificationError(
      "PRODUCTION_VERIFICATION_OPERATION_REFUSED",
      "Production verification operation is not approved."
    )
  }

  const result = await runTrustedProcess(PHASE_6I_PRODUCTION_VERIFICATION_SCRIPT, [
    invocation.deploymentSha,
    invocation.previousInstalledSha || ""
  ])

  return parseTrustedVerificationOutput(result.stdout)
}

function productionVerificationRunner(options = {}) {
  return options.verificationRunner || defaultProductionVerificationRunner
}

function booleanValue(value, fieldName) {
  if (typeof value !== "boolean") {
    throw ambiguousProductionVerificationError(`${fieldName} was not boolean`)
  }

  return value
}

function optionalBooleanValue(value, fieldName) {
  if (value === undefined) {
    return false
  }

  return booleanValue(value, fieldName)
}

function resultClassValue(value, fieldName) {
  const normalized = assertStrictSafeResultClass(value, fieldName)

  if (!allowedResultClasses.has(normalized)) {
    throw ambiguousProductionVerificationError(`${fieldName} was not an allowed result class`)
  }

  return normalized
}

function resultShaValue(value, fieldName) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return ""
  }

  const normalized = String(value).trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw ambiguousProductionVerificationError(`${fieldName} was not a valid SHA`)
  }

  return normalized
}

function assertStrictResultObject(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw ambiguousProductionVerificationError("verification result was not an object")
  }

  const keys = Object.keys(result)

  if (keys.length > verificationResultKeys.size || keys.some((key) => !verificationResultKeys.has(key))) {
    throw ambiguousProductionVerificationError("verification result used an unapproved schema")
  }

  if (result.schemaVersion !== 1) {
    throw ambiguousProductionVerificationError("verification result schema version was not approved")
  }
}

function firstFailedContractClass(result) {
  if (result.observedCheckoutSha === null || result.observedCheckoutSha === "") {
    return "checkout_sha_missing"
  }

  if (result.repository !== "passed") {
    return "repository_identity_failed"
  }

  if (result.checkout !== "passed") {
    return "checkout_contract_failed"
  }

  if (result.clean !== "passed") {
    return "dirty_checkout"
  }

  if (result.previousRevision !== "passed" && result.previousRevision !== "not_applicable") {
    return "previous_revision_mismatch"
  }

  if (result.runtimePreflight !== "passed") {
    return "runtime_preflight_failed"
  }

  if (result.openclawVersion !== "passed") {
    return "openclaw_version_failed"
  }

  if (result.serviceEnabled !== true) {
    return "service_not_enabled"
  }

  if (result.serviceActive !== true) {
    return "inactive_service"
  }

  if (result.serviceRunning !== true || result.serviceMainPidNonZero !== true) {
    return "service_not_running"
  }

  if (result.serviceIdentity !== "passed") {
    return "service_identity_mismatch"
  }

  if (result.unitContract !== "passed") {
    return "unit_contract_failed"
  }

  if (result.permissionContract !== "passed") {
    return "permission_contract_failed"
  }

  if (result.bridge !== "passed") {
    return "bridge_help_failed"
  }

  return "operation_failed"
}

function validateProductionVerificationResult(result, profile, expectedSha) {
  if (isUncertainOutcome(result)) {
    throw ambiguousProductionVerificationError()
  }

  assertStrictResultObject(result)

  const serviceName = String(result.serviceName || "")
  const observedCheckoutSha = resultShaValue(result.observedCheckoutSha, "observedCheckoutSha")
  const normalized = {
    ok: booleanValue(result.ok, "ok"),
    failureClass: result.failureClass === undefined ? "" : assertStrictSafeResultClass(result.failureClass, "failureClass"),
    observedCheckoutSha,
    serviceName,
    serviceEnabled: booleanValue(result.serviceEnabled, "serviceEnabled"),
    serviceActive: booleanValue(result.serviceActive, "serviceActive"),
    serviceRunning: booleanValue(result.serviceRunning, "serviceRunning"),
    serviceMainPidNonZero: booleanValue(result.serviceMainPidNonZero, "serviceMainPidNonZero"),
    rollbackInvoked: optionalBooleanValue(result.rollbackInvoked, "rollbackInvoked"),
    deploymentInvoked: optionalBooleanValue(result.deploymentInvoked, "deploymentInvoked"),
    restartInvoked: optionalBooleanValue(result.restartInvoked, "restartInvoked"),
    githubWriteInvoked: optionalBooleanValue(result.githubWriteInvoked, "githubWriteInvoked"),
    modelInvoked: optionalBooleanValue(result.modelInvoked, "modelInvoked"),
    routeInvoked: optionalBooleanValue(result.routeInvoked, "routeInvoked")
  }

  for (const key of resultClassKeys) {
    normalized[key] = resultClassValue(result[key], key)
  }

  if (
    normalized.rollbackInvoked ||
    normalized.deploymentInvoked ||
    normalized.restartInvoked ||
    normalized.githubWriteInvoked ||
    normalized.modelInvoked ||
    normalized.routeInvoked
  ) {
    return {
      ...normalized,
      ok: false,
      failureClass: "scope_violation"
    }
  }

  if (serviceName !== profile.serviceName) {
    return {
      ...normalized,
      ok: false,
      failureClass: "service_identity_mismatch"
    }
  }

  if (observedCheckoutSha !== expectedSha) {
    return {
      ...normalized,
      ok: false,
      failureClass: "checkout_sha_mismatch"
    }
  }

  const contractFailure = firstFailedContractClass(normalized)

  if (normalized.ok !== true || contractFailure !== "operation_failed") {
    const providedFailureClass = normalized.failureClass && normalized.failureClass !== "none"
      ? normalized.failureClass
      : ""

    return {
      ...normalized,
      ok: false,
      failureClass: normalizeSafeResultClass(providedFailureClass || contractFailure)
    }
  }

  return {
    ...normalized,
    ok: true,
    failureClass: ""
  }
}

async function inspectProduction(profile, facts, options = {}) {
  const result = await productionVerificationRunner(options)({
    kind: "inspect-production",
    profile,
    deploymentSha: facts.deploymentSha,
    previousInstalledSha: facts.previousInstalledSha,
    serviceName: profile.serviceName,
    shell: false,
    timeoutMs: MAX_PRODUCTION_VERIFICATION_TIMEOUT_MS,
    maxOutputBytes: MAX_PRODUCTION_VERIFICATION_OUTPUT_BYTES
  })

  return validateProductionVerificationResult(result, profile, facts.deploymentSha)
}

async function performProductionVerification(profile, facts, options = {}) {
  try {
    const result = await productionVerificationRunner(options)({
      kind: "verify-production",
      profile,
      deploymentSha: facts.deploymentSha,
      previousInstalledSha: facts.previousInstalledSha,
      serviceName: profile.serviceName,
      shell: false,
      timeoutMs: MAX_PRODUCTION_VERIFICATION_TIMEOUT_MS,
      maxOutputBytes: MAX_PRODUCTION_VERIFICATION_OUTPUT_BYTES
    })

    return validateProductionVerificationResult(result, profile, facts.deploymentSha)
  } catch (error) {
    if (isUncertainOutcome(error) || error?.code === "PRODUCTION_VERIFICATION_AMBIGUOUS") {
      throw ambiguousProductionVerificationError()
    }

    if (error instanceof DevelopmentRunStateError && error.code !== "PRODUCTION_VERIFICATION_OPERATION_FAILED") {
      throw error
    }

    return {
      ok: false,
      failureClass: "operation_failed",
      observedCheckoutSha: "",
      serviceName: profile.serviceName,
      serviceEnabled: false,
      serviceActive: false,
      serviceRunning: false,
      serviceMainPidNonZero: false,
      runtimePreflight: "not_run",
      bridge: "not_run",
      permissionContract: "not_run",
      unitContract: "not_run"
    }
  }
}

function verificationEvidence(run, deploymentSha, outcome, metadata, summary) {
  return {
    kind: "verification",
    sha: deploymentSha,
    source: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
    summary,
    metadata: {
      project: run.project.id,
      agent: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
      policyId: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
      policyHash: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
      deploymentSha,
      outcome,
      ...metadata
    }
  }
}

function verificationResultMetadata(result) {
  return {
    checkoutSha: result.observedCheckoutSha || "",
    service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
    active: result.serviceActive === true,
    running: result.serviceRunning === true && result.serviceMainPidNonZero === true,
    runtimePreflight: result.runtimePreflight || "not_run",
    bridge: result.bridge || "not_run",
    permissionContract: result.permissionContract || "not_run",
    unitContract: result.unitContract || "not_run"
  }
}

async function transitionVerificationFailed(run, facts, result, options = {}) {
  const api = stateApi(options)
  const evidence = verificationEvidence(run, facts.deploymentSha, "verification_failed", {
    attempt: run.attempts.verification,
    failureClass: normalizeSafeResultClass(result.failureClass),
    ...verificationResultMetadata(result)
  }, "Phase 6I production verification failed definitively.")

  return await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "verification_failed",
    actor: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
    reason: "phase-6i-production-verification-failed",
    evidence: [evidence]
  }, options)
}

async function transitionVerified(run, facts, result, options = {}) {
  const api = stateApi(options)
  const evidence = verificationEvidence(run, facts.deploymentSha, "verified", {
    attempt: run.attempts.verification,
    ...verificationResultMetadata(result)
  }, "Phase 6I production verification completed.")

  return await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "verified",
    actor: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
    reason: "phase-6i-production-verified",
    evidence: [evidence]
  }, options)
}

async function executeDevelopmentProductionVerificationInternal(runId, options = {}) {
  assertNoCallerVerificationTarget(options)

  const expectedVersion = normalizeExpectedVersion(options.expectedVersion)
  const api = stateApi(options)
  const profile = resolveApprovedDeploymentProfile()
  let run = await api.read(runId, options)

  if (run.version !== expectedVersion) {
    throw verificationError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before production verification."
    )
  }

  if (run.status !== "deployed") {
    throw verificationError(
      "PRODUCTION_VERIFICATION_RUN_NOT_DEPLOYED",
      "Development run must be deployed before production verification."
    )
  }

  const facts = deployedEvidenceFacts(run, profile)
  const attempt = run.attempts.verification + 1

  run = await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "verification_in_progress",
    actor: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
    reason: "phase-6i-production-verification-start",
    evidence: [verificationEvidence(run, facts.deploymentSha, "verification_started", {
      attempt,
      service: profile.serviceName,
      recordedAt: timestamp(options)
    }, "Phase 6I production verification attempt was reserved.")]
  }, options)

  const verification = await performProductionVerification(profile, facts, options)
  const current = await api.read(run.runId, options)

  if (current.status !== "verification_in_progress") {
    throw verificationError(
      "STALE_RUN_VERSION",
      "Development run state changed during production verification; reconcile before retrying."
    )
  }

  const currentFacts = deployedEvidenceFacts(current, profile)

  if (currentFacts.deploymentSha !== facts.deploymentSha) {
    throw verificationError(
      "PRODUCTION_VERIFICATION_SHA_CHAIN_INVALID",
      "Deployment SHA changed during production verification; reconcile before retrying."
    )
  }

  if (!verification.ok) {
    const failedRun = await transitionVerificationFailed(current, facts, verification, options)

    return {
      ok: false,
      outcome: "verification_failed",
      run: failedRun,
      verification: {
        policyId: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
        policyHash: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
        deploymentSha: facts.deploymentSha,
        checkoutSha: verification.observedCheckoutSha || "",
        service: profile.serviceName,
        failureClass: normalizeSafeResultClass(verification.failureClass)
      }
    }
  }

  const verifiedRun = await transitionVerified(current, facts, verification, options)

  return {
    ok: true,
    outcome: "verified",
    run: verifiedRun,
    verification: {
      policyId: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
      policyHash: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
      deploymentSha: facts.deploymentSha,
      checkoutSha: verification.observedCheckoutSha,
      service: profile.serviceName
    }
  }
}

export async function executeDevelopmentProductionVerification(runId, options = {}) {
  try {
    return await executeDevelopmentProductionVerificationInternal(runId, options)
  } catch (error) {
    throw safeProductionVerificationFailure(error)
  }
}

function verificationAttempt(run) {
  const started = latestProductionVerificationEvidence(run, "verification_started")

  if (started?.metadata?.attempt && Number.isInteger(started.metadata.attempt)) {
    return started.metadata.attempt
  }

  return null
}

function verificationEvidenceComplete(run, deploymentSha, checkoutSha) {
  const verified = latestProductionVerificationEvidence(run, "verified")

  return Boolean(
    verified &&
    verified.sha === deploymentSha &&
    verified.metadata?.deploymentSha === deploymentSha &&
    verified.metadata?.checkoutSha === checkoutSha &&
    verified.metadata?.runtimePreflight === "passed" &&
    verified.metadata?.bridge === "passed" &&
    verified.metadata?.permissionContract === "passed" &&
    verified.metadata?.unitContract === "passed"
  )
}

async function reconcileDevelopmentProductionVerificationInternal(runId, options = {}) {
  assertNoCallerVerificationTarget(options)

  const api = stateApi(options)
  const profile = resolveApprovedDeploymentProfile()
  const run = await api.read(runId, options)
  let facts = null
  let inspection = null
  let expectedDeploymentSha = null
  let evidenceComplete = false
  let ownerActionRequired = false

  try {
    facts = deployedEvidenceFacts(run, profile)
    expectedDeploymentSha = facts.deploymentSha
    inspection = await inspectProduction(profile, facts, options)
    evidenceComplete = verificationEvidenceComplete(run, facts.deploymentSha, inspection.observedCheckoutSha)
    ownerActionRequired = run.status === "verification_in_progress" && !evidenceComplete
  } catch {
    ownerActionRequired = ["verification_in_progress", "verification_failed"].includes(run.status)
  }

  return {
    ok: true,
    outcome: "production_verification_reconciled",
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id,
      headSha: run.headSha
    },
    verification: {
      policyId: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
      policyHash: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
      expectedDeploymentSha,
      attempt: verificationAttempt(run),
      currentCheckoutSha: inspection?.observedCheckoutSha || null,
      service: {
        name: profile.serviceName,
        enabled: inspection?.serviceEnabled === true,
        active: inspection?.serviceActive === true,
        running: inspection?.serviceRunning === true && inspection?.serviceMainPidNonZero === true
      },
      verificationEvidenceComplete: evidenceComplete,
      completionProven: run.status === "verified" && evidenceComplete,
      retryRequiresOwnerAction: ownerActionRequired,
      ownerActionRequired
    }
  }
}

export async function reconcileDevelopmentProductionVerification(runId, options = {}) {
  try {
    return await reconcileDevelopmentProductionVerificationInternal(runId, options)
  } catch (error) {
    throw safeProductionVerificationFailure(error)
  }
}

export function formatDevelopmentProductionVerificationAgentError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO production verification error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO production verification error: unexpected local failure."
}

export const phase6IProductionVerificationSecurityBoundary = Object.freeze({
  policyId: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
  policyHash: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
  startsFrom: "deployed",
  stopsAt: "verified",
  verifiesExactDeploymentShaOnly: true,
  readOnlyProduction: true,
  rollback: false,
  deploymentMutation: false,
  serviceRestart: false,
  gitMutation: false,
  githubWrite: false,
  modelExecution: false,
  ppoContinue: false,
  telegramOrOpenClawRouting: false
})
