import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runPpoLocalTool, toPpoWrapperArgs } from "./bridge.mjs";

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
  ["pr khlim-assist", ["pr", "khlim-assist"]],
  ["pr ledgerpilot-ai", ["pr", "ledgerpilot-ai"]],
  ["pr spy-market-agent", ["pr", "spy-market-agent"]],
  ["pr portfolio", ["pr", "portfolio"]]
]);

for (const [input, expected] of expectedMappings) {
  assert.deepEqual(toPpoWrapperArgs(input), expected, `${input} maps to approved wrapper argv`);
}

const localFixtureMappings = new Map([
  ["status", ["status"]],
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
  ["/ppo repo khlim-assist", ["repo", "khlim-assist"]],
  ["/ppo pr portfolio", ["pr", "portfolio"]]
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

const rejectedInputs = [
  "/status",
  "unknown",
  "status && whoami",
  "status; touch /tmp/ppo-test",
  "repo",
  "pr",
  "repo unknown",
  "pr unknown",
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

console.log("ppo_local bridge tests passed: existing commands, repo/pr routing, full payloads, and rejection safety.");
