import { execFile } from "node:child_process"
import {
  getBlockedPhase2GitHubProjectStatus,
  getPhase2GitHubProject,
  listPhase2GitHubProjects
} from "./github-project-registry.mjs"

export const GITHUB_READONLY_SOURCE = "GitHub read-only"
export const DEFAULT_ITEM_LIMIT = 5
export const MAX_ITEM_LIMIT = 10

export class GitHubReadOnlyError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "GitHubReadOnlyError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function projectLabel(projectId) {
  if (typeof projectId !== "string") {
    return "(invalid)"
  }

  return projectId.trim() || "(missing)"
}

export function listAllowedProjects() {
  return listPhase2GitHubProjects()
}

export function resolveProject(projectId) {
  if (typeof projectId !== "string") {
    throw new GitHubReadOnlyError(
      "INVALID_PROJECT",
      "Project id is required. Use one of: khlim-assist, ledgerpilot-ai, spy-market-agent, portfolio."
    )
  }

  const normalizedProjectId = projectId.trim()

  if (!normalizedProjectId) {
    throw new GitHubReadOnlyError(
      "INVALID_PROJECT",
      "Project id is required. Use one of: khlim-assist, ledgerpilot-ai, spy-market-agent, portfolio."
    )
  }

  const project = getPhase2GitHubProject(normalizedProjectId)

  if (project) {
    return project
  }

  const blockedStatus = getBlockedPhase2GitHubProjectStatus(normalizedProjectId)

  if (blockedStatus) {
    throw new GitHubReadOnlyError(
      "PROJECT_NOT_CONNECTED",
      `Project "${normalizedProjectId}" is ${blockedStatus} and is not connected for Phase 2A GitHub reads.`
    )
  }

  throw new GitHubReadOnlyError(
    "UNKNOWN_PROJECT",
    `Project "${projectLabel(projectId)}" is not in the Phase 2A GitHub read-only allowlist.`
  )
}

export function normalizeLimit(limit = DEFAULT_ITEM_LIMIT) {
  if (limit === undefined || limit === null || limit === "") {
    return DEFAULT_ITEM_LIMIT
  }

  const parsedLimit = Number(limit)

  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    throw new GitHubReadOnlyError(
      "INVALID_LIMIT",
      `Limit must be a positive integer no greater than ${MAX_ITEM_LIMIT}.`
    )
  }

  return Math.min(parsedLimit, MAX_ITEM_LIMIT)
}

function repoEndpoint(project) {
  return `/repos/${project.owner}/${project.repo}`
}

function appendQueryParams(endpoint, queryParams = {}) {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value))
    }
  }

  const queryString = params.toString()
  return queryString ? `${endpoint}?${queryString}` : endpoint
}

export function buildGhApiGetArgs(endpoint, queryParams = {}) {
  return ["api", "--method", "GET", appendQueryParams(endpoint, queryParams)]
}

function execFilePromise(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
      if (error) {
        const failure = new Error("gh api GET request failed")
        failure.code = error.code
        failure.exitCode = error.exitCode ?? error.code
        failure.signal = error.signal
        failure.stdout = stdout || error.stdout || ""
        failure.stderr = stderr || error.stderr || ""
        reject(failure)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

export function createGhApiGetRunner({ execFileImpl = execFile } = {}) {
  return async function runGhApiGet(request) {
    if (!request || request.method !== "GET") {
      throw new GitHubReadOnlyError(
        "UNSUPPORTED_METHOD",
        "GitHub read-only transport supports GET requests only."
      )
    }

    const args = buildGhApiGetArgs(request.endpoint, request.queryParams)

    return execFilePromise(execFileImpl, "gh", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 15000
    })
  }
}

function combinedFailureText(error) {
  return [error?.stderr, error?.stdout, error?.message].filter(Boolean).join("\n")
}

function classifyRunnerError(error, endpoint) {
  if (error instanceof GitHubReadOnlyError) {
    return error
  }

  if (error?.code === "ENOENT") {
    return new GitHubReadOnlyError(
      "GITHUB_CLI_UNAVAILABLE",
      "GitHub CLI `gh` is unavailable. Install it, verify with `gh --version`, then run `gh auth status`."
    )
  }

  const failureText = combinedFailureText(error)

  if (/(not logged in|authentication required|authenticate|auth login|HTTP 401|Bad credentials|requires authentication|no oauth token)/i.test(failureText)) {
    return new GitHubReadOnlyError(
      "GITHUB_CLI_UNAUTHENTICATED",
      "GitHub CLI `gh` is not authenticated. Run `gh auth status`; if needed, run `gh auth login` outside this repo and retry."
    )
  }

  if (/(HTTP 403|HTTP 404|Forbidden|Not Found|Could not resolve to a Repository|repository not found|Resource not accessible|permission denied|insufficient permissions)/i.test(failureText)) {
    return new GitHubReadOnlyError(
      "GITHUB_REPO_UNAVAILABLE",
      `Repository is unavailable or permission is denied for GET ${endpoint}. Confirm repo access with \`gh repo view\` and \`gh auth status\`.`
    )
  }

  return new GitHubReadOnlyError(
    "GITHUB_API_FAILED",
    `GitHub API GET failed for ${endpoint}. Retry later or confirm GitHub availability with \`gh auth status\`.`
  )
}

async function requestJson(runner, endpoint, queryParams = {}) {
  let result

  try {
    result = await runner({ method: "GET", endpoint, queryParams })
  } catch (error) {
    throw classifyRunnerError(error, endpoint)
  }

  const stdout = typeof result === "string" ? result : result?.stdout

  try {
    return JSON.parse(stdout)
  } catch {
    throw new GitHubReadOnlyError(
      "MALFORMED_GITHUB_RESPONSE",
      `GitHub CLI returned malformed JSON for GET ${endpoint}. Retry or inspect the local gh installation.`
    )
  }
}

function ensureArray(payload, endpoint) {
  if (!Array.isArray(payload)) {
    throw new GitHubReadOnlyError(
      "MALFORMED_GITHUB_RESPONSE",
      `GitHub CLI returned an unexpected JSON shape for GET ${endpoint}.`
    )
  }

  return payload
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null
}

function firstLine(value) {
  if (typeof value !== "string") {
    return ""
  }

  return value.split(/\r?\n/, 1)[0].trim()
}

export function normalizeRepoMetadata(payload, project) {
  const privateState = typeof payload?.private === "boolean" ? payload.private : null

  return {
    fullName: stringOrNull(payload?.full_name) || project.fullName,
    defaultBranch: stringOrNull(payload?.default_branch),
    visibility: stringOrNull(payload?.visibility) || (privateState === null ? null : privateState ? "private" : "public"),
    private: privateState,
    description: stringOrNull(payload?.description),
    updatedAt: stringOrNull(payload?.updated_at),
    pushedAt: stringOrNull(payload?.pushed_at),
    url: stringOrNull(payload?.html_url)
  }
}

export function normalizeCommit(payload) {
  const sha = stringOrNull(payload?.sha)
  const authorName = stringOrNull(payload?.commit?.author?.name) || stringOrNull(payload?.author?.login)

  return {
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    message: firstLine(payload?.commit?.message),
    author: authorName,
    timestamp: stringOrNull(payload?.commit?.author?.date) || stringOrNull(payload?.commit?.committer?.date),
    url: stringOrNull(payload?.html_url)
  }
}

export function normalizePullRequest(payload) {
  return {
    number: typeof payload?.number === "number" ? payload.number : null,
    title: stringOrNull(payload?.title),
    headRef: stringOrNull(payload?.head?.ref),
    baseRef: stringOrNull(payload?.base?.ref),
    draft: Boolean(payload?.draft),
    updatedAt: stringOrNull(payload?.updated_at),
    url: stringOrNull(payload?.html_url)
  }
}

export function normalizeIssue(payload) {
  const labels = Array.isArray(payload?.labels)
    ? payload.labels
      .map((label) => (typeof label === "string" ? label : stringOrNull(label?.name)))
      .filter(Boolean)
    : []

  return {
    number: typeof payload?.number === "number" ? payload.number : null,
    title: stringOrNull(payload?.title),
    state: stringOrNull(payload?.state),
    labels,
    updatedAt: stringOrNull(payload?.updated_at),
    url: stringOrNull(payload?.html_url)
  }
}

export function createGitHubReadOnlyClient({
  runner = createGhApiGetRunner(),
  now = () => new Date()
} = {}) {
  return {
    resolveProject,

    async getRepoMetadata(projectId) {
      const project = resolveProject(projectId)
      const endpoint = repoEndpoint(project)
      const payload = await requestJson(runner, endpoint)

      return normalizeRepoMetadata(payload, project)
    },

    async getRecentCommits(projectId, limit = DEFAULT_ITEM_LIMIT) {
      const project = resolveProject(projectId)
      const perPage = normalizeLimit(limit)
      const endpoint = `${repoEndpoint(project)}/commits`
      const payload = ensureArray(await requestJson(runner, endpoint, { per_page: perPage }), endpoint)

      return payload.map(normalizeCommit)
    },

    async getOpenPullRequests(projectId, limit = DEFAULT_ITEM_LIMIT) {
      const project = resolveProject(projectId)
      const perPage = normalizeLimit(limit)
      const endpoint = `${repoEndpoint(project)}/pulls`
      const payload = ensureArray(await requestJson(runner, endpoint, { state: "open", per_page: perPage }), endpoint)

      return payload.map(normalizePullRequest)
    },

    async getOpenIssues(projectId, limit = DEFAULT_ITEM_LIMIT) {
      const project = resolveProject(projectId)
      const perPage = normalizeLimit(limit)
      const endpoint = `${repoEndpoint(project)}/issues`
      const payload = ensureArray(await requestJson(runner, endpoint, { state: "open", per_page: perPage }), endpoint)

      return payload
        .filter((issue) => !issue?.pull_request)
        .map(normalizeIssue)
    },

    async getProjectSnapshot(projectId) {
      const project = resolveProject(projectId)
      const [repository, recentCommits, openPullRequests, openIssues] = await Promise.all([
        this.getRepoMetadata(project.id),
        this.getRecentCommits(project.id),
        this.getOpenPullRequests(project.id),
        this.getOpenIssues(project.id)
      ])
      const retrievalTime = now()

      return {
        project: {
          id: project.id,
          displayName: project.displayName,
          fullName: project.fullName
        },
        repository,
        recentCommits,
        openPullRequests,
        openIssues,
        retrievedAt: retrievalTime instanceof Date ? retrievalTime.toISOString() : new Date(retrievalTime).toISOString(),
        source: GITHUB_READONLY_SOURCE
      }
    }
  }
}

export async function getRepoMetadata(projectId, options = {}) {
  return createGitHubReadOnlyClient(options).getRepoMetadata(projectId)
}

export async function getRecentCommits(projectId, limit = DEFAULT_ITEM_LIMIT, options = {}) {
  return createGitHubReadOnlyClient(options).getRecentCommits(projectId, limit)
}

export async function getOpenPullRequests(projectId, limit = DEFAULT_ITEM_LIMIT, options = {}) {
  return createGitHubReadOnlyClient(options).getOpenPullRequests(projectId, limit)
}

export async function getOpenIssues(projectId, limit = DEFAULT_ITEM_LIMIT, options = {}) {
  return createGitHubReadOnlyClient(options).getOpenIssues(projectId, limit)
}

export async function getProjectSnapshot(projectId, options = {}) {
  return createGitHubReadOnlyClient(options).getProjectSnapshot(projectId)
}
