import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { link, mkdir, lstat, realpath, open, unlink } from "node:fs/promises"
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

/** Raise a stable error code without exposing raw filesystem or run-state data. */
function reject(code) { throw new OfflineClaimLedgerError(code) }
/** Compute a path-safe key from bounded canonical identifiers. */
function digest(value) { return createHash("sha256").update(value).digest("hex") }
/** Map an exact canonical run version to its permanently reserved storage slot. */
function directoryName(runId, expectedVersion) {
  if (!RUN_ID.test(runId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 10000000) reject("LEDGER_ID_INVALID")
  return `run-${digest(`${runId}:${expectedVersion}`)}`
}
/** Read and validate the injected, testable clock. */
function clock(now) {
  const value = now()
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(timestamp)) reject("LEDGER_CLOCK_INVALID")
  return timestamp
}
/** Reject expired or not-yet-issued envelopes using a bounded skew allowance. */
function fresh(now, from, to) {
  const timestamp = clock(now)
  if (timestamp < Date.parse(from) - 60000 || timestamp >= Date.parse(to)) reject("LEDGER_EXPIRED")
}
/** Compare the exact PPO canonical role, state, Git refs and version binding. */
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
/** Sync directory entries after creation, publication and tombstone transitions. */
async function syncDirectory(directory) {
  let dirHandle
  try {
    dirHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    await dirHandle.sync()
  } catch { reject("LEDGER_STORAGE_UNAVAILABLE") }
  finally { await dirHandle?.close().catch(() => {}) }
}
/** Publish a synced immutable record only after a durable, non-reusable pending tombstone exists. */
async function writeOnce(directory, name, record, conflictCode) {
  const encoded = Buffer.from(JSON.stringify(record), "utf8")
  if (encoded.length > MAX_RECORD_BYTES) reject("LEDGER_RECORD_OVERSIZED")
  const pending = join(directory, `${name}.pending`)
  const destination = join(directory, name)
  const temporary = join(directory, `${name}.payload-${randomBytes(12).toString("hex")}`)
  // A completed prior record must not be degraded into a stale pending state
  // by a duplicate operation. The O_EXCL pending and link still handle races.
  const existing = await lstat(destination).catch(e => {
    if (e?.code === "ENOENT") return null
    reject("LEDGER_STORAGE_UNSAFE")
  })
  if (existing) reject(conflictCode)

  // The tombstone must be synced first: a crash before publish cannot allow a
  // second claim, even if the caller retries with a new nonce after restart.
  let pendingHandle
  try {
    pendingHandle = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await pendingHandle.sync()
  } catch (error) {
    if (error?.code === "EEXIST") reject(conflictCode)
    reject("LEDGER_STORAGE_UNAVAILABLE")
  } finally {
    await pendingHandle?.close().catch(() => {})
  }
  await syncDirectory(directory)

  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(encoded)
    await handle.sync()
  } catch {
    reject("LEDGER_STORAGE_UNAVAILABLE")
  } finally {
    await handle?.close().catch(() => {})
  }

  try {
    // Hard-link creates the public name atomically and exclusively, but only
    // after the payload bytes have been synced. This cannot replace a record.
    await link(temporary, destination)
    await syncDirectory(directory)
    // Readers reject the public name while pending exists. Clear that fence
    // only after the committed entry is synced; retain tombstones on failures.
    await unlink(temporary)
    await unlink(pending)
    await syncDirectory(directory)
  } catch (error) {
    if (error?.code === "EEXIST") reject(conflictCode)
    reject("LEDGER_STORAGE_UNAVAILABLE")
  }
}
/** Reject symlinks, non-files, malformed records, oversized records and partial writes. */
async function readRecord(directory, name, missingCode = "LEDGER_INCOMPLETE") {
  const pending = await lstat(join(directory, `${name}.pending`)).catch(e => {
    if (e?.code === "ENOENT") return null
    reject("LEDGER_STORAGE_UNSAFE")
  })
  if (pending) reject("LEDGER_INCOMPLETE")
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
    let parsed
    try { parsed = JSON.parse(content) } catch { reject("LEDGER_RECORD_INVALID") }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) reject("LEDGER_RECORD_INVALID")
    return parsed
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

  /** Verify the private local root and its durable replay-index directory. */
  async function storage() {
    await assertDirectory(root)
    try { await mkdir(indexes, { mode: 0o700 }) } catch (e) {
      if (e?.code !== "EEXIST") reject("LEDGER_STORAGE_UNAVAILABLE")
    }
    await assertDirectory(indexes)
    await syncDirectory(root) // Also repairs an index mkdir that crashed before its parent fsync.
  }
  /** Recheck the trusted PPO canonical run before every persisted transition. */
  async function current(p) {
    let run
    try { run = await config.readRun(p.runId) } catch { reject("LEDGER_RUN_UNAVAILABLE") }
    if (!matchCanonicalRun(run, p)) reject("LEDGER_RUN_STALE")
    const role = config.resolveRole(run)
    if (role !== p.capability || !["implementation.backend", "implementation.frontend"].includes(role)) reject("LEDGER_ROLE_MISMATCH")
    if (!approvedProjects.has(p.projectId)) reject("LEDGER_PROJECT_DENIED")
  }
  /** Preserve the verified immutable payload with its original signing identity. */
  function wire(signed, payload) {
    // verifyRemoteEnvelope has already rejected accessors and forged signatures.
    return { signerId: signed.signerId, payload, signature: signed.signature }
  }
  /** Derive the unique append-only directory for one run version. */
  function entryPath(runId, expectedVersion) {
    return join(root, directoryName(runId, expectedVersion))
  }
  /** Re-read a completed, signed reservation and its exact authenticated digest. */
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
      await syncDirectory(root) // Persist the new directory entry before acknowledging any reservation.
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