import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DevelopmentRunStateError,
  createDevelopmentRun,
  readDevelopmentRun,
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

export const NEXT_STAGE_PLANNER_SCHEMA_VERSION = 1
export const NEXT_STAGE_PLANNER_ID = "phase-6b-next-stage-planner"
export const DEFAULT_NEXT_STAGE_REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))
export const MAX_PLANNER_PROJECT_DOC_BYTES = 64 * 1024
export const MAX_PLANNER_ROADMAP_BYTES = 160 * 1024
export const MAX_PLANNER_SECTION_CHARS = 4000
export const MAX_PLANNER_TASK_CHARS = 500
export const MAX_PLANNER_SOURCE_FACT_CHARS = 280
export const MAX_PLANNER_SOURCE_EVIDENCE = 8
export const MAX_PLANNER_RECORD_BYTES = 24 * 1024

export const NEXT_STAGE_PLANNER_OUTCOMES = Object.freeze([
  "planned",
  "owner_action_required"
])

export const NEXT_STAGE_OWNER_ACTION_REASONS = Object.freeze([
  "MISSING_PROJECT_STATE",
  "MALFORMED_SOURCE_STATE",
  "CONTRADICTORY_PROJECT_STATE",
  "AMBIGUOUS_PROJECT_STATE",
  "ALREADY_COMPLETE",
  "PRODUCT_DECISION_REQUIRED",
  "UNSUPPORTED_STAGE",
  "MISSING_GITHUB_FACTS",
  "UNSAFE_SOURCE_STATE"
])

export const PHASE_6B_SUPPORTED_NEXT_STAGES = Object.freeze([
  "planning",
  "implementation"
])

const sha40Pattern = /^[a-f0-9]{40}$/iu
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0008\u000E-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu

const approvedProjectDocRefs = Object.freeze(Object.fromEntries(
  listOrdinaryDevelopmentProjects().map((project) => [project.id, `projects/${project.id}.md`])
))
const approvedSourceRefs = new Set([
  "ROADMAP.md",
  ...Object.values(approvedProjectDocRefs)
])

export class DevelopmentNextStagePlannerError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "DevelopmentNextStagePlannerError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function plannerError(code, safeMessage) {
  return new DevelopmentNextStagePlannerError(code, safeMessage)
}

function safePlannerFailure(error) {
  if (error instanceof DevelopmentNextStagePlannerError || error instanceof DevelopmentRunStateError) {
    return error
  }

  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
    return plannerError(
      "SOURCE_UNAVAILABLE",
      "Approved planner source state is unavailable; no planning transition was attempted."
    )
  }

  return plannerError(
    "PLANNER_FAILED",
    "Next-stage planner failed safely; no raw source or runtime failure was stored."
  )
}

function allowedProjectIdList() {
  return listOrdinaryDevelopmentProjects().map((project) => project.id).join(", ")
}

function repoFullName(project) {
  return `${project.owner}/${project.repo}`
}

function resolvePlannerProject(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw plannerError(
      "INVALID_PROJECT",
      `Project id is required. Use one of: ${allowedProjectIdList()}.`
    )
  }

  const normalized = projectId.trim()
  const project = getOrdinaryDevelopmentProject(normalized)

  if (!project) {
    throw plannerError(
      "UNKNOWN_PROJECT",
      `Project id is not in the connected project allowlist. Use one of: ${allowedProjectIdList()}.`
    )
  }

  return {
    ...project,
    fullName: repoFullName(project)
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex")
}

function rejectUnsafeText(value) {
  return unsafeControlPattern.test(value) || sensitiveTextPattern.test(value)
}

function normalizeSectionText(value) {
  const normalized = String(value ?? "").trim()

  if (!normalized || normalized.length > MAX_PLANNER_SECTION_CHARS || rejectUnsafeText(normalized)) {
    return null
  }

  return normalized
}

function boundedFact(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/gu, " ")

  if (!normalized || normalized.length > MAX_PLANNER_SOURCE_FACT_CHARS || rejectUnsafeText(normalized)) {
    return null
  }

  return normalized
}

function normalizeTask(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/gu, " ")

  if (!normalized || normalized.length > MAX_PLANNER_TASK_CHARS || rejectUnsafeText(normalized)) {
    return null
  }

  return normalized
}

async function defaultReadApprovedSource(ref, options = {}) {
  if (!approvedSourceRefs.has(ref)) {
    throw plannerError(
      "UNAPPROVED_SOURCE",
      "Planner source is not approved; no source was read."
    )
  }

  const path = join(options.repoRoot || DEFAULT_NEXT_STAGE_REPO_ROOT, ref)
  const info = await lstat(path)

  if (!info.isFile() || info.isSymbolicLink()) {
    throw plannerError(
      "UNSAFE_LOCAL_PATH",
      "Approved planner source is not a regular local file."
    )
  }

  if (info.size > maxSourceBytes(ref)) {
    throw plannerError(
      "SOURCE_TOO_LARGE",
      "Approved planner source is too large."
    )
  }

  return readFile(path, "utf8")
}

function maxSourceBytes(ref) {
  return ref === "ROADMAP.md"
    ? MAX_PLANNER_ROADMAP_BYTES
    : MAX_PLANNER_PROJECT_DOC_BYTES
}

function enforceSourceBound(ref, value) {
  const text = String(value)

  if (Buffer.byteLength(text, "utf8") > maxSourceBytes(ref)) {
    throw plannerError(
      "SOURCE_TOO_LARGE",
      "Approved planner source is too large."
    )
  }

  return text
}

async function readApprovedSource(ref, options = {}) {
  if (!approvedSourceRefs.has(ref)) {
    throw plannerError(
      "UNAPPROVED_SOURCE",
      "Planner source is not approved; no source was read."
    )
  }

  if (options.sources && Object.hasOwn(options.sources, ref)) {
    return enforceSourceBound(ref, options.sources[ref])
  }

  if (typeof options.sourceReader === "function") {
    return enforceSourceBound(ref, await options.sourceReader(ref))
  }

  return enforceSourceBound(ref, await defaultReadApprovedSource(ref, options))
}

function parseLevelTwoSections(markdown) {
  if (typeof markdown !== "string" || !markdown.trim() || rejectUnsafeText(markdown)) {
    return {
      ok: false,
      reasonCode: "UNSAFE_SOURCE_STATE",
      sections: new Map()
    }
  }

  const lines = markdown.replace(/\r\n/gu, "\n").split("\n")
  const sections = new Map()
  let currentHeading = null
  let currentLines = []

  function commitSection() {
    if (!currentHeading) {
      return true
    }

    if (sections.has(currentHeading)) {
      return false
    }

    sections.set(currentHeading, currentLines.join("\n").trim())
    return true
  }

  for (const line of lines) {
    const match = line.match(/^## ([^\n#]+?)\s*$/u)

    if (match) {
      if (!commitSection()) {
        return {
          ok: false,
          reasonCode: "MALFORMED_SOURCE_STATE",
          sections: new Map()
        }
      }

      currentHeading = match[1].trim()
      currentLines = []
      continue
    }

    if (currentHeading) {
      currentLines.push(line)
    }
  }

  if (!commitSection()) {
    return {
      ok: false,
      reasonCode: "MALFORMED_SOURCE_STATE",
      sections: new Map()
    }
  }

  return {
    ok: true,
    reasonCode: null,
    sections
  }
}

function requiredSection(sections, heading) {
  const value = normalizeSectionText(sections.get(heading))

  if (!value) {
    return null
  }

  return value
}

function normalizeRepoSection(value) {
  const match = String(value ?? "").trim().match(/^`([^`]+)`$/u)
  return (match ? match[1] : String(value ?? "")).trim()
}

function buildSourceEvidence(ref, section, fact, extras = {}) {
  const safeFact = boundedFact(fact)

  if (!safeFact) {
    return null
  }

  return {
    source: ref === "ROADMAP.md" ? "roadmap" : ref.startsWith("projects/") ? "project-doc" : "github-readonly",
    ref,
    section,
    fact: safeFact,
    ...extras
  }
}

function ownerActionPlan({
  project,
  reasonCode,
  safeSummary,
  current = null,
  sourceEvidence = [],
  githubFacts = null,
  sourceHashes = null
}) {
  const plan = {
    schemaVersion: NEXT_STAGE_PLANNER_SCHEMA_VERSION,
    planner: NEXT_STAGE_PLANNER_ID,
    outcome: "owner_action_required",
    reasonCode,
    safeSummary,
    project: project ? {
      id: project.id,
      displayName: project.displayName,
      repo: project.fullName
    } : null,
    current,
    next: null,
    baseSha: null,
    githubFacts,
    sourceEvidence: sourceEvidence.slice(0, MAX_PLANNER_SOURCE_EVIDENCE),
    sourceHashes
  }

  return withPlanHash(plan)
}

function plannedPlan({
  project,
  current,
  next,
  baseSha,
  githubFacts,
  sourceEvidence,
  sourceHashes
}) {
  const plan = {
    schemaVersion: NEXT_STAGE_PLANNER_SCHEMA_VERSION,
    planner: NEXT_STAGE_PLANNER_ID,
    outcome: "planned",
    reasonCode: "READY",
    safeSummary: "Next development stage was determined from approved PPO project state, roadmap state, and GitHub read-only facts.",
    project: {
      id: project.id,
      displayName: project.displayName,
      repo: project.fullName
    },
    current,
    next,
    baseSha,
    githubFacts,
    sourceEvidence: sourceEvidence.slice(0, MAX_PLANNER_SOURCE_EVIDENCE),
    sourceHashes
  }

  return withPlanHash(plan)
}

function withPlanHash(plan) {
  const planHash = sha256Text(stableStringify(plan))
  const output = {
    ...plan,
    planHash
  }

  if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_PLANNER_RECORD_BYTES) {
    return {
      ...ownerActionPlan({
        project: plan.project ? {
          id: plan.project.id,
          displayName: plan.project.displayName,
          fullName: plan.project.repo
        } : null,
        reasonCode: "MALFORMED_SOURCE_STATE",
        safeSummary: "Planner output would exceed the Phase 6B size bound; owner action is required.",
        current: plan.current,
        sourceEvidence: [],
        githubFacts: null,
        sourceHashes: null
      })
    }
  }

  return output
}

function currentStateFromSections(sections) {
  const currentPhase = requiredSection(sections, "Current phase")
  const lastKnownStatus = requiredSection(sections, "Last known status")
  const nextAction = requiredSection(sections, "Next action")

  if (!currentPhase || !lastKnownStatus || !nextAction) {
    return {
      ok: false,
      reasonCode: "MISSING_PROJECT_STATE",
      current: {
        phase: currentPhase,
        status: lastKnownStatus,
        nextAction
      }
    }
  }

  return {
    ok: true,
    current: {
      phase: currentPhase,
      status: lastKnownStatus,
      nextAction
    }
  }
}

function actionLooksAlreadyComplete(current) {
  return (
    /\b(complete|completed|done|finished|verified|no next action|none)\b/iu.test(current.nextAction) ||
    (/\b(complete|completed|done|finished|verified)\b/iu.test(current.phase) && /\b(no next action|none|complete|completed|done)\b/iu.test(current.nextAction))
  )
}

function stateLooksContradictory(current) {
  return /\b(complete|completed|done|finished|verified)\b/iu.test(current.phase) &&
    /\b(add|implement|build|create|update|fix|harden|refactor|wire|integrate|prepare|inspect|plan)\b/iu.test(current.nextAction)
}

function actionNeedsProductDecision(nextAction) {
  return /\b(product|owner|business)\s+(choice|decision|required|approval)\b|\b(choose|select|decide)\b|\bwhich\b/iu.test(nextAction)
}

function actionLooksAmbiguous(nextAction) {
  return /\b(either|one of|and\/or|ambiguous|multiple options)\b/iu.test(nextAction) ||
    nextAction.split("\n").filter((line) => /^\s*[-*]\s+/u.test(line)).length > 1
}

function unsupportedStage(nextAction) {
  const checks = [
    ["merge", /\b(merge|approve PR|approve pull request|close PR|close pull request)\b/iu],
    ["git-mutation", /\b(create branch|branch creation|commit|push|checkout|rebase|cherry-pick)\b/iu],
    ["github-write", /\b(open PR|create PR|pull request automation|comment on|label|workflow dispatch|create issue)\b/iu],
    ["deployment", /\b(deploy|deployment|restart service|rollback|publish production)\b/iu],
    ["external-action", /\b(auto-post|send customer|execute trade|brokerage|production account)\b/iu],
    ["test-agent", /\b(run tests|execute tests|automated tests|test execution)\b/iu],
    ["review-agent", /\b(review changes|approve review|request changes)\b/iu]
  ]

  return checks.find(([, pattern]) => pattern.test(nextAction))?.[0] || null
}

function classifyNextStage(nextAction) {
  const unsupported = unsupportedStage(nextAction)

  if (unsupported) {
    return {
      ok: false,
      reasonCode: "UNSUPPORTED_STAGE",
      detail: unsupported
    }
  }

  if (actionNeedsProductDecision(nextAction)) {
    return {
      ok: false,
      reasonCode: "PRODUCT_DECISION_REQUIRED"
    }
  }

  if (actionLooksAmbiguous(nextAction)) {
    return {
      ok: false,
      reasonCode: "AMBIGUOUS_PROJECT_STATE"
    }
  }

  const planning = /\b(prepare|read-only|inspect|inspection|summarize|summary|plan|planning|identify|distinguish|research|document|generate scoped codex prompts|codex prompts)\b/iu.test(nextAction)
  const implementation = /\b(add|implement|build|create|update|fix|harden|refactor|wire|integrate|write)\b/iu.test(nextAction)

  if (planning && implementation) {
    return {
      ok: false,
      reasonCode: "AMBIGUOUS_PROJECT_STATE"
    }
  }

  if (implementation) {
    return {
      ok: true,
      nextStage: "implementation"
    }
  }

  if (planning) {
    return {
      ok: true,
      nextStage: "planning"
    }
  }

  return {
    ok: false,
    reasonCode: "UNSUPPORTED_STAGE"
  }
}

function normalizeSnapshot(project, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {
      ok: false,
      reasonCode: "MISSING_GITHUB_FACTS",
      githubFacts: null
    }
  }

  if (snapshot.project?.id !== project.id || snapshot.project?.fullName !== project.fullName) {
    return {
      ok: false,
      reasonCode: "CONTRADICTORY_PROJECT_STATE",
      githubFacts: null
    }
  }

  const latest = Array.isArray(snapshot.recentCommits) ? snapshot.recentCommits[0] : null
  const latestSha = String(latest?.sha ?? "").trim().toLowerCase()
  const repository = snapshot.repository || {}

  if (
    !sha40Pattern.test(latestSha) ||
    typeof repository.defaultBranch !== "string" ||
    !repository.defaultBranch.trim() ||
    repository.fullName !== project.fullName
  ) {
    return {
      ok: false,
      reasonCode: "MISSING_GITHUB_FACTS",
      githubFacts: null
    }
  }

  const openPullRequests = Array.isArray(snapshot.openPullRequests) ? snapshot.openPullRequests : []
  const openIssues = Array.isArray(snapshot.openIssues) ? snapshot.openIssues : []

  if (openPullRequests.length > 0) {
    return {
      ok: false,
      reasonCode: "AMBIGUOUS_PROJECT_STATE",
      githubFacts: {
        repository: {
          defaultBranch: repository.defaultBranch,
          updatedAt: repository.updatedAt || null
        },
        latestCommit: {
          sha: latestSha,
          shortSha: latestSha.slice(0, 7),
          timestamp: latest.timestamp || null
        },
        openPullRequestCount: openPullRequests.length,
        openIssueCount: openIssues.length
      }
    }
  }

  return {
    ok: true,
    baseSha: latestSha,
    githubFacts: {
      repository: {
        defaultBranch: repository.defaultBranch.trim(),
        updatedAt: repository.updatedAt || null
      },
      latestCommit: {
        sha: latestSha,
        shortSha: latestSha.slice(0, 7),
        timestamp: latest.timestamp || null
      },
      openPullRequestCount: openPullRequests.length,
      openIssueCount: openIssues.length
    }
  }
}

async function readPlannerSources(project, options = {}) {
  const projectRef = approvedProjectDocRefs[project.id]
  const [projectDoc, roadmap] = await Promise.all([
    readApprovedSource(projectRef, options),
    readApprovedSource("ROADMAP.md", options)
  ])

  return {
    projectRef,
    roadmapRef: "ROADMAP.md",
    projectDoc,
    roadmap,
    hashes: {
      projectDocSha256: sha256Text(projectDoc),
      roadmapSha256: sha256Text(roadmap)
    }
  }
}

async function getReadOnlySnapshot(project, options = {}) {
  const client = options.githubClient || createGitHubReadOnlyClient(options.githubOptions || {})
  return client.getProjectSnapshot(project.id)
}

function validateRoadmap(roadmapText) {
  if (typeof roadmapText !== "string" || rejectUnsafeText(roadmapText)) {
    return {
      ok: false,
      reasonCode: "UNSAFE_SOURCE_STATE"
    }
  }

  if (!/### Phase 6B - Deterministic autonomous next-stage planner foundation/u.test(roadmapText)) {
    return {
      ok: false,
      reasonCode: "MISSING_PROJECT_STATE"
    }
  }

  return { ok: true }
}

function buildPlanEvidenceRecord(plan) {
  return {
    kind: "planning",
    sha: plan.baseSha,
    source: NEXT_STAGE_PLANNER_ID,
    summary: "Phase 6B deterministic next-stage plan from approved PPO state and GitHub read-only facts.",
    metadata: {
      outcome: plan.outcome,
      nextStage: plan.next.stage,
      project: plan.project.id,
      planHash: plan.planHash,
      projectDocSha256: plan.sourceHashes.projectDocSha256,
      roadmapSha256: plan.sourceHashes.roadmapSha256,
      sourceCount: plan.sourceEvidence.length,
      openIssueCount: plan.githubFacts.openIssueCount,
      openPrCount: plan.githubFacts.openPullRequestCount
    }
  }
}

async function planNextDevelopmentStageInternal(projectId, options = {}) {
  const project = resolvePlannerProject(projectId)
  let sources

  try {
    sources = await readPlannerSources(project, options)
  } catch (error) {
    if (error instanceof DevelopmentNextStagePlannerError) {
      return ownerActionPlan({
        project,
        reasonCode: error.code === "SOURCE_TOO_LARGE" ? "MALFORMED_SOURCE_STATE" : "MISSING_PROJECT_STATE",
        safeSummary: "Approved planner source state could not be read safely; owner action is required.",
        sourceEvidence: [],
        githubFacts: null,
        sourceHashes: null
      })
    }

    throw error
  }

  const roadmapCheck = validateRoadmap(sources.roadmap)

  if (!roadmapCheck.ok) {
    return ownerActionPlan({
      project,
      reasonCode: roadmapCheck.reasonCode,
      safeSummary: "ROADMAP.md does not contain the approved Phase 6B planner boundary.",
      sourceEvidence: [],
      githubFacts: null,
      sourceHashes: sources.hashes
    })
  }

  const parsedProjectDoc = parseLevelTwoSections(sources.projectDoc)

  if (!parsedProjectDoc.ok) {
    return ownerActionPlan({
      project,
      reasonCode: parsedProjectDoc.reasonCode,
      safeSummary: "Project state could not be parsed safely; owner action is required.",
      sourceEvidence: [],
      githubFacts: null,
      sourceHashes: sources.hashes
    })
  }

  const sections = parsedProjectDoc.sections
  const currentResult = currentStateFromSections(sections)
  const projectName = requiredSection(sections, "Project")
  const repo = normalizeRepoSection(requiredSection(sections, "Repo"))
  const connectionStatus = requiredSection(sections, "Connection status")

  if (!projectName || !repo || !connectionStatus || !currentResult.ok) {
    return ownerActionPlan({
      project,
      reasonCode: "MISSING_PROJECT_STATE",
      safeSummary: "Project state is missing a required approved section; owner action is required.",
      current: currentResult.current,
      sourceEvidence: [],
      githubFacts: null,
      sourceHashes: sources.hashes
    })
  }

  const current = currentResult.current
  const baseEvidence = [
    buildSourceEvidence(sources.projectRef, "Current phase", current.phase, {
      sha256: sources.hashes.projectDocSha256
    }),
    buildSourceEvidence(sources.projectRef, "Last known status", current.status, {
      sha256: sources.hashes.projectDocSha256
    }),
    buildSourceEvidence(sources.projectRef, "Next action", current.nextAction, {
      sha256: sources.hashes.projectDocSha256
    }),
    buildSourceEvidence("ROADMAP.md", "Phase 6B", "Phase 6B deterministic next-stage planner boundary is approved.", {
      sha256: sources.hashes.roadmapSha256
    })
  ].filter(Boolean)

  if (repo !== project.fullName || !/^Connected candidate\.$/u.test(connectionStatus)) {
    return ownerActionPlan({
      project,
      reasonCode: "CONTRADICTORY_PROJECT_STATE",
      safeSummary: "Project state conflicts with the fixed connected-project registry; owner action is required.",
      current,
      sourceEvidence: baseEvidence,
      githubFacts: null,
      sourceHashes: sources.hashes
    })
  }

  if (stateLooksContradictory(current)) {
    return ownerActionPlan({
      project,
      reasonCode: "CONTRADICTORY_PROJECT_STATE",
      safeSummary: "Project state says the work is complete while also naming another next action; owner action is required.",
      current,
      sourceEvidence: baseEvidence,
      githubFacts: null,
      sourceHashes: sources.hashes
    })
  }

  if (actionLooksAlreadyComplete(current)) {
    return ownerActionPlan({
      project,
      reasonCode: "ALREADY_COMPLETE",
      safeSummary: "Project state does not name remaining work; owner action is required before opening a run.",
      current,
      sourceEvidence: baseEvidence,
      githubFacts: null,
      sourceHashes: sources.hashes
    })
  }

  const task = normalizeTask(current.nextAction)

  if (!task) {
    return ownerActionPlan({
      project,
      reasonCode: rejectUnsafeText(current.nextAction) ? "UNSAFE_SOURCE_STATE" : "MALFORMED_SOURCE_STATE",
      safeSummary: "Project next action is unsafe or outside the Phase 6B size bound; owner action is required.",
      current: {
        ...current,
        nextAction: null
      },
      sourceEvidence: baseEvidence.filter((entry) => entry.section !== "Next action"),
      githubFacts: null,
      sourceHashes: sources.hashes
    })
  }

  const stageResult = classifyNextStage(task)

  if (!stageResult.ok) {
    return ownerActionPlan({
      project,
      reasonCode: stageResult.reasonCode,
      safeSummary: "Project next action does not map to exactly one Phase 6B-supported next stage.",
      current,
      sourceEvidence: baseEvidence,
      githubFacts: null,
      sourceHashes: sources.hashes
    })
  }

  let snapshot

  try {
    snapshot = await getReadOnlySnapshot(project, options)
  } catch (error) {
    if (error instanceof GitHubReadOnlyError) {
      return ownerActionPlan({
        project,
        reasonCode: "MISSING_GITHUB_FACTS",
        safeSummary: "GitHub read-only facts are unavailable; owner action is required before opening a run.",
        current,
        sourceEvidence: baseEvidence,
        githubFacts: null,
        sourceHashes: sources.hashes
      })
    }

    throw error
  }

  const snapshotResult = normalizeSnapshot(project, snapshot)

  if (!snapshotResult.ok) {
    return ownerActionPlan({
      project,
      reasonCode: snapshotResult.reasonCode,
      safeSummary: "GitHub read-only facts are missing, contradictory, or require owner review.",
      current,
      sourceEvidence: baseEvidence,
      githubFacts: snapshotResult.githubFacts,
      sourceHashes: sources.hashes
    })
  }

  const sourceEvidence = [
    ...baseEvidence,
    buildSourceEvidence("github-readonly", "latest commit", `Latest read-only commit ${snapshotResult.githubFacts.latestCommit.shortSha}.`, {
      sha: snapshotResult.baseSha
    }),
    buildSourceEvidence("github-readonly", "open pull requests", `Open pull request count ${snapshotResult.githubFacts.openPullRequestCount}.`),
    buildSourceEvidence("github-readonly", "open issues", `Open issue count ${snapshotResult.githubFacts.openIssueCount}.`)
  ].filter(Boolean)

  return plannedPlan({
    project,
    current,
    next: {
      stage: stageResult.nextStage,
      task,
      runStatusAfterPlanning: "planned"
    },
    baseSha: snapshotResult.baseSha,
    githubFacts: snapshotResult.githubFacts,
    sourceEvidence,
    sourceHashes: sources.hashes
  })
}

function assertPlanIsExecutable(plan) {
  if (plan?.outcome !== "planned" || !plan.next || !PHASE_6B_SUPPORTED_NEXT_STAGES.includes(plan.next.stage)) {
    throw plannerError(
      "OWNER_ACTION_REQUIRED",
      "Planner outcome requires owner action; no run-state transition was attempted."
    )
  }
}

export async function planNextDevelopmentStage(projectId, options = {}) {
  try {
    return await planNextDevelopmentStageInternal(projectId, options)
  } catch (error) {
    throw safePlannerFailure(error)
  }
}

export async function createPlannedDevelopmentRun(projectId, options = {}) {
  try {
    const plan = await planNextDevelopmentStageInternal(projectId, options)

    if (plan.outcome !== "planned") {
      return {
        ok: false,
        outcome: plan.outcome,
        plan,
        run: null
      }
    }

    assertPlanIsExecutable(plan)

    const created = await createDevelopmentRun({
      projectId: plan.project.id,
      task: plan.next.task,
      baseSha: plan.baseSha,
      branch: plan.githubFacts.repository.defaultBranch,
      headSha: plan.baseSha,
      actor: NEXT_STAGE_PLANNER_ID
    }, options)
    const planning = await transitionDevelopmentRun(created.runId, {
      expectedVersion: created.version,
      status: "planning_in_progress",
      actor: NEXT_STAGE_PLANNER_ID,
      reason: "phase-6b-planning-started"
    }, options)
    const planned = await transitionDevelopmentRun(created.runId, {
      expectedVersion: planning.version,
      status: "planned",
      actor: NEXT_STAGE_PLANNER_ID,
      reason: "phase-6b-plan-ready",
      evidence: [buildPlanEvidenceRecord(plan)]
    }, options)

    return {
      ok: true,
      outcome: "planned",
      plan,
      run: planned
    }
  } catch (error) {
    throw safePlannerFailure(error)
  }
}

export async function planExistingDevelopmentRun(runId, options = {}) {
  try {
    const expectedVersion = options.expectedVersion
    const currentRun = await readDevelopmentRun(runId, options)
    const plan = await planNextDevelopmentStageInternal(currentRun.project.id, options)

    if (plan.outcome !== "planned") {
      return {
        ok: false,
        outcome: plan.outcome,
        plan,
        run: currentRun
      }
    }

    assertPlanIsExecutable(plan)

    const planning = await transitionDevelopmentRun(currentRun.runId, {
      expectedVersion,
      status: "planning_in_progress",
      actor: NEXT_STAGE_PLANNER_ID,
      reason: "phase-6b-planning-started"
    }, options)
    const planned = await transitionDevelopmentRun(currentRun.runId, {
      expectedVersion: planning.version,
      status: "planned",
      actor: NEXT_STAGE_PLANNER_ID,
      reason: "phase-6b-plan-ready",
      evidence: [buildPlanEvidenceRecord(plan)]
    }, options)

    return {
      ok: true,
      outcome: "planned",
      plan,
      run: planned
    }
  } catch (error) {
    throw safePlannerFailure(error)
  }
}

export function formatDevelopmentNextStagePlannerError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO development run-state error [${error.code}]: ${error.safeMessage}`
  }

  if (error instanceof DevelopmentNextStagePlannerError) {
    return `PPO next-stage planner error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO next-stage planner error: unexpected local failure."
}
