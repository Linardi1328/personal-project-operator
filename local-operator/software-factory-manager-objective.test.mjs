import assert from "node:assert/strict"
import test from "node:test"
import {
  createSoftwareFactoryManagerLaunch,
  createSoftwareFactoryManagerObjectiveIntake,
  formatSoftwareFactoryManagerObjective,
  normalizeSoftwareFactoryManagerObjective
} from "./software-factory-manager-objective.mjs"

const SHA = "a".repeat(40)
const RUN_ID = "A".repeat(43)

function snapshot(overrides = {}) {
  return {
    project: {
      id: "khlim-digital-ecosystem",
      displayName: "KHLIM Super App",
      fullName: "Linardi1328/khlim-digital-ecosystem"
    },
    repository: {
      fullName: "Linardi1328/khlim-digital-ecosystem",
      defaultBranch: "main"
    },
    recentCommits: [{ sha: SHA }],
    openPullRequests: [],
    openIssues: [{ number: 12 }],
    ...overrides
  }
}

test("manager objective intake pins one planned run to current GitHub head", async () => {
  const calls = []
  const intake = createSoftwareFactoryManagerObjectiveIntake({
    githubClient: {
      async getProjectSnapshot(projectId) {
        calls.push(["snapshot", projectId])
        return snapshot()
      }
    },
    async createRun(input) {
      calls.push(["create", input])
      return {
        runId: RUN_ID,
        version: 0,
        status: "created"
      }
    },
    async transitionRun(runId, transition) {
      calls.push(["transition", runId, transition])
      if (transition.status === "planning_in_progress") {
        return { runId, version: 1, status: "planning_in_progress" }
      }
      return { runId, version: 2, status: "planned" }
    }
  })

  const result = await intake(
    "khlim-digital-ecosystem",
    "Fix the Academy Lead browser acceptance failure without changing auth architecture."
  )

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "planned")
  assert.equal(result.runId, RUN_ID)
  assert.equal(result.baseSha, SHA)
  assert.equal(result.defaultBranch, "main")
  assert.equal(calls[1][1].task, "Fix the Academy Lead browser acceptance failure without changing auth architecture.")
  assert.equal(calls[1][1].baseSha, SHA)
  assert.equal(calls[1][1].headSha, SHA)
  assert.equal(calls[1][1].branch, "main")

  const plannedTransition = calls[3][2]
  assert.equal(plannedTransition.status, "planned")
  assert.equal(plannedTransition.evidence.length, 1)
  assert.equal(plannedTransition.evidence[0].kind, "planning")
  assert.equal(plannedTransition.evidence[0].sha, SHA)
  assert.equal(plannedTransition.evidence[0].metadata.origin, "owner_manager_objective")
  assert.equal(plannedTransition.evidence[0].metadata.openPrCount, 0)
  assert.equal(plannedTransition.evidence[0].metadata.openIssueCount, 1)
  assert.match(plannedTransition.evidence[0].metadata.objectiveHash, /^[a-f0-9]{64}$/u)
})

test("manager objective intake refuses repositories with open pull requests before creating a run", async () => {
  let createCalls = 0
  const intake = createSoftwareFactoryManagerObjectiveIntake({
    githubClient: {
      async getProjectSnapshot() {
        return snapshot({ openPullRequests: [{ number: 85 }] })
      }
    },
    async createRun() {
      createCalls += 1
      throw new Error("must not create")
    }
  })

  await assert.rejects(
    intake("khlim-digital-ecosystem", "Implement the approved bounded fix."),
    (error) => error?.code === "FACTORY_OBJECTIVE_GITHUB_STATE_AMBIGUOUS"
  )
  assert.equal(createCalls, 0)
})

test("manager objective intake refuses contradictory GitHub identity before creating a run", async () => {
  let createCalls = 0
  const intake = createSoftwareFactoryManagerObjectiveIntake({
    githubClient: {
      async getProjectSnapshot() {
        const value = snapshot()
        value.repository.fullName = "Linardi1328/not-the-project"
        return value
      }
    },
    async createRun() {
      createCalls += 1
    }
  })

  await assert.rejects(
    intake("khlim-digital-ecosystem", "Implement the approved bounded fix."),
    (error) => error?.code === "FACTORY_OBJECTIVE_GITHUB_STATE_INVALID"
  )
  assert.equal(createCalls, 0)
})

test("manager objective text is bounded and rejects sensitive/control input", () => {
  assert.equal(
    normalizeSoftwareFactoryManagerObjective("Implement the approved bounded fix."),
    "Implement the approved bounded fix."
  )

  assert.throws(
    () => normalizeSoftwareFactoryManagerObjective(" token=secretvalue "),
    (error) => error?.code === "FACTORY_OBJECTIVE_INVALID"
  )
  assert.throws(
    () => normalizeSoftwareFactoryManagerObjective("Unsafe\u0000objective"),
    (error) => error?.code === "FACTORY_OBJECTIVE_INVALID"
  )
  assert.throws(
    () => normalizeSoftwareFactoryManagerObjective("x".repeat(1001)),
    (error) => error?.code === "FACTORY_OBJECTIVE_INVALID"
  )
})

test("one-command manager launch hands the durable run to the autonomous runner", async () => {
  const observed = []
  const launch = createSoftwareFactoryManagerLaunch({
    async intake(projectId, objective) {
      observed.push(["intake", projectId, objective])
      return {
        ok: true,
        outcome: "planned",
        projectId,
        runId: RUN_ID,
        runVersion: 2,
        status: "planned",
        baseSha: SHA,
        defaultBranch: "main"
      }
    },
    async runFactory(runId) {
      observed.push(["factory", runId])
      return {
        ok: true,
        outcome: "release_ready",
        reason: "human_release_approval_required",
        run: {
          runId,
          projectId: "khlim-digital-ecosystem",
          status: "merge_ready"
        },
        releasePackage: {
          packageHash: "f".repeat(64)
        }
      }
    }
  })

  const result = await launch(
    "khlim-digital-ecosystem",
    "Implement the approved bounded fix."
  )

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "release_ready")
  assert.deepEqual(observed, [
    ["intake", "khlim-digital-ecosystem", "Implement the approved bounded fix."],
    ["factory", RUN_ID]
  ])
  assert.match(formatSoftwareFactoryManagerObjective(result), /explicitly approve merge/u)
})

test("blocked launch preserves run id for later factory-run resumption", async () => {
  const launch = createSoftwareFactoryManagerLaunch({
    async intake(projectId) {
      return {
        ok: true,
        outcome: "planned",
        projectId,
        runId: RUN_ID,
        runVersion: 2,
        status: "planned",
        baseSha: SHA,
        defaultBranch: "main"
      }
    },
    async runFactory(runId) {
      return {
        ok: false,
        outcome: "blocked_capacity",
        reason: "worker_capacity_exhausted",
        run: {
          runId,
          projectId: "khlim-digital-ecosystem",
          status: "implementation_in_progress"
        }
      }
    }
  })

  const result = await launch("khlim-digital-ecosystem", "Implement the approved bounded fix.")
  const output = formatSoftwareFactoryManagerObjective(result)

  assert.equal(result.outcome, "blocked_capacity")
  assert.match(output, new RegExp(`/ppo factory-run ${RUN_ID}`, "u"))
})


test("planning transition failure preserves the created durable run id", async () => {
  const intake = createSoftwareFactoryManagerObjectiveIntake({
    githubClient: {
      async getProjectSnapshot() {
        return snapshot()
      }
    },
    async createRun() {
      return { runId: RUN_ID, version: 0, status: "created" }
    },
    async transitionRun() {
      throw new Error("simulated transition failure")
    }
  })

  await assert.rejects(
    intake("khlim-digital-ecosystem", "Implement the approved bounded fix."),
    (error) => (
      error?.code === "FACTORY_OBJECTIVE_POST_CREATE_FAILED" &&
      error?.runId === RUN_ID
    )
  )
})

test("runner failure after intake keeps the durable run resumable", async () => {
  const launch = createSoftwareFactoryManagerLaunch({
    async intake(projectId) {
      return {
        ok: true,
        outcome: "planned",
        projectId,
        runId: RUN_ID,
        runVersion: 2,
        status: "planned",
        baseSha: SHA,
        defaultBranch: "main"
      }
    },
    async runFactory() {
      throw new Error("simulated runner crash")
    }
  })

  const result = await launch("khlim-digital-ecosystem", "Implement the approved bounded fix.")

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.intake.runId, RUN_ID)
  assert.equal(result.factory.reason, "factory_runner_failed_after_intake")
  assert.equal(result.factory.run.runId, RUN_ID)
})
