import { createHash } from "node:crypto"

// RIC-157 Phase 1G-A: transactional contract only. The caller MUST supply a
// trusted linearizable durable driver; this module does not provide a database,
// an OS lock, network transport, host enrollment, agent or execution gateway.
export const OFFLINE_TRANSACTION_FENCE_ID = "ppo-transaction-fence-contract-v1"
const BOUNDARY_FIELDS = Object.freeze([
  "hostId", "workerId", "hostEpoch", "publicKey", "runId",
  "expectedVersion", "requestHash", "claimHash", "projectId",
  "capability", "branch", "baseSha", "headSha", "actionId",
  "actionType", "actionPath", "issuedAt", "expiresAt",
  "requestExpiresAt", "requiredCatalogInvalidCount", "maxActiveProjects"
])
const LABEL = /^[a-z][a-z0-9-]{0,63}$/u
const RUN_ID = /^[A-Za-z0-9_-]{43}$/u
const SHA = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u
const NONCE = /^[a-f0-9]{32}$/u
const PATH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!\.)(?!.*\/\.\/)[A-Za-z0-9._/-]{1,120}$/u
const ACTIONS = new Set(["workspace.read", "workspace.write", "tests.local"])
const ROLE_WORKER = Object.freeze({
  "implementation.backend": "codex",
  "implementation.frontend": "antigravity"
})

export class OfflineTransactionFenceError extends Error {
  constructor(code) {
    super("Offline transaction fence rejected: " + code + ".")
    this.name = "OfflineTransactionFenceError"
    this.code = code
  }
}
function fail(code) { throw new OfflineTransactionFenceError(code) }
function matches(value, re) { return typeof value === "string" && re.test(value) }
function timestamp(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== "string") return NaN
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN
}
function pathAllowed(paths, path) {
  return Array.isArray(paths) && paths.length > 0 && paths.length <= 8 &&
    paths.every(p => matches(p, PATH)) &&
    paths.some(prefix => prefix.endsWith("/")
      ? path.startsWith(prefix)
      : path === prefix || path.startsWith(prefix + "/"))
}
/** Fingerprint only a pinned Ed25519 public key; do not serialize a key object. */
function fingerprint(publicKey) {
  if (publicKey?.asymmetricKeyType !== "ed25519" || publicKey.type !== "public") {
    fail("TX_BOUNDARY_INVALID")
  }
  try {
    return createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")
  } catch { fail("TX_BOUNDARY_INVALID") }
}

/** Snapshot the already-verified Phase 1F callback arguments without getters. */
function boundarySnapshot(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== BOUNDARY_FIELDS.length ||
      BOUNDARY_FIELDS.some(k => !Object.hasOwn(raw, k) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, k) ?? {}, "value"))) {
    fail("TX_BOUNDARY_INVALID")
  }
  const b = Object.fromEntries(BOUNDARY_FIELDS.map(k =>
    [k, Object.getOwnPropertyDescriptor(raw, k).value]))
  if (!matches(b.hostId, LABEL) || !matches(b.workerId, LABEL) ||
      !Number.isSafeInteger(b.hostEpoch) || b.hostEpoch < 1 ||
      !matches(b.runId, RUN_ID) ||
      !Number.isSafeInteger(b.expectedVersion) || b.expectedVersion < 1 ||
      b.expectedVersion > 10000000 ||
      !matches(b.requestHash, HASH) || !matches(b.claimHash, HASH) ||
      !matches(b.projectId, LABEL) ||
      ROLE_WORKER[b.capability] !== b.workerId ||
      typeof b.capability !== "string" || !Object.hasOwn(ROLE_WORKER, b.capability) ||
      typeof b.branch !== "string" || b.branch.length > 160 ||
      !matches(b.baseSha, SHA) || !matches(b.headSha, SHA) ||
      !matches(b.actionId, NONCE) || !ACTIONS.has(b.actionType) ||
      !matches(b.actionPath, PATH) ||
      !Number.isFinite(timestamp(b.issuedAt)) ||
      !Number.isFinite(timestamp(b.expiresAt)) ||
      !Number.isFinite(timestamp(b.requestExpiresAt)) ||
      timestamp(b.expiresAt) <= timestamp(b.issuedAt) ||
      timestamp(b.expiresAt) > timestamp(b.requestExpiresAt) ||
      b.requiredCatalogInvalidCount !== 0 || b.maxActiveProjects !== 2) {
    fail("TX_BOUNDARY_INVALID")
  }
  const hostKeyFingerprint = fingerprint(b.publicKey)
  // Do not retain a mutable object from the caller except the Ed25519 key,
  // which is used only to derive the fixed fingerprint above.
  const { publicKey: _discard, ...fields } = b
  return Object.freeze({ ...fields, hostKeyFingerprint })
}
function requireDriver(tx) {
  for (const name of [
    "now", "readHostForUpdate", "readClaimForUpdate",
    "readRequestForUpdate", "readRunForUpdate",
    "readAdmissionForUpdate", "tryConsumeOnce"
  ]) {
    if (typeof tx?.[name] !== "function") fail("TX_DRIVER_INVALID")
  }
}

/**
 * Create a callback for Phase 1F's consumeActionFence seam.
 *
 * The supplied transact(callback) MUST be a single durable, linearizable
 * transaction that holds locks on host, claim, canonical PPO run, request,
 * catalog/lane admission and nonce state through COMMIT. The final true must
 * mean commit is acknowledged. This cannot be proven by passing a callback.
 *
 * In-memory test transactions are only executable specifications, not
 * production authorization. A false/ambiguous/crashed transaction never
 * grants an action, and no caller may blindly replay the same action.
 */
export function createOfflineTransactionFenceAdapter(config) {
  if (!config || config.mode !== "offline-transaction-contract-only" ||
      typeof config.transact !== "function") fail("TX_CONFIGURATION_INVALID")
  const transact = config.transact
  return async function consumeActionFence(input) {
    const b = boundarySnapshot(input)
    let outcome
    try {
      outcome = await transact(async tx => {
        requireDriver(tx)
        const now = timestamp(await tx.now())
        if (!Number.isFinite(now) || now < timestamp(b.issuedAt) ||
            now >= timestamp(b.expiresAt) ||
            now >= timestamp(b.requestExpiresAt)) fail("TX_EXPIRED")

        const host = await tx.readHostForUpdate(b.hostId)
        if (host?.status !== "active" || host.hostId !== b.hostId ||
            host.workerId !== b.workerId ||
            host.hostEpoch !== b.hostEpoch ||
            host.claimEpoch !== b.hostEpoch ||
            host.claimHash !== b.claimHash ||
            host.keyFingerprint !== b.hostKeyFingerprint) fail("TX_HOST_STALE")

        const claim = await tx.readClaimForUpdate(b.claimHash)
        if (claim?.state !== "claimed" || claim.claimHash !== b.claimHash ||
            claim.requestHash !== b.requestHash || claim.runId !== b.runId ||
            claim.expectedVersion !== b.expectedVersion ||
            claim.hostId !== b.hostId || claim.workerId !== b.workerId ||
            !Number.isFinite(timestamp(claim.claimedAt)) ||
            !Number.isFinite(timestamp(claim.leaseExpiresAt)) ||
            timestamp(claim.claimedAt) > now ||
            now >= timestamp(claim.leaseExpiresAt)) fail("TX_CLAIM_STALE")

        const request = await tx.readRequestForUpdate(b.requestHash)
        if (request?.requestHash !== b.requestHash ||
            request.runId !== b.runId ||
            request.expectedVersion !== b.expectedVersion ||
            request.projectId !== b.projectId ||
            request.workerId !== b.workerId ||
            request.capability !== b.capability ||
            request.branch !== b.branch || request.baseSha !== b.baseSha ||
            request.headSha !== b.headSha ||
            timestamp(request.expiresAt) !== timestamp(b.requestExpiresAt) ||
            now >= timestamp(request.expiresAt) ||
            !Array.isArray(request.permits) ||
            !request.permits.includes(b.actionType) ||
            !pathAllowed(request.allowedPaths, b.actionPath)) fail("TX_SCOPE_DENIED")

        const run = await tx.readRunForUpdate(b.runId)
        if (run?.runId !== b.runId || run.version !== b.expectedVersion ||
            run.status !== "implementation_in_progress" ||
            run.project?.id !== b.projectId || run.branch !== b.branch ||
            run.baseSha !== b.baseSha || run.headSha !== b.headSha) {
          fail("TX_RUN_STALE")
        }

        const admission = await tx.readAdmissionForUpdate(b.projectId)
        const active = admission?.activeProjects
        if (admission?.valid !== true ||
            admission.invalidCount !== b.requiredCatalogInvalidCount ||
            !Array.isArray(active) || active.length > b.maxActiveProjects ||
            active.some(id => !matches(id, LABEL)) ||
            new Set(active).size !== active.length ||
            (active.length === b.maxActiveProjects &&
              !active.includes(b.projectId))) fail("TX_ADMISSION_BLOCKED")

        // This must be an INSERT with a unique constraint or equivalent
        // database-enforced single-use CAS, performed in THIS transaction.
        const consumed = await tx.tryConsumeOnce(Object.freeze({
          hostId: b.hostId, actionId: b.actionId,
          requestHash: b.requestHash, claimHash: b.claimHash,
          runId: b.runId, expectedVersion: b.expectedVersion,
          hostEpoch: b.hostEpoch
        }))
        if (consumed !== true) fail("TX_REPLAY_OR_AMBIGUOUS")
        return true
      })
    } catch (error) {
      if (error instanceof OfflineTransactionFenceError) throw error
      fail("TX_UNAVAILABLE_OR_AMBIGUOUS")
    }
    if (outcome !== true) fail("TX_UNAVAILABLE_OR_AMBIGUOUS")
    // Matches Phase 1F's callback signature; Phase 1F STILL returns canExecute:false.
    return true
  }
}
