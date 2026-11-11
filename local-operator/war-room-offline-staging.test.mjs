import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { signRemoteEnvelope } from "./software-factory-remote-contract.mjs"
import { createOfflineDurableClaimLedger } from "./software-factory-remote-durable-ledger.mjs"
import { linearIssueRevisionHash } from "./war-room-assignment-preflight.mjs"
import { stageOfflineAssignment } from "./war-room-offline-staging.mjs"

const NOW = "2026-11-11T05:02:00.000Z"
const RUN = "R".repeat(43)
const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const BRANCH = "feature/offline-stage"

/** Build a private synthetic store plus one shared PPO fixture authority. */
async function fixture(t, capability = "implementation.backend") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ppo-1e-staging-")))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const coordinator = generateKeyPairSync("ed25519")
  const issue = { identifier: "RIC-150", title: "Synthetic staged task",
    description: "Untrusted acceptance criteria", updatedAt: "2026-11-11T04:50:00.000Z" }
  const p = {
    kind: "dispatch-request", schemaVersion: 1, requestId: "1".repeat(32),
    runId: RUN, expectedVersion: 7, projectId: "rivora", branch: BRANCH,
    baseSha: BASE, headSha: HEAD, capability,
    workerId: capability === "implementation.backend" ? "codex" : "antigravity",
    taskSource: { kind: "linear-issue", issueId: issue.identifier,
      revisionHash: linearIssueRevisionHash(issue) },
    scope: { mode: "implementation", allowedPaths: ["src/"], permits: ["workspace.read"] },
    approval: { ownerId: "owner", approvalId: "3".repeat(32),
      approvedAt: "2026-11-11T04:59:00.000Z" },
    nonce: "2".repeat(32), idempotencyKey: "4".repeat(64),
    issuedAt: "2026-11-11T05:00:00.000Z",
    expiresAt: "2026-11-11T05:12:00.000Z", maxDurationMs: 600000
  }
  const f = {
    issue, run: { runId: RUN, version: 7, status: "implementation_in_progress",
      project: { id: "rivora" }, branch: BRANCH, baseSha: BASE, headSha: HEAD },
    repo: { projectId: "rivora", branch: BRANCH, baseSha: BASE, headSha: HEAD,
      reviewedCanonicalPath: true, isolatedWorktree: true },
    role: capability, approval: true, issueProject: "rivora",
    catalog: { valid: true }, active: ["rivora"],
    now: NOW, issueReads: 0, runReads: 0,
    onIssueRead: null, onRunRead: null, onApproval: null
  }
  const approvedProjects = ["rivora", "kynexa"]
  const clock = () => f.now
  const readRun = async () => {
    f.runReads++
    f.onRunRead?.(f.runReads)
    return structuredClone(f.run)
  }
  const resolveRole = () => f.role
  const readIssue = async () => {
    f.issueReads++
    f.onIssueRead?.(f.issueReads)
    return structuredClone(f.issue)
  }
  const verifyOwnerApproval = async () => {
    f.onApproval?.()
    return f.approval
  }
  const config = {
    mode: "offline-staging-proof-only",
    preflight: {
      mode: "offline-preflight-only", coordinatorPublicKey: coordinator.publicKey,
      approvedProjects, now: clock, readRun, resolveRole,
      readRepo: async () => structuredClone(f.repo), readIssue,
      resolveIssueProject: () => f.issueProject,
      verifyOwnerApproval,
      readCatalogAdmission: async () => structuredClone(f.catalog),
      listActiveProjects: async () => [...f.active]
    },
    ledger: {
      mode: "offline-durable-proof-only", coordinatorPublicKey: coordinator.publicKey,
      approvedProjects, now: clock, readRun, resolveRole, storeDir: dir,
      workerRegistry: {}
    }
  }
  const sign = () => signRemoteEnvelope(p, "ppo-control-plane", coordinator.privateKey)
  const contents = async () => readdir(dir)
  const ledger = () => createOfflineDurableClaimLedger(config.ledger)
  return { dir, p, f, config, sign, contents, ledger }
}

/** Match stable rejection codes from either preflight, ledger or this harness. */
const fails = code => error => error?.code === code

test("backend stages one immutable offline reservation without execution authority", async t => {
  const fx = await fixture(t)
  const result = await stageOfflineAssignment(fx.sign(), fx.config)
  assert.equal(result.outcome, "staged-offline")
  assert.equal(result.requestId, fx.p.requestId)
  assert.equal(result.runId, fx.p.runId)
  assert.equal(result.expectedVersion, 7)
  assert.equal(result.sourceRevisionHash, linearIssueRevisionHash(fx.f.issue))
  assert.match(result.requestHash, /^[a-f0-9]{64}$/)
  assert.equal(result.canExecute, false)
  assert.equal(result.releaseAuthorized, false)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(JSON.stringify(result).includes(fx.f.issue.description), false)
  assert.equal(fx.f.issueReads, 2)
  const persisted = await fx.ledger().inspect(RUN, 7)
  assert.equal(persisted.requestHash, result.requestHash)
  assert.equal(persisted.reserved, true)
})

test("frontend remains Antigravity-owned, with no worker claim or execution", async t => {
  const fx = await fixture(t, "implementation.frontend")
  const result = await stageOfflineAssignment(fx.sign(), fx.config)
  assert.equal(result.canExecute, false)
  assert.equal(result.releaseAuthorized, false)
  assert.equal((await fx.contents()).some(n => n.startsWith("run-")), true)
})

test("duplicate staging never replaces or recycles a durable run version", async t => {
  const fx = await fixture(t)
  const first = await stageOfflineAssignment(fx.sign(), fx.config)
  await assert.rejects(stageOfflineAssignment(fx.sign(), fx.config),
    fails("LEDGER_RUN_RESERVED"))
  const persisted = await fx.ledger().inspect(RUN, 7)
  assert.equal(persisted.requestHash, first.requestHash)
})

test("initial missing approval blocks before a single disk write", async t => {
  const fx = await fixture(t)
  fx.f.approval = false
  await assert.rejects(stageOfflineAssignment(fx.sign(), fx.config),
    fails("PREFLIGHT_APPROVAL_REQUIRED"))
  assert.deepEqual(await fx.contents(), [])
})

test("global invalid catalog and WIP overflow block before reservation", async t => {
  for (const blocked of ["catalog", "wip"]) {
    const fx = await fixture(t)
    if (blocked === "catalog") fx.f.catalog.valid = false
    else fx.f.active = ["kynexa", "khlim"]
    await assert.rejects(stageOfflineAssignment(fx.sign(), fx.config),
      fails(blocked === "catalog" ? "PREFLIGHT_CATALOG_BLOCKED" : "PREFLIGHT_WIP_BLOCKED"))
    assert.deepEqual(await fx.contents(), [])
  }
})

test("role mismatch, stale run and issue hash drift block before reservation", async t => {
  for (const blocked of ["role", "run", "issue"]) {
    const fx = await fixture(t)
    if (blocked === "role") fx.f.role = "implementation.frontend"
    else if (blocked === "run") fx.f.run.version = 8
    else fx.f.issue.description = "Changed post-signature"
    const expected = blocked === "role" ? "PREFLIGHT_ROLE_MISMATCH" :
      blocked === "run" ? "PREFLIGHT_RUN_STALE" : "PREFLIGHT_ISSUE_STALE"
    await assert.rejects(stageOfflineAssignment(fx.sign(), fx.config), fails(expected))
    assert.deepEqual(await fx.contents(), [])
  }
})

test("an invalid signed envelope blocks before touching storage", async t => {
  const fx = await fixture(t)
  const tampered = fx.sign()
  tampered.signature = "A".repeat(86)
  await assert.rejects(stageOfflineAssignment(tampered, fx.config),
    fails("STAGING_SIGNED_REQUEST_INVALID"))
  assert.deepEqual(await fx.contents(), [])
  assert.equal(fx.f.issueReads, 0)
})

test("preflight and ledger cannot silently use different trusted authorities", async t => {
  for (const alter of [
    c => { c.ledger.readRun = async () => null },
    c => { c.ledger.resolveRole = () => "implementation.frontend" },
    c => { c.ledger.now = () => "2026-11-11T09:00:00.000Z" },
    c => { c.ledger.approvedProjects = ["rivora", "kynexa"] },
    c => { c.ledger.coordinatorPublicKey = generateKeyPairSync("ed25519").publicKey },
    c => { c.mode = "live" }
  ]) {
    const fx = await fixture(t)
    alter(fx.config)
    await assert.rejects(stageOfflineAssignment(fx.sign(), fx.config),
      fails("STAGING_CONFIGURATION_INVALID"))
    assert.deepEqual(await fx.contents(), [])
  }
})

test("post-reservation issue drift denies success and keeps its tombstone", async t => {
  const fx = await fixture(t)
  fx.f.onIssueRead = count => {
    if (count === 2) fx.f.issue.description = "Changed while reserving"
  }
  await assert.rejects(stageOfflineAssignment(fx.sign(), fx.config),
    fails("PREFLIGHT_ISSUE_STALE"))
  assert.equal(fx.f.issueReads, 2)
  assert.equal((await fx.ledger().inspect(RUN, 7)).reserved, true)
  await assert.rejects(fx.ledger().reserve(fx.sign()), fails("LEDGER_RUN_RESERVED"))
})

test("revoked approval after reservation cannot produce staged success", async t => {
  const fx = await fixture(t)
  let verified = 0
  fx.f.onApproval = () => { verified++; if (verified === 2) fx.f.approval = false }
  await assert.rejects(stageOfflineAssignment(fx.sign(), fx.config),
    fails("PREFLIGHT_APPROVAL_REQUIRED"))
  assert.equal(verified, 2)
  assert.equal((await fx.ledger().inspect(RUN, 7)).reserved, true)
})

test("canonical run version drift at the second preflight leaves no success", async t => {
  const fx = await fixture(t)
  fx.f.onRunRead = count => { if (count === 3) fx.f.run.version = 8 }
  await assert.rejects(stageOfflineAssignment(fx.sign(), fx.config),
    fails("PREFLIGHT_RUN_STALE"))
  fx.f.run.version = 7
  assert.equal((await fx.ledger().inspect(RUN, 7)).reserved, true)
})

test("caller mutation during async preflight cannot swap verified request", async t => {
  const fx = await fixture(t)
  const signed = fx.sign()
  fx.f.onIssueRead = count => {
    if (count === 1) signed.payload.projectId = "kynexa"
  }
  const result = await stageOfflineAssignment(signed, fx.config)
  assert.equal(result.outcome, "staged-offline")
  assert.equal((await fx.ledger().inspect(RUN, 7)).requestHash, result.requestHash)
})
