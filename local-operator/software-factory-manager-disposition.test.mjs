import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  SOFTWARE_FACTORY_TRANSIENT_RETRY_MS,
  readSoftwareFactoryManagerDisposition,
  recordSoftwareFactoryManagerDisposition,
  shouldExecuteSoftwareFactoryManagedRun
} from "./software-factory-manager-disposition.mjs"

const RUN_ID = "A".repeat(43)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ppo-manager-disposition-"))
  return { writeDataDir: join(root, "write-data") }
}

function input(overrides = {}) {
  return {
    runId: RUN_ID,
    runVersion: 12,
    projectId: "kynexa",
    status: "implementation_in_progress",
    outcome: "blocked_capacity",
    reason: "worker_capacity_exhausted",
    ...overrides
  }
}

test("owner-action disposition remains parked until run version changes", async () => {
  const f = await fixture()
  const record = await recordSoftwareFactoryManagerDisposition(input({
    outcome: "owner_action_required",
    reason: "human_decision_required"
  }), {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T08:00:00.000Z")
  })

  assert.equal(record.retryAfter, null)
  assert.deepEqual(
    shouldExecuteSoftwareFactoryManagedRun(record, {
      now: () => new Date("2026-10-09T08:00:00.000Z")
    }),
    {
      execute: false,
      reason: "parked_until_run_version_changes"
    }
  )

  const nextVersion = await readSoftwareFactoryManagerDisposition(RUN_ID, 13, {
    writeDataDir: f.writeDataDir
  })
  assert.equal(nextVersion, null)
  assert.equal(shouldExecuteSoftwareFactoryManagedRun(nextVersion).execute, true)
})

test("release-ready disposition is parked without rebuilding release evidence", async () => {
  const f = await fixture()
  const record = await recordSoftwareFactoryManagerDisposition(input({
    status: "merge_ready",
    outcome: "release_ready",
    reason: "human_release_approval_required"
  }), {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T08:00:00.000Z")
  })

  assert.equal(record.retryAfter, null)
  assert.equal(shouldExecuteSoftwareFactoryManagedRun(record).execute, false)
})

test("capacity block waits one hour before becoming retryable", async () => {
  const f = await fixture()
  const recordedAt = new Date("2026-10-08T08:00:00.000Z")
  const record = await recordSoftwareFactoryManagerDisposition(input(), {
    writeDataDir: f.writeDataDir,
    now: () => recordedAt
  })

  assert.equal(
    record.retryAfter,
    new Date(recordedAt.getTime() + SOFTWARE_FACTORY_TRANSIENT_RETRY_MS).toISOString()
  )
  assert.equal(
    shouldExecuteSoftwareFactoryManagedRun(record, {
      now: () => new Date("2026-10-08T08:59:59.999Z")
    }).execute,
    false
  )
  assert.deepEqual(
    shouldExecuteSoftwareFactoryManagedRun(record, {
      now: () => new Date("2026-10-08T09:00:00.000Z")
    }),
    { execute: true, reason: "transient_retry_due" }
  )
})

test("blocked external state uses the same conservative retry floor", async () => {
  const f = await fixture()
  const record = await recordSoftwareFactoryManagerDisposition(input({
    outcome: "blocked_external",
    reason: "worker_unavailable"
  }), {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T08:00:00.000Z")
  })

  assert.equal(
    shouldExecuteSoftwareFactoryManagedRun(record, {
      now: () => new Date("2026-10-08T08:30:00.000Z")
    }).reason,
    "transient_retry_not_due"
  )
})

test("non-parking outcomes do not create disposition records", async () => {
  const f = await fixture()
  const record = await recordSoftwareFactoryManagerDisposition(input({
    outcome: "complete",
    reason: null
  }), {
    writeDataDir: f.writeDataDir
  })
  assert.equal(record, null)
  assert.equal(
    await readSoftwareFactoryManagerDisposition(RUN_ID, 12, {
      writeDataDir: f.writeDataDir
    }),
    null
  )
})

test("latest append-only disposition wins within one run version", async () => {
  const f = await fixture()
  await recordSoftwareFactoryManagerDisposition(input(), {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T08:00:00.000Z")
  })
  await recordSoftwareFactoryManagerDisposition(input({
    outcome: "owner_action_required",
    reason: "human_decision_required"
  }), {
    writeDataDir: f.writeDataDir,
    now: () => new Date("2026-10-08T09:00:00.000Z")
  })

  const latest = await readSoftwareFactoryManagerDisposition(RUN_ID, 12, {
    writeDataDir: f.writeDataDir
  })
  assert.equal(latest.sequence, 2)
  assert.equal(latest.outcome, "owner_action_required")
})

test("invalid free-form reason is refused instead of persisted", async () => {
  const f = await fixture()
  await assert.rejects(
    recordSoftwareFactoryManagerDisposition(input({
      reason: "raw /private/path token=secret"
    }), {
      writeDataDir: f.writeDataDir
    }),
    (error) => error?.code === "FACTORY_MANAGER_DISPOSITION_INVALID"
  )
})
