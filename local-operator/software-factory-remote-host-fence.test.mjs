import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  remotePayloadDigest, signRemoteEnvelope
} from "./software-factory-remote-contract.mjs"
import { createOfflineDurableClaimLedger } from "./software-factory-remote-durable-ledger.mjs"
import {
  signOfflineHostActionProof, verifyOfflineHostActionFence
} from "./software-factory-remote-host-fence.mjs"

const RUN = "R".repeat(43)
const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const NOW = "2026-11-12T02:03:00.000Z"
const ISSUED = "2026-11-12T02:00:00.000Z"
const EXPIRY = "2026-11-12T02:10:00.000Z"
const code = name => error => error?.code === name
const actionId = n => n.toString(16).padStart(32, "0")

/** Set up real signed Phase 1B envelopes and a private Phase 1C durable store. */
async function fixture(t) {
  const storeDir = await realpath(await mkdtemp(join(tmpdir(), "ppo-host-fence-")))
  t.after(async () => { await rm(storeDir, { recursive: true, force: true }) })
  const coordinator = generateKeyPairSync("ed25519")
  const worker = generateKeyPairSync("ed25519")
  const hostKey = generateKeyPairSync("ed25519")
  const state = {
    now: NOW, catalog: { valid: true, diagnostics: { invalid: 0 } },
    active: ["rivora"], consumptions: 0, used: new Set(),
    host: { hostId: "demo-mac", workerId: "codex", hostEpoch: 4,
      status: "active", publicKey: hostKey.publicKey },
    run: { runId: RUN, version: 9, status: "implementation_in_progress",
      project: { id: "rivora" }, branch: "feature/synthetic",
      baseSha: BASE, headSha: HEAD },
    onConsume: null, readHostError: false
  }
  const request = {
    kind: "dispatch-request", schemaVersion: 1,
    requestId: actionId(1), runId: RUN, expectedVersion: 9,
    projectId: "rivora", branch: "feature/synthetic",
    baseSha: BASE, headSha: HEAD, capability: "implementation.backend",
    workerId: "codex",
    taskSource: { kind: "linear-issue", issueId: "RIC-153",
      revisionHash: "c".repeat(64) },
    scope: { mode: "implementation", allowedPaths: ["src/"],
      permits: ["workspace.read", "workspace.write"] },
    approval: { ownerId: "owner", approvalId: actionId(2),
      approvedAt: "2026-11-12T01:59:00.000Z" },
    nonce: actionId(3), idempotencyKey: "d".repeat(64),
    issuedAt: ISSUED, expiresAt: EXPIRY, maxDurationMs: 120000
  }
  const signedRequest = signRemoteEnvelope(request, "ppo-control-plane", coordinator.privateKey)
  const requestHash = remotePayloadDigest(request)
  const claim = {
    kind: "worker-claim", schemaVersion: 1, requestId: request.requestId,
    requestHash, runId: RUN, expectedVersion: 9,
    workerId: "codex", hostId: "demo-mac", claimNonce: actionId(5),
    claimedAt: "2026-11-12T02:02:00.000Z",
    leaseExpiresAt: "2026-11-12T02:04:00.000Z"
  }
  const claimHash = remotePayloadDigest(claim)
  const ledgerConfig = {
    mode: "offline-durable-proof-only", storeDir,
    coordinatorPublicKey: coordinator.publicKey, now: () => state.now,
    readRun: async () => structuredClone(state.run),
    resolveRole: () => "implementation.backend",
    approvedProjects: ["rivora"], workerRegistry: {
      codex: { hostId: "demo-mac", online: true, publicKey: worker.publicKey }
    }
  }
  const ledger = createOfflineDurableClaimLedger(ledgerConfig)
  await ledger.reserve(signedRequest)
  await ledger.claim(RUN, 9, signRemoteEnvelope(claim, "codex", worker.privateKey))

  const config = {
    mode: "offline-host-fence-proof-only", now: ledgerConfig.now,
    coordinatorPublicKey: coordinator.publicKey, ledger: ledgerConfig,
    readHost: async () => {
      if (state.readHostError) throw new Error("host unavailable")
      return { ...state.host }
    },
    readCatalogAdmission: async () => structuredClone(state.catalog),
    listActiveProjects: async () => [...state.active],
    consumeActionFence: async input => {
      state.consumptions++
      state.onConsume?.(input)
      const h = state.host
      const keyStillPinned = h.publicKey === input.publicKey
      if (h.status !== "active" || h.hostEpoch !== input.hostEpoch ||
          !keyStillPinned || h.hostId !== input.hostId ||
          h.workerId !== input.workerId || state.used.has(input.actionId) ||
          Date.parse(state.now) >= Date.parse(input.expiresAt)) return false
      state.used.add(input.actionId)
      return true
    }
  }
  const proof = (overrides = {}, key = hostKey.privateKey) =>
    signOfflineHostActionProof({
      version: 1, hostId: "demo-mac", hostEpoch: 4,
      workerId: "codex", requestHash, claimHash,
      runId: RUN, expectedVersion: 9, actionId: actionId(40),
      actionType: "workspace.read", actionPath: "src/module.mjs",
      issuedAt: "2026-11-12T02:02:30.000Z",
      expiresAt: "2026-11-12T02:03:30.000Z",
      ...overrides
    }, key)
  return { state, request, signedRequest, claimHash, requestHash,
    hostKey, coordinator, worker, config, proof, ledger }
}

test("registered host signature and current worker fence produce inert diagnostic", async t => {
  const f = await fixture(t)
  const result = await verifyOfflineHostActionFence(f.signedRequest, f.proof(), f.config)
  assert.equal(result.fenceObserved, true)
  assert.equal(result.hostId, "demo-mac")
  assert.equal(result.hostEpoch, 4)
  assert.equal(result.runId, RUN)
  assert.equal(result.canExecute, false)
  assert.equal(result.releaseAuthorized, false)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(JSON.stringify(result).includes(f.request.taskSource.issueId), false)
  assert.equal(f.state.used.size, 1)
})

test("same action proof is single-use, including parallel check attempts", async t => {
  const f = await fixture(t)
  const signed = f.proof()
  const outcomes = await Promise.allSettled([
    verifyOfflineHostActionFence(f.signedRequest, signed, f.config),
    verifyOfflineHostActionFence(f.signedRequest, signed, f.config)
  ])
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1)
  assert.equal(outcomes.filter(o => o.status === "rejected").length, 1)
  assert.equal(outcomes.find(o => o.status === "rejected").reason.code,
    "FENCE_CONSUMPTION_DENIED")
  await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, signed, f.config),
    code("FENCE_CONSUMPTION_DENIED"))
})

test("unknown, revoked and unreachable host identities are denied before consumption", async t => {
  for (const kind of ["revoked", "unknown", "offline"]) {
    const f = await fixture(t)
    if (kind === "revoked") f.state.host.status = "revoked"
    if (kind === "unknown") f.state.host.hostId = "other-mac"
    if (kind === "offline") f.state.readHostError = true
    await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, f.proof(), f.config),
      code(kind === "offline" ? "FENCE_HOST_UNAVAILABLE" : "FENCE_HOST_UNTRUSTED"))
    assert.equal(f.state.consumptions, 0)
  }
})

test("different signing key, epoch and worker binding are denied", async t => {
  const f = await fixture(t)
  const rogue = generateKeyPairSync("ed25519")
  await assert.rejects(verifyOfflineHostActionFence(f.signedRequest,
    f.proof({}, rogue.privateKey), f.config), code("FENCE_HOST_SIGNATURE_INVALID"))
  await assert.rejects(verifyOfflineHostActionFence(f.signedRequest,
    f.proof({ hostEpoch: 3 }), f.config), code("FENCE_HOST_UNTRUSTED"))
  await assert.rejects(verifyOfflineHostActionFence(f.signedRequest,
    f.proof({ workerId: "antigravity" }), f.config), code("FENCE_ACTION_SCOPE_DENIED"))
  assert.equal(f.state.consumptions, 0)
})

test("rotating the pinned host key revokes old proof until new epoch and signature", async t => {
  const f = await fixture(t)
  const old = f.proof()
  const rotated = generateKeyPairSync("ed25519")
  f.state.host.hostEpoch = 5
  f.state.host.publicKey = rotated.publicKey
  await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, old, f.config),
    code("FENCE_HOST_UNTRUSTED"))
  const fresh = f.proof({ hostEpoch: 5 }, rotated.privateKey)
  const result = await verifyOfflineHostActionFence(f.signedRequest, fresh, f.config)
  assert.equal(result.fenceObserved, true)
  assert.equal(result.canExecute, false)
})

test("host revocation after initial registry read is stopped by final consume boundary", async t => {
  const f = await fixture(t)
  f.state.onConsume = () => { f.state.host.status = "revoked" }
  await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, f.proof(), f.config),
    code("FENCE_CONSUMPTION_DENIED"))
  assert.equal(f.state.used.size, 0)
})

test("stale epoch change during consume is not treated as valid", async t => {
  const f = await fixture(t)
  f.state.onConsume = () => { f.state.host.hostEpoch = 5 }
  await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, f.proof(), f.config),
    code("FENCE_CONSUMPTION_DENIED"))
  assert.equal(f.state.used.size, 0)
})

test("unsupported action, out-of-scope path and wrong digests fail closed", async t => {
  for (const overrides of [
    { actionType: "shell.exec" }, { actionType: "tests.local" },
    { actionPath: "src-adjacent/m.mjs" }, { actionPath: "../secrets" },
    { requestHash: "f".repeat(64) }, { claimHash: "f".repeat(64) },
    { expectedVersion: 10 }, { runId: "S".repeat(43) }
  ]) {
    const f = await fixture(t)
    const bad = () => f.proof(overrides)
    if (overrides.actionType === "shell.exec" ||
        overrides.actionPath === "../secrets") {
      assert.throws(bad, code("FENCE_PROOF_INVALID"))
    } else {
      await assert.rejects(verifyOfflineHostActionFence(f.signedRequest,
        bad(), f.config), e => typeof e?.code === "string" && e.code.startsWith("FENCE_"))
    }
    assert.equal(f.state.consumptions, 0)
  }
})

test("expired host proof, future proof and expired worker lease are denied", async t => {
  for (const kind of ["past", "future", "lease"]) {
    const f = await fixture(t)
    const proof = kind === "past" ? f.proof({
      issuedAt: "2026-11-12T02:01:00.000Z",
      expiresAt: "2026-11-12T02:02:00.000Z"
    }) : kind === "future" ? f.proof({
      issuedAt: "2026-11-12T02:05:00.000Z",
      expiresAt: "2026-11-12T02:05:30.000Z"
    }) : f.proof()
    if (kind === "lease") f.state.now = "2026-11-12T02:04:30.000Z"
    await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, proof, f.config),
      code(kind === "lease" ? "FENCE_PROOF_EXPIRED" : "FENCE_PROOF_EXPIRED"))
    assert.equal(f.state.consumptions, 0)
  }
})

test("the actual durable ledger rejects stale run versions before any action consume", async t => {
  const f = await fixture(t)
  f.state.run.version = 10
  await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, f.proof(), f.config),
    code("LEDGER_RUN_STALE"))
  assert.equal(f.state.consumptions, 0)
})

test("an invalid global catalog or exceeded WIP policy blocks action checks", async t => {
  for (const kind of ["invalid", "malformed", "wip"]) {
    const f = await fixture(t)
    if (kind === "invalid") f.state.catalog.diagnostics.invalid = 1
    if (kind === "malformed") delete f.state.catalog.diagnostics
    if (kind === "wip") f.state.active = ["kynexa", "khlim"]
    await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, f.proof(), f.config),
      code(kind === "wip" ? "FENCE_WIP_BLOCKED" : "FENCE_CATALOG_BLOCKED"))
    assert.equal(f.state.consumptions, 0)
  }
})

test("missing, failing and ambiguous atomic consume never report success", async t => {
  for (const kind of ["missing", "throw", "unknown"]) {
    const f = await fixture(t)
    if (kind === "missing") delete f.config.consumeActionFence
    if (kind === "throw") f.config.consumeActionFence = async () => { throw new Error("unknown") }
    if (kind === "unknown") f.config.consumeActionFence = async () => ({ accepted: true })
    await assert.rejects(verifyOfflineHostActionFence(f.signedRequest, f.proof(), f.config),
      code(kind === "missing" ? "FENCE_CONFIGURATION_INVALID" :
        kind === "throw" ? "FENCE_CONSUMPTION_UNAVAILABLE" : "FENCE_CONSUMPTION_DENIED"))
  }
})

test("forged coordinator request is rejected regardless of valid host proof", async t => {
  const f = await fixture(t)
  const fake = { ...f.signedRequest, signature: "A".repeat(86) }
  await assert.rejects(verifyOfflineHostActionFence(fake, f.proof(), f.config),
    code("FENCE_REQUEST_INVALID"))
  assert.equal(f.state.consumptions, 0)
})
