#!/usr/bin/env node

import {
  REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION,
} from "../../local-operator/development-run-state.mjs"
import {
  formatReviewRuntimeFailureRecovery,
  formatReviewRuntimeFailureRecoveryError,
  recoverReviewRuntimeFailure
} from "../../local-operator/development-review-retry-recovery.mjs"

const [runId, versionText, expectedHeadSha, ...extra] = process.argv.slice(2)
const expectedVersion = /^(?:0|[1-9][0-9]*)$/u.test(versionText || "")
  ? Number(versionText)
  : Number.NaN

if (!runId || !expectedHeadSha || extra.length > 0 || !Number.isSafeInteger(expectedVersion)) {
  process.stderr.write(
    "Usage: recover-phase6f-review-runtime-failure.mjs <run-id> <expected-version> <expected-head-sha>\n"
  )
  process.exitCode = 2
} else {
  const options = {}

  if (typeof process.env.PPO_WRITE_DATA_DIR === "string" && process.env.PPO_WRITE_DATA_DIR) {
    options.writeDataDir = process.env.PPO_WRITE_DATA_DIR
  }

  try {
    const result = await recoverReviewRuntimeFailure({
      runId,
      expectedVersion,
      expectedHeadSha,
      confirmation: process.env.PPO_PHASE6F_REVIEW_RETRY_CONFIRM
    }, options)

    process.stdout.write(formatReviewRuntimeFailureRecovery(result))
  } catch (error) {
    process.stderr.write(`${formatReviewRuntimeFailureRecoveryError(error)}\n`)

    if (process.env.PPO_PHASE6F_REVIEW_RETRY_CONFIRM !== REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION) {
      process.stderr.write(
        `Required confirmation: PPO_PHASE6F_REVIEW_RETRY_CONFIRM=${REVIEW_RUNTIME_FAILURE_RECOVERY_CONFIRMATION}\n`
      )
    }

    process.exitCode = 1
  }
}
