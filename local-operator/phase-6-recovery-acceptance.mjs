#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DevelopmentOperationLeaseError, acquireDevelopmentOperationLease, inspectDevelopmentOperationLease } from "./development-operation-lease.mjs"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const SELF = fileURLToPath(import.meta.url)
const WAIT_MS = 15_000
const RUN_ID = "R".repeat(43)

export const RECOVERY_ACCEPTANCE_CASES = Object.freeze([
  { id: "OWN-01", suite: null, pattern: null, timing: "real-process" },
  { id: "OWN-02", suite: "development-operation-lease.test.mjs", pattern: "recoverable only|non-private permissions", timing: "fixture-clock" },
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

function childResult(command, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: "ignore" })
    const timer = setTimeout(() => child.kill("SIGKILL"), WAIT_MS)
    child.once("exit", (code, signal) => { clearTimeout(timer); resolveResult(code === 0 && signal === null) })
    child.once("error", () => { clearTimeout(timer); resolveResult(false) })
  })
}

async function testedRevision() {
  const chunks = []
  const child = spawn("git", ["rev-parse", "HEAD"], { cwd: ROOT, shell: false, stdio: ["ignore", "pipe", "ignore"] })
  child.stdout.on("data", (chunk) => chunks.push(chunk))
  const ok = await new Promise((resolveResult) => child.once("exit", (code) => resolveResult(code === 0)))
  const revision = Buffer.concat(chunks).toString("utf8").trim()
  assert.equal(ok && /^[a-f0-9]{40}$/u.test(revision), true)
  return revision
}

async function ownedChildCase(revision) {
  const writeDataDir = await mkdtemp(join(tmpdir(), "ppo-recovery-acceptance-"))
  const child = spawn(process.execPath, [SELF, "--lease-child", writeDataDir, RUN_ID, revision], {
    shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"]
  })
  const ready = await new Promise((resolveReady) => {
    const timer = setTimeout(() => resolveReady(false), WAIT_MS)
    child.once("message", (message) => { clearTimeout(timer); resolveReady(message === "ready") })
    child.once("exit", () => { clearTimeout(timer); resolveReady(false) })
  })
  if (!ready) return { ok: false, reason: "readiness-failed" }
  const before = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })
  let duplicateRefused = false
  try {
    await acquireDevelopmentOperationLease({ runId: RUN_ID, phase: "6D", action: "recovery-acceptance", attempt: 1, headSha: revision }, { writeDataDir })
  } catch (error) {
    duplicateRefused = error instanceof DevelopmentOperationLeaseError && error.code === "OPERATION_LEASE_HELD"
  }
  child.kill("SIGTERM")
  await new Promise((resolveExit) => child.once("exit", resolveExit))
  const after = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })
  const ok = before.active && duplicateRefused && after.stale
  if (ok) await rm(writeDataDir, { recursive: true })
  return { ok, reason: ok ? "owned-child-refused-then-stale" : "ownership-invariant-failed" }
}

async function runSuite(entry) {
  return await childResult(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${entry.pattern}`,
    join(ROOT, "local-operator", entry.suite)], { cwd: ROOT })
}

async function main() {
  const revision = await testedRevision()
  const results = []
  const ownership = await ownedChildCase(revision)
  results.push(boundedResult(RECOVERY_ACCEPTANCE_CASES[0], ownership.ok ? "PASS" : "FAIL", revision, ownership.reason))
  for (const entry of RECOVERY_ACCEPTANCE_CASES.slice(1, -1)) {
    const ok = await runSuite(entry)
    results.push(boundedResult(entry, ok ? "PASS" : "FAIL", revision, ok ? "fixture-contract-satisfied" : "fixture-contract-failed"))
  }
  const mac = RECOVERY_ACCEPTANCE_CASES.at(-1)
  results.push(boundedResult(mac, process.platform === "darwin" && ownership.ok ? "PASS" : "SKIP", revision,
    process.platform === "darwin" ? "dead-owner-real-time-stale" : "unsupported-host"))
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`)
  if (results.some(({ outcome }) => outcome !== "PASS")) process.exitCode = 1
}

if (process.argv[2] === "--lease-child") {
  const [, , , writeDataDir, runId, headSha] = process.argv
  await acquireDevelopmentOperationLease({ runId, phase: "6D", action: "recovery-acceptance", attempt: 1, headSha }, { writeDataDir })
  process.send?.("ready")
  setInterval(() => {}, 1_000)
} else if (process.argv[1] === SELF) {
  await main()
}
