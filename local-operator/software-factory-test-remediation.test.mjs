import assert from "node:assert/strict"
import test from "node:test"
import {
  createSoftwareFactoryTestRemediationPreparer,
  latestSoftwareFactoryTestRemediation,
  SOFTWARE_FACTORY_TEST_REMEDIATION_ID
} from "./software-factory-test-remediation.mjs"
import {
  resolveSoftwareFactoryImplementationCapability
} from "./development-continue-orchestrator.mjs"
import {
  buildAntigravityImplementationPrompt
} from "./software-factory-antigravity-execution.mjs"

const RUN_ID = "T".repeat(43)
const SHA = "a".repeat(40)
const POLICY = Object.freeze({
  policyId: "fixed-test-policy",
  policyHash: "b".repeat(64),
  requiredTestCount: 2
})

function failedRun(overrides = {}) {
  return {
    runId: RUN_ID,
    version: 9,
    status: "tests_failed",
    task: "Implement the approved feature.",
    project: {
      id: "khlim-digital-ecosystem",
      fullName: "Linardi1328/khlim-digital-ecosystem"
    },
    branch: "ppo/test-remediation",
    baseSha: SHA,
    headSha: SHA,
    attempts: {
      planning: 1,
      implementation: 1,
      test: 2,
      review: 0,
      merge: 0,
      deploy: 0,
      verification: 0,
      rollback: 0
    },
    evidence: {
      planning: [],
      implementation: [],
      test: [
        {
          kind: "test",
          sha: SHA,
          source: "phase-6e-automated-test-runner",
          summary: "step",
          metadata: {
            runner: "phase-6e-automated-test-runner",
            project: "khlim-digital-ecosystem",
            attempt: 2,
            implSha: SHA,
            policyId: POLICY.policyId,
            policyHash: POLICY.policyHash,
            outcome: "failed",
            testId: "foundation-test"
          }
        },
        {
          kind: "test",
          sha: SHA,
          source: "phase-6e-automated-test-runner",
          summary: "aggregate",
          metadata: {
            runner: "phase-6e-automated-test-runner",
            project: "khlim-digital-ecosystem",
            attempt: 2,
            implSha: SHA,
            policyId: POLICY.policyId,
            policyHash: POLICY.policyHash,
            outcome: "failed",
            total: 2,
            passed: 0,
            failed: 1,
            ambiguous: 0
          }
        }
      ],
      review: [],
      merge: [],
      deploy: [],
      verification: [],
      rollback: []
    },
    ...overrides
  }
}

function preparerFixture({ capacity = "available", classification = "definitive_failed" } = {}) {
  let run = failedRun()
  let transitionCalls = 0
  const readinessCalls = []

  const prepare = createSoftwareFactoryTestRemediationPreparer({
    async readRun() {
      return structuredClone(run)
    },
    resolvePolicyIdentity() {
      return POLICY
    },
    classifyEvidence() {
      return classification
    },
    async readCheckpoint() {
      const error = new Error("missing")
      error.code = "FACTORY_CHECKPOINT_NOT_FOUND"
      throw error
    },
    async recordReadiness(input) {
      readinessCalls.push(structuredClone(input))
      return {
        checkpointVersion: 1,
        dispatch: capacity === "available"
          ? { outcome: "ready", consumeAttempt: true, reasonCode: "WORKER_READY" }
          : { outcome: "blocked_capacity", consumeAttempt: false, reasonCode: "WORKER_CAPACITY_EXHAUSTED" }
      }
    },
    async transitionRun(runId, input) {
      transitionCalls += 1
      assert.equal(runId, RUN_ID)
      run = {
        ...run,
        version: run.version + 1,
        status: input.status,
        evidence: {
          ...run.evidence,
          implementation: [
            ...(run.evidence.implementation || []),
            ...(input.evidence || [])
          ]
        }
      }
      return structuredClone(run)
    }
  })

  return {
    prepare,
    getRun: () => structuredClone(run),
    getTransitionCalls: () => transitionCalls,
    readinessCalls
  }
}

test("blocked Antigravity capacity leaves the run parked at tests_failed", async () => {
  const fixture = preparerFixture({ capacity: "exhausted" })
  const result = await fixture.prepare(RUN_ID, { expectedVersion: 9 })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "blocked_capacity")
  assert.equal(result.run.status, "tests_failed")
  assert.equal(fixture.getTransitionCalls(), 0)
  assert.equal(fixture.readinessCalls.length, 1)
  assert.equal(fixture.readinessCalls[0].capability, "debugging")
  assert.equal(fixture.readinessCalls[0].failedAttempts, 1)
})

test("fresh debugging capacity opens a remediation implementation stage", async () => {
  const fixture = preparerFixture()
  const result = await fixture.prepare(RUN_ID, { expectedVersion: 9 })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "test_remediation_ready")
  assert.equal(result.run.status, "implementation_in_progress")
  assert.equal(fixture.getTransitionCalls(), 1)

  const marker = latestSoftwareFactoryTestRemediation(result.run)
  assert.equal(marker.source, SOFTWARE_FACTORY_TEST_REMEDIATION_ID)
  assert.equal(marker.sha, SHA)
  assert.equal(marker.metadata.capability, "debugging")
  assert.equal(marker.metadata.sourceTestAttempt, 2)
  assert.equal(marker.metadata.failedTests, 1)
  assert.deepEqual(marker.metadata.failedTestIds, ["foundation-test"])
})

test("untrusted failure evidence is refused before readiness probing", async () => {
  const fixture = preparerFixture({ classification: "invalid" })

  await assert.rejects(
    fixture.prepare(RUN_ID, { expectedVersion: 9 }),
    (error) => error?.code === "TEST_REMEDIATION_EVIDENCE_INVALID"
  )

  assert.equal(fixture.readinessCalls.length, 0)
  assert.equal(fixture.getTransitionCalls(), 0)
})

test("test-remediation marker forces debugging capability", async () => {
  const fixture = preparerFixture()
  const result = await fixture.prepare(RUN_ID, { expectedVersion: 9 })

  assert.equal(
    resolveSoftwareFactoryImplementationCapability(result.run),
    "debugging"
  )
})

test("Antigravity debugging prompt contains bounded failed-test metadata only", async () => {
  const fixture = preparerFixture()
  const result = await fixture.prepare(RUN_ID, { expectedVersion: 9 })
  const prompt = buildAntigravityImplementationPrompt(
    result.run,
    {
      branch: result.run.branch,
      workspaceRef: "workspace-ref"
    },
    {
      capability: "debugging",
      modelClass: "standard",
      skills: ["debugging-and-error-recovery"]
    }
  )

  assert.match(prompt, /Trusted failed-test context:/u)
  assert.match(prompt, /Source test attempt: 2/u)
  assert.match(prompt, /Failed required test steps: 1 of 2/u)
  assert.match(prompt, /foundation-test/u)
  assert.match(prompt, /debugging-and-error-recovery/u)
  assert.doesNotMatch(prompt, /stdout|stderr|stack trace|SENSITIVE_TEST_SENTINEL/iu)
})
