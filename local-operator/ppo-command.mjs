#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

function usage() {
  return [
    "Personal Project Operator PPO Wrapper",
    "",
    "Use this wrapper when OpenClaw routes Telegram messages through the custom /ppo namespace.",
    "",
    "Terminal usage:",
    "  node local-operator/ppo-command.mjs status",
    "  node local-operator/ppo-command.mjs menu",
    "  node local-operator/ppo-command.mjs menu project",
    "  node local-operator/ppo-command.mjs menu codex",
    "  node local-operator/ppo-command.mjs menu system",
    "  node local-operator/ppo-command.mjs help",
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
    "",
    "Phase 1.5 boundary: local mock output only. No GitHub, Telegram, Codex, or VPS calls."
  ].join("\n");
}

function unsupported(command) {
  const commandLabel = command || "(missing)";
  return [
    `Unsupported PPO command: ${commandLabel}`,
    "",
    "Phase 1.5 supports only:",
    "- /ppo status",
    "- /ppo menu",
    "- /ppo menu project",
    "- /ppo menu codex",
    "- /ppo menu system",
    "- /ppo help",
    "",
    "Try: node local-operator/ppo-command.mjs menu"
  ].join("\n");
}

function toSimulatorArgs(command, args) {
  if (command === "status") {
    return ["/status"];
  }

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

  return adapted.replace(/(^|\s)\/([a-z][a-z-]*)(?=\s|$)/g, (match, prefix, command) => {
    if (command === "ppo") {
      return match;
    }

    return `${prefix}/ppo ${command}`;
  });
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
  const [rawCommand, ...args] = normalizeArgs(process.argv.slice(2));

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

  if (!simulatorArgs) {
    console.log(unsupported(rawCommand));
    process.exitCode = 1;
    return;
  }

  await runSimulator(simulatorArgs);
}

main().catch((error) => {
  console.error("PPO wrapper failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
