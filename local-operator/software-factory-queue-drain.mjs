import {
  assessSoftwareFactoryAdmission
} from "./software-factory-admission.mjs"
import {
  listDevelopmentRunSummaries
} from "./development-run-catalog.mjs"
import {
  executeSoftwareFactoryAutonomousRun
} from "./software-factory-autonomous-run.mjs"
import {
  SoftwareFactoryManagerObjectiveError,
  startSoftwareFactoryManagerObjective
} from "./software-factory-manager-objective.mjs"
import {
  claimSoftwareFactoryQueuedObjective,
  completeSoftwareFactoryQueuedObjective,
  listSoftwareFactoryQueuedObjectives,
  releaseSoftwareFactoryQueueClaim
} from "./software-factory-objective-queue.mjs"

export const SOFTWARE_FACTORY_QUEUE_DRAIN_ID = "software-factory-v1-7-queue-drain"

export class SoftwareFactoryQueueDrainError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryQueueDrainError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function drainError(code, safeMessage) {
  return new SoftwareFactoryQueueDrainError(code, safeMessage)
}

export function createSoftwareFactoryQueueDrainer(dependencies = {}) {
  const listQueue = dependencies.listQueue || listSoftwareFactoryQueuedObjectives
  const listRuns = dependencies.listRuns || listDevelopmentRunSummaries
  const claim = dependencies.claim || claimSoftwareFactoryQueuedObjective
  const releaseClaim = dependencies.releaseClaim || releaseSoftwareFactoryQueueClaim
  const complete = dependencies.complete || completeSoftwareFactoryQueuedObjective
  const intake = dependencies.intake || startSoftwareFactoryManagerObjective
  const runFactory = dependencies.runFactory || executeSoftwareFactoryAutonomousRun

  return async function drainSoftwareFactoryQueue(options = {}) {
    const queued = await listQueue(options)

    if (queued.length === 0) {
      return {
        ok: true,
        outcome: "queue_empty",
        queueId: null,
        runId: null
      }
    }

    if (queued.some((item) => item.claimed === true)) {
      return {
        ok: false,
        outcome: "owner_action_required",
        reason: "queue_claim_reconciliation_required",
        queueId: queued.find((item) => item.claimed === true)?.queueId || null,
        runId: null
      }
    }

    const catalog = await listRuns(options)
    let selected = null

    for (const item of queued) {
      const admission = assessSoftwareFactoryAdmission(item.projectId, catalog)
      if (admission.ok) {
        selected = item
        break
      }
    }

    if (!selected) {
      return {
        ok: true,
        outcome: "blocked_work_in_progress",
        queueId: null,
        runId: null
      }
    }

    await claim(selected.queueId, options)

    let intakeResult
    try {
      intakeResult = await intake(selected.projectId, selected.objective, options)
    } catch (error) {
      if (error instanceof SoftwareFactoryManagerObjectiveError && error.code === "FACTORY_OBJECTIVE_WIP_BLOCKED") {
        await releaseClaim(selected.queueId, options)
        return {
          ok: true,
          outcome: "blocked_work_in_progress",
          queueId: selected.queueId,
          runId: null
        }
      }

      if (typeof error?.runId === "string" && error.runId) {
        await complete(selected.queueId, {
          outcome: "owner_action_required",
          runId: error.runId,
          reason: "manager_intake_failed_after_run_creation"
        }, options)
        return {
          ok: false,
          outcome: "owner_action_required",
          reason: "manager_intake_failed_after_run_creation",
          queueId: selected.queueId,
          runId: error.runId
        }
      }

      await releaseClaim(selected.queueId, options)
      throw drainError(
        "FACTORY_QUEUE_DRAIN_INTAKE_FAILED",
        "Queued objective could not be admitted safely; no development run was created."
      )
    }

    let factoryResult
    try {
      factoryResult = await runFactory(intakeResult.runId, options)
    } catch {
      await complete(selected.queueId, {
        outcome: "owner_action_required",
        runId: intakeResult.runId,
        reason: "factory_runner_failed_after_intake"
      }, options)
      return {
        ok: false,
        outcome: "owner_action_required",
        reason: "factory_runner_failed_after_intake",
        queueId: selected.queueId,
        runId: intakeResult.runId
      }
    }

    await complete(selected.queueId, {
      outcome: factoryResult.outcome || "owner_action_required",
      runId: intakeResult.runId,
      reason: factoryResult.reason || null
    }, options)

    return {
      ok: factoryResult.ok,
      outcome: factoryResult.outcome,
      reason: factoryResult.reason || null,
      queueId: selected.queueId,
      runId: intakeResult.runId,
      intake: intakeResult,
      factory: factoryResult
    }
  }
}

const defaultDrainer = createSoftwareFactoryQueueDrainer()

export function drainSoftwareFactoryObjectiveQueue(options = {}) {
  return defaultDrainer(options)
}

export function formatSoftwareFactoryQueueDrain(result) {
  const lines = [
    "PPO Software Factory Queue Drain",
    `Outcome: ${result.outcome || "unknown"}`
  ]
  if (result.queueId) lines.push(`Queue: ${result.queueId}`)
  if (result.runId) lines.push(`Run: ${result.runId}`)
  if (result.reason) lines.push(`Reason: ${result.reason}`)

  if (result.outcome === "queue_empty") {
    lines.push("Next: no queued objective is waiting.")
  } else if (result.outcome === "blocked_work_in_progress") {
    lines.push("Next: queue remains parked until a Software Factory WIP slot becomes available.")
  } else if (result.outcome === "release_ready") {
    lines.push("Next: review the release package and explicitly approve merge.")
  } else if (result.outcome === "blocked_capacity") {
    lines.push(`Next: resume the durable run with /ppo factory-run ${result.runId} after worker capacity returns.`)
  } else if (result.outcome === "owner_action_required") {
    lines.push("Next: inspect the recorded run or queue claim before retrying.")
  }

  return lines.join("\n")
}

export function formatSoftwareFactoryQueueDrainError(error) {
  if (error instanceof SoftwareFactoryQueueDrainError) {
    return `PPO software factory queue-drain error [${error.code}]: ${error.safeMessage}`
  }
  return "PPO software factory queue-drain error: unexpected local failure."
}

export async function handlePpoSoftwareFactoryQueueDrainCommand(options = {}) {
  try {
    const result = await drainSoftwareFactoryObjectiveQueue(options)
    return {
      ok: result.ok,
      outcome: result.outcome,
      runId: result.runId || null,
      queueId: result.queueId || null,
      output: formatSoftwareFactoryQueueDrain(result)
    }
  } catch (error) {
    return {
      ok: false,
      outcome: "owner_action_required",
      runId: null,
      queueId: null,
      output: formatSoftwareFactoryQueueDrainError(error)
    }
  }
}
