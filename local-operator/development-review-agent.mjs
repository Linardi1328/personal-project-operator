import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { createServer } from "node:net"
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  REVIEW_ORPHAN_RECOVERY_ACTOR,
  readDevelopmentRun,
  recordDevelopmentRunProgress,
  resolveDevelopmentRunProject,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"
import {
  MAX_REVIEW_FINDING_CHARS,
  MAX_REVIEW_FINDINGS
} from "./development-review-findings-contract.mjs"

const execFileAsync = promisify(execFile)

export const INDEPENDENT_REVIEW_AGENT_ID = "phase-6f-independent-review-agent"
export const REMOTE_PR_REVIEW_AGENT_ID = "phase-6g-remote-pr-review-agent"
export const INDEPENDENT_REVIEW_SANDBOX_ID = "phase-6f-no-outbound-network-review-sandbox"
export const PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE = "phase-6d-codex-execution-adapter"
export const PHASE_6E_TEST_EVIDENCE_SOURCE = "phase-6e-automated-test-runner"
export const REVIEW_FINDINGS_EVIDENCE_OUTCOME = "review_findings"
export const MAX_INDEPENDENT_REVIEW_ATTEMPTS = 5
export const MAX_REVIEW_ARG_COUNT = 16
export const MAX_REVIEW_ARG_CHARS = 160
export const MAX_REVIEW_ENV_KEYS = 16
export const MAX_REVIEW_ENV_VALUE_CHARS = 1000
export const MAX_REVIEW_PROMPT_CHARS = 6000
export const MAX_REVIEW_OUTPUT_BYTES = 32 * 1024
export const MAX_REVIEW_STDERR_BYTES = 256 * 1024
export const MAX_REVIEW_TIMEOUT_MS = 10 * 60 * 1000
export const MIN_REVIEW_TIMEOUT_MS = 1000
export const MAX_REVIEW_GIT_OUTPUT_BYTES = 32 * 1024
export { MAX_REVIEW_FINDING_CHARS, MAX_REVIEW_FINDINGS }
export const REVIEW_SANDBOX_BACKENDS = Object.freeze({
  MACOS_SANDBOX_EXEC: "macos-sandbox-exec",
  CODEX_NATIVE_DARWIN: "codex-native-darwin",
  LINUX_NETWORK_NAMESPACE: "linux-network-namespace",
  CODEX_NATIVE_LINUX: "codex-native-linux"
})
export const REVIEW_DECISIONS = Object.freeze({
  APPROVED: "APPROVED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  OWNER_ACTION_REQUIRED: "OWNER_ACTION_REQUIRED"
})

const shaPattern = /^[a-f0-9]{40}$/u
const envKeyPattern = /^[A-Z_][A-Z0-9_]{0,39}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const unsafeMultilineOutputPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const forbiddenEnvKeyPattern = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|CONFIRM|ASKPASS|GIT_CONFIG|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_SSH|SSH_AUTH_SOCK|HOME|NETRC|NPM|AWS|GOOGLE|GCLOUD|AZURE|DOCKER|KUBE|OPENAI|ANTHROPIC|NODE_OPTIONS)/u
const forbiddenExecutableNames = new Set([
  "bash",
  "codex",
  "docker",
  "env",
  "fish",
  "gh",
  "git",
  "kubectl",
  "make",
  "npm",
  "npx",
  "openclaw",
  "pnpm",
  "powershell",
  "rsync",
  "scp",
  "service",
  "sh",
  "ssh",
  "systemctl",
  "yarn",
  "zsh"
])
const defaultExecutionPath = "/usr/bin:/bin:/usr/sbin:/sbin"
const readOnlyWorkspaceMode = "trusted-read-only-workspace"
const linuxReadOnlyWorkspaceMode = "trusted-read-only-mount-namespace"
const sandboxRequiredMessage = "Independent review requires a trusted no-outbound-network and read-only-workspace process sandbox."

export class DevelopmentReviewAgentError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentReviewAgentError"
  }
}

function reviewError(code, safeMessage) {
  return new DevelopmentReviewAgentError(code, safeMessage)
}

function safeReviewFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return reviewError(
    "REVIEW_AGENT_UNAVAILABLE",
    "Independent review agent is unavailable; no raw failure was stored."
  )
}

function rejectUnsafeText(value, code, safeMessage) {
  if (unsafeControlPattern.test(value) || sensitiveTextPattern.test(value)) {
    throw reviewError(code, safeMessage)
  }
}

function normalizeSafeText(value, {
  code,
  safeMessage,
  maxChars,
  required = true
}) {
  if (value === null || value === undefined) {
    if (required) {
      throw reviewError(code, safeMessage)
    }

    return null
  }

  const normalized = String(value).trim()

  if ((required && !normalized) || normalized.length > maxChars || unsafeControlPattern.test(normalized)) {
    throw reviewError(code, safeMessage)
  }

  rejectUnsafeText(normalized, code, safeMessage)
  return normalized
}

function normalizeSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw reviewError(
      "REVIEW_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw reviewError(
      "REVIEW_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required."
    )
  }

  return value
}

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date()
  }

  return date
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString()
  }

  return date.toISOString()
}

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

function stableHash(value) {
  return sha256Text(stableStringify(value))
}

function normalizeExecutablePath(value, code = "REVIEW_CONFIG_INVALID") {
  const executablePath = normalizeSafeText(value, {
    code,
    safeMessage: "Trusted reviewer executable configuration is invalid.",
    maxChars: 240
  })

  if (!isAbsolute(executablePath) || executablePath !== resolvePath(executablePath)) {
    throw reviewError(
      code,
      "Trusted reviewer executable configuration is invalid."
    )
  }

  const executableName = executablePath.split("/").at(-1)

  if (forbiddenExecutableNames.has(executableName)) {
    throw reviewError(
      code,
      "Trusted reviewer executable configuration is invalid."
    )
  }

  return executablePath
}

function normalizeSandboxPath(value) {
  const sandboxPath = normalizeSafeText(value, {
    code: "REVIEW_SANDBOX_REQUIRED",
    safeMessage: sandboxRequiredMessage,
    maxChars: 240
  })

  if (!isAbsolute(sandboxPath) || sandboxPath !== resolvePath(sandboxPath)) {
    throw reviewError(
      "REVIEW_SANDBOX_REQUIRED",
      sandboxRequiredMessage
    )
  }

  return sandboxPath
}

function normalizeSandboxPositiveInteger(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) {
    throw reviewError(
      "REVIEW_SANDBOX_REQUIRED",
      sandboxRequiredMessage
    )
  }

  return value
}

function requireSandboxTrue(value) {
  if (value !== true) {
    throw reviewError(
      "REVIEW_SANDBOX_REQUIRED",
      sandboxRequiredMessage
    )
  }

  return true
}

function normalizeExecutionSandbox(sandbox) {
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) {
    throw reviewError(
      "REVIEW_SANDBOX_REQUIRED",
      sandboxRequiredMessage
    )
  }

  const type = normalizeSafeText(sandbox.type, {
    code: "REVIEW_SANDBOX_REQUIRED",
    safeMessage: sandboxRequiredMessage,
    maxChars: 80
  })
  const network = normalizeSafeText(sandbox.network, {
    code: "REVIEW_SANDBOX_REQUIRED",
    safeMessage: sandboxRequiredMessage,
    maxChars: 40
  })
  const enforcement = normalizeSafeText(sandbox.enforcement, {
    code: "REVIEW_SANDBOX_REQUIRED",
    safeMessage: sandboxRequiredMessage,
    maxChars: 80
  })
  const platform = normalizeSafeText(sandbox.platform, {
    code: "REVIEW_SANDBOX_REQUIRED",
    safeMessage: sandboxRequiredMessage,
    maxChars: 20
  })

  if (network !== "none") {
    throw reviewError(
      "REVIEW_SANDBOX_REQUIRED",
      sandboxRequiredMessage
    )
  }

  const readOnlyWorkspace = requireSandboxTrue(sandbox.readOnlyWorkspace)
  const readOnlyMode = normalizeSafeText(sandbox.readOnlyWorkspaceMode, {
    code: "REVIEW_SANDBOX_REQUIRED",
    safeMessage: sandboxRequiredMessage,
    maxChars: 80
  })

  if (type === REVIEW_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC) {
    if (platform !== "darwin" || enforcement !== "os-process" || readOnlyMode !== readOnlyWorkspaceMode) {
      throw reviewError(
        "REVIEW_SANDBOX_REQUIRED",
        sandboxRequiredMessage
      )
    }

    return {
      type,
      backend: REVIEW_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
      platform,
      network,
      enforcement,
      readOnlyWorkspace,
      readOnlyWorkspaceMode: readOnlyMode,
      executablePath: normalizeSandboxPath(sandbox.executablePath)
    }
  }

  if (type === REVIEW_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE) {
    if (platform !== "linux" || enforcement !== "os-network-namespace" || readOnlyMode !== linuxReadOnlyWorkspaceMode) {
      throw reviewError(
        "REVIEW_SANDBOX_REQUIRED",
        sandboxRequiredMessage
      )
    }

    return {
      type,
      backend: REVIEW_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
      platform,
      network,
      enforcement,
      readOnlyWorkspace,
      readOnlyWorkspaceMode: readOnlyMode,
      executablePath: normalizeSandboxPath(sandbox.executablePath),
      readOnlyWorkspaceWrapperPath: normalizeSandboxPath(sandbox.readOnlyWorkspaceWrapperPath),
      namespacePath: normalizeSandboxPath(sandbox.namespacePath),
      setprivPath: normalizeSandboxPath(sandbox.setprivPath),
      runAsUid: normalizeSandboxPositiveInteger(sandbox.runAsUid),
      runAsGid: normalizeSandboxPositiveInteger(sandbox.runAsGid),
      requireNoNewPrivileges: requireSandboxTrue(sandbox.requireNoNewPrivileges),
      dropCapabilities: requireSandboxTrue(sandbox.dropCapabilities)
    }
  }

  if (
    type === REVIEW_SANDBOX_BACKENDS.CODEX_NATIVE_DARWIN ||
    type === REVIEW_SANDBOX_BACKENDS.CODEX_NATIVE_LINUX
  ) {
    const expectedPlatform = type === REVIEW_SANDBOX_BACKENDS.CODEX_NATIVE_DARWIN
      ? "darwin"
      : "linux"

    if (
      platform !== expectedPlatform ||
      enforcement !== "codex-command-sandbox" ||
      sandbox.readOnlyWorkspace !== true ||
      sandbox.readOnlyWorkspaceMode !== "codex-native-read-only"
    ) {
      throw reviewError(
        "REVIEW_SANDBOX_REQUIRED",
        sandboxRequiredMessage
      )
    }

    const permissionProfile = normalizeSafeText(sandbox.permissionProfile, {
      code: "REVIEW_SANDBOX_REQUIRED",
      safeMessage: sandboxRequiredMessage,
      maxChars: 40
    })

    if (permissionProfile !== ":read-only") {
      throw reviewError(
        "REVIEW_SANDBOX_REQUIRED",
        sandboxRequiredMessage
      )
    }

    return {
      type,
      backend: type,
      platform,
      network,
      enforcement,
      readOnlyWorkspace: true,
      readOnlyWorkspaceMode: "codex-native-read-only",
      executablePath: normalizeSandboxPath(sandbox.executablePath),
      permissionProfile
    }
  }

  throw reviewError(
    "REVIEW_SANDBOX_REQUIRED",
    sandboxRequiredMessage
  )
}

function normalizeReviewArgs(args = []) {
  if (!Array.isArray(args) || args.length > MAX_REVIEW_ARG_COUNT) {
    throw reviewError(
      "REVIEW_CONFIG_INVALID",
      "Reviewer argv configuration is invalid."
    )
  }

  return args.map((entry) => normalizeSafeText(entry, {
    code: "REVIEW_CONFIG_INVALID",
    safeMessage: "Reviewer argv configuration is invalid.",
    maxChars: MAX_REVIEW_ARG_CHARS
  }))
}

function normalizeReviewEnv(env = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw reviewError(
      "REVIEW_CONFIG_INVALID",
      "Reviewer environment configuration is invalid."
    )
  }

  const entries = Object.entries(env)

  if (entries.length > MAX_REVIEW_ENV_KEYS) {
    throw reviewError(
      "REVIEW_CONFIG_INVALID",
      "Reviewer environment configuration is invalid."
    )
  }

  const normalized = {
    PATH: defaultExecutionPath,
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    SSH_ASKPASS: "false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1"
  }

  for (const [key, value] of entries) {
    if (!envKeyPattern.test(key) || forbiddenEnvKeyPattern.test(key)) {
      throw reviewError(
        "REVIEW_CONFIG_INVALID",
        "Reviewer environment configuration is invalid."
      )
    }

    normalized[key] = normalizeSafeText(value, {
      code: "REVIEW_CONFIG_INVALID",
      safeMessage: "Reviewer environment configuration is invalid.",
      maxChars: MAX_REVIEW_ENV_VALUE_CHARS,
      required: false
    }) || ""
  }

  return normalized
}

function normalizeTimeoutMs(value) {
  const timeoutMs = value === undefined ? MAX_REVIEW_TIMEOUT_MS : value

  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_REVIEW_TIMEOUT_MS || timeoutMs > MAX_REVIEW_TIMEOUT_MS) {
    throw reviewError(
      "REVIEW_CONFIG_INVALID",
      "Reviewer timeout configuration is invalid."
    )
  }

  return timeoutMs
}

function normalizeOutputBytes(value) {
  const outputBytes = value === undefined ? MAX_REVIEW_OUTPUT_BYTES : value

  if (!Number.isInteger(outputBytes) || outputBytes <= 0 || outputBytes > MAX_REVIEW_OUTPUT_BYTES) {
    throw reviewError(
      "REVIEW_CONFIG_INVALID",
      "Reviewer output limit configuration is invalid."
    )
  }

  return outputBytes
}

function normalizeStderrBytes(value) {
  const stderrBytes = value === undefined ? MAX_REVIEW_STDERR_BYTES : value

  if (!Number.isInteger(stderrBytes) || stderrBytes <= 0 || stderrBytes > MAX_REVIEW_STDERR_BYTES) {
    throw reviewError(
      "REVIEW_CONFIG_INVALID",
      "Reviewer stderr limit configuration is invalid."
    )
  }

  return stderrBytes
}

function normalizeReviewConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw reviewError(
      "REVIEW_CONFIG_REQUIRED",
      "Trusted local reviewer configuration is required."
    )
  }

  if (Object.hasOwn(config, "command") || Object.hasOwn(config, "cmd") || config.shell === true) {
    throw reviewError(
      "REVIEW_CONFIG_INVALID",
      "Reviewer must use explicit executable argv with shell disabled."
    )
  }

  if (Object.hasOwn(config, "shell") && config.shell !== false) {
    throw reviewError(
      "REVIEW_CONFIG_INVALID",
      "Reviewer must use explicit executable argv with shell disabled."
    )
  }

  return {
    executablePath: normalizeExecutablePath(config.executablePath),
    args: normalizeReviewArgs(config.args || []),
    env: normalizeReviewEnv(config.env || {}),
    timeoutMs: normalizeTimeoutMs(config.timeoutMs),
    maxOutputBytes: normalizeOutputBytes(config.maxOutputBytes),
    maxStderrBytes: normalizeStderrBytes(config.maxStderrBytes),
    sandbox: normalizeExecutionSandbox(config.sandbox)
  }
}

function isUncertainExecutionOutcome(value) {
  return (
    value?.ambiguous === true ||
    value?.uncertain === true ||
    value?.interrupted === true ||
    value?.timedOut === true ||
    value?.killed === true ||
    value?.outputOverflow === true ||
    typeof value?.signal === "string" ||
    value?.code === "ETIMEDOUT" ||
    value?.code === "ABORT_ERR" ||
    value?.code === "ENOBUFS" ||
    value?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  )
}

function ambiguityClassification(value = {}, maxOutputBytes = MAX_REVIEW_OUTPUT_BYTES) {
  const stdoutOverflow = (
    value?.stdoutOverflow === true ||
    Buffer.byteLength(String(value?.stdout ?? ""), "utf8") > maxOutputBytes
  )
  const stderrOverflow = value?.stderrOverflow === true
  const outputOverflow = value?.outputOverflow === true || stdoutOverflow || stderrOverflow
  const timedOut = value?.timedOut === true || value?.code === "ETIMEDOUT"
  const signal = typeof value?.signal === "string" && value.signal.length <= 20
    ? value.signal
    : null
  const killed = value?.killed === true || timedOut || outputOverflow || signal !== null
  const failureClass = timedOut
    ? "timeout"
    : stderrOverflow
      ? "stderr_overflow"
      : stdoutOverflow
        ? "stdout_overflow"
        : outputOverflow
          ? "output_overflow"
          : signal !== null
            ? "signal"
            : "uncertain"

  return {
    failureClass,
    timedOut,
    killed,
    outputOverflow,
    stdoutOverflow,
    stderrOverflow,
    signal
  }
}

function ambiguousReviewError(details = {}) {
  const error = reviewError(
    "REVIEW_EXECUTION_AMBIGUOUS",
    "Independent review execution outcome is ambiguous; reconcile workspace state before retrying."
  )
  error.ambiguous = true
  error.ambiguity = ambiguityClassification(details)
  return error
}

function sandboxError() {
  return reviewError(
    "REVIEW_SANDBOX_UNAVAILABLE",
    "Independent review no-outbound-network and read-only-workspace process sandbox could not be established."
  )
}

function assertSandboxRuntimePlatform(sandbox, options = {}) {
  if (options.reviewRunner) {
    return
  }

  const currentPlatform = options.platform || process.platform

  if (sandbox.platform !== currentPlatform) {
    throw sandboxError()
  }
}

function sandboxProfileString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")
}

function normalizeReadOnlyWorkspacePath(value) {
  const workspacePath = normalizeSafeText(value, {
    code: "REVIEW_SANDBOX_UNAVAILABLE",
    safeMessage: "Independent review no-outbound-network and read-only-workspace process sandbox could not be established.",
    maxChars: 500
  })

  if (!isAbsolute(workspacePath) || workspacePath !== resolvePath(workspacePath)) {
    throw sandboxError()
  }

  return workspacePath
}

function macosReviewSandboxProfile(workspacePath) {
  const readOnlyPaths = normalizeReadOnlyPaths(workspacePath)
    .map((entry) => `(deny file-write* (subpath "${sandboxProfileString(entry)}"))`)
    .join("\n")

  return `(version 1)
(allow default)
(deny network*)
${readOnlyPaths}
`
}

function normalizeReadOnlyPaths(value) {
  const paths = Array.isArray(value) ? value : [value]
  const normalized = []

  if (paths.length < 1 || paths.length > 4) {
    throw sandboxError()
  }

  for (const entry of paths) {
    const workspacePath = normalizeReadOnlyWorkspacePath(entry)

    if (!normalized.includes(workspacePath)) {
      normalized.push(workspacePath)
    }
  }

  return normalized
}

function linuxReadOnlyPathArgs(paths) {
  return normalizeReadOnlyPaths(paths).flatMap((entry) => [
    "--read-only-path",
    entry
  ])
}

function sandboxedCommand(sandbox, executablePath, args, options = {}) {
  assertSandboxRuntimePlatform(sandbox, options)
  const readOnlyPaths = normalizeReadOnlyPaths(options.readOnlyPaths || options.readOnlyWorkspacePath)

  if (codexNativeCommandSandbox(sandbox)) {
    if (options.kind === "review") {
      return {
        backend: sandbox.backend,
        executablePath,
        args: [...args]
      }
    }

    const cwd = normalizeReadOnlyWorkspacePath(options.cwd)
    return {
      backend: sandbox.backend,
      executablePath: sandbox.executablePath,
      args: [
        "sandbox",
        "--permission-profile",
        sandbox.permissionProfile,
        "--cd",
        cwd,
        "--",
        executablePath,
        ...args
      ]
    }
  }

  if (sandbox.type === REVIEW_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC) {
    return {
      backend: sandbox.backend,
      executablePath: sandbox.executablePath,
      args: [
        "-p",
        macosReviewSandboxProfile(readOnlyPaths),
        executablePath,
        ...args
      ]
    }
  }

  if (sandbox.type === REVIEW_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE) {
    return {
      backend: sandbox.backend,
      executablePath: sandbox.executablePath,
      args: [
        `--net=${sandbox.namespacePath}`,
        sandbox.readOnlyWorkspaceWrapperPath,
        ...linuxReadOnlyPathArgs(readOnlyPaths),
        "--",
        sandbox.setprivPath,
        "--no-new-privs",
        `--reuid=${sandbox.runAsUid}`,
        `--regid=${sandbox.runAsGid}`,
        "--clear-groups",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        executablePath,
        ...args
      ]
    }
  }

  throw sandboxError()
}

export async function runSandboxedProcess(invocation) {
  const command = invocation.sandboxCommand || sandboxedCommand(
    invocation.sandbox,
    invocation.executablePath,
    invocation.args,
    { readOnlyPaths: invocation.readOnlyPaths || [invocation.cwd] }
  )

  return await new Promise((resolve, reject) => {
    const child = spawn(command.executablePath, command.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    })

    let stdout = ""
    let stderrBytes = 0
    let stdoutBytes = 0
    let killed = false
    let timedOut = false
    let outputOverflow = false
    let stdoutOverflow = false
    let stderrOverflow = false
    let settled = false
    const outputLimit = invocation.maxOutputBytes
    const stderrLimit = invocation.maxStderrBytes ?? outputLimit
    const timeoutHandle = setTimeout(() => {
      timedOut = true
      killed = true
      child.kill("SIGTERM")
    }, invocation.timeoutMs)

    const settle = (callback, value) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutHandle)
      callback(value)
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length

      if (stdoutBytes > outputLimit) {
        outputOverflow = true
        stdoutOverflow = true
        killed = true
        child.kill("SIGTERM")
        return
      }

      stdout += chunk.toString("utf8")
    })

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length

      if (stderrBytes > stderrLimit) {
        outputOverflow = true
        stderrOverflow = true
        killed = true
        child.kill("SIGTERM")
      }
    })

    child.on("error", (error) => {
      settle(reject, error)
    })

    child.stdin.on("error", (error) => {
      if (error?.code === "EPIPE") {
        return
      }

      settle(reject, error)
    })

    child.on("close", (exitCode, signal) => {
      settle(resolve, {
        exitCode,
        signal,
        killed,
        timedOut,
        outputOverflow,
        stdoutOverflow,
        stderrOverflow,
        ambiguous: killed || timedOut || outputOverflow || typeof signal === "string",
        stdout
      })
    })

    child.stdin.end(invocation.stdin || "", "utf8")
  })
}

async function runSandboxedCommand(invocation, options = {}) {
  const runner = options.reviewRunner || runSandboxedProcess

  try {
    const command = sandboxedCommand(invocation.sandbox, invocation.executablePath, invocation.args, {
      ...options,
      readOnlyPaths: invocation.readOnlyPaths || [invocation.cwd],
      kind: invocation.kind,
      cwd: invocation.cwd
    })

    return await runner({
      ...invocation,
      sandboxCommand: command,
      sandboxExecutablePath: command.executablePath,
      sandboxArgs: [...command.args],
      shell: false
    })
  } catch (error) {
    if (isUncertainExecutionOutcome(error)) {
      throw ambiguousReviewError(error)
    }

    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    if (invocation.kind === "review") {
      throw reviewError(
        "REVIEW_EXECUTION_FAILED",
        "Independent review failed before a verified decision was produced."
      )
    }

    throw sandboxError()
  }
}

async function withLoopbackProbeServer(callback, options = {}) {
  if (options.reviewRunner) {
    return await callback({
      port: 1,
      connectionCount: () => 0
    })
  }

  let connections = 0
  const server = createServer((socket) => {
    connections += 1
    socket.destroy()
  })

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch {
    throw sandboxError()
  }

  try {
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : null

    if (!Number.isInteger(port)) {
      throw sandboxError()
    }

    return await callback({
      port,
      connectionCount: () => connections
    })
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve())
    })
  }
}

function assertSandboxProbeResult(result) {
  if (isUncertainExecutionOutcome(result) || result?.exitCode === 71) {
    throw sandboxError()
  }
}

function linuxNetworkNamespaceSandbox(sandbox) {
  return sandbox.type === REVIEW_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE
}

function codexNativeLinuxSandbox(sandbox) {
  return sandbox.type === REVIEW_SANDBOX_BACKENDS.CODEX_NATIVE_LINUX
}

function codexNativeDarwinSandbox(sandbox) {
  return sandbox.type === REVIEW_SANDBOX_BACKENDS.CODEX_NATIVE_DARWIN
}

function codexNativeCommandSandbox(sandbox) {
  return codexNativeDarwinSandbox(sandbox) || codexNativeLinuxSandbox(sandbox)
}

async function assertSandboxLinuxPrivilegeBoundary(config, location, readOnlyPaths, options) {
  if (!linuxNetworkNamespaceSandbox(config.sandbox)) {
    return
  }

  const probeCode = [
    "const fs = require('node:fs')",
    "const status = fs.readFileSync('/proc/self/status', 'utf8')",
    "const uid = typeof process.getuid === 'function' ? process.getuid() : 0",
    "const cap = status.match(/^CapEff:\\s*([0-9a-fA-F]+)$/m)",
    "const nnp = status.match(/^NoNewPrivs:\\s*(\\d+)$/m)",
    "if (uid === 0) process.exit(70)",
    "if (!cap || !/^0+$/u.test(cap[1])) process.exit(69)",
    "if (!nnp || nnp[1] !== '1') process.exit(68)",
    "process.exit(0)"
  ].join(";")

  const result = await runSandboxedCommand({
    kind: "sandbox-probe",
    probe: "linux-privilege-boundary",
    sandbox: config.sandbox,
    executablePath: process.execPath,
    args: ["--eval", probeCode],
    cwd: location.workspacePath,
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: config.env,
    readOnlyPaths
  }, options)

  assertSandboxProbeResult(result)

  if (result?.exitCode !== 0) {
    throw sandboxError()
  }
}

async function assertSandboxProcessAllowed(config, location, readOnlyPaths, options) {
  const result = await runSandboxedCommand({
    kind: "sandbox-probe",
    probe: "local-process",
    sandbox: config.sandbox,
    executablePath: process.execPath,
    args: ["--eval", "process.exit(0)"],
    cwd: location.workspacePath,
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: config.env,
    readOnlyPaths
  }, options)

  assertSandboxProbeResult(result)

  if (result?.exitCode !== 0) {
    throw sandboxError()
  }
}

async function assertSandboxWorkspaceReadAllowed(config, location, readOnlyPaths, options) {
  const probeCode = [
    "const fs = require('node:fs')",
    "try { fs.readdirSync(process.cwd()); process.exit(0) } catch { process.exit(72) }"
  ].join(";")

  const result = await runSandboxedCommand({
    kind: "sandbox-probe",
    probe: "workspace-read",
    sandbox: config.sandbox,
    executablePath: process.execPath,
    args: ["--eval", probeCode],
    cwd: location.workspacePath,
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: config.env,
    readOnlyPaths
  }, options)

  assertSandboxProbeResult(result)

  if (result?.exitCode !== 0) {
    throw sandboxError()
  }
}

function assertSandboxWriteProbeDenied(result) {
  assertSandboxProbeResult(result)

  if (result?.sandboxDenied === true || result?.exitCode === 0) {
    return
  }

  throw sandboxError()
}

async function assertSandboxWorkspaceFileWriteDenied(config, location, readOnlyPaths, options) {
  const probeCode = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const target = path.join(process.cwd(), `.ppo-review-readonly-probe-${process.pid}`)",
    "try { fs.writeFileSync(target, 'probe', { flag: 'wx' }); try { fs.unlinkSync(target) } catch {}; process.exit(70) } catch (error) { process.exit(error && ['EACCES','EPERM','EROFS'].includes(error.code) ? 0 : 71) }"
  ].join(";")

  const result = await runSandboxedCommand({
    kind: "sandbox-probe",
    probe: "workspace-file-write",
    sandbox: config.sandbox,
    executablePath: process.execPath,
    args: ["--eval", probeCode],
    cwd: location.workspacePath,
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: config.env,
    readOnlyPaths
  }, options)

  assertSandboxWriteProbeDenied(result)
}

async function assertSandboxSourceFileWriteDenied(config, location, readOnlyPaths, options) {
  const probeCode = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const target = path.join(process.cwd(), `.ppo-review-source-readonly-probe-${process.pid}`)",
    "try { fs.writeFileSync(target, 'probe', { flag: 'wx' }); try { fs.unlinkSync(target) } catch {}; process.exit(70) } catch (error) { process.exit(error && ['EACCES','EPERM','EROFS'].includes(error.code) ? 0 : 71) }"
  ].join(";")

  const result = await runSandboxedCommand({
    kind: "sandbox-probe",
    probe: "source-file-write",
    sandbox: config.sandbox,
    executablePath: process.execPath,
    args: ["--eval", probeCode],
    cwd: location.sourceRepoPath,
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: config.env,
    readOnlyPaths
  }, options)

  assertSandboxWriteProbeDenied(result)
}

async function assertSandboxWorkspaceGitMutationDenied(config, location, readOnlyPaths, options) {
  const probeCode = [
    "const { execFileSync } = require('node:child_process')",
    "try { execFileSync('git', ['commit', '--allow-empty', '-m', 'ppo-review-readonly-probe'], { cwd: process.cwd(), stdio: 'ignore', timeout: 3000, env: { ...process.env, GIT_AUTHOR_NAME: 'PPO Review Probe', GIT_AUTHOR_EMAIL: 'ppo-review-probe@example.invalid', GIT_COMMITTER_NAME: 'PPO Review Probe', GIT_COMMITTER_EMAIL: 'ppo-review-probe@example.invalid' } }); process.exit(70) } catch (error) { process.exit(error && Number.isInteger(error.status) ? 0 : 71) }"
  ].join(";")

  const result = await runSandboxedCommand({
    kind: "sandbox-probe",
    probe: "workspace-git-mutation",
    sandbox: config.sandbox,
    executablePath: process.execPath,
    args: ["--eval", probeCode],
    cwd: location.workspacePath,
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: config.env,
    readOnlyPaths
  }, options)

  assertSandboxWriteProbeDenied(result)
}

function isDirectNetworkDenied(config, result, connectionCount) {
  if (result?.sandboxDenied === true) {
    return true
  }

  if (connectionCount !== 0) {
    return false
  }

  if (result?.exitCode === 0) {
    return true
  }

  return (
    linuxNetworkNamespaceSandbox(config.sandbox) ||
    codexNativeCommandSandbox(config.sandbox)
  ) && (
    result?.exitCode === 67 ||
    result?.exitCode === 68
  )
}

async function assertSandboxDirectNetworkDenied(config, location, readOnlyPaths, options) {
  const probeCode = [
    "const net = require('node:net')",
    "const port = Number(process.env.PPO_REVIEW_SANDBOX_PROBE_PORT)",
    "const socket = net.createConnection({ host: '127.0.0.1', port })",
    "const done = (code) => { try { socket.destroy() } catch {} process.exit(code) }",
    "const timer = setTimeout(() => done(68), 1500)",
    "socket.on('connect', () => { clearTimeout(timer); done(66) })",
    "socket.on('error', (error) => { clearTimeout(timer); done(error && (error.code === 'EPERM' || error.code === 'EACCES') ? 0 : 67) })"
  ].join(";")

  await withLoopbackProbeServer(async ({ port, connectionCount }) => {
    const result = await runSandboxedCommand({
      kind: "sandbox-probe",
      probe: "direct-network",
      sandbox: config.sandbox,
      executablePath: process.execPath,
      args: ["--eval", probeCode],
      cwd: location.workspacePath,
      stdin: "",
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      env: {
        ...config.env,
        PPO_REVIEW_SANDBOX_PROBE_PORT: String(port)
      },
      readOnlyPaths
    }, options)

    assertSandboxProbeResult(result)

    if (!isDirectNetworkDenied(config, result, connectionCount())) {
      throw sandboxError()
    }
  }, options)
}

async function assertReviewSandboxActive(config, location, facts, options) {
  const readOnlyPaths = readOnlyPathsForReview(location, facts)

  await assertSandboxLinuxPrivilegeBoundary(config, location, readOnlyPaths, options)
  await assertSandboxProcessAllowed(config, location, readOnlyPaths, options)
  await assertSandboxWorkspaceReadAllowed(config, location, readOnlyPaths, options)
  await assertSandboxWorkspaceFileWriteDenied(config, location, readOnlyPaths, options)
  await assertSandboxSourceFileWriteDenied(config, location, readOnlyPaths, options)
  await assertSandboxWorkspaceGitMutationDenied(config, location, readOnlyPaths, options)
  await assertSandboxDirectNetworkDenied(config, location, readOnlyPaths, options)
}

function assertGitArgs(args) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || !entry)) {
    throw reviewError(
      "REVIEW_GIT_OPERATION_REFUSED",
      "Git verification operation is not approved for the independent review agent."
    )
  }

  const command = args[2]
  const subcommand = args[3]
  const isGitC = args[0] === "-C" && typeof args[1] === "string"
  const branchRef = (value) => typeof value === "string" && value.startsWith("refs/heads/")
  const range = (value) => typeof value === "string" && /^[a-f0-9]{40}\.\.[a-f0-9]{40}$/u.test(value)
  const exactShape = (
    isGitC &&
    (
      (command === "rev-parse" && args.length === 4 && (
        subcommand === "--show-toplevel" ||
        subcommand === "HEAD" ||
        subcommand === "--git-dir" ||
        subcommand === "--git-common-dir" ||
        branchRef(subcommand)
      )) ||
      (command === "symbolic-ref" && args.length === 5 && subcommand === "--short" && args[4] === "HEAD") ||
      (command === "status" && args.length === 5 && subcommand === "--porcelain=v1" && args[4] === "--untracked-files=all") ||
      (command === "rev-list" && args.length === 6 && subcommand === "--ancestry-path" && args[4] === "--count" && range(args[5])) ||
      (command === "diff" && args.length === 5 && subcommand === "--name-only" && range(args[4])) ||
      (command === "diff" && args.length === 5 && subcommand === "--numstat" && range(args[4]))
    )
  )

  if (!exactShape) {
    throw reviewError(
      "REVIEW_GIT_OPERATION_REFUSED",
      "Git verification operation is not approved for the independent review agent."
    )
  }
}

async function runGit(args, options = {}) {
  assertGitArgs(args)

  const runner = options.gitRunner || (async (argv) => {
    const result = await execFileAsync("git", argv, {
      encoding: "utf8",
      maxBuffer: MAX_REVIEW_GIT_OUTPUT_BYTES,
      timeout: 15000,
      shell: false
    })

    return {
      stdout: result.stdout,
      exitCode: 0
    }
  })

  try {
    const result = await runner(args)
    return {
      stdout: String(result?.stdout ?? ""),
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0
    }
  } catch {
    throw reviewError(
      "REVIEW_GIT_VERIFY_FAILED",
      "Git verification failed; no raw Git output was stored."
    )
  }
}

function gitOutputLine(result, code, safeMessage) {
  const output = String(result.stdout ?? "").trim()

  if (!output || output.length > MAX_REVIEW_GIT_OUTPUT_BYTES || /[\u0000-\u001f\u007f]/u.test(output)) {
    throw reviewError(code, safeMessage)
  }

  return output.split(/\r?\n/u)[0].trim()
}

async function gitLine(cwd, args, options, code, safeMessage) {
  try {
    return gitOutputLine(await runGit(["-C", cwd, ...args], options), code, safeMessage)
  } catch (error) {
    if (error?.code === "REVIEW_GIT_VERIFY_FAILED") {
      throw reviewError(code, safeMessage)
    }

    throw error
  }
}

async function gitText(cwd, args, options) {
  const result = await runGit(["-C", cwd, ...args], options)
  const output = String(result.stdout ?? "")

  if (Buffer.byteLength(output, "utf8") > MAX_REVIEW_GIT_OUTPUT_BYTES || unsafeMultilineOutputPattern.test(output)) {
    throw reviewError(
      "REVIEW_GIT_VERIFY_FAILED",
      "Git verification output is invalid."
    )
  }

  return output.trim()
}

async function canonicalGitStatePath(cwd, value) {
  const rawPath = normalizeSafeText(value, {
    code: "REVIEW_WORKSPACE_NOT_READY",
    safeMessage: "Implementation workspace Git state could not be verified for independent review.",
    maxChars: 500
  })
  const absolutePath = isAbsolute(rawPath)
    ? rawPath
    : resolvePath(cwd, rawPath)
  const realPath = await realpath(absolutePath).catch(() => {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Implementation workspace Git state could not be verified for independent review."
    )
  })

  if (!isAbsolute(realPath) || realPath !== resolvePath(realPath)) {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Implementation workspace Git state could not be verified for independent review."
    )
  }

  return realPath
}

async function canonicalSourceRepoPath(location, options) {
  const sourceRepoPath = normalizeSafeText(location.sourceRepoPath, {
    code: "REVIEW_WORKSPACE_NOT_READY",
    safeMessage: "Source repository path could not be verified for independent review.",
    maxChars: 500
  })

  if (!isAbsolute(sourceRepoPath) || sourceRepoPath !== resolvePath(sourceRepoPath)) {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Source repository path could not be verified for independent review."
    )
  }

  const info = await stat(sourceRepoPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw reviewError(
        "REVIEW_WORKSPACE_NOT_READY",
        "Source repository path could not be verified for independent review."
      )
    }

    throw error
  })

  if (!info.isDirectory()) {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Source repository path could not be verified for independent review."
    )
  }

  const realPath = await realpath(sourceRepoPath).catch(() => {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Source repository path could not be verified for independent review."
    )
  })

  if (!isAbsolute(realPath) || realPath !== resolvePath(realPath) || realPath !== sourceRepoPath) {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Source repository path could not be verified for independent review."
    )
  }

  const topLevel = await gitLine(
    sourceRepoPath,
    ["rev-parse", "--show-toplevel"],
    options,
    "REVIEW_WORKSPACE_NOT_READY",
    "Source repository path could not be verified for independent review."
  )

  if (topLevel !== sourceRepoPath) {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Source repository path could not be verified for independent review."
    )
  }

  return realPath
}

async function workspaceFacts(location, options) {
  const info = await stat(location.workspacePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw reviewError(
        "REVIEW_WORKSPACE_NOT_READY",
        "Implementation workspace is missing or not verified for independent review."
      )
    }

    throw error
  })

  if (!info.isDirectory()) {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or not verified for independent review."
    )
  }

  const workspaceRealPath = await realpath(location.workspacePath)
  const rootRealPath = await realpath(location.workspaceRoot)
  const relation = relative(rootRealPath, workspaceRealPath)

  if (
    workspaceRealPath !== location.workspacePath ||
    rootRealPath !== location.workspaceRoot ||
    !relation ||
    relation === ".." ||
    relation.startsWith(`..${sep}`)
  ) {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Implementation workspace is outside the managed root."
    )
  }

  const gitDir = await canonicalGitStatePath(
    location.workspacePath,
    await gitLine(location.workspacePath, ["rev-parse", "--git-dir"], options, "REVIEW_WORKSPACE_NOT_READY", "Implementation workspace Git state could not be verified for independent review.")
  )
  const gitCommonDir = await canonicalGitStatePath(
    location.workspacePath,
    await gitLine(location.workspacePath, ["rev-parse", "--git-common-dir"], options, "REVIEW_WORKSPACE_NOT_READY", "Implementation workspace Git state could not be verified for independent review.")
  )
  const sourceRepoPath = await canonicalSourceRepoPath(location, options)

  return {
    topLevel: await gitLine(location.workspacePath, ["rev-parse", "--show-toplevel"], options, "REVIEW_WORKSPACE_NOT_READY", "Implementation workspace root could not be verified for independent review."),
    branch: await gitLine(location.workspacePath, ["symbolic-ref", "--short", "HEAD"], options, "REVIEW_WORKSPACE_BRANCH_MISMATCH", "Implementation workspace is detached or on the wrong branch for independent review."),
    headSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", "HEAD"], options, "REVIEW_WORKSPACE_NOT_READY", "Implementation workspace HEAD could not be verified for independent review."), "Workspace HEAD"),
    branchHeadSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", `refs/heads/${location.branch}`], options, "REVIEW_WORKSPACE_NOT_READY", "Implementation branch HEAD could not be verified for independent review."), "Implementation branch HEAD"),
    dirtyStatus: await gitText(location.workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"], options),
    gitDir,
    gitCommonDir,
    sourceRepoPath
  }
}

function assertWorkspaceMatches(location, facts) {
  if (
    facts.topLevel !== location.workspacePath ||
    facts.branch !== location.branch ||
    facts.branchHeadSha !== facts.headSha
  ) {
    throw reviewError(
      "REVIEW_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or mismatched for independent review."
    )
  }
}

function readOnlyPathsForReview(location, facts) {
  return normalizeReadOnlyPaths([
    location.workspacePath,
    facts.gitDir,
    facts.gitCommonDir,
    facts.sourceRepoPath
  ])
}

async function reconcileWorkspaceForReview(run, options) {
  const reviewedSha = normalizeSha(run.headSha, "Run head SHA")
  const location = await resolveImplementationWorkspaceLocation(run, options)
  const facts = await workspaceFacts(location, options)

  assertWorkspaceMatches(location, facts)

  if (facts.headSha !== reviewedSha || facts.branchHeadSha !== reviewedSha) {
    throw reviewError(
      "REVIEW_WORKSPACE_HEAD_MISMATCH",
      "Implementation workspace HEAD does not match the run head SHA."
    )
  }

  if (facts.dirtyStatus) {
    throw reviewError(
      "REVIEW_WORKSPACE_DIRTY",
      "Implementation workspace has uncommitted changes; independent review refused."
    )
  }

  return {
    location,
    facts,
    reviewedSha
  }
}

function latestPhase6DImplementationEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.implementation) ? run.evidence.implementation : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      entry?.source === PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE ||
      entry?.metadata?.adapter === PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE
    ) {
      return entry
    }
  }

  return null
}

function latestPhase6EPassEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.test) ? run.evidence.test : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      (entry?.source === PHASE_6E_TEST_EVIDENCE_SOURCE || entry?.metadata?.runner === PHASE_6E_TEST_EVIDENCE_SOURCE) &&
      entry?.metadata?.outcome === "passed"
    ) {
      return entry
    }
  }

  return null
}

function assertImplementationEvidenceMatches(run, reviewedSha) {
  const evidence = latestPhase6DImplementationEvidence(run)

  if (!evidence || evidence.sha !== reviewedSha) {
    throw reviewError(
      "REVIEW_IMPLEMENTATION_EVIDENCE_MISMATCH",
      "Phase 6D implementation evidence SHA does not match the run head SHA."
    )
  }

  return evidence
}

function assertTestPassEvidenceMatches(run, reviewedSha) {
  const evidence = latestPhase6EPassEvidence(run)

  if (!evidence || evidence.sha !== reviewedSha || evidence.metadata?.implSha !== reviewedSha) {
    throw reviewError(
      "REVIEW_TEST_EVIDENCE_MISMATCH",
      "Phase 6E PASS evidence does not match the run head SHA."
    )
  }

  return evidence
}

function latestReviewEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    const independentReviewEvidence = (
      entry?.source === INDEPENDENT_REVIEW_AGENT_ID ||
      entry?.metadata?.reviewer === INDEPENDENT_REVIEW_AGENT_ID
    )
    const recoveredReviewBoundary = (
      entry?.source === REVIEW_ORPHAN_RECOVERY_ACTOR &&
      entry?.metadata?.recovery === REVIEW_ORPHAN_RECOVERY_ACTOR &&
      entry?.metadata?.outcome === "review_orphan_recovered"
    )

    if (independentReviewEvidence || recoveredReviewBoundary) {
      return entry
    }
  }

  return null
}

function latestApprovedReviewEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      (entry?.source === INDEPENDENT_REVIEW_AGENT_ID || entry?.metadata?.reviewer === INDEPENDENT_REVIEW_AGENT_ID) &&
      entry?.metadata?.decision === REVIEW_DECISIONS.APPROVED &&
      entry?.metadata?.outcome === "approved"
    ) {
      return entry
    }
  }

  return null
}

function assertReviewAttemptAvailable(run) {
  if (run.attempts.review >= MAX_INDEPENDENT_REVIEW_ATTEMPTS) {
    throw reviewError(
      "REVIEW_ATTEMPT_LIMIT_REACHED",
      "Independent review attempt limit was reached; owner action is required."
    )
  }
}

function assertNoOpenReviewAttempt(run) {
  const latest = latestReviewEvidence(run)

  if (["review_started", "review_execution_ambiguous"].includes(latest?.metadata?.outcome)) {
    throw reviewError(
      "REVIEW_RECONCILIATION_REQUIRED",
      "Previous independent review attempt requires reconciliation before retrying."
    )
  }
}

function publicMetadata(metadata = {}, allowedKeys = []) {
  const output = {}

  for (const key of allowedKeys) {
    const value = metadata?.[key]

    if (value === null || value === undefined) {
      continue
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value
    }
  }

  return output
}

async function collectDiffFacts(run, location, reviewedSha, options) {
  const baseSha = normalizeSha(run.baseSha, "Run base SHA")
  const commitCountText = await gitLine(location.workspacePath, [
    "rev-list",
    "--ancestry-path",
    "--count",
    `${baseSha}..${reviewedSha}`
  ], options, "REVIEW_DIFF_FACTS_FAILED", "Review diff facts could not be derived.")
  const commitCount = Number.parseInt(commitCountText, 10)

  if (!Number.isInteger(commitCount) || commitCount <= 0) {
    throw reviewError(
      "REVIEW_DIFF_FACTS_FAILED",
      "Review diff facts could not be derived."
    )
  }

  const changedNames = (await gitText(location.workspacePath, [
    "diff",
    "--name-only",
    `${baseSha}..${reviewedSha}`
  ], options)).split(/\r?\n/u).filter(Boolean)
  const numstatLines = (await gitText(location.workspacePath, [
    "diff",
    "--numstat",
    `${baseSha}..${reviewedSha}`
  ], options)).split(/\r?\n/u).filter(Boolean)
  let additions = 0
  let deletions = 0
  let binaryFiles = 0

  for (const line of numstatLines) {
    const [added, deleted] = line.split(/\t/u)

    if (added === "-" || deleted === "-") {
      binaryFiles += 1
      continue
    }

    const addedCount = Number.parseInt(added, 10)
    const deletedCount = Number.parseInt(deleted, 10)

    if (Number.isInteger(addedCount) && addedCount >= 0) {
      additions += addedCount
    }

    if (Number.isInteger(deletedCount) && deletedCount >= 0) {
      deletions += deletedCount
    }
  }

  return {
    baseSha,
    reviewedSha,
    commitCount,
    changedFileCount: changedNames.length,
    additions,
    deletions,
    binaryFiles,
    changedFileHash: stableHash(changedNames.sort())
  }
}

function boundedPromptLine(value, maxChars = 500) {
  return normalizeSafeText(value, {
    code: "REVIEW_PROMPT_UNSAFE",
    safeMessage: "Independent review prompt source is unsafe.",
    maxChars
  })
}

function buildIndependentReviewPrompt(run, implementationEvidence, testEvidence, diffFacts) {
  const implementationMetadata = publicMetadata(implementationEvidence.metadata, [
    "attempt",
    "promptHash",
    "outcome",
    "sandbox",
    "backend",
    "platform",
    "network",
    "changedFiles"
  ])
  const testMetadata = publicMetadata(testEvidence.metadata, [
    "attempt",
    "policyId",
    "policyHash",
    "outcome",
    "total",
    "passed",
    "failed",
    "ambiguous",
    "sandbox",
    "network"
  ])
  const lines = [
    "PPO Phase 6F independent exact-SHA review.",
    `Project: ${boundedPromptLine(run.project.id, 80)}`,
    `Repository: ${boundedPromptLine(run.project.fullName, 120)}`,
    `Run status before review: ${boundedPromptLine(run.status, 40)}`,
    `Implementation SHA: ${diffFacts.reviewedSha}`,
    `Base SHA: ${diffFacts.baseSha}`,
    "",
    "Task:",
    boundedPromptLine(run.task, 1000),
    "",
    "Implementation evidence metadata:",
    stableStringify(implementationMetadata),
    "",
    "Test PASS evidence metadata:",
    stableStringify(testMetadata),
    "",
    "Local diff/file facts:",
    stableStringify({
      commitCount: diffFacts.commitCount,
      changedFileCount: diffFacts.changedFileCount,
      additions: diffFacts.additions,
      deletions: diffFacts.deletions,
      binaryFiles: diffFacts.binaryFiles,
      changedFileHash: diffFacts.changedFileHash
    }),
    "",
    "Security and scope requirements:",
    "- Review only the exact implementation SHA shown above.",
    "- Do not approve if tests are insufficient for the implementation risk.",
    "- Do not approve credential, secret, auth, deployment, GitHub write, merge, push, or service-control changes.",
    "- Do not approve work outside the bounded task scope.",
    "- Treat owner/product/security ambiguity as OWNER_ACTION_REQUIRED.",
    "- Return only one JSON object and no prose outside the object.",
    "",
    "Decision contract:",
    "- APPROVED => mergeAllowed=true and blockers/securityFindings/testsRequired all empty.",
    "- CHANGES_REQUESTED => mergeAllowed=false.",
    "- OWNER_ACTION_REQUIRED => mergeAllowed=false.",
    "",
    "Required JSON schema shape:",
    "Return exactly these keys: decision, reviewedSha, mergeAllowed, blockers, securityFindings, testsRequired, summary."
  ]
  const prompt = `${lines.join("\n")}\n`

  if (prompt.length > MAX_REVIEW_PROMPT_CHARS || sensitiveTextPattern.test(prompt) || unsafeMultilineOutputPattern.test(prompt)) {
    throw reviewError(
      "REVIEW_PROMPT_UNSAFE",
      "Independent review prompt source is unsafe."
    )
  }

  return prompt
}

function buildReviewStartedEvidence(run, location, execution, config) {
  return {
    kind: "review",
    sha: execution.reviewedSha,
    source: INDEPENDENT_REVIEW_AGENT_ID,
    summary: "Independent review attempt reserved.",
    metadata: {
      project: run.project.id,
      reviewer: INDEPENDENT_REVIEW_AGENT_ID,
      attempt: execution.attempt,
      reviewedSha: execution.reviewedSha,
      promptHash: execution.promptHash,
      startedAt: execution.startedAt,
      outcome: "review_started",
      sandbox: INDEPENDENT_REVIEW_SANDBOX_ID,
      backend: config.sandbox.backend,
      platform: config.sandbox.platform,
      network: "none",
      readOnlyWorkspace: true,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef
    }
  }
}

function reviewOutcomeForDecision(decision) {
  if (decision.decision === REVIEW_DECISIONS.APPROVED) {
    return "approved"
  }

  if (decision.decision === REVIEW_DECISIONS.CHANGES_REQUESTED) {
    return "changes_requested"
  }

  return "owner_action_required"
}

function reviewFindingHash(decision, reviewedSha) {
  return stableHash({
    reviewedSha,
    decision: decision.decision,
    blockers: decision.blockers,
    securityFindings: decision.securityFindings,
    testsRequired: decision.testsRequired
  })
}

function buildReviewFindingsEvidence(run, execution, decision) {
  return {
    kind: "review",
    sha: execution.reviewedSha,
    source: INDEPENDENT_REVIEW_AGENT_ID,
    summary: "Independent review validated bounded findings for remediation.",
    metadata: {
      project: run.project.id,
      reviewer: INDEPENDENT_REVIEW_AGENT_ID,
      attempt: execution.attempt,
      reviewedSha: execution.reviewedSha,
      decision: decision.decision,
      mergeAllowed: decision.mergeAllowed,
      blockers: decision.blockers.length,
      securityFindings: decision.securityFindings.length,
      testsRequired: decision.testsRequired.length,
      blockerItems: decision.blockers,
      securityItems: decision.securityFindings,
      testItems: decision.testsRequired,
      findingHash: reviewFindingHash(decision, execution.reviewedSha),
      outcome: REVIEW_FINDINGS_EVIDENCE_OUTCOME
    }
  }
}

function buildReviewDecisionEvidence(run, execution, config, decision, endedAt) {
  const outcome = reviewOutcomeForDecision(decision)

  return {
    kind: "review",
    sha: execution.reviewedSha,
    source: INDEPENDENT_REVIEW_AGENT_ID,
    summary: "Independent review completed with metadata-only decision.",
    metadata: {
      project: run.project.id,
      reviewer: INDEPENDENT_REVIEW_AGENT_ID,
      attempt: execution.attempt,
      reviewedSha: execution.reviewedSha,
      promptHash: execution.promptHash,
      decision: decision.decision,
      mergeAllowed: decision.mergeAllowed,
      blockers: decision.blockers.length,
      securityFindings: decision.securityFindings.length,
      testsRequired: decision.testsRequired.length,
      ...(execution.runtimeFailureClass ? {} : {
        summaryHash: sha256Text(decision.summary)
      }),
      startedAt: execution.startedAt,
      endedAt,
      outcome,
      ...(execution.runtimeFailureClass ? {
        runtimeFailureClass: execution.runtimeFailureClass
      } : {}),
      sandbox: INDEPENDENT_REVIEW_SANDBOX_ID,
      network: "none"
    }
  }
}

function normalizeDecisionText(value, maxChars = MAX_REVIEW_FINDING_CHARS) {
  return normalizeSafeText(value, {
    code: "REVIEW_OUTPUT_INVALID",
    safeMessage: "Independent reviewer output did not match the required schema.",
    maxChars
  })
}

function normalizeDecisionList(value, fieldName) {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_FINDINGS) {
    throw reviewError(
      "REVIEW_OUTPUT_INVALID",
      "Independent reviewer output did not match the required schema."
    )
  }

  return value.map((entry) => normalizeDecisionText(
    entry,
    fieldName === "summary" ? 500 : MAX_REVIEW_FINDING_CHARS
  ))
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys)
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => allowed.has(key))
}

function parseReviewerDecision(result, reviewedSha, maxOutputBytes) {
  if (isUncertainExecutionOutcome(result)) {
    throw ambiguousReviewError(ambiguityClassification(result, maxOutputBytes))
  }

  const stdout = String(result?.stdout ?? "")

  if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
    throw ambiguousReviewError({
      ...result,
      outputOverflow: true,
      stdoutOverflow: true
    })
  }

  if (unsafeMultilineOutputPattern.test(stdout)) {
    throw ambiguousReviewError(result)
  }

  if (result?.exitCode !== 0) {
    const failureText = `${String(result?.stderr ?? "")} ${String(result?.stdout ?? "")}`
    const error = reviewError(
      "REVIEW_EXECUTION_FAILED",
      "Independent review failed before a verified decision was produced."
    )
    error.failureClass = /(?:not logged in|authentication|authenticate|login required|token expired|token refresh|HTTP 401|unauthorized)/iu.test(failureText)
      ? "authentication"
      : "runtime"
    throw error
  }

  let parsed

  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw reviewError(
      "REVIEW_OUTPUT_INVALID",
      "Independent reviewer output did not match the required schema."
    )
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !hasOnlyKeys(parsed, [
      "decision",
      "reviewedSha",
      "mergeAllowed",
      "blockers",
      "securityFindings",
      "testsRequired",
      "summary"
    ])
  ) {
    throw reviewError(
      "REVIEW_OUTPUT_INVALID",
      "Independent reviewer output did not match the required schema."
    )
  }

  const decision = normalizeDecisionText(parsed.decision, 40)

  if (!Object.values(REVIEW_DECISIONS).includes(decision)) {
    throw reviewError(
      "REVIEW_OUTPUT_INVALID",
      "Independent reviewer output did not match the required schema."
    )
  }

  const normalized = {
    decision,
    reviewedSha: normalizeSha(parsed.reviewedSha, "Reviewed SHA"),
    mergeAllowed: parsed.mergeAllowed,
    blockers: normalizeDecisionList(parsed.blockers, "blockers"),
    securityFindings: normalizeDecisionList(parsed.securityFindings, "securityFindings"),
    testsRequired: normalizeDecisionList(parsed.testsRequired, "testsRequired"),
    summary: normalizeDecisionText(parsed.summary, 500)
  }

  if (normalized.reviewedSha !== reviewedSha) {
    throw reviewError(
      "REVIEW_SHA_MISMATCH",
      "Independent reviewer output SHA does not match the run head SHA."
    )
  }

  if (typeof normalized.mergeAllowed !== "boolean") {
    throw reviewError(
      "REVIEW_OUTPUT_INVALID",
      "Independent reviewer output did not match the required schema."
    )
  }

  if (normalized.decision === REVIEW_DECISIONS.APPROVED) {
    if (
      normalized.mergeAllowed !== true ||
      normalized.blockers.length !== 0 ||
      normalized.securityFindings.length !== 0 ||
      normalized.testsRequired.length !== 0
    ) {
      throw reviewError(
        "REVIEW_OUTPUT_CONTRADICTORY",
        "Independent reviewer approval decision is contradictory."
      )
    }
  } else if (normalized.mergeAllowed !== false) {
    throw reviewError(
      "REVIEW_OUTPUT_CONTRADICTORY",
      "Independent reviewer non-approval decision is contradictory."
    )
  }

  if (normalized.mergeAllowed && (
    normalized.blockers.length > 0 ||
    normalized.securityFindings.length > 0 ||
    normalized.testsRequired.length > 0
  )) {
    throw reviewError(
      "REVIEW_OUTPUT_CONTRADICTORY",
      "Independent reviewer merge permission is contradictory."
    )
  }

  return normalized
}

function buildReviewAmbiguityEvidence(run, execution, ambiguity, endedAt) {
  return {
    kind: "review",
    sha: execution.reviewedSha,
    source: INDEPENDENT_REVIEW_AGENT_ID,
    summary: "Independent review execution ended ambiguously with bounded classification.",
    metadata: {
      project: run.project.id,
      reviewer: INDEPENDENT_REVIEW_AGENT_ID,
      attempt: execution.attempt,
      reviewedSha: execution.reviewedSha,
      startedAt: execution.startedAt,
      endedAt,
      outcome: "review_execution_ambiguous",
      failureClass: ambiguity.failureClass,
      timedOut: ambiguity.timedOut,
      killed: ambiguity.killed,
      outputOverflow: ambiguity.outputOverflow,
      decisionOverflow: ambiguity.stdoutOverflow,
      progressOverflow: ambiguity.stderrOverflow,
      signal: ambiguity.signal,
      sandbox: INDEPENDENT_REVIEW_SANDBOX_ID,
      network: "none"
    }
  }
}

async function recordReviewAmbiguity(run, execution, error, options) {
  const ambiguity = ambiguityClassification(error?.ambiguity || error)
  const endedAt = timestamp(nowDate(options))

  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "review_in_progress",
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    reason: "phase-6f-independent-review-ambiguous",
    evidence: [
      buildReviewAmbiguityEvidence(run, execution, ambiguity, endedAt)
    ]
  }, options)
}

async function reserveReviewAttempt(run, location, execution, config, options) {
  return await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "review_in_progress",
    branch: location.branch,
    headSha: execution.reviewedSha,
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    reason: "phase-6f-independent-review-attempt",
    evidence: [
      buildReviewStartedEvidence(run, location, execution, config)
    ]
  }, options)
}

async function invokeReviewer(config, invocation, options = {}) {
  const result = await runSandboxedCommand({
    kind: "review",
    sandbox: config.sandbox,
    executablePath: config.executablePath,
    args: [...config.args],
    cwd: invocation.cwd,
    stdin: invocation.prompt,
    prompt: invocation.prompt,
    promptHash: invocation.promptHash,
    reviewedSha: invocation.reviewedSha,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    maxStderrBytes: config.maxStderrBytes,
    env: config.env,
    readOnlyPaths: invocation.readOnlyPaths
  }, options)

  return parseReviewerDecision(result, invocation.reviewedSha, config.maxOutputBytes)
}

export function normalizeTrustedReviewConfig(config) {
  return normalizeReviewConfig(config)
}

export async function reconcileTrustedReviewWorkspace(run, options = {}) {
  return await reconcileWorkspaceForReview(run, options)
}

export async function collectTrustedReviewDiffFacts(run, location, reviewedSha, options = {}) {
  return await collectDiffFacts(run, location, reviewedSha, options)
}

export function trustedReviewReadOnlyPaths(location, facts) {
  return readOnlyPathsForReview(location, facts)
}

export async function assertTrustedReviewSandboxActive(config, location, facts, options = {}) {
  await assertReviewSandboxActive(config, location, facts, options)
}

export async function invokeTrustedReviewForPrompt(config, invocation, options = {}) {
  return await invokeReviewer(config, invocation, options)
}

async function transitionReviewDecision(run, config, execution, decision, options) {
  const endedAt = timestamp(nowDate(options))
  const evidence = [
    ...(decision.decision === REVIEW_DECISIONS.APPROVED || execution.runtimeFailureClass ? [] : [
      buildReviewFindingsEvidence(run, execution, decision)
    ]),
    buildReviewDecisionEvidence(run, execution, config, decision, endedAt)
  ]
  const status = decision.decision === REVIEW_DECISIONS.APPROVED
    ? "review_passed"
    : "review_changes_requested"
  const transitioned = await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status,
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    reason: `phase-6f-independent-review-${reviewOutcomeForDecision(decision)}`,
    evidence
  }, options)

  return {
    ok: true,
    outcome: reviewOutcomeForDecision(decision),
    run: transitioned,
    review: {
      project: run.project.id,
      repo: run.project.fullName,
      reviewedSha: execution.reviewedSha,
      decision: decision.decision,
      mergeAllowed: decision.mergeAllowed,
      blockerCount: decision.blockers.length,
      securityFindingCount: decision.securityFindings.length,
      testsRequiredCount: decision.testsRequired.length,
      attempt: run.attempts.review
    }
  }
}

async function failClosedWithOwnerAction(run, config, execution, options, error) {
  const decision = {
    decision: REVIEW_DECISIONS.OWNER_ACTION_REQUIRED,
    reviewedSha: execution.reviewedSha,
    mergeAllowed: false,
    blockers: [],
    securityFindings: [],
    testsRequired: [],
    summary: "Independent review could not produce a valid approval decision."
  }

  await transitionReviewDecision(run, config, {
    ...execution,
    runtimeFailureClass: error?.failureClass === "authentication" ? "authentication" : "runtime"
  }, decision, options)
  throw error
}

async function failClosedForWorkspaceMutation(run, config, execution, options, code, safeMessage) {
  const decision = {
    decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
    reviewedSha: execution.reviewedSha,
    mergeAllowed: false,
    blockers: ["Reviewer modified or invalidated the verified workspace."],
    securityFindings: [],
    testsRequired: [],
    summary: "Independent review was blocked because workspace state changed during review."
  }

  await transitionReviewDecision(run, config, execution, decision, options)
  throw reviewError(code, safeMessage)
}

async function executeIndependentReviewInternal(runId, options = {}) {
  const expectedVersion = normalizeExpectedVersion(options.expectedVersion)
  const config = normalizeReviewConfig(options.reviewConfig)
  const run = await readDevelopmentRun(runId, options)

  if (run.version !== expectedVersion) {
    throw reviewError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  if (run.status === "review_in_progress") {
    assertNoOpenReviewAttempt(run)
  }

  if (run.status !== "tests_passed") {
    throw reviewError(
      "REVIEW_RUN_NOT_READY",
      "Development run must be tests_passed before independent review."
    )
  }

  const reviewedSha = normalizeSha(run.headSha, "Run head SHA")
  const implementationEvidence = assertImplementationEvidenceMatches(run, reviewedSha)
  const testEvidence = assertTestPassEvidenceMatches(run, reviewedSha)

  assertNoOpenReviewAttempt(run)
  assertReviewAttemptAvailable(run)

  const preflight = await reconcileWorkspaceForReview(run, options)
  const diffFacts = await collectDiffFacts(run, preflight.location, reviewedSha, options)
  const prompt = buildIndependentReviewPrompt(run, implementationEvidence, testEvidence, diffFacts)
  const promptHash = sha256Text(prompt)

  await assertReviewSandboxActive(config, preflight.location, preflight.facts, options)

  const startedAt = timestamp(nowDate(options))
  const execution = {
    attempt: run.attempts.review + 1,
    reviewedSha,
    promptHash,
    startedAt
  }
  const attemptRun = await reserveReviewAttempt(run, preflight.location, execution, config, options)
  const postReservation = await reconcileWorkspaceForReview(attemptRun, options)
  const attemptExecution = {
    ...execution,
    attempt: attemptRun.attempts.review
  }
  let decision

  try {
    decision = await invokeReviewer(config, {
      cwd: postReservation.location.workspacePath,
      prompt,
      promptHash,
      reviewedSha,
      readOnlyPaths: readOnlyPathsForReview(postReservation.location, postReservation.facts)
    }, options)
  } catch (error) {
    if (error?.ambiguous === true || error?.code === "REVIEW_EXECUTION_AMBIGUOUS") {
      try {
        await recordReviewAmbiguity(attemptRun, attemptExecution, error, options)
      } catch {
        // Preserve the original ambiguity. The reserved attempt remains fail-closed.
      }

      throw error
    }

    await failClosedWithOwnerAction(attemptRun, config, attemptExecution, options, error)
  }

  try {
    await reconcileWorkspaceForReview(attemptRun, options)
  } catch (error) {
    if (error?.code === "REVIEW_WORKSPACE_DIRTY") {
      await failClosedForWorkspaceMutation(
        attemptRun,
        config,
        attemptExecution,
        options,
        "REVIEW_WORKSPACE_DIRTY",
        "Independent reviewer changed the workspace; review approval was refused."
      )
    }

    if (error?.code === "REVIEW_WORKSPACE_HEAD_MISMATCH") {
      await failClosedForWorkspaceMutation(
        attemptRun,
        config,
        attemptExecution,
        options,
        "REVIEW_WORKSPACE_HEAD_MISMATCH",
        "Implementation workspace HEAD changed during independent review; approval was refused."
      )
    }

    throw error
  }

  if (decision.decision === REVIEW_DECISIONS.APPROVED) {
    assertTestPassEvidenceMatches(attemptRun, reviewedSha)
  }

  return await transitionReviewDecision(attemptRun, config, attemptExecution, decision, options)
}

async function reconcileIndependentReviewInternal(runId, options = {}) {
  const run = await readDevelopmentRun(runId, options)
  const reviewedSha = run.headSha ? normalizeSha(run.headSha, "Run head SHA") : null
  const latest = latestReviewEvidence(run)
  const approved = latestApprovedReviewEvidence(run)
  let implementationEvidenceValid = false
  let testPassEvidenceValid = false
  let location = null
  let facts = null
  let workspaceStatus = "missing"

  if (reviewedSha) {
    try {
      assertImplementationEvidenceMatches(run, reviewedSha)
      implementationEvidenceValid = true
    } catch {
      implementationEvidenceValid = false
    }

    try {
      assertTestPassEvidenceMatches(run, reviewedSha)
      testPassEvidenceValid = true
    } catch {
      testPassEvidenceValid = false
    }
  }

  try {
    location = await resolveImplementationWorkspaceLocation(run, options)
    facts = await workspaceFacts(location, options)
    assertWorkspaceMatches(location, facts)
    workspaceStatus = "matching"

    if (reviewedSha && facts.headSha !== reviewedSha) {
      workspaceStatus = "head_changed"
    } else if (facts.dirtyStatus) {
      workspaceStatus = "dirty"
    }
  } catch {
    workspaceStatus = "mismatch"
  }

  const openAttempt = latest?.metadata?.outcome === "review_started"
  const ambiguousAttempt = latest?.metadata?.outcome === "review_execution_ambiguous"
  const approvalValid = (
    run.status === "review_passed" &&
    approved?.sha === reviewedSha &&
    approved?.metadata?.reviewedSha === reviewedSha &&
    approved?.metadata?.decision === REVIEW_DECISIONS.APPROVED &&
    approved?.metadata?.mergeAllowed === true &&
    implementationEvidenceValid &&
    testPassEvidenceValid &&
    workspaceStatus === "matching"
  )
  const status = approvalValid
    ? "approval_valid"
    : openAttempt
      ? "open_attempt"
      : ambiguousAttempt
        ? "ambiguous_attempt"
        : workspaceStatus

  return {
    ok: true,
    outcome: "independent_review_reconciled",
    status,
    openAttempt,
    ambiguousAttempt,
    approvalValid,
    implementationEvidenceValid,
    testPassEvidenceValid,
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id,
      headSha: reviewedSha
    },
    workspace: location ? {
      project: location.project,
      repo: location.repo,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef
    } : null,
    facts: {
      branch: facts?.branch || null,
      headSha: facts?.headSha || null,
      expectedHeadSha: reviewedSha,
      dirty: Boolean(facts?.dirtyStatus)
    },
    evidence: {
      latestOutcome: latest?.metadata?.outcome || null,
      latestDecision: latest?.metadata?.decision || null,
      latestAttempt: latest?.metadata?.attempt || null,
      latestSha: latest?.sha || null
    }
  }
}

export async function executeIndependentReview(runId, options = {}) {
  try {
    return await executeIndependentReviewInternal(runId, options)
  } catch (error) {
    throw safeReviewFailure(error)
  }
}

export async function reconcileIndependentReview(runId, options = {}) {
  try {
    return await reconcileIndependentReviewInternal(runId, options)
  } catch (error) {
    throw safeReviewFailure(error)
  }
}

export function formatDevelopmentReviewAgentError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO independent review error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO independent review error: unexpected local failure."
}
