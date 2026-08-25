import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import {
  MAX_TASK_CHARS,
  estimateTaskSize
} from "./codex-prompt-generator.mjs"
import {
  CodexPlanningError,
  MAX_PLANNING_OUTPUT_CHARS,
  MAX_PROMPT_DRAFT_CHARS,
  MAX_SPLIT_PHASES,
  createCodexBudget,
  detectTaskDomains,
  formatCodexPlanningError,
  handleCodexBudgetCommand,
  handlePromptSizeCommand,
  handleSplitTaskCommand,
  listPlanningProjectIds,
  normalizePromptDraftText,
  reviewPromptSize,
  splitTask
} from "./codex-planning-tools.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"

const unsafeTerminalControlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function assertBounded(output) {
  assert.equal(output.length <= MAX_PLANNING_OUTPUT_CHARS, true, "planning output is bounded")
}

function assertNoTerminalControls(output) {
  assert.equal(unsafeTerminalControlPattern.test(output), false, "unsafe terminal controls are removed")
  assert.doesNotMatch(output, /\u001B|\u009B/u)
}

function assertEstimate(output, label) {
  assert.match(output, new RegExp(`Estimate:\\n${escapeRegExp(label)}`))
}

function wrapper(args) {
  return spawnSync(process.execPath, ["local-operator/ppo-command.mjs", ...args], {
    encoding: "utf8"
  })
}

const allowedProjects = listPhase2GitHubProjects()
const allowedProjectIds = allowedProjects.map((project) => project.id)

assert.deepEqual(listPlanningProjectIds(), allowedProjectIds, "planning project ids reuse the connected registry")
assert.equal(allowedProjectIds.length, 6, "planning tools use the six connected projects")
assert.equal(allowedProjectIds.includes("rbl-content-engine"), true, "RBL Content Engine is connected for planning tools")
assert.equal(allowedProjectIds.includes("khlim-digital-ecosystem"), true, "KHLIM Super App is connected for planning tools")

for (const project of allowedProjects) {
  const output = createCodexBudget(project.id, "add provider validation tests")

  assert.match(output, /^Codex Budget Estimate/)
  assert.match(output, new RegExp(`Project:\\n${escapeRegExp(project.displayName)}`))
  assert.match(output, new RegExp(`Repository:\\n${escapeRegExp(`${project.owner}/${project.repo}`)}`))
  assert.match(output, /Evidence Boundary:/)
  assert.match(output, /Does not inspect arbitrary repository files\./)
  assert.match(output, /Does not estimate actual token cost\./)
  assert.match(output, /Does not inspect Codex account usage\./)
  assertBounded(output)
}

for (const [task, label] of [
  ["add validation tests", "Small"],
  ["add invoice import workflow", "Medium"],
  ["refactor backend and frontend architecture", "Large"],
  ["add GitHub integration, Telegram routing, VPS deployment, and write actions", "Too large - split required"]
]) {
  const output = createCodexBudget("ledgerpilot-ai", task)

  assertEstimate(output, label)
  assert.match(output, new RegExp(`Reason:\\n${escapeRegExp(estimateTaskSize(task).reason)}`))
  assert.equal(estimateTaskSize(task).label, label, "budget estimate matches Phase 3A estimator")
}

for (const projectId of [
  "unknown-project",
  "prooflab",
  "jom-jelajah",
  "Linardi1328/khlim-assist",
  "../../khlim-assist",
  ""
]) {
  const result = handleCodexBudgetCommand(projectId, "add tests")

  assert.equal(result.ok, false, `${projectId || "(empty)"} is rejected`)
  assert.match(result.output, /^Codex planning failed \[/)
  assert.doesNotMatch(result.output, /stack|SENSITIVE_TEST_SENTINEL/)
}

{
  const result = handleCodexBudgetCommand("khlim-assist", "")

  assert.equal(result.ok, false)
  assert.match(result.output, /\[INVALID_TASK\]/)
}

{
  const exactMaxTask = "x".repeat(MAX_TASK_CHARS)
  const output = createCodexBudget("khlim-assist", exactMaxTask)

  assert.match(output, new RegExp(`Task:\\n${exactMaxTask}`))
  assertBounded(output)
}

{
  const result = handleCodexBudgetCommand("khlim-assist", "x".repeat(MAX_TASK_CHARS + 1))

  assert.equal(result.ok, false)
  assert.match(result.output, /\[TASK_TOO_LARGE\]/)
}

{
  const task = "; rm -rf / $(whoami) `whoami` ../../etc/passwd"
  const output = createCodexBudget("khlim-assist", task)

  assert.match(output, new RegExp(`Task:\\n${escapeRegExp(task)}`))
  assertNoTerminalControls(output)
}

{
  const output = createCodexBudget("portfolio", "unicode café 東京 🚀")

  assert.match(output, /unicode café 東京 🚀/)
  assertNoTerminalControls(output)
}

{
  const output = createCodexBudget(
    "khlim-assist",
    "clean \u001B[2J terminal \u001B]0;pwned\u0007 controls \u0000 \u009B31m done"
  )

  assert.match(output, /Task:\nclean terminal controls done/)
  assert.doesNotMatch(output, /pwned|\[2J/)
  assertNoTerminalControls(output)
}

{
  assert.throws(
    () => normalizePromptDraftText(""),
    (error) => error instanceof CodexPlanningError && error.code === "INVALID_DRAFT"
  )

  const exactMaxDraft = "x".repeat(MAX_PROMPT_DRAFT_CHARS)
  assert.equal(normalizePromptDraftText(exactMaxDraft).length, MAX_PROMPT_DRAFT_CHARS)

  assert.throws(
    () => normalizePromptDraftText("x".repeat(MAX_PROMPT_DRAFT_CHARS + 1)),
    (error) => error instanceof CodexPlanningError && error.code === "DRAFT_TOO_LARGE"
  )
}

for (const [draft, label] of [
  ["Goal: fix typo.", "Compact"],
  [`Goal: ${"focused feature ".repeat(80)}`, "Acceptable"],
  [`Goal: ${"long context ".repeat(350)}`, "Long"],
  [
    "Goal: build the whole operator. Add GitHub integration. Add Telegram routing. Add VPS deployment. Add write actions.",
    "Too broad"
  ]
]) {
  const output = reviewPromptSize(draft)

  assertEstimate(output, label)
  assertBounded(output)
}

{
  const output = reviewPromptSize("one two\nthree")

  assert.match(output, /Characters:\n13/)
  assert.match(output, /Approx\. words:\n3/)
  assert.match(output, /Lines:\n2/)
}

{
  const output = reviewPromptSize([
    "Goal: x",
    "Goal: x",
    "",
    "",
    "",
    "- keep safety",
    "- keep safety",
    "- keep tests",
    "Safety: do not expose credentials",
    "Exit Criteria: NOT merged"
  ].join("\n"))

  assert.match(output, /Remove \/ Reduce:/)
  assert.match(output, /- repeated adjacent lines/)
  assert.match(output, /- repeated blank lines/)
  assert.doesNotMatch(output, /Goal: x\nGoal: x/)
  assert.doesNotMatch(output, /- keep safety\n- keep safety/)
  assert.match(output, /- keep safety\n- keep tests/)
  assert.doesNotMatch(output, /\n\n\n\n/)
  assert.match(output, /Safety: do not expose credentials/)
  assert.match(output, /Exit Criteria: NOT merged/)
  assert.match(output, /Did not paraphrase or invent requirements\./)
}

{
  const output = reviewPromptSize([
    "Scope:",
    "- keep safety",
    "  - preserve nested requirement",
    "Requirements:",
    "- keep safety",
    "  - preserve nested requirement",
    "Duplicate exact line",
    "Duplicate exact line"
  ].join("\n"))

  assert.match(output, /Preserved indentation, nested bullets, and repeated text under separate headings\./)
  assert.equal((output.match(/^- keep safety$/gm) || []).length, 2, "identical bullet text under different sections is preserved")
  assert.equal((output.match(/^  - preserve nested requirement$/gm) || []).length, 2, "nested indentation is preserved by compaction")
  assert.doesNotMatch(output, /Duplicate exact line\nDuplicate exact line/)
}

{
  const output = reviewPromptSize([
    "Scope:",
    "- parent",
    "  - nested item",
    "  - nested item",
    "- parent",
    "Requirements:",
    "- parent"
  ].join("\n"))

  assert.equal((output.match(/^  - nested item$/gm) || []).length, 1, "adjacent exact nested duplicate is removed")
  assert.equal((output.match(/^- parent$/gm) || []).length, 3, "non-adjacent or separate-heading duplicate bullets are preserved")
}

{
  const output = reviewPromptSize("Goal: keep café 東京\nGoal: keep café 東京")

  assert.match(output, /café 東京/)
  assertNoTerminalControls(output)
}

{
  const output = reviewPromptSize("Task: ; rm -rf /\nTask: ; rm -rf /\nUse $(whoami) and `whoami` as inert examples.")

  assert.match(output, /Task: ; rm -rf \//)
  assert.match(output, /\$\(whoami\)/)
  assert.match(output, /`whoami`/)
  assertNoTerminalControls(output)
}

{
  const output = reviewPromptSize("clear \u001B[2J keep\nclear \u001B[2J keep\nosc \u001B]0;pwned\u0007 safe\nc1 \u009B31m ok")

  assert.doesNotMatch(output, /\[2J|pwned/)
  assert.match(output, /clear\s+keep/)
  assert.match(output, /osc\s+safe/)
  assert.match(output, /c1\s+ok/)
  assertNoTerminalControls(output)
}

{
  const result = handlePromptSizeCommand("")

  assert.equal(result.ok, false)
  assert.match(result.output, /\[INVALID_DRAFT\]/)
}

{
  const output = reviewPromptSize("x".repeat(MAX_PROMPT_DRAFT_CHARS))

  assert.match(output, /Estimate:\nToo broad/)
  assert.match(output, /Compacted Draft:\nNo deterministic compaction needed\./)
  assertBounded(output)
}

{
  assert.throws(
    () => splitTask(""),
    (error) => error instanceof CodexPlanningError && error.code === "INVALID_TASK"
  )

  assert.throws(
    () => splitTask("x".repeat(MAX_TASK_CHARS + 1)),
    (error) => error instanceof CodexPlanningError && error.code === "TASK_TOO_LARGE"
  )
}

{
  const first = splitTask("add GitHub integration, Telegram bot, Codex prompt generator, VPS deployment, and write actions")
  const second = splitTask("add GitHub integration, Telegram bot, Codex prompt generator, VPS deployment, and write actions")

  assert.equal(first, second, "split output is deterministic")
}

{
  const output = splitTask("fix typo")

  assertEstimate(output, "Small")
  assert.match(output, /Split not required\./)
  assert.match(output, /1\. Implementation/)
  assertBounded(output)
}

{
  const output = splitTask("fix typo and push")

  assertEstimate(output, "Small")
  assert.match(output, /Permission-gated write-action design only\./)
  assert.match(output, /Current writes disabled in PPO\./)
  assert.match(output, /Separate explicit approval is required before any write/)
  assert.match(output, /Permission-gated write-action design/)
  assert.doesNotMatch(output, /^1\. Implementation$/m)
  assert.doesNotMatch(output, /approval to mutate|push now|merge now|write implementation/i)
  assertBounded(output)
}

{
  const output = splitTask("add invoice import workflow")

  assertEstimate(output, "Medium")
  assert.match(output, /Optional for this task\./)
  assertBounded(output)
}

{
  const output = splitTask("add invoice import workflow and create issue")

  assertEstimate(output, "Medium")
  assert.match(output, /Permission-gated write-action design only\./)
  assert.match(output, /Current writes disabled in PPO\./)
  assert.match(output, /Separate explicit approval is required before any write/)
  assert.match(output, /Permission-gated write-action design/)
  assert.doesNotMatch(output, /^1\. Focused implementation$/m)
  assert.doesNotMatch(output, /approval to mutate|create issue now|push now|merge now|write implementation/i)
  assertBounded(output)
}

for (const task of [
  "fix typo and open PR",
  "fix typo and create pull request",
  "fix typo and close issue",
  "fix typo and update PR",
  "fix typo and comment on pull request",
  "fix typo and label issue",
  "fix typo and delete branch",
  "fix typo and delete repo",
  "fix typo and commit"
]) {
  const output = splitTask(task)

  assertEstimate(output, "Small")
  assert.match(output, /Permission-gated write-action design only\./, `${task} is gated`)
  assert.match(output, /Current writes disabled in PPO\./, `${task} states current writes are disabled`)
  assert.match(output, /Separate explicit approval is required before any write/, `${task} requires separate approval`)
  assert.doesNotMatch(output, /^1\. Implementation$/m, `${task} does not use implementation workflow`)
  assert.doesNotMatch(output, /approval to mutate|write implementation|merge now|push now|commit now|delete now/i)
  assertBounded(output)
}

{
  const output = splitTask("refactor backend and frontend architecture")

  assertEstimate(output, "Large")
  assert.match(output, /Frontend\/UI/)
  assert.match(output, /Backend\/API/)
  assert.match(output, /\d+\. Hardening/)
  assert.match(output, /\d+\. Review/)
  assertBounded(output)
}

{
  const output = splitTask(
    "update docs, add GitHub repo integration, Telegram OpenClaw routing, Codex prompt tooling, frontend UI, backend API, database schema migration, VPS deployment, write actions, hardening tests, and security review"
  )

  assertEstimate(output, "Too large - split required")
  assert.match(output, /Permission-gated write-action design/)
  assert.match(output, /Current PPO writes are disabled|Current writes disabled in PPO/)
  assert.match(output, /separate explicit approval/)
  assert.equal((output.match(/^\d+\. Permission-gated write-action design$/gm) || []).length, 1, "write-action phase is preserved exactly once")
  assert.equal((output.match(/^\d+\. (?:Tests\/hardening\/security|Hardening)$/gm) || []).length, 1, "hardening phase is priority-reserved exactly once")
  assert.equal((output.match(/^\d+\. Review$/gm) || []).length, 1, "review phase is priority-reserved exactly once")
  assert.equal((output.match(/^\d+\. /gm) || []).length <= MAX_SPLIT_PHASES, true, "saturated split stays within phase bound")
  assertBounded(output)
}

{
  const output = splitTask("add GitHub integration, Telegram bot, Codex prompt generator, VPS deployment, and write actions")

  assertEstimate(output, "Too large - split required")
  assert.match(output, /Repository integration/)
  assert.match(output, /Telegram\/OpenClaw routing/)
  assert.match(output, /Codex prompt tooling/)
  assert.match(output, /Deployment planning/)
  assert.match(output, /Permission-gated write-action design/)
  assert.match(output, /Current PPO writes are disabled; this permission-gated work requires separate explicit approval/)
  assert.match(output, /\d+\. Hardening/)
  assert.match(output, /\d+\. Review/)
  assert.doesNotMatch(output, /Proceed with write|perform write|merge now|push now|approved to mutate/)
  assert.equal((output.match(/^\d+\. /gm) || []).length <= MAX_SPLIT_PHASES, true)
  assertBounded(output)
}

for (const [task, expectedKey] of [
  ["add GitHub integration", "github"],
  ["add Telegram OpenClaw routing", "telegram"],
  ["add Codex prompt tooling", "codex"],
  ["prepare VPS deployment plan", "deployment"]
]) {
  const keys = detectTaskDomains(task).map((domain) => domain.key)

  assert.deepEqual(keys, [expectedKey], `${expectedKey} domain detected only when supported`)
}

{
  const output = splitTask("add GitHub integration and Telegram routing with hardening tests and VPS deployment")

  assert.match(output, /Tests\/hardening\/security/)
  assert.equal((output.match(/Tests\/hardening\/security/g) || []).length, 1, "hardening phase is not duplicated")
  assert.match(output, /\d+\. Review/)
}

{
  const output = splitTask("add invoice import workflow")

  assert.doesNotMatch(output, /local-operator|\.mjs|src\/|projects\//)
}

{
  const task = "; rm -rf / $(whoami) `whoami` ../../etc/passwd"
  const output = splitTask(task)

  assert.match(output, new RegExp(`Original Task:\\n${escapeRegExp(task)}`))
  assertNoTerminalControls(output)
}

{
  const output = splitTask("unicode café 東京 🚀 \u001B[2J \u001B]0;pwned\u0007 \u0000 done")

  assert.match(output, /unicode café 東京 🚀 done/)
  assert.doesNotMatch(output, /pwned|\[2J/)
  assertNoTerminalControls(output)
}

{
  const result = handleSplitTaskCommand("")

  assert.equal(result.ok, false)
  assert.match(result.output, /\[INVALID_TASK\]/)
}

{
  const output = formatCodexPlanningError(new Error("SENSITIVE_TEST_SENTINEL raw failure"))

  assert.equal(output, "Codex planning failed:\nUnexpected local failure.")
  assert.doesNotMatch(output, /SENSITIVE_TEST_SENTINEL|raw failure/)
}

{
  const source = await readFile(new URL("./codex-planning-tools.mjs", import.meta.url), "utf8")

  assert.doesNotMatch(source, /child_process|execFile|execSync|spawn|eval\(|new Function|node:vm/)
  assert.doesNotMatch(source, /createGitHubReadOnlyClient|getRepoMetadata|getRecentCommits|getOpenPullRequests|getOpenIssues|getOpenIssuesPage|gh api/)
  assert.doesNotMatch(source, /OpenAI|ChatGPT|responses\.create|chat\.completions|invokeCodex|runCodex|executeCodex/)
}

{
  const exportedNames = Object.keys(await import("./codex-planning-tools.mjs")).sort()

  assert.equal(
    exportedNames.some((name) => /write|run|deploy|execute|spawn|commit|push|merge/i.test(name)),
    false,
    "planning module exports no write/run/deploy/execute capability"
  )
}

{
  const result = wrapper(["codex", "unknown-project", "add-tests"])

  assert.equal(result.status, 1)
  assert.match(result.stdout, /Codex prompt generation failed \[UNKNOWN_PROJECT\]/)
  assert.doesNotMatch(result.stdout, /Unsupported PPO command: codex/)
}

{
  const result = wrapper(["codex-budget", "ledgerpilot-ai", "add invoice import workflow"])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^Codex Budget Estimate/)
  assert.match(result.stdout, /Project:\nLedgerPilot AI/)
}

{
  const result = wrapper(["prompt-size", "Goal: build one focused feature"])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^Prompt Size Review/)
}

{
  const result = wrapper([
    "prompt-size",
    "Goal: keep line structure\nRequirements:\n- preserve newline one\n- preserve newline two\nExit Criteria: reviewed"
  ])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^Prompt Size Review/)
  assert.match(result.stdout, /Lines:\n5/)
}

{
  const result = wrapper(["split-task", "add GitHub integration and Telegram routing"])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^Task Split/)
}

{
  const result = wrapper(["/ppo codex unknown-project add-tests"])

  assert.equal(result.status, 1)
  assert.match(result.stdout, /Codex prompt generation failed \[UNKNOWN_PROJECT\]/)
  assert.doesNotMatch(result.stdout, /^Unsupported PPO command:/)
}

{
  const result = wrapper(["/ppo codex-budget khlim-assist add validation tests"])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^Codex Budget Estimate/)
  assert.match(result.stdout, /Project:\nKHLIM Assist/)
}

{
  const result = wrapper([
    "/ppo prompt-size Goal: keep line structure\nRequirements:\n- preserve newline one\n- preserve newline two\nExit Criteria: reviewed"
  ])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^Prompt Size Review/)
  assert.match(result.stdout, /Lines:\n5/)
}

{
  const result = wrapper(["/ppo split-task add GitHub integration and Telegram routing"])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^Task Split/)
  assert.doesNotMatch(result.stdout, /Keep arbitrary text routing behind separate review\./)
  assert.match(
    result.stdout,
    /Phase 3C routing is limited to the four approved text command envelopes; richer arbitrary-text workflows require separate review\./
  )
}

{
  const output = execFileSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "codex-budget",
    "khlim-assist",
    "add validation tests"
  ], { encoding: "utf8" })

  assert.match(output, /^Codex Budget Estimate/)
}

console.log("Codex planning tools tests passed: budget, prompt-size, split-task, terminal and Phase 3C PPO routing boundaries.")
