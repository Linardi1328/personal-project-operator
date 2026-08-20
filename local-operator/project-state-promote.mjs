import { createHash, randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink
} from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV,
  PROJECT_NOTE_ID_PATTERN,
  normalizeProjectNote
} from "./project-note-add.mjs"
import {
  getPhase2GitHubProject,
  listPhase2GitHubProjects
} from "./github-project-registry.mjs"

export const PROJECT_STATE_PROMOTE_ACTION = "promote-note"
export const PROJECT_STATE_CONFIRM_ENV = "PPO_PROJECT_STATE_CONFIRM"
export const DEFAULT_PROJECT_STATE_AUDIT_RELATIVE_PATH = "audit/project-state-promotion-audit.ndjson"
export const DEFAULT_PROJECT_STATE_REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))

export const PROJECT_STATE_FIELDS = Object.freeze({
  "current-phase": "## Current phase",
  "last-known-status": "## Last known status",
  "next-action": "## Next action"
})

const safeAuditCodePattern = /^[A-Z0-9_]{1,80}$/u
const execFileAsync = promisify(execFile)

export class ProjectStatePromoteError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "ProjectStatePromoteError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

export class ProjectStateMutationAmbiguousError extends ProjectStatePromoteError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "ProjectStateMutationAmbiguousError"
    this.mutationApplied = true
  }
}

function stateError(code, safeMessage) {
  return new ProjectStatePromoteError(code, safeMessage)
}

function allowedProjectIdList() {
  return listPhase2GitHubProjects().map((project) => project.id).join(", ")
}

function allowedFieldList() {
  return Object.keys(PROJECT_STATE_FIELDS).join(", ")
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

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PPO_WRITE_DATA_DIR
}

function resolveRepoRoot(options = {}) {
  const configured = options.repoRoot

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PROJECT_STATE_REPO_ROOT
}

function stateAuditPath(options = {}) {
  if (typeof options.auditPath === "string" && options.auditPath.trim()) {
    return options.auditPath
  }

  return join(resolveWriteDataDir(options), DEFAULT_PROJECT_STATE_AUDIT_RELATIVE_PATH)
}

function promotionPaths(projectId, options = {}) {
  const writeDataDir = resolveWriteDataDir(options)
  const repoRoot = resolveRepoRoot(options)

  return {
    writeDataDir,
    repoRoot,
    notePath: join(writeDataDir, "project-notes", `${projectId}.ndjson`),
    auditPath: stateAuditPath(options),
    projectPath: join(repoRoot, "projects", `${projectId}.md`)
  }
}

export function resolveProjectStateProject(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw stateError(
      "INVALID_PROJECT",
      `Project id is required. Use one of: ${allowedProjectIdList()}.`
    )
  }

  const normalized = projectId.trim()
  const project = getPhase2GitHubProject(normalized)

  if (!project) {
    throw stateError(
      "UNKNOWN_PROJECT",
      `Project id is not in the connected project allowlist. Use one of: ${allowedProjectIdList()}.`
    )
  }

  return {
    ...project,
    fullName: repoFullName(project)
  }
}

export function normalizeProjectStateField(field) {
  const normalized = String(field ?? "").trim()
  const heading = PROJECT_STATE_FIELDS[normalized]

  if (!heading) {
    throw stateError(
      "INVALID_FIELD",
      `Project state field is not allowed. Use one of: ${allowedFieldList()}.`
    )
  }

  return {
    field: normalized,
    heading
  }
}

export function normalizeProjectStateNoteId(noteId) {
  const normalized = String(noteId ?? "").trim()

  if (!PROJECT_NOTE_ID_PATTERN.test(normalized)) {
    throw stateError(
      "INVALID_NOTE_ID",
      "Project note id must be the 43-character opaque id returned by Phase 5C/5D note creation."
    )
  }

  return normalized
}

function validateStoredNoteText(note) {
  if (typeof note !== "string") {
    throw stateError(
      "INVALID_NOTE_RECORD",
      "Stored project note is invalid; no project state mutation was attempted."
    )
  }

  let normalized

  try {
    normalized = normalizeProjectNote(note)
  } catch {
    throw stateError(
      "INVALID_NOTE_RECORD",
      "Stored project note is invalid; no project state mutation was attempted."
    )
  }

  if (normalized !== note) {
    throw stateError(
      "INVALID_NOTE_RECORD",
      "Stored project note is not in canonical Phase 5C/5D form; no project state mutation was attempted."
    )
  }

  return note
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
    throw stateError(
      "UNSAFE_LOCAL_PATH",
      `${description} is not a regular local file; no project state mutation was attempted.`
    )
  }

  return readFile(path)
}

function parseNoteRecords(buffer, projectId) {
  if (buffer === null) {
    return []
  }

  const text = buffer.toString("utf8")
  const records = []

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue
    }

    let record

    try {
      record = JSON.parse(line)
    } catch {
      throw stateError(
        "INVALID_NOTE_STORE",
        `Project note store is invalid for ${projectId}; no project state mutation was attempted.`
      )
    }

    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      !PROJECT_NOTE_ID_PATTERN.test(String(record.noteId ?? "")) ||
      typeof record.project !== "string" ||
      typeof record.note !== "string"
    ) {
      throw stateError(
        "INVALID_NOTE_STORE",
        `Project note store is invalid for ${projectId}; no project state mutation was attempted.`
      )
    }

    records.push(record)
  }

  return records
}

async function readProjectNoteRecordsAt(projectId, options = {}) {
  const paths = promotionPaths(projectId, options)
  const buffer = await readRegularFileIfPresent(paths.notePath, "Project note store")
  return parseNoteRecords(buffer, projectId)
}

export async function resolveProjectStateNote(projectId, noteId, options = {}) {
  const normalizedNoteId = normalizeProjectStateNoteId(noteId)
  const selectedRecords = await readProjectNoteRecordsAt(projectId, options)
  const selectedMatches = selectedRecords.filter((record) => record.noteId === normalizedNoteId)

  if (selectedMatches.length > 1) {
    throw stateError(
      "AMBIGUOUS_NOTE_ID",
      "Project note id appears more than once in the selected project note store; no project state mutation was attempted."
    )
  }

  if (selectedMatches.length === 1) {
    const record = selectedMatches[0]

    if (record.project !== projectId) {
      throw stateError(
        "NOTE_PROJECT_MISMATCH",
        "Project note does not belong to the selected project; no project state mutation was attempted."
      )
    }

    return {
      noteId: normalizedNoteId,
      project: projectId,
      note: validateStoredNoteText(record.note)
    }
  }

  for (const project of listPhase2GitHubProjects()) {
    if (project.id === projectId) {
      continue
    }

    const records = await readProjectNoteRecordsAt(project.id, options)

    if (records.some((record) => record.noteId === normalizedNoteId)) {
      throw stateError(
        "NOTE_PROJECT_MISMATCH",
        "Project note does not belong to the selected project; no project state mutation was attempted."
      )
    }
  }

  throw stateError(
    "NOTE_NOT_FOUND",
    "Project note id was not found in the durable Phase 5C/5D note store; no project state mutation was attempted."
  )
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function headingMatches(source, heading) {
  const needle = Buffer.from(heading, "utf8")
  const matches = []
  let offset = 0

  while (offset <= source.length - needle.length) {
    const index = source.indexOf(needle, offset)

    if (index === -1) {
      break
    }

    const atLineStart = index === 0 || source[index - 1] === 0x0a
    const after = index + needle.length
    const hasLf = source[after] === 0x0a
    const hasCrLf = source[after] === 0x0d && source[after + 1] === 0x0a

    if (atLineStart && (hasLf || hasCrLf)) {
      matches.push({
        start: index,
        lineEnd: after + (hasCrLf ? 2 : 1),
        eol: hasCrLf ? Buffer.from("\r\n") : Buffer.from("\n")
      })
    }

    offset = index + 1
  }

  return matches
}

function nextLevelTwoHeading(source, offset) {
  const needle = Buffer.from("## ")
  let cursor = offset

  while (cursor <= source.length - needle.length) {
    const index = source.indexOf(needle, cursor)

    if (index === -1) {
      return source.length
    }

    if (index === 0 || source[index - 1] === 0x0a) {
      return index
    }

    cursor = index + 1
  }

  return source.length
}

export function replaceProjectStateSection(sourceInput, heading, note) {
  const source = Buffer.isBuffer(sourceInput) ? sourceInput : Buffer.from(sourceInput)
  const matches = headingMatches(source, heading)

  if (matches.length !== 1) {
    throw stateError(
      "INVALID_PROJECT_STATE_FILE",
      `Expected exactly one ${heading} section; no project state mutation was attempted.`
    )
  }

  const match = matches[0]
  const bodyStart = match.lineEnd
  const bodyEnd = nextLevelTwoHeading(source, bodyStart)
  const noteBytes = Buffer.from(note, "utf8")
  const replacementBody = Buffer.concat([
    match.eol,
    noteBytes,
    match.eol,
    match.eol
  ])
  const currentBody = source.subarray(bodyStart, bodyEnd)

  return {
    changed: !currentBody.equals(replacementBody),
    output: Buffer.concat([
      source.subarray(0, bodyStart),
      replacementBody,
      source.subarray(bodyEnd)
    ]),
    bodyStart,
    bodyEnd
  }
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function syncDirectory(path) {
  const directory = await open(path, "r")

  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function writeAppendOnlyLine(path, line, { rootDir } = {}) {
  if (rootDir) {
    await ensurePrivateDir(rootDir)
  }

  await ensurePrivateDir(dirname(path))
  const file = await open(path, "a", 0o600)

  try {
    await file.writeFile(`${line}\n`, "utf8")
    await file.sync()
  } finally {
    await file.close()
  }

  await chmod(path, 0o600)
  await syncDirectory(dirname(path))
}

export function buildProjectStateAuditRecord(intent, status, details = {}, now = new Date()) {
  const record = {
    schemaVersion: 1,
    timestamp: timestamp(now),
    action: PROJECT_STATE_PROMOTE_ACTION,
    project: intent.project.id,
    field: intent.field,
    noteId: intent.noteId,
    status,
    beforeHash: intent.beforeHash,
    afterHash: details.afterHash || intent.afterHash
  }

  if (typeof details.code === "string" && safeAuditCodePattern.test(details.code)) {
    record.code = details.code
  }

  return record
}

export function createProjectStateAuditRecorder({ auditPath, writeDataDir } = {}) {
  const resolvedPath = auditPath || stateAuditPath({ writeDataDir })
  const resolvedRoot = writeDataDir
    ? resolveWriteDataDir({ writeDataDir })
    : auditPath
      ? null
      : resolveWriteDataDir()

  return {
    auditPath: resolvedPath,

    async record(entry) {
      await writeAppendOnlyLine(resolvedPath, JSON.stringify(entry), {
        rootDir: resolvedRoot
      })
    }
  }
}

async function readPromotionAuditRecords(options = {}) {
  const path = stateAuditPath(options)
  const buffer = await readRegularFileIfPresent(path, "Project state promotion audit")

  if (buffer === null) {
    return []
  }

  const records = []

  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line.trim()) {
      continue
    }

    let record

    try {
      record = JSON.parse(line)
    } catch {
      throw stateError(
        "INVALID_AUDIT_TRAIL",
        "Project state promotion audit trail is invalid; no project state mutation was attempted."
      )
    }

    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw stateError(
        "INVALID_AUDIT_TRAIL",
        "Project state promotion audit trail is invalid; no project state mutation was attempted."
      )
    }

    records.push(record)
  }

  return records
}

function duplicatePromotionStatus(records, intent) {
  const matching = records.filter((record) => (
    record?.action === PROJECT_STATE_PROMOTE_ACTION &&
    record?.project === intent.project.id &&
    record?.field === intent.field &&
    record?.noteId === intent.noteId &&
    ["attempted", "failed", "succeeded"].includes(record?.status)
  ))

  if (matching.some((record) => record.status === "succeeded")) {
    return "succeeded"
  }

  if (matching.at(-1)?.status === "attempted") {
    return "ambiguous"
  }

  return null
}

async function defaultGitRunner(args, { cwd } = {}) {
  return execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024
  })
}

async function runGitCheck(args, options) {
  const runner = options.gitRunner || defaultGitRunner

  try {
    return await runner(args, { cwd: resolveRepoRoot(options) })
  } catch {
    throw stateError(
      "GIT_PREFLIGHT_FAILED",
      "Git safety preflight failed; no project state mutation was attempted."
    )
  }
}

async function assertSafeGitTarget(projectPath, options = {}) {
  const repoRoot = resolveRepoRoot(options)
  const branchResult = await runGitCheck(["rev-parse", "--abbrev-ref", "HEAD"], options)
  const branch = String(branchResult?.stdout ?? "").trim()

  if (branch === "main") {
    throw stateError(
      "MAIN_BRANCH_REFUSED",
      "Project state promotion is refused on main. Use a dedicated development branch."
    )
  }

  const relativeProjectPath = relative(repoRoot, projectPath).replaceAll("\\", "/")
  const statusResult = await runGitCheck([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    relativeProjectPath
  ], options)

  if (String(statusResult?.stdout ?? "").trim()) {
    throw stateError(
      "DIRTY_TARGET_REFUSED",
      "Target project state file has uncommitted changes; no project state mutation was attempted."
    )
  }
}

export async function atomicDurableProjectStateReplace(path, content) {
  const info = await lstat(path)

  if (!info.isFile() || info.isSymbolicLink()) {
    throw stateError(
      "UNSAFE_LOCAL_PATH",
      "Target project state path is not a regular local file; no project state mutation was attempted."
    )
  }

  const directory = dirname(path)
  const tempPath = join(
    directory,
    `.ppo-state-promote.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
  )
  let file
  let renamed = false

  try {
    file = await open(tempPath, "wx", info.mode & 0o777)
    await file.writeFile(content)
    await file.sync()
    await file.close()
    file = null
    await chmod(tempPath, info.mode & 0o777)
    await rename(tempPath, path)
    renamed = true
    await syncDirectory(directory)
  } catch (error) {
    try {
      await file?.close()
    } catch {
      // Best effort only; no sensitive content is logged.
    }

    if (!renamed) {
      try {
        await unlink(tempPath)
      } catch {
        // Best effort cleanup of a same-directory private temp file.
      }
    }

    if (renamed) {
      throw new ProjectStateMutationAmbiguousError(
        "DURABILITY_AMBIGUOUS",
        "Project state replacement occurred but directory durability could not be confirmed. Inspect the target and audit trail before retrying."
      )
    }

    throw error
  }
}

function safeFailure(error) {
  if (error instanceof ProjectStatePromoteError) {
    return error
  }

  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
    return stateError(
      "PROJECT_STATE_STORE_UNAVAILABLE",
      "Project state file is unavailable for controlled replacement."
    )
  }

  return stateError(
    "PROJECT_STATE_WRITE_FAILED",
    "Project state replacement failed. Inspect the local checkout before retrying."
  )
}

export function prepareProjectStatePromotion(projectId, noteId, field, note, source, options = {}) {
  const project = resolveProjectStateProject(projectId)
  const normalizedNoteId = normalizeProjectStateNoteId(noteId)
  const normalizedField = normalizeProjectStateField(field)
  const paths = promotionPaths(project.id, options)
  const replacement = replaceProjectStateSection(source, normalizedField.heading, note)
  const beforeHash = sha256(source)
  const afterHash = sha256(replacement.output)

  return {
    action: PROJECT_STATE_PROMOTE_ACTION,
    project,
    noteId: normalizedNoteId,
    field: normalizedField.field,
    heading: normalizedField.heading,
    note,
    projectPath: paths.projectPath,
    auditPath: paths.auditPath,
    beforeHash,
    afterHash,
    replacement,
    requiredConfirmation: `${PROJECT_STATE_PROMOTE_ACTION}:${project.id}:${normalizedNoteId}:${normalizedField.field}`
  }
}

function buildPreview(intent) {
  return [
    "Project State Promotion Preview",
    `Action: ${intent.action}`,
    `Project: ${intent.project.id}`,
    `Field: ${intent.field}`,
    `Note ID: ${intent.noteId}`,
    `Target: ${intent.projectPath}`,
    "Intended change: replace exactly one approved project-state section with the stored note text verbatim",
    `Required confirmation: ${PROJECT_STATE_CONFIRM_ENV}=${intent.requiredConfirmation}`
  ].join("\n")
}

export function formatProjectStatePromoteError(error) {
  if (error instanceof ProjectStatePromoteError) {
    return `PPO project state error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO project state error: unexpected local failure."
}

async function tryAudit(auditRecorder, entry) {
  try {
    await auditRecorder.record(entry)
    return true
  } catch {
    return false
  }
}

async function auditRefusal(auditRecorder, intent, code, now) {
  return tryAudit(
    auditRecorder,
    buildProjectStateAuditRecord(intent, "refused", { code, afterHash: intent.beforeHash }, now)
  )
}

async function auditDefiniteFailure(auditRecorder, intent, code, now) {
  return tryAudit(
    auditRecorder,
    buildProjectStateAuditRecord(intent, "failed", { code, afterHash: intent.beforeHash }, now)
  )
}

export async function handleProjectStatePromoteCommand(projectId, noteId, field, options = {}) {
  try {
    const project = resolveProjectStateProject(projectId)
    const normalizedNoteId = normalizeProjectStateNoteId(noteId)
    const normalizedField = normalizeProjectStateField(field)
    const paths = promotionPaths(project.id, options)
    const noteRecord = await resolveProjectStateNote(project.id, normalizedNoteId, options)
    const source = await readRegularFileIfPresent(paths.projectPath, "Target project state file")

    if (source === null) {
      throw stateError(
        "PROJECT_STATE_FILE_NOT_FOUND",
        "Target project state file was not found; no project state mutation was attempted."
      )
    }

    const intent = prepareProjectStatePromotion(
      project.id,
      normalizedNoteId,
      normalizedField.field,
      noteRecord.note,
      source,
      options
    )
    const now = nowDate(options)
    const auditRecorder = options.auditRecorder || createProjectStateAuditRecorder({
      auditPath: options.auditPath || paths.auditPath,
      writeDataDir: paths.writeDataDir
    })
    const confirmationValue = String(options.confirmationValue ?? "")
    const preview = buildPreview(intent)

    if (confirmationValue !== intent.requiredConfirmation) {
      const code = confirmationValue ? "CONFIRMATION_MISMATCH" : "CONFIRMATION_MISSING"
      const auditRecorded = await auditRefusal(auditRecorder, intent, code, now)
      const auditLine = auditRecorded
        ? "Audit: refusal recorded"
        : "Audit: unavailable for refused promotion; no project state mutation was attempted"

      return {
        ok: false,
        output: [
          preview,
          confirmationValue
            ? "Refused: confirmation mismatch; no project state mutation was attempted."
            : "Refused: confirmation missing; no project state mutation was attempted.",
          auditLine
        ].join("\n")
      }
    }

    try {
      await assertSafeGitTarget(intent.projectPath, options)
    } catch (error) {
      const safeError = safeFailure(error)
      await auditRefusal(auditRecorder, intent, safeError.code, now)
      return {
        ok: false,
        output: formatProjectStatePromoteError(safeError)
      }
    }

    const auditRecords = await readPromotionAuditRecords({
      ...options,
      auditPath: options.auditPath || paths.auditPath
    })
    const duplicateStatus = duplicatePromotionStatus(auditRecords, intent)

    if (!intent.replacement.changed || duplicateStatus === "succeeded") {
      await auditRefusal(auditRecorder, intent, "DUPLICATE_PROMOTION", now)
      return {
        ok: false,
        output: formatProjectStatePromoteError(stateError(
          "DUPLICATE_PROMOTION",
          "This note has already been promoted into the selected project-state field; no mutation was attempted."
        ))
      }
    }

    if (duplicateStatus === "ambiguous") {
      await auditRefusal(auditRecorder, intent, "PRIOR_ATTEMPT_AMBIGUOUS", now)
      return {
        ok: false,
        ambiguous: true,
        output: formatProjectStatePromoteError(stateError(
          "PRIOR_ATTEMPT_AMBIGUOUS",
          "A prior promotion attempt has no terminal audit record. Inspect the project file and audit trail before retrying."
        ))
      }
    }

    try {
      await auditRecorder.record(buildProjectStateAuditRecord(intent, "attempted", {}, now))
    } catch {
      return {
        ok: false,
        output: formatProjectStatePromoteError(stateError(
          "AUDIT_UNAVAILABLE",
          "Project state promotion audit trail is unavailable; no project state mutation was attempted."
        ))
      }
    }

    try {
      await assertSafeGitTarget(intent.projectPath, options)
      const currentSource = await readRegularFileIfPresent(intent.projectPath, "Target project state file")

      if (currentSource === null || sha256(currentSource) !== intent.beforeHash) {
        throw stateError(
          "TARGET_CHANGED_DURING_PROMOTION",
          "Target project state file changed during preflight; no project state mutation was attempted."
        )
      }
    } catch (error) {
      const safeError = safeFailure(error)
      const failureRecorded = await auditDefiniteFailure(
        auditRecorder,
        intent,
        safeError.code,
        options.now ? nowDate(options) : new Date()
      )

      if (!failureRecorded) {
        return {
          ok: false,
          output: formatProjectStatePromoteError(stateError(
            "AUDIT_UNAVAILABLE",
            "Promotion was stopped before mutation and the failure audit record could not be written. Inspect the audit trail before retrying."
          ))
        }
      }

      return {
        ok: false,
        output: formatProjectStatePromoteError(safeError)
      }
    }

    const replaceFile = options.replaceFile || atomicDurableProjectStateReplace

    try {
      await replaceFile(intent.projectPath, intent.replacement.output)
    } catch (error) {
      if (error?.mutationApplied === true) {
        return {
          ok: false,
          ambiguous: true,
          output: formatProjectStatePromoteError(error instanceof ProjectStatePromoteError
            ? error
            : new ProjectStateMutationAmbiguousError(
              "MUTATION_AMBIGUOUS",
              "Project state may have changed but mutation durability is ambiguous. Inspect the target and audit trail before retrying."
            ))
        }
      }

      const safeError = safeFailure(error)
      const failureRecorded = await auditDefiniteFailure(
        auditRecorder,
        intent,
        safeError.code,
        options.now ? nowDate(options) : new Date()
      )

      if (!failureRecorded) {
        return {
          ok: false,
          output: formatProjectStatePromoteError(stateError(
            "AUDIT_UNAVAILABLE",
            "Project state replacement failed and the failure audit record could not be written. Inspect the target before retrying."
          ))
        }
      }

      return {
        ok: false,
        output: formatProjectStatePromoteError(safeError)
      }
    }

    try {
      await auditRecorder.record(buildProjectStateAuditRecord(
        intent,
        "succeeded",
        {},
        options.now ? nowDate(options) : new Date()
      ))
    } catch {
      return {
        ok: false,
        ambiguous: true,
        output: [
          "PPO project state warning [SUCCESS_AUDIT_UNAVAILABLE]: Project state was promoted, but the success audit record could not be written.",
          "Treat this result as ambiguous and do not retry automatically; inspect the target and audit trail first."
        ].join("\n")
      }
    }

    return {
      ok: true,
      output: [
        "Project State Promoted",
        `Project: ${intent.project.id}`,
        `Field: ${intent.field}`,
        `Note ID: ${intent.noteId}`,
        `Before SHA-256: ${intent.beforeHash}`,
        `After SHA-256: ${intent.afterHash}`,
        "Audit: recorded"
      ].join("\n")
    }
  } catch (error) {
    return {
      ok: false,
      output: formatProjectStatePromoteError(error)
    }
  }
}
