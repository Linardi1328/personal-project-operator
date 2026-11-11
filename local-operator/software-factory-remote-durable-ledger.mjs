import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, lstat, realpath, open } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import {
  remotePayloadDigest,
  verifyRemoteEnvelope
} from "./software-factory-remote-contract.mjs"

// Offline Phase 1C proof only: this module never executes tools, connects to
// hosts, grants release authority, or modifies PPO's canonical run records.
export const SOFTWARE_FACTORY_REMOTE_DURABLE_LEDGER_ID = "phase-1c-offline-durable-ledger"
const FENCE_VERSION = 1
const MAX_RECORD_BYTES = 16 * 1024
const RUN_ID = /^[A-Za-z0-9_-]{43}$/u
const HASH = /^[a-f0-9]{64}$/u

export class OfflineClaimLedgerError extends Error {
  constructor(code) {
    super(`Offline durable claim ledger rejected: ${code}.`)
    this.name = "OfflineClaimLedgerError"
    this.code = code
  }
}

function reject(code) { throw new OfflineClaimLedgerError(code) }
function digest(value) { return createHash("sha256").update(value).digest("hex") }
function directoryName(runId, expectedVersion) {
  if (!RUN_ID.test(runId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 10000000) reject("LEDGER_ID_INVALID")
  return `run-${digest(`${runId}:${expectedVersion}`)}`
}
function clock(now) {
  const value = now()
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(timestamp)) reject("LEDGER_CLOCK_INVALID")
  return timestamp
}
function fresh(now, from, to) {
  const timestamp = clock(now)
  if (timestamp < Date.parse(from) - 60000 || timestamp >= Date.parse(to)) reject("LEDGER_EXPIRED")
}
function matchCanonicalRun(run, p) {
  return run?.runId === p.runId && run?.version === p.expectedVersion &&
    run?.status === "implementation_in_progress" && run?.project?.id === p.projectId &&
    run?.branch === p.branch && run?.baseSha === p.baseSha && run?.headSha === p.headSha
}

/** Require a private canonical directory; never follow a symlink to state. */
async function assertDirectory(path) {
  const info = await lstat(path).catch(() => reject("LEDGER_STORAGE_UNAVAILABLE"))
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await realpath(path) !== path) reject("LEDGER_STORAGE_UNSAFE")
}
/** Commit an immutable record with O_EXCL, fsync its bytes and directory, never replace it. */
async function syncDirectory(directory) {
  let dirHandle
  try {
    dirHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    await dirHandle.sync()
  } catch {
    reject("LEDGER_STORAGE_UNAVAILABLE")
  } finally {
    await dirHandle?.close().catch(() => {})
  }
}

async function writeOnce(directory, name, record, conflictCode) {
  const encoded = Buffer.from(JSON.stringify(record), "utf8")
  if (encoded.length > MAX_RECORD_BYTES) reject("LEDGER_RECORD_OVERSIZED")
  let handle
  try {
    handle = await open(join(directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (error?.code === "EEXIST") reject(conflictCode)
    reject("LEDGER_STORAGE_UNAVAILABLE")
  }
  try {
    await handle.writeFile(encoded)
    await handle.sync()
  } catch {
    reject("LEDGER_STORAGE_UNAVAILABLE") // Incomplete file is intentionally retained as a tombstone.
  } finally {
    await handle.close().catch(() => {})
  }
  await syncDirectory(directory)
}
/** Reject symlinks, non-files, malformed records, oversized records and partial writes. */
async function readRecord(directory, name, missingCode = "LEDGER_INCOMPLETE") {
  let handle
  try {
    handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error?.code === "ENOENT") reject(missingCode)
    reject("LEDGER_STORAGE_UNSAFE")
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size === 0 || info.size > MAX_RECORD_BYTES) reject("LEDGER_RECORD_INVALID")
    const content = await handle.readFile({ encoding: "utf8" })
    try { return JSON.parse(content) } catch { reject("LEDGER_RECORD_INVALID") }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Create a permanent, single-claim reservation ledger for synthetic testing only. */
export function createOfflineDurableClaimLedger(config) {
  if (!config || config.mode !== "offline-durable-proof-only" ||
      typeof config.storeDir !== "string" || !isAbsolute(config.storeDir) ||
      resolve(config.storeDir) !== config.storeDir ||
      typeof config.now !== "function" || typeof config.readRun !== "function" ||
      typeof config.resolveRole !== "function" || !config.coordinatorPublicKey ||
      !Array.isArray(config.approvedProjects) || !config.workerRegistry ||
      typeof config.workerRegistry !== "object") reject("LEDGER_CONFIGURATION_INVALID")

  const root = config.storeDir
  const indexes = join(root, "indexes")
  const approvedProjects = new Set(config.approvedProjects)

  async function storage() {
    await assertDirectory(root)
    let created = false
    try { await mkdir(indexes, { mode: 0o700 }); created = true } catch (e) {
      if (e?.code !== "EEXIST") reject("LEDGER_STORAGE_UNAVAILABLE")
    }
    await assertDirectory(indexes)
    if (created) await syncDirectory(root)
  }
  async function current(p) {
    let run
    try { run = await config.readRun(p.runId) } catch { reject("LEDGER_RUN_UNAVAILABLE") }
    if (!matchCanonicalRun(run, p)) reject("LEDGER_RUN_STALE")
    const role = config.resolveRole(run)
    if (role !== p.capability || !["implementation.backend", "implementation.frontend"].includes(role)) reject("LEDGER_ROLE_MISMATCH")
    if (!approvedProjects.has(p.projectId)) reject("LEDGER_PROJECT_DENIED")
  }
  function wire(signed, payload) {
    // verifyRemoteEnvelope has already rejected accessors and forged signatures.
    return { signerId: signed.signerId, payload, signature: signed.signature }
  }
  function entryPath(runId, expectedVersion) {
    return join(root, directoryName(runId, expectedVersion))
  }
  async function entry(p) {
    const dir = entryPath(p.runId, p.expectedVersion)
    await assertDirectory(dir)
    const completed = await readRecord(dir, "complete.json")
    const signed = await readRecord(dir, "request.json")
    let original
    try { original = verifyRemoteEnvelope(signed, "ppo-control-plane", config.coordinatorPublicKey) } catch { reject("LEDGER_RECORD_INVALID") }
    const hash = remotePayloadDigest(original)
    if (completed?.v !== FENCE_VERSION || completed.requestHash !== hash ||
        completed.runId !== original.runId || completed.expectedVersion !== original.expectedVersion ||
        original.runId !== p.runId || original.expectedVersion !== p.expectedVersion) reject("LEDGER_RECORD_INVALID")
    return { dir, signed, payload: original, requestHash: hash }
  }

  return Object.freeze({
    /** Atomically reserve one canonical run version; partial failures permanently block reuse. */
    async reserve(signed) {
      const p = verifyRemoteEnvelope(signed, "ppo-control-plane", config.coordinatorPublicKey)
      const requestWire = wire(signed, p)
      if (p.kind !== "dispatch-request") reject("LEDGER_REQUEST_INVALID")
      await storage()
      fresh(config.now, p.issuedAt, p.expiresAt)
      await current(p)
      const dir = entryPath(p.runId, p.expectedVersion)
      try { await mkdir(dir, { mode: 0o700 }) } catch (error) {
        if (error?.code === "EEXIST") reject("LEDGER_RUN_RESERVED")
        reject("LEDGER_STORAGE_UNAVAILABLE")
      }
      // The directory itself is the atomic, never-reused run-version fence.
      // All remaining writes are append-only; an interrupted reservation never auto-recovers.
      const requestHash = remotePayloadDigest(p)
      await writeOnce(dir, "request.json", requestWire, "LEDGER_RUN_RESERVED")
      for (const [kind, value] of [
        ["request", p.requestId], ["nonce", p.nonce],
        ["approval", p.approval.approvalId], ["idempotency", p.idempotencyKey]
      ]) {
        await writeOnce(indexes, `${kind}-${digest(value)}.json`,
          { v: FENCE_VERSION, runId: p.runId, expectedVersion: p.expectedVersion, requestHash }, "LEDGER_REPLAY")
      }
      await writeOnce(dir, "complete.json", { v: FENCE_VERSION, runId: p.runId,
        expectedVersion: p.expectedVersion, requestHash }, "LEDGER_RUN_RESERVED")
      return Object.freeze({ outcome: "reserved", requestHash, runId: p.runId,
        expectedVersion: p.expectedVersion, releaseAuthorized: false })
    },
    /** Persist one and only one signed worker claim; never recycle expired or incomplete claims. */
    async claim(runId, expectedVersion, signed) {
      await storage()
      const reservation = await entry({ runId, expectedVersion })
      const p = reservation.payload
      await current(p)
      fresh(config.now, p.issuedAt, p.expiresAt)
      const worker = config.workerRegistry[p.workerId]
      if (!worker || worker.online !== true) reject("LEDGER_WORKER_OFFLINE")
      if (!worker.publicKey || typeof worker.hostId !== "string") reject("LEDGER_WORKER_UNTRUSTED")
      const claim = verifyRemoteEnvelope(signed, p.workerId, worker.publicKey)
      const claimWire = wire(signed, claim)
      if (claim.kind !== "worker-claim" || claim.requestId !== p.requestId ||
          claim.requestHash !== reservation.requestHash || claim.runId !== p.runId ||
          claim.expectedVersion !== p.expectedVersion || claim.workerId !== p.workerId ||
          claim.hostId !== worker.hostId) reject("LEDGER_CLAIM_BINDING_INVALID")
      fresh(config.now, claim.claimedAt, claim.leaseExpiresAt)
      if (Date.parse(claim.claimedAt) < Date.parse(p.issuedAt) ||
          Date.parse(claim.leaseExpiresAt) > Date.parse(p.expiresAt) ||
          Date.parse(claim.leaseExpiresAt) - Date.parse(claim.claimedAt) > p.maxDurationMs) reject("LEDGER_LEASE_INVALID")
      const claimHash = remotePayloadDigest(claim)
      // A global nonce tombstone prevents reuse across different run versions.
      await writeOnce(indexes, `claim-nonce-${digest(claim.claimNonce)}.json`,
        { v: FENCE_VERSION, runId, expectedVersion, claimHash }, "LEDGER_REPLAY")
      await writeOnce(reservation.dir, "claim.json", claimWire, "LEDGER_ALREADY_CLAIMED")
      return Object.freeze({ outcome: "claimed", runId, expectedVersion, claimHash,
        releaseAuthorized: false })
    },
    /** Read-only fence inspection: never grants permission to run tools or release a build. */
    async checkFence(runId, expectedVersion, claimHash) {
      if (!HASH.test(claimHash)) reject("LEDGER_CLAIM_HASH_INVALID")
      await storage()
      const reservation = await entry({ runId, expectedVersion })
      await current(reservation.payload)
      const signed = await readRecord(reservation.dir, "claim.json", "LEDGER_CLAIM_MISSING")
      const p = reservation.payload
      const worker = config.workerRegistry[p.workerId]
      if (!worker?.publicKey || worker.online !== true || worker.hostId !== signed.payload?.hostId) reject("LEDGER_WORKER_UNTRUSTED")
      let claim
      try { claim = verifyRemoteEnvelope(signed, p.workerId, worker.publicKey) } catch { reject("LEDGER_RECORD_INVALID") }
      if (claim.kind !== "worker-claim" || claim.requestId !== p.requestId ||
          claim.requestHash !== reservation.requestHash || claim.runId !== runId ||
          claim.expectedVersion !== expectedVersion || claim.workerId !== p.workerId ||
          remotePayloadDigest(claim) !== claimHash) reject("LEDGER_FENCE_REJECTED")
      fresh(config.now, claim.claimedAt, claim.leaseExpiresAt)
      return Object.freeze({ current: true, runId, expectedVersion, claimHash,
        releaseAuthorized: false, canExecute: false })
    },
    /** Minimal non-authoritative diagnostic state; malformed records fail closed. */
    async inspect(runId, expectedVersion) {
      await storage()
      const reservation = await entry({ runId, expectedVersion })
      return Object.freeze({ reserved: true, requestHash: reservation.requestHash,
        runId, expectedVersion, releaseAuthorized: false })
    }
  })
}