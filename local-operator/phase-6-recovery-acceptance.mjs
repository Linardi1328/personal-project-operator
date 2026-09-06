#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_DEVELOPMENT_OPERATION_LEASE_AGE_MS, DevelopmentOperationLeaseError, acquireDevelopmentOperationLease, discardStaleDevelopmentOperationLease, inspectDevelopmentOperationLease } from "./development-operation-lease.mjs"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const SELF = fileURLToPath(import.meta.url)
export const WAIT_MS = 15_000
const RUN_ID = "R".repeat(43)

export const RECOVERY_ACCEPTANCE_CASES = Object.freeze([
  { id: "OWN-01", suite: null, pattern: null, timing: "real-process" },
  { id: "OWN-02", suite: null, pattern: null, timing: "real-process+fixture-clock" },
  { id: "6D-EDIT", suite: "development-codex-execution-adapter.test.mjs", pattern: "preserves a dirty exact-start", timing: "real-process" },
  { id: "6D-COMMIT", suite: "development-codex-execution-adapter.test.mjs", pattern: "adopts one clean descendant", timing: "real-process" },
  { id: "6D-NOCHANGE", suite: "development-codex-execution-adapter.test.mjs", pattern: "orphaned no-change", timing: "real-process" },
  { id: "6D-REFUSE", suite: "development-codex-execution-adapter.test.mjs", pattern: "refuses mixed committed|workspace HEAD must match", timing: "real-process" },
  { id: "6E-OPEN", suite: "development-test-runner.test.mjs", pattern: "orphaned automated testing", timing: "real-process" },
  { id: "6F-RESERVED", suite: "development-review-agent.test.mjs", pattern: "orphan recovery closes", timing: "real-process" },
  { id: "6F-REFUSE", suite: "development-review-agent.test.mjs", pattern: "requires tests_passed|valid blockers", timing: "real-process" },
  { id: "HARD-01", suite: "development-hardening-orchestrator.test.mjs", pattern: "ambiguous Codex, test, and review|maximum three hardening", timing: "real-process" },
  { id: "REPLAY-01", suite: "development-test-runner.test.mjs", pattern: "only one final PASS|invalidates prior PASS", timing: "real-process" },
  { id: "MAC-STALE", suite: null, pattern: null, timing: "real-time" }
])

function boundedResult(entry, outcome, revision, reason) {
  return { id: entry.id, outcome, revision, platform: process.platform, timing: entry.timing,
    adapter: entry.id.startsWith("OWN") || entry.id === "MAC-STALE" ? "none" : "deterministic-no-network", reason }
}

function waitForEvent(child, event, waitMs = WAIT_MS) {
  return new Promise((resolveEvent) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener(event, onEvent)
      child.removeListener("error", onError)
      resolveEvent(value)
    }
    const onEvent = (...args) => finish({ ok: true, args })
    const onError = () => finish({ ok: false, reason: "child-error" })
    const timer = setTimeout(() => finish({ ok: false, reason: `${event}-timeout` }), waitMs)
    child.once(event, onEvent)
    child.once("error", onError)
  })
}

export async function terminateOwnedChild(child, options = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return { ok: true, reason: "already-exited" }
  let signalled
  try { signalled = child.kill("SIGTERM") } catch { return { ok: false, reason: "signal-failed" } }
  if (!signalled) return { ok: false, reason: "signal-failed" }
  let exited = await waitForEvent(child, "exit", options.waitMs)
  if (exited.ok) return { ok: true, reason: "terminated-observed" }
  try { signalled = child.kill("SIGKILL") } catch { return { ok: false, reason: "exit-timeout" } }
  if (!signalled) return { ok: false, reason: "exit-timeout" }
  exited = await waitForEvent(child, "exit", options.waitMs)
  return exited.ok ? { ok: false, reason: "exit-timeout-killed-observed" } : { ok: false, reason: "cleanup-timeout" }
}

async function childResult(command, args, options = {}) {
  const child = spawn(command, args, { ...options, shell: false, stdio: "ignore" })
  const exited = await waitForEvent(child, "exit")
  if (!exited.ok) { await terminateOwnedChild(child); return false }
  return exited.args[0] === 0 && exited.args[1] === null
}

async function gitOutput(args) {
  const chunks = []
  const child = spawn("git", args, { cwd: ROOT, shell: false, stdio: ["ignore", "pipe", "ignore"] })
  child.stdout.on("data", (chunk) => chunks.push(chunk))
  const exited = await waitForEvent(child, "exit")
  assert.equal(exited.ok && exited.args[0] === 0, true)
  return Buffer.concat(chunks).toString("utf8").trim()
}

export async function verifyTestedSource(expectedRevision) {
  assert.match(expectedRevision || "", /^[a-f0-9]{40}$/u)
  const revision = await gitOutput(["rev-parse", "HEAD"])
  assert.equal(revision, expectedRevision)
  assert.equal(await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]), "")
  return revision
}

async function startOwnedChild(writeDataDir, revision) {
  const child = spawn(process.execPath, [SELF, "--lease-child", writeDataDir, RUN_ID, revision], { shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] })
  const ready = await waitForEvent(child, "message")
  if (!ready.ok || ready.args[0] !== "ready") {
    const cleanup = await terminateOwnedChild(child)
    return { child, ok: false, reason: cleanup.ok ? "readiness-failed" : cleanup.reason }
  }
  return { child, ok: true }
}

async function interruptFixture(revision, verifyDuplicate = false) {
  const writeDataDir = await mkdtemp(join(tmpdir(), "ppo-recovery-acceptance-"))
  const started = await startOwnedChild(writeDataDir, revision)
  if (!started.ok) return { ok: false, reason: started.reason }
  const before = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })
  let duplicateRefused = true
  if (verifyDuplicate) {
    try {
      await acquireDevelopmentOperationLease({ runId: RUN_ID, phase: "6D", action: "recovery-acceptance", attempt: 1, headSha: revision }, { writeDataDir })
      duplicateRefused = false
    } catch (error) { duplicateRefused = error instanceof DevelopmentOperationLeaseError && error.code === "OPERATION_LEASE_HELD" }
  }
  const stopped = await terminateOwnedChild(started.child)
  const after = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })
  const ok = before.active && duplicateRefused && stopped.ok && after.stale
  if (ok) await rm(writeDataDir, { recursive: true })
  return { ok, reason: ok ? "owned-child-interrupted-observed" : (stopped.reason || "ownership-invariant-failed") }
}

async function ownershipRefusals(revision) {
  const writeDataDir = await mkdtemp(join(tmpdir(), "ppo-recovery-ownership-"))
  const snapshot = async () => {
    const inspected = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })
    return JSON.stringify(inspected)
  }
  try {
    // Missing leases must never be invented by inspection or stale discard.
    const missingBefore = await snapshot()
    const missing = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })
    const missingDiscarded = await discardStaleDevelopmentOperationLease(RUN_ID, {
      phase: "6D", attempt: 1, headSha: revision
    }, { writeDataDir })
    const missingAfter = await snapshot()
    if (missing.exists || missingDiscarded || missingBefore !== missingAfter) return { ok: false, reason: "missing-lease-mutated" }

    const started = await startOwnedChild(writeDataDir, revision)
    if (!started.ok) return { ok: false, reason: started.reason }
    const freshBefore = await snapshot()
    let freshRefused = false
    try {
      await acquireDevelopmentOperationLease({ runId: RUN_ID, phase: "6D", action: "different", attempt: 1, headSha: revision }, { writeDataDir })
    } catch (error) { freshRefused = error instanceof DevelopmentOperationLeaseError && error.code === "OPERATION_LEASE_HELD" }
    const freshAfter = await snapshot()
    const stopped = await terminateOwnedChild(started.child)
    if (!freshRefused || freshBefore !== freshAfter || !stopped.ok) return { ok: false, reason: "fresh-lease-not-refused" }

    const stale = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })
    const mismatchedBefore = await snapshot()
    let mismatchRefused = false
    try {
      await acquireDevelopmentOperationLease({ runId: RUN_ID, phase: "6E", action: "different", attempt: 2, headSha: revision }, { writeDataDir })
    } catch (error) { mismatchRefused = error instanceof DevelopmentOperationLeaseError }
    if (!stale.stale || !mismatchRefused || mismatchedBefore !== await snapshot()) return { ok: false, reason: "mismatched-lease-not-refused" }

    const leasePath = join(writeDataDir, "development-runs", "operation-leases", `${RUN_ID}.json`)
    await writeFile(leasePath, "{malformed", { mode: 0o600 })
    await chmod(leasePath, 0o600)
    const malformedBefore = await gitOutputForFile(leasePath)
    let malformedRefused = false
    try { await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir }) } catch (error) { malformedRefused = error instanceof DevelopmentOperationLeaseError }
    if (!malformedRefused || malformedBefore !== await gitOutputForFile(leasePath)) return { ok: false, reason: "malformed-lease-not-refused" }
    await rm(writeDataDir, { recursive: true })
    return { ok: true, reason: "all-lease-refusals-observed" }
  } catch { return { ok: false, reason: "ownership-refusal-check-failed" } }
}

async function gitOutputForFile(path) {
  return readFile(path, "utf8")
}

async function runSuite(entry) {
  return childResult(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${entry.pattern}`, join(ROOT, "local-operator", entry.suite)], { cwd: ROOT })
}

async function runMacStale(revision) {
  if (process.platform !== "darwin") return { outcome: "SKIP", reason: "unsupported-host" }
  const writeDataDir = await mkdtemp(join(tmpdir(), "ppo-recovery-macos-stale-"))
  const started = await startOwnedChild(writeDataDir, revision)
  if (!started.ok) return { outcome: "FAIL", reason: started.reason }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, MAX_DEVELOPMENT_OPERATION_LEASE_AGE_MS + 50))
  const stale = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })
  const stopped = await terminateOwnedChild(started.child)
  const ok = stale.stale && stopped.ok
  if (ok) await rm(writeDataDir, { recursive: true })
  return { outcome: ok ? "PASS" : "FAIL", reason: ok ? "configured-real-time-threshold-stale" : stopped.reason }
}

export async function main(options = {}) {
  const revision = await verifyTestedSource(options.expectedRevision)
  const results = []
  for (const entry of RECOVERY_ACCEPTANCE_CASES.slice(0, -1)) {
    const interruption = entry.id === "OWN-02"
      ? await ownershipRefusals(revision)
      : await interruptFixture(revision, entry.id === "OWN-01")
    const contract = interruption.ok && (entry.suite === null || await runSuite(entry))
    results.push(boundedResult(entry, contract ? "PASS" : "FAIL", revision,
      contract ? "interrupted-fixture-recovery-contract-satisfied" : interruption.ok ? "fixture-contract-failed" : interruption.reason))
  }
  const mac = RECOVERY_ACCEPTANCE_CASES.at(-1)
  const macResult = options.skipMac === true
    ? { outcome: "SKIP", reason: "test-mode-host-check-not-run" }
    : await runMacStale(revision)
  results.push(boundedResult(mac, macResult.outcome, revision, macResult.reason))
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`)
  if (results.some(({ outcome }) => outcome !== "PASS")) process.exitCode = 1
}

if (process.argv[2] === "--lease-child") {
  const [, , , writeDataDir, runId, headSha] = process.argv
  await acquireDevelopmentOperationLease({ runId, phase: "6D", action: "recovery-acceptance", attempt: 1, headSha }, { writeDataDir })
  process.send?.("ready")
  setInterval(() => {}, 1_000)
} else if (process.argv[1] === SELF) {
  const args = process.argv.slice(2)
  const revisionIndex = args.indexOf("--expected-revision")
  const expectedRevision = revisionIndex >= 0 ? args[revisionIndex + 1] : null
  try { await main({ expectedRevision, skipMac: args.includes("--test-skip-mac") }) }
  catch { process.stderr.write("recovery acceptance refused: source-revision-mismatch-or-dirty\n"); process.exitCode = 1 }
}
