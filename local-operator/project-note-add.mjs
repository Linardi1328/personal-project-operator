import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  getBlockedPhase2GitHubProjectStatus,
  getPhase2GitHubProject,
  listPhase2GitHubProjects
} from "./github-project-registry.mjs"

export const PROJECT_NOTE_ACTION = "add-note"
export const PROJECT_NOTE_DANGER_LEVEL = "dangerous"
export const NOTE_WRITE_CONFIRM_ENV = "PPO_NOTE_WRITE_CONFIRM"
export const PPO_WRITE_DATA_DIR_ENV = "PPO_WRITE_DATA_DIR"
export const DEFAULT_PPO_WRITE_DATA_DIR = fileURLToPath(new URL("./write-data", import.meta.url))
export const DEFAULT_PROJECT_NOTE_AUDIT_RELATIVE_PATH = "audit/project-note-audit.ndjson"
export const MAX_PROJECT_NOTE_CHARS = 2000
export const PROJECT_NOTE_ID_BYTES = 32
export const PROJECT_NOTE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u

const ansiTerminalSequence = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_])/u
const unsafeNoteControls = /[\u0000-\u001F\u007F-\u009F]/u
const safeAuditReasonPattern = /^[a-z0-9_:-]{1,80}$/u
const safeAuditCodePattern = /^[A-Z0-9_]{1,80}$/u

export class ProjectNoteAddError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "ProjectNoteAddError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function projectNoteError(code, safeMessage) {
  return new ProjectNoteAddError(code, safeMessage)
}

function allowedProjectIdList() {
  return listPhase2GitHubProjects().map((project) => project.id).join(", ")
}

function repoFullName(project) {
  return `${project.owner}/${project.repo}`
}

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PPO_WRITE_DATA_DIR
}

function noteAuditPath(options = {}) {
  if (typeof options.auditPath === "string" && options.auditPath.trim()) {
    return options.auditPath
  }

  return join(resolveWriteDataDir(options), DEFAULT_PROJECT_NOTE_AUDIT_RELATIVE_PATH)
}

function noteStorePaths(projectId, options = {}) {
  const root = resolveWriteDataDir(options)
  const notesRoot = join(root, "project-notes")

  return {
    root,
    notesRoot,
    notePath: join(notesRoot, `${projectId}.ndjson`),
    auditPath: noteAuditPath(options)
  }
}

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date()
  }

  return date
}

function noteTimestamp(now) {
  const value = now instanceof Date ? now : new Date(now)

  if (Number.isNaN(value.getTime())) {
    return new Date().toISOString()
  }

  return value.toISOString()
}

function hasUnsafeTerminalInput(value) {
  return ansiTerminalSequence.test(value) || unsafeNoteControls.test(value)
}

export function resolveProjectNoteProject(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw projectNoteError(
      "INVALID_PROJECT",
      `Project id is required. Use one of: ${allowedProjectIdList()}.`
    )
  }

  const normalizedProjectId = projectId.trim()
  const project = getPhase2GitHubProject(normalizedProjectId)

  if (project) {
    return {
      ...project,
      fullName: repoFullName(project)
    }
  }

  const blockedStatus = getBlockedPhase2GitHubProjectStatus(normalizedProjectId)

  if (blockedStatus) {
    throw projectNoteError(
      "PROJECT_NOT_CONNECTED",
      `Project is ${blockedStatus} and is not connected for Phase 5C note creation. Use one of: ${allowedProjectIdList()}.`
    )
  }

  throw projectNoteError(
    "UNKNOWN_PROJECT",
    `Project id is not in the connected project allowlist. Use one of: ${allowedProjectIdList()}.`
  )
}

export function normalizeProjectNote(noteInput = []) {
  const rawNote = Array.isArray(noteInput)
    ? noteInput.map((part) => String(part)).join(" ")
    : String(noteInput ?? "")

  if (hasUnsafeTerminalInput(rawNote)) {
    throw projectNoteError(
      "UNSAFE_INPUT",
      "Project note contains terminal control characters or escape sequences and was rejected."
    )
  }

  const note = rawNote.trim()

  if (!note) {
    throw projectNoteError(
      "INVALID_NOTE",
      "Project note text is required. Use: note-add <project> <note...>."
    )
  }

  if (note.length > MAX_PROJECT_NOTE_CHARS) {
    throw projectNoteError(
      "NOTE_TOO_LARGE",
      `Project note is too long for Phase 5C. Keep it at ${MAX_PROJECT_NOTE_CHARS} characters or fewer.`
    )
  }

  return note
}

export function prepareProjectNoteIntent(projectId, noteInput = []) {
  const project = resolveProjectNoteProject(projectId)
  const note = normalizeProjectNote(noteInput)
  const paths = noteStorePaths(project.id)

  return {
    action: PROJECT_NOTE_ACTION,
    dangerLevel: PROJECT_NOTE_DANGER_LEVEL,
    project,
    note,
    noteChars: note.length,
    notePath: paths.notePath,
    requiredConfirmation: `${PROJECT_NOTE_ACTION}:${project.id}`
  }
}

export function buildProjectNotePreview(intent) {
  return [
    "Project Note Add Preview",
    `Action: ${intent.action}`,
    `Project: ${intent.project.id}`,
    `Repo: ${intent.project.fullName}`,
    `Store: ${intent.notePath}`,
    `Intended change: append one project note`,
    `Note: present (${intent.noteChars} chars)`,
    `Danger level: ${intent.dangerLevel}`
  ].join("\n")
}

function confirmationRefusalLine(confirmationValue) {
  if (confirmationValue) {
    return "Refused: confirmation mismatch; no project note write was attempted."
  }

  return "Refused: confirmation missing; no project note write was attempted."
}

function confirmationInstruction(intent) {
  return `Required confirmation: ${NOTE_WRITE_CONFIRM_ENV}=${intent.requiredConfirmation}`
}

export function makeProjectNoteId({ randomBytesImpl = randomBytes } = {}) {
  const noteId = randomBytesImpl(PROJECT_NOTE_ID_BYTES).toString("base64url")

  if (!PROJECT_NOTE_ID_PATTERN.test(noteId)) {
    throw projectNoteError(
      "NOTE_ID_GENERATION_FAILED",
      "Project note id could not be generated; no project note write was attempted."
    )
  }

  return noteId
}

function projectNoteRecord(intent, noteId, now) {
  return {
    schemaVersion: 1,
    noteId,
    timestamp: noteTimestamp(now),
    action: intent.action,
    project: intent.project.id,
    projectName: intent.project.displayName,
    repo: intent.project.fullName,
    note: intent.note
  }
}

export function buildProjectNoteAuditRecord(intent, status, details = {}, now = new Date()) {
  const record = {
    schemaVersion: 1,
    timestamp: noteTimestamp(now),
    action: intent.action,
    project: intent.project.id,
    repo: intent.project.fullName,
    dangerLevel: intent.dangerLevel,
    status,
    noteChars: intent.noteChars
  }

  if (typeof details.reason === "string" && safeAuditReasonPattern.test(details.reason)) {
    record.reason = details.reason
  }

  if (typeof details.code === "string" && safeAuditCodePattern.test(details.code)) {
    record.code = details.code
  } else if (typeof details.code === "string") {
    record.code = "UNCLASSIFIED_FAILURE"
  }

  if (typeof details.noteId === "string" && PROJECT_NOTE_ID_PATTERN.test(details.noteId)) {
    record.noteId = details.noteId
  }

  return record
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function syncDirectory(path) {
  let directory

  try {
    directory = await open(path, "r")
    await directory.sync()
  } catch {
    return
  } finally {
    await directory?.close()
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

export function createProjectNoteAuditRecorder({
  auditPath,
  writeDataDir
} = {}) {
  const resolvedAuditPath = auditPath || noteAuditPath({ writeDataDir })
  const resolvedWriteDataDir = writeDataDir
    ? resolveWriteDataDir({ writeDataDir })
    : auditPath
      ? null
      : resolveWriteDataDir()

  return {
    auditPath: resolvedAuditPath,

    async record(entry) {
      await writeAppendOnlyLine(resolvedAuditPath, JSON.stringify(entry), {
        rootDir: resolvedWriteDataDir
      })
    }
  }
}

async function recordAudit(auditRecorder, intent, status, details, now) {
  await auditRecorder.record(buildProjectNoteAuditRecord(intent, status, details, now))
}

async function tryRecordAudit(auditRecorder, intent, status, details, now) {
  try {
    await recordAudit(auditRecorder, intent, status, details, now)
    return true
  } catch {
    return false
  }
}

export function createProjectNoteStore({
  writeDataDir
} = {}) {
  return {
    async append(intent, now = new Date()) {
      const noteId = intent.noteId

      if (!PROJECT_NOTE_ID_PATTERN.test(String(noteId ?? ""))) {
        throw projectNoteError(
          "MALFORMED_NOTE_INTENT",
          "Project note id is invalid; no project note write was attempted."
        )
      }

      const paths = noteStorePaths(intent.project.id, { writeDataDir })
      const record = projectNoteRecord(intent, noteId, now)

      await ensurePrivateDir(paths.root)
      await ensurePrivateDir(paths.notesRoot)
      await writeAppendOnlyLine(paths.notePath, JSON.stringify(record), {
        rootDir: paths.root
      })

      return {
        noteId,
        notePath: paths.notePath,
        record
      }
    }
  }
}

async function runInjectedStore(store, intent, now) {
  if (typeof store === "function") {
    return store(intent, now)
  }

  return store.append(intent, now)
}

function normalizeStoredNoteResult(result, intent) {
  if (!result || typeof result !== "object" || typeof result.noteId !== "string" || !PROJECT_NOTE_ID_PATTERN.test(result.noteId)) {
    throw projectNoteError(
      "MALFORMED_NOTE_RESULT",
      `Project note store returned an invalid note result for ${intent.project.id}. Inspect the note store before retrying.`
    )
  }

  if (result.noteId !== intent.noteId) {
    throw projectNoteError(
      "MALFORMED_NOTE_RESULT",
      `Project note store returned a mismatched note id for ${intent.project.id}. Inspect the note store before retrying.`
    )
  }

  return {
    noteId: result.noteId,
    notePath: typeof result.notePath === "string" ? result.notePath : intent.notePath
  }
}

function classifyProjectNoteFailure(error, intent) {
  if (error instanceof ProjectNoteAddError) {
    return error
  }

  if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") {
    return projectNoteError(
      "NOTE_STORE_UNAVAILABLE",
      `Project note store is unavailable for ${intent.project.id}. Confirm write-data permissions before retrying.`
    )
  }

  return projectNoteError(
    "NOTE_WRITE_FAILED",
    `Project note write failed for ${intent.project.id}. Inspect the note store before retrying.`
  )
}

function formatCreatedProjectNote(intent, storedNote) {
  return [
    "Project Note Added",
    `Action: ${intent.action}`,
    `Project: ${intent.project.id}`,
    `Repo: ${intent.project.fullName}`,
    `Note ID: ${storedNote.noteId}`,
    `Store: ${storedNote.notePath}`,
    "Audit: recorded"
  ].join("\n")
}

export function formatProjectNoteAddError(error) {
  if (error instanceof ProjectNoteAddError) {
    return `PPO project note error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO project note error: unexpected local failure."
}

export async function handleProjectNoteAddCommand(projectId, noteInput = [], options = {}) {
  try {
    const intent = prepareProjectNoteIntent(projectId, noteInput)
    const paths = noteStorePaths(intent.project.id, options)
    const now = nowDate(options)
    const auditRecorder = options.auditRecorder || createProjectNoteAuditRecorder({
      auditPath: options.auditPath || paths.auditPath,
      writeDataDir: paths.root
    })
    const confirmationValue = String(options.confirmationValue ?? "")
    const preview = buildProjectNotePreview({
      ...intent,
      notePath: paths.notePath
    })

    if (confirmationValue !== intent.requiredConfirmation) {
      const reason = confirmationValue ? "confirmation_mismatch" : "confirmation_missing"
      const auditRecorded = await tryRecordAudit(auditRecorder, intent, "refused", { reason }, now)
      const auditLine = auditRecorded
        ? "Audit: refusal recorded"
        : "Audit: unavailable for refused note attempt; no project note write was attempted"

      return {
        ok: false,
        output: [
          preview,
          confirmationRefusalLine(confirmationValue),
          confirmationInstruction(intent),
          auditLine
        ].join("\n")
      }
    }

    const noteId = makeProjectNoteId({ randomBytesImpl: options.randomBytesImpl })
    const confirmedIntent = {
      ...intent,
      notePath: paths.notePath,
      noteId
    }

    try {
      await recordAudit(
        auditRecorder,
        confirmedIntent,
        "attempted",
        { reason: "confirmed", noteId },
        now
      )
    } catch {
      return {
        ok: false,
        output: formatProjectNoteAddError(projectNoteError(
          "AUDIT_UNAVAILABLE",
          "Project note audit trail is unavailable; no project note write was attempted."
        ))
      }
    }

    const store = options.store || createProjectNoteStore({
      writeDataDir: options.writeDataDir
    })
    let storedNote

    try {
      storedNote = normalizeStoredNoteResult(
        await runInjectedStore(store, confirmedIntent, now),
        confirmedIntent
      )
    } catch (error) {
      const safeError = classifyProjectNoteFailure(error, intent)
      const failureRecorded = await tryRecordAudit(
        auditRecorder,
        confirmedIntent,
        "failed",
        { code: safeError.code, noteId },
        options.now ? options.now() : new Date()
      )

      if (!failureRecorded) {
        return {
          ok: false,
          output: formatProjectNoteAddError(projectNoteError(
            "AUDIT_UNAVAILABLE",
            "Project note write failed and the failure audit record could not be written. Inspect the note store before retrying."
          ))
        }
      }

      return {
        ok: false,
        output: formatProjectNoteAddError(safeError)
      }
    }

    try {
      await recordAudit(
        auditRecorder,
        confirmedIntent,
        "succeeded",
        { noteId },
        options.now ? options.now() : new Date()
      )
    } catch {
      return {
        ok: false,
        output: formatProjectNoteAddError(projectNoteError(
          "AUDIT_UNAVAILABLE",
          "Project note may have been written, but the success audit record could not be written. Inspect the note store and audit trail before retrying."
        ))
      }
    }

    return {
      ok: true,
      output: formatCreatedProjectNote(confirmedIntent, storedNote)
    }
  } catch (error) {
    return {
      ok: false,
      output: formatProjectNoteAddError(error)
    }
  }
}

export async function readProjectNoteRecords(projectId, options = {}) {
  const project = resolveProjectNoteProject(projectId)
  const { notePath } = noteStorePaths(project.id, options)
  let info

  try {
    info = await stat(notePath)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return []
    }

    throw error
  }

  if (!info.isFile()) {
    return []
  }

  const file = await open(notePath, "r")

  try {
    const content = await file.readFile("utf8")
    return content.trim()
      ? content.trim().split("\n").map((line) => JSON.parse(line))
      : []
  } finally {
    await file.close()
  }
}
