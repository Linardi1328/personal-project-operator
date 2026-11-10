import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"

// Offline-only Phase 1B wire contracts. These exports do not enable transport,
// host trust, a PPO run transition, or production execution.
export const SOFTWARE_FACTORY_REMOTE_CONTRACT_VERSION = 1
export const SOFTWARE_FACTORY_REMOTE_CONTRACT_KINDS = Object.freeze([
  "dispatch-request", "worker-claim", "execution-evidence", "review-decision"
])
export const SOFTWARE_FACTORY_REMOTE_MAX_ENVELOPE_BYTES = 8192
const kinds = new Set(SOFTWARE_FACTORY_REMOTE_CONTRACT_KINDS)
const sha = /^[a-f0-9]{40}$/u
const digest = /^[a-f0-9]{64}$/u
const nonce = /^[a-f0-9]{32}$/u
const runId = /^[A-Za-z0-9_-]{43}$/u
const label = /^[a-z][a-z0-9-]{0,63}$/u
const issueId = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/u
const ref = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,160}$/u
const forbidden = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|(?:\bgithub_pat_[A-Za-z0-9_]{10,}|\bgh[opusr]_[A-Za-z0-9]{10,}|\bsk-[A-Za-z0-9_-]{16,}|BEGIN .*PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:])/iu
const allowedPaths = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,120}$/u
const permits = new Set(["workspace.read", "workspace.write", "tests.local"])
const capabilities = Object.freeze({"implementation.backend":"codex","implementation.frontend":"antigravity"})
const outcomes = new Set(["success", "blocked", "failed"])
const decisions = new Set(["accept", "changes_requested", "blocked"])

export class SoftwareFactoryRemoteContractError extends Error {
  constructor(code) {
    super(`Remote dispatch contract rejected: ${code}.`)
    this.name = "SoftwareFactoryRemoteContractError"
    this.code = code
  }
}

function fail(code) { throw new SoftwareFactoryRemoteContractError(code) }
function object(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail("REMOTE_FIELDS_INVALID")
}
function match(value, pattern) { return typeof value === "string" && pattern.test(value) }
function bounded(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value === value.trim() && !forbidden.test(value)
}
function validTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
}
function int(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max }
function pathList(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 &&
    value.every(x => match(x, allowedPaths) && !x.startsWith(".")) && new Set(value).size === value.length
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}
export function remotePayloadDigest(payload) {
  validateRemotePayload(payload)
  return createHash("sha256").update(canonical(payload)).digest("hex")
}

/** Validate strict v1 shapes and bounded metadata; never treats payload strings as authority. */
export function validateRemotePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p) || !kinds.has(p.kind) ||
      p.schemaVersion !== SOFTWARE_FACTORY_REMOTE_CONTRACT_VERSION) fail("REMOTE_VERSION_OR_KIND_INVALID")
  if (p.kind === "dispatch-request") {
    object(p,["kind","schemaVersion","requestId","runId","expectedVersion","projectId","branch","baseSha","headSha","capability","workerId","taskSource","scope","approval","nonce","idempotencyKey","issuedAt","expiresAt","maxDurationMs"])
    object(p.taskSource,["kind","issueId","revisionHash"])
    object(p.scope,["mode","allowedPaths","permits"])
    object(p.approval,["ownerId","approvalId","approvedAt"])
    if (!match(p.requestId,nonce) || !match(p.runId,runId) || !int(p.expectedVersion,1,10000000) ||
        !match(p.projectId,label) || !match(p.branch,ref) || !match(p.baseSha,sha) || !match(p.headSha,sha) ||
        !Object.hasOwn(capabilities,p.capability) || p.workerId !== capabilities[p.capability] ||
        p.taskSource.kind !== "linear-issue" || !match(p.taskSource.issueId,issueId) ||
        !match(p.taskSource.revisionHash,digest) || p.scope.mode !== "implementation" ||
        !pathList(p.scope.allowedPaths) || !Array.isArray(p.scope.permits) || p.scope.permits.length < 1 ||
        p.scope.permits.length > 3 || new Set(p.scope.permits).size !== p.scope.permits.length ||
        p.scope.permits.some(x=>!permits.has(x)) || !p.scope.permits.includes("workspace.read") ||
        !match(p.approval.ownerId,label) || !match(p.approval.approvalId,nonce) ||
        !validTime(p.approval.approvedAt) || !match(p.nonce,nonce) ||
        !match(p.idempotencyKey,digest) || !validTime(p.issuedAt) || !validTime(p.expiresAt) ||
        !int(p.maxDurationMs,1000,600000)) fail("REMOTE_REQUEST_INVALID")
    const issued=Date.parse(p.issuedAt), end=Date.parse(p.expiresAt), approved=Date.parse(p.approval.approvedAt)
    if (end <= issued || end-issued > 900000 || approved > issued || issued-approved > 900000 ||
        p.maxDurationMs > end-issued) fail("REMOTE_REQUEST_TIME_INVALID")
  } else if (p.kind === "worker-claim") {
    object(p,["kind","schemaVersion","requestId","requestHash","runId","expectedVersion","workerId","hostId","claimNonce","claimedAt","leaseExpiresAt"])
    if (!match(p.requestId,nonce) || !match(p.requestHash,digest) || !match(p.runId,runId) ||
        !int(p.expectedVersion,1,10000000) || !match(p.workerId,label) || !match(p.hostId,label) ||
        !match(p.claimNonce,nonce) || !validTime(p.claimedAt) || !validTime(p.leaseExpiresAt) ||
        Date.parse(p.leaseExpiresAt) <= Date.parse(p.claimedAt) ||
        Date.parse(p.leaseExpiresAt)-Date.parse(p.claimedAt) > 600000) fail("REMOTE_CLAIM_INVALID")
  } else if (p.kind === "execution-evidence") {
    object(p,["kind","schemaVersion","requestHash","claimHash","runId","expectedVersion","workerId","outcome","changedPaths","deniedTools","outputHash","summary","finishedAt"])
    if (!match(p.requestHash,digest) || !match(p.claimHash,digest) || !match(p.runId,runId) ||
        !int(p.expectedVersion,1,10000000) || !match(p.workerId,label) || !outcomes.has(p.outcome) ||
        !Array.isArray(p.changedPaths) || p.changedPaths.length > 8 ||
        p.changedPaths.some(x=>!match(x,allowedPaths)) || new Set(p.changedPaths).size !== p.changedPaths.length ||
        !Array.isArray(p.deniedTools) || p.deniedTools.length > 5 ||
        p.deniedTools.some(x=>!bounded(x,60)) || !match(p.outputHash,digest) ||
        !bounded(p.summary,200) || !validTime(p.finishedAt)) fail("REMOTE_EVIDENCE_INVALID")
    if (p.outcome === "success" && p.deniedTools.length > 0) fail("REMOTE_DENIED_IS_NOT_SUCCESS")
  } else {
    object(p,["kind","schemaVersion","requestHash","evidenceHash","runId","expectedVersion","reviewerId","decision","summary","reviewedAt"])
    if (!match(p.requestHash,digest) || !match(p.evidenceHash,digest) || !match(p.runId,runId) ||
        !int(p.expectedVersion,1,10000000) || !match(p.reviewerId,label) ||
        !decisions.has(p.decision) || !bounded(p.summary,200) || !validTime(p.reviewedAt)) fail("REMOTE_REVIEW_INVALID")
  }
  const encoded = canonical(p)
  if (Buffer.byteLength(encoded,"utf8") > SOFTWARE_FACTORY_REMOTE_MAX_ENVELOPE_BYTES) fail("REMOTE_OVERSIZED")
  return p
}

/** Locally sign synthetic messages; key registration and production transport are out of scope. */
export function signRemoteEnvelope(payload, signerId, privateKey) {
  validateRemotePayload(payload)
  if (!match(signerId,label) || privateKey?.asymmetricKeyType !== "ed25519") fail("REMOTE_SIGNER_INVALID")
  const signed = canonical({signerId,payload})
  return {signerId,payload:structuredClone(payload),signature:cryptoSign(null,Buffer.from(signed),privateKey).toString("base64url")}
}

// Do not let structuredClone silently normalize class instances, invoke getters,
// or preserve cycles into a payload that will be used as dispatch authority.
function assertPlainData(value, seen = new WeakSet(), depth = 0) {
  if (depth > 12) fail("REMOTE_FIELDS_INVALID")
  if (value === null || typeof value !== "object") {
    if (["function", "symbol", "bigint", "undefined"].includes(typeof value)) fail("REMOTE_FIELDS_INVALID")
    return
  }
  if (seen.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail("REMOTE_FIELDS_INVALID")
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") fail("REMOTE_FIELDS_INVALID")
    const desc = Object.getOwnPropertyDescriptor(value, key)
    if (!desc || !Object.hasOwn(desc, "value")) fail("REMOTE_FIELDS_INVALID")
    assertPlainData(desc.value, seen, depth + 1)
  }
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Verify exactly one stable snapshot; return immutable signed data, not caller-owned references. */
export function verifyRemoteEnvelope(envelope, expectedSignerId, publicKey) {
  let snapshot
  try {
    assertPlainData(envelope)
    snapshot = structuredClone(envelope)
  } catch {
    fail("REMOTE_FIELDS_INVALID")
  }
  envelope = snapshot
  object(envelope,["signerId","payload","signature"])
  if (envelope.signerId !== expectedSignerId || !match(envelope.signerId,label) ||
      typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature) ||
      Buffer.from(envelope.signature,"base64url").toString("base64url") !== envelope.signature ||
      publicKey?.asymmetricKeyType !== "ed25519") {
    fail("REMOTE_SIGNER_INVALID")
  }
  validateRemotePayload(envelope.payload)
  if (Buffer.byteLength(canonical(envelope),"utf8") > SOFTWARE_FACTORY_REMOTE_MAX_ENVELOPE_BYTES) fail("REMOTE_OVERSIZED")
  const raw=Buffer.from(canonical({signerId:envelope.signerId,payload:envelope.payload}))
  if (!cryptoVerify(null,raw,publicKey,Buffer.from(envelope.signature,"base64url"))) fail("REMOTE_SIGNATURE_INVALID")
  return deepFreeze(envelope.payload)
}