import { verify, KeyObject } from "node:crypto"
import { isAbsolute } from "node:path"

// This module verifies HOST IDENTITY ONLY. It deliberately never returns a
// quiescence guard, work-state flag, delivery authorization, or lease claim.
// The pinned public key and expected fields MUST come from an independent
// trusted owner-maintained configuration, never from the witness or chat.
export const RETIREMENT_HOST_WITNESS_PROTOCOL = "ppo-ric61-host-identity-v1"
export const RETIREMENT_HOST_WITNESS_MAX_LIFETIME_MS = 30_000
const unavailable = Object.freeze({ ok: false, code: "retirement_host_identity_unverifiable" })
const roles = new Set(["mac", "vps"])
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const shaPattern = /^[a-f0-9]{40}$/
const epochPattern = /^[A-Za-z0-9_-]{43}$/
const encodingPattern = /^[A-Za-z0-9_-]+$/
const payloadKeys = Object.freeze([
  "protocol", "role", "hostId", "writeDataDir", "deploymentSha",
  "epoch", "issuedAtMs", "expiresAtMs"
])
const hasOnlyKeys = (object, names) =>
  object !== null && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).length === names.length &&
  names.every(key => Object.hasOwn(object, key))

function decodeCanonicalBase64url(encoded, maxBytes) {
  if (typeof encoded !== "string" || encoded.length > maxBytes * 2 ||
      !encodingPattern.test(encoded)) return null
  const bytes = Buffer.from(encoded, "base64url")
  if (bytes.length === 0 || bytes.length > maxBytes ||
      bytes.toString("base64url") !== encoded) return null
  return bytes
}

function expectedConfigValid(config) {
  return config && typeof config === "object" &&
    roles.has(config.role) && typeof config.hostId === "string" &&
    identityPattern.test(config.hostId) &&
    typeof config.writeDataDir === "string" &&
    isAbsolute(config.writeDataDir) &&
    typeof config.deploymentSha === "string" &&
    shaPattern.test(config.deploymentSha) &&
    typeof config.epoch === "string" &&
    epochPattern.test(config.epoch) &&
    Number.isSafeInteger(config.nowMs) && config.nowMs >= 0 &&
    config.publicKey instanceof KeyObject &&
    config.publicKey.type === "public" &&
    config.publicKey.asymmetricKeyType === "ed25519"
}

/**
 * Offline, read-only verification of a host-signed identity witness.
 * The signed, canonical payload is bound to a fresh controller epoch and a
 * pre-registered host role, host ID, data directory and deployed code SHA.
 *
 * A successful result establishes only that the expected public key signed
 * these fresh identity fields. It does NOT establish actual process identity,
 * absence of workers, deployed-code correctness, exclusive OS fencing,
 * service-state exclusion, GitHub delivery safety, or permission to retire.
 */
export function verifyRetirementHostIdentityWitness(witness, expected) {
  try {
    if (!expectedConfigValid(expected) ||
        !hasOnlyKeys(witness, ["payload", "signature"])) return unavailable

    const bytes = decodeCanonicalBase64url(witness.payload, 1024)
    const signature = decodeCanonicalBase64url(witness.signature, 64)
    if (!bytes || !signature || signature.length !== 64) return unavailable
    const raw = bytes.toString("utf8")
    if (!Buffer.from(raw, "utf8").equals(bytes)) return unavailable
    const claims = JSON.parse(raw)
    if (!hasOnlyKeys(claims, payloadKeys)) return unavailable

    // Fixed serialization eliminates hidden duplicate fields, alternative
    // key orders, or unbound attributes in a signed JSON envelope.
    const canonical = Object.fromEntries(payloadKeys.map(key => [key, claims[key]]))
    if (JSON.stringify(canonical) !== raw) return unavailable

    if (claims.protocol !== RETIREMENT_HOST_WITNESS_PROTOCOL ||
        claims.role !== expected.role ||
        claims.hostId !== expected.hostId ||
        claims.writeDataDir !== expected.writeDataDir ||
        claims.deploymentSha !== expected.deploymentSha ||
        claims.epoch !== expected.epoch ||
        !Number.isSafeInteger(claims.issuedAtMs) ||
        !Number.isSafeInteger(claims.expiresAtMs) ||
        claims.issuedAtMs < 0 ||
        claims.issuedAtMs > expected.nowMs ||
        claims.expiresAtMs <= expected.nowMs ||
        claims.expiresAtMs <= claims.issuedAtMs ||
        claims.expiresAtMs - claims.issuedAtMs > RETIREMENT_HOST_WITNESS_MAX_LIFETIME_MS) {
      return unavailable
    }
    if (!verify(null, bytes, expected.publicKey, signature)) return unavailable
    return Object.freeze({
      ok: true,
      code: "retirement_host_identity_verified_only",
      role: expected.role,
      hostId: expected.hostId
    })
  } catch {
    return unavailable
  }
}
