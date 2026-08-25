#!/usr/bin/env node

import {
  REVIEW_ORPHAN_RECOVERY_CONFIRMATION
} from "../../local-operator/development-run-state.mjs"
import {
  formatReviewOrphanRecovery,
  formatReviewOrphanRecoveryError,
  recoverReviewOrphan
} from "../../local-operator/development-review-orphan-recovery.mjs"

const [
  runId,
  versionText,
  expectedHeadSha,
  reviewAttemptText,
  ...extra
] = process.argv.slice(2)
const expectedVersion = /^(?:0|[1-9][0-9]*)$/u.test(versionText || "")
  ? Number(versionText)
  : Number.NaN
const expectedReviewAttempt = /^[1-9][0-9]*$/u.test(reviewAttemptText || "")
  ? Number(reviewAttemptText)
  : Number.NaN

if (
  !runId ||
  !expectedHeadSha ||
  extra.length > 0 ||
  !Number.isSafeInteger(expectedVersion) ||
  !Number.isSafeInteger(expectedReviewAttempt)
) {
  process.stderr.write(
    "Usage: recover-phase6f-review-orphan.mjs <run-id> <expected-version> <expected-head-sha> <expected-review-attempt>\n"
  )
  process.exitCode = 2
} else {
  const options = {}

  if (typeof process.env.PPO_WRITE_DATA_DIR === "string" && process.env.PPO_WRITE_DATA_DIR) {
    options.writeDataDir = process.env.PPO_WRITE_DATA_DIR
  }

  try {
    const result = await recoverReviewOrphan({
      runId,
      expectedVersion,
      expectedHeadSha,
      expectedReviewAttempt,
      confirmation: process.env.PPO_PHASE6F_ORPHAN_RECOVERY_CONFIRM
    }, options)

    process.stdout.write(formatReviewOrphanRecovery(result))
  } catch (error) {
    process.stderr.write(`${formatReviewOrphanRecoveryError(error)}\n`)

    if (process.env.PPO_PHASE6F_ORPHAN_RECOVERY_CONFIRM !== REVIEW_ORPHAN_RECOVERY_CONFIRMATION) {
      process.stderr.write(
        `Required confirmation: PPO_PHASE6F_ORPHAN_RECOVERY_CONFIRM=${REVIEW_ORPHAN_RECOVERY_CONFIRMATION}\n`
      )
    }

    process.exitCode = 1
  }
}
