import {
  GITHUB_READONLY_SOURCE,
  GitHubReadOnlyError,
  createGitHubReadOnlyClient,
  listAllowedProjects
} from "./github-readonly.mjs"

const STATUS_READ_LIMIT = 5
const unexpectedStatusFailure = "unexpected local failure."

function valueOrFallback(value) {
  return typeof value === "string" && value.trim() ? value : "unavailable"
}

function countLabel(items) {
  if (!Array.isArray(items)) return "unavailable"
  if (items.length === 0) {
    return "none"
  }

  if (items.length >= STATUS_READ_LIMIT) {
    return `${STATUS_READ_LIMIT}+`
  }

  return String(items.length)
}

function issueCountLabel(openIssuesPage) {
  if (!Array.isArray(openIssuesPage) && (!openIssuesPage ||
      !Array.isArray(openIssuesPage.issues) || typeof openIssuesPage.limitHit !== "boolean")) {
    return "unavailable"
  }
  const issues = Array.isArray(openIssuesPage) ? openIssuesPage : openIssuesPage.issues
  const limitHit = !Array.isArray(openIssuesPage) && openIssuesPage.limitHit

  if (limitHit) {
    if (issues.length === 0) {
      return "unknown (page limit hit)"
    }

    return `${issues.length}+`
  }

  return countLabel(issues)
}

function latestCommitLabel(recentCommits) {
  if (!Array.isArray(recentCommits)) return "unavailable"
  if (recentCommits.length === 0) return "none returned"
  const latestCommit = recentCommits[0]

  if (!latestCommit || typeof latestCommit !== "object") {
    return "unavailable"
  }

  const ref = latestCommit.shortSha || (latestCommit.sha ? latestCommit.sha.slice(0, 7) : "unknown")
  const message = valueOrFallback(latestCommit.message)

  return `${ref} ${message}`
}

function safeStatusMessage(error) {
  if (error instanceof GitHubReadOnlyError) {
    return error.safeMessage
  }

  return unexpectedStatusFailure
}

export function formatProjectStatus(project, repository, recentCommits, openPullRequests, openIssuesPage, failures = {}) {
  const report = (label, value) => failures[label] ? `unavailable (${safeStatusMessage(failures[label])})` : value
  return [
    project.displayName,
    `- Repo: ${repository?.fullName || `${project.fullName} (configured; metadata unavailable)`}`,
    `- Default: ${report("repository", valueOrFallback(repository?.defaultBranch))}`,
    `- Latest: ${report("commits", latestCommitLabel(recentCommits))}`,
    `- Open PRs: ${report("pullRequests", countLabel(openPullRequests))}`,
    `- Open issues: ${report("issues", issueCountLabel(openIssuesPage))}`,
    `- Updated: ${report("repository", valueOrFallback(repository?.updatedAt))}`
  ].join("\n")
}

export function formatProjectStatusFailure(project, error) {
  return [
    project.displayName,
    `- Status unavailable: ${safeStatusMessage(error)}`
  ].join("\n")
}

async function readProjectStatus(client, project) {
  const values = {}, failures = {}
  // Keep registry order and the same four bounded reads. One unavailable
  // source must not erase independent observations from the other sources.
  for (const [key, method, args] of [
    ["repository", "getRepoMetadata", [project.id]],
    ["commits", "getRecentCommits", [project.id, STATUS_READ_LIMIT]],
    ["pullRequests", "getOpenPullRequests", [project.id, STATUS_READ_LIMIT]],
    ["issues", "getOpenIssuesPage", [project.id, STATUS_READ_LIMIT]]
  ]) {
    try { values[key] = await client[method](...args) }
    catch (error) { failures[key] = error; values[key] = null }
  }
  if (Object.keys(failures).length === 4) {
    return formatProjectStatusFailure(project, failures.repository)
  }
  return formatProjectStatus(project, values.repository, values.commits,
    values.pullRequests, values.issues, failures)
}

export async function handleGitHubPpoStatus(options = {}) {
  const client = options.client || createGitHubReadOnlyClient()
  const sections = []

  for (const project of listAllowedProjects()) {
    try {
      sections.push(await readProjectStatus(client, project))
    } catch (error) {
      sections.push(formatProjectStatusFailure(project, error))
    }
  }

  return {
    ok: true,
    output: [
      "Project Status",
      `Source: ${GITHUB_READONLY_SOURCE}`,
      "",
      sections.join("\n\n")
    ].join("\n")
  }
}
