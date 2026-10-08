import { createHash } from "node:crypto"
import {
  MAX_DEVELOPMENT_RUN_TASK_CHARS,
  createDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  GitHubReadOnlyError,
  createGitHubReadOnlyClient
} from "./github-readonly.mjs"
import {
  getOrdinaryDevelopmentProject,
  listOrdinaryDevelopmentProjects
} from "./github-project-registry.mjs"
import {
  listDevelopmentRunSummaries
} from "./development-run-catalog.mjs"
import {
  SoftwareFactoryAdmissionError,
  assessSoftwareFactoryAdmission
} from "./software-factory-admission.mjs"
import {
  executeSoftwareFactoryAutonomousRun
} from "./software-factory-autonomous-run.mjs"
import {
  buildBaselineSoftwareFactoryPlan,
  softwareFactoryPlanEvidence
} from "./software-factory-plan-contract.mjs"

export const SOFTWARE_FACTORY_MANAGER_OBJECTIVE_ID = "software-factory-v1-4-manager-objective"
export const SOFTWARE_FACTORY_MANAGER_OBJECTIVE_MAX_CHARS = MAX_DEVELOPMENT_RUN_TASK_CHARS

const allowedProjects = new Set(listOrdinaryDevelopmentProjects().map((project) => project.id))
const shaPattern = /^[a-f0-9]{40}$/u
const unsafeControlPattern = /[\u0000-\u001F\u007F-\u009F]/u
const sensitiveTextPattern = /(?:github_pat_|gh[opusr]_|sk-|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu

export class SoftwareFactoryManagerObjectiveError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage)
    this.name = "SoftwareFactoryManagerObjectiveError"
    this.code = code
    this.safeMessage = safeMessage
    this.runId = typeof options.runId === "string" ? options.runId : null
  }
}

function objectiveError(code, safeMessage, options = {}) {
  return new SoftwareFactoryManagerObjectiveError(code, safeMessage, options)
}

function postCreationError(error, runId) {
  if (error instanceof SoftwareFactoryManagerObjectiveError) {
    error.runId = runId
    return error
  }

  return objectiveError(
    "FACTORY_OBJECTIVE_POST_CREATE_FAILED",
    "Manager objective run was created but could not advance safely; inspect the durable run before retrying.",
    { runId }
  )
}

function normalizeProjectId(value) {
  const projectId = String(value ?? "").trim()

  if (!allowedProjects.has(projectId) || !getOrdinaryDevelopmentProject(projectId)) {
    throw objectiveError(
      "FACTORY_OBJECTIVE_PROJECT_INVALID",
      "Manager objective requires one approved ordinary development project."
    )
  }

  return projectId
}

export function normalizeSoftwareFactoryManagerObjective(value) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw objectiveError(
      "FACTORY_OBJECTIVE_INVALID",
      "Manager objective text is invalid."
    )
  }

  const objective = value.trim()

  if (
    !objective ||
    objective.length > SOFTWARE_FACTORY_MANAGER_OBJECTIVE_MAX_CHARS ||
    unsafeControlPattern.test(objective) ||
    sensitiveTextPattern.test(objective)
  ) {
    throw objectiveError(
      "FACTORY_OBJECTIVE_INVALID",
      "Manager objective text is invalid."
    )
  }

  return objective
}

function validateSnapshot(projectId, snapshot) {
  const project = getOrdinaryDevelopmentProject(projectId)
  const latest = Array.isArray(snapshot?.recentCommits) ? snapshot.recentCommits[0] : null
  const baseSha = String(latest?.sha ?? "").trim().toLowerCase()
  const defaultBranch = String(snapshot?.repository?.defaultBranch ?? "").trim()
  const openPullRequests = Array.isArray(snapshot?.openPullRequests) ? snapshot.openPullRequests : []

  if (
    snapshot?.project?.id !== projectId ||
    snapshot?.project?.fullName !== project?.fullName ||
    snapshot?.repository?.fullName !== project?.fullName ||
    !defaultBranch ||
    !shaPattern.test(baseSha)
  ) {
    throw objectiveError(
      "FACTORY_OBJECTIVE_GITHUB_STATE_INVALID",
      "Current GitHub state could not be pinned safely for manager objective intake."
    )
  }

  if (openPullRequests.length > 0) {
    throw objectiveError(
      "FACTORY_OBJECTIVE_GITHUB_STATE_AMBIGUOUS",
      "Manager objective intake requires the project to have no open pull requests."
    )
  }

  return {
    project,
    baseSha,
    defaultBranch,
    openIssueCount: Array.isArray(snapshot.openIssues) ? snapshot.openIssues.length : 0
  }
}

function planningEvidence({ projectId, objective, baseSha, defaultBranch, openIssueCount }) {
  return {
    kind: "planning",
    sha: baseSha,
    source: SOFTWARE_FACTORY_MANAGER_OBJECTIVE_ID,
    summary: "Owner-supplied manager objective pinned to current GitHub default-branch head.",
    metadata: {
      outcome: "planned",
      project: projectId,
      origin: "owner_manager_objective",
      objectiveHash: createHash("sha256").update(objective).digest("hex"),
      defaultBranch,
      openPrCount: 0,
      openIssueCount
    }
  }
}

export function createSoftwareFactoryManagerObjectiveIntake(dependencies = {}) {
  const githubClient = dependencies.githubClient || createGitHubReadOnlyClient()
  const createRun = dependencies.createRun || createDevelopmentRun
  const transitionRun = dependencies.transitionRun || transitionDevelopmentRun
  const listRuns = dependencies.listRuns || listDevelopmentRunSummaries

  return async function intake(projectIdInput, objectiveInput, options = {}) {
    const projectId = normalizeProjectId(projectIdInput)
    const objective = normalizeSoftwareFactoryManagerObjective(objectiveInput)
    let admission

    try {
      admission = assessSoftwareFactoryAdmission(projectId, await listRuns(options))
    } catch (error) {
      if (error instanceof SoftwareFactoryAdmissionError) {
        throw objectiveError(
          error.code,
          error.safeMessage
        )
      }
      throw error
    }

    if (!admission.ok) {
      throw objectiveError(
        "FACTORY_OBJECTIVE_WIP_BLOCKED",
        admission.reasonCode === "PROJECT_ACTIVE_RUN_LIMIT"
          ? "Manager objective intake is blocked because this project already has an active development run."
          : "Manager objective intake is blocked because the two-project Software Factory WIP limit is full."
      )
    }

    let snapshot

    try {
      snapshot = await githubClient.getProjectSnapshot(projectId)
    } catch (error) {
      if (error instanceof GitHubReadOnlyError) {
        throw objectiveError(
          "FACTORY_OBJECTIVE_GITHUB_UNAVAILABLE",
          "GitHub read-only state is unavailable for manager objective intake."
        )
      }
      throw error
    }

    const pinned = validateSnapshot(projectId, snapshot)
    const created = await createRun({
      projectId,
      task: objective,
      baseSha: pinned.baseSha,
      branch: pinned.defaultBranch,
      headSha: pinned.baseSha,
      actor: SOFTWARE_FACTORY_MANAGER_OBJECTIVE_ID
    }, options)

    let baselinePlan
    let planned

    try {
      baselinePlan = buildBaselineSoftwareFactoryPlan({
        runId: created.runId,
        projectId,
        baseSha: pinned.baseSha,
        objective
      })
      const planning = await transitionRun(created.runId, {
        expectedVersion: created.version,
        status: "planning_in_progress",
        actor: SOFTWARE_FACTORY_MANAGER_OBJECTIVE_ID,
        reason: "manager-objective-planning-started"
      }, options)
      planned = await transitionRun(created.runId, {
        expectedVersion: planning.version,
        status: "planned",
        actor: SOFTWARE_FACTORY_MANAGER_OBJECTIVE_ID,
        reason: "manager-objective-planned",
        evidence: [
          planningEvidence({
            projectId,
            objective,
            baseSha: pinned.baseSha,
            defaultBranch: pinned.defaultBranch,
            openIssueCount: pinned.openIssueCount
          }),
          softwareFactoryPlanEvidence(baselinePlan)
        ]
      }, options)
    } catch (error) {
      throw postCreationError(error, created.runId)
    }

    return {
      ok: true,
      outcome: "planned",
      projectId,
      runId: planned.runId,
      runVersion: planned.version,
      status: planned.status,
      baseSha: pinned.baseSha,
      defaultBranch: pinned.defaultBranch,
      planHash: baselinePlan.planHash,
      planCapability: baselinePlan.capabilityHint,
      planRisk: baselinePlan.risk
    }
  }
}

const defaultIntake = createSoftwareFactoryManagerObjectiveIntake()

export async function startSoftwareFactoryManagerObjective(projectId, objective, options = {}) {
  return defaultIntake(projectId, objective, options)
}

export function createSoftwareFactoryManagerLaunch(dependencies = {}) {
  const intake = dependencies.intake || defaultIntake
  const runFactory = dependencies.runFactory || executeSoftwareFactoryAutonomousRun

  return async function launch(projectId, objective, options = {}) {
    const intakeResult = await intake(projectId, objective, options)

    try {
      const factoryResult = await runFactory(intakeResult.runId, options)

      return {
        ok: factoryResult.ok,
        outcome: factoryResult.outcome,
        intake: intakeResult,
        factory: factoryResult
      }
    } catch {
      return {
        ok: false,
        outcome: "owner_action_required",
        intake: intakeResult,
        factory: {
          ok: false,
          outcome: "owner_action_required",
          reason: "factory_runner_failed_after_intake",
          run: {
            runId: intakeResult.runId,
            projectId: intakeResult.projectId,
            status: intakeResult.status
          }
        }
      }
    }
  }
}

const defaultLaunch = createSoftwareFactoryManagerLaunch()

export function executeSoftwareFactoryManagerObjective(projectId, objective, options = {}) {
  return defaultLaunch(projectId, objective, options)
}

export function formatSoftwareFactoryManagerObjective(result) {
  const lines = [
    "PPO Software Factory Manager Objective",
    `Project: ${result.intake?.projectId || "unknown"}`,
    `Run: ${result.intake?.runId || "unknown"}`,
    `Base SHA: ${result.intake?.baseSha || "unknown"}`,
    `Outcome: ${result.outcome || "unknown"}`
  ]

  if (result.factory?.reason) {
    lines.push(`Reason: ${result.factory.reason}`)
  }

  if (result.outcome === "release_ready") {
    lines.push("Next: review the release package and explicitly approve merge.")
  } else if (result.outcome === "blocked_capacity") {
    lines.push(`Next: resume with /ppo factory-run ${result.intake.runId} after worker capacity returns.`)
  } else if (result.outcome === "blocked_external") {
    lines.push(`Next: restore the blocked dependency, then resume with /ppo factory-run ${result.intake.runId}.`)
  } else if (result.outcome === "owner_action_required") {
    lines.push(`Next: inspect the run with /ppo run ${result.intake.runId}.`)
  }

  return lines.join("\n")
}

export function formatSoftwareFactoryManagerObjectiveError(error) {
  if (error instanceof SoftwareFactoryManagerObjectiveError) {
    return `PPO software factory manager-objective error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory manager-objective error: unexpected local failure."
}


export async function handlePpoSoftwareFactoryManagerObjectiveCommand(projectId, objective, options = {}) {
  try {
    const result = await executeSoftwareFactoryManagerObjective(projectId, objective, options)
    return {
      ok: result.ok,
      outcome: result.outcome,
      runId: result.intake?.runId || null,
      output: formatSoftwareFactoryManagerObjective(result)
    }
  } catch (error) {
    return {
      ok: false,
      outcome: "owner_action_required",
      runId: error?.runId || null,
      output: error?.runId
        ? [
            formatSoftwareFactoryManagerObjectiveError(error),
            `Run: ${error.runId}`,
            `Next: inspect the durable run with /ppo run ${error.runId} before retrying.`
          ].join("\n")
        : formatSoftwareFactoryManagerObjectiveError(error)
    }
  }
}
