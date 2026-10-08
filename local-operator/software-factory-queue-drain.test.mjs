import assert from "node:assert/strict"
import test from "node:test"
import {
  createSoftwareFactoryQueueDrainer
} from "./software-factory-queue-drain.mjs"

const QUEUE_ID = "Q".repeat(32)
const RUN_ID = "R".repeat(43)

function item(overrides = {}) {
  return {
    schemaVersion: 1,
    queueId: QUEUE_ID,
    projectId: "kynexa",
    objective: "Fix the approved registration defect.",
    objectiveHash: "a".repeat(64),
    queuedAt: "2026-10-08T06:00:00.000Z",
    claimed: false,
    ...overrides
  }
}

function catalog(active = []) {
  return {
    ok: true,
    code: "ok",
    active,
    diagnostics: { truncated: false }
  }
}

test("returns queue_empty without creating work", async () => {
  const drain = createSoftwareFactoryQueueDrainer({
    async listQueue() { return [] }
  })
  const result = await drain()
  assert.equal(result.outcome, "queue_empty")
})

test("parks queue when WIP is full without claiming", async () => {
  let claims = 0
  const drain = createSoftwareFactoryQueueDrainer({
    async listQueue() { return [item()] },
    async listRuns() {
      return catalog([
        { project: "rivora", runId: "A".repeat(43), terminal: false, recoveryRequired: false },
        { project: "axiom-quantum", runId: "B".repeat(43), terminal: false, recoveryRequired: false }
      ])
    },
    async claim() { claims += 1 }
  })
  const result = await drain()
  assert.equal(result.outcome, "blocked_work_in_progress")
  assert.equal(claims, 0)
})

test("launches one admitted queued objective and records its durable run", async () => {
  const calls = []
  const drain = createSoftwareFactoryQueueDrainer({
    async listQueue() { return [item()] },
    async listRuns() { return catalog([]) },
    async claim(queueId) { calls.push(["claim", queueId]) },
    async complete(queueId, result) { calls.push(["complete", queueId, result]) },
    async intake(projectId, objective) {
      calls.push(["intake", projectId, objective])
      return { runId: RUN_ID, projectId, status: "planned" }
    },
    async runFactory(runId) {
      calls.push(["run", runId])
      return { ok: true, outcome: "release_ready", reason: "human_release_approval_required" }
    }
  })
  const result = await drain()
  assert.equal(result.outcome, "release_ready")
  assert.equal(result.runId, RUN_ID)
  assert.deepEqual(calls[0], ["claim", QUEUE_ID])
  assert.deepEqual(calls[1], ["intake", "kynexa", "Fix the approved registration defect."])
  assert.deepEqual(calls[2], ["run", RUN_ID])
  assert.equal(calls[3][0], "complete")
  assert.equal(calls[3][2].runId, RUN_ID)
})

test("claimed item without result stops for reconciliation", async () => {
  let claims = 0
  const drain = createSoftwareFactoryQueueDrainer({
    async listQueue() { return [item({ claimed: true })] },
    async claim() { claims += 1 }
  })
  const result = await drain()
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "queue_claim_reconciliation_required")
  assert.equal(claims, 0)
})

test("runner crash after intake records run and does not release claim", async () => {
  let released = 0
  let completed = null
  const drain = createSoftwareFactoryQueueDrainer({
    async listQueue() { return [item()] },
    async listRuns() { return catalog([]) },
    async claim() {},
    async releaseClaim() { released += 1 },
    async complete(_queueId, result) { completed = result },
    async intake() { return { runId: RUN_ID, projectId: "kynexa", status: "planned" } },
    async runFactory() { throw new Error("crash") }
  })
  const result = await drain()
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.runId, RUN_ID)
  assert.equal(released, 0)
  assert.equal(completed.runId, RUN_ID)
})
