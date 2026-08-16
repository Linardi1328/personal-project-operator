#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const rootUrl = new URL("./", import.meta.url);

async function readJson(filename) {
  const raw = await readFile(new URL(filename, rootUrl), "utf8");
  return JSON.parse(raw);
}

function usage() {
  return [
    "Personal Project Operator Local Simulator",
    "",
    "Usage:",
    "  node local-operator/simulate-command.mjs /status",
    "  node local-operator/simulate-command.mjs /menu",
    "  node local-operator/simulate-command.mjs /menu project",
    "  node local-operator/simulate-command.mjs /menu codex",
    "  node local-operator/simulate-command.mjs /menu system",
    "  node local-operator/simulate-command.mjs /help",
    "",
    "Phase 1 boundary: local mock output only. No GitHub, Telegram, Codex, or VPS calls."
  ].join("\n");
}

function renderStatus(projectState) {
  const activeProjects = projectState.projects.filter((project) => project.active);
  const lines = [
    "Project Status",
    "",
    `Source: ${projectState.dataSource}`,
    `Phase: ${projectState.phase}`,
    `Last updated: ${projectState.lastUpdated}`,
    "Safety: read-only local mock output; no external calls",
    ""
  ];

  for (const project of activeProjects) {
    lines.push(
      project.displayName,
      `- Repo: ${project.repo}`,
      `- Current phase: ${project.currentPhase}`,
      `- Last known status: ${project.lastKnownStatus}`,
      `- Next action: ${project.nextAction}`,
      `- Codex needed: ${project.codexNeeded}`,
      ""
    );
  }

  const futureCount = projectState.projects.length - activeProjects.length;
  lines.push(`Future/placeholders not shown: ${futureCount}`);
  lines.push("Try: /menu project");
  return lines.join("\n");
}

function commandLine(command) {
  const args = command.arguments ? ` ${command.arguments}` : "";
  const marker = command.phase1Simulator ? "local" : "future";
  return `- ${command.command}${args} - ${command.description} [${marker}]`;
}

function findCategory(commandsConfig, rawCategory) {
  if (!rawCategory) {
    return null;
  }

  const normalized = rawCategory.toLowerCase();
  return commandsConfig.categories.find((category) => {
    return category.id === normalized || category.aliases.includes(normalized);
  });
}

function renderMenu(commandsConfig, rawCategory) {
  const category = findCategory(commandsConfig, rawCategory);

  if (rawCategory && !category) {
    const valid = commandsConfig.categories.map((item) => item.id).join(", ");
    return [
      `Unknown menu category: ${rawCategory}`,
      `Available categories: ${valid}`,
      "Try: /menu"
    ].join("\n");
  }

  const categories = category ? [category] : commandsConfig.categories;
  const lines = [
    category ? category.label : "Personal Project Operator Menu",
    "",
    "Phase 1 runnable commands are marked [local]. Future commands are documented but not active.",
    ""
  ];

  for (const item of categories) {
    if (!category) {
      lines.push(item.label);
    }
    for (const command of item.commands) {
      lines.push(commandLine(command));
    }
    lines.push("");
  }

  lines.push("Phase 1 boundary: no live APIs, no secrets, no writes.");
  return lines.join("\n");
}

function renderHelp() {
  return [
    "Personal Project Operator Help",
    "",
    "Use this local simulator to test phone-style command output before OpenClaw routes real chat messages.",
    "",
    "Start with:",
    "- /menu",
    "- /status",
    "",
    "Supported locally in Phase 1:",
    "- /status",
    "- /menu",
    "- /menu project",
    "- /menu codex",
    "- /menu system",
    "- /help",
    "",
    "Examples:",
    "- node local-operator/simulate-command.mjs /status",
    "- node local-operator/simulate-command.mjs /menu system",
    "",
    "Safety:",
    "- Local fixture data only",
    "- No GitHub API calls",
    "- No Telegram API calls",
    "- No Codex usage scraping",
    "- No VPS deployment",
    "- No write actions"
  ].join("\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }

  const normalizedCommand = command.toLowerCase();

  if (normalizedCommand === "/status") {
    const projectState = await readJson("project-state.json");
    console.log(renderStatus(projectState));
    return;
  }

  if (normalizedCommand === "/menu") {
    const commandsConfig = await readJson("commands.json");
    console.log(renderMenu(commandsConfig, args[0]));
    return;
  }

  if (normalizedCommand === "/help") {
    console.log(renderHelp());
    return;
  }

  console.log([
    `Unsupported local command: ${command}`,
    "",
    "Phase 1 supports only:",
    "- /status",
    "- /menu",
    "- /help",
    "",
    "Try: node local-operator/simulate-command.mjs /menu"
  ].join("\n"));
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("Local simulator failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

