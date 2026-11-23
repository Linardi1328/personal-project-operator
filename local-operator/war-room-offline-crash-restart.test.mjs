import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto"
import { on, once } from "node:events"
import fsPromises from "node:fs/promises"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  createDevelopmentRun, createOfflineReservationContinuation, readDevelopmentRun,
  recordDevelopmentRunProgress, transitionDevelopmentRun
} from "./development-run-state.mjs"
import { executeDevelopmentContinue, executeSoftwareFactoryImplementation } from "./development-continue-orchestrator.mjs"
import { executeSoftwareFactoryAutonomousRun } from "./software-factory-autonomous-run.mjs"
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

function observations(verifyOwnerApproval) {
  return {
    readIssue: () => ISSUE,
    resolveIssueProject: () => PROJECT,
    readRepo: () => ({
      projectId: PROJECT, branch: BRANCH, baseSha: BASE, headSha: BASE,
      reviewedCanonicalPath: true, isolatedWorktree: true
    }),
    readCatalogAdmission: () => ({ valid: true }), listActiveProjects: () => [PROJECT],
    verifyOwnerApproval
  }
}

function continuation(root, runId, expectedVersion, coordinatorPublicKey, verifyOwnerApproval, now = runOptions(root).now) {
  return createOfflineReservationContinuation({
    root, runId, expectedVersion, coordinatorPublicKey, approvedProjects: [PROJECT], now,
    ...observations(verifyOwnerApproval)
  })
}

async function createPlannedRun(options, evidence = []) {
  let run = await createDevelopmentRun(RUN_INPUT, options)
  for (const status of ["planning_in_progress", "planned"]) {
    run = await transitionDevelopmentRun(run.runId, { expectedVersion: run.version, status, actor: ACTOR, evidence }, options)
  }
  return run
}

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
    const { mode, root, signed, publicKey, approvalHashes, target } = await receive()
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
    const transition = () => transitionDevelopmentRun(runId, {
      expectedVersion, status: "implementation_ready", actor: ACTOR,
      reason: "Synthetic internal continuation boundary observation."
    }, options)
    let atPreflight = false
    const stage = () => stageOfflineAssignment(signed, {
      mode: "offline-staging-proof-only", ledger: ledgerConfig,
      preflight: {
        ...common, mode: "offline-preflight-only",
        ...observations(async binding => {
          if (!approvalHashes.includes(binding.requestHash)) return false
          if (mode === "race" && !atPreflight) {
            atPreflight = true
            await barrier("preflight")
          }
          return true
        })
      }
    })

    if (mode.startsWith("protected-")) {
      let approvalReads = 0
      let now = NOW
      const { bind } = continuation(root, target.runId, target.version, common.coordinatorPublicKey, async binding => {
        if (!approvalHashes.includes(binding.requestHash)) return false
        approvalReads += 1
        if (mode === "protected-race" && approvalReads === 1) await barrier("preflight")
        if (mode === "protected-before-bind" && approvalReads === 2) {
          await barrier("reserved", { reservation: await inspect() })
        }
        return true
      }, () => now)

      if (["protected-before-ack", "protected-expiry-before-publish", "protected-replay-index-crash"].includes(mode)) {
        const open = fsPromises.open
        const nonceHash = createHash("sha256").update(signed.payload.nonce).digest("hex")
        const noncePending = join(ledgerPath(root), "indexes", "nonce-" + nonceHash + ".json.pending")
        fsPromises.open = async (path, ...args) => {
          if (mode === "protected-replay-index-crash" && path === noncePending) {
            await barrier("before-index-pending")
            const file = await open(path, ...args)
            await file.sync()
            await barrier("index-pending")
            return file
          }
          const file = await open(path, ...args)
          if (mode === "protected-before-ack" && approvalReads === 2 &&
              path === join(options.writeDataDir, "development-runs", "records")) {
            // Pause after real canonical publication, before acknowledgment.
            const sync = file.sync.bind(file)
            file.sync = async () => {
              await sync()
              await barrier("mutation-committed")
            }
          }
          if (mode === "protected-expiry-before-publish" && approvalReads === 2 &&
              basename(path).startsWith(".ppo-development-run-version.")) {
            const sync = file.sync.bind(file)
            file.sync = async () => {
              await sync()
              now = signed.payload.expiresAt
            }
          }
          return file
        }
        syncBuiltinESMExports()
      }

      let result
      try { result = await bind(signed) } catch (error) {
        if (typeof error?.code !== "string" || error.code === "ERR_ASSERTION") throw error
        await send(process, { event: "denied", code: error.code })
        return
      }
      await send(process, { event: "bound", result })
      return
    }

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
        const run = await transition()
        const staleCode = await refusal(transition)
        const replayCode = await refusal(stage)
        await send(process, { event: "continued", run, reservation: await inspect(), staleCode, replayCode })
        break
      }
      case "scoped-raw":
        await send(process, { event: "denied", code: await refusal(transition) })
        break
      default:
        assert.fail("Unknown fixture operation")
    }
  } finally {
    await inbox.return()
    if (process.connected) process.disconnect()
  }
}

async function fixture(t, { scoped = false } = {}) {
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
  let initial = await createPlannedRun(options)

  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const approved = new Set()
  const endpoint = continuation(root, initial.runId, initial.version + 1, publicKey,
    binding => approved.has(binding.requestHash))
  initial = scoped ? await endpoint.prepare() : await transitionDevelopmentRun(initial.runId, {
    expectedVersion: initial.version, status: "implementation_in_progress", actor: ACTOR
  }, options)
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
  for (const hash of approvalHashes) approved.add(hash)

  async function start(mode, { signed = original, approved = true, target = initial, hashes = approvalHashes } = {}) {
    const child = fork(fileURLToPath(import.meta.url), [CHILD], {
      env: { TMPDIR: temp }, execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"]
    })
    const closed = once(child, "close")
    closed.catch(() => {})
    children.push({ child, closed })
    const messages = on(child, "message", { close: ["close"], signal: AbortSignal.timeout(TIMEOUT) })
    await send(child, { mode, root, signed, target: { runId: target.runId, version: target.version },
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      approvalHashes: approved ? hashes : [] })
    return {
      pid: child.pid,
      advance: () => send(child, "proceed"),
      async next(event) {
        const message = await messages.next()
        assert.equal(message.done, false, "Child closed before " + event)
        const [value] = message.value
        if (event) assert.equal(value.event, event)
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
    root, initial, requestHash, fresh, start, original, publicKey, options, bind: endpoint.bind,
    sign: changes => signRemoteEnvelope({ ...payload, ...changes }, "ppo-control-plane", privateKey),
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

function assertBound(run, f) {
  assert.equal(run.version, f.initial.version + 1)
  assert.equal(run.status, f.initial.status)
  assert.equal(run.history.at(-1).previousHistoryHash, f.initial.historyHash)
  assert.deepEqual(run.history.at(-1).evidence[0].metadata, {
    requestHash: f.requestHash, reservedVersion: f.initial.version, issueRevisionHash: linearIssueRevisionHash(ISSUE)
  })
}

async function assignmentWithSameNonce(f) {
  const run = await createPlannedRun(f.options)
  const signed = f.sign({
    runId: run.runId, requestId: f.fresh.payload.requestId, idempotencyKey: f.fresh.payload.idempotencyKey,
    approval: f.fresh.payload.approval
  })
  const requestHash = remotePayloadDigest(signed.payload)
  const endpoint = continuation(f.root, run.runId, run.version + 1, f.publicKey,
    binding => binding.requestHash === requestHash)
  return { prepared: await endpoint.prepare(), signed, requestHash, bind: endpoint.bind }
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

  test("RIC-193 binds the exact reservation in a canonical CAS and returns offline evidence", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    assert.equal(f.initial.version, 3)
    assert.deepEqual(await f.bind(f.original), {
      outcome: "bound-offline", version: 4, grant: false,
      requestId: f.original.payload.requestId, requestHash: f.requestHash, runId: f.initial.runId,
      expectedVersion: 3, sourceRevisionHash: linearIssueRevisionHash(ISSUE), ...RESERVATION_FLAGS
    })
    const bound = await f.read()
    assertBound(bound, f)
    const observer = await f.start("inspect")
    const { reservation, claimCode } = await observer.next("observed")
    await observer.exited()
    assert.equal(reservation.requestHash, f.requestHash)
    // A stale reservation cannot yield a current worker fence after binding.
    assert.equal(claimCode, "LEDGER_RUN_STALE")
    await assert.rejects(f.bind(f.original), { code: "PREFLIGHT_RUN_STALE" })
    await assert.rejects(transitionDevelopmentRun(bound.runId, {
      expectedVersion: bound.version, status: "implementation_ready", actor: ACTOR
    }, f.options), { code: "OFFLINE_ASSIGNMENT_REQUIRED" })
  })

  test("RIC-193 denies unbound continuation before and after a reservation-only process crash", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    const writer = await f.start("protected-before-bind")
    const { reservation } = await writer.next("reserved")
    assert.equal(reservation.requestHash, f.requestHash)
    const onDisk = await snapshot(ledgerPath(f.root))
    const { runId, version: expectedVersion } = f.initial
    await assert.rejects(transitionDevelopmentRun(runId, {
      expectedVersion, status: "implementation_ready", actor: ACTOR
    }, f.options), { code: "OFFLINE_ASSIGNMENT_REQUIRED" })
    assert.deepEqual(await f.read(), f.initial)
    writer.crash()
    await writer.exited("SIGKILL")

    const observer = await f.start("inspect")
    const observed = await observer.next("observed")
    await observer.exited()
    assert.deepEqual(observed.reservation, reservation)
    assert.equal(observed.claimCode, "LEDGER_CLAIM_MISSING")
    const restarted = await f.start("protected-bind")
    assert.deepEqual(await restarted.next("denied"), { event: "denied", code: "LEDGER_RUN_RESERVED" })
    await restarted.exited()
    await assert.rejects(f.bind(f.fresh), { code: "LEDGER_RUN_RESERVED" })

    const otherWriter = await f.start("scoped-raw")
    assert.deepEqual(await otherWriter.next("denied"), { event: "denied", code: "OFFLINE_ASSIGNMENT_REQUIRED" })
    await otherWriter.exited()
    await assert.rejects(recordDevelopmentRunProgress(runId, {
      expectedVersion, status: f.initial.status, actor: "war-room-offline-assignment-bind",
      evidence: [{
        kind: "planning", source: "war-room-offline-assignment-bind", sha: BASE,
        metadata: { requestHash: f.requestHash, reservedVersion: expectedVersion }
      }]
    }, { ...f.options, offlineAssignmentMutation: true, grant: true, reservation }), { code: "OFFLINE_ASSIGNMENT_REQUIRED" })
    const continued = await executeDevelopmentContinue(runId, f.options)
    assert.equal(continued.reason, "offline_assignment_only")
    assert.equal(continued.action, "none")
    assert.equal((await executeSoftwareFactoryImplementation(runId, { ...f.options, expectedVersion })).reason,
      "offline_assignment_only")
    assert.equal((await executeSoftwareFactoryAutonomousRun(runId, f.options)).reason, "offline_assignment_only")
    assert.deepEqual(await f.read(), f.initial)
    assert.deepEqual(await snapshot(ledgerPath(f.root)), onDisk)
    t.diagnostic("the scoped canonical writer denied version 3 → 4 while the version 3 reservation remained unbound")
  })

  test("RIC-193 two independent binders yield one durable reservation and canonical binding", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    const writers = await Promise.all([
      f.start("protected-race"), f.start("protected-race", { signed: f.fresh })
    ])
    await Promise.all(writers.map(writer => writer.next("preflight")))
    await Promise.all(writers.map(writer => writer.advance()))
    const results = await Promise.all(writers.map(writer => writer.next()))
    await Promise.all(writers.map(writer => writer.exited()))
    const winner = results.find(result => result.event === "bound")
    const loser = results.find(result => result.event === "denied")
    assert.ok(winner && loser)
    // The loser may first observe the already committed canonical version.
    assert.ok(["LEDGER_RUN_RESERVED", "LEDGER_RUN_STALE"].includes(loser.code))
    assertBound(await f.read(), { ...f, requestHash: winner.result.requestHash })
  })

  test("RIC-193 crash after canonical mutation and before acknowledgment never republishes the binding", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    const writer = await f.start("protected-before-ack")
    await writer.next("mutation-committed")
    const committed = await f.read()
    assertBound(committed, f)
    writer.crash()
    await writer.exited("SIGKILL")
    const restarted = await f.start("protected-bind")
    assert.deepEqual(await restarted.next("denied"), { event: "denied", code: "PREFLIGHT_RUN_STALE" })
    await restarted.exited()
    assert.deepEqual(await f.read(), committed)
  })

  test("RIC-193 refuses an unsigned receipt, altered signed fields, and a different coordinator key", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    const altered = structuredClone(f.original)
    altered.payload.scope.allowedPaths = ["different/"]
    for (const input of [altered, { grant: true, runId: f.initial.runId, requestHash: f.requestHash }]) {
      await assert.rejects(f.bind(input), { code: "STAGING_SIGNED_REQUEST_INVALID" })
    }
    const other = generateKeyPairSync("ed25519")
    const otherAssignment = signRemoteEnvelope(f.original.payload, "ppo-control-plane", other.privateKey)
    const { bind } = continuation(f.root, f.initial.runId, f.initial.version, other.publicKey, () => true)
    await assert.rejects(bind(otherAssignment), { code: "PREFLIGHT_RUN_STALE" })
    assert.deepEqual(await readdir(ledgerPath(f.root)), [])
    assert.deepEqual(await f.read(), f.initial)
  })

  test("RIC-193 requires exact signed run identity, refs, scope and independent approval", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    for (const [changes, code] of [
      [{ runId: "Z".repeat(43) }, "PREFLIGHT_RUN_STALE"],
      [{ expectedVersion: 4 }, "PREFLIGHT_RUN_STALE"],
      [{ projectId: "unrelated-project" }, "PREFLIGHT_PROJECT_DENIED"],
      [{ branch: "ppo/rivora/different" }, "PREFLIGHT_RUN_STALE"],
      [{ baseSha: "b".repeat(40) }, "PREFLIGHT_RUN_STALE"],
      [{ headSha: "b".repeat(40) }, "PREFLIGHT_RUN_STALE"],
      [{ scope: { ...f.original.payload.scope, permits: ["workspace.read", "workspace.write"] } }, "PREFLIGHT_APPROVAL_REQUIRED"],
      [{ approval: { ...f.original.payload.approval, ownerId: "another-owner" } }, "PREFLIGHT_APPROVAL_REQUIRED"]
    ]) {
      await assert.rejects(f.bind(f.sign(changes)), { code })
    }
    assert.deepEqual(await readdir(ledgerPath(f.root)), [])
    assert.deepEqual(await f.read(), f.initial)
  })

  test("RIC-193 refuses a nonce already spent on a different scoped run", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    await f.bind(f.original)
    const { prepared, signed, bind } = await assignmentWithSameNonce(f)
    await assert.rejects(bind(signed), { code: "LEDGER_REPLAY" })
    assert.deepEqual(await readDevelopmentRun(prepared.runId, f.options), prepared)
  })

  test("RIC-193 a shared replay index admits only one publishing writer across process crash", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    const { prepared, signed, requestHash, bind } = await assignmentWithSameNonce(f)
    const first = await f.start("protected-replay-index-crash", { target: prepared, signed, hashes: [requestHash] })
    await first.next("before-index-pending")
    const competitor = await f.start("protected-bind")
    assert.deepEqual(await competitor.next("denied"), { event: "denied", code: "LEDGER_REPLAY" })
    await competitor.exited()
    await first.advance()
    await first.next("index-pending")
    first.crash()
    await first.exited("SIGKILL")
    await assert.rejects(bind(signed), { code: "LEDGER_RUN_RESERVED" })
    await assert.rejects(f.bind(f.original), { code: "LEDGER_RUN_RESERVED" })
    assert.deepEqual(await f.read(), f.initial)
    assert.deepEqual(await readDevelopmentRun(prepared.runId, f.options), prepared)
  })

  test("RIC-193 checks expiry after syncing the temporary canonical marker", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    const writer = await f.start("protected-expiry-before-publish")
    assert.deepEqual(await writer.next("denied"), { event: "denied", code: "STAGING_REQUEST_EXPIRED" })
    await writer.exited()
    assert.deepEqual(await f.read(), f.initial)
    await assert.rejects(f.bind(f.original), { code: "LEDGER_RUN_RESERVED" })
  })

  test("RIC-193 a valid assignment keeps canonical history readable when the clock moves backward", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    const { bind } = continuation(f.root, f.initial.runId, f.initial.version, f.publicKey,
      binding => binding.requestHash === f.requestHash, () => "2026-11-11T05:01:30.000Z")
    assert.equal((await bind(f.original)).outcome, "bound-offline")
    const bound = await f.read()
    assertBound(bound, f)
    assert.equal(bound.timestamps.updatedAt, f.initial.timestamps.updatedAt)
  })

  test("RIC-193 rejects a bad allowlist before permanently scoping the planned run", TEST_OPTIONS, async t => {
    const f = await fixture(t)
    const planned = await createPlannedRun(f.options)
    const config = {
      root: f.root, runId: planned.runId, expectedVersion: planned.version + 1,
      coordinatorPublicKey: f.publicKey, now: f.options.now, ...observations(() => false)
    }
    for (const approvedProjects of [[], [PROJECT, PROJECT], ["INVALID"]]) {
      assert.throws(() => createOfflineReservationContinuation({ ...config, approvedProjects }),
        { code: "OFFLINE_ASSIGNMENT_CONFIG_INVALID" })
    }
    const wrongProject = createOfflineReservationContinuation({ ...config, approvedProjects: ["kynexa"] })
    await assert.rejects(wrongProject.prepare(), { code: "OFFLINE_ASSIGNMENT_PROJECT_DENIED" })
    assert.deepEqual(await readDevelopmentRun(planned.runId, f.options), planned)
  })

  test("RIC-193 refuses preparation when scope fits but the next binding would exceed record capacity", TEST_OPTIONS, async t => {
    const f = await fixture(t)
    const evidence = Array.from({ length: 8 }, () => ({
      kind: "planning", sha: BASE, summary: "x".repeat(500),
      metadata: { notes: Array(16).fill("x".repeat(200)), padding: "x".repeat(25) }
    }))
    const planned = await createPlannedRun(f.options, evidence)
    const endpoint = continuation(f.root, planned.runId, planned.version + 1, f.publicKey, () => false)
    await assert.rejects(endpoint.prepare(), { code: "RUN_RECORD_TOO_LARGE" })
    assert.deepEqual(await readDevelopmentRun(planned.runId, f.options), planned)
    assert.deepEqual(await readdir(ledgerPath(f.root)), [])
  })

  for (const [damage, code] of [
    ["missing-completion", "LEDGER_INCOMPLETE"],
    ["pending-completion", "LEDGER_INCOMPLETE"],
    ["corrupt-request", "LEDGER_RECORD_INVALID"],
    ["contradictory-index", "LEDGER_RECORD_INVALID"],
    ["expired", "STAGING_REQUEST_EXPIRED"]
  ]) {
    test("RIC-193 refuses reservation state " + damage + " before canonical publication", TEST_OPTIONS, async t => {
      const f = await fixture(t, { scoped: true })
      const key = createHash("sha256").update(f.initial.runId + ":" + f.initial.version).digest("hex")
      const slot = join(ledgerPath(f.root), "run-" + key)
      let approvalReads = 0
      let now = NOW
      const { bind } = continuation(f.root, f.initial.runId, f.initial.version, f.publicKey, async binding => {
        assert.equal(binding.requestHash, f.requestHash)
        if (++approvalReads !== 2) return true
        if (damage === "missing-completion") await rm(join(slot, "complete.json"))
        if (damage === "pending-completion") await writeFile(join(slot, "complete.json.pending"), "", { mode: 0o600 })
        if (damage === "corrupt-request") await writeFile(join(slot, "request.json"), "{{", { mode: 0o600 })
        if (damage === "contradictory-index") {
          const indexes = join(ledgerPath(f.root), "indexes")
          const nonceIndex = (await readdir(indexes)).find(name => name.startsWith("nonce-"))
          const path = join(indexes, nonceIndex)
          const record = JSON.parse(await readFile(path))
          await writeFile(path, JSON.stringify({ ...record, expectedVersion: f.initial.version + 1 }), { mode: 0o600 })
        }
        if (damage === "expired") now = f.original.payload.expiresAt
        return true
      }, () => now)
      await assert.rejects(bind(f.original), { code })
      assert.equal(approvalReads, 2)
      assert.deepEqual(await f.read(), f.initial)
      await assert.rejects(f.bind(f.original), { code: "LEDGER_RUN_RESERVED" })
    })
  }

  test("RIC-193 respects stale canonical versions and refuses conflicting record history", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    await assert.rejects(recordDevelopmentRunProgress(f.initial.runId, {
      expectedVersion: f.initial.version - 1, actor: ACTOR
    }, f.options), { code: "STALE_RUN_VERSION" })
    const recordPath = join(f.options.writeDataDir, "development-runs", "records", f.initial.runId + ".json")
    await writeFile(recordPath, JSON.stringify({ ...f.initial, historyHash: "f".repeat(64) }), { mode: 0o600 })
    await assert.rejects(f.bind(f.original), { code: "PREFLIGHT_TRUSTED_READ_UNAVAILABLE" })
    assert.deepEqual(await readdir(ledgerPath(f.root)), [])
  })

  test("RIC-193 requires the canonical refs to agree with the same-version immutable marker", TEST_OPTIONS, async t => {
    const f = await fixture(t, { scoped: true })
    const headSha = "b".repeat(40)
    const recordPath = join(f.options.writeDataDir, "development-runs", "records", f.initial.runId + ".json")
    await writeFile(recordPath, JSON.stringify({ ...f.initial, headSha }), { mode: 0o600 })
    const signed = f.sign({ headSha })
    const config = observations(binding => binding.requestHash === remotePayloadDigest(signed.payload))
    const readRepo = () => ({ ...config.readRepo(), headSha })
    const { bind } = createOfflineReservationContinuation({
      root: f.root, runId: f.initial.runId, expectedVersion: f.initial.version,
      coordinatorPublicKey: f.publicKey, approvedProjects: [PROJECT], now: f.options.now,
      ...config, readRepo
    })
    await assert.rejects(bind(signed), { code: "PREFLIGHT_TRUSTED_READ_UNAVAILABLE" })
    assert.deepEqual(await readdir(ledgerPath(f.root)), [])
  })

  test("RIC-193 assignment path refuses an ordinary run and ordinary writers preserve lifecycle behavior", TEST_OPTIONS, async t => {
    const f = await fixture(t)
    await assert.rejects(f.bind(f.original), { code: "PREFLIGHT_RUN_STALE" })
    assert.deepEqual(await readdir(ledgerPath(f.root)), [])
    const progress = await recordDevelopmentRunProgress(f.initial.runId, {
      expectedVersion: f.initial.version, status: f.initial.status, actor: ACTOR
    }, f.options)
    const next = await transitionDevelopmentRun(progress.runId, {
      expectedVersion: progress.version, status: "implementation_ready", actor: ACTOR
    }, f.options)
    assert.equal(next.version, f.initial.version + 2)
    assert.equal(next.status, "implementation_ready")
  })
}

if (process.argv[2] === CHILD && typeof process.send === "function") {
  await childMain()
} else {
  registerTests()
}
