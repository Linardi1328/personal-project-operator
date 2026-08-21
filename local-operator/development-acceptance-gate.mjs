import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  readDevelopmentRun,
  resolveDevelopmentRunProject
} from "./development-run-state.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  PHASE_6F_HARDENING_ORCHESTRATOR_ID
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID
} from "./development-test-runner.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REVIEW_DECISIONS
} from "./development-review-agent.mjs"
import {
  makeDevelopmentWorkspaceBranchName,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"

const execFileAsync = promisify(execFile)

export const DEVELOPMENT_ACCEPTANCE_GATE_ID = "phase-6g-deterministic-acceptance-gate"
export const PHASE_6G_DELIVERY_POLICY_ID = "phase-6g-acceptance-github-delivery-v1"
export const PHASE_6G_DEFAULT_BASE_BRANCH = "main"
export const MAX_ACCEPTANCE_GIT_OUTPUT_BYTES = 24 * 1024
export const MAX_ACCEPTANCE_GIT_TIMEOUT_MS = 15000

const shaPattern = /^[a-f0-9]{40}$/u
const safeRemotePatterns = [
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu,
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu,
  /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu
]
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const unsafeMultilineOutputPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F])/u

export const PHASE_6G_DELIVERY_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify({
    policyId: PHASE_6G_DELIVERY_POLICY_ID,
    gate: DEVELOPMENT_ACCEPTANCE_GATE_ID,
    requiredStatus: "review_passed",
    baseBranch: PHASE_6G_DEFAULT_BASE_BRANCH,
    shaPinned: true,
    noModelAcceptance: true
  }))
  .digest("hex")

export class DevelopmentAcceptanceGateError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentAcceptanceGateError"
  }
}

function acceptanceError(code, safeMessage) {
  return new DevelopmentAcceptanceGateError(code, safeMessage)
}

function safeAcceptanceFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return acceptanceError(
    "ACCEPTANCE_GATE_UNAVAILABLE",
    "Acceptance gate is unavailable; no raw failure was stored."
  )
}

function normalizeSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw acceptanceError(
      "ACCEPTANCE_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw acceptanceError(
      "ACCEPTANCE_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required."
    )
  }

  return value
}

function assertSafeLine(value, code, safeMessage) {
  const normalized = String(value ?? "").trim()

  if (!normalized || normalized.length > MAX_ACCEPTANCE_GIT_OUTPUT_BYTES || unsafeControlPattern.test(normalized)) {
    throw acceptanceError(code, safeMessage)
  }

  return normalized.split(/\r?\n/u)[0].trim()
}

function githubIdentityFromRemote(remoteUrl) {
  const normalized = String(remoteUrl ?? "").trim()

  if (!normalized || normalized.length > 200 || unsafeControlPattern.test(normalized)) {
    throw acceptanceError(
      "ACCEPTANCE_REPOSITORY_IDENTITY_INVALID",
      "Repository identity is not approved for this run."
    )
  }

  for (const pattern of safeRemotePatterns) {
    const match = normalized.match(pattern)

    if (match) {
      return `${match[1]}/${match[2].replace(/\.git$/iu, "")}`
    }
  }

  throw acceptanceError(
    "ACCEPTANCE_REPOSITORY_IDENTITY_INVALID",
    "Repository identity is not approved for this run."
  )
}

function defaultBranchBlocked(branchName) {
  return branchName === PHASE_6G_DEFAULT_BASE_BRANCH || branchName === "master"
}

function assertGitArgs(args) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || !entry)) {
    throw acceptanceError(
      "ACCEPTANCE_GIT_OPERATION_REFUSED",
      "Git verification operation is not approved for the acceptance gate."
    )
  }

  const command = args[2]
  const subcommand = args[3]
  const branchRef = (value) => typeof value === "string" && value.startsWith("refs/heads/")
  const exactShape = (
    args[0] === "-C" &&
    typeof args[1] === "string" &&
    (
      (command === "rev-parse" && args.length === 4 && (
        subcommand === "--show-toplevel" ||
        subcommand === "--git-dir" ||
        subcommand === "--git-common-dir" ||
        subcommand === "HEAD" ||
        branchRef(subcommand)
      )) ||
      (command === "symbolic-ref" && args.length === 5 && subcommand === "--short" && args[4] === "HEAD") ||
      (command === "status" && args.length === 5 && subcommand === "--porcelain=v1" && args[4] === "--untracked-files=all") ||
      (command === "remote" && args.length === 5 && subcommand === "get-url" && args[4] === "origin")
    )
  )

  if (!exactShape) {
    throw acceptanceError(
      "ACCEPTANCE_GIT_OPERATION_REFUSED",
      "Git verification operation is not approved for the acceptance gate."
    )
  }
}

async function runGit(args, options = {}) {
  assertGitArgs(args)

  if (options.gitRunner) {
    const result = await options.gitRunner(args)
    return {
      stdout: String(result?.stdout ?? ""),
      stderr: "",
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0
    }
  }

  try {
    const result = await execFileAsync("git", args, {
      encoding: "utf8",
      maxBuffer: MAX_ACCEPTANCE_GIT_OUTPUT_BYTES,
      timeout: MAX_ACCEPTANCE_GIT_TIMEOUT_MS,
      shell: false
    })

    return {
      stdout: result.stdout,
      stderr: "",
      exitCode: 0
    }
  } catch {
    throw acceptanceError(
      "ACCEPTANCE_GIT_VERIFY_FAILED",
      "Git verification failed; no raw Git output was stored."
    )
  }
}

async function gitLine(cwd, args, options, code, safeMessage) {
  const result = await runGit(["-C", cwd, ...args], options)

  return assertSafeLine(result.stdout, code, safeMessage)
}

async function gitText(cwd, args, options) {
  const result = await runGit(["-C", cwd, ...args], options)
  const output = String(result.stdout ?? "")

  if (Buffer.byteLength(output, "utf8") > MAX_ACCEPTANCE_GIT_OUTPUT_BYTES || unsafeMultilineOutputPattern.test(output)) {
    throw acceptanceError(
      "ACCEPTANCE_GIT_VERIFY_FAILED",
      "Git verification output is invalid."
    )
  }

  return output.trim()
}

async function canonicalPath(cwd, value, code, safeMessage) {
  const rawPath = assertSafeLine(value, code, safeMessage)
  const absolutePath = isAbsolute(rawPath)
    ? rawPath
    : resolvePath(cwd, rawPath)
  const realPath = await realpath(absolutePath).catch(() => {
    throw acceptanceError(code, safeMessage)
  })

  if (!isAbsolute(realPath) || realPath !== resolvePath(realPath)) {
    throw acceptanceError(code, safeMessage)
  }

  return realPath
}

export async function verifyAcceptanceWorkspace(run, options = {}) {
  const project = resolveDevelopmentRunProject(run?.project?.id)
  const approvedSha = normalizeSha(run?.headSha, "Run head SHA")
  const expectedBranch = makeDevelopmentWorkspaceBranchName(run)

  if (run.branch !== expectedBranch || defaultBranchBlocked(run.branch)) {
    throw acceptanceError(
      "ACCEPTANCE_WORKSPACE_BRANCH_MISMATCH",
      "Implementation branch is not the canonical Phase 6C branch."
    )
  }

  const location = await resolveImplementationWorkspaceLocation(run, options)
  const info = await stat(location.workspacePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw acceptanceError(
        "ACCEPTANCE_WORKSPACE_NOT_READY",
        "Phase 6C implementation workspace is missing."
      )
    }

    throw error
  })

  if (!info.isDirectory()) {
    throw acceptanceError(
      "ACCEPTANCE_WORKSPACE_NOT_READY",
      "Phase 6C implementation workspace is missing."
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
    throw acceptanceError(
      "ACCEPTANCE_WORKSPACE_NOT_CANONICAL",
      "Phase 6C implementation workspace is not canonical."
    )
  }

  const facts = {
    topLevel: await gitLine(location.workspacePath, ["rev-parse", "--show-toplevel"], options, "ACCEPTANCE_WORKSPACE_NOT_CANONICAL", "Phase 6C implementation workspace is not canonical."),
    branch: await gitLine(location.workspacePath, ["symbolic-ref", "--short", "HEAD"], options, "ACCEPTANCE_WORKSPACE_BRANCH_MISMATCH", "Implementation workspace is detached or on the wrong branch."),
    headSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", "HEAD"], options, "ACCEPTANCE_WORKSPACE_HEAD_MISMATCH", "Implementation workspace HEAD does not match the approved run SHA."), "Workspace HEAD"),
    branchHeadSha: normalizeSha(await gitLine(location.workspacePath, ["rev-parse", `refs/heads/${location.branch}`], options, "ACCEPTANCE_WORKSPACE_HEAD_MISMATCH", "Implementation branch HEAD does not match the approved run SHA."), "Implementation branch HEAD"),
    dirtyStatus: await gitText(location.workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"], options),
    gitDir: await canonicalPath(location.workspacePath, await gitLine(location.workspacePath, ["rev-parse", "--git-dir"], options, "ACCEPTANCE_WORKSPACE_NOT_CANONICAL", "Phase 6C implementation workspace is not canonical."), "ACCEPTANCE_WORKSPACE_NOT_CANONICAL", "Phase 6C implementation workspace is not canonical."),
    gitCommonDir: await canonicalPath(location.workspacePath, await gitLine(location.workspacePath, ["rev-parse", "--git-common-dir"], options, "ACCEPTANCE_WORKSPACE_NOT_CANONICAL", "Phase 6C implementation workspace is not canonical."), "ACCEPTANCE_WORKSPACE_NOT_CANONICAL", "Phase 6C implementation workspace is not canonical."),
    remoteIdentity: githubIdentityFromRemote(await gitLine(location.workspacePath, ["remote", "get-url", "origin"], options, "ACCEPTANCE_REPOSITORY_IDENTITY_INVALID", "Repository identity is not approved for this run."))
  }

  if (
    facts.topLevel !== location.workspacePath ||
    facts.branch !== location.branch ||
    facts.headSha !== approvedSha ||
    facts.branchHeadSha !== approvedSha ||
    facts.remoteIdentity !== project.fullName
  ) {
    throw acceptanceError(
      "ACCEPTANCE_WORKSPACE_MISMATCH",
      "Phase 6C workspace does not match the approved run SHA, branch, or repository."
    )
  }

  if (facts.dirtyStatus) {
    throw acceptanceError(
      "ACCEPTANCE_WORKSPACE_DIRTY",
      "Phase 6C implementation workspace must be clean before delivery."
    )
  }

  return {
    location,
    facts
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

export function latestPhase6DImplementationEvidence(run) {
  return latestEvidence(run, "implementation", (entry) => (
    entry?.source === CODEX_EXECUTION_ADAPTER_ID ||
    entry?.metadata?.adapter === CODEX_EXECUTION_ADAPTER_ID
  ))
}

export function latestPhase6EPassEvidence(run) {
  return latestEvidence(run, "test", (entry) => (
    (entry?.source === AUTOMATED_TEST_RUNNER_ID || entry?.metadata?.runner === AUTOMATED_TEST_RUNNER_ID) &&
    entry?.metadata?.outcome === "passed"
  ))
}

export function latestPhase6FReviewEvidence(run) {
  return latestEvidence(run, "review", (entry) => (
    entry?.source === INDEPENDENT_REVIEW_AGENT_ID ||
    entry?.metadata?.reviewer === INDEPENDENT_REVIEW_AGENT_ID
  ))
}

export function latestPhase6FApprovedReviewEvidence(run) {
  return latestEvidence(run, "review", (entry) => (
    (entry?.source === INDEPENDENT_REVIEW_AGENT_ID || entry?.metadata?.reviewer === INDEPENDENT_REVIEW_AGENT_ID) &&
    entry?.metadata?.decision === REVIEW_DECISIONS.APPROVED &&
    entry?.metadata?.outcome === "approved"
  ))
}

function latestHardeningEvidence(run) {
  const implementation = Array.isArray(run?.evidence?.implementation) ? run.evidence.implementation : []
  const review = Array.isArray(run?.evidence?.review) ? run.evidence.review : []
  const evidence = [...implementation, ...review]

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      entry?.source === PHASE_6F_HARDENING_ORCHESTRATOR_ID ||
      entry?.metadata?.orchestrator === PHASE_6F_HARDENING_ORCHESTRATOR_ID
    ) {
      return entry
    }
  }

  return null
}

function assertNoOpenOrAmbiguousAttempts(run, approvedSha) {
  const implementation = latestPhase6DImplementationEvidence(run)
  const test = latestEvidence(run, "test", (entry) => (
    entry?.source === AUTOMATED_TEST_RUNNER_ID ||
    entry?.metadata?.runner === AUTOMATED_TEST_RUNNER_ID
  ))
  const review = latestPhase6FReviewEvidence(run)
  const hardening = latestHardeningEvidence(run)
  const entries = [implementation, test, review, hardening].filter(Boolean)

  for (const entry of entries) {
    const outcome = entry?.metadata?.outcome
    const relatedSha = entry?.sha === approvedSha ||
      entry?.metadata?.implSha === approvedSha ||
      entry?.metadata?.reviewedSha === approvedSha ||
      entry?.metadata?.sourceReviewSha === approvedSha

    if (!relatedSha) {
      continue
    }

    if (["execution_started", "testing_started", "review_started", "hardening_started"].includes(outcome)) {
      throw acceptanceError(
        "ACCEPTANCE_RECONCILIATION_REQUIRED",
        "An open implementation, test, review, or hardening attempt requires reconciliation before delivery."
      )
    }

    if (entry?.metadata?.ambiguous === true || Number(entry?.metadata?.ambiguous || 0) > 0) {
      throw acceptanceError(
        "ACCEPTANCE_RECONCILIATION_REQUIRED",
        "Ambiguous implementation, test, review, or hardening evidence requires reconciliation before delivery."
      )
    }
  }

  if (
    hardening?.metadata?.outcome === "owner_action_required" ||
    hardening?.metadata?.nonConverged === true ||
    hardening?.metadata?.reason === "max_hardening_rounds_exhausted"
  ) {
    throw acceptanceError(
      "ACCEPTANCE_HARDENING_NOT_CONVERGED",
      "Hardening ended with owner action required or non-convergence."
    )
  }
}

function assertEvidenceChain(run, approvedSha) {
  const implementation = latestPhase6DImplementationEvidence(run)
  const tests = latestPhase6EPassEvidence(run)
  const review = latestPhase6FApprovedReviewEvidence(run)
  const latestReview = latestPhase6FReviewEvidence(run)

  if (
    !implementation ||
    implementation.sha !== approvedSha ||
    implementation.metadata?.outcome !== "implementation_ready"
  ) {
    throw acceptanceError(
      "ACCEPTANCE_IMPLEMENTATION_EVIDENCE_MISMATCH",
      "Valid Phase 6D implementation evidence does not match the approved run SHA."
    )
  }

  if (
    !tests ||
    tests.sha !== approvedSha ||
    tests.metadata?.implSha !== approvedSha ||
    tests.metadata?.outcome !== "passed" ||
    Number(tests.metadata?.failed || 0) !== 0 ||
    Number(tests.metadata?.ambiguous || 0) !== 0
  ) {
    throw acceptanceError(
      "ACCEPTANCE_TEST_EVIDENCE_MISMATCH",
      "Valid Phase 6E PASS evidence does not match the approved run SHA."
    )
  }

  if (
    !review ||
    !latestReview ||
    latestReview !== review ||
    review.sha !== approvedSha ||
    review.metadata?.reviewedSha !== approvedSha ||
    review.metadata?.decision !== REVIEW_DECISIONS.APPROVED ||
    review.metadata?.mergeAllowed !== true ||
    Number(review.metadata?.blockers || 0) !== 0 ||
    Number(review.metadata?.securityFindings || 0) !== 0 ||
    Number(review.metadata?.testsRequired || 0) !== 0
  ) {
    throw acceptanceError(
      "ACCEPTANCE_REVIEW_EVIDENCE_MISMATCH",
      "Valid Phase 6F APPROVED review evidence does not match the approved run SHA."
    )
  }

  return {
    implementation,
    tests,
    review
  }
}

async function assertDevelopmentAcceptanceGateInternal(runId, options = {}) {
  const expectedVersion = normalizeExpectedVersion(options.expectedVersion)
  const run = await readDevelopmentRun(runId, options)

  if (run.version !== expectedVersion) {
    throw acceptanceError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  if (run.status !== "review_passed") {
    throw acceptanceError(
      "ACCEPTANCE_RUN_NOT_REVIEW_PASSED",
      "Development run must be review_passed before GitHub delivery."
    )
  }

  const project = resolveDevelopmentRunProject(run.project.id)

  if (
    run.project.displayName !== project.displayName ||
    run.project.owner !== project.owner ||
    run.project.repo !== project.repo ||
    run.project.fullName !== project.fullName
  ) {
    throw acceptanceError(
      "ACCEPTANCE_PROJECT_MISMATCH",
      "Run project does not match the approved project registry."
    )
  }

  const approvedSha = normalizeSha(run.headSha, "Run head SHA")
  const branch = String(run.branch || "")

  if (!branch || defaultBranchBlocked(branch)) {
    throw acceptanceError(
      "ACCEPTANCE_DEFAULT_BRANCH_REFUSED",
      "Delivery branch must not be a protected default branch."
    )
  }

  const evidence = assertEvidenceChain(run, approvedSha)
  const workspace = await verifyAcceptanceWorkspace(run, options)

  assertNoOpenOrAmbiguousAttempts(run, approvedSha)

  if (
    evidence.implementation.sha !== evidence.tests.sha ||
    evidence.tests.metadata?.implSha !== evidence.review.metadata?.reviewedSha ||
    evidence.review.metadata?.reviewedSha !== workspace.facts.headSha
  ) {
    throw acceptanceError(
      "ACCEPTANCE_SHA_CHAIN_MISMATCH",
      "Reviewed, tested, implementation, and workspace SHAs must all match."
    )
  }

  return {
    ok: true,
    outcome: "acceptance_passed",
    deliveryAllowed: true,
    policy: {
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH
    },
    run,
    project,
    approvedSha,
    branch,
    base: PHASE_6G_DEFAULT_BASE_BRANCH,
    workspace: {
      location: workspace.location,
      facts: workspace.facts
    },
    evidence: {
      implementationSha: evidence.implementation.sha,
      testedSha: evidence.tests.sha,
      reviewedSha: evidence.review.metadata.reviewedSha,
      mergeAllowed: evidence.review.metadata.mergeAllowed
    }
  }
}

export async function assertDevelopmentAcceptanceGate(runId, options = {}) {
  try {
    return await assertDevelopmentAcceptanceGateInternal(runId, options)
  } catch (error) {
    throw safeAcceptanceFailure(error)
  }
}

export async function evaluateDevelopmentAcceptanceGate(runId, options = {}) {
  try {
    return await assertDevelopmentAcceptanceGateInternal(runId, options)
  } catch (error) {
    const failure = safeAcceptanceFailure(error)

    return {
      ok: true,
      outcome: "acceptance_failed",
      deliveryAllowed: false,
      code: failure.code,
      safeMessage: failure.safeMessage
    }
  }
}

export function formatDevelopmentAcceptanceGateError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO acceptance gate error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO acceptance gate error: unexpected local failure."
}
