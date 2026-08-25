#!/usr/bin/env node

import {
  CODEX_NO_CHANGE_RECOVERY_CONFIRMATION,
  formatCodexNoChangeRecovery,
  formatCodexNoChangeRecoveryError,
  recoverCodexNoChangeRun
} from "../../local-operator/development-codex-no-change-recovery.mjs"

const [runId, versionText, expectedHeadSha, attemptText, ...extra] = process.argv.slice(2)
const expectedVersion = /^(?:0|[1-9][0-9]*)$/u.test(versionText || "")
  ? Number(versionText)
  : Number.NaN
const expectedAttempt = /^[1-9][0-9]*$/u.test(attemptText || "")
  ? Number(attemptText)
  : Number.NaN

if (
  !runId ||
  !expectedHeadSha ||
  extra.length > 0 ||
  !Number.isSafeInteger(expectedVersion) ||
  !Number.isSafeInteger(expectedAttempt)
) {
  process.stderr.write(
    "Usage: recover-phase6d-codex-no-change.mjs <run-id> <expected-version> <expected-head-sha> <expected-attempt>\n"
  )
  process.exitCode = 2
} else {
  const options = {}

  if (typeof process.env.PPO_WRITE_DATA_DIR === "string" && process.env.PPO_WRITE_DATA_DIR) {
    options.writeDataDir = process.env.PPO_WRITE_DATA_DIR
  }

  try {
    const result = await recoverCodexNoChangeRun({
      runId,
      expectedVersion,
      expectedHeadSha,
      expectedAttempt,
      confirmation: process.env.PPO_PHASE6D_NO_CHANGE_RECOVERY_CONFIRM
    }, options)

    process.stdout.write(formatCodexNoChangeRecovery(result))
  } catch (error) {
    process.stderr.write(`${formatCodexNoChangeRecoveryError(error)}\n`)

    if (
      process.env.PPO_PHASE6D_NO_CHANGE_RECOVERY_CONFIRM !==
      CODEX_NO_CHANGE_RECOVERY_CONFIRMATION
    ) {
      process.stderr.write(
        `Required confirmation: PPO_PHASE6D_NO_CHANGE_RECOVERY_CONFIRM=${CODEX_NO_CHANGE_RECOVERY_CONFIRMATION}\n`
      )
    }

    process.exitCode = 1
  }
}
