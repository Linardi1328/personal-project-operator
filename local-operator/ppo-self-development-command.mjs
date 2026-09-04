#!/usr/bin/env node

import { fileURLToPath } from "node:url"

import {
  confirmPersonalProjectOperatorSelfDevelopmentRunCancellation,
  continuePersonalProjectOperatorSelfDevelopment,
  formatPersonalProjectOperatorSelfDevelopmentResult,
  inspectPersonalProjectOperatorSelfDevelopment,
  recoverPersonalProjectOperatorSelfDevelopment,
  stagePersonalProjectOperatorSelfDevelopmentRunCancellation,
  startPersonalProjectOperatorSelfDevelopment
} from "./development-self-controller.mjs"
import { DEVELOPMENT_RUN_ID_PATTERN } from "./development-run-id.mjs"
import { PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION } from "./development-self-cancellation.mjs"

function unavailable() {
  return "PPO Self-Development\nStatus: unavailable\nOutcome: invalid_command\n"
}

function exactRunId(value) {
  return typeof value === "string" && DEVELOPMENT_RUN_ID_PATTERN.test(value)
}

export async function handlePpoSelfDevelopmentCommand(args, handlers = {}) {
  const start = handlers.start || startPersonalProjectOperatorSelfDevelopment
  const inspect = handlers.inspect || inspectPersonalProjectOperatorSelfDevelopment
  const continueRun = handlers.continueRun || continuePersonalProjectOperatorSelfDevelopment
  const recover = handlers.recover || recoverPersonalProjectOperatorSelfDevelopment
  const stageCancellation = handlers.stageCancellation || stagePersonalProjectOperatorSelfDevelopmentRunCancellation
  const confirmCancellation = handlers.confirmCancellation || confirmPersonalProjectOperatorSelfDevelopmentRunCancellation

  if (args.length === 1 && args[0] === "start") {
    const result = await start()
    return { ok: result.ok, output: formatPersonalProjectOperatorSelfDevelopmentResult(result, "start") }
  }

  if (args.length === 2 && args[0] === "status" && exactRunId(args[1])) {
    const result = await inspect(args[1])
    return { ok: result.ok, output: formatPersonalProjectOperatorSelfDevelopmentResult(result, "status") }
  }

  if (args.length === 2 && args[0] === "continue" && exactRunId(args[1])) {
    const result = await continueRun(args[1])
    return { ok: result.ok, output: formatPersonalProjectOperatorSelfDevelopmentResult(result, "continue") }
  }

  if (args.length === 2 && args[0] === "recover" && exactRunId(args[1])) {
    const result = await recover(args[1])
    return { ok: result.ok, output: formatPersonalProjectOperatorSelfDevelopmentResult(result, "recover") }
  }

  if (args.length === 2 && args[0] === "cancel" && exactRunId(args[1])) {
    const result = await stageCancellation(args[1])
    return { ok: result.ok, output: formatPersonalProjectOperatorSelfDevelopmentResult(result, "cancel") }
  }

  if (
    args.length === 5 &&
    args[0] === "cancel-confirm" &&
    exactRunId(args[1]) &&
    /^(?:0|[1-9][0-9]{0,2})$/u.test(args[2]) &&
    args[3] === PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION &&
    args[4] === "--local-owner-confirmed"
  ) {
    const result = await confirmCancellation(
      args[1],
      Number(args[2]),
      args[3]
    )
    return { ok: result.ok, output: formatPersonalProjectOperatorSelfDevelopmentResult(result, "cancel-confirm") }
  }

  return { ok: false, output: unavailable() }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await handlePpoSelfDevelopmentCommand(process.argv.slice(2))
  process.stdout.write(result.output)
  process.exitCode = result.ok ? 0 : 1
}
