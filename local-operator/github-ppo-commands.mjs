import {
  GITHUB_READONLY_SOURCE,
  GitHubReadOnlyError,
  createGitHubReadOnlyClient,
  resolveProject
} from "./github-readonly.mjs"

const REPO_COMMIT_LIMIT = 5
const PR_LIMIT = 5

function valueOrFallback(value) {
  return value || "n/a"
}

function commitLine(commit) {
  const ref = commit.shortSha || (commit.sha ? commit.sha.slice(0, 7) : "unknown")
  const message = valueOrFallback(commit.message)
  const author = valueOrFallback(commit.author)
  const timestamp = valueOrFallback(commit.timestamp)

  return `- ${ref} ${message} (${author}, ${timestamp})`
}

function pullRequestLine(pullRequest) {
  const draftLabel = pullRequest.draft ? "draft" : "ready"
  const headRef = valueOrFallback(pullRequest.headRef)
  const baseRef = valueOrFallback(pullRequest.baseRef)

  return `- #${pullRequest.number} ${valueOrFallback(pullRequest.title)} [${headRef} -> ${baseRef}, ${draftLabel}] updated ${valueOrFallback(pullRequest.updatedAt)}`
}

export function formatGitHubPpoError(error) {
  if (error instanceof GitHubReadOnlyError) {
    return `PPO GitHub read-only error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO GitHub read-only error: unexpected local failure."
}

export function formatRepoSummary(project, repository, recentCommits) {
  const lines = [
    `Repo Summary: ${project.displayName}`,
    `Source: ${GITHUB_READONLY_SOURCE}`,
    `Repo: ${repository.fullName || project.fullName}`,
    `Default branch: ${valueOrFallback(repository.defaultBranch)}`,
    `Visibility: ${valueOrFallback(repository.visibility)}`,
    `Description: ${repository.description || "none"}`,
    `Updated: ${valueOrFallback(repository.updatedAt)}`,
    `Pushed: ${valueOrFallback(repository.pushedAt)}`,
    "Recent commits:"
  ]

  if (recentCommits.length === 0) {
    lines.push("- none returned")
  } else {
    lines.push(...recentCommits.map(commitLine))
  }

  return lines.join("\n")
}

export function formatPrSummary(project, repository, openPullRequests) {
  const lines = [
    `PR Summary: ${project.displayName}`,
    `Source: ${GITHUB_READONLY_SOURCE}`,
    `Repo: ${repository.fullName || project.fullName}`,
    `Open PRs: ${openPullRequests.length === 0 ? "none" : openPullRequests.length}`
  ]

  if (openPullRequests.length > 0) {
    lines.push(...openPullRequests.map(pullRequestLine))
  }

  return lines.join("\n")
}

export async function handleGitHubPpoCommand(command, projectId, options = {}) {
  try {
    const project = resolveProject(projectId)
    const client = options.client || createGitHubReadOnlyClient()

    if (command === "repo") {
      const [repository, recentCommits] = await Promise.all([
        client.getRepoMetadata(project.id),
        client.getRecentCommits(project.id, REPO_COMMIT_LIMIT)
      ])

      return {
        ok: true,
        output: formatRepoSummary(project, repository, recentCommits)
      }
    }

    if (command === "pr") {
      const [repository, openPullRequests] = await Promise.all([
        client.getRepoMetadata(project.id),
        client.getOpenPullRequests(project.id, PR_LIMIT)
      ])

      return {
        ok: true,
        output: formatPrSummary(project, repository, openPullRequests)
      }
    }

    throw new GitHubReadOnlyError(
      "UNSUPPORTED_GITHUB_PPO_COMMAND",
      "Unsupported GitHub PPO command. Use /ppo repo <project> or /ppo pr <project>."
    )
  } catch (error) {
    return {
      ok: false,
      output: formatGitHubPpoError(error)
    }
  }
}
