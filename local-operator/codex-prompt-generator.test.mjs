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
const unsafeTerminalControlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u

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

function makeDocLoader({ calls = [], markdown = projectDoc } = {}) {
  return async (project) => {
    calls.push(project.id)
    return markdown
  }
}

async function makePrompt(projectId, task, config = {}) {
  const client = makeClient(config.client)
  const docCalls = []
  const output = await generateCodexPrompt(projectId, task, {
    client,
    loadProjectDocument: makeDocLoader({ calls: docCalls, markdown: config.projectDoc })
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

function assertMandatoryPromptSections(output) {
  for (const heading of [
    "Task Size Estimate",
    "Goal",
    "Scope",
    "Requirements",
    "Tests / Checks",
    "Safety Boundaries",
    "Exit Criteria"
  ]) {
    assertSection(output, heading)
  }

  assert.match(output, /^Codex Prompt/)
  assert.match(output, /\nProject:\n/)
  assert.match(output, /\nRepository:\n/)
  assert.match(output, /\nTask:\n/)
}

function makeBigProjectDoc() {
  const long = "This project context sentence is intentionally long but deterministic. ".repeat(20)

  return `
# Big Project

## Connection status

${long}

## Current role

${long}

## OpenClaw priority

${long}

## Current phase

${long}

## Next action

${long}

## Codex fit

${long}

## Do not change

- ${long}

## Known risks

- ${long}
`
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
  assertMandatoryPromptSections(output)

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
  const maxTask = "x".repeat(MAX_TASK_CHARS)
  const { output } = await makePrompt("khlim-assist", maxTask)

  assert.match(output, new RegExp(`Task:\\n${maxTask}`))
  assertMandatoryPromptSections(output)
  assert.equal(output.length <= MAX_GENERATED_PROMPT_CHARS, true, "max task output is bounded")
}

{
  const { output } = await makePrompt("khlim-assist", "add provider validation tests", {
    client: {
      commits: [
        {
          shortSha: "abc1234",
          message: "long commit message ".repeat(400)
        }
      ]
    }
  })

  assert.match(output, /- Latest commit: abc1234 long commit message/)
  assert.doesNotMatch(output, new RegExp("long commit message ".repeat(50)))
  assertMandatoryPromptSections(output)
  assert.equal(output.length <= MAX_GENERATED_PROMPT_CHARS, true, "long commit output is bounded")
}

{
  const { output } = await makePrompt("khlim-assist", "add provider validation tests", {
    projectDoc: makeBigProjectDoc()
  })

  assert.match(output, /Curated project documentation \(may be stale\):/)
  assertMandatoryPromptSections(output)
  assert.equal(output.length <= MAX_GENERATED_PROMPT_CHARS, true, "large doc context output is bounded")
}

{
  const maxTask = "x".repeat(MAX_TASK_CHARS)
  const { output } = await makePrompt("khlim-assist", maxTask, {
    projectDoc: makeBigProjectDoc(),
    client: {
      defaultBranch: "feature/" + "very-long-branch-name-".repeat(80),
      commits: [
        {
          shortSha: "abc1234",
          message: "worst case commit message ".repeat(400)
        }
      ],
      pullRequests: Array.from({ length: 5 }, (_value, index) => ({ number: index + 1 })),
      openIssuesPage: {
        issues: Array.from({ length: 5 }, (_value, index) => ({ number: index + 1 })),
        pageLimit: 5,
        rawReturnedCount: 5,
        limitHit: true
      }
    }
  })

  assert.match(output, new RegExp(`Task:\\n${maxTask}`))
  assert.match(output, /- Exact work requested: see Task section above\./)
  assert.match(output, /- Open PRs: 5\+/)
  assert.match(output, /- Open issues: 5\+/)
  assertMandatoryPromptSections(output)
  assert.equal(output.length <= MAX_GENERATED_PROMPT_CHARS, true, "combined worst-case output is bounded")
}

{
  const { output } = await makePrompt(
    "khlim-assist",
    "add GitHub integration, Telegram routing, VPS deployment, and write actions"
  )

  assert.match(output, /Task Size Estimate:\nToo large - split required/)
  assert.match(output, /Suggested action: split before implementation\./)
  assert.match(output, /Plan a safe split for KHLIM Assist before implementation\./)
  assertMandatoryPromptSections(output)
  assert.equal(output.length <= MAX_GENERATED_PROMPT_CHARS, true, "too-large guidance remains bounded")
}

{
  const { output } = await makePrompt(
    "khlim-digital-ecosystem",
    "Review the repository and propose one small next development task"
  )

  assert.match(output, /Produce the requested analysis or proposal for KHLIM Super App without modifying the repository\./)
  assert.match(output, /Keep this response read-only; do not edit files or create repository changes\./)
  assert.match(output, /Do not create a branch, commit, pull request, or issue\./)
  assert.match(output, /No repository changes were made\./)
  assert.doesNotMatch(output, /Implement the requested task|Work on a dedicated branch|Branch pushed and ready for review/)
}

{
  const { output } = await makePrompt(
    "khlim-assist",
    "Review the provider validation and implement the focused fix"
  )

  assert.match(output, /Implement the requested task for KHLIM Assist\./)
  assert.match(output, /Work on a dedicated branch\./)
  assert.doesNotMatch(output, /Keep this response read-only/)
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
  const { output } = await makePrompt("khlim-assist", "clear \u001B[2J keep")

  assert.match(output, /Task:\nclear keep/)
  assert.doesNotMatch(output, /\u001B|\[2J/)
  assert.equal(unsafeTerminalControlPattern.test(output), false, "ANSI controls are removed")
}

{
  const { output } = await makePrompt("khlim-assist", "title \u001B]0;pwned\u0007 safe")

  assert.match(output, /Task:\ntitle safe/)
  assert.doesNotMatch(output, /\u001B|\u0007|pwned/)
  assert.equal(unsafeTerminalControlPattern.test(output), false, "OSC controls are removed")
}

{
  const { output } = await makePrompt("khlim-assist", "unicode café 東京 \u0000\tline \u009B31m ok")

  assert.match(output, /Task:\nunicode café 東京 line ok/)
  assert.equal(unsafeTerminalControlPattern.test(output), false, "C0/C1 controls are removed")
  assert.match(output, /café 東京/)
}

{
  const { output } = await makePrompt("portfolio", "harden contact form error handling")

  assert.match(output, /Task Size Estimate:\nSmall/)
  assertSection(output, "Hardening Emphasis")
  assert.match(output, /malformed inputs, abuse cases, and safe error handling/)
  assert.match(output, /secret, raw stderr, or environment-value leakage/)
}

{
  const client = makeClient()
  const output = await generateCodexPrompt("rbl-content-engine", "organize source asset workflow", {
    client
  })

  assert.match(output, /^Codex Prompt/)
  assert.match(output, /Project:\nRBL Content Engine/)
  assert.match(output, /Repository:\nLinardi1328\/rbl-content-engine/)
  assert.match(output, /Task:\norganize source asset workflow/)
  assert.match(output, /research organization, scripts, source handling, asset planning/)
  assert.deepEqual(client.calls, [
    ["getRepoMetadata", "rbl-content-engine"],
    ["getRecentCommits", "rbl-content-engine", 1],
    ["getOpenPullRequests", "rbl-content-engine", 5],
    ["getOpenIssuesPage", "rbl-content-engine", 5]
  ])
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
  "jom-jelajah",
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
    }),
    (error) => {
      if (rejectedProjectId === "prooflab" || rejectedProjectId === "jom-jelajah") {
        assert.equal(error.code, "UNKNOWN_PROJECT", `${rejectedProjectId} is rejected as unknown`)
      }

      return true
    }
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
