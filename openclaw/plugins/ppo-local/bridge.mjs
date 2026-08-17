import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listPhase2GitHubProjects } from "../../../local-operator/github-project-registry.mjs";

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
  const commandLabel = rawCommand || "(missing)";
  return [
    `Unsupported PPO tool input: ${commandLabel}`,
    "",
    "Phase 2C supports only:",
    "- /ppo status",
    "- /ppo menu",
    "- /ppo menu project",
    "- /ppo menu codex",
    "- /ppo menu system",
    "- /ppo help",
    "- /ppo repo <project>",
    "- /ppo pr <project>"
  ].join("\n");
}

export function toPpoWrapperArgs(rawCommand) {
  if (typeof rawCommand !== "string") {
    return null;
  }

  let normalized = rawCommand.trim().replace(/\s+/g, " ");

  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();

  if (lower === "/ppo" || lower === "ppo") {
    return null;
  }

  if (lower.startsWith("/ppo ")) {
    normalized = normalized.slice(5).trim().replace(/\s+/g, " ");
  } else if (lower.startsWith("ppo ")) {
    normalized = normalized.slice(4).trim().replace(/\s+/g, " ");
  } else if (normalized.startsWith("/")) {
    return null;
  }

  const normalizedLower = normalized.toLowerCase();
  const staticCommand = allowedCommands.get(normalizedLower);

  if (staticCommand) {
    return staticCommand;
  }

  const parts = normalized.split(" ");
  const commandName = parts[0]?.toLowerCase();

  if (
    parts.length === 2 &&
    (commandName === "repo" || commandName === "pr") &&
    allowedGitHubProjectIds.has(parts[1])
  ) {
    return [commandName, parts[1]];
  }

  return null;
}

async function runWrapper(wrapperPath, wrapperArgs, options) {
  if (options.runWrapper) {
    return options.runWrapper(wrapperArgs, { wrapperPath });
  }

  return execFileAsync(process.execPath, [wrapperPath, ...wrapperArgs], {
    maxBuffer: 1024 * 1024
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
