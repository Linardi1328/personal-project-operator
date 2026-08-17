import assert from "node:assert/strict"
import * as githubPpoCommands from "./github-ppo-commands.mjs"
import { GitHubReadOnlyError, listAllowedProjects } from "./github-readonly.mjs"

const allowedProjectIds = ["khlim-assist", "ledgerpilot-ai", "spy-market-agent", "portfolio"]

const repository = {
  fullName: "Linardi1328/khlim-assist",
  defaultBranch: "main",
  visibility: "private",
  description: "Admin workflow assistant",
  updatedAt: "2026-08-16T10:00:00Z",
  pushedAt: "2026-08-16T11:00:00Z"
}

const commits = [
  {
    sha: "abcdef1234567890",
    shortSha: "abcdef1",
    message: "Add reporting view",
    author: "Richie",
    timestamp: "2026-08-16T12:00:00Z"
  },
  {
    sha: "1234567890abcdef",
    shortSha: "1234567",
    message: "Tighten tests",
    author: "Linardi1328",
    timestamp: "2026-08-16T13:00:00Z"
  }
]

const pullRequests = [
  {
    number: 7,
    title: "Prepare read-only state",
    headRef: "feature/read-state",
    baseRef: "main",
    draft: true,
    updatedAt: "2026-08-16T14:00:00Z"
  },
  {
    number: 8,
    title: "Polish formatter",
    headRef: "formatter-polish",
    baseRef: "main",
    draft: false,
    updatedAt: "2026-08-16T15:00:00Z"
  }
]

function makeClient(overrides = {}) {
  const calls = []
  const client = {
    calls,
    async getRepoMetadata(projectId) {
      calls.push(["getRepoMetadata", projectId])
      if (overrides.getRepoMetadata) {
        return overrides.getRepoMetadata(projectId)
      }

      return {
        ...repository,
        fullName: listAllowedProjects().find((project) => project.id === projectId)?.fullName || repository.fullName
      }
    },
    async getRecentCommits(projectId, limit) {
      calls.push(["getRecentCommits", projectId, limit])
      if (overrides.getRecentCommits) {
        return overrides.getRecentCommits(projectId, limit)
      }

      return commits
    },
    async getOpenPullRequests(projectId, limit) {
      calls.push(["getOpenPullRequests", projectId, limit])
      if (overrides.getOpenPullRequests) {
        return overrides.getOpenPullRequests(projectId, limit)
      }

      return pullRequests
    }
  }

  return client
}

{
  const client = makeClient()
  const result = await githubPpoCommands.handleGitHubPpoCommand("repo", "khlim-assist", { client })

  assert.equal(result.ok, true)
  assert.match(result.output, /^Repo Summary: KHLIM Assist/)
  assert.match(result.output, /Source: GitHub read-only/)
  assert.match(result.output, /Repo: Linardi1328\/khlim-assist/)
  assert.match(result.output, /Default branch: main/)
  assert.match(result.output, /Visibility: private/)
  assert.match(result.output, /Description: Admin workflow assistant/)
  assert.match(result.output, /Updated: 2026-08-16T10:00:00Z/)
  assert.match(result.output, /Pushed: 2026-08-16T11:00:00Z/)
  assert.match(result.output, /Recent commits:\n- abcdef1 Add reporting view \(Richie, 2026-08-16T12:00:00Z\)/)
  assert.match(result.output, /- 1234567 Tighten tests \(Linardi1328, 2026-08-16T13:00:00Z\)/)
  assert.deepEqual(client.calls, [
    ["getRepoMetadata", "khlim-assist"],
    ["getRecentCommits", "khlim-assist", 5]
  ])
}

{
  const client = makeClient({
    getRepoMetadata: () => ({ ...repository, description: null })
  })
  const result = await githubPpoCommands.handleGitHubPpoCommand("repo", "khlim-assist", { client })

  assert.equal(result.ok, true)
  assert.match(result.output, /Description: none/)
}

{
  const client = makeClient()
  const result = await githubPpoCommands.handleGitHubPpoCommand("pr", "khlim-assist", { client })

  assert.equal(result.ok, true)
  assert.match(result.output, /^PR Summary: KHLIM Assist/)
  assert.match(result.output, /Source: GitHub read-only/)
  assert.match(result.output, /Repo: Linardi1328\/khlim-assist/)
  assert.match(result.output, /Open PRs: 2/)
  assert.match(result.output, /- #7 Prepare read-only state \[feature\/read-state -> main, draft\] updated 2026-08-16T14:00:00Z/)
  assert.match(result.output, /- #8 Polish formatter \[formatter-polish -> main, ready\] updated 2026-08-16T15:00:00Z/)
  assert.deepEqual(client.calls, [
    ["getRepoMetadata", "khlim-assist"],
    ["getOpenPullRequests", "khlim-assist", 5]
  ])
}

{
  const client = makeClient({
    getOpenPullRequests: () => []
  })
  const result = await githubPpoCommands.handleGitHubPpoCommand("pr", "khlim-assist", { client })

  assert.equal(result.ok, true)
  assert.match(result.output, /^PR Summary: KHLIM Assist/)
  assert.match(result.output, /Open PRs: none/)
  assert.doesNotMatch(result.output, /#7/)
}

for (const projectId of allowedProjectIds) {
  const client = makeClient()
  const repoResult = await githubPpoCommands.handleGitHubPpoCommand("repo", projectId, { client })
  const prResult = await githubPpoCommands.handleGitHubPpoCommand("pr", projectId, { client })

  assert.equal(repoResult.ok, true, `${projectId} repo command succeeds`)
  assert.equal(prResult.ok, true, `${projectId} pr command succeeds`)
}

for (const projectId of [
  "unknown",
  "rbl-content-engine",
  "prooflab",
  "jom-jelajah",
  "khlim-assist && whoami",
  "khlim-assist; whoami",
  "../../khlim-assist",
  "Linardi1328/khlim-assist"
]) {
  const client = makeClient()
  const result = await githubPpoCommands.handleGitHubPpoCommand("repo", projectId, { client })

  assert.equal(result.ok, false, `${projectId} is rejected`)
  assert.match(result.output, /^PPO GitHub read-only error \[/)
  assert.deepEqual(client.calls, [], `${projectId} performs zero client calls`)
}

{
  const client = makeClient({
    getRepoMetadata: () => {
      const error = new GitHubReadOnlyError("GITHUB_API_FAILED", "Safe retry message.")
      error.stderr = "raw stderr with SENSITIVE_TEST_SENTINEL"
      error.stdout = "raw stdout with SENSITIVE_TEST_SENTINEL"
      throw error
    }
  })
  const result = await githubPpoCommands.handleGitHubPpoCommand("repo", "khlim-assist", { client })

  assert.equal(result.ok, false)
  assert.equal(result.output, "PPO GitHub read-only error [GITHUB_API_FAILED]: Safe retry message.")
  assert.doesNotMatch(result.output, /SENSITIVE_TEST_SENTINEL|raw stderr|raw stdout/)
}

{
  const client = makeClient({
    getRepoMetadata: () => {
      throw new Error("unexpected sensitive-bearing error SENSITIVE_TEST_SENTINEL")
    }
  })
  const result = await githubPpoCommands.handleGitHubPpoCommand("repo", "khlim-assist", { client })

  assert.equal(result.ok, false)
  assert.equal(result.output, "PPO GitHub read-only error: unexpected local failure.")
  assert.doesNotMatch(result.output, /SENSITIVE_TEST_SENTINEL|unexpected sensitive-bearing error/)
}

{
  const exportedNames = Object.keys(githubPpoCommands).sort()

  assert.deepEqual(exportedNames, [
    "formatGitHubPpoError",
    "formatPrSummary",
    "formatRepoSummary",
    "handleGitHubPpoCommand"
  ])
  assert.equal(exportedNames.some((name) => /create|update|delete|merge|approve|close|comment|label|push|write/i.test(name)), false)
}

console.log("GitHub PPO command tests passed: repo/pr formatting, safe errors, allowlist rejection, and no write handlers.")
