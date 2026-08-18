#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { handleCodexPromptCommand } from "./codex-prompt-generator.mjs";
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

function isPpoPrefixed(rawArgs) {
  const args = rawArgs
    .flatMap((arg) => arg.trim().split(/\s+/))
    .filter(Boolean);

  return args[0]?.toLowerCase() === "/ppo" || args[0]?.toLowerCase() === "ppo";
}

function usage() {
  return [
    "Personal Project Operator PPO Wrapper",
    "",
    "Use this wrapper for approved /ppo routing and local terminal-only commands.",
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
    "  node local-operator/ppo-command.mjs codex khlim-assist \"add provider validation tests\"",
    "",
    "Telegram/OpenClaw message shape:",
    "  node local-operator/ppo-command.mjs \"/ppo status\"",
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
    "",
    "Phase 3A boundary: terminal codex prompt generation is text-only and not exposed through Telegram/OpenClaw."
  ].join("\n");
}

function unsupported(command) {
  const commandLabel = command || "(missing)";
  return [
    `Unsupported PPO command: ${commandLabel}`,
    "",
    "Phase 3A supports only:",
    "- /ppo status",
    "- /ppo menu",
    "- /ppo menu project",
    "- /ppo menu codex",
    "- /ppo menu system",
    "- /ppo help",
    "- /ppo repo <project>",
    "- /ppo pr <project>",
    "- terminal only: codex <project> <task>",
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
        "Supported through /ppo in Phase 3A:",
        "- /ppo status [github read-only]",
        "- /ppo menu [local]",
        "- /ppo menu project [local]",
        "- /ppo menu codex [local]",
        "- /ppo menu system [local]",
        "- /ppo help [local]",
        "- /ppo repo <project> [github read-only]",
        "- /ppo pr <project> [github read-only]"
      ].join("\n")
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
        "- /ppo menu and /ppo help use local fixture data",
        "- No Telegram API calls",
        "- No Codex usage scraping",
        "- No VPS deployment",
        "- No write actions"
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
  const ppoPrefixed = isPpoPrefixed(rawProcessArgs);
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

  if (command === "codex") {
    if (ppoPrefixed) {
      console.log(unsupported("/ppo codex"));
      process.exitCode = 1;
      return;
    }

    if (args.length < 2) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const [projectId, ...taskArgs] = args;
    const result = await handleCodexPromptCommand(projectId, taskArgs);
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
