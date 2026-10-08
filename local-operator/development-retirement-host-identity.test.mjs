import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"
import {
  RETIREMENT_HOST_WITNESS_PROTOCOL,
  RETIREMENT_HOST_WITNESS_MAX_LIFETIME_MS,
  verifyRetirementHostIdentityWitness
} from "./development-retirement-host-identity.mjs"

const nowMs = 1_800_000_000_000
const epoch = Buffer.alloc(32, 1).toString("base64url")
const otherEpoch = Buffer.alloc(32, 2).toString("base64url")
const keys = generateKeyPairSync("ed25519")
const alternateKeys = generateKeyPairSync("ed25519")
const expected = Object.freeze({
  role: "mac",
  hostId: "ppo-mac-1",
  writeDataDir: "/private/synthetic/ppo-store",
  deploymentSha: "a".repeat(40),
  epoch,
  nowMs,
  publicKey: keys.publicKey
})

function claims(overrides = {}) {
  return {
    protocol: RETIREMENT_HOST_WITNESS_PROTOCOL,
    role: expected.role,
    hostId: expected.hostId,
    writeDataDir: expected.writeDataDir,
    deploymentSha: expected.deploymentSha,
    epoch: expected.epoch,
    issuedAtMs: nowMs - 500,
    expiresAtMs: nowMs + 500,
    ...overrides
  }
}

function witness(message = claims(), privateKey = keys.privateKey) {
  const bytes = Buffer.from(typeof message === "string" ? message : JSON.stringify(message), "utf8")
  return {
    payload: bytes.toString("base64url"),
    signature: sign(null, bytes, privateKey).toString("base64url")
  }
}

const rejected = { ok: false, code: "retirement_host_identity_unverifiable" }
const reject = (signed, config = expected) =>
  assert.deepEqual(verifyRetirementHostIdentityWitness(signed, config), rejected)

test("valid signed, epoch-bound Mac identity reports identity only", () => {
  const result = verifyRetirementHostIdentityWitness(witness(), expected)
  assert.deepEqual(result, {
    ok: true,
    code: "retirement_host_identity_verified_only",
    role: "mac",
    hostId: "ppo-mac-1"
  })
  for (const property of ["workersQuiescent", "deliveryQuiescent", "exclusive", "assertHeld", "release"]) {
    assert.equal(Object.hasOwn(result, property), false)
  }
})

test("VPS uses independently pinned identity, store, epoch and signing key", () => {
  const vpsConfig = {
    ...expected, role: "vps", hostId: "ppo-vps-1",
    writeDataDir: "/var/lib/personal-project-operator/write-data",
    publicKey: alternateKeys.publicKey, epoch: otherEpoch
  }
  const vps = witness(claims({
    role: vpsConfig.role, hostId: vpsConfig.hostId,
    writeDataDir: vpsConfig.writeDataDir, epoch: vpsConfig.epoch
  }), alternateKeys.privateKey)
  assert.equal(verifyRetirementHostIdentityWitness(vps, vpsConfig).ok, true)
  reject(vps)
  reject(witness(), vpsConfig)
})

for (const [label, override] of [
  ["wrong role", { role: "vps" }],
  ["unknown role", { role: "test" }],
  ["wrong host identity", { hostId: "other-host" }],
  ["wrong data root", { writeDataDir: "/different" }],
  ["wrong deployed revision", { deploymentSha: "b".repeat(40) }],
  ["replayed epoch", { epoch: otherEpoch }],
  ["future issued time", { issuedAtMs: nowMs + 1 }],
  ["expired certificate", { expiresAtMs: nowMs }],
  ["overlong lifetime", { issuedAtMs: nowMs - RETIREMENT_HOST_WITNESS_MAX_LIFETIME_MS,
    expiresAtMs: nowMs + 1 }],
  ["negative time", { issuedAtMs: -1 }],
  ["non-integer time", { issuedAtMs: 0.1 }],
  ["inverted time", { expiresAtMs: nowMs - 800 }],
  ["unexpected payload field", { workersQuiescent: true }],
  ["signed nonprotocol", { protocol: "untrusted-claim" }]
]) {
  test(label + " is rejected even when signature is otherwise genuine", () => {
    reject(witness(claims(override)))
  })
}

test("old attestations are rejected under current trusted clock", () => {
  reject(witness(), { ...expected, nowMs: nowMs + 1000 })
})

test("wrong pinned key, missing key and wrong key type are rejected", () => {
  reject(witness(), { ...expected, publicKey: alternateKeys.publicKey })
  reject(witness(), { ...expected, publicKey: undefined })
  reject(witness(), { ...expected, publicKey: keys.privateKey })
})

test("untrusted caller attempts to supply signing key or quiescence claims fail", () => {
  reject({ ...witness(), publicKey: keys.publicKey })
  reject({ ...witness(), workersQuiescent: true })
  reject({ ...witness(), deliveryQuiescent: true })
})

test("signature cannot be copied onto a changed payload or replaced with random bytes", () => {
  const good = witness()
  reject({ ...good, payload: witness(claims({ hostId: "other" })).payload })
  reject({ ...good, signature: sign(null, Buffer.from("different"), keys.privateKey).toString("base64url") })
  reject({ ...good, signature: Buffer.alloc(64, 1).toString("base64url") })
})

test("serialized duplicate keys, reordered keys and unknown keys fail closed", () => {
  const raw = JSON.stringify(claims())
  reject(witness(raw.replace('"hostId":"ppo-mac-1"', '"hostId":"ppo-mac-1","hostId":"ppo-mac-1"')))
  const { protocol, role, ...remaining } = claims()
  reject(witness(JSON.stringify({ role, protocol, ...remaining })))
  reject(witness(JSON.stringify({ ...claims(), extra: "ignored?" })))
})

test("malformed encodings and bad payloads fail without exposing errors", () => {
  const good = witness()
  for (const malformed of [
    null, {}, [], { payload: "!!", signature: good.signature },
    { ...good, signature: "===" }, { ...good, signature: "abc" },
    { ...good, payload: Buffer.alloc(1025, 1).toString("base64url") },
    { ...good, payload: Buffer.from("not json").toString("base64url") },
    { ...good, payload: good.payload + "=" }
  ]) reject(malformed)
})

test("untrusted expected registration and missing requested epoch are rejected", () => {
  const good = witness()
  reject(good, { ...expected, hostId: undefined })
  reject(good, { ...expected, role: "mac-vps" })
  reject(good, { ...expected, writeDataDir: "relative/path" })
  reject(good, { ...expected, epoch: undefined })
  reject(good, { ...expected, deploymentSha: undefined })
  reject(good, { ...expected, nowMs: Infinity })
})
