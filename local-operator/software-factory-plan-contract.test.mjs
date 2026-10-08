import assert from "node:assert/strict"
import test from "node:test"
import {
  SOFTWARE_FACTORY_PLAN_CONTRACT_ID,
  buildBaselineSoftwareFactoryPlan,
  latestSoftwareFactoryPlan,
  softwareFactoryPlanEvidence,
  validateSoftwareFactoryPlan
} from "./software-factory-plan-contract.mjs"

const RUN_ID = "A".repeat(43)
const BASE_SHA = "b".repeat(40)

test("baseline plan is deterministic, bounded, and objective-bound", () => {
  const objective = "Fix the responsive registration form accessibility failure."
  const left = buildBaselineSoftwareFactoryPlan({
    runId: RUN_ID,
    projectId: "kynexa",
    baseSha: BASE_SHA,
    objective
  })
  const right = buildBaselineSoftwareFactoryPlan({
    runId: RUN_ID,
    projectId: "kynexa",
    baseSha: BASE_SHA,
    objective
  })

  assert.deepEqual(left, right)
  assert.equal(left.capabilityHint, "implementation.frontend")
  assert.equal(left.risk, "low")
  assert.match(left.objectiveHash, /^[a-f0-9]{64}$/u)
  assert.match(left.planHash, /^[a-f0-9]{64}$/u)
  assert.equal(left.acceptanceCriteria.length, 4)
  assert.ok(left.acceptanceCriteria.every((item) => item.length <= 140))
})

test("baseline plan classifies debugging and high-risk objectives conservatively", () => {
  const plan = buildBaselineSoftwareFactoryPlan({
    runId: RUN_ID,
    projectId: "khlim-digital-ecosystem",
    baseSha: BASE_SHA,
    objective: "Debug the failing authentication integration test without changing production deployment."
  })

  assert.equal(plan.capabilityHint, "debugging")
  assert.equal(plan.risk, "high")
})

test("plan evidence fits the run-state primitive metadata contract", () => {
  const plan = buildBaselineSoftwareFactoryPlan({
    runId: RUN_ID,
    projectId: "axiom-quantum",
    baseSha: BASE_SHA,
    objective: "Implement the bounded intelligence reporting fix."
  })
  const evidence = softwareFactoryPlanEvidence(plan)

  assert.equal(evidence.kind, "planning")
  assert.equal(evidence.sha, BASE_SHA)
  assert.equal(evidence.source, SOFTWARE_FACTORY_PLAN_CONTRACT_ID)
  assert.equal(evidence.metadata.planHash, plan.planHash)
  assert.deepEqual(evidence.metadata.criteria, plan.acceptanceCriteria)
  assert.deepEqual(evidence.metadata.constraints, plan.constraints)
  assert.deepEqual(evidence.metadata.exclusions, plan.exclusions)
})

test("tampered plan content is rejected by its hash", () => {
  const plan = buildBaselineSoftwareFactoryPlan({
    runId: RUN_ID,
    projectId: "rivora",
    baseSha: BASE_SHA,
    objective: "Implement the approved schedule filter fix."
  })

  assert.throws(
    () => validateSoftwareFactoryPlan({
      ...plan,
      goal: "Expand the task into unrelated architecture work."
    }),
    (error) => error?.code === "FACTORY_PLAN_HASH_MISMATCH"
  )
})

test("plan fields reject oversized and sensitive content", () => {
  const plan = buildBaselineSoftwareFactoryPlan({
    runId: RUN_ID,
    projectId: "rivora",
    baseSha: BASE_SHA,
    objective: "Implement the approved bounded fix."
  })

  assert.throws(
    () => validateSoftwareFactoryPlan({
      ...plan,
      constraints: ["x".repeat(141)]
    }),
    (error) => error?.code === "FACTORY_PLAN_INVALID"
  )

  assert.throws(
    () => buildBaselineSoftwareFactoryPlan({
      runId: RUN_ID,
      projectId: "rivora",
      baseSha: BASE_SHA,
      objective: "Set token=supersecretvalue"
    }),
    (error) => error?.code === "FACTORY_PLAN_OBJECTIVE_INVALID"
  )
})

test("latest plan requires exact run, project, SHA, and objective binding", () => {
  const objective = "Implement the approved bounded fix."
  const plan = buildBaselineSoftwareFactoryPlan({
    runId: RUN_ID,
    projectId: "rivora",
    baseSha: BASE_SHA,
    objective
  })
  const evidence = softwareFactoryPlanEvidence(plan)
  const run = {
    runId: RUN_ID,
    project: { id: "rivora" },
    task: objective,
    baseSha: BASE_SHA,
    evidence: { planning: [evidence] }
  }

  assert.equal(latestSoftwareFactoryPlan(run)?.planHash, plan.planHash)
  assert.equal(latestSoftwareFactoryPlan({ ...run, task: "Different objective." }), null)
  assert.equal(latestSoftwareFactoryPlan({ ...run, baseSha: "c".repeat(40) }), null)
})
