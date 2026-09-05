import assert from "node:assert/strict"
import { chmod, mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  DevelopmentOperationLeaseError,
  acquireDevelopmentOperationLease,
  discardStaleDevelopmentOperationLease,
  inspectDevelopmentOperationLease,
  releaseDevelopmentOperationLease,
  relinquishDevelopmentOperationLease
} from "./development-operation-lease.mjs"

const RUN_ID = "L".repeat(43)
const HEAD_SHA = "a".repeat(40)

async function tempWriteDataDir() {
  return await mkdtemp(join(tmpdir(), "ppo-operation-lease-"))
}

function target(overrides = {}) {
  return {
    runId: RUN_ID,
    phase: "6D",
    action: "phase-6d-codex-implementation",
    attempt: 1,
    headSha: HEAD_SHA,
    ...overrides
  }
}

test("development operation lease binds one live owner to exact phase attempt and SHA", async () => {
  const writeDataDir = await tempWriteDataDir()
  const now = () => new Date("2026-09-05T00:00:00.000Z")
  const lease = await acquireDevelopmentOperationLease(target(), { writeDataDir, now })
  const inspected = await inspectDevelopmentOperationLease(RUN_ID, {
    writeDataDir,
    now,
    processProbe: (pid) => pid === process.pid
  })

  assert.equal(inspected.active, true)
  assert.equal(inspected.lease.phase, "6D")
  assert.equal(inspected.lease.attempt, 1)
  assert.equal(inspected.lease.headSha, HEAD_SHA)
  assert.equal((await stat(join(
    writeDataDir,
    "development-runs/operation-leases",
    `${RUN_ID}.json`
  ))).mode & 0o777, 0o600)

  await assert.rejects(
    acquireDevelopmentOperationLease(target(), {
      writeDataDir,
      now,
      processProbe: () => true
    }),
    (error) => error instanceof DevelopmentOperationLeaseError && error.code === "OPERATION_LEASE_HELD"
  )

  assert.equal(await releaseDevelopmentOperationLease(lease, { writeDataDir }), true)
  assert.equal((await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })).exists, false)
})

test("relinquished operation lease is recoverable only for its exact target", async () => {
  const writeDataDir = await tempWriteDataDir()
  const lease = await acquireDevelopmentOperationLease(target(), { writeDataDir })

  await relinquishDevelopmentOperationLease(lease, { writeDataDir })
  const inspected = await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })

  assert.equal(inspected.exists, true)
  assert.equal(inspected.active, false)
  assert.equal(inspected.stale, true)
  await assert.rejects(
    discardStaleDevelopmentOperationLease(RUN_ID, {
      phase: "6E",
      attempt: 1,
      headSha: HEAD_SHA
    }, { writeDataDir }),
    (error) => error instanceof DevelopmentOperationLeaseError && error.code === "OPERATION_LEASE_NOT_STALE"
  )

  assert.equal(await discardStaleDevelopmentOperationLease(RUN_ID, target(), { writeDataDir }), true)
  assert.equal((await inspectDevelopmentOperationLease(RUN_ID, { writeDataDir })).exists, false)
})

test("a dead exact owner lease must be discarded before the next phase attempt", async () => {
  const writeDataDir = await tempWriteDataDir()
  const first = await acquireDevelopmentOperationLease(target(), { writeDataDir })

  await relinquishDevelopmentOperationLease(first, { writeDataDir })
  await assert.rejects(
    acquireDevelopmentOperationLease(target({
      phase: "6E",
      action: "phase-6e-automated-tests",
      attempt: 2
    }), { writeDataDir }),
    (error) => error instanceof DevelopmentOperationLeaseError && error.code === "OPERATION_LEASE_HELD"
  )
  await discardStaleDevelopmentOperationLease(RUN_ID, target(), { writeDataDir })
  const second = await acquireDevelopmentOperationLease(target({
    phase: "6E",
    action: "phase-6e-automated-tests",
    attempt: 2
  }), { writeDataDir })

  assert.notEqual(second.token, first.token)
  assert.equal(second.phase, "6E")
  assert.equal(second.attempt, 2)
  await releaseDevelopmentOperationLease(second, { writeDataDir })
})

test("operation lease inspection rejects a file with non-private permissions", async () => {
  const writeDataDir = await tempWriteDataDir()
  await acquireDevelopmentOperationLease(target(), { writeDataDir })
  const leasePath = join(
    writeDataDir,
    "development-runs/operation-leases",
    `${RUN_ID}.json`
  )

  await chmod(leasePath, 0o644)
  await assert.rejects(
    inspectDevelopmentOperationLease(RUN_ID, { writeDataDir }),
    (error) => error instanceof DevelopmentOperationLeaseError && error.code === "OPERATION_LEASE_INVALID"
  )
})
