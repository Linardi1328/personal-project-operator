import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

for (const [input, expected] of [
  ["/ppo status", ["status"]],
  ["/ppo repo khlim-assist", ["repo", "khlim-assist"]],
  ["/ppo repo rbl-content-engine", ["repo", "rbl-content-engine"]],
  ["/ppo pr portfolio", ["pr", "portfolio"]],
  ["/ppo pr rbl-content-engine", ["pr", "rbl-content-engine"]],
  [`/ppo codex rbl-content-engine ${phase3cTask}`, ["codex", "rbl-content-engine", phase3cTask]],
  [`/ppo codex-budget khlim-assist ${phase3cTask}`, ["codex-budget", "khlim-assist", phase3cTask]],
  [`/ppo prompt-size ${multilineDraft}`, ["prompt-size", multilineDraft]],
  [`/ppo split-task ${phase3cTask}`, ["split-task", phase3cTask]]
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
  [`ppo split-task ${phase3cTask}`, ["split-task", phase3cTask]]
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

console.log("ppo_local bridge tests passed: existing commands, status/repo/pr routing, full payloads, and rejection safety.");
