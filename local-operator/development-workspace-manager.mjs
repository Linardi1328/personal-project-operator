import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve as resolvePath, relative, join, sep } from "node:path"
import { promisify } from "node:util"
import {
  DevelopmentRunStateError,
  readDevelopmentRun,
  resolveDevelopmentRunProject,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"

const execFileAsync = promisify(execFile)

export const DEVELOPMENT_WORKSPACE_MANAGER_ID = "phase-6c-workspace-manager"
export const DEVELOPMENT_WORKSPACE_STORE_DIR = "development-workspaces"
export const MAX_WORKSPACE_PATH_CHARS = 240
export const MAX_WORKSPACE_BRANCH_CHARS = 120
export const MAX_WORKSPACE_GIT_OUTPUT_BYTES = 24 * 1024
export const MAX_WORKSPACE_GIT_TIMEOUT_MS = 15000

const shaPattern = /^[a-f0-9]{40}$/u
const pathSegmentPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u
const workspaceIdPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const safeRemotePatterns = [
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu,
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu,
  /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu
]

class DevelopmentWorkspaceManagerError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentWorkspaceManagerError"
  }
}

function workspaceError(code, safeMessage) {
  return new DevelopmentWorkspaceManagerError(code, safeMessage)
}

function safeWorkspaceFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return workspaceError(
    "WORKSPACE_MANAGER_UNAVAILABLE",
    "Development workspace manager is unavailable; no raw failure was stored."
  )
}

function validateSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw workspaceError(
      "WORKSPACE_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function boundedSafeString(value, {
  code,
  safeMessage,
  maxChars
}) {
  const normalized = String(value ?? "").trim()

  if (!normalized || normalized.length > maxChars || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw workspaceError(code, safeMessage)
  }

  return normalized
}

function configuredWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PPO_WRITE_DATA_DIR
}

function defaultWorkspaceRoot(options = {}) {
  return join(configuredWriteDataDir(options), DEVELOPMENT_WORKSPACE_STORE_DIR)
}

function assertPathSegment(value, fieldName) {
  if (!pathSegmentPattern.test(value)) {
    throw workspaceError(
      "WORKSPACE_REGISTRY_INVALID",
      `${fieldName} is not approved for workspace management.`
    )
  }
}

function assertWithinRoot(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath)

  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw workspaceError(
      "WORKSPACE_PATH_ESCAPE",
      "Workspace path is outside the PPO-managed workspace root."
    )
  }
}

function normalizeAbsolutePath(value, fieldName) {
  const normalized = boundedSafeString(value, {
    code: "WORKSPACE_REGISTRY_INVALID",
    safeMessage: `${fieldName} is not approved for workspace management.`,
    maxChars: MAX_WORKSPACE_PATH_CHARS
  })

  if (normalized !== resolvePath(normalized) || normalized.includes("\0")) {
    throw workspaceError(
      "WORKSPACE_REGISTRY_INVALID",
      `${fieldName} is not approved for workspace management.`
    )
  }

  return normalized
}

async function assertNotSymlink(path, code, safeMessage) {
  let info

  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  }

  if (info.isSymbolicLink()) {
    throw workspaceError(code, safeMessage)
  }

  return info
}

function assertNotNested(pathA, pathB, code, safeMessage) {
  const a = resolvePath(pathA)
  const b = resolvePath(pathB)

  const containsOrSame = (parent, child) => {
    const relation = relative(parent, child)
    return !relation || (
      relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation)
    )
  }

  if (containsOrSame(a, b) || containsOrSame(b, a)) {
    throw workspaceError(code, safeMessage)
  }
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function workspaceRunMaterial(run) {
  return stableHash({
    runId: run.runId,
    project: run.project.id,
    stage: "implementation",
    baseSha: run.baseSha
  }).slice(0, 16)
}

export function makeDevelopmentWorkspaceBranchName(run) {
  const projectId = resolveDevelopmentRunProject(run?.project?.id).id
  const material = workspaceRunMaterial(run)
  const branchName = `ppo/${projectId}/implementation/${material}`

  if (branchName.length > MAX_WORKSPACE_BRANCH_CHARS) {
    throw workspaceError(
      "WORKSPACE_BRANCH_INVALID",
      "Generated workspace branch name is invalid."
    )
  }

  return branchName
}

export function makeDevelopmentWorkspaceId(run) {
  const projectId = resolveDevelopmentRunProject(run?.project?.id).id
  const workspaceId = `${projectId}-${workspaceRunMaterial(run)}`

  if (!workspaceIdPattern.test(workspaceId)) {
    throw workspaceError(
      "WORKSPACE_ID_INVALID",
      "Generated workspace id is invalid."
    )
  }

  return workspaceId
}

function githubIdentityFromRemote(remoteUrl) {
  const normalized = boundedSafeString(remoteUrl, {
    code: "WORKSPACE_REPOSITORY_IDENTITY_INVALID",
    safeMessage: "Repository identity is not approved for this run.",
    maxChars: 200
  })

  for (const pattern of safeRemotePatterns) {
    const match = normalized.match(pattern)

    if (match) {
      return `${match[1]}/${match[2].replace(/\.git$/iu, "")}`
    }
  }

  throw workspaceError(
    "WORKSPACE_REPOSITORY_IDENTITY_INVALID",
    "Repository identity is not approved for this run."
  )
}

function normalizeProjectWorkspaceRegistry(registry, options = {}) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw workspaceError(
      "WORKSPACE_REGISTRY_REQUIRED",
      "Project workspace registry is required before workspace preparation."
    )
  }

  const normalized = new Map()

  for (const [projectId, entry] of Object.entries(registry)) {
    const project = resolveDevelopmentRunProject(projectId)

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw workspaceError(
        "WORKSPACE_REGISTRY_INVALID",
        "Project workspace registry entry is invalid."
      )
    }

    const sourceRepoPath = normalizeAbsolutePath(entry.sourceRepoPath, "Source repository path")
    const workspaceRoot = normalizeAbsolutePath(
      entry.workspaceRoot || defaultWorkspaceRoot(options),
      "Workspace root"
    )

    normalized.set(project.id, {
      project,
      sourceRepoPath,
      workspaceRoot
    })
  }

  return normalized
}

function resolveRegistryEntry(projectId, options = {}) {
  const registry = normalizeProjectWorkspaceRegistry(options.workspaceRegistry, options)
  const entry = registry.get(projectId)

  if (!entry) {
    throw workspaceError(
      "WORKSPACE_REGISTRY_MISSING_PROJECT",
      "Project is not configured for workspace management."
    )
  }

  return entry
}

async function ensureManagedWorkspaceRoot(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  await assertNotSymlink(
    path,
    "WORKSPACE_PATH_ESCAPE",
    "Workspace root must be a PPO-managed directory, not a symbolic link."
  )
}

async function resolveWorkspacePaths(entry, run, { allowExistingWorkspace = false } = {}) {
  const workspaceRoot = normalizeAbsolutePath(entry.workspaceRoot, "Workspace root")
  const sourceRepoPath = normalizeAbsolutePath(entry.sourceRepoPath, "Source repository path")
  const workspaceId = makeDevelopmentWorkspaceId(run)
  const projectSubdir = entry.project.id

  assertPathSegment(projectSubdir, "Project workspace segment")
  assertWithinRoot(workspaceRoot, join(workspaceRoot, projectSubdir))

  const sourceInfo = await assertNotSymlink(
    sourceRepoPath,
    "WORKSPACE_SOURCE_UNSAFE",
    "Source repository path is unsafe or unavailable."
  )

  if (!sourceInfo) {
    throw workspaceError(
      "WORKSPACE_SOURCE_MISSING",
      "Source repository is missing."
    )
  }

  if (!sourceInfo.isDirectory()) {
    throw workspaceError(
      "WORKSPACE_SOURCE_UNSAFE",
      "Source repository path is unsafe or unavailable."
    )
  }

  const sourceRealPath = await realpath(sourceRepoPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw workspaceError(
        "WORKSPACE_SOURCE_MISSING",
        "Source repository is missing."
      )
    }

    throw error
  })

  if (sourceRealPath !== sourceRepoPath) {
    throw workspaceError(
      "WORKSPACE_PATH_ESCAPE",
      "Workspace registry source path must be canonical."
    )
  }

  const rootInfo = await assertNotSymlink(
    workspaceRoot,
    "WORKSPACE_PATH_ESCAPE",
    "Workspace root must be a PPO-managed directory, not a symbolic link."
  )

  if (rootInfo && !rootInfo.isDirectory()) {
    throw workspaceError(
      "WORKSPACE_ROOT_UNSAFE",
      "Workspace root must be a PPO-managed directory."
    )
  }

  const rootRealPath = rootInfo ? await realpath(workspaceRoot) : workspaceRoot

  if (rootRealPath !== workspaceRoot) {
    throw workspaceError(
      "WORKSPACE_PATH_ESCAPE",
      "Workspace root must be canonical."
    )
  }

  assertNotNested(
    sourceRealPath,
    rootRealPath,
    "WORKSPACE_ROOT_UNSAFE",
    "Workspace root must be separate from the source repository."
  )

  const projectRoot = join(workspaceRoot, projectSubdir)
  const projectRootInfo = await assertNotSymlink(
    projectRoot,
    "WORKSPACE_PATH_ESCAPE",
    "Project workspace root must be canonical."
  )

  if (projectRootInfo && !projectRootInfo.isDirectory()) {
    throw workspaceError(
      "WORKSPACE_ROOT_UNSAFE",
      "Project workspace root must be a PPO-managed directory."
    )
  }

  const projectRootRealPath = projectRootInfo ? await realpath(projectRoot) : projectRoot

  if (projectRootRealPath !== projectRoot) {
    throw workspaceError(
      "WORKSPACE_PATH_ESCAPE",
      "Project workspace root must be canonical."
    )
  }

  assertWithinRoot(rootRealPath, projectRootRealPath)

  const workspacePath = join(projectRoot, workspaceId)
  assertWithinRoot(rootRealPath, workspacePath)

  if (workspacePath.length > MAX_WORKSPACE_PATH_CHARS) {
    throw workspaceError(
      "WORKSPACE_PATH_TOO_LONG",
      "Workspace path exceeds the approved size limit."
    )
  }

  const existingWorkspace = await assertNotSymlink(
    workspacePath,
    "WORKSPACE_PATH_ESCAPE",
    "Workspace path is unsafe."
  )

  if (existingWorkspace && !allowExistingWorkspace) {
    throw workspaceError(
      "WORKSPACE_COLLISION",
      "Workspace path is already owned or occupied."
    )
  }

  return {
    sourceRepoPath: sourceRealPath,
    workspaceRoot: rootRealPath,
    projectRoot: projectRootRealPath,
    workspacePath,
    workspaceId,
    workspaceRef: `${DEVELOPMENT_WORKSPACE_STORE_DIR}/${projectSubdir}/${workspaceId}`
  }
}

async function ensureWorkspaceDirectories(paths) {
  await ensureManagedWorkspaceRoot(paths.workspaceRoot)
  await ensureManagedWorkspaceRoot(paths.projectRoot)

  const rootRealPath = await realpath(paths.workspaceRoot)
  const projectRootRealPath = await realpath(paths.projectRoot)

  if (rootRealPath !== paths.workspaceRoot || projectRootRealPath !== paths.projectRoot) {
    throw workspaceError(
      "WORKSPACE_PATH_ESCAPE",
      "Workspace directories must remain inside the PPO-managed root."
    )
  }

  assertWithinRoot(paths.workspaceRoot, paths.projectRoot)

  const existingWorkspace = await assertNotSymlink(
    paths.workspacePath,
    "WORKSPACE_PATH_ESCAPE",
    "Workspace path is unsafe."
  )

  if (existingWorkspace) {
    throw workspaceError(
      "WORKSPACE_COLLISION",
      "Workspace path is already owned or occupied."
    )
  }
}

function isExitCodeOne(error) {
  return error?.code === 1 || error?.exitCode === 1
}

function isMutatingGitArgs(args) {
  const command = args[2]
  const subcommand = args[3]

  return (
    command === "branch" ||
    (command === "worktree" && (subcommand === "add" || subcommand === "remove"))
  )
}

function isUncertainGitOutcome(error) {
  return (
    error?.ambiguous === true ||
    error?.uncertain === true ||
    error?.timedOut === true ||
    error?.killed === true ||
    typeof error?.signal === "string" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ABORT_ERR" ||
    error?.code === "ENOBUFS" ||
    error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    error?.code === "WORKSPACE_GIT_TIMEOUT"
  )
}

function ambiguousGitMutationError() {
  const error = workspaceError(
    "WORKSPACE_OUTCOME_AMBIGUOUS",
    "Workspace mutation outcome is ambiguous; reconcile before retrying."
  )
  error.ambiguous = true
  return error
}

function makeGitRunner(defaultRunner) {
  return defaultRunner || runGit
}

function assertGitArgs(args) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || !entry)) {
    throw workspaceError(
      "WORKSPACE_GIT_OPERATION_REFUSED",
      "Git operation is not approved for workspace management."
    )
  }

  const command = args[2]
  const subcommand = args[3]
  const isGitC = args[0] === "-C" && typeof args[1] === "string"

  if (!isGitC) {
    throw workspaceError(
      "WORKSPACE_GIT_OPERATION_REFUSED",
      "Git operation is not approved for workspace management."
    )
  }

  const safeBranch = (value) => (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_BRANCH_CHARS &&
    !value.startsWith("-") &&
    !defaultBranchBlocked(value)
  )
  const branchRef = (value) => typeof value === "string" && value.startsWith("refs/heads/")
  const exactShape = (
    (command === "rev-parse" && args.length === 4 && (
      subcommand === "--show-toplevel" ||
      subcommand === "HEAD" ||
      branchRef(subcommand)
    )) ||
    (command === "remote" && args.length === 5 && subcommand === "get-url" && args[4] === "origin") ||
    (command === "cat-file" && args.length === 5 && subcommand === "-e" && args[4].endsWith("^{commit}")) ||
    (command === "status" && args.length === 5 && subcommand === "--porcelain=v1" && args[4] === "--untracked-files=all") ||
    (command === "check-ref-format" && args.length === 5 && subcommand === "--branch" && safeBranch(args[4])) ||
    (command === "show-ref" && args.length === 6 && subcommand === "--verify" && args[4] === "--quiet" && branchRef(args[5])) ||
    (command === "branch" && args.length === 5 && (
      (subcommand === "-D" && safeBranch(args[4])) ||
      (safeBranch(subcommand) && shaPattern.test(args[4]))
    )) ||
    (command === "worktree" && (
      (args.length === 6 && subcommand === "add" && safeBranch(args[5])) ||
      (args.length === 6 && subcommand === "remove" && args[4] === "--force")
    )) ||
    (command === "symbolic-ref" && args.length === 5 && subcommand === "--short" && args[4] === "HEAD")
  )

  if (!exactShape) {
    throw workspaceError(
      "WORKSPACE_GIT_OPERATION_REFUSED",
      "Git operation is not approved for workspace management."
    )
  }
}

async function runGit(args) {
  assertGitArgs(args)

  try {
    const result = await execFileAsync("git", args, {
      encoding: "utf8",
      maxBuffer: MAX_WORKSPACE_GIT_OUTPUT_BYTES,
      timeout: MAX_WORKSPACE_GIT_TIMEOUT_MS,
      shell: false
    })

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0
    }
  } catch (error) {
    if (isUncertainGitOutcome(error)) {
      if (isMutatingGitArgs(args)) {
        throw ambiguousGitMutationError()
      }

      throw workspaceError(
        "WORKSPACE_GIT_TIMEOUT",
        "Git operation did not finish within the workspace manager limit."
      )
    }

    const wrapped = workspaceError(
      "WORKSPACE_GIT_FAILED",
      "Git operation failed; no raw Git output was stored."
    )
    wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null
    throw wrapped
  }
}

async function git(gitRunner, args) {
  assertGitArgs(args)
  let result

  try {
    result = await gitRunner(args)
  } catch (error) {
    if (isMutatingGitArgs(args) && isUncertainGitOutcome(error)) {
      throw ambiguousGitMutationError()
    }

    throw error
  }

  if (isMutatingGitArgs(args) && isUncertainGitOutcome(result)) {
    throw ambiguousGitMutationError()
  }

  if (!result || typeof result !== "object") {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0
    }
  }

  return {
    stdout: String(result.stdout ?? ""),
    stderr: "",
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 0
  }
}

function gitOutputLine(result, code, safeMessage) {
  const output = String(result.stdout ?? "").trim()

  if (!output || output.length > MAX_WORKSPACE_GIT_OUTPUT_BYTES || /[\u0000-\u001f\u007f]/u.test(output)) {
    throw workspaceError(code, safeMessage)
  }

  return output.split(/\r?\n/u)[0].trim()
}

async function gitRequiredLine(gitRunner, args, code, safeMessage) {
  try {
    return gitOutputLine(await git(gitRunner, args), code, safeMessage)
  } catch (error) {
    if (error?.code === "WORKSPACE_GIT_FAILED") {
      throw workspaceError(code, safeMessage)
    }

    throw error
  }
}

async function gitOptional(gitRunner, args) {
  try {
    await git(gitRunner, args)
    return true
  } catch (error) {
    if (isExitCodeOne(error)) {
      return false
    }

    throw error
  }
}

function assertDefiniteGitFailure(error) {
  if (error?.ambiguous === true || error?.code === "WORKSPACE_OUTCOME_AMBIGUOUS") {
    throw ambiguousGitMutationError()
  }
}

function defaultBranchBlocked(branchName) {
  return branchName === "main" || branchName === "master"
}

function verifyRunProject(run) {
  const project = resolveDevelopmentRunProject(run?.project?.id)

  if (
    run.project.displayName !== project.displayName ||
    run.project.owner !== project.owner ||
    run.project.repo !== project.repo ||
    run.project.fullName !== project.fullName
  ) {
    throw workspaceError(
      "WORKSPACE_RUN_PROJECT_INVALID",
      "Run project does not match the approved project registry."
    )
  }

  return project
}

async function verifyRepositoryPreflight(gitRunner, run, paths, project, branchName) {
  const toplevel = await gitRequiredLine(gitRunner, [
    "-C",
    paths.sourceRepoPath,
    "rev-parse",
    "--show-toplevel"
  ], "WORKSPACE_SOURCE_NOT_GIT_REPO", "Source repository is not a Git repository.")

  if (toplevel !== paths.sourceRepoPath) {
    throw workspaceError(
      "WORKSPACE_SOURCE_UNSAFE",
      "Source repository path is not the approved repository root."
    )
  }

  const remoteIdentity = githubIdentityFromRemote(await gitRequiredLine(gitRunner, [
    "-C",
    paths.sourceRepoPath,
    "remote",
    "get-url",
    "origin"
  ], "WORKSPACE_REPOSITORY_IDENTITY_INVALID", "Repository identity is not approved for this run."))

  if (remoteIdentity !== project.fullName) {
    throw workspaceError(
      "WORKSPACE_REPOSITORY_IDENTITY_INVALID",
      "Repository identity is not approved for this run."
    )
  }

  await git(gitRunner, [
    "-C",
    paths.sourceRepoPath,
    "cat-file",
    "-e",
    `${run.baseSha}^{commit}`
  ]).catch((error) => {
    if (error?.code === "WORKSPACE_GIT_FAILED") {
      throw workspaceError(
        "WORKSPACE_BASE_SHA_MISSING",
        "Run base SHA does not exist in the source repository."
      )
    }

    throw error
  })

  const statusOutput = String((await git(gitRunner, [
    "-C",
    paths.sourceRepoPath,
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ])).stdout ?? "").trim()

  if (statusOutput) {
    throw workspaceError(
      "WORKSPACE_SOURCE_DIRTY",
      "Source repository working tree is dirty; workspace preparation refused."
    )
  }

  const sourceBranch = await gitRequiredLine(gitRunner, [
    "-C",
    paths.sourceRepoPath,
    "symbolic-ref",
    "--short",
    "HEAD"
  ], "WORKSPACE_SOURCE_UNSAFE", "Source repository branch state is unsafe.")

  if (!sourceBranch || sourceBranch.length > MAX_WORKSPACE_BRANCH_CHARS) {
    throw workspaceError(
      "WORKSPACE_SOURCE_UNSAFE",
      "Source repository branch state is unsafe."
    )
  }

  if (defaultBranchBlocked(branchName)) {
    throw workspaceError(
      "WORKSPACE_BRANCH_INVALID",
      "Workspace branch cannot be a protected default branch name."
    )
  }

  const checkedBranch = await gitRequiredLine(gitRunner, [
    "-C",
    paths.sourceRepoPath,
    "check-ref-format",
    "--branch",
    branchName
  ], "WORKSPACE_BRANCH_INVALID", "Generated workspace branch name is invalid.")

  if (checkedBranch !== branchName) {
    throw workspaceError(
      "WORKSPACE_BRANCH_INVALID",
      "Generated workspace branch name is invalid."
    )
  }

  const branchExists = await gitOptional(gitRunner, [
    "-C",
    paths.sourceRepoPath,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branchName}`
  ])

  if (branchExists) {
    throw workspaceError(
      "WORKSPACE_COLLISION",
      "Workspace branch already exists."
    )
  }
}

async function safeCleanupCreatedWorkspace(gitRunner, paths, branchName, created) {
  if (created.worktree) {
    try {
      await git(gitRunner, [
        "-C",
        paths.sourceRepoPath,
        "worktree",
        "remove",
        "--force",
        paths.workspacePath
      ])
    } catch (error) {
      assertDefiniteGitFailure(error)
      // Best effort cleanup after a definite local failure.
    }
  }

  if (created.branch) {
    try {
      await git(gitRunner, [
        "-C",
        paths.sourceRepoPath,
        "branch",
        "-D",
        branchName
      ])
    } catch (error) {
      assertDefiniteGitFailure(error)
      // Best effort cleanup after a definite local failure.
    }
  }
}

async function createAndVerifyWorkspace(gitRunner, run, paths, branchName) {
  const created = {
    branch: false,
    worktree: false
  }

  try {
    await git(gitRunner, [
      "-C",
      paths.sourceRepoPath,
      "branch",
      branchName,
      run.baseSha
    ])
    created.branch = true

    await git(gitRunner, [
      "-C",
      paths.sourceRepoPath,
      "worktree",
      "add",
      paths.workspacePath,
      branchName
    ])
    created.worktree = true

    await verifyPreparedWorkspace(gitRunner, run, paths, branchName)
  } catch (error) {
    assertDefiniteGitFailure(error)
    await safeCleanupCreatedWorkspace(gitRunner, paths, branchName, created)
    throw error
  }
}

async function verifyPreparedWorkspace(gitRunner, run, paths, branchName) {
  const info = await stat(paths.workspacePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw workspaceError(
        "WORKSPACE_VERIFY_FAILED",
        "Prepared workspace is missing."
      )
    }

    throw error
  })

  if (!info.isDirectory()) {
    throw workspaceError(
      "WORKSPACE_VERIFY_FAILED",
      "Prepared workspace is not a directory."
    )
  }

  const workspaceRealPath = await realpath(paths.workspacePath)

  if (workspaceRealPath !== paths.workspacePath) {
    throw workspaceError(
      "WORKSPACE_PATH_ESCAPE",
      "Prepared workspace path escaped the managed root."
    )
  }

  assertWithinRoot(paths.workspaceRoot, workspaceRealPath)

  const workspaceTopLevel = await gitRequiredLine(gitRunner, [
    "-C",
    paths.workspacePath,
    "rev-parse",
    "--show-toplevel"
  ], "WORKSPACE_VERIFY_FAILED", "Prepared workspace could not be verified.")

  if (workspaceTopLevel !== paths.workspacePath) {
    throw workspaceError(
      "WORKSPACE_VERIFY_FAILED",
      "Prepared workspace does not match the expected Git root."
    )
  }

  const workspaceBranch = await gitRequiredLine(gitRunner, [
    "-C",
    paths.workspacePath,
    "symbolic-ref",
    "--short",
    "HEAD"
  ], "WORKSPACE_VERIFY_FAILED", "Prepared workspace branch could not be verified.")

  if (workspaceBranch !== branchName || defaultBranchBlocked(workspaceBranch)) {
    throw workspaceError(
      "WORKSPACE_VERIFY_FAILED",
      "Prepared workspace branch is not the expected isolated branch."
    )
  }

  const workspaceHead = validateSha(await gitRequiredLine(gitRunner, [
    "-C",
    paths.workspacePath,
    "rev-parse",
    "HEAD"
  ], "WORKSPACE_VERIFY_FAILED", "Prepared workspace head could not be verified."), "Workspace HEAD")

  if (workspaceHead !== run.baseSha) {
    throw workspaceError(
      "WORKSPACE_VERIFY_FAILED",
      "Prepared workspace does not start at the run base SHA."
    )
  }

  const branchHead = validateSha(await gitRequiredLine(gitRunner, [
    "-C",
    paths.sourceRepoPath,
    "rev-parse",
    `refs/heads/${branchName}`
  ], "WORKSPACE_VERIFY_FAILED", "Prepared branch head could not be verified."), "Workspace branch HEAD")

  if (branchHead !== run.baseSha) {
    throw workspaceError(
      "WORKSPACE_VERIFY_FAILED",
      "Prepared branch does not start at the run base SHA."
    )
  }

  return {
    branchHead,
    workspaceHead
  }
}

function buildWorkspaceEvidence(run, branchName, paths, verifiedAt) {
  return {
    kind: "implementation",
    sha: run.baseSha,
    source: DEVELOPMENT_WORKSPACE_MANAGER_ID,
    summary: "Isolated implementation workspace prepared and verified.",
    metadata: {
      project: run.project.id,
      repo: run.project.fullName,
      baseSha: run.baseSha,
      branch: branchName,
      workspaceId: paths.workspaceId,
      workspaceRef: paths.workspaceRef,
      manager: DEVELOPMENT_WORKSPACE_MANAGER_ID,
      verifiedAt
    }
  }
}

function workspaceMetadata(run, branchName, paths) {
  return {
    project: run.project.id,
    repo: run.project.fullName,
    baseSha: run.baseSha,
    branch: branchName,
    workspaceId: paths.workspaceId,
    workspaceRef: paths.workspaceRef
  }
}

async function resolveImplementationWorkspaceLocationInternal(run, options = {}) {
  const project = verifyRunProject(run)
  const branchName = run.branch || makeDevelopmentWorkspaceBranchName(run)
  const registryEntry = resolveRegistryEntry(project.id, options)
  const paths = await resolveWorkspacePaths(registryEntry, run, { allowExistingWorkspace: true })

  return {
    ...workspaceMetadata(run, branchName, paths),
    sourceRepoPath: paths.sourceRepoPath,
    workspaceRoot: paths.workspaceRoot,
    workspacePath: paths.workspacePath
  }
}

async function prepareImplementationWorkspaceInternal(runId, options = {}) {
  const expectedVersion = options.expectedVersion

  if (!Number.isInteger(expectedVersion)) {
    throw workspaceError(
      "WORKSPACE_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required."
    )
  }

  const gitRunner = makeGitRunner(options.gitRunner)
  const run = await readDevelopmentRun(runId, options)

  if (run.status !== "planned") {
    throw workspaceError(
      "WORKSPACE_RUN_NOT_PLANNED",
      "Development run must be in planned status before workspace preparation."
    )
  }

  if (run.version !== expectedVersion) {
    throw workspaceError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  const project = verifyRunProject(run)
  const baseSha = validateSha(run.baseSha, "Run base SHA")
  const branchName = makeDevelopmentWorkspaceBranchName(run)
  const registryEntry = resolveRegistryEntry(project.id, options)
  const paths = await resolveWorkspacePaths(registryEntry, { ...run, baseSha })

  await verifyRepositoryPreflight(gitRunner, run, paths, project, branchName)
  await ensureWorkspaceDirectories(paths)
  await createAndVerifyWorkspace(gitRunner, run, paths, branchName)

  let transitioned

  try {
    const branchCheck = await verifyPreparedWorkspace(gitRunner, run, paths, branchName)
    const verifiedAtValue = options.now ? options.now() : new Date()
    const verifiedAtDate = verifiedAtValue instanceof Date ? verifiedAtValue : new Date(verifiedAtValue)
    const verifiedAt = Number.isNaN(verifiedAtDate.getTime())
      ? new Date().toISOString()
      : verifiedAtDate.toISOString()
    const evidence = buildWorkspaceEvidence(run, branchName, paths, verifiedAt)

    transitioned = await transitionDevelopmentRun(run.runId, {
      expectedVersion,
      status: "implementation_in_progress",
      branch: branchName,
      headSha: branchCheck.branchHead,
      actor: DEVELOPMENT_WORKSPACE_MANAGER_ID,
      reason: "phase-6c-workspace-ready",
      evidence: [evidence]
    }, options)
  } catch (error) {
    if (error?.stateCommitted === true) {
      throw error
    }

    await safeCleanupCreatedWorkspace(gitRunner, paths, branchName, {
      branch: true,
      worktree: true
    })
    throw error
  }

  return {
    ok: true,
    outcome: "implementation_workspace_ready",
    run: transitioned,
    workspace: workspaceMetadata(run, branchName, paths)
  }
}

function findRecordedWorkspace(run) {
  const records = run?.evidence?.implementation || []
  return records
    .filter((entry) => entry?.source === DEVELOPMENT_WORKSPACE_MANAGER_ID)
    .at(-1) || null
}

async function inspectImplementationWorkspaceInternal(runId, options = {}) {
  const gitRunner = makeGitRunner(options.gitRunner)
  const run = await readDevelopmentRun(runId, options)
  const project = verifyRunProject(run)
  const branchName = run.branch || makeDevelopmentWorkspaceBranchName(run)
  const registryEntry = resolveRegistryEntry(project.id, options)
  const paths = await resolveWorkspacePaths(registryEntry, run, { allowExistingWorkspace: true })
  const recorded = findRecordedWorkspace(run)
  const expected = workspaceMetadata(run, branchName, paths)

  let exists = false
  let matches = false
  let headSha = null
  let actualBranch = null
  let status = "missing"

  const info = await stat(paths.workspacePath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  })

  if (info?.isDirectory()) {
    exists = true
    try {
      const workspaceRealPath = await realpath(paths.workspacePath)
      actualBranch = await gitRequiredLine(gitRunner, [
        "-C",
        paths.workspacePath,
        "symbolic-ref",
        "--short",
        "HEAD"
      ], "WORKSPACE_RECONCILE_FAILED", "Workspace inspection could not verify branch.")
      headSha = validateSha(await gitRequiredLine(gitRunner, [
        "-C",
        paths.workspacePath,
        "rev-parse",
        "HEAD"
      ], "WORKSPACE_RECONCILE_FAILED", "Workspace inspection could not verify head."), "Workspace HEAD")

      matches = (
        workspaceRealPath === paths.workspacePath &&
        actualBranch === branchName &&
        headSha === run.baseSha &&
        (!recorded || (
          recorded.metadata.workspaceId === paths.workspaceId &&
          recorded.metadata.workspaceRef === paths.workspaceRef &&
          recorded.metadata.branch === branchName &&
          recorded.metadata.baseSha === run.baseSha &&
          recorded.metadata.repo === run.project.fullName
        ))
      )
      status = matches ? "matching" : "mismatch"
    } catch {
      status = "mismatch"
    }
  }

  return {
    ok: true,
    outcome: "workspace_inspected",
    exists,
    matches,
    status,
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id
    },
    workspace: expected,
    facts: {
      branch: actualBranch,
      headSha
    }
  }
}

export async function prepareImplementationWorkspace(runId, options = {}) {
  try {
    return await prepareImplementationWorkspaceInternal(runId, options)
  } catch (error) {
    throw safeWorkspaceFailure(error)
  }
}

export async function inspectImplementationWorkspace(runId, options = {}) {
  try {
    return await inspectImplementationWorkspaceInternal(runId, options)
  } catch (error) {
    throw safeWorkspaceFailure(error)
  }
}

export async function resolveImplementationWorkspaceLocation(run, options = {}) {
  try {
    return await resolveImplementationWorkspaceLocationInternal(run, options)
  } catch (error) {
    throw safeWorkspaceFailure(error)
  }
}

export function formatDevelopmentWorkspaceManagerError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO development workspace error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO development workspace error: unexpected local failure."
}
