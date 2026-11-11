import { sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import { createOfflineDurableClaimLedger } from "./software-factory-remote-durable-ledger.mjs"
import { remotePayloadDigest, verifyRemoteEnvelope } from "./software-factory-remote-contract.mjs"

// RIC-153 is a synthetic, non-executing contract. No transport, commands,
// host registration, filesystem action, agent invocation or production gate.
export const OFFLINE_HOST_ACTION_FENCE_ID = "ppo-host-action-fence-proof-v1"
const FIELDS = Object.freeze([
  "version", "hostId", "hostEpoch", "workerId", "requestHash", "claimHash",
  "runId", "expectedVersion", "actionId", "actionType", "actionPath",
  "issuedAt", "expiresAt"
])
const LABEL = /^[a-z][a-z0-9-]{0,63}$/u
const ID = /^[A-Za-z0-9_-]{43}$/u
const HASH = /^[a-f0-9]{64}$/u
const NONCE = /^[a-f0-9]{32}$/u
const PATH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!\.)(?!.*\/\.\/)[A-Za-z0-9._/-]{1,120}$/u
const ACTIONS = new Set(["workspace.read", "workspace.write", "tests.local"])
const MAX_PROOF_MS = 60000
const MAX_PROOF_BYTES = 2048

export class OfflineHostActionFenceError extends Error {
  constructor(code) {
    super("Offline host action fence rejected: " + code + ".")
    this.name = "OfflineHostActionFenceError"
    this.code = code
  }
}

/** Fail with metadata-only codes; never disclose keys, paths or provider data. */
function fail(code) { throw new OfflineHostActionFenceError(code) }

/** Validate an exact scalar-only v1 proof without invoking foreign getters. */
function snapshotProof(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== FIELDS.length ||
      FIELDS.some(key => !Object.hasOwn(raw, key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key) ?? {}, "value"))) {
    fail("FENCE_PROOF_INVALID")
  }
  const p = Object.fromEntries(FIELDS.map(key => [key, Object.getOwnPropertyDescriptor(raw, key).value]))
  if (p.version !== 1 || !LABEL.test(p.hostId ?? "") ||
      !LABEL.test(p.workerId ?? "") ||
      !Number.isSafeInteger(p.hostEpoch) || p.hostEpoch < 1 ||
      !HASH.test(p.requestHash ?? "") || !HASH.test(p.claimHash ?? "") ||
      !ID.test(p.runId ?? "") ||
      !Number.isSafeInteger(p.expectedVersion) || p.expectedVersion < 1 ||
      p.expectedVersion > 10000000 || !NONCE.test(p.actionId ?? "") ||
      !ACTIONS.has(p.actionType) || !PATH.test(p.actionPath ?? "") ||
      typeof p.issuedAt !== "string" || typeof p.expiresAt !== "string") {
    fail("FENCE_PROOF_INVALID")
  }
  for (const key of ["issuedAt", "expiresAt"]) {
    const ms = Date.parse(p[key])
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== p[key]) fail("FENCE_PROOF_INVALID")
  }
  if (Date.parse(p.expiresAt) <= Date.parse(p.issuedAt) ||
      Date.parse(p.expiresAt) - Date.parse(p.issuedAt) > MAX_PROOF_MS) {
    fail("FENCE_PROOF_INVALID")
  }
  if (Buffer.byteLength(JSON.stringify(FIELDS.map(k => p[k])), "utf8") > MAX_PROOF_BYTES) {
    fail("FENCE_PROOF_INVALID")
  }
  return Object.freeze(p)
}

/** Domain-separated, fixed-order serialization for the signed host proof. */
function message(p) {
  return Buffer.from(JSON.stringify([OFFLINE_HOST_ACTION_FENCE_ID, ...FIELDS.map(k => p[k])]), "utf8")
}

/**
 * Synthetic test helper ONLY; enrollment/transport key custody and real host
 * signing are deliberately absent from this milestone.
 */
export function signOfflineHostActionProof(payload, privateKey) {
  const p = snapshotProof(payload)
  if (privateKey?.asymmetricKeyType !== "ed25519" || privateKey.type !== "private") {
    fail("FENCE_SIGNING_KEY_INVALID")
  }
  return Object.freeze({ payload: p,
    signature: cryptoSign(null, message(p), privateKey).toString("base64url") })
}

/** Snapshot signed host input without invoking getters or trusting later mutations. */
function snapshotSignedHostProof(signed) {
  if (!signed || typeof signed !== "object" || Array.isArray(signed) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(signed)) ||
      Reflect.ownKeys(signed).length !== 2 ||
      !Object.hasOwn(signed, "payload") || !Object.hasOwn(signed, "signature") ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(signed, "payload") ?? {}, "value") ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(signed, "signature") ?? {}, "value")) {
    fail("FENCE_PROOF_INVALID")
  }
  return Object.freeze({
    payload: snapshotProof(Object.getOwnPropertyDescriptor(signed, "payload").value),
    signature: Object.getOwnPropertyDescriptor(signed, "signature").value
  })
}

/** Verify the host signature against a separately pinned, active host key. */
function verifiedHostProof(signed, publicKey) {
  const { payload: p, signature } = signed
  if (publicKey?.asymmetricKeyType !== "ed25519" || publicKey.type !== "public" ||
      typeof signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/u.test(signature) ||
      Buffer.from(signature, "base64url").toString("base64url") !== signature ||
      !cryptoVerify(null, message(p), publicKey, Buffer.from(signature, "base64url"))) {
    fail("FENCE_HOST_SIGNATURE_INVALID")
  }
  return p
}

/** Authorize only an exact reviewed path or one of its descendants. */
function permittedPath(scope, path) {
  return scope.allowedPaths.some(prefix => prefix.endsWith("/")
    ? path.startsWith(prefix)
    : path === prefix || path.startsWith(prefix + "/"))
}

/** Snapshot trusted ledger settings so user-controlled callback drift cannot swap keys. */
function trustedConfig(config) {
  if (!config || config.mode !== "offline-host-fence-proof-only" ||
      typeof config.now !== "function" ||
      typeof config.readHost !== "function" ||
      typeof config.consumeActionFence !== "function" ||
      typeof config.readCatalogAdmission !== "function" ||
      typeof config.listActiveProjects !== "function" ||
      !config.ledger || config.now !== config.ledger.now ||
      config.coordinatorPublicKey !== config.ledger.coordinatorPublicKey ||
      !Array.isArray(config.ledger.approvedProjects) ||
      !config.ledger.workerRegistry ||
      typeof config.ledger.workerRegistry !== "object") {
    fail("FENCE_CONFIGURATION_INVALID")
  }
  const workers = {}
  for (const [id, worker] of Object.entries(config.ledger.workerRegistry)) {
    if (!LABEL.test(id) || !worker || typeof worker !== "object" ||
        !LABEL.test(worker.hostId ?? "") ||
        worker.publicKey?.asymmetricKeyType !== "ed25519" ||
        worker.publicKey.type !== "public") fail("FENCE_CONFIGURATION_INVALID")
    workers[id] = Object.freeze({ hostId: worker.hostId,
      publicKey: worker.publicKey, online: worker.online === true })
  }
  const ledger = Object.freeze({ ...config.ledger,
    workerRegistry: Object.freeze(workers),
    approvedProjects: Object.freeze([...config.ledger.approvedProjects]) })
  return Object.freeze({ now: config.now, readHost: config.readHost,
    consumeActionFence: config.consumeActionFence,
    readCatalogAdmission: config.readCatalogAdmission,
    listActiveProjects: config.listActiveProjects,
    coordinatorPublicKey: config.coordinatorPublicKey, ledger })
}

/** Convert only an independently trusted host registry row to a pinned snapshot. */
function hostSnapshot(record, p) {
  if (!record || typeof record !== "object" ||
      record.hostId !== p.hostId || record.workerId !== p.workerId ||
      record.status !== "active" || record.hostEpoch !== p.hostEpoch ||
      record.publicKey?.asymmetricKeyType !== "ed25519" ||
      record.publicKey.type !== "public") fail("FENCE_HOST_UNTRUSTED")
  return Object.freeze({ hostId: record.hostId, workerId: record.workerId,
    hostEpoch: record.hostEpoch, publicKey: record.publicKey })
}

/** Require positive evidence of complete, non-corrupt synthetic admission. */
async function checkAdmission(trusted, projectId) {
  let admission, active
  try {
    admission = await trusted.readCatalogAdmission()
    active = await trusted.listActiveProjects()
  } catch { fail("FENCE_ADMISSION_UNAVAILABLE") }
  if (admission?.valid !== true || admission?.diagnostics?.invalid !== 0) {
    fail("FENCE_CATALOG_BLOCKED")
  }
  if (!Array.isArray(active) || active.length > 2 ||
      active.some(id => !LABEL.test(id)) ||
      new Set(active).size !== active.length ||
      (active.length === 2 && !active.includes(projectId))) {
    fail("FENCE_WIP_BLOCKED")
  }
}

/**
 * A diagnostic action-boundary proof, NOT permission to execute tools.
 *
 * The injected consumeActionFence MUST represent a trusted transactional CAS
 * that rechecks the host's current key/epoch and atomically consumes actionId.
 * The local tests emulate this authority; nothing here implements a durable
 * shared authority, network authentication, or an operational action gateway.
 */
export async function verifyOfflineHostActionFence(signedRequest, signedHostProof, config) {
  const trusted = trustedConfig(config)
  let request
  try {
    request = verifyRemoteEnvelope(signedRequest, "ppo-control-plane", trusted.coordinatorPublicKey)
  } catch { fail("FENCE_REQUEST_INVALID") }
  if (request.kind !== "dispatch-request") fail("FENCE_REQUEST_INVALID")

  // Pin the exact proof snapshot before any async host or ledger reads.
  // Identity is not trusted until the independently pinned key verifies it.
  const stableProof = snapshotSignedHostProof(signedHostProof)
  const p = stableProof.payload
  const requestHash = remotePayloadDigest(request)
  if (p.requestHash !== requestHash || p.runId !== request.runId ||
      p.expectedVersion !== request.expectedVersion ||
      p.workerId !== request.workerId ||
      !request.scope.permits.includes(p.actionType) ||
      !permittedPath(request.scope, p.actionPath)) {
    fail("FENCE_ACTION_SCOPE_DENIED")
  }
  const worker = trusted.ledger.workerRegistry[p.workerId]
  if (!worker || worker.online !== true || worker.hostId !== p.hostId) {
    fail("FENCE_WORKER_UNTRUSTED")
  }
  let now
  try { now = Date.parse(trusted.now()) }
  catch { fail("FENCE_CLOCK_INVALID") }
  if (!Number.isFinite(now) || Date.parse(p.issuedAt) > now ||
      now >= Date.parse(p.expiresAt) ||
      Date.parse(p.issuedAt) < Date.parse(request.issuedAt) ||
      Date.parse(p.expiresAt) > Date.parse(request.expiresAt)) {
    fail("FENCE_PROOF_EXPIRED")
  }

  let record
  try { record = await trusted.readHost(p.hostId) }
  catch { fail("FENCE_HOST_UNAVAILABLE") }
  const host = hostSnapshot(record, p)
  verifiedHostProof(stableProof, host.publicKey)

  await checkAdmission(trusted, request.projectId)
  // The merged ledger independently checks worker claim signature, host label,
  // canonical run version/SHA, request digest and unexpired worker lease.
  const ledger = createOfflineDurableClaimLedger(trusted.ledger)
  await ledger.checkFence(p.runId, p.expectedVersion, p.claimHash)
  const stored = await ledger.inspect(p.runId, p.expectedVersion)
  if (stored.requestHash !== requestHash || stored.reserved !== true) {
    fail("FENCE_REQUEST_MISMATCH")
  }

  // Last callback must perform the epoch/key/replay check atomically. A stale
  // host at this exact boundary is denied even if an earlier read was good.
  let consumed
  try {
    consumed = await trusted.consumeActionFence(Object.freeze({
      hostId: host.hostId, workerId: host.workerId, hostEpoch: host.hostEpoch,
      publicKey: host.publicKey, runId: p.runId,
      expectedVersion: p.expectedVersion, requestHash, claimHash: p.claimHash,
      actionId: p.actionId, actionType: p.actionType, actionPath: p.actionPath,
      expiresAt: p.expiresAt
    }))
  } catch { fail("FENCE_CONSUMPTION_UNAVAILABLE") }
  if (consumed !== true) fail("FENCE_CONSUMPTION_DENIED")
  return Object.freeze({ fenceObserved: true, hostId: p.hostId,
    hostEpoch: p.hostEpoch, runId: p.runId, expectedVersion: p.expectedVersion,
    actionId: p.actionId, canExecute: false, releaseAuthorized: false })
}
