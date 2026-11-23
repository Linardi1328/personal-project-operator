import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto"
import { on, once } from "node:events"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  createDevelopmentRun, readDevelopmentRun, recordDevelopmentRunProgress, transitionDevelopmentRun
} from "./development-run-state.mjs"
import { resolveSoftwareFactoryTaskRole } from "./software-factory-plan-contract.mjs"
import { remotePayloadDigest, signRemoteEnvelope } from "./software-factory-remote-contract.mjs"
import { createOfflineDurableClaimLedger } from "./software-factory-remote-durable-ledger.mjs"
import { linearIssueRevisionHash } from "./war-room-assignment-preflight.mjs"
import { stageOfflineAssignment } from "./war-room-offline-staging.mjs"

// Test-only process-crash boundary: SIGKILL follows a successful staging return
// and verified durable receipt, before the separate canonical CAS write. The
// parent survives and restarts helpers with the same fixture observations. This
// does not simulate a power loss, a crash inside fsync, or rollback of a device.
// Invalid ledger states below are deliberately seeded in disposable fixtures.
const CHILD = "--ric192-fixture-child"
const ROOT_PREFIX = "ppo-ric192-"
const TIMEOUT = 30_000
const TEST_OPTIONS = { timeout: 90_000 }
const NOW = "2026-11-11T05:02:00.000Z"
const PROJECT = "rivora"
const ACTOR = "ric192-offline-fixture"
const BRANCH = "ppo/rivora/implementation/synthetic-restart"
const BASE = "a".repeat(40)
const ISSUE = Object.freeze({
  identifier: "RIC-987192", title: "Synthetic crash and restart",
  description: "Add a synthetic backend API endpoint.", updatedAt: "2026-11-11T04:58:00.000Z"
})
const RESERVATION_FLAGS = { canExecute: false, releaseAuthorized: false }
const RUN_INPUT = { projectId: PROJECT, task: ISSUE.description, actor: ACTOR, branch: BRANCH, baseSha: BASE, headSha: BASE }

const ledgerPath = root => join(root, "reservations")
const runOptions = root => ({ writeDataDir: join(root, "canonical"), now: () => new Date(NOW) })

function send(channel, payload) {
  return new Promise((resolve, reject) => channel.send(payload, error => error ? reject(error) : resolve()))
}

async function refusal(operation) {
  try { await operation() } catch (error) {
    if (typeof error?.code !== "string" || error.code === "ERR_ASSERTION") throw error
    return error.code
  }
  assert.fail("Expected a fail-closed refusal")
}

async function childMain() {
  const inbox = on(process, "message", { close: ["disconnect"] })
  async function receive() {
    const message = await inbox.next()
    assert.equal(message.done, false, "Parent disconnected")
    return message.value[0]
  }
  async function barrier(event, fields = {}) {
    await send(process, { event, ...fields })
    assert.equal(await receive(), "proceed")
  }
  try {
    const { mode, root, signed, publicKey, approvalHashes } = await receive()
    // Only a private child of the system temp directory is a valid test store.
    assert.match(basename(root), /^ppo-ric192-[A-Za-z0-9]{6}$/u)
    assert.equal(dirname(root), await realpath(tmpdir()))
    const info = await lstat(root)
    assert.ok(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700)
    assert.equal(await realpath(root), root)

    const { runId, expectedVersion } = signed.payload
    const options = runOptions(root)
    const readRun = id => readDevelopmentRun(id, options)
    const common = {
      coordinatorPublicKey: createPublicKey(publicKey),
      approvedProjects: [PROJECT], now: options.now, readRun, resolveRole: resolveSoftwareFactoryTaskRole
    }
    const ledgerConfig = { ...common, mode: "offline-durable-proof-only", storeDir: ledgerPath(root), workerRegistry: {} }
    const ledger = createOfflineDurableClaimLedger(ledgerConfig)
    const inspect = () => ledger.inspect(runId, expectedVersion)
    let atPreflight = false
    const stage = () => stageOfflineAssignment(signed, {
      mode: "offline-staging-proof-only", ledger: ledgerConfig,
      preflight: {
        ...common, mode: "offline-preflight-only", readIssue: () => ISSUE,
        resolveIssueProject: () => PROJECT,
        readRepo: () => ({
          projectId: PROJECT, branch: BRANCH, baseSha: BASE, headSha: BASE,
          reviewedCanonicalPath: true, isolatedWorktree: true
        }),
        readCatalogAdmission: () => ({ valid: true }), listActiveProjects: () => [PROJECT],
        async verifyOwnerApproval(binding) {
          if (!approvalHashes.includes(binding.requestHash)) return false
          if (mode === "race" && !atPreflight) {
            atPreflight = true
            await barrier("preflight")
          }
          return true
        }
      }
    })

    switch (mode) {
      case "reserve": {
        const receipt = await stage()
        assert.equal(receipt.outcome, "staged-offline")
        assert.equal(receipt.canExecute, false)
        assert.equal(receipt.releaseAuthorized, false)
        const reservation = await inspect()
        const run = await readRun(runId)
        // The only binding write in this path sits after this acknowledgement.
        await barrier("reserved", { receipt, reservation, run })
        const bound = await recordDevelopmentRunProgress(runId, {
          expectedVersion: receipt.expectedVersion, status: run.status, actor: ACTOR,
          evidence: [{
            kind: "planning", source: ACTOR, sha: run.headSha, summary: "Bound synthetic assignment reservation.",
            metadata: { requestHash: receipt.requestHash, reservedVersion: receipt.expectedVersion, synthetic: true }
          }]
        }, options)
        await send(process, { event: "bound", run: bound })
        break
      }
      case "inspect": {
        const reservation = await inspect()
        const claimCode = await refusal(() => ledger.checkFence(runId, expectedVersion, "f".repeat(64)))
        await send(process, { event: "observed", reservation, claimCode, run: await readRun(runId) })
        break
      }
      case "invalid":
        await send(process, { event: "invalid", code: await refusal(inspect), run: await readRun(runId) })
        break
      case "attempt":
      case "race":
        await send(process, { event: "denied", code: await refusal(stage) })
        break
      case "continue": {
        // Call the real, trusted internal writer. No continuation runner,
        // lease, execution handler, or fake reservation-denial hook is used.
        const transition = () => transitionDevelopmentRun(runId, {
          expectedVersion, status: "implementation_ready", actor: ACTOR,
          reason: "Synthetic internal continuation boundary observation."
        }, options)
        const run = await transition()
        const staleCode = await refusal(transition)
        const replayCode = await refusal(stage)
        await send(process, { event: "continued", run, reservation: await inspect(), staleCode, replayCode })
        break
      }
      default:
        assert.fail("Unknown fixture operation")
    }
  } finally {
    await inbox.return()
    if (process.connected) process.disconnect()
  }
}

async function fixture(t) {
  const temp = await realpath(tmpdir())
  const root = await mkdtemp(join(temp, ROOT_PREFIX))
  const children = []
  t.after(async () => {
    const exits = await Promise.allSettled(children.map(({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      return closed
    }))
    await rm(root, { recursive: true, force: true })
    await assert.rejects(lstat(root), { code: "ENOENT" })
    for (const exit of exits) {
      if (exit.status === "rejected") throw exit.reason
    }
  })
  await mkdir(ledgerPath(root), { mode: 0o700 })
  const options = runOptions(root)
  let initial = await createDevelopmentRun(RUN_INPUT, options)
  for (const status of ["planning_in_progress", "planned", "implementation_in_progress"]) {
    initial = await transitionDevelopmentRun(initial.runId, { expectedVersion: initial.version, status, actor: ACTOR }, options)
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const payload = {
    kind: "dispatch-request", schemaVersion: 1, requestId: "1".repeat(32),
    runId: initial.runId, expectedVersion: initial.version, projectId: PROJECT, branch: BRANCH,
    baseSha: BASE, headSha: BASE, capability: "implementation.backend", workerId: "codex",
    taskSource: { kind: "linear-issue", issueId: ISSUE.identifier, revisionHash: linearIssueRevisionHash(ISSUE) },
    scope: { mode: "implementation", allowedPaths: ["src/"], permits: ["workspace.read"] },
    approval: { ownerId: "owner", approvalId: "2".repeat(32), approvedAt: "2026-11-11T05:00:00.000Z" },
    nonce: "3".repeat(32), idempotencyKey: "4".repeat(64),
    issuedAt: "2026-11-11T05:01:00.000Z", expiresAt: "2026-11-11T05:12:00.000Z", maxDurationMs: 120_000
  }
  const original = signRemoteEnvelope(payload, "ppo-control-plane", privateKey)
  const fresh = signRemoteEnvelope({
    ...payload, requestId: "5".repeat(32), nonce: "6".repeat(32), idempotencyKey: "7".repeat(64),
    approval: { ...payload.approval, approvalId: "8".repeat(32) }
  }, "ppo-control-plane", privateKey)
  const requestHash = remotePayloadDigest(original.payload)
  const freshHash = remotePayloadDigest(fresh.payload)
  assert.notEqual(requestHash, freshHash)
  const approvalHashes = [requestHash, freshHash]

  async function start(mode, { signed = original, approved = true } = {}) {
    const child = fork(fileURLToPath(import.meta.url), [CHILD], {
      env: { TMPDIR: temp }, execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"]
    })
    const closed = once(child, "close")
    closed.catch(() => {})
    children.push({ child, closed })
    const messages = on(child, "message", { close: ["close"], signal: AbortSignal.timeout(TIMEOUT) })
    await send(child, { mode, root, signed, publicKey: publicKey.export({ type: "spki", format: "pem" }),
      approvalHashes: approved ? approvalHashes : [] })
    return {
      pid: child.pid,
      advance: () => send(child, "proceed"),
      async next(event) {
        const message = await messages.next()
        assert.equal(message.done, false, "Child closed before " + event)
        const [value] = message.value
        assert.equal(value.event, event)
        return value
      },
      async exited(signal = null) {
        assert.deepEqual(await closed, [signal ? null : 0, signal])
        assert.equal(child.connected, false)
      },
      crash() { assert.equal(child.kill("SIGKILL"), true) }
    }
  }

  return {
    root, initial, requestHash, fresh, start,
    read: () => readDevelopmentRun(initial.runId, options)
  }
}

async function atReservation(f) {
  const writer = await f.start("reserve")
  const before = await writer.next("reserved")
  assert.deepEqual(before.run, f.initial)
  assert.deepEqual(before.receipt, {
    outcome: "staged-offline", requestId: "1".repeat(32), requestHash: f.requestHash, runId: f.initial.runId,
    expectedVersion: f.initial.version, sourceRevisionHash: linearIssueRevisionHash(ISSUE), ...RESERVATION_FLAGS
  })
  assert.deepEqual(before.reservation, {
    reserved: true, requestHash: f.requestHash, runId: f.initial.runId, expectedVersion: f.initial.version,
    releaseAuthorized: false
  })
  return { writer, before }
}

async function crashedReservation(f) {
  const { writer, before } = await atReservation(f)
  writer.crash()
  await writer.exited("SIGKILL")
  return { pid: writer.pid, before }
}

// Compare names and opaque bytes. All semantic checks use the real ledger
// and canonical run readers in the restarted process.
async function snapshot(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return Object.fromEntries(await Promise.all(entries.map(async entry => {
    const path = join(entry.parentPath, entry.name)
    return [relative(root, path), entry.isDirectory() ? "directory" : await readFile(path, "hex")]
  })))
}

function registerTests() {
  test("RIC-192 uninterrupted control binds the reserved version by canonical CAS", TEST_OPTIONS, async t => {
    const f = await fixture(t)
    const { writer } = await atReservation(f)
    await writer.advance()
    const { run } = await writer.next("bound")
    await writer.exited()
    assert.deepEqual(run, await f.read())
    assert.equal(run.runId, f.initial.runId)
    assert.equal(run.version, f.initial.version + 1)
    assert.equal(run.status, f.initial.status)
    assert.deepEqual(run.evidence.planning.at(-1).metadata, {
      requestHash: f.requestHash, reservedVersion: f.initial.version, synthetic: true
    })
  })

  test("RIC-192 missing approval before durable reservation leaves no receipt or ledger entries", TEST_OPTIONS, async t => {
    const f = await fixture(t)
    const writer = await f.start("attempt", { approved: false })
    assert.equal((await writer.next("denied")).code, "PREFLIGHT_APPROVAL_REQUIRED")
    await writer.exited()
    assert.deepEqual(await snapshot(ledgerPath(f.root)), {})
    assert.deepEqual(await f.read(), f.initial)
  })

  test("RIC-192 SIGKILL after durable staging preserves a non-executable reservation across restart", TEST_OPTIONS, async t => {
    const f = await fixture(t)
    const { writer, before } = await atReservation(f)
    const onDisk = await snapshot(f.root)
    writer.crash()
    await writer.exited("SIGKILL")

    const reader = await f.start("inspect")
    const after = await reader.next("observed")
    await reader.exited()
    assert.notEqual(reader.pid, writer.pid)
    assert.deepEqual(after.reservation, before.reservation)
    assert.deepEqual(after.run, f.initial)
    assert.equal(after.claimCode, "LEDGER_CLAIM_MISSING")
    assert.ok(Object.values(after.run.evidence).every(entries => entries.length === 0))
    assert.deepEqual(await snapshot(f.root), onDisk)

    const replay = await f.start("race")
    const distinct = await f.start("race", { signed: f.fresh })
    await Promise.all([replay.next("preflight"), distinct.next("preflight")])
    await Promise.all([replay.advance(), distinct.advance()])
    for (const child of [replay, distinct]) {
      assert.equal((await child.next("denied")).code, "LEDGER_RUN_RESERVED")
      await child.exited()
    }
    assert.deepEqual(await f.read(), f.initial)
    assert.deepEqual(await snapshot(f.root), onDisk)
    t.diagnostic("writer " + writer.pid + " exited SIGKILL before CAS; restarted reader " + reader.pid +
      " verified run " + f.initial.runId + " at version " + f.initial.version + " and request " + f.requestHash)
    t.diagnostic("claim LEDGER_CLAIM_MISSING; concurrent original and distinct request LEDGER_RUN_RESERVED")
  })

  for (const [mode, suffix, bytes, code] of [
    ["incomplete", "complete.json.pending", "", "LEDGER_INCOMPLETE"],
    ["corrupt", "request.json", "{", "LEDGER_RECORD_INVALID"]
  ]) {
    test("RIC-192 " + mode + " durable slot refuses inspection and reuse after restart", TEST_OPTIONS, async t => {
      const f = await fixture(t)
      await crashedReservation(f)
      const slot = (await readdir(ledgerPath(f.root))).filter(name => name.startsWith("run-"))
      assert.equal(slot.length, 1)
      await writeFile(join(ledgerPath(f.root), slot[0], suffix), bytes, {
        mode: 0o600, flag: mode === "incomplete" ? "wx" : "w"
      })
      const damaged = await snapshot(ledgerPath(f.root))

      const reader = await f.start("invalid")
      const rejected = await reader.next("invalid")
      assert.equal(rejected.code, code)
      assert.deepEqual(rejected.run, f.initial)
      await reader.exited()

      const duplicate = await f.start("attempt", { signed: f.fresh })
      assert.equal((await duplicate.next("denied")).code, "LEDGER_RUN_RESERVED")
      await duplicate.exited()
      assert.deepEqual(await snapshot(ledgerPath(f.root)), damaged)
      assert.deepEqual(await f.read(), f.initial)
    })
  }

  test("RIC-192 baseline gap: the trusted canonical writer can advance without binding a reservation", TEST_OPTIONS, async t => {
    const f = await fixture(t)
    const { pid, before } = await crashedReservation(f)
    const onDisk = await snapshot(ledgerPath(f.root))
    const writer = await f.start("continue")
    assert.notEqual(writer.pid, pid)
    const result = await writer.next("continued")
    await writer.exited()
    assert.deepEqual(result.run, await f.read())
    assert.equal(result.run.runId, f.initial.runId)
    assert.equal(result.run.version, f.initial.version + 1)
    assert.equal(result.run.status, "implementation_ready")
    assert.deepEqual(result.run.evidence, f.initial.evidence)
    assert.equal(result.staleCode, "STALE_RUN_VERSION")
    assert.equal(result.replayCode, "PREFLIGHT_RUN_STALE")
    assert.deepEqual(result.reservation, before.reservation)
    assert.deepEqual(await snapshot(ledgerPath(f.root)), onDisk)
    t.diagnostic("trusted internal transition accepted version " + result.run.version +
      " with reservation still at version " + f.initial.version + "; no reservation-bound denial")
  })
}

if (process.argv[2] === CHILD && typeof process.send === "function") {
  await childMain()
} else {
  registerTests()
}
