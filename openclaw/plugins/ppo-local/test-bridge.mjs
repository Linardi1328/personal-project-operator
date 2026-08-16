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
  ["menu system", ["menu", "system"]]
]);

for (const [input, expected] of expectedMappings) {
  assert.deepEqual(toPpoWrapperArgs(input), expected, `${input} maps to approved wrapper argv`);
  const result = await runPpoLocalTool({ command: input });
  assert.equal(result.ok, true, `${input} succeeds`);
  assert.equal(result.exitCode, 0, `${input} exit code`);
  assert.deepEqual(result.wrapperArgs, expected, `${input} executed expected wrapper argv`);
  assert.equal(result.stdout, runWrapper(expected), `${input} returns exact wrapper output`);
}

const fullPayload = await runPpoLocalTool({ command: "/ppo menu project" });
assert.equal(fullPayload.ok, true, "full /ppo payload succeeds");
assert.deepEqual(fullPayload.wrapperArgs, ["menu", "project"]);
assert.equal(fullPayload.stdout, runWrapper(["menu", "project"]), "full /ppo payload returns exact wrapper output");

const rejectedInputs = [
  "/status",
  "unknown",
  "status && whoami",
  "status; touch /tmp/ppo-test",
  "$(whoami)",
  "`whoami`",
  "../../something"
];

for (const input of rejectedInputs) {
  assert.equal(toPpoWrapperArgs(input), null, `${input} rejected before execution`);
  const result = await runPpoLocalTool({ command: input });
  assert.equal(result.ok, false, `${input} fails safely`);
  assert.equal(result.exitCode, 1, `${input} failure exit code`);
  assert.deepEqual(result.wrapperArgs, [], `${input} does not call wrapper`);
  assert.match(result.stdout, /^Unsupported PPO tool input:/, `${input} returns safe unsupported text`);
}

console.log("ppo_local bridge tests passed: 7 accepted inputs, 7 rejected inputs.");
