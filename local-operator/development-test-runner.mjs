import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { createServer } from "node:net"
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  readDevelopmentRun,
  recordDevelopmentRunProgress,
  resolveDevelopmentRunProject,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"

const execFileAsync = promisify(execFile)

export const AUTOMATED_TEST_RUNNER_ID = "phase-6e-automated-test-runner"
export const AUTOMATED_TEST_SANDBOX_ID = "phase-6e-no-outbound-network-test-sandbox"
export const PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE = "phase-6d-codex-execution-adapter"
export const MAX_AUTOMATED_TEST_STEPS = 5
export const MAX_AUTOMATED_TEST_ATTEMPTS = 5
export const MAX_TEST_ARG_COUNT = 32
export const MAX_TEST_ARG_CHARS = 240
export const MAX_TEST_ENV_KEYS = 16
export const MAX_TEST_ENV_VALUE_CHARS = 1000
export const MAX_TEST_OUTPUT_BYTES = 32 * 1024
export const MAX_TEST_TIMEOUT_MS = 2 * 60 * 1000
export const MIN_TEST_TIMEOUT_MS = 1000
export const MAX_TEST_GIT_OUTPUT_BYTES = 24 * 1024
export const TEST_SANDBOX_BACKENDS = Object.freeze({
  MACOS_SANDBOX_EXEC: "macos-sandbox-exec",
  LINUX_NETWORK_NAMESPACE: "linux-network-namespace"
})

const shaPattern = /^[a-f0-9]{40}$/u
const safeIdPattern = /^[a-z0-9][a-z0-9_.:-]{0,79}$/u
const envKeyPattern = /^[A-Z_][A-Z0-9_]{0,39}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const unsafeMultilineOutputPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const forbiddenEnvKeyPattern = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|CONFIRM|ASKPASS|GIT_CONFIG|GIT_SSH|SSH_AUTH_SOCK|HOME|NETRC|NPM|AWS|GOOGLE|GCLOUD|AZURE|DOCKER|KUBE|OPENAI|ANTHROPIC|NODE_OPTIONS)/u
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
const noOutboundNetworkSandboxProfile = `(version 1)
(allow default)
(deny network*)
`

export class DevelopmentTestRunnerError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentTestRunnerError"
  }
}

function testRunnerError(code, safeMessage) {
  return new DevelopmentTestRunnerError(code, safeMessage)
}

function safeTestRunnerFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return testRunnerError(
    "TEST_RUNNER_UNAVAILABLE",
    "Automated test runner is unavailable; no raw failure was stored."
  )
}

function rejectUnsafeText(value, code, safeMessage) {
  if (unsafeControlPattern.test(value) || sensitiveTextPattern.test(value)) {
    throw testRunnerError(code, safeMessage)
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
      throw testRunnerError(code, safeMessage)
    }

    return null
  }

  const normalized = String(value).trim()

  if ((required && !normalized) || normalized.length > maxChars || unsafeControlPattern.test(normalized)) {
    throw testRunnerError(code, safeMessage)
  }

  rejectUnsafeText(normalized, code, safeMessage)
  return normalized
}

function normalizeSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw testRunnerError(
      "TEST_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw testRunnerError(
      "TEST_EXPECTED_VERSION_REQUIRED",
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

function normalizeSafeId(value, fieldName = "Test policy id") {
  const normalized = normalizeSafeText(value, {
    code: "TEST_POLICY_INVALID",
    safeMessage: `${fieldName} is not approved for automated testing.`,
    maxChars: 80
  })

  if (!safeIdPattern.test(normalized)) {
    throw testRunnerError(
      "TEST_POLICY_INVALID",
      `${fieldName} is not approved for automated testing.`
    )
  }

  return normalized
}

function normalizeExecutablePath(value) {
  const executablePath = normalizeSafeText(value, {
    code: "TEST_POLICY_UNTRUSTED_EXECUTABLE",
    safeMessage: "Automated test executable is not in the trusted policy allowlist.",
    maxChars: 240
  })

  if (!isAbsolute(executablePath) || executablePath !== resolvePath(executablePath)) {
    throw testRunnerError(
      "TEST_POLICY_UNTRUSTED_EXECUTABLE",
      "Automated test executable is not in the trusted policy allowlist."
    )
  }

  const executableName = executablePath.split("/").at(-1)

  if (forbiddenExecutableNames.has(executableName)) {
    throw testRunnerError(
      "TEST_POLICY_UNTRUSTED_EXECUTABLE",
      "Automated test executable is not in the trusted policy allowlist."
    )
  }

  return executablePath
}

function normalizeSandboxPath(value) {
  const sandboxPath = normalizeSafeText(value, {
    code: "TEST_SANDBOX_REQUIRED",
    safeMessage: "Automated testing requires a trusted no-outbound-network process sandbox.",
    maxChars: 240
  })

  if (!isAbsolute(sandboxPath) || sandboxPath !== resolvePath(sandboxPath)) {
    throw testRunnerError(
      "TEST_SANDBOX_REQUIRED",
      "Automated testing requires a trusted no-outbound-network process sandbox."
    )
  }

  return sandboxPath
}

function normalizeSandboxPositiveInteger(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) {
    throw testRunnerError(
      "TEST_SANDBOX_REQUIRED",
      "Automated testing requires a trusted no-outbound-network process sandbox."
    )
  }

  return value
}

function requireSandboxTrue(value) {
  if (value !== true) {
    throw testRunnerError(
      "TEST_SANDBOX_REQUIRED",
      "Automated testing requires a trusted no-outbound-network process sandbox."
    )
  }

  return true
}

function normalizeExecutionSandbox(sandbox) {
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) {
    throw testRunnerError(
      "TEST_SANDBOX_REQUIRED",
      "Automated testing requires a trusted no-outbound-network process sandbox."
    )
  }

  const type = normalizeSafeText(sandbox.type, {
    code: "TEST_SANDBOX_REQUIRED",
    safeMessage: "Automated testing requires a trusted no-outbound-network process sandbox.",
    maxChars: 80
  })
  const network = normalizeSafeText(sandbox.network, {
    code: "TEST_SANDBOX_REQUIRED",
    safeMessage: "Automated testing requires a trusted no-outbound-network process sandbox.",
    maxChars: 40
  })
  const enforcement = normalizeSafeText(sandbox.enforcement, {
    code: "TEST_SANDBOX_REQUIRED",
    safeMessage: "Automated testing requires a trusted no-outbound-network process sandbox.",
    maxChars: 80
  })
  const platform = normalizeSafeText(sandbox.platform, {
    code: "TEST_SANDBOX_REQUIRED",
    safeMessage: "Automated testing requires a trusted no-outbound-network process sandbox.",
    maxChars: 20
  })

  if (network !== "none") {
    throw testRunnerError(
      "TEST_SANDBOX_REQUIRED",
      "Automated testing requires a trusted no-outbound-network process sandbox."
    )
  }

  if (type === TEST_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC) {
    if (platform !== "darwin" || enforcement !== "os-process") {
      throw testRunnerError(
        "TEST_SANDBOX_REQUIRED",
        "Automated testing requires a trusted no-outbound-network process sandbox."
      )
    }

    return {
      type,
      backend: TEST_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
      platform,
      network,
      enforcement,
      executablePath: normalizeSandboxPath(sandbox.executablePath)
    }
  }

  if (type === TEST_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE) {
    if (platform !== "linux" || enforcement !== "os-network-namespace") {
      throw testRunnerError(
        "TEST_SANDBOX_REQUIRED",
        "Automated testing requires a trusted no-outbound-network process sandbox."
      )
    }

    return {
      type,
      backend: TEST_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
      platform,
      network,
      enforcement,
      executablePath: normalizeSandboxPath(sandbox.executablePath),
      namespacePath: normalizeSandboxPath(sandbox.namespacePath),
      setprivPath: normalizeSandboxPath(sandbox.setprivPath),
      runAsUid: normalizeSandboxPositiveInteger(sandbox.runAsUid),
      runAsGid: normalizeSandboxPositiveInteger(sandbox.runAsGid),
      requireNoNewPrivileges: requireSandboxTrue(sandbox.requireNoNewPrivileges),
      dropCapabilities: requireSandboxTrue(sandbox.dropCapabilities)
    }
  }

  throw testRunnerError(
    "TEST_SANDBOX_REQUIRED",
    "Automated testing requires a trusted no-outbound-network process sandbox."
  )
}

function normalizeTestArgs(args = []) {
  if (!Array.isArray(args) || args.length > MAX_TEST_ARG_COUNT) {
    throw testRunnerError(
      "TEST_POLICY_INVALID",
      "Automated test argv policy is invalid."
    )
  }

  return args.map((entry) => normalizeSafeText(entry, {
    code: "TEST_POLICY_INVALID",
    safeMessage: "Automated test argv policy is invalid.",
    maxChars: MAX_TEST_ARG_CHARS
  }))
}

function normalizeTimeoutMs(value) {
  if (!Number.isInteger(value) || value < MIN_TEST_TIMEOUT_MS || value > MAX_TEST_TIMEOUT_MS) {
    throw testRunnerError(
      "TEST_POLICY_INVALID",
      "Automated test timeout policy is invalid."
    )
  }

  return value
}

function normalizeOutputBytes(value) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TEST_OUTPUT_BYTES) {
    throw testRunnerError(
      "TEST_POLICY_INVALID",
      "Automated test output policy is invalid."
    )
  }

  return value
}

function normalizePolicyEnv(env = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw testRunnerError(
      "TEST_POLICY_INVALID",
      "Automated test environment policy is invalid."
    )
  }

  const entries = Object.entries(env)

  if (entries.length > MAX_TEST_ENV_KEYS) {
    throw testRunnerError(
      "TEST_POLICY_INVALID",
      "Automated test environment policy is invalid."
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
      throw testRunnerError(
        "TEST_POLICY_INVALID",
        "Automated test environment policy is invalid."
      )
    }

    normalized[key] = normalizeSafeText(value, {
      code: "TEST_POLICY_INVALID",
      safeMessage: "Automated test environment policy is invalid.",
      maxChars: MAX_TEST_ENV_VALUE_CHARS,
      required: false
    }) || ""
  }

  return normalized
}

function normalizeTrustedExecutables(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 16) {
    throw testRunnerError(
      "TEST_POLICY_UNTRUSTED_EXECUTABLE",
      "Automated test executable is not in the trusted policy allowlist."
    )
  }

  return paths.map((entry) => normalizeExecutablePath(entry))
}

function normalizeTestStep(step, trustedExecutableSet) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw testRunnerError(
      "TEST_POLICY_INVALID",
      "Automated test command policy is invalid."
    )
  }

  if (Object.hasOwn(step, "command") || Object.hasOwn(step, "cmd") || step.shell === true) {
    throw testRunnerError(
      "TEST_POLICY_ARBITRARY_COMMAND_REFUSED",
      "Automated test policy must use explicit executable argv with shell disabled."
    )
  }

  if (Object.hasOwn(step, "shell") && step.shell !== false) {
    throw testRunnerError(
      "TEST_POLICY_ARBITRARY_COMMAND_REFUSED",
      "Automated test policy must use explicit executable argv with shell disabled."
    )
  }

  const id = normalizeSafeId(step.id, "Automated test id")
  const executablePath = normalizeExecutablePath(step.executablePath)

  if (!trustedExecutableSet.has(executablePath)) {
    throw testRunnerError(
      "TEST_POLICY_UNTRUSTED_EXECUTABLE",
      "Automated test executable is not in the trusted policy allowlist."
    )
  }

  if (step.required !== undefined && step.required !== true) {
    throw testRunnerError(
      "TEST_POLICY_INVALID",
      "Automated test command policy is invalid."
    )
  }

  return {
    id,
    executablePath,
    args: normalizeTestArgs(step.args || []),
    timeoutMs: normalizeTimeoutMs(step.timeoutMs),
    maxOutputBytes: normalizeOutputBytes(step.maxOutputBytes || MAX_TEST_OUTPUT_BYTES),
    required: true
  }
}

function normalizeProjectTestPolicy(project, policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw testRunnerError(
      "TEST_POLICY_REQUIRED",
      "Trusted project test policy is required."
    )
  }

  const policyId = normalizeSafeId(policy.policyId, "Automated test policy id")
  const policyVersion = normalizeSafeText(policy.policyVersion, {
    code: "TEST_POLICY_INVALID",
    safeMessage: "Automated test policy version is invalid.",
    maxChars: 40
  })
  const trustedExecutablePaths = normalizeTrustedExecutables(policy.trustedExecutablePaths)
  const trustedExecutableSet = new Set(trustedExecutablePaths)

  if (!Array.isArray(policy.steps) || policy.steps.length === 0 || policy.steps.length > MAX_AUTOMATED_TEST_STEPS) {
    throw testRunnerError(
      "TEST_POLICY_TOO_MANY_STEPS",
      "Automated test policy exceeds the bounded test-step limit."
    )
  }

  const normalized = {
    project: project.id,
    policyId,
    policyVersion,
    trustedExecutablePaths,
    env: normalizePolicyEnv(policy.env || {}),
    sandbox: normalizeExecutionSandbox(policy.sandbox),
    steps: policy.steps.map((step) => normalizeTestStep(step, trustedExecutableSet))
  }

  return {
    ...normalized,
    policyHash: stableHash(normalized)
  }
}

function normalizeTestPolicyRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw testRunnerError(
      "TEST_POLICY_REQUIRED",
      "Trusted project test policy is required."
    )
  }

  const normalized = new Map()

  for (const [projectId, policy] of Object.entries(registry)) {
    const project = resolveDevelopmentRunProject(projectId)
    normalized.set(project.id, normalizeProjectTestPolicy(project, policy))
  }

  return normalized
}

function resolveProjectPolicy(run, registry) {
  const policy = registry.get(run.project.id)

  if (!policy) {
    throw testRunnerError(
      "TEST_POLICY_MISSING_PROJECT",
      "Project is not configured for automated testing."
    )
  }

  return policy
}

export function resolveAutomatedTestPolicyIdentity(run, options = {}) {
  const registry = normalizeTestPolicyRegistry(options.testPolicyRegistry)
  const policy = resolveProjectPolicy(run, registry)

  return {
    policyId: policy.policyId,
    policyHash: policy.policyHash,
    requiredTestCount: policy.steps.length
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

function ambiguousTestingError() {
  const error = testRunnerError(
    "TEST_EXECUTION_AMBIGUOUS",
    "Automated test execution outcome is ambiguous; reconcile workspace state before retrying."
  )
  error.ambiguous = true
  return error
}

function sandboxError() {
  return testRunnerError(
    "TEST_SANDBOX_UNAVAILABLE",
    "Automated test no-outbound-network process sandbox could not be established."
  )
}

function assertSandboxRuntimePlatform(sandbox, options = {}) {
  if (options.sandboxRunner) {
    return
  }

  const currentPlatform = options.platform || process.platform

  if (sandbox.platform !== currentPlatform) {
    throw sandboxError()
  }
}

function sandboxedCommand(sandbox, executablePath, args, options = {}) {
  assertSandboxRuntimePlatform(sandbox, options)

  if (sandbox.type === TEST_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC) {
    return {
      backend: sandbox.backend,
      executablePath: sandbox.executablePath,
      args: [
        "-p",
        noOutboundNetworkSandboxProfile,
        executablePath,
        ...args
      ]
    }
  }

  if (sandbox.type === TEST_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE) {
    return {
      backend: sandbox.backend,
      executablePath: sandbox.executablePath,
      args: [
        `--net=${sandbox.namespacePath}`,
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

async function runSandboxedProcess(invocation) {
  const command = invocation.sandboxCommand || sandboxedCommand(
    invocation.sandbox,
    invocation.executablePath,
    invocation.args
  )

  return await new Promise((resolve, reject) => {
    const child = spawn(command.executablePath, command.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    })

    let stdoutBytes = 0
    let stderrBytes = 0
    let killed = false
    let timedOut = false
    let outputOverflow = false
    let settled = false
    const outputLimit = invocation.maxOutputBytes
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
        killed = true
        child.kill("SIGTERM")
      }
    })

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length

      if (stderrBytes > outputLimit) {
        outputOverflow = true
        killed = true
        child.kill("SIGTERM")
      }
    })

    child.on("error", (error) => {
      settle(reject, error)
    })

    child.on("close", (exitCode, signal) => {
      settle(resolve, {
        exitCode,
        signal,
        killed,
        timedOut,
        outputOverflow,
        ambiguous: killed || timedOut || outputOverflow || typeof signal === "string"
      })
    })
  })
}

async function runSandboxedCommand(invocation, options = {}) {
  const runner = options.sandboxRunner || runSandboxedProcess

  try {
    const command = sandboxedCommand(invocation.sandbox, invocation.executablePath, invocation.args, options)

    return await runner({
      ...invocation,
      sandboxCommand: command,
      sandboxExecutablePath: command.executablePath,
      sandboxArgs: [...command.args],
      shell: false
    })
  } catch (error) {
    if (isUncertainExecutionOutcome(error)) {
      throw ambiguousTestingError()
    }

    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    if (invocation.kind === "test") {
      throw testRunnerError(
        "TEST_EXECUTION_FAILED",
        "Automated test command failed before a verified result was produced."
      )
    }

    throw sandboxError()
  }
}

async function withLoopbackProbeServer(callback, options = {}) {
  if (options.sandboxRunner) {
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
  return sandbox.type === TEST_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE
}

async function assertSandboxLinuxPrivilegeBoundary(policy, location, options) {
  if (!linuxNetworkNamespaceSandbox(policy.sandbox)) {
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
    sandbox: policy.sandbox,
    executablePath: process.execPath,
    args: ["--eval", probeCode],
    cwd: location.workspacePath,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: policy.env
  }, options)

  assertSandboxProbeResult(result)

  if (result?.exitCode !== 0) {
    throw sandboxError()
  }
}

async function assertSandboxProcessAllowed(policy, location, options) {
  const result = await runSandboxedCommand({
    kind: "sandbox-probe",
    probe: "local-process",
    sandbox: policy.sandbox,
    executablePath: process.execPath,
    args: ["--eval", "process.exit(0)"],
    cwd: location.workspacePath,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: policy.env
  }, options)

  assertSandboxProbeResult(result)

  if (result?.exitCode !== 0) {
    throw sandboxError()
  }
}

function isDirectNetworkDenied(policy, result, connectionCount) {
  if (result?.sandboxDenied === true) {
    return true
  }

  if (connectionCount !== 0) {
    return false
  }

  if (result?.exitCode === 0) {
    return true
  }

  return linuxNetworkNamespaceSandbox(policy.sandbox) && (
    result?.exitCode === 67 ||
    result?.exitCode === 68
  )
}

async function assertSandboxDirectNetworkDenied(policy, location, options) {
  const probeCode = [
    "const net = require('node:net')",
    "const port = Number(process.env.PPO_TEST_SANDBOX_PROBE_PORT)",
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
      sandbox: policy.sandbox,
      executablePath: process.execPath,
      args: ["--eval", probeCode],
      cwd: location.workspacePath,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      env: {
        ...policy.env,
        PPO_TEST_SANDBOX_PROBE_PORT: String(port)
      }
    }, options)

    assertSandboxProbeResult(result)

    if (!isDirectNetworkDenied(policy, result, connectionCount())) {
      throw sandboxError()
    }
  }, options)
}

async function assertTestSandboxActive(policy, location, options) {
  await assertSandboxLinuxPrivilegeBoundary(policy, location, options)
  await assertSandboxProcessAllowed(policy, location, options)
  await assertSandboxDirectNetworkDenied(policy, location, options)
}

function assertGitArgs(args) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || !entry)) {
    throw testRunnerError(
      "TEST_GIT_OPERATION_REFUSED",
      "Git verification operation is not approved for the automated test runner."
    )
  }

  const command = args[2]
  const subcommand = args[3]
  const isGitC = args[0] === "-C" && typeof args[1] === "string"
  const branchRef = (value) => typeof value === "string" && value.startsWith("refs/heads/")
  const exactShape = (
    isGitC &&
    (
      (command === "rev-parse" && args.length === 4 && (
        subcommand === "--show-toplevel" ||
        subcommand === "HEAD" ||
        branchRef(subcommand)
      )) ||
      (command === "symbolic-ref" && args.length === 5 && subcommand === "--short" && args[4] === "HEAD") ||
      (command === "status" && args.length === 5 && subcommand === "--porcelain=v1" && args[4] === "--untracked-files=all")
    )
  )

  if (!exactShape) {
    throw testRunnerError(
      "TEST_GIT_OPERATION_REFUSED",
      "Git verification operation is not approved for the automated test runner."
    )
  }
}

async function runGit(args, options = {}) {
  assertGitArgs(args)

  const runner = options.gitRunner || (async (argv) => {
    const result = await execFileAsync("git", argv, {
      encoding: "utf8",
      maxBuffer: MAX_TEST_GIT_OUTPUT_BYTES,
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
    throw testRunnerError(
      "TEST_GIT_VERIFY_FAILED",
      "Git verification failed; no raw Git output was stored."
    )
  }
}

function gitOutputLine(result, code, safeMessage) {
  const output = String(result.stdout ?? "").trim()

  if (!output || output.length > MAX_TEST_GIT_OUTPUT_BYTES || /[\u0000-\u001f\u007f]/u.test(output)) {
    throw testRunnerError(code, safeMessage)
  }

  return output.split(/\r?\n/u)[0].trim()
}

async function gitLine(cwd, args, options, code, safeMessage) {
  try {
    return gitOutputLine(await runGit(["-C", cwd, ...args], options), code, safeMessage)
  } catch (error) {
    if (error?.code === "TEST_GIT_VERIFY_FAILED") {
      throw testRunnerError(code, safeMessage)
    }

    throw error
  }
}

async function gitText(cwd, args, options) {
  const result = await runGit(["-C", cwd, ...args], options)
  const output = String(result.stdout ?? "")

  if (Buffer.byteLength(output, "utf8") > MAX_TEST_GIT_OUTPUT_BYTES || unsafeMultilineOutputPattern.test(output)) {
    throw testRunnerError(
      "TEST_GIT_VERIFY_FAILED",
      "Git verification output is invalid."
    )
  }

  return output.trim()
}

async function workspaceFacts(location, options) {
  const info = await stat(location.workspacePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw testRunnerError(
        "TEST_WORKSPACE_NOT_READY",
        "Implementation workspace is missing or not verified for automated testing."
      )
    }

    throw error
  })

  if (!info.isDirectory()) {
    throw testRunnerError(
      "TEST_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or not verified for automated testing."
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
    throw testRunnerError(
      "TEST_WORKSPACE_NOT_READY",
      "Implementation workspace is outside the managed root."
    )
  }

  return {
    topLevel: await gitLine(location.workspacePath, ["rev-parse", "--show-toplevel"], options, "TEST_WORKSPACE_NOT_READY", "Implementation workspace root could not be verified for automated testing."),
    branch: await gitLine(location.workspacePath, ["symbolic-ref", "--short", "HEAD"], options, "TEST_WORKSPACE_BRANCH_MISMATCH", "Implementation workspace is detached or on the wrong branch for automated testing."),
    headSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", "HEAD"], options, "TEST_WORKSPACE_NOT_READY", "Implementation workspace HEAD could not be verified for automated testing."), "Workspace HEAD"),
    branchHeadSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", `refs/heads/${location.branch}`], options, "TEST_WORKSPACE_NOT_READY", "Implementation branch HEAD could not be verified for automated testing."), "Implementation branch HEAD"),
    dirtyStatus: await gitText(location.workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"], options)
  }
}

function assertWorkspaceMatches(location, facts) {
  if (
    facts.topLevel !== location.workspacePath ||
    facts.branch !== location.branch ||
    facts.branchHeadSha !== facts.headSha
  ) {
    throw testRunnerError(
      "TEST_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or mismatched for automated testing."
    )
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

function assertImplementationEvidenceMatches(run, implementationSha) {
  const evidence = latestPhase6DImplementationEvidence(run)

  if (!evidence || evidence.sha !== implementationSha) {
    throw testRunnerError(
      "TEST_IMPLEMENTATION_EVIDENCE_MISMATCH",
      "Phase 6D implementation evidence SHA does not match the run head SHA."
    )
  }
}

function latestAutomatedTestEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.test) ? run.evidence.test : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (entry?.source === AUTOMATED_TEST_RUNNER_ID || entry?.metadata?.runner === AUTOMATED_TEST_RUNNER_ID) {
      return entry
    }
  }

  return null
}

function latestPassedAggregateEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.test) ? run.evidence.test : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      (entry?.source === AUTOMATED_TEST_RUNNER_ID || entry?.metadata?.runner === AUTOMATED_TEST_RUNNER_ID) &&
      entry?.metadata?.outcome === "passed"
    ) {
      return entry
    }
  }

  return null
}

function assertNoOpenTestAttempt(run) {
  const latest = latestAutomatedTestEvidence(run)

  if (latest?.metadata?.outcome === "testing_started") {
    throw testRunnerError(
      "TEST_RECONCILIATION_REQUIRED",
      "Previous automated test attempt requires reconciliation before retrying."
    )
  }

  if (run.status === "tests_in_progress" && !latest) {
    throw testRunnerError(
      "TEST_RECONCILIATION_REQUIRED",
      "Automated testing is already in progress and requires reconciliation before retrying."
    )
  }
}

function assertTestAttemptAvailable(run) {
  if (run.attempts.test >= MAX_AUTOMATED_TEST_ATTEMPTS) {
    throw testRunnerError(
      "TEST_ATTEMPT_LIMIT_REACHED",
      "Automated test attempt limit was reached; owner action is required."
    )
  }
}

async function reconcileWorkspaceForTesting(run, options) {
  const implementationSha = normalizeSha(run.headSha, "Run head SHA")
  const location = await resolveImplementationWorkspaceLocation(run, options)
  const facts = await workspaceFacts(location, options)

  assertWorkspaceMatches(location, facts)

  if (facts.headSha !== implementationSha || facts.branchHeadSha !== implementationSha) {
    throw testRunnerError(
      "TEST_WORKSPACE_HEAD_MISMATCH",
      "Implementation workspace HEAD does not match the run head SHA."
    )
  }

  if (facts.dirtyStatus) {
    throw testRunnerError(
      "TEST_WORKSPACE_DIRTY",
      "Implementation workspace has uncommitted changes; automated testing refused."
    )
  }

  return {
    location,
    facts,
    implementationSha
  }
}

function buildAttemptStartedEvidence(run, location, policy, execution) {
  return {
    kind: "test",
    sha: execution.implementationSha,
    source: AUTOMATED_TEST_RUNNER_ID,
    summary: "Automated test attempt reserved.",
    metadata: {
      project: run.project.id,
      runner: AUTOMATED_TEST_RUNNER_ID,
      attempt: execution.attempt,
      policyId: policy.policyId,
      policyHash: policy.policyHash,
      implSha: execution.implementationSha,
      startedAt: execution.startedAt,
      outcome: "testing_started",
      sandbox: AUTOMATED_TEST_SANDBOX_ID,
      backend: policy.sandbox.backend,
      platform: policy.sandbox.platform,
      network: "none",
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef
    }
  }
}

function buildStepEvidence(run, policy, execution, result) {
  return {
    kind: "test",
    sha: execution.implementationSha,
    source: AUTOMATED_TEST_RUNNER_ID,
    summary: "Automated test step completed with metadata-only result.",
    metadata: {
      project: run.project.id,
      runner: AUTOMATED_TEST_RUNNER_ID,
      attempt: execution.attempt,
      testId: result.testId,
      policyId: policy.policyId,
      policyHash: policy.policyHash,
      implSha: execution.implementationSha,
      exitClass: result.exitClass,
      durationMs: result.durationMs,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      outcome: result.outcome,
      sandbox: AUTOMATED_TEST_SANDBOX_ID,
      network: "none"
    }
  }
}

function buildAggregateEvidence(run, policy, execution, outcome, results, endedAt) {
  const durationMs = Math.max(0, Date.now() - execution.startedMs)
  const passed = results.filter((result) => result.outcome === "passed").length
  const failed = results.filter((result) => result.outcome === "failed").length
  const ambiguous = results.filter((result) => result.outcome === "ambiguous").length

  return {
    kind: "test",
    sha: execution.implementationSha,
    source: AUTOMATED_TEST_RUNNER_ID,
    summary: "Automated test policy completed with metadata-only aggregate result.",
    metadata: {
      project: run.project.id,
      runner: AUTOMATED_TEST_RUNNER_ID,
      attempt: execution.attempt,
      policyId: policy.policyId,
      policyHash: policy.policyHash,
      implSha: execution.implementationSha,
      outcome,
      startedAt: execution.startedAt,
      endedAt,
      durationMs,
      total: policy.steps.length,
      passed,
      failed,
      ambiguous,
      sandbox: AUTOMATED_TEST_SANDBOX_ID,
      network: "none"
    }
  }
}

async function reserveAutomatedTestAttempt(run, location, policy, execution, options) {
  const evidence = [buildAttemptStartedEvidence(run, location, policy, execution)]

  if (run.status === "implementation_ready") {
    return await transitionDevelopmentRun(run.runId, {
      expectedVersion: run.version,
      status: "tests_in_progress",
      branch: location.branch,
      headSha: execution.implementationSha,
      actor: AUTOMATED_TEST_RUNNER_ID,
      reason: "phase-6e-automated-testing-attempt",
      evidence
    }, options)
  }

  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "tests_in_progress",
    actor: AUTOMATED_TEST_RUNNER_ID,
    reason: "phase-6e-automated-testing-retry-attempt",
    incrementAttempt: true,
    evidence
  }, options)
}

async function recordDefinitiveTestOutcome(run, policy, execution, results, outcome, options) {
  const endedAt = timestamp(nowDate(options))
  const evidence = [
    ...results.map((result) => buildStepEvidence(run, policy, execution, result)),
    buildAggregateEvidence(run, policy, execution, outcome, results, endedAt)
  ]

  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "tests_in_progress",
    actor: AUTOMATED_TEST_RUNNER_ID,
    reason: `phase-6e-automated-testing-${outcome}`,
    evidence
  }, options)
}

function assertBoundedStepOutput(result, maxOutputBytes) {
  const stdoutBytes = Buffer.byteLength(String(result?.stdout ?? ""), "utf8")
  const stderrBytes = Buffer.byteLength(String(result?.stderr ?? ""), "utf8")

  if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
    throw ambiguousTestingError()
  }
}

async function executeTestStep(step, policy, location, options = {}) {
  const startedAt = timestamp(nowDate(options))
  const startedMs = Date.now()
  let result

  try {
    result = await runSandboxedCommand({
      kind: "test",
      testId: step.id,
      sandbox: policy.sandbox,
      executablePath: step.executablePath,
      args: [...step.args],
      cwd: location.workspacePath,
      timeoutMs: step.timeoutMs,
      maxOutputBytes: step.maxOutputBytes,
      env: policy.env
    }, options)
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw testRunnerError(
      "TEST_EXECUTION_FAILED",
      "Automated test command failed before a verified result was produced."
    )
  }

  if (isUncertainExecutionOutcome(result)) {
    throw ambiguousTestingError()
  }

  assertBoundedStepOutput(result, step.maxOutputBytes)

  const endedAt = timestamp(nowDate(options))
  const durationMs = Math.max(0, Date.now() - startedMs)
  const passed = result?.exitCode === 0

  if (!passed && !Number.isInteger(result?.exitCode)) {
    throw ambiguousTestingError()
  }

  return {
    testId: step.id,
    exitClass: passed ? "zero" : "nonzero",
    durationMs,
    startedAt,
    endedAt,
    outcome: passed ? "passed" : "failed"
  }
}

async function executePolicySteps(policy, location, options = {}) {
  const results = []

  for (const step of policy.steps) {
    const result = await executeTestStep(step, policy, location, options)
    results.push(result)

    if (result.outcome !== "passed") {
      return {
        outcome: "failed",
        results
      }
    }
  }

  return {
    outcome: "passed",
    results
  }
}

async function recordWorkspaceFailure(run, policy, execution, results, outcome, code, safeMessage, options) {
  await recordDefinitiveTestOutcome(run, policy, execution, results, outcome, options)
  throw testRunnerError(code, safeMessage)
}

async function executeAutomatedTestsInternal(runId, options = {}) {
  const expectedVersion = normalizeExpectedVersion(options.expectedVersion)
  const policyRegistry = normalizeTestPolicyRegistry(options.testPolicyRegistry)
  const run = await readDevelopmentRun(runId, options)

  if (run.version !== expectedVersion) {
    throw testRunnerError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  if (run.status !== "implementation_ready" && run.status !== "tests_in_progress") {
    throw testRunnerError(
      "TEST_RUN_NOT_READY",
      "Development run must be implementation_ready before automated testing."
    )
  }

  const implementationSha = normalizeSha(run.headSha, "Run head SHA")
  const policy = resolveProjectPolicy(run, policyRegistry)

  assertImplementationEvidenceMatches(run, implementationSha)
  assertNoOpenTestAttempt(run)
  assertTestAttemptAvailable(run)

  const preflight = await reconcileWorkspaceForTesting(run, options)

  await assertTestSandboxActive(policy, preflight.location, options)

  const startedAt = timestamp(nowDate(options))
  const nextAttempt = run.attempts.test + 1
  const execution = {
    attempt: nextAttempt,
    implementationSha,
    startedAt,
    startedMs: Date.now()
  }
  const attemptRun = await reserveAutomatedTestAttempt(run, preflight.location, policy, execution, options)
  const postReservation = await reconcileWorkspaceForTesting(attemptRun, options)
  const attemptExecution = {
    ...execution,
    attempt: attemptRun.attempts.test
  }
  let policyResult

  try {
    policyResult = await executePolicySteps(policy, postReservation.location, options)
  } catch (error) {
    if (error?.ambiguous === true || error?.code === "TEST_EXECUTION_AMBIGUOUS") {
      throw error
    }

    await recordDefinitiveTestOutcome(attemptRun, policy, attemptExecution, [], "failed", options)
    throw error
  }

  if (policyResult.outcome !== "passed") {
    await recordDefinitiveTestOutcome(attemptRun, policy, attemptExecution, policyResult.results, "failed", options)
    throw testRunnerError(
      "TEST_POLICY_FAILED",
      "One or more required automated tests failed; testing cannot pass for this implementation SHA."
    )
  }

  let finalCheck

  try {
    finalCheck = await reconcileWorkspaceForTesting(attemptRun, options)
  } catch (error) {
    if (error?.code === "TEST_WORKSPACE_DIRTY") {
      await recordWorkspaceFailure(
        attemptRun,
        policy,
        attemptExecution,
        policyResult.results,
        "workspace_dirty",
        "TEST_WORKSPACE_DIRTY",
        "Implementation workspace has uncommitted changes after automated testing; pass evidence was refused.",
        options
      )
    }

    if (error?.code === "TEST_WORKSPACE_HEAD_MISMATCH") {
      await recordWorkspaceFailure(
        attemptRun,
        policy,
        attemptExecution,
        policyResult.results,
        "workspace_changed",
        "TEST_WORKSPACE_HEAD_MISMATCH",
        "Implementation workspace HEAD changed during automated testing; pass evidence was refused.",
        options
      )
    }

    throw error
  }

  if (finalCheck.facts.headSha !== implementationSha) {
    await recordWorkspaceFailure(
      attemptRun,
      policy,
      attemptExecution,
      policyResult.results,
      "workspace_changed",
      "TEST_WORKSPACE_HEAD_MISMATCH",
      "Implementation workspace HEAD changed during automated testing; pass evidence was refused.",
      options
    )
  }

  const endedAt = timestamp(nowDate(options))
  const evidence = [
    ...policyResult.results.map((result) => buildStepEvidence(attemptRun, policy, attemptExecution, result)),
    buildAggregateEvidence(attemptRun, policy, attemptExecution, "passed", policyResult.results, endedAt)
  ]
  const transitioned = await transitionDevelopmentRun(attemptRun.runId, {
    expectedVersion: attemptRun.version,
    status: "tests_passed",
    branch: postReservation.location.branch,
    headSha: implementationSha,
    actor: AUTOMATED_TEST_RUNNER_ID,
    reason: "phase-6e-automated-testing-passed",
    evidence
  }, options)

  return {
    ok: true,
    outcome: "tests_passed",
    run: transitioned,
    testing: {
      project: attemptRun.project.id,
      repo: attemptRun.project.fullName,
      branch: postReservation.location.branch,
      workspaceId: postReservation.location.workspaceId,
      workspaceRef: postReservation.location.workspaceRef,
      implementationSha,
      policyId: policy.policyId,
      policyHash: policy.policyHash,
      attempt: attemptRun.attempts.test,
      requiredTests: policy.steps.length
    }
  }
}

async function reconcileAutomatedTestingInternal(runId, options = {}) {
  const run = await readDevelopmentRun(runId, options)
  const implementationSha = run.headSha ? normalizeSha(run.headSha, "Run head SHA") : null
  const latest = latestAutomatedTestEvidence(run)
  const passed = latestPassedAggregateEvidence(run)
  let location = null
  let facts = null
  let workspaceStatus = "missing"

  try {
    location = await resolveImplementationWorkspaceLocation(run, options)
    facts = await workspaceFacts(location, options)
    assertWorkspaceMatches(location, facts)
    workspaceStatus = "matching"

    if (implementationSha && facts.headSha !== implementationSha) {
      workspaceStatus = "head_changed"
    } else if (facts.dirtyStatus) {
      workspaceStatus = "dirty"
    }
  } catch {
    workspaceStatus = "mismatch"
  }

  const openAttempt = latest?.metadata?.outcome === "testing_started"
  const passEvidenceValid = (
    run.status === "tests_passed" &&
    passed?.sha === implementationSha &&
    passed?.metadata?.implSha === implementationSha &&
    workspaceStatus === "matching"
  )
  const status = passEvidenceValid
    ? "passed_valid"
    : openAttempt
      ? "open_attempt"
      : workspaceStatus

  return {
    ok: true,
    outcome: "automated_testing_reconciled",
    status,
    openAttempt,
    passEvidenceValid,
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id,
      headSha: implementationSha
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
      expectedHeadSha: implementationSha,
      dirty: Boolean(facts?.dirtyStatus)
    },
    evidence: {
      latestOutcome: latest?.metadata?.outcome || null,
      latestAttempt: latest?.metadata?.attempt || null,
      latestSha: latest?.sha || null
    }
  }
}

export async function executeAutomatedTests(runId, options = {}) {
  try {
    return await executeAutomatedTestsInternal(runId, options)
  } catch (error) {
    throw safeTestRunnerFailure(error)
  }
}

export async function reconcileAutomatedTesting(runId, options = {}) {
  try {
    return await reconcileAutomatedTestingInternal(runId, options)
  } catch (error) {
    throw safeTestRunnerFailure(error)
  }
}

export function formatDevelopmentTestRunnerError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO automated test runner error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO automated test runner error: unexpected local failure."
}
