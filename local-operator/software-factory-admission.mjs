export const SOFTWARE_FACTORY_ADMISSION_POLICY_VERSION = 1
export const SOFTWARE_FACTORY_MAX_ACTIVE_PROJECTS = 2
export const SOFTWARE_FACTORY_MAX_ACTIVE_RUNS_PER_PROJECT = 1
export const SOFTWARE_FACTORY_WIP_RELEASED_STATUSES = Object.freeze([
  "merged",
  "deploy_in_progress",
  "deploy_failed",
  "deployed",
  "verification_in_progress",
  "verification_failed",
  "rollback_in_progress",
  "rollback_failed",
  "rolled_back"
])

const wipReleasedStatusSet = new Set(SOFTWARE_FACTORY_WIP_RELEASED_STATUSES)
const projectIdPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u

export class SoftwareFactoryAdmissionError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryAdmissionError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function admissionError(code, safeMessage) {
  return new SoftwareFactoryAdmissionError(code, safeMessage)
}

function normalizeProjectId(value) {
  const projectId = String(value ?? "").trim()
  if (!projectIdPattern.test(projectId)) {
    throw admissionError(
      "FACTORY_ADMISSION_PROJECT_INVALID",
      "Software factory admission project is invalid."
    )
  }
  return projectId
}

function normalizeCatalog(catalog) {
  if (
    !catalog ||
    typeof catalog !== "object" ||
    Array.isArray(catalog) ||
    catalog.ok !== true ||
    !Array.isArray(catalog.active) ||
    catalog.code === "catalog_truncated" ||
    catalog.diagnostics?.truncated === true
  ) {
    throw admissionError(
      "FACTORY_ADMISSION_CATALOG_UNAVAILABLE",
      "Software factory run catalog is unavailable or incomplete; new work was not admitted."
    )
  }

  for (const summary of catalog.active) {
    if (
      !summary ||
      typeof summary !== "object" ||
      typeof summary.project !== "string" ||
      typeof summary.runId !== "string" ||
      summary.terminal === true ||
      summary.recoveryRequired === true
    ) {
      throw admissionError(
        "FACTORY_ADMISSION_CATALOG_UNTRUSTED",
        "Software factory run catalog contains state that requires recovery or owner inspection."
      )
    }
  }

  return catalog.active.filter((summary) => !wipReleasedStatusSet.has(summary.status))
}

export function softwareFactoryRunConsumesWip(summary) {
  if (!summary || typeof summary !== "object" || summary.terminal === true) {
    return false
  }

  if (summary.recoveryRequired === true) {
    throw admissionError(
      "FACTORY_ADMISSION_CATALOG_UNTRUSTED",
      "Software factory run state requires recovery or owner inspection."
    )
  }

  return !wipReleasedStatusSet.has(summary.status)
}

export function assessSoftwareFactoryAdmission(projectIdInput, catalog) {
  const projectId = normalizeProjectId(projectIdInput)
  const active = normalizeCatalog(catalog)
  const projectRuns = active.filter((summary) => summary.project === projectId)
  const activeProjects = [...new Set(active.map((summary) => summary.project))].sort()

  if (projectRuns.length >= SOFTWARE_FACTORY_MAX_ACTIVE_RUNS_PER_PROJECT) {
    return Object.freeze({
      ok: false,
      outcome: "blocked_work_in_progress",
      reasonCode: "PROJECT_ACTIVE_RUN_LIMIT",
      projectId,
      activeProjectCount: activeProjects.length,
      activeProjects: Object.freeze(activeProjects),
      projectActiveRunCount: projectRuns.length
    })
  }

  if (
    !activeProjects.includes(projectId) &&
    activeProjects.length >= SOFTWARE_FACTORY_MAX_ACTIVE_PROJECTS
  ) {
    return Object.freeze({
      ok: false,
      outcome: "blocked_work_in_progress",
      reasonCode: "GLOBAL_ACTIVE_PROJECT_LIMIT",
      projectId,
      activeProjectCount: activeProjects.length,
      activeProjects: Object.freeze(activeProjects),
      projectActiveRunCount: 0
    })
  }

  return Object.freeze({
    ok: true,
    outcome: "admitted",
    reasonCode: "ADMISSION_AVAILABLE",
    projectId,
    activeProjectCount: activeProjects.length,
    activeProjects: Object.freeze(activeProjects),
    projectActiveRunCount: projectRuns.length
  })
}

export function formatSoftwareFactoryAdmissionError(error) {
  if (error instanceof SoftwareFactoryAdmissionError) {
    return `PPO software factory admission error [${error.code}]: ${error.safeMessage}`
  }
  return "PPO software factory admission error: unexpected local failure."
}
