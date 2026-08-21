import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  readDevelopmentRun,
  recordDevelopmentRunProgress,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID,
  latestPhase6DImplementationEvidence,
  latestPhase6EPassEvidence,
  latestPhase6FApprovedReviewEvidence
} from "./development-acceptance-gate.mjs"
import {
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS
} from "./development-review-agent.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD
} from "./github-delivery-agent.mjs"

const execFileAsync = promisify(execFile)

export const DEVELOPMENT_DEPLOYMENT_AGENT_ID = "phase-6h-exact-sha-deployment-agent"
export const PHASE_6H_DEPLOYMENT_POLICY_ID = "phase-6h-exact-sha-ppo-deployment-policy"
export const MAX_DEPLOYMENT_OUTPUT_BYTES = 32 * 1024
export const MAX_DEPLOYMENT_TIMEOUT_MS = 5 * 60 * 1000

const shaPattern = /^[a-f0-9]{40}$/u
const safeResultClassPattern = /^[a-z][a-z0-9_-]{0,79}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const allowedRemotePatterns = Object.freeze([
  /^https:\/\/github\.com\/Linardi1328\/personal-project-operator(?:\.git)?$/u,
  /^git@github\.com:Linardi1328\/personal-project-operator(?:\.git)?$/u,
  /^ssh:\/\/git@github\.com\/Linardi1328\/personal-project-operator(?:\.git)?$/u
])
const callerShaOptionKeys = Object.freeze([
  "deploymentSha",
  "targetSha",
  "deploySha",
  "expectedDeploymentSha",
  "sha"
])

export const PHASE_6H_PPO_DEPLOYMENT_PROFILE = Object.freeze({
  profileId: "personal-project-operator-production",
  projectId: "personal-project-operator",
  repositoryFullName: "Linardi1328/personal-project-operator",
  installDir: "/opt/personal-project-operator",
  stateDir: "/var/lib/personal-project-operator",
  serviceName: "ppo-openclaw.service",
  remoteName: "origin",
  approvedRemote: "https://github.com/Linardi1328/personal-project-operator.git",
  mainRef: "main",
  deployScript: "/opt/personal-project-operator/deployment/scripts/deploy-exact-sha.sh",
  preflightScript: "/opt/personal-project-operator/deployment/scripts/preflight-openclaw-runtime.sh",
  serviceControlScript: "/opt/personal-project-operator/deployment/scripts/service-control.sh",
  gitExecutable: "/usr/bin/git"
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

export const PHASE_6H_DEPLOYMENT_POLICY_HASH = sha256Text(stableStringify(PHASE_6H_PPO_DEPLOYMENT_PROFILE))

export class DevelopmentDeploymentAgentError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentDeploymentAgentError"
  }
}

function deploymentError(code, safeMessage) {
  return new DevelopmentDeploymentAgentError(code, safeMessage)
}

function safeDeploymentFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return deploymentError(
    "DEPLOYMENT_AGENT_UNAVAILABLE",
    "Deployment agent is unavailable; no raw failure was stored."
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
    throw deploymentError(
      "DEPLOYMENT_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw deploymentError(
      "DEPLOYMENT_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required before deployment."
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

function remoteIdentity(remoteUrl) {
  const normalized = String(remoteUrl ?? "").trim()

  if (sensitiveTextPattern.test(normalized) || unsafeControlPattern.test(normalized)) {
    throw deploymentError(
      "DEPLOYMENT_REPOSITORY_IDENTITY_INVALID",
      "Deployment repository identity is not approved."
    )
  }

  for (const pattern of allowedRemotePatterns) {
    if (pattern.test(normalized)) {
      return PHASE_6H_PPO_DEPLOYMENT_PROFILE.repositoryFullName
    }
  }

  throw deploymentError(
    "DEPLOYMENT_REPOSITORY_IDENTITY_INVALID",
    "Deployment repository identity is not approved."
  )
}

function hasOnlyProfileKeys(profile) {
  const approvedKeys = Object.keys(PHASE_6H_PPO_DEPLOYMENT_PROFILE).sort()
  const profileKeys = Object.keys(profile || {}).sort()

  return stableStringify(approvedKeys) === stableStringify(profileKeys)
}

export function resolveApprovedDeploymentProfile(candidate = null) {
  if (candidate === null || candidate === undefined) {
    return PHASE_6H_PPO_DEPLOYMENT_PROFILE
  }

  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !hasOnlyProfileKeys(candidate) ||
    stableStringify(candidate) !== stableStringify(PHASE_6H_PPO_DEPLOYMENT_PROFILE)
  ) {
    throw deploymentError(
      "DEPLOYMENT_PROFILE_REFUSED",
      "Deployment profile is not the approved Phase 6H PPO deployment profile."
    )
  }

  return PHASE_6H_PPO_DEPLOYMENT_PROFILE
}

function assertNoCallerDeploymentTarget(options) {
  for (const key of callerShaOptionKeys) {
    if (Object.hasOwn(options, key)) {
      throw deploymentError(
        "DEPLOYMENT_TARGET_FROM_CALLER_REFUSED",
        "Deployment target SHA must come only from Phase 6G merged evidence."
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

function latestRemoteApprovedReviewEvidence(run) {
  return latestEvidence(run, "review", (entry) => (
    entry?.source === REMOTE_PR_REVIEW_AGENT_ID &&
    entry?.metadata?.reviewer === REMOTE_PR_REVIEW_AGENT_ID &&
    entry?.metadata?.decision === REVIEW_DECISIONS.APPROVED &&
    entry?.metadata?.outcome === "approved"
  ))
}

function latestPhase6GMergedEvidence(run) {
  return latestEvidence(run, "merge", (entry) => (
    entry?.source === GITHUB_DELIVERY_AGENT_ID &&
    entry?.metadata?.agent === GITHUB_DELIVERY_AGENT_ID &&
    entry?.metadata?.outcome === "merged"
  ))
}

function latestDeploymentEvidence(run, outcome = null) {
  return latestEvidence(run, "deploy", (entry) => (
    entry?.source === DEVELOPMENT_DEPLOYMENT_AGENT_ID &&
    entry?.metadata?.agent === DEVELOPMENT_DEPLOYMENT_AGENT_ID &&
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
    throw deploymentError(
      "DEPLOYMENT_PROJECT_REFUSED",
      "Phase 6H deployment supports only the approved personal-project-operator profile."
    )
  }
}

function assertTrustedDevelopmentChain(run, implementationSha) {
  const implementation = latestPhase6DImplementationEvidence(run)
  const tests = latestPhase6EPassEvidence(run)
  const localReview = latestPhase6FApprovedReviewEvidence(run)
  const remoteReview = latestRemoteApprovedReviewEvidence(run)

  if (
    !implementation ||
    implementation.sha !== implementationSha ||
    implementation.metadata?.outcome !== "implementation_ready"
  ) {
    throw deploymentError(
      "DEPLOYMENT_EVIDENCE_CHAIN_INVALID",
      "Phase 6D implementation evidence does not match the merged run head."
    )
  }

  if (
    !tests ||
    tests.sha !== implementationSha ||
    tests.metadata?.implSha !== implementationSha ||
    tests.metadata?.outcome !== "passed" ||
    Number(tests.metadata?.failed || 0) !== 0 ||
    Number(tests.metadata?.ambiguous || 0) !== 0
  ) {
    throw deploymentError(
      "DEPLOYMENT_EVIDENCE_CHAIN_INVALID",
      "Phase 6E PASS evidence does not match the merged run head."
    )
  }

  if (
    !localReview ||
    localReview.sha !== implementationSha ||
    localReview.metadata?.reviewedSha !== implementationSha ||
    localReview.metadata?.decision !== REVIEW_DECISIONS.APPROVED ||
    localReview.metadata?.mergeAllowed !== true ||
    Number(localReview.metadata?.blockers || 0) !== 0 ||
    Number(localReview.metadata?.securityFindings || 0) !== 0 ||
    Number(localReview.metadata?.testsRequired || 0) !== 0
  ) {
    throw deploymentError(
      "DEPLOYMENT_EVIDENCE_CHAIN_INVALID",
      "Phase 6F local approval evidence does not match the merged run head."
    )
  }

  if (
    !remoteReview ||
    remoteReview.sha !== implementationSha ||
    remoteReview.metadata?.reviewedSha !== implementationSha ||
    remoteReview.metadata?.decision !== REVIEW_DECISIONS.APPROVED ||
    remoteReview.metadata?.mergeAllowed !== true ||
    Number(remoteReview.metadata?.blockers || 0) !== 0 ||
    Number(remoteReview.metadata?.securityFindings || 0) !== 0 ||
    Number(remoteReview.metadata?.testsRequired || 0) !== 0
  ) {
    throw deploymentError(
      "DEPLOYMENT_EVIDENCE_CHAIN_INVALID",
      "Phase 6G remote approval evidence does not match the merged run head."
    )
  }

  return {
    implementation,
    tests,
    localReview,
    remoteReview
  }
}

function mergedEvidenceFacts(run, profile) {
  assertProjectMatchesProfile(run, profile)

  const implementationSha = normalizeSha(run.headSha, "Run head SHA")
  const chain = assertTrustedDevelopmentChain(run, implementationSha)
  const merged = latestPhase6GMergedEvidence(run)

  if (
    !merged ||
    merged.sha !== implementationSha ||
    merged.metadata?.implementationSha !== implementationSha ||
    merged.metadata?.expectedHeadSha !== implementationSha ||
    merged.metadata?.mergeMethod !== PHASE_6G_APPROVED_MERGE_METHOD ||
    merged.metadata?.policyId !== PHASE_6G_DELIVERY_POLICY_ID ||
    merged.metadata?.policyHash !== PHASE_6G_DELIVERY_POLICY_HASH
  ) {
    throw deploymentError(
      "DEPLOYMENT_MERGED_EVIDENCE_INVALID",
      "Valid Phase 6G merged evidence is required before deployment."
    )
  }

  const deploymentSha = normalizeSha(merged.metadata?.mergeCommitSha, "Phase 6G merge commit SHA")

  if (merged.metadata?.mainSha !== deploymentSha) {
    throw deploymentError(
      "DEPLOYMENT_MERGED_EVIDENCE_INVALID",
      "Phase 6G merged evidence does not prove main at the merge commit."
    )
  }

  return {
    implementationSha,
    deploymentSha,
    merged,
    chain
  }
}

function deploymentEvidence(run, deploymentSha, outcome, metadata, summary) {
  return {
    kind: "deploy",
    sha: deploymentSha,
    source: DEVELOPMENT_DEPLOYMENT_AGENT_ID,
    summary,
    metadata: {
      project: run.project.id,
      agent: DEVELOPMENT_DEPLOYMENT_AGENT_ID,
      policyId: PHASE_6H_DEPLOYMENT_POLICY_ID,
      policyHash: PHASE_6H_DEPLOYMENT_POLICY_HASH,
      deploymentSha,
      outcome,
      ...metadata
    }
  }
}

function stateApi(options = {}) {
  const runStateOptions = {
    ...options,
    allowPersonalProjectOperatorSelfDevelopmentProject: true
  }

  return {
    read: async (runId) => await (options.readDevelopmentRun || readDevelopmentRun)(runId, runStateOptions),
    recordProgress: async (runId, progress) => await (options.recordDevelopmentRunProgress || recordDevelopmentRunProgress)(runId, progress, runStateOptions),
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

function ambiguousDeploymentError() {
  const error = deploymentError(
    "DEPLOYMENT_AMBIGUOUS",
    "Deployment outcome is ambiguous; reconcile read-only before retry."
  )
  error.ambiguous = true
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
      maxBuffer: MAX_DEPLOYMENT_OUTPUT_BYTES,
      timeout: MAX_DEPLOYMENT_TIMEOUT_MS,
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
      throw ambiguousDeploymentError()
    }

    throw deploymentError(
      "DEPLOYMENT_OPERATION_FAILED",
      "Approved deployment operation failed; no raw process output was stored."
    )
  }
}

async function defaultDeploymentRunner(invocation) {
  const profile = PHASE_6H_PPO_DEPLOYMENT_PROFILE

  if (invocation.kind === "inspect-deployment") {
    const remote = await runTrustedProcess(profile.gitExecutable, [
      "-C",
      profile.installDir,
      "remote",
      "get-url",
      profile.remoteName
    ])
    let checkoutSha = null

    try {
      const head = await runTrustedProcess(profile.gitExecutable, [
        "-C",
        profile.installDir,
        "rev-parse",
        "HEAD"
      ])
      checkoutSha = normalizeSha(String(head.stdout || "").trim(), "Deployment checkout SHA")
    } catch {
      checkoutSha = null
    }

    return {
      ok: true,
      installDir: profile.installDir,
      remoteUrl: String(remote.stdout || "").trim(),
      repositoryFullName: remoteIdentity(String(remote.stdout || "").trim()),
      checkoutSha
    }
  }

  if (invocation.kind === "deploy-exact-sha") {
    await runTrustedProcess(profile.deployScript, [invocation.expectedSha])

    return {
      ok: true,
      installDir: profile.installDir,
      remoteUrl: profile.approvedRemote,
      repositoryFullName: profile.repositoryFullName,
      serviceName: profile.serviceName,
      checkoutSha: invocation.expectedSha,
      preflight: "passed",
      serviceRestart: "completed"
    }
  }

  throw deploymentError(
    "DEPLOYMENT_OPERATION_REFUSED",
    "Deployment operation is not approved."
  )
}

function deploymentRunner(options = {}) {
  return options.deploymentRunner || defaultDeploymentRunner
}

function normalizeOptionalCheckoutSha(value) {
  if (value === null || value === undefined || value === "") {
    return null
  }

  return normalizeSha(value, "Deployment checkout SHA")
}

function validateDeploymentInspection(result, profile) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw deploymentError(
      "DEPLOYMENT_INSPECTION_INVALID",
      "Deployment inspection did not return trusted metadata."
    )
  }

  if (result.installDir !== undefined && result.installDir !== profile.installDir) {
    throw deploymentError(
      "DEPLOYMENT_INSTALL_PATH_REFUSED",
      "Deployment installation directory is not approved."
    )
  }

  if (result.remoteUrl !== undefined) {
    remoteIdentity(result.remoteUrl)
  }

  if (result.repositoryFullName !== undefined && result.repositoryFullName !== profile.repositoryFullName) {
    throw deploymentError(
      "DEPLOYMENT_REPOSITORY_IDENTITY_INVALID",
      "Deployment repository identity is not approved."
    )
  }

  return {
    ok: result.ok !== false,
    checkoutSha: normalizeOptionalCheckoutSha(result.checkoutSha),
    repositoryFullName: result.repositoryFullName || profile.repositoryFullName,
    remoteUrl: result.remoteUrl || profile.approvedRemote
  }
}

function validateDeploymentResult(result, profile, expectedSha) {
  if (isUncertainOutcome(result)) {
    throw ambiguousDeploymentError()
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      ok: false,
      failureClass: "operation_failed"
    }
  }

  if (result.ok === false) {
    return {
      ok: false,
      failureClass: normalizeSafeResultClass(result.failureClass)
    }
  }

  const inspection = validateDeploymentInspection(result, profile)

  if (result.serviceName !== profile.serviceName) {
    throw deploymentError(
      "DEPLOYMENT_SERVICE_REFUSED",
      "Deployment service identity is not approved."
    )
  }

  if (result.rollbackInvoked === true || result.verificationInvoked === true) {
    throw deploymentError(
      "DEPLOYMENT_SCOPE_VIOLATION",
      "Deployment operation exceeded the Phase 6H boundary."
    )
  }

  if (result.preflight !== "passed" || result.serviceRestart !== "completed") {
    return {
      ok: false,
      failureClass: "postcondition_failed"
    }
  }

  if (inspection.checkoutSha !== expectedSha) {
    return {
      ok: false,
      failureClass: "checkout_sha_mismatch"
    }
  }

  return {
    ok: true,
    checkoutSha: inspection.checkoutSha,
    serviceName: result.serviceName,
    preflight: result.preflight,
    serviceRestart: result.serviceRestart
  }
}

async function inspectDeployment(profile, expectedSha, options = {}) {
  const result = await deploymentRunner(options)({
    kind: "inspect-deployment",
    profile,
    expectedSha,
    shell: false,
    timeoutMs: MAX_DEPLOYMENT_TIMEOUT_MS,
    maxOutputBytes: MAX_DEPLOYMENT_OUTPUT_BYTES
  })

  return validateDeploymentInspection(result, profile)
}

async function performDeployment(profile, expectedSha, options = {}) {
  try {
    const result = await deploymentRunner(options)({
      kind: "deploy-exact-sha",
      profile,
      expectedSha,
      serviceName: profile.serviceName,
      shell: false,
      timeoutMs: MAX_DEPLOYMENT_TIMEOUT_MS,
      maxOutputBytes: MAX_DEPLOYMENT_OUTPUT_BYTES
    })

    return validateDeploymentResult(result, profile, expectedSha)
  } catch (error) {
    if (isUncertainOutcome(error) || error?.code === "DEPLOYMENT_AMBIGUOUS") {
      throw ambiguousDeploymentError()
    }

    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    return {
      ok: false,
      failureClass: "operation_failed"
    }
  }
}

async function transitionDeployFailed(run, facts, failureClass, options = {}) {
  const api = stateApi(options)
  const evidence = deploymentEvidence(run, facts.deploymentSha, "deploy_failed", {
    attempt: run.attempts.deploy,
    failureClass: normalizeSafeResultClass(failureClass),
    service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
    failedAt: timestamp(options)
  }, "Phase 6H exact-SHA deployment failed definitively.")

  return await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "deploy_failed",
    actor: DEVELOPMENT_DEPLOYMENT_AGENT_ID,
    reason: "phase-6h-exact-sha-deploy-failed",
    evidence: [evidence]
  }, options)
}

async function transitionDeployed(run, facts, previousInstalledSha, checkoutSha, options = {}) {
  const api = stateApi(options)
  const evidence = deploymentEvidence(run, facts.deploymentSha, "deployed", {
    attempt: run.attempts.deploy,
    previousInstalledSha: previousInstalledSha || "",
    checkoutSha,
    service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
    preflight: "passed",
    restart: "completed",
    deployedAt: timestamp(options)
  }, "Phase 6H exact-SHA deployment completed.")

  return await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "deployed",
    actor: DEVELOPMENT_DEPLOYMENT_AGENT_ID,
    reason: "phase-6h-exact-sha-deployed",
    evidence: [evidence]
  }, options)
}

async function executeDevelopmentDeploymentInternal(runId, options = {}) {
  assertNoCallerDeploymentTarget(options)

  const expectedVersion = normalizeExpectedVersion(options.expectedVersion)
  const api = stateApi(options)
  const profile = resolveApprovedDeploymentProfile(options.deploymentProfile)
  let run = await api.read(runId, options)

  if (run.version !== expectedVersion) {
    throw deploymentError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before deployment."
    )
  }

  if (run.status !== "merged") {
    throw deploymentError(
      "DEPLOYMENT_RUN_NOT_MERGED",
      "Development run must be merged before Phase 6H deployment."
    )
  }

  const facts = mergedEvidenceFacts(run, profile)
  const before = await inspectDeployment(profile, facts.deploymentSha, options)
  const attempt = run.attempts.deploy + 1

  run = await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "deploy_in_progress",
    actor: DEVELOPMENT_DEPLOYMENT_AGENT_ID,
    reason: "phase-6h-exact-sha-deploy-start",
    evidence: [deploymentEvidence(run, facts.deploymentSha, "deploy_started", {
      attempt,
      previousInstalledSha: before.checkoutSha || "",
      service: profile.serviceName,
      recordedAt: timestamp(options)
    }, "Phase 6H exact-SHA deployment attempt was reserved.")]
  }, options)

  let deployment

  try {
    deployment = await performDeployment(profile, facts.deploymentSha, options)
  } catch (error) {
    if (error?.ambiguous === true || error?.code === "DEPLOYMENT_AMBIGUOUS") {
      throw error
    }

    if (error instanceof DevelopmentRunStateError) {
      deployment = {
        ok: false,
        failureClass: error.code === "DEPLOYMENT_SERVICE_REFUSED" || error.code === "DEPLOYMENT_SCOPE_VIOLATION"
          ? "scope_violation"
          : "operation_failed"
      }
    } else {
      deployment = {
        ok: false,
        failureClass: "operation_failed"
      }
    }
  }

  const after = await inspectDeployment(profile, facts.deploymentSha, options)

  if (!deployment.ok || after.checkoutSha !== facts.deploymentSha) {
    const failedRun = await transitionDeployFailed(run, facts, deployment.failureClass || "postcondition_failed", options)

    return {
      ok: false,
      outcome: "deploy_failed",
      run: failedRun,
      deployment: {
        policyId: PHASE_6H_DEPLOYMENT_POLICY_ID,
        policyHash: PHASE_6H_DEPLOYMENT_POLICY_HASH,
        implementationSha: facts.implementationSha,
        deploymentSha: facts.deploymentSha,
        checkoutSha: after.checkoutSha,
        failureClass: deployment.failureClass || "postcondition_failed"
      }
    }
  }

  const deployedRun = await transitionDeployed(run, facts, before.checkoutSha, after.checkoutSha, options)

  return {
    ok: true,
    outcome: "deployed",
    run: deployedRun,
    deployment: {
      policyId: PHASE_6H_DEPLOYMENT_POLICY_ID,
      policyHash: PHASE_6H_DEPLOYMENT_POLICY_HASH,
      implementationSha: facts.implementationSha,
      deploymentSha: facts.deploymentSha,
      previousInstalledSha: before.checkoutSha,
      checkoutSha: after.checkoutSha,
      service: profile.serviceName
    }
  }
}

export async function executeDevelopmentDeployment(runId, options = {}) {
  try {
    return await executeDevelopmentDeploymentInternal(runId, options)
  } catch (error) {
    throw safeDeploymentFailure(error)
  }
}

function deploymentAttempt(run) {
  const started = latestDeploymentEvidence(run, "deploy_started")

  if (started?.metadata?.attempt && Number.isInteger(started.metadata.attempt)) {
    return started.metadata.attempt
  }

  return null
}

function deployedEvidenceComplete(run, expectedSha, checkoutSha) {
  const deployed = latestDeploymentEvidence(run, "deployed")

  return Boolean(
    deployed &&
    deployed.sha === expectedSha &&
    deployed.metadata?.deploymentSha === expectedSha &&
    deployed.metadata?.checkoutSha === checkoutSha &&
    deployed.metadata?.preflight === "passed" &&
    deployed.metadata?.restart === "completed"
  )
}

async function reconcileDevelopmentDeploymentInternal(runId, options = {}) {
  const api = stateApi(options)
  const profile = resolveApprovedDeploymentProfile(options.deploymentProfile)
  const run = await api.read(runId, options)
  let facts = null
  let inspection = null
  let expectedDeploymentSha = null
  let evidenceComplete = false
  let ownerActionRequired = false

  try {
    facts = mergedEvidenceFacts(run, profile)
    expectedDeploymentSha = facts.deploymentSha
    inspection = await inspectDeployment(profile, facts.deploymentSha, options)
    evidenceComplete = deployedEvidenceComplete(run, facts.deploymentSha, inspection.checkoutSha)
    ownerActionRequired = ["deploy_in_progress", "deploy_failed"].includes(run.status) && !evidenceComplete
  } catch {
    ownerActionRequired = ["deploy_in_progress", "deploy_failed"].includes(run.status)
  }

  const currentCheckoutSha = inspection?.checkoutSha || null
  const targetInstalled = Boolean(expectedDeploymentSha && currentCheckoutSha === expectedDeploymentSha)

  return {
    ok: true,
    outcome: "deployment_reconciled",
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id,
      headSha: run.headSha
    },
    deployment: {
      policyId: PHASE_6H_DEPLOYMENT_POLICY_ID,
      policyHash: PHASE_6H_DEPLOYMENT_POLICY_HASH,
      expectedDeploymentSha,
      attempt: deploymentAttempt(run),
      currentCheckoutSha,
      targetInstalled,
      deploymentEvidenceComplete: evidenceComplete,
      completionProven: evidenceComplete,
      ownerActionRequired
    }
  }
}

export async function reconcileDevelopmentDeployment(runId, options = {}) {
  try {
    return await reconcileDevelopmentDeploymentInternal(runId, options)
  } catch (error) {
    throw safeDeploymentFailure(error)
  }
}

export function formatDevelopmentDeploymentAgentError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO deployment error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO deployment error: unexpected local failure."
}

export const phase6HDeploymentSecurityBoundary = Object.freeze({
  policyId: PHASE_6H_DEPLOYMENT_POLICY_ID,
  policyHash: PHASE_6H_DEPLOYMENT_POLICY_HASH,
  startsFrom: "merged",
  stopsAt: "deployed",
  deploysExactShaOnly: true,
  rollback: false,
  productionVerification: false,
  ppoContinue: false,
  telegramOrOpenClawRouting: false
})
