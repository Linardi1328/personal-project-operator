import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const PPO_COMMAND = resolve(ROOT, "local-operator/ppo-command.mjs");
const BRIDGE = resolve(ROOT, "openclaw/plugins/ppo-local/index.mjs");
const WORKFLOW = resolve(ROOT, ".github/workflows/ppo-pr-validation.yml");

const USER_FACING_ACCEPTANCE = Object.freeze([
  { surface: "/ppo status", suites: ["local-operator/github-ppo-status.test.mjs"] },
  { surface: "/ppo menu", suites: ["openclaw/plugins/ppo-local/test-bridge.mjs"] },
  { surface: "/ppo help", suites: ["openclaw/plugins/ppo-local/test-bridge.mjs"] },
  { surface: "/ppo repo <project>", suites: ["local-operator/github-ppo-commands.test.mjs"] },
  { surface: "/ppo pr <project>", suites: ["local-operator/github-ppo-commands.test.mjs"] },
  { surface: "/ppo codex <project> <task>", suites: ["local-operator/codex-prompt-generator.test.mjs"] },
  { surface: "/ppo codex-budget <project> <task>", suites: ["local-operator/codex-planning-tools.test.mjs"] },
  { surface: "/ppo prompt-size <draft>", suites: ["local-operator/codex-planning-tools.test.mjs"] },
  { surface: "/ppo split-task <task>", suites: ["local-operator/codex-planning-tools.test.mjs"] },
  { surface: "/ppo issue-create <project> <title> [--body <body>]", suites: ["local-operator/github-issue-approval.test.mjs"] },
  { surface: "/ppo issue-confirm <request-id>", suites: ["local-operator/github-issue-approval.test.mjs"] },
  { surface: "/ppo note-add <project> <note...>", suites: ["local-operator/project-note-approval.test.mjs"] },
  { surface: "/ppo note-confirm <request-id>", suites: ["local-operator/project-note-approval.test.mjs"] },
  { surface: "/ppo start <project>", suites: ["local-operator/development-start-route.test.mjs"] },
  { surface: "/ppo runs", suites: ["local-operator/development-run-catalog-route.test.mjs"] },
  { surface: "/ppo run <run-id>", suites: ["local-operator/development-run-catalog-route.test.mjs"] },
  { surface: "/ppo cancel <run-id>", suites: ["local-operator/development-run-cancellation-approval.test.mjs"] },
  { surface: "/ppo cancel-confirm <request-id>", suites: ["local-operator/development-run-cancellation-approval.test.mjs"] },
  { surface: "/ppo continue <run-id>", suites: ["local-operator/development-continue-orchestrator.test.mjs"] },
  { surface: "/ppo recover <run-id>", suites: ["local-operator/development-recovery-route.test.mjs"] },
  { surface: "terminal issue-create", suites: ["local-operator/github-issue-create.test.mjs"] },
  { surface: "terminal note-add", suites: ["local-operator/project-note-add.test.mjs"] },
  { surface: "terminal state-promote", suites: ["local-operator/project-state-promote.test.mjs"] }
]);

const PHASE_6_LIFECYCLE_SUITES = Object.freeze([
  "local-operator/development-run-state.test.mjs",
  "local-operator/development-next-stage-planner.test.mjs",
  "local-operator/development-workspace-manager.test.mjs",
  "local-operator/development-codex-execution-adapter.test.mjs",
  "local-operator/development-test-runner.test.mjs",
  "local-operator/development-review-agent.test.mjs",
  "local-operator/development-hardening-orchestrator.test.mjs",
  "local-operator/github-delivery-agent.test.mjs",
  "local-operator/development-deployment-agent.test.mjs",
  "local-operator/development-production-verification-agent.test.mjs",
  "local-operator/development-rollback-agent.test.mjs",
  "local-operator/development-continue-orchestrator.test.mjs",
  "local-operator/development-recovery-coordinator.test.mjs",
  "local-operator/development-recovery-route.test.mjs",
  "local-operator/development-run-catalog.test.mjs",
  "local-operator/development-run-catalog-route.test.mjs",
  "local-operator/development-run-cancellation.test.mjs",
  "local-operator/development-run-cancellation-approval.test.mjs"
]);

function workflowStep(workflow) {
  const start = workflow.indexOf("      - name: Phase 6Q integrated user acceptance");
  const end = workflow.indexOf("\n      - name:", start + 1);
  assert.notEqual(start, -1, "Phase 6Q CI step is missing");
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

test("Phase 6Q acceptance matrix covers every supported PPO and terminal user surface", async () => {
  const source = await readFile(PPO_COMMAND, "utf8");
  const supportedBlock = source.slice(source.indexOf("Supported Telegram messages:"), source.indexOf("Phase 5A boundary:"));

  const telegramSurfaces = USER_FACING_ACCEPTANCE.filter(({ surface }) => surface.startsWith("/ppo "));
  for (const { surface } of telegramSurfaces) {
    assert.match(supportedBlock, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\<[^>]+\\>/g, ".+"), "u"), surface);
  }

  assert.match(source, /Terminal-only additions:/u);
  assert.match(source, /state-promote <project> <note-id>/u);
  assert.equal(new Set(USER_FACING_ACCEPTANCE.map(({ surface }) => surface)).size, USER_FACING_ACCEPTANCE.length);
});

test("Phase 6Q acceptance references only existing dedicated test suites", async () => {
  const suites = new Set([
    ...USER_FACING_ACCEPTANCE.flatMap(({ suites }) => suites),
    ...PHASE_6_LIFECYCLE_SUITES,
    "openclaw/plugins/ppo-local/test-bridge.mjs"
  ]);

  await Promise.all([...suites].map((suite) => access(resolve(ROOT, suite))));
});

test("Phase 6Q CI gate executes every user-surface suite and every Phase 6 lifecycle suite", async () => {
  const workflow = await readFile(WORKFLOW, "utf8");
  const step = workflowStep(workflow);
  const required = new Set([
    ...USER_FACING_ACCEPTANCE.flatMap(({ suites }) => suites),
    ...PHASE_6_LIFECYCLE_SUITES,
    "openclaw/plugins/ppo-local/test-bridge.mjs"
  ]);

  for (const suite of required) {
    assert.match(step, new RegExp(suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"), suite);
  }
});

test("Phase 6Q CI remains non-production and does not run live deployment or rollback primitives", async () => {
  const workflow = await readFile(WORKFLOW, "utf8");
  const step = workflowStep(workflow);

  assert.doesNotMatch(step, /deploy-exact-sha\.sh|verify-production-readonly\.sh|rollback-exact-sha\.sh|systemctl|ssh\s|sudo\s|gh\s+pr\s+merge/u);
  assert.doesNotMatch(step, /PPO_GITHUB_WRITE_CONFIRM|PPO_NOTE_WRITE_CONFIRM|PPO_PROJECT_STATE_CONFIRM/u);
});

test("Phase 6Q keeps the OpenClaw bridge in the user-facing acceptance boundary", async () => {
  await access(BRIDGE);
  const workflow = await readFile(WORKFLOW, "utf8");
  assert.match(workflowStep(workflow), /openclaw\/plugins\/ppo-local\/test-bridge\.mjs/u);
});
