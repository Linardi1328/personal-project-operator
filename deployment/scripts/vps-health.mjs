#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const VPS_HEALTH_SERVICE = "ppo-openclaw.service";
export const VPS_TARGET = "Ubuntu 24.04 LTS, 2 vCPU / 4 GB RAM class VPS";
export const VPS_INSTALL_DIR = "/opt/personal-project-operator";
export const VPS_WRAPPER_PATH = `${VPS_INSTALL_DIR}/local-operator/ppo-command.mjs`;
export const VPS_OPENCLAW_PREFIX = "/home/ppo/.local/openclaw";
export const VPS_NODE_PATH = `${VPS_OPENCLAW_PREFIX}/bin/node`;
export const VPS_OPENCLAW_PATH = `${VPS_OPENCLAW_PREFIX}/bin/openclaw`;
export const VPS_HEALTH_TIMEOUT_MS = 3000;

const execFileAsync = promisify(execFile);
const ansiTerminalSequences = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_])/gu;
const unsafeControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function sanitize(value) {
  return String(value ?? "")
    .replace(ansiTerminalSequences, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(unsafeControls, "")
    .trim();
}

function firstLine(value) {
  return sanitize(value).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function defaultRunner(command, args, options) {
  return execFileAsync(command, args, options);
}

async function runReadOnlyCommand(runner, command, args) {
  try {
    const result = await runner(command, args, {
      shell: false,
      timeout: VPS_HEALTH_TIMEOUT_MS,
      maxBuffer: 64 * 1024
    });

    return {
      ok: true,
      stdout: sanitize(result?.stdout)
    };
  } catch {
    return {
      ok: false,
      stdout: ""
    };
  }
}

function check(label, status, detail = "") {
  return {
    label,
    status,
    detail: sanitize(detail)
  };
}

function parseDisk(output) {
  const lines = sanitize(output).split("\n").filter(Boolean);
  const values = lines[1]?.trim().split(/\s+/u);

  if (!values || values.length < 5) {
    return "unavailable";
  }

  return `${values[4]} used on /`;
}

function parseMemory(output) {
  const line = sanitize(output).split("\n").find((item) => item.startsWith("Mem:"));
  const values = line?.trim().split(/\s+/u);

  if (!values || values.length < 3) {
    return "unavailable";
  }

  return `${values[2]} MiB used of ${values[1]} MiB`;
}

export async function collectVpsHealth(options = {}) {
  const runner = options.runner ?? defaultRunner;
  const exists = options.exists ?? existsSync;
  const now = options.now ?? new Date().toISOString();
  const checks = [];

  const nodeVersion = await runReadOnlyCommand(runner, VPS_NODE_PATH, ["--version"]);
  checks.push(check("OpenClaw local-prefix Node.js", nodeVersion.ok ? "available" : "unavailable", firstLine(nodeVersion.stdout)));

  const gitVersion = await runReadOnlyCommand(runner, "git", ["--version"]);
  checks.push(check("git", gitVersion.ok ? "available" : "unavailable", firstLine(gitVersion.stdout)));

  const ghVersion = await runReadOnlyCommand(runner, "gh", ["--version"]);
  checks.push(check("gh", ghVersion.ok ? "available" : "unavailable", firstLine(ghVersion.stdout)));

  const openclawVersion = await runReadOnlyCommand(runner, VPS_OPENCLAW_PATH, ["--version"]);
  checks.push(check("OpenClaw local-prefix executable", openclawVersion.ok ? "available" : "unavailable", firstLine(openclawVersion.stdout)));

  const serviceActive = await runReadOnlyCommand(runner, "systemctl", ["is-active", VPS_HEALTH_SERVICE]);
  checks.push(check("systemd active", serviceActive.ok ? "active" : "inactive or unavailable", firstLine(serviceActive.stdout)));

  const serviceEnabled = await runReadOnlyCommand(runner, "systemctl", ["is-enabled", VPS_HEALTH_SERVICE]);
  checks.push(check("systemd boot recovery", serviceEnabled.ok ? "enabled" : "not enabled or unavailable", firstLine(serviceEnabled.stdout)));

  const uptime = await runReadOnlyCommand(runner, "uptime", ["-p"]);
  checks.push(check("uptime", uptime.ok ? "available" : "unavailable", firstLine(uptime.stdout)));

  const disk = await runReadOnlyCommand(runner, "df", ["-h", "/"]);
  checks.push(check("disk", disk.ok ? "available" : "unavailable", parseDisk(disk.stdout)));

  const memory = await runReadOnlyCommand(runner, "free", ["-m"]);
  checks.push(check("memory", memory.ok ? "available" : "unavailable", parseMemory(memory.stdout)));

  checks.push(check("repo checkout", exists(VPS_INSTALL_DIR) ? "present" : "missing", VPS_INSTALL_DIR));
  checks.push(check("PPO wrapper", exists(VPS_WRAPPER_PATH) ? "present" : "missing", VPS_WRAPPER_PATH));

  return {
    title: "VPS Health Foundation",
    source: "local read-only host checks",
    target: VPS_TARGET,
    service: VPS_HEALTH_SERVICE,
    retrievedAt: sanitize(now),
    checks
  };
}

export function formatVpsHealth(report) {
  const lines = [
    report.title,
    `Source: ${report.source}`,
    `Target: ${report.target}`,
    `Service: ${report.service}`,
    `Retrieved: ${report.retrievedAt}`,
    "",
    "Checks:",
    ...report.checks.map((item) => {
      const detail = item.detail ? ` (${item.detail})` : "";
      return `- ${item.label}: ${item.status}${detail}`;
    }),
    "",
    "Boundary:",
    "- Read-only local host inspection.",
    "- Does not SSH to a server.",
    "- Does not restart services.",
    "- Does not print environment variables or credentials.",
    "- /ppo vps-health routing remains future work."
  ];

  return lines.join("\n");
}

async function main() {
  if (process.argv.length > 2) {
    console.log("VPS health check failed: unsupported arguments.");
    process.exitCode = 1;
    return;
  }

  const report = await collectVpsHealth();
  console.log(formatVpsHealth(report));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => {
    console.log("VPS health check failed: unexpected local failure.");
    process.exitCode = 1;
  });
}
