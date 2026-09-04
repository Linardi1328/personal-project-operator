import { createHash } from "node:crypto"
import {
  DEVELOPMENT_RUN_ID_PATTERN,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  inspectDevelopmentRunReadOnly,
  transitionPersonalProjectOperatorSelfDevelopmentRun
} from "./development-run-state.mjs"
import {
  DEVELOPMENT_RUN_CANCELLATION_ACTOR,
  DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES,
  DEVELOPMENT_RUN_CANCELLATION_REASON,
  classifyDevelopmentRunCancellationStatus
} from "./development-run-cancellation.mjs"

export const PPO_SELF_DEVELOPMENT_CANCELLATION_ID = "stage-0-local-ppo-self-development-cancellation"
export const PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_ID = "stage-0-local-ppo-self-development-cancellation-policy"
export const PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION = "cancel-personal-project-operator-run"

const policyBoundary = Object.freeze({
  id: PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_ID,
  cancellation: PPO_SELF_DEVELOPMENT_CANCELLATION_ID,
  project: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id,
  localOnly: true,
  openClawRoute: false,
  eligibleStatuses: DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES,
  confirmation: PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION,
  expectedVersionRequired: true,
  targetStatus: "cancelled",
  cleanup: false,
  processInterruption: false,
  githubActions: false,
  productionActions: false
})

export const PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(policyBoundary))
  .digest("hex")

function failure(code) {
  return {
    cancellation: PPO_SELF_DEVELOPMENT_CANCELLATION_ID,
    policyId: PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_ID,
    policyHash: PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_HASH,
    ok: false,
    outcome: code
  }
}

function validSelfRecord(record) {
  const expected = PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT

  return (
    record?.project?.id === expected.id &&
    record.project.displayName === expected.displayName &&
    record.project.owner === expected.owner &&
    record.project.repo === expected.repo &&
    record.project.fullName === expected.fullName
  )
}

async function inspectCurrent(runId, options = {}) {
  if (typeof runId !== "string" || !DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    return failure("invalid_run_id")
  }

  const inspector = options.inspectRun || inspectDevelopmentRunReadOnly
  let inspected

  try {
    inspected = await inspector(runId, {
      ...options,
      allowPersonalProjectOperatorSelfDevelopmentProject: true
    })
  } catch {
    return failure("cancellation_unavailable")
  }

  if (!inspected?.ok || inspected.canonicalState !== "canonical_current") {
    return failure(inspected?.recoveryRequired ? "canonical_recovery_required" : "run_unavailable")
  }

  const run = inspected.record

  if (!validSelfRecord(run)) {
    return failure("project_refused")
  }

  const statusClass = classifyDevelopmentRunCancellationStatus(run.status)

  if (statusClass !== "eligible") {
    return failure(statusClass)
  }

  return {
    cancellation: PPO_SELF_DEVELOPMENT_CANCELLATION_ID,
    policyId: PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_ID,
    policyHash: PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_HASH,
    ok: true,
    outcome: "cancellation_ready",
    runId: run.runId,
    project: run.project.id,
    beforeStatus: run.status,
    expectedVersion: run.version,
    headSha: run.headSha
  }
}

export async function stagePersonalProjectOperatorSelfDevelopmentCancellation(runId, options = {}) {
  return await inspectCurrent(runId, options)
}

export async function confirmPersonalProjectOperatorSelfDevelopmentCancellation(
  runId,
  expectedVersion,
  confirmation,
  options = {}
) {
  if (
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    confirmation !== PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION
  ) {
    return failure("confirmation_required")
  }

  const ready = await inspectCurrent(runId, options)

  if (!ready.ok) {
    return ready
  }

  if (ready.expectedVersion !== expectedVersion) {
    return failure("stale_state")
  }

  try {
    const transition = options.transitionRun || transitionPersonalProjectOperatorSelfDevelopmentRun
    const run = await transition(runId, {
      expectedVersion,
      status: "cancelled",
      actor: DEVELOPMENT_RUN_CANCELLATION_ACTOR,
      reason: DEVELOPMENT_RUN_CANCELLATION_REASON
    }, options)

    return {
      cancellation: PPO_SELF_DEVELOPMENT_CANCELLATION_ID,
      policyId: PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_ID,
      policyHash: PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_HASH,
      ok: true,
      outcome: "cancelled",
      runId: run.runId,
      project: run.project.id,
      beforeStatus: ready.beforeStatus,
      afterStatus: run.status,
      beforeVersion: expectedVersion,
      afterVersion: run.version,
      headSha: run.headSha
    }
  } catch (error) {
    return failure(error?.code === "STALE_RUN_VERSION" ? "stale_state" : "cancellation_unavailable")
  }
}

export function formatPersonalProjectOperatorSelfDevelopmentCancellation(result) {
  const lines = [
    "PPO Self-Development Cancellation",
    `Status: ${result?.ok === true ? result.outcome : "unavailable"}`,
    `Outcome: ${result?.outcome || "cancellation_unavailable"}`
  ]

  if (result?.ok === true) {
    lines.push(`Run: ${result.runId}`)
    lines.push(`Project: ${result.project}`)
    lines.push(`Before: ${result.beforeStatus}`)
    lines.push(`Version: ${result.expectedVersion ?? `${result.beforeVersion} -> ${result.afterVersion}`}`)
    lines.push(`Head: ${result.headSha || "none"}`)

    if (result.outcome === "cancellation_ready") {
      lines.push(
        `Confirm: ppo-self-development cancel-confirm ${result.runId} ${result.expectedVersion} ${PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION} --local-owner-confirmed`
      )
    }
  }

  return `${lines.join("\n")}\n`
}
