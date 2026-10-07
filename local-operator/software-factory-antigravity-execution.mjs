import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  readDevelopmentRun,
  recordDevelopmentRunProgress,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  inspectImplementationWorkspace,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"
import {
  assertAntigravityDispatchAuthorization,
  ANTIGRAVITY_REVIEWED_EXECUTABLE_PATHS
} from "./software-factory-antigravity-readiness.mjs"

const execFileAsync = promisify(execFile)

export const ANTIGRAVITY_EXECUTION_ADAPTER_ID = "software-factory-v0-antigravity-execution"
export const ANTIGRAVITY_EXECUTION_SCHEMA_VERSION = 1
export const ANTIGRAVITY_EXECUTION_MAX_OUTPUT_BYTES = 256 * 1024
export const ANTIGRAVITY_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000
export const ANTIGRAVITY_EXECUTION_PROMPT_MAX_CHARS = 6000

const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:])/iu
const shaPattern = /^[a-f0-9]{40}$/u
const reviewedCapabilities = new Set([
  "implementation.backend",
  "implementation.frontend",
  "debugging"
])

export class SoftwareFactoryAntigravityExecutionError extends DevelopmentRunStateError {
  constructor(code, safeMessage, failureClass = "runtime") {
    super(code, safeMessage)
    this.name = "SoftwareFactoryAntigravityExecutionError"
    this.failureClass = failureClass
  }
}

function executionError(code, safeMessage, failureClass = "runtime") {
  return new SoftwareFactoryAntigravityExecutionError(code, safeMessage, failureClass)
}

function safeFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }
  return executionError(
    "ANTIGRAVITY_EXECUTION_UNAVAILABLE",
    "Antigravity implementation execution is unavailable; no raw failure was stored."
  )
}

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function timestamp(options = {}) {
  return nowDate(options).toISOString()
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeSafeText(value, {
  maxChars,
  code = "ANTIGRAVITY_EXECUTION_INPUT_INVALID",
  safeMessage = "Antigravity execution input is invalid.",
  required = true
}) {
  const normalized = String(value ?? "").trim()
  if (
    (required && !normalized) ||
    normalized.length > maxChars ||
    unsafeControlPattern.test(normalized) ||
    sensitiveTextPattern.test(normalized)
  ) {
    throw executionError(code, safeMessage, "configuration")
  }
  return normalized
}

function normalizeSha(value, label = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (!shaPattern.test(normalized)) {
    throw executionError(
      "ANTIGRAVITY_EXECUTION_SHA_INVALID",
      `${label} must be a full 40-character Git SHA.`,
      "configuration"
    )
  }
  return normalized
}

function assertWithin(parent, child) {
  const rel = relative(parent, child)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw executionError(
      "ANTIGRAVITY_WORKSPACE_UNTRUSTED",
      "Antigravity execution workspace is outside the reviewed boundary.",
      "workspace_trust"
    )
  }
}

function permissionAllowSet(settings) {
  const allow = settings?.permissions?.allow
  return new Set(Array.isArray(allow) ? allow.filter((value) => typeof value === "string") : [])
}

export function validateAntigravityAutomationSettings(settings, workspaceRoot, workspacePath) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw executionError(
      "ANTIGRAVITY_AUTOMATION_SETTINGS_REQUIRED",
      "Antigravity automation settings are not configured for unattended workspace edits.",
      "configuration"
    )
  }

  if (settings.toolPermission !== "always-proceed") {
    throw executionError(
      "ANTIGRAVITY_AUTOMATION_SETTINGS_REQUIRED",
      "Antigravity unattended execution requires the reviewed always-proceed file-operation policy.",
      "configuration"
    )
  }

  if (settings.nonWorkspaceAccess === true || settings["non-workspace-access"] === true) {
    throw executionError(
      "ANTIGRAVITY_NON_WORKSPACE_ACCESS_ENABLED",
      "Antigravity non-workspace access must remain disabled for PPO execution.",
      "configuration"
    )
  }

  const allow = permissionAllowSet(settings)
  if (!allow.has("read_file(*)") || !allow.has("write_file(*)")) {
    throw executionError(
      "ANTIGRAVITY_FILE_POLICY_REQUIRED",
      "Antigravity file read/write operations must be explicitly allowlisted for unattended execution.",
      "configuration"
    )
  }

  const trusted = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces.filter((value) => typeof value === "string")
    : []
  const canonicalManagedRoot = resolvePath(workspaceRoot)
  const canonicalWorkspace = resolvePath(workspacePath)
  const trustedMatch = trusted.some((root) => {
    if (!isAbsolute(root)) {
      return false
    }
    const canonicalRoot = resolvePath(root)
    const rootWithinManaged = (() => {
      const rel = relative(canonicalManagedRoot, canonicalRoot)
      return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    })()
    const workspaceWithinTrusted = (() => {
      const rel = relative(canonicalRoot, canonicalWorkspace)
      return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    })()
    return rootWithinManaged && workspaceWithinTrusted
  })

  if (!trustedMatch) {
    throw executionError(
      "ANTIGRAVITY_WORKSPACE_NOT_TRUSTED",
      "PPO workspace is not inside an Antigravity trusted workspace.",
      "configuration"
    )
  }

  return Object.freeze({
    toolPermission: settings.toolPermission,
    nonWorkspaceAccess: false,
    fileReadAllowed: true,
    fileWriteAllowed: true
  })
}

function fixedGitPath(platform) {
  if (platform === "darwin") return "/opt/homebrew/bin/git"
  if (platform === "linux") return "/usr/bin/git"
  throw executionError(
    "ANTIGRAVITY_PLATFORM_UNSUPPORTED",
    "Antigravity implementation execution is not reviewed for this platform.",
    "configuration"
  )
}

function fixedSettingsPath(homePath) {
  return join(homePath, ".gemini", "antigravity-cli", "settings.json")
}

async function validateRegularPrivateFile(path, safeCode, safeMessage) {
  const linkInfo = await lstat(path).catch(() => null)
  if (!linkInfo || linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw executionError(safeCode, safeMessage, "configuration")
  }
  const canonical = await realpath(path).catch(() => null)
  if (canonical !== path) {
    throw executionError(safeCode, safeMessage, "configuration")
  }
  return canonical
}

async function readAutomationSettings(homePath, workspaceRoot, workspacePath) {
  const path = fixedSettingsPath(homePath)
  await validateRegularPrivateFile(
    path,
    "ANTIGRAVITY_AUTOMATION_SETTINGS_REQUIRED",
    "Antigravity automation settings are unavailable or unsafe."
  )
  let settings
  try {
    const raw = await readFile(path, "utf8")
    if (Buffer.byteLength(raw, "utf8") > 128 * 1024) throw new Error("oversized")
    settings = JSON.parse(raw)
  } catch {
    throw executionError(
      "ANTIGRAVITY_AUTOMATION_SETTINGS_REQUIRED",
      "Antigravity automation settings are unavailable or invalid.",
      "configuration"
    )
  }
  return validateAntigravityAutomationSettings(settings, workspaceRoot, workspacePath)
}

async function resolveReviewedAgy(platform) {
  const candidates = ANTIGRAVITY_REVIEWED_EXECUTABLE_PATHS[platform] || []
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch(() => null)
    if (!info || info.isSymbolicLink() || !info.isFile() || (info.mode & 0o022) !== 0) continue
    const canonical = await realpath(candidate).catch(() => null)
    if (canonical === candidate) return canonical
  }
  throw executionError(
    "ANTIGRAVITY_EXECUTABLE_UNAVAILABLE",
    "Reviewed Antigravity executable is unavailable.",
    "configuration"
  )
}

async function validateGitExecutable(path) {
  const info = await lstat(path).catch(() => null)
  if (!info || info.isSymbolicLink() || !info.isFile() || (info.mode & 0o022) !== 0) {
    throw executionError(
      "ANTIGRAVITY_GIT_UNTRUSTED",
      "Reviewed Git executable is unavailable or unsafe.",
      "configuration"
    )
  }
  const canonical = await realpath(path).catch(() => null)
  if (canonical !== path) {
    throw executionError(
      "ANTIGRAVITY_GIT_UNTRUSTED",
      "Reviewed Git executable is unavailable or unsafe.",
      "configuration"
    )
  }
  return canonical
}

function sanitizedEnv(homePath, agyPath, gitPath) {
  return {
    PATH: [dirname(agyPath), dirname(gitPath), "/usr/bin", "/bin"].join(":"),
    HOME: homePath,
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1"
  }
}

async function gitText(gitPath, cwd, args, env) {
  try {
    const result = await execFileAsync(gitPath, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      timeout: 30_000,
      shell: false
    })
    return String(result.stdout ?? "").trim()
  } catch {
    throw executionError(
      "ANTIGRAVITY_GIT_VERIFICATION_FAILED",
      "PPO could not verify Antigravity workspace Git state.",
      "git_verification"
    )
  }
}

async function gitFacts(gitPath, cwd, env) {
  const [headSha, branch, statusText, remote] = await Promise.all([
    gitText(gitPath, cwd, ["rev-parse", "HEAD"], env),
    gitText(gitPath, cwd, ["branch", "--show-current"], env),
    gitText(gitPath, cwd, ["status", "--porcelain=v1", "--untracked-files=all"], env),
    gitText(gitPath, cwd, ["remote", "get-url", "origin"], env)
  ])
  return { headSha: normalizeSha(headSha), branch, statusText, remote }
}

function sameSourceFacts(before, after) {
  return before.headSha === after.headSha &&
    before.branch === after.branch &&
    before.statusText === after.statusText &&
    before.remote === after.remote
}

function latestPlanningSummary(run) {
  const evidence = Array.isArray(run?.evidence?.planning) ? run.evidence.planning : []
  return evidence.at(-1)?.summary || null
}

export function buildAntigravityImplementationPrompt(run, workspace, authorization) {
  const task = normalizeSafeText(run?.task, {
    maxChars: 1000,
    code: "ANTIGRAVITY_PROMPT_UNSAFE",
    safeMessage: "Antigravity implementation prompt source is unsafe."
  })
  const project = normalizeSafeText(run?.project?.id, { maxChars: 80 })
  const repo = normalizeSafeText(run?.project?.fullName, { maxChars: 140 })
  const branch = normalizeSafeText(workspace?.branch, { maxChars: 160 })
  const workspaceRef = normalizeSafeText(workspace?.workspaceRef, { maxChars: 180 })
  const planning = latestPlanningSummary(run)
  const skillLines = Array.isArray(authorization?.skills) && authorization.skills.length
    ? authorization.skills.map((skill) => `- Use the installed Antigravity skill: ${normalizeSafeText(skill, { maxChars: 100 })}.`)
    : ["- No specialist skill is required beyond the approved task."]
  const lines = [
    "Execute exactly one bounded PPO implementation task in the current isolated workspace.",
    `Project: ${project}`,
    `Repository: ${repo}`,
    `Branch: ${branch}`,
    `Workspace reference: ${workspaceRef}`,
    `Capability: ${authorization.capability}`,
    `Model class policy: ${authorization.modelClass}`,
    "",
    "Task:",
    task,
    ...(planning ? ["", "Planning context:", normalizeSafeText(planning, { maxChars: 500 })] : []),
    "",
    "Required skills:",
    ...skillLines,
    "",
    "Execution behavior:",
    "- This PPO task and its plan are already approved. Do not start a second planning or artifact-approval cycle.",
    "- Execute the bounded implementation directly and finish in this non-interactive session.",
    "",
    "Hard boundaries:",
    "- Edit only files inside the current workspace.",
    "- Do not access or modify files outside the workspace.",
    "- Do not push, fetch, pull, merge, rebase, reset, cherry-pick, tag, or modify any remote Git state.",
    "- Do not deploy, publish, restart services, modify infrastructure, or call production systems.",
    "- Do not modify credentials, authentication settings, tokens, secrets, or Antigravity configuration.",
    "- Do not add unrelated dependencies, broad refactors, or scope not required by the task.",
    "- Do not commit. PPO will inspect and create the local commit after execution.",
    "- Keep terminal commands local to the workspace. Network-dependent application actions are out of scope.",
    "",
    "Implement the requested change and return concise completion notes. PPO independently verifies all file and Git state."
  ]
  const prompt = `${lines.join("\n")}\n`
  if (prompt.length > ANTIGRAVITY_EXECUTION_PROMPT_MAX_CHARS || sensitiveTextPattern.test(prompt)) {
    throw executionError(
      "ANTIGRAVITY_PROMPT_UNSAFE",
      "Antigravity implementation prompt exceeds the reviewed safety bound.",
      "configuration"
    )
  }
  return prompt
}

function failureClassFromOutput(stdout, stderr, error = null) {
  const text = `${stdout || ""}\n${stderr || ""}`
  if (/quota (?:reached|exhausted)|0% remaining|limit(?:s)? exhausted/iu.test(text)) return "usage_limit"
  if (/rate limit|too many requests|\b429\b/iu.test(text)) return "usage_limit"
  if (/permission|approval|request-review|tool.*denied|operation.*denied/iu.test(text)) return "permission"
  if (/not authenticated|authentication required|sign in|login required|unauthorized|\b401\b/iu.test(text)) return "authentication"
  if (error?.killed || error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT") return "runtime"
  return "nonzero_exit"
}


function antigravityAttemptEvidence(run) {
  const entries = Array.isArray(run?.evidence?.implementation)
    ? run.evidence.implementation
    : []
  const attempt = run?.attempts?.implementation

  return Number.isInteger(attempt) && attempt > 0
    ? entries.filter((entry) => (
        entry?.source === ANTIGRAVITY_EXECUTION_ADAPTER_ID &&
        entry?.metadata?.attempt === attempt
      ))
    : []
}

export function classifyAntigravityExecutionAttemptEvidence(run) {
  const entries = antigravityAttemptEvidence(run)

  if (entries.length === 0) {
    return "none"
  }

  const outcomes = entries.map((entry) => entry?.metadata?.outcome)
  const startedCount = outcomes.filter((outcome) => outcome === "execution_started").length
  const failedCount = outcomes.filter((outcome) => outcome === "execution_failed").length
  const readyCount = outcomes.filter((outcome) => outcome === "implementation_ready").length

  if (startedCount !== 1 || failedCount > 1 || readyCount > 1 || (failedCount > 0 && readyCount > 0)) {
    return "invalid"
  }

  const lastOutcome = outcomes.at(-1)

  if (lastOutcome === "execution_started") {
    return "open"
  }

  if (lastOutcome === "execution_failed") {
    return "definitive_failed"
  }

  if (lastOutcome === "implementation_ready") {
    return "completed"
  }

  return "invalid"
}

export function buildAntigravityExecutionArgs(prompt) {
  const normalizedPrompt = normalizeSafeText(prompt, {
    maxChars: ANTIGRAVITY_EXECUTION_PROMPT_MAX_CHARS,
    code: "ANTIGRAVITY_PROMPT_UNSAFE",
    safeMessage: "Antigravity implementation prompt source is unsafe."
  })
  return Object.freeze([
    "-p",
    normalizedPrompt,
    "--sandbox",
    "--print-timeout",
    "10m"
  ])
}

async function invokeAntigravity(agyPath, cwd, prompt, env) {
  try {
    const result = await execFileAsync(agyPath, buildAntigravityExecutionArgs(prompt), {
      cwd,
      env,
      encoding: "utf8",
      timeout: ANTIGRAVITY_EXECUTION_TIMEOUT_MS,
      maxBuffer: ANTIGRAVITY_EXECUTION_MAX_OUTPUT_BYTES,
      shell: false
    })
    const output = `${result.stdout || ""}\n${result.stderr || ""}`
    if (sensitiveTextPattern.test(output)) {
      throw executionError(
        "ANTIGRAVITY_EXECUTION_OUTPUT_UNSAFE",
        "Antigravity execution output contained sensitive material and was discarded.",
        "runtime"
      )
    }
    return { stdout: result.stdout || "", stderr: result.stderr || "" }
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) throw error
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || error?.code === "ENOBUFS") {
      throw executionError(
        "ANTIGRAVITY_EXECUTION_OUTPUT_INVALID",
        "Antigravity execution output exceeded the reviewed size bound.",
        "runtime"
      )
    }
    const failureClass = failureClassFromOutput(error?.stdout, error?.stderr, error)
    throw executionError(
      failureClass === "permission"
        ? "ANTIGRAVITY_PERMISSION_BLOCKED"
        : failureClass === "usage_limit"
          ? "ANTIGRAVITY_CAPACITY_BLOCKED"
          : "ANTIGRAVITY_EXECUTION_FAILED",
      failureClass === "permission"
        ? "Antigravity unattended file permissions are not ready for PPO execution."
        : failureClass === "usage_limit"
          ? "Antigravity capacity became unavailable during execution."
          : "Antigravity implementation execution did not complete successfully.",
      failureClass
    )
  }
}

async function restoreWorkspace(gitPath, workspacePath, expectedStartSha, env) {
  try {
    await execFileAsync(gitPath, ["reset", "--hard", expectedStartSha], {
      cwd: workspacePath,
      env,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      timeout: 30_000,
      shell: false
    })
    await execFileAsync(gitPath, ["clean", "-fd"], {
      cwd: workspacePath,
      env,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      timeout: 30_000,
      shell: false
    })
  } catch {
    throw executionError(
      "ANTIGRAVITY_RECONCILIATION_REQUIRED",
      "Failed Antigravity execution requires workspace reconciliation before retrying.",
      "workspace_invalid"
    )
  }

  const facts = await gitFacts(gitPath, workspacePath, env)
  if (facts.headSha !== expectedStartSha || facts.statusText) {
    throw executionError(
      "ANTIGRAVITY_RECONCILIATION_REQUIRED",
      "Failed Antigravity execution requires workspace reconciliation before retrying.",
      "workspace_invalid"
    )
  }
}

async function commitWorkspace(gitPath, workspacePath, expectedStartSha, env) {
  const before = await gitFacts(gitPath, workspacePath, env)
  if (before.headSha !== expectedStartSha) {
    throw executionError(
      "ANTIGRAVITY_WORKSPACE_HEAD_MISMATCH",
      "Antigravity workspace HEAD changed unexpectedly before PPO commit.",
      "git_verification"
    )
  }
  if (!before.statusText) {
    throw executionError(
      "ANTIGRAVITY_NO_IMPLEMENTATION",
      "Antigravity produced no workspace changes.",
      "no_change"
    )
  }
  await gitText(gitPath, workspacePath, ["add", "--all"], env)
  try {
    await execFileAsync(gitPath, [
      "-c", "user.name=PPO Software Factory",
      "-c", "user.email=ppo@localhost.invalid",
      "commit", "-m", "PPO Antigravity implementation"
    ], {
      cwd: workspacePath,
      env,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      timeout: 30_000,
      shell: false
    })
  } catch {
    throw executionError(
      "ANTIGRAVITY_COMMIT_FAILED",
      "PPO could not preserve verified Antigravity workspace changes.",
      "git_verification"
    )
  }
  const after = await gitFacts(gitPath, workspacePath, env)
  if (after.statusText || after.headSha === expectedStartSha) {
    throw executionError(
      "ANTIGRAVITY_IMPLEMENTATION_INVALID",
      "Antigravity implementation could not be preserved as a clean local commit.",
      "git_verification"
    )
  }
  const countText = await gitText(gitPath, workspacePath, [
    "rev-list", "--ancestry-path", "--count", `${expectedStartSha}..HEAD`
  ], env)
  const count = Number.parseInt(countText, 10)
  const changed = (await gitText(gitPath, workspacePath, [
    "diff", "--name-only", `${expectedStartSha}..HEAD`
  ], env)).split(/\r?\n/u).filter(Boolean)
  if (!Number.isInteger(count) || count <= 0 || changed.length === 0) {
    throw executionError(
      "ANTIGRAVITY_IMPLEMENTATION_INVALID",
      "Antigravity implementation commit is not a valid descendant change.",
      "git_verification"
    )
  }
  return { headSha: after.headSha, changedFileCount: changed.length }
}

function executionEvidence(run, location, authorization, data) {
  return {
    kind: "implementation",
    sha: data.sha,
    source: ANTIGRAVITY_EXECUTION_ADAPTER_ID,
    summary: data.outcome === "implementation_ready"
      ? "Antigravity implementation completed and was verified locally."
      : "Antigravity implementation attempt ended without a verified implementation.",
    metadata: {
      project: run.project.id,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef,
      adapter: ANTIGRAVITY_EXECUTION_ADAPTER_ID,
      attempt: data.attempt,
      promptHash: data.promptHash,
      startedAt: data.startedAt,
      ...(data.endedAt ? { endedAt: data.endedAt } : {}),
      outcome: data.outcome,
      ...(data.failureClass ? { failureClass: data.failureClass } : {}),
      capability: authorization.capability,
      modelClass: authorization.modelClass,
      checkpointVersion: authorization.checkpointVersion,
      remotePolicy: "deny",
      networkPolicy: "antigravity-sandbox",
      ...(data.changedFileCount !== undefined ? { changedFiles: data.changedFileCount } : {})
    }
  }
}

async function executeInternal(runId, authorization, options = {}) {
  const expectedVersion = options.expectedVersion
  if (!Number.isInteger(expectedVersion)) {
    throw executionError(
      "ANTIGRAVITY_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required.",
      "configuration"
    )
  }

  const checkedAuthorization = assertAntigravityDispatchAuthorization(authorization)
  if (!reviewedCapabilities.has(checkedAuthorization.capability)) {
    throw executionError(
      "ANTIGRAVITY_CAPABILITY_NOT_EXECUTABLE",
      "Authorized Antigravity capability is not an implementation execution capability.",
      "configuration"
    )
  }

  const run = await readDevelopmentRun(runId, options)
  if (
    run.status !== "implementation_in_progress" ||
    run.version !== expectedVersion ||
    checkedAuthorization.runId !== run.runId ||
    checkedAuthorization.runVersion !== run.version ||
    checkedAuthorization.projectId !== run.project.id
  ) {
    throw executionError(
      "ANTIGRAVITY_AUTHORIZATION_RUN_MISMATCH",
      "Antigravity dispatch authorization no longer matches the current development run.",
      "configuration"
    )
  }

  const inspection = await inspectImplementationWorkspace(runId, options)
  if (!inspection.exists || inspection.status !== "matching") {
    throw executionError(
      "ANTIGRAVITY_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or mismatched.",
      "workspace_invalid"
    )
  }
  const location = await resolveImplementationWorkspaceLocation(run, options)
  const workspaceReal = await realpath(location.workspacePath).catch(() => null)
  if (workspaceReal !== location.workspacePath) {
    throw executionError(
      "ANTIGRAVITY_WORKSPACE_UNTRUSTED",
      "Implementation workspace must be canonical.",
      "workspace_trust"
    )
  }

  const platform = process.platform
  const agyPath = await resolveReviewedAgy(platform)
  const gitPath = await validateGitExecutable(fixedGitPath(platform))
  const configuredHome = process.env.HOME
  if (typeof configuredHome !== "string" || !configuredHome.trim() || !isAbsolute(configuredHome)) {
    throw executionError(
      "ANTIGRAVITY_HOME_INVALID",
      "Antigravity home directory is unavailable.",
      "configuration"
    )
  }
  const homePath = resolvePath(configuredHome)
  const homeReal = await realpath(homePath).catch(() => null)
  if (homeReal !== homePath) {
    throw executionError(
      "ANTIGRAVITY_HOME_INVALID",
      "Antigravity home directory is unavailable.",
      "configuration"
    )
  }
  await readAutomationSettings(homePath, location.workspaceRoot, location.workspacePath)
  const env = sanitizedEnv(homePath, agyPath, gitPath)
  const expectedStartSha = normalizeSha(run.headSha || run.baseSha, "Run implementation head SHA")
  const workspaceBefore = await gitFacts(gitPath, location.workspacePath, env)
  if (
    workspaceBefore.headSha !== expectedStartSha ||
    workspaceBefore.statusText ||
    workspaceBefore.branch !== location.branch
  ) {
    throw executionError(
      "ANTIGRAVITY_WORKSPACE_NOT_READY",
      "Implementation workspace is not clean at the authorized starting SHA.",
      "workspace_invalid"
    )
  }

  const sourcePath = options.workspaceRegistry?.[run.project.id]?.sourceRepoPath
  if (!sourcePath) {
    throw executionError(
      "ANTIGRAVITY_SOURCE_REGISTRY_REQUIRED",
      "Project source repository path is required for execution verification.",
      "configuration"
    )
  }
  const sourceReal = await realpath(sourcePath).catch(() => null)
  if (!sourceReal || sourceReal !== sourcePath) {
    throw executionError(
      "ANTIGRAVITY_SOURCE_UNTRUSTED",
      "Project source repository path is unavailable or non-canonical.",
      "workspace_trust"
    )
  }
  assertWithin(dirname(sourceReal), sourceReal)
  const sourceBefore = await gitFacts(gitPath, sourceReal, env)

  const prompt = buildAntigravityImplementationPrompt(run, location, checkedAuthorization)
  const promptHash = sha256Text(prompt)
  const startedAt = timestamp(options)
  const nextAttempt = run.attempts.implementation + 1
  const attemptRun = await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "implementation_in_progress",
    actor: ANTIGRAVITY_EXECUTION_ADAPTER_ID,
    reason: "software-factory-antigravity-execution-started",
    incrementAttempt: true,
    evidence: [executionEvidence(run, location, checkedAuthorization, {
      sha: expectedStartSha,
      attempt: nextAttempt,
      promptHash,
      startedAt,
      outcome: "execution_started"
    })]
  }, options)

  let verified

  try {
    await invokeAntigravity(agyPath, location.workspacePath, prompt, env)

    const sourceAfterExecution = await gitFacts(gitPath, sourceReal, env)
    if (!sameSourceFacts(sourceBefore, sourceAfterExecution)) {
      throw executionError(
        "ANTIGRAVITY_SOURCE_CHANGED",
        "Antigravity execution modified the protected source repository.",
        "source_changed"
      )
    }

    verified = await commitWorkspace(
      gitPath,
      location.workspacePath,
      expectedStartSha,
      env
    )

    const sourceAfterCommit = await gitFacts(gitPath, sourceReal, env)
    if (!sameSourceFacts(sourceBefore, sourceAfterCommit)) {
      throw executionError(
        "ANTIGRAVITY_SOURCE_CHANGED",
        "Protected source repository changed during PPO preservation.",
        "source_changed"
      )
    }
  } catch (error) {
    const failureClass = error?.failureClass || "runtime"
    let cleanupError = null

    try {
      await restoreWorkspace(gitPath, location.workspacePath, expectedStartSha, env)
    } catch (restoreError) {
      cleanupError = restoreError
    }

    let sourceChanged = failureClass === "source_changed"
    try {
      const sourceAfterFailure = await gitFacts(gitPath, sourceReal, env)
      sourceChanged = sourceChanged || !sameSourceFacts(sourceBefore, sourceAfterFailure)
    } catch {
      sourceChanged = true
    }

    const finalFailureClass = sourceChanged ? "source_changed" : failureClass
    const endedAt = timestamp(options)

    try {
      await recordDevelopmentRunProgress(attemptRun.runId, {
        expectedVersion: attemptRun.version,
        status: "implementation_in_progress",
        actor: ANTIGRAVITY_EXECUTION_ADAPTER_ID,
        reason: "software-factory-antigravity-execution-failed",
        evidence: [executionEvidence(attemptRun, location, checkedAuthorization, {
          sha: expectedStartSha,
          attempt: attemptRun.attempts.implementation,
          promptHash,
          startedAt,
          endedAt,
          outcome: "execution_failed",
          failureClass: finalFailureClass
        })]
      }, options)
    } catch {
      throw executionError(
        "ANTIGRAVITY_RECONCILIATION_REQUIRED",
        "Antigravity execution outcome could not be recorded safely; reconcile the run before retrying.",
        "workspace_invalid"
      )
    }

    if (cleanupError) {
      throw cleanupError
    }

    if (sourceChanged) {
      throw executionError(
        "ANTIGRAVITY_SOURCE_CHANGED",
        "Antigravity execution changed or made the protected source repository unverifiable.",
        "source_changed"
      )
    }

    throw error
  }

  const endedAt = timestamp(options)
  const transitioned = await transitionDevelopmentRun(attemptRun.runId, {
    expectedVersion: attemptRun.version,
    status: "implementation_ready",
    branch: location.branch,
    headSha: verified.headSha,
    actor: ANTIGRAVITY_EXECUTION_ADAPTER_ID,
    reason: "software-factory-antigravity-implementation-ready",
    evidence: [executionEvidence(attemptRun, location, checkedAuthorization, {
      sha: verified.headSha,
      attempt: attemptRun.attempts.implementation,
      promptHash,
      startedAt,
      endedAt,
      outcome: "implementation_ready",
      changedFileCount: verified.changedFileCount
    })]
  }, options)

  return {
    ok: true,
    outcome: "implementation_ready",
    run: transitioned,
    implementation: {
      workerId: "antigravity",
      capability: checkedAuthorization.capability,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef,
      headSha: verified.headSha,
      changedFileCount: verified.changedFileCount,
      attempt: transitioned.attempts.implementation
    }
  }
}

async function recoverOrphanedInternal(runId, options = {}) {
  const expectedVersion = options.expectedVersion
  const expectedHeadSha = normalizeSha(options.expectedHeadSha, "Expected implementation head SHA")
  const expectedAttempt = options.expectedAttempt

  if (!Number.isInteger(expectedVersion) || !Number.isInteger(expectedAttempt) || expectedAttempt <= 0) {
    throw executionError(
      "ANTIGRAVITY_ORPHAN_RECOVERY_TARGET_REQUIRED",
      "Antigravity orphan recovery requires the exact run version, head SHA, and implementation attempt.",
      "configuration"
    )
  }

  const run = await readDevelopmentRun(runId, options)
  if (
    run.version !== expectedVersion ||
    run.status !== "implementation_in_progress" ||
    normalizeSha(run.headSha || run.baseSha, "Run implementation head SHA") !== expectedHeadSha ||
    run.attempts.implementation !== expectedAttempt ||
    classifyAntigravityExecutionAttemptEvidence(run) !== "open"
  ) {
    throw executionError(
      "ANTIGRAVITY_ORPHAN_RECOVERY_STATE_MISMATCH",
      "Antigravity orphan recovery target no longer matches the open implementation attempt.",
      "workspace_invalid"
    )
  }

  const location = await resolveImplementationWorkspaceLocation(run, options)
  const platform = options.platform || process.platform
  const gitPath = await validateGitExecutable(fixedGitPath(platform))
  const configuredHome = process.env.HOME

  if (typeof configuredHome !== "string" || !configuredHome.trim() || !isAbsolute(configuredHome)) {
    throw executionError(
      "ANTIGRAVITY_HOME_INVALID",
      "Antigravity home directory is unavailable.",
      "configuration"
    )
  }

  const homePath = resolvePath(configuredHome)
  const env = sanitizedEnv(homePath, ANTIGRAVITY_REVIEWED_EXECUTABLE_PATHS[platform]?.[0] || dirname(gitPath), gitPath)
  const sourcePath = options.workspaceRegistry?.[run.project.id]?.sourceRepoPath

  if (!sourcePath) {
    throw executionError(
      "ANTIGRAVITY_SOURCE_REGISTRY_REQUIRED",
      "Project source repository path is required for orphan recovery.",
      "configuration"
    )
  }

  const sourceReal = await realpath(sourcePath).catch(() => null)
  const workspaceReal = await realpath(location.workspacePath).catch(() => null)

  if (sourceReal !== sourcePath || workspaceReal !== location.workspacePath) {
    throw executionError(
      "ANTIGRAVITY_ORPHAN_RECOVERY_UNTRUSTED",
      "Antigravity orphan recovery paths are unavailable or non-canonical.",
      "workspace_trust"
    )
  }

  const sourceFacts = await gitFacts(gitPath, sourceReal, env)
  if (sourceFacts.headSha !== expectedHeadSha || sourceFacts.statusText) {
    throw executionError(
      "ANTIGRAVITY_RECONCILIATION_REQUIRED",
      "Protected source repository changed or is not clean; owner reconciliation is required.",
      "source_changed"
    )
  }

  await restoreWorkspace(gitPath, location.workspacePath, expectedHeadSha, env)

  const started = antigravityAttemptEvidence(run).find(
    (entry) => entry?.metadata?.outcome === "execution_started"
  )
  const endedAt = timestamp(options)
  const recovered = await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "implementation_in_progress",
    actor: ANTIGRAVITY_EXECUTION_ADAPTER_ID,
    reason: "software-factory-antigravity-orphan-recovered",
    evidence: [executionEvidence(run, location, {
      capability: started?.metadata?.capability || "implementation.backend",
      modelClass: started?.metadata?.modelClass || "standard",
      checkpointVersion: started?.metadata?.checkpointVersion || 0
    }, {
      sha: expectedHeadSha,
      attempt: expectedAttempt,
      promptHash: started?.metadata?.promptHash || "0".repeat(64),
      startedAt: started?.metadata?.startedAt || endedAt,
      endedAt,
      outcome: "execution_failed",
      failureClass: "runtime"
    })]
  }, options)

  return {
    ok: true,
    outcome: "antigravity_orphan_recovered_for_retry",
    run: recovered,
    recovery: {
      disposition: "retry",
      attempt: expectedAttempt,
      headSha: expectedHeadSha
    }
  }
}

export async function recoverOrphanedAntigravityExecution(runId, options = {}) {
  try {
    return await recoverOrphanedInternal(runId, options)
  } catch (error) {
    throw safeFailure(error)
  }
}


export async function executeAntigravityImplementation(runId, authorization, options = {}) {
  try {
    return await executeInternal(runId, authorization, options)
  } catch (error) {
    throw safeFailure(error)
  }
}

export function formatSoftwareFactoryAntigravityExecutionError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO Antigravity execution error [${error.code}]: ${error.safeMessage}`
  }
  return "PPO Antigravity execution error: unexpected local failure."
}
