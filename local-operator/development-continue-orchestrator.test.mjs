import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  CODEX_EXECUTION_SANDBOX_ID
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  AUTOMATED_TEST_SANDBOX_ID
} from "./development-test-runner.mjs"
import {
  executeDevelopmentContinue,
  formatDevelopmentContinueResult,
  handlePpoDevelopmentContinueCommand
} from "./development-continue-orchestrator.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"

const RUN_ID = "A".repeat(43)
const BAD_RUN_ID = "short"
const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const NEXT_SHA = "c".repeat(40)
const WRONG_SHA = "d".repeat(40)
const PROMPT_HASH = "e".repeat(64)
const TEST_POLICY_HASH = "f".repeat(64)
const STARTED_AT = "2026-08-23T00:00:00.000Z"
const ENDED_AT = "2026-08-23T00:01:00.000Z"
const PROJECT = {
  ...listPhase2GitHubProjects()[0],
  fullName: `${listPhase2GitHubProjects()[0].owner}/${listPhase2GitHubProjects()[0].repo}`
}
const TEST_POLICY_ID = "phase-6e-local-node-policy"

function evidence() {
  return {
    planning: [],
    implementation: [],
    review: [],
    test: [],
    merge: [],
    deploy: [],
    verification: [],
    rollback: []
  }
}

function attempts() {
  return {
    planning: 0,
    implementation: 0,
    test: 0,
    review: 0,
    merge: 0,
    deploy: 0,
    verification: 0,
    rollback: 0
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeRun(status, options = {}) {
  return {
    runId: options.runId || RUN_ID,
    version: options.version ?? 7,
    project: options.project || PROJECT,
    status,
    stage: options.stage || "implementation",
    baseSha: BASE_SHA,
    branch: "phase-6k-fixture",
    headSha: options.headSha === undefined ? HEAD_SHA : options.headSha,
    attempts: {
      ...attempts(),
      ...(options.attempts || {})
    },
    evidence: {
      ...evidence(),
      ...(options.evidence || {})
    }
  }
}

function makeReader(sequence) {
  const reads = []
  const records = Array.isArray(sequence) ? sequence : [sequence]

  return {
    reads,
    async readRun(runId) {
      reads.push(runId)
      const index = Math.min(reads.length - 1, records.length - 1)
      return clone(records[index])
    }
  }
}

function makeChildHandlers(afterByHandler = {}) {
  const calls = []
  const handlers = {}

  for (const [handler, afterStatus] of Object.entries(afterByHandler)) {
    handlers[handler] = async (runId, options) => {
      calls.push({
        handler,
        runId,
        expectedVersion: options.expectedVersion,
        options
      })

      return {
        ok: true,
        outcome: afterStatus,
        run: makeRun(afterStatus, {
          version: options.expectedVersion + 1,
          headSha: NEXT_SHA
        })
      }
    }
  }

  return {
    calls,
    handlers
  }
}

function codexAttemptEvidence(run, overrides = {}) {
  const outcome = overrides.outcome || "execution_started"
  const metadata = {
    project: run.project.id,
    branch: run.branch,
    workspaceId: "phase-6k-workspace",
    workspaceRef: "worktrees/phase-6k-workspace",
    adapter: CODEX_EXECUTION_ADAPTER_ID,
    attempt: run.attempts.implementation,
    promptHash: PROMPT_HASH,
    startedAt: STARTED_AT,
    outcome,
    remotePolicy: "deny",
    sandbox: CODEX_EXECUTION_SANDBOX_ID,
    backend: "macos-sandbox-exec",
    platform: "darwin",
    network: "none",
    ...(outcome === "execution_failed" ? { endedAt: ENDED_AT } : {}),
    ...(overrides.metadata || {})
  }

  if (overrides.omitMetadata) {
    for (const key of overrides.omitMetadata) {
      delete metadata[key]
    }
  }

  return {
    kind: "implementation",
    sha: run.headSha,
    source: CODEX_EXECUTION_ADAPTER_ID,
    summary: "Codex execution attempt fixture.",
    metadata,
    ...overrides.entry
  }
}

function testStartedEvidence(run, overrides = {}) {
  const metadata = {
    project: run.project.id,
    branch: run.branch,
    workspaceId: "phase-6k-workspace",
    workspaceRef: "worktrees/phase-6k-workspace",
    runner: AUTOMATED_TEST_RUNNER_ID,
    attempt: run.attempts.test,
    policyId: TEST_POLICY_ID,
    policyHash: TEST_POLICY_HASH,
    implSha: run.headSha,
    outcome: "testing_started",
    startedAt: STARTED_AT,
    sandbox: AUTOMATED_TEST_SANDBOX_ID,
    network: "none",
    ...(overrides.metadata || {})
  }

  if (overrides.omitMetadata) {
    for (const key of overrides.omitMetadata) {
      delete metadata[key]
    }
  }

  return {
    kind: "test",
    sha: run.headSha,
    source: AUTOMATED_TEST_RUNNER_ID,
    summary: "Automated test attempt fixture.",
    metadata,
    ...overrides.entry
  }
}

function testFailureEvidence(run, overrides = {}) {
  const metadata = {
    project: run.project.id,
    branch: run.branch,
    runner: AUTOMATED_TEST_RUNNER_ID,
    attempt: run.attempts.test,
    policyId: TEST_POLICY_ID,
    policyHash: TEST_POLICY_HASH,
    implSha: run.headSha,
    outcome: "failed",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    total: 2,
    passed: 1,
    failed: 1,
    ambiguous: 0,
    sandbox: AUTOMATED_TEST_SANDBOX_ID,
    network: "none",
    ...(overrides.metadata || {})
  }

  if (overrides.omitMetadata) {
    for (const key of overrides.omitMetadata) {
      delete metadata[key]
    }
  }

  return {
    kind: "test",
    sha: run.headSha,
    source: AUTOMATED_TEST_RUNNER_ID,
    summary: "Automated test aggregate failure fixture.",
    metadata,
    ...overrides.entry
  }
}

async function tempWriteDataDir(label = "ppo-6k-") {
  return mkdtemp(join(tmpdir(), label))
}

test("Phase 6K dispatches each supported status to exactly one reviewed child boundary", async () => {
  const cases = [
    ["created", "planExistingDevelopmentRun", "phase-6b-plan", "planned"],
    ["planned", "prepareImplementationWorkspace", "phase-6c-prepare-workspace", "implementation_in_progress"],
    ["implementation_in_progress", "executeCodexImplementation", "phase-6d-codex-implementation", "implementation_ready"],
    ["implementation_ready", "executeAutomatedTests", "phase-6e-automated-tests", "tests_passed"],
    ["tests_passed", "executeIndependentReview", "phase-6f-independent-review", "review_passed"],
    ["review_changes_requested", "executeBoundedHardening", "phase-6f-bounded-hardening", "review_passed"],
    ["review_passed", "executePhase6GDelivery", "phase-6g-delivery", "merged"],
    ["merge_ready", "executeShaPinnedMerge", "phase-6g-sha-pinned-merge", "merged"]
  ]

  for (const [status, handlerName, action, afterStatus] of cases) {
    const run = makeRun(status)
    const reader = makeReader(run)
    const children = makeChildHandlers({ [handlerName]: afterStatus })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, true, status)
    assert.equal(result.before, status, status)
    assert.equal(result.action, action, status)
    assert.equal(result.after, afterStatus, status)
    assert.equal(children.calls.length, 1, status)
    assert.equal(children.calls[0].handler, handlerName, status)
    assert.equal(children.calls[0].runId, RUN_ID, status)
    assert.equal(children.calls[0].expectedVersion, run.version, status)
    assert.equal(Object.hasOwn(children.calls[0].options, "project"), false, status)
  }
})

test("Phase 6K allows automated-test retry only after definitive Phase 6E failure evidence", async () => {
  const run = makeRun("tests_in_progress", {
    attempts: { test: 1 },
  })
  run.evidence.test = [testFailureEvidence(run)]
  const reader = makeReader(run)
  const children = makeChildHandlers({
    executeAutomatedTests: "tests_passed"
  })
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: reader.readRun,
    childHandlers: children.handlers
  })

  assert.equal(result.ok, true)
  assert.equal(result.action, "phase-6e-automated-test-retry")
  assert.equal(result.after, "tests_passed")
  assert.equal(children.calls.length, 1)
  assert.equal(children.calls[0].expectedVersion, run.version)
})

test("Phase 6K refuses open or ambiguous attempts before dispatch", async () => {
  const implementationRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  implementationRun.evidence.implementation = [codexAttemptEvidence(implementationRun)]
  const testingRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  testingRun.evidence.test = [testStartedEvidence(testingRun)]
  const cases = [
    [implementationRun, "codex_reconciliation_required"],
    [testingRun, "automated_test_reconciliation_required"],
    [makeRun("tests_in_progress", { evidence: { test: [] } }), "automated_test_reconciliation_required"],
    [makeRun("planning_in_progress"), "planning_reconciliation_required"],
    [makeRun("review_in_progress"), "review_reconciliation_required"],
    [makeRun("tests_failed"), "automated_test_failure_recovery_not_routed"]
  ]

  for (const [run, reason] of cases) {
    const reader = makeReader(run)
    const children = makeChildHandlers({
      executeCodexImplementation: "implementation_ready",
      executeAutomatedTests: "tests_passed",
      executeIndependentReview: "review_passed",
      planExistingDevelopmentRun: "planned"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, false, run.status)
    assert.equal(result.outcome, "owner_action_required", run.status)
    assert.equal(result.reason, reason, run.status)
    assert.equal(children.calls.length, 0, run.status)
  }
})

test("Phase 6K rejects stale state before invoking a mutating child phase", async () => {
  const initial = makeRun("created", { version: 4 })
  const changed = makeRun("created", { version: 5 })
  const reader = makeReader([initial, changed])
  const children = makeChildHandlers({
    planExistingDevelopmentRun: "planned"
  })
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: reader.readRun,
    childHandlers: children.handlers
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "stale_state")
  assert.equal(result.reason, "run_changed_before_dispatch")
  assert.equal(children.calls.length, 0)
})

test("Phase 6K refuses malformed durable evidence instead of dispatching", async () => {
  const run = makeRun("implementation_in_progress", {
    evidence: {
      ...evidence(),
      implementation: null
    }
  })
  const reader = makeReader(run)
  const children = makeChildHandlers({
    executeCodexImplementation: "implementation_ready"
  })
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: reader.readRun,
    childHandlers: children.handlers
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "continue_durable_evidence_invalid")
  assert.equal(children.calls.length, 0)
})

test("Phase 6K binds Phase 6D retry authorization to trusted current attempt evidence", async () => {
  const wrongSourceRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 1 },
    evidence: {
      implementation: [{
        kind: "implementation",
        sha: HEAD_SHA,
        source: "unrelated-agent",
        metadata: {
          outcome: "execution_started",
          attempt: 1,
          adapter: "unrelated-agent"
        }
      }]
    }
  })
  const wrongShaRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  wrongShaRun.evidence.implementation = [codexAttemptEvidence(wrongShaRun, {
    outcome: "execution_failed",
    entry: { sha: WRONG_SHA },
    metadata: {
      expectedStartSha: WRONG_SHA
    }
  })]
  const staleAttemptRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 2 }
  })
  staleAttemptRun.evidence.implementation = [codexAttemptEvidence(staleAttemptRun, {
    outcome: "execution_failed",
    metadata: { attempt: 1 }
  })]
  const malformedRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  malformedRun.evidence.implementation = [codexAttemptEvidence(malformedRun, {
    outcome: "execution_failed",
    omitMetadata: ["promptHash"]
  })]

  for (const run of [wrongSourceRun, wrongShaRun, staleAttemptRun, malformedRun]) {
    const reader = makeReader(run)
    const children = makeChildHandlers({
      executeCodexImplementation: "implementation_ready"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, false)
    assert.equal(result.outcome, "owner_action_required")
    assert.equal(result.reason, "codex_evidence_invalid")
    assert.equal(children.calls.length, 0)
  }

  const openRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  openRun.evidence.implementation = [codexAttemptEvidence(openRun)]
  {
    const reader = makeReader(openRun)
    const children = makeChildHandlers({
      executeCodexImplementation: "implementation_ready"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "codex_reconciliation_required")
    assert.equal(children.calls.length, 0)
  }

  const definitiveFailureRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  definitiveFailureRun.evidence.implementation = [codexAttemptEvidence(definitiveFailureRun, {
    outcome: "execution_failed"
  })]
  {
    const reader = makeReader(definitiveFailureRun)
    const children = makeChildHandlers({
      executeCodexImplementation: "implementation_ready"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, "phase-6d-codex-implementation")
    assert.equal(children.calls.length, 1)
    assert.equal(children.calls[0].expectedVersion, definitiveFailureRun.version)
  }
})

test("Phase 6K binds Phase 6E retry authorization to trusted aggregate failure evidence", async () => {
  const unrelatedFailureRun = makeRun("tests_in_progress", {
    attempts: { test: 1 },
    evidence: {
      test: [{
        kind: "test",
        sha: HEAD_SHA,
        source: "unrelated-agent",
        metadata: {
          outcome: "failed"
        }
      }]
    }
  })
  const wrongShaRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  wrongShaRun.evidence.test = [testFailureEvidence(wrongShaRun, {
    entry: { sha: WRONG_SHA },
    metadata: { implSha: WRONG_SHA }
  })]
  const wrongRunnerRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  wrongRunnerRun.evidence.test = [testFailureEvidence(wrongRunnerRun, {
    metadata: { runner: "unrelated-runner" }
  })]
  const staleAttemptRun = makeRun("tests_in_progress", {
    attempts: { test: 2 }
  })
  staleAttemptRun.evidence.test = [testFailureEvidence(staleAttemptRun, {
    metadata: { attempt: 1 }
  })]
  const malformedRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  malformedRun.evidence.test = [testFailureEvidence(malformedRun, {
    omitMetadata: ["policyHash"]
  })]
  const stepFailureRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  stepFailureRun.evidence.test = [testFailureEvidence(stepFailureRun, {
    metadata: { testId: "unit" }
  })]

  for (const run of [
    unrelatedFailureRun,
    wrongShaRun,
    wrongRunnerRun,
    staleAttemptRun,
    malformedRun,
    stepFailureRun
  ]) {
    const reader = makeReader(run)
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, false)
    assert.equal(result.outcome, "owner_action_required")
    assert.equal(result.reason, "automated_test_evidence_invalid")
    assert.equal(children.calls.length, 0)
  }

  const openRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  openRun.evidence.test = [testStartedEvidence(openRun)]
  {
    const reader = makeReader(openRun)
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "automated_test_reconciliation_required")
    assert.equal(children.calls.length, 0)
  }

  const trustedFailureRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  trustedFailureRun.evidence.test = [testFailureEvidence(trustedFailureRun)]
  {
    const reader = makeReader(trustedFailureRun)
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, "phase-6e-automated-test-retry")
    assert.equal(children.calls.length, 1)
    assert.equal(children.calls[0].expectedVersion, trustedFailureRun.version)
  }
})

test("Phase 6K surfaces child owner-action outcomes without bypassing caps or reviews", async () => {
  {
    const run = makeRun("review_changes_requested")
    const reader = makeReader(run)
    const calls = []
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: {
        executeBoundedHardening: async (runId, options) => {
          calls.push({ runId, expectedVersion: options.expectedVersion })
          return {
            ok: false,
            outcome: "owner_action_required",
            reason: "hardening_cap_exhausted",
            run
          }
        }
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.action, "phase-6f-bounded-hardening")
    assert.equal(result.outcome, "owner_action_required")
    assert.equal(result.reason, "hardening_cap_exhausted")
    assert.equal(calls.length, 1)
  }

  {
    const run = makeRun("review_passed")
    const reader = makeReader(run)
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: {
        executePhase6GDelivery: async () => ({
          ok: false,
          outcome: "remote_review_changes_requested",
          reasonCode: "remote_review_changes_requested",
          run
        })
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.action, "phase-6g-delivery")
    assert.equal(result.outcome, "remote_review_changes_requested")
    assert.equal(result.reason, "remote_review_changes_requested")
  }
})

test("Phase 6K reports durable child failure state after one read-only reload", async () => {
  const writeDataDir = await tempWriteDataDir()
  const created = await createDevelopmentRun({
    projectId: PROJECT.id,
    task: "Phase 6K child failure reconciliation fixture.",
    baseSha: BASE_SHA,
    branch: "phase-6k-child-failure",
    actor: "phase-6k-test"
  }, {
    writeDataDir
  })
  const planning = await transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress",
    actor: "phase-6k-test",
    reason: "phase-6k-fixture-planning"
  }, {
    writeDataDir
  })
  const planned = await transitionDevelopmentRun(created.runId, {
    expectedVersion: planning.version,
    status: "planned",
    actor: "phase-6k-test",
    reason: "phase-6k-fixture-planned"
  }, {
    writeDataDir
  })
  let childCalls = 0

  const result = await executeDevelopmentContinue(created.runId, {
    writeDataDir,
    childHandlers: {
      prepareImplementationWorkspace: async (runId, options) => {
        childCalls += 1
        await transitionDevelopmentRun(runId, {
          expectedVersion: options.expectedVersion,
          status: "implementation_in_progress",
          headSha: NEXT_SHA,
          branch: "phase-6k-child-failure",
          actor: "phase-6k-test",
          reason: "phase-6k-fixture-child-mutated"
        }, {
          writeDataDir
        })
        const error = new Error("SENSITIVE_TEST_SENTINEL raw child failure")
        error.code = "SAFE_CHILD_FAILURE"
        error.outcome = "remote_review_changes_requested"
        error.reasonCode = "child_safe_failure"
        throw error
      }
    }
  })

  assert.equal(childCalls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.before, "planned")
  assert.equal(result.action, "phase-6c-prepare-workspace")
  assert.equal(result.outcome, "remote_review_changes_requested")
  assert.equal(result.reason, "child_safe_failure")
  assert.equal(result.after, "implementation_in_progress")
  assert.equal(result.headSha, NEXT_SHA)

  const stored = JSON.parse(await readFile(join(
    writeDataDir,
    "development-runs",
    "records",
    `${planned.runId}.json`
  ), "utf8"))
  assert.equal(stored.status, "implementation_in_progress")
  assert.equal(stored.headSha, NEXT_SHA)
  assert.equal(stored.version, planned.version + 1)
})

test("Phase 6K bounds child failure output when post-failure reload is unavailable", async () => {
  const run = makeRun("created")
  const calls = []
  const reader = {
    async readRun() {
      calls.push("read")

      if (calls.length > 2) {
        throw new Error("SENSITIVE_TEST_SENTINEL raw reload failure")
      }

      return clone(run)
    }
  }
  let childCalls = 0
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: reader.readRun,
    childHandlers: {
      planExistingDevelopmentRun: async () => {
        childCalls += 1
        const error = new Error("SENSITIVE_TEST_SENTINEL raw child failure")
        error.code = "SAFE_CHILD_FAILURE"
        error.outcome = "remote_review_changes_requested"
        error.reasonCode = "child_safe_failure"
        throw error
      }
    }
  })

  assert.equal(childCalls, 1)
  assert.equal(calls.length, 3)
  assert.equal(result.ok, false)
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "child_state_reload_failed")
  assert.equal(result.after, "created")
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_TEST_SENTINEL|raw reload|raw child/)
})

test("Phase 6K stops at merged and never dispatches production or terminal statuses", async () => {
  const statuses = [
    ["merged", true, "complete"],
    ["deploy_in_progress", false, "owner_action_required"],
    ["deploy_failed", false, "owner_action_required"],
    ["deployed", false, "owner_action_required"],
    ["verification_in_progress", false, "owner_action_required"],
    ["verification_failed", false, "owner_action_required"],
    ["rollback_in_progress", false, "owner_action_required"],
    ["rollback_failed", false, "owner_action_required"],
    ["rolled_back", false, "owner_action_required"],
    ["verified", true, "complete"],
    ["cancelled", false, "owner_action_required"],
    ["failed", false, "owner_action_required"]
  ]

  for (const [status, ok, outcome] of statuses) {
    const run = makeRun(status)
    const reader = makeReader(run)
    const children = makeChildHandlers({
      executePhase6GDelivery: "merged",
      executeShaPinnedMerge: "merged",
      executeCodexImplementation: "implementation_ready"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers
    })

    assert.equal(result.ok, ok, status)
    assert.equal(result.outcome, outcome, status)
    assert.equal(result.action, "none", status)
    assert.equal(result.after, status, status)
    assert.equal(children.calls.length, 0, status)
  }
})

test("Phase 6K accepts only runId and refuses caller-selected orchestration values", async () => {
  for (const [key, value] of [
    ["expectedVersion", 7],
    ["projectId", "khlim-assist"],
    ["project", PROJECT],
    ["status", "review_passed"],
    ["action", "merge"],
    ["branch", "main"],
    ["headSha", HEAD_SHA],
    ["repository", "Linardi1328/khlim-assist"],
    ["remote", "origin"],
    ["prNumber", 1],
    ["command", "anything"],
    ["executable", "node"],
    ["workspace", "/tmp/workspace"],
    ["policy", "other"],
    ["deploymentTarget", HEAD_SHA],
    ["service", "ppo-openclaw.service"],
    ["rollbackTarget", BASE_SHA],
    ["confirmation", "rollback-verification-failure"],
    ["environmentOverride", { PATH: "/tmp" }]
  ]) {
    const result = await executeDevelopmentContinue(RUN_ID, {
      [key]: value,
      readRun: async () => {
        throw new Error("read must not happen")
      }
    })

    assert.equal(result.ok, false, key)
    assert.equal(result.outcome, "owner_action_required", key)
    assert.equal(result.reason, "continue_caller_option_refused", key)
  }
})

test("Phase 6K parses only opaque run ids and refuses PPO self-development runs", async () => {
  for (const runId of [
    "",
    BAD_RUN_ID,
    ` ${RUN_ID}`,
    `${RUN_ID} `,
    `${RUN_ID}\nanything`,
    "../personal-project-operator",
    `${RUN_ID} --action merge`
  ]) {
    const result = await executeDevelopmentContinue(runId, {
      readRun: async () => {
        throw new Error("read must not happen")
      }
    })

    assert.equal(result.ok, false, runId)
    assert.equal(result.reason, "continue_invalid_run_id", runId)
  }

  const ppoRun = makeRun("created", {
    project: {
      id: "personal-project-operator",
      displayName: "Personal Project Operator",
      owner: "Linardi1328",
      repo: "personal-project-operator",
      fullName: "Linardi1328/personal-project-operator"
    }
  })
  const reader = makeReader(ppoRun)
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: reader.readRun
  })

  assert.equal(result.ok, false)
  assert.equal(result.project, "personal-project-operator")
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "project_refused")
})

test("Phase 6K output is compact bounded metadata", async () => {
  const run = makeRun("created")
  const reader = makeReader(run)
  const children = makeChildHandlers({
    planExistingDevelopmentRun: "planned"
  })
  const handled = await handlePpoDevelopmentContinueCommand(RUN_ID, {
    readRun: reader.readRun,
    childHandlers: children.handlers
  })

  assert.equal(handled.ok, true)
  assert.equal(handled.output, formatDevelopmentContinueResult(handled.result))
  assert.match(handled.output, /^PPO Development Continue\n/)
  assert.match(handled.output, new RegExp(`Run: ${RUN_ID}`))
  assert.match(handled.output, /Project: khlim-assist/)
  assert.match(handled.output, /Before: created/)
  assert.match(handled.output, /Action: phase-6b-plan/)
  assert.match(handled.output, /Outcome: planned/)
  assert.match(handled.output, /After: planned/)
  assert.doesNotMatch(handled.output, /stdout|stderr|stack|token|secret|SENSITIVE_TEST_SENTINEL/i)
})

test("concurrent Phase 6K continue calls cannot duplicate a run-state reservation", async () => {
  const writeDataDir = await tempWriteDataDir()
  const created = await createDevelopmentRun({
    projectId: PROJECT.id,
    task: "Phase 6K concurrency fixture.",
    baseSha: BASE_SHA,
    branch: "main",
    actor: "phase-6k-test"
  }, {
    writeDataDir
  })
  const staleInitial = {
    ...created,
    evidence: {
      ...evidence(),
      ...created.evidence
    }
  }
  const readCalls = []
  const childCalls = []

  async function readRun(runId) {
    readCalls.push(runId)
    return clone(staleInitial)
  }

  async function planExistingDevelopmentRunHandler(runId, options) {
    childCalls.push(options.expectedVersion)
    const reserved = await transitionDevelopmentRun(runId, {
      expectedVersion: options.expectedVersion,
      status: "planning_in_progress",
      actor: "phase-6k-test"
    }, {
      writeDataDir
    })

    return {
      ok: true,
      outcome: "planning_in_progress",
      run: reserved
    }
  }

  const results = await Promise.all([
    executeDevelopmentContinue(created.runId, {
      writeDataDir,
      readRun,
      childHandlers: {
        planExistingDevelopmentRun: planExistingDevelopmentRunHandler
      }
    }),
    executeDevelopmentContinue(created.runId, {
      writeDataDir,
      readRun,
      childHandlers: {
        planExistingDevelopmentRun: planExistingDevelopmentRunHandler
      }
    })
  ])

  assert.equal(childCalls.length, 2)
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(results.filter((result) => result.outcome === "stale_state").length, 1)

  const stored = JSON.parse(await readFile(join(
    writeDataDir,
    "development-runs",
    "records",
    `${created.runId}.json`
  ), "utf8"))
  assert.equal(stored.status, "planning_in_progress")
  assert.equal(stored.version, 1)
})

test("Phase 6K orchestrator is composition-only and imports no production agents", async () => {
  const source = await readFile(new URL("./development-continue-orchestrator.mjs", import.meta.url), "utf8")
  const commandSource = await readFile(new URL("./ppo-command.mjs", import.meta.url), "utf8")
  const bridgeSource = await readFile(new URL("../openclaw/plugins/ppo-local/bridge.mjs", import.meta.url), "utf8")

  assert.doesNotMatch(source, /\b(?:exec|execFile|spawn|spawnSync)\b/)
  assert.doesNotMatch(source, /systemctl|\bgit\b|\bgh\b|\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\brsync\b/)
  assert.doesNotMatch(source, /deploy-exact-sha|rollback-exact-sha|service-control|vps-health/)
  assert.doesNotMatch(source, /development-deployment-agent|development-production-verification-agent|development-rollback-agent/)
  assert.doesNotMatch(commandSource, /development-deployment-agent|development-production-verification-agent|development-rollback-agent/)
  assert.doesNotMatch(bridgeSource, /development-deployment-agent|development-production-verification-agent|development-rollback-agent/)
})
