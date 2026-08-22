import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  DEVELOPMENT_RUN_STATUSES,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
} from "./development-run-state.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  CODEX_EXECUTION_SANDBOX_ID
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  AUTOMATED_TEST_SANDBOX_ID,
  resolveAutomatedTestPolicyIdentity
} from "./development-test-runner.mjs"
import {
  DEVELOPMENT_RECOVERY_COORDINATOR_ID,
  PHASE_6L_RECOVERY_POLICY_ID,
  PHASE_6L_RECOVERY_STATUS_CONTRACT,
  executeDevelopmentRecovery,
  formatDevelopmentRecoveryResult
} from "./development-recovery-coordinator.mjs"
import {
  loadDevelopmentContinueRuntimeProfile,
  loadDevelopmentRecoveryRuntimeProfile
} from "./development-continue-runtime-profile.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"

const RUN_ID = "L".repeat(43)
const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const OTHER_SHA = "c".repeat(40)
const PROMPT_HASH = "d".repeat(64)
const STARTED_AT = "2026-08-23T00:00:00.000Z"
const ENDED_AT = "2026-08-23T00:01:00.000Z"
const PROJECTS = listPhase2GitHubProjects().map((project) => ({
  ...project,
  fullName: `${project.owner}/${project.repo}`
}))
const PROJECT = PROJECTS[0]

function attempts(overrides = {}) {
  return {
    planning: 0,
    implementation: 0,
    test: 0,
    review: 0,
    merge: 0,
    deploy: 0,
    verification: 0,
    rollback: 0,
    ...overrides
  }
}

function evidence(overrides = {}) {
  return {
    planning: [],
    implementation: [],
    review: [],
    test: [],
    merge: [],
    deploy: [],
    verification: [],
    rollback: [],
    ...overrides
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function runFor(status, options = {}) {
  const runProject = options.project || PROJECT

  return {
    runId: options.runId || RUN_ID,
    version: options.version ?? 7,
    project: runProject,
    status,
    stage: options.stage || "implementation",
    baseSha: BASE_SHA,
    branch: options.branch || "phase-6l-fixture",
    headSha: options.headSha === undefined ? HEAD_SHA : options.headSha,
    attempts: attempts(options.attempts),
    evidence: evidence(options.evidence),
    history: options.history || [],
    timestamps: options.timestamps || {
      createdAt: STARTED_AT,
      updatedAt: STARTED_AT,
      statusChangedAt: STARTED_AT
    }
  }
}

function makeReader(sequence) {
  const records = Array.isArray(sequence) ? sequence : [sequence]
  const reads = []

  return {
    reads,
    async readRun(runId) {
      reads.push(runId)
      const index = Math.min(reads.length - 1, records.length - 1)
      return clone(records[index])
    }
  }
}

function makeReconcilers(overrides = {}) {
  const calls = []
  const record = (name, result) => async (runId, options) => {
    calls.push({ name, runId, options })
    return typeof result === "function" ? await result(runId, options) : clone(result)
  }

  return {
    calls,
    reconcilers: {
      inspectImplementationWorkspace: record("inspectImplementationWorkspace", {
        ok: true,
        outcome: "workspace_inspected",
        status: "missing",
        exists: false,
        matches: false
      }),
      reconcileCodexExecution: record("reconcileCodexExecution", {
        ok: true,
        outcome: "codex_execution_reconciled",
        status: "unchanged"
      }),
      reconcileAutomatedTesting: record("reconcileAutomatedTesting", {
        ok: true,
        outcome: "automated_testing_reconciled",
        status: "matching"
      }),
      reconcileIndependentReview: record("reconcileIndependentReview", {
        ok: true,
        outcome: "independent_review_reconciled",
        status: "open_attempt"
      }),
      reconcileGitHubDelivery: record("reconcileGitHubDelivery", {
        ok: true,
        outcome: "github_delivery_reconciled",
        delivery: {
          remoteBranchSha: HEAD_SHA,
          ciStatus: "unknown",
          mergeStatus: "review_passed"
        }
      }),
      ...Object.fromEntries(Object.entries(overrides).map(([name, result]) => [name, record(name, result)]))
    }
  }
}

async function recoveryProfileProvider(request) {
  return await loadDevelopmentRecoveryRuntimeProfile(request, {
    platform: "darwin",
    includeTestPolicy: request.includeTestPolicy === true
  })
}

async function recoveryOptions(run, reconcilers = makeReconcilers()) {
  return {
    readRun: makeReader(run).readRun,
    reconcilers: reconcilers.reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  }
}

async function policyIdentityFor(run) {
  const profile = await loadDevelopmentRecoveryRuntimeProfile({ run }, {
    platform: "darwin",
    includeTestPolicy: true
  })

  return resolveAutomatedTestPolicyIdentity(run, {
    testPolicyRegistry: profile.testPolicyRegistry
  })
}

function codexStartedEvidence(run, overrides = {}) {
  return {
    kind: "implementation",
    sha: HEAD_SHA,
    source: CODEX_EXECUTION_ADAPTER_ID,
    summary: "Codex execution attempt reserved.",
    metadata: {
      project: run.project.id,
      adapter: CODEX_EXECUTION_ADAPTER_ID,
      attempt: run.attempts.implementation,
      promptHash: PROMPT_HASH,
      startedAt: STARTED_AT,
      outcome: "execution_started",
      sandbox: CODEX_EXECUTION_SANDBOX_ID,
      network: "none",
      remotePolicy: "deny",
      branch: run.branch,
      workspaceId: "khlim-assist-workspace",
      workspaceRef: "refs/heads/phase-6l-fixture",
      ...overrides
    }
  }
}

function testEvidence(run, policyIdentity, outcome, overrides = {}) {
  const base = {
    project: run.project.id,
    runner: AUTOMATED_TEST_RUNNER_ID,
    attempt: run.attempts.test,
    policyId: policyIdentity.policyId,
    policyHash: policyIdentity.policyHash,
    implSha: HEAD_SHA,
    startedAt: STARTED_AT,
    outcome,
    sandbox: AUTOMATED_TEST_SANDBOX_ID,
    network: "none",
    branch: run.branch
  }

  if (outcome === "testing_started") {
    base.workspaceId = "khlim-assist-workspace"
    base.workspaceRef = "refs/heads/phase-6l-fixture"
  } else {
    base.endedAt = ENDED_AT
    base.total = policyIdentity.requiredTestCount
    base.passed = outcome === "passed" ? policyIdentity.requiredTestCount : 0
    base.failed = outcome === "failed" ? 1 : 0
    base.ambiguous = 0
  }

  return {
    kind: "test",
    sha: HEAD_SHA,
    source: AUTOMATED_TEST_RUNNER_ID,
    summary: "Automated test metadata-only evidence.",
    metadata: {
      ...base,
      ...overrides
    }
  }
}

test("Phase 6L status contract covers every development run status exactly once", () => {
  assert.deepEqual(Object.keys(PHASE_6L_RECOVERY_STATUS_CONTRACT).sort(), [...DEVELOPMENT_RUN_STATUSES].sort())
})

test("Phase 6L dispatches exactly one read-only recovery boundary for each recoverable status", async () => {
  const expectedChild = new Map([
    ["planned", "inspectImplementationWorkspace"],
    ["implementation_in_progress", "reconcileCodexExecution"],
    ["tests_in_progress", "reconcileAutomatedTesting"],
    ["tests_failed", "reconcileAutomatedTesting"],
    ["review_in_progress", "reconcileIndependentReview"],
    ["review_passed", "reconcileGitHubDelivery"],
    ["merge_ready", "reconcileGitHubDelivery"]
  ])

  for (const status of DEVELOPMENT_RUN_STATUSES) {
    const run = runFor(status, {
      attempts: {
        implementation: 1,
        test: 1
      }
    })
    const children = makeReconcilers()
    const result = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(run, children))

    assert.equal(result.coordinator, DEVELOPMENT_RECOVERY_COORDINATOR_ID, status)
    assert.equal(result.policyId, PHASE_6L_RECOVERY_POLICY_ID, status)
    assert.equal(children.calls.length, expectedChild.has(status) ? 1 : 0, status)

    if (expectedChild.has(status)) {
      assert.equal(children.calls[0].name, expectedChild.get(status), status)
    }
  }
})

test("Phase 6L refuses malformed run ids and caller-controlled recovery targets", async () => {
  const run = runFor("created")
  const result = await executeDevelopmentRecovery("short", await recoveryOptions(run))
  assert.equal(result.ok, false)
  assert.equal(result.outcome, "recovery_unavailable")

  for (const key of ["expectedVersion", "project", "workspaceRegistry", "testPolicyRegistry", "command", "service", "confirmation"]) {
    const blocked = await executeDevelopmentRecovery(RUN_ID, {
      ...(await recoveryOptions(run)),
      [key]: "caller-controlled"
    })
    assert.equal(blocked.ok, false, key)
    assert.equal(blocked.outcome, "recovery_unavailable", key)
  }
})

test("Phase 6L validates ordinary project identity and keeps PPO production recovery out of scope", async () => {
  const ppoRun = runFor("verification_failed", {
    project: PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
  })
  const ppo = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(ppoRun))
  assert.equal(ppo.outcome, "production_recovery_out_of_scope")
  assert.equal(ppo.observation, "project_out_of_scope")

  const malformed = runFor("planned", {
    project: {
      ...PROJECT,
      repo: "wrong-repo",
      fullName: `${PROJECT.owner}/wrong-repo`
    }
  })
  const invalid = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(malformed))
  assert.equal(invalid.outcome, "recovery_unavailable")
  assert.equal(invalid.observation, "project_identity_invalid")
})

test("Phase 6L planned workspace recovery maps missing, ahead, and mismatched states without mutation", async () => {
  const missingChildren = makeReconcilers({
    inspectImplementationWorkspace: {
      ok: true,
      outcome: "workspace_inspected",
      status: "missing",
      exists: false,
      matches: false
    }
  })
  const missing = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(runFor("planned"), missingChildren))
  assert.equal(missing.outcome, "recovery_not_required")
  assert.equal(missing.observation, "workspace_missing")

  const aheadChildren = makeReconcilers({
    inspectImplementationWorkspace: {
      ok: true,
      outcome: "workspace_inspected",
      status: "matching",
      exists: true,
      matches: true
    }
  })
  const ahead = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(runFor("planned"), aheadChildren))
  assert.equal(ahead.outcome, "owner_action_required")
  assert.equal(ahead.observation, "workspace_state_ahead")

  const mismatchChildren = makeReconcilers({
    inspectImplementationWorkspace: {
      ok: true,
      outcome: "workspace_inspected",
      status: "mismatch",
      exists: true,
      matches: false
    }
  })
  const mismatch = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(runFor("planned"), mismatchChildren))
  assert.equal(mismatch.outcome, "owner_action_required")
  assert.equal(mismatch.observation, "workspace_mismatched")
})

test("Phase 6L Codex recovery observes open and workspace states without execution or promotion", async () => {
  const openRun = runFor("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  openRun.evidence.implementation = [codexStartedEvidence(openRun)]
  const open = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(openRun))
  assert.equal(open.outcome, "recovery_observed")
  assert.equal(open.observation, "codex_attempt_open")
  assert.equal(open.run.status, "implementation_in_progress")

  for (const [status, observation] of [
    ["unchanged", "codex_workspace_unchanged"],
    ["advanced", "codex_workspace_advanced"],
    ["mismatched", "codex_workspace_mismatched"]
  ]) {
    const children = makeReconcilers({
      reconcileCodexExecution: {
        ok: true,
        outcome: "codex_execution_reconciled",
        status
      }
    })
    const result = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(runFor("implementation_in_progress"), children))
    assert.equal(result.observation, observation)
    assert.equal(result.run.status, "implementation_in_progress")
    assert.equal(children.calls.length, 1)
  }
})

test("Phase 6L malformed current Codex evidence fails closed", async () => {
  const run = runFor("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  run.evidence.implementation = [codexStartedEvidence(run, {
    source: "wrong-source"
  })]
  run.evidence.implementation[0].source = "wrong-source"

  const result = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(run))
  assert.equal(result.outcome, "recovery_unavailable")
  assert.equal(result.observation, "codex_evidence_invalid")
})

test("Phase 6L automated testing recovery uses the exact current reviewed policy identity", async () => {
  const run = runFor("tests_in_progress", {
    attempts: { test: 1 }
  })
  const identity = await policyIdentityFor(run)
  run.evidence.test = [testEvidence(run, identity, "testing_started")]
  const open = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(run))
  assert.equal(open.observation, "test_attempt_open")

  const failedRun = runFor("tests_failed", {
    attempts: { test: 1 }
  })
  const failedIdentity = await policyIdentityFor(failedRun)
  failedRun.evidence.test = [testEvidence(failedRun, failedIdentity, "failed")]
  const failed = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(failedRun))
  assert.equal(failed.observation, "test_failure_recorded")

  const passRun = runFor("tests_in_progress", {
    attempts: { test: 1 }
  })
  const passIdentity = await policyIdentityFor(passRun)
  passRun.evidence.test = [testEvidence(passRun, passIdentity, "passed")]
  const passed = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(passRun))
  assert.equal(passed.observation, "test_pass_evidence_present")

  const stalePolicyRun = runFor("tests_in_progress", {
    attempts: { test: 1 }
  })
  stalePolicyRun.evidence.test = [testEvidence(stalePolicyRun, passIdentity, "failed", {
    policyHash: "f".repeat(64)
  })]
  const stale = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(stalePolicyRun))
  assert.equal(stale.outcome, "owner_action_required")
  assert.equal(stale.observation, "test_evidence_untrusted")
})

test("Phase 6L recovery-only profile matches Phase 6K policy identity without mutation readiness probes", async () => {
  const directoryPaths = new Set([
    "/Users/richie/.local/share/personal-project-operator/development-workspaces",
    "/Users/richie/khlim-assist",
    "/Users/richie/ledgerpilot-ai",
    "/Users/richie/spy-market-agent",
    "/Users/richie/richie-linardi-portfolio-website",
    "/Users/richie/rbl-content-engine"
  ])
  const fakeStat = async (path) => ({
    isFile: () => !directoryPaths.has(path),
    isDirectory: () => directoryPaths.has(path)
  })
  const fakeAccess = async () => {}
  const fakeExec = async () => ({ stdout: "ok\n", stderr: "" })

  for (const project of PROJECTS) {
    const run = runFor("tests_in_progress", {
      project,
      attempts: { test: 1 }
    })
    const continueProfile = await loadDevelopmentContinueRuntimeProfile({ run }, {
      platform: "darwin",
      statImpl: fakeStat,
      accessImpl: fakeAccess,
      execFileImpl: fakeExec
    })
    const recoveryProfile = await loadDevelopmentRecoveryRuntimeProfile({ run }, {
      platform: "darwin",
      includeTestPolicy: true,
      execFileImpl: async () => {
        throw new Error("SENSITIVE_TEST_SENTINEL recovery must not probe mutation runtime")
      }
    })
    const continueIdentity = resolveAutomatedTestPolicyIdentity(run, continueProfile)
    const recoveryIdentity = resolveAutomatedTestPolicyIdentity(run, recoveryProfile)

    assert.deepEqual(recoveryIdentity, continueIdentity, project.id)
  }
})

test("Phase 6L review recovery invokes only independent review reconciliation", async () => {
  for (const [status, observation] of [
    ["open_attempt", "review_attempt_open"],
    ["approval_valid", "review_approval_evidence_present"],
    ["matching", "review_workspace_matching"]
  ]) {
    const children = makeReconcilers({
      reconcileIndependentReview: {
        ok: true,
        outcome: "independent_review_reconciled",
        status
      }
    })
    const result = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(runFor("review_in_progress"), children))

    assert.equal(result.observation, observation)
    assert.equal(children.calls.length, 1)
    assert.equal(children.calls[0].name, "reconcileIndependentReview")
  }
})

test("Phase 6L GitHub delivery recovery is read-only and never marks durable merged", async () => {
  let writeCalled = false
  const githubClient = {
    createPullRequest: async () => {
      writeCalled = true
      throw new Error("write refused")
    },
    mergePullRequest: async () => {
      writeCalled = true
      throw new Error("write refused")
    },
    submitPullRequestReview: async () => {
      writeCalled = true
      throw new Error("write refused")
    }
  }
  const children = makeReconcilers({
    reconcileGitHubDelivery: async (_runId, options) => {
      assert.equal(options.githubClient, githubClient)
      return {
        ok: true,
        outcome: "github_delivery_reconciled",
        delivery: {
          prNumber: 123,
          ciStatus: "passed",
          mergeStatus: "merged_remote"
        }
      }
    }
  })
  const result = await executeDevelopmentRecovery(RUN_ID, {
    ...(await recoveryOptions(runFor("merge_ready"), children)),
    githubClient
  })

  assert.equal(writeCalled, false)
  assert.equal(result.observation, "delivery_remote_merged")
  assert.equal(result.run.status, "merge_ready")
})

test("Phase 6L detects concurrent durable state changes after read-only observation", async () => {
  const before = runFor("implementation_in_progress", {
    version: 7
  })
  const after = runFor("implementation_ready", {
    version: 8
  })
  const reader = makeReader([before, after])
  const result = await executeDevelopmentRecovery(RUN_ID, {
    readRun: reader.readRun,
    reconcilers: makeReconcilers().reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  })

  assert.equal(result.outcome, "stale_recovery_observation")
  assert.equal(result.observation, "state_changed")
  assert.equal(reader.reads.length, 2)
})

test("Phase 6L detects child reconciler state-write regressions from claimed child run", async () => {
  const run = runFor("implementation_in_progress")
  const children = makeReconcilers({
    reconcileCodexExecution: {
      ok: true,
      outcome: "codex_execution_reconciled",
      status: "advanced",
      run: {
        ...run,
        version: run.version + 1,
        status: "implementation_ready"
      }
    }
  })
  const result = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(run, children))

  assert.equal(result.outcome, "recovery_state_changed")
  assert.equal(result.observation, "state_changed")
})

test("Phase 6L malformed child results and unsafe values collapse to bounded recovery_unavailable", async () => {
  for (const childResult of [
    null,
    { ok: true, outcome: "unexpected_outcome", status: "advanced" },
    { ok: true, outcome: "codex_execution_reconciled", status: "SENSITIVE_TEST_SENTINEL token=abc" }
  ]) {
    const children = makeReconcilers({
      reconcileCodexExecution: childResult
    })
    const result = await executeDevelopmentRecovery(RUN_ID, await recoveryOptions(runFor("implementation_in_progress"), children))

    assert.equal(result.outcome, "recovery_unavailable")
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_TEST_SENTINEL|token=abc/)
  }
})

test("Phase 6L never calls injected mutation state APIs", async () => {
  const run = runFor("created")
  const result = await executeDevelopmentRecovery(RUN_ID, {
    ...(await recoveryOptions(run)),
    transitionDevelopmentRun: () => {
      throw new Error("transition must not be called")
    },
    recordDevelopmentRunProgress: () => {
      throw new Error("record must not be called")
    },
    createDevelopmentRun: () => {
      throw new Error("create must not be called")
    }
  })

  assert.equal(result.outcome, "recovery_not_required")
})

test("Phase 6L formatter is bounded and omits raw evidence and secrets", () => {
  const output = formatDevelopmentRecoveryResult({
    schemaVersion: 1,
    coordinator: DEVELOPMENT_RECOVERY_COORDINATOR_ID,
    policyId: PHASE_6L_RECOVERY_POLICY_ID,
    policyHash: "e".repeat(64),
    ok: true,
    run: {
      runId: RUN_ID,
      project: PROJECT.id,
      version: 7,
      status: "implementation_in_progress",
      headSha: HEAD_SHA
    },
    phase: "6D",
    operation: "reconcile-codex-execution",
    outcome: "recovery_observed",
    observation: "codex_attempt_open",
    ownerActionRequired: true,
    continuationCandidate: false,
    evidence: [{ secret: "SENSITIVE_TEST_SENTINEL" }]
  })

  assert.match(output, /PPO Development Recovery/)
  assert.match(output, /Owner action: required/)
  assert.doesNotMatch(output, /SENSITIVE_TEST_SENTINEL|evidence|stdout|stderr|token/)
})

test("Phase 6L coordinator source remains composition-only and production-isolated", async () => {
  const source = await readFile(new URL("./development-recovery-coordinator.mjs", import.meta.url), "utf8")

  assert.doesNotMatch(source, /development-deployment-agent\.mjs/)
  assert.doesNotMatch(source, /development-production-verification-agent\.mjs/)
  assert.doesNotMatch(source, /development-rollback-agent\.mjs/)
  assert.doesNotMatch(source, /deploy-exact-sha\.sh|verify-production-readonly\.sh|rollback-exact-sha\.sh|service-control\.sh/)
  assert.doesNotMatch(source, /systemctl|\/opt\/personal-project-operator|\/var\/lib\/personal-project-operator|\bSSH\b|VPS/)
  assert.doesNotMatch(source, /\b(?:exec|execFile|spawn|spawnSync)\b/)
  assert.doesNotMatch(source, /\b(?:git push|git merge|git checkout|git switch|gh |curl|wget|ssh|scp|rsync)\b/)
  assert.doesNotMatch(source, /planExistingDevelopmentRun|prepareImplementationWorkspace|executeCodexImplementation|executeAutomatedTests|executeIndependentReview|executeBoundedHardening|executePhase6GDelivery|executeShaPinnedMerge/)
  assert.doesNotMatch(source, /transitionDevelopmentRun|recordDevelopmentRunProgress|createDevelopmentRun/)
})
