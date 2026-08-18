import assert from "node:assert/strict"
import * as githubPpoStatus from "./github-ppo-status.mjs"
import { GitHubReadOnlyError, listAllowedProjects } from "./github-readonly.mjs"

const allowedProjects = listAllowedProjects()
const allowedProjectIds = allowedProjects.map((project) => project.id)
const STATUS_READ_LIMIT = 5

function makeItems(count, prefix) {
  return Array.from({ length: count }, (_value, index) => ({
    number: index + 1,
    title: `${prefix} ${index + 1}`
  }))
}

function makeIssuePage(count, options = {}) {
  const limitHit = Boolean(options.limitHit)

  return {
    issues: makeItems(count, "issue"),
    pageLimit: STATUS_READ_LIMIT,
    rawReturnedCount: options.rawReturnedCount ?? (limitHit ? STATUS_READ_LIMIT : count),
    limitHit
  }
}

function baseRepository(projectId) {
  const project = allowedProjects.find((candidate) => candidate.id === projectId)

  return {
    fullName: project.fullName,
    defaultBranch: "main",
    updatedAt: `2026-08-16T1${allowedProjectIds.indexOf(projectId)}:00:00Z`
  }
}

function makeClient(config = {}) {
  const calls = []

  return {
    calls,

    async getRepoMetadata(projectId) {
      calls.push(["getRepoMetadata", projectId])

      if (config.failures?.[projectId]?.getRepoMetadata) {
        throw config.failures[projectId].getRepoMetadata
      }

      return config.repositories?.[projectId] || baseRepository(projectId)
    },

    async getRecentCommits(projectId, limit) {
      calls.push(["getRecentCommits", projectId, limit])

      if (config.failures?.[projectId]?.getRecentCommits) {
        throw config.failures[projectId].getRecentCommits
      }

      return config.commits?.[projectId] || [
        {
          shortSha: `${projectId.slice(0, 3)}1234`,
          message: `Update ${projectId}`,
          timestamp: "2026-08-16T12:00:00Z"
        }
      ]
    },

    async getOpenPullRequests(projectId, limit) {
      calls.push(["getOpenPullRequests", projectId, limit])

      if (config.failures?.[projectId]?.getOpenPullRequests) {
        throw config.failures[projectId].getOpenPullRequests
      }

      return config.pullRequests?.[projectId] || []
    },

    async getOpenIssuesPage(projectId, limit) {
      calls.push(["getOpenIssuesPage", projectId, limit])

      if (config.failures?.[projectId]?.getOpenIssuesPage) {
        throw config.failures[projectId].getOpenIssuesPage
      }

      if (config.issuePages?.[projectId]) {
        return config.issuePages[projectId]
      }

      const issues = config.issues?.[projectId] || []

      return {
        issues,
        pageLimit: STATUS_READ_LIMIT,
        rawReturnedCount: issues.length,
        limitHit: issues.length >= STATUS_READ_LIMIT
      }
    }
  }
}

{
  const client = makeClient({
    repositories: {
      "khlim-assist": {
        fullName: "Linardi1328/khlim-assist",
        defaultBranch: "main",
        updatedAt: "2026-08-16T19:09:45Z"
      },
      "ledgerpilot-ai": {
        fullName: "Linardi1328/ledgerpilot-ai",
        defaultBranch: "main",
        updatedAt: "2026-08-16T20:00:00Z"
      },
      "spy-market-agent": {
        fullName: "Linardi1328/spy-market-agent",
        defaultBranch: "main",
        updatedAt: "2026-08-16T21:00:00Z"
      },
      portfolio: {
        fullName: "Linardi1328/richie-linardi-portfolio-website",
        defaultBranch: "main",
        updatedAt: "2026-08-16T22:00:00Z"
      }
    },
    commits: {
      "khlim-assist": [
        {
          shortSha: "1dd9e08",
          message: "Merge pull request #5 café 東京"
        }
      ],
      "ledgerpilot-ai": [],
      "spy-market-agent": [
        {
          sha: "abcdef1234567890",
          message: "Refresh market notes"
        }
      ],
      portfolio: [
        {
          shortSha: "aaabbbb",
          message: "Polish case study"
        }
      ]
    },
    pullRequests: {
      "khlim-assist": [],
      "ledgerpilot-ai": makeItems(1, "pr"),
      "spy-market-agent": makeItems(4, "pr"),
      portfolio: makeItems(5, "pr")
    },
    issuePages: {
      "khlim-assist": makeIssuePage(0),
      "ledgerpilot-ai": makeIssuePage(1),
      "spy-market-agent": makeIssuePage(4),
      portfolio: makeIssuePage(5, { limitHit: true })
    }
  })

  const result = await githubPpoStatus.handleGitHubPpoStatus({ client })

  assert.equal(result.ok, true)
  assert.match(result.output, /^Project Status\nSource: GitHub read-only/)

  const projectNameOrder = allowedProjects.map((project) => result.output.indexOf(project.displayName))
  assert.deepEqual(
    projectNameOrder,
    [...projectNameOrder].sort((left, right) => left - right),
    "projects appear in registry order"
  )

  assert.match(result.output, /KHLIM Assist\n- Repo: Linardi1328\/khlim-assist\n- Default: main/)
  assert.match(result.output, /- Latest: 1dd9e08 Merge pull request #5 café 東京/)
  assert.match(result.output, /- Open PRs: none/)
  assert.match(result.output, /- Open issues: none/)
  assert.match(result.output, /- Updated: 2026-08-16T19:09:45Z/)
  assert.match(result.output, /LedgerPilot AI[\s\S]*- Latest: none returned[\s\S]*- Open PRs: 1[\s\S]*- Open issues: 1/)
  assert.match(result.output, /SPY Market Agent[\s\S]*- Latest: abcdef1 Refresh market notes[\s\S]*- Open PRs: 4[\s\S]*- Open issues: 4/)
  assert.match(result.output, /Portfolio Website[\s\S]*- Open PRs: 5\+[\s\S]*- Open issues: 5\+/)
  assert.match(result.output, /RBL Content Engine[\s\S]*- Repo: Linardi1328\/rbl-content-engine[\s\S]*- Latest: rbl1234 Update rbl-content-engine/)

  const queriedProjectIds = new Set(client.calls.map((call) => call[1]))
  assert.deepEqual([...queriedProjectIds], allowedProjectIds)

  for (const call of client.calls) {
    assert.equal(allowedProjectIds.includes(call[1]), true, `${call[1]} is allowlisted`)

    if (call[0] !== "getRepoMetadata") {
      assert.equal(call[2], STATUS_READ_LIMIT, `${call[0]} uses bounded limit`)
    }
  }

  const expectedSequentialCalls = allowedProjectIds.flatMap((projectId) => [
    ["getRepoMetadata", projectId],
    ["getRecentCommits", projectId, STATUS_READ_LIMIT],
    ["getOpenPullRequests", projectId, STATUS_READ_LIMIT],
    ["getOpenIssuesPage", projectId, STATUS_READ_LIMIT]
  ])

  assert.deepEqual(client.calls, expectedSequentialCalls, "projects and reads are sequential and bounded")
}

{
  const project = allowedProjects[0]
  const repository = baseRepository(project.id)
  const recentCommits = []
  const pullRequests = []

  const saturatedThree = githubPpoStatus.formatProjectStatus(
    project,
    repository,
    recentCommits,
    pullRequests,
    {
      issues: makeItems(3, "issue"),
      pageLimit: STATUS_READ_LIMIT,
      rawReturnedCount: STATUS_READ_LIMIT,
      limitHit: true
    }
  )

  assert.match(saturatedThree, /- Open issues: 3\+/)
  assert.doesNotMatch(saturatedThree, /^- Open issues: 3$/m)

  const saturatedZero = githubPpoStatus.formatProjectStatus(
    project,
    repository,
    recentCommits,
    pullRequests,
    {
      issues: [],
      pageLimit: STATUS_READ_LIMIT,
      rawReturnedCount: STATUS_READ_LIMIT,
      limitHit: true
    }
  )

  assert.match(saturatedZero, /- Open issues: unknown \(page limit hit\)/)
  assert.doesNotMatch(saturatedZero, /^- Open issues: none$/m)
}

{
  const gitHubError = new GitHubReadOnlyError("GITHUB_CLI_UNAUTHENTICATED", "Safe auth message.")
  gitHubError.stderr = "SENSITIVE_TEST_SENTINEL raw stderr"
  const client = makeClient({
    failures: {
      "ledgerpilot-ai": {
        getRepoMetadata: gitHubError
      }
    }
  })

  const result = await githubPpoStatus.handleGitHubPpoStatus({ client })

  assert.equal(result.ok, true)
  assert.match(result.output, /KHLIM Assist/)
  assert.match(result.output, /LedgerPilot AI\n- Status unavailable: Safe auth message\./)
  assert.match(result.output, /SPY Market Agent/)
  assert.match(result.output, /Portfolio Website/)
  assert.doesNotMatch(result.output, /SENSITIVE_TEST_SENTINEL|raw stderr|GITHUB_CLI_UNAUTHENTICATED/)
}

{
  const client = makeClient({
    failures: {
      "spy-market-agent": {
        getOpenPullRequests: new Error("SENSITIVE_TEST_SENTINEL unexpected failure")
      }
    }
  })

  const result = await githubPpoStatus.handleGitHubPpoStatus({ client })

  assert.equal(result.ok, true)
  assert.match(result.output, /SPY Market Agent\n- Status unavailable: unexpected local failure\./)
  assert.match(result.output, /Portfolio Website/)
  assert.doesNotMatch(result.output, /SENSITIVE_TEST_SENTINEL|unexpected failure/)
}

{
  const exportedNames = Object.keys(githubPpoStatus).sort()

  assert.deepEqual(exportedNames, [
    "formatProjectStatus",
    "formatProjectStatusFailure",
    "handleGitHubPpoStatus"
  ])
  assert.equal(exportedNames.some((name) => /create|update|delete|merge|approve|close|comment|label|push|write/i.test(name)), false)
}

console.log("GitHub PPO status tests passed: live status formatting, bounded reads, failure isolation, and safe errors.")
