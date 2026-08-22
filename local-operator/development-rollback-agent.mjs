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
  DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
  PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
  PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID
} from "./development-production-verification-agent.mjs"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD
} from "./github-delivery-agent.mjs"

const execFileAsync = promisify(execFile)

export const DEVELOPMENT_ROLLBACK_AGENT_ID = "phase-6j-exact-previous-sha-rollback-agent"
export const PHASE_6J_ROLLBACK_POLICY_ID = "phase-6j-exact-previous-sha-ppo-rollback-policy"
export const PHASE_6J_OWNER_ROLLBACK_CONFIRMATION = "rollback-verification-failure"
export const MAX_ROLLBACK_OUTPUT_BYTES = 32 * 1024
export const MAX_ROLLBACK_TIMEOUT_MS = 3 * 60 * 1000
export const PHASE_6J_ROLLBACK_SCRIPT =
  `${PHASE_6H_PPO_DEPLOYMENT_PROFILE.installDir}/deployment/scripts/rollback-exact-sha.sh`
export const PHASE_6J_ROLLBACK_COORDINATED_INSPECTION_ID =
  "phase-6j-agent-embedded-readonly-production-inspection"
// This mutable checkout script is retained only as a manual diagnostic helper.
// Coordinated Phase 6J reconciliation never executes it.
export const PHASE_6J_ROLLBACK_MANUAL_INSPECTION_SCRIPT =
  `${PHASE_6H_PPO_DEPLOYMENT_PROFILE.installDir}/deployment/scripts/inspect-rollback-readonly.sh`

const shaPattern = /^[a-f0-9]{40}$/u
const safeResultClassPattern = /^[a-z][a-z0-9_-]{0,79}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const allowedResultClasses = new Set(["passed", "failed", "not_run", "not_applicable"])
const rollbackResultKeys = new Set([
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
  "currentCheckout",
  "detached",
  "clean",
  "previousRevision",
  "rollbackCommit",
  "checkoutSwitch",
  "permissionContract",
  "runtimePreflight",
  "serviceRestart",
  "postrollbackCheckout",
  "rollbackInvoked",
  "deploymentInvoked",
  "githubWriteInvoked",
  "modelInvoked",
  "routeInvoked",
  "networkRefreshInvoked",
  "legacyRollbackInvoked"
])
const resultClassKeys = Object.freeze([
  "repository",
  "currentCheckout",
  "detached",
  "clean",
  "previousRevision",
  "rollbackCommit",
  "checkoutSwitch",
  "permissionContract",
  "runtimePreflight",
  "serviceRestart",
  "postrollbackCheckout"
])
const rollbackContractEntryCount = 14
const fixedRollbackInspectionPaths = Object.freeze({
  git: "/usr/bin/git",
  systemctl: "/usr/bin/systemctl",
  stat: "/usr/bin/stat",
  find: "/usr/bin/find",
  cat: "/usr/bin/cat",
  sudo: "/usr/bin/sudo",
  installDir: PHASE_6H_PPO_DEPLOYMENT_PROFILE.installDir,
  stateDir: PHASE_6H_PPO_DEPLOYMENT_PROFILE.stateDir,
  configDir: "/etc/personal-project-operator",
  openclawPrefix: "/home/ppo/.local/openclaw",
  nodeBin: "/home/ppo/.local/openclaw/tools/node/bin/node",
  openclawBin: "/home/ppo/.local/openclaw/bin/openclaw",
  remoteName: PHASE_6H_PPO_DEPLOYMENT_PROFILE.remoteName,
  repositoryUrl: "https://github.com/Linardi1328/personal-project-operator.git",
  serviceName: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
  serviceUser: "ppo",
  serviceGroup: "ppo"
})
const callerRollbackTargetOptionKeys = Object.freeze([
  "rollbackSha",
  "targetSha",
  "previousSha",
  "previousInstalledSha",
  "deploymentSha",
  "checkoutSha",
  "expectedDeploymentSha",
  "repository",
  "repositoryFullName",
  "remoteUrl",
  "service",
  "serviceName",
  "installDir",
  "stateDir",
  "command",
  "executable",
  "executablePath",
  "script",
  "scriptPath",
  "rollbackCommand",
  "policy",
  "profile",
  "deploymentProfile"
])

const rollbackPolicyContract = Object.freeze({
  phase: "6J",
  source: DEVELOPMENT_ROLLBACK_AGENT_ID,
  startsFrom: "verification_failed",
  stopsAt: "rolled_back",
  profile: PHASE_6H_PPO_DEPLOYMENT_PROFILE,
  rollbackScript: PHASE_6J_ROLLBACK_SCRIPT,
  coordinatedInspection: PHASE_6J_ROLLBACK_COORDINATED_INSPECTION_ID,
  explicitOwnerConfirmationRequired: true,
  requiredChecks: Object.freeze([
    "fixed_ppo_project",
    "phase_6g_merge_chain",
    "phase_6h_deployed_previous_sha",
    "phase_6i_verification_failed",
    "fixed_repository_origin",
    "exact_failed_deployment_head",
    "detached_clean_checkout",
    "previous_revision_marker",
    "local_rollback_commit",
    "detached_exact_sha_switch",
    "runtime_checkout_permissions",
    "post_switch_runtime_preflight",
    "fixed_service_restart",
    "postrollback_checkout",
    "fixed_service_running"
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

export const PHASE_6J_ROLLBACK_POLICY_HASH = sha256Text(stableStringify(rollbackPolicyContract))

export class DevelopmentRollbackAgentError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentRollbackAgentError"
  }
}

function rollbackError(code, safeMessage) {
  return new DevelopmentRollbackAgentError(code, safeMessage)
}

function safeRollbackFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return rollbackError(
    "ROLLBACK_AGENT_UNAVAILABLE",
    "Rollback agent is unavailable; no raw failure was stored."
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
    throw rollbackError(
      "ROLLBACK_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw rollbackError(
      "ROLLBACK_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required before rollback."
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
    throw ambiguousRollbackError(`${fieldName} was not a safe result class.`)
  }

  return normalized
}

function assertNoCallerRollbackTarget(options) {
  for (const key of callerRollbackTargetOptionKeys) {
    if (Object.hasOwn(options, key)) {
      throw rollbackError(
        "ROLLBACK_TARGET_FROM_CALLER_REFUSED",
        "Rollback target must come only from Phase 6H deployed evidence and the fixed PPO profile."
      )
    }
  }
}

function assertOwnerRollbackConfirmation(value) {
  if (value !== PHASE_6J_OWNER_ROLLBACK_CONFIRMATION) {
    throw rollbackError(
      "ROLLBACK_OWNER_CONFIRMATION_REQUIRED",
      "Explicit owner rollback confirmation is required before Phase 6J rollback."
    )
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

function latestPhase6IVerificationEvidence(run, outcome = null) {
  return latestEvidence(run, "verification", (entry) => (
    entry?.source === DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID &&
    entry?.metadata?.agent === DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID &&
    (outcome === null || entry?.metadata?.outcome === outcome)
  ))
}

function latestRollbackEvidence(run, outcome = null) {
  return latestEvidence(run, "rollback", (entry) => (
    entry?.source === DEVELOPMENT_ROLLBACK_AGENT_ID &&
    entry?.metadata?.agent === DEVELOPMENT_ROLLBACK_AGENT_ID &&
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
    throw rollbackError(
      "ROLLBACK_PROJECT_REFUSED",
      "Phase 6J rollback supports only the approved personal-project-operator production profile."
    )
  }
}

function rollbackEvidenceFacts(run, profile) {
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
    throw rollbackError(
      "ROLLBACK_SHA_CHAIN_INVALID",
      "Valid Phase 6G merged evidence is required before rollback."
    )
  }

  const deployed = latestPhase6HDeploymentEvidence(run)
  const deploymentSha = normalizeSha(deployed?.metadata?.deploymentSha, "Phase 6H deployment SHA")
  const rollbackSha = normalizeSha(deployed?.metadata?.previousInstalledSha, "Phase 6H previous installed SHA")

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
    deployed.metadata?.restart !== "completed" ||
    rollbackSha === deploymentSha
  ) {
    throw rollbackError(
      "ROLLBACK_DEPLOYED_EVIDENCE_INVALID",
      "Valid Phase 6H deployed evidence with a distinct previous installed SHA is required before rollback."
    )
  }

  if (
    normalizeSha(merged.metadata?.mergeCommitSha, "Phase 6G merge commit SHA") !== deploymentSha ||
    merged.metadata?.mainSha !== deploymentSha
  ) {
    throw rollbackError(
      "ROLLBACK_SHA_CHAIN_INVALID",
      "Phase 6H deployed SHA must equal the Phase 6G merge commit SHA."
    )
  }

  const latestVerification = latestPhase6IVerificationEvidence(run)
  const verificationStarted = latestPhase6IVerificationEvidence(run, "verification_started")
  const verificationFailed = latestPhase6IVerificationEvidence(run, "verification_failed")
  const verificationAttempt = verificationFailed?.metadata?.attempt

  if (
    latestVerification !== verificationFailed ||
    !verificationStarted ||
    !verificationFailed ||
    verificationStarted.sha !== deploymentSha ||
    verificationFailed.sha !== deploymentSha ||
    verificationStarted.metadata?.deploymentSha !== deploymentSha ||
    verificationFailed.metadata?.deploymentSha !== deploymentSha ||
    verificationStarted.metadata?.policyId !== PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID ||
    verificationStarted.metadata?.policyHash !== PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH ||
    verificationFailed.metadata?.policyId !== PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID ||
    verificationFailed.metadata?.policyHash !== PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH ||
    verificationStarted.metadata?.outcome !== "verification_started" ||
    verificationFailed.metadata?.outcome !== "verification_failed" ||
    !Number.isInteger(verificationStarted.metadata?.attempt) ||
    verificationStarted.metadata.attempt <= 0 ||
    !Number.isInteger(verificationAttempt) ||
    verificationAttempt <= 0 ||
    verificationAttempt !== verificationStarted.metadata.attempt
  ) {
    throw rollbackError(
      "ROLLBACK_VERIFICATION_EVIDENCE_INVALID",
      "Valid Phase 6I verification_failed evidence for the deployed SHA is required before rollback."
    )
  }

  return {
    deploymentSha,
    rollbackSha,
    deployed,
    merged,
    verificationFailed,
    verificationAttempt
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

function ambiguousRollbackError(detail = null) {
  const error = rollbackError(
    "ROLLBACK_AMBIGUOUS",
    "Rollback outcome is ambiguous; reconcile read-only before retry."
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
      maxBuffer: MAX_ROLLBACK_OUTPUT_BYTES,
      timeout: MAX_ROLLBACK_TIMEOUT_MS,
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
      throw ambiguousRollbackError()
    }

    throw rollbackError(
      "ROLLBACK_OPERATION_FAILED",
      "Approved rollback operation failed; no raw process output was stored."
    )
  }
}

function parseTrustedRollbackOutput(stdout) {
  let parsed

  try {
    parsed = JSON.parse(String(stdout || ""))
  } catch {
    throw ambiguousRollbackError("rollback output was not valid JSON")
  }

  return parsed
}

async function defaultReadOnlyInspectionCommandRunner(invocation) {
  try {
    const result = await execFileAsync(invocation.executablePath, invocation.args, {
      cwd: "/",
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
      },
      encoding: "utf8",
      maxBuffer: invocation.maxOutputBytes,
      timeout: invocation.timeoutMs,
      shell: false
    })

    return {
      exitCode: 0,
      stdout: result.stdout
    }
  } catch (error) {
    if (isUncertainOutcome(error)) {
      throw ambiguousRollbackError()
    }

    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : ""
    }
  }
}

function readOnlyInspectionCommandRunner(options = {}) {
  return options.readOnlyInspectionCommandRunner || defaultReadOnlyInspectionCommandRunner
}

async function runReadOnlyInspectionCommand(executablePath, args, options = {}) {
  const invocation = {
    executablePath,
    args: [...args],
    cwd: "/",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
    },
    shell: false,
    timeoutMs: MAX_ROLLBACK_TIMEOUT_MS,
    maxOutputBytes: MAX_ROLLBACK_OUTPUT_BYTES
  }
  let result

  try {
    result = await readOnlyInspectionCommandRunner(options)(invocation)
  } catch (error) {
    if (isUncertainOutcome(error) || error?.code === "ROLLBACK_AMBIGUOUS") {
      throw ambiguousRollbackError()
    }

    if (options.readOnlyInspectionCommandRunner) {
      throw error
    }

    return {
      exitCode: 1,
      stdout: ""
    }
  }

  if (isUncertainOutcome(result)) {
    throw ambiguousRollbackError()
  }

  if (!result || !Number.isInteger(result.exitCode)) {
    throw ambiguousRollbackError("read-only inspection command returned malformed status")
  }

  const stdout = String(result.stdout ?? "")

  if (Buffer.byteLength(stdout, "utf8") > MAX_ROLLBACK_OUTPUT_BYTES) {
    throw ambiguousRollbackError("read-only inspection command output exceeded bound")
  }

  return {
    exitCode: result.exitCode,
    stdout
  }
}

function firstOutputLine(stdout) {
  return String(stdout || "").split(/\r?\n/u)[0]?.trim() || ""
}

function nullSeparatedOutput(stdout) {
  return String(stdout || "").split("\0").filter((entry) => entry.length > 0)
}

function baseReadOnlyRollbackInspectionResult(profile) {
  return {
    schemaVersion: 1,
    ok: false,
    failureClass: "rollback_incomplete",
    observedCheckoutSha: "",
    serviceName: profile.serviceName,
    serviceEnabled: false,
    serviceActive: false,
    serviceRunning: false,
    serviceMainPidNonZero: false,
    repository: "failed",
    currentCheckout: "failed",
    detached: "failed",
    clean: "failed",
    previousRevision: "failed",
    rollbackCommit: "failed",
    checkoutSwitch: "not_applicable",
    permissionContract: "failed",
    runtimePreflight: "failed",
    serviceRestart: "not_applicable",
    postrollbackCheckout: "failed",
    rollbackInvoked: false,
    deploymentInvoked: false,
    githubWriteInvoked: false,
    modelInvoked: false,
    routeInvoked: false,
    networkRefreshInvoked: false,
    legacyRollbackInvoked: false
  }
}

async function runFixedGit(args, options = {}) {
  return await runReadOnlyInspectionCommand(fixedRollbackInspectionPaths.git, args, options)
}

async function runFixedSystemctl(args, options = {}) {
  return await runReadOnlyInspectionCommand(fixedRollbackInspectionPaths.systemctl, args, options)
}

async function statPath(path, options = {}) {
  const result = await runReadOnlyInspectionCommand(fixedRollbackInspectionPaths.stat, [
    "-c",
    "%U %G %a %F",
    path
  ], options)

  if (result.exitCode !== 0) {
    return null
  }

  const match = firstOutputLine(result.stdout).match(/^(\S+) (\S+) ([0-7]+) (.+)$/u)

  if (!match) {
    return null
  }

  return {
    user: match[1],
    group: match[2],
    mode: match[3],
    fileType: match[4]
  }
}

function statMatches(metadata, expectedUser, expectedGroup, expectedMode) {
  return Boolean(
    metadata &&
    metadata.user === expectedUser &&
    metadata.group === expectedGroup &&
    metadata.mode === expectedMode
  )
}

async function fixedPathIsDirectory(path, options = {}) {
  const metadata = await statPath(path, options)

  return metadata?.fileType === "directory"
}

async function fixedPathIsExecutable(path, options = {}) {
  const metadata = await statPath(path, options)
  const mode = Number.parseInt(metadata?.mode || "", 8)

  return Number.isInteger(mode) && (mode & 0o111) !== 0
}

function trackedModeToExpectedPermission(trackedMode) {
  return trackedMode === "100755" ? "755" : "644"
}

async function expectedFilePermission(relativePath, options = {}) {
  const result = await runFixedGit([
    "-C",
    fixedRollbackInspectionPaths.installDir,
    "ls-files",
    "-s",
    "--",
    relativePath
  ], options)
  const trackedMode = firstOutputLine(result.stdout).split(/\s+/u)[0] || ""

  return trackedModeToExpectedPermission(trackedMode)
}

async function checkReadOnlyPermissionContract(options = {}) {
  const installDir = fixedRollbackInspectionPaths.installDir

  if (!statMatches(await statPath(installDir, options), "root", fixedRollbackInspectionPaths.serviceGroup, "755")) {
    return false
  }

  const directoryList = await runReadOnlyInspectionCommand(fixedRollbackInspectionPaths.find, [
    installDir,
    "-type",
    "d",
    "-print0"
  ], options)

  if (directoryList.exitCode !== 0) {
    return false
  }

  for (const path of nullSeparatedOutput(directoryList.stdout)) {
    if (!statMatches(await statPath(path, options), "root", fixedRollbackInspectionPaths.serviceGroup, "755")) {
      return false
    }
  }

  const fileList = await runReadOnlyInspectionCommand(fixedRollbackInspectionPaths.find, [
    installDir,
    "-type",
    "f",
    "-print0"
  ], options)

  if (fileList.exitCode !== 0) {
    return false
  }

  for (const path of nullSeparatedOutput(fileList.stdout)) {
    const relativePath = path.startsWith(`${installDir}/`) ? path.slice(installDir.length + 1) : path
    const expectedMode = await expectedFilePermission(relativePath, options)

    if (!statMatches(await statPath(path, options), "root", fixedRollbackInspectionPaths.serviceGroup, expectedMode)) {
      return false
    }
  }

  return true
}

function parseNodeVersion(rawVersion) {
  const match = String(rawVersion || "").trim().replace(/^v/u, "").match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/u)

  if (!match) {
    return null
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  }
}

function nodeVersionIsSupported(rawVersion) {
  const parsed = parseNodeVersion(rawVersion)

  if (!parsed) {
    return false
  }

  const { major, minor, patch } = parsed

  if (major === 22) {
    return minor > 22 || (minor === 22 && patch >= 3)
  }

  if (major === 24) {
    return minor > 15 || (minor === 15 && patch >= 0)
  }

  if (major === 25) {
    return minor > 9 || (minor === 9 && patch >= 0)
  }

  return major >= 26
}

async function checkReadOnlyRuntimePreflight(options = {}) {
  if (!(await fixedPathIsDirectory(fixedRollbackInspectionPaths.installDir, options))) {
    return false
  }

  if (!(await fixedPathIsDirectory(fixedRollbackInspectionPaths.configDir, options))) {
    return false
  }

  if (!(await fixedPathIsExecutable(fixedRollbackInspectionPaths.nodeBin, options))) {
    return false
  }

  if (!(await fixedPathIsExecutable(fixedRollbackInspectionPaths.openclawBin, options))) {
    return false
  }

  const nodeVersion = await runReadOnlyInspectionCommand(fixedRollbackInspectionPaths.sudo, [
    "-u",
    fixedRollbackInspectionPaths.serviceUser,
    fixedRollbackInspectionPaths.nodeBin,
    "--version"
  ], options)

  if (nodeVersion.exitCode !== 0 || !nodeVersionIsSupported(firstOutputLine(nodeVersion.stdout))) {
    return false
  }

  const openclawVersion = await runReadOnlyInspectionCommand(fixedRollbackInspectionPaths.sudo, [
    "-u",
    fixedRollbackInspectionPaths.serviceUser,
    fixedRollbackInspectionPaths.openclawBin,
    "--version"
  ], options)

  return openclawVersion.exitCode === 0
}

async function inspectProductionRollbackReadOnly(invocation, options = {}) {
  const result = baseReadOnlyRollbackInspectionResult(invocation.profile)
  const paths = fixedRollbackInspectionPaths

  const remote = await runFixedGit([
    "-C",
    paths.installDir,
    "remote",
    "get-url",
    paths.remoteName
  ], options)
  if (remote.exitCode === 0 && firstOutputLine(remote.stdout) === paths.repositoryUrl) {
    result.repository = "passed"
  }

  const head = await runFixedGit([
    "-C",
    paths.installDir,
    "rev-parse",
    "--verify",
    "HEAD"
  ], options)
  const observedCheckoutSha = firstOutputLine(head.stdout).toLowerCase()

  if (head.exitCode === 0 && shaPattern.test(observedCheckoutSha)) {
    result.observedCheckoutSha = observedCheckoutSha
    result.currentCheckout = observedCheckoutSha === invocation.deploymentSha ? "passed" : "failed"
    result.postrollbackCheckout = observedCheckoutSha === invocation.rollbackSha ? "passed" : "failed"
  }

  const symbolicRef = await runFixedGit([
    "-C",
    paths.installDir,
    "symbolic-ref",
    "-q",
    "HEAD"
  ], options)
  result.detached = symbolicRef.exitCode === 0 ? "failed" : "passed"

  const status = await runFixedGit([
    "--no-optional-locks",
    "-C",
    paths.installDir,
    "-c",
    "core.fsmonitor=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames"
  ], options)
  result.clean = status.exitCode === 0 && status.stdout === "" ? "passed" : "failed"

  const marker = await runReadOnlyInspectionCommand(paths.cat, [
    `${paths.stateDir}/last-deploy-previous-revision`
  ], options)
  result.previousRevision = marker.exitCode === 0 && firstOutputLine(marker.stdout) === invocation.rollbackSha
    ? "passed"
    : "failed"

  const rollbackCommit = await runFixedGit([
    "-C",
    paths.installDir,
    "rev-parse",
    "--verify",
    "--quiet",
    `${invocation.rollbackSha}^{commit}`
  ], options)
  result.rollbackCommit = rollbackCommit.exitCode === 0 ? "passed" : "failed"

  result.permissionContract = await checkReadOnlyPermissionContract(options) ? "passed" : "failed"
  result.runtimePreflight = await checkReadOnlyRuntimePreflight(options) ? "passed" : "failed"

  const serviceEnabled = await runFixedSystemctl([
    "is-enabled",
    "--quiet",
    paths.serviceName
  ], options)
  result.serviceEnabled = serviceEnabled.exitCode === 0

  const serviceActive = await runFixedSystemctl([
    "is-active",
    "--quiet",
    paths.serviceName
  ], options)
  result.serviceActive = serviceActive.exitCode === 0

  const subState = await runFixedSystemctl([
    "show",
    paths.serviceName,
    "--property=SubState",
    "--value"
  ], options)
  result.serviceRunning = subState.exitCode === 0 && firstOutputLine(subState.stdout) === "running"

  const mainPid = await runFixedSystemctl([
    "show",
    paths.serviceName,
    "--property=MainPID",
    "--value"
  ], options)
  const mainPidValue = firstOutputLine(mainPid.stdout)
  result.serviceMainPidNonZero = mainPid.exitCode === 0 && /^[0-9]+$/u.test(mainPidValue) && mainPidValue !== "0"

  if (
    result.repository === "passed" &&
    result.postrollbackCheckout === "passed" &&
    result.detached === "passed" &&
    result.clean === "passed" &&
    result.previousRevision === "passed" &&
    result.rollbackCommit === "passed" &&
    result.permissionContract === "passed" &&
    result.runtimePreflight === "passed" &&
    result.serviceActive === true &&
    result.serviceRunning === true &&
    result.serviceMainPidNonZero === true
  ) {
    result.ok = true
    result.failureClass = "none"
  } else if (result.observedCheckoutSha === invocation.deploymentSha) {
    result.failureClass = "rollback_not_started"
  }

  return result
}

async function defaultRollbackRunner(invocation, options = {}) {
  if (invocation.kind === "execute-rollback") {
    const result = await runTrustedProcess(PHASE_6J_ROLLBACK_SCRIPT, [
      invocation.deploymentSha,
      invocation.rollbackSha
    ])

    return parseTrustedRollbackOutput(result.stdout)
  }

  if (invocation.kind === "inspect-rollback") {
    return await inspectProductionRollbackReadOnly(invocation, options)
  }

  throw rollbackError(
    "ROLLBACK_OPERATION_REFUSED",
    "Rollback operation is not approved."
  )
}

function rollbackExecutionRunner(options = {}) {
  return options.rollbackRunner || ((invocation) => defaultRollbackRunner(invocation, options))
}

function rollbackInspectionRunner(options = {}) {
  return options.rollbackInspectionRunner || ((invocation) => defaultRollbackRunner(invocation, options))
}

function booleanValue(value, fieldName) {
  if (typeof value !== "boolean") {
    throw ambiguousRollbackError(`${fieldName} was not boolean`)
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
    throw ambiguousRollbackError(`${fieldName} was not an allowed result class`)
  }

  return normalized
}

function resultShaValue(value, fieldName) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return ""
  }

  const normalized = String(value).trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw ambiguousRollbackError(`${fieldName} was not a valid SHA`)
  }

  return normalized
}

function assertStrictResultObject(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw ambiguousRollbackError("rollback result was not an object")
  }

  const keys = Object.keys(result)

  if (keys.length > rollbackResultKeys.size || keys.some((key) => !rollbackResultKeys.has(key))) {
    throw ambiguousRollbackError("rollback result used an unapproved schema")
  }

  if (result.schemaVersion !== 1) {
    throw ambiguousRollbackError("rollback result schema version was not approved")
  }
}

function firstFailedRollbackContractClass(result, mode) {
  if (result.repository !== "passed") {
    return "repository_identity_failed"
  }

  if (mode === "execute" && result.currentCheckout !== "passed") {
    return "current_checkout_mismatch"
  }

  if (result.detached !== "passed") {
    return "checkout_not_detached"
  }

  if (result.clean !== "passed") {
    return "dirty_checkout"
  }

  if (result.previousRevision !== "passed") {
    return "previous_revision_mismatch"
  }

  if (result.rollbackCommit !== "passed") {
    return "rollback_commit_missing"
  }

  if (mode === "execute" && result.checkoutSwitch !== "passed") {
    return "checkout_switch_failed"
  }

  if (result.permissionContract !== "passed") {
    return "permission_contract_failed"
  }

  if (result.runtimePreflight !== "passed") {
    return "runtime_preflight_failed"
  }

  if (mode === "execute" && result.serviceRestart !== "passed") {
    return "service_restart_failed"
  }

  if (result.postrollbackCheckout !== "passed") {
    return "postrollback_checkout_mismatch"
  }

  if (result.serviceActive !== true || result.serviceRunning !== true || result.serviceMainPidNonZero !== true) {
    return "service_not_running"
  }

  return "none"
}

function validateRollbackResult(result, profile, facts, mode) {
  if (isUncertainOutcome(result)) {
    throw ambiguousRollbackError()
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
    githubWriteInvoked: optionalBooleanValue(result.githubWriteInvoked, "githubWriteInvoked"),
    modelInvoked: optionalBooleanValue(result.modelInvoked, "modelInvoked"),
    routeInvoked: optionalBooleanValue(result.routeInvoked, "routeInvoked"),
    networkRefreshInvoked: optionalBooleanValue(result.networkRefreshInvoked, "networkRefreshInvoked"),
    legacyRollbackInvoked: optionalBooleanValue(result.legacyRollbackInvoked, "legacyRollbackInvoked")
  }

  for (const key of resultClassKeys) {
    normalized[key] = resultClassValue(result[key], key)
  }

  if (
    normalized.deploymentInvoked ||
    normalized.githubWriteInvoked ||
    normalized.modelInvoked ||
    normalized.routeInvoked ||
    normalized.networkRefreshInvoked ||
    normalized.legacyRollbackInvoked ||
    (mode === "inspect" && normalized.rollbackInvoked)
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
      failureClass: "service_identity_failed"
    }
  }

  const contractFailure = firstFailedRollbackContractClass(normalized, mode)

  if (normalized.ok !== true || contractFailure !== "none" || observedCheckoutSha !== facts.rollbackSha) {
    const providedFailureClass = normalized.failureClass && normalized.failureClass !== "none"
      ? normalized.failureClass
      : ""
    const checkoutFailureClass = observedCheckoutSha === facts.deploymentSha
      ? "rollback_not_started"
      : "postrollback_checkout_mismatch"

    return {
      ...normalized,
      ok: false,
      failureClass: normalizeSafeResultClass(providedFailureClass || (observedCheckoutSha !== facts.rollbackSha ? checkoutFailureClass : contractFailure))
    }
  }

  return {
    ...normalized,
    ok: true,
    failureClass: ""
  }
}

async function performRollback(profile, facts, options = {}) {
  try {
    const result = await rollbackExecutionRunner(options)({
      kind: "execute-rollback",
      profile,
      deploymentSha: facts.deploymentSha,
      rollbackSha: facts.rollbackSha,
      serviceName: profile.serviceName,
      shell: false,
      timeoutMs: MAX_ROLLBACK_TIMEOUT_MS,
      maxOutputBytes: MAX_ROLLBACK_OUTPUT_BYTES
    })

    return validateRollbackResult(result, profile, facts, "execute")
  } catch (error) {
    if (isUncertainOutcome(error) || error?.code === "ROLLBACK_AMBIGUOUS") {
      throw ambiguousRollbackError()
    }

    if (error instanceof DevelopmentRunStateError && error.code !== "ROLLBACK_OPERATION_FAILED") {
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
      repository: "not_run",
      currentCheckout: "not_run",
      detached: "not_run",
      clean: "not_run",
      previousRevision: "not_run",
      rollbackCommit: "not_run",
      checkoutSwitch: "not_run",
      permissionContract: "not_run",
      runtimePreflight: "not_run",
      serviceRestart: "not_run",
      postrollbackCheckout: "not_run",
      rollbackInvoked: false
    }
  }
}

async function inspectRollback(profile, facts, options = {}) {
  const result = await rollbackInspectionRunner(options)({
    kind: "inspect-rollback",
    profile,
    deploymentSha: facts.deploymentSha,
    rollbackSha: facts.rollbackSha,
    serviceName: profile.serviceName,
    shell: false,
    timeoutMs: MAX_ROLLBACK_TIMEOUT_MS,
    maxOutputBytes: MAX_ROLLBACK_OUTPUT_BYTES
  })

  return validateRollbackResult(result, profile, facts, "inspect")
}

function booleanContractEntry(key, value) {
  return `${key}:${value === true ? "true" : "false"}`
}

function resultClassContractEntry(result, key) {
  return `${key}:${result?.[key] || "not_run"}`
}

function rollbackContractMetadata(result) {
  return [
    resultClassContractEntry(result, "repository"),
    resultClassContractEntry(result, "currentCheckout"),
    resultClassContractEntry(result, "detached"),
    resultClassContractEntry(result, "clean"),
    resultClassContractEntry(result, "previousRevision"),
    resultClassContractEntry(result, "rollbackCommit"),
    resultClassContractEntry(result, "checkoutSwitch"),
    resultClassContractEntry(result, "permissionContract"),
    resultClassContractEntry(result, "runtimePreflight"),
    resultClassContractEntry(result, "serviceRestart"),
    resultClassContractEntry(result, "postrollbackCheckout"),
    booleanContractEntry("serviceActive", result?.serviceActive),
    booleanContractEntry("serviceRunning", result?.serviceRunning),
    booleanContractEntry("serviceMainPidNonZero", result?.serviceMainPidNonZero)
  ]
}

function contractEntryIsSafe(entry) {
  return (
    typeof entry === "string" &&
    entry.length <= 80 &&
    !unsafeControlPattern.test(entry) &&
    !sensitiveTextPattern.test(entry)
  )
}

function rollbackContractProvesFullSuccess(contract) {
  if (!Array.isArray(contract) || contract.length !== rollbackContractEntryCount || contract.some((entry) => !contractEntryIsSafe(entry))) {
    return false
  }

  const entries = new Set(contract)

  return (
    entries.size === rollbackContractEntryCount &&
    entries.has("repository:passed") &&
    entries.has("currentCheckout:passed") &&
    entries.has("detached:passed") &&
    entries.has("clean:passed") &&
    entries.has("previousRevision:passed") &&
    entries.has("rollbackCommit:passed") &&
    entries.has("checkoutSwitch:passed") &&
    entries.has("permissionContract:passed") &&
    entries.has("runtimePreflight:passed") &&
    entries.has("serviceRestart:passed") &&
    entries.has("postrollbackCheckout:passed") &&
    entries.has("serviceActive:true") &&
    entries.has("serviceRunning:true") &&
    entries.has("serviceMainPidNonZero:true")
  )
}

function currentInspectionProvesRollbackApplied(inspection, facts) {
  return Boolean(
    inspection?.ok === true &&
    inspection.observedCheckoutSha === facts.rollbackSha &&
    inspection.repository === "passed" &&
    inspection.detached === "passed" &&
    inspection.clean === "passed" &&
    inspection.previousRevision === "passed" &&
    inspection.rollbackCommit === "passed" &&
    inspection.permissionContract === "passed" &&
    inspection.runtimePreflight === "passed" &&
    inspection.postrollbackCheckout === "passed" &&
    inspection.serviceActive === true &&
    inspection.serviceRunning === true &&
    inspection.serviceMainPidNonZero === true
  )
}

function rollbackFailedEvidenceProvesRetryIdentity(run, facts) {
  const latestRollback = latestRollbackEvidence(run)
  const started = latestRollbackEvidence(run, "rollback_started")
  const failed = latestRollbackEvidence(run, "rollback_failed")
  const startedMetadata = started?.metadata || {}
  const failedMetadata = failed?.metadata || {}

  if (
    latestRollback !== failed ||
    !started ||
    !failed ||
    started.source !== DEVELOPMENT_ROLLBACK_AGENT_ID ||
    failed.source !== DEVELOPMENT_ROLLBACK_AGENT_ID ||
    started.sha !== facts.rollbackSha ||
    failed.sha !== facts.rollbackSha ||
    startedMetadata.agent !== DEVELOPMENT_ROLLBACK_AGENT_ID ||
    failedMetadata.agent !== DEVELOPMENT_ROLLBACK_AGENT_ID ||
    startedMetadata.policyId !== PHASE_6J_ROLLBACK_POLICY_ID ||
    startedMetadata.policyHash !== PHASE_6J_ROLLBACK_POLICY_HASH ||
    failedMetadata.policyId !== PHASE_6J_ROLLBACK_POLICY_ID ||
    failedMetadata.policyHash !== PHASE_6J_ROLLBACK_POLICY_HASH ||
    startedMetadata.deploymentSha !== facts.deploymentSha ||
    failedMetadata.deploymentSha !== facts.deploymentSha ||
    startedMetadata.rollbackSha !== facts.rollbackSha ||
    failedMetadata.rollbackSha !== facts.rollbackSha ||
    startedMetadata.outcome !== "rollback_started" ||
    failedMetadata.outcome !== "rollback_failed" ||
    !Number.isInteger(startedMetadata.attempt) ||
    startedMetadata.attempt <= 0 ||
    !Number.isInteger(failedMetadata.attempt) ||
    failedMetadata.attempt <= 0 ||
    startedMetadata.attempt !== failedMetadata.attempt
  ) {
    throw rollbackError(
      "ROLLBACK_RETRY_EVIDENCE_INVALID",
      "A rollback_failed retry requires exact Phase 6J policy evidence for the same deployment and rollback SHAs."
    )
  }
}

function retryInspectionProvesRollbackNeverStarted(inspection, facts) {
  return Boolean(
    inspection &&
    inspection.observedCheckoutSha === facts.deploymentSha &&
    inspection.repository === "passed" &&
    inspection.currentCheckout === "passed" &&
    inspection.detached === "passed" &&
    inspection.clean === "passed" &&
    inspection.previousRevision === "passed" &&
    inspection.rollbackCommit === "passed" &&
    inspection.postrollbackCheckout !== "passed" &&
    inspection.rollbackInvoked === false &&
    inspection.deploymentInvoked !== true &&
    inspection.networkRefreshInvoked !== true &&
    inspection.serviceEnabled === true &&
    inspection.serviceActive === true &&
    inspection.serviceRunning === true &&
    inspection.serviceMainPidNonZero === true
  )
}

async function assertRollbackFailedRetrySafe(run, profile, facts, options = {}) {
  rollbackFailedEvidenceProvesRetryIdentity(run, facts)

  let inspection

  try {
    inspection = await inspectRollback(profile, facts, options)
  } catch (error) {
    if (isUncertainOutcome(error) || error?.code === "ROLLBACK_AMBIGUOUS") {
      throw ambiguousRollbackError()
    }

    throw error
  }

  if (!retryInspectionProvesRollbackNeverStarted(inspection, facts)) {
    throw rollbackError(
      "ROLLBACK_RETRY_RECONCILIATION_REQUIRED",
      "Rollback retry requires read-only reconciliation proving production is still at the failed deployment SHA and safe to retry."
    )
  }
}

function rollbackEvidence(run, facts, outcome, metadata, summary) {
  return {
    kind: "rollback",
    sha: facts.rollbackSha,
    source: DEVELOPMENT_ROLLBACK_AGENT_ID,
    summary,
    metadata: {
      project: run.project.id,
      agent: DEVELOPMENT_ROLLBACK_AGENT_ID,
      policyId: PHASE_6J_ROLLBACK_POLICY_ID,
      policyHash: PHASE_6J_ROLLBACK_POLICY_HASH,
      deploymentSha: facts.deploymentSha,
      rollbackSha: facts.rollbackSha,
      outcome,
      ...metadata
    }
  }
}

function rollbackResultMetadata(result) {
  return {
    observedCheckoutSha: result.observedCheckoutSha || "",
    service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
    contract: rollbackContractMetadata(result)
  }
}

async function transitionRollbackFailed(run, facts, result, options = {}) {
  const api = stateApi(options)
  const evidence = rollbackEvidence(run, facts, "rollback_failed", {
    attempt: run.attempts.rollback,
    failureClass: normalizeSafeResultClass(result.failureClass),
    ...rollbackResultMetadata(result)
  }, "Phase 6J exact previous-SHA rollback failed definitively.")

  return await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "rollback_failed",
    actor: DEVELOPMENT_ROLLBACK_AGENT_ID,
    reason: "phase-6j-rollback-failed",
    evidence: [evidence]
  }, options)
}

async function transitionRolledBack(run, facts, result, options = {}) {
  const api = stateApi(options)
  const evidence = rollbackEvidence(run, facts, "rolled_back", {
    attempt: run.attempts.rollback,
    ...rollbackResultMetadata(result)
  }, "Phase 6J exact previous-SHA rollback completed.")

  return await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "rolled_back",
    actor: DEVELOPMENT_ROLLBACK_AGENT_ID,
    reason: "phase-6j-rolled-back",
    evidence: [evidence]
  }, options)
}

async function executeDevelopmentRollbackInternal(runId, options = {}) {
  assertNoCallerRollbackTarget(options)
  assertOwnerRollbackConfirmation(options.ownerConfirmation)

  const expectedVersion = normalizeExpectedVersion(options.expectedVersion)
  const api = stateApi(options)
  const profile = resolveApprovedDeploymentProfile()
  let run = await api.read(runId, options)

  if (run.version !== expectedVersion) {
    throw rollbackError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before rollback."
    )
  }

  if (!["verification_failed", "rollback_failed"].includes(run.status)) {
    throw rollbackError(
      "ROLLBACK_RUN_NOT_VERIFICATION_FAILED",
      "Development run must be verification_failed or rollback_failed before Phase 6J rollback."
    )
  }

  const facts = rollbackEvidenceFacts(run, profile)

  if (run.status === "rollback_failed") {
    await assertRollbackFailedRetrySafe(run, profile, facts, options)
  }

  const attempt = run.attempts.rollback + 1

  run = await api.transition(run.runId, {
    expectedVersion: run.version,
    status: "rollback_in_progress",
    actor: DEVELOPMENT_ROLLBACK_AGENT_ID,
    reason: "phase-6j-rollback-start",
    evidence: [rollbackEvidence(run, facts, "rollback_started", {
      attempt,
      service: profile.serviceName,
      recordedAt: timestamp(options)
    }, "Phase 6J exact previous-SHA rollback attempt was reserved.")]
  }, options)

  const rollback = await performRollback(profile, facts, options)
  const current = await api.read(run.runId, options)

  if (current.status !== "rollback_in_progress") {
    throw rollbackError(
      "STALE_RUN_VERSION",
      "Development run state changed during rollback; reconcile before retrying."
    )
  }

  const currentFacts = rollbackEvidenceFacts(current, profile)

  if (currentFacts.deploymentSha !== facts.deploymentSha || currentFacts.rollbackSha !== facts.rollbackSha) {
    throw rollbackError(
      "ROLLBACK_SHA_CHAIN_INVALID",
      "Rollback evidence changed during rollback; reconcile before retrying."
    )
  }

  if (!rollback.ok) {
    const failedRun = await transitionRollbackFailed(current, facts, rollback, options)

    return {
      ok: false,
      outcome: "rollback_failed",
      run: failedRun,
      rollback: {
        policyId: PHASE_6J_ROLLBACK_POLICY_ID,
        policyHash: PHASE_6J_ROLLBACK_POLICY_HASH,
        deploymentSha: facts.deploymentSha,
        rollbackSha: facts.rollbackSha,
        checkoutSha: rollback.observedCheckoutSha || "",
        service: profile.serviceName,
        failureClass: normalizeSafeResultClass(rollback.failureClass)
      }
    }
  }

  const rolledBackRun = await transitionRolledBack(current, facts, rollback, options)

  return {
    ok: true,
    outcome: "rolled_back",
    run: rolledBackRun,
    rollback: {
      policyId: PHASE_6J_ROLLBACK_POLICY_ID,
      policyHash: PHASE_6J_ROLLBACK_POLICY_HASH,
      deploymentSha: facts.deploymentSha,
      rollbackSha: facts.rollbackSha,
      checkoutSha: rollback.observedCheckoutSha,
      service: profile.serviceName
    }
  }
}

export async function executeDevelopmentRollback(runId, options = {}) {
  try {
    return await executeDevelopmentRollbackInternal(runId, options)
  } catch (error) {
    throw safeRollbackFailure(error)
  }
}

function rollbackAttempt(run) {
  const started = latestRollbackEvidence(run, "rollback_started")

  if (
    started?.metadata?.policyId === PHASE_6J_ROLLBACK_POLICY_ID &&
    started?.metadata?.policyHash === PHASE_6J_ROLLBACK_POLICY_HASH &&
    Number.isInteger(started?.metadata?.attempt) &&
    started.metadata.attempt > 0
  ) {
    return started.metadata.attempt
  }

  return null
}

function rollbackEvidenceComplete(run, facts, inspection) {
  const rolledBack = latestRollbackEvidence(run, "rolled_back")
  const metadata = rolledBack?.metadata || {}
  const attempt = rollbackAttempt(run)

  return Boolean(
    run.status === "rolled_back" &&
    rolledBack &&
    currentInspectionProvesRollbackApplied(inspection, facts) &&
    rolledBack.source === DEVELOPMENT_ROLLBACK_AGENT_ID &&
    rolledBack.sha === facts.rollbackSha &&
    metadata.agent === DEVELOPMENT_ROLLBACK_AGENT_ID &&
    metadata.policyId === PHASE_6J_ROLLBACK_POLICY_ID &&
    metadata.policyHash === PHASE_6J_ROLLBACK_POLICY_HASH &&
    metadata.outcome === "rolled_back" &&
    metadata.deploymentSha === facts.deploymentSha &&
    metadata.rollbackSha === facts.rollbackSha &&
    metadata.observedCheckoutSha === facts.rollbackSha &&
    metadata.service === PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName &&
    Number.isInteger(metadata.attempt) &&
    metadata.attempt > 0 &&
    attempt === metadata.attempt &&
    rollbackContractProvesFullSuccess(metadata.contract)
  )
}

async function reconcileDevelopmentRollbackInternal(runId, options = {}) {
  assertNoCallerRollbackTarget(options)

  const api = stateApi(options)
  const profile = resolveApprovedDeploymentProfile()
  const run = await api.read(runId, options)
  let facts = null
  let inspection = null
  let evidenceComplete = false
  let ownerActionRequired = false

  try {
    facts = rollbackEvidenceFacts(run, profile)
    inspection = await inspectRollback(profile, facts, options)
    evidenceComplete = rollbackEvidenceComplete(run, facts, inspection)
    ownerActionRequired = ["verification_failed", "rollback_in_progress", "rollback_failed", "rolled_back"].includes(run.status) && !evidenceComplete
  } catch {
    ownerActionRequired = ["verification_failed", "rollback_in_progress", "rollback_failed", "rolled_back"].includes(run.status)
  }

  const currentCheckoutSha = inspection?.observedCheckoutSha || null
  const checkoutMatchesDeploymentSha = Boolean(facts && currentCheckoutSha === facts.deploymentSha)
  const checkoutMatchesRollbackSha = Boolean(facts && currentCheckoutSha === facts.rollbackSha)
  const completionProven = run.status === "rolled_back" && evidenceComplete

  return {
    ok: true,
    outcome: "rollback_reconciled",
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id,
      headSha: run.headSha
    },
    rollback: {
      policyId: PHASE_6J_ROLLBACK_POLICY_ID,
      policyHash: PHASE_6J_ROLLBACK_POLICY_HASH,
      attempt: rollbackAttempt(run),
      expectedDeploymentSha: facts?.deploymentSha || null,
      expectedRollbackSha: facts?.rollbackSha || null,
      currentCheckoutSha,
      checkoutMatchesDeploymentSha,
      checkoutMatchesRollbackSha,
      detached: inspection?.detached || "not_run",
      clean: inspection?.clean || "not_run",
      previousRevision: inspection?.previousRevision || "not_run",
      runtimePreflight: inspection?.runtimePreflight || "not_run",
      service: {
        name: profile.serviceName,
        enabled: inspection?.serviceEnabled === true,
        active: inspection?.serviceActive === true,
        running: inspection?.serviceRunning === true && inspection?.serviceMainPidNonZero === true
      },
      rollbackEvidenceComplete: evidenceComplete,
      rollbackAppearsNotStarted: checkoutMatchesDeploymentSha,
      rollbackAppearsApplied: checkoutMatchesRollbackSha,
      completionProven,
      retryRequiresOwnerAction: ownerActionRequired,
      ownerActionRequired
    }
  }
}

export async function reconcileDevelopmentRollback(runId, options = {}) {
  try {
    return await reconcileDevelopmentRollbackInternal(runId, options)
  } catch (error) {
    throw safeRollbackFailure(error)
  }
}

export function formatDevelopmentRollbackAgentError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO rollback error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO rollback error: unexpected local failure."
}

export const phase6JRollbackSecurityBoundary = Object.freeze({
  policyId: PHASE_6J_ROLLBACK_POLICY_ID,
  policyHash: PHASE_6J_ROLLBACK_POLICY_HASH,
  startsFrom: "verification_failed",
  stopsAt: "rolled_back",
  exactPreviousShaOnly: true,
  ownerConfirmationRequired: true,
  automaticRollback: false,
  rollbackFromVerified: false,
  deploymentMutation: false,
  serviceRestartFixedOnly: true,
  networkRefresh: false,
  gitFetch: false,
  githubWrite: false,
  modelExecution: false,
  ppoContinue: false,
  telegramOrOpenClawRouting: false
})
