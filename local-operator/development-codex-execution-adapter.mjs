import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { chmod, mkdir, realpath, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  recordDevelopmentRunProgress,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  inspectImplementationWorkspace,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"

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
export const MAX_CODEX_IMPLEMENTATION_ATTEMPTS = 10
export const CODEX_EXECUTION_POLICY_STORE_DIR = "codex-execution-policy"
export const CODEX_EXECUTION_SANDBOX_ID = "phase-6d-no-outbound-network-sandbox"
export const PHASE_6F_HARDENING_ORCHESTRATOR_ID = "phase-6f-bounded-hardening-orchestrator"
export const PHASE_6F_INDEPENDENT_REVIEW_AGENT_ID = "phase-6f-independent-review-agent"
export const PHASE_6G_REMOTE_PR_REVIEW_AGENT_ID = "phase-6g-remote-pr-review-agent"
export const PHASE_6F_REVIEW_FINDINGS_OUTCOME = "review_findings"
export const CODEX_SANDBOX_BACKENDS = Object.freeze({
  MACOS_SANDBOX_EXEC: "macos-sandbox-exec",
  LINUX_NETWORK_NAMESPACE: "linux-network-namespace"
})

const shaPattern = /^[a-f0-9]{40}$/u
const envKeyPattern = /^[A-Z_][A-Z0-9_]{0,39}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const unsafePromptControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0008\u000B-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const forbiddenEnvKeyPattern = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|CONFIRM|ASKPASS|GIT_CONFIG|GIT_SSH|SSH_AUTH_SOCK)/u
const defaultExecutionPath = "/usr/bin:/bin:/usr/sbin:/sbin"
const linuxDirectSshExecutablePath = "/usr/bin/ssh"
const hardeningReviewSources = new Set([
  PHASE_6F_INDEPENDENT_REVIEW_AGENT_ID,
  PHASE_6G_REMOTE_PR_REVIEW_AGENT_ID
])
const noOutboundNetworkSandboxProfile = `(version 1)
(allow default)
(deny network*)
`

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

function configuredWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PPO_WRITE_DATA_DIR
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function promptCharSize(lines) {
  return `${lines.join("\n")}\n`.length
}

function assertPromptLinesFit(lines) {
  if (promptCharSize(lines) > MAX_CODEX_PROMPT_CHARS) {
    throw adapterError(
      "CODEX_PROMPT_TOO_LARGE",
      "Codex prompt exceeds the adapter size limit."
    )
  }
}

function optionalLineFits(lines, line, requiredTail) {
  return promptCharSize([...lines, line, ...requiredTail]) <= MAX_CODEX_PROMPT_CHARS
}

function appendOptionalLines(lines, optionalLines, requiredTail) {
  for (const line of optionalLines) {
    if (!optionalLineFits(lines, line, requiredTail)) {
      return
    }

    lines.push(line)
  }
}

function appendOptionalTextSection(lines, sectionPrefix, text, requiredTail) {
  if (promptCharSize([...lines, ...sectionPrefix, text, ...requiredTail]) <= MAX_CODEX_PROMPT_CHARS) {
    lines.push(...sectionPrefix, text)
    return
  }

  if (promptCharSize([...lines, ...sectionPrefix, ...requiredTail]) > MAX_CODEX_PROMPT_CHARS) {
    return
  }

  const suffix = " [truncated]"
  const available = MAX_CODEX_PROMPT_CHARS - promptCharSize([...lines, ...sectionPrefix, ...requiredTail]) - 1

  if (available <= suffix.length + 20) {
    return
  }

  lines.push(...sectionPrefix, `${text.slice(0, available - suffix.length)}${suffix}`)
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

function latestHardeningStartedEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.implementation) ? run.evidence.implementation : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      entry?.source === PHASE_6F_HARDENING_ORCHESTRATOR_ID &&
      entry?.metadata?.orchestrator === PHASE_6F_HARDENING_ORCHESTRATOR_ID &&
      entry?.metadata?.outcome === "hardening_started"
    ) {
      return entry
    }
  }

  return null
}

function latestReviewFindingsEvidence(run, reviewedSha, attempt) {
  const evidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      hardeningReviewSources.has(entry?.source) &&
      hardeningReviewSources.has(entry?.metadata?.reviewer) &&
      entry?.metadata?.outcome === PHASE_6F_REVIEW_FINDINGS_OUTCOME &&
      entry?.sha === reviewedSha &&
      entry?.metadata?.reviewedSha === reviewedSha &&
      entry?.metadata?.attempt === attempt
    ) {
      return entry
    }
  }

  return null
}

function normalizeHardeningItems(value, fieldName) {
  if (!Array.isArray(value) || value.length > 5) {
    throw adapterError(
      "CODEX_PROMPT_UNSAFE",
      "Codex prompt source is unsafe; execution refused."
    )
  }

  return value.map((entry) => normalizeSafeText(entry, {
    code: "CODEX_PROMPT_UNSAFE",
    safeMessage: "Codex prompt source is unsafe; execution refused.",
    maxChars: fieldName === "testsRequired" ? 160 : 160
  }))
}

function deriveHardeningRemediationContext(run) {
  const started = latestHardeningStartedEvidence(run)

  if (!started) {
    return null
  }

  const reviewedSha = normalizeSha(started.metadata?.sourceReviewSha, "Hardening source review SHA")

  if (started.sha !== reviewedSha || reviewedSha !== normalizeSha(run.headSha, "Run head SHA")) {
    throw adapterError(
      "CODEX_PROMPT_UNSAFE",
      "Codex prompt source is unsafe; execution refused."
    )
  }

  const attempt = started.metadata?.reviewAttempt

  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw adapterError(
      "CODEX_PROMPT_UNSAFE",
      "Codex prompt source is unsafe; execution refused."
    )
  }

  const findings = latestReviewFindingsEvidence(run, reviewedSha, attempt)

  if (!findings || findings.metadata?.decision !== "CHANGES_REQUESTED" || findings.metadata?.mergeAllowed !== false) {
    throw adapterError(
      "CODEX_PROMPT_UNSAFE",
      "Codex prompt source is unsafe; execution refused."
    )
  }

  if (!Number.isInteger(started.metadata?.round) || started.metadata.round <= 0 || started.metadata.round > 3) {
    throw adapterError(
      "CODEX_PROMPT_UNSAFE",
      "Codex prompt source is unsafe; execution refused."
    )
  }

  const blockers = normalizeHardeningItems(findings.metadata?.blockerItems, "blockers")
  const securityFindings = normalizeHardeningItems(findings.metadata?.securityItems, "securityFindings")
  const testsRequired = normalizeHardeningItems(findings.metadata?.testItems, "testsRequired")
  const expectedHash = sha256Text(stableStringify({
    reviewedSha,
    decision: "CHANGES_REQUESTED",
    blockers,
    securityFindings,
    testsRequired
  }))

  if (
    blockers.length + securityFindings.length <= 0 ||
    findings.metadata?.blockers !== blockers.length ||
    findings.metadata?.securityFindings !== securityFindings.length ||
    findings.metadata?.testsRequired !== testsRequired.length ||
    started.metadata?.blockerCount !== blockers.length ||
    started.metadata?.securityFindingCount !== securityFindings.length ||
    started.metadata?.testRequirementCount !== testsRequired.length ||
    findings.metadata?.findingHash !== expectedHash ||
    started.metadata?.remediationHash !== expectedHash
  ) {
    throw adapterError(
      "CODEX_PROMPT_UNSAFE",
      "Codex prompt source is unsafe; execution refused."
    )
  }

  return {
    round: started.metadata.round,
    sourceReviewSha: reviewedSha,
    reviewAttempt: attempt,
    remediationHash: expectedHash,
    blockers,
    securityFindings,
    testsRequired
  }
}

function hardeningPromptFacts(context) {
  if (!context) {
    return []
  }

  const facts = [
    "",
    "Phase 6F hardening context:",
    `Round: ${context.round}.`,
    `Reviewed SHA: ${context.sourceReviewSha}.`,
    "Blockers:",
    ...context.blockers.map((entry, index) => `${index + 1}. ${entry}`),
    "Security findings:",
    ...(context.securityFindings.length > 0
      ? context.securityFindings.map((entry, index) => `${index + 1}. ${entry}`)
      : ["None."]),
    "Tests required:",
    ...(context.testsRequired.length > 0
      ? context.testsRequired.map((entry, index) => `${index + 1}. ${entry}`)
      : ["None."]),
    "",
    "Hardening boundaries:",
    "- Implement only the minimal remediation required by the validated review evidence.",
    "- Do not treat remediation completion as test pass or review approval.",
    "- Leave a new local descendant commit on the current isolated branch."
  ]

  return facts.map((line) => normalizeSafeText(line, {
    code: "CODEX_PROMPT_UNSAFE",
    safeMessage: "Codex prompt source is unsafe; execution refused.",
    maxChars: 500,
    required: false
  }))
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
  const hardeningContext = deriveHardeningRemediationContext(run)
  const requiredHead = [
    "You are executing one bounded Personal Project Operator implementation task.",
    `Project: ${projectId}`,
    `Repository: ${repo}`,
    `Isolated branch: ${branch}`,
    `Workspace reference: ${workspaceRef}`,
    `Base SHA: ${baseSha}`,
    `Expected starting HEAD: ${startSha}`,
  ]
  const requiredTail = [
    ...hardeningPromptFacts(hardeningContext),
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
  ]

  assertPromptLinesFit([...requiredHead, ...requiredTail])

  const lines = [...requiredHead]
  appendOptionalTextSection(lines, ["", "Task:"], task, requiredTail)
  appendOptionalLines(lines, ["", ...planningFacts], requiredTail)
  lines.push(...requiredTail)
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

function normalizeGitExecutablePath(value) {
  return normalizeExecutablePath(value)
}

function normalizeSandboxPath(value) {
  const sandboxPath = normalizeSafeText(value, {
    code: "CODEX_SANDBOX_REQUIRED",
    safeMessage: "Codex execution requires a trusted no-outbound-network process sandbox.",
    maxChars: 240
  })

  if (!isAbsolute(sandboxPath) || sandboxPath !== resolvePath(sandboxPath)) {
    throw adapterError(
      "CODEX_SANDBOX_REQUIRED",
      "Codex execution requires a trusted no-outbound-network process sandbox."
    )
  }

  return sandboxPath
}

function normalizeSandboxPositiveInteger(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 2147483647) {
    throw adapterError(
      "CODEX_SANDBOX_REQUIRED",
      "Codex execution requires a trusted no-outbound-network process sandbox."
    )
  }

  return value
}

function requireSandboxTrue(value) {
  if (value !== true) {
    throw adapterError(
      "CODEX_SANDBOX_REQUIRED",
      "Codex execution requires a trusted no-outbound-network process sandbox."
    )
  }

  return true
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

function normalizeRemoteGitWritePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw adapterError(
      "CODEX_REMOTE_POLICY_REQUIRED",
      "Codex remote Git write denial policy is required."
    )
  }

  const mode = normalizeSafeText(policy.mode, {
    code: "CODEX_REMOTE_POLICY_REQUIRED",
    safeMessage: "Codex remote Git write denial policy is required.",
    maxChars: 40
  })
  const enforcement = normalizeSafeText(policy.enforcement, {
    code: "CODEX_REMOTE_POLICY_REQUIRED",
    safeMessage: "Codex remote Git write denial policy is required.",
    maxChars: 80
  })

  if (mode !== "deny" || enforcement !== "adapter-git-wrapper") {
    throw adapterError(
      "CODEX_REMOTE_POLICY_REQUIRED",
      "Codex remote Git write denial policy is required."
    )
  }

  return {
    mode,
    enforcement
  }
}

function normalizeExecutionSandbox(sandbox) {
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) {
    throw adapterError(
      "CODEX_SANDBOX_REQUIRED",
      "Codex execution requires a trusted no-outbound-network process sandbox."
    )
  }

  const type = normalizeSafeText(sandbox.type, {
    code: "CODEX_SANDBOX_REQUIRED",
    safeMessage: "Codex execution requires a trusted no-outbound-network process sandbox.",
    maxChars: 80
  })
  const network = normalizeSafeText(sandbox.network, {
    code: "CODEX_SANDBOX_REQUIRED",
    safeMessage: "Codex execution requires a trusted no-outbound-network process sandbox.",
    maxChars: 40
  })
  const enforcement = normalizeSafeText(sandbox.enforcement, {
    code: "CODEX_SANDBOX_REQUIRED",
    safeMessage: "Codex execution requires a trusted no-outbound-network process sandbox.",
    maxChars: 80
  })
  const platform = normalizeSafeText(sandbox.platform, {
    code: "CODEX_SANDBOX_REQUIRED",
    safeMessage: "Codex execution requires a trusted no-outbound-network process sandbox.",
    maxChars: 20
  })

  if (network !== "none") {
    throw adapterError(
      "CODEX_SANDBOX_REQUIRED",
      "Codex execution requires a trusted no-outbound-network process sandbox."
    )
  }

  if (type === CODEX_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC) {
    if (platform !== "darwin" || enforcement !== "os-process") {
      throw adapterError(
        "CODEX_SANDBOX_REQUIRED",
        "Codex execution requires a trusted no-outbound-network process sandbox."
      )
    }

    return {
      type,
      backend: CODEX_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
      platform,
      network,
      enforcement,
      executablePath: normalizeSandboxPath(sandbox.executablePath)
    }
  }

  if (type === CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE) {
    if (platform !== "linux" || enforcement !== "os-network-namespace") {
      throw adapterError(
        "CODEX_SANDBOX_REQUIRED",
        "Codex execution requires a trusted no-outbound-network process sandbox."
      )
    }

    return {
      type,
      backend: CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
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

  throw adapterError(
    "CODEX_SANDBOX_REQUIRED",
    "Codex execution requires a trusted no-outbound-network process sandbox."
  )
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
    gitExecutablePath: normalizeGitExecutablePath(config.gitExecutablePath),
    args: normalizeCodexArgs(config.args || []),
    env: normalizeCodexEnv(config.env || {}),
    timeoutMs: normalizeTimeoutMs(config.timeoutMs),
    remoteGitWritePolicy: normalizeRemoteGitWritePolicy(config.remoteGitWritePolicy),
    executionSandbox: normalizeExecutionSandbox(config.executionSandbox)
  }
}

function sandboxError() {
  return adapterError(
    "CODEX_SANDBOX_UNAVAILABLE",
    "Codex no-outbound-network process sandbox could not be established."
  )
}

function codexPolicyError() {
  return adapterError(
    "CODEX_REMOTE_POLICY_UNAVAILABLE",
    "Codex remote Git write denial policy could not be established."
  )
}

function codexPolicyPaths(run, attempt, options = {}) {
  const writeDataDir = resolvePath(configuredWriteDataDir(options))

  if (!isAbsolute(writeDataDir) || writeDataDir.includes("\0")) {
    throw codexPolicyError()
  }

  const attemptSegment = `attempt-${String(attempt).padStart(2, "0")}`

  return {
    policyRoot: join(writeDataDir, CODEX_EXECUTION_POLICY_STORE_DIR),
    runPolicyDir: join(writeDataDir, CODEX_EXECUTION_POLICY_STORE_DIR, run.runId),
    attemptDir: join(writeDataDir, CODEX_EXECUTION_POLICY_STORE_DIR, run.runId, attemptSegment),
    binDir: join(writeDataDir, CODEX_EXECUTION_POLICY_STORE_DIR, run.runId, attemptSegment, "bin"),
    gitWrapperPath: join(writeDataDir, CODEX_EXECUTION_POLICY_STORE_DIR, run.runId, attemptSegment, "bin", "git")
  }
}

function gitPolicyWrapperSource(gitExecutablePath) {
  const quotedGit = shellSingleQuote(gitExecutablePath)

  return `#!/bin/sh
cmd=""
skip_next=0
for arg in "$@"; do
  if [ "$skip_next" = "1" ]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path)
      skip_next=1
      continue
      ;;
    --git-dir=*|--work-tree=*|--namespace=*|--exec-path=*)
      continue
      ;;
    --*)
      continue
      ;;
    -*)
      continue
      ;;
    *)
      cmd="$arg"
      break
      ;;
  esac
done

case "$cmd" in
  push|send-pack|receive-pack|fetch|pull|clone|ls-remote|remote|remote-http|remote-https|remote-ssh|remote-ext|remote-fd|remote-ftps|remote-ftp|remote-git)
    echo "PPO Codex policy: remote Git operations are disabled." >&2
    exit 126
    ;;
esac

exec ${quotedGit} "$@"
`
}

function codexPolicyGitConfigEnv() {
  const entries = [
    ["protocol.file.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ssh.allow", "never"],
    ["protocol.http.allow", "never"],
    ["protocol.https.allow", "never"],
    ["protocol.ext.allow", "never"]
  ]
  const env = {
    GIT_CONFIG_COUNT: String(entries.length)
  }

  for (const [index, [key, value]] of entries.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  }

  return env
}

function codexPolicyEnv(config, paths) {
  const basePath = config.env.PATH || defaultExecutionPath

  return {
    ...config.env,
    ...codexPolicyGitConfigEnv(),
    PATH: `${paths.binDir}:${basePath}`,
    GIT_EXEC_PATH: paths.binDir,
    GIT_ALLOW_PROTOCOL: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "false",
    SSH_ASKPASS: "false",
    GIT_SSH_COMMAND: "false",
    PPO_CODEX_REMOTE_GIT_WRITE_POLICY: "deny",
    PPO_CODEX_REMOTE_GIT_WRITE_POLICY_ENFORCEMENT: "adapter-git-wrapper"
  }
}

async function writeCodexPolicyWrapper(paths, config) {
  await mkdir(paths.policyRoot, { recursive: true, mode: 0o700 })
  await chmod(paths.policyRoot, 0o700)
  await mkdir(paths.runPolicyDir, { recursive: true, mode: 0o700 })
  await chmod(paths.runPolicyDir, 0o700)
  await mkdir(paths.attemptDir, { recursive: true, mode: 0o700 })
  await chmod(paths.attemptDir, 0o700)
  await mkdir(paths.binDir, { recursive: true, mode: 0o700 })
  await chmod(paths.binDir, 0o700)
  await writeFile(paths.gitWrapperPath, gitPolicyWrapperSource(config.gitExecutablePath), {
    encoding: "utf8",
    mode: 0o700
  })
  await chmod(paths.gitWrapperPath, 0o700)
}

async function establishCodexExecutionPolicy(config, run, attempt, options = {}) {
  const paths = codexPolicyPaths(run, attempt, options)
  const env = codexPolicyEnv(config, paths)

  try {
    await writeCodexPolicyWrapper(paths, config)
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw codexPolicyError()
  }

  return {
    paths,
    env,
    metadata: {
      mode: config.remoteGitWritePolicy.mode,
      enforcement: config.remoteGitWritePolicy.enforcement
    }
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

async function runTrustedGit(config, cwd, args) {
  try {
    await execFileAsync(config.gitExecutablePath, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_CODEX_OUTPUT_BYTES,
      timeout: 15000,
      shell: false
    })
  } catch {
    throw sandboxError()
  }
}

async function prepareSandboxProbeRepo(config, paths) {
  const probeRepoPath = join(
    paths.attemptDir,
    `sandbox-probe-repo-${process.pid}-${process.hrtime.bigint().toString(36)}`
  )

  try {
    await mkdir(probeRepoPath, { recursive: true, mode: 0o700 })
    await chmod(probeRepoPath, 0o700)
    await runTrustedGit(config, probeRepoPath, ["init"])
    await runTrustedGit(config, probeRepoPath, ["config", "user.email", "ppo-sandbox-probe@example.invalid"])
    await runTrustedGit(config, probeRepoPath, ["config", "user.name", "PPO Sandbox Probe"])
    await runTrustedGit(config, probeRepoPath, ["commit", "--allow-empty", "-m", "sandbox probe"])
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw sandboxError()
  }

  return probeRepoPath
}

async function configureSandboxProbeRemote(config, probeRepoPath, remoteUrl) {
  try {
    await execFileAsync(config.gitExecutablePath, ["remote", "remove", "origin"], {
      cwd: probeRepoPath,
      encoding: "utf8",
      maxBuffer: MAX_CODEX_OUTPUT_BYTES,
      timeout: 15000,
      shell: false
    }).catch(() => null)
    await runTrustedGit(config, probeRepoPath, ["remote", "add", "origin", remoteUrl])
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw sandboxError()
  }
}

function sanitizedProbeEnv() {
  return {
    PATH: defaultExecutionPath,
    TERM: "dumb",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0"
  }
}

function assertSandboxProbeResult(result, code = "CODEX_SANDBOX_UNAVAILABLE") {
  if (isUncertainExecutionOutcome(result) || result?.exitCode === 71) {
    throw adapterError(
      code,
      "Codex no-outbound-network process sandbox could not be established."
    )
  }
}

function linuxNetworkNamespaceSandbox(sandbox) {
  return sandbox.type === CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE
}

async function assertSandboxLinuxPrivilegeBoundary(config, location, policy, options) {
  if (!linuxNetworkNamespaceSandbox(config.executionSandbox)) {
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
    sandbox: config.executionSandbox,
    executablePath: process.execPath,
    args: ["--eval", probeCode],
    cwd: location.workspacePath,
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    env: policy.env
  }, options)

  assertSandboxProbeResult(result)

  if (result?.exitCode !== 0) {
    throw sandboxError()
  }
}

async function assertSandboxLocalGitAllowed(config, location, policy, options) {
  const result = await runSandboxedCommand({
    kind: "sandbox-probe",
    probe: "local-workspace-git",
    sandbox: config.executionSandbox,
    executablePath: config.gitExecutablePath,
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: location.workspacePath,
    stdin: "",
    timeoutMs: 15000,
    maxOutputBytes: MAX_CODEX_OUTPUT_BYTES,
    env: policy.env
  }, options)

  assertSandboxProbeResult(result)

  if (result?.exitCode !== 0) {
    throw sandboxError()
  }
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

  return linuxNetworkNamespaceSandbox(config.executionSandbox) && (
    result?.exitCode === 67 ||
    result?.exitCode === 68
  )
}

async function assertSandboxDirectNetworkDenied(config, location, policy, options) {
  const probeCode = [
    "const net = require('node:net')",
    "const port = Number(process.env.PPO_CODEX_SANDBOX_PROBE_PORT)",
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
      sandbox: config.executionSandbox,
      executablePath: process.execPath,
      args: ["--eval", probeCode],
      cwd: location.workspacePath,
      stdin: "",
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      env: {
        ...policy.env,
        PPO_CODEX_SANDBOX_PROBE_PORT: String(port)
      }
    }, options)

    assertSandboxProbeResult(result)

    if (!isDirectNetworkDenied(config, result, connectionCount())) {
      throw sandboxError()
    }
  }, options)
}

async function assertSandboxDirectSshDenied(config, location, options) {
  await withLoopbackProbeServer(async ({ port, connectionCount }) => {
    const result = await runSandboxedCommand({
      kind: "sandbox-probe",
      probe: "direct-ssh-transport",
      sandbox: config.executionSandbox,
      executablePath: linuxDirectSshExecutablePath,
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=2",
        "-p",
        String(port),
        "127.0.0.1",
        "true"
      ],
      cwd: location.workspacePath,
      stdin: "",
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      env: sanitizedProbeEnv()
    }, options)

    assertSandboxProbeResult(result)

    if (result?.sandboxDenied === true) {
      return
    }

    if (result?.exitCode === 0 || connectionCount() !== 0) {
      throw sandboxError()
    }
  }, options)
}

async function assertSandboxRemoteGitDenied({
  config,
  probeRepoPath,
  executablePath,
  args,
  env,
  probe,
  options
}) {
  await withLoopbackProbeServer(async ({ port, connectionCount }) => {
    await configureSandboxProbeRemote(config, probeRepoPath, `ssh://127.0.0.1:${port}/ppo-sandbox-probe.git`)

    const result = await runSandboxedCommand({
      kind: "sandbox-probe",
      probe,
      sandbox: config.executionSandbox,
      executablePath,
      args,
      cwd: probeRepoPath,
      stdin: "",
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      env
    }, options)

    assertSandboxProbeResult(result)

    if (result?.sandboxDenied === true) {
      return
    }

    if (result?.exitCode === 0 || connectionCount() !== 0) {
      throw sandboxError()
    }
  }, options)
}

async function assertCodexSandboxActive(config, location, policy, options) {
  await assertSandboxLinuxPrivilegeBoundary(config, location, policy, options)
  await assertSandboxLocalGitAllowed(config, location, policy, options)
  await assertSandboxDirectNetworkDenied(config, location, policy, options)
  await assertSandboxDirectSshDenied(config, location, options)

  const probeRepoPath = await prepareSandboxProbeRepo(config, policy.paths)

  await assertSandboxRemoteGitDenied({
    config,
    probeRepoPath,
    executablePath: config.gitExecutablePath,
    args: ["push", "origin", "HEAD"],
    env: sanitizedProbeEnv(),
    probe: "absolute-git-sanitized-env-push",
    options
  })
  await assertSandboxRemoteGitDenied({
    config,
    probeRepoPath,
    executablePath: "/usr/bin/env",
    args: ["git", "push", "origin", "HEAD"],
    env: policy.env,
    probe: "ordinary-git-push",
    options
  })
}

async function establishCodexExecutionSandbox(config, run, location, attempt, options = {}) {
  const policy = await establishCodexExecutionPolicy(config, run, attempt, options)

  await assertCodexSandboxActive(config, location, policy, options)

  return {
    ...policy,
    sandbox: config.executionSandbox,
    metadata: {
      ...policy.metadata,
      sandbox: CODEX_EXECUTION_SANDBOX_ID,
      backend: config.executionSandbox.backend,
      platform: config.executionSandbox.platform,
      network: "none"
    }
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

  if (sandbox.type === CODEX_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC) {
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

  if (sandbox.type === CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE) {
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

    child.stdin.end(invocation.stdin || "", "utf8")
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
      throw ambiguousExecutionError()
    }

    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    if (invocation.kind === "codex") {
      throw error
    }

    throw sandboxError()
  }
}

async function invokeCodex(config, invocation, options = {}) {
  const boundedInvocation = {
    kind: "codex",
    sandbox: config.executionSandbox,
    executablePath: config.executablePath,
    args: [...config.args],
    cwd: invocation.cwd,
    stdin: invocation.prompt,
    prompt: invocation.prompt,
    promptHash: invocation.promptHash,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: MAX_CODEX_OUTPUT_BYTES,
    env: invocation.env,
    shell: false,
    remoteGitWritePolicy: {
      ...invocation.remoteGitWritePolicy
    },
    executionSandbox: {
      ...invocation.executionSandbox
    }
  }

  let result

  try {
    result = await runSandboxedCommand(boundedInvocation, options)
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

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

async function sourceFacts(location, options) {
  return {
    topLevel: await gitLine(location.sourceRepoPath, ["rev-parse", "--show-toplevel"], options, "CODEX_SOURCE_CHANGED", "Source repository state could not be verified."),
    branch: await gitLine(location.sourceRepoPath, ["symbolic-ref", "--short", "HEAD"], options, "CODEX_SOURCE_CHANGED", "Source repository branch could not be verified."),
    headSha: normalizeSha(await gitLine(location.sourceRepoPath, ["rev-parse", "HEAD"], options, "CODEX_SOURCE_CHANGED", "Source repository head could not be verified."), "Source repository HEAD")
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
    before.headSha !== after.headSha
  ) {
    throw adapterError(
      "CODEX_SOURCE_CHANGED",
      "Source repository state changed during Codex execution."
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
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef,
      adapter: CODEX_EXECUTION_ADAPTER_ID,
      attempt: run.attempts.implementation,
      promptHash: execution.promptHash,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      outcome: "implementation_ready",
      remotePolicy: "deny",
      sandbox: CODEX_EXECUTION_SANDBOX_ID,
      backend: execution.executionSandbox.backend,
      platform: execution.executionSandbox.platform,
      network: "none",
      changedFiles: verified.changedFileCount
    }
  }
}

function buildExecutionAttemptEvidence(run, location, execution) {
  return {
    kind: "implementation",
    sha: execution.expectedStartSha,
    source: CODEX_EXECUTION_ADAPTER_ID,
    summary: "Codex execution attempt reserved.",
    metadata: {
      project: run.project.id,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef,
      adapter: CODEX_EXECUTION_ADAPTER_ID,
      attempt: execution.attempt,
      promptHash: execution.promptHash,
      startedAt: execution.startedAt,
      outcome: "execution_started",
      remotePolicy: "deny",
      sandbox: CODEX_EXECUTION_SANDBOX_ID,
      backend: execution.executionSandbox.backend,
      platform: execution.executionSandbox.platform,
      network: "none"
    }
  }
}

function buildExecutionFailureEvidence(run, location, execution) {
  return {
    kind: "implementation",
    sha: execution.expectedStartSha,
    source: CODEX_EXECUTION_ADAPTER_ID,
    summary: "Codex execution attempt ended without a verified implementation.",
    metadata: {
      project: run.project.id,
      branch: location.branch,
      workspaceId: location.workspaceId,
      workspaceRef: location.workspaceRef,
      adapter: CODEX_EXECUTION_ADAPTER_ID,
      attempt: execution.attempt,
      promptHash: execution.promptHash,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      outcome: "execution_failed",
      remotePolicy: "deny",
      sandbox: CODEX_EXECUTION_SANDBOX_ID,
      backend: execution.executionSandbox.backend,
      platform: execution.executionSandbox.platform,
      network: "none"
    }
  }
}

function buildHardeningImplementationEvidence(run, verified, execution, hardeningContext) {
  return {
    kind: "implementation",
    sha: verified.headSha,
    source: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
    summary: "Phase 6F hardening remediation produced a verified implementation SHA.",
    metadata: {
      project: run.project.id,
      orchestrator: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
      round: hardeningContext.round,
      sourceReviewSha: hardeningContext.sourceReviewSha,
      resultingSha: verified.headSha,
      blockerCount: hardeningContext.blockers.length,
      securityFindingCount: hardeningContext.securityFindings.length,
      testRequirementCount: hardeningContext.testsRequired.length,
      remediationHash: hardeningContext.remediationHash,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      outcome: "implementation_ready",
      codex: CODEX_EXECUTION_ADAPTER_ID,
      tests: "phase-6e-automated-test-runner",
      reviewer: PHASE_6F_INDEPENDENT_REVIEW_AGENT_ID
    }
  }
}

function latestCodexImplementationEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.implementation) ? run.evidence.implementation : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (entry?.source === CODEX_EXECUTION_ADAPTER_ID && entry?.metadata?.adapter === CODEX_EXECUTION_ADAPTER_ID) {
      return entry
    }
  }

  return null
}

function assertNoOpenCodexAttempt(run) {
  const latest = latestCodexImplementationEvidence(run)

  if (latest?.metadata?.outcome === "execution_started") {
    throw adapterError(
      "CODEX_RECONCILIATION_REQUIRED",
      "Previous Codex execution attempt requires reconciliation before retrying."
    )
  }
}

function assertCodexAttemptAvailable(run) {
  if (run.attempts.implementation >= MAX_CODEX_IMPLEMENTATION_ATTEMPTS) {
    throw adapterError(
      "CODEX_ATTEMPT_LIMIT_REACHED",
      "Codex implementation attempt limit was reached; owner action is required."
    )
  }
}

async function reserveCodexExecutionAttempt(run, location, execution, options) {
  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "implementation_in_progress",
    actor: CODEX_EXECUTION_ADAPTER_ID,
    reason: "phase-6d-codex-execution-attempt",
    incrementAttempt: true,
    evidence: [
      buildExecutionAttemptEvidence(run, location, execution)
    ]
  }, options)
}

async function recordDefinitiveCodexFailure(run, location, execution, options) {
  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "implementation_in_progress",
    actor: CODEX_EXECUTION_ADAPTER_ID,
    reason: "phase-6d-codex-execution-definitive-failure",
    evidence: [
      buildExecutionFailureEvidence(run, location, execution)
    ]
  }, options)
}

async function reconcileBeforeExecution(runId, run, options) {
  const expectedStartSha = normalizeSha(run.headSha || run.baseSha, "Expected implementation start SHA")
  const inspection = await inspectImplementationWorkspace(runId, options)
  const requiresBaseInspectionMatch = expectedStartSha === normalizeSha(run.baseSha, "Run base SHA")

  if (!inspection.exists || (requiresBaseInspectionMatch && (!inspection.matches || inspection.status !== "matching"))) {
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

  assertNoOpenCodexAttempt(run)
  assertCodexAttemptAvailable(run)

  const hardeningContext = deriveHardeningRemediationContext(run)
  const { location, expectedStartSha } = await reconcileBeforeExecution(runId, run, options)
  const prompt = buildCodexImplementationPrompt(run, location)
  const promptHash = sha256Text(prompt)
  const startedAt = timestamp(nowDate(options))
  const nextAttempt = run.attempts.implementation + 1
  const executionSandbox = await establishCodexExecutionSandbox(config, run, location, nextAttempt, options)
  const attemptRun = await reserveCodexExecutionAttempt(run, location, {
    attempt: nextAttempt,
    expectedStartSha,
    promptHash,
    startedAt,
    executionSandbox: executionSandbox.metadata
  }, options)
  const postReservation = await reconcileBeforeExecution(runId, attemptRun, options)
  const sourceBefore = await sourceFacts(postReservation.location, options)
  const execution = {
    attempt: attemptRun.attempts.implementation,
    expectedStartSha: postReservation.expectedStartSha,
    promptHash,
    startedAt,
    endedAt: null,
    executionSandbox: executionSandbox.metadata
  }

  try {
    await invokeCodex(config, {
      cwd: postReservation.location.workspacePath,
      prompt,
      promptHash,
      env: executionSandbox.env,
      remoteGitWritePolicy: executionSandbox.metadata,
      executionSandbox: executionSandbox.metadata
    }, options)
  } catch (error) {
    if (error?.ambiguous === true || error?.code === "CODEX_EXECUTION_AMBIGUOUS") {
      throw error
    }

    execution.endedAt = timestamp(nowDate(options))
    await recordDefinitiveCodexFailure(attemptRun, postReservation.location, execution, options)
    throw error
  }

  const endedAt = timestamp(nowDate(options))
  execution.endedAt = endedAt
  let verified

  try {
    verified = await verifyImplementationResult(attemptRun, postReservation.location, sourceBefore, postReservation.expectedStartSha, options)
  } catch (error) {
    await recordDefinitiveCodexFailure(attemptRun, postReservation.location, execution, options)
    throw error
  }

  const implementationEvidence = buildImplementationEvidence(attemptRun, postReservation.location, verified, {
    promptHash,
    startedAt,
    endedAt,
    executionSandbox: executionSandbox.metadata
  })
  const evidence = [
    implementationEvidence,
    ...(hardeningContext ? [
      buildHardeningImplementationEvidence(attemptRun, verified, {
        promptHash,
        startedAt,
        endedAt
      }, hardeningContext)
    ] : [])
  ]
  const transitioned = await transitionDevelopmentRun(attemptRun.runId, {
    expectedVersion: attemptRun.version,
    status: "implementation_ready",
    branch: postReservation.location.branch,
    headSha: verified.headSha,
    actor: CODEX_EXECUTION_ADAPTER_ID,
    reason: "phase-6d-codex-implementation-ready",
    evidence
  }, options)

  return {
    ok: true,
    outcome: "implementation_ready",
    run: transitioned,
    implementation: {
      project: attemptRun.project.id,
      repo: attemptRun.project.fullName,
      branch: postReservation.location.branch,
      workspaceId: postReservation.location.workspaceId,
      workspaceRef: postReservation.location.workspaceRef,
      headSha: verified.headSha,
      promptHash,
      attempt: attemptRun.attempts.implementation,
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
