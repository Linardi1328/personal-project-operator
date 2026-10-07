import assert from "node:assert/strict"
import test from "node:test"
import {
  createSoftwareFactoryAutonomousRunner,
  formatSoftwareFactoryAutonomousRun
} from "./software-factory-autonomous-run.mjs"

const RUN_ID = "A".repeat(43)
const SHA = "a".repeat(40)

function run(status, version, overrides = {}) {
  return {
    runId: RUN_ID,
    version,
    status,
    project: { id: "khlim-digital-ecosystem" },
    headSha: SHA,
    baseSha: SHA,
    task: "Implement the approved bounded feature.",
    ...overrides
  }
}

function sequenceRunner(sequence, results) {
  let index = 0
  let continueIndex = 0

  return createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return structuredClone(sequence[Math.min(index, sequence.length - 1)])
    },
    async continueRun() {
      const result = structuredClone(results[Math.min(continueIndex, results.length - 1)])
      continueIndex += 1
      index = Math.min(index + 1, sequence.length - 1)
      return result
    }
  })
}

test("advances multiple reviewed boundaries and stops at merge_ready", async () => {
  const states = [
    run("planned", 3),
    run("implementation_in_progress", 4),
    run("implementation_ready", 5),
    run("tests_passed", 6),
    run("review_passed", 7),
    run("merge_ready", 8)
  ]
  const results = [
    { ok: true, action: "prepare", outcome: "workspace_ready" },
    { ok: true, action: "implement", outcome: "implementation_ready" },
    { ok: true, action: "test", outcome: "tests_passed" },
    { ok: true, action: "review", outcome: "review_passed" },
    { ok: true, action: "delivery", outcome: "merge_ready" }
  ]
  const runner = sequenceRunner(states, results)
  const result = await runner(RUN_ID)

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "release_ready")
  assert.equal(result.run.status, "merge_ready")
  assert.equal(result.stepCount, 5)
  assert.equal(result.reason, "human_release_approval_required")
})

test("pre-existing merge_ready run never invokes Continue", async () => {
  let continueCalls = 0
  const runner = createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return run("merge_ready", 12)
    },
    async continueRun() {
      continueCalls += 1
      throw new Error("should not run")
    }
  })

  const result = await runner(RUN_ID)

  assert.equal(result.outcome, "release_ready")
  assert.equal(result.stepCount, 0)
  assert.equal(continueCalls, 0)
})

test("blocked worker capacity stops without additional continuation", async () => {
  let state = run("implementation_in_progress", 4)
  let continueCalls = 0
  const runner = createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return structuredClone(state)
    },
    async continueRun() {
      continueCalls += 1
      return {
        ok: false,
        action: "phase-6d-codex-implementation",
        outcome: "blocked_capacity",
        reason: "worker_capacity_exhausted"
      }
    }
  })

  const result = await runner(RUN_ID)

  assert.equal(result.outcome, "blocked_capacity")
  assert.equal(result.reason, "worker_capacity_exhausted")
  assert.equal(result.stepCount, 1)
  assert.equal(continueCalls, 1)
})

test("owner action stops the autonomous loop", async () => {
  const runner = createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return run("tests_failed", 9)
    },
    async continueRun() {
      return {
        ok: false,
        action: "none",
        outcome: "owner_action_required",
        reason: "automated_test_failure_recovery_not_routed"
      }
    }
  })

  const result = await runner(RUN_ID)

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "automated_test_failure_recovery_not_routed")
})

test("one stale-state result may refresh and continue", async () => {
  let state = run("planned", 3)
  let calls = 0
  const runner = createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return structuredClone(state)
    },
    async continueRun() {
      calls += 1

      if (calls === 1) {
        state = run("implementation_in_progress", 4)
        return {
          ok: false,
          action: "prepare",
          outcome: "stale_state",
          reason: "run_changed_before_dispatch"
        }
      }

      state = run("merge_ready", 5)
      return {
        ok: true,
        action: "delivery",
        outcome: "merge_ready"
      }
    }
  })

  const result = await runner(RUN_ID)

  assert.equal(result.outcome, "release_ready")
  assert.equal(result.stepCount, 2)
})

test("repeated stale-state results fail closed", async () => {
  let state = run("planned", 3)
  let calls = 0
  const runner = createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return structuredClone(state)
    },
    async continueRun() {
      calls += 1
      state = run("planned", 3 + calls)
      return {
        ok: false,
        action: "prepare",
        outcome: "stale_state",
        reason: "run_changed_before_dispatch"
      }
    }
  })

  const result = await runner(RUN_ID)

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "repeated_stale_state")
  assert.equal(result.stepCount, 2)
})

test("successful result with no state progress fails closed", async () => {
  const state = run("planned", 3)
  const runner = createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return structuredClone(state)
    },
    async continueRun() {
      return {
        ok: true,
        action: "prepare",
        outcome: "continued"
      }
    }
  })

  const result = await runner(RUN_ID)

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "autonomous_run_no_progress")
})

test("production workflow states remain outside the factory runner", async () => {
  const runner = createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return run("deployed", 15)
    },
    async continueRun() {
      throw new Error("should not run")
    }
  })

  const result = await runner(RUN_ID)

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "production_workflow_outside_factory_runner")
})

test("step limit prevents runaway continuation", async () => {
  let version = 1
  let status = "planned"
  const runner = createSoftwareFactoryAutonomousRunner({
    async readRun() {
      return run(status, version)
    },
    async continueRun() {
      version += 1
      status = status === "planned" ? "implementation_in_progress" : "planned"
      return {
        ok: true,
        action: "bounded-fixture",
        outcome: "continued"
      }
    }
  })

  const result = await runner(RUN_ID, { maxSteps: 3 })

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "autonomous_step_limit_reached")
  assert.equal(result.stepCount, 3)
})

test("format highlights release approval as the next action", () => {
  const output = formatSoftwareFactoryAutonomousRun({
    outcome: "release_ready",
    stepCount: 5,
    run: {
      runId: RUN_ID,
      projectId: "khlim-digital-ecosystem",
      status: "merge_ready"
    },
    reason: "human_release_approval_required"
  })

  assert.match(output, /Outcome: release_ready/u)
  assert.match(output, /explicitly approve merge/u)
})
