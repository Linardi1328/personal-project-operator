import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runPpoLocalTool, toPpoWrapperArgs } from "./bridge.mjs";
import { MAX_TASK_CHARS } from "../../../local-operator/codex-prompt-generator.mjs";
import { MAX_PROMPT_DRAFT_CHARS } from "../../../local-operator/codex-planning-tools.mjs";
import { listPhase2GitHubProjects } from "../../../local-operator/github-project-registry.mjs";

const runWrapper = (args) => execFileSync(process.execPath, ["local-operator/ppo-command.mjs", ...args], {
  encoding: "utf8"
});

const expectedMappings = new Map([
  ["status", ["status"]],
  ["menu", ["menu"]],
  ["help", ["help"]],
  ["menu project", ["menu", "project"]],
  ["menu codex", ["menu", "codex"]],
  ["menu system", ["menu", "system"]],
  ["repo khlim-assist", ["repo", "khlim-assist"]],
  ["repo ledgerpilot-ai", ["repo", "ledgerpilot-ai"]],
  ["repo spy-market-agent", ["repo", "spy-market-agent"]],
  ["repo portfolio", ["repo", "portfolio"]],
  ["repo rbl-content-engine", ["repo", "rbl-content-engine"]],
  ["pr khlim-assist", ["pr", "khlim-assist"]],
  ["pr ledgerpilot-ai", ["pr", "ledgerpilot-ai"]],
  ["pr spy-market-agent", ["pr", "spy-market-agent"]],
  ["pr portfolio", ["pr", "portfolio"]],
  ["pr rbl-content-engine", ["pr", "rbl-content-engine"]]
]);

const currentProjectIds = listPhase2GitHubProjects().map((project) => project.id);
const phase3cTask = "; rm -rf / $(whoami) `whoami` ../../etc/passwd café 東京";
const multilineDraft = "Goal: keep line structure\nRequirements:\n- preserve newline one\n- preserve newline two\nExit Criteria: reviewed";
const validIssueRequestId = "A".repeat(43);
const validNoteRequestId = "B".repeat(43);
const validDevelopmentRunId = "C".repeat(43);
const validCancellationRequestId = "D".repeat(43);

for (const projectId of currentProjectIds) {
  expectedMappings.set(
    `codex ${projectId} ${phase3cTask}`,
    ["codex", projectId, phase3cTask]
  );
  expectedMappings.set(
    `codex-budget ${projectId} ${phase3cTask}`,
    ["codex-budget", projectId, phase3cTask]
  );
}

expectedMappings.set(`prompt-size ${multilineDraft}`, ["prompt-size", multilineDraft]);
expectedMappings.set(`split-task ${phase3cTask}`, ["split-task", phase3cTask]);
expectedMappings.set("issue-create khlim-assist Add issue title", ["/ppo", "issue-create", "khlim-assist", "Add issue title"]);
expectedMappings.set("issue-create khlim-assist Add issue title --body Body text", ["/ppo", "issue-create", "khlim-assist", "Add issue title", "--body", "Body text"]);
expectedMappings.set(`issue-confirm ${validIssueRequestId}`, ["/ppo", "issue-confirm", validIssueRequestId]);
expectedMappings.set("note-add khlim-assist Add project note", ["/ppo", "note-add", "khlim-assist", "Add project note"]);
expectedMappings.set(`note-confirm ${validNoteRequestId}`, ["/ppo", "note-confirm", validNoteRequestId]);
expectedMappings.set("runs", ["runs"]);
expectedMappings.set(`run ${validDevelopmentRunId}`, ["run", validDevelopmentRunId]);
expectedMappings.set(`cancel ${validDevelopmentRunId}`, ["cancel", validDevelopmentRunId]);
expectedMappings.set(`cancel-confirm ${validCancellationRequestId}`, ["cancel-confirm", validCancellationRequestId]);
expectedMappings.set(`continue ${validDevelopmentRunId}`, ["continue", validDevelopmentRunId]);
expectedMappings.set(`recover ${validDevelopmentRunId}`, ["recover", validDevelopmentRunId]);

for (const [input, expected] of expectedMappings) {
  assert.deepEqual(toPpoWrapperArgs(input), expected, `${input} maps to approved wrapper argv`);
}

const localFixtureMappings = new Map([
  ["menu", ["menu"]],
  ["help", ["help"]],
  ["menu project", ["menu", "project"]],
  ["menu codex", ["menu", "codex"]],
  ["menu system", ["menu", "system"]]
]);

for (const [input, expected] of localFixtureMappings) {
  const result = await runPpoLocalTool({ command: input });
  assert.equal(result.ok, true, `${input} succeeds`);
  assert.equal(result.exitCode, 0, `${input} exit code`);
  assert.deepEqual(result.wrapperArgs, expected, `${input} executed expected wrapper argv`);
  assert.equal(result.stdout, runWrapper(expected), `${input} returns exact wrapper output`);
}

for (const [input, expected] of expectedMappings) {
  const result = await runPpoLocalTool(
    { command: input },
    {
      runWrapper: async (wrapperArgs) => ({
        stdout: `fake wrapper: ${wrapperArgs.join(" ")}\n`,
        stderr: ""
      })
    }
  );

  assert.equal(result.ok, true, `${input} fake wrapper succeeds`);
  assert.equal(result.exitCode, 0, `${input} fake wrapper exit code`);
  assert.deepEqual(result.wrapperArgs, expected, `${input} fake wrapper received expected argv`);
  assert.equal(result.stdout, `fake wrapper: ${expected.join(" ")}\n`);
}

const fullPayload = await runPpoLocalTool({ command: "/ppo menu project" });
assert.equal(fullPayload.ok, true, "full /ppo payload succeeds");
assert.deepEqual(fullPayload.wrapperArgs, ["menu", "project"]);
assert.equal(fullPayload.stdout, runWrapper(["menu", "project"]), "full /ppo payload returns exact wrapper output");

{
  const safeRunsOutput = [
    "PPO Development Runs",
    "Runs: 1",
    "Invalid: 0",
    "",
    `1. ${validDevelopmentRunId}`,
    "   Project: khlim-assist",
    "   Status: created",
    "   Stage: planning",
    "   Updated: 2026-08-22T00:00:00.000Z",
    ""
  ].join("\n");
  const result = await runPpoLocalTool(
    { command: "/ppo runs" },
    {
      runWrapper: async (wrapperArgs) => {
        assert.deepEqual(wrapperArgs, ["runs"]);
        return {
          stdout: safeRunsOutput,
          stderr: "SENSITIVE_TEST_SENTINEL raw runs stderr"
        };
      }
    }
  );

  assert.equal(result.ok, true, "runs output succeeds through bridge");
  assert.deepEqual(result.wrapperArgs, ["runs"]);
  assert.match(result.stdout, /PPO Development Runs/);
  assert.match(result.stdout, new RegExp(validDevelopmentRunId, "u"));
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|raw runs stderr|token|secret|stack/i);
}

{
  const safeRunOutput = [
    "PPO Development Run",
    `Run: ${validDevelopmentRunId}`,
    "Project: khlim-assist",
    "Status: created",
    "Stage: planning",
    "Version: 0",
    "Updated: 2026-08-22T00:00:00.000Z",
    "Canonical: canonical_current",
    ""
  ].join("\n");
  const result = await runPpoLocalTool(
    { command: `/ppo run ${validDevelopmentRunId}` },
    {
      runWrapper: async (wrapperArgs) => {
        assert.deepEqual(wrapperArgs, ["run", validDevelopmentRunId]);
        return {
          stdout: safeRunOutput,
          stderr: "SENSITIVE_TEST_SENTINEL raw run stderr"
        };
      }
    }
  );

  assert.equal(result.ok, true, "run output succeeds through bridge");
  assert.deepEqual(result.wrapperArgs, ["run", validDevelopmentRunId]);
  assert.match(result.stdout, /PPO Development Run/);
  assert.match(result.stdout, new RegExp(validDevelopmentRunId, "u"));
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|raw run stderr|token|secret|stack/i);
}

{
  const safeContinueOutput = [
    "PPO Development Continue",
    `Run: ${validDevelopmentRunId}`,
    "Project: khlim-assist",
    "Before: implementation_in_progress",
    "Action: phase-6d-codex-implementation",
    "Outcome: owner_action_required",
    "After: implementation_in_progress",
    "Head: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "Reason: codex_reconciliation_required",
    ""
  ].join("\n");
  const result = await runPpoLocalTool(
    { command: `/ppo continue ${validDevelopmentRunId}` },
    {
      runWrapper: async (wrapperArgs) => {
        assert.deepEqual(wrapperArgs, ["continue", validDevelopmentRunId]);
        return {
          stdout: safeContinueOutput,
          stderr: "SENSITIVE_TEST_SENTINEL raw continue stderr"
        };
      }
    }
  );

  assert.equal(result.ok, true, "continue output with reason succeeds through bridge");
  assert.deepEqual(result.wrapperArgs, ["continue", validDevelopmentRunId]);
  assert.match(result.stdout, /Reason: codex_reconciliation_required/);
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|raw continue stderr|token|secret|stack/i);
}

{
  const safeCancelOutput = [
    "PPO Development Run Cancellation",
    "Status: staged",
    `Run: ${validDevelopmentRunId}`,
    "Project: khlim-assist",
    "Before: created",
    "Version: 0",
    "Head: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    `Request: ${validCancellationRequestId}`,
    "Expires: 2026-08-24T00:10:00.000Z",
    `Confirm: /ppo cancel-confirm ${validCancellationRequestId}`,
    ""
  ].join("\n");
  const result = await runPpoLocalTool(
    { command: `/ppo cancel ${validDevelopmentRunId}` },
    {
      runWrapper: async (wrapperArgs) => {
        assert.deepEqual(wrapperArgs, ["cancel", validDevelopmentRunId]);
        return {
          stdout: safeCancelOutput,
          stderr: "SENSITIVE_TEST_SENTINEL raw cancel stderr"
        };
      }
    }
  );

  assert.equal(result.ok, true, "cancel output succeeds through bridge");
  assert.deepEqual(result.wrapperArgs, ["cancel", validDevelopmentRunId]);
  assert.match(result.stdout, /PPO Development Run Cancellation/);
  assert.match(result.stdout, /Status: staged/);
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|raw cancel stderr|token|secret|stack/i);
}

{
  const safeCancelConfirmOutput = [
    "PPO Development Run Cancellation",
    "Status: cancelled",
    `Run: ${validDevelopmentRunId}`,
    "Project: khlim-assist",
    "Before: created",
    "After: cancelled",
    "Version: 0 -> 1",
    "Head: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "Reason: owner_requested_quiescent_cancellation",
    ""
  ].join("\n");
  const result = await runPpoLocalTool(
    { command: `/ppo cancel-confirm ${validCancellationRequestId}` },
    {
      runWrapper: async (wrapperArgs) => {
        assert.deepEqual(wrapperArgs, ["cancel-confirm", validCancellationRequestId]);
        return {
          stdout: safeCancelConfirmOutput,
          stderr: "SENSITIVE_TEST_SENTINEL raw cancel-confirm stderr"
        };
      }
    }
  );

  assert.equal(result.ok, true, "cancel-confirm output succeeds through bridge");
  assert.deepEqual(result.wrapperArgs, ["cancel-confirm", validCancellationRequestId]);
  assert.match(result.stdout, /Status: cancelled/);
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|raw cancel-confirm stderr|token|secret|stack/i);
}

{
  const safeRecoverOutput = [
    "PPO Development Recovery",
    `Run: ${validDevelopmentRunId}`,
    "Project: khlim-assist",
    "Status: implementation_in_progress",
    "Phase: 6D",
    "Observation: codex_attempt_open",
    "Outcome: recovery_observed",
    "Owner action: required",
    ""
  ].join("\n");
  const result = await runPpoLocalTool(
    { command: `/ppo recover ${validDevelopmentRunId}` },
    {
      runWrapper: async (wrapperArgs) => {
        assert.deepEqual(wrapperArgs, ["recover", validDevelopmentRunId]);
        return {
          stdout: safeRecoverOutput,
          stderr: "SENSITIVE_TEST_SENTINEL raw recover stderr"
        };
      }
    }
  );

  assert.equal(result.ok, true, "recover output succeeds through bridge");
  assert.deepEqual(result.wrapperArgs, ["recover", validDevelopmentRunId]);
  assert.match(result.stdout, /PPO Development Recovery/);
  assert.match(result.stdout, /Observation: codex_attempt_open/);
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|raw recover stderr|token|secret|stack/i);
}

for (const [input, expected] of [
  ["/ppo status", ["status"]],
  ["/ppo repo khlim-assist", ["repo", "khlim-assist"]],
  ["/ppo repo rbl-content-engine", ["repo", "rbl-content-engine"]],
  ["/ppo pr portfolio", ["pr", "portfolio"]],
  ["/ppo pr rbl-content-engine", ["pr", "rbl-content-engine"]],
  [`/ppo codex rbl-content-engine ${phase3cTask}`, ["codex", "rbl-content-engine", phase3cTask]],
  [`/ppo codex-budget khlim-assist ${phase3cTask}`, ["codex-budget", "khlim-assist", phase3cTask]],
  [`/ppo prompt-size ${multilineDraft}`, ["prompt-size", multilineDraft]],
  [`/ppo split-task ${phase3cTask}`, ["split-task", phase3cTask]],
  ["/ppo issue-create khlim-assist Full payload title --body Full payload body", ["/ppo", "issue-create", "khlim-assist", "Full payload title", "--body", "Full payload body"]],
  [`/ppo issue-confirm ${validIssueRequestId}`, ["/ppo", "issue-confirm", validIssueRequestId]],
  ["/ppo note-add khlim-assist Full payload project note", ["/ppo", "note-add", "khlim-assist", "Full payload project note"]],
  [`/ppo note-confirm ${validNoteRequestId}`, ["/ppo", "note-confirm", validNoteRequestId]],
  ["/ppo runs", ["runs"]],
  [`/ppo run ${validDevelopmentRunId}`, ["run", validDevelopmentRunId]],
  [`/ppo cancel ${validDevelopmentRunId}`, ["cancel", validDevelopmentRunId]],
  [`/ppo cancel-confirm ${validCancellationRequestId}`, ["cancel-confirm", validCancellationRequestId]],
  [`/ppo continue ${validDevelopmentRunId}`, ["continue", validDevelopmentRunId]],
  [`/ppo recover ${validDevelopmentRunId}`, ["recover", validDevelopmentRunId]]
]) {
  const result = await runPpoLocalTool(
    { command: input },
    {
      runWrapper: async (wrapperArgs) => ({
        stdout: `fake wrapper: ${wrapperArgs.join(" ")}\n`,
        stderr: ""
      })
    }
  );

  assert.equal(result.ok, true, `${input} full payload succeeds`);
  assert.deepEqual(result.wrapperArgs, expected, `${input} full payload maps correctly`);
  assert.equal(result.stdout, `fake wrapper: ${expected.join(" ")}\n`);
}

for (const [input, expected] of [
  [`ppo codex portfolio ${phase3cTask}`, ["codex", "portfolio", phase3cTask]],
  [`ppo codex-budget rbl-content-engine ${phase3cTask}`, ["codex-budget", "rbl-content-engine", phase3cTask]],
  [`ppo prompt-size ${multilineDraft}`, ["prompt-size", multilineDraft]],
  [`ppo split-task ${phase3cTask}`, ["split-task", phase3cTask]],
  ["ppo runs", ["runs"]],
  [`ppo run ${validDevelopmentRunId}`, ["run", validDevelopmentRunId]],
  [`ppo cancel ${validDevelopmentRunId}`, ["cancel", validDevelopmentRunId]],
  [`ppo cancel-confirm ${validCancellationRequestId}`, ["cancel-confirm", validCancellationRequestId]],
  [`ppo continue ${validDevelopmentRunId}`, ["continue", validDevelopmentRunId]],
  [`ppo recover ${validDevelopmentRunId}`, ["recover", validDevelopmentRunId]]
]) {
  assert.deepEqual(toPpoWrapperArgs(input), expected, `${input} raw ppo envelope maps correctly`);
}

{
  const exactTask = "x".repeat(MAX_TASK_CHARS);
  const exactDraft = "y".repeat(MAX_PROMPT_DRAFT_CHARS);

  for (const [input, expected] of [
    [`codex khlim-assist ${exactTask}`, ["codex", "khlim-assist", exactTask]],
    [`/ppo codex-budget rbl-content-engine ${exactTask}`, ["codex-budget", "rbl-content-engine", exactTask]],
    [`split-task ${exactTask}`, ["split-task", exactTask]],
    [`/ppo prompt-size ${exactDraft}`, ["prompt-size", exactDraft]]
  ]) {
    assert.deepEqual(toPpoWrapperArgs(input), expected, `${expected[0]} accepts exact Phase 3C text bound`);

    const result = await runPpoLocalTool(
      { command: input },
      {
        runWrapper: async (wrapperArgs) => ({
          stdout: `bounded fake wrapper: ${wrapperArgs[0]}\n`,
          stderr: ""
        })
      }
    );

    assert.equal(result.ok, true, `${expected[0]} exact-bound input executes fake wrapper`);
    assert.deepEqual(result.wrapperArgs, expected, `${expected[0]} exact-bound argv is preserved`);
  }
}

for (const input of [
  `codex khlim-assist ${"x".repeat(MAX_TASK_CHARS + 1)}`,
  `/ppo codex-budget rbl-content-engine ${"x".repeat(MAX_TASK_CHARS + 1)}`,
  `split-task ${"x".repeat(MAX_TASK_CHARS + 1)}`,
  `/ppo prompt-size ${"y".repeat(MAX_PROMPT_DRAFT_CHARS + 1)}`
]) {
  assert.equal(toPpoWrapperArgs(input), null, `${input.slice(0, 24)}... rejects over-limit text before execution`);
  let wrapperCalls = 0;
  const result = await runPpoLocalTool(
    { command: input },
    {
      runWrapper: async () => {
        wrapperCalls += 1;
        return { stdout: "", stderr: "" };
      }
    }
  );

  assert.equal(result.ok, false, "over-limit input fails safely");
  assert.equal(result.exitCode, 1, "over-limit input uses safe failure exit code");
  assert.deepEqual(result.wrapperArgs, [], "over-limit input has no wrapper argv");
  assert.equal(wrapperCalls, 0, "over-limit input executes zero wrapper calls");
}

{
  const safeStdout = "PPO GitHub read-only error [GITHUB_CLI_UNAUTHENTICATED]: Safe auth message.\n";
  const result = await runPpoLocalTool(
    { command: "repo khlim-assist" },
    {
      runWrapper: async () => {
        const error = new Error("wrapper exited 1");
        error.code = 1;
        error.stdout = safeStdout;
        error.stderr = "SENSITIVE_TEST_SENTINEL raw gh stderr";
        throw error;
      }
    }
  );

  assert.equal(result.ok, false, "non-zero wrapper exit is returned, not thrown");
  assert.equal(result.exitCode, 1, "non-zero wrapper exit code is preserved");
  assert.equal(result.stdout, safeStdout, "safe wrapper stdout is returned");
  assert.equal(result.stderr, "", "raw wrapper stderr is not surfaced");
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|raw gh stderr/);
}

{
  const safeStdout = "Codex planning failed [INVALID_DRAFT]: Prompt draft text is required. Use: prompt-size <draft>.\n";
  const result = await runPpoLocalTool(
    { command: "prompt-size safe draft" },
    {
      runWrapper: async () => {
        const error = new Error("wrapper exited 1");
        error.code = 1;
        error.stdout = safeStdout;
        error.stderr = "SENSITIVE_TEST_SENTINEL raw planning stderr";
        throw error;
      }
    }
  );

  assert.equal(result.ok, false, "non-zero planning wrapper exit is returned, not thrown");
  assert.equal(result.exitCode, 1, "non-zero planning wrapper exit code is preserved");
  assert.equal(result.stdout, safeStdout, "safe planning wrapper stdout is returned");
  assert.equal(result.stderr, "", "raw planning wrapper stderr is not surfaced");
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|raw planning stderr/);
}

{
  const result = await runPpoLocalTool(
    { command: "repo khlim-assist" },
    {
      runWrapper: async () => {
        const error = new Error("SENSITIVE_TEST_SENTINEL spawn failure");
        error.code = "ENOENT";
        error.stderr = "SENSITIVE_TEST_SENTINEL raw spawn stderr";
        throw error;
      }
    }
  );

  assert.equal(result.ok, false, "unexpected execution failure is returned safely");
  assert.equal(result.exitCode, 1, "unexpected execution failure uses generic exit code");
  assert.equal(result.stdout, "PPO local wrapper failed: unexpected local failure.\n");
  assert.equal(result.stderr, "", "unexpected stderr is not surfaced");
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|spawn failure|raw spawn stderr/);
}

{
  const result = await runPpoLocalTool(
    { command: "repo khlim-assist" },
    {
      runWrapper: async () => {
        throw {
          message: "SENSITIVE_TEST_SENTINEL malformed failure",
          stderr: "SENSITIVE_TEST_SENTINEL"
        };
      }
    }
  );

  assert.equal(result.ok, false, "malformed execution failure is returned safely");
  assert.equal(result.stdout, "PPO local wrapper failed: unexpected local failure.\n");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_SENTINEL|malformed failure/);
}

const rejectedInputs = [
  "/status",
  "unknown",
  "status extra",
  "status khlim-assist",
  "status && whoami",
  "status; touch /tmp/ppo-test",
  "codex",
  "/ppo codex",
  "codex khlim-assist",
  "/ppo codex khlim-assist",
  "codex unknown add-validation",
  "/ppo codex unknown add-validation",
  "codex prooflab add-validation",
  "codex jom-jelajah add-validation",
  "codex KHLIM-assist add-validation",
  "codex Linardi1328/khlim-assist add-validation",
  "codex ../../khlim-assist add-validation",
  "codex-budget",
  "/ppo codex-budget",
  "codex-budget khlim-assist",
  "/ppo codex-budget khlim-assist",
  "codex-budget unknown add-tests",
  "/ppo codex-budget unknown add-tests",
  "codex-budget prooflab add-tests",
  "codex-budget jom-jelajah add-tests",
  "codex-budget KHLIM-assist add-tests",
  "codex-budget Linardi1328/khlim-assist add-tests",
  "codex-budget ../../khlim-assist add-tests",
  "prompt-size",
  "/ppo prompt-size",
  "split-task",
  "/ppo split-task",
  "repo",
  "pr",
  "repo unknown",
  "pr unknown",
  "repo prooflab",
  "pr prooflab",
  "repo jom-jelajah",
  "pr jom-jelajah",
  "repo KHLIM-assist",
  "repo Linardi1328/khlim-assist",
  "repo khlim-assist extra",
  "repo khlim-assist && whoami",
  "repo khlim-assist; whoami",
  "repo ../../khlim-assist",
  "issue-create",
  "issue-create unknown Title",
  "issue-create khlim-assist",
  "issue-create khlim-assist Title --body",
  "issue-create khlim-assist Title PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist SENSITIVE_TEST_SENTINEL",
  "issue-confirm",
  "issue-confirm short-id",
  `issue-confirm ${validIssueRequestId} extra`,
  "note-add",
  "note-add unknown project note",
  "note-add khlim-assist",
  "note-add khlim-assist bad\u001B[31m note",
  "note-add khlim-assist PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist SENSITIVE_TEST_SENTINEL",
  "note-confirm",
  "note-confirm short-id",
  `note-confirm ${validNoteRequestId} extra`,
  "runs extra",
  "/ppo runs extra",
  "ppo runs extra",
  "runs\t",
  "runs\n",
  "runs\u0000",
  "run",
  "/ppo run",
  "ppo run",
  "run malformed",
  "/ppo run malformed",
  "run " + "E".repeat(42),
  "run " + "E".repeat(44),
  `run ${validDevelopmentRunId} extra`,
  `/ppo run ${validDevelopmentRunId} extra`,
  `ppo run ${validDevelopmentRunId} extra`,
  `run  ${validDevelopmentRunId}`,
  `run ${validDevelopmentRunId} `,
  ` run ${validDevelopmentRunId}`,
  `run ${validDevelopmentRunId}\nanything`,
  `run ${validDevelopmentRunId}\ranything`,
  `run ${validDevelopmentRunId}\tanything`,
  `run ${validDevelopmentRunId}\u0000`,
  `/ppo run ${validDevelopmentRunId} --project khlim-assist`,
  `/ppo run ${validDevelopmentRunId} --status created`,
  `/ppo run ${validDevelopmentRunId} --expectedVersion 0`,
  `/ppo run ${validDevelopmentRunId} ${"d".repeat(40)}`,
  "/ppo run-status",
  "/ppo list-runs",
  "/ppo runs-all",
  "/ppo run-search",
  "cancel",
  "/ppo cancel",
  "ppo cancel",
  "cancel malformed",
  "/ppo cancel malformed",
  "cancel " + "E".repeat(42),
  "cancel " + "E".repeat(44),
  `cancel ${validDevelopmentRunId} extra`,
  `/ppo cancel ${validDevelopmentRunId} extra`,
  `ppo cancel ${validDevelopmentRunId} extra`,
  `cancel  ${validDevelopmentRunId}`,
  `cancel ${validDevelopmentRunId} `,
  ` cancel ${validDevelopmentRunId}`,
  `cancel ${validDevelopmentRunId}\nanything`,
  `cancel ${validDevelopmentRunId}\ranything`,
  `cancel ${validDevelopmentRunId}\tanything`,
  `cancel ${validDevelopmentRunId}\u0000`,
  `/ppo cancel ${validDevelopmentRunId} --force`,
  `/ppo cancel ${validDevelopmentRunId} --cleanup`,
  `/ppo cancel ${validDevelopmentRunId} --project khlim-assist`,
  `/ppo cancel ${validDevelopmentRunId} --expectedVersion 0`,
  "cancel-confirm",
  "/ppo cancel-confirm",
  "ppo cancel-confirm",
  "cancel-confirm malformed",
  "/ppo cancel-confirm malformed",
  "cancel-confirm " + "E".repeat(42),
  "cancel-confirm " + "E".repeat(44),
  `cancel-confirm ${validCancellationRequestId} extra`,
  `/ppo cancel-confirm ${validCancellationRequestId} extra`,
  `ppo cancel-confirm ${validCancellationRequestId} extra`,
  `cancel-confirm  ${validCancellationRequestId}`,
  `cancel-confirm ${validCancellationRequestId} `,
  ` cancel-confirm ${validCancellationRequestId}`,
  `cancel-confirm ${validCancellationRequestId}\nanything`,
  `cancel-confirm ${validCancellationRequestId}\ranything`,
  `cancel-confirm ${validCancellationRequestId}\tanything`,
  `cancel-confirm ${validCancellationRequestId}\u0000`,
  `/ppo cancel-confirm ${validCancellationRequestId} --retry`,
  `/ppo stop ${validDevelopmentRunId}`,
  `/ppo abort ${validDevelopmentRunId}`,
  `/ppo kill ${validDevelopmentRunId}`,
  `/ppo run-cancel ${validDevelopmentRunId}`,
  `/ppo cancel-run ${validDevelopmentRunId}`,
  `/ppo cancel-force ${validDevelopmentRunId}`,
  "continue",
  "/ppo continue",
  "continue malformed",
  "/ppo continue malformed",
  `continue\n${validDevelopmentRunId}`,
  `/ppo continue\n${validDevelopmentRunId}`,
  `ppo continue\n${validDevelopmentRunId}`,
  `continue ${validDevelopmentRunId}\n`,
  `/ppo continue ${validDevelopmentRunId}\r\n`,
  `/ppo\ncontinue ${validDevelopmentRunId}`,
  "continue ../...",
  "/ppo continue khlim-assist",
  `/ppo continue ${validDevelopmentRunId} extra`,
  `/ppo continue ${validDevelopmentRunId}\nanything`,
  `/ppo continue ${validDevelopmentRunId} --action merge`,
  `/ppo continue ${validDevelopmentRunId} ${"d".repeat(40)}`,
  "recover",
  "/ppo recover",
  "recover malformed",
  "/ppo recover malformed",
  "recover " + "E".repeat(42),
  "recover " + "E".repeat(44),
  `recover\n${validDevelopmentRunId}`,
  `/ppo recover\n${validDevelopmentRunId}`,
  `ppo recover\n${validDevelopmentRunId}`,
  `recover ${validDevelopmentRunId}\n`,
  `/ppo recover ${validDevelopmentRunId}\r\n`,
  `/ppo recover\t${validDevelopmentRunId}`,
  `/ppo\nrecover ${validDevelopmentRunId}`,
  "recover ../...",
  "/ppo recover khlim-assist",
  `/ppo recover ${validDevelopmentRunId} extra`,
  `/ppo recover ${validDevelopmentRunId}\nanything`,
  `/ppo recover ${validDevelopmentRunId} --expectedVersion 7`,
  `/ppo recover ${validDevelopmentRunId} --project khlim-assist`,
  `/ppo recover ${validDevelopmentRunId} --status review_passed`,
  `/ppo recover ${validDevelopmentRunId} --action merge`,
  `/ppo recover ${validDevelopmentRunId} ${"d".repeat(40)}`,
  `/ppo recovery ${validDevelopmentRunId}`,
  `/ppo reconcile ${validDevelopmentRunId}`,
  `/ppo repair ${validDevelopmentRunId}`,
  `/ppo retry ${validDevelopmentRunId}`,
  `/ppo resume ${validDevelopmentRunId}`,
  "$(whoami)",
  "`whoami`",
  "../../something"
];

for (const input of rejectedInputs) {
  assert.equal(toPpoWrapperArgs(input), null, `${input} rejected before execution`);
  let wrapperCalls = 0;
  const result = await runPpoLocalTool({ command: input });
  assert.equal(result.ok, false, `${input} fails safely`);
  assert.equal(result.exitCode, 1, `${input} failure exit code`);
  assert.deepEqual(result.wrapperArgs, [], `${input} does not call wrapper`);
  assert.match(result.stdout, /^Unsupported PPO tool input:/, `${input} returns safe unsupported text`);
  assert.doesNotMatch(result.stdout, /PPO_(?:GITHUB|NOTE)_WRITE_CONFIRM|SENSITIVE_TEST_SENTINEL|create-issue:khlim-assist|add-note:khlim-assist/);

  const fakeResult = await runPpoLocalTool(
    { command: input },
    {
      runWrapper: async () => {
        wrapperCalls += 1;
        return { stdout: "", stderr: "" };
      }
    }
  );

  assert.equal(fakeResult.ok, false, `${input} fake wrapper fails safely`);
  assert.equal(wrapperCalls, 0, `${input} executes zero fake wrapper calls`);
}

const bridgeSource = await readFile(new URL("bridge.mjs", import.meta.url), "utf8");
assert.equal(bridgeSource.includes("shell: false"), true, "bridge wrapper execution keeps shell disabled");

console.log("ppo_local bridge tests passed: existing commands, status/repo/pr routing, full payloads, and rejection safety.");
