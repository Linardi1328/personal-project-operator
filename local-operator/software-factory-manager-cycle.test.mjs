import assert from "node:assert/strict"
import test from "node:test"
import {
  createSoftwareFactoryManagerCycle,
  formatSoftwareFactoryManagerCycle
} from "./software-factory-manager-cycle.mjs"

const RUN_A = "A".repeat(43)
const RUN_B = "B".repeat(43)
const RUN_C = "C".repeat(43)

function summary(project, runId, overrides = {}) {
  return {
    project,
    runId,
    status: "implementation_in_progress",
    terminal: false,
    recoveryRequired: false,
    ...overrides
  }
}

function catalog(active = [], overrides = {}) {
  return {
    ok: true,
    code: "ok",
    active,
    diagnostics: { truncated: false },
    ...overrides
  }
}

test("idle cycle drains queue once without invoking factory runs", async () => {
  let runCalls = 0
  let drainCalls = 0
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() { return catalog([]) },
    async runFactory() { runCalls += 1 },
    async drainQueue() {
      drainCalls += 1
      return { ok: true, outcome: "queue_empty" }
    }
  })

  const result = await cycle()
  assert.equal(result.outcome, "cycle_idle")
  assert.equal(result.processedRunCount, 0)
  assert.equal(runCalls, 0)
  assert.equal(drainCalls, 1)
})

test("resumes at most two allowed active projects sequentially then drains once", async () => {
  const calls = []
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() {
      return catalog([
        summary("kynexa", RUN_A),
        summary("rivora", RUN_B)
      ])
    },
    async runFactory(runId) {
      calls.push(["run-start", runId])
      await Promise.resolve()
      calls.push(["run-end", runId])
      return {
        ok: true,
        outcome: "complete",
        run: { status: "merged" }
      }
    },
    async drainQueue() {
      calls.push(["drain"])
      return { ok: true, outcome: "queue_empty" }
    }
  })

  const result = await cycle()
  assert.equal(result.outcome, "cycle_complete")
  assert.equal(result.processedRunCount, 2)
  assert.deepEqual(calls, [
    ["run-start", RUN_A],
    ["run-end", RUN_A],
    ["run-start", RUN_B],
    ["run-end", RUN_B],
    ["drain"]
  ])
})

test("merge-ready run is resumed only to the existing release-ready boundary", async () => {
  let drainCalls = 0
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() {
      return catalog([
        summary("kynexa", RUN_A, { status: "merge_ready" })
      ])
    },
    async runFactory(runId) {
      assert.equal(runId, RUN_A)
      return {
        ok: true,
        outcome: "release_ready",
        reason: "human_release_approval_required",
        run: { status: "merge_ready" },
        releasePackage: { sensitive: "must not leak into cycle result" }
      }
    },
    async drainQueue() {
      drainCalls += 1
      return { ok: false, outcome: "blocked_work_in_progress", reason: "global_active_project_limit" }
    }
  })

  const result = await cycle()
  assert.equal(result.outcome, "release_ready")
  assert.equal(result.runs[0].outcome, "release_ready")
  assert.equal(result.runs[0].reason, "human_release_approval_required")
  assert.equal(Object.hasOwn(result.runs[0], "releasePackage"), false)
  assert.equal(drainCalls, 1)
})

test("merged and production-stage runs are skipped by manager cycle", async () => {
  const calls = []
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() {
      return catalog([
        summary("kynexa", RUN_A, { status: "merged" }),
        summary("rivora", RUN_B, { status: "deploy_in_progress" })
      ])
    },
    async runFactory(runId) { calls.push(runId) },
    async drainQueue() {
      return { ok: true, outcome: "queue_empty" }
    }
  })

  const result = await cycle()
  assert.equal(result.processedRunCount, 0)
  assert.deepEqual(calls, [])
  assert.equal(result.outcome, "cycle_idle")
})

test("recovery-required active state fails closed before any work", async () => {
  let runs = 0
  let drains = 0
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() {
      return catalog([
        summary("kynexa", RUN_A, {
          status: "merged",
          recoveryRequired: true
        })
      ])
    },
    async runFactory() { runs += 1 },
    async drainQueue() { drains += 1 }
  })

  await assert.rejects(
    cycle(),
    (error) => error?.code === "FACTORY_CYCLE_RECOVERY_REQUIRED"
  )
  assert.equal(runs, 0)
  assert.equal(drains, 0)
})

test("truncated catalog fails closed before any work", async () => {
  let runs = 0
  let drains = 0
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() {
      return catalog([], {
        code: "catalog_truncated",
        diagnostics: { truncated: true }
      })
    },
    async runFactory() { runs += 1 },
    async drainQueue() { drains += 1 }
  })

  await assert.rejects(
    cycle(),
    (error) => error?.code === "FACTORY_CYCLE_CATALOG_UNAVAILABLE"
  )
  assert.equal(runs, 0)
  assert.equal(drains, 0)
})

test("policy-violating active project count fails closed", async () => {
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() {
      return catalog([
        summary("kynexa", RUN_A),
        summary("rivora", RUN_B),
        summary("axiom-quantum", RUN_C)
      ])
    }
  })

  await assert.rejects(
    cycle(),
    (error) => error?.code === "FACTORY_CYCLE_WIP_INVALID"
  )
})

test("runner failure is bounded and queue still gets one admission attempt", async () => {
  let drains = 0
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() {
      return catalog([summary("kynexa", RUN_A)])
    },
    async runFactory() {
      throw new Error("raw failure must not escape")
    },
    async drainQueue() {
      drains += 1
      return { ok: true, outcome: "queue_empty" }
    }
  })

  const result = await cycle()
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.runs[0].reason, "factory_runner_failed")
  assert.equal(drains, 1)
})

test("blocked capacity is surfaced without retrying inside manager cycle", async () => {
  let runs = 0
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() {
      return catalog([summary("kynexa", RUN_A)])
    },
    async runFactory() {
      runs += 1
      return {
        ok: false,
        outcome: "blocked_capacity",
        reason: "worker_capacity_exhausted",
        run: { status: "implementation_in_progress" }
      }
    },
    async drainQueue() {
      return { ok: false, outcome: "blocked_work_in_progress", reason: "project_active_run_limit" }
    }
  })

  const result = await cycle()
  assert.equal(runs, 1)
  assert.equal(result.outcome, "blocked_capacity")
  assert.equal(result.runs[0].reason, "worker_capacity_exhausted")
})

test("queue result is bounded and cannot leak objective or raw worker data", async () => {
  const cycle = createSoftwareFactoryManagerCycle({
    async listRuns() { return catalog([]) },
    async drainQueue() {
      return {
        ok: false,
        outcome: "blocked_capacity",
        reason: "worker_capacity_exhausted",
        queueId: "Q".repeat(32),
        runId: RUN_A,
        objective: "secret objective",
        rawOutput: "SENSITIVE_TEST_SENTINEL"
      }
    }
  })

  const result = await cycle()
  assert.deepEqual(Object.keys(result.queue).sort(), ["ok", "outcome", "queueId", "reason", "runId"].sort())
  const output = formatSoftwareFactoryManagerCycle(result)
  assert.doesNotMatch(output, /secret objective|SENSITIVE_TEST_SENTINEL/u)
})
