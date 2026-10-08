import assert from "node:assert/strict"
import test from "node:test"
import { assessSoftwareFactoryAdmission } from "./software-factory-admission.mjs"
import { createSoftwareFactoryManagerCycle } from "./software-factory-manager-cycle.mjs"
import { createSoftwareFactoryAutonomousRunner } from "./software-factory-autonomous-run.mjs"
import { createSoftwareFactoryQueueDrainer } from "./software-factory-queue-drain.mjs"

const complete = { scanned: 0, returned: 0, invalid: 0, outOfScope: 0, truncated: false }
const malformed = [undefined, null, [], {}, { truncated: false },
  { ...complete, invalid: 1, scanned: 1 }, { ...complete, invalid: "0" },
  { ...complete, invalid: -1 }, { ...complete, truncated: undefined },
  { ...complete, scanned: NaN }, { ...complete, returned: -1 },
  { ...complete, outOfScope: 0.5 }, { ...complete, scanned: 101 },
  { ...complete, returned: 21 }, { ...complete, scanned: 1 },
  { ...complete, extra: "untrusted" }]

for (const active of [[], [{ project: "khlim-assist", runId: "A".repeat(43),
  status: "planned", terminal: false, recoveryRequired: false }]]) {
  for (const [index, diagnostics] of malformed.entries()) {
    test(`catalog diagnostics ${index} fail closed with ${active.length} active runs`, async () => {
      const catalog = { ok: true, code: "ok", active, diagnostics }
      assert.throws(() => assessSoftwareFactoryAdmission("kynexa", catalog),
        { code: "FACTORY_ADMISSION_CATALOG_UNAVAILABLE" })
      let calls = 0
      const sideEffect = async () => { calls++; throw new Error("must not execute") }
      const cycle = createSoftwareFactoryManagerCycle({ listRuns: async () => catalog,
        runFactory: sideEffect, drainQueue: sideEffect, readDisposition: sideEffect, recordDisposition: sideEffect })
      await assert.rejects(cycle(), { code: "FACTORY_CYCLE_CATALOG_UNAVAILABLE" })
      const drain = createSoftwareFactoryQueueDrainer({ listRuns: async () => catalog,
        listQueue: async () => [{ queueId: "pending", projectId: "kynexa", claimed: false }],
        claim: sideEffect, intake: sideEffect, runFactory: sideEffect })
      await assert.rejects(drain(), { code: "FACTORY_ADMISSION_CATALOG_UNAVAILABLE" })
      const runner = createSoftwareFactoryAutonomousRunner({ listRuns: async () => catalog,
        readRun: sideEffect, continueRun: sideEffect })
      await assert.rejects(runner("A".repeat(43)), { code: "FACTORY_RUN_CATALOG_UNAVAILABLE" })
      assert.equal(calls, 0)
    })
  }
}

test("legitimate out-of-scope self-development entries do not block admission or an idle cycle", async () => {
  const catalog = { ok: true, code: "ok", active: [],
    diagnostics: { ...complete, scanned: 1, outOfScope: 1 } }
  assert.equal(assessSoftwareFactoryAdmission("kynexa", catalog).ok, true)
  let drained = 0
  const cycle = createSoftwareFactoryManagerCycle({ listRuns: async () => catalog,
    drainQueue: async () => { drained++; return { ok: true, outcome: "queue_empty" } } })
  await cycle()
  assert.equal(drained, 1)
})

test("direct factory runner rechecks catalog before the next continuation", async () => {
  let reads = 0, continuations = 0
  const runner = createSoftwareFactoryAutonomousRunner({
    listRuns: async () => ({ ok: true, code: "ok", diagnostics: continuations === 0 ? complete : { ...complete, scanned: 1, invalid: 1 } }),
    readRun: async () => ({ runId: "A".repeat(43), version: reads++, status: "implementation_in_progress", project: { id: "khlim-assist" } }),
    continueRun: async () => { continuations++; return { ok: true, outcome: "implementation_ready" } }
  })
  await assert.rejects(runner("A".repeat(43)), { code: "FACTORY_RUN_CATALOG_UNAVAILABLE" })
  assert.equal(continuations, 1)
})
