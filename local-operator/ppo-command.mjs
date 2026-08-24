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
  CANCELLATION_REQUEST_ID_PATTERN,
  handlePpoDevelopmentCancelCommand,
  handlePpoDevelopmentCancelConfirmCommand
} from "./development-run-cancellation-approval.mjs";
import { handlePpoDevelopmentContinueCommand } from "./development-continue-orchestrator.mjs";
import { loadDevelopmentContinueRuntimeProfile } from "./development-continue-runtime-profile.mjs";
import {
  handlePpoDevelopmentRunCommand,
  handlePpoDevelopmentRunsCommand
} from "./development-run-catalog-route.mjs";
import { handlePpoDevelopmentStartCommand } from "./development-start-route.mjs";
import { handlePpoDevelopmentRecoverCommand } from "./development-recovery-route.mjs";
import {
  handlePpoIssueConfirmCommand,
  handlePpoIssueCreateApprovalCommand
} from "./github-issue-approval.mjs";
import { handleGitHubIssueCreateCommand } from "./github-issue-create.mjs";
import { handleGitHubPpoCommand } from "./github-ppo-commands.mjs";
import { handleGitHubPpoStatus } from "./github-ppo-status.mjs";
import { handleProjectNoteAddCommand } from "./project-note-add.mjs";
import {
  handlePpoNoteAddApprovalCommand,
  handlePpoNoteConfirmCommand
} from "./project-note-approval.mjs";
import { handleProjectStatePromoteCommand } from "./project-state-promote.mjs";
import { DEVELOPMENT_RUN_ID_PATTERN } from "./development-run-id.mjs";
import { listPhase2GitHubProjects } from "./github-project-registry.mjs";

const execFileAsync = promisify(execFile);
const simulatorPath = fileURLToPath(new URL("simulate-command.mjs", import.meta.url));
const startProjectIds = new Set(listPhase2GitHubProjects().map((project) => project.id));

function normalizeArgs(rawArgs) {
  const args = rawArgs
    .flatMap((arg) => arg.trim().split(/\s+/))
    .filter(Boolean);

  if (args[0]?.toLowerCase() === "/ppo" || args[0]?.toLowerCase() === "ppo") {
    return args.slice(1);
  }

  return args;
}

function parseStrictRunIdCommandArgs(rawArgs, command, options = {}) {
  const args = rawArgs.map((arg) => String(arg));
  const unsafe = args.some((arg) => arg !== arg.trim() || /[\u0000-\u001F\u007F-\u009F]/u.test(arg));
  const lower0 = args[0]?.toLowerCase();
  const lower1 = args[1]?.toLowerCase();
  const firstLooksLikeCommand = lower0 === command || lower0?.startsWith(`${command} `);
  const envelopeLooksLikeCommand = (
    (lower0 === "/ppo" || lower0 === "ppo") &&
    (lower1 === command || lower1?.startsWith(`${command} `))
  );
  const combinedEnvelopeLooksLikeCommand = (
    (lower0?.startsWith("/ppo") || lower0?.startsWith("ppo")) &&
    new RegExp(`(?:^|[\\s\\r\\n\\t])${command}(?:$|[\\s\\r\\n\\t])`, "iu").test(args[0])
  );
  const exactCombinedText = args.length === 1 ? args[0] : "";
  const exactCombinedParts = exactCombinedText.split(" ");
  const exactCombinedLooksLikeCommand = (
    exactCombinedText === command ||
    exactCombinedText.startsWith(`${command} `) ||
    exactCombinedText.startsWith(`/ppo ${command}`) ||
    exactCombinedText.startsWith(`ppo ${command}`)
  );
  const attempted = (
    firstLooksLikeCommand ||
    envelopeLooksLikeCommand ||
    combinedEnvelopeLooksLikeCommand ||
    exactCombinedLooksLikeCommand
  );

  if (!attempted) {
    return null;
  }

  if (unsafe) {
    return { ok: false, attempted: true };
  }

  if (args.length === 2 && args[0] === command && DEVELOPMENT_RUN_ID_PATTERN.test(args[1])) {
    return { ok: true, attempted: true, runId: args[1] };
  }

  if (
    args.length === 3 &&
    (args[0] === "/ppo" || args[0] === "ppo") &&
    args[1] === command &&
    DEVELOPMENT_RUN_ID_PATTERN.test(args[2])
  ) {
    return { ok: true, attempted: true, runId: args[2] };
  }

  if (options.allowExactCombined === true && args.length === 1) {
    if (
      exactCombinedParts.length === 2 &&
      exactCombinedParts[0] === command &&
      DEVELOPMENT_RUN_ID_PATTERN.test(exactCombinedParts[1])
    ) {
      return { ok: true, attempted: true, runId: exactCombinedParts[1] };
    }

    if (
      exactCombinedParts.length === 3 &&
      (exactCombinedParts[0] === "/ppo" || exactCombinedParts[0] === "ppo") &&
      exactCombinedParts[1] === command &&
      DEVELOPMENT_RUN_ID_PATTERN.test(exactCombinedParts[2])
    ) {
      return { ok: true, attempted: true, runId: exactCombinedParts[2] };
    }
  }

  return { ok: false, attempted: true };
}

function parseStrictRequestIdCommandArgs(rawArgs, command, options = {}) {
  const args = rawArgs.map((arg) => String(arg));
  const unsafe = args.some((arg) => arg !== arg.trim() || /[\u0000-\u001F\u007F-\u009F]/u.test(arg));
  const lower0 = args[0]?.toLowerCase();
  const lower1 = args[1]?.toLowerCase();
  const firstLooksLikeCommand = lower0 === command || lower0?.startsWith(`${command} `);
  const envelopeLooksLikeCommand = (
    (lower0 === "/ppo" || lower0 === "ppo") &&
    (lower1 === command || lower1?.startsWith(`${command} `))
  );
  const combinedEnvelopeLooksLikeCommand = (
    (lower0?.startsWith("/ppo") || lower0?.startsWith("ppo")) &&
    new RegExp(`(?:^|[\\s\\r\\n\\t])${command}(?:$|[\\s\\r\\n\\t])`, "iu").test(args[0])
  );
  const exactCombinedText = args.length === 1 ? args[0] : "";
  const exactCombinedParts = exactCombinedText.split(" ");
  const exactCombinedLooksLikeCommand = (
    exactCombinedText === command ||
    exactCombinedText.startsWith(`${command} `) ||
    exactCombinedText.startsWith(`/ppo ${command} `) ||
    exactCombinedText.startsWith(`ppo ${command} `)
  );
  const attempted = (
    firstLooksLikeCommand ||
    envelopeLooksLikeCommand ||
    combinedEnvelopeLooksLikeCommand ||
    exactCombinedLooksLikeCommand
  );

  if (!attempted) {
    return null;
  }

  if (unsafe) {
    return { ok: false, attempted: true };
  }

  if (args.length === 2 && args[0] === command && CANCELLATION_REQUEST_ID_PATTERN.test(args[1])) {
    return { ok: true, attempted: true, requestId: args[1] };
  }

  if (
    args.length === 3 &&
    (args[0] === "/ppo" || args[0] === "ppo") &&
    args[1] === command &&
    CANCELLATION_REQUEST_ID_PATTERN.test(args[2])
  ) {
    return { ok: true, attempted: true, requestId: args[2] };
  }

  if (options.allowExactCombined === true && args.length === 1) {
    if (
      exactCombinedParts.length === 2 &&
      exactCombinedParts[0] === command &&
      CANCELLATION_REQUEST_ID_PATTERN.test(exactCombinedParts[1])
    ) {
      return { ok: true, attempted: true, requestId: exactCombinedParts[1] };
    }

    if (
      exactCombinedParts.length === 3 &&
      (exactCombinedParts[0] === "/ppo" || exactCombinedParts[0] === "ppo") &&
      exactCombinedParts[1] === command &&
      CANCELLATION_REQUEST_ID_PATTERN.test(exactCombinedParts[2])
    ) {
      return { ok: true, attempted: true, requestId: exactCombinedParts[2] };
    }
  }

  return { ok: false, attempted: true };
}

function parseStrictZeroArgCommandArgs(rawArgs, command, options = {}) {
  const args = rawArgs.map((arg) => String(arg));
  const unsafe = args.some((arg) => arg !== arg.trim() || /[\u0000-\u001F\u007F-\u009F]/u.test(arg));
  const commandAttemptPattern = new RegExp(`^(?:(?:/ppo|ppo)[\\s\\r\\n\\t]+)?${command}(?:$|[\\s\\r\\n\\t])`, "iu");
  const attempted = commandAttemptPattern.test(args.join(" "));

  if (!attempted) {
    return null;
  }

  if (unsafe) {
    return { ok: false, attempted: true };
  }

  if (args.length === 1 && args[0] === command) {
    return { ok: true, attempted: true };
  }

  if (
    options.allowExactCombined === true &&
    args.length === 1 &&
    (args[0] === `/ppo ${command}` || args[0] === `ppo ${command}`)
  ) {
    return { ok: true, attempted: true };
  }

  if (
    args.length === 2 &&
    (args[0] === "/ppo" || args[0] === "ppo") &&
    args[1] === command
  ) {
    return { ok: true, attempted: true };
  }

  return { ok: false, attempted: true };
}

function parseStrictStartArgs(rawArgs) {
  const args = rawArgs.map((arg) => String(arg));
  const unsafe = args.some((arg) => arg !== arg.trim() || /[\u0000-\u001F\u007F-\u009F]/u.test(arg));
  const lower0 = args[0]?.toLowerCase();
  const lower1 = args[1]?.toLowerCase();
  const firstLooksLikeStart = lower0 === "start" || /^\s*start(?:$|[\s\r\n\t])/iu.test(args[0] || "");
  const envelopeLooksLikeStart = (
    (lower0?.trim() === "/ppo" || lower0?.trim() === "ppo") &&
    (lower1 === "start" || /^\s*start(?:$|[\s\r\n\t])/iu.test(args[1] || ""))
  );
  const combinedEnvelopeLooksLikeStart = /^\s*(?:\/ppo|ppo)[\s\r\n\t]+start(?:$|[\s\r\n\t])/iu.test(args[0] || "");
  const attempted = firstLooksLikeStart || envelopeLooksLikeStart || combinedEnvelopeLooksLikeStart;

  if (!attempted) {
    return null;
  }

  if (unsafe) {
    return { ok: false, attempted: true };
  }

  if (args.length === 2 && args[0] === "start" && startProjectIds.has(args[1])) {
    return { ok: true, attempted: true, projectId: args[1] };
  }

  if (
    args.length === 3 &&
    (args[0] === "/ppo" || args[0] === "ppo") &&
    args[1] === "start" &&
    startProjectIds.has(args[2])
  ) {
    return { ok: true, attempted: true, projectId: args[2] };
  }

  if (args.length === 1) {
    const parts = args[0].split(" ");

    if (parts.length === 2 && parts[0] === "start" && startProjectIds.has(parts[1])) {
      return { ok: true, attempted: true, projectId: parts[1] };
    }

    if (
      parts.length === 3 &&
      (parts[0] === "/ppo" || parts[0] === "ppo") &&
      parts[1] === "start" &&
      startProjectIds.has(parts[2])
    ) {
      return { ok: true, attempted: true, projectId: parts[2] };
    }
  }

  return { ok: false, attempted: true };
}

function parseStrictContinueArgs(rawArgs) {
  return parseStrictRunIdCommandArgs(rawArgs, "continue");
}

function parseStrictRecoverArgs(rawArgs) {
  return parseStrictRunIdCommandArgs(rawArgs, "recover");
}

function parseStrictCancelArgs(rawArgs) {
  return parseStrictRunIdCommandArgs(rawArgs, "cancel", {
    allowExactCombined: true
  });
}

function parseStrictCancelConfirmArgs(rawArgs) {
  return parseStrictRequestIdCommandArgs(rawArgs, "cancel-confirm", {
    allowExactCombined: true
  });
}

function parseStrictRunArgs(rawArgs) {
  return parseStrictRunIdCommandArgs(rawArgs, "run", {
    allowExactCombined: true
  });
}

function parseStrictRunsArgs(rawArgs) {
  return parseStrictZeroArgCommandArgs(rawArgs, "runs", {
    allowExactCombined: true
  });
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

function noteAddTerminalArgs(rawArgs) {
  const firstArg = String(rawArgs[0] ?? "");
  const trimmedFirstArg = firstArg.trim();

  if (trimmedFirstArg.toLowerCase() === "note-add") {
    return rawArgs.slice(1).map((arg) => String(arg));
  }

  if (trimmedFirstArg.toLowerCase().startsWith("note-add ")) {
    const rest = trimmedFirstArg.slice("note-add".length).trimStart();
    const projectEnvelope = splitFirstToken(rest);

    if (!projectEnvelope) {
      return [];
    }

    const note = projectEnvelope.rest.trim();
    const parsed = note ? [projectEnvelope.token, note] : [projectEnvelope.token];

    return [...parsed, ...rawArgs.slice(1).map((arg) => String(arg))];
  }

  return rawArgs.slice(1).map((arg) => String(arg));
}

function usage() {
  return [
    "Personal Project Operator PPO Wrapper",
    "",
    "Use this wrapper for approved /ppo routing, local deterministic text commands, approval-gated issue creation, terminal project notes, and controlled development run routes.",
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
    "  node local-operator/ppo-command.mjs note-add khlim-assist \"project note text\"",
    "  node local-operator/ppo-command.mjs state-promote khlim-assist <note-id> current-phase",
    "  node local-operator/ppo-command.mjs start khlim-assist",
    "  node local-operator/ppo-command.mjs runs",
    "  node local-operator/ppo-command.mjs run <run-id>",
    "  node local-operator/ppo-command.mjs cancel <run-id>",
    "  node local-operator/ppo-command.mjs cancel-confirm <request-id>",
    "  node local-operator/ppo-command.mjs continue <run-id>",
    "  node local-operator/ppo-command.mjs recover <run-id>",
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
    "  node local-operator/ppo-command.mjs \"/ppo note-add khlim-assist project note text\"",
    "  node local-operator/ppo-command.mjs \"/ppo note-confirm <request-id>\"",
    "  node local-operator/ppo-command.mjs /ppo start khlim-assist",
    "  node local-operator/ppo-command.mjs /ppo runs",
    "  node local-operator/ppo-command.mjs /ppo run <run-id>",
    "  node local-operator/ppo-command.mjs /ppo cancel <run-id>",
    "  node local-operator/ppo-command.mjs /ppo cancel-confirm <request-id>",
    "  node local-operator/ppo-command.mjs /ppo continue <run-id>",
    "  node local-operator/ppo-command.mjs /ppo recover <run-id>",
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
    "  /ppo note-add <project> <note...>",
    "  /ppo note-confirm <request-id>",
    "  /ppo start <project>",
    "  /ppo runs",
    "  /ppo run <run-id>",
    "  /ppo cancel <run-id>",
    "  /ppo cancel-confirm <request-id>",
    "  /ppo continue <run-id>",
    "  /ppo recover <run-id>",
    "",
    "Phase 5A boundary: terminal issue-create requires PPO_GITHUB_WRITE_CONFIRM=create-issue:<project>.",
    "Phase 5B boundary: /ppo issue-create only stages a pending request; /ppo issue-confirm performs the approved single-use write.",
    "Phase 5C boundary: terminal note-add requires PPO_NOTE_WRITE_CONFIRM=add-note:<project>.",
    "Phase 5D boundary: /ppo note-add stages only; /ppo note-confirm performs the approved single-use local note append.",
    "Phase 5E boundary: terminal state-promote requires PPO_PROJECT_STATE_CONFIRM=promote-note:<project>:<note-id>:<field>; /ppo state-promote remains unsupported.",
    "Phase 7A boundary: /ppo start accepts only one allowlisted project id, creates at most one Phase 6B planned run, and never continues automatically.",
    "Phase 6O boundary: /ppo runs and /ppo run <run-id> expose the Phase 6N read-only ordinary-run catalog only; no filters, recovery, continue, cancellation, retry, repair, or production action.",
    "Phase 6P boundary: /ppo cancel stages a single-use quiescent cancellation request and /ppo cancel-confirm consumes it; no process interruption, cleanup, recovery, continue, retry, or production action.",
    "Phase 6K boundary: /ppo continue accepts only an existing ordinary development run id and advances at most one reviewed Phase 6B-6G boundary; production deployment, verification, and rollback remain local-only.",
    "Phase 6M boundary: /ppo recover accepts only an existing ordinary development run id and exposes one Phase 6L read-only recovery observation; it performs no repair, retry, continue, deployment, verification, or rollback."
  ].join("\n");
}

function unsupported(command) {
  const commandLabel = command || "(missing)";
  return [
    `Unsupported PPO command: ${commandLabel}`,
    "",
    "PPO wrapper supports only:",
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
    "- /ppo note-confirm <request-id>",
    "- /ppo start <project>",
    "- /ppo runs",
    "- /ppo run <run-id>",
    "- /ppo cancel <run-id>",
    "- /ppo cancel-confirm <request-id>",
    "- /ppo continue <run-id>",
    "- /ppo recover <run-id>",
    "",
    "Terminal-only additions:",
    "- issue-create <project> <title> [body...]",
    "- note-add <project> <note...>",
    "- state-promote <project> <note-id> <current-phase|last-known-status|next-action>",
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
      "Phase 6M PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, approval-gated issue creation, approval-gated project note creation, one-boundary ordinary development continue, and read-only development recovery."
    )
    .replace(
      "Phase 6M PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, approval-gated issue creation, approval-gated project note creation, one-boundary ordinary development continue, and read-only development recovery.",
      "Phase 6O PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, approval-gated issue creation, approval-gated project note creation, one-boundary ordinary development continue, read-only development recovery, and the read-only ordinary-run catalog."
    )
    .replace(
      "Phase 6O PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, approval-gated issue creation, approval-gated project note creation, one-boundary ordinary development continue, read-only development recovery, and the read-only ordinary-run catalog.",
      "Phase 6P PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, approval-gated issue creation, approval-gated project note creation, one-boundary ordinary development continue, read-only development recovery, the read-only ordinary-run catalog, and confirmation-gated quiescent run cancellation."
    )
    .replace(
      "Phase 6P PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, approval-gated issue creation, approval-gated project note creation, one-boundary ordinary development continue, read-only development recovery, the read-only ordinary-run catalog, and confirmation-gated quiescent run cancellation.",
      "Phase 7A PPO-routed commands include local menus, GitHub read-only summaries, deterministic Codex text planning, approval-gated issue creation, approval-gated project note creation, controlled ordinary-run start, one-boundary ordinary development continue, read-only development recovery, the read-only ordinary-run catalog, and confirmation-gated quiescent run cancellation."
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
      "- /ppo start <project> - Create one planned ordinary development run. [future]",
      "- /ppo start <project> - Create one planned ordinary development run. [controlled development start]"
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
      "Phase 6M boundary: /ppo continue remains one-boundary Phase 6B-6G development continuation; /ppo recover exposes one Phase 6L read-only recovery observation and never routes production deployment, verification, or rollback."
    )
    .replace(
      "Phase 6M boundary: /ppo continue remains one-boundary Phase 6B-6G development continuation; /ppo recover exposes one Phase 6L read-only recovery observation and never routes production deployment, verification, or rollback.",
      "Phase 6O boundary: /ppo runs and /ppo run expose the Phase 6N read-only ordinary-run catalog; /ppo continue remains one-boundary Phase 6B-6G development continuation; /ppo recover exposes one Phase 6L read-only recovery observation; production deployment, verification, and rollback remain unrouted."
    )
    .replace(
      "Phase 6O boundary: /ppo runs and /ppo run expose the Phase 6N read-only ordinary-run catalog; /ppo continue remains one-boundary Phase 6B-6G development continuation; /ppo recover exposes one Phase 6L read-only recovery observation; production deployment, verification, and rollback remain unrouted.",
      "Phase 6P boundary: /ppo cancel stages and /ppo cancel-confirm consumes a single-use quiescent cancellation request; /ppo runs and /ppo run remain read-only catalog routes; /ppo continue and /ppo recover keep their separate reviewed boundaries; production deployment, verification, and rollback remain unrouted."
    )
    .replace(
      "Phase 6P boundary: /ppo cancel stages and /ppo cancel-confirm consumes a single-use quiescent cancellation request; /ppo runs and /ppo run remain read-only catalog routes; /ppo continue and /ppo recover keep their separate reviewed boundaries; production deployment, verification, and rollback remain unrouted.",
      "Phase 7A boundary: /ppo start creates at most one Phase 6B planned run and never continues automatically; /ppo cancel remains confirmation-gated; /ppo runs and /ppo run remain read-only catalog routes; production deployment, verification, and rollback remain unrouted."
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
        "Supported through /ppo in Phase 7A:",
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
        "- /ppo issue-confirm <request-id> [approved write]",
        "- /ppo note-add <project> <note...> [approval stage]",
        "- /ppo note-confirm <request-id> [approved write]",
        "- /ppo start <project> [controlled development start]",
        "- /ppo runs [read-only development catalog]",
        "- /ppo run <run-id> [read-only development summary]",
        "- /ppo cancel <run-id> [approval stage]",
        "- /ppo cancel-confirm <request-id> [approved quiescent cancellation]",
        "- /ppo continue <run-id> [development]",
        "- /ppo recover <run-id> [read-only development recovery]"
      ].join("\n")
    )
    .replace(
      "Supported through /ppo in Phase 3B:",
      "Supported through /ppo in Phase 7A:"
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
        "- /ppo issue-create stages locally; /ppo issue-confirm can create one approved GitHub issue after single-use confirmation",
        "- /ppo note-add stages locally; /ppo note-confirm can append one approved local project note after single-use confirmation",
        "- /ppo start creates at most one planned Phase 6B development run and never continues automatically",
        "- /ppo runs and /ppo run expose only bounded Phase 6N ordinary-run catalog metadata",
        "- /ppo cancel stages only; /ppo cancel-confirm can cancel one eligible quiescent run after single-use confirmation",
        "- /ppo continue advances one existing ordinary development run through at most one reviewed Phase 6B-6G boundary",
        "- /ppo recover reports one read-only Phase 6L development recovery observation and never repairs, retries, or continues the run"
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
  const strictStart = parseStrictStartArgs(rawProcessArgs);
  const strictRuns = parseStrictRunsArgs(rawProcessArgs);
  const strictRun = parseStrictRunArgs(rawProcessArgs);
  const strictCancelConfirm = parseStrictCancelConfirmArgs(rawProcessArgs);
  const strictCancel = parseStrictCancelArgs(rawProcessArgs);
  const strictContinue = parseStrictContinueArgs(rawProcessArgs);
  const strictRecover = parseStrictRecoverArgs(rawProcessArgs);

  if (strictStart?.ok === true) {
    const result = await handlePpoDevelopmentStartCommand(strictStart.projectId);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (strictRuns?.ok === true) {
    const result = await handlePpoDevelopmentRunsCommand();
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (strictRun?.ok === true) {
    const result = await handlePpoDevelopmentRunCommand(strictRun.runId);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (strictCancelConfirm?.ok === true) {
    const result = await handlePpoDevelopmentCancelConfirmCommand(strictCancelConfirm.requestId);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (strictCancel?.ok === true) {
    const result = await handlePpoDevelopmentCancelCommand(strictCancel.runId);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (strictContinue?.ok === true) {
    const result = await handlePpoDevelopmentContinueCommand(strictContinue.runId, {
      trustedRuntimeProfileProvider: loadDevelopmentContinueRuntimeProfile
    });
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (strictRecover?.ok === true) {
    const result = await handlePpoDevelopmentRecoverCommand(strictRecover.runId);
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (strictStart?.attempted === true) {
    console.log(unsupported("start"));
    process.exitCode = 1;
    return;
  }

  if (strictRuns?.attempted === true) {
    console.log(unsupported("runs"));
    process.exitCode = 1;
    return;
  }

  if (strictRun?.attempted === true) {
    console.log(unsupported("run"));
    process.exitCode = 1;
    return;
  }

  if (strictCancelConfirm?.attempted === true) {
    console.log(unsupported("cancel-confirm"));
    process.exitCode = 1;
    return;
  }

  if (strictCancel?.attempted === true) {
    console.log(unsupported("cancel"));
    process.exitCode = 1;
    return;
  }

  if (strictContinue?.attempted === true) {
    console.log(unsupported(rawProcessArgs[0] || "continue"));
    process.exitCode = 1;
    return;
  }

  if (strictRecover?.attempted === true) {
    console.log(unsupported(rawProcessArgs[0] || "recover"));
    process.exitCode = 1;
    return;
  }

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

  if (command === "note-add") {
    if (isPpoEnvelope(rawProcessArgs)) {
      const result = await handlePpoNoteAddApprovalCommand(payloadAfterCommand(rawProcessArgs, command));
      console.log(result.output);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    const commandArgs = noteAddTerminalArgs(rawProcessArgs);

    if (commandArgs.length < 2) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const [projectId, ...noteArgs] = commandArgs;
    const result = await handleProjectNoteAddCommand(projectId, noteArgs, {
      confirmationValue: process.env.PPO_NOTE_WRITE_CONFIRM
    });
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "note-confirm") {
    if (!isPpoEnvelope(rawProcessArgs)) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const result = await handlePpoNoteConfirmCommand(payloadAfterCommand(rawProcessArgs, command));
    console.log(result.output);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "state-promote") {
    if (isPpoEnvelope(rawProcessArgs)) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    if (args.length !== 3) {
      console.log(unsupported(rawCommand));
      process.exitCode = 1;
      return;
    }

    const [projectId, noteId, field] = args;
    const result = await handleProjectStatePromoteCommand(projectId, noteId, field, {
      confirmationValue: process.env.PPO_PROJECT_STATE_CONFIRM
    });
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
