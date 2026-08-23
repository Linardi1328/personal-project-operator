import { createHash } from "node:crypto"
import { DEVELOPMENT_RUN_ID_PATTERN } from "./development-run-id.mjs"
import {
  executeDevelopmentRecovery,
  formatDevelopmentRecoveryResult
} from "./development-recovery-coordinator.mjs"

export const DEVELOPMENT_RECOVERY_ROUTE_ID = "phase-6m-controlled-development-recovery-route"
export const PHASE_6M_RECOVERY_ROUTE_POLICY_ID = "phase-6m-controlled-development-recovery-route-policy"

const routePolicy = Object.freeze({
  id: PHASE_6M_RECOVERY_ROUTE_POLICY_ID,
  route: DEVELOPMENT_RECOVERY_ROUTE_ID,
  callerInput: Object.freeze(["runId"]),
  engine: "phase-6l-readonly-development-recovery-coordinator",
  readOnly: true,
  autoContinue: false,
  mutationActions: false,
  productionActions: false
})

export const PHASE_6M_RECOVERY_ROUTE_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(routePolicy))
  .digest("hex")

function invalidRecoveryRouteResult(runId = "unknown") {
  return {
    schemaVersion: 1,
    coordinator: DEVELOPMENT_RECOVERY_ROUTE_ID,
    policyId: PHASE_6M_RECOVERY_ROUTE_POLICY_ID,
    policyHash: PHASE_6M_RECOVERY_ROUTE_POLICY_HASH,
    ok: false,
    run: {
      runId: DEVELOPMENT_RUN_ID_PATTERN.test(String(runId || "")) ? runId : "unknown",
      project: "unknown",
      version: null,
      status: "unknown",
      headSha: null
    },
    phase: "none",
    operation: "none",
    outcome: "recovery_unavailable",
    observation: "malformed_child_result",
    ownerActionRequired: true,
    continuationCandidate: false
  }
}

function normalizeRouteRunId(runId) {
  if (
    typeof runId !== "string" ||
    runId !== runId.trim() ||
    /[\r\n\t\u0000-\u001F\u007F]/u.test(runId) ||
    !DEVELOPMENT_RUN_ID_PATTERN.test(runId)
  ) {
    throw new Error("INVALID_RECOVERY_RUN_ID")
  }

  return runId
}

export async function handlePpoDevelopmentRecoverCommand(runId, options = {}) {
  let normalizedRunId

  try {
    normalizedRunId = normalizeRouteRunId(runId)
  } catch {
    const result = invalidRecoveryRouteResult(runId)
    return {
      ok: false,
      result,
      output: formatDevelopmentRecoveryResult(result)
    }
  }

  const executeRecovery = options.executeDevelopmentRecoveryImpl || executeDevelopmentRecovery
  const formatRecovery = options.formatDevelopmentRecoveryResultImpl || formatDevelopmentRecoveryResult

  try {
    const result = await executeRecovery(normalizedRunId, options.recoveryCoordinatorOptions || {})

    return {
      ok: result?.ok === true,
      result,
      output: formatRecovery(result)
    }
  } catch {
    const result = invalidRecoveryRouteResult(normalizedRunId)

    return {
      ok: false,
      result,
      output: formatRecovery(result)
    }
  }
}
