import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  CodexPromptError,
  MAX_GENERATED_PROMPT_CHARS,
  MAX_TASK_CHARS,
  estimateTaskSize,
  extractProjectDocContext,
  generateCodexPrompt,
  handleCodexPromptCommand
} from "./codex-prompt-generator.mjs"
import { GitHubReadOnlyError, listAllowedProjects } from "./github-readonly.mjs"

const allowedProjects = listAllowedProjects()
const allowedProjectIds = allowedProjects.map((project) => project.id)

const projectDoc = `
# Test Project

## Project

Test Project

## Repo

\`Linardi1328/test-project\`

## Connection status

Connected candidate.

## Current role

Important project role.

## Current phase

Phase 3A testing.

## Next action

Add focused prompt generation tests.

## Codex fit

Good fit for small and medium prompts.

## Do not change

- Do not add credentials.
- Do not deploy automatically.

## Known risks

- Keep boundaries explicit.
`

function makeClient(config = {}) {
  const calls = []

  return {
    calls,

    async getRepoMetadata(projectId) {
      calls.push(["getRepoMetadata", projectId])
      if (config.failure) {
        throw config.failure
      }
      const project = allowedProjects.find((candidate) => candidate.id === projectId)

      return {
        fullName: project.fullName,
        defaultBranch: config.defaultBranch || "main",
        updatedAt: `2026-08-17T0${allowedProjectIds.indexOf(projectId)}:00:00Z`
      }
    },

    async getRecentCommits(projectId, limit) {
      calls.push(["getRecentCommits", projectId, limit])
      if (config.failure) {
        throw config.failure
      }

      return config.commits || [
        {
          shortSha: "abc1234",
          message: "Latest safe commit"
        },
        {
          shortSha: "def5678",
          message: "Second commit should not be printed"
        }
      ]
    },

    async getOpenPullRequests(projectId, limit) {
      calls.push(["getOpenPullRequests", projectId, limit])
      if (config.failure) {
        throw config.failure
      }

      return config.pullRequests || []
    },

    async getOpenIssuesPage(projectId, limit) {
      calls.push(["getOpenIssuesPage", projectId, limit])
      if (config.failure) {
        throw config.failure
      }

      return config.openIssuesPage || {
        issues: [],
        pageLimit: limit,
        rawReturnedCount: 0,
        limitHit: false
      }
    }
  }
}

function makeDocLoader({ calls = [] } = {}) {
  return async (project) => {
    calls.push(project.id)
    return projectDoc
  }
}

async function makePrompt(projectId, task, config = {}) {
  const client = makeClient(config.client)
  const docCalls = []
  const output = await generateCodexPrompt(projectId, task, {
    client,
    loadProjectDocument: makeDocLoader({ calls: docCalls })
  })

  return {
    output,
    client,
    docCalls
  }
}

function assertSection(output, heading) {
  assert.match(output, new RegExp(`\\n${heading}:\\n`), `${heading} section exists`)
}

{
  const context = extractProjectDocContext(projectDoc)

  assert.deepEqual(context.slice(0, 3), [
    "Documentation status: Connected candidate.",
    "Current role: Important project role.",
    "Current phase: Phase 3A testing."
  ])
  assert.equal(context.some((line) => line.includes("Do not add credentials")), true)
  assert.equal(context.some((line) => line.includes("deploy automatically")), false, "only bounded first safety note is extracted")
}

{
  for (const project of allowedProjects) {
    const { output, client, docCalls } = await makePrompt(project.id, "add provider validation tests")

    assert.match(output, /^Codex Prompt/)
    assert.match(output, new RegExp(`Project:\\n${project.displayName}`))
    assert.match(output, new RegExp(`Repository:\\n${project.fullName.replace("/", "\\/")}`))
    assert.match(output, /Task:\nadd provider validation tests/)
    assert.deepEqual(docCalls, [project.id])
    assert.deepEqual(client.calls, [
      ["getRepoMetadata", project.id],
      ["getRecentCommits", project.id, 1],
      ["getOpenPullRequests", project.id, 5],
      ["getOpenIssuesPage", project.id, 5]
    ])
  }
}

{
  const first = await makePrompt("khlim-assist", "add provider validation tests")
  const second = await makePrompt("khlim-assist", "add provider validation tests")

  assert.equal(first.output, second.output, "output is deterministic for same inputs")
}

{
  const { output } = await makePrompt("khlim-assist", "add provider validation tests", {
    client: {
      pullRequests: [],
      openIssuesPage: {
        issues: [{ number: 1 }, { number: 2 }],
        pageLimit: 5,
        rawReturnedCount: 5,
        limitHit: true
      }
    }
  })

  for (const heading of [
    "Goal",
    "Context",
    "Scope",
    "Requirements",
    "Tests / Checks",
    "Safety Boundaries",
    "Exit Criteria"
  ]) {
    assertSection(output, heading)
  }

  assert.match(output, /Curated project documentation \(may be stale\):/)
  assert.match(output, /Live GitHub read-only facts \(GitHub read-only\):/)
  assert.match(output, /- Latest commit: abc1234 Latest safe commit/)
  assert.doesNotMatch(output, /Second commit should not be printed/)
  assert.match(output, /- Open PRs: none/)
  assert.match(output, /- Open issues: 2\+/)
}

{
  const { output } = await makePrompt("portfolio", "add contact form confirmation", {
    client: {
      pullRequests: [{ number: 1 }, { number: 2 }],
      openIssuesPage: {
        issues: [{ number: 1 }],
        pageLimit: 5,
        rawReturnedCount: 1,
        limitHit: false
      }
    }
  })

  assert.match(output, /- Open PRs: 2/)
  assert.match(output, /- Open issues: 1/)
}

{
  assert.equal(estimateTaskSize("docs update").label, "Small")
  assert.equal(estimateTaskSize("add user settings feature").label, "Medium")
  assert.equal(estimateTaskSize("refactor backend and frontend architecture").label, "Large")
  assert.equal(
    estimateTaskSize("add GitHub integration, Telegram routing, VPS deployment, and write actions").label,
    "Too large - split required"
  )
}

{
  const { output } = await makePrompt("portfolio", "harden contact form error handling")

  assert.match(output, /Task Size Estimate:\nSmall/)
  assertSection(output, "Hardening Emphasis")
  assert.match(output, /malformed inputs, abuse cases, and safe error handling/)
  assert.match(output, /secret, raw stderr, or environment-value leakage/)
}

{
  await assert.rejects(
    () => generateCodexPrompt("khlim-assist", "", {
      client: makeClient(),
      loadProjectDocument: makeDocLoader()
    }),
    (error) => error instanceof CodexPromptError && error.code === "INVALID_TASK"
  )

  await assert.rejects(
    () => generateCodexPrompt("khlim-assist", "x".repeat(MAX_TASK_CHARS + 1), {
      client: makeClient(),
      loadProjectDocument: makeDocLoader()
    }),
    (error) => error instanceof CodexPromptError && error.code === "TASK_TOO_LARGE"
  )
}

for (const rejectedProjectId of [
  "unknown-project",
  "prooflab",
  "Linardi1328/khlim-assist",
  "../../khlim-assist",
  ""
]) {
  const client = makeClient()
  const docCalls = []

  await assert.rejects(
    () => generateCodexPrompt(rejectedProjectId, "add tests", {
      client,
      loadProjectDocument: makeDocLoader({ calls: docCalls })
    })
  )
  assert.equal(client.calls.length, 0, `${rejectedProjectId} performs zero GitHub reads`)
  assert.equal(docCalls.length, 0, `${rejectedProjectId} performs zero project doc reads`)
}

for (const task of [
  "; rm -rf /",
  "$(whoami)",
  "`whoami`",
  "../../etc/passwd"
]) {
  const { output, client, docCalls } = await makePrompt("khlim-assist", task)

  assert.match(output, new RegExp(`Task:\\n${task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  assert.equal(client.calls.length, 4, "malicious-looking task text is data, not a command")
  assert.deepEqual(docCalls, ["khlim-assist"], "task text is not used as a filesystem path")
}

{
  const gitHubError = new GitHubReadOnlyError("GITHUB_CLI_UNAUTHENTICATED", "Safe auth message.")
  gitHubError.stderr = "SENSITIVE_TEST_SENTINEL raw gh stderr"
  const result = await handleCodexPromptCommand("khlim-assist", "add tests", {
    client: makeClient({ failure: gitHubError }),
    loadProjectDocument: makeDocLoader()
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /Codex prompt generation failed \[GITHUB_CLI_UNAUTHENTICATED\]: Safe auth message\./)
  assert.doesNotMatch(result.output, /SENSITIVE_TEST_SENTINEL|raw gh stderr/)
}

{
  const result = await handleCodexPromptCommand("khlim-assist", "add tests", {
    client: makeClient({ failure: new Error("SENSITIVE_TEST_SENTINEL unexpected failure") }),
    loadProjectDocument: makeDocLoader()
  })

  assert.equal(result.ok, false)
  assert.equal(result.output, "Codex prompt generation failed:\nUnexpected local failure.")
  assert.doesNotMatch(result.output, /SENSITIVE_TEST_SENTINEL|unexpected failure/)
}

{
  const { output } = await makePrompt("khlim-assist", "add provider validation tests")

  assert.equal(output.length <= MAX_GENERATED_PROMPT_CHARS, true, "generated output is bounded")
}

{
  const source = await readFile(new URL("./codex-prompt-generator.mjs", import.meta.url), "utf8")

  assert.doesNotMatch(source, /child_process|execFile|execSync|spawn|eval\(|new Function|node:vm/)
}

{
  const exportedNames = Object.keys(await import("./codex-prompt-generator.mjs")).sort()

  assert.equal(exportedNames.some((name) => /write|runCodex|executeCodex|invokeCodex|openPr|createIssue|deploy/i.test(name)), false)
}

console.log("Codex prompt generator tests passed: deterministic text prompts, safe inputs, size estimates, and terminal-only boundaries.")
