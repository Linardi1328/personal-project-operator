import assert from "node:assert/strict"
import test from "node:test"
import {
  PHASE_6G_DEFAULT_BASE_BRANCH,
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID
} from "./development-test-runner.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS
} from "./development-review-agent.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD,
  PPO_PR_VALIDATION_WORKFLOW_NAME,
  REQUIRED_PPO_PR_VALIDATION_STEPS
} from "./github-delivery-agent.mjs"
import {
  REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID
} from "./software-factory-implementation-evidence.mjs"
import {
  buildSoftwareFactoryReleasePackage,
  buildSoftwareFactoryReleasePackageFromRun,
  formatSoftwareFactoryReleasePackage
} from "./software-factory-release-package.mjs"

const RUN_ID = "A".repeat(43)
const SHA = "a".repeat(40)
const OTHER_SHA = "b".repeat(40)
const TEST_POLICY_HASH = "c".repeat(64)
const BRANCH = "ppo/khlim-digital-ecosystem/implementation/release-packet"

function implementationEvidence(overrides = {}) {
  return {
    kind: "implementation",
    sha: SHA,
    source: REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID,
    summary: "Implementation ready.",
    metadata: {
      adapter: REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID,
      project: "khlim-digital-ecosystem",
      attempt: 2,
      outcome: "implementation_ready",
      changedFiles: 7,
      model: "gemini-3-flash-high",
      ...overrides
    }
  }
}

function testEvidence(overrides = {}) {
  return {
    kind: "test",
    sha: SHA,
    source: AUTOMATED_TEST_RUNNER_ID,
    summary: "Tests passed.",
    metadata: {
      runner: AUTOMATED_TEST_RUNNER_ID,
      project: "khlim-digital-ecosystem",
      attempt: 3,
      implSha: SHA,
      policyId: "khlim-fixed-quality-v1",
      policyHash: TEST_POLICY_HASH,
      outcome: "passed",
      total: 18,
      passed: 18,
      failed: 0,
      ambiguous: 0,
      ...overrides
    }
  }
}

function localReviewEvidence(overrides = {}) {
  return {
    kind: "review",
    sha: SHA,
    source: INDEPENDENT_REVIEW_AGENT_ID,
    summary: "Local review approved.",
    metadata: {
      reviewer: INDEPENDENT_REVIEW_AGENT_ID,
      project: "khlim-digital-ecosystem",
      attempt: 2,
      reviewedSha: SHA,
      decision: REVIEW_DECISIONS.APPROVED,
      mergeAllowed: true,
      blockers: 0,
      securityFindings: 0,
      testsRequired: 0,
      outcome: "approved",
      ...overrides
    }
  }
}

function remoteReviewEvidence(overrides = {}) {
  return {
    kind: "review",
    sha: SHA,
    source: REMOTE_PR_REVIEW_AGENT_ID,
    summary: "Remote review approved.",
    metadata: {
      reviewer: REMOTE_PR_REVIEW_AGENT_ID,
      project: "khlim-digital-ecosystem",
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      attempt: 1,
      prNumber: 42,
      branch: BRANCH,
      reviewedSha: SHA,
      decision: REVIEW_DECISIONS.APPROVED,
      mergeAllowed: true,
      blockers: 0,
      securityFindings: 0,
      testsRequired: 0,
      outcome: "approved",
      ...overrides
    }
  }
}

function ciEvidence(overrides = {}) {
  return {
    kind: "merge",
    sha: SHA,
    source: GITHUB_DELIVERY_AGENT_ID,
    summary: "Exact-head CI passed.",
    metadata: {
      project: "khlim-digital-ecosystem",
      agent: GITHUB_DELIVERY_AGENT_ID,
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      implementationSha: SHA,
      outcome: "ci_passed",
      prNumber: 42,
      workflowName: PPO_PR_VALIDATION_WORKFLOW_NAME,
      workflowRunId: 9001,
      workflowConclusion: "success",
      requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length,
      ...overrides
    }
  }
}

function mergeReadyEvidence(overrides = {}) {
  return {
    kind: "merge",
    sha: SHA,
    source: GITHUB_DELIVERY_AGENT_ID,
    summary: "Merge-ready.",
    metadata: {
      project: "khlim-digital-ecosystem",
      agent: GITHUB_DELIVERY_AGENT_ID,
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      implementationSha: SHA,
      outcome: "merge_ready",
      prNumber: 42,
      branch: BRANCH,
      base: PHASE_6G_DEFAULT_BASE_BRANCH,
      prHeadSha: SHA,
      workflowRunId: 9001,
      remoteReviewedSha: SHA,
      remoteDecision: REVIEW_DECISIONS.APPROVED,
      ...overrides
    }
  }
}

function releaseRun(overrides = {}) {
  return {
    runId: RUN_ID,
    version: 17,
    status: "merge_ready",
    project: {
      id: "khlim-digital-ecosystem",
      fullName: "Linardi1328/khlim-digital-ecosystem"
    },
    task: "Fix the approved Academy Lead browser acceptance blocker.",
    branch: BRANCH,
    baseSha: OTHER_SHA,
    headSha: SHA,
    attempts: {
      planning: 1,
      implementation: 2,
      test: 3,
      review: 2,
      merge: 1,
      deploy: 0,
      verification: 0,
      rollback: 0
    },
    evidence: {
      planning: [],
      implementation: [implementationEvidence()],
      test: [testEvidence()],
      review: [
        localReviewEvidence(),
        remoteReviewEvidence()
      ],
      merge: [
        ciEvidence(),
        mergeReadyEvidence()
      ],
      deploy: [],
      verification: [],
      rollback: []
    },
    ...overrides
  }
}

test("builds one deterministic bounded release candidate package from exact-head evidence", () => {
  const run = releaseRun()
  const first = buildSoftwareFactoryReleasePackageFromRun(run)
  const second = buildSoftwareFactoryReleasePackageFromRun(structuredClone(run))

  assert.equal(first.kind, "software_factory_release_candidate")
  assert.equal(first.run.headSha, SHA)
  assert.equal(first.run.repository, "Linardi1328/khlim-digital-ecosystem")
  assert.equal(first.implementation.adapterId, REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID)
  assert.equal(first.implementation.changedFiles, 7)
  assert.equal(first.implementation.model, "gemini-3-flash-high")
  assert.equal(first.tests.passed, 18)
  assert.equal(first.tests.failed, 0)
  assert.equal(first.localReview.decision, REVIEW_DECISIONS.APPROVED)
  assert.equal(first.remoteReview.prNumber, 42)
  assert.equal(first.ci.workflowRunId, 9001)
  assert.equal(first.ci.requiredSteps, REQUIRED_PPO_PR_VALIDATION_STEPS.length)
  assert.equal(first.delivery.approvedMergeMethod, PHASE_6G_APPROVED_MERGE_METHOD)
  assert.equal(first.authority.merge, "owner_approval_required")
  assert.equal(first.authority.productionDeployment, "not_authorized")
  assert.match(first.packageHash, /^[a-f0-9]{64}$/u)
  assert.equal(first.packageHash, second.packageHash)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.delivery), true)
})

test("wrapper reads the run once and builds the same package", async () => {
  let reads = 0
  const run = releaseRun()
  const result = await buildSoftwareFactoryReleasePackage(RUN_ID, {
    async readRun(runId) {
      reads += 1
      assert.equal(runId, RUN_ID)
      return structuredClone(run)
    }
  })

  assert.equal(reads, 1)
  assert.equal(result.run.headSha, SHA)
})

test("refuses a run that is not merge_ready", () => {
  assert.throws(
    () => buildSoftwareFactoryReleasePackageFromRun(releaseRun({ status: "review_passed" })),
    (error) => error?.code === "FACTORY_RELEASE_RUN_NOT_READY"
  )
})

test("refuses stale implementation evidence", () => {
  const run = releaseRun()
  run.evidence.implementation = [implementationEvidence({})]
  run.evidence.implementation[0].sha = OTHER_SHA

  assert.throws(
    () => buildSoftwareFactoryReleasePackageFromRun(run),
    (error) => error?.code === "FACTORY_RELEASE_IMPLEMENTATION_EVIDENCE_INVALID"
  )
})

test("refuses failed or ambiguous deterministic test evidence", () => {
  for (const overrides of [
    { failed: 1, passed: 17 },
    { ambiguous: 1 }
  ]) {
    const run = releaseRun()
    run.evidence.test = [testEvidence(overrides)]

    assert.throws(
      () => buildSoftwareFactoryReleasePackageFromRun(run),
      (error) => error?.code === "FACTORY_RELEASE_TEST_EVIDENCE_INVALID"
    )
  }
})

test("refuses a later local review that no longer approves merge", () => {
  const run = releaseRun()
  run.evidence.review.splice(1, 0, localReviewEvidence({
    attempt: 3,
    decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
    mergeAllowed: false,
    blockers: 1,
    outcome: "changes_requested"
  }))

  assert.throws(
    () => buildSoftwareFactoryReleasePackageFromRun(run),
    (error) => error?.code === "FACTORY_RELEASE_LOCAL_REVIEW_INVALID"
  )
})

test("refuses remote review with blockers or stale reviewed SHA", () => {
  for (const overrides of [
    { blockers: 1, mergeAllowed: false, decision: REVIEW_DECISIONS.CHANGES_REQUESTED, outcome: "changes_requested" },
    { reviewedSha: OTHER_SHA }
  ]) {
    const run = releaseRun()
    run.evidence.review[1] = remoteReviewEvidence(overrides)

    assert.throws(
      () => buildSoftwareFactoryReleasePackageFromRun(run),
      (error) => error?.code === "FACTORY_RELEASE_REMOTE_REVIEW_INVALID"
    )
  }
})

test("refuses contradictory CI and merge-ready delivery bindings", () => {
  const ciMismatch = releaseRun()
  ciMismatch.evidence.merge[0] = ciEvidence({ workflowConclusion: "failure" })

  assert.throws(
    () => buildSoftwareFactoryReleasePackageFromRun(ciMismatch),
    (error) => error?.code === "FACTORY_RELEASE_CI_EVIDENCE_INVALID"
  )

  const deliveryMismatch = releaseRun()
  deliveryMismatch.evidence.merge[1] = mergeReadyEvidence({ workflowRunId: 9002 })

  assert.throws(
    () => buildSoftwareFactoryReleasePackageFromRun(deliveryMismatch),
    (error) => error?.code === "FACTORY_RELEASE_DELIVERY_EVIDENCE_INVALID"
  )
})

test("formatter exposes manager-level evidence without task or raw review prose", () => {
  const packageValue = buildSoftwareFactoryReleasePackageFromRun(releaseRun())
  const output = formatSoftwareFactoryReleasePackage(packageValue)

  assert.match(output, /PPO Release Candidate/u)
  assert.match(output, /Pull request: #42/u)
  assert.match(output, /Tests: 18\/18 passed/u)
  assert.match(output, /owner approval required for merge/u)
  assert.doesNotMatch(output, /Academy Lead/u)
  assert.doesNotMatch(output, /review prose/u)
})
