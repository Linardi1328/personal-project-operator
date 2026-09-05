import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createDevelopmentRun,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  CODEX_EXECUTION_POLICY_STORE_DIR,
  CODEX_EXECUTION_SANDBOX_ID,
  PHASE_6F_HARDENING_ORCHESTRATOR_ID
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  AUTOMATED_TEST_SANDBOX_ID,
  resolveAutomatedTestPolicyIdentity
} from "./development-test-runner.mjs"
import {
  executeDevelopmentContinue,
  formatDevelopmentContinueResult,
  handlePpoDevelopmentContinueCommand
} from "./development-continue-orchestrator.mjs"
import {
  loadDevelopmentContinueRuntimeProfile
} from "./development-continue-runtime-profile.mjs"
import { listOrdinaryDevelopmentProjects } from "./github-project-registry.mjs"

const RUN_ID = "A".repeat(43)
const BAD_RUN_ID = "short"
const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const NEXT_SHA = "c".repeat(40)
const WRONG_SHA = "d".repeat(40)
const PROMPT_HASH = "e".repeat(64)
const STARTED_AT = "2026-08-23T00:00:00.000Z"
const ENDED_AT = "2026-08-23T00:01:00.000Z"
const PROJECT = {
  ...listOrdinaryDevelopmentProjects()[0],
  fullName: `${listOrdinaryDevelopmentProjects()[0].owner}/${listOrdinaryDevelopmentProjects()[0].repo}`
}
const TEST_POLICY_ID = "phase-6e-local-node-policy"
const MACOS_KHLIM_ASSIST_PYTHON = "/Users/richie/.local/share/personal-project-operator/runtimes/khlim-assist-python3.12/bin/python3"

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
    },
    task: options.task || "Phase 6K stored route fixture."
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

function trustedTestPolicyRegistry(run, overrides = {}) {
  return {
    [run.project.id]: {
      policyId: TEST_POLICY_ID,
      policyVersion: "1",
      trustedExecutablePaths: ["/bin/echo"],
      env: {
        PPO_SAFE_TEST_FLAG: "1"
      },
      sandbox: {
        type: "macos-sandbox-exec",
        platform: "darwin",
        network: "none",
        enforcement: "os-process",
        executablePath: "/usr/bin/sandbox-exec"
      },
      steps: [{
        id: "unit",
        executablePath: "/bin/echo",
        args: ["ok"],
        timeoutMs: 2000,
        maxOutputBytes: 2048,
        required: true,
        shell: false
      }, {
        id: "lint",
        executablePath: "/bin/echo",
        args: ["ok"],
        timeoutMs: 2000,
        maxOutputBytes: 2048,
        required: true,
        shell: false
      }],
      ...overrides
    }
  }
}

function testPolicyIdentity(run, registry = trustedTestPolicyRegistry(run)) {
  return resolveAutomatedTestPolicyIdentity(run, {
    testPolicyRegistry: registry
  })
}

function trustedRuntimeProfile(run, overrides = {}) {
  return {
    workspaceRegistry: {
      [run.project.id]: {
        sourceRepoPath: "/tmp/phase6k-fixed-source",
        workspaceRoot: "/tmp/phase6k-fixed-workspaces"
      }
    },
    codexConfig: {
      executablePath: "/bin/echo",
      gitExecutablePath: "/opt/homebrew/bin/git",
      args: [],
      timeoutMs: 1000,
      env: {},
      remoteGitWritePolicy: {
        mode: "deny",
        enforcement: "adapter-git-wrapper"
      },
      executionSandbox: {
        type: "macos-sandbox-exec",
        platform: "darwin",
        network: "none",
        enforcement: "os-process",
        executablePath: "/usr/bin/sandbox-exec"
      }
    },
    testPolicyRegistry: trustedTestPolicyRegistry(run),
    reviewConfig: {
      executablePath: "/bin/echo",
      args: [],
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      env: {},
      sandbox: {
        type: "macos-sandbox-exec",
        platform: "darwin",
        network: "none",
        enforcement: "os-process",
        readOnlyWorkspace: true,
        readOnlyWorkspaceMode: "trusted-read-only-workspace",
        executablePath: "/usr/bin/sandbox-exec"
      },
      shell: false
    },
    ...overrides
  }
}

function trustedRuntimeProviderFor(run, overrides = {}, calls = []) {
  return async (request) => {
    calls.push(request)
    return trustedRuntimeProfile(run, overrides)
  }
}

function fakeRuntimeStatFor({ missing = new Set(), symlinks = new Set(), modeByPath = {} } = {}) {
  return async (path) => {
    if (missing.has(path)) {
      const error = new Error("missing")
      error.code = "ENOENT"
      throw error
    }

    const executablePaths = new Set([
      "/Users/richie/.local/bin/codex",
      "/opt/homebrew/bin/git",
      "/opt/homebrew/bin/node",
      "/opt/homebrew/bin/python3.12",
      MACOS_KHLIM_ASSIST_PYTHON,
      "/usr/local/bin/ppo-independent-reviewer",
      "/usr/bin/sandbox-exec",
      "/home/ppo/.local/bin/codex",
      "/usr/bin/git",
      "/usr/local/lib/personal-project-operator/phase6k-tools/node-v24/bin/node",
      "/usr/bin/python3.12",
      "/usr/bin/bwrap",
      "/usr/bin/nsenter",
      "/usr/bin/id",
      "/usr/bin/setpriv",
      "/usr/local/bin/ppo-readonly-workspace-wrapper"
    ])
    const regularFilePaths = new Set([
      ...executablePaths,
      "/usr/local/lib/personal-project-operator/phase6k-tools/portfolio/typescript/bin/tsc",
      "/usr/local/lib/personal-project-operator/phase6k-tools/portfolio/eslint/bin/eslint.js",
      "/var/lib/personal-project-operator/phase6-sandbox/no-outbound.netns"
    ])
    const directoryPaths = new Set([
      "/Users/richie/khlim-assist",
      "/Users/richie/ledgerpilot-ai",
      "/Users/richie/spy-market-agent",
      "/Users/richie/richie-linardi-portfolio-website",
      "/Users/richie/rbl-content-engine",
      "/Users/richie/khlim-digital-ecosystem",
      "/Users/richie/.local/share/personal-project-operator/development-workspaces",
      "/var/lib/personal-project-operator/source-repos/khlim-assist",
      "/var/lib/personal-project-operator/source-repos/ledgerpilot-ai",
      "/var/lib/personal-project-operator/source-repos/spy-market-agent",
      "/var/lib/personal-project-operator/source-repos/richie-linardi-portfolio-website",
      "/var/lib/personal-project-operator/source-repos/rbl-content-engine",
      "/var/lib/personal-project-operator/source-repos/khlim-digital-ecosystem",
      "/var/lib/personal-project-operator/development-workspaces",
      "/var/lib/personal-project-operator/phase6-sandbox"
    ])
    const mode = Object.hasOwn(modeByPath, path) ? modeByPath[path] : 0o100755

    return {
      uid: 0,
      gid: 0,
      mode,
      isFile: () => regularFilePaths.has(path),
      isDirectory: () => directoryPaths.has(path),
      isSymbolicLink: () => symlinks.has(path)
    }
  }
}

async function fakeRuntimeExecFile() {
  return {
    stdout: "ok\n",
    stderr: ""
  }
}

function runPpoCommand(args, options = {}) {
  return spawnSync(process.execPath, ["local-operator/ppo-command.mjs", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env || {})
    }
  })
}

function ordinaryProject(projectId) {
  const project = listOrdinaryDevelopmentProjects().find((entry) => entry.id === projectId)

  assert.ok(project, `ordinary project ${projectId} exists`)
  return project
}

function runForProject(projectId, status = "implementation_ready", options = {}) {
  return makeRun(status, {
    ...options,
    project: ordinaryProject(projectId)
  })
}

async function loadFakeRuntimeProfileFor(projectId, options = {}) {
  return await loadDevelopmentContinueRuntimeProfile({ run: runForProject(projectId) }, {
    platform: options.platform || "darwin",
    statImpl: options.statImpl || fakeRuntimeStatFor(),
    lstatImpl: options.lstatImpl || options.statImpl || fakeRuntimeStatFor(),
    accessImpl: options.accessImpl || (async () => {}),
    execFileImpl: options.execFileImpl || fakeRuntimeExecFile,
    codexSandboxCapabilityProbe: options.codexSandboxCapabilityProbe,
    linuxSandboxCapabilityProbe: options.linuxSandboxCapabilityProbe
  })
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
  const identity = overrides.policyIdentity || testPolicyIdentity(run)
  const metadata = {
    project: run.project.id,
    branch: run.branch,
    workspaceId: "phase-6k-workspace",
    workspaceRef: "worktrees/phase-6k-workspace",
    runner: AUTOMATED_TEST_RUNNER_ID,
    attempt: run.attempts.test,
    policyId: identity.policyId,
    policyHash: identity.policyHash,
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
  const identity = overrides.policyIdentity || testPolicyIdentity(run)
  const defaultPassed = Math.max(0, identity.requiredTestCount - 1)
  const metadata = {
    project: run.project.id,
    branch: run.branch,
    runner: AUTOMATED_TEST_RUNNER_ID,
    attempt: run.attempts.test,
    policyId: identity.policyId,
    policyHash: identity.policyHash,
    implSha: run.headSha,
    outcome: "failed",
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    total: identity.requiredTestCount,
    passed: defaultPassed,
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

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function createStoredRun(status, options = {}) {
  const writeDataDir = options.writeDataDir || await tempWriteDataDir()
  const projectId = options.projectId || PROJECT.id
  const created = await createDevelopmentRun({
    projectId,
    task: options.task || "Phase 6K stored route fixture.",
    baseSha: BASE_SHA,
    branch: "main",
    headSha: BASE_SHA,
    actor: "phase-6k-test"
  }, {
    writeDataDir
  })

  if (status === "created") {
    return { writeDataDir, run: created }
  }

  const planning = await transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress",
    actor: "phase-6k-test"
  }, { writeDataDir })
  const planned = await transitionDevelopmentRun(planning.runId, {
    expectedVersion: planning.version,
    status: "planned",
    actor: "phase-6k-test"
  }, { writeDataDir })

  if (status === "planned") {
    return { writeDataDir, run: planned }
  }

  const implementing = await transitionDevelopmentRun(planned.runId, {
    expectedVersion: planned.version,
    status: "implementation_in_progress",
    branch: "phase-6k-fixture",
    headSha: HEAD_SHA,
    actor: "phase-6k-test"
  }, { writeDataDir })

  if (status === "implementation_in_progress") {
    return { writeDataDir, run: implementing }
  }

  const implementationReady = await transitionDevelopmentRun(implementing.runId, {
    expectedVersion: implementing.version,
    status: "implementation_ready",
    branch: "phase-6k-fixture",
    headSha: HEAD_SHA,
    actor: CODEX_EXECUTION_ADAPTER_ID,
    evidence: [{
      kind: "implementation",
      sha: HEAD_SHA,
      source: CODEX_EXECUTION_ADAPTER_ID,
      metadata: {
        project: projectId,
        adapter: CODEX_EXECUTION_ADAPTER_ID,
        attempt: implementing.attempts.implementation,
        promptHash: PROMPT_HASH,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        outcome: "implementation_ready",
        remotePolicy: "deny",
        sandbox: CODEX_EXECUTION_SANDBOX_ID,
        network: "none",
        changedFiles: 1
      }
    }]
  }, { writeDataDir })

  if (status === "implementation_ready") {
    return { writeDataDir, run: implementationReady }
  }

  const testingEvidenceRun = {
    ...implementationReady,
    status: "tests_in_progress",
    attempts: {
      ...implementationReady.attempts,
      test: implementationReady.attempts.test + 1
    }
  }
  const testingPolicyIdentity = options.testPolicyRegistry
    ? testPolicyIdentity(testingEvidenceRun, options.testPolicyRegistry)
    : undefined
  const testing = await transitionDevelopmentRun(implementationReady.runId, {
    expectedVersion: implementationReady.version,
    status: "tests_in_progress",
    branch: "phase-6k-fixture",
    headSha: HEAD_SHA,
    actor: AUTOMATED_TEST_RUNNER_ID,
    evidence: status === "tests_in_progress" ? [testFailureEvidence(testingEvidenceRun, {
      ...(testingPolicyIdentity ? { policyIdentity: testingPolicyIdentity } : {})
    })] : []
  }, { writeDataDir })

  if (status === "tests_in_progress") {
    return { writeDataDir, run: testing }
  }

  const passedPolicyIdentity = options.testPolicyRegistry
    ? testPolicyIdentity(testing, options.testPolicyRegistry)
    : testPolicyIdentity(testing)
  const testsPassed = await transitionDevelopmentRun(testing.runId, {
    expectedVersion: testing.version,
    status: "tests_passed",
    branch: "phase-6k-fixture",
    headSha: HEAD_SHA,
    actor: AUTOMATED_TEST_RUNNER_ID,
    evidence: [{
      kind: "test",
      sha: HEAD_SHA,
      source: AUTOMATED_TEST_RUNNER_ID,
      metadata: {
        project: projectId,
        runner: AUTOMATED_TEST_RUNNER_ID,
        attempt: testing.attempts.test,
        ...passedPolicyIdentity,
        implSha: HEAD_SHA,
        outcome: "passed",
        total: passedPolicyIdentity.requiredTestCount,
        passed: passedPolicyIdentity.requiredTestCount,
        failed: 0,
        ambiguous: 0,
        sandbox: AUTOMATED_TEST_SANDBOX_ID,
        network: "none"
      }
    }]
  }, { writeDataDir })

  if (status === "tests_passed") {
    return { writeDataDir, run: testsPassed }
  }

  const reviewing = await transitionDevelopmentRun(testsPassed.runId, {
    expectedVersion: testsPassed.version,
    status: "review_in_progress",
    branch: "phase-6k-fixture",
    headSha: HEAD_SHA,
    actor: "phase-6f-independent-review-agent"
  }, { writeDataDir })
  const reviewDecision = status === "review_changes_requested" ? "changes_requested" : "approved"
  const reviewRun = await transitionDevelopmentRun(reviewing.runId, {
    expectedVersion: reviewing.version,
    status,
    branch: "phase-6k-fixture",
    headSha: HEAD_SHA,
    actor: "phase-6f-independent-review-agent",
    evidence: [{
      kind: "review",
      sha: HEAD_SHA,
      source: "phase-6f-independent-review-agent",
      metadata: {
        project: projectId,
        reviewer: "phase-6f-independent-review-agent",
        attempt: reviewing.attempts.review,
        reviewedSha: HEAD_SHA,
        promptHash: "c".repeat(64),
        decision: reviewDecision,
        mergeAllowed: reviewDecision === "approved",
        blockers: reviewDecision === "approved" ? 0 : 1,
        securityFindings: 0,
        testsRequired: 0,
        summaryHash: "e".repeat(64),
        outcome: reviewDecision,
        sandbox: "phase-6f-no-outbound-network-review-sandbox",
        network: "none"
      }
    }, ...(reviewDecision === "changes_requested" ? [{
      kind: "review",
      sha: HEAD_SHA,
      source: "phase-6f-independent-review-agent",
      metadata: {
        project: projectId,
        reviewer: "phase-6f-independent-review-agent",
        attempt: reviewing.attempts.review,
        reviewedSha: HEAD_SHA,
        outcome: "review_findings",
        blockers: ["Fix the bounded fixture."],
        securityFindings: [],
        testsRequired: []
      }
    }] : [])]
  }, { writeDataDir })

  return { writeDataDir, run: reviewRun }
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
    const run = makeRun(status, status === "tests_in_progress" ? { attempts: { test: 1 } } : {})

    if (status === "tests_in_progress") {
      run.evidence.test = [testFailureEvidence(run)]
    }

    const reader = makeReader(run)
    const children = makeChildHandlers({ [handlerName]: afterStatus })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run)
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
    childHandlers: children.handlers,
    trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run)
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
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run)
    })

    assert.equal(result.ok, false, run.status)
    assert.equal(result.outcome, "owner_action_required", run.status)
    assert.equal(result.reason, reason, run.status)
    assert.equal(children.calls.length, 0, run.status)
  }
})

test("Phase 6K reconciles dead exact-operation leases for Phase 6D, 6E, and 6F", async () => {
  const now = () => new Date("2026-08-23T00:02:30.000Z")
  const implementationRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  implementationRun.evidence.implementation = [codexAttemptEvidence(implementationRun)]
  const testingRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  testingRun.evidence.test = [testStartedEvidence(testingRun)]
  const reviewRun = makeRun("review_in_progress", {
    stage: "review",
    attempts: { review: 1 }
  })
  reviewRun.evidence.review = [{
    kind: "review",
    sha: reviewRun.headSha,
    source: "phase-6f-independent-review-agent",
    summary: "Review attempt fixture.",
    metadata: {
      project: reviewRun.project.id,
      reviewer: "phase-6f-independent-review-agent",
      attempt: 1,
      reviewedSha: reviewRun.headSha,
      promptHash: PROMPT_HASH,
      startedAt: STARTED_AT,
      outcome: "review_started"
    }
  }]
  const cases = [{
    run: implementationRun,
    phase: "6D",
    handler: "recoverOrphanedCodexExecution",
    after: "implementation_ready"
  }, {
    run: testingRun,
    phase: "6E",
    handler: "recoverOrphanedAutomatedTesting",
    after: "tests_in_progress"
  }, {
    run: reviewRun,
    phase: "6F",
    handler: "recoverReviewOrphan",
    after: "tests_passed"
  }]

  for (const fixture of cases) {
    const calls = []
    const discarded = []
    const targetAttempt = fixture.phase === "6D"
      ? fixture.run.attempts.implementation
      : fixture.phase === "6E"
        ? fixture.run.attempts.test
        : fixture.run.attempts.review
    const operationLeaseManager = {
      async inspect() {
        return {
          exists: true,
          active: false,
          stale: true,
          lease: {
            phase: fixture.phase,
            attempt: targetAttempt,
            headSha: fixture.run.headSha
          }
        }
      },
      async discardStale(runId, target) {
        discarded.push({ runId, target })
      }
    }
    const childHandlers = {
      [fixture.handler]: async (...args) => {
        calls.push(args)
        const request = fixture.phase === "6F" ? args[0] : args[1]
        return {
          ok: true,
          outcome: `${fixture.phase.toLowerCase()}_orphan_recovered`,
          run: makeRun(fixture.after, {
            version: fixture.run.version + 1,
            headSha: fixture.run.headSha
          })
        }
      }
    }
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: makeReader(fixture.run).readRun,
      childHandlers,
      operationLeaseManager,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(fixture.run, { now })
    })

    assert.equal(result.ok, true, fixture.phase)
    assert.equal(result.after, fixture.after, fixture.phase)
    assert.equal(calls.length, 1, fixture.phase)
    assert.equal(discarded.length, 1, fixture.phase)
    assert.equal(discarded[0].target.phase, fixture.phase)
    if (fixture.phase === "6F") {
      assert.equal(calls[0][0].expectedVersion, fixture.run.version)
      assert.equal(calls[0][0].expectedReviewAttempt, targetAttempt)
    } else {
      assert.equal(calls[0][1].expectedVersion, fixture.run.version)
      assert.equal(calls[0][1].expectedAttempt, targetAttempt)
    }
  }
})

test("Phase 6K never reconciles a live, fresh, or mismatched operation lease", async () => {
  const run = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  run.evidence.test = [testStartedEvidence(run)]

  for (const inspected of [{
    active: true,
    lease: { phase: "6E", attempt: 1, headSha: run.headSha }
  }, {
    active: false,
    lease: { phase: "6D", attempt: 1, headSha: run.headSha }
  }]) {
    let recoveryCalls = 0
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: makeReader(run).readRun,
      childHandlers: {
        async recoverOrphanedAutomatedTesting() {
          recoveryCalls += 1
        }
      },
      operationLeaseManager: {
        async inspect() {
          return inspected
        }
      },
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run, {
        now: () => new Date("2026-08-23T00:02:30.000Z")
      })
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "automated_test_reconciliation_required")
    assert.equal(recoveryCalls, 0)
  }
})

test("Phase 6K reconciles a child-phase orphan owned by interrupted bounded hardening", async () => {
  const run = makeRun("tests_in_progress", {
    attempts: { test: 2, review: 1 }
  })
  run.evidence.implementation = [{
    kind: "implementation",
    sha: BASE_SHA,
    source: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
    summary: "Hardening attempt fixture.",
    metadata: {
      project: run.project.id,
      orchestrator: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
      outcome: "hardening_started",
      sourceReviewSha: BASE_SHA,
      reviewAttempt: 1
    }
  }]
  run.evidence.test = [testStartedEvidence(run)]
  let recoveryCalls = 0
  let discardedTarget = null
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: makeReader(run).readRun,
    childHandlers: {
      recoverOrphanedAutomatedTesting: async (_runId, options) => {
        recoveryCalls += 1
        return {
          ok: true,
          outcome: "test_orphan_recovered_for_retry",
          run: makeRun("tests_in_progress", {
            version: options.expectedVersion + 1,
            headSha: run.headSha
          })
        }
      }
    },
    operationLeaseManager: {
      async inspect() {
        return {
          active: false,
          stale: true,
          lease: {
            phase: "6F",
            action: "phase-6f-bounded-hardening",
            attempt: 1,
            headSha: BASE_SHA
          }
        }
      },
      async discardStale(_runId, target) {
        discardedTarget = target
      }
    },
    trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run, {
      now: () => new Date("2026-08-23T00:02:30.000Z")
    })
  })

  assert.equal(result.ok, true)
  assert.equal(recoveryCalls, 1)
  assert.deepEqual(discardedTarget, {
    phase: "6F",
    attempt: 1,
    headSha: BASE_SHA
  })
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
  assert.equal(result.reason, "codex_evidence_invalid")
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

  for (const run of [wrongSourceRun, wrongShaRun, malformedRun]) {
    const reader = makeReader(run)
    const children = makeChildHandlers({
      executeCodexImplementation: "implementation_ready"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run)
    })

    assert.equal(result.ok, false)
    assert.equal(result.outcome, "owner_action_required")
    assert.equal(result.reason, "codex_evidence_invalid")
    assert.equal(children.calls.length, 0)
  }

  {
    const reader = makeReader(staleAttemptRun)
    const children = makeChildHandlers({
      executeCodexImplementation: "implementation_ready"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(staleAttemptRun)
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, "phase-6d-codex-implementation")
    assert.equal(children.calls.length, 1)
    assert.equal(children.calls[0].expectedVersion, staleAttemptRun.version)
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
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(openRun)
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
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(definitiveFailureRun)
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
  const wrongPolicyIdRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  wrongPolicyIdRun.evidence.test = [testFailureEvidence(wrongPolicyIdRun, {
    metadata: { policyId: "phase-6e-other-policy" }
  })]
  const wrongPolicyHashRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  wrongPolicyHashRun.evidence.test = [testFailureEvidence(wrongPolicyHashRun, {
    metadata: { policyHash: "f".repeat(64) }
  })]
  const oldPolicyRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  oldPolicyRun.evidence.test = [testFailureEvidence(oldPolicyRun, {
    policyIdentity: testPolicyIdentity(oldPolicyRun, trustedTestPolicyRegistry(oldPolicyRun, {
      policyVersion: "old"
    }))
  })]
  const wrongRequiredCountRun = makeRun("tests_in_progress", {
    attempts: { test: 1 }
  })
  wrongRequiredCountRun.evidence.test = [testFailureEvidence(wrongRequiredCountRun, {
    metadata: { total: 1, passed: 0, failed: 1, ambiguous: 0 }
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
    wrongPolicyIdRun,
    wrongPolicyHashRun,
    oldPolicyRun,
    wrongRequiredCountRun,
    stepFailureRun
  ]) {
    const reader = makeReader(run)
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: reader.readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run)
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
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(openRun)
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
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(trustedFailureRun)
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, "phase-6e-automated-test-retry")
    assert.equal(children.calls.length, 1)
    assert.equal(children.calls[0].expectedVersion, trustedFailureRun.version)
  }
})

test("Phase 6K Phase 6E retry evidence is bound to the exact selected reviewed project policy", async () => {
  const khlimRun = runForProject("khlim-assist", "tests_in_progress", {
    attempts: { test: 1 }
  })
  const khlimProfile = await loadFakeRuntimeProfileFor("khlim-assist")
  const khlimIdentity = resolveAutomatedTestPolicyIdentity(khlimRun, khlimProfile)
  khlimRun.evidence.test = [testFailureEvidence(khlimRun, {
    policyIdentity: khlimIdentity
  })]
  {
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: makeReader(khlimRun).readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: async () => khlimProfile
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, "phase-6e-automated-test-retry")
    assert.equal(children.calls.length, 1)
  }

  for (const [label, metadata] of [
    ["wrong policy id", { policyId: "phase-6e-other-reviewed-policy" }],
    ["wrong policy hash", { policyHash: "f".repeat(64) }],
    ["valid-looking arbitrary hash", { policyHash: "1".repeat(64) }],
    ["wrong required test count", { total: khlimIdentity.requiredTestCount + 1, passed: 0, failed: 1, ambiguous: 0 }],
    ["step-level failure", { testId: "pytest" }]
  ]) {
    const run = runForProject("khlim-assist", "tests_in_progress", {
      attempts: { test: 1 }
    })
    run.evidence.test = [testFailureEvidence(run, {
      policyIdentity: khlimIdentity,
      metadata
    })]
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: makeReader(run).readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: async () => khlimProfile
    })

    assert.equal(result.ok, false, label)
    assert.equal(result.reason, "automated_test_evidence_invalid", label)
    assert.equal(children.calls.length, 0, label)
  }

  const ledgerRun = runForProject("ledgerpilot-ai", "tests_in_progress", {
    attempts: { test: 1 }
  })
  const ledgerProfile = await loadFakeRuntimeProfileFor("ledgerpilot-ai")
  const ledgerIdentity = resolveAutomatedTestPolicyIdentity(ledgerRun, ledgerProfile)
  assert.notEqual(ledgerIdentity.policyHash, khlimIdentity.policyHash)

  const staleKhlmRun = runForProject("khlim-assist", "tests_in_progress", {
    attempts: { test: 1 }
  })
  staleKhlmRun.evidence.test = [testFailureEvidence(staleKhlmRun, {
    policyIdentity: ledgerIdentity
  })]
  {
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: makeReader(staleKhlmRun).readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: async () => khlimProfile
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "automated_test_evidence_invalid")
    assert.equal(children.calls.length, 0)
  }

  ledgerRun.evidence.test = [testFailureEvidence(ledgerRun, {
    policyIdentity: ledgerIdentity
  })]
  {
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: makeReader(ledgerRun).readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: async () => ledgerProfile
    })

    assert.equal(result.ok, true)
    assert.equal(children.calls.length, 1)
  }
})

test("Phase 6K default route passes trusted runtime profile into real child APIs", async () => {
  const cases = [
    ["implementation_in_progress", "phase-6d-codex-implementation"],
    ["implementation_ready", "phase-6e-automated-tests"],
    ["tests_in_progress", "phase-6e-automated-test-retry"],
    ["tests_passed", "phase-6f-independent-review"],
    ["review_changes_requested", "phase-6f-bounded-hardening"],
    ["review_passed", "phase-6g-delivery"]
  ]

  for (const [status, action] of cases) {
    const fixture = await createStoredRun(status)
    const calls = []
    const result = await executeDevelopmentContinue(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir,
      trustedRuntimeProfileProvider: trustedRuntimeProviderFor(fixture.run, {}, calls)
    })

    assert.equal(calls.length, 1, status)
    assert.equal(calls[0].action, action, status)
    assert.equal(result.ok, false, status)
    assert.equal(result.action, action, status)
    assert.notEqual(result.reason, "continue_runtime_not_ready", status)
    assert.doesNotMatch(String(result.reason), /config|required|policy/i, status)
  }
})

test("Phase 6K default route loads the reviewed runtime profile before real child dispatch", async () => {
  const reviewedProfile = await loadFakeRuntimeProfileFor(PROJECT.id)
  const cases = [
    ["implementation_in_progress", "phase-6d-codex-implementation"],
    ["implementation_ready", "phase-6e-automated-tests"],
    ["tests_in_progress", "phase-6e-automated-test-retry"],
    ["tests_passed", "phase-6f-independent-review"],
    ["review_changes_requested", "phase-6f-bounded-hardening"],
    ["review_passed", "phase-6g-delivery"]
  ]

  for (const [status, action] of cases) {
    const fixture = await createStoredRun(status, {
      testPolicyRegistry: reviewedProfile.testPolicyRegistry
    })
    const profileRequests = []
    const result = await executeDevelopmentContinue(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir,
      trustedRuntimeProfileProvider: async (request) => {
        profileRequests.push(request)
        return await loadDevelopmentContinueRuntimeProfile(request, {
          platform: "darwin",
          statImpl: fakeRuntimeStatFor(),
          accessImpl: async () => {},
          execFileImpl: fakeRuntimeExecFile
        })
      }
    })

    assert.equal(profileRequests.length, 1, status)
    assert.equal(profileRequests[0].action, action, status)
    assert.equal(result.action, action, status)
    assert.notEqual(result.reason, "continue_runtime_not_ready", status)
    const { runId, ...boundedResult } = result
    assert.equal(runId, fixture.run.runId, status)
    assert.doesNotMatch(JSON.stringify(boundedResult), /SENSITIVE_TEST_SENTINEL|raw|secret|token/i, status)
  }
})

test("Phase 6K fixed runtime profile supplies reviewed local capabilities only", async () => {
  const run = makeRun("implementation_ready")
  const profile = await loadDevelopmentContinueRuntimeProfile({ run }, {
    platform: "darwin",
    statImpl: fakeRuntimeStatFor(),
    accessImpl: async () => {},
    execFileImpl: fakeRuntimeExecFile
  })

  assert.deepEqual(Object.keys(profile.workspaceRegistry), [PROJECT.id])
  assert.equal(profile.workspaceRegistry[PROJECT.id].sourceRepoPath, "/Users/richie/khlim-assist")
  assert.equal(profile.workspaceRegistry[PROJECT.id].workspaceRoot, "/Users/richie/.local/share/personal-project-operator/development-workspaces")
  assert.equal(profile.codexConfig.executablePath, "/Users/richie/.local/bin/codex")
  assert.equal(profile.codexConfig.gitExecutablePath, "/opt/homebrew/bin/git")
  assert.equal(profile.codexConfig.executionSandbox.type, "codex-native-darwin")
  assert.equal(profile.codexConfig.executionSandbox.executablePath, "/Users/richie/.local/bin/codex")
  assert.equal(profile.codexConfig.executionSandbox.permissionProfile, ":workspace")
  assert.deepEqual(profile.codexConfig.args, [
    "exec",
    "--ephemeral",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "-c",
    "approval_policy=\"never\"",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--model",
    "gpt-5.6-sol",
    "-"
  ])
  assert.equal(profile.codexConfig.env.HOME, "/Users/richie")
  assert.equal(profile.codexConfig.env.CODEX_HOME, "/Users/richie/.codex")
  assert.equal(profile.codexConfig.remoteGitWritePolicy.mode, "deny")
  assert.equal(profile.codexConfig.executionSandbox.network, "none")
  assert.equal(profile.testPolicyRegistry[PROJECT.id].steps.length, 3)
  assert.equal(profile.testPolicyRegistry[PROJECT.id].policyId, "phase-6e-khlim-assist-fixed-python-quality-policy")
  assert.deepEqual(profile.testPolicyRegistry[PROJECT.id].trustedExecutablePaths, [MACOS_KHLIM_ASSIST_PYTHON])
  assert.deepEqual(
    profile.testPolicyRegistry[PROJECT.id].steps.map((step) => step.executablePath),
    Array(3).fill(MACOS_KHLIM_ASSIST_PYTHON)
  )
  assert.deepEqual(profile.testPolicyRegistry[PROJECT.id].steps.map((step) => step.args), [
    ["-m", "ruff", "check", "--no-cache", "."],
    ["-m", "mypy", "--no-incremental", "backend/app"],
    ["-m", "pytest", "-p", "no:cacheprovider", "backend/tests"]
  ])
  assert.doesNotMatch(JSON.stringify(profile.testPolicyRegistry[PROJECT.id]), /node --test|package\.json|npm|npx|Makefile/)
  assert.equal(profile.reviewConfig.executablePath, "/usr/local/bin/ppo-independent-reviewer")
  assert.equal(profile.reviewConfig.timeoutMs, 10 * 60 * 1000)
  assert.equal(profile.reviewConfig.env.PATH, "/opt/homebrew/bin:/usr/bin:/bin")
  assert.equal(profile.reviewConfig.shell, false)
  assert.equal(profile.reviewConfig.sandbox.readOnlyWorkspace, true)
  assert.equal(profile.reviewConfig.sandbox.network, "none")
  assert.equal(Object.hasOwn(profile, "deploymentTarget"), false)
  assert.equal(Object.hasOwn(profile, "service"), false)

  await assert.rejects(
    () => loadDevelopmentContinueRuntimeProfile({ run }, {
      platform: "darwin",
      statImpl: fakeRuntimeStatFor({ missing: new Set(["/usr/local/bin/ppo-independent-reviewer"]) }),
      accessImpl: async () => {},
      execFileImpl: fakeRuntimeExecFile
    }),
    (error) => error.code === "CONTINUE_RUNTIME_NOT_READY"
  )

  await assert.rejects(
    () => loadDevelopmentContinueRuntimeProfile({ run: makeRun("implementation_ready", {
      project: {
        id: "personal-project-operator",
        owner: "Linardi1328",
        repo: "personal-project-operator",
        fullName: "Linardi1328/personal-project-operator"
      }
    }) }, {
      platform: "darwin",
      statImpl: fakeRuntimeStatFor(),
      accessImpl: async () => {},
      execFileImpl: fakeRuntimeExecFile
    }),
    (error) => error.code === "CONTINUE_RUNTIME_NOT_READY"
  )
})

test("Phase 6F readiness uses a live model request and classifies revoked authentication before dispatch", async () => {
  const run = makeRun("tests_passed")
  const calls = []
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: makeReader(run).readRun,
    childHandlers: {
      executeIndependentReview: async () => {
        calls.push("review")
      }
    },
    trustedRuntimeProfileProvider: (request) => loadDevelopmentContinueRuntimeProfile(request, {
      platform: "darwin",
      statImpl: fakeRuntimeStatFor(),
      accessImpl: async () => {},
      execFileImpl: async (_path, args) => {
        calls.push(args)
        if (args[0] === "exec" && args.includes("--ephemeral")) {
          const error = new Error("HTTP 401 token refresh failed SENSITIVE_TEST_SENTINEL")
          error.stderr = "authentication required SENSITIVE_TEST_SENTINEL"
          throw error
        }
        return { stdout: "ok\n", stderr: "" }
      }
    })
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, "codex_authentication_failed")
  assert.equal(calls.includes("review"), false)
  assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === "exec"), true)
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_TEST_SENTINEL|token refresh/iu)
})

test("orphan reconciliation runtime loading does not depend on live Codex authentication", async () => {
  const run = makeRun("review_in_progress")
  let codexProbeCalls = 0
  const profile = await loadDevelopmentContinueRuntimeProfile({
    run,
    action: "phase-6f-review-orphan-recovery"
  }, {
    platform: "darwin",
    statImpl: fakeRuntimeStatFor(),
    accessImpl: async () => {},
    execFileImpl: async (path) => {
      if (path.endsWith("/codex")) {
        codexProbeCalls += 1
        throw new Error("revoked authentication must not block reconciliation")
      }

      return { stdout: "ok\n", stderr: "" }
    }
  })

  assert.deepEqual(Object.keys(profile.workspaceRegistry), [run.project.id])
  assert.equal(codexProbeCalls, 0)
})

test("Phase 6K runtime profile defines one reviewed fixed test policy for each ordinary project", async () => {
  const expectedPolicies = new Map([
    ["khlim-assist", {
      policyId: "phase-6e-khlim-assist-fixed-python-quality-policy",
      executablePath: MACOS_KHLIM_ASSIST_PYTHON,
      args: [
        ["-m", "ruff", "check", "--no-cache", "."],
        ["-m", "mypy", "--no-incremental", "backend/app"],
        ["-m", "pytest", "-p", "no:cacheprovider", "backend/tests"]
      ],
      stepCount: 3
    }],
    ["ledgerpilot-ai", {
      policyId: "phase-6e-ledgerpilot-ai-fixed-python-pytest-policy",
      executablePath: "/opt/homebrew/bin/python3.12",
      args: ["-m", "pytest", "tests"],
      stepCount: 1
    }],
    ["spy-market-agent", {
      policyId: "phase-6e-spy-market-agent-fixed-python-pytest-policy",
      executablePath: "/opt/homebrew/bin/python3.12",
      args: ["-m", "pytest", "tests"],
      stepCount: 1
    }],
    ["portfolio", {
      policyId: "phase-6e-portfolio-fixed-next-quality-policy",
      executablePath: "/opt/homebrew/bin/node",
      args: [
        ["/usr/local/lib/personal-project-operator/phase6k-tools/portfolio/typescript/bin/tsc", "--noEmit"],
        ["/usr/local/lib/personal-project-operator/phase6k-tools/portfolio/eslint/bin/eslint.js", "."]
      ],
      stepCount: 2
    }],
    ["rbl-content-engine", {
      policyId: "phase-6e-rbl-content-engine-fixed-python-unittest-policy",
      executablePath: "/opt/homebrew/bin/python3.12",
      args: [
        ["-m", "compileall", "-q", "src", "tests"],
        ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"]
      ],
      stepCount: 2
    }],
    ["khlim-digital-ecosystem", {
      policyId: "phase-6e-khlim-digital-ecosystem-fixed-node-foundation-policy",
      executablePath: "/opt/homebrew/bin/node",
      args: ["--test", "tests/foundation.test.mjs"],
      stepCount: 1
    }]
  ])
  const projectIds = listOrdinaryDevelopmentProjects().map((project) => project.id)

  assert.deepEqual(projectIds.toSorted(), Array.from(expectedPolicies.keys()).toSorted())

  const seenPolicyIds = new Set()
  const policyHashes = new Map()

  for (const projectId of projectIds) {
    const profile = await loadFakeRuntimeProfileFor(projectId)
    const policy = profile.testPolicyRegistry[projectId]
    const expected = expectedPolicies.get(projectId)
    const identity = resolveAutomatedTestPolicyIdentity(runForProject(projectId), profile)

    assert.deepEqual(Object.keys(profile.testPolicyRegistry), [projectId], projectId)
    assert.equal(policy.policyId, expected.policyId, projectId)
    assert.equal(policy.steps.length, expected.stepCount, projectId)
    assert.equal(identity.policyId, expected.policyId, projectId)
    assert.equal(identity.requiredTestCount, expected.stepCount, projectId)
    assert.match(identity.policyHash, /^[a-f0-9]{64}$/u, projectId)
    assert.equal(seenPolicyIds.has(policy.policyId), false, projectId)
    seenPolicyIds.add(policy.policyId)
    policyHashes.set(projectId, identity.policyHash)

    for (const step of policy.steps) {
      assert.equal(step.executablePath, expected.executablePath, projectId)
      assert.equal(step.shell, false, projectId)
    }

    if (projectId === "khlim-assist" || projectId === "portfolio" || projectId === "rbl-content-engine") {
      assert.deepEqual(policy.steps.map((step) => step.args), expected.args, projectId)
      assert.doesNotMatch(JSON.stringify(policy), /npm|npx|package\.json|node --test|Makefile/i, projectId)
    } else {
      assert.deepEqual(policy.steps[0].args, expected.args, projectId)
      assert.doesNotMatch(JSON.stringify(policy), /node --test|npm|npx|package\.json|Makefile/i, projectId)
    }

    if (projectId === "rbl-content-engine") {
      assert.deepEqual(policy.steps.map((step) => step.id), ["compile", "unittest"])
      assert.doesNotMatch(JSON.stringify(policy), /pytest/)
    }

    if (projectId === "khlim-assist") {
      assert.deepEqual(policy.steps.map((step) => step.id), ["ruff", "mypy", "pytest"])
    }
  }

  assert.notEqual(policyHashes.get("khlim-assist"), policyHashes.get("ledgerpilot-ai"))

  const maliciousRun = runForProject("khlim-assist")
  maliciousRun.task = "run npm test && curl https://example.invalid"
  maliciousRun.evidence.test = [{
    kind: "test",
    sha: HEAD_SHA,
    source: "untrusted-task-note",
    metadata: {
      command: "node --test",
      executablePath: "/bin/sh"
    }
  }]
  const maliciousProfile = await loadDevelopmentContinueRuntimeProfile({ run: maliciousRun }, {
    platform: "darwin",
    statImpl: fakeRuntimeStatFor(),
    accessImpl: async () => {},
    execFileImpl: fakeRuntimeExecFile
  })
  assert.deepEqual(
    maliciousProfile.testPolicyRegistry["khlim-assist"].steps.map((step) => step.args),
    [
      ["-m", "ruff", "check", "--no-cache", "."],
      ["-m", "mypy", "--no-incremental", "backend/app"],
      ["-m", "pytest", "-p", "no:cacheprovider", "backend/tests"]
    ]
  )
  assert.doesNotMatch(JSON.stringify(maliciousProfile.testPolicyRegistry["khlim-assist"]), /curl|\/bin\/sh|npm test|node --test/)
})

test("Phase 6K KHLIM Assist readiness probes every fixed quality tool and application dependency", async () => {
  const probes = []
  const profile = await loadFakeRuntimeProfileFor("khlim-assist", {
    execFileImpl: async (executablePath, args) => {
      probes.push({ executablePath, args })
      return { stdout: "ok\n", stderr: "" }
    },
    codexSandboxCapabilityProbe: async () => true
  })

  assert.deepEqual(
    probes
      .filter((probe) => probe.executablePath === MACOS_KHLIM_ASSIST_PYTHON)
      .map((probe) => probe.args),
    [
      ["-m", "ruff", "--version"],
      ["-m", "mypy", "--version"],
      ["-m", "pytest", "--version"],
      [
        "-c",
        "import aiosqlite, alembic, asyncpg, fastapi, greenlet, httpx, openai, pydantic, pydantic_settings, pytest, pytest_asyncio, sqlalchemy, uvicorn; raise SystemExit(0 if pytest.__version__.split('.', 1)[0] == '8' else 1)"
      ]
    ]
  )
  assert.equal(profile.testPolicyRegistry["khlim-assist"].steps.length, 3)
})

test("Phase 6K RBL reviewed policy uses fixed Python compileall and unittest without pytest", async () => {
  const probes = []
  const profile = await loadFakeRuntimeProfileFor("rbl-content-engine", {
    execFileImpl: async (executablePath, args) => {
      probes.push({ executablePath, args })
      return { stdout: "ok\n", stderr: "" }
    }
  })
  const policy = profile.testPolicyRegistry["rbl-content-engine"]
  const identity = resolveAutomatedTestPolicyIdentity(runForProject("rbl-content-engine"), profile)

  assert.equal(policy.policyId, "phase-6e-rbl-content-engine-fixed-python-unittest-policy")
  assert.equal(identity.policyId, "phase-6e-rbl-content-engine-fixed-python-unittest-policy")
  assert.match(identity.policyHash, /^[a-f0-9]{64}$/u)
  assert.equal(identity.requiredTestCount, 2)
  assert.equal(policy.steps.length, 2)
  assert.deepEqual(policy.steps.map((step) => step.required), [true, true])
  assert.deepEqual(policy.trustedExecutablePaths, ["/opt/homebrew/bin/python3.12"])
  assert.equal(policy.steps[0].id, "compile")
  assert.equal(policy.steps[0].executablePath, "/opt/homebrew/bin/python3.12")
  assert.deepEqual(policy.steps[0].args, ["-m", "compileall", "-q", "src", "tests"])
  assert.equal(policy.steps[0].shell, false)
  assert.equal(policy.steps[1].id, "unittest")
  assert.equal(policy.steps[1].executablePath, "/opt/homebrew/bin/python3.12")
  assert.deepEqual(policy.steps[1].args, ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"])
  assert.equal(policy.steps[1].shell, false)
  assert.deepEqual(probes.filter((probe) => probe.executablePath === "/opt/homebrew/bin/python3.12"), [{
    executablePath: "/opt/homebrew/bin/python3.12",
    args: ["-c", "import compileall, unittest"]
  }])
  assert.doesNotMatch(JSON.stringify(policy), /pytest|Makefile|package\.json|npm|npx|node --test/)
})

test("Phase 6K RBL retry evidence must match the new compile/unittest policy", async () => {
  const currentProfile = await loadFakeRuntimeProfileFor("rbl-content-engine")
  const rblRun = runForProject("rbl-content-engine", "tests_in_progress", {
    attempts: { test: 1 }
  })
  const currentIdentity = resolveAutomatedTestPolicyIdentity(rblRun, currentProfile)
  const oldRblPytestRegistry = {
    "rbl-content-engine": {
      policyId: "phase-6e-rbl-content-engine-fixed-python-pytest-policy",
      policyVersion: "1",
      trustedExecutablePaths: ["/opt/homebrew/bin/python3.12"],
      env: {
        PPO_PHASE6K_TEST_POLICY: "fixed",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1"
      },
      sandbox: currentProfile.testPolicyRegistry["rbl-content-engine"].sandbox,
      steps: [{
        id: "pytest",
        executablePath: "/opt/homebrew/bin/python3.12",
        args: ["-m", "pytest", "tests"],
        timeoutMs: 120000,
        maxOutputBytes: currentProfile.testPolicyRegistry["rbl-content-engine"].steps[0].maxOutputBytes,
        required: true,
        shell: false
      }]
    }
  }
  const oldIdentity = resolveAutomatedTestPolicyIdentity(rblRun, {
    testPolicyRegistry: oldRblPytestRegistry
  })
  assert.equal(oldIdentity.policyId, "phase-6e-rbl-content-engine-fixed-python-pytest-policy")
  assert.notEqual(oldIdentity.policyHash, currentIdentity.policyHash)

  {
    const run = runForProject("rbl-content-engine", "tests_in_progress", {
      attempts: { test: 1 }
    })
    run.evidence.test = [testFailureEvidence(run, {
      policyIdentity: oldIdentity
    })]
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: makeReader(run).readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: async () => currentProfile
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "automated_test_evidence_invalid")
    assert.equal(children.calls.length, 0)
  }

  {
    const run = runForProject("rbl-content-engine", "tests_in_progress", {
      attempts: { test: 1 }
    })
    run.evidence.test = [testFailureEvidence(run, {
      policyIdentity: currentIdentity
    })]
    const children = makeChildHandlers({
      executeAutomatedTests: "tests_passed"
    })
    const result = await executeDevelopmentContinue(RUN_ID, {
      readRun: makeReader(run).readRun,
      childHandlers: children.handlers,
      trustedRuntimeProfileProvider: async () => currentProfile
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, "phase-6e-automated-test-retry")
    assert.equal(children.calls.length, 1)
  }
})

test("Phase 6K Linux runtime profile uses Codex native command sandboxing", async () => {
  const probes = []
  const profile = await loadFakeRuntimeProfileFor("khlim-assist", {
    platform: "linux",
    linuxSandboxCapabilityProbe: async (probe) => {
      probes.push(probe)
      return true
    }
  })

  assert.equal(probes.length, 1)
  assert.equal(probes[0].executablePath, "/home/ppo/.local/bin/codex")
  assert.deepEqual(probes[0].args, [
    "sandbox",
    "--permission-profile",
    ":read-only",
    "--cd",
    "/var/lib/personal-project-operator/development-workspaces",
    "--",
    "/usr/local/lib/personal-project-operator/phase6k-tools/node-v24/bin/node",
    "--eval",
    "process.exit(0)"
  ])
  assert.equal(profile.codexConfig.executionSandbox.type, "codex-native-linux")
  assert.equal(profile.codexConfig.executionSandbox.executablePath, "/home/ppo/.local/bin/codex")
  assert.equal(profile.codexConfig.executionSandbox.permissionProfile, ":workspace")
  assert.deepEqual(profile.codexConfig.args, [
    "exec",
    "--ephemeral",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "-c",
    "approval_policy=\"never\"",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--model",
    "gpt-5.6-sol",
    "-"
  ])
  assert.deepEqual(
    profile.testPolicyRegistry["khlim-assist"].steps.map((step) => step.executablePath),
    Array(3).fill("/usr/bin/python3.12")
  )
  assert.deepEqual(profile.testPolicyRegistry["khlim-assist"].steps.map((step) => step.args), [
    ["-m", "ruff", "check", "--no-cache", "."],
    ["-m", "mypy", "--no-incremental", "backend/app"],
    ["-m", "pytest", "-p", "no:cacheprovider", "backend/tests"]
  ])
  assert.equal(profile.reviewConfig.executablePath, "/usr/local/bin/ppo-independent-reviewer")
  assert.equal(
    profile.reviewConfig.env.PATH,
    "/home/ppo/.local/openclaw/tools/node/bin:/usr/bin:/bin"
  )
  assert.equal(profile.reviewConfig.sandbox.permissionProfile, ":read-only")
  assert.doesNotMatch(JSON.stringify(profile), /nsenter|setpriv|no-outbound\.netns/u)
})

test("Phase 6K macOS runtime profile keeps the Codex controller online and sandboxes generated commands", async () => {
  const probes = []
  const profile = await loadFakeRuntimeProfileFor("khlim-digital-ecosystem", {
    platform: "darwin",
    codexSandboxCapabilityProbe: async (probe) => {
      probes.push(probe)
      return true
    }
  })

  assert.equal(probes.length, 1)
  assert.equal(probes[0].executablePath, "/Users/richie/.local/bin/codex")
  assert.deepEqual(probes[0].args, [
    "sandbox",
    "--permission-profile",
    ":read-only",
    "--cd",
    "/Users/richie/.local/share/personal-project-operator/development-workspaces",
    "--",
    "/opt/homebrew/bin/node",
    "--eval",
    "process.exit(0)"
  ])
  assert.equal(profile.codexConfig.executionSandbox.type, "codex-native-darwin")
  assert.equal(profile.codexConfig.executionSandbox.platform, "darwin")
  assert.equal(profile.codexConfig.executionSandbox.enforcement, "codex-command-sandbox")
  assert.equal(profile.codexConfig.executionSandbox.permissionProfile, ":workspace")
  assert.notDeepEqual(profile.codexConfig.args, [])
  assert.equal(profile.codexConfig.args[0], "exec")
  assert.equal(profile.codexConfig.args.at(-1), "-")
  assert.equal(profile.reviewConfig.timeoutMs, 10 * 60 * 1000)
  assert.equal(profile.reviewConfig.sandbox.type, "codex-native-darwin")
  assert.equal(profile.reviewConfig.sandbox.executablePath, "/Users/richie/.local/bin/codex")
  assert.equal(profile.reviewConfig.sandbox.permissionProfile, ":read-only")
})

test("Phase 6K KHLIM Linux profile binds the fixed source and foundation test", async () => {
  const profile = await loadFakeRuntimeProfileFor("khlim-digital-ecosystem", {
    platform: "linux",
    linuxSandboxCapabilityProbe: async () => true
  })
  const policy = profile.testPolicyRegistry["khlim-digital-ecosystem"]

  assert.equal(
    profile.workspaceRegistry["khlim-digital-ecosystem"].sourceRepoPath,
    "/var/lib/personal-project-operator/source-repos/khlim-digital-ecosystem"
  )
  assert.equal(policy.policyId, "phase-6e-khlim-digital-ecosystem-fixed-node-foundation-policy")
  assert.deepEqual(policy.trustedExecutablePaths, [
    "/usr/local/lib/personal-project-operator/phase6k-tools/node-v24/bin/node"
  ])
  assert.equal(policy.steps.length, 1)
  assert.equal(
    policy.steps[0].executablePath,
    "/usr/local/lib/personal-project-operator/phase6k-tools/node-v24/bin/node"
  )
  assert.deepEqual(policy.steps[0].args, ["--test", "tests/foundation.test.mjs"])
  assert.equal(policy.steps[0].shell, false)
})

test("Phase 6K Linux runtime profile fails closed for missing or unusable Codex sandbox boundaries", async () => {
  const bubblewrapPath = "/usr/bin/bwrap"
  const reviewerPath = "/usr/local/bin/ppo-independent-reviewer"
  const trustedNodePath = "/usr/local/lib/personal-project-operator/phase6k-tools/node-v24/bin/node"

  await assert.rejects(
    () => loadFakeRuntimeProfileFor("khlim-assist", {
      platform: "linux",
      statImpl: fakeRuntimeStatFor({ missing: new Set([bubblewrapPath]) }),
      linuxSandboxCapabilityProbe: async () => true
    }),
    (error) => error.code === "CONTINUE_RUNTIME_NOT_READY"
  )

  const productionProbeProfile = await loadFakeRuntimeProfileFor("khlim-assist", {
    platform: "linux",
    statImpl: fakeRuntimeStatFor()
  })
  assert.equal(productionProbeProfile.codexConfig.executionSandbox.type, "codex-native-linux")

  await assert.rejects(
    () => loadFakeRuntimeProfileFor("khlim-assist", {
      platform: "linux",
      statImpl: fakeRuntimeStatFor({ missing: new Set([reviewerPath]) }),
      linuxSandboxCapabilityProbe: async () => true
    }),
    (error) => error.code === "CONTINUE_RUNTIME_NOT_READY"
  )

  await assert.rejects(
    () => loadFakeRuntimeProfileFor("khlim-digital-ecosystem", {
      platform: "linux",
      statImpl: fakeRuntimeStatFor({ modeByPath: { [trustedNodePath]: 0o100775 } }),
      linuxSandboxCapabilityProbe: async () => true
    }),
    (error) => error.code === "CONTINUE_RUNTIME_NOT_READY"
  )

  await assert.rejects(
    () => loadFakeRuntimeProfileFor("khlim-assist", {
      platform: "linux",
      statImpl: fakeRuntimeStatFor({ modeByPath: { [reviewerPath]: 0o100775 } }),
      linuxSandboxCapabilityProbe: async () => true
    }),
    (error) => error.code === "CONTINUE_RUNTIME_NOT_READY"
  )

  await assert.rejects(
    () => loadFakeRuntimeProfileFor("khlim-assist", {
      platform: "linux",
      linuxSandboxCapabilityProbe: async () => false
    }),
    (error) => error.code === "CONTINUE_RUNTIME_NOT_READY"
  )
})

test("Phase 6K refuses missing Linux runtime readiness before child or policy-store mutation", async () => {
  const bubblewrapPath = "/usr/bin/bwrap"
  const fixture = await createStoredRun("implementation_in_progress")
  const before = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  let childCalls = 0
  const result = await executeDevelopmentContinue(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    childHandlers: {
      executeCodexImplementation: async () => {
        childCalls += 1
        return { ok: true, outcome: "implementation_ready", run: fixture.run }
      }
    },
    trustedRuntimeProfileProvider: (request) => loadDevelopmentContinueRuntimeProfile(request, {
      platform: "linux",
      statImpl: fakeRuntimeStatFor({ missing: new Set([bubblewrapPath]) }),
      accessImpl: async () => {},
      execFileImpl: fakeRuntimeExecFile,
      linuxSandboxCapabilityProbe: async () => true
    })
  })
  const after = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, "continue_runtime_not_ready")
  assert.equal(childCalls, 0)
  assert.equal(after.version, before.version)
  assert.equal(after.status, before.status)
  assert.equal(await pathExists(join(fixture.writeDataDir, CODEX_EXECUTION_POLICY_STORE_DIR)), false)
})

test("Phase 6K refuses missing project test runtime before Phase 6E mutation", async () => {
  const fixture = await createStoredRun("implementation_ready")
  const before = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  let childCalls = 0
  const result = await executeDevelopmentContinue(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    childHandlers: {
      executeAutomatedTests: async () => {
        childCalls += 1
        return { ok: true, outcome: "tests_passed", run: fixture.run }
      }
    },
    trustedRuntimeProfileProvider: (request) => loadDevelopmentContinueRuntimeProfile(request, {
      platform: "darwin",
      statImpl: fakeRuntimeStatFor(),
      accessImpl: async () => {},
      execFileImpl: async () => {
        throw new Error("SENSITIVE_TEST_SENTINEL missing pytest")
      }
    })
  })
  const after = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, "continue_runtime_not_ready")
  assert.equal(childCalls, 0)
  assert.equal(after.version, before.version)
  assert.equal(after.status, before.status)
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_TEST_SENTINEL|missing pytest/)
})

test("Phase 6K refuses missing RBL Python runtime before Phase 6E mutation", async () => {
  const fixture = await createStoredRun("implementation_ready", {
    projectId: "rbl-content-engine"
  })
  const before = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  let childCalls = 0
  const result = await executeDevelopmentContinue(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    childHandlers: {
      executeAutomatedTests: async () => {
        childCalls += 1
        return { ok: true, outcome: "tests_passed", run: fixture.run }
      }
    },
    trustedRuntimeProfileProvider: (request) => loadDevelopmentContinueRuntimeProfile(request, {
      platform: "darwin",
      statImpl: fakeRuntimeStatFor({ missing: new Set(["/opt/homebrew/bin/python3.12"]) }),
      accessImpl: async () => {},
      execFileImpl: async () => {
        throw new Error("SENSITIVE_TEST_SENTINEL rbl runtime")
      }
    })
  })
  const after = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, "continue_runtime_not_ready")
  assert.equal(childCalls, 0)
  assert.equal(after.version, before.version)
  assert.equal(after.status, before.status)
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_TEST_SENTINEL|rbl runtime/)
})

test("Phase 6K does not weaken the production OpenClaw privilege boundary", async () => {
  const unit = await readFile(new URL("../deployment/systemd/ppo-openclaw.service", import.meta.url), "utf8")

  assert.match(unit, /^NoNewPrivileges=true$/m)
  assert.doesNotMatch(unit, /CAP_SYS_ADMIN|AmbientCapabilities|setcap|sudo|NoNewPrivileges=false/)
})

test("Phase 6K fails closed when the trusted runtime profile is missing or malformed", async () => {
  for (const provider of [
    async () => {
      throw new Error("SENSITIVE_TEST_SENTINEL missing profile")
    },
    async () => null,
    async () => ({
      workspaceRegistry: {},
      unexpectedRuntimeField: true
    })
  ]) {
    const fixture = await createStoredRun("implementation_in_progress")
    const before = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })
    const result = await executeDevelopmentContinue(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir,
      trustedRuntimeProfileProvider: provider
    })
    const after = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(result.ok, false)
    assert.equal(result.reason, "continue_runtime_not_ready")
    assert.equal(after.version, before.version)
    assert.equal(after.status, before.status)
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_TEST_SENTINEL|missing profile|unexpectedRuntimeField/)
  }
})

test("Phase 6K resumes interrupted hardening when no current Codex attempt is reserved", async () => {
  const run = makeRun("implementation_in_progress", {
    attempts: {
      implementation: 2,
      test: 1,
      review: 1
    },
    evidence: {
      implementation: [
        codexAttemptEvidence(makeRun("implementation_in_progress", {
          attempts: { implementation: 1 }
        }), {
          outcome: "execution_failed",
          metadata: { attempt: 1 }
        }),
        {
          kind: "implementation",
          sha: HEAD_SHA,
          source: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
          metadata: {
            project: PROJECT.id,
            orchestrator: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
            round: 1,
            sourceReviewSha: HEAD_SHA,
            reviewAttempt: 1,
            blockerCount: 1,
            securityFindingCount: 0,
            testRequirementCount: 0,
            remediationHash: "a".repeat(64),
            startedAt: STARTED_AT,
            outcome: "hardening_started",
            codex: CODEX_EXECUTION_ADAPTER_ID,
            tests: AUTOMATED_TEST_RUNNER_ID,
            reviewer: "phase-6f-independent-review-agent"
          }
        }
      ]
    }
  })
  const reader = makeReader(run)
  const children = makeChildHandlers({
    executeCodexImplementation: "implementation_ready"
  })
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: reader.readRun,
    childHandlers: children.handlers,
    trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run)
  })

  assert.equal(result.ok, true)
  assert.equal(result.action, "phase-6d-codex-implementation")
  assert.equal(children.calls.length, 1)
  assert.equal(children.calls[0].expectedVersion, run.version)
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

test("Phase 6K surfaces bounded Codex failure classifications without raw output", async () => {
  const run = makeRun("implementation_in_progress")
  const reader = makeReader(run)
  const result = await executeDevelopmentContinue(RUN_ID, {
    readRun: reader.readRun,
    childHandlers: {
      executeCodexImplementation: async () => {
        const error = new Error("SENSITIVE_TEST_SENTINEL 401 token_invalidated")
        error.code = "CODEX_EXECUTION_FAILED"
        error.failureClass = "authentication"
        throw error
      }
    },
    trustedRuntimeProfileProvider: trustedRuntimeProviderFor(run)
  })

  assert.equal(result.ok, false)
  assert.equal(result.action, "phase-6d-codex-implementation")
  assert.equal(result.reason, "codex_authentication_failed")
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_TEST_SENTINEL|token_invalidated/iu)
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
    ["codexConfig", {}],
    ["testPolicyRegistry", {}],
    ["reviewConfig", {}],
    ["workspaceRegistry", {}],
    ["githubClient", {}],
    ["gitRunner", async () => {}],
    ["sandboxRunner", async () => {}],
    ["runtimeProfile", {}],
    ["runtimeProvider", async () => {}],
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

test("ppo-command rejects malformed terminal continue argv before runtime or run-state access", async () => {
  const malformedArgvCases = [
    ["continue\n" + RUN_ID],
    ["continue\r\n" + RUN_ID],
    ["continue", `${RUN_ID}\n`],
    ["/ppo\ncontinue", RUN_ID],
    ["continue " + RUN_ID],
    ["continue", RUN_ID, "--action", "merge"],
    ["continue", RUN_ID, HEAD_SHA],
    [" continue", RUN_ID],
    ["continue", ` ${RUN_ID}`],
    ["/ppo", "continue", RUN_ID, "extra"],
    ["ppo", "continue", `${RUN_ID}\r\n`]
  ]

  for (const argv of malformedArgvCases) {
    const writeDataDir = await tempWriteDataDir("ppo-6k-command-")
    const result = runPpoCommand(argv, {
      env: {
        PPO_WRITE_DATA_DIR: writeDataDir,
        PPO_GITHUB_WRITE_CONFIRM: "SENSITIVE_TEST_SENTINEL",
        PPO_NOTE_WRITE_CONFIRM: "SENSITIVE_TEST_SENTINEL"
      }
    })

    assert.notEqual(result.status, 0, argv.join(" "))
    assert.match(result.stdout, /^Unsupported PPO command:/, argv.join(" "))
    assert.doesNotMatch(result.stdout, /PPO Development Continue|continue_runtime_not_ready|SENSITIVE_TEST_SENTINEL|token|secret/i, argv.join(" "))
    assert.equal(await pathExists(join(writeDataDir, "development-runs")), false, argv.join(" "))
  }
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
  assert.match(handled.output, /Build summary: Phase 6K stored route fixture\./)
  assert.match(handled.output, /Before: created/)
  assert.match(handled.output, /Action: phase-6b-plan/)
  assert.match(handled.output, /Outcome: planned/)
  assert.match(handled.output, /After: planned/)
  assert.match(handled.output, new RegExp(`Next command: /ppo continue ${RUN_ID}`, "u"))
  assert.doesNotMatch(handled.output, /stdout|stderr|stack|token|secret|SENSITIVE_TEST_SENTINEL/i)

  const hostileSummaryOutput = formatDevelopmentContinueResult({
    ...handled.result,
    buildSummary: "SENSITIVE_TEST_SENTINEL token=do-not-render"
  })
  assert.doesNotMatch(hostileSummaryOutput, /Build summary|SENSITIVE_TEST_SENTINEL|do-not-render/u)

  const blockedRun = makeRun("implementation_in_progress", {
    attempts: { implementation: 1 }
  })
  blockedRun.evidence.implementation = [codexAttemptEvidence(blockedRun)]
  const blocked = await handlePpoDevelopmentContinueCommand(RUN_ID, {
    readRun: makeReader(blockedRun).readRun,
    trustedRuntimeProfileProvider: trustedRuntimeProviderFor(blockedRun)
  })

  assert.equal(blocked.ok, false)
  assert.match(blocked.output, /Action: phase-6d-codex-implementation/)
  assert.match(blocked.output, /Outcome: owner_action_required/)
  assert.match(blocked.output, /Reason: codex_reconciliation_required/)
  assert.match(blocked.output, new RegExp(`Next command: /ppo run ${RUN_ID}`, "u"))
  assert.doesNotMatch(blocked.output, /stdout|stderr|stack|token|secret|SENSITIVE_TEST_SENTINEL|raw/i)
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
  assert.match(commandSource, /development-continue-runtime-profile\.mjs/)
  assert.match(commandSource, /trustedRuntimeProfileProvider:\s*loadDevelopmentContinueRuntimeProfile/)
})
