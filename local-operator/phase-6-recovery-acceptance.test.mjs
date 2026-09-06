import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { RECOVERY_ACCEPTANCE_CASES, terminateOwnedChild } from "./phase-6-recovery-acceptance.mjs"

test("recovery acceptance matrix is bounded and covers every required boundary", () => {
  assert.equal(RECOVERY_ACCEPTANCE_CASES.length, 12)
  assert.deepEqual(RECOVERY_ACCEPTANCE_CASES.map(({ id }) => id), [
    "OWN-01", "OWN-02", "6D-EDIT", "6D-COMMIT", "6D-NOCHANGE", "6D-REFUSE",
    "6E-OPEN", "6F-RESERVED", "6F-REFUSE", "HARD-01", "REPLAY-01", "MAC-STALE"
  ])
})

test("runner uses owned children, bounded waits, exact revision, and no broad process search", async () => {
  const source = await readFile(new URL("./phase-6-recovery-acceptance.mjs", import.meta.url), "utf8")
  assert.match(source, /spawn\(process\.execPath/u)
  assert.match(source, /ready\.args\[0\] !== "ready"/u)
  assert.match(source, /WAIT_MS = 15_000/u)
  assert.match(source, /git", \["rev-parse", "HEAD"\]/u)
  assert.doesNotMatch(source, /pgrep|pkill|killall/u)
  assert.match(source, /outcome !== "PASS"/u)
})

test("owned child termination bounds signal failure, exit timeout, and cleanup observation", async () => {
  class FakeChild extends EventEmitter {
    exitCode = null
    signalCode = null
    signals = []
    kill(signal) { this.signals.push(signal); return this.behavior(signal) }
  }

  const failed = new FakeChild()
  failed.behavior = () => false
  assert.deepEqual(await terminateOwnedChild(failed, { waitMs: 5 }), { ok: false, reason: "signal-failed" })

  const escalated = new FakeChild()
  escalated.behavior = (signal) => {
    if (signal === "SIGKILL") setTimeout(() => escalated.emit("exit", null, "SIGKILL"), 1)
    return true
  }
  assert.deepEqual(await terminateOwnedChild(escalated, { waitMs: 5 }), { ok: false, reason: "exit-timeout-killed-observed" })
  assert.deepEqual(escalated.signals, ["SIGTERM", "SIGKILL"])
})

test("runner emits only the bounded matrix schema, exact SHA, and nonzero required SKIP", async () => {
  const script = fileURLToPath(new URL("./phase-6-recovery-acceptance.mjs", import.meta.url))
  const child = spawn(process.execPath, [script, "--test-skip-mac"], { shell: false, stdio: ["ignore", "pipe", "pipe"] })
  const stdout = []
  const stderr = []
  child.stdout.on("data", (chunk) => stdout.push(chunk))
  child.stderr.on("data", (chunk) => stderr.push(chunk))
  const [code] = await new Promise((resolve) => child.once("exit", (...args) => resolve(args)))
  assert.equal(code, 1, Buffer.concat(stderr).toString("utf8"))
  const lines = Buffer.concat(stdout).toString("utf8").trim().split("\n").map(JSON.parse)
  assert.equal(lines.length, RECOVERY_ACCEPTANCE_CASES.length)
  const revision = lines[0].revision
  assert.match(revision, /^[a-f0-9]{40}$/u)
  for (const [index, result] of lines.entries()) {
    assert.deepEqual(Object.keys(result).sort(), ["adapter", "id", "outcome", "platform", "reason", "revision", "timing"].sort())
    assert.equal(result.id, RECOVERY_ACCEPTANCE_CASES[index].id)
    assert.equal(result.revision, revision)
    assert.match(result.reason, /^[a-z0-9-]+$/u)
  }
  assert.equal(lines.slice(0, -1).every(({ outcome }) => outcome === "PASS"), true)
  assert.equal(lines.at(-1).outcome, "SKIP")
})
