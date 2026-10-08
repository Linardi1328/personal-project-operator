#!/usr/bin/env node
import { isAbsolute } from "node:path"
import { diagnoseDevelopmentRunHistory } from "../../local-operator/development-run-state.mjs"
import { diagnoseDevelopmentRunCatalog } from "../../local-operator/development-run-catalog.mjs"
import { inspectDevelopmentRunRetirement } from "../../local-operator/development-run-retirement.mjs"

// Explicit path only: do not implicitly inspect a live/default runtime store.
const args = process.argv.slice(2)
const allowed = new Set(["--write-data-dir", "--run-id", "--retirement-run"])
const values = new Map()
let valid = args.length > 0 && args.length % 2 === 0
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]) || values.has(args[i]) || !args[i + 1]) valid = false
  values.set(args[i], args[i + 1])
}
const root = values.get("--write-data-dir")
if (!valid || !root || !isAbsolute(root) || (values.has("--run-id") && values.has("--retirement-run"))) {
  process.stderr.write("Usage: node deployment/scripts/diagnose-ppo-runs.mjs --write-data-dir ABSOLUTE_PRIVATE_BACKUP [--run-id RUN_ID | --retirement-run RUN_ID]\n")
  process.exitCode = 2
} else {
  try {
    const options = { writeDataDir: root }
    const result = values.has("--run-id")
      ? await diagnoseDevelopmentRunHistory(values.get("--run-id"), options)
      : values.has("--retirement-run")
        ? await inspectDevelopmentRunRetirement(values.get("--retirement-run"), options)
        : await diagnoseDevelopmentRunCatalog(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch {
    process.stdout.write('{"ok":false,"code":"diagnostic_unavailable"}\n')
    process.exitCode = 1
  }
}
