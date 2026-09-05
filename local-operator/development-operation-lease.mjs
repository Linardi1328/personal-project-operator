import { randomBytes } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import { DEVELOPMENT_RUN_ID_PATTERN } from "./development-run-state.mjs"

export const DEVELOPMENT_OPERATION_LEASE_SCHEMA_VERSION = 1
export const DEVELOPMENT_OPERATION_LEASE_DIR = "development-runs/operation-leases"
export const MAX_DEVELOPMENT_OPERATION_LEASE_AGE_MS = 90 * 60 * 1000

const phasePattern = /^6[DEF]$/u
const actionPattern = /^[a-z][a-z0-9-]{0,79}$/u
const shaPattern = /^[a-f0-9]{40}$/u
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u

export class DevelopmentOperationLeaseError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "DevelopmentOperationLeaseError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function leaseError(code, safeMessage) {
  return new DevelopmentOperationLeaseError(code, safeMessage)
}

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  return typeof configured === "string" && configured.trim()
    ? configured
    : DEFAULT_PPO_WRITE_DATA_DIR
}

function leasePaths(runId, options = {}) {
  if (typeof runId !== "string" || !DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    throw leaseError("OPERATION_LEASE_INVALID", "Development operation lease input is invalid.")
  }

  const leaseDir = join(resolveWriteDataDir(options), DEVELOPMENT_OPERATION_LEASE_DIR)

  return {
    leaseDir,
    leasePath: join(leaseDir, `${runId}.json`)
  }
}

function nowDate(options = {}) {
  const value = options.now instanceof Function ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw leaseError("OPERATION_LEASE_CLOCK_INVALID", "Development operation lease clock is invalid.")
  }

  return date
}

function normalizeLease(value, runId) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []
  const expectedKeys = [
    "action",
    "attempt",
    "headSha",
    "ownerPid",
    "phase",
    "runId",
    "schemaVersion",
    "startedAt",
    "token"
  ].sort()

  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== DEVELOPMENT_OPERATION_LEASE_SCHEMA_VERSION ||
    value.runId !== runId ||
    !phasePattern.test(value.phase) ||
    !actionPattern.test(value.action) ||
    !Number.isInteger(value.attempt) ||
    value.attempt <= 0 ||
    !shaPattern.test(value.headSha) ||
    !Number.isInteger(value.ownerPid) ||
    value.ownerPid < 0 ||
    !tokenPattern.test(value.token) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    new Date(Date.parse(value.startedAt)).toISOString() !== value.startedAt
  ) {
    throw leaseError("OPERATION_LEASE_INVALID", "Stored development operation lease is invalid.")
  }

  return value
}

async function readLeaseIfPresent(runId, options = {}) {
  const { leasePath } = leasePaths(runId, options)
  let info

  try {
    info = await lstat(leasePath)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  }

  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
    throw leaseError("OPERATION_LEASE_INVALID", "Stored development operation lease is invalid.")
  }

  let handle
  let payload

  try {
    handle = await open(leasePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    payload = await handle.readFile("utf8")
  } catch {
    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  } finally {
    await handle?.close()
  }

  if (Buffer.byteLength(payload, "utf8") > 2048) {
    throw leaseError("OPERATION_LEASE_INVALID", "Stored development operation lease is invalid.")
  }

  try {
    return normalizeLease(JSON.parse(payload), runId)
  } catch (error) {
    if (error instanceof DevelopmentOperationLeaseError) {
      throw error
    }

    throw leaseError("OPERATION_LEASE_INVALID", "Stored development operation lease is invalid.")
  }
}

function ownerProcessActive(pid, options = {}) {
  if (pid === 0) {
    return false
  }

  const probe = options.processProbe || ((ownerPid) => {
    try {
      process.kill(ownerPid, 0)
      return true
    } catch (error) {
      return error?.code === "EPERM"
    }
  })

  return probe(pid) === true
}

export async function inspectDevelopmentOperationLease(runId, options = {}) {
  const lease = await readLeaseIfPresent(runId, options)

  if (!lease) {
    return { exists: false, active: false, stale: false, lease: null }
  }

  const ageMs = nowDate(options).getTime() - Date.parse(lease.startedAt)
  const withinMaximumAge = ageMs >= 0 && ageMs < MAX_DEVELOPMENT_OPERATION_LEASE_AGE_MS
  const active = withinMaximumAge && ownerProcessActive(lease.ownerPid, options)

  return {
    exists: true,
    active,
    stale: !active,
    ageMs,
    lease
  }
}

async function acquireLeaseInternal(input, options) {
  const runId = input?.runId
  const { leaseDir, leasePath } = leasePaths(runId, options)
  const lease = normalizeLease({
    schemaVersion: DEVELOPMENT_OPERATION_LEASE_SCHEMA_VERSION,
    runId,
    phase: input?.phase,
    action: input?.action,
    attempt: input?.attempt,
    headSha: input?.headSha,
    ownerPid: process.pid,
    token: randomBytes(32).toString("base64url"),
    startedAt: nowDate(options).toISOString()
  }, runId)

  let directoryInfo

  try {
    await mkdir(leaseDir, { recursive: true, mode: 0o700 })
    directoryInfo = await lstat(leaseDir)
  } catch {
    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  }

  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  }

  try {
    await chmod(leaseDir, 0o700)
  } catch {
    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  }

  let handle

  try {
    handle = await open(
      leasePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600
    )
    await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8")
    await handle.sync()
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw leaseError("OPERATION_LEASE_HELD", "Another development operation owns this run.")
    }

    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  } finally {
    await handle?.close()
  }

  return lease
}

export async function acquireDevelopmentOperationLease(input, options = {}) {
  return await acquireLeaseInternal(input, options)
}

export async function releaseDevelopmentOperationLease(lease, options = {}) {
  const stored = await readLeaseIfPresent(lease?.runId, options)

  if (!stored) {
    return false
  }

  if (stored.token !== lease?.token) {
    throw leaseError("OPERATION_LEASE_OWNERSHIP_MISMATCH", "Development operation lease ownership changed.")
  }

  try {
    await unlink(leasePaths(stored.runId, options).leasePath)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false
    }

    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  }
}

export async function relinquishDevelopmentOperationLease(lease, options = {}) {
  const stored = await readLeaseIfPresent(lease?.runId, options)

  if (!stored || stored.token !== lease?.token) {
    throw leaseError("OPERATION_LEASE_OWNERSHIP_MISMATCH", "Development operation lease ownership changed.")
  }

  const relinquished = {
    ...stored,
    ownerPid: 0
  }
  const { leasePath } = leasePaths(stored.runId, options)
  const tempPath = `${leasePath}.${stored.token}.tmp`
  let handle

  try {
    handle = await open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600
    )
    await handle.writeFile(`${JSON.stringify(relinquished)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, leasePath)
  } catch {
    await unlink(tempPath).catch(() => {})
    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  } finally {
    await handle?.close()
  }

  return relinquished
}

export async function discardStaleDevelopmentOperationLease(runId, expected, options = {}) {
  const inspected = await inspectDevelopmentOperationLease(runId, options)

  if (!inspected.exists) {
    return false
  }

  if (
    inspected.active ||
    inspected.lease.phase !== expected?.phase ||
    inspected.lease.attempt !== expected?.attempt ||
    inspected.lease.headSha !== expected?.headSha
  ) {
    throw leaseError("OPERATION_LEASE_NOT_STALE", "Development operation lease is active or does not match the recovery target.")
  }

  try {
    await unlink(leasePaths(runId, options).leasePath)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false
    }

    throw leaseError("OPERATION_LEASE_UNAVAILABLE", "Development operation lease store is unavailable.")
  }
}
