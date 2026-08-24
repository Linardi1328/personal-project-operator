import { createHash, randomBytes } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename
} from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import {
  DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES,
  DEVELOPMENT_RUN_CANCELLATION_ID,
  DEVELOPMENT_RUN_CANCELLATION_REASON,
  PHASE_6P_RUN_CANCELLATION_POLICY_HASH,
  PHASE_6P_RUN_CANCELLATION_POLICY_ID,
  developmentRunCancellationPolicy,
  executeDevelopmentRunCancellation,
  formatDevelopmentRunCancellation,
  inspectDevelopmentRunCancellationEligibility,
  makeDevelopmentRunCancellationFailure
} from "./development-run-cancellation.mjs"
import { DEVELOPMENT_RUN_ID_PATTERN } from "./development-run-id.mjs"
import {
  MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
} from "./development-run-state.mjs"
import { getOrdinaryDevelopmentProject } from "./github-project-registry.mjs"

export const DEVELOPMENT_RUN_CANCELLATION_APPROVAL_ID = "phase-6p-development-run-cancellation-approval"
export const PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID = "phase-6p-development-run-cancellation-approval-policy"
export const DEVELOPMENT_RUN_CANCELLATION_APPROVAL_TTL_MS = 10 * 60 * 1000
export const CANCELLATION_REQUEST_ID_BYTES = 32
export const CANCELLATION_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u
export const DEVELOPMENT_RUN_CANCELLATION_APPROVAL_STORE_DIR = "pending-development-run-cancellations"

const MAX_CANCELLATION_REQUEST_RECORD_BYTES = 4096
const CANCELLATION_PENDING_DIR_NAME = "pending"
const CANCELLATION_CLAIMED_DIR_NAME = "claimed"
const versionBound = MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES
const claimedRequestFilePattern = /^([A-Za-z0-9_-]{43})\.[0-9]+\.[a-f0-9]{16}\.json$/u
const eligibleStatusSet = new Set(DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES)

export class DevelopmentRunCancellationApprovalError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "DevelopmentRunCancellationApprovalError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function approvalError(code, safeMessage) {
  return new DevelopmentRunCancellationApprovalError(code, safeMessage)
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

const approvalContract = Object.freeze({
  approval: DEVELOPMENT_RUN_CANCELLATION_APPROVAL_ID,
  policy: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID,
  schemaVersion: 1,
  cancellation: {
    id: DEVELOPMENT_RUN_CANCELLATION_ID,
    policy: {
      id: PHASE_6P_RUN_CANCELLATION_POLICY_ID,
      hash: PHASE_6P_RUN_CANCELLATION_POLICY_HASH
    }
  },
  requestTtlMs: DEVELOPMENT_RUN_CANCELLATION_APPROVAL_TTL_MS,
  requestIdBytes: CANCELLATION_REQUEST_ID_BYTES,
  requestIdPattern: CANCELLATION_REQUEST_ID_PATTERN.source,
  requestStore: {
    root: DEVELOPMENT_RUN_CANCELLATION_APPROVAL_STORE_DIR,
    pending: CANCELLATION_PENDING_DIR_NAME,
    claimed: CANCELLATION_CLAIMED_DIR_NAME
  },
  requestBinding: ["runId", "expectedVersion", "projectId", "beforeStatus"],
  pendingToClaimedSingleUse: true,
  claimOperation: "pending-to-claimed",
  commands: {
    stage: "/ppo cancel",
    confirm: "/ppo cancel-confirm"
  },
  callerInput: {
    stage: ["runId"],
    confirm: ["requestId"]
  },
  callerSelectedAction: false,
  callerSelectedStatus: false,
  callerSelectedActor: false,
  callerSelectedReason: false,
  callerSelectedVersion: false,
  automaticRetry: false
})

export const PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH = createHash("sha256")
  .update(stableStringify(approvalContract))
  .digest("hex")

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date()
  }

  return date
}

function hasOnlyKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const allowed = new Set(keys)
  const actual = Object.keys(value)

  return actual.length === keys.length && actual.every((key) => allowed.has(key))
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
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
  const approvalRoot = join(root, DEVELOPMENT_RUN_CANCELLATION_APPROVAL_STORE_DIR)

  return {
    root,
    approvalRoot,
    pendingDir: join(approvalRoot, CANCELLATION_PENDING_DIR_NAME),
    claimedDir: join(approvalRoot, CANCELLATION_CLAIMED_DIR_NAME)
  }
}

function requestFilePath(directory, requestId) {
  return join(directory, `${requestId}.json`)
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  }
}

async function ensurePrivateDir(path) {
  const before = await lstatIfPresent(path)

  if (before && (!before.isDirectory() || before.isSymbolicLink())) {
    throw approvalError(
      "STORE_UNAVAILABLE",
      "Development run cancellation approval store is unavailable."
    )
  }

  if (!before) {
    await mkdir(path, { mode: 0o700 })
  }

  const after = await lstat(path)

  if (!after.isDirectory() || after.isSymbolicLink()) {
    throw approvalError(
      "STORE_UNAVAILABLE",
      "Development run cancellation approval store is unavailable."
    )
  }

  await chmod(path, 0o700)
}

async function ensureStore(paths) {
  await ensurePrivateDir(paths.root)
  await ensurePrivateDir(paths.approvalRoot)
  await ensurePrivateDir(paths.pendingDir)
  await ensurePrivateDir(paths.claimedDir)
}

async function requireExistingStore(paths) {
  for (const path of [paths.approvalRoot, paths.pendingDir, paths.claimedDir]) {
    const info = await lstatIfPresent(path)

    if (info === null) {
      return false
    }

    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw approvalError(
        "STORE_UNAVAILABLE",
        "Development run cancellation approval store is unavailable."
      )
    }
  }

  return true
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

function normalizeCancellationRequestId(requestId) {
  if (typeof requestId !== "string" || !CANCELLATION_REQUEST_ID_PATTERN.test(requestId)) {
    throw approvalError(
      "INVALID_REQUEST_ID",
      "Development run cancellation confirmation request id is malformed."
    )
  }

  return requestId
}

export function makeDevelopmentRunCancellationRequestId({ randomBytesImpl = randomBytes } = {}) {
  const requestId = randomBytesImpl(CANCELLATION_REQUEST_ID_BYTES).toString("base64url")

  if (!CANCELLATION_REQUEST_ID_PATTERN.test(requestId)) {
    throw approvalError(
      "REQUEST_ID_GENERATION_FAILED",
      "Development run cancellation request id could not be generated."
    )
  }

  return requestId
}

function approvalPolicyRecord() {
  return {
    id: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID,
    hash: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH
  }
}

function requestRecord({
  requestId,
  createdAt,
  expiresAt,
  runId,
  expectedVersion,
  projectId,
  beforeStatus
}) {
  return {
    schemaVersion: 1,
    requestId,
    createdAt,
    expiresAt,
    policyId: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID,
    policyHash: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH,
    runId,
    expectedVersion,
    projectId,
    beforeStatus
  }
}

function serializedRequestRecord(record) {
  const data = `${JSON.stringify(record)}\n`

  if (Buffer.byteLength(data, "utf8") > MAX_CANCELLATION_REQUEST_RECORD_BYTES) {
    throw approvalError(
      "STORE_UNAVAILABLE",
      "Development run cancellation approval store is unavailable."
    )
  }

  return data
}

async function writeFilePrivateExclusive(path, data) {
  const file = await open(path, "wx", 0o600)

  try {
    await file.writeFile(data, "utf8")
    await file.sync()
  } finally {
    await file.close()
  }

  await chmod(path, 0o600)
}

async function writePendingRecord(paths, record, options = {}) {
  let lastError

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const requestId = attempt === 0
      ? record.requestId
      : makeDevelopmentRunCancellationRequestId(options)
    const updatedRecord = {
      ...record,
      requestId
    }
    const pendingPath = requestFilePath(paths.pendingDir, requestId)

    try {
      await writeFilePrivateExclusive(pendingPath, serializedRequestRecord(updatedRecord))
      await syncDirectory(paths.pendingDir)
      return updatedRecord
    } catch (error) {
      lastError = error

      if (error?.code !== "EEXIST") {
        break
      }
    }
  }

  throw lastError || approvalError(
    "STORE_UNAVAILABLE",
    "Development run cancellation approval store is unavailable."
  )
}

function normalizeStoredProjectId(projectId) {
  if (projectId === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id) {
    return projectId
  }

  if (!getOrdinaryDevelopmentProject(projectId)) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored development run cancellation request is invalid."
    )
  }

  return projectId
}

function parseStoredRequest(payload, expectedRequestId = null) {
  let parsed

  try {
    parsed = JSON.parse(payload)
  } catch {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored development run cancellation request is invalid."
    )
  }

  if (!hasOnlyKeys(parsed, [
    "schemaVersion",
    "requestId",
    "createdAt",
    "expiresAt",
    "policyId",
    "policyHash",
    "runId",
    "expectedVersion",
    "projectId",
    "beforeStatus"
  ])) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored development run cancellation request is invalid."
    )
  }

  const requestId = normalizeCancellationRequestId(parsed.requestId)

  if (expectedRequestId && requestId !== expectedRequestId) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored development run cancellation request is invalid."
    )
  }

  if (
    parsed.schemaVersion !== 1 ||
    parsed.policyId !== PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID ||
    parsed.policyHash !== PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH ||
    !DEVELOPMENT_RUN_ID_PATTERN.test(parsed.runId) ||
    !Number.isInteger(parsed.expectedVersion) ||
    parsed.expectedVersion < 0 ||
    parsed.expectedVersion >= versionBound ||
    !eligibleStatusSet.has(parsed.beforeStatus) ||
    !isIsoTimestamp(parsed.createdAt) ||
    !isIsoTimestamp(parsed.expiresAt) ||
    Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)
  ) {
    throw approvalError(
      "INVALID_PENDING_REQUEST",
      "Stored development run cancellation request is invalid."
    )
  }

  return {
    schemaVersion: 1,
    requestId,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    policyId: parsed.policyId,
    policyHash: parsed.policyHash,
    runId: parsed.runId,
    expectedVersion: parsed.expectedVersion,
    projectId: normalizeStoredProjectId(parsed.projectId),
    beforeStatus: parsed.beforeStatus
  }
}

function isExpired(record, now) {
  return Date.parse(record.expiresAt) <= now.getTime()
}

async function assertTrustedRequestFileLeaf(path) {
  const before = await lstatIfPresent(path)

  if (!before) {
    throw approvalError(
      "REQUEST_NOT_FOUND",
      "Development run cancellation request was not found, expired, or already consumed."
    )
  }

  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CANCELLATION_REQUEST_RECORD_BYTES) {
    throw approvalError(
      "STORE_UNAVAILABLE",
      "Development run cancellation approval store is unavailable."
    )
  }
}

async function readTrustedRequestFile(path, expectedRequestId) {
  await assertTrustedRequestFileLeaf(path)

  const file = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))

  try {
    const current = await file.stat()

    if (!current.isFile() || current.size > MAX_CANCELLATION_REQUEST_RECORD_BYTES) {
      throw approvalError(
        "STORE_UNAVAILABLE",
        "Development run cancellation approval store is unavailable."
      )
    }

    return parseStoredRequest(await file.readFile("utf8"), expectedRequestId)
  } finally {
    await file.close()
  }
}

async function hasClaimedRequest(paths, requestId) {
  let entries

  try {
    entries = await readdir(paths.claimedDir)
  } catch {
    return false
  }

  return entries.some((entry) => {
    const match = entry.match(claimedRequestFilePattern)
    return match && match[1] === requestId
  })
}

function mapApprovalFailure(error) {
  if (!(error instanceof DevelopmentRunCancellationApprovalError)) {
    return makeDevelopmentRunCancellationFailure("store_unavailable")
  }

  if (error.code === "INVALID_REQUEST_ID") {
    return makeDevelopmentRunCancellationFailure("invalid_request_id")
  }

  if (error.code === "REQUEST_NOT_FOUND") {
    return makeDevelopmentRunCancellationFailure("request_not_found")
  }

  if (error.code === "REQUEST_ALREADY_CONSUMED") {
    return makeDevelopmentRunCancellationFailure("request_already_consumed")
  }

  if (error.code === "REQUEST_EXPIRED") {
    return makeDevelopmentRunCancellationFailure("request_expired")
  }

  if (error.code === "STORE_UNAVAILABLE") {
    return makeDevelopmentRunCancellationFailure("store_unavailable")
  }

  return makeDevelopmentRunCancellationFailure("cancellation_unavailable")
}

export async function stageDevelopmentRunCancellationApproval(runId, options = {}) {
  try {
    const ready = await inspectDevelopmentRunCancellationEligibility(runId, options)

    if (!ready.ok) {
      return ready
    }

    const paths = storePaths(options)
    const createdAtDate = nowDate(options)
    const requestId = makeDevelopmentRunCancellationRequestId(options)
    const createdAt = createdAtDate.toISOString()
    const expiresAt = new Date(createdAtDate.getTime() + DEVELOPMENT_RUN_CANCELLATION_APPROVAL_TTL_MS).toISOString()
    const record = requestRecord({
      requestId,
      createdAt,
      expiresAt,
      runId: ready.runId,
      expectedVersion: ready.expectedVersion,
      projectId: ready.project,
      beforeStatus: ready.beforeStatus
    })

    await ensureStore(paths)
    const stored = await writePendingRecord(paths, record, options)

    return {
      schemaVersion: 1,
      cancellation: DEVELOPMENT_RUN_CANCELLATION_ID,
      policy: developmentRunCancellationPolicy(),
      ok: true,
      code: "cancellation_staged",
      outcome: "cancellation_staged",
      runId: ready.runId,
      project: ready.project,
      beforeStatus: ready.beforeStatus,
      expectedVersion: ready.expectedVersion,
      headSha: ready.headSha,
      requestId: stored.requestId,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt
    }
  } catch (error) {
    return mapApprovalFailure(error)
  }
}

export async function claimDevelopmentRunCancellationApprovalRequest(requestId, options = {}) {
  const normalizedRequestId = normalizeCancellationRequestId(requestId)
  const paths = storePaths(options)
  const pendingPath = requestFilePath(paths.pendingDir, normalizedRequestId)
  const claimedPath = join(
    paths.claimedDir,
    `${normalizedRequestId}.${process.pid}.${randomBytes(8).toString("hex")}.json`
  )
  const now = nowDate(options)

  if (!await requireExistingStore(paths)) {
    throw approvalError(
      "REQUEST_NOT_FOUND",
      "Development run cancellation request was not found, expired, or already consumed."
    )
  }

  if (await hasClaimedRequest(paths, normalizedRequestId)) {
    throw approvalError(
      "REQUEST_ALREADY_CONSUMED",
      "Development run cancellation request was already consumed."
    )
  }

  await assertTrustedRequestFileLeaf(pendingPath)

  try {
    await rename(pendingPath, claimedPath)
    await syncDirectory(paths.pendingDir)
    await syncDirectory(paths.claimedDir)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw approvalError(
        await hasClaimedRequest(paths, normalizedRequestId) ? "REQUEST_ALREADY_CONSUMED" : "REQUEST_NOT_FOUND",
        "Development run cancellation request was not found, expired, or already consumed."
      )
    }

    throw approvalError(
      "STORE_UNAVAILABLE",
      "Development run cancellation approval store is unavailable."
    )
  }

  const record = await readTrustedRequestFile(claimedPath, normalizedRequestId)

  if (isExpired(record, now)) {
    throw approvalError(
      "REQUEST_EXPIRED",
      "Development run cancellation request was not found, expired, or already consumed."
    )
  }

  return record
}

export async function confirmDevelopmentRunCancellationApproval(requestId, options = {}) {
  let record

  try {
    record = await claimDevelopmentRunCancellationApprovalRequest(requestId, options)
  } catch (error) {
    return mapApprovalFailure(error)
  }

  if (record.projectId === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id) {
    return makeDevelopmentRunCancellationFailure("project_out_of_scope")
  }

  return executeDevelopmentRunCancellation({
    runId: record.runId,
    expectedVersion: record.expectedVersion,
    projectId: record.projectId,
    beforeStatus: record.beforeStatus
  }, options)
}

export async function handlePpoDevelopmentCancelCommand(runId, options = {}) {
  let result

  try {
    result = await stageDevelopmentRunCancellationApproval(runId, options)
  } catch {
    result = makeDevelopmentRunCancellationFailure("cancellation_unavailable")
  }

  return {
    ok: result.ok === true,
    code: result.code,
    output: formatDevelopmentRunCancellation(result)
  }
}

export async function handlePpoDevelopmentCancelConfirmCommand(requestId, options = {}) {
  let result

  try {
    result = await confirmDevelopmentRunCancellationApproval(requestId, options)
  } catch {
    result = makeDevelopmentRunCancellationFailure("cancellation_unavailable")
  }

  return {
    ok: result.ok === true,
    code: result.code,
    output: formatDevelopmentRunCancellation(result)
  }
}

export function developmentRunCancellationApprovalPolicy() {
  return {
    id: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID,
    hash: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH,
    cancellationPolicy: {
      id: PHASE_6P_RUN_CANCELLATION_POLICY_ID,
      hash: PHASE_6P_RUN_CANCELLATION_POLICY_HASH
    },
    ttlMs: DEVELOPMENT_RUN_CANCELLATION_APPROVAL_TTL_MS,
    requestIdPattern: CANCELLATION_REQUEST_ID_PATTERN.source,
    reason: DEVELOPMENT_RUN_CANCELLATION_REASON
  }
}
