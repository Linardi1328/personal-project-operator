import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  inspectImplementationWorkspace,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"

const execFileAsync = promisify(execFile)

export const CODEX_EXECUTION_ADAPTER_ID = "phase-6d-codex-execution-adapter"
export const MAX_CODEX_PROMPT_CHARS = 4000
export const MAX_CODEX_ARG_COUNT = 16
export const MAX_CODEX_ARG_CHARS = 160
export const MAX_CODEX_ENV_KEYS = 16
export const MAX_CODEX_ENV_VALUE_CHARS = 1000
export const MAX_CODEX_OUTPUT_BYTES = 32 * 1024
export const MAX_CODEX_TIMEOUT_MS = 10 * 60 * 1000
export const MIN_CODEX_TIMEOUT_MS = 1000

const shaPattern = /^[a-f0-9]{40}$/u
const envKeyPattern = /^[A-Z_][A-Z0-9_]{0,39}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const unsafePromptControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0008\u000B-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const forbiddenEnvKeyPattern = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|CONFIRM)/u

export class DevelopmentCodexExecutionAdapterError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentCodexExecutionAdapterError"
  }
}

function adapterError(code, safeMessage) {
  return new DevelopmentCodexExecutionAdapterError(code, safeMessage)
}

function safeAdapterFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return adapterError(
    "CODEX_ADAPTER_UNAVAILABLE",
    "Codex execution adapter is unavailable; no raw failure was stored."
  )
}

function rejectUnsafeText(value, code, safeMessage) {
  if (unsafeControlPattern.test(value) || sensitiveTextPattern.test(value)) {
    throw adapterError(code, safeMessage)
  }
}

function rejectUnsafePrompt(value) {
  if (unsafePromptControlPattern.test(value) || sensitiveTextPattern.test(value)) {
    throw adapterError(
      "CODEX_PROMPT_UNSAFE",
      "Codex prompt source is unsafe; execution refused."
    )
  }
}

function normalizeSafeText(value, {
  code,
  safeMessage,
  maxChars,
  required = true
}) {
  const normalized = String(value ?? "").trim()

  if ((required && !normalized) || normalized.length > maxChars || unsafeControlPattern.test(normalized)) {
    throw adapterError(code, safeMessage)
  }

  rejectUnsafeText(normalized, code, safeMessage)
  return normalized
}

function normalizeSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw adapterError(
      "CODEX_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
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

function boundedLines(lines, maxChars) {
  const output = []
  let size = 0

  for (const line of lines) {
    const nextSize = size + line.length + 1

    if (nextSize > maxChars) {
      break
    }

    output.push(line)
    size = nextSize
  }

  return output
}

function latestPlanningEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.planning) ? run.evidence.planning : []
  return evidence.at(-1) || null
}

function promptPlanningFacts(evidence) {
  if (!evidence) {
    return [
      "Planning evidence: none recorded."
    ]
  }

  const metadata = evidence.metadata || {}
  const facts = [
    `Planning evidence SHA: ${evidence.sha}.`
  ]

  if (metadata.planHash) {
    facts.push(`Planning plan hash: ${metadata.planHash}.`)
  }

  if (metadata.nextStage) {
    facts.push(`Planning next stage: ${metadata.nextStage}.`)
  }

  if (metadata.sourceCount !== undefined) {
    facts.push(`Planning source count: ${metadata.sourceCount}.`)
  }

  if (evidence.summary) {
    facts.push(`Planning summary: ${evidence.summary}.`)
  }

  return facts
}

export function buildCodexImplementationPrompt(run, workspace) {
  const task = normalizeSafeText(run?.task, {
    code: "CODEX_PROMPT_UNSAFE",
    safeMessage: "Codex prompt source is unsafe; execution refused.",
    maxChars: 1000
  })
  const projectId = normalizeSafeText(run?.project?.id, {
    code: "CODEX_PROMPT_UNSAFE",
    safeMessage: "Codex prompt source is unsafe; execution refused.",
    maxChars: 80
  })
  const repo = normalizeSafeText(run?.project?.fullName, {
    code: "CODEX_PROMPT_UNSAFE",
    safeMessage: "Codex prompt source is unsafe; execution refused.",
    maxChars: 120
  })
  const branch = normalizeSafeText(workspace?.branch || run?.branch, {
    code: "CODEX_PROMPT_UNSAFE",
    safeMessage: "Codex prompt source is unsafe; execution refused.",
    maxChars: 160
  })
  const workspaceRef = normalizeSafeText(workspace?.workspaceRef, {
    code: "CODEX_PROMPT_UNSAFE",
    safeMessage: "Codex prompt source is unsafe; execution refused.",
    maxChars: 160
  })
  const baseSha = normalizeSha(run?.baseSha, "Run base SHA")
  const startSha = normalizeSha(run?.headSha || run?.baseSha, "Run head SHA")
  const planningFacts = promptPlanningFacts(latestPlanningEvidence(run)).map((line) => {
    normalizeSafeText(line, {
      code: "CODEX_PROMPT_UNSAFE",
      safeMessage: "Codex prompt source is unsafe; execution refused.",
      maxChars: 500
    })
    return line
  })
  const lines = boundedLines([
    "You are executing one bounded Personal Project Operator implementation task.",
    `Project: ${projectId}`,
    `Repository: ${repo}`,
    `Isolated branch: ${branch}`,
    `Workspace reference: ${workspaceRef}`,
    `Base SHA: ${baseSha}`,
    `Expected starting HEAD: ${startSha}`,
    "",
    "Task:",
    task,
    "",
    ...planningFacts,
    "",
    "Required boundaries:",
    "- Work only inside the current isolated branch and worktree.",
    "- Do not push to any remote.",
    "- Do not merge, rebase, reset, cherry-pick, or change repository history outside the current isolated branch.",
    "- Do not deploy, restart services, or change production infrastructure.",
    "- Do not modify credentials, tokens, secrets, authentication settings, or confirmation values.",
    "- Do not run unrelated work, destructive cleanup, broad refactors, or changes outside the task scope.",
    "- Leave a local commit on the current isolated branch when the implementation is complete.",
    "",
    "Return concise completion notes only. The adapter will independently verify Git state and will ignore prose claims of success."
  ], MAX_CODEX_PROMPT_CHARS)
  const prompt = `${lines.join("\n")}\n`

  if (prompt.length > MAX_CODEX_PROMPT_CHARS) {
    throw adapterError(
      "CODEX_PROMPT_TOO_LARGE",
      "Codex prompt exceeds the adapter size limit."
    )
  }

  rejectUnsafePrompt(prompt)

  return prompt
}

function normalizeExecutablePath(value) {
  const executablePath = normalizeSafeText(value, {
    code: "CODEX_CONFIG_INVALID",
    safeMessage: "Codex executable configuration is invalid.",
    maxChars: 240
  })

  if (!isAbsolute(executablePath) || executablePath !== resolvePath(executablePath)) {
    throw adapterError(
      "CODEX_CONFIG_INVALID",
      "Codex executable configuration is invalid."
    )
  }

  return executablePath
}

function normalizeCodexArgs(args = []) {
  if (!Array.isArray(args) || args.length > MAX_CODEX_ARG_COUNT) {
    throw adapterError(
      "CODEX_CONFIG_INVALID",
      "Codex argv configuration is invalid."
    )
  }

  return args.map((entry) => normalizeSafeText(entry, {
    code: "CODEX_CONFIG_INVALID",
    safeMessage: "Codex argv configuration is invalid.",
    maxChars: MAX_CODEX_ARG_CHARS
  }))
}

function normalizeCodexEnv(env = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw adapterError(
      "CODEX_CONFIG_INVALID",
      "Codex environment configuration is invalid."
    )
  }

  const entries = Object.entries(env)

  if (entries.length > MAX_CODEX_ENV_KEYS) {
    throw adapterError(
      "CODEX_CONFIG_INVALID",
      "Codex environment configuration is invalid."
    )
  }

  const normalized = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    TERM: "dumb",
    NO_COLOR: "1"
  }

  for (const [key, value] of entries) {
    if (!envKeyPattern.test(key) || forbiddenEnvKeyPattern.test(key)) {
      throw adapterError(
        "CODEX_CONFIG_INVALID",
        "Codex environment configuration is invalid."
      )
    }

    normalized[key] = normalizeSafeText(value, {
      code: "CODEX_CONFIG_INVALID",
      safeMessage: "Codex environment configuration is invalid.",
      maxChars: MAX_CODEX_ENV_VALUE_CHARS,
      required: false
    })
  }

  return normalized
}

function normalizeTimeoutMs(value) {
  const timeoutMs = value === undefined ? MAX_CODEX_TIMEOUT_MS : value

  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_CODEX_TIMEOUT_MS || timeoutMs > MAX_CODEX_TIMEOUT_MS) {
    throw adapterError(
      "CODEX_CONFIG_INVALID",
      "Codex timeout configuration is invalid."
    )
  }

  return timeoutMs
}

function normalizeCodexConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw adapterError(
      "CODEX_CONFIG_REQUIRED",
      "Trusted local Codex configuration is required."
    )
  }

  return {
    executablePath: normalizeExecutablePath(config.executablePath),
    args: normalizeCodexArgs(config.args || []),
    env: normalizeCodexEnv(config.env || {}),
    timeoutMs: normalizeTimeoutMs(config.timeoutMs)
  }
}

function isUncertainExecutionOutcome(value) {
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

function ambiguousExecutionError() {
  const error = adapterError(
    "CODEX_EXECUTION_AMBIGUOUS",
    "Codex execution outcome is ambiguous; reconcile workspace state before retrying."
  )
  error.ambiguous = true
  return error
}

function assertBoundedCodexOutput(result) {
  const stdoutBytes = Buffer.byteLength(String(result?.stdout ?? ""), "utf8")
  const stderrBytes = Buffer.byteLength(String(result?.stderr ?? ""), "utf8")

  if (stdoutBytes > MAX_CODEX_OUTPUT_BYTES || stderrBytes > MAX_CODEX_OUTPUT_BYTES) {
    throw ambiguousExecutionError()
  }
}

async function runCodexProcess(invocation) {
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.executablePath, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    })

    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    let stderrBytes = 0
    let killed = false
    let settled = false
    const timeout = setTimeout(() => {
      killed = true
      child.kill("SIGTERM")
    }, invocation.timeoutMs)

    const settle = (callback, value) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length

      if (stdoutBytes > MAX_CODEX_OUTPUT_BYTES) {
        killed = true
        child.kill("SIGTERM")
        return
      }

      stdout += chunk.toString("utf8")
    })

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length

      if (stderrBytes > MAX_CODEX_OUTPUT_BYTES) {
        killed = true
        child.kill("SIGTERM")
        return
      }

      stderr += chunk.toString("utf8")
    })

    child.on("error", (error) => {
      settle(reject, error)
    })

    child.on("close", (exitCode, signal) => {
      settle(resolve, {
        exitCode,
        signal,
        killed,
        timedOut: killed,
        ambiguous: killed || typeof signal === "string",
        stdout,
        stderr
      })
    })

    child.stdin.end(invocation.prompt, "utf8")
  })
}

async function invokeCodex(config, invocation, options = {}) {
  const runner = options.codexRunner || runCodexProcess
  const boundedInvocation = {
    executablePath: config.executablePath,
    args: [...config.args],
    cwd: invocation.cwd,
    prompt: invocation.prompt,
    promptHash: invocation.promptHash,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: MAX_CODEX_OUTPUT_BYTES,
    env: config.env,
    shell: false
  }

  let result

  try {
    result = await runner(boundedInvocation)
  } catch (error) {
    if (isUncertainExecutionOutcome(error)) {
      throw ambiguousExecutionError()
    }

    throw adapterError(
      "CODEX_EXECUTION_FAILED",
      "Codex execution failed before a verified implementation was produced."
    )
  }

  if (isUncertainExecutionOutcome(result)) {
    throw ambiguousExecutionError()
  }

  assertBoundedCodexOutput(result)

  if (!Number.isInteger(result?.exitCode) || result.exitCode !== 0) {
    throw adapterError(
      "CODEX_EXECUTION_FAILED",
      "Codex execution exited without a verified implementation."
    )
  }

  return {
    exitCode: 0
  }
}

function assertGitArgs(args) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || !entry)) {
    throw adapterError(
      "CODEX_GIT_OPERATION_REFUSED",
      "Git verification operation is not approved for the Codex adapter."
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
      (command === "remote" && args.length === 5 && subcommand === "get-url" && args[4] === "origin") ||
      (command === "for-each-ref" && args.length === 5 && subcommand === "refs/remotes" && args[4] === "--format=%(refname):%(objectname)") ||
      (command === "rev-list" && args.length === 6 && subcommand === "--ancestry-path" && args[4] === "--count" && /^[a-f0-9]{40}\.\.HEAD$/u.test(args[5])) ||
      (command === "diff" && args.length === 5 && subcommand === "--name-only" && /^[a-f0-9]{40}\.\.HEAD$/u.test(args[4])) ||
      (command === "status" && args.length === 5 && subcommand === "--porcelain=v1" && args[4] === "--untracked-files=all")
    )
  )

  if (!exactShape) {
    throw adapterError(
      "CODEX_GIT_OPERATION_REFUSED",
      "Git verification operation is not approved for the Codex adapter."
    )
  }
}

async function runGit(args, options = {}) {
  assertGitArgs(args)

  const runner = options.gitRunner || (async (argv) => {
    const result = await execFileAsync("git", argv, {
      encoding: "utf8",
      maxBuffer: MAX_CODEX_OUTPUT_BYTES,
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
  } catch (error) {
    throw adapterError(
      "CODEX_GIT_VERIFY_FAILED",
      "Git verification failed; no raw Git output was stored."
    )
  }
}

function gitOutputLine(result, code, safeMessage) {
  const output = String(result.stdout ?? "").trim()

  if (!output || output.length > MAX_CODEX_OUTPUT_BYTES || /[\u0000-\u001f\u007f]/u.test(output)) {
    throw adapterError(code, safeMessage)
  }

  return output.split(/\r?\n/u)[0].trim()
}

async function gitLine(cwd, args, options, code, safeMessage) {
  try {
    return gitOutputLine(await runGit(["-C", cwd, ...args], options), code, safeMessage)
  } catch (error) {
    if (error?.code === "CODEX_GIT_VERIFY_FAILED") {
      throw adapterError(code, safeMessage)
    }

    throw error
  }
}

async function gitText(cwd, args, options) {
  const result = await runGit(["-C", cwd, ...args], options)
  const output = String(result.stdout ?? "")

  if (Buffer.byteLength(output, "utf8") > MAX_CODEX_OUTPUT_BYTES || unsafePromptControlPattern.test(output)) {
    throw adapterError(
      "CODEX_GIT_VERIFY_FAILED",
      "Git verification output is invalid."
    )
  }

  return output.trim()
}

function hashRemoteRefs(output) {
  return sha256Text(output.split(/\r?\n/u).filter(Boolean).sort().join("\n"))
}

async function sourceFacts(location, options) {
  return {
    topLevel: await gitLine(location.sourceRepoPath, ["rev-parse", "--show-toplevel"], options, "CODEX_SOURCE_CHANGED", "Source repository state could not be verified."),
    branch: await gitLine(location.sourceRepoPath, ["symbolic-ref", "--short", "HEAD"], options, "CODEX_SOURCE_CHANGED", "Source repository branch could not be verified."),
    headSha: normalizeSha(await gitLine(location.sourceRepoPath, ["rev-parse", "HEAD"], options, "CODEX_SOURCE_CHANGED", "Source repository head could not be verified."), "Source repository HEAD"),
    remoteUrl: await gitLine(location.sourceRepoPath, ["remote", "get-url", "origin"], options, "CODEX_SOURCE_CHANGED", "Source repository remote could not be verified."),
    remoteRefsHash: hashRemoteRefs(await gitText(location.sourceRepoPath, ["for-each-ref", "refs/remotes", "--format=%(refname):%(objectname)"], options))
  }
}

async function workspaceFacts(location, options) {
  const info = await stat(location.workspacePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw adapterError(
        "CODEX_WORKSPACE_NOT_READY",
        "Implementation workspace is missing or not verified."
      )
    }

    throw error
  })

  if (!info.isDirectory()) {
    throw adapterError(
      "CODEX_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or not verified."
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
    throw adapterError(
      "CODEX_WORKSPACE_NOT_READY",
      "Implementation workspace is outside the managed root."
    )
  }

  return {
    topLevel: await gitLine(location.workspacePath, ["rev-parse", "--show-toplevel"], options, "CODEX_WORKSPACE_NOT_READY", "Implementation workspace root could not be verified."),
    branch: await gitLine(location.workspacePath, ["symbolic-ref", "--short", "HEAD"], options, "CODEX_WORKSPACE_DETACHED", "Implementation workspace is detached or on the wrong branch."),
    headSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", "HEAD"], options, "CODEX_WORKSPACE_NOT_READY", "Implementation workspace HEAD could not be verified."), "Workspace HEAD"),
    branchHeadSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", `refs/heads/${location.branch}`], options, "CODEX_WORKSPACE_NOT_READY", "Implementation branch HEAD could not be verified."), "Implementation branch HEAD"),
    dirtyStatus: await gitText(location.workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"], options)
  }
}

function assertSourceUnchanged(before, after) {
  if (
    before.topLevel !== after.topLevel ||
    before.branch !== after.branch ||
    before.headSha !== after.headSha ||
    before.remoteUrl !== after.remoteUrl ||
    before.remoteRefsHash !== after.remoteRefsHash
  ) {
    throw adapterError(
      "CODEX_SOURCE_CHANGED",
      "Source repository or remote-tracking state changed during Codex execution."
    )
  }
}

function assertWorkspaceMatches(location, facts) {
  if (
    facts.topLevel !== location.workspacePath ||
    facts.branch !== location.branch ||
    facts.branchHeadSha !== facts.headSha
  ) {
    throw adapterError(
      "CODEX_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or mismatched."
    )
  }
}

async function verifyImplementationResult(run, location, sourceBefore, expectedStartSha, options) {
  const sourceAfter = await sourceFacts(location, options)
  assertSourceUnchanged(sourceBefore, sourceAfter)

  const facts = await workspaceFacts(location, options)
  assertWorkspaceMatches(location, facts)

  if (facts.dirtyStatus) {
    throw adapterError(
      "CODEX_IMPLEMENTATION_INVALID",
      "Codex left uncommitted workspace changes; no implementation evidence was recorded."
    )
  }

  if (facts.headSha === expectedStartSha) {
    throw adapterError(
      "CODEX_NO_IMPLEMENTATION",
      "Codex produced no local implementation commit."
    )
  }

  const ancestorCountText = await gitLine(location.workspacePath, [
    "rev-list",
    "--ancestry-path",
    "--count",
    `${run.baseSha}..HEAD`
  ], options, "CODEX_IMPLEMENTATION_INVALID", "Implementation HEAD is not descended from the run base SHA.")
  const ancestorCount = Number.parseInt(ancestorCountText, 10)

  if (!Number.isInteger(ancestorCount) || ancestorCount <= 0) {
    throw adapterError(
      "CODEX_IMPLEMENTATION_INVALID",
      "Implementation HEAD is not descended from the run base SHA."
    )
  }

  const changedFiles = (await gitText(location.workspacePath, [
    "diff",
    "--name-only",
    `${expectedStartSha}..HEAD`
  ], options)).split(/\r?\n/u).filter(Boolean)

  if (changedFiles.length === 0) {
    throw adapterError(
      "CODEX_NO_IMPLEMENTATION",
      "Codex produced no meaningful local implementation change."
    )
  }

  return {
    headSha: facts.headSha,
    changedFileCount: changedFiles.length,
    sourceBranch: sourceAfter.branch
  }
}

function buildImplementationEvidence(run, location, verified, execution) {
  return {
    kind: "implementation",
    sha: verified.headSha,
    source: CODEX_EXECUTION_ADAPTER_ID,
    summary: "Codex implementation completed and verified locally.",
    metadata: {
      project: run.project.id,
      repo: run.project.fullName,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef,
      adapter: CODEX_EXECUTION_ADAPTER_ID,
      attempt: run.attempts.implementation,
      promptHash: execution.promptHash,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      outcome: "implementation_ready",
      changedFiles: verified.changedFileCount
    }
  }
}

async function reconcileBeforeExecution(runId, run, options) {
  const inspection = await inspectImplementationWorkspace(runId, options)

  if (!inspection.exists || !inspection.matches || inspection.status !== "matching") {
    throw adapterError(
      "CODEX_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or mismatched; reconcile before Codex execution."
    )
  }

  const location = await resolveImplementationWorkspaceLocation(run, options)

  if (
    inspection.workspace.project !== location.project ||
    inspection.workspace.repo !== location.repo ||
    inspection.workspace.branch !== location.branch ||
    inspection.workspace.workspaceId !== location.workspaceId ||
    inspection.workspace.workspaceRef !== location.workspaceRef
  ) {
    throw adapterError(
      "CODEX_WORKSPACE_NOT_READY",
      "Implementation workspace is missing or mismatched; reconcile before Codex execution."
    )
  }

  const facts = await workspaceFacts(location, options)
  assertWorkspaceMatches(location, facts)

  const expectedStartSha = normalizeSha(run.headSha || run.baseSha, "Expected implementation start SHA")

  if (facts.headSha !== expectedStartSha || inspection.facts.headSha !== expectedStartSha) {
    throw adapterError(
      "CODEX_WORKSPACE_HEAD_MISMATCH",
      "Implementation workspace HEAD does not match the run state."
    )
  }

  if (facts.dirtyStatus) {
    throw adapterError(
      "CODEX_WORKSPACE_NOT_READY",
      "Implementation workspace has uncommitted changes before Codex execution."
    )
  }

  return {
    location,
    expectedStartSha
  }
}

async function executeCodexImplementationInternal(runId, options = {}) {
  const expectedVersion = options.expectedVersion

  if (!Number.isInteger(expectedVersion)) {
    throw adapterError(
      "CODEX_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required."
    )
  }

  const config = normalizeCodexConfig(options.codexConfig)
  const run = await readDevelopmentRun(runId, options)

  if (run.status !== "implementation_in_progress") {
    throw adapterError(
      "CODEX_RUN_NOT_IMPLEMENTING",
      "Development run must be implementation_in_progress before Codex execution."
    )
  }

  if (run.version !== expectedVersion) {
    throw adapterError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  const { location, expectedStartSha } = await reconcileBeforeExecution(runId, run, options)
  const sourceBefore = await sourceFacts(location, options)
  const prompt = buildCodexImplementationPrompt(run, location)
  const promptHash = sha256Text(prompt)
  const startedAt = timestamp(nowDate(options))

  await invokeCodex(config, {
    cwd: location.workspacePath,
    prompt,
    promptHash
  }, options)

  const endedAt = timestamp(nowDate(options))
  const verified = await verifyImplementationResult(run, location, sourceBefore, expectedStartSha, options)
  const evidence = buildImplementationEvidence(run, location, verified, {
    promptHash,
    startedAt,
    endedAt
  })
  const transitioned = await transitionDevelopmentRun(run.runId, {
    expectedVersion,
    status: "implementation_ready",
    branch: location.branch,
    headSha: verified.headSha,
    actor: CODEX_EXECUTION_ADAPTER_ID,
    reason: "phase-6d-codex-implementation-ready",
    evidence: [evidence]
  }, options)

  return {
    ok: true,
    outcome: "implementation_ready",
    run: transitioned,
    implementation: {
      project: run.project.id,
      repo: run.project.fullName,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef,
      headSha: verified.headSha,
      promptHash,
      changedFileCount: verified.changedFileCount
    }
  }
}

async function reconcileCodexExecutionInternal(runId, options = {}) {
  const run = await readDevelopmentRun(runId, options)
  const location = await resolveImplementationWorkspaceLocation(run, options)
  const expectedStartSha = normalizeSha(run.headSha || run.baseSha, "Expected implementation start SHA")

  let facts = null
  let status = "missing"

  try {
    facts = await workspaceFacts(location, options)
    assertWorkspaceMatches(location, facts)

    if (facts.headSha === expectedStartSha) {
      status = "unchanged"
    } else {
      const ancestorCountText = await gitLine(location.workspacePath, [
        "rev-list",
        "--ancestry-path",
        "--count",
        `${run.baseSha}..HEAD`
      ], options, "CODEX_RECONCILE_FAILED", "Codex execution reconciliation failed.")
      const ancestorCount = Number.parseInt(ancestorCountText, 10)
      status = Number.isInteger(ancestorCount) && ancestorCount > 0 ? "advanced" : "mismatched"
    }
  } catch {
    status = "mismatched"
  }

  return {
    ok: true,
    outcome: "codex_execution_reconciled",
    status,
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id
    },
    workspace: {
      project: location.project,
      repo: location.repo,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef
    },
    facts: {
      branch: facts?.branch || null,
      headSha: facts?.headSha || null,
      expectedStartSha
    }
  }
}

export async function executeCodexImplementation(runId, options = {}) {
  try {
    return await executeCodexImplementationInternal(runId, options)
  } catch (error) {
    throw safeAdapterFailure(error)
  }
}

export async function reconcileCodexExecution(runId, options = {}) {
  try {
    return await reconcileCodexExecutionInternal(runId, options)
  } catch (error) {
    throw safeAdapterFailure(error)
  }
}

export function formatDevelopmentCodexExecutionAdapterError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO Codex execution adapter error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO Codex execution adapter error: unexpected local failure."
}
