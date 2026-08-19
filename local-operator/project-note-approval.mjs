import { randomBytes } from "node:crypto"
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink
} from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV,
  ProjectNoteAddError,
  formatProjectNoteAddError,
  handleProjectNoteAddCommand,
  prepareProjectNoteIntent
} from "./project-note-add.mjs"

export const NOTE_APPROVAL_TTL_MS = 10 * 60 * 1000
export const NOTE_REQUEST_ID_BYTES = 32
export const NOTE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u

const chatConfirmationPattern = /\bPPO_NOTE_WRITE_CONFIRM\b/iu

export class ProjectNoteApprovalError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "ProjectNoteApprovalError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function approvalError(code, safeMessage) {
  return new ProjectNoteApprovalError(code, safeMessage)
}

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date()
  }

  return date
}

function splitFirstToken(value) {
  const match = String(value || "").match(/^(\S+)(?:[\t\n\r ]+([\s\S]*))?$/u)

  if (!match) {
    return null
  }

  return {
    token: match[1],
    rest: match[2] ?? ""
  }
}

export function parsePpoNoteAddRequest(rest) {
  const payload = String(rest ?? "")

  if (chatConfirmationPattern.test(payload)) {
    throw approvalError(
      "CHAT_CONFIRMATION_REJECTED",
      "Terminal note confirmation values are not accepted through /ppo chat; no note approval request was staged."
    )
  }

  const projectEnvelope = splitFirstToken(payload.trimStart())

  if (!projectEnvelope) {
    throw approvalError(
      "INVALID_NOTE_ADD_SYNTAX",
      "Use: /ppo note-add <project> <note...>."
    )
  }

  const intent = prepareProjectNoteIntent(projectEnvelope.token, projectEnvelope.rest)

  return {
    projectId: intent.project.id,
    note: intent.note,
    intent
  }
}

export function parsePpoNoteConfirmRequest(rest) {
  const payload = String(rest ?? "").trim()
  const envelope = splitFirstToken(payload)

  if (!envelope || envelope.rest.trim()) {
    throw approvalError(
      "INVALID_REQUEST_ID",
      "Project note confirmation request id is malformed; no project note write was attempted."
    )
  }

  return normalizeNoteRequestId(envelope.token)
}

export function normalizeNoteRequestId(requestId) {
  const normalized = String(requestId ?? "").trim()

  if (!NOTE_REQUEST_ID_PATTERN.test(normalized)) {
    throw approvalError(
      "INVALID_REQUEST_ID",
      "Project note confirmation request id is malformed; no project note write was attempted."
    )
  }

  return normalized
}

export function makeNoteRequestId({ randomBytesImpl = randomBytes } = {}) {
  const requestId = randomBytesImpl(NOTE_REQUEST_ID_BYTES).toString("base64url")

  if (!NOTE_REQUEST_ID_PATTERN.test(requestId)) {
    throw approvalError(
      "REQUEST_ID_GENERATION_FAILED",
      "Project note approval request id could not be generated; no approval request was staged."
    )
  }

  return requestId
}

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PPO_WRITE_DATA_DIR
}

function storePaths(options = {}) {
  const root = resolveWriteDataDir(options)
  const noteRoot = join(root, "pending-project-notes")

  return {
    root,
    noteRoot,
    pendingDir: join(noteRoot, "pending"),
    claimedDir: join(noteRoot, "claimed")
  }
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function ensureStore(paths) {
  await ensurePrivateDir(paths.root)
  await ensurePrivateDir(paths.noteRoot)
  await ensurePrivateDir(paths.pendingDir)
  await ensurePrivateDir(paths.claimedDir)
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

function persistedIntent(intent) {
  return {
    action: intent.action,
    dangerLevel: intent.dangerLevel,
    project: {
      id: intent.project.id,
      displayName: intent.project.displayName,
      owner: intent.project.owner,
      repo: intent.project.repo,
      fullName: intent.project.fullName
    },
    note: intent.note,
    noteChars: intent.noteChars,
    requiredConfirmation: intent.requiredConfirmation
  }
}

function requestRecord({ requestId, intent, createdAt, expiresAt }) {
  return {
    schemaVersion: 1,
    requestId,
    createdAt,
    expiresAt,
    intent: persistedIntent(intent)
  }
}

async function writeFilePrivate(path, data) {
  const file = await open(path, "wx", 0o600)

  try {
    await file.writeFile(data, "utf8")
    await file.sync()
  } finally {
    await file.close()
  }

  await chmod(path, 0o600)
}

async function writePendingRecord(paths, record, options) {
  let lastError

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const requestId = attempt === 0
      ? record.requestId
      : makeNoteRequestId(options)
    const updatedRecord = {
      ...record,
      requestId
    }
    const tempName = `.${requestId}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    const tempPath = join(paths.pendingDir, tempName)
    const finalPath = join(paths.pendingDir, `${requestId}.json`)
    const data = `${JSON.stringify(updatedRecord)}\n`

    try {
      await writeFilePrivate(tempPath, data)
      await link(tempPath, finalPath)

      try {
        await chmod(finalPath, 0o600)
      } catch {
        // The linked file inherits the private temp file mode.
      }

      try {
        await unlink(tempPath)
      } catch {
        // A leftover temp hardlink contains only one private pending request.
      }

      await syncDirectory(paths.pendingDir)
      return updatedRecord
    } catch (error) {
      lastError = error

      try {
        await unlink(tempPath)
      } catch {
        // Best-effort cleanup; the temp filename carries no request content.
      }

      if (error?.code !== "EEXIST") {
        break
      }
    }
  }

  throw lastError || approvalError(
    "PENDING_STORE_UNAVAILABLE",
    "Project note approval request store is unavailable; no approval request was staged."
  )
}

function normalizeStoredIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored project note approval request is invalid; no project note write was attempted."
    )
  }

  const normalized = prepareProjectNoteIntent(intent.project?.id, intent.note)

  if (
    normalized.action !== intent.action ||
    normalized.dangerLevel !== intent.dangerLevel ||
    normalized.project.displayName !== intent.project?.displayName ||
    normalized.project.owner !== intent.project?.owner ||
    normalized.project.repo !== intent.project?.repo ||
    normalized.project.fullName !== intent.project?.fullName ||
    normalized.noteChars !== intent.noteChars ||
    normalized.requiredConfirmation !== intent.requiredConfirmation
  ) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored project note approval request is invalid; no project note write was attempted."
    )
  }

  return normalized
}

function parseStoredRequest(payload, expectedRequestId = null) {
  let parsed

  try {
    parsed = JSON.parse(payload)
  } catch {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored project note approval request is invalid; no project note write was attempted."
    )
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schemaVersion !== 1) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored project note approval request is invalid; no project note write was attempted."
    )
  }

  const requestId = normalizeNoteRequestId(parsed.requestId)

  if (expectedRequestId && requestId !== expectedRequestId) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored project note approval request is invalid; no project note write was attempted."
    )
  }

  const createdAtMs = Date.parse(parsed.createdAt)
  const expiresAtMs = Date.parse(parsed.expiresAt)

  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= createdAtMs) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored project note approval request is invalid; no project note write was attempted."
    )
  }

  return {
    schemaVersion: 1,
    requestId,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    intent: normalizeStoredIntent(parsed.intent)
  }
}

function isExpired(record, now = new Date()) {
  return Date.parse(record.expiresAt) <= now.getTime()
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false
    }

    throw error
  }
}

async function deleteExpiredFromDirectory(directory, now) {
  let entries

  try {
    entries = await readdir(directory)
  } catch {
    return
  }

  for (const entry of entries) {
    const path = join(directory, entry)

    if (entry.endsWith(".tmp")) {
      try {
        const info = await stat(path)

        if (now.getTime() - info.mtimeMs >= NOTE_APPROVAL_TTL_MS) {
          await unlinkIfPresent(path)
        }
      } catch {
        await unlinkIfPresent(path)
      }

      continue
    }

    if (!entry.endsWith(".json")) {
      continue
    }

    try {
      const record = parseStoredRequest(await readFile(path, "utf8"))

      if (isExpired(record, now)) {
        await unlinkIfPresent(path)
      }
    } catch {
      await unlinkIfPresent(path)
    }
  }

  await syncDirectory(directory)
}

export async function cleanupExpiredProjectNoteApprovalRequests(options = {}) {
  const paths = storePaths(options)
  const now = nowDate(options)

  await ensureStore(paths)
  await deleteExpiredFromDirectory(paths.pendingDir, now)
  await deleteExpiredFromDirectory(paths.claimedDir, now)
}

export async function stageProjectNoteApprovalRequest(intent, options = {}) {
  const normalizedIntent = normalizeStoredIntent(persistedIntent(intent))
  const paths = storePaths(options)
  const createdAtDate = nowDate(options)
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : NOTE_APPROVAL_TTL_MS

  if (ttlMs <= 0) {
    throw approvalError(
      "INVALID_TTL",
      "Project note approval request ttl is invalid; no approval request was staged."
    )
  }

  await ensureStore(paths)
  await cleanupExpiredProjectNoteApprovalRequests(options)

  const requestId = makeNoteRequestId(options)
  const createdAt = createdAtDate.toISOString()
  const expiresAt = new Date(createdAtDate.getTime() + ttlMs).toISOString()
  const record = requestRecord({
    requestId,
    intent: normalizedIntent,
    createdAt,
    expiresAt
  })

  return writePendingRecord(paths, record, options)
}

export async function claimProjectNoteApprovalRequest(requestId, options = {}) {
  const normalizedRequestId = normalizeNoteRequestId(requestId)
  const paths = storePaths(options)
  const pendingPath = join(paths.pendingDir, `${normalizedRequestId}.json`)
  const claimedPath = join(
    paths.claimedDir,
    `${normalizedRequestId}.${process.pid}.${randomBytes(8).toString("hex")}.json`
  )
  const now = nowDate(options)

  await ensureStore(paths)

  try {
    await rename(pendingPath, claimedPath)
    await syncDirectory(paths.pendingDir)
    await syncDirectory(paths.claimedDir)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw approvalError(
        "REQUEST_NOT_FOUND",
        "Project note confirmation request was not found, expired, or already consumed; no project note write was attempted."
      )
    }

    throw error
  }

  let record

  try {
    record = parseStoredRequest(await readFile(claimedPath, "utf8"), normalizedRequestId)

    if (isExpired(record, now)) {
      throw approvalError(
        "REQUEST_EXPIRED",
        "Project note confirmation request was not found, expired, or already consumed; no project note write was attempted."
      )
    }

    await unlinkIfPresent(claimedPath)
    await syncDirectory(paths.claimedDir)

    return record
  } catch (error) {
    await unlinkIfPresent(claimedPath)
    await syncDirectory(paths.claimedDir)

    if (error instanceof ProjectNoteApprovalError || error instanceof ProjectNoteAddError) {
      throw error
    }

    throw approvalError(
      "PENDING_STORE_UNAVAILABLE",
      "Project note approval request store is unavailable; no project note write was attempted."
    )
  }
}

function formatStagedProjectNoteApproval(record) {
  return [
    [
      "Project Note Add Preview",
      `Action: ${record.intent.action}`,
      `Project: ${record.intent.project.id}`,
      `Repo: ${record.intent.project.fullName}`,
      "Intended change: append one project note after confirmation",
      `Note: present (${record.intent.noteChars} chars)`,
      `Danger level: ${record.intent.dangerLevel}`
    ].join("\n"),
    `Request ID: ${record.requestId}`,
    `Expires: ${record.expiresAt}`,
    `Confirm: /ppo note-confirm ${record.requestId}`
  ].join("\n")
}

export function formatProjectNoteApprovalError(error) {
  if (error instanceof ProjectNoteAddError) {
    return formatProjectNoteAddError(error)
  }

  if (error instanceof ProjectNoteApprovalError) {
    return `PPO project note approval error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO project note approval error: unexpected local failure."
}

export async function handlePreparedProjectNoteAddIntent(intent, options = {}) {
  const normalizedIntent = normalizeStoredIntent(persistedIntent(intent))
  const writerOptions = {
    ...options,
    confirmationValue: normalizedIntent.requiredConfirmation
  }

  if (typeof options.writer === "function") {
    return options.writer(normalizedIntent, writerOptions)
  }

  return handleProjectNoteAddCommand(normalizedIntent.project.id, normalizedIntent.note, writerOptions)
}

export async function handlePpoNoteAddApprovalCommand(rest, options = {}) {
  try {
    const parsed = parsePpoNoteAddRequest(rest)
    const record = await stageProjectNoteApprovalRequest(parsed.intent, options)

    return {
      ok: true,
      output: formatStagedProjectNoteApproval(record)
    }
  } catch (error) {
    return {
      ok: false,
      output: formatProjectNoteApprovalError(error)
    }
  }
}

export async function handlePpoNoteConfirmCommand(rest, options = {}) {
  try {
    const requestId = parsePpoNoteConfirmRequest(rest)
    const record = await claimProjectNoteApprovalRequest(requestId, options)

    return handlePreparedProjectNoteAddIntent(record.intent, options)
  } catch (error) {
    return {
      ok: false,
      output: formatProjectNoteApprovalError(error)
    }
  }
}
