import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MAX_TASK_CHARS } from "../../../local-operator/codex-prompt-generator.mjs";
import { MAX_PROMPT_DRAFT_CHARS } from "../../../local-operator/codex-planning-tools.mjs";
import {
  parsePpoIssueConfirmRequest,
  parsePpoIssueCreateRequest
} from "../../../local-operator/github-issue-approval.mjs";
import { listPhase2GitHubProjects } from "../../../local-operator/github-project-registry.mjs";
import {
  parsePpoNoteAddRequest,
  parsePpoNoteConfirmRequest
} from "../../../local-operator/project-note-approval.mjs";

const execFileAsync = promisify(execFile);

const allowedCommands = new Map([
  ["status", ["status"]],
  ["menu", ["menu"]],
  ["help", ["help"]],
  ["menu project", ["menu", "project"]],
  ["menu codex", ["menu", "codex"]],
  ["menu system", ["menu", "system"]]
]);

const allowedGitHubProjectIds = new Set(listPhase2GitHubProjects().map((project) => project.id));
const unexpectedWrapperFailure = "PPO local wrapper failed: unexpected local failure.";

export const defaultWrapperPath = fileURLToPath(
  new URL("../../../local-operator/ppo-command.mjs", import.meta.url)
);

export function unsupportedPpoToolInput(rawCommand) {
  const commandText = unwrapPpoEnvelope(typeof rawCommand === "string" ? rawCommand : "") || String(rawCommand || "");
  const commandLabel = splitFirstToken(commandText)?.token || "(missing)";

  return [
    `Unsupported PPO tool input: ${commandLabel}`,
    "",
    "PPO local tool supports only:",
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
    "- /ppo note-add <project> <note...>",
    "- /ppo note-confirm <request-id>"
  ].join("\n");
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

function unwrapPpoEnvelope(rawCommand) {
  const trimmed = rawCommand.trim();

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

  if (first.token.startsWith("/")) {
    return null;
  }

  return trimmed;
}

function normalizedStaticCommand(commandName, rest) {
  return [commandName, rest.trim().replace(/\s+/g, " ")]
    .filter(Boolean)
    .join(" ");
}

function parseProjectTextCommand(commandName, rest) {
  const projectEnvelope = splitFirstToken(rest.trimStart());

  if (!projectEnvelope || !allowedGitHubProjectIds.has(projectEnvelope.token)) {
    return null;
  }

  const payload = projectEnvelope.rest.trim();

  if (!payload) {
    return null;
  }

  if (payload.length > MAX_TASK_CHARS) {
    return null;
  }

  return [commandName, projectEnvelope.token, payload];
}

function parseTextOnlyCommand(commandName, rest, limit) {
  const payload = rest.trim();

  if (payload.length > limit) {
    return null;
  }

  return payload ? [commandName, payload] : null;
}

function parseIssueCreateCommand(rest) {
  try {
    const parsed = parsePpoIssueCreateRequest(rest);
    const args = ["/ppo", "issue-create", parsed.projectId, parsed.title];

    if (parsed.body) {
      args.push("--body", parsed.body);
    }

    return args;
  } catch {
    return null;
  }
}

function parseIssueConfirmCommand(rest) {
  try {
    return ["/ppo", "issue-confirm", parsePpoIssueConfirmRequest(rest)];
  } catch {
    return null;
  }
}

function parseNoteAddCommand(rest) {
  try {
    const parsed = parsePpoNoteAddRequest(rest);

    return ["/ppo", "note-add", parsed.projectId, parsed.note];
  } catch {
    return null;
  }
}

function parseNoteConfirmCommand(rest) {
  try {
    return ["/ppo", "note-confirm", parsePpoNoteConfirmRequest(rest)];
  } catch {
    return null;
  }
}

export function toPpoWrapperArgs(rawCommand) {
  if (typeof rawCommand !== "string") {
    return null;
  }

  const commandText = unwrapPpoEnvelope(rawCommand);

  if (!commandText) {
    return null;
  }

  const commandEnvelope = splitFirstToken(commandText);

  if (!commandEnvelope) {
    return null;
  }

  const commandName = commandEnvelope.token.toLowerCase();
  const normalizedCommand = normalizedStaticCommand(commandName, commandEnvelope.rest);
  const staticCommand = allowedCommands.get(normalizedCommand.toLowerCase());

  if (staticCommand) {
    return staticCommand;
  }

  const parts = normalizedCommand.split(" ");

  if (
    parts.length === 2 &&
    (commandName === "repo" || commandName === "pr") &&
    allowedGitHubProjectIds.has(parts[1])
  ) {
    return [commandName, parts[1]];
  }

  if (commandName === "codex" || commandName === "codex-budget") {
    return parseProjectTextCommand(commandName, commandEnvelope.rest);
  }

  if (commandName === "prompt-size") {
    return parseTextOnlyCommand(commandName, commandEnvelope.rest, MAX_PROMPT_DRAFT_CHARS);
  }

  if (commandName === "split-task") {
    return parseTextOnlyCommand(commandName, commandEnvelope.rest, MAX_TASK_CHARS);
  }

  if (commandName === "issue-create") {
    return parseIssueCreateCommand(commandEnvelope.rest);
  }

  if (commandName === "issue-confirm") {
    return parseIssueConfirmCommand(commandEnvelope.rest);
  }

  if (commandName === "note-add") {
    return parseNoteAddCommand(commandEnvelope.rest);
  }

  if (commandName === "note-confirm") {
    return parseNoteConfirmCommand(commandEnvelope.rest);
  }

  return null;
}

async function runWrapper(wrapperPath, wrapperArgs, options) {
  if (options.runWrapper) {
    return options.runWrapper(wrapperArgs, { wrapperPath });
  }

  return execFileAsync(process.execPath, [wrapperPath, ...wrapperArgs], {
    maxBuffer: 1024 * 1024,
    shell: false
  });
}

function normalizeWrapperFailure(error) {
  const exitCode = Number.isInteger(error?.code)
    ? error.code
    : Number.isInteger(error?.exitCode)
      ? error.exitCode
      : null;

  if (exitCode !== null) {
    const stdout = typeof error.stdout === "string" && error.stdout.length > 0
      ? error.stdout
      : `${unexpectedWrapperFailure}\n`;

    return {
      ok: false,
      exitCode,
      stdout,
      stderr: ""
    };
  }

  return {
    ok: false,
    exitCode: 1,
    stdout: `${unexpectedWrapperFailure}\n`,
    stderr: ""
  };
}

export async function runPpoLocalTool(params = {}, options = {}) {
  const rawCommand = typeof params.command === "string" ? params.command : "";
  const wrapperArgs = toPpoWrapperArgs(rawCommand);

  if (!wrapperArgs) {
    return {
      ok: false,
      exitCode: 1,
      stdout: unsupportedPpoToolInput(rawCommand),
      stderr: "",
      wrapperArgs: []
    };
  }

  const wrapperPath = options.wrapperPath || defaultWrapperPath;
  let result;

  try {
    result = await runWrapper(wrapperPath, wrapperArgs, options);
  } catch (error) {
    return {
      ...normalizeWrapperFailure(error),
      wrapperArgs
    };
  }

  return {
    ok: true,
    exitCode: 0,
    stdout: result.stdout || "",
    stderr: "",
    wrapperArgs
  };
}
