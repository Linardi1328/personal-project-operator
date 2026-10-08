#!/usr/bin/env node
import { isAbsolute } from "node:path"
import { diagnoseHistoricalReviewRecovery } from "../../local-operator/development-run-state.mjs"

const args = process.argv.slice(2)
const values = new Map()
let valid = args.length === 6
for (let i = 0; i < args.length; i += 2) {
  if (!["--backup-dir", "--run-id", "--events"].includes(args[i]) || values.has(args[i])) valid = false
  values.set(args[i], args[i + 1])
}
const backupDir = values.get("--backup-dir")
const selection = values.get("--events") || ""
if (!valid || !backupDir || !isAbsolute(backupDir) || !/^\d+(,\d+){0,9}$/u.test(selection)) {
  process.stdout.write('{"code":"invalid_diagnostic_request"}\n')
  process.exitCode = 2
} else {
  const result = await diagnoseHistoricalReviewRecovery(values.get("--run-id"), {
    backupDir, eventIndices: selection.split(",").map(Number)
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  // A completed assessment is not an authorization or a claim of valid history.
  process.exitCode = result.code === "diagnostic_complete" ? 0
    : result.code === "invalid_diagnostic_request" ? 2 : 1
}
