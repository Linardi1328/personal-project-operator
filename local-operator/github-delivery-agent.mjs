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
  DEVELOPMENT_ACCEPTANCE_GATE_ID,
  PHASE_6G_DEFAULT_BASE_BRANCH,
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID,
  assertDevelopmentAcceptanceGate,
  latestPhase6DImplementationEvidence,
  latestPhase6EPassEvidence,
  latestPhase6FApprovedReviewEvidence
} from "./development-acceptance-gate.mjs"
import {
  INDEPENDENT_REVIEW_SANDBOX_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS,
  REVIEW_FINDINGS_EVIDENCE_OUTCOME,
  assertTrustedReviewSandboxActive,
  collectTrustedReviewDiffFacts,
  invokeTrustedReviewForPrompt,
  normalizeTrustedReviewConfig,
  reconcileTrustedReviewWorkspace,
  trustedReviewReadOnlyPaths
} from "./development-review-agent.mjs"

const execFileAsync = promisify(execFile)

export const GITHUB_DELIVERY_AGENT_ID = "phase-6g-github-delivery-agent"
export const PPO_PR_VALIDATION_WORKFLOW_NAME = "PPO PR validation"
export const PPO_PR_VALIDATION_WORKFLOW_FILE = "ppo-pr-validation.yml"
export const PHASE_6G_APPROVED_MERGE_METHOD = "squash"
export const MAX_GITHUB_DELIVERY_GIT_OUTPUT_BYTES = 32 * 1024
export const MAX_GITHUB_DELIVERY_GIT_TIMEOUT_MS = 30 * 1000
export const MAX_GITHUB_DELIVERY_API_OUTPUT_BYTES = 256 * 1024
export const MAX_GITHUB_DELIVERY_API_TIMEOUT_MS = 30 * 1000
export const MAX_REMOTE_REVIEW_PROMPT_CHARS = 6000
export const REQUIRED_PPO_PR_VALIDATION_STEPS = Object.freeze([
  "Node syntax checks",
  "Shell syntax checks",
  "Full regression suite",
  "Diff whitespace checks"
])

const shaPattern = /^[a-f0-9]{40}$/u
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u
const safeRemotePatterns = [
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu,
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu,
  /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu
]
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const unsafeMultilineOutputPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu

export class GitHubDeliveryAgentError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "GitHubDeliveryAgentError"
  }
}

function deliveryError(code, safeMessage) {
  return new GitHubDeliveryAgentError(code, safeMessage)
}

function safeDeliveryFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return deliveryError(
    "GITHUB_DELIVERY_UNAVAILABLE",
    "GitHub delivery agent is unavailable; no raw failure was stored."
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

function normalizeSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw deliveryError(
      "GITHUB_DELIVERY_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw deliveryError(
      "GITHUB_DELIVERY_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required."
    )
  }

  return value
}

function normalizePrNumber(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) {
    throw deliveryError(
      "GITHUB_DELIVERY_PR_INVALID",
      "Pull request metadata is invalid."
    )
  }

  return value
}

function normalizeBranch(value) {
  const normalized = String(value ?? "").trim()

  if (
    !branchPattern.test(normalized) ||
    normalized.includes("..") ||
    normalized.includes("//") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".lock") ||
    normalized === PHASE_6G_DEFAULT_BASE_BRANCH ||
    normalized === "master"
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_BRANCH_REFUSED",
      "Delivery branch must be the approved non-default Phase 6C branch."
    )
  }

  return normalized
}

function normalizeSafeText(value, { maxChars = 200, required = true, code = "GITHUB_DELIVERY_METADATA_INVALID", safeMessage = "Delivery metadata is invalid." } = {}) {
  if (value === null || value === undefined) {
    if (required) {
      throw deliveryError(code, safeMessage)
    }

    return null
  }

  const normalized = String(value).trim()

  if ((required && !normalized) || normalized.length > maxChars || unsafeControlPattern.test(normalized) || sensitiveTextPattern.test(normalized)) {
    throw deliveryError(code, safeMessage)
  }

  return normalized
}

function githubIdentityFromRemote(remoteUrl) {
  const normalized = normalizeSafeText(remoteUrl, {
    maxChars: 200,
    code: "GITHUB_DELIVERY_REPOSITORY_IDENTITY_INVALID",
    safeMessage: "Repository identity is not approved for this run."
  })

  for (const pattern of safeRemotePatterns) {
    const match = normalized.match(pattern)

    if (match) {
      return `${match[1]}/${match[2].replace(/\.git$/iu, "")}`
    }
  }

  throw deliveryError(
    "GITHUB_DELIVERY_REPOSITORY_IDENTITY_INVALID",
    "Repository identity is not approved for this run."
  )
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

function ambiguousWriteError(code, safeMessage) {
  const error = deliveryError(code, safeMessage)
  error.ambiguous = true
  return error
}

function assertGitArgs(args) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || !entry)) {
    throw deliveryError(
      "GITHUB_DELIVERY_GIT_OPERATION_REFUSED",
      "GitHub delivery Git operation is not approved."
    )
  }

  const command = args[2]
  const subcommand = args[3]
  const branchRef = (value) => typeof value === "string" && value.startsWith("refs/heads/") && normalizeBranch(value.slice("refs/heads/".length))
  const pushRef = (value) => {
    const [sha, ref] = String(value).split(":")
    return normalizeSha(sha, "Push SHA") && branchRef(ref) && !String(value).startsWith("+")
  }
  const exactShape = (
    args[0] === "-C" &&
    typeof args[1] === "string" &&
    (
      (command === "remote" && args.length === 5 && subcommand === "get-url" && args[4] === "origin") ||
      (command === "symbolic-ref" && args.length === 5 && subcommand === "--short" && args[4] === "HEAD") ||
      (command === "rev-parse" && args.length === 4 && (
        subcommand === "HEAD" ||
        (typeof subcommand === "string" && subcommand.startsWith("refs/heads/"))
      )) ||
      (command === "status" && args.length === 5 && subcommand === "--porcelain=v1" && args[4] === "--untracked-files=all") ||
      (command === "ls-remote" && args.length === 6 && subcommand === "origin" && branchRef(args[4]) && args[5] === "--refs") ||
      (command === "push" && args.length === 6 && subcommand === "origin" && pushRef(args[4]) && args[5] === "--porcelain")
    )
  )

  if (!exactShape) {
    throw deliveryError(
      "GITHUB_DELIVERY_GIT_OPERATION_REFUSED",
      "GitHub delivery Git operation is not approved."
    )
  }
}

function isGitMutation(args) {
  return args[2] === "push"
}

async function runGit(args, options = {}) {
  assertGitArgs(args)

  if (options.gitRunner) {
    try {
      const result = await options.gitRunner(args)

      if (isGitMutation(args) && isUncertainOutcome(result)) {
        throw ambiguousWriteError(
          "GITHUB_DELIVERY_PUSH_AMBIGUOUS",
          "Branch push outcome is ambiguous; reconcile the remote branch before retrying."
        )
      }

      return {
        stdout: String(result?.stdout ?? ""),
        stderr: "",
        exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0
      }
    } catch (error) {
      if (isGitMutation(args) && isUncertainOutcome(error)) {
        throw ambiguousWriteError(
          "GITHUB_DELIVERY_PUSH_AMBIGUOUS",
          "Branch push outcome is ambiguous; reconcile the remote branch before retrying."
        )
      }

      throw error
    }
  }

  try {
    const result = await execFileAsync("git", args, {
      encoding: "utf8",
      maxBuffer: MAX_GITHUB_DELIVERY_GIT_OUTPUT_BYTES,
      timeout: MAX_GITHUB_DELIVERY_GIT_TIMEOUT_MS,
      shell: false
    })

    return {
      stdout: result.stdout,
      stderr: "",
      exitCode: 0
    }
  } catch (error) {
    if (isGitMutation(args) && isUncertainOutcome(error)) {
      throw ambiguousWriteError(
        "GITHUB_DELIVERY_PUSH_AMBIGUOUS",
        "Branch push outcome is ambiguous; reconcile the remote branch before retrying."
      )
    }

    throw deliveryError(
      "GITHUB_DELIVERY_GIT_FAILED",
      "Git operation failed; no raw Git output was stored."
    )
  }
}

async function gitLine(cwd, args, options, code, safeMessage) {
  const result = await runGit(["-C", cwd, ...args], options)
  const output = String(result.stdout ?? "").trim()

  if (!output || output.length > MAX_GITHUB_DELIVERY_GIT_OUTPUT_BYTES || unsafeControlPattern.test(output)) {
    throw deliveryError(code, safeMessage)
  }

  return output.split(/\r?\n/u)[0].trim()
}

async function gitText(cwd, args, options) {
  const result = await runGit(["-C", cwd, ...args], options)
  const output = String(result.stdout ?? "")

  if (Buffer.byteLength(output, "utf8") > MAX_GITHUB_DELIVERY_GIT_OUTPUT_BYTES || unsafeMultilineOutputPattern.test(output)) {
    throw deliveryError(
      "GITHUB_DELIVERY_GIT_FAILED",
      "Git operation failed; no raw Git output was stored."
    )
  }

  return output.trim()
}

async function readRemoteBranchSha(location, branch, options = {}) {
  const ref = `refs/heads/${normalizeBranch(branch)}`
  const result = await runGit([
    "-C",
    location.workspacePath,
    "ls-remote",
    "origin",
    ref,
    "--refs"
  ], options)
  const output = String(result.stdout ?? "").trim()

  if (!output) {
    return null
  }

  const lines = output.split(/\r?\n/u).filter(Boolean)

  if (lines.length !== 1) {
    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_BRANCH_AMBIGUOUS",
      "Remote branch state is ambiguous."
    )
  }

  const [sha, remoteRef] = lines[0].split(/\s+/u)

  if (remoteRef !== ref) {
    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_BRANCH_AMBIGUOUS",
      "Remote branch state is ambiguous."
    )
  }

  return normalizeSha(sha, "Remote branch SHA")
}

async function verifyLocalWorkspaceForDelivery(acceptance, options = {}) {
  const location = acceptance.workspace.location
  const branch = normalizeBranch(acceptance.branch)
  const approvedSha = normalizeSha(acceptance.approvedSha, "Approved SHA")
  const remoteIdentity = githubIdentityFromRemote(await gitLine(location.workspacePath, [
    "remote",
    "get-url",
    "origin"
  ], options, "GITHUB_DELIVERY_REPOSITORY_IDENTITY_INVALID", "Repository identity is not approved for this run."))
  const facts = {
    branch: await gitLine(location.workspacePath, ["symbolic-ref", "--short", "HEAD"], options, "GITHUB_DELIVERY_WORKSPACE_MISMATCH", "Workspace branch is not approved for delivery."),
    headSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", "HEAD"], options, "GITHUB_DELIVERY_WORKSPACE_MISMATCH", "Workspace HEAD is not approved for delivery."), "Workspace HEAD"),
    branchHeadSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", `refs/heads/${branch}`], options, "GITHUB_DELIVERY_WORKSPACE_MISMATCH", "Workspace branch HEAD is not approved for delivery."), "Workspace branch HEAD"),
    dirtyStatus: await gitText(location.workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"], options),
    remoteIdentity
  }

  if (
    facts.branch !== branch ||
    facts.headSha !== approvedSha ||
    facts.branchHeadSha !== approvedSha ||
    facts.remoteIdentity !== acceptance.project.fullName ||
    facts.dirtyStatus
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_WORKSPACE_MISMATCH",
      "Workspace branch, HEAD, clean state, or repository identity is not approved for delivery."
    )
  }

  return facts
}

function latestDeliveryEvidence(run, outcome = null) {
  const evidence = Array.isArray(run?.evidence?.merge) ? run.evidence.merge : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      entry?.source === GITHUB_DELIVERY_AGENT_ID &&
      entry?.metadata?.agent === GITHUB_DELIVERY_AGENT_ID &&
      (outcome === null || entry?.metadata?.outcome === outcome)
    ) {
      return entry
    }
  }

  return null
}

function latestRemoteReviewEvidence(run, outcome = null) {
  const evidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      entry?.source === REMOTE_PR_REVIEW_AGENT_ID &&
      entry?.metadata?.reviewer === REMOTE_PR_REVIEW_AGENT_ID &&
      (outcome === null || entry?.metadata?.outcome === outcome)
    ) {
      return entry
    }
  }

  return null
}

function latestPushedShaForBranch(run, branch) {
  const evidence = Array.isArray(run?.evidence?.merge) ? run.evidence.merge : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      entry?.source === GITHUB_DELIVERY_AGENT_ID &&
      entry?.metadata?.branch === branch &&
      entry?.metadata?.pushedSha
    ) {
      return entry.metadata.pushedSha
    }
  }

  return null
}

function deliveryEvidence(run, sha, outcome, metadata, summary) {
  return {
    kind: "merge",
    sha,
    source: GITHUB_DELIVERY_AGENT_ID,
    summary,
    metadata: {
      project: run.project.id,
      agent: GITHUB_DELIVERY_AGENT_ID,
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      implementationSha: sha,
      outcome,
      ...metadata
    }
  }
}

async function recordDeliveryProgress(run, evidence, options, reason) {
  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: run.status,
    actor: GITHUB_DELIVERY_AGENT_ID,
    reason,
    evidence: [evidence]
  }, options)
}

export async function pushApprovedBranch(acceptance, options = {}) {
  await verifyLocalWorkspaceForDelivery(acceptance, options)

  const run = acceptance.run
  const location = acceptance.workspace.location
  const approvedSha = normalizeSha(acceptance.approvedSha, "Approved implementation SHA")
  const branch = normalizeBranch(acceptance.branch)
  const previousPushedSha = latestPushedShaForBranch(run, branch)
  const beforeSha = await readRemoteBranchSha(location, branch, options)

  if (beforeSha === approvedSha) {
    return {
      ok: true,
      outcome: "branch_already_exact",
      approvedSha,
      branch,
      previousRemoteSha: beforeSha,
      remoteBranchSha: beforeSha,
      pushed: false
    }
  }

  if (beforeSha && beforeSha !== previousPushedSha) {
    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_BRANCH_UNEXPECTED",
      "Remote branch points at an unexpected SHA; owner action is required."
    )
  }

  const pushArgs = [
    "-C",
    location.workspacePath,
    "push",
    "origin",
    `${approvedSha}:refs/heads/${branch}`,
    "--porcelain"
  ]

  const attemptPush = async () => {
    await runGit(pushArgs, options)
    const afterSha = await readRemoteBranchSha(location, branch, options)

    if (afterSha !== approvedSha) {
      throw deliveryError(
        "GITHUB_DELIVERY_PUSH_VERIFY_FAILED",
        "Remote branch did not land on the approved implementation SHA."
      )
    }

    return afterSha
  }

  try {
    const afterSha = await attemptPush()

    return {
      ok: true,
      outcome: "branch_pushed",
      approvedSha,
      branch,
      previousRemoteSha: beforeSha,
      remoteBranchSha: afterSha,
      pushed: true
    }
  } catch (error) {
    if (error?.ambiguous !== true && error?.code !== "GITHUB_DELIVERY_PUSH_AMBIGUOUS") {
      throw error
    }

    const reconciledSha = await readRemoteBranchSha(location, branch, options)

    if (reconciledSha === approvedSha) {
      return {
        ok: true,
        outcome: "branch_push_recovered",
        approvedSha,
        branch,
        previousRemoteSha: beforeSha,
        remoteBranchSha: reconciledSha,
        pushed: true
      }
    }

    if (reconciledSha === null) {
      const retrySha = await attemptPush()

      return {
        ok: true,
        outcome: "branch_push_safe_retry",
        approvedSha,
        branch,
        previousRemoteSha: beforeSha,
        remoteBranchSha: retrySha,
        pushed: true
      }
    }

    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_BRANCH_UNEXPECTED",
      "Remote branch points at an unexpected SHA after ambiguous push; owner action is required."
    )
  }
}

function repoEndpoint(project, suffix = "") {
  return `/repos/${project.owner}/${project.repo}${suffix}`
}

function appendQuery(endpoint, query = {}) {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value))
    }
  }

  const queryString = params.toString()

  return queryString ? `${endpoint}?${queryString}` : endpoint
}

function normalizePullRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw deliveryError(
      "GITHUB_DELIVERY_PR_INVALID",
      "Pull request metadata is invalid."
    )
  }

  return {
    number: normalizePrNumber(raw.number),
    state: normalizeSafeText(raw.state, { maxChars: 20 }),
    draft: Boolean(raw.draft),
    merged: Boolean(raw.merged),
    mergeable: raw.mergeable === null || raw.mergeable === undefined ? null : Boolean(raw.mergeable),
    mergeableState: raw.mergeable_state ? normalizeSafeText(raw.mergeable_state, { maxChars: 40 }) : null,
    mergeCommitSha: raw.merge_commit_sha ? normalizeSha(raw.merge_commit_sha, "Merge commit SHA") : null,
    baseRef: normalizeSafeText(raw.base?.ref, { maxChars: 160 }),
    baseRepoFullName: normalizeSafeText(raw.base?.repo?.full_name, { maxChars: 160 }),
    headRef: normalizeSafeText(raw.head?.ref, { maxChars: 160 }),
    headSha: normalizeSha(raw.head?.sha, "PR head SHA"),
    headRepoFullName: normalizeSafeText(raw.head?.repo?.full_name, { maxChars: 160 }),
    nodeId: raw.node_id ? normalizeSafeText(raw.node_id, { maxChars: 120 }) : null
  }
}

function normalizeWorkflowRun(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw deliveryError(
      "GITHUB_DELIVERY_CI_INVALID",
      "CI metadata is invalid."
    )
  }

  return {
    id: Number(raw.id),
    name: normalizeSafeText(raw.name || raw.display_title || PPO_PR_VALIDATION_WORKFLOW_NAME, { maxChars: 120 }),
    event: normalizeSafeText(raw.event || "pull_request", { maxChars: 40 }),
    status: normalizeSafeText(raw.status || "", { maxChars: 40 }),
    conclusion: raw.conclusion ? normalizeSafeText(raw.conclusion, { maxChars: 40 }) : null,
    headSha: normalizeSha(raw.head_sha || raw.headSha, "Workflow head SHA"),
    headBranch: raw.head_branch ? normalizeSafeText(raw.head_branch, { maxChars: 160 }) : null,
    runNumber: Number.isInteger(raw.run_number) ? raw.run_number : null,
    attempt: Number.isInteger(raw.run_attempt) ? raw.run_attempt : null,
    createdAt: raw.created_at ? normalizeSafeText(raw.created_at, { maxChars: 40 }) : null
  }
}

function normalizeWorkflowJob(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw deliveryError(
      "GITHUB_DELIVERY_CI_INVALID",
      "CI metadata is invalid."
    )
  }

  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((step) => ({
      name: normalizeSafeText(step.name, { maxChars: 120 }),
      status: normalizeSafeText(step.status || "", { maxChars: 40 }),
      conclusion: step.conclusion ? normalizeSafeText(step.conclusion, { maxChars: 40 }) : null
    }))
    : []

  return {
    id: Number(raw.id),
    name: normalizeSafeText(raw.name || "validate", { maxChars: 120 }),
    status: normalizeSafeText(raw.status || "", { maxChars: 40 }),
    conclusion: raw.conclusion ? normalizeSafeText(raw.conclusion, { maxChars: 40 }) : null,
    steps
  }
}

function normalizeRef(raw) {
  const sha = raw?.object?.sha || raw?.sha

  return {
    sha: normalizeSha(sha, "Reference SHA")
  }
}

async function ghApiJson(args, options = {}) {
  try {
    const result = await execFileAsync("gh", args, {
      encoding: "utf8",
      maxBuffer: MAX_GITHUB_DELIVERY_API_OUTPUT_BYTES,
      timeout: MAX_GITHUB_DELIVERY_API_TIMEOUT_MS,
      shell: false
    })

    const stdout = String(result.stdout ?? "")

    if (Buffer.byteLength(stdout, "utf8") > MAX_GITHUB_DELIVERY_API_OUTPUT_BYTES || unsafeMultilineOutputPattern.test(stdout)) {
      throw deliveryError(
        "GITHUB_DELIVERY_API_INVALID",
        "GitHub API metadata is invalid."
      )
    }

    return JSON.parse(stdout || "{}")
  } catch (error) {
    if (isUncertainOutcome(error)) {
      throw ambiguousWriteError(
        "GITHUB_DELIVERY_API_WRITE_AMBIGUOUS",
        "GitHub write outcome is ambiguous; reconcile before retrying."
      )
    }

    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw deliveryError(
      "GITHUB_DELIVERY_API_FAILED",
      "GitHub API operation failed; no raw response was stored."
    )
  }
}

function createTrustedGitHubClient(options = {}) {
  return {
    async listPullRequests(project, { branch, base }) {
      const response = await ghApiJson([
        "api",
        "--method",
        "GET",
        appendQuery(repoEndpoint(project, "/pulls"), {
          state: "open",
          head: `${project.owner}:${branch}`,
          base,
          per_page: 10
        })
      ], options)

      return (Array.isArray(response) ? response : []).map(normalizePullRequest)
    },

    async createPullRequest(project, { branch, base, title, body }) {
      try {
        const response = await ghApiJson([
          "api",
          "--method",
          "POST",
          repoEndpoint(project, "/pulls"),
          "--field",
          `title=${title}`,
          "--field",
          `head=${branch}`,
          "--field",
          `base=${base}`,
          "--field",
          `body=${body}`,
          "--field",
          "draft=false"
        ], options)

        return normalizePullRequest(response)
      } catch (error) {
        if (error?.ambiguous === true || error?.code === "GITHUB_DELIVERY_API_WRITE_AMBIGUOUS") {
          throw ambiguousWriteError(
            "GITHUB_DELIVERY_PR_CREATE_AMBIGUOUS",
            "Pull request creation outcome is ambiguous; reconcile before retrying."
          )
        }

        throw error
      }
    },

    async getPullRequest(project, prNumber) {
      const response = await ghApiJson([
        "api",
        "--method",
        "GET",
        repoEndpoint(project, `/pulls/${normalizePrNumber(prNumber)}`)
      ], options)

      return normalizePullRequest(response)
    },

    async listWorkflowRuns(project, { headSha, branch }) {
      const response = await ghApiJson([
        "api",
        "--method",
        "GET",
        appendQuery(repoEndpoint(project, `/actions/workflows/${PPO_PR_VALIDATION_WORKFLOW_FILE}/runs`), {
          branch,
          event: "pull_request",
          head_sha: headSha,
          per_page: 10
        })
      ], options)

      return (Array.isArray(response?.workflow_runs) ? response.workflow_runs : []).map(normalizeWorkflowRun)
    },

    async listWorkflowRunJobs(project, runId) {
      const response = await ghApiJson([
        "api",
        "--method",
        "GET",
        appendQuery(repoEndpoint(project, `/actions/runs/${Number(runId)}/jobs`), {
          per_page: 10
        })
      ], options)

      return (Array.isArray(response?.jobs) ? response.jobs : []).map(normalizeWorkflowJob)
    },

    async mergePullRequest(project, { prNumber, expectedHeadSha, method }) {
      try {
        const response = await ghApiJson([
          "api",
          "--method",
          "PUT",
          repoEndpoint(project, `/pulls/${normalizePrNumber(prNumber)}/merge`),
          "--field",
          `merge_method=${method}`,
          "--field",
          `sha=${normalizeSha(expectedHeadSha, "Expected head SHA")}`,
          "--field",
          "commit_title=PPO Phase 6G exact-head merge"
        ], options)

        return {
          merged: Boolean(response?.merged),
          sha: response?.sha ? normalizeSha(response.sha, "Merge commit SHA") : null
        }
      } catch (error) {
        if (error?.ambiguous === true || error?.code === "GITHUB_DELIVERY_API_WRITE_AMBIGUOUS") {
          throw ambiguousWriteError(
            "GITHUB_DELIVERY_MERGE_AMBIGUOUS",
            "Pull request merge outcome is ambiguous; reconcile before retrying."
          )
        }

        throw error
      }
    },

    async getBranchRef(project, branch) {
      const response = await ghApiJson([
        "api",
        "--method",
        "GET",
        repoEndpoint(project, `/git/ref/heads/${branch}`)
      ], options)

      return normalizeRef(response)
    }
  }
}

function githubClient(options = {}) {
  return options.githubClient || createTrustedGitHubClient(options)
}

function deterministicPrTitle(acceptance) {
  return `PPO delivery: ${acceptance.project.id} ${acceptance.approvedSha.slice(0, 12)}`
}

function deterministicPrBody(acceptance) {
  const lines = [
    "PPO Phase 6G delivery request.",
    "",
    `Project: ${acceptance.project.id}`,
    `Repository: ${acceptance.project.fullName}`,
    `Branch: ${acceptance.branch}`,
    `Base: ${PHASE_6G_DEFAULT_BASE_BRANCH}`,
    `Implementation SHA: ${acceptance.approvedSha}`,
    `Policy: ${PHASE_6G_DELIVERY_POLICY_ID}`,
    `Policy hash: ${PHASE_6G_DELIVERY_POLICY_HASH}`,
    "",
    "This PR is created from metadata-only acceptance evidence. Phase 6G stops at merged and does not deploy."
  ]
  const body = `${lines.join("\n")}\n`

  if (body.length > 1000 || sensitiveTextPattern.test(body) || unsafeMultilineOutputPattern.test(body)) {
    throw deliveryError(
      "GITHUB_DELIVERY_PR_BODY_INVALID",
      "Pull request body could not be constructed safely."
    )
  }

  return body
}

function validateExactPullRequest(pr, acceptance, expectedNumber = null) {
  const prNumber = normalizePrNumber(pr?.number)
  const branch = normalizeBranch(acceptance.branch)
  const approvedSha = normalizeSha(acceptance.approvedSha, "Approved implementation SHA")

  if (
    (expectedNumber !== null && prNumber !== expectedNumber) ||
    pr.baseRepoFullName !== acceptance.project.fullName ||
    pr.headRepoFullName !== acceptance.project.fullName ||
    pr.baseRef !== PHASE_6G_DEFAULT_BASE_BRANCH ||
    pr.headRef !== branch ||
    pr.headSha !== approvedSha ||
    pr.state !== "open" ||
    pr.draft !== false
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_PR_HEAD_MISMATCH",
      "Remote pull request no longer matches the approved exact head."
    )
  }

  return pr
}

export async function createOrReconcileApprovedPullRequest(acceptance, options = {}) {
  const client = githubClient(options)
  const branch = normalizeBranch(acceptance.branch)
  const base = PHASE_6G_DEFAULT_BASE_BRANCH
  const existing = await client.listPullRequests(acceptance.project, { branch, base })

  if (existing.length > 1) {
    throw deliveryError(
      "GITHUB_DELIVERY_PR_AMBIGUOUS",
      "Multiple matching pull requests exist; owner action is required."
    )
  }

  if (existing.length === 1) {
    return {
      ok: true,
      outcome: "pr_reused",
      pr: validateExactPullRequest(existing[0], acceptance)
    }
  }

  try {
    const created = await client.createPullRequest(acceptance.project, {
      branch,
      base,
      title: deterministicPrTitle(acceptance),
      body: deterministicPrBody(acceptance)
    })

    return {
      ok: true,
      outcome: "pr_created",
      pr: validateExactPullRequest(created, acceptance)
    }
  } catch (error) {
    if (error?.ambiguous !== true && error?.code !== "GITHUB_DELIVERY_PR_CREATE_AMBIGUOUS") {
      throw error
    }

    const reconciled = await client.listPullRequests(acceptance.project, { branch, base })

    if (reconciled.length === 1) {
      return {
        ok: true,
        outcome: "pr_create_recovered",
        pr: validateExactPullRequest(reconciled[0], acceptance)
      }
    }

    throw deliveryError(
      "GITHUB_DELIVERY_PR_CREATE_AMBIGUOUS",
      "Pull request creation outcome is ambiguous and could not be reconciled safely."
    )
  }
}

export async function reconcileRemotePullRequestHead(acceptance, prNumber, options = {}) {
  const pr = await githubClient(options).getPullRequest(acceptance.project, prNumber)

  return validateExactPullRequest(pr, acceptance, prNumber)
}

export async function requireExactHeadCi(acceptance, pr, options = {}) {
  const client = githubClient(options)
  const approvedSha = normalizeSha(acceptance.approvedSha, "Approved implementation SHA")
  const runs = await client.listWorkflowRuns(acceptance.project, {
    headSha: approvedSha,
    branch: acceptance.branch,
    prNumber: pr.number
  })
  const exactRuns = runs.filter((run) => (
    run.name === PPO_PR_VALIDATION_WORKFLOW_NAME &&
    run.headSha === approvedSha
  )).sort((a, b) => Number(b.id || 0) - Number(a.id || 0))

  if (exactRuns.length === 0) {
    throw deliveryError(
      runs.some((run) => run.headSha !== approvedSha && run.conclusion === "success")
        ? "GITHUB_DELIVERY_CI_OLDER_SHA_REJECTED"
        : "GITHUB_DELIVERY_CI_PENDING",
      "Exact-head PPO PR validation has not passed for the approved SHA."
    )
  }

  const latest = exactRuns[0]

  if (latest.status !== "completed") {
    throw deliveryError(
      "GITHUB_DELIVERY_CI_PENDING",
      "Exact-head PPO PR validation is still pending."
    )
  }

  if (latest.conclusion !== "success") {
    throw deliveryError(
      "GITHUB_DELIVERY_CI_FAILED",
      "Exact-head PPO PR validation failed."
    )
  }

  const jobs = await client.listWorkflowRunJobs(acceptance.project, latest.id)
  const completedJobs = jobs.filter((job) => job.status === "completed" && job.conclusion === "success")
  const stepConclusions = new Map()

  for (const job of completedJobs) {
    for (const step of job.steps) {
      stepConclusions.set(step.name, step)
    }
  }

  for (const stepName of REQUIRED_PPO_PR_VALIDATION_STEPS) {
    const step = stepConclusions.get(stepName)

    if (!step || step.status !== "completed" || step.conclusion !== "success") {
      throw deliveryError(
        "GITHUB_DELIVERY_CI_FAILED",
        "Exact-head PPO PR validation did not complete every required step successfully."
      )
    }
  }

  return {
    ok: true,
    outcome: "ci_passed",
    workflowName: latest.name,
    workflowRunId: latest.id,
    workflowConclusion: latest.conclusion,
    headSha: latest.headSha,
    requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length
  }
}

function publicMetadata(metadata = {}, keys = []) {
  const output = {}

  for (const key of keys) {
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

function boundedPromptLine(value, maxChars = 500) {
  return normalizeSafeText(value, {
    maxChars,
    code: "GITHUB_DELIVERY_REMOTE_REVIEW_PROMPT_UNSAFE",
    safeMessage: "Remote PR review prompt source is unsafe."
  })
}

function buildRemoteReviewPrompt(run, pr, ci, diffFacts) {
  const implementationEvidence = latestPhase6DImplementationEvidence(run)
  const testEvidence = latestPhase6EPassEvidence(run)
  const localReviewEvidence = latestPhase6FApprovedReviewEvidence(run)
  const lines = [
    "PPO Phase 6G independent exact-head remote PR review.",
    `Project: ${boundedPromptLine(run.project.id, 80)}`,
    `Repository: ${boundedPromptLine(run.project.fullName, 120)}`,
    `Pull request: ${pr.number}`,
    `Base branch: ${PHASE_6G_DEFAULT_BASE_BRANCH}`,
    `Remote head branch: ${boundedPromptLine(pr.headRef, 160)}`,
    `Remote head SHA: ${pr.headSha}`,
    `Local approved SHA: ${run.headSha}`,
    "",
    "Task:",
    boundedPromptLine(run.task, 1000),
    "",
    "Exact-head CI metadata:",
    stableStringify({
      workflowName: ci.workflowName,
      workflowRunId: ci.workflowRunId,
      workflowConclusion: ci.workflowConclusion,
      headSha: ci.headSha,
      requiredSteps: ci.requiredSteps
    }),
    "",
    "Phase 6E PASS metadata:",
    stableStringify(publicMetadata(testEvidence.metadata, [
      "attempt",
      "policyId",
      "policyHash",
      "outcome",
      "total",
      "passed",
      "failed",
      "ambiguous"
    ])),
    "",
    "Phase 6F local review metadata:",
    stableStringify(publicMetadata(localReviewEvidence.metadata, [
      "attempt",
      "reviewedSha",
      "decision",
      "mergeAllowed",
      "blockers",
      "securityFindings",
      "testsRequired",
      "outcome"
    ])),
    "",
    "Implementation metadata:",
    stableStringify(publicMetadata(implementationEvidence.metadata, [
      "attempt",
      "promptHash",
      "outcome",
      "changedFiles"
    ])),
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
    "- Review only the exact remote PR head SHA shown above.",
    "- Do not approve if the remote PR head differs from the local approved SHA.",
    "- Do not approve credential, secret, auth, deployment, GitHub write expansion, merge policy, or service-control changes.",
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

  if (prompt.length > MAX_REMOTE_REVIEW_PROMPT_CHARS || sensitiveTextPattern.test(prompt) || unsafeMultilineOutputPattern.test(prompt)) {
    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_REVIEW_PROMPT_UNSAFE",
      "Remote PR review prompt source is unsafe."
    )
  }

  return prompt
}

function reviewOutcome(decision) {
  if (decision.decision === REVIEW_DECISIONS.APPROVED) {
    return "approved"
  }

  if (decision.decision === REVIEW_DECISIONS.CHANGES_REQUESTED) {
    return "changes_requested"
  }

  return "owner_action_required"
}

function remoteReviewFindingHash(decision, reviewedSha) {
  return sha256Text(stableStringify({
    reviewedSha,
    decision: decision.decision,
    blockers: decision.blockers,
    securityFindings: decision.securityFindings,
    testsRequired: decision.testsRequired
  }))
}

function remoteReviewStartedEvidence(run, pr, promptHash, startedAt) {
  return {
    kind: "review",
    sha: normalizeSha(run.headSha, "Run head SHA"),
    source: REMOTE_PR_REVIEW_AGENT_ID,
    summary: "Remote PR review attempt reserved.",
    metadata: {
      project: run.project.id,
      reviewer: REMOTE_PR_REVIEW_AGENT_ID,
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      prNumber: pr.number,
      base: PHASE_6G_DEFAULT_BASE_BRANCH,
      branch: pr.headRef,
      reviewedSha: run.headSha,
      promptHash,
      outcome: "remote_review_started",
      sandbox: INDEPENDENT_REVIEW_SANDBOX_ID,
      network: "none",
      startedAt
    }
  }
}

function remoteReviewFindingsEvidence(run, pr, decision) {
  return {
    kind: "review",
    sha: normalizeSha(run.headSha, "Run head SHA"),
    source: REMOTE_PR_REVIEW_AGENT_ID,
    summary: "Remote PR review validated bounded findings for remediation.",
    metadata: {
      project: run.project.id,
      reviewer: REMOTE_PR_REVIEW_AGENT_ID,
      prNumber: pr.number,
      reviewedSha: run.headSha,
      decision: decision.decision,
      mergeAllowed: decision.mergeAllowed,
      blockers: decision.blockers.length,
      securityFindings: decision.securityFindings.length,
      testsRequired: decision.testsRequired.length,
      blockerItems: decision.blockers,
      securityItems: decision.securityFindings,
      testItems: decision.testsRequired,
      findingHash: remoteReviewFindingHash(decision, run.headSha),
      outcome: REVIEW_FINDINGS_EVIDENCE_OUTCOME
    }
  }
}

function remoteReviewDecisionEvidence(run, pr, promptHash, decision, endedAt) {
  return {
    kind: "review",
    sha: normalizeSha(run.headSha, "Run head SHA"),
    source: REMOTE_PR_REVIEW_AGENT_ID,
    summary: "Remote PR review completed with metadata-only decision.",
    metadata: {
      project: run.project.id,
      reviewer: REMOTE_PR_REVIEW_AGENT_ID,
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      prNumber: pr.number,
      base: PHASE_6G_DEFAULT_BASE_BRANCH,
      branch: pr.headRef,
      reviewedSha: run.headSha,
      decision: decision.decision,
      mergeAllowed: decision.mergeAllowed,
      blockers: decision.blockers.length,
      securityFindings: decision.securityFindings.length,
      testsRequired: decision.testsRequired.length,
      summaryHash: sha256Text(decision.summary),
      outcome: reviewOutcome(decision),
      endedAt
    }
  }
}

async function recordRemoteReviewDecision(run, pr, promptHash, decision, options = {}) {
  const evidence = [
    ...(decision.decision === REVIEW_DECISIONS.APPROVED ? [] : [
      remoteReviewFindingsEvidence(run, pr, decision)
    ]),
    remoteReviewDecisionEvidence(run, pr, promptHash, decision, timestamp(options))
  ]

  if (decision.decision === REVIEW_DECISIONS.APPROVED) {
    return await recordDevelopmentRunProgress(run.runId, {
      expectedVersion: run.version,
      status: "review_passed",
      actor: REMOTE_PR_REVIEW_AGENT_ID,
      reason: "phase-6g-remote-pr-review-approved",
      evidence
    }, options)
  }

  return await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "review_changes_requested",
    actor: REMOTE_PR_REVIEW_AGENT_ID,
    reason: `phase-6g-remote-pr-review-${reviewOutcome(decision)}`,
    evidence
  }, options)
}

export async function executeRemotePrReview(run, pr, ci, options = {}) {
  const latest = latestRemoteReviewEvidence(run)

  if (
    latest?.metadata?.outcome === "remote_review_started" &&
    latest?.sha === run.headSha &&
    latest?.metadata?.prNumber === pr.number
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_REVIEW_RECONCILIATION_REQUIRED",
      "Previous remote PR review attempt requires reconciliation before retrying."
    )
  }

  const config = normalizeTrustedReviewConfig(options.reviewConfig)
  const approvedSha = normalizeSha(run.headSha, "Run head SHA")
  const preflight = await reconcileTrustedReviewWorkspace(run, options)
  const diffFacts = await collectTrustedReviewDiffFacts(run, preflight.location, approvedSha, options)
  const prompt = buildRemoteReviewPrompt(run, pr, ci, diffFacts)
  const promptHash = sha256Text(prompt)

  await assertTrustedReviewSandboxActive(config, preflight.location, preflight.facts, options)

  let attemptRun = await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "review_passed",
    actor: REMOTE_PR_REVIEW_AGENT_ID,
    reason: "phase-6g-remote-pr-review-attempt",
    evidence: [remoteReviewStartedEvidence(run, pr, promptHash, timestamp(options))]
  }, options)

  const postReservation = await reconcileTrustedReviewWorkspace(attemptRun, options)
  let decision

  try {
    decision = await invokeTrustedReviewForPrompt(config, {
      cwd: postReservation.location.workspacePath,
      prompt,
      promptHash,
      reviewedSha: approvedSha,
      readOnlyPaths: trustedReviewReadOnlyPaths(postReservation.location, postReservation.facts)
    }, options)
  } catch (error) {
    if (error?.ambiguous === true || error?.code === "REVIEW_EXECUTION_AMBIGUOUS") {
      throw error
    }

    const ownerAction = {
      decision: REVIEW_DECISIONS.OWNER_ACTION_REQUIRED,
      reviewedSha: approvedSha,
      mergeAllowed: false,
      blockers: [],
      securityFindings: [],
      testsRequired: [],
      summary: "Remote PR review failed closed before a valid decision."
    }

    await recordRemoteReviewDecision(attemptRun, pr, promptHash, ownerAction, options)
    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_REVIEW_FAILED",
      "Remote PR review failed closed before a valid approval decision."
    )
  }

  await reconcileTrustedReviewWorkspace(attemptRun, options)

  if (
    decision.decision === REVIEW_DECISIONS.APPROVED &&
    (
      decision.reviewedSha !== pr.headSha ||
      decision.reviewedSha !== approvedSha ||
      decision.mergeAllowed !== true ||
      ci.outcome !== "ci_passed"
    )
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_REVIEW_CONTRADICTORY",
      "Remote PR review approval does not match exact-head delivery gates."
    )
  }

  attemptRun = await recordRemoteReviewDecision(attemptRun, pr, promptHash, decision, options)

  return {
    ok: decision.decision === REVIEW_DECISIONS.APPROVED,
    outcome: reviewOutcome(decision),
    run: attemptRun,
    review: {
      decision: decision.decision,
      reviewedSha: decision.reviewedSha,
      mergeAllowed: decision.mergeAllowed,
      blockers: decision.blockers.length,
      securityFindings: decision.securityFindings.length,
      testsRequired: decision.testsRequired.length
    }
  }
}

function assertRemoteApprovalEvidence(run, pr, approvedSha) {
  const evidence = latestRemoteReviewEvidence(run, "approved")

  if (
    !evidence ||
    evidence.sha !== approvedSha ||
    evidence.metadata?.prNumber !== pr.number ||
    evidence.metadata?.reviewedSha !== approvedSha ||
    evidence.metadata?.decision !== REVIEW_DECISIONS.APPROVED ||
    evidence.metadata?.mergeAllowed !== true ||
    Number(evidence.metadata?.blockers || 0) !== 0 ||
    Number(evidence.metadata?.securityFindings || 0) !== 0 ||
    Number(evidence.metadata?.testsRequired || 0) !== 0
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_REMOTE_REVIEW_REQUIRED",
      "Exact-head remote PR review approval is required before merge readiness."
    )
  }

  return evidence
}

async function transitionToMergeReady(run, acceptance, pr, ci, options = {}) {
  const approvedSha = normalizeSha(acceptance.approvedSha, "Approved implementation SHA")
  const remoteReview = assertRemoteApprovalEvidence(run, pr, approvedSha)
  const readyEvidence = deliveryEvidence(run, approvedSha, "merge_ready", {
    prNumber: pr.number,
    branch: acceptance.branch,
    base: PHASE_6G_DEFAULT_BASE_BRANCH,
    prHeadSha: pr.headSha,
    workflowRunId: ci.workflowRunId,
    remoteReviewedSha: remoteReview.metadata.reviewedSha,
    remoteDecision: remoteReview.metadata.decision,
    preparedAt: timestamp(options)
  }, "Phase 6G merge-ready gate passed for exact remote PR head.")

  return await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "merge_ready",
    branch: acceptance.branch,
    headSha: approvedSha,
    actor: GITHUB_DELIVERY_AGENT_ID,
    reason: "phase-6g-merge-ready",
    evidence: [readyEvidence]
  }, options)
}

export async function executeGitHubDeliveryToMergeReady(runId, options = {}) {
  normalizeExpectedVersion(options.expectedVersion)
  let acceptance = await assertDevelopmentAcceptanceGate(runId, options)
  let run = acceptance.run
  const push = await pushApprovedBranch(acceptance, options)

  run = await recordDeliveryProgress(run, deliveryEvidence(run, acceptance.approvedSha, push.outcome, {
    branch: acceptance.branch,
    pushedSha: acceptance.approvedSha,
    previousRemoteSha: push.previousRemoteSha || "",
    remoteBranchSha: push.remoteBranchSha,
    pushedAt: timestamp(options)
  }, "Approved implementation SHA was pushed or reconciled on the approved branch."), options, "phase-6g-branch-push")

  acceptance = await assertDevelopmentAcceptanceGate(runId, {
    ...options,
    expectedVersion: run.version
  })

  const prResult = await createOrReconcileApprovedPullRequest(acceptance, options)
  let pr = prResult.pr

  run = await recordDeliveryProgress(run, deliveryEvidence(run, acceptance.approvedSha, prResult.outcome, {
    branch: acceptance.branch,
    base: PHASE_6G_DEFAULT_BASE_BRANCH,
    prNumber: pr.number,
    prHeadSha: pr.headSha,
    reconciledAt: timestamp(options)
  }, "Approved pull request was created or reconciled deterministically."), options, "phase-6g-pr-reconcile")

  acceptance = await assertDevelopmentAcceptanceGate(runId, {
    ...options,
    expectedVersion: run.version
  })
  pr = await reconcileRemotePullRequestHead(acceptance, pr.number, options)

  const ci = await requireExactHeadCi(acceptance, pr, options)

  run = await recordDeliveryProgress(run, deliveryEvidence(run, acceptance.approvedSha, "ci_passed", {
    prNumber: pr.number,
    workflowName: ci.workflowName,
    workflowRunId: ci.workflowRunId,
    workflowConclusion: ci.workflowConclusion,
    requiredSteps: ci.requiredSteps,
    checkedAt: timestamp(options)
  }, "Exact-head PPO PR validation passed."), options, "phase-6g-ci-pass")

  const remoteReview = await executeRemotePrReview(run, pr, ci, options)
  run = remoteReview.run

  if (!remoteReview.ok) {
    return {
      ok: false,
      outcome: remoteReview.outcome,
      run,
      pr,
      ci,
      remoteReview: remoteReview.review
    }
  }

  acceptance = await assertDevelopmentAcceptanceGate(runId, {
    ...options,
    expectedVersion: run.version
  })
  pr = await reconcileRemotePullRequestHead(acceptance, pr.number, options)
  const finalCi = await requireExactHeadCi(acceptance, pr, options)

  assertRemoteApprovalEvidence(run, pr, acceptance.approvedSha)

  const mergeReady = await transitionToMergeReady(run, acceptance, pr, finalCi, options)

  return {
    ok: true,
    outcome: "merge_ready",
    run: mergeReady,
    pr,
    ci: finalCi,
    remoteReview: {
      decision: REVIEW_DECISIONS.APPROVED,
      reviewedSha: acceptance.approvedSha,
      mergeAllowed: true
    }
  }
}

function latestMergeReadyEvidence(run) {
  return latestDeliveryEvidence(run, "merge_ready")
}

function latestMergeStartedEvidence(run) {
  return latestDeliveryEvidence(run, "merge_started")
}

function latestMergedEvidence(run) {
  return latestDeliveryEvidence(run, "merged")
}

async function mergeReadyFacts(run, options = {}) {
  const ready = latestMergeReadyEvidence(run)
  const approvedSha = normalizeSha(run.headSha, "Run head SHA")

  if (
    !ready ||
    ready.sha !== approvedSha ||
    ready.metadata?.implementationSha !== approvedSha ||
    ready.metadata?.remoteReviewedSha !== approvedSha ||
    ready.metadata?.remoteDecision !== REVIEW_DECISIONS.APPROVED
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_MERGE_READY_REQUIRED",
      "Run must have exact-head merge-ready evidence before merge."
    )
  }

  const acceptanceLike = {
    project: run.project,
    approvedSha,
    branch: ready.metadata.branch,
    base: PHASE_6G_DEFAULT_BASE_BRANCH
  }
  const pr = validateExactPullRequest(
    await githubClient(options).getPullRequest(run.project, ready.metadata.prNumber),
    acceptanceLike,
    ready.metadata.prNumber
  )
  const ci = await requireExactHeadCi(acceptanceLike, pr, options)
  const remoteReview = assertRemoteApprovalEvidence(run, pr, approvedSha)

  if (pr.mergeable !== true) {
    throw deliveryError(
      "GITHUB_DELIVERY_PR_NOT_MERGEABLE",
      "Pull request is not mergeable for the exact reviewed head."
    )
  }

  return {
    ready,
    pr,
    ci,
    remoteReview,
    approvedSha
  }
}

async function reconcileMergeCompletion(run, facts, options = {}) {
  const client = githubClient(options)
  const pr = await client.getPullRequest(run.project, facts.pr.number)

  if (
    pr.number !== facts.pr.number ||
    pr.baseRef !== PHASE_6G_DEFAULT_BASE_BRANCH ||
    pr.headRef !== facts.pr.headRef ||
    pr.headSha !== facts.approvedSha ||
    pr.baseRepoFullName !== run.project.fullName ||
    pr.headRepoFullName !== run.project.fullName
  ) {
    throw deliveryError(
      "GITHUB_DELIVERY_MERGE_RECONCILE_CONFLICT",
      "Merged pull request state conflicts with the expected exact head."
    )
  }

  if (pr.merged !== true || !pr.mergeCommitSha) {
    throw deliveryError(
      "GITHUB_DELIVERY_MERGE_RECONCILE_CONFLICT",
      "Ambiguous merge could not be proven successful; owner action is required."
    )
  }

  const main = await client.getBranchRef(run.project, PHASE_6G_DEFAULT_BASE_BRANCH)

  if (main.sha !== pr.mergeCommitSha) {
    throw deliveryError(
      "GITHUB_DELIVERY_MERGE_RECONCILE_CONFLICT",
      "Main branch does not reflect the expected merge commit."
    )
  }

  return {
    pr,
    mergeCommitSha: pr.mergeCommitSha,
    mainSha: main.sha
  }
}

async function transitionMerged(run, facts, completed, options = {}) {
  const evidence = deliveryEvidence(run, facts.approvedSha, "merged", {
    prNumber: facts.pr.number,
    expectedHeadSha: facts.approvedSha,
    mergeMethod: PHASE_6G_APPROVED_MERGE_METHOD,
    mergeCommitSha: completed.mergeCommitSha,
    mainSha: completed.mainSha,
    mergedAt: timestamp(options)
  }, "Phase 6G exact-head pull request merge was verified.")

  return await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "merged",
    branch: facts.pr.headRef,
    headSha: facts.approvedSha,
    actor: GITHUB_DELIVERY_AGENT_ID,
    reason: "phase-6g-exact-head-merged",
    evidence: [evidence]
  }, options)
}

export async function executeShaPinnedMerge(runId, options = {}) {
  const expectedVersion = normalizeExpectedVersion(options.expectedVersion)
  let run = await readDevelopmentRun(runId, options)

  if (run.version !== expectedVersion) {
    throw deliveryError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  if (run.status !== "merge_ready") {
    throw deliveryError(
      "GITHUB_DELIVERY_RUN_NOT_MERGE_READY",
      "Development run must be merge_ready before SHA-pinned merge."
    )
  }

  let facts = await mergeReadyFacts(run, options)

  if (latestMergedEvidence(run)?.metadata?.mergeCommitSha) {
    const completed = await reconcileMergeCompletion(run, facts, options)

    return {
      ok: true,
      outcome: "merged",
      run,
      pr: completed.pr,
      merge: {
        implementationSha: facts.approvedSha,
        mergeCommitSha: completed.mergeCommitSha,
        mainSha: completed.mainSha
      }
    }
  }

  if (latestMergeStartedEvidence(run)?.sha === facts.approvedSha) {
    const completed = await reconcileMergeCompletion(run, facts, options)
    const mergedRun = await transitionMerged(run, facts, completed, options)

    return {
      ok: true,
      outcome: "merged",
      run: mergedRun,
      pr: completed.pr,
      merge: {
        implementationSha: facts.approvedSha,
        mergeCommitSha: completed.mergeCommitSha,
        mainSha: completed.mainSha
      }
    }
  }

  run = await recordDeliveryProgress(run, deliveryEvidence(run, facts.approvedSha, "merge_started", {
    prNumber: facts.pr.number,
    expectedHeadSha: facts.approvedSha,
    mergeMethod: PHASE_6G_APPROVED_MERGE_METHOD,
    startedAt: timestamp(options)
  }, "Phase 6G exact-head merge attempt was reserved."), options, "phase-6g-merge-start")

  facts = await mergeReadyFacts(run, options)

  try {
    const merge = await githubClient(options).mergePullRequest(run.project, {
      prNumber: facts.pr.number,
      expectedHeadSha: facts.approvedSha,
      method: PHASE_6G_APPROVED_MERGE_METHOD
    })

    if (merge.merged !== true) {
      throw deliveryError(
        "GITHUB_DELIVERY_MERGE_FAILED",
        "GitHub did not confirm the exact-head merge."
      )
    }
  } catch (error) {
    if (error?.ambiguous !== true && error?.code !== "GITHUB_DELIVERY_MERGE_AMBIGUOUS") {
      throw error
    }
  }

  const completed = await reconcileMergeCompletion(run, facts, options)
  const mergedRun = await transitionMerged(run, facts, completed, options)

  return {
    ok: true,
    outcome: "merged",
    run: mergedRun,
    pr: completed.pr,
    merge: {
      implementationSha: facts.approvedSha,
      mergeCommitSha: completed.mergeCommitSha,
      mainSha: completed.mainSha
    }
  }
}

export async function executePhase6GDelivery(runId, options = {}) {
  try {
    const delivered = await executeGitHubDeliveryToMergeReady(runId, options)

    if (!delivered.ok) {
      return delivered
    }

    return await executeShaPinnedMerge(runId, {
      ...options,
      expectedVersion: delivered.run.version
    })
  } catch (error) {
    throw safeDeliveryFailure(error)
  }
}

export async function reconcileGitHubDelivery(runId, options = {}) {
  try {
    const run = await readDevelopmentRun(runId, options)
    const approvedSha = run.headSha ? normalizeSha(run.headSha, "Run head SHA") : null
    const latestPush = latestDeliveryEvidence(run)
    const latestReady = latestMergeReadyEvidence(run)
    const latestReview = latestRemoteReviewEvidence(run)
    let remoteBranchSha = null
    let pr = null
    let ciStatus = "unknown"
    let mergeStatus = run.status

    if (run.branch && approvedSha) {
      try {
        const acceptance = run.status === "review_passed"
          ? await assertDevelopmentAcceptanceGate(runId, {
            ...options,
            expectedVersion: run.version
          })
          : null
        const location = acceptance?.workspace?.location

        if (location) {
          remoteBranchSha = await readRemoteBranchSha(location, run.branch, options)
        }
      } catch {
        remoteBranchSha = null
      }
    }

    if (latestReady?.metadata?.prNumber) {
      try {
        pr = await githubClient(options).getPullRequest(run.project, latestReady.metadata.prNumber)

        if (approvedSha && pr.headSha === approvedSha) {
          try {
            await requireExactHeadCi({
              project: run.project,
              approvedSha,
              branch: pr.headRef
            }, pr, options)
            ciStatus = "passed"
          } catch (error) {
            ciStatus = error?.code === "GITHUB_DELIVERY_CI_PENDING" ? "pending" : "failed"
          }
        }
      } catch {
        pr = null
      }
    }

    if (run.status === "merge_ready" && latestReady?.metadata?.prNumber) {
      try {
        const facts = await mergeReadyFacts(run, options)
        const completed = await reconcileMergeCompletion(run, facts, options)
        mergeStatus = completed.mergeCommitSha ? "merged_remote" : "merge_ready"
      } catch {
        mergeStatus = "merge_ready"
      }
    }

    return {
      ok: true,
      outcome: "github_delivery_reconciled",
      run: {
        runId: run.runId,
        version: run.version,
        status: run.status,
        project: run.project.id,
        headSha: approvedSha
      },
      delivery: {
        policyId: PHASE_6G_DELIVERY_POLICY_ID,
        policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
        branch: run.branch,
        remoteBranchSha,
        latestOutcome: latestPush?.metadata?.outcome || null,
        prNumber: latestReady?.metadata?.prNumber || null,
        prHeadSha: pr?.headSha || null,
        ciStatus,
        remoteReviewOutcome: latestReview?.metadata?.outcome || null,
        mergeStatus
      }
    }
  } catch (error) {
    throw safeDeliveryFailure(error)
  }
}

export function formatGitHubDeliveryAgentError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO GitHub delivery error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO GitHub delivery error: unexpected local failure."
}

export const phase6GDeliverySecurityBoundary = Object.freeze({
  gate: DEVELOPMENT_ACCEPTANCE_GATE_ID,
  policyId: PHASE_6G_DELIVERY_POLICY_ID,
  policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
  writes: Object.freeze([
    "push-approved-branch-sha",
    "create-approved-pr",
    "merge-approved-pr-head"
  ]),
  mergeMethod: PHASE_6G_APPROVED_MERGE_METHOD,
  deploys: false
})
