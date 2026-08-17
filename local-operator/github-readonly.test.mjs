import assert from "node:assert/strict"
import {
  GITHUB_READONLY_SOURCE,
  GitHubReadOnlyError,
  MAX_ITEM_LIMIT,
  buildGhApiGetArgs,
  createGhApiGetRunner,
  createGitHubReadOnlyClient,
  listAllowedProjects,
  resolveProject
} from "./github-readonly.mjs"

const allowedProjectIds = ["khlim-assist", "ledgerpilot-ai", "spy-market-agent", "portfolio"]

const repoPayload = {
  full_name: "Linardi1328/khlim-assist",
  default_branch: "main",
  visibility: "private",
  private: true,
  description: "Admin workflow assistant",
  updated_at: "2026-08-16T10:00:00Z",
  pushed_at: "2026-08-16T11:00:00Z",
  html_url: "https://github.com/Linardi1328/khlim-assist"
}

const commitPayload = [
  {
    sha: "abcdef1234567890",
    commit: {
      message: "Add reporting view\n\nBody ignored",
      author: {
        name: "Richie",
        date: "2026-08-16T12:00:00Z"
      }
    },
    author: {
      login: "Linardi1328"
    },
    html_url: "https://github.com/Linardi1328/khlim-assist/commit/abcdef1234567890"
  }
]

const pullRequestPayload = [
  {
    number: 7,
    title: "Prepare read-only state",
    head: {
      ref: "feature/read-state"
    },
    base: {
      ref: "main"
    },
    draft: true,
    updated_at: "2026-08-16T13:00:00Z",
    html_url: "https://github.com/Linardi1328/khlim-assist/pull/7"
  }
]

const issuePayload = [
  {
    number: 3,
    title: "Document admin approval path",
    state: "open",
    labels: [{ name: "docs" }, "phase-2"],
    updated_at: "2026-08-16T14:00:00Z",
    html_url: "https://github.com/Linardi1328/khlim-assist/issues/3"
  },
  {
    number: 7,
    title: "Prepare read-only state",
    pull_request: {
      url: "https://api.github.com/repos/Linardi1328/khlim-assist/pulls/7"
    },
    state: "open",
    labels: [],
    updated_at: "2026-08-16T13:00:00Z",
    html_url: "https://github.com/Linardi1328/khlim-assist/pull/7"
  }
]

function makeFixtureRunner(calls = []) {
  return async (request) => {
    calls.push({
      method: request.method,
      endpoint: request.endpoint,
      queryParams: { ...request.queryParams }
    })

    assert.equal(request.method, "GET", "generated request is explicitly GET")

    if (request.endpoint.endsWith("/commits")) {
      return { stdout: JSON.stringify(commitPayload) }
    }

    if (request.endpoint.endsWith("/pulls")) {
      return { stdout: JSON.stringify(pullRequestPayload) }
    }

    if (request.endpoint.endsWith("/issues")) {
      return { stdout: JSON.stringify(issuePayload) }
    }

    return { stdout: JSON.stringify(repoPayload) }
  }
}

async function expectReadOnlyError(fn, expectedCode) {
  await assert.rejects(
    fn,
    (error) => {
      assert.equal(error instanceof GitHubReadOnlyError, true)
      assert.equal(error.code, expectedCode)
      assert.equal(error.message, error.safeMessage)
      return true
    }
  )
}

assert.deepEqual(listAllowedProjects().map((project) => project.id), allowedProjectIds)

for (const projectId of allowedProjectIds) {
  const project = resolveProject(projectId)
  assert.equal(project.id, projectId)
  assert.equal(project.fullName, `${project.owner}/${project.repo}`)
}

const rejectedProjectInputs = [
  "Linardi1328/khlim-assist",
  "octocat/Hello-World",
  "unknown-project",
  "rbl-content-engine",
  "prooflab",
  "jom-jelajah",
  "khlim-assist && whoami",
  "khlim-assist; touch /tmp/ppo",
  "$(whoami)",
  "`whoami`",
  "../../khlim-assist",
  "",
  null
]

for (const input of rejectedProjectInputs) {
  const calls = []
  const client = createGitHubReadOnlyClient({ runner: makeFixtureRunner(calls) })

  await expectReadOnlyError(() => client.getRepoMetadata(input), input === null || input === "" ? "INVALID_PROJECT" : blockedProjectIds(input) ? "PROJECT_NOT_CONNECTED" : "UNKNOWN_PROJECT")
  assert.equal(calls.length, 0, `${String(input)} performs zero GitHub calls`)
}

function blockedProjectIds(projectId) {
  return ["rbl-content-engine", "prooflab", "jom-jelajah"].includes(projectId)
}

{
  const calls = []
  const client = createGitHubReadOnlyClient({ runner: makeFixtureRunner(calls) })
  const metadata = await client.getRepoMetadata("khlim-assist")

  assert.deepEqual(metadata, {
    fullName: "Linardi1328/khlim-assist",
    defaultBranch: "main",
    visibility: "private",
    private: true,
    description: "Admin workflow assistant",
    updatedAt: "2026-08-16T10:00:00Z",
    pushedAt: "2026-08-16T11:00:00Z",
    url: "https://github.com/Linardi1328/khlim-assist"
  })
  assert.deepEqual(calls[0], {
    method: "GET",
    endpoint: "/repos/Linardi1328/khlim-assist",
    queryParams: {}
  })
}

{
  const calls = []
  const client = createGitHubReadOnlyClient({ runner: makeFixtureRunner(calls) })
  const commits = await client.getRecentCommits("khlim-assist", 5)

  assert.deepEqual(commits, [
    {
      sha: "abcdef1234567890",
      shortSha: "abcdef1",
      message: "Add reporting view",
      author: "Richie",
      timestamp: "2026-08-16T12:00:00Z",
      url: "https://github.com/Linardi1328/khlim-assist/commit/abcdef1234567890"
    }
  ])
  assert.equal(calls[0].method, "GET")
  assert.equal(calls[0].endpoint, "/repos/Linardi1328/khlim-assist/commits")
  assert.equal(calls[0].queryParams.per_page, 5)
}

{
  const calls = []
  const client = createGitHubReadOnlyClient({ runner: makeFixtureRunner(calls) })
  const pullRequests = await client.getOpenPullRequests("khlim-assist", 5)

  assert.deepEqual(pullRequests, [
    {
      number: 7,
      title: "Prepare read-only state",
      headRef: "feature/read-state",
      baseRef: "main",
      draft: true,
      updatedAt: "2026-08-16T13:00:00Z",
      url: "https://github.com/Linardi1328/khlim-assist/pull/7"
    }
  ])
  assert.equal(calls[0].method, "GET")
  assert.equal(calls[0].endpoint, "/repos/Linardi1328/khlim-assist/pulls")
  assert.deepEqual(calls[0].queryParams, { state: "open", per_page: 5 })
}

{
  const calls = []
  const client = createGitHubReadOnlyClient({ runner: makeFixtureRunner(calls) })
  const issues = await client.getOpenIssues("khlim-assist", 5)

  assert.deepEqual(issues, [
    {
      number: 3,
      title: "Document admin approval path",
      state: "open",
      labels: ["docs", "phase-2"],
      updatedAt: "2026-08-16T14:00:00Z",
      url: "https://github.com/Linardi1328/khlim-assist/issues/3"
    }
  ])
  assert.equal(calls[0].method, "GET")
  assert.equal(calls[0].endpoint, "/repos/Linardi1328/khlim-assist/issues")
  assert.deepEqual(calls[0].queryParams, { state: "open", per_page: 5 })
}

{
  const calls = []
  const client = createGitHubReadOnlyClient({
    runner: makeFixtureRunner(calls),
    now: () => new Date("2026-08-17T00:00:00.000Z")
  })
  const snapshot = await client.getProjectSnapshot("khlim-assist")

  assert.equal(snapshot.project.id, "khlim-assist")
  assert.equal(snapshot.project.fullName, "Linardi1328/khlim-assist")
  assert.equal(snapshot.repository.fullName, "Linardi1328/khlim-assist")
  assert.equal(snapshot.recentCommits.length, 1)
  assert.equal(snapshot.openPullRequests.length, 1)
  assert.equal(snapshot.openIssues.length, 1)
  assert.equal(snapshot.retrievedAt, "2026-08-17T00:00:00.000Z")
  assert.equal(snapshot.source, GITHUB_READONLY_SOURCE)
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "GET", "GET"])
}

{
  const calls = []
  const client = createGitHubReadOnlyClient({ runner: makeFixtureRunner(calls) })

  await client.getRecentCommits("khlim-assist", 999)
  assert.equal(calls[0].queryParams.per_page, MAX_ITEM_LIMIT)

  await expectReadOnlyError(() => client.getOpenIssues("khlim-assist", 0), "INVALID_LIMIT")
  assert.equal(calls.length, 1, "invalid limits perform zero extra GitHub calls")
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => ({ stdout: "{not-json" })
  })

  await expectReadOnlyError(() => client.getRepoMetadata("khlim-assist"), "MALFORMED_GITHUB_RESPONSE")
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => ({ stdout: JSON.stringify({ not: "an array" }) })
  })

  await expectReadOnlyError(() => client.getRecentCommits("khlim-assist"), "MALFORMED_GITHUB_RESPONSE")
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => {
      const error = new Error("spawn gh ENOENT")
      error.code = "ENOENT"
      throw error
    }
  })

  await expectReadOnlyError(() => client.getRepoMetadata("khlim-assist"), "GITHUB_CLI_UNAVAILABLE")
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => {
      const error = new Error("HTTP 401: authentication required")
      throw error
    }
  })

  await expectReadOnlyError(() => client.getRepoMetadata("khlim-assist"), "GITHUB_CLI_UNAUTHENTICATED")
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => {
      const error = new Error("HTTP 404: Not Found")
      throw error
    }
  })

  await expectReadOnlyError(() => client.getRepoMetadata("khlim-assist"), "GITHUB_REPO_UNAVAILABLE")
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => {
      const error = new Error("HTTP 500: upstream failure")
      throw error
    }
  })

  await expectReadOnlyError(() => client.getRepoMetadata("khlim-assist"), "GITHUB_API_FAILED")
}

{
  const args = buildGhApiGetArgs("/repos/Linardi1328/khlim-assist/pulls", {
    state: "open",
    per_page: 5
  })

  assert.deepEqual(args, [
    "api",
    "--method",
    "GET",
    "/repos/Linardi1328/khlim-assist/pulls?state=open&per_page=5"
  ])
}

{
  const calls = []
  const runner = createGhApiGetRunner({
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options })
      callback(null, JSON.stringify({ ok: true }), "")
    }
  })

  const result = await runner({
    method: "GET",
    endpoint: "/repos/Linardi1328/khlim-assist",
    queryParams: {}
  })

  assert.equal(result.stdout, JSON.stringify({ ok: true }))
  assert.equal(calls[0].file, "gh")
  assert.deepEqual(calls[0].args, ["api", "--method", "GET", "/repos/Linardi1328/khlim-assist"])
  assert.equal(calls[0].options.shell, false)
}

{
  const runner = createGhApiGetRunner({
    execFileImpl: () => {
      throw new Error("execFile must not run for rejected methods")
    }
  })

  await expectReadOnlyError(
    () => runner({ method: "PATCH", endpoint: "/repos/Linardi1328/khlim-assist", queryParams: {} }),
    "UNSUPPORTED_METHOD"
  )
}

console.log("GitHub read-only tests passed: allowlist, GET-only transport, normalization, errors, and safety boundaries.")
