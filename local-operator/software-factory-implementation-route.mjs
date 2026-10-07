import {
  readDevelopmentRun
} from "./development-run-state.mjs"
import {
  readSoftwareFactoryDispatchCheckpoint,
  SoftwareFactoryDispatchCheckpointError
} from "./software-factory-dispatch-checkpoint.mjs"
import {
  SoftwareFactoryReadinessError,
  authorizeAntigravityDispatch,
  recordTrustedAntigravityReadiness
} from "./software-factory-antigravity-readiness.mjs"
import {
  executeAntigravityImplementation
} from "./software-factory-antigravity-execution.mjs"

export const SOFTWARE_FACTORY_IMPLEMENTATION_ROUTE_ID = "software-factory-v0-antigravity-implementation-route"

const frontendSignalPattern = /\b(front[- ]?end|ui|ux|browser|css|scss|tailwind|component|page|screen|modal|dialog|form|input|button|cta|layout|responsive|accessibility|aria|keyboard|focus|animation|visual|design|landing|dashboard|navigation|navbar|sidebar|toast|theme|typography|render|dom|playwright|e2e)\b/iu

export class SoftwareFactoryImplementationRouteError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryImplementationRouteError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function routeError(code, safeMessage) {
  return new SoftwareFactoryImplementationRouteError(code, safeMessage)
}

function latestPlanningSummary(run) {
  const evidence = Array.isArray(run?.evidence?.planning) ? run.evidence.planning : []
  return evidence.at(-1)?.summary || ""
}

export function classifySoftwareFactoryImplementationCapability(run) {
  const task = typeof run?.task === "string" ? run.task : ""
  const planning = latestPlanningSummary(run)
  const text = `${task}\n${planning}`
  return frontendSignalPattern.test(text)
    ? "implementation.frontend"
    : "implementation.backend"
}

async function currentCheckpointVersion(runId, options = {}) {
  try {
    const checkpoint = await readSoftwareFactoryDispatchCheckpoint(runId, options)
    return checkpoint.checkpointVersion
  } catch (error) {
    if (error instanceof SoftwareFactoryDispatchCheckpointError && error.code === "FACTORY_CHECKPOINT_NOT_FOUND") {
      return 0
    }
    throw error
  }
}

function blockedResult(run, checkpoint, reason = null) {
  return {
    ok: false,
    outcome: checkpoint?.dispatch?.outcome || "blocked_external",
    reason: reason || checkpoint?.dispatch?.reasonCode || "software_factory_dispatch_blocked",
    run,
    dispatch: checkpoint ? {
      checkpointVersion: checkpoint.checkpointVersion,
      capability: checkpoint.capability,
      workerId: checkpoint.workerId,
      modelClass: checkpoint.modelClass,
      outcome: checkpoint.dispatch.outcome,
      reasonCode: checkpoint.dispatch.reasonCode,
      consumeAttempt: checkpoint.dispatch.consumeAttempt
    } : null
  }
}

function readinessBlockResult(run, capability, checkpoint, error) {
  if (
    error instanceof SoftwareFactoryReadinessError &&
    error.code === "ANTIGRAVITY_AUTHORIZATION_NOT_READY"
  ) {
    return {
      ok: false,
      outcome: "blocked_capacity",
      reason: "antigravity_capacity_not_ready",
      run,
      dispatch: {
        checkpointVersion: checkpoint.checkpointVersion,
        capability,
        workerId: checkpoint.workerId,
        modelClass: checkpoint.modelClass,
        outcome: "blocked_capacity",
        reasonCode: error.code,
        consumeAttempt: false
      }
    }
  }

  if (
    error instanceof SoftwareFactoryReadinessError &&
    [
      "ANTIGRAVITY_EXECUTABLE_UNAVAILABLE",
      "ANTIGRAVITY_READINESS_PROBE_FAILED",
      "ANTIGRAVITY_READINESS_OUTPUT_INVALID"
    ].includes(error.code)
  ) {
    return {
      ok: false,
      outcome: "blocked_external",
      reason: error.code.toLowerCase(),
      run,
      dispatch: {
        checkpointVersion: checkpoint.checkpointVersion,
        capability,
        workerId: checkpoint.workerId,
        modelClass: checkpoint.modelClass,
        outcome: "blocked_external",
        reasonCode: error.code,
        consumeAttempt: false
      }
    }
  }

  throw error
}

async function executeRouteInternal(runId, options = {}) {
  if (!Number.isInteger(options.expectedVersion)) {
    throw routeError(
      "FACTORY_IMPLEMENTATION_EXPECTED_VERSION_REQUIRED",
      "Software factory implementation route requires the exact development run version."
    )
  }

  const run = await readDevelopmentRun(runId, options)
  if (
    run.version !== options.expectedVersion ||
    run.status !== "implementation_in_progress"
  ) {
    throw routeError(
      "FACTORY_IMPLEMENTATION_RUN_STALE",
      "Software factory implementation route no longer matches the current development run."
    )
  }

  const capability = classifySoftwareFactoryImplementationCapability(run)
  const expectedCheckpointVersion = await currentCheckpointVersion(run.runId, options)
  const checkpoint = await recordTrustedAntigravityReadiness({
    runId: run.runId,
    runVersion: run.version,
    capability,
    expectedCheckpointVersion,
    failedAttempts: run.attempts.implementation,
    risk: "normal"
  }, options)

  if (checkpoint.dispatch.outcome !== "ready" || checkpoint.dispatch.consumeAttempt !== true) {
    return blockedResult(run, checkpoint)
  }

  let authorization
  try {
    authorization = await authorizeAntigravityDispatch({
      runId: run.runId,
      runVersion: run.version,
      capability,
      checkpointVersion: checkpoint.checkpointVersion,
      failedAttempts: run.attempts.implementation,
      risk: "normal"
    }, options)
  } catch (error) {
    return readinessBlockResult(run, capability, checkpoint, error)
  }

  return await executeAntigravityImplementation(run.runId, authorization, {
    ...options,
    expectedVersion: run.version
  })
}

export async function executeSoftwareFactoryImplementation(runId, options = {}) {
  try {
    return await executeRouteInternal(runId, options)
  } catch (error) {
    if (
      error instanceof SoftwareFactoryImplementationRouteError ||
      error instanceof SoftwareFactoryDispatchCheckpointError ||
      error instanceof SoftwareFactoryReadinessError
    ) {
      throw error
    }

    throw routeError(
      "FACTORY_IMPLEMENTATION_ROUTE_UNAVAILABLE",
      "Software factory implementation route is unavailable; no raw failure was exposed."
    )
  }
}

export function formatSoftwareFactoryImplementationRouteError(error) {
  if (
    error instanceof SoftwareFactoryImplementationRouteError ||
    error instanceof SoftwareFactoryDispatchCheckpointError ||
    error instanceof SoftwareFactoryReadinessError
  ) {
    return `PPO software factory implementation route error [${error.code}]: ${error.safeMessage}`
  }
  return "PPO software factory implementation route error: unexpected local failure."
}
