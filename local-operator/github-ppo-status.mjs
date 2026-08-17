import {
  GITHUB_READONLY_SOURCE,
  GitHubReadOnlyError,
  createGitHubReadOnlyClient,
  listAllowedProjects
} from "./github-readonly.mjs"

const STATUS_READ_LIMIT = 5
const unexpectedStatusFailure = "unexpected local failure."

function valueOrFallback(value) {
  return value || "n/a"
}

function countLabel(items) {
  if (items.length === 0) {
    return "none"
  }

  if (items.length >= STATUS_READ_LIMIT) {
    return `${STATUS_READ_LIMIT}+`
  }

  return String(items.length)
}

function issueCountLabel(openIssuesPage) {
  const issues = Array.isArray(openIssuesPage)
    ? openIssuesPage
    : openIssuesPage?.issues || []
  const limitHit = !Array.isArray(openIssuesPage) && Boolean(openIssuesPage?.limitHit)

  if (limitHit) {
    if (issues.length === 0) {
      return "unknown (page limit hit)"
    }

    return `${issues.length}+`
  }

  return countLabel(issues)
}

function latestCommitLabel(recentCommits) {
  const latestCommit = recentCommits[0]

  if (!latestCommit) {
    return "none returned"
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

export function formatProjectStatus(project, repository, recentCommits, openPullRequests, openIssuesPage) {
  return [
    project.displayName,
    `- Repo: ${repository.fullName || project.fullName}`,
    `- Default: ${valueOrFallback(repository.defaultBranch)}`,
    `- Latest: ${latestCommitLabel(recentCommits)}`,
    `- Open PRs: ${countLabel(openPullRequests)}`,
    `- Open issues: ${issueCountLabel(openIssuesPage)}`,
    `- Updated: ${valueOrFallback(repository.updatedAt)}`
  ].join("\n")
}

export function formatProjectStatusFailure(project, error) {
  return [
    project.displayName,
    `- Status unavailable: ${safeStatusMessage(error)}`
  ].join("\n")
}

async function readProjectStatus(client, project) {
  const repository = await client.getRepoMetadata(project.id)
  const recentCommits = await client.getRecentCommits(project.id, STATUS_READ_LIMIT)
  const openPullRequests = await client.getOpenPullRequests(project.id, STATUS_READ_LIMIT)
  const openIssuesPage = await client.getOpenIssuesPage(project.id, STATUS_READ_LIMIT)

  return formatProjectStatus(project, repository, recentCommits, openPullRequests, openIssuesPage)
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
