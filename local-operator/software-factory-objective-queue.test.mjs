import assert from "node:assert/strict"
import { lstat, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  claimSoftwareFactoryQueuedObjective,
  completeSoftwareFactoryQueuedObjective,
  enqueueSoftwareFactoryObjective,
  listSoftwareFactoryQueuedObjectives,
  releaseSoftwareFactoryQueueClaim,
  formatSoftwareFactoryObjectiveQueue
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


test("post-publication queue durability failure is ambiguous and request remains visible", async () => {
  const options = await fixture()

  await assert.rejects(
    enqueueSoftwareFactoryObjective({
      projectId: "kynexa",
      objective: "Fix the approved capacity-safe defect."
    }, {
      ...options,
      syncDirectoryImpl: async () => {
        throw new Error("simulated directory fsync failure")
      }
    }),
    (error) => (
      error?.code === "FACTORY_QUEUE_DURABILITY_AMBIGUOUS" &&
      error?.stateCommitted === true
    )
  )

  const pending = await listSoftwareFactoryQueuedObjectives(options)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].projectId, "kynexa")
})

test("claim revalidates stored request instead of trusting tampered queue content", async () => {
  const options = await fixture()
  const queued = await enqueueSoftwareFactoryObjective({
    projectId: "kynexa",
    objective: "Fix the approved registration defect."
  }, options)
  const requestPath = join(
    options.writeDataDir,
    "software-factory-objective-queue",
    "requests",
    `${queued.queueId}.json`
  )
  await writeFile(requestPath, JSON.stringify({
    schemaVersion: 1,
    queueId: queued.queueId,
    projectId: "kynexa",
    objective: "tampered objective",
    objectiveHash: queued.objectiveHash,
    queuedAt: queued.queuedAt
  }), "utf8")

  await assert.rejects(
    claimSoftwareFactoryQueuedObjective(queued.queueId, options),
    (error) => error?.code === "FACTORY_QUEUE_CORRUPT"
  )
})

test("new queue directory ancestry is synchronized before request publication", async () => {
  const options = await fixture()
  let parentSyncs = 0

  await enqueueSoftwareFactoryObjective({
    projectId: "rivora",
    objective: "Fix the approved event page defect."
  }, {
    ...options,
    syncParentDirectoryImpl: async () => {
      parentSyncs += 1
    }
  })

  assert.equal(parentSyncs, 4)
})


test("queue view exposes metadata without objective text", async () => {
  const output = formatSoftwareFactoryObjectiveQueue([{
    queueId: "Q".repeat(32),
    projectId: "kynexa",
    objective: "Sensitive business objective that should not be echoed.",
    objectiveHash: "a".repeat(64),
    queuedAt: "2026-10-08T06:00:00.000Z",
    claimed: false
  }])

  assert.match(output, /Project: kynexa/u)
  assert.match(output, /Objective hash: a{64}/u)
  assert.doesNotMatch(output, /Sensitive business objective/u)
})


test("empty queue listing is read-only and does not create queue storage", async () => {
  const options = await fixture()
  const queueRoot = join(options.writeDataDir, "software-factory-objective-queue")

  assert.equal((await listSoftwareFactoryQueuedObjectives(options)).length, 0)
  await assert.rejects(
    lstat(queueRoot),
    (error) => error?.code === "ENOENT"
  )
})
