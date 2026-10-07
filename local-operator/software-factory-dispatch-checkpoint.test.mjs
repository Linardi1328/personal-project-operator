import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createDevelopmentRun,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  assessSoftwareFactoryDispatchResume,
  readSoftwareFactoryDispatchCheckpoint,
  recordSoftwareFactoryDispatchCheckpoint
} from "./software-factory-dispatch-checkpoint.mjs"

function makeClock(start = "2026-10-07T10:00:00.000Z") {
  let tick = 0
  const base = Date.parse(start)

  return () => {
    const value = new Date(base + tick * 1000)
    tick += 1
    return value
  }
}

async function makePlannedRun() {
  const root = await mkdtemp(join(tmpdir(), "ppo-factory-checkpoint-"))
  const writeDataDir = join(root, "write-data")
  const now = makeClock()
  const sha = "a".repeat(40)
  const created = await createDevelopmentRun({
    projectId: "khlim-digital-ecosystem",
    task: "Fix the current approved browser acceptance blocker.",
    baseSha: sha,
    branch: "main",
    headSha: sha,
    actor: "factory-test"
  }, {
    writeDataDir,
    now
  })
  const planning = await transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress",
    actor: "factory-test"
  }, {
    writeDataDir,
    now
  })
  const planned = await transitionDevelopmentRun(created.runId, {
    expectedVersion: planning.version,
    status: "planned",
    actor: "factory-test"
  }, {
    writeDataDir,
    now
  })

  return { writeDataDir, now, run: planned }
}

function observation({
  capacity = "available",
  integration = "configured",
  workerId = "antigravity",
  sourceId = "owner-observation",
  observedAt = "2026-10-07T10:00:03.000Z"
} = {}) {
  return {
    workerId,
    integration,
    capacity,
    sourceId,
    observedAt
  }
}

test("exhausted Antigravity capacity persists without changing the development run or attempts", async () => {
  const fixture = await makePlannedRun()
  const before = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  const checkpoint = await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 0,
    observation: observation({ capacity: "exhausted" })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z")
  })

  const after = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(checkpoint.dispatch.outcome, "blocked_capacity")
  assert.equal(checkpoint.dispatch.reasonCode, "WORKER_CAPACITY_EXHAUSTED")
  assert.equal(checkpoint.dispatch.consumeAttempt, false)
  assert.equal(checkpoint.workerId, "antigravity")
  assert.deepEqual(checkpoint.skills, ["ui-ux-pro-max"])
  assert.equal(after.status, before.status)
  assert.equal(after.version, before.version)
  assert.deepEqual(after.attempts, before.attempts)
})

test("rate limited capacity is also a non-attempt checkpoint", async () => {
  const fixture = await makePlannedRun()
  const checkpoint = await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "debugging",
    expectedCheckpointVersion: 0,
    observation: observation({ capacity: "rate_limited" })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z")
  })

  assert.equal(checkpoint.dispatch.outcome, "blocked_capacity")
  assert.equal(checkpoint.dispatch.consumeAttempt, false)
  assert.deepEqual(checkpoint.skills, ["debugging-and-error-recovery"])
})

test("stale available observation fails closed instead of yielding ready", async () => {
  const fixture = await makePlannedRun()
  const checkpoint = await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0,
    observation: observation({
      capacity: "available",
      observedAt: "2026-10-07T09:00:00.000Z"
    })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z")
  })

  assert.equal(checkpoint.observation.fresh, false)
  assert.equal(checkpoint.dispatch.outcome, "blocked_external")
  assert.equal(checkpoint.dispatch.reasonCode, "WORKER_CAPACITY_UNKNOWN")
  assert.equal(checkpoint.dispatch.consumeAttempt, false)
})

test("capacity observation must match the reviewed worker for the capability", async () => {
  const fixture = await makePlannedRun()

  await assert.rejects(
    recordSoftwareFactoryDispatchCheckpoint({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "implementation.frontend",
      expectedCheckpointVersion: 0,
      observation: observation({ workerId: "chatgpt" })
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T10:00:04.000Z")
    }),
    (error) => error?.code === "FACTORY_OBSERVATION_WORKER_MISMATCH"
  )
})

test("stale development-run version is refused", async () => {
  const fixture = await makePlannedRun()

  await assert.rejects(
    recordSoftwareFactoryDispatchCheckpoint({
      runId: fixture.run.runId,
      runVersion: fixture.run.version - 1,
      capability: "implementation.backend",
      expectedCheckpointVersion: 0,
      observation: observation()
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T10:00:04.000Z")
    }),
    (error) => error?.code === "FACTORY_RUN_VERSION_STALE"
  )
})

test("stale checkpoint writer is refused", async () => {
  const fixture = await makePlannedRun()

  await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0,
    observation: observation({ capacity: "exhausted" })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z")
  })

  await assert.rejects(
    recordSoftwareFactoryDispatchCheckpoint({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "implementation.backend",
      expectedCheckpointVersion: 0,
      observation: observation({ capacity: "available" })
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T10:00:05.000Z")
    }),
    (error) => error?.code === "FACTORY_CHECKPOINT_VERSION_STALE"
  )
})

test("concurrent first writers cannot overwrite the same checkpoint version", async () => {
  const fixture = await makePlannedRun()
  const inputs = [0, 1].map((offset) => recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0,
    observation: observation({
      capacity: offset === 0 ? "exhausted" : "rate_limited"
    })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z")
  }))

  const results = await Promise.allSettled(inputs)
  const fulfilled = results.filter((result) => result.status === "fulfilled")
  const rejected = results.filter((result) => result.status === "rejected")

  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason?.code, "FACTORY_CHECKPOINT_VERSION_STALE")

  const latest = await readSoftwareFactoryDispatchCheckpoint(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(latest.checkpointVersion, 1)
})

test("fresh capacity can be assessed as resumable after a blocked checkpoint", async () => {
  const fixture = await makePlannedRun()

  const blocked = await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 0,
    observation: observation({ capacity: "exhausted" })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z")
  })

  const resume = await assessSoftwareFactoryDispatchResume({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    observation: observation({
      capacity: "available",
      observedAt: "2026-10-07T10:05:00.000Z"
    })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:05:01.000Z")
  })

  assert.equal(blocked.dispatch.outcome, "blocked_capacity")
  assert.equal(resume.ok, true)
  assert.equal(resume.dispatch.outcome, "ready")
  assert.equal(resume.previousCheckpointVersion, 1)
})

test("fresh available observation can replace blocked checkpoint using optimistic versioning", async () => {
  const fixture = await makePlannedRun()

  await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 0,
    observation: observation({ capacity: "exhausted" })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z")
  })

  const ready = await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 1,
    observation: observation({
      capacity: "available",
      observedAt: "2026-10-07T10:05:00.000Z"
    })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:05:01.000Z")
  })

  assert.equal(ready.checkpointVersion, 2)
  assert.equal(ready.dispatch.outcome, "ready")
  assert.equal(ready.dispatch.consumeAttempt, true)
})

test("changing the capability for an existing checkpoint is refused", async () => {
  const fixture = await makePlannedRun()

  await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0,
    observation: observation({ capacity: "exhausted" })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z")
  })

  await assert.rejects(
    recordSoftwareFactoryDispatchCheckpoint({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "debugging",
      expectedCheckpointVersion: 1,
      observation: observation({ capacity: "available" })
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T10:05:01.000Z")
    }),
    (error) => error?.code === "FACTORY_CHECKPOINT_BINDING_MISMATCH"
  )
})


test("post-publication durability failure is ambiguous and requires reconciliation", async () => {
  const fixture = await makePlannedRun()

  await assert.rejects(
    recordSoftwareFactoryDispatchCheckpoint({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "implementation.backend",
      expectedCheckpointVersion: 0,
      observation: observation({ capacity: "exhausted" })
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T10:00:04.000Z"),
      syncDirectoryImpl: async () => {
        throw new Error("simulated directory sync failure")
      }
    }),
    (error) => (
      error?.code === "FACTORY_CHECKPOINT_DURABILITY_AMBIGUOUS" &&
      error?.stateCommitted === true
    )
  )

  const reconciled = await readSoftwareFactoryDispatchCheckpoint(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(reconciled.checkpointVersion, 1)
  assert.equal(reconciled.dispatch.outcome, "blocked_capacity")
})


test("checkpoint directory failures map to a safe store-unavailable error", async () => {
  const fixture = await makePlannedRun()

  await assert.rejects(
    recordSoftwareFactoryDispatchCheckpoint({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "implementation.backend",
      expectedCheckpointVersion: 0,
      observation: observation({ capacity: "exhausted" })
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T10:00:04.000Z"),
      ensureCheckpointDirectoryImpl: async () => {
        const error = new Error("/private/secret/path")
        error.code = "EACCES"
        throw error
      }
    }),
    (error) => (
      error?.code === "FACTORY_CHECKPOINT_STORE_UNAVAILABLE" &&
      error?.safeMessage === "Software factory dispatch checkpoint store is unavailable."
    )
  )
})


test("first checkpoint creation synchronizes new store and run directory entries", async () => {
  const fixture = await makePlannedRun()
  const synced = []

  await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0,
    observation: observation({ capacity: "exhausted" })
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T10:00:04.000Z"),
    syncDirectoryImpl: async (path) => {
      synced.push(path)
    }
  })

  assert.ok(synced.includes(fixture.writeDataDir))
  assert.ok(synced.some((path) => path.endsWith("software-factory-dispatch-checkpoints")))
  assert.ok(synced.some((path) => path.endsWith(fixture.run.runId)))
})
