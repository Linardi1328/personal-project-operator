#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { handleCodexPromptCommand } from "./codex-prompt-generator.mjs";
import {
  handleCodexBudgetCommand,
  handlePromptSizeCommand,
  handleSplitTaskCommand
} from "./codex-planning-tools.mjs";
import {
  handlePpoIssueConfirmCommand,
  handlePpoIssueCreateApprovalCommand
} from "./github-issue-approval.mjs";
import { handleGitHubIssueCreateCommand } from "./github-issue-create.mjs";
import { handleGitHubPpoCommand } from "./github-ppo-commands.mjs";
import { handleGitHubPpoStatus } from "./github-ppo-status.mjs";

const execFileAsync = promisify(execFile);
const simulatorPath = fileURLToPath(new URL("simulate-command.mjs", import.meta.url));

function normalizeArgs(rawArgs) {
  const args = rawArgs
    .flatMap((arg) => arg.trim().split(/\s+/))
    .filter(Boolean);

  if (args[0]?.toLowerCase() === "/ppo" || args[0]?.toLowerCase() === "ppo") {
    return args.slice(1);
  }

  return args;
}

function terminalArgsAfterCommand(rawArgs, command) {
  const firstArg = String(rawArgs[0] ?? "");
  const trimmedFirstArg = firstArg.trim();
  const lowerFirstArg = trimmedFirstArg.toLowerCase();

  if (lowerFirstArg === command) {
    return rawArgs.slice(1);
  }

  if (lowerFirstArg.startsWith(`${command} `)) {
    return [trimmedFirstArg.slice(command.length).trimStart(), ...rawArgs.slice(1)];
  }

  return rawArgs.slice(1);
}

function splitFirstToken(value) {
  const match = String(value || "").match(/^(\S+)(?:[\t\n\r ]+([\s\S]*))?$/u);

  if (!match) {
    return null;
  }

  return {
    token: match[1],
    rest: match[2] ?? ""
  };
}

function commandTextFromRawArgs(rawArgs) {
  return rawArgs.map((arg) => String(arg)).join(" ");
}

function unwrapPpoEnvelope(rawArgs) {
  const trimmed = commandTextFromRawArgs(rawArgs).trim();

  if (!trimmed) {
    return null;
  }

  const first = splitFirstToken(trimmed);

  if (!first) {
    return null;
  }

  const firstToken = first.token.toLowerCase();

  if (firstToken === "/ppo" || firstToken === "ppo") {
    const rest = first.rest.trimStart();
    return rest ? rest : null;
  }

  return trimmed;
}

function isPpoEnvelope(rawArgs) {
  const trimmed = commandTextFromRawArgs(rawArgs).trim();

  if (!trimmed) {
    return false;
  }

  const first = splitFirstToken(trimmed);
  const firstToken = first?.token.toLowerCase();

  return firstToken === "/ppo" || firstToken === "ppo";
}

function payloadAfterCommand(rawArgs, command) {
  const unwrapped = unwrapPpoEnvelope(rawArgs);
  const commandEnvelope = splitFirstToken(unwrapped);

  if (!commandEnvelope || commandEnvelope.token.toLowerCase() !== command) {
    return null;
  }

  return commandEnvelope.rest;
}

function projectPayloadArgs(rawArgs, command) {
  const rest = payloadAfterCommand(rawArgs, command);
  const projectEnvelope = splitFirstToken(String(rest ?? "").trimStart());

  if (!projectEnvelope) {
    return null;
  }

  const payload = projectEnvelope.rest.trim();

  return payload ? [projectEnvelope.token, payload] : null;
}

function textPayloadArgs(rawArgs, command) {
  const rest = payloadAfterCommand(rawArgs, command);

  if (rest === null) {
    return null;
  }

  const payload = rest.trim();

  return payload ? [payload] : null;
}

function issueCreateTerminalArgs(rawArgs) {
  const firstArg = String(rawArgs[0] ?? "");
  const trimmedFirstArg = firstArg.trim();

  if (trimmedFirstArg.toLowerCase() === "issue-create") {
    return rawArgs.slice(1).map((arg) => String(arg));
  }

  if (trimmedFirstArg.toLowerCase().startsWith("issue-create ")) {
    const rest = trimmedFirstArg.slice("issue-create".length).trimStart();
    const projectEnvelope = splitFirstToken(rest);

    if (!projectEnvelope) {
      return [];
    }

    const titleEnvelope = splitFirstToken(projectEnvelope.rest.trimStart());

    if (!titleEnvelope) {
      return [projectEnvelope.token];
    }

    const body = titleEnvelope.rest.trim();
    const parsed = body
      ? [projectEnvelope.token, titleEnvelope.token, body]
      : [projectEnvelope.token, titleEnvelope.token];

    return [...parsed, ...rawArgs.slice(1).map((arg) => String(arg))];
  }

  return rawArgs.slice(1).map((arg) => String(arg));
}

function usage() {
  return [
    "Personal Project Operator PPO Wrapper",
    "",
    "Use this wrapper for approved /ppo routing, local deterministic text commands, and approval-gated issue creation.",
    "",
    "Terminal usage:",
    "  node local-operator/ppo-command.mjs status",
    "  node local-operator/ppo-command.mjs menu",
    "  node local-operator/ppo-command.mjs menu project",
    "  node local-operator/ppo-command.mjs menu codex",
    "  node local-operator/ppo-command.mjs menu system",
    "  node local-operator/ppo-command.mjs help",
    "  node local-operator/ppo-command.mjs repo khlim-assist",
    "  node local-operator/ppo-command.mjs pr khlim-assist",
    "  node local-operator/ppo-command.mjs issue-create khlim-assist \"issue title\" \"optional body\"",
    "  node local-operator/ppo-command.mjs codex khlim-assist \"add provider validation tests\"",
    "  node local-operator/ppo-command.mjs codex-budget ledgerpilot-ai \"add invoice import workflow\"",
    "  node local-operator/ppo-command.mjs prompt-size \"Goal: build one focused feature\"",
    "  node local-operator/ppo-command.mjs split-task \"add GitHub integration and Telegram routing\"",
    "",
    "Telegram/OpenClaw message shape:",
    "  node local-operator/ppo-command.mjs \"/ppo status\"",
    "  node local-operator/ppo-command.mjs \"/ppo codex khlim-assist add provider validation tests\"",
    "  node local-operator/ppo-command.mjs \"/ppo codex-budget ledgerpilot-ai add invoice import workflow\"",
    "  node local-operator/ppo-command.mjs \"/ppo prompt-size Goal: build one focused feature\"",
    "  node local-operator/ppo-command.mjs \"/ppo split-task add GitHub integration and Telegram routing\"",
    "  node local-operator/ppo-command.mjs \"/ppo issue-create khlim-assist issue title --body optional body\"",
    "  node local-operator/ppo-command.mjs \"/ppo issue-confirm <request-id>\"",
    "",
    "Supported Telegram messages:",
    "  /ppo status",
    "  /ppo menu",
    "  /ppo menu project",
    "  /ppo menu codex",
    "  /ppo menu system",
    "  /ppo help",
    "  /ppo repo <project>",
    "  /ppo pr <project>",
    "  /ppo codex <project> <task>",
    "  /ppo codex-budget <project> <task>",
    "  /ppo prompt-size <draft>",
    "  /ppo split-task <task>",
    "  /ppo issue-create <project> <title> [--body <body>]",
    "  /ppo issue-confirm <request-id>",
    "",
    "Phase 5A boundary: terminal issue-create requires PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>.",
    "Phase 5B boundary: /ppo issue-create only stages a pending request; /ppo issue-confirm performs the approved single-use write."
  ].join("\n");
}

function unsupported(command) {
  const commandLabel = command || "(missing)";
  return [
    `Unsupported PPO command: ${commandLabel}`,
    "",
    "Phase 5B supports only:",
    "- /ppo status",
    "- /ppo menu",
    "- /ppo menu project",
    "- /ppo menu codex",
    "- /ppo menu system",
    "- /ppo help",
    "- /ppo repo <project>",
    "- /ppo pr <project>",
    "- /ppo codex <project> <task>",
    "- /ppo codex-budget <project> <task>",
    "- /ppo prompt-size <draft>",
    "- /ppo split-task <task>",
    "- /ppo issue-create <project> <title> [--body <body>]",
    "- /ppo issue-confirm <request-id>",
    "",
    "Phase 5A terminal-only addition:",
    "- issue-create <project> <title> [body...]",
    "",
    "Try: node local-operator/ppo-command.mjs menu"
  ].join("\n");
}

function toSimulatorArgs(command, args) {
  if (command === "menu") {
    return ["/menu", ...args.slice(0, 1)];
  }

  if (command === "help") {
    return ["/help"];
  }

  return null;
}

function applyPpoNamespace(output) {
  const adapted = output
    .replaceAll(
      "node local-operator/simulate-command.mjs /status",
      "node local-operator/ppo-command.mjs status"
    )
    .replaceAll(
      "node local-operator/simulate-command.mjs /help",
      "node local-operator/ppo-command.mjs help"
    )
    .replace(
      "Use this local simulator to test phone-style command output before OpenClaw routes real chat messages.",
      "Use this PPO wrapper to test phone-style command output before OpenClaw routes real chat messages."
    )
    .replace(
      /node local-operator\/simulate-command\.mjs \/menu( [a-z]+)?/g,
      (_match, category = "") => `node local-operator/ppo-command.mjs menu${category}`
    )
    .replace(
      "Phase 1 runnable commands are marked [local]. Future commands are documented but not active.",
      "Phase 1.5 runnable PPO commands are marked [local]. Future commands are documented but not active."
    )
    .replace(
      "Phase: Phase 1 - Local OpenClaw Test foundation",
      "Phase: Phase 1.5 - OpenClaw Telegram routing preparation"
    )
    .replaceAll("Phase 1 local command output test", "Phase 1.5 local PPO routing test")
    .replaceAll("Phase 1 boundary", "Phase 1.5 boundary")
    .replace("Supported locally in Phase 1:", "Supported locally through /ppo in Phase 1.5:");

  const namespaced = adapted.replace(/(^|\s)\/([a-z][a-z-]*)(?=\s|$)/g, (match, prefix, command) => {
    if (command === "ppo") {
      return match;
    }

    return `${prefix}/ppo ${command}`;
  });

  return namespaced
    .replace(
      "Phase 1.5 runnable PPO commands are marked [local]. Future commands are documented but not active.",
      "Phase 2B runnable PPO commands are marked [local] or [github read-only]. Future commands are documented but not active."
    )
    .replace(
      "Phase 2B runnable PPO commands are marked [local] or [github read-only]. Future commands are documented but not active.",
      "Phase 2C runnable PPO commands are marked [local] or [github read-only]. Future commands are documented but not active."
    )
    .replace(
      "Phase 2C runnable PPO commands are marked [local] or [github read-only]. Future commands are documented but not active.",
      "Phase 3A PPO-routed commands are marked [local] or [github read-only]. Terminal codex generation is local-only."
    )
    .replace(
      "Phase 3A PPO-routed commands are marked [local] or [github read-only]. Terminal codex generation is local-only.",
      "Phase 3B PPO-routed commands are marked [local] or [github read-only]. Terminal Codex prompt/planning commands are local-only."
    )
    .replace(
      "Phase 3B PPO-routed commands are marked [local] or [github read-only]. Terminal Codex prompt/planning commands are local-only.",
      "Phase 5B PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, and approval-gated issue creation."
    )
    .replace(
      "- /ppo status - Show all active projects and next actions. [local]",
      "- /ppo status - Show live GitHub project status. [github read-only]"
    )
    .replace(
      "- /ppo repo <project> - Summarize a project repository. [future]",
      "- /ppo repo <project> - Summarize a project repository. [github read-only]"
    )
    .replace(
      "- /ppo pr <project> - Summarize latest project PR state. [future]",
      "- /ppo pr <project> - Summarize latest project PR state. [github read-only]"
    )
    .replace(
      "Phase 1.5 boundary: no live APIs, no secrets, no writes.",
      "Phase 2B boundary: /ppo status/menu/help remain local fixture-backed; /ppo repo and /ppo pr use GitHub read-only; no writes."
    )
    .replace(
      "Phase 2B boundary: /ppo status/menu/help remain local fixture-backed; /ppo repo and /ppo pr use GitHub read-only; no writes.",
      "Phase 2C boundary: /ppo status, /ppo repo, and /ppo pr use GitHub read-only; menu/help remain local fixture-backed; no writes."
    )
    .replace(
      "Phase 2C boundary: /ppo status, /ppo repo, and /ppo pr use GitHub read-only; menu/help remain local fixture-backed; no writes.",
      "Phase 3A boundary: /ppo status, /ppo repo, and /ppo pr use GitHub read-only; terminal codex generation is local-only; no writes."
    )
    .replace(
      "Phase 3A boundary: /ppo status, /ppo repo, and /ppo pr use GitHub read-only; terminal codex generation is local-only; no writes.",
      "Phase 3B boundary: /ppo status, /ppo repo, and /ppo pr use GitHub read-only; terminal Codex prompt/planning commands are local-only; no writes."
    )
    .replace(
      "Phase 3B boundary: /ppo status, /ppo repo, and /ppo pr use GitHub read-only; terminal Codex prompt/planning commands are local-only; no writes.",
      "Phase 5B boundary: /ppo issue-create stages only; /ppo issue-confirm can create one approved GitHub issue after single-use confirmation."
    )
    .replace(
      [
        "Supported locally through /ppo in Phase 1.5:",
        "- /ppo status",
        "- /ppo menu",
        "- /ppo menu project",
        "- /ppo menu codex",
        "- /ppo menu system",
        "- /ppo help"
      ].join("\n"),
      [
        "Supported through /ppo in Phase 5B:",
        "- /ppo status [github read-only]",
        "- /ppo menu [local]",
        "- /ppo menu project [local]",
        "- /ppo menu codex [local]",
        "- /ppo menu system [local]",
        "- /ppo help [local]",
        "- /ppo repo <project> [github read-only]",
        "- /ppo pr <project> [github read-only]",
        "- /ppo codex <project> <task> [local text]",
        "- /ppo codex-budget <project> <task> [local text]",
        "- /ppo prompt-size <draft> [local text]",
        "- /ppo split-task <task> [local text]",
        "- /ppo issue-create <project> <title> [approval stage]",
        "- /ppo issue-confirm <request-id> [approved write]"
      ].join("\n")
    )
    .replace(
      "Supported through /ppo in Phase 3B:",
      "Supported through /ppo in Phase 5B:"
    )
    .replace(
      "- /ppo codex <project> <phase-or-task> - Generate compact Codex prompt. [future]",
      "- /ppo codex <project> <phase-or-task> - Generate compact Codex prompt text. [local text]"
    )
    .replace(
      "- /ppo codex-budget <project> <task> - Estimate Codex task size. [future]",
      "- /ppo codex-budget <project> <task> - Estimate Codex task size. [local text]"
    )
    .replace(
      "- /ppo prompt-size <draft> - Review and compress long Codex prompts. [future]",
      "- /ppo prompt-size <draft> - Review and mechanically compact prompt drafts. [local text]"
    )
    .replace(
      "- /ppo split-task <task> - Split large tasks into smaller phases. [future]",
      "- /ppo split-task <task> - Split large tasks into smaller planning phases. [local text]"
    )
    .replace(
      [
        "Safety:",
        "- Local fixture data only",
        "- No GitHub API calls",
        "- No Telegram API calls",
        "- No Codex usage scraping",
        "- No VPS deployment",
        "- No write actions"
      ].join("\n"),
      [
        "Safety:",
        "- /ppo status, /ppo repo, and /ppo pr use GitHub read-only",
        "- /ppo codex and planning commands generate deterministic local text",
        "- /ppo menu and /ppo help use local fixture data",
        "- No Telegram API calls",
        "- No Codex usage scraping",
        "- No VPS deployment",
        "- /ppo issue-create stages locally; /ppo issue-confirm can create one approved GitHub issue after single-use confirmation"
      ].join("\n")
    );
}

async function runSimulator(args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [simulatorPath, ...args], {
    maxBuffer: 1024 * 1024
  });

  if (stderr) {
    process.stderr.write(stderr);
  }

  process.stdout.write(applyPpoNamespace(stdout));
}

async function main() {
  const rawProcessArgs = process.argv.slice(2);
  const [rawCommand, ...args] = normalizeArgs(rawProcessArgs);

  if (!rawCommand) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }

  if (rawCommand.startsWith("/")) {
    console.log(unsupported(rawCommand));
    process.exitCode = 1;
    return;
  }

  const command = rawCommand.toLowerCase();
  const simulatorArgs = toSimulatorArgs(command, args);

  if (command === "status") {
    if (args.length !== 0) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const result = await handleGitHubPpoStatus();
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (simulatorArgs) {
    await runSimulator(simulatorArgs);
    return;
  }

  if (command === "repo" || command === "pr") {
    if (args.length !== 1) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const result = await handleGitHubPpoCommand(command, args[0]);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "issue-create") {
    if (isPpoEnvelope(rawProcessArgs)) {
      const result = await handlePpoIssueCreateApprovalCommand(payloadAfterCommand(rawProcessArgs, command));
      console.log(result.output);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    const commandArgs = issueCreateTerminalArgs(rawProcessArgs);

    if (commandArgs.length < 2) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const [projectId, title, ...bodyArgs] = commandArgs;
    const result = await handleGitHubIssueCreateCommand(projectId, title, bodyArgs, {
      confirmationValue: process.env.PPO_GITHUB_WRITE_CONFIRM
    });
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "issue-confirm") {
    if (!isPpoEnvelope(rawProcessArgs)) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const result = await handlePpoIssueConfirmCommand(payloadAfterCommand(rawProcessArgs, command));
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "codex") {
    const commandArgs = projectPayloadArgs(rawProcessArgs, command) || args;

    if (commandArgs.length < 2) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const [projectId, ...taskArgs] = commandArgs;
    const result = await handleCodexPromptCommand(projectId, taskArgs);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "codex-budget") {
    const commandArgs = projectPayloadArgs(rawProcessArgs, command) || args;

    if (commandArgs.length < 2) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const [projectId, ...taskArgs] = commandArgs;
    const result = handleCodexBudgetCommand(projectId, taskArgs);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "prompt-size") {
    const draftArgs = textPayloadArgs(rawProcessArgs, command) || terminalArgsAfterCommand(rawProcessArgs, command);

    if (draftArgs.length < 1) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const result = handlePromptSizeCommand(draftArgs);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "split-task") {
    const taskArgs = textPayloadArgs(rawProcessArgs, command) || args;

    if (taskArgs.length < 1) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const result = handleSplitTaskCommand(taskArgs);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  console.log(unsupported(rawCommand));
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("PPO wrapper failed:");
  console.error("Unexpected local failure.");
  process.exitCode = 1;
});
