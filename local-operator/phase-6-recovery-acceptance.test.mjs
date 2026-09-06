import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { RECOVERY_ACCEPTANCE_CASES } from "./phase-6-recovery-acceptance.mjs"

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
  assert.match(source, /message === "ready"/u)
  assert.match(source, /WAIT_MS = 15_000/u)
  assert.match(source, /git", \["rev-parse", "HEAD"\]/u)
  assert.doesNotMatch(source, /pgrep|pkill|killall/u)
  assert.match(source, /outcome !== "PASS"/u)
})
