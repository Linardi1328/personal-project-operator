import {
  hasTrustedDevelopmentRunCatalogDiagnostics,
  listDevelopmentRunSummaries
} from "./development-run-catalog.mjs"
import {
  SOFTWARE_FACTORY_MAX_ACTIVE_PROJECTS,
  SOFTWARE_FACTORY_MAX_ACTIVE_RUNS_PER_PROJECT,
  SoftwareFactoryAdmissionError,
  softwareFactoryRunConsumesWip
} from "./software-factory-admission.mjs"
import {
  executeSoftwareFactoryAutonomousRun
} from "./software-factory-autonomous-run.mjs"
import {
  drainSoftwareFactoryObjectiveQueue
} from "./software-factory-queue-drain.mjs"
import {
  readSoftwareFactoryManagerDisposition,
  recordSoftwareFactoryManagerDisposition,
  shouldExecuteSoftwareFactoryManagedRun
} from "./software-factory-manager-disposition.mjs"

export const SOFTWARE_FACTORY_MANAGER_CYCLE_ID = "software-factory-v1-9-manager-cycle"

export class SoftwareFactoryManagerCycleError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryManagerCycleError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function cycleError(code, safeMessage) {
  return new SoftwareFactoryManagerCycleError(code, safeMessage)
}

function normalizeCatalog(catalog) {
  if (
    !catalog ||
    typeof catalog !== "object" ||
    Array.isArray(catalog) ||
    catalog.ok !== true ||
    !Array.isArray(catalog.active) ||
    catalog.code === "catalog_truncated" ||
    !hasTrustedDevelopmentRunCatalogDiagnostics(catalog.diagnostics)
  ) {
    throw cycleError(
      "FACTORY_CYCLE_CATALOG_UNAVAILABLE",
      "Software factory manager cycle requires a complete trusted run catalog."
    )
  }

  const selected = []

  for (const summary of catalog.active) {
    try {
      if (softwareFactoryRunConsumesWip(summary)) {
        selected.push(summary)
      }
    } catch (error) {
      if (error instanceof SoftwareFactoryAdmissionError) {
        throw cycleError(
          "FACTORY_CYCLE_RECOVERY_REQUIRED",
          "Software factory manager cycle stopped because an active run requires recovery or owner inspection."
        )
      }
      throw error
    }
  }

  const projectCounts = new Map()

  for (const summary of selected) {
    const projectId = summary.project
    projectCounts.set(projectId, (projectCounts.get(projectId) || 0) + 1)

    if (projectCounts.get(projectId) > SOFTWARE_FACTORY_MAX_ACTIVE_RUNS_PER_PROJECT) {
      throw cycleError(
        "FACTORY_CYCLE_WIP_INVALID",
        "Software factory manager cycle found more active runs for one project than policy allows."
      )
    }
  }

  if (projectCounts.size > SOFTWARE_FACTORY_MAX_ACTIVE_PROJECTS) {
    throw cycleError(
      "FACTORY_CYCLE_WIP_INVALID",
      "Software factory manager cycle found more active projects than policy allows."
    )
  }

  return selected
}

function boundedRunResult(summary, result, options = {}) {
  return Object.freeze({
    runId: summary.runId,
    projectId: summary.project,
    ok: result?.ok === true,
    outcome: typeof result?.outcome === "string" ? result.outcome : "owner_action_required",
    reason: typeof result?.reason === "string" ? result.reason : null,
    status: typeof result?.run?.status === "string" ? result.run.status : summary.status,
    parked: options.parked === true
  })
}

function boundedQueueResult(result) {
  return Object.freeze({
    ok: result?.ok === true,
    outcome: typeof result?.outcome === "string" ? result.outcome : "owner_action_required",
    reason: typeof result?.reason === "string" ? result.reason : null,
    queueId: typeof result?.queueId === "string" ? result.queueId : null,
    runId: typeof result?.runId === "string" ? result.runId : null
  })
}

export function createSoftwareFactoryManagerCycle(dependencies = {}) {
  const listRuns = dependencies.listRuns || listDevelopmentRunSummaries
  const runFactory = dependencies.runFactory || executeSoftwareFactoryAutonomousRun
  const drainQueue = dependencies.drainQueue || drainSoftwareFactoryObjectiveQueue
  const readDisposition = dependencies.readDisposition || readSoftwareFactoryManagerDisposition
  const recordDisposition = dependencies.recordDisposition || recordSoftwareFactoryManagerDisposition
  const shouldExecute = dependencies.shouldExecute || shouldExecuteSoftwareFactoryManagedRun

  return async function runManagerCycle(options = {}) {
    const catalog = await listRuns(options)
    const active = normalizeCatalog(catalog)
    const runs = []

    let executedRunCount = 0
    let parkedRunCount = 0

    for (const summary of active) {
      let existingDisposition

      try {
        existingDisposition = await readDisposition(summary.runId, summary.version, options)
      } catch {
        throw cycleError(
          "FACTORY_CYCLE_DISPOSITION_UNAVAILABLE",
          "Software factory manager disposition state is unavailable; cycle stopped before repeating managed work."
        )
      }

      const decision = shouldExecute(existingDisposition, options)

      if (decision?.execute !== true) {
        parkedRunCount += 1
        runs.push(boundedRunResult(summary, {
          ok: existingDisposition?.outcome !== "owner_action_required",
          outcome: existingDisposition?.outcome || "owner_action_required",
          reason: existingDisposition?.reason || decision?.reason || "manager_run_parked",
          run: { status: summary.status }
        }, { parked: true }))
        continue
      }

      let result

      try {
        result = await runFactory(summary.runId, options)
      } catch {
        result = {
          ok: false,
          outcome: "owner_action_required",
          reason: "factory_runner_failed"
        }
      }

      executedRunCount += 1
      const bounded = boundedRunResult(summary, result)

      if (
        result?.outcome === "owner_action_required" ||
        result?.outcome === "release_ready" ||
        result?.outcome === "blocked_capacity" ||
        result?.outcome === "blocked_external"
      ) {
        const runVersion = Number.isInteger(result?.run?.version)
          ? result.run.version
          : summary.version
        const status = typeof result?.run?.status === "string"
          ? result.run.status
          : summary.status

        try {
          await recordDisposition({
            runId: summary.runId,
            runVersion,
            projectId: summary.project,
            status,
            outcome: bounded.outcome,
            reason: bounded.reason
          }, options)
        } catch {
          throw cycleError(
            "FACTORY_CYCLE_DISPOSITION_UNAVAILABLE",
            "Software factory manager disposition could not be recorded; cycle stopped to prevent repeated managed work."
          )
        }
      }

      runs.push(bounded)
    }

    let queue

    try {
      queue = boundedQueueResult(await drainQueue(options))
    } catch {
      queue = boundedQueueResult({
        ok: false,
        outcome: "owner_action_required",
        reason: "queue_drain_failed"
      })
    }

    const ownerAction = runs.some((entry) => entry.outcome === "owner_action_required") ||
      queue.outcome === "owner_action_required"
    const releaseReady = runs.some((entry) => entry.outcome === "release_ready") ||
      queue.outcome === "release_ready"
    const blockedCapacity = runs.some((entry) => entry.outcome === "blocked_capacity") ||
      queue.outcome === "blocked_capacity"
    const blockedExternal = runs.some((entry) => entry.outcome === "blocked_external") ||
      queue.outcome === "blocked_external"

    const outcome = ownerAction
      ? "owner_action_required"
      : releaseReady
        ? "release_ready"
        : blockedCapacity
          ? "blocked_capacity"
          : blockedExternal
            ? "blocked_external"
            : runs.length === 0 && queue.outcome === "queue_empty"
              ? "cycle_idle"
              : "cycle_complete"

    return Object.freeze({
      ok: !ownerAction,
      cycleId: SOFTWARE_FACTORY_MANAGER_CYCLE_ID,
      outcome,
      processedRunCount: runs.length,
      executedRunCount,
      parkedRunCount,
      runs: Object.freeze(runs),
      queue
    })
  }
}

const defaultCycle = createSoftwareFactoryManagerCycle()

export function executeSoftwareFactoryManagerCycle(options = {}) {
  return defaultCycle(options)
}

export function formatSoftwareFactoryManagerCycle(result) {
  const lines = [
    "PPO Software Factory Manager Cycle",
    `Outcome: ${result?.outcome || "owner_action_required"}`,
    `Active runs processed: ${Number.isInteger(result?.processedRunCount) ? result.processedRunCount : 0}`,
    `Active runs executed: ${Number.isInteger(result?.executedRunCount) ? result.executedRunCount : 0}`,
    `Active runs parked: ${Number.isInteger(result?.parkedRunCount) ? result.parkedRunCount : 0}`
  ]

  for (const entry of Array.isArray(result?.runs) ? result.runs : []) {
    lines.push(
      "",
      `Run: ${entry.runId}`,
      `Project: ${entry.projectId}`,
      `Run outcome: ${entry.outcome}`,
      `Run status: ${entry.status}`,
      `Run parked: ${entry.parked === true ? "yes" : "no"}`
    )
    if (entry.reason) lines.push(`Run reason: ${entry.reason}`)
  }

  if (result?.queue) {
    lines.push(
      "",
      `Queue outcome: ${result.queue.outcome}`
    )
    if (result.queue.runId) lines.push(`Queued run: ${result.queue.runId}`)
    if (result.queue.reason) lines.push(`Queue reason: ${result.queue.reason}`)
  }

  if (result?.outcome === "release_ready") {
    lines.push("Next: review the release package and explicitly approve merge.")
  } else if (result?.outcome === "blocked_capacity") {
    lines.push("Next: a later manager cycle may resume after worker capacity returns.")
  } else if (result?.outcome === "blocked_external") {
    lines.push("Next: restore the blocked external dependency before a later manager cycle.")
  } else if (result?.outcome === "owner_action_required") {
    lines.push("Next: inspect the recorded run or queue reason before another manager cycle.")
  } else {
    lines.push("Next: no owner scheduling action is required.")
  }

  return lines.join("\n")
}

export function formatSoftwareFactoryManagerCycleError(error) {
  if (error instanceof SoftwareFactoryManagerCycleError) {
    return `PPO software factory manager-cycle error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory manager-cycle error: unexpected local failure."
}

export async function handlePpoSoftwareFactoryManagerCycleCommand(options = {}) {
  try {
    const result = await executeSoftwareFactoryManagerCycle(options)
    return {
      ok: result.ok,
      outcome: result.outcome,
      output: formatSoftwareFactoryManagerCycle(result),
      result
    }
  } catch (error) {
    return {
      ok: false,
      outcome: "owner_action_required",
      output: formatSoftwareFactoryManagerCycleError(error),
      result: null
    }
  }
}
