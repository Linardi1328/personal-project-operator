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
import { fileURLToPath } from "node:url"
import {
  GitHubIssueCreateError,
  buildIssueCreatePreview,
  formatGitHubIssueCreateError,
  handlePreparedGitHubIssueCreateIntent,
  normalizePreparedIssueCreateIntent,
  prepareIssueCreateIntent
} from "./github-issue-create.mjs"

export const PPO_WRITE_DATA_DIR_ENV = "PPO_WRITE_DATA_DIR"
export const DEFAULT_PPO_WRITE_DATA_DIR = fileURLToPath(new URL("./write-data", import.meta.url))
export const ISSUE_APPROVAL_TTL_MS = 10 * 60 * 1000
export const ISSUE_REQUEST_ID_BYTES = 32
export const ISSUE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u

const chatConfirmationPattern = /\bPPO_GITHUB_WRITE_CONFIRM\b/iu

export class GitHubIssueApprovalError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "GitHubIssueApprovalError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function approvalError(code, safeMessage) {
  return new GitHubIssueApprovalError(code, safeMessage)
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

function splitIssueTitleAndBody(payload) {
  const delimiter = String(payload ?? "").match(/(^|[\t\n\r ])--body(?=$|[\t\n\r ])/u)

  if (!delimiter) {
    return {
      title: String(payload ?? ""),
      body: ""
    }
  }

  const delimiterEnd = delimiter.index + delimiter[0].length
  const body = String(payload ?? "").slice(delimiterEnd)

  if (!body.trim()) {
    throw approvalError(
      "INVALID_BODY_DELIMITER",
      "Issue body text is required after the body delimiter; no approval request was staged."
    )
  }

  return {
    title: String(payload ?? "").slice(0, delimiter.index),
    body
  }
}

export function parsePpoIssueCreateRequest(rest) {
  const payload = String(rest ?? "")

  if (chatConfirmationPattern.test(payload)) {
    throw approvalError(
      "CHAT_CONFIRMATION_REJECTED",
      "Terminal write confirmation values are not accepted through /ppo chat; no approval request was staged."
    )
  }

  const projectEnvelope = splitFirstToken(payload.trimStart())

  if (!projectEnvelope) {
    throw approvalError(
      "INVALID_ISSUE_CREATE_SYNTAX",
      "Use: /ppo issue-create <project> <title> [--body <body>]."
    )
  }

  const { title, body } = splitIssueTitleAndBody(projectEnvelope.rest)
  const intent = prepareIssueCreateIntent(projectEnvelope.token, title, body)

  return {
    projectId: intent.project.id,
    title: intent.title,
    body: intent.body,
    intent
  }
}

export function parsePpoIssueConfirmRequest(rest) {
  const payload = String(rest ?? "").trim()
  const envelope = splitFirstToken(payload)

  if (!envelope || envelope.rest.trim()) {
    throw approvalError(
      "INVALID_REQUEST_ID",
      "Issue confirmation request id is malformed; no GitHub write was attempted."
    )
  }

  return normalizeIssueRequestId(envelope.token)
}

export function normalizeIssueRequestId(requestId) {
  const normalized = String(requestId ?? "").trim()

  if (!ISSUE_REQUEST_ID_PATTERN.test(normalized)) {
    throw approvalError(
      "INVALID_REQUEST_ID",
      "Issue confirmation request id is malformed; no GitHub write was attempted."
    )
  }

  return normalized
}

export function makeIssueRequestId({ randomBytesImpl = randomBytes } = {}) {
  const requestId = randomBytesImpl(ISSUE_REQUEST_ID_BYTES).toString("base64url")

  if (!ISSUE_REQUEST_ID_PATTERN.test(requestId)) {
    throw approvalError(
      "REQUEST_ID_GENERATION_FAILED",
      "Issue approval request id could not be generated; no approval request was staged."
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
  const issueRoot = join(root, "pending-github-issues")

  return {
    root,
    issueRoot,
    pendingDir: join(issueRoot, "pending"),
    claimedDir: join(issueRoot, "claimed")
  }
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function ensureStore(paths) {
  await ensurePrivateDir(paths.root)
  await ensurePrivateDir(paths.issueRoot)
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

function jsonLineFreeIntent(intent) {
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
    method: intent.method,
    endpoint: intent.endpoint,
    title: intent.title,
    body: intent.body,
    requiredConfirmation: intent.requiredConfirmation
  }
}

function requestRecord({ requestId, intent, createdAt, expiresAt }) {
  return {
    schemaVersion: 1,
    requestId,
    createdAt,
    expiresAt,
    intent: jsonLineFreeIntent(intent)
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
      : makeIssueRequestId(options)
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
        // A leftover temp hardlink is cleaned by later expiry cleanup.
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
    "Issue approval request store is unavailable; no approval request was staged."
  )
}

function parseStoredRequest(payload, expectedRequestId = null) {
  let parsed

  try {
    parsed = JSON.parse(payload)
  } catch {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored issue approval request is invalid; no GitHub write was attempted."
    )
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schemaVersion !== 1) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored issue approval request is invalid; no GitHub write was attempted."
    )
  }

  const requestId = normalizeIssueRequestId(parsed.requestId)

  if (expectedRequestId && requestId !== expectedRequestId) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored issue approval request is invalid; no GitHub write was attempted."
    )
  }

  const createdAtMs = Date.parse(parsed.createdAt)
  const expiresAtMs = Date.parse(parsed.expiresAt)

  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= createdAtMs) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored issue approval request is invalid; no GitHub write was attempted."
    )
  }

  return {
    schemaVersion: 1,
    requestId,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    intent: normalizePreparedIssueCreateIntent(parsed.intent)
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

        if (now.getTime() - info.mtimeMs >= ISSUE_APPROVAL_TTL_MS) {
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

export async function cleanupExpiredIssueApprovalRequests(options = {}) {
  const paths = storePaths(options)
  const now = nowDate(options)

  await ensureStore(paths)
  await deleteExpiredFromDirectory(paths.pendingDir, now)
  await deleteExpiredFromDirectory(paths.claimedDir, now)
}

export async function stageIssueApprovalRequest(intent, options = {}) {
  const normalizedIntent = normalizePreparedIssueCreateIntent(intent)
  const paths = storePaths(options)
  const createdAtDate = nowDate(options)
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : ISSUE_APPROVAL_TTL_MS

  if (ttlMs <= 0) {
    throw approvalError(
      "INVALID_TTL",
      "Issue approval request ttl is invalid; no approval request was staged."
    )
  }

  await ensureStore(paths)
  await cleanupExpiredIssueApprovalRequests(options)

  const requestId = makeIssueRequestId(options)
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

export async function claimIssueApprovalRequest(requestId, options = {}) {
  const normalizedRequestId = normalizeIssueRequestId(requestId)
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
        "Issue confirmation request was not found, expired, or already consumed; no GitHub write was attempted."
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
        "Issue confirmation request was not found, expired, or already consumed; no GitHub write was attempted."
      )
    }

    await unlinkIfPresent(claimedPath)
    await syncDirectory(paths.claimedDir)

    return record
  } catch (error) {
    await unlinkIfPresent(claimedPath)
    await syncDirectory(paths.claimedDir)

    if (error instanceof GitHubIssueApprovalError || error instanceof GitHubIssueCreateError) {
      throw error
    }

    throw approvalError(
      "PENDING_STORE_UNAVAILABLE",
      "Issue approval request store is unavailable; no GitHub write was attempted."
    )
  }
}

function formatStagedIssueApproval(record) {
  return [
    buildIssueCreatePreview(record.intent),
    `Request ID: ${record.requestId}`,
    `Expires: ${record.expiresAt}`,
    `Confirm: /ppo issue-confirm ${record.requestId}`
  ].join("\n")
}

export function formatGitHubIssueApprovalError(error) {
  if (error instanceof GitHubIssueCreateError) {
    return formatGitHubIssueCreateError(error)
  }

  if (error instanceof GitHubIssueApprovalError) {
    return `PPO GitHub issue approval error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO GitHub issue approval error: unexpected local failure."
}

export async function handlePpoIssueCreateApprovalCommand(rest, options = {}) {
  try {
    const parsed = parsePpoIssueCreateRequest(rest)
    const record = await stageIssueApprovalRequest(parsed.intent, options)

    return {
      ok: true,
      output: formatStagedIssueApproval(record)
    }
  } catch (error) {
    return {
      ok: false,
      output: formatGitHubIssueApprovalError(error)
    }
  }
}

export async function handlePpoIssueConfirmCommand(rest, options = {}) {
  try {
    const requestId = parsePpoIssueConfirmRequest(rest)
    const record = await claimIssueApprovalRequest(requestId, options)

    return handlePreparedGitHubIssueCreateIntent(record.intent, {
      ...options,
      confirmationValue: record.intent.requiredConfirmation
    })
  } catch (error) {
    return {
      ok: false,
      output: formatGitHubIssueApprovalError(error)
    }
  }
}
