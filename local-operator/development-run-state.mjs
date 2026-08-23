import { createHash, randomBytes } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink
} from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import {
  getPhase2GitHubProject,
  listPhase2GitHubProjects
} from "./github-project-registry.mjs"
import {
  DEVELOPMENT_RUN_ID_BYTES,
  DEVELOPMENT_RUN_ID_PATTERN
} from "./development-run-id.mjs"

export {
  DEVELOPMENT_RUN_ID_BYTES,
  DEVELOPMENT_RUN_ID_PATTERN
}

export const PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT = Object.freeze({
  id: "personal-project-operator",
  displayName: "Personal Project Operator",
  owner: "Linardi1328",
  repo: "personal-project-operator",
  fullName: "Linardi1328/personal-project-operator"
})

export const DEVELOPMENT_RUN_SCHEMA_VERSION = 1
export const DEVELOPMENT_RUN_STORE_DIR = "development-runs"
export const MAX_DEVELOPMENT_RUN_TASK_CHARS = 1000
export const MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES = 100
export const MAX_DEVELOPMENT_RUN_RECORD_BYTES = 128 * 1024
export const MAX_DEVELOPMENT_RUN_EVIDENCE_PER_KIND = 32
export const MAX_DEVELOPMENT_RUN_EVIDENCE_PER_TRANSITION = 8
export const MAX_DEVELOPMENT_RUN_METADATA_KEYS = 16
export const MAX_DEVELOPMENT_RUN_METADATA_ARRAY_ITEMS = 16
export const MAX_DEVELOPMENT_RUN_STAGE_ATTEMPTS = 20

export const DEVELOPMENT_RUN_STATUSES = Object.freeze([
  "created",
  "planning_in_progress",
  "planned",
  "implementation_in_progress",
  "implementation_ready",
  "tests_in_progress",
  "tests_failed",
  "tests_passed",
  "review_in_progress",
  "review_changes_requested",
  "review_passed",
  "merge_ready",
  "merged",
  "deploy_in_progress",
  "deploy_failed",
  "deployed",
  "verification_in_progress",
  "verification_failed",
  "rollback_in_progress",
  "rollback_failed",
  "rolled_back",
  "verified",
  "cancelled",
  "failed"
])

export const DEVELOPMENT_RUN_STAGES = Object.freeze([
  "intake",
  "planning",
  "implementation",
  "test",
  "review",
  "merge",
  "deploy",
  "verification",
  "rollback",
  "closed"
])

export const DEVELOPMENT_RUN_EVIDENCE_KINDS = Object.freeze([
  "planning",
  "implementation",
  "review",
  "test",
  "merge",
  "deploy",
  "verification",
  "rollback"
])

export const DEVELOPMENT_RUN_ATTEMPT_KEYS = Object.freeze([
  "planning",
  "implementation",
  "test",
  "review",
  "merge",
  "deploy",
  "verification",
  "rollback"
])

export const ALLOWED_DEVELOPMENT_RUN_TRANSITIONS = Object.freeze({
  created: Object.freeze(["planning_in_progress", "cancelled", "failed"]),
  planning_in_progress: Object.freeze(["planned", "cancelled", "failed"]),
  planned: Object.freeze(["implementation_in_progress", "cancelled", "failed"]),
  implementation_in_progress: Object.freeze(["implementation_ready", "cancelled", "failed"]),
  implementation_ready: Object.freeze(["tests_in_progress", "cancelled", "failed"]),
  tests_in_progress: Object.freeze(["tests_failed", "tests_passed", "cancelled", "failed"]),
  tests_failed: Object.freeze(["implementation_in_progress", "cancelled", "failed"]),
  tests_passed: Object.freeze(["review_in_progress", "cancelled", "failed"]),
  review_in_progress: Object.freeze(["review_changes_requested", "review_passed", "cancelled", "failed"]),
  review_changes_requested: Object.freeze(["implementation_in_progress", "cancelled", "failed"]),
  review_passed: Object.freeze(["review_changes_requested", "merge_ready", "cancelled", "failed"]),
  merge_ready: Object.freeze(["merged", "cancelled", "failed"]),
  merged: Object.freeze(["deploy_in_progress", "cancelled", "failed"]),
  deploy_in_progress: Object.freeze(["deploy_failed", "deployed", "cancelled", "failed"]),
  deploy_failed: Object.freeze(["deploy_in_progress", "cancelled", "failed"]),
  deployed: Object.freeze(["verification_in_progress", "cancelled", "failed"]),
  verification_in_progress: Object.freeze(["verification_failed", "verified", "cancelled", "failed"]),
  verification_failed: Object.freeze(["rollback_in_progress", "deploy_in_progress", "implementation_in_progress", "cancelled", "failed"]),
  rollback_in_progress: Object.freeze(["rolled_back", "rollback_failed", "cancelled", "failed"]),
  rollback_failed: Object.freeze(["rollback_in_progress", "implementation_in_progress", "cancelled", "failed"]),
  rolled_back: Object.freeze(["implementation_in_progress", "cancelled", "failed"]),
  verified: Object.freeze([]),
  cancelled: Object.freeze([]),
  failed: Object.freeze([])
})

const statusSet = new Set(DEVELOPMENT_RUN_STATUSES)
const evidenceKindSet = new Set(DEVELOPMENT_RUN_EVIDENCE_KINDS)
const phase6ALegacyEvidenceKindKeys = Object.freeze([
  "implementation",
  "review",
  "test",
  "deploy",
  "verification"
])
const prePhase6GEvidenceKindKeys = Object.freeze([
  "planning",
  "implementation",
  "review",
  "test",
  "deploy",
  "verification"
])
const phase6GLegacyPlanningEvidenceKindKeys = Object.freeze([
  "implementation",
  "review",
  "test",
  "merge",
  "deploy",
  "verification"
])
const phase6JPlanningLegacyEvidenceKindKeys = DEVELOPMENT_RUN_EVIDENCE_KINDS.filter((kind) => kind !== "planning")
const prePhase6JAttemptKeys = Object.freeze([
  "planning",
  "implementation",
  "test",
  "review",
  "merge",
  "deploy",
  "verification"
])
const prePhase6JEvidenceKindKeys = Object.freeze([
  "planning",
  "implementation",
  "review",
  "test",
  "merge",
  "deploy",
  "verification"
])
const stageSet = new Set(DEVELOPMENT_RUN_STAGES)
const terminalStatusSet = new Set(["verified", "cancelled", "failed"])
const shaPattern = /^[a-f0-9]{40}$/iu
const actorPattern = /^[A-Za-z0-9_.:-]{1,80}$/u
const metadataKeyPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/u
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u
const versionFilePattern = /^(\d{6})\.json$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const forbiddenMetadataKeyPattern = /(?:raw|stderr|stdout|stack|exception|error|token|secret|password|credential|authorization|auth)/iu

const stageByStatus = Object.freeze({
  created: "intake",
  planning_in_progress: "planning",
  planned: "planning",
  implementation_in_progress: "implementation",
  implementation_ready: "implementation",
  tests_in_progress: "test",
  tests_failed: "test",
  tests_passed: "test",
  review_in_progress: "review",
  review_changes_requested: "review",
  review_passed: "review",
  merge_ready: "merge",
  merged: "merge",
  deploy_in_progress: "deploy",
  deploy_failed: "deploy",
  deployed: "deploy",
  verification_in_progress: "verification",
  verification_failed: "verification",
  rollback_in_progress: "rollback",
  rollback_failed: "rollback",
  rolled_back: "rollback",
  verified: "closed",
  cancelled: "closed",
  failed: "closed"
})

const attemptKeyByEnteringStatus = Object.freeze({
  planning_in_progress: "planning",
  implementation_in_progress: "implementation",
  tests_in_progress: "test",
  review_in_progress: "review",
  merge_ready: "merge",
  deploy_in_progress: "deploy",
  verification_in_progress: "verification",
  rollback_in_progress: "rollback"
})
const sameStatusAttemptStatuses = new Set([
  "implementation_in_progress",
  "tests_in_progress",
  "review_changes_requested",
  "review_passed",
  "merge_ready"
])

export class DevelopmentRunStateError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "DevelopmentRunStateError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

export class DevelopmentRunStateAmbiguousError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentRunStateAmbiguousError"
    this.stateCommitted = true
  }
}

function runStateError(code, safeMessage) {
  return new DevelopmentRunStateError(code, safeMessage)
}

function safeRunStateFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
    return runStateError(
      "RUN_STORE_UNAVAILABLE",
      "Development run state store is unavailable; confirm private write-data permissions before retrying."
    )
  }

  return runStateError(
    "RUN_STORE_UNAVAILABLE",
    "Development run state store is unavailable; no raw failure was stored."
  )
}

function allowedProjectIdList() {
  return listPhase2GitHubProjects().map((project) => project.id).join(", ")
}

function repoFullName(project) {
  return `${project.owner}/${project.repo}`
}

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date()
  }

  return date
}

function timestamp(now) {
  const value = now instanceof Date ? now : new Date(now)

  if (Number.isNaN(value.getTime())) {
    return new Date().toISOString()
  }

  return value.toISOString()
}

function isIsoTimestamp(value) {
  const parsed = Date.parse(value)
  return typeof value === "string" && Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PPO_WRITE_DATA_DIR
}

function storePaths(runId = null, options = {}) {
  const root = resolveWriteDataDir(options)
  const runRoot = join(root, DEVELOPMENT_RUN_STORE_DIR)
  const versionsRoot = join(runRoot, "versions")
  const paths = {
    root,
    runRoot,
    recordsDir: join(runRoot, "records"),
    versionsRoot
  }

  if (runId !== null) {
    const normalizedRunId = normalizeDevelopmentRunId(runId)
    paths.recordPath = join(paths.recordsDir, `${normalizedRunId}.json`)
    paths.versionDir = join(versionsRoot, normalizedRunId)
  }

  return paths
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function ensureStore(paths) {
  await ensurePrivateDir(paths.root)
  await ensurePrivateDir(paths.runRoot)
  await ensurePrivateDir(paths.recordsDir)
  await ensurePrivateDir(paths.versionsRoot)

  if (paths.versionDir) {
    await ensurePrivateDir(paths.versionDir)
  }
}

async function syncDirectory(path) {
  const directory = await open(path, "r")

  try {
    await directory.sync()
  } finally {
    await directory.close()
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

function eventHash(event) {
  const hashable = { ...event }
  delete hashable.eventHash
  return sha256Text(stableStringify(hashable))
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys)
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => allowed.has(key))
}

function rejectUnsafeText(value, code, safeMessage) {
  if (unsafeControlPattern.test(value) || sensitiveTextPattern.test(value)) {
    throw runStateError(code, safeMessage)
  }
}

function normalizeSafeText(value, {
  fieldName,
  maxChars,
  required = false,
  code = "INVALID_INPUT",
  safeMessage = `${fieldName} is invalid.`
}) {
  if (value === null || value === undefined) {
    if (required) {
      throw runStateError(code, safeMessage)
    }

    return null
  }

  const normalized = String(value).trim()

  if (!normalized && required) {
    throw runStateError(code, safeMessage)
  }

  if (normalized.length > maxChars) {
    throw runStateError(code, safeMessage)
  }

  rejectUnsafeText(normalized, code, safeMessage)
  return normalized || null
}

function normalizeSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw runStateError(
      "INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeOptionalSha(value, fieldName = "SHA") {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null
  }

  return normalizeSha(value, fieldName)
}

function normalizeBranch(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null
  }

  const normalized = String(value).trim()

  if (
    !branchPattern.test(normalized) ||
    normalized.includes("..") ||
    normalized.includes("//") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".lock")
  ) {
    throw runStateError(
      "INVALID_BRANCH",
      "Branch metadata is invalid; no run-state write was attempted."
    )
  }

  rejectUnsafeText(
    normalized,
    "INVALID_BRANCH",
    "Branch metadata is invalid; no run-state write was attempted."
  )
  return normalized
}

function normalizeActor(value) {
  const normalized = value === null || value === undefined || String(value).trim() === ""
    ? "local-operator"
    : String(value).trim()

  if (!actorPattern.test(normalized)) {
    throw runStateError(
      "INVALID_ACTOR",
      "Run-state actor metadata is invalid; no run-state write was attempted."
    )
  }

  rejectUnsafeText(
    normalized,
    "INVALID_ACTOR",
    "Run-state actor metadata is invalid; no run-state write was attempted."
  )
  return normalized
}

export function normalizeDevelopmentRunId(runId) {
  const normalized = String(runId ?? "").trim()

  if (!DEVELOPMENT_RUN_ID_PATTERN.test(normalized)) {
    throw runStateError(
      "INVALID_RUN_ID",
      "Development run id is malformed."
    )
  }

  return normalized
}

export function makeDevelopmentRunId({ randomBytesImpl = randomBytes } = {}) {
  const runId = randomBytesImpl(DEVELOPMENT_RUN_ID_BYTES).toString("base64url")

  if (!DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    throw runStateError(
      "RUN_ID_GENERATION_FAILED",
      "Development run id could not be generated; no run-state write was attempted."
    )
  }

  return runId
}

export function resolveDevelopmentRunProject(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw runStateError(
      "INVALID_PROJECT",
      `Project id is required. Use one of: ${allowedProjectIdList()}.`
    )
  }

  const normalized = projectId.trim()
  const project = getPhase2GitHubProject(normalized)

  if (!project) {
    throw runStateError(
      "UNKNOWN_PROJECT",
      `Project id is not in the connected project allowlist. Use one of: ${allowedProjectIdList()}.`
    )
  }

  return {
    ...project,
    fullName: repoFullName(project)
  }
}

export function normalizeDevelopmentRunStatus(status) {
  const normalized = String(status ?? "").trim()

  if (!statusSet.has(normalized)) {
    throw runStateError(
      "INVALID_RUN_STATUS",
      "Development run status is not allowed."
    )
  }

  return normalized
}

function stageForStatus(status) {
  const stage = stageByStatus[status]

  if (!stage || !stageSet.has(stage)) {
    throw runStateError(
      "INVALID_RUN_STATUS",
      "Development run status is not allowed."
    )
  }

  return stage
}

export function stageForDevelopmentRunStatus(status) {
  return stageForStatus(normalizeDevelopmentRunStatus(status))
}

export function isDevelopmentRunTerminalStatus(status) {
  return terminalStatusSet.has(normalizeDevelopmentRunStatus(status))
}

function assertAllowedTransition(fromStatus, toStatus) {
  const allowed = ALLOWED_DEVELOPMENT_RUN_TRANSITIONS[fromStatus] || []

  if (!allowed.includes(toStatus)) {
    throw runStateError(
      "INVALID_RUN_TRANSITION",
      "Development run lifecycle transition is not allowed; reload state and use the next explicit transition."
    )
  }
}

function emptyAttempts() {
  return Object.fromEntries(DEVELOPMENT_RUN_ATTEMPT_KEYS.map((key) => [key, 0]))
}

function emptyEvidence() {
  return Object.fromEntries(DEVELOPMENT_RUN_EVIDENCE_KINDS.map((kind) => [kind, []]))
}

function incrementAttempts(attempts, toStatus) {
  const key = attemptKeyByEnteringStatus[toStatus]

  if (!key) {
    return { ...attempts }
  }

  return incrementAttemptKey(attempts, key)
}

function incrementAttemptKey(attempts, key) {
  const next = { ...attempts }
  next[key] += 1

  if (next[key] > MAX_DEVELOPMENT_RUN_STAGE_ATTEMPTS) {
    throw runStateError(
      "ATTEMPT_LIMIT_REACHED",
      "Development run attempt counter limit was reached; no run-state write was attempted."
    )
  }

  return next
}

function incrementSameStatusAttempt(attempts, status) {
  if (!sameStatusAttemptStatuses.has(status)) {
    throw runStateError(
      "INVALID_RUN_TRANSITION",
      "Development run progress update is not allowed for this lifecycle status."
    )
  }

  const key = attemptKeyByEnteringStatus[status]

  if (!key) {
    throw runStateError(
      "INVALID_RUN_TRANSITION",
      "Development run progress update is not allowed for this lifecycle status."
    )
  }

  return incrementAttemptKey(attempts, key)
}

function normalizeMetadataValue(value) {
  if (value === null) {
    return null
  }

  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw runStateError(
        "INVALID_EVIDENCE",
        "Evidence metadata is invalid; no run-state write was attempted."
      )
    }

    return value
  }

  if (typeof value === "string") {
    const normalized = normalizeSafeText(value, {
      fieldName: "Evidence metadata",
      maxChars: 200,
      required: false,
      code: "INVALID_EVIDENCE",
      safeMessage: "Evidence metadata is invalid; no run-state write was attempted."
    })

    return normalized || ""
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_DEVELOPMENT_RUN_METADATA_ARRAY_ITEMS) {
      throw runStateError(
        "INVALID_EVIDENCE",
        "Evidence metadata is invalid; no run-state write was attempted."
      )
    }

    return value.map((entry) => {
      if (entry && typeof entry === "object") {
        throw runStateError(
          "INVALID_EVIDENCE",
          "Evidence metadata is invalid; no run-state write was attempted."
        )
      }

      return normalizeMetadataValue(entry)
    })
  }

  throw runStateError(
    "INVALID_EVIDENCE",
    "Evidence metadata is invalid; no run-state write was attempted."
  )
}

function normalizeEvidenceMetadata(metadata = {}) {
  if (metadata === null || metadata === undefined) {
    return {}
  }

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw runStateError(
      "INVALID_EVIDENCE",
      "Evidence metadata is invalid; no run-state write was attempted."
    )
  }

  const entries = Object.entries(metadata)

  if (entries.length > MAX_DEVELOPMENT_RUN_METADATA_KEYS) {
    throw runStateError(
      "EVIDENCE_LIMIT_REACHED",
      "Evidence metadata is too large; no run-state write was attempted."
    )
  }

  const normalized = {}

  for (const [key, value] of entries) {
    if (!metadataKeyPattern.test(key) || forbiddenMetadataKeyPattern.test(key)) {
      throw runStateError(
        "INVALID_EVIDENCE",
        "Evidence metadata is invalid; no run-state write was attempted."
      )
    }

    normalized[key] = normalizeMetadataValue(value)
  }

  return normalized
}

export function normalizeDevelopmentRunEvidenceRecord(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw runStateError(
      "INVALID_EVIDENCE",
      "Evidence metadata is invalid; no run-state write was attempted."
    )
  }

  const kind = String(input.kind ?? "").trim()

  if (!evidenceKindSet.has(kind)) {
    throw runStateError(
      "INVALID_EVIDENCE",
      "Evidence metadata is invalid; no run-state write was attempted."
    )
  }

  const evidence = {
    kind,
    sha: normalizeSha(input.sha, "Evidence SHA"),
    recordedAt: timestamp(nowDate(options)),
    source: normalizeSafeText(input.source, {
      fieldName: "Evidence source",
      maxChars: 80,
      required: false,
      code: "INVALID_EVIDENCE",
      safeMessage: "Evidence metadata is invalid; no run-state write was attempted."
    }),
    summary: normalizeSafeText(input.summary, {
      fieldName: "Evidence summary",
      maxChars: 500,
      required: false,
      code: "INVALID_EVIDENCE",
      safeMessage: "Evidence metadata is invalid; no run-state write was attempted."
    }),
    metadata: normalizeEvidenceMetadata(input.metadata)
  }

  if (Buffer.byteLength(stableStringify(evidence), "utf8") > 4096) {
    throw runStateError(
      "EVIDENCE_LIMIT_REACHED",
      "Evidence metadata is too large; no run-state write was attempted."
    )
  }

  return evidence
}

function normalizeEvidenceList(evidenceInput = [], options = {}) {
  const evidence = Array.isArray(evidenceInput)
    ? evidenceInput
    : [evidenceInput]

  if (evidence.length > MAX_DEVELOPMENT_RUN_EVIDENCE_PER_TRANSITION) {
    throw runStateError(
      "EVIDENCE_LIMIT_REACHED",
      "Too many evidence records were supplied; no run-state write was attempted."
    )
  }

  return evidence
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => normalizeDevelopmentRunEvidenceRecord(entry, options))
}

function appendEvidence(existing, additions) {
  const next = Object.fromEntries(
    DEVELOPMENT_RUN_EVIDENCE_KINDS.map((kind) => [kind, [...existing[kind]]])
  )

  for (const evidence of additions) {
    next[evidence.kind].push(evidence)

    if (next[evidence.kind].length > MAX_DEVELOPMENT_RUN_EVIDENCE_PER_KIND) {
      throw runStateError(
        "EVIDENCE_LIMIT_REACHED",
        "Development run evidence limit was reached; no run-state write was attempted."
      )
    }
  }

  return next
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function serializeRecord(record) {
  const data = `${JSON.stringify(record)}\n`

  if (Buffer.byteLength(data, "utf8") > MAX_DEVELOPMENT_RUN_RECORD_BYTES) {
    throw runStateError(
      "RUN_RECORD_TOO_LARGE",
      "Development run record is too large; no run-state write was attempted."
    )
  }

  return data
}

function versionFileName(version) {
  return `${String(version).padStart(6, "0")}.json`
}

async function atomicDurableWriteCanonical(path, data) {
  const directory = dirname(path)
  const tempPath = join(
    directory,
    `.ppo-development-run.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
  )
  let file
  let renamed = false

  try {
    file = await open(tempPath, "wx", 0o600)
    await file.writeFile(data, "utf8")
    await file.sync()
    await file.close()
    file = null
    await chmod(tempPath, 0o600)
    await rename(tempPath, path)
    renamed = true
    await chmod(path, 0o600)
    await syncDirectory(directory)
  } catch (error) {
    try {
      await file?.close()
    } catch {
      // Best effort only; no raw filesystem error is surfaced.
    }

    if (!renamed) {
      try {
        await unlink(tempPath)
      } catch {
        // Best effort cleanup of a private temp file.
      }
    }

    if (renamed) {
      throw new DevelopmentRunStateAmbiguousError(
        "RUN_DURABILITY_AMBIGUOUS",
        "Development run state was replaced but directory durability could not be confirmed. Reload run state before retrying."
      )
    }

    throw error
  }
}

async function writeExclusiveDurableVersionMarker(path, data) {
  const directory = dirname(path)
  const tempPath = join(
    directory,
    `.ppo-development-run-version.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
  )
  let file

  try {
    file = await open(tempPath, "wx", 0o600)
    await file.writeFile(data, "utf8")
    await file.sync()
    await file.close()
    file = null
    await chmod(tempPath, 0o600)
    await link(tempPath, path)
    await chmod(path, 0o600)
    await unlink(tempPath)
    await syncDirectory(directory)
  } catch (error) {
    try {
      await file?.close()
    } catch {
      // Best effort only; no raw filesystem error is surfaced.
    }

    try {
      await unlink(tempPath)
    } catch {
      // Best effort cleanup of a private temp file.
    }

    if (error?.code === "EEXIST") {
      throw runStateError(
        "STALE_RUN_VERSION",
        "Development run state changed concurrently; reload before retrying."
      )
    }

    throw error
  }
}

async function readRegularFileIfPresent(path, description) {
  let info

  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  }

  if (!info.isFile() || info.isSymbolicLink()) {
    throw runStateError(
      "UNSAFE_LOCAL_PATH",
      `${description} is not a regular private file.`
    )
  }

  if (info.size > MAX_DEVELOPMENT_RUN_RECORD_BYTES) {
    throw runStateError(
      "RUN_RECORD_TOO_LARGE",
      `${description} is too large.`
    )
  }

  return readFile(path, "utf8")
}

function buildHistoryEvent({
  version,
  timestamp: eventTimestamp,
  actor,
  reason,
  project,
  task,
  baseSha,
  fromStatus,
  toStatus,
  fromStage,
  toStage,
  branch,
  headSha,
  evidence,
  attempts,
  previousHistoryHash
}) {
  const event = {
    schemaVersion: DEVELOPMENT_RUN_SCHEMA_VERSION,
    version,
    timestamp: eventTimestamp,
    actor,
    reason,
    project: project.id,
    repo: project.fullName,
    task: version === 0 ? task : null,
    baseSha: version === 0 ? baseSha : null,
    fromStatus,
    toStatus,
    fromStage,
    toStage,
    branch,
    headSha,
    evidence,
    attempts,
    previousHistoryHash
  }

  return {
    ...event,
    eventHash: eventHash(event)
  }
}

function buildInitialRecord({
  runId,
  project,
  task,
  baseSha,
  branch,
  headSha,
  createdAt,
  actor
}) {
  const attempts = emptyAttempts()
  const evidence = emptyEvidence()
  const status = "created"
  const stage = stageForStatus(status)
  const historyEvent = buildHistoryEvent({
    version: 0,
    timestamp: createdAt,
    actor,
    reason: null,
    project,
    task,
    baseSha,
    fromStatus: null,
    toStatus: status,
    fromStage: null,
    toStage: stage,
    branch,
    headSha,
    evidence: [],
    attempts,
    previousHistoryHash: null
  })

  return {
    schemaVersion: DEVELOPMENT_RUN_SCHEMA_VERSION,
    runId,
    version: 0,
    project,
    task,
    stage,
    status,
    baseSha,
    branch,
    headSha,
    attempts,
    timestamps: {
      createdAt,
      updatedAt: createdAt,
      statusChangedAt: createdAt,
      terminalAt: null
    },
    evidence,
    historyHash: historyEvent.eventHash,
    history: [historyEvent]
  }
}

function applyTransition(record, {
  toStatus,
  branch,
  headSha,
  evidence,
  actor,
  reason,
  now
}) {
  assertAllowedTransition(record.status, toStatus)

  if (record.history.length >= MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES) {
    throw runStateError(
      "RUN_HISTORY_LIMIT_REACHED",
      "Development run history limit was reached; no run-state write was attempted."
    )
  }

  const nextVersion = record.version + 1
  const nextStage = stageForStatus(toStatus)
  const nextAttempts = incrementAttempts(record.attempts, toStatus)
  const nextBranch = branch === undefined ? record.branch : normalizeBranch(branch)
  const nextHeadSha = headSha === undefined ? record.headSha : normalizeOptionalSha(headSha, "Head SHA")
  const nextEvidence = appendEvidence(record.evidence, evidence)
  const updatedAt = timestamp(now)
  const event = buildHistoryEvent({
    version: nextVersion,
    timestamp: updatedAt,
    actor,
    reason,
    project: record.project,
    task: record.task,
    baseSha: record.baseSha,
    fromStatus: record.status,
    toStatus,
    fromStage: record.stage,
    toStage: nextStage,
    branch: nextBranch,
    headSha: nextHeadSha,
    evidence,
    attempts: nextAttempts,
    previousHistoryHash: record.historyHash
  })
  const terminalAt = isDevelopmentRunTerminalStatus(toStatus)
    ? updatedAt
    : null

  return {
    ...record,
    version: nextVersion,
    stage: nextStage,
    status: toStatus,
    branch: nextBranch,
    headSha: nextHeadSha,
    attempts: nextAttempts,
    timestamps: {
      ...record.timestamps,
      updatedAt,
      statusChangedAt: updatedAt,
      terminalAt
    },
    evidence: nextEvidence,
    historyHash: event.eventHash,
    history: [...record.history, event]
  }
}

function applyProgressUpdate(record, {
  branch,
  headSha,
  evidence,
  actor,
  reason,
  now,
  incrementAttempt = false
}) {
  if (!sameStatusAttemptStatuses.has(record.status)) {
    throw runStateError(
      "INVALID_RUN_TRANSITION",
      "Development run progress update is not allowed for this lifecycle status."
    )
  }

  if (record.history.length >= MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES) {
    throw runStateError(
      "RUN_HISTORY_LIMIT_REACHED",
      "Development run history limit was reached; no run-state write was attempted."
    )
  }

  const nextVersion = record.version + 1
  const nextAttempts = incrementAttempt
    ? incrementSameStatusAttempt(record.attempts, record.status)
    : { ...record.attempts }
  const nextBranch = branch === undefined ? record.branch : normalizeBranch(branch)
  const nextHeadSha = headSha === undefined ? record.headSha : normalizeOptionalSha(headSha, "Head SHA")
  const nextEvidence = appendEvidence(record.evidence, evidence)
  const updatedAt = timestamp(now)
  const event = buildHistoryEvent({
    version: nextVersion,
    timestamp: updatedAt,
    actor,
    reason,
    project: record.project,
    task: record.task,
    baseSha: record.baseSha,
    fromStatus: record.status,
    toStatus: record.status,
    fromStage: record.stage,
    toStage: record.stage,
    branch: nextBranch,
    headSha: nextHeadSha,
    evidence,
    attempts: nextAttempts,
    previousHistoryHash: record.historyHash
  })

  return {
    ...record,
    version: nextVersion,
    branch: nextBranch,
    headSha: nextHeadSha,
    attempts: nextAttempts,
    timestamps: {
      ...record.timestamps,
      updatedAt,
      statusChangedAt: updatedAt
    },
    evidence: nextEvidence,
    historyHash: event.eventHash,
    history: [...record.history, event]
  }
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES) {
    throw runStateError(
      "INVALID_EXPECTED_VERSION",
      "Expected development run version is invalid."
    )
  }

  return value
}

function resolveOptionalDevelopmentRunProject(projectId, options = {}) {
  if (
    options.allowPersonalProjectOperatorSelfDevelopmentProject === true &&
    projectId === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id
  ) {
    return PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
  }

  return null
}

function normalizeProjectShape(project, options = {}) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }

  const resolved = resolveOptionalDevelopmentRunProject(project.id, options) || resolveDevelopmentRunProject(project.id)

  if (
    project.displayName !== resolved.displayName ||
    project.owner !== resolved.owner ||
    project.repo !== resolved.repo ||
    project.fullName !== resolved.fullName
  ) {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }

  return resolved
}

function normalizeAttemptShape(attempts) {
  if (!attempts || typeof attempts !== "object" || Array.isArray(attempts) || !(
    hasOnlyKeys(attempts, DEVELOPMENT_RUN_ATTEMPT_KEYS) ||
    hasOnlyKeys(attempts, prePhase6JAttemptKeys)
  )) {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }

  const normalized = {
    ...emptyAttempts(),
    ...attempts
  }

  for (const key of DEVELOPMENT_RUN_ATTEMPT_KEYS) {
    if (!Number.isInteger(normalized[key]) || normalized[key] < 0 || normalized[key] > MAX_DEVELOPMENT_RUN_STAGE_ATTEMPTS) {
      throw runStateError(
        "RUN_RECORD_INVALID",
        "Stored development run record is invalid."
      )
    }
  }

  return normalized
}

function validateAttemptShape(attempts) {
  normalizeAttemptShape(attempts)
}

function validateEvidenceShape(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || !(
    hasOnlyKeys(evidence, DEVELOPMENT_RUN_EVIDENCE_KINDS) ||
    hasOnlyKeys(evidence, phase6JPlanningLegacyEvidenceKindKeys) ||
    hasOnlyKeys(evidence, prePhase6JEvidenceKindKeys) ||
    hasOnlyKeys(evidence, phase6GLegacyPlanningEvidenceKindKeys) ||
    hasOnlyKeys(evidence, prePhase6GEvidenceKindKeys) ||
    hasOnlyKeys(evidence, phase6ALegacyEvidenceKindKeys)
  )) {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }

  for (const kind of DEVELOPMENT_RUN_EVIDENCE_KINDS) {
    if (!Object.hasOwn(evidence, kind)) {
      evidence[kind] = []
    }
  }

  for (const kind of DEVELOPMENT_RUN_EVIDENCE_KINDS) {
    if (!Array.isArray(evidence[kind]) || evidence[kind].length > MAX_DEVELOPMENT_RUN_EVIDENCE_PER_KIND) {
      throw runStateError(
        "RUN_RECORD_INVALID",
        "Stored development run record is invalid."
      )
    }

    for (const entry of evidence[kind]) {
      const normalized = normalizeDevelopmentRunEvidenceRecord(entry, {
        now: () => new Date(entry.recordedAt)
      })

      if (stableStringify(normalized) !== stableStringify(entry)) {
        throw runStateError(
          "RUN_RECORD_INVALID",
          "Stored development run record is invalid."
        )
      }
    }
  }
}

function validateTimestamps(timestamps) {
  if (
    !timestamps ||
    typeof timestamps !== "object" ||
    Array.isArray(timestamps) ||
    !hasOnlyKeys(timestamps, ["createdAt", "updatedAt", "statusChangedAt", "terminalAt"]) ||
    !isIsoTimestamp(timestamps.createdAt) ||
    !isIsoTimestamp(timestamps.updatedAt) ||
    !isIsoTimestamp(timestamps.statusChangedAt) ||
    (timestamps.terminalAt !== null && !isIsoTimestamp(timestamps.terminalAt))
  ) {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }
}

function validateHistoryEventShape(event) {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    !hasOnlyKeys(event, [
      "schemaVersion",
      "version",
      "timestamp",
      "actor",
      "reason",
      "project",
      "repo",
      "task",
      "baseSha",
      "fromStatus",
      "toStatus",
      "fromStage",
      "toStage",
      "branch",
      "headSha",
      "evidence",
      "attempts",
      "previousHistoryHash",
      "eventHash"
    ]) ||
    event.schemaVersion !== DEVELOPMENT_RUN_SCHEMA_VERSION ||
    !Number.isInteger(event.version) ||
    !isIsoTimestamp(event.timestamp) ||
    !actorPattern.test(event.actor) ||
    (event.reason !== null && typeof event.reason !== "string") ||
    typeof event.project !== "string" ||
    typeof event.repo !== "string" ||
    !statusSet.has(event.toStatus) ||
    (event.fromStatus !== null && !statusSet.has(event.fromStatus)) ||
    !stageSet.has(event.toStage) ||
    (event.fromStage !== null && !stageSet.has(event.fromStage)) ||
    (event.branch !== null && typeof event.branch !== "string") ||
    (event.headSha !== null && !shaPattern.test(event.headSha)) ||
    !Array.isArray(event.evidence) ||
    event.evidence.length > MAX_DEVELOPMENT_RUN_EVIDENCE_PER_TRANSITION ||
    typeof event.eventHash !== "string"
  ) {
    throw runStateError(
      "RUN_HISTORY_INVALID",
      "Stored development run transition history is invalid."
    )
  }

  rejectUnsafeText(
    event.actor,
    "RUN_HISTORY_INVALID",
    "Stored development run transition history is invalid."
  )

  if (event.reason !== null) {
    normalizeSafeText(event.reason, {
      fieldName: "History reason",
      maxChars: 500,
      required: false,
      code: "RUN_HISTORY_INVALID",
      safeMessage: "Stored development run transition history is invalid."
    })
  }

  if (event.branch !== null) {
    normalizeBranch(event.branch)
  }

  validateAttemptShape(event.attempts)

  for (const entry of event.evidence) {
    const normalized = normalizeDevelopmentRunEvidenceRecord(entry, {
      now: () => new Date(entry.recordedAt)
    })

    if (stableStringify(normalized) !== stableStringify(entry)) {
      throw runStateError(
        "RUN_HISTORY_INVALID",
        "Stored development run transition history is invalid."
      )
    }
  }
}

function validateHistory(record) {
  if (!Array.isArray(record.history) || record.history.length === 0 || record.history.length > MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES) {
    throw runStateError(
      "RUN_HISTORY_INVALID",
      "Stored development run transition history is invalid."
    )
  }

  let previousHash = null
  let previousStatus = null
  let previousStage = null
  let previousTimestampMs = null
  let attempts = emptyAttempts()
  let evidence = emptyEvidence()

  for (let index = 0; index < record.history.length; index += 1) {
    const event = record.history[index]
    validateHistoryEventShape(event)
    const eventAttempts = normalizeAttemptShape(event.attempts)

    if (
      event.version !== index ||
      event.previousHistoryHash !== previousHash ||
      event.eventHash !== eventHash(event) ||
      (index === 0 && (
        event.fromStatus !== null ||
        event.fromStage !== null ||
        event.toStatus !== "created" ||
        event.toStage !== "intake" ||
        event.task !== record.task ||
        event.baseSha !== record.baseSha
      )) ||
      (index > 0 && (
        event.fromStatus !== previousStatus ||
        event.fromStage !== previousStage ||
        event.task !== null ||
        event.baseSha !== null
      ))
    ) {
      throw runStateError(
        "RUN_HISTORY_INVALID",
        "Stored development run transition history is invalid."
      )
    }

    if (index > 0 && event.fromStatus !== event.toStatus) {
      assertAllowedTransition(event.fromStatus, event.toStatus)
      attempts = incrementAttempts(attempts, event.toStatus)
    } else if (index > 0) {
      if (!sameStatusAttemptStatuses.has(event.toStatus)) {
        throw runStateError(
          "RUN_HISTORY_INVALID",
          "Stored development run transition history is invalid."
        )
      }

      const sameStatusAttempts = { ...attempts }
      let incrementedAttempts = null

      try {
        incrementedAttempts = incrementSameStatusAttempt(attempts, event.toStatus)
      } catch {
        incrementedAttempts = null
      }

      if (stableStringify(eventAttempts) === stableStringify(sameStatusAttempts)) {
        attempts = sameStatusAttempts
      } else if (incrementedAttempts && stableStringify(eventAttempts) === stableStringify(incrementedAttempts)) {
        attempts = incrementedAttempts
      } else {
        throw runStateError(
          "RUN_HISTORY_INVALID",
          "Stored development run transition history is invalid."
        )
      }
    }

    if (stableStringify(attempts) !== stableStringify(eventAttempts)) {
      throw runStateError(
        "RUN_HISTORY_INVALID",
        "Stored development run transition history is invalid."
      )
    }

    evidence = appendEvidence(evidence, event.evidence)

    if (event.toStage !== stageForStatus(event.toStatus)) {
      throw runStateError(
        "RUN_HISTORY_INVALID",
        "Stored development run transition history is invalid."
      )
    }

    const eventTimestampMs = Date.parse(event.timestamp)

    if (previousTimestampMs !== null && eventTimestampMs < previousTimestampMs) {
      throw runStateError(
        "RUN_HISTORY_INVALID",
        "Stored development run transition history is invalid."
      )
    }

    previousTimestampMs = eventTimestampMs
    previousHash = event.eventHash
    previousStatus = event.toStatus
    previousStage = event.toStage
  }

  const lastEvent = record.history.at(-1)

  if (
    record.version !== lastEvent.version ||
    record.status !== lastEvent.toStatus ||
    record.stage !== lastEvent.toStage ||
    record.historyHash !== lastEvent.eventHash ||
    record.timestamps.createdAt !== record.history[0].timestamp ||
    record.timestamps.updatedAt !== lastEvent.timestamp ||
    record.timestamps.statusChangedAt !== lastEvent.timestamp ||
    record.timestamps.terminalAt !== (isDevelopmentRunTerminalStatus(record.status) ? lastEvent.timestamp : null) ||
    stableStringify(record.attempts) !== stableStringify(normalizeAttemptShape(lastEvent.attempts)) ||
    stableStringify(record.evidence) !== stableStringify(evidence)
  ) {
    throw runStateError(
      "RUN_HISTORY_INVALID",
      "Stored development run transition history is invalid."
    )
  }
}

function parseRunRecord(payload, expectedRunId = null, options = {}) {
  if (Buffer.byteLength(String(payload ?? ""), "utf8") > MAX_DEVELOPMENT_RUN_RECORD_BYTES) {
    throw runStateError(
      "RUN_RECORD_TOO_LARGE",
      "Stored development run record is too large."
    )
  }

  let parsed

  try {
    parsed = JSON.parse(payload)
  } catch {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !hasOnlyKeys(parsed, [
      "schemaVersion",
      "runId",
      "version",
      "project",
      "task",
      "stage",
      "status",
      "baseSha",
      "branch",
      "headSha",
      "attempts",
      "timestamps",
      "evidence",
      "historyHash",
      "history"
    ]) ||
    parsed.schemaVersion !== DEVELOPMENT_RUN_SCHEMA_VERSION
  ) {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }

  const runId = normalizeDevelopmentRunId(parsed.runId)

  if (expectedRunId && runId !== expectedRunId) {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }

  const status = normalizeDevelopmentRunStatus(parsed.status)
  const stage = stageForStatus(status)

  if (
    !Number.isInteger(parsed.version) ||
    parsed.version < 0 ||
    parsed.version >= MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES ||
    parsed.stage !== stage ||
    parsed.task !== normalizeSafeText(parsed.task, {
      fieldName: "Task",
      maxChars: MAX_DEVELOPMENT_RUN_TASK_CHARS,
      required: true,
      code: "RUN_RECORD_INVALID",
      safeMessage: "Stored development run record is invalid."
    }) ||
    parsed.baseSha !== normalizeSha(parsed.baseSha, "Base SHA") ||
    parsed.branch !== normalizeBranch(parsed.branch) ||
    parsed.headSha !== normalizeOptionalSha(parsed.headSha, "Head SHA")
  ) {
    throw runStateError(
      "RUN_RECORD_INVALID",
      "Stored development run record is invalid."
    )
  }

  parsed.project = normalizeProjectShape(parsed.project, options)
  parsed.attempts = normalizeAttemptShape(parsed.attempts)
  validateTimestamps(parsed.timestamps)
  validateEvidenceShape(parsed.evidence)
  validateHistory(parsed)

  return cloneJson(parsed)
}

export function parseDevelopmentRunRecord(payload, expectedRunId = null, options = {}) {
  return parseRunRecord(payload, expectedRunId, options)
}

function sameReadOnlyObservation(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

function readOnlyFileIdentity(info, payload) {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    hash: sha256Text(payload)
  }
}

function readOnlyDirectoryIdentity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs
  }
}

function sameReadOnlyIdentity(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function staleReadOnlyObservation() {
  return runStateError(
    "RUN_STALE_OBSERVATION",
    "Development run state changed while it was being inspected."
  )
}

async function lstatReadOnly(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  }
}

async function assertReadOnlyDirectoryIfPresent(path, description) {
  const before = await lstatReadOnly(path)

  if (before === null) {
    return null
  }

  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw runStateError(
      "UNSAFE_LOCAL_PATH",
      `${description} is not a regular private directory.`
    )
  }

  return before
}

async function readReadOnlyDirectoryEntries(path, description) {
  const before = await assertReadOnlyDirectoryIfPresent(path, description)

  if (before === null) {
    return null
  }

  let entries

  try {
    entries = await readdir(path)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw staleReadOnlyObservation()
    }

    throw error
  }

  const after = await assertReadOnlyDirectoryIfPresent(path, description)

  if (after === null || !sameReadOnlyObservation(before, after)) {
    throw staleReadOnlyObservation()
  }

  return entries
}

async function readReadOnlyDirectorySnapshot(path, description) {
  const before = await assertReadOnlyDirectoryIfPresent(path, description)

  if (before === null) {
    return null
  }

  let entries

  try {
    entries = await readdir(path)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw staleReadOnlyObservation()
    }

    throw error
  }

  const after = await assertReadOnlyDirectoryIfPresent(path, description)

  if (after === null || !sameReadOnlyObservation(before, after)) {
    throw staleReadOnlyObservation()
  }

  return {
    identity: readOnlyDirectoryIdentity(after),
    entries: [...entries].sort()
  }
}

async function readRegularFileReadOnlySnapshotIfPresent(path, description) {
  const before = await lstatReadOnly(path)

  if (before === null) {
    return null
  }

  if (!before.isFile() || before.isSymbolicLink()) {
    throw runStateError(
      "UNSAFE_LOCAL_PATH",
      `${description} is not a regular private file.`
    )
  }

  if (before.size > MAX_DEVELOPMENT_RUN_RECORD_BYTES) {
    throw runStateError(
      "RUN_RECORD_TOO_LARGE",
      `${description} is too large.`
    )
  }

  let file
  let payload

  try {
    file = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
    payload = await file.readFile("utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw staleReadOnlyObservation()
    }

    if (error?.code === "ELOOP") {
      throw runStateError(
        "UNSAFE_LOCAL_PATH",
        `${description} is not a regular private file.`
      )
    }

    throw error
  } finally {
    await file?.close()
  }

  const after = await lstatReadOnly(path)

  if (after === null || !sameReadOnlyObservation(before, after)) {
    throw staleReadOnlyObservation()
  }

  if (Buffer.byteLength(payload, "utf8") > MAX_DEVELOPMENT_RUN_RECORD_BYTES) {
    throw runStateError(
      "RUN_RECORD_TOO_LARGE",
      `${description} is too large.`
    )
  }

  return {
    payload,
    identity: readOnlyFileIdentity(after, payload)
  }
}

async function readRegularFileReadOnlyIfPresent(path, description) {
  const snapshot = await readRegularFileReadOnlySnapshotIfPresent(path, description)

  return snapshot?.payload ?? null
}

async function readVersionMarkersReadOnly(paths, runId, options = {}) {
  const versionDirectorySnapshot = await readReadOnlyDirectorySnapshot(paths.versionDir, "Development run version directory")

  if (versionDirectorySnapshot === null) {
    return {
      latest: null,
      observation: {
        versionDir: null,
        markerFileNames: [],
        latestMarker: null
      }
    }
  }

  let latest = null
  let latestMarker = null
  const markerFileNames = []

  for (const entry of versionDirectorySnapshot.entries) {
    if (entry.endsWith(".tmp")) {
      continue
    }

    const match = entry.match(versionFilePattern)

    if (!match) {
      continue
    }

    markerFileNames.push(entry)
    const markerPath = join(paths.versionDir, entry)
    const snapshot = await readRegularFileReadOnlySnapshotIfPresent(markerPath, "Development run version marker")

    if (snapshot === null) {
      throw staleReadOnlyObservation()
    }

    const record = parseRunRecord(snapshot.payload, runId, options)
    const version = Number.parseInt(match[1], 10)

    if (record.version !== version) {
      throw runStateError(
        "RUN_HISTORY_INVALID",
        "Stored development run transition history is invalid."
      )
    }

    if (!latest || record.version > latest.version) {
      latest = record
      latestMarker = {
        fileName: entry,
        identity: snapshot.identity
      }
    }
  }

  return {
    latest,
    observation: {
      versionDir: versionDirectorySnapshot.identity,
      markerFileNames,
      latestMarker
    }
  }
}

async function readLatestVersionMarkerReadOnly(paths, runId, options = {}) {
  const markers = await readVersionMarkersReadOnly(paths, runId, options)

  return markers.latest
}

async function maybeAwaitReadOnlyFinalCheckSeam(options = {}) {
  const seam = options.__readOnlyBeforeFinalCheck

  if (typeof seam === "function") {
    await seam()
  }
}

function staleIfChanged(stable) {
  if (!stable) {
    throw staleReadOnlyObservation()
  }
}

async function assertReadOnlyFileObservationStable(path, description, observed) {
  const current = await readRegularFileReadOnlySnapshotIfPresent(path, description)

  if (observed === null) {
    if (current !== null) {
      throw staleReadOnlyObservation()
    }

    return
  }

  staleIfChanged(current !== null && sameReadOnlyIdentity(current.identity, observed.identity))
}

async function assertReadOnlyDirectoryObservationStable(path, description, observed) {
  const current = await assertReadOnlyDirectoryIfPresent(path, description)

  if (observed === null) {
    if (current !== null) {
      throw staleReadOnlyObservation()
    }

    return
  }

  staleIfChanged(current !== null && sameReadOnlyIdentity(readOnlyDirectoryIdentity(current), observed))
}

async function readVersionMarkerObservationOnly(paths) {
  const versionDirectorySnapshot = await readReadOnlyDirectorySnapshot(paths.versionDir, "Development run version directory")

  if (versionDirectorySnapshot === null) {
    return {
      versionDir: null,
      markerFileNames: [],
      latestMarker: null
    }
  }

  const markerFileNames = versionDirectorySnapshot.entries
    .filter((entry) => !entry.endsWith(".tmp") && versionFilePattern.test(entry))
  let latestMarker = null

  if (markerFileNames.length > 0) {
    const latestFileName = markerFileNames.at(-1)
    const snapshot = await readRegularFileReadOnlySnapshotIfPresent(
      join(paths.versionDir, latestFileName),
      "Development run version marker"
    )

    if (snapshot === null) {
      throw staleReadOnlyObservation()
    }

    latestMarker = {
      fileName: latestFileName,
      identity: snapshot.identity
    }
  }

  return {
    versionDir: versionDirectorySnapshot.identity,
    markerFileNames,
    latestMarker
  }
}

async function assertVersionMarkerObservationStable(paths, runId, observed, options = {}) {
  const current = await readVersionMarkerObservationOnly(paths)

  staleIfChanged(
    sameReadOnlyIdentity(current.versionDir, observed.versionDir) &&
    stableStringify(current.markerFileNames) === stableStringify(observed.markerFileNames) &&
    sameReadOnlyIdentity(current.latestMarker, observed.latestMarker)
  )
}

async function assertReadOnlyObservationStable(paths, runId, observed, options = {}) {
  await maybeAwaitReadOnlyFinalCheckSeam(options)
  await assertReadOnlyDirectoryObservationStable(paths.runRoot, "Development run store", observed.runRoot)
  await assertReadOnlyDirectoryObservationStable(paths.recordsDir, "Development run records directory", observed.recordsDir)
  await assertReadOnlyFileObservationStable(paths.recordPath, "Development run record", observed.canonical)
  await assertVersionMarkerObservationStable(paths, runId, observed.versionMarkers, options)
  await assertReadOnlyDirectoryObservationStable(paths.versionsRoot, "Development run versions directory", observed.versionsRoot)
}

function readOnlySnapshotResult({
  ok,
  runId,
  code,
  canonicalState,
  record = null,
  canonicalRecord = null,
  latestRecord = null,
  recoveryRequired = false
}) {
  return {
    schemaVersion: 1,
    ok,
    runId,
    code,
    canonicalState,
    recoveryRequired,
    record: record ? cloneJson(record) : null,
    canonicalRecord: canonicalRecord ? cloneJson(canonicalRecord) : null,
    latestRecord: latestRecord ? cloneJson(latestRecord) : null
  }
}

function readOnlyFailureFromError(error, runId) {
  if (error instanceof DevelopmentRunStateError) {
    const recordInvalidCodes = new Set([
      "ATTEMPT_LIMIT_REACHED",
      "EVIDENCE_LIMIT_REACHED",
      "INVALID_ACTOR",
      "INVALID_BRANCH",
      "INVALID_EVIDENCE",
      "INVALID_PROJECT",
      "INVALID_REASON",
      "INVALID_RUN_STATUS",
      "INVALID_SHA",
      "INVALID_TASK",
      "UNKNOWN_PROJECT"
    ])

    if (error.code === "INVALID_RUN_ID") {
      return readOnlySnapshotResult({
        ok: false,
        runId: null,
        code: "invalid_run_id",
        canonicalState: "run_not_found"
      })
    }

    if (error.code === "INVALID_RUN_TRANSITION") {
      return readOnlySnapshotResult({
        ok: false,
        runId,
        code: "history_invalid",
        canonicalState: "history_invalid"
      })
    }

    if (error.code === "RUN_RECORD_INVALID" || error.code === "RUN_RECORD_TOO_LARGE") {
      return readOnlySnapshotResult({
        ok: false,
        runId,
        code: "record_invalid",
        canonicalState: "record_invalid"
      })
    }

    if (recordInvalidCodes.has(error.code)) {
      return readOnlySnapshotResult({
        ok: false,
        runId,
        code: "record_invalid",
        canonicalState: "record_invalid"
      })
    }

    if (error.code === "RUN_HISTORY_INVALID") {
      return readOnlySnapshotResult({
        ok: false,
        runId,
        code: "history_invalid",
        canonicalState: "history_invalid"
      })
    }

    if (error.code === "RUN_STALE_OBSERVATION") {
      return readOnlySnapshotResult({
        ok: false,
        runId,
        code: "stale_observation",
        canonicalState: "stale_observation"
      })
    }

    if (error.code === "UNSAFE_LOCAL_PATH") {
      return readOnlySnapshotResult({
        ok: false,
        runId,
        code: "store_unavailable",
        canonicalState: "store_unavailable"
      })
    }
  }

  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
    return readOnlySnapshotResult({
      ok: false,
      runId,
      code: "store_unavailable",
      canonicalState: "store_unavailable"
    })
  }

  return readOnlySnapshotResult({
    ok: false,
    runId,
    code: "store_unavailable",
    canonicalState: "store_unavailable"
  })
}

async function inspectDevelopmentRunReadOnlyInternal(runId, options = {}) {
  const normalizedRunId = normalizeDevelopmentRunId(runId)
  const paths = storePaths(normalizedRunId, options)
  const runRoot = await assertReadOnlyDirectoryIfPresent(paths.runRoot, "Development run store")

  if (runRoot === null) {
    return readOnlySnapshotResult({
      ok: false,
      runId: normalizedRunId,
      code: "store_missing",
      canonicalState: "store_missing"
    })
  }

  const recordsDir = await assertReadOnlyDirectoryIfPresent(paths.recordsDir, "Development run records directory")
  const versionsRoot = await assertReadOnlyDirectoryIfPresent(paths.versionsRoot, "Development run versions directory")

  if (recordsDir === null || versionsRoot === null) {
    return readOnlySnapshotResult({
      ok: false,
      runId: normalizedRunId,
      code: "store_missing",
      canonicalState: "store_missing"
    })
  }

  const canonicalSnapshot = await readRegularFileReadOnlySnapshotIfPresent(paths.recordPath, "Development run record")
  const canonical = canonicalSnapshot === null
    ? null
    : parseRunRecord(canonicalSnapshot.payload, normalizedRunId, options)
  const versionMarkers = await readVersionMarkersReadOnly(paths, normalizedRunId, options)
  const latest = versionMarkers.latest
  const observation = {
    runRoot: readOnlyDirectoryIdentity(runRoot),
    recordsDir: readOnlyDirectoryIdentity(recordsDir),
    versionsRoot: readOnlyDirectoryIdentity(versionsRoot),
    canonical: canonicalSnapshot === null
      ? null
      : {
          identity: canonicalSnapshot.identity
        },
    versionMarkers: versionMarkers.observation
  }

  await assertReadOnlyObservationStable(paths, normalizedRunId, observation, options)

  if (!canonical && !latest) {
    return readOnlySnapshotResult({
      ok: false,
      runId: normalizedRunId,
      code: "run_not_found",
      canonicalState: "run_not_found"
    })
  }

  if (canonical && !latest) {
    return readOnlySnapshotResult({
      ok: false,
      runId: normalizedRunId,
      code: "canonical_conflict",
      canonicalState: "canonical_conflict",
      canonicalRecord: canonical
    })
  }

  if (canonical && latest && latest.version < canonical.version) {
    return readOnlySnapshotResult({
      ok: false,
      runId: normalizedRunId,
      code: "canonical_conflict",
      canonicalState: "canonical_conflict",
      canonicalRecord: canonical,
      latestRecord: latest
    })
  }

  if (canonical && latest && latest.version === canonical.version && latest.historyHash !== canonical.historyHash) {
    return readOnlySnapshotResult({
      ok: false,
      runId: normalizedRunId,
      code: "canonical_conflict",
      canonicalState: "canonical_conflict",
      canonicalRecord: canonical,
      latestRecord: latest
    })
  }

  if (!canonical && latest) {
    return readOnlySnapshotResult({
      ok: true,
      runId: normalizedRunId,
      code: "canonical_missing",
      canonicalState: "canonical_missing",
      record: latest,
      latestRecord: latest,
      recoveryRequired: true
    })
  }

  if (latest.version > canonical.version) {
    return readOnlySnapshotResult({
      ok: true,
      runId: normalizedRunId,
      code: "canonical_behind",
      canonicalState: "canonical_behind",
      record: latest,
      canonicalRecord: canonical,
      latestRecord: latest,
      recoveryRequired: true
    })
  }

  return readOnlySnapshotResult({
    ok: true,
    runId: normalizedRunId,
    code: "canonical_current",
    canonicalState: "canonical_current",
    record: canonical,
    canonicalRecord: canonical,
    latestRecord: latest
  })
}

export async function inspectDevelopmentRunReadOnly(runId, options = {}) {
  let normalizedRunId = null

  try {
    normalizedRunId = normalizeDevelopmentRunId(runId)
    return await inspectDevelopmentRunReadOnlyInternal(normalizedRunId, options)
  } catch (error) {
    return readOnlyFailureFromError(error, normalizedRunId)
  }
}

async function readLatestVersionMarker(paths, runId, options = {}) {
  let entries

  try {
    entries = await readdir(paths.versionDir)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  }

  let latest = null

  for (const entry of entries) {
    if (entry.endsWith(".tmp")) {
      continue
    }

    const match = entry.match(versionFilePattern)

    if (!match) {
      continue
    }

    const version = Number.parseInt(match[1], 10)
    const payload = await readRegularFileIfPresent(join(paths.versionDir, entry), "Development run version marker")

    if (payload === null) {
      continue
    }

    const record = parseRunRecord(payload, runId, options)

    if (record.version !== version) {
      throw runStateError(
        "RUN_HISTORY_INVALID",
        "Stored development run transition history is invalid."
      )
    }

    if (!latest || record.version > latest.version) {
      latest = record
    }
  }

  return latest
}

async function writeVersionMarker(paths, record) {
  await ensureStore(paths)
  const markerPath = join(paths.versionDir, versionFileName(record.version))
  await writeExclusiveDurableVersionMarker(markerPath, serializeRecord(record))
}

async function writeCanonicalRecord(paths, record) {
  await ensureStore(paths)
  await atomicDurableWriteCanonical(paths.recordPath, serializeRecord(record))
}

async function commitRecord(paths, record) {
  await writeVersionMarker(paths, record)

  try {
    await writeCanonicalRecord(paths, record)
  } catch (error) {
    if (error instanceof DevelopmentRunStateError) {
      throw error
    }

    throw runStateError(
      "RUN_STORE_UNAVAILABLE",
      "Development run state store is unavailable; reload before retrying."
    )
  }
}

function validatePersonalProjectOperatorSelfDevelopmentInput(input = {}) {
  const hasProjectId = Object.hasOwn(input || {}, "projectId")
  const projectId = hasProjectId ? String(input.projectId ?? "").trim() : PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id

  if (projectId !== PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id) {
    throw runStateError(
      "UNKNOWN_PROJECT",
      "Personal Project Operator self-development runs are fixed to the approved PPO repository."
    )
  }

  const fixedFields = Object.freeze({
    owner: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.owner,
    repo: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.repo,
    fullName: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.fullName,
    repositoryFullName: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.fullName
  })
  const refusedIdentityKeys = Object.freeze([
    "url",
    "repoUrl",
    "repositoryUrl",
    "remote",
    "remoteUrl",
    "origin",
    "installDir",
    "installationDirectory",
    "path",
    "deploymentProfile",
    "service",
    "serviceName"
  ])

  for (const [key, expected] of Object.entries(fixedFields)) {
    if (Object.hasOwn(input || {}, key) && input[key] !== expected) {
      throw runStateError(
        "UNKNOWN_PROJECT",
        "Personal Project Operator self-development runs are fixed to the approved PPO repository."
      )
    }
  }

  for (const key of refusedIdentityKeys) {
    if (Object.hasOwn(input || {}, key)) {
      throw runStateError(
        "UNKNOWN_PROJECT",
        "Personal Project Operator self-development runs are fixed to the approved PPO repository."
      )
    }
  }

  if (Object.hasOwn(input || {}, "project")) {
    const project = input.project

    if (
      !project ||
      typeof project !== "object" ||
      Array.isArray(project) ||
      project.id !== PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id ||
      project.displayName !== PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.displayName ||
      project.owner !== PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.owner ||
      project.repo !== PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.repo ||
      project.fullName !== PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.fullName
    ) {
      throw runStateError(
        "UNKNOWN_PROJECT",
        "Personal Project Operator self-development runs are fixed to the approved PPO repository."
      )
    }
  }

  return PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
}

async function createDevelopmentRunWithProject(input, project, options = {}) {
  const task = normalizeSafeText(input?.task, {
    fieldName: "Task",
    maxChars: MAX_DEVELOPMENT_RUN_TASK_CHARS,
    required: true,
    code: "INVALID_TASK",
    safeMessage: `Development run task is required and must be ${MAX_DEVELOPMENT_RUN_TASK_CHARS} characters or fewer.`
  })
  const baseSha = normalizeSha(input?.baseSha, "Base SHA")
  const branch = normalizeBranch(input?.branch)
  const headSha = normalizeOptionalSha(input?.headSha, "Head SHA")
  const actor = normalizeActor(input?.actor)
  const createdAt = timestamp(nowDate(options))
  const basePaths = storePaths(null, options)

  await ensureStore(basePaths)

  let lastError

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const runId = makeDevelopmentRunId(options)
    const paths = storePaths(runId, options)
    const existing = await readRegularFileIfPresent(paths.recordPath, "Development run record")

    if (existing !== null) {
      lastError = runStateError(
        "RUN_ID_COLLISION",
        "Development run id collided with an existing run; no run-state write was attempted."
      )
      continue
    }

    const record = buildInitialRecord({
      runId,
      project,
      task,
      baseSha,
      branch,
      headSha,
      createdAt,
      actor
    })

    try {
      await commitRecord(paths, record)
      return cloneJson(record)
    } catch (error) {
      if (error instanceof DevelopmentRunStateError && error.code === "STALE_RUN_VERSION") {
        lastError = runStateError(
          "RUN_ID_COLLISION",
          "Development run id collided with an existing run; no run-state write was attempted."
        )
        continue
      }

      throw error
    }
  }

  throw lastError || runStateError(
    "RUN_ID_GENERATION_FAILED",
    "Development run id could not be generated; no run-state write was attempted."
  )
}

async function createDevelopmentRunInternal(input, options = {}) {
  return await createDevelopmentRunWithProject(input, resolveDevelopmentRunProject(input?.projectId), options)
}

async function createPersonalProjectOperatorSelfDevelopmentRunInternal(input, options = {}) {
  return await createDevelopmentRunWithProject(
    {
      ...input,
      projectId: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id
    },
    validatePersonalProjectOperatorSelfDevelopmentInput(input),
    {
      ...options,
      allowPersonalProjectOperatorSelfDevelopmentProject: true
    }
  )
}

async function readDevelopmentRunInternal(runId, options = {}) {
  const normalizedRunId = normalizeDevelopmentRunId(runId)
  const paths = storePaths(normalizedRunId, options)

  await ensureStore(paths)

  const payload = await readRegularFileIfPresent(paths.recordPath, "Development run record")
  const canonical = payload === null
    ? null
    : parseRunRecord(payload, normalizedRunId, options)
  const latest = await readLatestVersionMarker(paths, normalizedRunId, options)

  if (!canonical && !latest) {
    throw runStateError(
      "RUN_NOT_FOUND",
      "Development run was not found."
    )
  }

  if (canonical && !latest) {
    throw runStateError(
      "RUN_HISTORY_INVALID",
      "Stored development run transition history is invalid."
    )
  }

  if (canonical && latest && latest.version < canonical.version) {
    throw runStateError(
      "RUN_HISTORY_INVALID",
      "Stored development run transition history is invalid."
    )
  }

  if (canonical && latest && latest.version === canonical.version && latest.historyHash !== canonical.historyHash) {
    throw runStateError(
      "RUN_HISTORY_INVALID",
      "Stored development run transition history is invalid."
    )
  }

  if (!canonical || latest.version > canonical.version) {
    await writeCanonicalRecord(paths, latest)
    return cloneJson(latest)
  }

  return cloneJson(canonical)
}

async function transitionDevelopmentRunInternal(runId, transition, options = {}) {
  const normalizedRunId = normalizeDevelopmentRunId(runId)
  const expectedVersion = normalizeExpectedVersion(transition?.expectedVersion)
  const toStatus = normalizeDevelopmentRunStatus(transition?.status)
  const actor = normalizeActor(transition?.actor)
  const reason = normalizeSafeText(transition?.reason, {
    fieldName: "Transition reason",
    maxChars: 500,
    required: false,
    code: "INVALID_REASON",
    safeMessage: "Development run transition reason is invalid; no run-state write was attempted."
  })
  const now = nowDate(options)
  const evidence = normalizeEvidenceList(transition?.evidence || [], {
    ...options,
    now: () => now
  })
  const current = await readDevelopmentRunInternal(normalizedRunId, options)

  if (current.version !== expectedVersion) {
    throw runStateError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  const next = applyTransition(current, {
    toStatus,
    branch: Object.hasOwn(transition, "branch") ? transition.branch : undefined,
    headSha: Object.hasOwn(transition, "headSha") ? transition.headSha : undefined,
    evidence,
    actor,
    reason,
    now
  })
  const paths = storePaths(normalizedRunId, options)

  await commitRecord(paths, next)
  return cloneJson(next)
}

async function recordDevelopmentRunProgressInternal(runId, progress, options = {}) {
  const normalizedRunId = normalizeDevelopmentRunId(runId)
  const expectedVersion = normalizeExpectedVersion(progress?.expectedVersion)
  const expectedStatus = Object.hasOwn(progress || {}, "status")
    ? normalizeDevelopmentRunStatus(progress.status)
    : null
  const actor = normalizeActor(progress?.actor)
  const reason = normalizeSafeText(progress?.reason, {
    fieldName: "Progress reason",
    maxChars: 500,
    required: false,
    code: "INVALID_REASON",
    safeMessage: "Development run progress reason is invalid; no run-state write was attempted."
  })
  const now = nowDate(options)
  const evidence = normalizeEvidenceList(progress?.evidence || [], {
    ...options,
    now: () => now
  })
  const incrementAttempt = progress?.incrementAttempt === true
  const current = await readDevelopmentRunInternal(normalizedRunId, options)

  if (current.version !== expectedVersion || (expectedStatus !== null && current.status !== expectedStatus)) {
    throw runStateError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  const next = applyProgressUpdate(current, {
    branch: Object.hasOwn(progress || {}, "branch") ? progress.branch : undefined,
    headSha: Object.hasOwn(progress || {}, "headSha") ? progress.headSha : undefined,
    evidence,
    actor,
    reason,
    now,
    incrementAttempt
  })
  const paths = storePaths(normalizedRunId, options)

  await commitRecord(paths, next)
  return cloneJson(next)
}

export async function createDevelopmentRun(input, options = {}) {
  try {
    return await createDevelopmentRunInternal(input, options)
  } catch (error) {
    throw safeRunStateFailure(error)
  }
}

export async function createPersonalProjectOperatorSelfDevelopmentRun(input, options = {}) {
  try {
    return await createPersonalProjectOperatorSelfDevelopmentRunInternal(input, options)
  } catch (error) {
    throw safeRunStateFailure(error)
  }
}

export async function readDevelopmentRun(runId, options = {}) {
  try {
    return await readDevelopmentRunInternal(runId, options)
  } catch (error) {
    throw safeRunStateFailure(error)
  }
}

export async function readPersonalProjectOperatorSelfDevelopmentRun(runId, options = {}) {
  try {
    return await readDevelopmentRunInternal(runId, {
      ...options,
      allowPersonalProjectOperatorSelfDevelopmentProject: true
    })
  } catch (error) {
    throw safeRunStateFailure(error)
  }
}

export async function transitionDevelopmentRun(runId, transition, options = {}) {
  try {
    return await transitionDevelopmentRunInternal(runId, transition, options)
  } catch (error) {
    throw safeRunStateFailure(error)
  }
}

export async function transitionPersonalProjectOperatorSelfDevelopmentRun(runId, transition, options = {}) {
  try {
    return await transitionDevelopmentRunInternal(runId, transition, {
      ...options,
      allowPersonalProjectOperatorSelfDevelopmentProject: true
    })
  } catch (error) {
    throw safeRunStateFailure(error)
  }
}

export async function recordDevelopmentRunProgress(runId, progress, options = {}) {
  try {
    return await recordDevelopmentRunProgressInternal(runId, progress, options)
  } catch (error) {
    throw safeRunStateFailure(error)
  }
}

export async function recordPersonalProjectOperatorSelfDevelopmentRunProgress(runId, progress, options = {}) {
  try {
    return await recordDevelopmentRunProgressInternal(runId, progress, {
      ...options,
      allowPersonalProjectOperatorSelfDevelopmentProject: true
    })
  } catch (error) {
    throw safeRunStateFailure(error)
  }
}

export function formatDevelopmentRunStateError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO development run-state error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO development run-state error: unexpected local failure."
}
