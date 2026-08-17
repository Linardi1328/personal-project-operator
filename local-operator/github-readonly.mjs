import { execFile } from "node:child_process"
import {
  getBlockedPhase2GitHubProjectStatus,
  getPhase2GitHubProject,
  listPhase2GitHubProjects
} from "./github-project-registry.mjs"

export const GITHUB_READONLY_SOURCE = "GitHub read-only"
export const DEFAULT_ITEM_LIMIT = 5
export const MAX_ITEM_LIMIT = 10

const ansiTerminalSequences = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_])/gu
const lineAndTabControls = /[\u0009-\u000D]+/gu
const unsafeTerminalControls = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/gu

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

function rejectGitHubRequest(code, safeMessage) {
  throw new GitHubReadOnlyError(code, safeMessage)
}

export function sanitizeGitHubText(value) {
  if (typeof value !== "string") {
    return value
  }

  return value
    .replace(ansiTerminalSequences, "")
    .replace(lineAndTabControls, " ")
    .replace(unsafeTerminalControls, "")
}

function endpointSuffix(endpoint, project) {
  const baseEndpoint = repoEndpoint(project)

  if (endpoint === baseEndpoint) {
    return ""
  }

  if (!endpoint.startsWith(`${baseEndpoint}/`)) {
    return null
  }

  return endpoint.slice(baseEndpoint.length)
}

function normalizeQueryParams(queryParams = {}) {
  if (queryParams === null || queryParams === undefined) {
    return {}
  }

  if (typeof queryParams !== "object" || Array.isArray(queryParams)) {
    rejectGitHubRequest(
      "UNSUPPORTED_ENDPOINT",
      "GitHub read-only transport accepts only structured query parameters for approved endpoints."
    )
  }

  return queryParams
}

function validatePerPage(value) {
  const parsedValue = Number(value)

  return Number.isInteger(parsedValue) && parsedValue >= 1 && parsedValue <= MAX_ITEM_LIMIT
}

function validateEndpointQuery(endpoint, queryParams) {
  const query = normalizeQueryParams(queryParams)
  const keys = Object.keys(query)

  if (typeof endpoint !== "string" || !endpoint.startsWith("/")) {
    rejectGitHubRequest(
      "UNSUPPORTED_ENDPOINT",
      "GitHub read-only transport requires an approved GitHub API endpoint path."
    )
  }

  if (endpoint.includes("?") || endpoint.includes("#")) {
    rejectGitHubRequest(
      "UNSUPPORTED_ENDPOINT",
      "GitHub read-only transport accepts endpoint paths only; query parameters must be passed separately."
    )
  }

  for (const project of listPhase2GitHubProjects()) {
    const suffix = endpointSuffix(endpoint, project)

    if (suffix === null) {
      continue
    }

    if (suffix === "") {
      if (keys.length === 0) {
        return
      }

      rejectGitHubRequest(
        "UNSUPPORTED_ENDPOINT",
        `GitHub read-only transport does not allow query parameters for GET ${endpoint}.`
      )
    }

    if (suffix === "/commits") {
      if (keys.every((key) => key === "per_page") && (query.per_page === undefined || validatePerPage(query.per_page))) {
        return
      }

      rejectGitHubRequest(
        "UNSUPPORTED_ENDPOINT",
        `GitHub read-only transport allows only bounded per_page on GET ${endpoint}.`
      )
    }

    if (suffix === "/pulls" || suffix === "/issues") {
      const allowedKeys = keys.every((key) => key === "state" || key === "per_page")
      const stateAllowed = query.state === undefined || query.state === "open"
      const pageAllowed = query.per_page === undefined || validatePerPage(query.per_page)

      if (allowedKeys && stateAllowed && pageAllowed) {
        return
      }

      rejectGitHubRequest(
        "UNSUPPORTED_ENDPOINT",
        `GitHub read-only transport allows only open state and bounded per_page on GET ${endpoint}.`
      )
    }

    break
  }

  rejectGitHubRequest(
    "UNSUPPORTED_ENDPOINT",
    `GitHub read-only transport is limited to Phase 2A repo metadata, commits, pulls, and issues endpoints. Rejected GET ${endpoint}.`
  )
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
  validateEndpointQuery(endpoint, queryParams)

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

function ensureObject(payload, endpoint) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GitHubReadOnlyError(
      "MALFORMED_GITHUB_RESPONSE",
      `GitHub CLI returned an unexpected JSON shape for GET ${endpoint}.`
    )
  }

  return payload
}

function ensureRepoIdentity(payload, project, endpoint) {
  if (payload.full_name === undefined || payload.full_name === null) {
    return
  }

  if (typeof payload.full_name !== "string" || payload.full_name !== project.fullName) {
    throw new GitHubReadOnlyError(
      "MALFORMED_GITHUB_RESPONSE",
      `GitHub CLI returned repository identity that does not match ${project.fullName} for GET ${endpoint}.`
    )
  }
}

function sanitizedStringOrNull(value) {
  if (typeof value !== "string") {
    return null
  }

  const sanitizedValue = sanitizeGitHubText(value)

  return sanitizedValue.length > 0 ? sanitizedValue : null
}

function firstLine(value) {
  if (typeof value !== "string") {
    return ""
  }

  return sanitizeGitHubText(value.split(/[\r\n]/, 1)[0].trim())
}

export function normalizeRepoMetadata(payload, project) {
  const privateState = typeof payload?.private === "boolean" ? payload.private : null

  return {
    fullName: sanitizedStringOrNull(payload?.full_name) || project.fullName,
    defaultBranch: sanitizedStringOrNull(payload?.default_branch),
    visibility: sanitizedStringOrNull(payload?.visibility) || (privateState === null ? null : privateState ? "private" : "public"),
    private: privateState,
    description: sanitizedStringOrNull(payload?.description),
    updatedAt: sanitizedStringOrNull(payload?.updated_at),
    pushedAt: sanitizedStringOrNull(payload?.pushed_at),
    url: sanitizedStringOrNull(payload?.html_url)
  }
}

export function normalizeCommit(payload) {
  const sha = sanitizedStringOrNull(payload?.sha)
  const authorName = sanitizedStringOrNull(payload?.commit?.author?.name) || sanitizedStringOrNull(payload?.author?.login)

  return {
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    message: firstLine(payload?.commit?.message),
    author: authorName,
    timestamp: sanitizedStringOrNull(payload?.commit?.author?.date) || sanitizedStringOrNull(payload?.commit?.committer?.date),
    url: sanitizedStringOrNull(payload?.html_url)
  }
}

export function normalizePullRequest(payload) {
  return {
    number: typeof payload?.number === "number" ? payload.number : null,
    title: sanitizedStringOrNull(payload?.title),
    headRef: sanitizedStringOrNull(payload?.head?.ref),
    baseRef: sanitizedStringOrNull(payload?.base?.ref),
    draft: Boolean(payload?.draft),
    updatedAt: sanitizedStringOrNull(payload?.updated_at),
    url: sanitizedStringOrNull(payload?.html_url)
  }
}

export function normalizeIssue(payload) {
  const labels = Array.isArray(payload?.labels)
    ? payload.labels
      .map((label) => (typeof label === "string" ? sanitizedStringOrNull(label) : sanitizedStringOrNull(label?.name)))
      .filter(Boolean)
    : []

  return {
    number: typeof payload?.number === "number" ? payload.number : null,
    title: sanitizedStringOrNull(payload?.title),
    state: sanitizedStringOrNull(payload?.state),
    labels,
    updatedAt: sanitizedStringOrNull(payload?.updated_at),
    url: sanitizedStringOrNull(payload?.html_url)
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
      const payload = ensureObject(await requestJson(runner, endpoint), endpoint)
      ensureRepoIdentity(payload, project, endpoint)

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
      const page = await this.getOpenIssuesPage(projectId, limit)

      return page.issues
    },

    async getOpenIssuesPage(projectId, limit = DEFAULT_ITEM_LIMIT) {
      const project = resolveProject(projectId)
      const perPage = normalizeLimit(limit)
      const endpoint = `${repoEndpoint(project)}/issues`
      const payload = ensureArray(await requestJson(runner, endpoint, { state: "open", per_page: perPage }), endpoint)
      const issues = payload
        .filter((issue) => !issue?.pull_request)
        .map(normalizeIssue)

      return {
        issues,
        pageLimit: perPage,
        rawReturnedCount: payload.length,
        limitHit: payload.length >= perPage
      }
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

export async function getOpenIssuesPage(projectId, limit = DEFAULT_ITEM_LIMIT, options = {}) {
  return createGitHubReadOnlyClient(options).getOpenIssuesPage(projectId, limit)
}

export async function getProjectSnapshot(projectId, options = {}) {
  return createGitHubReadOnlyClient(options).getProjectSnapshot(projectId)
}
