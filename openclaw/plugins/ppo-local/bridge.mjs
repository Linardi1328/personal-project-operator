import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const allowedCommands = new Map([
  ["status", ["status"]],
  ["menu", ["menu"]],
  ["help", ["help"]],
  ["menu project", ["menu", "project"]],
  ["menu codex", ["menu", "codex"]],
  ["menu system", ["menu", "system"]]
]);

export const defaultWrapperPath = fileURLToPath(
  new URL("../../../local-operator/ppo-command.mjs", import.meta.url)
);

export function unsupportedPpoToolInput(rawCommand) {
  const commandLabel = rawCommand || "(missing)";
  return [
    `Unsupported PPO tool input: ${commandLabel}`,
    "",
    "Phase 1.5 supports only:",
    "- /ppo status",
    "- /ppo menu",
    "- /ppo menu project",
    "- /ppo menu codex",
    "- /ppo menu system",
    "- /ppo help"
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

  return allowedCommands.get(normalized.toLowerCase()) || null;
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
  const { stdout, stderr } = await execFileAsync(process.execPath, [wrapperPath, ...wrapperArgs], {
    maxBuffer: 1024 * 1024
  });

  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr,
    wrapperArgs
  };
}
