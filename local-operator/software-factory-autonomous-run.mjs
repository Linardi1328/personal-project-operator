import {
  DEVELOPMENT_RUN_ID_PATTERN,
  readDevelopmentRun
} from "./development-run-state.mjs"
import {
  executeDevelopmentContinue
} from "./development-continue-orchestrator.mjs"
import {
  buildSoftwareFactoryReleasePackageFromRun,
  formatSoftwareFactoryReleasePackage
} from "./software-factory-release-package.mjs"

export const SOFTWARE_FACTORY_AUTONOMOUS_RUNNER_ID = "software-factory-v0-6-autonomous-runner"
export const SOFTWARE_FACTORY_AUTONOMOUS_MAX_STEPS = 16

const terminalStatuses = new Set(["cancelled", "failed"])
const completeStatuses = new Set(["merged", "verified"])
const productionStatuses = new Set([
  "deploy_in_progress",
  "deploy_failed",
  "deployed",
  "verification_in_progress",
  "verification_failed",
  "rollback_in_progress",
  "rollback_failed",
  "rolled_back"
])

export class SoftwareFactoryAutonomousRunError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryAutonomousRunError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function runnerError(code, safeMessage) {
  return new SoftwareFactoryAutonomousRunError(code, safeMessage)
}

function normalizeRunId(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !DEVELOPMENT_RUN_ID_PATTERN.test(value)
  ) {
    throw runnerError(
      "FACTORY_RUN_INVALID_RUN_ID",
      "Software factory autonomous run requires one opaque development run id."
    )
  }

  return value
}

function normalizeMaxSteps(value) {
  if (value === undefined || value === null) {
    return SOFTWARE_FACTORY_AUTONOMOUS_MAX_STEPS
  }

  if (!Number.isInteger(value) || value < 1 || value > SOFTWARE_FACTORY_AUTONOMOUS_MAX_STEPS) {
    throw runnerError(
      "FACTORY_RUN_INVALID_STEP_LIMIT",
      "Software factory autonomous step limit is invalid."
    )
  }

  return value
}

function snapshot(run) {
  return {
    runId: run.runId,
    version: run.version,
    status: run.status,
    projectId: run.project?.id || "unknown",
    headSha: run.headSha || run.baseSha || null,
    task: run.task || null
  }
}

function finalResult({
  ok,
  outcome,
  reason = null,
  run,
  steps,
  history
}) {
  return {
    ok,
    runnerId: SOFTWARE_FACTORY_AUTONOMOUS_RUNNER_ID,
    outcome,
    reason,
    run: snapshot(run),
    stepCount: steps,
    history
  }
}

function preflightStop(run, steps, history) {
  if (run.status === "merge_ready") {
    return finalResult({
      ok: true,
      outcome: "release_ready",
      reason: "human_release_approval_required",
      run,
      steps,
      history
    })
  }

  if (completeStatuses.has(run.status)) {
    return finalResult({
      ok: true,
      outcome: "complete",
      run,
      steps,
      history
    })
  }

  if (terminalStatuses.has(run.status)) {
    return finalResult({
      ok: false,
      outcome: "terminal",
      reason: `run_${run.status}`,
      run,
      steps,
      history
    })
  }

  if (productionStatuses.has(run.status)) {
    return finalResult({
      ok: false,
      outcome: "owner_action_required",
      reason: "production_workflow_outside_factory_runner",
      run,
      steps,
      history
    })
  }

  return null
}

function historyEntry(step, before, result, after) {
  return {
    step,
    beforeStatus: before.status,
    beforeVersion: before.version,
    action: result.action || "none",
    outcome: result.outcome || "unknown",
    reason: result.reason || null,
    afterStatus: after.status,
    afterVersion: after.version,
    headSha: after.headSha || after.baseSha || null
  }
}

function progressKey(entry) {
  return [
    entry.beforeStatus,
    entry.beforeVersion,
    entry.action,
    entry.outcome,
    entry.reason || "",
    entry.afterStatus,
    entry.afterVersion
  ].join("|")
}

export function createSoftwareFactoryAutonomousRunner(dependencies = {}) {
  const readRunImpl = dependencies.readRun || readDevelopmentRun
  const continueImpl = dependencies.continueRun || executeDevelopmentContinue
  const releasePackageImpl = dependencies.buildReleasePackage || buildSoftwareFactoryReleasePackageFromRun

  return async function runSoftwareFactoryAutonomously(runId, options = {}) {
    const normalizedRunId = normalizeRunId(runId)
    const maxSteps = normalizeMaxSteps(options.maxSteps)
    const history = []
    const seen = new Set()
    let staleRetryUsed = false

    for (let step = 0; step < maxSteps; step += 1) {
      const before = await readRunImpl(normalizedRunId, options)
      const stop = preflightStop(before, history.length, history)

      if (stop) {
        return stop.outcome === "release_ready"
          ? {
              ...stop,
              releasePackage: await releasePackageImpl(before)
            }
          : stop
      }

      const result = await continueImpl(normalizedRunId, options)
      const after = await readRunImpl(normalizedRunId, options)
      const entry = historyEntry(step + 1, before, result, after)
      history.push(entry)

      const postStop = preflightStop(after, history.length, history)
      if (postStop) {
        return postStop.outcome === "release_ready"
          ? {
              ...postStop,
              releasePackage: await releasePackageImpl(after)
            }
          : postStop
      }

      if (result.outcome === "stale_state") {
        if (staleRetryUsed) {
          return finalResult({
            ok: false,
            outcome: "owner_action_required",
            reason: "repeated_stale_state",
            run: after,
            steps: history.length,
            history
          })
        }

        staleRetryUsed = true
        continue
      }

      staleRetryUsed = false

      if (result.outcome === "blocked_capacity") {
        return finalResult({
          ok: false,
          outcome: "blocked_capacity",
          reason: result.reason || "worker_capacity_blocked",
          run: after,
          steps: history.length,
          history
        })
      }

      if (result.outcome === "blocked_external") {
        return finalResult({
          ok: false,
          outcome: "blocked_external",
          reason: result.reason || "external_dependency_blocked",
          run: after,
          steps: history.length,
          history
        })
      }

      if (result.outcome === "owner_action_required" || result.ok !== true) {
        return finalResult({
          ok: false,
          outcome: "owner_action_required",
          reason: result.reason || "reviewed_boundary_requires_owner_action",
          run: after,
          steps: history.length,
          history
        })
      }

      const key = progressKey(entry)
      const noProgress = (
        before.version === after.version &&
        before.status === after.status &&
        before.headSha === after.headSha
      )

      if (noProgress || seen.has(key)) {
        return finalResult({
          ok: false,
          outcome: "owner_action_required",
          reason: "autonomous_run_no_progress",
          run: after,
          steps: history.length,
          history
        })
      }

      seen.add(key)
    }

    const run = await readRunImpl(normalizedRunId, options)
    return finalResult({
      ok: false,
      outcome: "owner_action_required",
      reason: "autonomous_step_limit_reached",
      run,
      steps: history.length,
      history
    })
  }
}

const defaultRunner = createSoftwareFactoryAutonomousRunner()

export function executeSoftwareFactoryAutonomousRun(runId, options = {}) {
  return defaultRunner(runId, options)
}

export function formatSoftwareFactoryAutonomousRun(result) {
  const lines = [
    "PPO Software Factory Run",
    `Run: ${result.run?.runId || "unknown"}`,
    `Project: ${result.run?.projectId || "unknown"}`,
    `Status: ${result.run?.status || "unknown"}`,
    `Outcome: ${result.outcome || "unknown"}`,
    `Steps: ${Number.isInteger(result.stepCount) ? result.stepCount : 0}`
  ]

  if (result.reason) {
    lines.push(`Reason: ${result.reason}`)
  }

  if (result.outcome === "release_ready") {
    if (result.releasePackage) {
      lines.push("", formatSoftwareFactoryReleasePackage(result.releasePackage))
    }
    lines.push("Next: review the release candidate and explicitly approve merge.")
  } else if (result.outcome === "blocked_capacity") {
    lines.push("Next: resume the same factory run after worker capacity is available.")
  } else if (result.outcome === "blocked_external") {
    lines.push("Next: restore the blocked external dependency, then resume the same factory run.")
  } else if (result.outcome === "complete") {
    lines.push("Next: no development action required.")
  } else {
    lines.push("Next: inspect the recorded reason before resuming.")
  }

  return lines.join("\n")
}

export function formatSoftwareFactoryAutonomousRunError(error) {
  if (error instanceof SoftwareFactoryAutonomousRunError) {
    return `PPO software factory run error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory run error: unexpected local failure."
}
