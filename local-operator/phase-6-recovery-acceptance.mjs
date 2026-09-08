#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { fixture, read, advance, git, options } from "./phase-6-acceptance-fixture.mjs"
import { inspectDevelopmentOperationLease } from "./development-operation-lease.mjs"
import { recoverOrphanedCodexExecution } from "./development-codex-execution-adapter.mjs"
import { recoverOrphanedAutomatedTesting } from "./development-test-runner.mjs"
import { recoverReviewOrphan } from "./development-review-orphan-recovery.mjs"
import { REVIEW_ORPHAN_RECOVERY_CONFIRMATION } from "./development-run-state.mjs"

const SELF = fileURLToPath(import.meta.url)
const ROOT = fileURLToPath(new URL("../", import.meta.url))
export const RECOVERY_ACCEPTANCE_CASES = Object.freeze([
  "OWN-01", "OWN-02", "6D-EDIT", "6D-COMMIT", "6D-NOCHANGE", "6D-REFUSE",
  "6E-OPEN", "6F-RESERVED", "6F-REFUSE", "6F-MISSING", "6F-FINDINGS", "HARD-01", "REPLAY-01", "MAC-STALE"
])
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const failureDetails = new WeakMap()
function acceptanceError(reason, childReason) {
  const error = new Error(childReason ? `${reason}: ${childReason}` : reason)
  failureDetails.set(error, { reason, ...(childReason ? { childReason } : {}) })
  return error
}
export function readinessFailureCode(value) {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/u.test(value)
    ? value : "unclassified"
}
async function bounded(promise, ms, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(acceptanceError(label)), ms)
  })]) } finally { clearTimeout(timer) }
}

// Listeners are attached before signalling. Every exit path observes close.
export async function withOwnedChild(f, mode, operation, hooks = {}) {
  const child = spawn(process.execPath, [SELF, "--fixture-child"], {
    shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH }
  })
  let closed = false
  child.on("error", () => {})
  const exit = new Promise(resolve => child.once("close", (code, signal) => { closed = true; resolve({ code, signal }) }))
  const ready = new Promise((resolve, reject) => {
    child.once("message", m => m === "ready" ? resolve()
      : reject(acceptanceError("readiness-failed", readinessFailureCode(m?.code))))
    child.once("error", () => reject(acceptanceError("child-process-error")))
    child.once("exit", () => reject(acceptanceError("exit-before-ready")))
  })
  ready.catch(() => {})
  const stop = async () => {
    if (!closed) {
      child.kill("SIGTERM")
      try { await bounded(exit, 2000, "term-timeout") }
      catch { child.kill("SIGKILL"); await bounded(exit, 2000, "cleanup-timeout") }
    }
    return exit
  }
  try {
    hooks.spawned?.(child)
    child.send({ f, mode }, () => {})
    await bounded(ready, hooks.readyTimeoutMs || 15000, "ready-timeout")
    await hooks.ready?.(child)
    return await operation({ child, stop })
  } finally { await stop(); assert.equal(closed, true) }
}

export async function verifyTestedSource(expectedRevision) {
  assert.match(expectedRevision || "", /^[a-f0-9]{40}$/u)
  assert.equal(await git(["rev-parse", "HEAD"], ROOT), expectedRevision)
  assert.equal(await git(["status", "--porcelain=v1", "--untracked-files=all"], ROOT), "")
  return expectedRevision
}

async function refused(f, invoke) {
  const before = await read(f)
  assert.equal((await invoke()).ok, false)
  assert.deepEqual(await read(f), before)
}

async function replay(f, before) {
  const opts = { ...options(f, 61000), expectedVersion: before.version, expectedHeadSha: before.headSha,
    expectedAttempt: f.phase === "6E" ? before.attempts.test : before.attempts.implementation }
  const current = await read(f)
  const call = f.phase === "6F"
    ? () => recoverReviewOrphan({ runId: f.runId, expectedVersion: before.version, expectedHeadSha: before.headSha,
      expectedReviewAttempt: before.attempts.review, confirmation: REVIEW_ORPHAN_RECOVERY_CONFIRMATION }, opts)
    : () => (f.phase === "6E" ? recoverOrphanedAutomatedTesting : recoverOrphanedCodexExecution)(f.runId, opts)
  await assert.rejects(call)
  assert.deepEqual(await read(f), current)
}

export async function runCase(id, revision, hooks = {}) {
  assert.ok(RECOVERY_ACCEPTANCE_CASES.includes(id))
  if (id === "MAC-STALE" && process.platform !== "darwin") return "SKIP"
  if (id === "6F-MISSING" || id === "6F-FINDINGS") {
    const f = await fixture(ROOT, revision, id === "6F-FINDINGS" ? "HARD" : "6F", { missingTestEvidence: id === "6F-MISSING" })
    const before = await read(f)
    let passed = false
    try {
      if (id === "6F-MISSING") {
        let invoked = false
        await refused(f, () => advance(f, () => { invoked = true; throw Error("Must not invoke reviewer") }))
        assert.equal(invoked, false)
      }
      await assert.rejects(() => recoverReviewOrphan({ runId: f.runId, expectedVersion: before.version,
        expectedHeadSha: before.headSha, expectedReviewAttempt: Math.max(1, before.attempts.review),
        confirmation: REVIEW_ORPHAN_RECOVERY_CONFIRMATION }, options(f, 61000)))
      assert.deepEqual(await read(f), before)
      passed = true
      return "PASS"
    } finally { if (passed) await rm(f.temp, { recursive: true }) }
  }
  const phase = id.startsWith("6E") || id === "REPLAY-01" ? "6E" : id.startsWith("6F") ? "6F" : id === "HARD-01" ? "HARD" : "6D"
  const f = await fixture(ROOT, revision, phase)
  let passed = false
  try {
    const mode = id === "6D-COMMIT" ? "commit" : id === "6D-REFUSE" ? "mixed" : id === "6D-NOCHANGE" || id.startsWith("OWN") || id === "MAC-STALE" ? "nochange" : "edit"
    await withOwnedChild(f, mode, async ({ child, stop }) => {
      const open = await read(f)
      const lease = await inspectDevelopmentOperationLease(f.runId, options(f))
      assert.equal(lease.lease.ownerPid, child.pid)
      assert.equal(lease.active, true)
      assert.equal(lease.lease.headSha, open.headSha)
      await refused(f, () => advance(f))
      await hooks.afterReservation?.(f)
      assert.equal((await stop()).signal, "SIGTERM")
      assert.equal((await inspectDevelopmentOperationLease(f.runId, options(f))).stale, true)
      await refused(f, () => advance(f))
      if (id === "OWN-02") {
        const path = join(f.writeDataDir, "development-runs", "operation-leases", `${f.runId}.json`)
        const original = await readFile(path, "utf8")
        for (const replacement of [JSON.stringify({ ...JSON.parse(original), headSha: "0".repeat(40) }), "{malformed", null]) {
          if (replacement === null) await rm(path)
          else await writeFile(path, replacement, { mode: 0o600 })
          await refused(f, () => advance(f, undefined, 61000))
        }
        await writeFile(path, original, { mode: 0o600 })
      }
      if (id === "6D-REFUSE") { await refused(f, () => advance(f, undefined, 61000)); return }
      if (id === "6F-REFUSE") {
        await writeFile(join(f.location.workspacePath, "unexpected.txt"), "dirty\n")
        await refused(f, () => advance(f, undefined, 61000))
        await rm(join(f.location.workspacePath, "unexpected.txt"))
      }
      if (id === "MAC-STALE") await delay(61000)
      const result = await advance(f, undefined, id === "MAC-STALE" ? 0 : 61000)
      assert.equal(result.ok, true, JSON.stringify(result))
      const after = await read(f)
      assert.deepEqual(after.attempts, open.attempts)
      assert.ok(after.version > open.version)
      if (phase === "6D" || phase === "HARD") {
        assert.equal(after.status, mode === "nochange" ? "implementation_in_progress" : "implementation_ready")
        if (mode !== "nochange") {
          assert.equal(await git(["status", "--porcelain"], f.location.workspacePath), "")
          assert.equal(await git(["rev-list", "--count", `${open.headSha}..HEAD`], f.location.workspacePath), "1")
          assert.equal(await readFile(join(f.location.workspacePath, "interrupted.txt"), "utf8"), `${revision}\n`)
        }
      } else if (phase === "6E") {
        assert.equal(after.evidence.test.at(-1).metadata.outcome, "failed")
        assert.equal(after.evidence.test.at(-1).metadata.ambiguous, 1)
        assert.equal(after.evidence.test.some(e => e.metadata.outcome === "passed"), false)
      } else {
        assert.equal(after.status, "tests_passed")
        assert.deepEqual(after.evidence.test, open.evidence.test)
        assert.equal(after.evidence.review.some(e => e.metadata.decision === "APPROVED"), false)
      }
      if (phase === "HARD") {
        assert.equal(open.evidence.implementation.filter(e => e.metadata.outcome === "hardening_started").length, 1)
        assert.equal(after.evidence.implementation.filter(e => e.metadata.outcome === "hardening_started").length, 1)
        assert.ok(after.evidence.implementation.some(e => e.metadata.resultingSha === after.headSha))
      }
      await replay(f, open)
      if (phase === "6E") {
        let steps = 0
        const retried = await advance(f, async () => { steps++; return { exitCode: 0, stdout: "", stderr: "" } }, 62000)
        assert.equal(retried.ok, true, JSON.stringify(retried))
        assert.equal((await read(f)).status, "tests_passed")
        assert.equal(steps, 2)
        assert.equal((await read(f)).attempts.test, open.attempts.test + 1)
      }
    }, hooks)
    passed = true
    return "PASS"
  } finally {
    // Failed fixtures are retained. Successful cleanup follows observed child exit.
    if (passed) await rm(f.temp, { recursive: true })
  }
}

export async function acceptanceCaseResult(id, revision, execute = runCase) {
  assert.ok(RECOVERY_ACCEPTANCE_CASES.includes(id))
  let outcome, details = {}
  try {
    outcome = await execute(id, revision)
    assert.ok(["PASS", "FAIL", "SKIP"].includes(outcome))
    if (outcome === "SKIP") details = { reason: "unsupported-host" }
    if (outcome === "FAIL") details = { reason: "case-failed" }
  } catch (error) {
    outcome = "FAIL"
    details = failureDetails.get(error) || { reason: "case-failed" }
  }
  return { id, outcome, revision, platform: process.platform,
    timing: id === "MAC-STALE" ? "real-time" : "real-process+fixture-clock",
    adapter: "deterministic-model-and-sandbox-boundary", ...details }
}

export async function main(expectedRevision) {
  const revision = await verifyTestedSource(expectedRevision)
  for (const id of RECOVERY_ACCEPTANCE_CASES) {
    const result = await acceptanceCaseResult(id, revision)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.outcome !== "PASS") process.exitCode = 1
  }
}

if (process.argv[1] === SELF && process.argv[2] === "--fixture-child" && process.send) {
  process.once("message", async ({ f, mode }) => {
    try {
      if (mode === "fail-before-ready") {
        throw Object.assign(new Error("fixture startup failure"), { code: "FIXTURE_PRE_READY_FAILURE" })
      }
      const result = await advance(f, async () => {
        if (f.phase === "6D" || f.phase === "HARD") {
          if (mode !== "nochange") await writeFile(join(f.location.workspacePath, "interrupted.txt"), `${f.revision}\n`)
          if (mode === "commit" || mode === "mixed") {
            await git(["add", "interrupted.txt"], f.location.workspacePath)
            await git(["commit", "-m", "fixture interrupted implementation"], f.location.workspacePath)
          }
          if (mode === "mixed") await writeFile(join(f.location.workspacePath, "partial.txt"), "unfinished\n")
        }
        if (mode === "ignore-term") process.on("SIGTERM", () => {})
        if (mode !== "silent") process.send("ready")
        setInterval(() => {}, 1000)
        await new Promise(() => {})
      })
      process.send({ type: "failed", code: readinessFailureCode(result?.reason || result?.outcome) })
    } catch (error) {
      process.send({ type: "failed", code: readinessFailureCode(error?.code) })
    }
  })
} else if (process.argv[1] === SELF) {
  try {
    assert.equal(process.argv.length, 4)
    assert.equal(process.argv[2], "--expected-revision")
    await main(process.argv[3])
  } catch { process.stderr.write("recovery acceptance refused: invalid-command-or-source\n"); process.exitCode = 1 }
}
