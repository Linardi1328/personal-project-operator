import { createHash } from "node:crypto"
import {
  DEVELOPMENT_RUN_ID_PATTERN,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  inspectDevelopmentRunReadOnly
} from "./development-run-state.mjs"
import {
  createPlannedPersonalProjectOperatorSelfDevelopmentRun
} from "./development-next-stage-planner.mjs"
import {
  executePersonalProjectOperatorSelfDevelopmentContinue,
  formatPersonalProjectOperatorSelfDevelopmentContinueResult
} from "./development-continue-orchestrator.mjs"
import {
  loadPersonalProjectOperatorSelfDevelopmentRuntimeProfile
} from "./development-continue-runtime-profile.mjs"
import {
  executePersonalProjectOperatorSelfDevelopmentRecovery,
  formatPersonalProjectOperatorSelfDevelopmentRecoveryResult
} from "./development-recovery-coordinator.mjs"
import { safeDevelopmentBuildSummary } from "./development-build-summary.mjs"
import {
  confirmPersonalProjectOperatorSelfDevelopmentCancellation,
  formatPersonalProjectOperatorSelfDevelopmentCancellation,
  stagePersonalProjectOperatorSelfDevelopmentCancellation
} from "./development-self-cancellation.mjs"

export const PPO_SELF_DEVELOPMENT_CONTROLLER_ID = "stage-0-local-ppo-self-development-controller"
export const PPO_SELF_DEVELOPMENT_CONTROLLER_POLICY_ID = "stage-0-local-ppo-self-development-policy"
export const MAX_PPO_SELF_DEVELOPMENT_OUTPUT_CHARS = 4096

const policyBoundary = Object.freeze({
  id: PPO_SELF_DEVELOPMENT_CONTROLLER_POLICY_ID,
  controller: PPO_SELF_DEVELOPMENT_CONTROLLER_ID,
  project: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id,
  repository: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.fullName,
  localOnly: true,
  openClawRoute: false,
  publicCommand: false,
  startInput: Object.freeze([]),
  runInput: Object.freeze(["runId"]),
  maximumStatus: "merged",
  productionActions: false,
  arbitraryRepository: false,
  arbitraryRuntime: false,
  arbitraryPolicy: false
})

export const PPO_SELF_DEVELOPMENT_CONTROLLER_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(policyBoundary))
  .digest("hex")

function safeRunId(runId) {
  return typeof runId === "string" && DEVELOPMENT_RUN_ID_PATTERN.test(runId) ? runId : "unknown"
}

function safeSha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : null
}

function baseResult(fields) {
  return {
    controller: PPO_SELF_DEVELOPMENT_CONTROLLER_ID,
    policyId: PPO_SELF_DEVELOPMENT_CONTROLLER_POLICY_ID,
    policyHash: PPO_SELF_DEVELOPMENT_CONTROLLER_POLICY_HASH,
    ...fields
  }
}

function unavailableResult(runId = "unknown", reason = "controller_unavailable") {
  return baseResult({
    ok: false,
    outcome: "owner_action_required",
    reason,
    runId: safeRunId(runId),
    project: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id,
    status: "unavailable",
    headSha: null,
    buildSummary: null
  })
}

function validSelfRun(run) {
  return (
    run?.project?.id === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id &&
    run.project.fullName === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.fullName &&
    DEVELOPMENT_RUN_ID_PATTERN.test(run.runId)
  )
}

export async function startPersonalProjectOperatorSelfDevelopment(options = {}) {
  try {
    const planner = options.createPlannedRun || createPlannedPersonalProjectOperatorSelfDevelopmentRun
    const result = await planner(options)
    const run = result?.run

    if (
      result?.ok !== true ||
      result.outcome !== "planned" ||
      !validSelfRun(run) ||
      run.status !== "planned" ||
      run.baseSha !== run.headSha
    ) {
      return unavailableResult("unknown", result?.plan?.reasonCode?.toLowerCase() || "planning_not_ready")
    }

    return baseResult({
      ok: true,
      outcome: "planned",
      reason: null,
      runId: run.runId,
      project: run.project.id,
      status: run.status,
      headSha: safeSha(run.headSha),
      buildSummary: safeDevelopmentBuildSummary(run.task)
    })
  } catch {
    return unavailableResult()
  }
}

export async function inspectPersonalProjectOperatorSelfDevelopment(runId, options = {}) {
  if (safeRunId(runId) === "unknown") {
    return unavailableResult(runId, "invalid_run_id")
  }

  try {
    const inspector = options.inspectRun || inspectDevelopmentRunReadOnly
    const inspected = await inspector(runId, {
      ...options,
      allowPersonalProjectOperatorSelfDevelopmentProject: true
    })

    if (!inspected?.ok || inspected.canonicalState !== "canonical_current") {
      return unavailableResult(
        runId,
        inspected?.recoveryRequired ? "canonical_recovery_required" : "run_unavailable"
      )
    }

    const run = inspected.record

    if (!validSelfRun(run)) {
      return unavailableResult(runId, "project_refused")
    }

    return baseResult({
      ok: true,
      outcome: ["merged", "verified", "cancelled", "failed"].includes(run.status) ? "complete" : "active",
      reason: null,
      runId: run.runId,
      project: run.project.id,
      status: run.status,
      headSha: safeSha(run.headSha),
      buildSummary: safeDevelopmentBuildSummary(run.task)
    })
  } catch {
    return unavailableResult(runId, "run_unavailable")
  }
}

export async function continuePersonalProjectOperatorSelfDevelopment(runId, options = {}) {
  const trustedRuntimeProfileProvider = options.trustedRuntimeProfileProvider || (async (request) => (
    await loadPersonalProjectOperatorSelfDevelopmentRuntimeProfile(request, {
      platform: options.platform
    })
  ))

  return await executePersonalProjectOperatorSelfDevelopmentContinue(runId, {
    ...options,
    trustedRuntimeProfileProvider
  })
}

export async function recoverPersonalProjectOperatorSelfDevelopment(runId, options = {}) {
  return await executePersonalProjectOperatorSelfDevelopmentRecovery(runId, options)
}

export async function stagePersonalProjectOperatorSelfDevelopmentRunCancellation(runId, options = {}) {
  return await stagePersonalProjectOperatorSelfDevelopmentCancellation(runId, options)
}

export async function confirmPersonalProjectOperatorSelfDevelopmentRunCancellation(
  runId,
  expectedVersion,
  confirmation,
  options = {}
) {
  return await confirmPersonalProjectOperatorSelfDevelopmentCancellation(
    runId,
    expectedVersion,
    confirmation,
    options
  )
}

export function formatPersonalProjectOperatorSelfDevelopmentResult(result, action = "status") {
  if (action === "continue") {
    return formatPersonalProjectOperatorSelfDevelopmentContinueResult(result)
  }

  if (action === "recover") {
    return formatPersonalProjectOperatorSelfDevelopmentRecoveryResult(result)
  }

  if (action === "cancel" || action === "cancel-confirm") {
    return formatPersonalProjectOperatorSelfDevelopmentCancellation(result)
  }

  const lines = [
    action === "start" ? "PPO Self-Development Start" : "PPO Self-Development Status",
    `Run: ${result.runId || "unknown"}`,
    `Project: ${result.project || PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id}`,
    `Status: ${result.status || "unavailable"}`,
    `Outcome: ${result.outcome || "owner_action_required"}`,
    `Head: ${result.headSha || "none"}`
  ]
  const buildSummary = safeDevelopmentBuildSummary(result.buildSummary)

  if (buildSummary) {
    lines.splice(3, 0, `Build summary: ${buildSummary}`)
  }

  if (result.reason) {
    lines.push(`Reason: ${result.reason}`)
  }

  if (action === "start" && result.ok === true) {
    lines.push(`Next command: ppo-self-development continue ${result.runId}`)
  }

  return `${lines.join("\n").slice(0, MAX_PPO_SELF_DEVELOPMENT_OUTPUT_CHARS)}\n`
}

export function personalProjectOperatorSelfDevelopmentControllerPolicy() {
  return {
    id: PPO_SELF_DEVELOPMENT_CONTROLLER_POLICY_ID,
    hash: PPO_SELF_DEVELOPMENT_CONTROLLER_POLICY_HASH
  }
}
