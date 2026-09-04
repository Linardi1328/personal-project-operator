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
import {
  AUTOMATED_TEST_RUNNER_ID,
  AUTOMATED_TEST_SANDBOX_ID
} from "./development-test-runner.mjs"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD
} from "./github-delivery-agent.mjs"

export const PPO_SELF_DEVELOPMENT_CANCELLATION_ID = "stage-0-local-ppo-self-development-cancellation"
export const PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_ID = "stage-0-local-ppo-self-development-cancellation-policy"
export const PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION = "cancel-personal-project-operator-run"
export const PPO_SELF_DEVELOPMENT_STALE_MERGE_CANCELLATION_CONFIRMATION =
  "cancel-stale-unmerged-personal-project-operator-run"
export const PPO_SELF_DEVELOPMENT_STALE_TEST_ATTEMPT_MIN_AGE_MS = 30 * 60 * 1000
export const PPO_SELF_DEVELOPMENT_STALE_MERGE_STATE_MIN_AGE_MS = 30 * 60 * 1000
export const PPO_SELF_DEVELOPMENT_STALE_TEST_CANCELLATION_REASON =
  "owner_requested_stale_self_test_cancellation"
export const PPO_SELF_DEVELOPMENT_STALE_MERGE_CANCELLATION_REASON =
  "owner_confirmed_stale_unmerged_self_merge_cancellation"

const safePolicyIdPattern = /^[a-z0-9][a-z0-9_.:-]{0,79}$/u
const policyHashPattern = /^[a-f0-9]{64}$/u

const policyBoundary = Object.freeze({
  id: PPO_SELF_DEVELOPMENT_CANCELLATION_POLICY_ID,
  cancellation: PPO_SELF_DEVELOPMENT_CANCELLATION_ID,
  project: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id,
  localOnly: true,
  openClawRoute: false,
  eligibleStatuses: DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES,
  staleTestAttempt: Object.freeze({
    status: "tests_in_progress",
    minimumAgeMs: PPO_SELF_DEVELOPMENT_STALE_TEST_ATTEMPT_MIN_AGE_MS,
    runner: AUTOMATED_TEST_RUNNER_ID,
    sandbox: AUTOMATED_TEST_SANDBOX_ID,
    network: "none"
  }),
  staleMergeState: Object.freeze({
    status: "merge_ready",
    minimumAgeMs: PPO_SELF_DEVELOPMENT_STALE_MERGE_STATE_MIN_AGE_MS,
    agent: GITHUB_DELIVERY_AGENT_ID,
    mergeMethod: PHASE_6G_APPROVED_MERGE_METHOD,
    confirmation: PPO_SELF_DEVELOPMENT_STALE_MERGE_CANCELLATION_CONFIRMATION
  }),
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

function currentTimeMs(options) {
  try {
    const current = typeof options.now === "function" ? options.now() : new Date()
    return current instanceof Date ? current.getTime() : Number.NaN
  } catch {
    return Number.NaN
  }
}

function staleSelfTestAttempt(run, options) {
  if (run.status !== "tests_in_progress" || !Array.isArray(run?.evidence?.test)) {
    return false
  }

  const entry = run.evidence.test.at(-1)
  const metadata = entry?.metadata || {}
  const startedAtMs = typeof metadata.startedAt === "string" && metadata.startedAt.length <= 80
    ? Date.parse(metadata.startedAt)
    : Number.NaN
  const nowMs = currentTimeMs(options)

  return (
    Number.isFinite(nowMs) &&
    Number.isFinite(startedAtMs) &&
    nowMs - startedAtMs >= PPO_SELF_DEVELOPMENT_STALE_TEST_ATTEMPT_MIN_AGE_MS &&
    Number.isInteger(run?.attempts?.test) &&
    run.attempts.test > 0 &&
    entry?.kind === "test" &&
    entry?.source === AUTOMATED_TEST_RUNNER_ID &&
    entry?.sha === run.headSha &&
    metadata.runner === AUTOMATED_TEST_RUNNER_ID &&
    metadata.project === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id &&
    metadata.attempt === run.attempts.test &&
    metadata.implSha === run.headSha &&
    metadata.outcome === "testing_started" &&
    metadata.endedAt === undefined &&
    metadata.sandbox === AUTOMATED_TEST_SANDBOX_ID &&
    metadata.network === "none" &&
    metadata.branch === run.branch &&
    safePolicyIdPattern.test(metadata.policyId || "") &&
    policyHashPattern.test(metadata.policyHash || "") &&
    typeof metadata.workspaceId === "string" &&
    metadata.workspaceId.length > 0 &&
    metadata.workspaceId.length <= 120 &&
    typeof metadata.workspaceRef === "string" &&
    metadata.workspaceRef.length > 0 &&
    metadata.workspaceRef.length <= 160
  )
}

function staleSelfMergeState(run, options) {
  if (run.status !== "merge_ready" || !Array.isArray(run?.evidence?.merge)) {
    return false
  }

  const entry = run.evidence.merge.at(-1)
  const metadata = entry?.metadata || {}
  const observedAt = metadata.outcome === "merge_started" ? metadata.startedAt : metadata.preparedAt
  const observedAtMs = typeof observedAt === "string" && observedAt.length <= 80
    ? Date.parse(observedAt)
    : Number.NaN
  const nowMs = currentTimeMs(options)
  const common = (
    Number.isFinite(nowMs) &&
    Number.isFinite(observedAtMs) &&
    nowMs - observedAtMs >= PPO_SELF_DEVELOPMENT_STALE_MERGE_STATE_MIN_AGE_MS &&
    entry?.kind === "merge" &&
    entry?.source === GITHUB_DELIVERY_AGENT_ID &&
    entry?.sha === run.headSha &&
    metadata.agent === GITHUB_DELIVERY_AGENT_ID &&
    metadata.project === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id &&
    metadata.policyId === PHASE_6G_DELIVERY_POLICY_ID &&
    metadata.policyHash === PHASE_6G_DELIVERY_POLICY_HASH &&
    metadata.implementationSha === run.headSha &&
    Number.isInteger(metadata.prNumber) &&
    metadata.prNumber > 0
  )

  if (!common) {
    return false
  }

  if (metadata.outcome === "merge_started") {
    return (
      metadata.expectedHeadSha === run.headSha &&
      metadata.mergeMethod === PHASE_6G_APPROVED_MERGE_METHOD
    )
  }

  return (
    metadata.outcome === "merge_ready" &&
    metadata.prHeadSha === run.headSha &&
    metadata.branch === run.branch &&
    metadata.base === "main"
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
  const staleTestAttempt = staleSelfTestAttempt(run, options)
  const staleMergeState = staleSelfMergeState(run, options)

  if (statusClass !== "eligible" && !staleTestAttempt && !staleMergeState) {
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
    headSha: run.headSha,
    staleTestAttempt,
    staleMergeState,
    confirmation: staleMergeState
      ? PPO_SELF_DEVELOPMENT_STALE_MERGE_CANCELLATION_CONFIRMATION
      : PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION
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
    ![
      PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION,
      PPO_SELF_DEVELOPMENT_STALE_MERGE_CANCELLATION_CONFIRMATION
    ].includes(confirmation)
  ) {
    return failure("confirmation_required")
  }

  const ready = await inspectCurrent(runId, options)

  if (!ready.ok) {
    return ready
  }

  if (confirmation !== ready.confirmation) {
    return failure("confirmation_required")
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
      reason: ready.staleMergeState
        ? PPO_SELF_DEVELOPMENT_STALE_MERGE_CANCELLATION_REASON
        : ready.staleTestAttempt
          ? PPO_SELF_DEVELOPMENT_STALE_TEST_CANCELLATION_REASON
          : DEVELOPMENT_RUN_CANCELLATION_REASON
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
      headSha: run.headSha,
      staleTestAttempt: ready.staleTestAttempt,
      staleMergeState: ready.staleMergeState
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
    lines.push(`Stale test attempt: ${result.staleTestAttempt === true ? "yes" : "no"}`)
    lines.push(`Stale merge state: ${result.staleMergeState === true ? "yes" : "no"}`)

    if (result.outcome === "cancellation_ready") {
      lines.push(
        `Confirm: ppo-self-development cancel-confirm ${result.runId} ${result.expectedVersion} ${result.confirmation} --local-owner-confirmed`
      )
    }
  }

  return `${lines.join("\n")}\n`
}
