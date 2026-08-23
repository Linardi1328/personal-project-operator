import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import {
  createDevelopmentRun,
  DEVELOPMENT_RUN_STATUSES,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  recordDevelopmentRunProgress,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  CODEX_EXECUTION_SANDBOX_ID,
  classifyCodexExecutionAttemptEvidence
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  AUTOMATED_TEST_SANDBOX_ID,
  classifyAutomatedTestAttemptEvidence,
  resolveAutomatedTestPolicyIdentity
} from "./development-test-runner.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS
} from "./development-review-agent.mjs"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  REQUIRED_PPO_PR_VALIDATION_STEPS
} from "./github-delivery-agent.mjs"
import {
  prepareImplementationWorkspace,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"
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

const execFileAsync = promisify(execFile)
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

async function git(args, cwd) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    shell: false
  })

  return String(result.stdout ?? "").trim()
}

async function makeDurableReviewPassedFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ppo-6l-real-")))
  const sourceRepoPath = join(root, "source")
  const workspaceRoot = join(root, "workspaces")
  const writeDataDir = join(root, "write-data")

  await mkdir(sourceRepoPath)
  await git(["init"], sourceRepoPath)
  await git(["checkout", "-B", "main"], sourceRepoPath)
  await git(["config", "user.email", "ppo-test@example.invalid"], sourceRepoPath)
  await git(["config", "user.name", "PPO Test"], sourceRepoPath)
  await git(["remote", "add", "origin", `git@github.com:${PROJECT.fullName}.git`], sourceRepoPath)
  await writeFile(join(sourceRepoPath, "README.md"), "# Phase 6L\n", "utf8")
  await git(["add", "README.md"], sourceRepoPath)
  await git(["commit", "-m", "initial fixture"], sourceRepoPath)
  const baseSha = await git(["rev-parse", "HEAD"], sourceRepoPath)
  const workspaceRegistry = {
    [PROJECT.id]: {
      sourceRepoPath,
      workspaceRoot
    }
  }
  const now = () => new Date(STARTED_AT)
  const created = await createDevelopmentRun({
    projectId: PROJECT.id,
    task: "Recover a Phase 6L GitHub delivery fixture.",
    baseSha,
    branch: "main",
    headSha: baseSha,
    actor: "test-planner"
  }, {
    writeDataDir,
    now
  })
  const planning = await transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress",
    actor: "test-planner"
  }, {
    writeDataDir,
    now
  })
  const planned = await transitionDevelopmentRun(created.runId, {
    expectedVersion: planning.version,
    status: "planned",
    actor: "test-planner"
  }, {
    writeDataDir,
    now
  })
  const prepared = await prepareImplementationWorkspace(planned.runId, {
    expectedVersion: planned.version,
    writeDataDir,
    workspaceRegistry,
    now
  })
  const location = await resolveImplementationWorkspaceLocation(prepared.run, {
    writeDataDir,
    workspaceRegistry
  })

  await writeFile(join(location.workspacePath, "implementation.txt"), "implemented\n", "utf8")
  await git(["add", "implementation.txt"], location.workspacePath)
  await git(["commit", "-m", "phase 6l implementation"], location.workspacePath)
  const headSha = await git(["rev-parse", "HEAD"], location.workspacePath)
  const implementationReady = await transitionDevelopmentRun(created.runId, {
    expectedVersion: prepared.run.version,
    status: "implementation_ready",
    branch: location.branch,
    headSha,
    actor: CODEX_EXECUTION_ADAPTER_ID,
    evidence: [{
      kind: "implementation",
      sha: headSha,
      source: CODEX_EXECUTION_ADAPTER_ID,
      metadata: {
        project: PROJECT.id,
        adapter: CODEX_EXECUTION_ADAPTER_ID,
        attempt: 1,
        promptHash: PROMPT_HASH,
        outcome: "implementation_ready",
        changedFiles: 1
      }
    }]
  }, {
    writeDataDir,
    now
  })
  const testing = await transitionDevelopmentRun(created.runId, {
    expectedVersion: implementationReady.version,
    status: "tests_in_progress",
    actor: AUTOMATED_TEST_RUNNER_ID,
    evidence: [{
      kind: "test",
      sha: headSha,
      source: AUTOMATED_TEST_RUNNER_ID,
      metadata: {
        project: PROJECT.id,
        runner: AUTOMATED_TEST_RUNNER_ID,
        attempt: 1,
        policyId: "phase-6e-local-node-policy",
        policyHash: "b".repeat(64),
        implSha: headSha,
        outcome: "testing_started",
        sandbox: AUTOMATED_TEST_SANDBOX_ID,
        network: "none"
      }
    }]
  }, {
    writeDataDir,
    now
  })
  const testsPassed = await transitionDevelopmentRun(created.runId, {
    expectedVersion: testing.version,
    status: "tests_passed",
    branch: location.branch,
    headSha,
    actor: AUTOMATED_TEST_RUNNER_ID,
    evidence: [{
      kind: "test",
      sha: headSha,
      source: AUTOMATED_TEST_RUNNER_ID,
      metadata: {
        project: PROJECT.id,
        runner: AUTOMATED_TEST_RUNNER_ID,
        attempt: 1,
        policyId: "phase-6e-local-node-policy",
        policyHash: "b".repeat(64),
        implSha: headSha,
        outcome: "passed",
        total: 1,
        passed: 1,
        failed: 0,
        ambiguous: 0
      }
    }]
  }, {
    writeDataDir,
    now
  })
  const reviewing = await transitionDevelopmentRun(created.runId, {
    expectedVersion: testsPassed.version,
    status: "review_in_progress",
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    evidence: [{
      kind: "review",
      sha: headSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      metadata: {
        project: PROJECT.id,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 1,
        reviewedSha: headSha,
        promptHash: "c".repeat(64),
        outcome: "review_started",
        sandbox: "phase-6f-no-outbound-network-review-sandbox",
        network: "none"
      }
    }]
  }, {
    writeDataDir,
    now
  })
  const reviewPassed = await transitionDevelopmentRun(created.runId, {
    expectedVersion: reviewing.version,
    status: "review_passed",
    branch: location.branch,
    headSha,
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    evidence: [{
      kind: "review",
      sha: headSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      metadata: {
        project: PROJECT.id,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 1,
        reviewedSha: headSha,
        promptHash: "c".repeat(64),
        decision: REVIEW_DECISIONS.APPROVED,
        mergeAllowed: true,
        blockers: 0,
        securityFindings: 0,
        testsRequired: 0,
        summaryHash: "e".repeat(64),
        outcome: "approved",
        sandbox: "phase-6f-no-outbound-network-review-sandbox",
        network: "none"
      }
    }]
  }, {
    writeDataDir,
    now
  })

  return {
    writeDataDir,
    workspaceRegistry,
    location,
    run: reviewPassed,
    headSha,
    now
  }
}

function makePhase6GDeliveryEvidence(run, outcome, metadata = {}) {
  return {
    kind: "merge",
    sha: run.headSha,
    source: GITHUB_DELIVERY_AGENT_ID,
    summary: "Phase 6G delivery progress fixture.",
    metadata: {
      project: run.project.id,
      agent: GITHUB_DELIVERY_AGENT_ID,
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      implementationSha: run.headSha,
      outcome,
      ...metadata
    }
  }
}

function makePhase6GDeliveryEvidenceForSha(run, sha, outcome, metadata = {}) {
  return {
    ...makePhase6GDeliveryEvidence(run, outcome, metadata),
    sha,
    metadata: {
      ...makePhase6GDeliveryEvidence(run, outcome, metadata).metadata,
      implementationSha: sha,
      ...metadata
    }
  }
}

function makePhase6GRemoteReviewEvidence(run, pr, metadata = {}) {
  return {
    kind: "review",
    sha: run.headSha,
    source: REMOTE_PR_REVIEW_AGENT_ID,
    summary: "Phase 6G remote review fixture.",
    metadata: {
      project: run.project.id,
      reviewer: REMOTE_PR_REVIEW_AGENT_ID,
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      attempt: 1,
      prNumber: pr.number,
      branch: run.branch,
      reviewedSha: run.headSha,
      decision: REVIEW_DECISIONS.APPROVED,
      mergeAllowed: true,
      blockers: 0,
      securityFindings: 0,
      testsRequired: 0,
      outcome: "approved",
      endedAt: ENDED_AT,
      ...metadata
    }
  }
}

function makePhase6GRemoteReviewEvidenceForSha(run, pr, sha, metadata = {}) {
  return {
    ...makePhase6GRemoteReviewEvidence(run, pr, metadata),
    sha,
    metadata: {
      ...makePhase6GRemoteReviewEvidence(run, pr, metadata).metadata,
      reviewedSha: sha,
      ...metadata
    }
  }
}

async function appendPhase6GProgress(run, fixture, evidenceEntry, actor = GITHUB_DELIVERY_AGENT_ID) {
  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: run.status,
    actor,
    evidence: [evidenceEntry]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
}

function makeReadOnlyDeliveryGitRunner(remoteBranchSha = null) {
  return async (args) => {
    if (args[2] === "ls-remote") {
      return {
        stdout: remoteBranchSha ? `${remoteBranchSha}\t${args[4]}\n` : "",
        stderr: "",
        exitCode: 0
      }
    }

    const result = await execFileAsync("git", args, {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      shell: false
    })

    return {
      stdout: result.stdout,
      stderr: "",
      exitCode: 0
    }
  }
}

function makeReadOnlyDeliveryGithubClient(run, options = {}) {
  const writes = []
  const prs = options.prs || []
  const mainSha = options.mainSha || "m".repeat(40)
  const workflowRuns = options.runs || [{
    id: 100,
    name: "PPO PR validation",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    headSha: run.headSha,
    headBranch: run.branch
  }]
  const workflowJobs = options.jobs || [{
    id: 101,
    name: "validate",
    status: "completed",
    conclusion: "success",
    steps: REQUIRED_PPO_PR_VALIDATION_STEPS.map((name) => ({
      name,
      status: "completed",
      conclusion: "success"
    }))
  }]

  return {
    writes,
    async listPullRequests(_project, query) {
      return prs.filter((pr) => (
        pr.state === "open" &&
        pr.headRef === query.branch &&
        pr.baseRef === query.base
      ))
    },
    async getPullRequest(_project, prNumber) {
      const pr = prs.find((entry) => entry.number === prNumber)
      if (!pr) {
        throw new Error("missing pr")
      }
      return pr
    },
    async listWorkflowRuns() {
      return workflowRuns
    },
    async listWorkflowRunJobs() {
      return workflowJobs
    },
    async getBranchRef() {
      return { sha: mainSha }
    },
    async createPullRequest() {
      writes.push("createPullRequest")
      throw new Error("write refused")
    },
    async mergePullRequest() {
      writes.push("mergePullRequest")
      throw new Error("write refused")
    },
    async submitPullRequestReview() {
      writes.push("submitPullRequestReview")
      throw new Error("write refused")
    }
  }
}

function makePr(run, overrides = {}) {
  return {
    number: overrides.number || 1,
    state: overrides.state || "open",
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false,
    mergeable: overrides.mergeable ?? true,
    mergeableState: "clean",
    mergeCommitSha: overrides.mergeCommitSha || null,
    baseRef: overrides.baseRef || "main",
    baseRepoFullName: overrides.baseRepoFullName || run.project.fullName,
    headRef: overrides.headRef || run.branch,
    headSha: overrides.headSha || run.headSha,
    headRepoFullName: overrides.headRepoFullName || run.project.fullName,
    nodeId: "PR_node"
  }
}

async function advanceReviewPassedRunToNewSha(fixture, run) {
  await writeFile(join(fixture.location.workspacePath, "hardened.txt"), "hardened\n", "utf8")
  await git(["add", "hardened.txt"], fixture.location.workspacePath)
  await git(["commit", "-m", "phase 6l hardened implementation"], fixture.location.workspacePath)
  const newSha = await git(["rev-parse", "HEAD"], fixture.location.workspacePath)
  const implementing = await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "implementation_in_progress",
    branch: run.branch,
    headSha: run.headSha,
    actor: "phase-6f-bounded-hardening-orchestrator",
    evidence: [{
      kind: "implementation",
      sha: run.headSha,
      source: "phase-6f-bounded-hardening-orchestrator",
      metadata: {
        project: run.project.id,
        orchestrator: "phase-6f-bounded-hardening-orchestrator",
        sourceReviewSha: run.headSha,
        outcome: "hardening_started",
        round: 1
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  const ready = await transitionDevelopmentRun(run.runId, {
    expectedVersion: implementing.version,
    status: "implementation_ready",
    branch: run.branch,
    headSha: newSha,
    actor: CODEX_EXECUTION_ADAPTER_ID,
    evidence: [{
      kind: "implementation",
      sha: newSha,
      source: CODEX_EXECUTION_ADAPTER_ID,
      metadata: {
        project: run.project.id,
        adapter: CODEX_EXECUTION_ADAPTER_ID,
        attempt: implementing.attempts.implementation,
        promptHash: PROMPT_HASH,
        outcome: "implementation_ready",
        changedFiles: 1
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  const testing = await transitionDevelopmentRun(run.runId, {
    expectedVersion: ready.version,
    status: "tests_in_progress",
    actor: AUTOMATED_TEST_RUNNER_ID,
    evidence: [{
      kind: "test",
      sha: newSha,
      source: AUTOMATED_TEST_RUNNER_ID,
      metadata: {
        project: run.project.id,
        runner: AUTOMATED_TEST_RUNNER_ID,
        attempt: ready.attempts.test + 1,
        policyId: "phase-6e-local-node-policy",
        policyHash: "b".repeat(64),
        implSha: newSha,
        outcome: "testing_started",
        sandbox: AUTOMATED_TEST_SANDBOX_ID,
        network: "none"
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  const testsPassed = await transitionDevelopmentRun(run.runId, {
    expectedVersion: testing.version,
    status: "tests_passed",
    branch: run.branch,
    headSha: newSha,
    actor: AUTOMATED_TEST_RUNNER_ID,
    evidence: [{
      kind: "test",
      sha: newSha,
      source: AUTOMATED_TEST_RUNNER_ID,
      metadata: {
        project: run.project.id,
        runner: AUTOMATED_TEST_RUNNER_ID,
        attempt: testing.attempts.test,
        policyId: "phase-6e-local-node-policy",
        policyHash: "b".repeat(64),
        implSha: newSha,
        outcome: "passed",
        total: 1,
        passed: 1,
        failed: 0,
        ambiguous: 0
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  const reviewing = await transitionDevelopmentRun(run.runId, {
    expectedVersion: testsPassed.version,
    status: "review_in_progress",
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    evidence: [{
      kind: "review",
      sha: newSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      metadata: {
        project: run.project.id,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: testsPassed.attempts.review + 1,
        reviewedSha: newSha,
        promptHash: "c".repeat(64),
        outcome: "review_started",
        sandbox: "phase-6f-no-outbound-network-review-sandbox",
        network: "none"
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })

  return await transitionDevelopmentRun(run.runId, {
    expectedVersion: reviewing.version,
    status: "review_passed",
    branch: run.branch,
    headSha: newSha,
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    evidence: [{
      kind: "review",
      sha: newSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      metadata: {
        project: run.project.id,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: reviewing.attempts.review,
        reviewedSha: newSha,
        promptHash: "c".repeat(64),
        decision: REVIEW_DECISIONS.APPROVED,
        mergeAllowed: true,
        blockers: 0,
        securityFindings: 0,
        testsRequired: 0,
        summaryHash: "e".repeat(64),
        outcome: "approved",
        sandbox: "phase-6f-no-outbound-network-review-sandbox",
        network: "none"
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
}

async function makeRecoveryMergeReadyFixture() {
  const fixture = await makeDurableReviewPassedFixture()
  const pr = makePr(fixture.run)
  let run = fixture.run

  for (const entry of [
    makePhase6GDeliveryEvidence(run, "branch_pushed", {
      branch: run.branch,
      pushedSha: run.headSha,
      previousRemoteSha: "",
      remoteBranchSha: run.headSha,
      pushedAt: STARTED_AT
    }),
    makePhase6GDeliveryEvidence(run, "pr_created", {
      branch: run.branch,
      base: "main",
      prNumber: pr.number,
      prHeadSha: run.headSha,
      reconciledAt: ENDED_AT
    }),
    makePhase6GDeliveryEvidence(run, "ci_passed", {
      prNumber: pr.number,
      workflowName: "PPO PR validation",
      workflowRunId: 100,
      workflowConclusion: "success",
      requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length,
      checkedAt: ENDED_AT
    }),
    makePhase6GRemoteReviewEvidence(run, pr)
  ]) {
    const actor = entry.source === REMOTE_PR_REVIEW_AGENT_ID ? REMOTE_PR_REVIEW_AGENT_ID : GITHUB_DELIVERY_AGENT_ID
    run = await appendPhase6GProgress(run, fixture, entry, actor)
  }

  const mergeReady = await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "merge_ready",
    branch: run.branch,
    headSha: run.headSha,
    actor: GITHUB_DELIVERY_AGENT_ID,
    evidence: [makePhase6GDeliveryEvidence(run, "merge_ready", {
      prNumber: pr.number,
      branch: run.branch,
      base: "main",
      prHeadSha: run.headSha,
      workflowRunId: 100,
      remoteReviewedSha: run.headSha,
      remoteDecision: REVIEW_DECISIONS.APPROVED,
      preparedAt: ENDED_AT
    })]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })

  return {
    fixture,
    pr,
    run: mergeReady
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

test("shared Phase 6D evidence classifier covers current attempt trust cases", () => {
  const baseRun = runFor("implementation_in_progress", {
    attempts: { implementation: 2 }
  })
  const trustedStarted = codexStartedEvidence(baseRun)
  const trustedFailed = codexStartedEvidence(baseRun, {
    outcome: "execution_failed",
    endedAt: ENDED_AT
  })

  for (const [name, entries, expected] of [
    ["none", [], "none"],
    ["trusted-started", [trustedStarted], "open"],
    ["trusted-failed", [trustedFailed], "definitive_failed"],
    ["wrong-source", [{ ...trustedStarted, source: "wrong-source" }], "invalid"],
    ["source-adapter-mismatch", [codexStartedEvidence(baseRun, { adapter: "wrong-adapter" })], "invalid"],
    ["missing-attempt", [codexStartedEvidence(baseRun, { attempt: undefined })], "invalid"],
    ["malformed-attempt", [codexStartedEvidence(baseRun, { attempt: "2" })], "invalid"],
    ["wrong-attempt", [codexStartedEvidence(baseRun, { attempt: 1 })], "none"],
    ["stale-sha", [{ ...trustedStarted, sha: OTHER_SHA, metadata: { ...trustedStarted.metadata } }], "invalid"],
    ["wrong-project", [codexStartedEvidence(baseRun, { project: "wrong-project" })], "invalid"],
    ["wrong-sandbox", [codexStartedEvidence(baseRun, { sandbox: "wrong-sandbox" })], "invalid"],
    ["network-mismatch", [codexStartedEvidence(baseRun, { network: "default" })], "invalid"],
    ["branch-mismatch", [codexStartedEvidence(baseRun, { branch: "wrong-branch" })], "invalid"],
    ["malformed-prompt-hash", [codexStartedEvidence(baseRun, { promptHash: "bad" })], "invalid"],
    ["missing-workspace-id", [codexStartedEvidence(baseRun, { workspaceId: undefined })], "invalid"],
    ["malformed-backend", [codexStartedEvidence(baseRun, { backend: "bad\nbackend" })], "invalid"],
    ["malformed-timestamp", [codexStartedEvidence(baseRun, { startedAt: "bad\ntime" })], "invalid"]
  ]) {
    const run = runFor("implementation_in_progress", {
      attempts: { implementation: 2 },
      evidence: {
        implementation: entries
      }
    })

    assert.equal(classifyCodexExecutionAttemptEvidence(run), expected, name)
  }
})

test("shared Phase 6E evidence classifier covers current attempt trust cases", async () => {
  const baseRun = runFor("tests_in_progress", {
    attempts: { test: 2 }
  })
  const identity = await policyIdentityFor(baseRun)
  const trustedStarted = testEvidence(baseRun, identity, "testing_started")
  const trustedFailed = testEvidence(baseRun, identity, "failed")
  const trustedPassed = testEvidence(baseRun, identity, "passed")

  for (const [name, entries, expected] of [
    ["none", [], "none"],
    ["trusted-started", [trustedStarted], "open"],
    ["trusted-failed", [trustedFailed], "definitive_failed"],
    ["trusted-passed", [trustedPassed], "passed"],
    ["wrong-source", [{ ...trustedFailed, source: "wrong-source" }], "invalid"],
    ["runner-mismatch", [testEvidence(baseRun, identity, "failed", { runner: "wrong-runner" })], "invalid"],
    ["wrong-sha", [{ ...trustedFailed, sha: OTHER_SHA, metadata: { ...trustedFailed.metadata } }], "invalid"],
    ["wrong-attempt", [testEvidence(baseRun, identity, "failed", { attempt: 1 })], "invalid"],
    ["wrong-project", [testEvidence(baseRun, identity, "failed", { project: "wrong-project" })], "invalid"],
    ["wrong-policy-id", [testEvidence(baseRun, identity, "failed", { policyId: "wrong-policy" })], "invalid"],
    ["wrong-policy-hash", [testEvidence(baseRun, identity, "failed", { policyHash: "f".repeat(64) })], "invalid"],
    ["step-level-failure", [testEvidence(baseRun, identity, "failed", { testId: "unit" })], "invalid"],
    ["wrong-required-count", [testEvidence(baseRun, identity, "failed", { total: identity.requiredTestCount + 1 })], "invalid"],
    ["malformed-counts", [testEvidence(baseRun, identity, "failed", { failed: -1 })], "invalid"],
    ["wrong-sandbox", [testEvidence(baseRun, identity, "failed", { sandbox: "wrong-sandbox" })], "invalid"],
    ["network-mismatch", [testEvidence(baseRun, identity, "failed", { network: "default" })], "invalid"],
    ["malformed-workspace", [testEvidence(baseRun, identity, "testing_started", { workspaceId: "bad\nworkspace" })], "invalid"],
    ["malformed-timestamp", [testEvidence(baseRun, identity, "failed", { startedAt: "bad\ntime" })], "invalid"]
  ]) {
    const run = runFor("tests_in_progress", {
      attempts: { test: 2 },
      evidence: {
        test: entries
      }
    })

    assert.equal(classifyAutomatedTestAttemptEvidence(run, identity), expected, name)
  }
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

test("Phase 6L Linux recovery-only profile matches Phase 6K policy identity without readiness probes", async () => {
  const directoryPaths = new Set([
    "/var/lib/personal-project-operator/development-workspaces",
    "/var/lib/personal-project-operator/source-repos/khlim-assist",
    "/var/lib/personal-project-operator/source-repos/ledgerpilot-ai",
    "/var/lib/personal-project-operator/source-repos/spy-market-agent",
    "/var/lib/personal-project-operator/source-repos/richie-linardi-portfolio-website",
    "/var/lib/personal-project-operator/source-repos/rbl-content-engine",
    "/var/lib/personal-project-operator/phase6-sandbox"
  ])
  const fakeInfo = (path) => ({
    uid: 0,
    gid: 0,
    mode: 0o755,
    isFile: () => !directoryPaths.has(path),
    isDirectory: () => directoryPaths.has(path),
    isSymbolicLink: () => false
  })
  const fakeStat = async (path) => fakeInfo(path)
  const fakeIdentity = async () => ({
    uid: 4242,
    gid: 4243,
    userName: "ppo",
    groupName: "ppo"
  })
  const fakeExec = async () => ({ stdout: "ok\n", stderr: "" })

  for (const project of PROJECTS) {
    const run = runFor("tests_in_progress", {
      project,
      attempts: { test: 1 }
    })
    const continueProfile = await loadDevelopmentContinueRuntimeProfile({ run }, {
      platform: "linux",
      statImpl: fakeStat,
      lstatImpl: fakeStat,
      accessImpl: async () => {},
      execFileImpl: fakeExec,
      identityLookup: fakeIdentity,
      linuxSandboxCapabilityProbe: async () => true
    })
    const recoveryProfile = await loadDevelopmentRecoveryRuntimeProfile({ run }, {
      platform: "linux",
      includeTestPolicy: true,
      identityLookup: fakeIdentity,
      execFileImpl: async () => {
        throw new Error("SENSITIVE_TEST_SENTINEL recovery must not probe mutation runtime")
      },
      linuxSandboxCapabilityProbe: async () => {
        throw new Error("SENSITIVE_TEST_SENTINEL recovery must not probe sandbox readiness")
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

test("Phase 6L maps real Phase 6G read-only delivery reconciliation states", async () => {
  const cases = [
    {
      name: "not-started",
      remoteBranchSha: null,
      pr: null,
      progress: [],
      observation: "delivery_not_started",
      outcome: "recovery_not_required",
      ownerActionRequired: false,
      continuationCandidate: true
    },
    {
      name: "branch",
      remoteBranchSha: "exact",
      pr: null,
      progress: (run) => [makePhase6GDeliveryEvidence(run, "branch_pushed", {
        branch: run.branch,
        pushedSha: run.headSha,
        previousRemoteSha: "",
        remoteBranchSha: run.headSha,
        pushedAt: STARTED_AT
      })],
      observation: "delivery_branch_observed",
      outcome: "recovery_observed"
    },
    {
      name: "pr",
      remoteBranchSha: "exact",
      pr: "exact",
      progress: (run, pr) => [
        makePhase6GDeliveryEvidence(run, "branch_pushed", {
          branch: run.branch,
          pushedSha: run.headSha,
          previousRemoteSha: "",
          remoteBranchSha: run.headSha,
          pushedAt: STARTED_AT
        }),
        makePhase6GDeliveryEvidence(run, "pr_created", {
          branch: run.branch,
          base: "main",
          prNumber: pr.number,
          prHeadSha: run.headSha,
          reconciledAt: ENDED_AT
        })
      ],
      observation: "delivery_pr_observed",
      outcome: "recovery_observed"
    },
    {
      name: "ci",
      remoteBranchSha: "exact",
      pr: "exact",
      progress: (run, pr) => [
        makePhase6GDeliveryEvidence(run, "branch_pushed", {
          branch: run.branch,
          pushedSha: run.headSha,
          previousRemoteSha: "",
          remoteBranchSha: run.headSha,
          pushedAt: STARTED_AT
        }),
        makePhase6GDeliveryEvidence(run, "pr_created", {
          branch: run.branch,
          base: "main",
          prNumber: pr.number,
          prHeadSha: run.headSha,
          reconciledAt: ENDED_AT
        }),
        makePhase6GDeliveryEvidence(run, "ci_passed", {
          prNumber: pr.number,
          workflowName: "PPO PR validation",
          workflowRunId: 100,
          workflowConclusion: "success",
          requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length,
          checkedAt: ENDED_AT
        })
      ],
      observation: "delivery_ci_observed",
      outcome: "recovery_observed"
    },
    {
      name: "remote-review",
      remoteBranchSha: "exact",
      pr: "exact",
      progress: (run, pr) => [
        makePhase6GDeliveryEvidence(run, "branch_pushed", {
          branch: run.branch,
          pushedSha: run.headSha,
          previousRemoteSha: "",
          remoteBranchSha: run.headSha,
          pushedAt: STARTED_AT
        }),
        makePhase6GDeliveryEvidence(run, "pr_created", {
          branch: run.branch,
          base: "main",
          prNumber: pr.number,
          prHeadSha: run.headSha,
          reconciledAt: ENDED_AT
        }),
        makePhase6GDeliveryEvidence(run, "ci_passed", {
          prNumber: pr.number,
          workflowName: "PPO PR validation",
          workflowRunId: 100,
          workflowConclusion: "success",
          requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length,
          checkedAt: ENDED_AT
        }),
        makePhase6GRemoteReviewEvidence(run, pr)
      ],
      observation: "delivery_remote_review_observed",
      outcome: "recovery_observed"
    }
  ]

  for (const entry of cases) {
    const fixture = await makeDurableReviewPassedFixture()
    const pr = entry.pr === "exact" ? makePr(fixture.run) : null
    let run = fixture.run
    const progress = typeof entry.progress === "function" ? entry.progress(run, pr) : entry.progress

    for (const progressEntry of progress) {
      const actor = progressEntry.source === REMOTE_PR_REVIEW_AGENT_ID ? REMOTE_PR_REVIEW_AGENT_ID : GITHUB_DELIVERY_AGENT_ID
      run = await appendPhase6GProgress(run, fixture, progressEntry, actor)
    }

    const githubClient = makeReadOnlyDeliveryGithubClient(run, {
      prs: pr ? [pr] : []
    })
    const result = await executeDevelopmentRecovery(run.runId, {
      writeDataDir: fixture.writeDataDir,
      recoveryRuntimeProfileProvider: async () => ({
        workspaceRegistry: fixture.workspaceRegistry
      }),
      gitRunner: makeReadOnlyDeliveryGitRunner(entry.remoteBranchSha === "exact" ? run.headSha : entry.remoteBranchSha),
      githubClient
    })

    assert.equal(result.observation, entry.observation, entry.name)
    assert.equal(result.outcome, entry.outcome, entry.name)
    assert.equal(result.ownerActionRequired, entry.ownerActionRequired ?? true, entry.name)
    assert.equal(result.continuationCandidate, entry.continuationCandidate ?? false, entry.name)
    assert.deepEqual(githubClient.writes, [], entry.name)
  }
})

test("Phase 6L real Phase 6G recovery ignores trusted historical delivery from prior hardening SHA", async () => {
  const fixture = await makeDurableReviewPassedFixture()
  const shaA = fixture.run.headSha
  const prA = makePr(fixture.run, { number: 44 })
  let run = fixture.run

  for (const entry of [
    makePhase6GDeliveryEvidenceForSha(run, shaA, "branch_pushed", {
      branch: run.branch,
      pushedSha: shaA,
      previousRemoteSha: "",
      remoteBranchSha: shaA,
      pushedAt: STARTED_AT
    }),
    makePhase6GDeliveryEvidenceForSha(run, shaA, "pr_created", {
      branch: run.branch,
      base: "main",
      prNumber: prA.number,
      prHeadSha: shaA,
      reconciledAt: ENDED_AT
    }),
    makePhase6GDeliveryEvidenceForSha(run, shaA, "ci_passed", {
      prNumber: prA.number,
      workflowName: "PPO PR validation",
      workflowRunId: 100,
      workflowConclusion: "success",
      requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length,
      checkedAt: ENDED_AT
    })
  ]) {
    run = await appendPhase6GProgress(run, fixture, entry)
  }

  run = await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "review_changes_requested",
    branch: run.branch,
    headSha: shaA,
    actor: REMOTE_PR_REVIEW_AGENT_ID,
    evidence: [makePhase6GRemoteReviewEvidenceForSha(run, prA, shaA, {
      decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
      mergeAllowed: false,
      blockers: 1,
      securityFindings: 0,
      testsRequired: 0,
      outcome: "changes_requested"
    })]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })

  const runB = await advanceReviewPassedRunToNewSha(fixture, run)
  assert.notEqual(runB.headSha, shaA)

  const historicalClient = makeReadOnlyDeliveryGithubClient(runB, {
    prs: [makePr(runB, { number: prA.number, headSha: shaA })]
  })
  const historical = await executeDevelopmentRecovery(runB.runId, {
    writeDataDir: fixture.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: fixture.workspaceRegistry
    }),
    gitRunner: makeReadOnlyDeliveryGitRunner(shaA),
    githubClient: historicalClient
  })

  assert.equal(historical.observation, "delivery_not_started")
  assert.equal(historical.outcome, "recovery_not_required")
  assert.equal(historical.ownerActionRequired, false)
  assert.equal(historical.continuationCandidate, true)
  assert.equal(historical.run.headSha, runB.headSha)
  assert.deepEqual(historicalClient.writes, [])

  const currentBranchRun = await appendPhase6GProgress(runB, fixture, makePhase6GDeliveryEvidenceForSha(runB, runB.headSha, "branch_pushed", {
    branch: runB.branch,
    pushedSha: runB.headSha,
    previousRemoteSha: shaA,
    remoteBranchSha: runB.headSha,
    pushedAt: ENDED_AT
  }))
  const currentClient = makeReadOnlyDeliveryGithubClient(currentBranchRun, {
    prs: []
  })
  const current = await executeDevelopmentRecovery(currentBranchRun.runId, {
    writeDataDir: fixture.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: fixture.workspaceRegistry
    }),
    gitRunner: makeReadOnlyDeliveryGitRunner(currentBranchRun.headSha),
    githubClient: currentClient
  })

  assert.equal(current.observation, "delivery_branch_observed")
  assert.equal(current.outcome, "recovery_observed")
  assert.deepEqual(currentClient.writes, [])
})

test("Phase 6L real Phase 6G recovery fails closed for contradictory historical and malformed current evidence", async () => {
  const cases = [
    {
      name: "historical-contradictory-sha-fields",
      entry: (run, shaA) => makePhase6GDeliveryEvidenceForSha(run, shaA, "branch_pushed", {
        branch: run.branch,
        pushedSha: shaA,
        remoteBranchSha: run.headSha,
        pushedAt: STARTED_AT
      }),
      branchSha: (run, shaA) => shaA
    },
    {
      name: "historical-partially-current-pr-head",
      entry: (run, shaA) => makePhase6GDeliveryEvidenceForSha(run, shaA, "pr_created", {
        branch: run.branch,
        base: "main",
        prNumber: 77,
        prHeadSha: run.headSha,
        reconciledAt: ENDED_AT
      }),
      branchSha: (run, shaA) => shaA
    },
    {
      name: "current-malformed-policy",
      entry: (run) => makePhase6GDeliveryEvidenceForSha(run, run.headSha, "branch_pushed", {
        branch: run.branch,
        pushedSha: run.headSha,
        remoteBranchSha: run.headSha,
        policyHash: "0".repeat(64),
        pushedAt: STARTED_AT
      }),
      branchSha: (run) => run.headSha
    },
    {
      name: "current-malformed-pr-head",
      entry: (run, shaA) => makePhase6GDeliveryEvidenceForSha(run, run.headSha, "pr_created", {
        branch: run.branch,
        base: "main",
        prNumber: 77,
        prHeadSha: shaA,
        reconciledAt: ENDED_AT
      }),
      branchSha: (run) => run.headSha
    }
  ]

  for (const entry of cases) {
    const fixture = await makeDurableReviewPassedFixture()
    const shaA = fixture.run.headSha
    const requested = await transitionDevelopmentRun(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      status: "review_changes_requested",
      branch: fixture.run.branch,
      headSha: shaA,
      actor: REMOTE_PR_REVIEW_AGENT_ID,
      evidence: [makePhase6GRemoteReviewEvidenceForSha(fixture.run, makePr(fixture.run), shaA, {
        decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
        mergeAllowed: false,
        blockers: 1,
        securityFindings: 0,
        testsRequired: 0,
        outcome: "changes_requested"
      })]
    }, {
      writeDataDir: fixture.writeDataDir,
      now: fixture.now
    })
    let runB = await advanceReviewPassedRunToNewSha(fixture, requested)
    runB = await appendPhase6GProgress(runB, fixture, entry.entry(runB, shaA))
    const client = makeReadOnlyDeliveryGithubClient(runB)
    const result = await executeDevelopmentRecovery(runB.runId, {
      writeDataDir: fixture.writeDataDir,
      recoveryRuntimeProfileProvider: async () => ({
        workspaceRegistry: fixture.workspaceRegistry
      }),
      gitRunner: makeReadOnlyDeliveryGitRunner(entry.branchSha(runB, shaA)),
      githubClient: client
    })

    assert.equal(result.outcome, "recovery_unavailable", entry.name)
    assert.deepEqual(client.writes, [], entry.name)
  }

  const unknown = await makeDurableReviewPassedFixture()
  const unknownResult = await executeDevelopmentRecovery(unknown.run.runId, {
    writeDataDir: unknown.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: unknown.workspaceRegistry
    }),
    gitRunner: makeReadOnlyDeliveryGitRunner("9".repeat(40)),
    githubClient: makeReadOnlyDeliveryGithubClient(unknown.run)
  })

  assert.equal(unknownResult.outcome, "recovery_unavailable", "unknown-third-remote-branch")
})

test("Phase 6L real Phase 6G recovery observes merge-ready and remote-merged state without writes", async () => {
  const fixture = await makeDurableReviewPassedFixture()
  const pr = makePr(fixture.run)
  let run = fixture.run

  for (const entry of [
    makePhase6GDeliveryEvidence(run, "branch_pushed", {
      branch: run.branch,
      pushedSha: run.headSha,
      previousRemoteSha: "",
      remoteBranchSha: run.headSha,
      pushedAt: STARTED_AT
    }),
    makePhase6GDeliveryEvidence(run, "pr_created", {
      branch: run.branch,
      base: "main",
      prNumber: pr.number,
      prHeadSha: run.headSha,
      reconciledAt: ENDED_AT
    }),
    makePhase6GDeliveryEvidence(run, "ci_passed", {
      prNumber: pr.number,
      workflowName: "PPO PR validation",
      workflowRunId: 100,
      workflowConclusion: "success",
      requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length,
      checkedAt: ENDED_AT
    }),
    makePhase6GRemoteReviewEvidence(run, pr)
  ]) {
    const actor = entry.source === REMOTE_PR_REVIEW_AGENT_ID ? REMOTE_PR_REVIEW_AGENT_ID : GITHUB_DELIVERY_AGENT_ID
    run = await appendPhase6GProgress(run, fixture, entry, actor)
  }

  const mergeReady = await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "merge_ready",
    branch: run.branch,
    headSha: run.headSha,
    actor: GITHUB_DELIVERY_AGENT_ID,
    evidence: [makePhase6GDeliveryEvidence(run, "merge_ready", {
      prNumber: pr.number,
      branch: run.branch,
      base: "main",
      prHeadSha: run.headSha,
      workflowRunId: 100,
      remoteReviewedSha: run.headSha,
      remoteDecision: REVIEW_DECISIONS.APPROVED,
      preparedAt: ENDED_AT
    })]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  const readyClient = makeReadOnlyDeliveryGithubClient(mergeReady, {
    prs: [pr],
    mainSha: OTHER_SHA
  })
  const ready = await executeDevelopmentRecovery(mergeReady.runId, {
    writeDataDir: fixture.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: fixture.workspaceRegistry
    }),
    githubClient: readyClient
  })

  assert.equal(ready.observation, "delivery_merge_ready")
  assert.equal(ready.run.status, "merge_ready")
  assert.deepEqual(readyClient.writes, [])

  const mergedPr = {
    ...pr,
    state: "closed",
    merged: true,
    mergeCommitSha: OTHER_SHA
  }
  const mergedClient = makeReadOnlyDeliveryGithubClient(mergeReady, {
    prs: [mergedPr],
    mainSha: OTHER_SHA
  })
  const merged = await executeDevelopmentRecovery(mergeReady.runId, {
    writeDataDir: fixture.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: fixture.workspaceRegistry
    }),
    githubClient: mergedClient
  })

  assert.equal(merged.observation, "delivery_remote_merged")
  assert.equal(merged.run.status, "merge_ready")
  assert.deepEqual(mergedClient.writes, [])
})

test("Phase 6L real Phase 6G merge-ready recovery fails closed when proof is incomplete", async () => {
  const cases = [
    {
      name: "wrong-pr-head",
      pr: (run, pr) => ({ ...pr, headSha: "8".repeat(40) })
    },
    {
      name: "wrong-pr-base",
      pr: (_run, pr) => ({ ...pr, baseRef: "develop" })
    },
    {
      name: "wrong-pr-repository",
      pr: (_run, pr) => ({ ...pr, baseRepoFullName: "Linardi1328/wrong-repo" })
    },
    {
      name: "not-mergeable",
      pr: (_run, pr) => ({ ...pr, mergeable: false })
    },
    {
      name: "ci-pending",
      client: (run, pr) => makeReadOnlyDeliveryGithubClient(run, {
        prs: [pr],
        runs: [{
          id: 100,
          name: "PPO PR validation",
          event: "pull_request",
          status: "in_progress",
          conclusion: null,
          headSha: run.headSha,
          headBranch: run.branch
        }]
      })
    },
    {
      name: "ci-failed",
      client: (run, pr) => makeReadOnlyDeliveryGithubClient(run, {
        prs: [pr],
        runs: [{
          id: 100,
          name: "PPO PR validation",
          event: "pull_request",
          status: "completed",
          conclusion: "failure",
          headSha: run.headSha,
          headBranch: run.branch
        }]
      })
    },
    {
      name: "stale-workflow-head",
      client: (run, pr) => makeReadOnlyDeliveryGithubClient(run, {
        prs: [pr],
        runs: [{
          id: 100,
          name: "PPO PR validation",
          event: "pull_request",
          status: "completed",
          conclusion: "success",
          headSha: "7".repeat(40),
          headBranch: run.branch
        }]
      })
    },
    {
      name: "merged-main-mismatch",
      pr: (_run, pr) => ({
        ...pr,
        state: "closed",
        merged: true,
        mergeCommitSha: OTHER_SHA
      }),
      mainSha: "6".repeat(40)
    }
  ]

  for (const entry of cases) {
    const { fixture, run, pr } = await makeRecoveryMergeReadyFixture()
    const prState = entry.pr ? entry.pr(run, pr) : pr
    const client = entry.client
      ? entry.client(run, prState)
      : makeReadOnlyDeliveryGithubClient(run, {
        prs: [prState],
        mainSha: entry.mainSha || OTHER_SHA
      })
    const result = await executeDevelopmentRecovery(run.runId, {
      writeDataDir: fixture.writeDataDir,
      recoveryRuntimeProfileProvider: async () => ({
        workspaceRegistry: fixture.workspaceRegistry
      }),
      githubClient: client
    })

    assert.equal(result.outcome, "recovery_unavailable", entry.name)
    assert.deepEqual(client.writes, [], entry.name)
  }

  const malformed = await makeRecoveryMergeReadyFixture()
  const malformedRun = await appendPhase6GProgress(malformed.run, malformed.fixture, makePhase6GDeliveryEvidenceForSha(malformed.run, malformed.run.headSha, "merge_started", {
    prNumber: malformed.pr.number,
    expectedHeadSha: "5".repeat(40),
    mergeMethod: "squash",
    mergeAttemptedAt: ENDED_AT
  }))
  const malformedClient = makeReadOnlyDeliveryGithubClient(malformedRun, {
    prs: [malformed.pr],
    mainSha: OTHER_SHA
  })
  const malformedResult = await executeDevelopmentRecovery(malformedRun.runId, {
    writeDataDir: malformed.fixture.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: malformed.fixture.workspaceRegistry
    }),
    githubClient: malformedClient
  })

  assert.equal(malformedResult.outcome, "recovery_unavailable", "malformed-merge-started")
  assert.deepEqual(malformedClient.writes, [])
})

test("Phase 6L real Phase 6G recovery fails closed for wrong or conflicting remote delivery state", async () => {
  const wrongHead = await makeDurableReviewPassedFixture()
  const wrongPr = makePr(wrongHead.run, { headSha: "f".repeat(40) })
  const wrongHeadRun = await appendPhase6GProgress(wrongHead.run, wrongHead, makePhase6GDeliveryEvidence(wrongHead.run, "pr_created", {
    branch: wrongHead.run.branch,
    base: "main",
    prNumber: wrongPr.number,
    prHeadSha: wrongHead.run.headSha,
    reconciledAt: ENDED_AT
  }))
  const wrongHeadClient = makeReadOnlyDeliveryGithubClient(wrongHeadRun, {
    prs: [wrongPr]
  })
  const wrongHeadResult = await executeDevelopmentRecovery(wrongHeadRun.runId, {
    writeDataDir: wrongHead.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: wrongHead.workspaceRegistry
    }),
    gitRunner: makeReadOnlyDeliveryGitRunner(wrongHeadRun.headSha),
    githubClient: wrongHeadClient
  })

  assert.equal(wrongHeadResult.outcome, "recovery_unavailable")
  assert.deepEqual(wrongHeadClient.writes, [])

  const duplicate = await makeDurableReviewPassedFixture()
  const duplicateClient = makeReadOnlyDeliveryGithubClient(duplicate.run, {
    prs: [
      makePr(duplicate.run, { number: 1 }),
      makePr(duplicate.run, { number: 2 })
    ]
  })
  const duplicateResult = await executeDevelopmentRecovery(duplicate.run.runId, {
    writeDataDir: duplicate.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: duplicate.workspaceRegistry
    }),
    gitRunner: makeReadOnlyDeliveryGitRunner(duplicate.run.headSha),
    githubClient: duplicateClient
  })

  assert.equal(duplicateResult.outcome, "recovery_unavailable")
  assert.deepEqual(duplicateClient.writes, [])

  const stalePolicy = await makeDurableReviewPassedFixture()
  const staleRun = await appendPhase6GProgress(stalePolicy.run, stalePolicy, makePhase6GDeliveryEvidence(stalePolicy.run, "branch_pushed", {
    branch: stalePolicy.run.branch,
    pushedSha: stalePolicy.run.headSha,
    previousRemoteSha: "",
    remoteBranchSha: stalePolicy.run.headSha,
    policyHash: "0".repeat(64),
    pushedAt: STARTED_AT
  }))
  const staleClient = makeReadOnlyDeliveryGithubClient(staleRun)
  const staleResult = await executeDevelopmentRecovery(staleRun.runId, {
    writeDataDir: stalePolicy.writeDataDir,
    recoveryRuntimeProfileProvider: async () => ({
      workspaceRegistry: stalePolicy.workspaceRegistry
    }),
    gitRunner: makeReadOnlyDeliveryGitRunner(staleRun.headSha),
    githubClient: staleClient
  })

  assert.equal(staleResult.outcome, "recovery_unavailable")
  assert.deepEqual(staleClient.writes, [])
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

test("Phase 6L performs the durable post-read before mapping successful child results", async () => {
  const run = runFor("implementation_in_progress", {
    version: 7
  })
  const normalReader = makeReader([run, run])
  const normalChildren = makeReconcilers({
    reconcileCodexExecution: {
      ok: true,
      outcome: "codex_execution_reconciled",
      status: "advanced"
    }
  })
  const normal = await executeDevelopmentRecovery(RUN_ID, {
    readRun: normalReader.readRun,
    reconcilers: normalChildren.reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  })

  assert.equal(normal.observation, "codex_workspace_advanced")
  assert.equal(normalReader.reads.length, 2)

  const claimedReader = makeReader([run, run])
  const claimedChildren = makeReconcilers({
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
  const claimed = await executeDevelopmentRecovery(RUN_ID, {
    readRun: claimedReader.readRun,
    reconcilers: claimedChildren.reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  })

  assert.equal(claimed.outcome, "recovery_state_changed")
  assert.equal(claimed.observation, "state_changed")
  assert.equal(claimedReader.reads.length, 2)

  const childMutated = runFor("implementation_ready", {
    version: 8,
    history: [{ actor: CODEX_EXECUTION_ADAPTER_ID }]
  })
  const childMutationReader = makeReader([run, childMutated])
  const childMutation = await executeDevelopmentRecovery(RUN_ID, {
    readRun: childMutationReader.readRun,
    reconcilers: claimedChildren.reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  })

  assert.equal(childMutation.outcome, "recovery_state_changed")
  assert.equal(childMutation.observation, "state_changed")
  assert.equal(childMutationReader.reads.length, 2)
})

test("Phase 6L still re-reads durable state when a child reconciler throws", async () => {
  const run = runFor("implementation_in_progress", {
    version: 7
  })
  const unchangedReader = makeReader([run, run])
  const throwingChildren = makeReconcilers({
    reconcileCodexExecution: async () => {
      throw new Error("SENSITIVE_TEST_SENTINEL child failure")
    }
  })
  const unchanged = await executeDevelopmentRecovery(RUN_ID, {
    readRun: unchangedReader.readRun,
    reconcilers: throwingChildren.reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  })

  assert.equal(unchanged.outcome, "recovery_unavailable")
  assert.equal(unchanged.observation, "malformed_child_result")
  assert.equal(unchangedReader.reads.length, 2)
  assert.doesNotMatch(JSON.stringify(unchanged), /SENSITIVE_TEST_SENTINEL/)

  const childMutated = runFor("implementation_ready", {
    version: 8,
    history: [{ actor: CODEX_EXECUTION_ADAPTER_ID }]
  })
  const childMutationReader = makeReader([run, childMutated])
  const childMutation = await executeDevelopmentRecovery(RUN_ID, {
    readRun: childMutationReader.readRun,
    reconcilers: throwingChildren.reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  })

  assert.equal(childMutation.outcome, "recovery_state_changed")
  assert.equal(childMutation.observation, "state_changed")
  assert.equal(childMutationReader.reads.length, 2)

  const concurrent = runFor("implementation_ready", {
    version: 8,
    history: [{ actor: "another-actor" }]
  })
  const concurrentReader = makeReader([run, concurrent])
  const stale = await executeDevelopmentRecovery(RUN_ID, {
    readRun: concurrentReader.readRun,
    reconcilers: throwingChildren.reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  })

  assert.equal(stale.outcome, "stale_recovery_observation")
  assert.equal(stale.observation, "state_changed")
  assert.equal(concurrentReader.reads.length, 2)
})

test("Phase 6L detects child reconciler state-write regressions from claimed child run", async () => {
  const run = runFor("implementation_in_progress")
  const reader = makeReader([run, run])
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
  const result = await executeDevelopmentRecovery(RUN_ID, {
    readRun: reader.readRun,
    reconcilers: children.reconcilers,
    recoveryRuntimeProfileProvider: recoveryProfileProvider
  })

  assert.equal(result.outcome, "recovery_state_changed")
  assert.equal(result.observation, "state_changed")
  assert.equal(reader.reads.length, 2)
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
  const continueSource = await readFile(new URL("./development-continue-orchestrator.mjs", import.meta.url), "utf8")

  assert.doesNotMatch(source, /development-deployment-agent\.mjs/)
  assert.doesNotMatch(source, /development-production-verification-agent\.mjs/)
  assert.doesNotMatch(source, /development-rollback-agent\.mjs/)
  assert.doesNotMatch(source, /deploy-exact-sha\.sh|verify-production-readonly\.sh|rollback-exact-sha\.sh|service-control\.sh/)
  assert.doesNotMatch(source, /systemctl|\/opt\/personal-project-operator|\/var\/lib\/personal-project-operator|\bSSH\b|VPS/)
  assert.doesNotMatch(source, /\b(?:exec|execFile|spawn|spawnSync)\b/)
  assert.doesNotMatch(source, /\b(?:git push|git merge|git checkout|git switch|gh |curl|wget|ssh|scp|rsync)\b/)
  assert.doesNotMatch(source, /planExistingDevelopmentRun|prepareImplementationWorkspace|executeCodexImplementation|executeAutomatedTests|executeIndependentReview|executeBoundedHardening|executePhase6GDelivery|executeShaPinnedMerge/)
  assert.doesNotMatch(source, /transitionDevelopmentRun|recordDevelopmentRunProgress|createDevelopmentRun/)
  assert.match(source, /classifyCodexExecutionAttemptEvidence/)
  assert.match(source, /classifyAutomatedTestAttemptEvidence/)
  assert.match(continueSource, /classifyCodexExecutionAttemptEvidence/)
  assert.match(continueSource, /classifyAutomatedTestAttemptEvidence/)
  assert.doesNotMatch(source, /trustedCodexAttemptState|trustedTestEvidenceObservation/)
  assert.doesNotMatch(continueSource, /trustedCodexAttemptState|trustedTestEvidenceObservation/)
})
