import { randomUUID } from "node:crypto"
import { chmod, link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import { DEVELOPMENT_RUN_ID_PATTERN } from "./development-run-id.mjs"

export const SOFTWARE_FACTORY_MANAGER_DISPOSITION_SCHEMA_VERSION = 1
export const SOFTWARE_FACTORY_MANAGER_DISPOSITION_STORE_DIR = "software-factory-manager-dispositions"
export const SOFTWARE_FACTORY_TRANSIENT_RETRY_MS = 60 * 60 * 1000
export const SOFTWARE_FACTORY_MANAGER_PARK_OUTCOMES = Object.freeze([
  "owner_action_required",
  "release_ready",
  "blocked_capacity",
  "blocked_external"
])

const outcomeSet = new Set(SOFTWARE_FACTORY_MANAGER_PARK_OUTCOMES)
const sequencePattern = /^(\d{6})\.json$/u
const projectPattern = /^[a-z0-9][a-z0-9-]{0,79}$/u
const statusPattern = /^[a-z][a-z0-9_]{0,79}$/u
const reasonPattern = /^[a-z0-9][a-z0-9_:-]{0,119}$/u

export class SoftwareFactoryManagerDispositionError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryManagerDispositionError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function dispositionError(code, safeMessage) {
  return new SoftwareFactoryManagerDispositionError(code, safeMessage)
}

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV
  ]

  return typeof configured === "string" && configured.trim()
    ? configured
    : DEFAULT_PPO_WRITE_DATA_DIR
}

function nowDate(options = {}) {
  const value = typeof options.now === "function" ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw dispositionError(
      "FACTORY_MANAGER_CLOCK_INVALID",
      "Software factory manager clock is invalid."
    )
  }

  return date
}

function normalizeRunId(value) {
  const runId = String(value ?? "").trim()

  if (!DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_INVALID",
      "Software factory manager disposition run id is invalid."
    )
  }

  return runId
}

function normalizeRunVersion(value) {
  if (!Number.isInteger(value) || value < 0 || value > 999999) {
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_INVALID",
      "Software factory manager disposition run version is invalid."
    )
  }

  return value
}

function normalizeSafeIdentifier(value, pattern, field) {
  const normalized = String(value ?? "").trim()

  if (!pattern.test(normalized)) {
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_INVALID",
      `Software factory manager disposition ${field} is invalid.`
    )
  }

  return normalized
}

function normalizeReason(value) {
  if (value === null || value === undefined || value === "") {
    return null
  }

  return normalizeSafeIdentifier(value, reasonPattern, "reason")
}

function paths(runId, runVersion, options = {}) {
  const root = join(resolveWriteDataDir(options), SOFTWARE_FACTORY_MANAGER_DISPOSITION_STORE_DIR)
  const runRoot = join(root, normalizeRunId(runId))
  const versionRoot = join(runRoot, String(normalizeRunVersion(runVersion)).padStart(6, "0"))

  return { root, runRoot, versionRoot }
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function syncDirectory(path) {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function listSequences(runId, runVersion, options = {}) {
  const p = paths(runId, runVersion, options)
  let entries

  try {
    entries = await readdir(p.versionRoot)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_STORE_UNAVAILABLE",
      "Software factory manager disposition store is unavailable."
    )
  }

  return entries
    .filter((name) => sequencePattern.test(name))
    .map((name) => Number.parseInt(name.slice(0, 6), 10))
    .sort((a, b) => a - b)
}

function normalizeStoredDisposition(value, runId, runVersion, sequence) {
  const expectedKeys = [
    "schemaVersion",
    "sequence",
    "runId",
    "runVersion",
    "projectId",
    "status",
    "outcome",
    "reason",
    "recordedAt",
    "retryAfter"
  ].sort()
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []

  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== SOFTWARE_FACTORY_MANAGER_DISPOSITION_SCHEMA_VERSION ||
    value.sequence !== sequence ||
    value.runId !== runId ||
    value.runVersion !== runVersion ||
    !projectPattern.test(value.projectId) ||
    !statusPattern.test(value.status) ||
    !outcomeSet.has(value.outcome) ||
    !(value.reason === null || reasonPattern.test(value.reason)) ||
    !Number.isFinite(Date.parse(value.recordedAt)) ||
    new Date(Date.parse(value.recordedAt)).toISOString() !== value.recordedAt ||
    !(
      value.retryAfter === null ||
      (
        Number.isFinite(Date.parse(value.retryAfter)) &&
        new Date(Date.parse(value.retryAfter)).toISOString() === value.retryAfter
      )
    )
  ) {
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_CORRUPT",
      "Stored software factory manager disposition is invalid."
    )
  }

  return value
}

async function readSequence(runId, runVersion, sequence, options = {}) {
  const p = paths(runId, runVersion, options)
  const path = join(p.versionRoot, `${String(sequence).padStart(6, "0")}.json`)
  let raw

  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_STORE_UNAVAILABLE",
      "Software factory manager disposition store is unavailable."
    )
  }

  if (Buffer.byteLength(raw, "utf8") > 4096) {
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_CORRUPT",
      "Stored software factory manager disposition is invalid."
    )
  }

  try {
    return normalizeStoredDisposition(JSON.parse(raw), runId, runVersion, sequence)
  } catch (error) {
    if (error instanceof SoftwareFactoryManagerDispositionError) throw error
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_CORRUPT",
      "Stored software factory manager disposition is invalid."
    )
  }
}

export async function readSoftwareFactoryManagerDisposition(runId, runVersion, options = {}) {
  const normalizedRunId = normalizeRunId(runId)
  const normalizedVersion = normalizeRunVersion(runVersion)
  const sequences = await listSequences(normalizedRunId, normalizedVersion, options)

  if (sequences.length === 0) return null
  return readSequence(normalizedRunId, normalizedVersion, sequences.at(-1), options)
}

export function shouldExecuteSoftwareFactoryManagedRun(disposition, options = {}) {
  if (!disposition) {
    return { execute: true, reason: "no_disposition" }
  }

  if (
    disposition.outcome === "owner_action_required" ||
    disposition.outcome === "release_ready"
  ) {
    return {
      execute: false,
      reason: "parked_until_run_version_changes"
    }
  }

  const now = nowDate(options)
  const retryAfter = disposition.retryAfter ? Date.parse(disposition.retryAfter) : null

  if (retryAfter !== null && now.getTime() < retryAfter) {
    return {
      execute: false,
      reason: "transient_retry_not_due"
    }
  }

  return {
    execute: true,
    reason: "transient_retry_due"
  }
}

export async function recordSoftwareFactoryManagerDisposition(input, options = {}) {
  const runId = normalizeRunId(input?.runId)
  const runVersion = normalizeRunVersion(input?.runVersion)
  const projectId = normalizeSafeIdentifier(input?.projectId, projectPattern, "project")
  const status = normalizeSafeIdentifier(input?.status, statusPattern, "status")
  const outcome = String(input?.outcome ?? "").trim()
  const reason = normalizeReason(input?.reason)

  if (!outcomeSet.has(outcome)) {
    return null
  }

  const p = paths(runId, runVersion, options)
  const sequences = await listSequences(runId, runVersion, options)
  const nextSequence = (sequences.at(-1) || 0) + 1
  const recordedAt = nowDate(options)
  const retryAfter = outcome === "blocked_capacity" || outcome === "blocked_external"
    ? new Date(recordedAt.getTime() + SOFTWARE_FACTORY_TRANSIENT_RETRY_MS).toISOString()
    : null
  const record = Object.freeze({
    schemaVersion: SOFTWARE_FACTORY_MANAGER_DISPOSITION_SCHEMA_VERSION,
    sequence: nextSequence,
    runId,
    runVersion,
    projectId,
    status,
    outcome,
    reason,
    recordedAt: recordedAt.toISOString(),
    retryAfter
  })

  try {
    await ensurePrivateDir(p.versionRoot)
  } catch {
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_STORE_UNAVAILABLE",
      "Software factory manager disposition store is unavailable."
    )
  }

  const finalPath = join(p.versionRoot, `${String(nextSequence).padStart(6, "0")}.json`)
  const tempPath = join(p.versionRoot, `.pending-${randomUUID()}.json`)
  let handle
  let published = false

  try {
    handle = await open(tempPath, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await link(tempPath, finalPath)
    published = true
    const syncDirectoryImpl = options.syncDirectoryImpl || syncDirectory
    await syncDirectoryImpl(p.versionRoot)
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw dispositionError(
        "FACTORY_MANAGER_DISPOSITION_CONFLICT",
        "Software factory manager disposition changed concurrently; reload before retrying."
      )
    }

    if (published) {
      const ambiguous = dispositionError(
        "FACTORY_MANAGER_DISPOSITION_DURABILITY_AMBIGUOUS",
        "Software factory manager disposition may already be committed; reload before retrying."
      )
      ambiguous.stateCommitted = true
      throw ambiguous
    }

    if (error instanceof SoftwareFactoryManagerDispositionError) throw error
    throw dispositionError(
      "FACTORY_MANAGER_DISPOSITION_STORE_UNAVAILABLE",
      "Software factory manager disposition store is unavailable."
    )
  } finally {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
  }

  return record
}
