import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createPlannedDevelopmentRun,
  planNextDevelopmentStage
} from "./development-next-stage-planner.mjs"
import {
  listDevelopmentRunSummaries
} from "./development-run-catalog.mjs"
import {
  readDevelopmentRun
} from "./development-run-state.mjs"
import {
  createGitHubReadOnlyClient
} from "./github-readonly.mjs"
import {
  STAGE3A_MAX_REMOTE_AGE_MS,
  STAGE3A_PROJECT_ID,
  STAGE3A_REPOSITORY,
  observeKhlimAssistStage3Readiness
} from "./customer-zero-stage3a-readiness.mjs"

export const STAGE3B_PILOT_ID = "customer-zero-stage3b-khlim-assist-first-controlled-task"
export const STAGE3B_TASK = "Add deterministic regression tests for Phase 2 multilingual GREEN/YELLOW/RED classification, including malformed and empty inputs, without changing classification logic, retrieval behavior, or participant auto-reply settings."
export const STAGE3B_PROJECT_DOC = "projects/khlim-assist.md"

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const MAX_PROJECT_DOC_BYTES = 64 * 1024
const MAX_ROADMAP_BYTES = 160 * 1024

export class Stage3BPilotError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "Stage3BPilotError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function refuse(code, safeMessage) {
  return new Stage3BPilotError(code, safeMessage)
}

function assertEmptyRequest(request) {
  if (
    request === undefined ||
    request === null ||
    (typeof request === "object" && !Array.isArray(request) && Object.keys(request).length === 0)
  ) {
    return
  }

  throw refuse(
    "STAGE3B_CALLER_INPUT_FORBIDDEN",
    "Stage 3B is fixed to the approved KHLIM Assist pilot task and accepts no caller-selected task or target."
  )
}

function nowDate(options = {}) {
  const value = typeof options.now === "function" ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

async function readFixedFile(ref, maxBytes) {
  const path = join(REPO_ROOT, ref)
  const info = await lstat(path)

  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw refuse(
      "STAGE3B_SOURCE_UNAVAILABLE",
      "Stage 3B approved planning source is unavailable or unsafe."
    )
  }

  return readFile(path, "utf8")
}

async function loadFixedSources(options = {}) {
  if (typeof options.sourceLoader === "function") {
    const sources = await options.sourceLoader()
    if (
      !sources ||
      typeof sources.projectDoc !== "string" ||
      typeof sources.roadmap !== "string"
    ) {
      throw refuse(
        "STAGE3B_SOURCE_UNAVAILABLE",
        "Stage 3B approved planning source is unavailable or unsafe."
      )
    }

    return sources
  }

  const [projectDoc, roadmap] = await Promise.all([
    readFixedFile(STAGE3B_PROJECT_DOC, MAX_PROJECT_DOC_BYTES),
    readFixedFile("ROADMAP.md", MAX_ROADMAP_BYTES)
  ])

  return { projectDoc, roadmap }
}

function extractNextAction(projectDoc) {
  const normalized = String(projectDoc).replace(/\r\n/gu, "\n")
  const lines = normalized.split("\n")
  const headings = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index])) {
      headings.push(index)
    }
  }

  const start = headings.find((index) => lines[index] === "## Next action")
  if (start === undefined) {
    return null
  }

  const nextHeading = headings.find((index) => index > start)
  const body = lines
    .slice(start + 1, nextHeading === undefined ? lines.length : nextHeading)
    .join("\n")
    .trim()
    .replace(/\s+/gu, " ")

  return body || null
}

function validateReadiness(report) {
  return (
    report?.schema === "personal-project-operator.customer-zero.stage3a-readiness.v1" &&
    report?.ready === true &&
    report?.project?.id === STAGE3A_PROJECT_ID &&
    report?.project?.repository === STAGE3A_REPOSITORY &&
    isSha(report?.exactRevision) &&
    Array.isArray(report?.observations) &&
    report.observations.length > 0 &&
    report.observations.every((entry) => entry?.status === "PASS")
  )
}

function validatePinnedSnapshot(snapshot, exactRevision, now) {
  const retrievedAt = Date.parse(snapshot?.retrievedAt)
  const ageMs = Number.isFinite(retrievedAt) ? now.getTime() - retrievedAt : null

  return (
    snapshot?.project?.id === STAGE3A_PROJECT_ID &&
    snapshot?.project?.fullName === STAGE3A_REPOSITORY &&
    snapshot?.repository?.fullName === STAGE3A_REPOSITORY &&
    snapshot?.repository?.defaultBranch === "main" &&
    snapshot?.recentCommits?.[0]?.sha === exactRevision &&
    ageMs !== null &&
    ageMs >= -30_000 &&
    ageMs <= STAGE3A_MAX_REMOTE_AGE_MS
  )
}

function ownerActionResult(code, exactRevision = null, existingRunId = null) {
  return Object.freeze({
    schemaVersion: 1,
    pilot: STAGE3B_PILOT_ID,
    projectId: STAGE3A_PROJECT_ID,
    outcome: "owner_action_required",
    code,
    runId: existingRunId,
    exactRevision: isSha(exactRevision) ? exactRevision : null,
    automaticContinuation: false,
    deploymentAuthorized: false,
    customerMessagingAuthorized: false
  })
}

function existingResult(run, exactRevision) {
  return Object.freeze({
    schemaVersion: 1,
    pilot: STAGE3B_PILOT_ID,
    projectId: STAGE3A_PROJECT_ID,
    outcome: "existing",
    code: "STAGE3B_PILOT_ALREADY_EXISTS",
    runId: run.runId,
    status: run.status,
    exactRevision,
    automaticContinuation: false,
    deploymentAuthorized: false,
    customerMessagingAuthorized: false
  })
}

function plannedResult(run, exactRevision) {
  return Object.freeze({
    schemaVersion: 1,
    pilot: STAGE3B_PILOT_ID,
    projectId: STAGE3A_PROJECT_ID,
    outcome: "planned",
    code: "STAGE3B_PILOT_PLANNED",
    runId: run.runId,
    status: run.status,
    exactRevision,
    nextCommand: `/ppo continue ${run.runId}`,
    automaticContinuation: false,
    deploymentAuthorized: false,
    customerMessagingAuthorized: false
  })
}

async function inspectExistingPilot(options = {}) {
  const listRuns = options.listRuns || listDevelopmentRunSummaries
  const readRun = options.readRun || readDevelopmentRun
  const catalogOptions = {}
  if (options.writeDataDir !== undefined) {
    catalogOptions.writeDataDir = options.writeDataDir
  }

  let catalog
  try {
    catalog = await listRuns(catalogOptions)
  } catch {
    return { ok: false, code: "STAGE3B_RUN_CATALOG_UNAVAILABLE" }
  }

  if (
    catalog?.ok !== true ||
    catalog?.diagnostics?.truncated === true ||
    !Array.isArray(catalog?.summaries)
  ) {
    return {
      ok: false,
      code: catalog?.diagnostics?.truncated === true
        ? "STAGE3B_RUN_CATALOG_TRUNCATED"
        : "STAGE3B_RUN_CATALOG_UNAVAILABLE"
    }
  }

  const khlimSummaries = catalog.summaries.filter((summary) => summary?.project === STAGE3A_PROJECT_ID)
  const matching = []
  let unrelatedActive = null

  for (const summary of khlimSummaries) {
    let run
    try {
      run = await readRun(summary.runId, catalogOptions)
    } catch {
      return { ok: false, code: "STAGE3B_RUN_CATALOG_UNAVAILABLE" }
    }

    if (run?.project?.id !== STAGE3A_PROJECT_ID) {
      return { ok: false, code: "STAGE3B_RUN_CATALOG_UNAVAILABLE" }
    }

    if (run.task === STAGE3B_TASK) {
      matching.push({ run, summary })
    } else if (summary.terminal !== true && unrelatedActive === null) {
      unrelatedActive = summary
    }
  }

  if (matching.length > 1) {
    return { ok: false, code: "STAGE3B_DUPLICATE_PILOT_RUNS" }
  }

  if (matching.length === 1) {
    const { run, summary } = matching[0]
    if (summary.canonicalState !== "canonical_current" || summary.recoveryRequired === true) {
      return {
        ok: false,
        code: "STAGE3B_EXISTING_RUN_RECOVERY_REQUIRED",
        run
      }
    }

    return { ok: true, existing: run }
  }

  if (unrelatedActive) {
    return {
      ok: false,
      code: "STAGE3B_KHLIM_RUN_ALREADY_ACTIVE",
      runId: unrelatedActive.runId
    }
  }

  return { ok: true, existing: null }
}

function validatePlan(plan, exactRevision) {
  return (
    plan?.outcome === "planned" &&
    plan?.project?.id === STAGE3A_PROJECT_ID &&
    plan?.project?.repo === STAGE3A_REPOSITORY &&
    plan?.baseSha === exactRevision &&
    plan?.next?.stage === "implementation" &&
    plan?.next?.task === STAGE3B_TASK
  )
}

function validateCreatedRun(result, exactRevision) {
  const run = result?.run
  return (
    result?.ok === true &&
    result?.outcome === "planned" &&
    validatePlan(result?.plan, exactRevision) &&
    run?.project?.id === STAGE3A_PROJECT_ID &&
    run?.project?.fullName === STAGE3A_REPOSITORY &&
    run?.task === STAGE3B_TASK &&
    run?.status === "planned" &&
    run?.baseSha === exactRevision &&
    run?.headSha === exactRevision &&
    typeof run?.runId === "string"
  )
}

export async function startKhlimAssistStage3BPilot(request = {}, options = {}) {
  assertEmptyRequest(request)

  const readinessObserver = options.readinessObserver || observeKhlimAssistStage3Readiness
  const githubClient = options.githubClient || createGitHubReadOnlyClient()
  const planOnly = options.planOnly || planNextDevelopmentStage
  const createPlannedRun = options.createPlannedRun || createPlannedDevelopmentRun
  const now = nowDate(options)

  let readiness
  try {
    readiness = await readinessObserver({}, options.readinessOptions || {})
  } catch {
    return ownerActionResult("STAGE3A_READINESS_UNAVAILABLE")
  }

  if (!validateReadiness(readiness)) {
    return ownerActionResult("STAGE3A_READINESS_REQUIRED")
  }

  const existing = await inspectExistingPilot(options)
  if (!existing.ok) {
    return ownerActionResult(existing.code, readiness.exactRevision, existing.run?.runId || existing.runId || null)
  }
  if (existing.existing) {
    return existingResult(existing.existing, readiness.exactRevision)
  }

  let sources
  try {
    sources = await loadFixedSources(options)
  } catch {
    return ownerActionResult("STAGE3B_SOURCE_UNAVAILABLE", readiness.exactRevision)
  }

  if (extractNextAction(sources.projectDoc) !== STAGE3B_TASK) {
    return ownerActionResult("STAGE3B_TASK_DRIFT", readiness.exactRevision)
  }

  let snapshot
  try {
    snapshot = await githubClient.getProjectSnapshot(STAGE3A_PROJECT_ID)
  } catch {
    return ownerActionResult("STAGE3B_GITHUB_SNAPSHOT_UNAVAILABLE", readiness.exactRevision)
  }

  if (!validatePinnedSnapshot(snapshot, readiness.exactRevision, now)) {
    return ownerActionResult("STAGE3B_REVISION_NOT_PINNED", readiness.exactRevision)
  }

  const pinnedGithubClient = Object.freeze({
    async getProjectSnapshot(projectId) {
      if (projectId !== STAGE3A_PROJECT_ID) {
        throw refuse(
          "STAGE3B_PROJECT_MISMATCH",
          "Stage 3B GitHub facts are fixed to KHLIM Assist."
        )
      }
      return snapshot
    }
  })

  const planningOptions = {
    sources: {
      [STAGE3B_PROJECT_DOC]: sources.projectDoc,
      "ROADMAP.md": sources.roadmap
    },
    githubClient: pinnedGithubClient
  }
  if (options.writeDataDir !== undefined) {
    planningOptions.writeDataDir = options.writeDataDir
  }
  if (options.now !== undefined) {
    planningOptions.now = options.now
  }
  if (options.randomBytesImpl !== undefined) {
    planningOptions.randomBytesImpl = options.randomBytesImpl
  }

  let preflight
  try {
    preflight = await planOnly(STAGE3A_PROJECT_ID, planningOptions)
  } catch {
    return ownerActionResult("STAGE3B_PLANNER_UNAVAILABLE", readiness.exactRevision)
  }

  if (!validatePlan(preflight, readiness.exactRevision)) {
    return ownerActionResult("STAGE3B_PLAN_MISMATCH", readiness.exactRevision)
  }

  let created
  try {
    created = await createPlannedRun(STAGE3A_PROJECT_ID, planningOptions)
  } catch {
    return ownerActionResult("STAGE3B_RUN_CREATION_UNAVAILABLE", readiness.exactRevision)
  }

  if (!validateCreatedRun(created, readiness.exactRevision)) {
    return ownerActionResult("STAGE3B_CREATED_RUN_MISMATCH", readiness.exactRevision, created?.run?.runId || null)
  }

  return plannedResult(created.run, readiness.exactRevision)
}
