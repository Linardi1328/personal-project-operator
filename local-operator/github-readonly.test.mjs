import assert from "node:assert/strict"
import {
  GITHUB_READONLY_SOURCE,
  GitHubReadOnlyError,
  MAX_ITEM_LIMIT,
  buildGhApiGetArgs,
  createGhApiGetRunner,
  createGitHubReadOnlyClient,
  listAllowedProjects,
  resolveProject,
  sanitizeGitHubText
} from "./github-readonly.mjs"

const allowedProjectIds = ["khlim-assist", "ledgerpilot-ai", "spy-market-agent", "portfolio", "rbl-content-engine"]
const unsafeTerminalControlPattern = /[\u0000-\u001F\u007F-\u009F]/u

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

function makeIssuePayload(number) {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    labels: [{ name: "bug" }],
    updated_at: "2026-08-16T14:00:00Z",
    html_url: `https://github.com/Linardi1328/khlim-assist/issues/${number}`
  }
}

function makeIssuePullRequestPayload(number) {
  return {
    number,
    title: `Pull request ${number}`,
    pull_request: {
      url: `https://api.github.com/repos/Linardi1328/khlim-assist/pulls/${number}`
    },
    state: "open",
    labels: [],
    updated_at: "2026-08-16T13:00:00Z",
    html_url: `https://github.com/Linardi1328/khlim-assist/pull/${number}`
  }
}

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

function assertNoUnsafeTerminalControls(value, label = "value") {
  if (typeof value === "string") {
    assert.equal(unsafeTerminalControlPattern.test(value), false, `${label} has no terminal control characters`)
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeTerminalControls(item, `${label}[${index}]`))
    return
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertNoUnsafeTerminalControls(item, `${label}.${key}`)
    }
  }
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

  await expectReadOnlyError(() => client.getRepoMetadata(input), input === null || input === "" ? "INVALID_PROJECT" : "UNKNOWN_PROJECT")
  assert.equal(calls.length, 0, `${String(input)} performs zero GitHub calls`)
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
  const client = createGitHubReadOnlyClient({
    runner: async (request) => {
      calls.push({
        method: request.method,
        endpoint: request.endpoint,
        queryParams: { ...request.queryParams }
      })

      assert.equal(request.method, "GET")

      return {
        stdout: JSON.stringify({
          ...repoPayload,
          full_name: "Linardi1328/rbl-content-engine",
          description: "RBL content workflow engine",
          html_url: "https://github.com/Linardi1328/rbl-content-engine"
        })
      }
    }
  })
  const metadata = await client.getRepoMetadata("rbl-content-engine")

  assert.equal(metadata.fullName, "Linardi1328/rbl-content-engine")
  assert.equal(metadata.description, "RBL content workflow engine")
  assert.deepEqual(calls[0], {
    method: "GET",
    endpoint: "/repos/Linardi1328/rbl-content-engine",
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
    runner: async (request) => {
      calls.push(request)
      return {
        stdout: JSON.stringify([
          makeIssuePayload(1),
          makeIssuePayload(2),
          makeIssuePullRequestPayload(3),
          makeIssuePayload(4),
          makeIssuePullRequestPayload(5)
        ])
      }
    }
  })
  const page = await client.getOpenIssuesPage("khlim-assist", 5)

  assert.equal(page.issues.length, 3)
  assert.deepEqual(page.issues.map((issue) => issue.number), [1, 2, 4])
  assert.equal(page.pageLimit, 5)
  assert.equal(page.rawReturnedCount, 5)
  assert.equal(page.limitHit, true)
  assert.equal(calls[0].method, "GET")
  assert.equal(calls[0].endpoint, "/repos/Linardi1328/khlim-assist/issues")
  assert.deepEqual(calls[0].queryParams, { state: "open", per_page: 5 })
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => ({
      stdout: JSON.stringify([
        makeIssuePayload(1),
        makeIssuePayload(2),
        makeIssuePullRequestPayload(3),
        makeIssuePayload(4)
      ])
    })
  })
  const page = await client.getOpenIssuesPage("khlim-assist", 5)

  assert.equal(page.issues.length, 3)
  assert.deepEqual(page.issues.map((issue) => issue.number), [1, 2, 4])
  assert.equal(page.rawReturnedCount, 4)
  assert.equal(page.limitHit, false)
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => ({
      stdout: JSON.stringify([
        makeIssuePullRequestPayload(1),
        makeIssuePullRequestPayload(2),
        makeIssuePullRequestPayload(3),
        makeIssuePullRequestPayload(4),
        makeIssuePullRequestPayload(5)
      ])
    })
  })
  const page = await client.getOpenIssuesPage("khlim-assist", 5)

  assert.equal(page.issues.length, 0)
  assert.equal(page.rawReturnedCount, 5)
  assert.equal(page.limitHit, true)
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => ({
      stdout: JSON.stringify([
        makeIssuePayload(1),
        makeIssuePullRequestPayload(2)
      ])
    })
  })
  const issues = await client.getOpenIssues("khlim-assist", 5)

  assert.equal(Array.isArray(issues), true)
  assert.deepEqual(issues.map((issue) => issue.number), [1])
  assert.equal(Object.hasOwn(issues, "issues"), false)
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
  const dangerousText = "\u001B[31mDanger\u001B[0m\nSecond\rThird\tTabbed\u0000\u009B31m café 東京"
  const sanitizedText = sanitizeGitHubText(dangerousText)

  assert.equal(sanitizedText, "Danger Second Third Tabbed café 東京")
  assertNoUnsafeTerminalControls(sanitizedText, "sanitizedText")

  const client = createGitHubReadOnlyClient({
    runner: async (request) => {
      assert.equal(request.method, "GET")

      if (request.endpoint.endsWith("/commits")) {
        return {
          stdout: JSON.stringify([
            {
              sha: "abcdef1\u001B[31m234567890\u001B[0m",
              commit: {
                message: "Commit café 東京\u001B[31m red\u001B[0m\nInjected line",
                author: {
                  name: dangerousText,
                  date: "2026-08-16T12:00:00Z\u0007"
                }
              },
              html_url: "https://github.com/Linardi1328/khlim-assist/commit/abcdef1\u001B[0m"
            }
          ])
        }
      }

      if (request.endpoint.endsWith("/pulls")) {
        return {
          stdout: JSON.stringify([
            {
              number: 8,
              title: dangerousText,
              head: {
                ref: "feature/read\u001B[31m-state\u001B[0m"
              },
              base: {
                ref: "main\rshadow"
              },
              draft: false,
              updated_at: "2026-08-16T13:00:00Z\u0000",
              html_url: "https://github.com/Linardi1328/khlim-assist/pull/8\u001B[0m"
            }
          ])
        }
      }

      if (request.endpoint.endsWith("/issues")) {
        return {
          stdout: JSON.stringify([
            {
              number: 4,
              title: dangerousText,
              state: "open\u001B[31m",
              labels: [{ name: "docs\nnext" }, "phase\t2", "\u001B[31mred\u001B[0m" ],
              updated_at: "2026-08-16T14:00:00Z\u009B31m",
              html_url: "https://github.com/Linardi1328/khlim-assist/issues/4\u001B[0m"
            }
          ])
        }
      }

      return {
        stdout: JSON.stringify({
          ...repoPayload,
          default_branch: "main\rshadow",
          visibility: "private\u001B[0m",
          description: dangerousText,
          updated_at: "2026-08-16T10:00:00Z\u0000",
          pushed_at: "2026-08-16T11:00:00Z\u0007",
          html_url: "https://github.com/Linardi1328/khlim-assist\u001B[0m"
        })
      }
    },
    now: () => new Date("2026-08-17T00:00:00.000Z")
  })
  const snapshot = await client.getProjectSnapshot("khlim-assist")

  assertNoUnsafeTerminalControls(snapshot, "snapshot")
  assert.equal(snapshot.repository.description, "Danger Second Third Tabbed café 東京")
  assert.equal(snapshot.repository.defaultBranch, "main shadow")
  assert.equal(snapshot.recentCommits[0].message, "Commit café 東京 red")
  assert.equal(snapshot.recentCommits[0].author, "Danger Second Third Tabbed café 東京")
  assert.equal(snapshot.openPullRequests[0].title, "Danger Second Third Tabbed café 東京")
  assert.equal(snapshot.openPullRequests[0].baseRef, "main shadow")
  assert.deepEqual(snapshot.openIssues[0].labels, ["docs next", "phase 2", "red"])
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

for (const malformedRepoPayload of [
  [],
  null,
  "not an object"
]) {
  const client = createGitHubReadOnlyClient({
    runner: async () => ({ stdout: JSON.stringify(malformedRepoPayload) })
  })

  await expectReadOnlyError(() => client.getRepoMetadata("khlim-assist"), "MALFORMED_GITHUB_RESPONSE")
}

{
  const client = createGitHubReadOnlyClient({
    runner: async () => ({ stdout: JSON.stringify({ ...repoPayload, full_name: "octocat/Hello-World" }) })
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

for (const endpoint of [
  "/user",
  "/repos/octocat/Hello-World",
  "/repos/Linardi1328/khlim-assist/hooks",
  "/repos/Linardi1328/khlim-assist/actions/secrets",
  "/orgs/Linardi1328"
]) {
  const calls = []
  const runner = createGhApiGetRunner({
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options })
      callback(null, JSON.stringify({ ok: true }), "")
    }
  })

  await expectReadOnlyError(
    () => runner({ method: "GET", endpoint, queryParams: {} }),
    "UNSUPPORTED_ENDPOINT"
  )
  assert.equal(calls.length, 0, `${endpoint} performs zero gh calls`)
}

for (const request of [
  {
    endpoint: "/repos/Linardi1328/khlim-assist?per_page=1",
    queryParams: {}
  },
  {
    endpoint: "/repos/Linardi1328/khlim-assist/commits",
    queryParams: { per_page: 999 }
  },
  {
    endpoint: "/repos/Linardi1328/khlim-assist/pulls",
    queryParams: { state: "closed", per_page: 5 }
  }
]) {
  const calls = []
  const runner = createGhApiGetRunner({
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options })
      callback(null, JSON.stringify({ ok: true }), "")
    }
  })

  await expectReadOnlyError(
    () => runner({ method: "GET", ...request }),
    "UNSUPPORTED_ENDPOINT"
  )
  assert.equal(calls.length, 0, `${request.endpoint} with rejected query performs zero gh calls`)
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
