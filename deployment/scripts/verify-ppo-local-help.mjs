#!/usr/bin/env node
import { runPpoLocalTool } from "../../openclaw/plugins/ppo-local/bridge.mjs"

const result = await runPpoLocalTool({ command: "help" })

if (
  result.ok !== true ||
  result.exitCode !== 0 ||
  !Array.isArray(result.wrapperArgs) ||
  result.wrapperArgs.join(" ") !== "help" ||
  typeof result.stdout !== "string" ||
  !result.stdout.includes("Personal Project Operator")
) {
  process.exit(1)
}
