import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { RECOVERY_ACCEPTANCE_CASES, terminateOwnedChild, verifyTestedSource } from "./phase-6-recovery-acceptance.mjs"

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
  assert.match(source, /verifyTestedSource\(options\.expectedRevision\)/u)
  assert.match(source, /status", "--porcelain=v1", "--untracked-files=all"/u)
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

test("runner requires an explicit expected SHA and fails closed on mismatch or a dirty tree", async () => {
  await assert.rejects(verifyTestedSource("0".repeat(40)))
  const script = fileURLToPath(new URL("./phase-6-recovery-acceptance.mjs", import.meta.url))
  const child = spawn(process.execPath, [script, "--test-skip-mac"], { shell: false, stdio: ["ignore", "pipe", "pipe"] })
  const stdout = []
  const stderr = []
  child.stdout.on("data", (chunk) => stdout.push(chunk))
  child.stderr.on("data", (chunk) => stderr.push(chunk))
  const [code] = await new Promise((resolve) => child.once("exit", (...args) => resolve(args)))
  assert.equal(code, 1)
  assert.equal(Buffer.concat(stdout).toString("utf8"), "")
  assert.equal(Buffer.concat(stderr).toString("utf8"), "recovery acceptance refused: source-revision-mismatch-or-dirty\n")
})
