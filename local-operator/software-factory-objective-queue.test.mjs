import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  claimSoftwareFactoryQueuedObjective,
  completeSoftwareFactoryQueuedObjective,
  enqueueSoftwareFactoryObjective,
  listSoftwareFactoryQueuedObjectives,
  releaseSoftwareFactoryQueueClaim
} from "./software-factory-objective-queue.mjs"

async function fixture() {
  return {
    writeDataDir: await mkdtemp(join(tmpdir(), "ppo-factory-queue-"))
  }
}

test("queues and lists a bounded manager objective", async () => {
  const options = await fixture()
  const queued = await enqueueSoftwareFactoryObjective({
    projectId: "kynexa",
    objective: "Fix the approved registration workflow defect."
  }, options)
  const pending = await listSoftwareFactoryQueuedObjectives(options)
  assert.equal(queued.outcome, "queued")
  assert.equal(pending.length, 1)
  assert.equal(pending[0].queueId, queued.queueId)
  assert.equal(pending[0].claimed, false)
})

test("deduplicates identical pending project objectives", async () => {
  const options = await fixture()
  const first = await enqueueSoftwareFactoryObjective({
    projectId: "rivora",
    objective: "Fix the approved schedule filtering defect."
  }, options)
  const second = await enqueueSoftwareFactoryObjective({
    projectId: "rivora",
    objective: "Fix the approved schedule filtering defect."
  }, options)
  assert.equal(second.outcome, "already_queued")
  assert.equal(second.queueId, first.queueId)
})

test("claim is exclusive and completion removes item from pending list", async () => {
  const options = await fixture()
  const queued = await enqueueSoftwareFactoryObjective({
    projectId: "axiom-quantum",
    objective: "Add the approved bounded reporting validation."
  }, options)

  await claimSoftwareFactoryQueuedObjective(queued.queueId, options)
  await assert.rejects(
    claimSoftwareFactoryQueuedObjective(queued.queueId, options),
    (error) => error?.code === "FACTORY_QUEUE_CONFLICT"
  )
  await completeSoftwareFactoryQueuedObjective(queued.queueId, {
    outcome: "release_ready",
    runId: "A".repeat(43),
    reason: null
  }, options)
  assert.equal((await listSoftwareFactoryQueuedObjectives(options)).length, 0)
})

test("claim can be released before any durable run exists", async () => {
  const options = await fixture()
  const queued = await enqueueSoftwareFactoryObjective({
    projectId: "kynexa",
    objective: "Implement the approved bounded UI fix."
  }, options)
  await claimSoftwareFactoryQueuedObjective(queued.queueId, options)
  assert.equal(await releaseSoftwareFactoryQueueClaim(queued.queueId, options), true)
  const pending = await listSoftwareFactoryQueuedObjectives(options)
  assert.equal(pending[0].claimed, false)
})

test("completed claims cannot be released", async () => {
  const options = await fixture()
  const queued = await enqueueSoftwareFactoryObjective({
    projectId: "kynexa",
    objective: "Implement the approved bounded backend fix."
  }, options)
  await claimSoftwareFactoryQueuedObjective(queued.queueId, options)
  await completeSoftwareFactoryQueuedObjective(queued.queueId, {
    outcome: "blocked_capacity",
    runId: "B".repeat(43),
    reason: "worker_capacity_exhausted"
  }, options)
  await assert.rejects(
    releaseSoftwareFactoryQueueClaim(queued.queueId, options),
    (error) => error?.code === "FACTORY_QUEUE_ALREADY_COMPLETED"
  )
})
