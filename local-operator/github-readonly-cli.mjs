#!/usr/bin/env node
import {
  GitHubReadOnlyError,
  createGitHubReadOnlyClient,
  listAllowedProjects
} from "./github-readonly.mjs"

const commands = new Set(["repo", "commits", "prs", "issues", "snapshot"])

function usage() {
  const projects = listAllowedProjects().map((project) => project.id).join(", ")

  return [
    "Personal Project Operator GitHub Read-Only CLI",
    "",
    "Terminal validation only. Phase 2A does not expose Telegram commands.",
    "",
    "Usage:",
    "  node local-operator/github-readonly-cli.mjs repo <project-id>",
    "  node local-operator/github-readonly-cli.mjs commits <project-id> [limit]",
    "  node local-operator/github-readonly-cli.mjs prs <project-id> [limit]",
    "  node local-operator/github-readonly-cli.mjs issues <project-id> [limit]",
    "  node local-operator/github-readonly-cli.mjs snapshot <project-id>",
    "",
    `Allowed projects: ${projects}`
  ].join("\n")
}

function formatValue(value) {
  return value || "n/a"
}

function printRepo(metadata) {
  console.log(`Repo: ${metadata.fullName}`)
  console.log(`Default: ${formatValue(metadata.defaultBranch)}`)
  console.log(`Visibility: ${formatValue(metadata.visibility)}`)
  console.log(`Description: ${formatValue(metadata.description)}`)
  console.log(`Updated: ${formatValue(metadata.updatedAt)}`)
  console.log(`Pushed: ${formatValue(metadata.pushedAt)}`)
  if (metadata.url) {
    console.log(`URL: ${metadata.url}`)
  }
}

function printCommits(commits) {
  console.log("Recent commits:")
  if (commits.length === 0) {
    console.log("- none returned")
    return
  }

  for (const commit of commits) {
    console.log(`- ${formatValue(commit.shortSha)} ${formatValue(commit.message)} (${formatValue(commit.author)}, ${formatValue(commit.timestamp)})`)
  }
}

function printPullRequests(pullRequests) {
  console.log("Open PRs:")
  if (pullRequests.length === 0) {
    console.log("- none open")
    return
  }

  for (const pullRequest of pullRequests) {
    const draftLabel = pullRequest.draft ? " draft" : ""
    console.log(`- #${pullRequest.number} ${formatValue(pullRequest.title)} [${formatValue(pullRequest.headRef)} -> ${formatValue(pullRequest.baseRef)}${draftLabel}] updated ${formatValue(pullRequest.updatedAt)}`)
  }
}

function printIssues(issues) {
  console.log("Open issues:")
  if (issues.length === 0) {
    console.log("- none open")
    return
  }

  for (const issue of issues) {
    const labels = issue.labels.length > 0 ? ` labels: ${issue.labels.join(", ")}` : ""
    console.log(`- #${issue.number} ${formatValue(issue.title)} (${formatValue(issue.state)}, updated ${formatValue(issue.updatedAt)})${labels}`)
  }
}

function printSnapshot(snapshot) {
  console.log(`Project: ${snapshot.project.displayName} (${snapshot.project.id})`)
  console.log(`Source: ${snapshot.source}`)
  console.log(`Retrieved: ${snapshot.retrievedAt}`)
  printRepo(snapshot.repository)
  console.log("")
  printCommits(snapshot.recentCommits)
  console.log("")
  printPullRequests(snapshot.openPullRequests)
  console.log("")
  printIssues(snapshot.openIssues)
}

async function main() {
  const [command, projectId, limit] = process.argv.slice(2)

  if (!commands.has(command) || !projectId) {
    console.log(usage())
    process.exitCode = 1
    return
  }

  const client = createGitHubReadOnlyClient()

  if (command === "repo") {
    printRepo(await client.getRepoMetadata(projectId))
    return
  }

  if (command === "commits") {
    printCommits(await client.getRecentCommits(projectId, limit))
    return
  }

  if (command === "prs") {
    printPullRequests(await client.getOpenPullRequests(projectId, limit))
    return
  }

  if (command === "issues") {
    printIssues(await client.getOpenIssues(projectId, limit))
    return
  }

  printSnapshot(await client.getProjectSnapshot(projectId))
}

main().catch((error) => {
  if (error instanceof GitHubReadOnlyError) {
    console.error(`PPO GitHub read-only error [${error.code}]: ${error.safeMessage}`)
  } else {
    console.error("PPO GitHub read-only error: unexpected local failure.")
  }

  process.exitCode = 1
})
