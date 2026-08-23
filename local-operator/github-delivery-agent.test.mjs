import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import {
  DevelopmentRunStateError,
  createDevelopmentRun,
  readDevelopmentRun,
  recordDevelopmentRunProgress,
  resolveDevelopmentRunProject,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  buildCodexImplementationPrompt,
  CODEX_EXECUTION_ADAPTER_ID,
  PHASE_6F_HARDENING_ORCHESTRATOR_ID
} from "./development-codex-execution-adapter.mjs"
import {
  executeBoundedHardening
} from "./development-hardening-orchestrator.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID
} from "./development-test-runner.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS,
  REVIEW_SANDBOX_BACKENDS
} from "./development-review-agent.mjs"
import {
  prepareImplementationWorkspace,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID,
  assertDevelopmentAcceptanceGate
} from "./development-acceptance-gate.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD,
  REQUIRED_PPO_PR_VALIDATION_STEPS,
  createOrReconcileApprovedPullRequest,
  executeGitHubDeliveryToMergeReady,
  executePhase6GDelivery,
  executeRemotePrReview,
  executeShaPinnedMerge,
  pushApprovedBranch,
  reconcileGitHubDelivery,
  reconcileRemotePullRequestHead,
  requireExactHeadCi
} from "./github-delivery-agent.mjs"

const execFileAsync = promisify(execFile)
const BASE_TIME = Date.parse("2026-08-21T12:00:00.000Z")
const MERGE_SHA = "d".repeat(40)
const MAIN_SHA = MERGE_SHA

function makeClock() {
  let tick = 0

  return () => {
    const next = new Date(BASE_TIME + tick * 1000)
    tick += 1
    return next
  }
}

async function canonicalTempRoot(label = "ppo-6g-") {
  return realpath(await mkdtemp(join(tmpdir(), label)))
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

async function makeSourceRepo(options = {}) {
  const root = await canonicalTempRoot()
  const project = resolveDevelopmentRunProject(options.projectId || "khlim-assist")
  const sourceRepoPath = join(root, "source")
  const workspaceRoot = join(root, "workspaces")
  const writeDataDir = join(root, "write-data")

  await mkdir(sourceRepoPath)
  await git(["init"], sourceRepoPath)
  await git(["checkout", "-B", "main"], sourceRepoPath)
  await git(["config", "user.email", "ppo-test@example.invalid"], sourceRepoPath)
  await git(["config", "user.name", "PPO Test"], sourceRepoPath)
  await git(["remote", "add", "origin", options.remote || `git@github.com:${project.fullName}.git`], sourceRepoPath)
  await writeFile(join(sourceRepoPath, "README.md"), `# ${project.displayName}\n`, "utf8")
  await git(["add", "README.md"], sourceRepoPath)
  await git(["commit", "-m", "initial fixture"], sourceRepoPath)

  return {
    root,
    project,
    sourceRepoPath,
    workspaceRoot,
    writeDataDir,
    baseSha: await git(["rev-parse", "HEAD"], sourceRepoPath),
    registry: {
      [project.id]: {
        sourceRepoPath,
        workspaceRoot
      }
    }
  }
}

async function makeReviewPassedFixture(options = {}) {
  const fixture = await makeSourceRepo(options)
  const now = options.now || makeClock()
  const created = await createDevelopmentRun({
    projectId: fixture.project.id,
    task: options.task || "Implement the approved Phase 6G fixture without changing credentials.",
    baseSha: fixture.baseSha,
    branch: "main",
    headSha: fixture.baseSha,
    actor: "test-planner"
  }, {
    writeDataDir: fixture.writeDataDir,
    now
  })
  const planning = await transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress",
    actor: "test-planner"
  }, {
    writeDataDir: fixture.writeDataDir,
    now
  })
  const planned = await transitionDevelopmentRun(created.runId, {
    expectedVersion: planning.version,
    status: "planned",
    actor: "test-planner"
  }, {
    writeDataDir: fixture.writeDataDir,
    now
  })
  const prepared = await prepareImplementationWorkspace(planned.runId, {
    expectedVersion: planned.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    now
  })
  const location = await resolveImplementationWorkspaceLocation(prepared.run, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })

  await writeFile(join(location.workspacePath, "implementation.txt"), "implemented\n", "utf8")
  await git(["add", "implementation.txt"], location.workspacePath)
  await git(["commit", "-m", "phase 6g implementation fixture"], location.workspacePath)

  const headSha = await git(["rev-parse", "HEAD"], location.workspacePath)
  const ready = await transitionDevelopmentRun(prepared.run.runId, {
    expectedVersion: prepared.run.version,
    status: "implementation_ready",
    branch: location.branch,
    headSha,
    actor: CODEX_EXECUTION_ADAPTER_ID,
    evidence: options.implementationEvidence === false ? [] : [{
      kind: "implementation",
      sha: options.implementationSha || headSha,
      source: CODEX_EXECUTION_ADAPTER_ID,
      metadata: {
        project: fixture.project.id,
        adapter: CODEX_EXECUTION_ADAPTER_ID,
        attempt: 1,
        promptHash: "a".repeat(64),
        outcome: "implementation_ready",
        changedFiles: 1
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now
  })
  const testing = await transitionDevelopmentRun(ready.runId, {
    expectedVersion: ready.version,
    status: "tests_in_progress",
    actor: AUTOMATED_TEST_RUNNER_ID,
    evidence: [{
      kind: "test",
      sha: headSha,
      source: AUTOMATED_TEST_RUNNER_ID,
      metadata: {
        project: fixture.project.id,
        runner: AUTOMATED_TEST_RUNNER_ID,
        attempt: 1,
        policyId: "phase-6e-local-node-policy",
        policyHash: "b".repeat(64),
        implSha: headSha,
        outcome: "testing_started",
        sandbox: "phase-6e-no-outbound-network-test-sandbox",
        network: "none"
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now
  })
  const testsPassed = await transitionDevelopmentRun(testing.runId, {
    expectedVersion: testing.version,
    status: "tests_passed",
    branch: location.branch,
    headSha,
    actor: AUTOMATED_TEST_RUNNER_ID,
    evidence: options.testEvidence === false ? [] : [{
      kind: "test",
      sha: options.testSha || headSha,
      source: AUTOMATED_TEST_RUNNER_ID,
      metadata: {
        project: fixture.project.id,
        runner: AUTOMATED_TEST_RUNNER_ID,
        attempt: 1,
        policyId: "phase-6e-local-node-policy",
        policyHash: "b".repeat(64),
        implSha: options.testImplSha || headSha,
        outcome: "passed",
        total: 1,
        passed: 1,
        failed: 0,
        ambiguous: options.ambiguousTests ? 1 : 0
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now
  })
  const reviewing = await transitionDevelopmentRun(testsPassed.runId, {
    expectedVersion: testsPassed.version,
    status: "review_in_progress",
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    evidence: [{
      kind: "review",
      sha: headSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      metadata: {
        project: fixture.project.id,
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
    writeDataDir: fixture.writeDataDir,
    now
  })
  const reviewPassed = await transitionDevelopmentRun(reviewing.runId, {
    expectedVersion: reviewing.version,
    status: "review_passed",
    branch: location.branch,
    headSha,
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    evidence: options.reviewEvidence === false ? [] : [{
      kind: "review",
      sha: options.reviewSha || headSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      metadata: {
        project: fixture.project.id,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 1,
        reviewedSha: options.reviewedSha || headSha,
        promptHash: "c".repeat(64),
        decision: REVIEW_DECISIONS.APPROVED,
        mergeAllowed: options.mergeAllowed ?? true,
        blockers: options.blockers || 0,
        securityFindings: options.securityFindings || 0,
        testsRequired: options.testsRequired || 0,
        summaryHash: "e".repeat(64),
        outcome: "approved",
        sandbox: "phase-6f-no-outbound-network-review-sandbox",
        network: "none"
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now
  })

  return {
    ...fixture,
    now,
    location,
    headSha,
    run: reviewPassed
  }
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

function remoteReviewEntries(run, outcome = null) {
  return run.evidence.review.filter((entry) => (
    entry.source === REMOTE_PR_REVIEW_AGENT_ID &&
    entry.metadata?.reviewer === REMOTE_PR_REVIEW_AGENT_ID &&
    (outcome === null || entry.metadata?.outcome === outcome)
  ))
}

function latestRemoteReviewEntry(run, outcome) {
  return remoteReviewEntries(run, outcome).at(-1)
}

function trustedReviewConfig() {
  return {
    executablePath: process.execPath,
    args: ["--eval", "process.exit(0)"],
    timeoutMs: 2000,
    maxOutputBytes: 4096,
    env: {
      PPO_SAFE_REVIEW_FLAG: "1"
    },
    sandbox: {
      type: REVIEW_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
      platform: "darwin",
      network: "none",
      enforcement: "os-process",
      readOnlyWorkspace: true,
      readOnlyWorkspaceMode: "trusted-read-only-workspace",
      executablePath: "/usr/bin/sandbox-exec"
    }
  }
}

function reviewerDecision(reviewedSha, overrides = {}) {
  return {
    decision: REVIEW_DECISIONS.APPROVED,
    reviewedSha,
    mergeAllowed: true,
    blockers: [],
    securityFindings: [],
    testsRequired: [],
    summary: "Remote exact-head PR review approved.",
    ...overrides
  }
}

function makeReviewRunner(factory = (invocation) => reviewerDecision(invocation.reviewedSha), options = {}) {
  const calls = options.calls || []

  return async (invocation) => {
    calls.push(invocation)
    assert.equal(invocation.shell, false)
    assert.equal(invocation.sandbox.network, "none")
    assert.equal(invocation.sandbox.readOnlyWorkspace, true)

    if (invocation.kind === "sandbox-probe") {
      if (["local-process", "workspace-read", "linux-privilege-boundary"].includes(invocation.probe)) {
        return { exitCode: 0, stdout: "", stderr: "" }
      }

      if (["workspace-file-write", "source-file-write", "workspace-git-mutation", "direct-network"].includes(invocation.probe)) {
        return options.probeAllowed
          ? { exitCode: 70, stdout: "probe allowed", stderr: "" }
          : { exitCode: 0, sandboxDenied: true, stdout: "", stderr: "" }
      }
    }

    if (options.rawReviewResult) {
      return options.rawReviewResult
    }

    return {
      exitCode: 0,
      stdout: `${JSON.stringify(factory(invocation))}\n`,
      stderr: "raw stderr ignored"
    }
  }
}

function makePr(project, branch, headSha, overrides = {}) {
  return {
    number: overrides.number || 1,
    state: overrides.state || "open",
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false,
    mergeable: overrides.mergeable ?? true,
    mergeableState: overrides.mergeableState || "clean",
    mergeCommitSha: overrides.mergeCommitSha || null,
    baseRef: overrides.baseRef || "main",
    baseRepoFullName: overrides.baseRepoFullName || project.fullName,
    headRef: overrides.headRef || branch,
    headSha: overrides.headSha || headSha,
    headRepoFullName: overrides.headRepoFullName || project.fullName,
    nodeId: overrides.nodeId || "PR_node"
  }
}

function successRun(headSha, overrides = {}) {
  return {
    id: overrides.id || 100,
    name: "PPO PR validation",
    event: "pull_request",
    status: overrides.status || "completed",
    conclusion: overrides.conclusion ?? "success",
    headSha: overrides.headSha || headSha,
    headBranch: overrides.headBranch || null,
    runNumber: 1,
    attempt: 1
  }
}

function successJobs(overrides = {}) {
  return [{
    id: 200,
    name: "validate",
    status: overrides.status || "completed",
    conclusion: overrides.conclusion ?? "success",
    steps: REQUIRED_PPO_PR_VALIDATION_STEPS.map((name) => ({
      name,
      status: "completed",
      conclusion: "success"
    }))
  }]
}

function makeGitHubClient(project, branch, headSha, options = {}) {
  const state = {
    prs: options.prs ? [...options.prs] : [],
    created: [],
    mergeCalls: [],
    mainSha: options.mainSha || MAIN_SHA,
    runs: options.runs || [successRun(headSha)],
    jobs: options.jobs || successJobs(),
    createAmbiguous: options.createAmbiguous || false,
    mergeAmbiguous: options.mergeAmbiguous || false,
    mergeAmbiguousWithoutRemote: options.mergeAmbiguousWithoutRemote || false,
    mergeCrashAfterRemote: options.mergeCrashAfterRemote || false
  }

  return {
    state,
    async listPullRequests(_project, query) {
      return state.prs.filter((pr) => (
        pr.state === "open" &&
        pr.headRef === query.branch &&
        pr.baseRef === query.base
      ))
    },
    async createPullRequest(_project, input) {
      state.created.push(input)
      const pr = makePr(project, branch, headSha, { number: state.prs.length + 1 })
      state.prs.push(pr)

      if (state.createAmbiguous) {
        state.createAmbiguous = false
        const error = new Error("ambiguous create")
        error.ambiguous = true
        throw error
      }

      return pr
    },
    async getPullRequest(_project, prNumber) {
      const pr = state.prs.find((entry) => entry.number === prNumber)

      if (!pr) {
        throw new Error("missing pr")
      }

      return pr
    },
    async listWorkflowRuns() {
      return state.runs
    },
    async listWorkflowRunJobs() {
      return state.jobs
    },
    async mergePullRequest(_project, input) {
      state.mergeCalls.push(input)
      const pr = state.prs.find((entry) => entry.number === input.prNumber)

      if (!pr) {
        throw new Error("missing pr")
      }

      assert.equal(input.expectedHeadSha, pr.headSha)
      assert.equal(input.method, PHASE_6G_APPROVED_MERGE_METHOD)

      if (state.mergeAmbiguous) {
        state.mergeAmbiguous = false

        if (!state.mergeAmbiguousWithoutRemote) {
          pr.merged = true
          pr.state = "closed"
          pr.mergeCommitSha = MERGE_SHA
          state.mainSha = MERGE_SHA
        }

        const error = new Error("ambiguous merge")
        error.ambiguous = true
        throw error
      }

      pr.merged = true
      pr.state = "closed"
      pr.mergeCommitSha = MERGE_SHA
      state.mainSha = MERGE_SHA

      if (state.mergeCrashAfterRemote) {
        state.mergeCrashAfterRemote = false
        throw new Error("local process crashed after remote merge")
      }

      return {
        merged: true,
        sha: MERGE_SHA
      }
    },
    async getBranchRef() {
      return {
        sha: state.mainSha
      }
    }
  }
}

function makeGitRunner(remoteState = {}) {
  const state = {
    branchSha: remoteState.branchSha || null,
    pushCalls: [],
    pushMode: remoteState.pushMode || "success"
  }

  const runner = async (args) => {
    const command = args[2]

    if (command === "ls-remote") {
      const ref = args[4]
      return {
        stdout: state.branchSha ? `${state.branchSha}\t${ref}\n` : "",
        stderr: "",
        exitCode: 0
      }
    }

    if (command === "push") {
      state.pushCalls.push([...args])
      const [sha] = args[4].split(":")

      if (state.pushMode === "ambiguous-recovered") {
        state.branchSha = sha
        state.pushMode = "success"
        const error = new Error("ambiguous push")
        error.ambiguous = true
        throw error
      }

      if (state.pushMode === "ambiguous-absent-retry") {
        state.pushMode = "success"
        const error = new Error("ambiguous push")
        error.ambiguous = true
        throw error
      }

      state.branchSha = sha
      return {
        stdout: "pushed\n",
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

  runner.state = state
  return runner
}

function deliveryProgressEvidence(run, outcome, metadata = {}) {
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

function remoteReviewProgressEvidence(run, pr, outcome = "approved", metadata = {}) {
  return {
    kind: "review",
    sha: run.headSha,
    source: REMOTE_PR_REVIEW_AGENT_ID,
    summary: "Phase 6G remote review progress fixture.",
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
      outcome,
      endedAt: "2026-08-21T12:00:00.000Z",
      ...metadata
    }
  }
}

async function appendDeliveryProgress(run, evidence, fixture, actor = GITHUB_DELIVERY_AGENT_ID) {
  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: run.status,
    actor,
    evidence: [evidence]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
}

function readOnlyGithubClient(client) {
  const writes = []

  return {
    writes,
    state: client.state,
    listPullRequests: (...args) => client.listPullRequests(...args),
    getPullRequest: (...args) => client.getPullRequest(...args),
    listWorkflowRuns: (...args) => client.listWorkflowRuns(...args),
    listWorkflowRunJobs: (...args) => client.listWorkflowRunJobs(...args),
    getBranchRef: (...args) => client.getBranchRef(...args),
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

async function makeMergeReadyDeliveryFixture(options = {}) {
  const fixture = await makeReviewPassedFixture(options.fixtureOptions || {})
  const githubClient = options.githubClient || makeGitHubClient(
    fixture.project,
    fixture.run.branch,
    fixture.headSha,
    options.githubOptions || {}
  )
  const delivered = await executeGitHubDeliveryToMergeReady(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    gitRunner: makeGitRunner(),
    githubClient,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: fixture.now
  })

  return {
    ...fixture,
    githubClient,
    delivered
  }
}

async function makeMergeStartedCrashFixture(options = {}) {
  const fixture = await makeMergeReadyDeliveryFixture({
    githubOptions: {
      mainSha: "c".repeat(40),
      mergeCrashAfterRemote: true,
      ...(options.githubOptions || {})
    }
  })

  await assert.rejects(executeShaPinnedMerge(fixture.run.runId, {
    expectedVersion: fixture.delivered.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    githubClient: fixture.githubClient,
    now: fixture.now
  }), /local process crashed after remote merge/u)

  const withStarted = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(withStarted.status, "merge_ready")
  assert.equal(withStarted.evidence.merge.at(-1).metadata.outcome, "merge_started")
  assert.equal(fixture.githubClient.state.mergeCalls.length, 1)

  return {
    ...fixture,
    withStarted
  }
}

test("read-only delivery reconciliation observes review_passed delivery progress before merge_ready", async () => {
  const cases = [
    {
      name: "not-started",
      remoteBranchSha: null,
      pr: null,
      evidence: [],
      expected: {
        latestOutcome: null,
        remoteBranchSha: null,
        prNumber: null,
        ciStatus: "unknown",
        remoteReviewOutcome: null,
        mergeStatus: "not_started"
      }
    },
    {
      name: "branch",
      remoteBranchSha: "exact",
      pr: null,
      evidence: (run) => [deliveryProgressEvidence(run, "branch_pushed", {
        branch: run.branch,
        pushedSha: run.headSha,
        previousRemoteSha: "",
        remoteBranchSha: run.headSha,
        pushedAt: "2026-08-21T12:00:00.000Z"
      })],
      expected: {
        latestOutcome: "branch_pushed",
        remoteBranchSha: "exact",
        prNumber: null,
        ciStatus: "unknown",
        remoteReviewOutcome: null,
        mergeStatus: "review_passed"
      }
    },
    {
      name: "pr",
      remoteBranchSha: "exact",
      pr: "exact",
      evidence: (run, pr) => [
        deliveryProgressEvidence(run, "branch_pushed", {
          branch: run.branch,
          pushedSha: run.headSha,
          previousRemoteSha: "",
          remoteBranchSha: run.headSha,
          pushedAt: "2026-08-21T12:00:00.000Z"
        }),
        deliveryProgressEvidence(run, "pr_created", {
          branch: run.branch,
          base: "main",
          prNumber: pr.number,
          prHeadSha: run.headSha,
          reconciledAt: "2026-08-21T12:00:01.000Z"
        })
      ],
      expected: {
        latestOutcome: "pr_created",
        remoteBranchSha: "exact",
        prNumber: 1,
        prHeadSha: "exact",
        ciStatus: "unknown",
        remoteReviewOutcome: null,
        mergeStatus: "review_passed"
      }
    },
    {
      name: "ci",
      remoteBranchSha: "exact",
      pr: "exact",
      evidence: (run, pr) => [
        deliveryProgressEvidence(run, "branch_pushed", {
          branch: run.branch,
          pushedSha: run.headSha,
          previousRemoteSha: "",
          remoteBranchSha: run.headSha,
          pushedAt: "2026-08-21T12:00:00.000Z"
        }),
        deliveryProgressEvidence(run, "pr_created", {
          branch: run.branch,
          base: "main",
          prNumber: pr.number,
          prHeadSha: run.headSha,
          reconciledAt: "2026-08-21T12:00:01.000Z"
        }),
        deliveryProgressEvidence(run, "ci_passed", {
          prNumber: pr.number,
          workflowName: "PPO PR validation",
          workflowRunId: 100,
          workflowConclusion: "success",
          requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length,
          checkedAt: "2026-08-21T12:00:02.000Z"
        })
      ],
      expected: {
        latestOutcome: "ci_passed",
        remoteBranchSha: "exact",
        prNumber: 1,
        prHeadSha: "exact",
        ciStatus: "passed",
        remoteReviewOutcome: null,
        mergeStatus: "review_passed"
      }
    },
    {
      name: "remote-review",
      remoteBranchSha: "exact",
      pr: "exact",
      evidence: (run, pr) => [
        deliveryProgressEvidence(run, "branch_pushed", {
          branch: run.branch,
          pushedSha: run.headSha,
          previousRemoteSha: "",
          remoteBranchSha: run.headSha,
          pushedAt: "2026-08-21T12:00:00.000Z"
        }),
        deliveryProgressEvidence(run, "pr_created", {
          branch: run.branch,
          base: "main",
          prNumber: pr.number,
          prHeadSha: run.headSha,
          reconciledAt: "2026-08-21T12:00:01.000Z"
        }),
        deliveryProgressEvidence(run, "ci_passed", {
          prNumber: pr.number,
          workflowName: "PPO PR validation",
          workflowRunId: 100,
          workflowConclusion: "success",
          requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length,
          checkedAt: "2026-08-21T12:00:02.000Z"
        }),
        remoteReviewProgressEvidence(run, pr)
      ],
      expected: {
        latestOutcome: "ci_passed",
        remoteBranchSha: "exact",
        prNumber: 1,
        prHeadSha: "exact",
        ciStatus: "passed",
        remoteReviewOutcome: "approved",
        mergeStatus: "review_passed"
      }
    }
  ]

  for (const entry of cases) {
    const fixture = await makeReviewPassedFixture()
    const pr = entry.pr === "exact" ? makePr(fixture.project, fixture.run.branch, fixture.headSha) : null
    const client = readOnlyGithubClient(makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha, {
      prs: pr ? [pr] : []
    }))
    const evidenceEntries = typeof entry.evidence === "function" ? entry.evidence(fixture.run, pr) : entry.evidence

    let run = fixture.run
    for (const evidenceEntry of evidenceEntries) {
      const actor = evidenceEntry.source === REMOTE_PR_REVIEW_AGENT_ID ? REMOTE_PR_REVIEW_AGENT_ID : GITHUB_DELIVERY_AGENT_ID
      run = await appendDeliveryProgress(run, evidenceEntry, fixture, actor)
    }

    const reconciled = await reconcileGitHubDelivery(run.runId, {
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      gitRunner: makeGitRunner({
        branchSha: entry.remoteBranchSha === "exact" ? fixture.headSha : entry.remoteBranchSha
      }),
      githubClient: client
    })

    assert.equal(reconciled.outcome, "github_delivery_reconciled", entry.name)
    assert.equal(reconciled.delivery.latestOutcome, entry.expected.latestOutcome, entry.name)
    assert.equal(reconciled.delivery.remoteBranchSha, entry.expected.remoteBranchSha === "exact" ? fixture.headSha : entry.expected.remoteBranchSha, entry.name)
    assert.equal(reconciled.delivery.prNumber, entry.expected.prNumber, entry.name)
    assert.equal(reconciled.delivery.prHeadSha, entry.expected.prHeadSha === "exact" ? fixture.headSha : null, entry.name)
    assert.equal(reconciled.delivery.ciStatus, entry.expected.ciStatus, entry.name)
    assert.equal(reconciled.delivery.remoteReviewOutcome, entry.expected.remoteReviewOutcome, entry.name)
    assert.equal(reconciled.delivery.mergeStatus, entry.expected.mergeStatus, entry.name)
    assert.deepEqual(client.writes, [], entry.name)
  }
})

test("read-only delivery reconciliation observes merge_ready and remote merge without writing", async () => {
  const fixture = await makeMergeReadyDeliveryFixture({
    githubOptions: {
      mainSha: "c".repeat(40)
    }
  })
  const client = readOnlyGithubClient(fixture.githubClient)
  const ready = await reconcileGitHubDelivery(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    githubClient: client
  })

  assert.equal(ready.delivery.mergeStatus, "merge_ready")
  assert.equal(ready.delivery.prNumber, 1)
  assert.deepEqual(client.writes, [])

  fixture.githubClient.state.prs[0].state = "closed"
  fixture.githubClient.state.prs[0].merged = true
  fixture.githubClient.state.prs[0].mergeCommitSha = MERGE_SHA
  fixture.githubClient.state.mainSha = MERGE_SHA

  const merged = await reconcileGitHubDelivery(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    githubClient: client
  })

  assert.equal(merged.delivery.mergeStatus, "merged_remote")
  assert.deepEqual(client.writes, [])
})

test("read-only delivery reconciliation fails closed on wrong PR head, duplicate PRs, and stale policy evidence", async () => {
  const wrongHead = await makeReviewPassedFixture()
  const wrongHeadPr = makePr(wrongHead.project, wrongHead.run.branch, wrongHead.headSha, {
    headSha: "e".repeat(40)
  })
  const wrongHeadRun = await appendDeliveryProgress(wrongHead.run, deliveryProgressEvidence(wrongHead.run, "pr_created", {
    branch: wrongHead.run.branch,
    base: "main",
    prNumber: wrongHeadPr.number,
    prHeadSha: wrongHead.run.headSha,
    reconciledAt: "2026-08-21T12:00:01.000Z"
  }), wrongHead)

  await assertRejectsCode(reconcileGitHubDelivery(wrongHeadRun.runId, {
    writeDataDir: wrongHead.writeDataDir,
    workspaceRegistry: wrongHead.registry,
    gitRunner: makeGitRunner({ branchSha: wrongHead.headSha }),
    githubClient: readOnlyGithubClient(makeGitHubClient(wrongHead.project, wrongHead.run.branch, wrongHead.headSha, {
      prs: [wrongHeadPr]
    }))
  }), "GITHUB_DELIVERY_PR_HEAD_MISMATCH")

  const duplicate = await makeReviewPassedFixture()
  await assertRejectsCode(reconcileGitHubDelivery(duplicate.run.runId, {
    writeDataDir: duplicate.writeDataDir,
    workspaceRegistry: duplicate.registry,
    gitRunner: makeGitRunner({ branchSha: duplicate.headSha }),
    githubClient: readOnlyGithubClient(makeGitHubClient(duplicate.project, duplicate.run.branch, duplicate.headSha, {
      prs: [
        makePr(duplicate.project, duplicate.run.branch, duplicate.headSha, { number: 1 }),
        makePr(duplicate.project, duplicate.run.branch, duplicate.headSha, { number: 2 })
      ]
    }))
  }), "GITHUB_DELIVERY_PR_AMBIGUOUS")

  const stalePolicy = await makeReviewPassedFixture()
  const staleRun = await appendDeliveryProgress(stalePolicy.run, deliveryProgressEvidence(stalePolicy.run, "branch_pushed", {
    branch: stalePolicy.run.branch,
    pushedSha: stalePolicy.run.headSha,
    previousRemoteSha: "",
    remoteBranchSha: stalePolicy.run.headSha,
    policyHash: "f".repeat(64),
    pushedAt: "2026-08-21T12:00:00.000Z"
  }), stalePolicy)

  await assertRejectsCode(reconcileGitHubDelivery(staleRun.runId, {
    writeDataDir: stalePolicy.writeDataDir,
    workspaceRegistry: stalePolicy.registry,
    gitRunner: makeGitRunner({ branchSha: stalePolicy.headSha }),
    githubClient: readOnlyGithubClient(makeGitHubClient(stalePolicy.project, stalePolicy.run.branch, stalePolicy.headSha))
  }), "GITHUB_DELIVERY_RECONCILE_EVIDENCE_INVALID")
})

test("read-only delivery reconciliation requires coherent current remote-review evidence", async () => {
  const cases = [
    {
      name: "approved-decision-contradiction",
      metadata: {
        decision: REVIEW_DECISIONS.CHANGES_REQUESTED
      }
    },
    {
      name: "approved-merge-not-allowed",
      metadata: {
        mergeAllowed: false
      }
    },
    {
      name: "approved-with-blockers",
      metadata: {
        blockers: 1
      }
    },
    {
      name: "wrong-reviewed-sha",
      metadata: {
        reviewedSha: "e".repeat(40)
      }
    },
    {
      name: "wrong-policy-hash",
      metadata: {
        policyHash: "f".repeat(64)
      }
    }
  ]

  for (const entry of cases) {
    const fixture = await makeReviewPassedFixture()
    const pr = makePr(fixture.project, fixture.run.branch, fixture.headSha)
    const run = await appendDeliveryProgress(fixture.run, remoteReviewProgressEvidence(fixture.run, pr, "approved", entry.metadata), fixture, REMOTE_PR_REVIEW_AGENT_ID)

    await assertRejectsCode(reconcileGitHubDelivery(run.runId, {
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      gitRunner: makeGitRunner({ branchSha: fixture.headSha }),
      githubClient: readOnlyGithubClient(makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha, {
        prs: [pr]
      }))
    }), "GITHUB_DELIVERY_RECONCILE_REVIEW_EVIDENCE_INVALID")
  }

  const wrongPrNumber = await makeReviewPassedFixture()
  const pr = makePr(wrongPrNumber.project, wrongPrNumber.run.branch, wrongPrNumber.headSha, { number: 1 })
  let run = await appendDeliveryProgress(wrongPrNumber.run, deliveryProgressEvidence(wrongPrNumber.run, "pr_created", {
    branch: wrongPrNumber.run.branch,
    base: "main",
    prNumber: pr.number,
    prHeadSha: wrongPrNumber.run.headSha,
    reconciledAt: "2026-08-21T12:00:01.000Z"
  }), wrongPrNumber)
  run = await appendDeliveryProgress(run, remoteReviewProgressEvidence(run, {
    ...pr,
    number: 2
  }), wrongPrNumber, REMOTE_PR_REVIEW_AGENT_ID)

  await assertRejectsCode(reconcileGitHubDelivery(run.runId, {
    writeDataDir: wrongPrNumber.writeDataDir,
    workspaceRegistry: wrongPrNumber.registry,
    gitRunner: makeGitRunner({ branchSha: wrongPrNumber.headSha }),
    githubClient: readOnlyGithubClient(makeGitHubClient(wrongPrNumber.project, wrongPrNumber.run.branch, wrongPrNumber.headSha, {
      prs: [pr]
    }))
  }), "GITHUB_DELIVERY_RECONCILE_REVIEW_CONFLICT")
})

test("acceptance gate requires exact review_passed state, SHA equality, clean workspace, and no open attempts", async () => {
  const fixture = await makeReviewPassedFixture()

  const accepted = await assertDevelopmentAcceptanceGate(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })

  assert.equal(accepted.deliveryAllowed, true)
  assert.equal(accepted.approvedSha, fixture.headSha)
  assert.equal(accepted.evidence.implementationSha, fixture.headSha)
  assert.equal(accepted.evidence.testedSha, fixture.headSha)
  assert.equal(accepted.evidence.reviewedSha, fixture.headSha)

  await assertRejectsCode(assertDevelopmentAcceptanceGate(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  }), "ACCEPTANCE_EXPECTED_VERSION_REQUIRED")

  const implementationReady = await makeReviewPassedFixture()
  const notReviewPassed = await transitionDevelopmentRun(implementationReady.run.runId, {
    expectedVersion: implementationReady.run.version,
    status: "merge_ready",
    actor: "test"
  }, {
    writeDataDir: implementationReady.writeDataDir,
    now: implementationReady.now
  })

  await assertRejectsCode(assertDevelopmentAcceptanceGate(notReviewPassed.runId, {
    expectedVersion: notReviewPassed.version,
    writeDataDir: implementationReady.writeDataDir,
    workspaceRegistry: implementationReady.registry
  }), "ACCEPTANCE_RUN_NOT_REVIEW_PASSED")

  for (const options of [
    { implementationSha: fixture.baseSha, code: "ACCEPTANCE_IMPLEMENTATION_EVIDENCE_MISMATCH" },
    { testSha: fixture.baseSha, code: "ACCEPTANCE_TEST_EVIDENCE_MISMATCH" },
    { reviewedSha: fixture.baseSha, code: "ACCEPTANCE_REVIEW_EVIDENCE_MISMATCH" },
    { mergeAllowed: false, code: "ACCEPTANCE_REVIEW_EVIDENCE_MISMATCH" },
    { ambiguousTests: true, code: "ACCEPTANCE_TEST_EVIDENCE_MISMATCH" }
  ]) {
    const stale = await makeReviewPassedFixture(options)

    await assertRejectsCode(assertDevelopmentAcceptanceGate(stale.run.runId, {
      expectedVersion: stale.run.version,
      writeDataDir: stale.writeDataDir,
      workspaceRegistry: stale.registry
    }), options.code)
  }

  const dirty = await makeReviewPassedFixture()
  await writeFile(join(dirty.location.workspacePath, "dirty.txt"), "dirty\n", "utf8")
  await assertRejectsCode(assertDevelopmentAcceptanceGate(dirty.run.runId, {
    expectedVersion: dirty.run.version,
    writeDataDir: dirty.writeDataDir,
    workspaceRegistry: dirty.registry
  }), "ACCEPTANCE_WORKSPACE_DIRTY")

  const changed = await makeReviewPassedFixture()
  await writeFile(join(changed.location.workspacePath, "after-review.txt"), "changed\n", "utf8")
  await git(["add", "after-review.txt"], changed.location.workspacePath)
  await git(["commit", "-m", "stale review approval"], changed.location.workspacePath)
  await assertRejectsCode(assertDevelopmentAcceptanceGate(changed.run.runId, {
    expectedVersion: changed.run.version,
    writeDataDir: changed.writeDataDir,
    workspaceRegistry: changed.registry
  }), "ACCEPTANCE_WORKSPACE_MISMATCH")

  const openReview = await makeReviewPassedFixture()
  const openRun = await recordDevelopmentRunProgress(openReview.run.runId, {
    expectedVersion: openReview.run.version,
    status: "review_passed",
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    evidence: [{
      kind: "review",
      sha: openReview.headSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      metadata: {
        project: openReview.project.id,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 2,
        reviewedSha: openReview.headSha,
        outcome: "review_started"
      }
    }]
  }, {
    writeDataDir: openReview.writeDataDir,
    now: openReview.now
  })

  await assertRejectsCode(assertDevelopmentAcceptanceGate(openReview.run.runId, {
    expectedVersion: openRun.version,
    writeDataDir: openReview.writeDataDir,
    workspaceRegistry: openReview.registry
  }), "ACCEPTANCE_REVIEW_EVIDENCE_MISMATCH")

  const hardening = await makeReviewPassedFixture()
  const hardeningRun = await recordDevelopmentRunProgress(hardening.run.runId, {
    expectedVersion: hardening.run.version,
    status: "review_passed",
    actor: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
    evidence: [{
      kind: "review",
      sha: hardening.headSha,
      source: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
      metadata: {
        project: hardening.project.id,
        orchestrator: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
        sourceReviewSha: hardening.headSha,
        outcome: "owner_action_required",
        reason: "max_hardening_rounds_exhausted"
      }
    }]
  }, {
    writeDataDir: hardening.writeDataDir,
    now: hardening.now
  })

  await assertRejectsCode(assertDevelopmentAcceptanceGate(hardening.run.runId, {
    expectedVersion: hardeningRun.version,
    writeDataDir: hardening.writeDataDir,
    workspaceRegistry: hardening.registry
  }), "ACCEPTANCE_HARDENING_NOT_CONVERGED")
})

test("push gate uses exact approved SHA, fixed origin identity, no force, and safe ambiguity reconciliation", async () => {
  const fixture = await makeReviewPassedFixture()
  const acceptance = await assertDevelopmentAcceptanceGate(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })
  const gitRunner = makeGitRunner()
  const result = await pushApprovedBranch(acceptance, { gitRunner })

  assert.equal(result.remoteBranchSha, fixture.headSha)
  assert.equal(gitRunner.state.pushCalls.length, 1)
  assert.deepEqual(gitRunner.state.pushCalls[0].slice(2), [
    "push",
    "origin",
    `${fixture.headSha}:refs/heads/${fixture.run.branch}`,
    "--porcelain"
  ])
  assert.equal(gitRunner.state.pushCalls[0].some((entry) => entry.startsWith("+")), false)

  const idempotentRunner = makeGitRunner({ branchSha: fixture.headSha })
  const idempotent = await pushApprovedBranch(acceptance, { gitRunner: idempotentRunner })

  assert.equal(idempotent.outcome, "branch_already_exact")
  assert.equal(idempotentRunner.state.pushCalls.length, 0)

  const unexpectedRunner = makeGitRunner({ branchSha: "f".repeat(40) })
  await assertRejectsCode(pushApprovedBranch(acceptance, {
    gitRunner: unexpectedRunner
  }), "GITHUB_DELIVERY_REMOTE_BRANCH_UNEXPECTED")

  const recoveredRunner = makeGitRunner({ pushMode: "ambiguous-recovered" })
  const recovered = await pushApprovedBranch(acceptance, {
    gitRunner: recoveredRunner
  })

  assert.equal(recovered.outcome, "branch_push_recovered")
  assert.equal(recoveredRunner.state.pushCalls.length, 1)

  const retryRunner = makeGitRunner({ pushMode: "ambiguous-absent-retry" })
  const retried = await pushApprovedBranch(acceptance, {
    gitRunner: retryRunner
  })

  assert.equal(retried.outcome, "branch_push_safe_retry")
  assert.equal(retryRunner.state.pushCalls.length, 2)

  const badRemote = await makeReviewPassedFixture()
  await git(["remote", "set-url", "origin", "git@github.com:Linardi1328/wrong.git"], badRemote.location.workspacePath)
  await assertRejectsCode(assertDevelopmentAcceptanceGate(badRemote.run.runId, {
    expectedVersion: badRemote.run.version,
    writeDataDir: badRemote.writeDataDir,
    workspaceRegistry: badRemote.registry
  }), "ACCEPTANCE_WORKSPACE_MISMATCH")
})

test("PR reconciliation and exact-head CI reject duplicate, stale, pending, failed, and wrong-head states", async () => {
  const fixture = await makeReviewPassedFixture()
  const acceptance = await assertDevelopmentAcceptanceGate(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })
  const client = makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha)

  const created = await createOrReconcileApprovedPullRequest(acceptance, {
    githubClient: client
  })

  assert.equal(created.outcome, "pr_created")
  assert.equal(client.state.created[0].base, "main")
  assert.equal(client.state.created[0].branch, fixture.run.branch)
  assert.match(client.state.created[0].title, new RegExp(fixture.headSha.slice(0, 12), "u"))
  assert.doesNotMatch(client.state.created[0].body, /token|secret|stdout|stderr|SENSITIVE_TEST_SENTINEL/iu)

  const reused = await createOrReconcileApprovedPullRequest(acceptance, {
    githubClient: client
  })

  assert.equal(reused.outcome, "pr_reused")
  assert.equal(client.state.prs.length, 1)

  const duplicateClient = makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha, {
    prs: [
      makePr(fixture.project, fixture.run.branch, fixture.headSha, { number: 1 }),
      makePr(fixture.project, fixture.run.branch, fixture.headSha, { number: 2 })
    ]
  })
  await assertRejectsCode(createOrReconcileApprovedPullRequest(acceptance, {
    githubClient: duplicateClient
  }), "GITHUB_DELIVERY_PR_AMBIGUOUS")

  const ambiguousClient = makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha, {
    createAmbiguous: true
  })
  const recovered = await createOrReconcileApprovedPullRequest(acceptance, {
    githubClient: ambiguousClient
  })

  assert.equal(recovered.outcome, "pr_create_recovered")
  assert.equal(ambiguousClient.state.prs.length, 1)

  client.state.prs[0].headSha = fixture.baseSha
  await assertRejectsCode(reconcileRemotePullRequestHead(acceptance, 1, {
    githubClient: client
  }), "GITHUB_DELIVERY_PR_HEAD_MISMATCH")
  client.state.prs[0].headSha = fixture.headSha

  const ciPass = await requireExactHeadCi(acceptance, client.state.prs[0], {
    githubClient: client
  })
  assert.equal(ciPass.outcome, "ci_passed")
  assert.equal(ciPass.headSha, fixture.headSha)

  for (const [runs, jobs, code] of [
    [[successRun(fixture.baseSha)], successJobs(), "GITHUB_DELIVERY_CI_OLDER_SHA_REJECTED"],
    [[successRun(fixture.headSha, { status: "in_progress", conclusion: null })], successJobs(), "GITHUB_DELIVERY_CI_PENDING"],
    [[successRun(fixture.headSha, { conclusion: "failure" })], successJobs(), "GITHUB_DELIVERY_CI_FAILED"],
    [[successRun(fixture.headSha)], [{ ...successJobs()[0], steps: successJobs()[0].steps.slice(0, 3) }], "GITHUB_DELIVERY_CI_FAILED"]
  ]) {
    const ciClient = makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha, {
      prs: [makePr(fixture.project, fixture.run.branch, fixture.headSha)],
      runs,
      jobs
    })

    await assertRejectsCode(requireExactHeadCi(acceptance, ciClient.state.prs[0], {
      githubClient: ciClient
    }), code)
  }
})

test("remote PR review is exact-head, sandboxed, structured, and can re-enter hardening on changes requested", async () => {
  const fixture = await makeReviewPassedFixture()
  const pr = makePr(fixture.project, fixture.run.branch, fixture.headSha)
  const ci = {
    outcome: "ci_passed",
    workflowName: "PPO PR validation",
    workflowRunId: 100,
    workflowConclusion: "success",
    headSha: fixture.headSha,
    requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length
  }
  const calls = []
  const approved = await executeRemotePrReview(fixture.run, pr, ci, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner((invocation) => reviewerDecision(invocation.reviewedSha), { calls }),
    now: fixture.now
  })

  assert.equal(approved.ok, true)
  assert.equal(approved.run.status, "review_passed")
  assert.equal(approved.review.reviewedSha, fixture.headSha)
  assert.equal(calls.filter((call) => call.kind === "review").length, 1)
  assert.deepEqual(calls.map((call) => call.probe || call.kind), [
    "local-process",
    "workspace-read",
    "workspace-file-write",
    "source-file-write",
    "workspace-git-mutation",
    "direct-network",
    "review"
  ])
  const reviewCall = calls.find((call) => call.kind === "review")
  assert.match(reviewCall.prompt, /PPO Phase 6G independent exact-head remote PR review/u)
  assert.match(reviewCall.prompt, new RegExp(fixture.headSha, "u"))
  assert.doesNotMatch(reviewCall.prompt, /SENSITIVE_TEST_SENTINEL|github_pat_|gho_|raw CI logs|stdout:|stderr:/iu)
  assert.equal(reviewCall.readOnlyPaths.includes(fixture.location.workspacePath), true)
  assert.equal(reviewCall.readOnlyPaths.includes(fixture.sourceRepoPath), true)
  assert.equal(latestRemoteReviewEntry(approved.run, "remote_review_started").metadata.attempt, 1)
  assert.equal(latestRemoteReviewEntry(approved.run, "approved").metadata.attempt, 1)

  const secondApproved = await executeRemotePrReview(approved.run, pr, ci, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner((invocation) => reviewerDecision(invocation.reviewedSha)),
    now: fixture.now
  })

  assert.equal(secondApproved.ok, true)
  assert.equal(latestRemoteReviewEntry(secondApproved.run, "remote_review_started").metadata.attempt, 2)
  assert.equal(latestRemoteReviewEntry(secondApproved.run, "approved").metadata.attempt, 2)

  const changes = await makeReviewPassedFixture()
  const changesPr = makePr(changes.project, changes.run.branch, changes.headSha)
  const requested = await executeRemotePrReview(changes.run, changesPr, {
    ...ci,
    headSha: changes.headSha
  }, {
    writeDataDir: changes.writeDataDir,
    workspaceRegistry: changes.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner((invocation) => reviewerDecision(invocation.reviewedSha, {
      decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
      mergeAllowed: false,
      blockers: ["Remote PR head misses validation coverage."],
      securityFindings: ["Remote PR review found a bounded security issue."],
      summary: "Changes requested."
    })),
    now: changes.now
  })

  assert.equal(requested.ok, false)
  assert.equal(requested.run.status, "review_changes_requested")
  assert.equal(latestRemoteReviewEntry(requested.run, "remote_review_started").metadata.attempt, 1)
  assert.equal(latestRemoteReviewEntry(requested.run, "review_findings").metadata.attempt, 1)
  assert.equal(latestRemoteReviewEntry(requested.run, "changes_requested").metadata.attempt, 1)
  assert.equal(latestRemoteReviewEntry(requested.run, "changes_requested").metadata.mergeAllowed, false)

  await assertRejectsCode(executeBoundedHardening(changes.run.runId, {
    expectedVersion: requested.run.version,
    writeDataDir: changes.writeDataDir,
    workspaceRegistry: changes.registry,
    now: changes.now
  }), "CODEX_CONFIG_REQUIRED")

  const hardeningRun = await readDevelopmentRun(changes.run.runId, {
    writeDataDir: changes.writeDataDir
  })
  const hardeningStarted = hardeningRun.evidence.implementation.findLast((entry) => (
    entry.source === PHASE_6F_HARDENING_ORCHESTRATOR_ID &&
    entry.metadata?.outcome === "hardening_started"
  ))
  assert.equal(hardeningRun.status, "implementation_in_progress")
  assert.equal(hardeningStarted.metadata.reviewAttempt, 1)
  assert.equal(hardeningStarted.metadata.reviewer, REMOTE_PR_REVIEW_AGENT_ID)

  const remediationPrompt = buildCodexImplementationPrompt(hardeningRun, changes.location)
  assert.match(remediationPrompt, /Remote PR head misses validation coverage\./u)
  assert.match(remediationPrompt, /Remote PR review found a bounded security issue\./u)

  const malformed = await makeReviewPassedFixture()
  await assertRejectsCode(executeRemotePrReview(malformed.run, makePr(malformed.project, malformed.run.branch, malformed.headSha), {
    ...ci,
    headSha: malformed.headSha
  }, {
    writeDataDir: malformed.writeDataDir,
    workspaceRegistry: malformed.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(null, { rawReviewResult: { exitCode: 0, stdout: "not json" } }),
    now: malformed.now
  }), "GITHUB_DELIVERY_REMOTE_REVIEW_FAILED")

  const malformedReloaded = await readDevelopmentRun(malformed.run.runId, {
    writeDataDir: malformed.writeDataDir
  })
  assert.equal(malformedReloaded.status, "review_changes_requested")
  assert.equal(malformedReloaded.evidence.review.at(-1).metadata.decision, REVIEW_DECISIONS.OWNER_ACTION_REQUIRED)
  assert.equal(malformedReloaded.evidence.review.at(-1).metadata.attempt, 1)

  const openAttempt = await makeReviewPassedFixture()
  const openAttemptRun = await recordDevelopmentRunProgress(openAttempt.run.runId, {
    expectedVersion: openAttempt.run.version,
    status: "review_passed",
    actor: REMOTE_PR_REVIEW_AGENT_ID,
    reason: "test-open-remote-review-attempt",
    evidence: [{
      kind: "review",
      sha: openAttempt.headSha,
      source: REMOTE_PR_REVIEW_AGENT_ID,
      summary: "Open remote PR review attempt should block retry.",
      metadata: {
        project: openAttempt.project.id,
        reviewer: REMOTE_PR_REVIEW_AGENT_ID,
        attempt: 1,
        prNumber: 1,
        branch: openAttempt.run.branch,
        reviewedSha: openAttempt.headSha,
        promptHash: "f".repeat(64),
        outcome: "remote_review_started"
      }
    }]
  }, {
    writeDataDir: openAttempt.writeDataDir,
    now: openAttempt.now
  })

  await assertRejectsCode(executeRemotePrReview(openAttemptRun, makePr(openAttempt.project, openAttempt.run.branch, openAttempt.headSha), {
    ...ci,
    headSha: openAttempt.headSha
  }, {
    writeDataDir: openAttempt.writeDataDir,
    workspaceRegistry: openAttempt.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: openAttempt.now
  }), "GITHUB_DELIVERY_REMOTE_REVIEW_RECONCILIATION_REQUIRED")

  for (const invalidAttempt of [undefined, 0, "1"]) {
    const invalid = await makeReviewPassedFixture()
    const metadata = {
      project: invalid.project.id,
      reviewer: REMOTE_PR_REVIEW_AGENT_ID,
      prNumber: 1,
      branch: invalid.run.branch,
      reviewedSha: invalid.headSha,
      decision: REVIEW_DECISIONS.APPROVED,
      mergeAllowed: true,
      blockers: 0,
      securityFindings: 0,
      testsRequired: 0,
      summaryHash: "a".repeat(64),
      outcome: "approved"
    }

    if (invalidAttempt !== undefined) {
      metadata.attempt = invalidAttempt
    }

    const invalidRun = await recordDevelopmentRunProgress(invalid.run.runId, {
      expectedVersion: invalid.run.version,
      status: "review_passed",
      actor: REMOTE_PR_REVIEW_AGENT_ID,
      reason: "test-invalid-remote-review-attempt",
      evidence: [{
        kind: "review",
        sha: invalid.headSha,
        source: REMOTE_PR_REVIEW_AGENT_ID,
        summary: "Invalid remote PR review attempt should block retry.",
        metadata
      }]
    }, {
      writeDataDir: invalid.writeDataDir,
      now: invalid.now
    })

    await assertRejectsCode(executeRemotePrReview(invalidRun, makePr(invalid.project, invalid.run.branch, invalid.headSha), {
      ...ci,
      headSha: invalid.headSha
    }, {
      writeDataDir: invalid.writeDataDir,
      workspaceRegistry: invalid.registry,
      reviewConfig: trustedReviewConfig(),
      reviewRunner: makeReviewRunner(),
      now: invalid.now
    }), "GITHUB_DELIVERY_REMOTE_REVIEW_ATTEMPT_INVALID")
  }
})

test("delivery reaches merge_ready only after push, PR, exact-head CI, remote approval, and persisted metadata-only evidence", async () => {
  const fixture = await makeReviewPassedFixture()
  const gitRunner = makeGitRunner()
  const githubClient = makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha)
  const calls = []
  const result = await executeGitHubDeliveryToMergeReady(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    gitRunner,
    githubClient,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner((invocation) => reviewerDecision(invocation.reviewedSha), { calls }),
    now: fixture.now
  })

  assert.equal(result.run.status, "merge_ready")
  assert.equal(result.run.headSha, fixture.headSha)
  assert.equal(result.pr.headSha, fixture.headSha)
  assert.equal(result.ci.outcome, "ci_passed")
  assert.equal(githubClient.state.created.length, 1)
  assert.equal(gitRunner.state.branchSha, fixture.headSha)
  assert.equal(calls.filter((call) => call.kind === "review").length, 1)

  const evidenceText = JSON.stringify(result.run.evidence)
  assert.match(evidenceText, new RegExp(fixture.headSha, "u"))
  assert.doesNotMatch(evidenceText, /github_pat_|gho_|authorization|credential|raw|stdout|stderr|SENSITIVE_TEST_SENTINEL/iu)

  const mergeReadyEvidence = result.run.evidence.merge.at(-1)
  assert.equal(mergeReadyEvidence.metadata.outcome, "merge_ready")
  assert.equal(mergeReadyEvidence.metadata.prHeadSha, fixture.headSha)
  assert.equal(mergeReadyEvidence.metadata.remoteReviewedSha, fixture.headSha)
})

test("SHA-pinned merge requires merge_ready, exact current head, mergeability, expected SHA, and verifies merge commit/main", async () => {
  const fixture = await makeReviewPassedFixture()
  const githubClient = makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha)
  const delivered = await executeGitHubDeliveryToMergeReady(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    gitRunner: makeGitRunner(),
    githubClient,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: fixture.now
  })
  const merged = await executeShaPinnedMerge(fixture.run.runId, {
    expectedVersion: delivered.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    githubClient,
    now: fixture.now
  })

  assert.equal(merged.run.status, "merged")
  assert.equal(merged.merge.implementationSha, fixture.headSha)
  assert.equal(merged.merge.mergeCommitSha, MERGE_SHA)
  assert.equal(merged.merge.mainSha, MAIN_SHA)
  assert.equal(githubClient.state.mergeCalls.length, 1)
  assert.deepEqual(githubClient.state.mergeCalls[0], {
    prNumber: 1,
    expectedHeadSha: fixture.headSha,
    method: PHASE_6G_APPROVED_MERGE_METHOD
  })

  const headMoved = await makeReviewPassedFixture()
  const movedClient = makeGitHubClient(headMoved.project, headMoved.run.branch, headMoved.headSha)
  const movedDelivered = await executeGitHubDeliveryToMergeReady(headMoved.run.runId, {
    expectedVersion: headMoved.run.version,
    writeDataDir: headMoved.writeDataDir,
    workspaceRegistry: headMoved.registry,
    gitRunner: makeGitRunner(),
    githubClient: movedClient,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: headMoved.now
  })
  movedClient.state.prs[0].headSha = "f".repeat(40)
  await assertRejectsCode(executeShaPinnedMerge(headMoved.run.runId, {
    expectedVersion: movedDelivered.run.version,
    writeDataDir: headMoved.writeDataDir,
    workspaceRegistry: headMoved.registry,
    githubClient: movedClient
  }), "GITHUB_DELIVERY_PR_HEAD_MISMATCH")

  const blocked = await makeReviewPassedFixture()
  const blockedClient = makeGitHubClient(blocked.project, blocked.run.branch, blocked.headSha)
  const blockedDelivered = await executeGitHubDeliveryToMergeReady(blocked.run.runId, {
    expectedVersion: blocked.run.version,
    writeDataDir: blocked.writeDataDir,
    workspaceRegistry: blocked.registry,
    gitRunner: makeGitRunner(),
    githubClient: blockedClient,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: blocked.now
  })
  blockedClient.state.prs[0].mergeable = false
  await assertRejectsCode(executeShaPinnedMerge(blocked.run.runId, {
    expectedVersion: blockedDelivered.run.version,
    writeDataDir: blocked.writeDataDir,
    workspaceRegistry: blocked.registry,
    githubClient: blockedClient
  }), "GITHUB_DELIVERY_PR_NOT_MERGEABLE")
})

test("SHA-pinned merge recovers a successful remote merge after process crash without a duplicate merge", async () => {
  const fixture = await makeMergeStartedCrashFixture()

  assert.equal(fixture.githubClient.state.prs[0].state, "closed")
  assert.equal(fixture.githubClient.state.prs[0].merged, true)
  assert.equal(fixture.githubClient.state.prs[0].headSha, fixture.headSha)
  assert.equal(fixture.githubClient.state.prs[0].mergeCommitSha, MERGE_SHA)
  assert.equal(fixture.githubClient.state.mainSha, MERGE_SHA)

  const recovered = await executeShaPinnedMerge(fixture.run.runId, {
    expectedVersion: fixture.withStarted.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    githubClient: fixture.githubClient,
    now: fixture.now
  })

  assert.equal(fixture.githubClient.state.mergeCalls.length, 1)
  assert.equal(recovered.run.status, "merged")
  assert.equal(recovered.merge.implementationSha, fixture.headSha)
  assert.equal(recovered.merge.mergeCommitSha, MERGE_SHA)
  assert.equal(recovered.merge.mainSha, MERGE_SHA)
  assert.equal(recovered.run.evidence.merge.at(-1).metadata.expectedHeadSha, fixture.headSha)
  assert.equal(recovered.run.evidence.merge.at(-1).metadata.mergeCommitSha, MERGE_SHA)
  assert.equal(recovered.run.evidence.merge.at(-1).metadata.mainSha, MERGE_SHA)
})

test("SHA-pinned merge recovery fails closed for conflicting remote state after merge_started", async () => {
  const cases = [
    {
      name: "PR closed but not merged",
      mutate({ pr }) {
        pr.state = "closed"
        pr.merged = false
        pr.mergeCommitSha = null
      }
    },
    {
      name: "merged PR has wrong head SHA",
      mutate({ pr }) {
        pr.headSha = "e".repeat(40)
      }
    },
    {
      name: "wrong PR branch",
      mutate({ pr }) {
        pr.headRef = "phase/unexpected"
      }
    },
    {
      name: "wrong PR base",
      mutate({ pr }) {
        pr.baseRef = "develop"
      }
    },
    {
      name: "wrong PR repository",
      mutate({ pr }) {
        pr.baseRepoFullName = "Linardi1328/unexpected"
      }
    },
    {
      name: "missing merge commit SHA",
      mutate({ pr }) {
        pr.mergeCommitSha = null
      }
    },
    {
      name: "main does not equal merge commit",
      mutate({ client }) {
        client.state.mainSha = "e".repeat(40)
      }
    }
  ]

  for (const entry of cases) {
    const fixture = await makeMergeStartedCrashFixture()
    entry.mutate({
      client: fixture.githubClient,
      pr: fixture.githubClient.state.prs[0]
    })

    await assertRejectsCode(executeShaPinnedMerge(fixture.run.runId, {
      expectedVersion: fixture.withStarted.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      githubClient: fixture.githubClient,
      now: fixture.now
    }), "GITHUB_DELIVERY_MERGE_RECONCILE_CONFLICT")

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })
    assert.equal(fixture.githubClient.state.mergeCalls.length, 1, entry.name)
    assert.equal(reloaded.status, "merge_ready", entry.name)
    assert.equal(reloaded.evidence.merge.at(-1).metadata.outcome, "merge_started", entry.name)
  }
})

test("ambiguous merge is reconciled before retry and duplicate merge attempts are prevented", async () => {
  const fixture = await makeReviewPassedFixture()
  const ambiguousClient = makeGitHubClient(fixture.project, fixture.run.branch, fixture.headSha, {
    mergeAmbiguous: true
  })
  const result = await executePhase6GDelivery(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    gitRunner: makeGitRunner(),
    githubClient: ambiguousClient,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: fixture.now
  })

  assert.equal(result.run.status, "merged")
  assert.equal(result.merge.mergeCommitSha, MERGE_SHA)
  assert.equal(ambiguousClient.state.mergeCalls.length, 1)

  const unresolved = await makeReviewPassedFixture()
  const unresolvedClient = makeGitHubClient(unresolved.project, unresolved.run.branch, unresolved.headSha, {
    mergeAmbiguous: true,
    mergeAmbiguousWithoutRemote: true
  })
  const delivered = await executeGitHubDeliveryToMergeReady(unresolved.run.runId, {
    expectedVersion: unresolved.run.version,
    writeDataDir: unresolved.writeDataDir,
    workspaceRegistry: unresolved.registry,
    gitRunner: makeGitRunner(),
    githubClient: unresolvedClient,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: unresolved.now
  })

  await assertRejectsCode(executeShaPinnedMerge(unresolved.run.runId, {
    expectedVersion: delivered.run.version,
    writeDataDir: unresolved.writeDataDir,
    workspaceRegistry: unresolved.registry,
    githubClient: unresolvedClient,
    now: unresolved.now
  }), "GITHUB_DELIVERY_MERGE_RECONCILE_CONFLICT")

  const withStarted = await readDevelopmentRun(unresolved.run.runId, {
    writeDataDir: unresolved.writeDataDir
  })
  assert.equal(withStarted.status, "merge_ready")
  assert.equal(withStarted.evidence.merge.at(-1).metadata.outcome, "merge_started")

  await assertRejectsCode(executeShaPinnedMerge(unresolved.run.runId, {
    expectedVersion: withStarted.version,
    writeDataDir: unresolved.writeDataDir,
    workspaceRegistry: unresolved.registry,
    githubClient: unresolvedClient,
    now: unresolved.now
  }), "GITHUB_DELIVERY_MERGE_RECONCILE_CONFLICT")
  assert.equal(unresolvedClient.state.mergeCalls.length, 1)
})

test("Phase 6G exposes no command route, deployment action, or broad GitHub write surface", async () => {
  const commandSource = await readFile(new URL("ppo-command.mjs", import.meta.url), "utf8")
  const bridgeSource = await readFile(new URL("../openclaw/plugins/ppo-local/bridge.mjs", import.meta.url), "utf8")
  const moduleSource = await readFile(new URL("github-delivery-agent.mjs", import.meta.url), "utf8")

  assert.equal(commandSource.includes("github-delivery-agent"), false)
  assert.equal(bridgeSource.includes("github-delivery-agent"), false)

  for (const forbidden of [
    "/issues",
    "/labels",
    "/releases",
    "workflow_dispatch",
    "deleteRef",
    "branch protection",
    "force",
    "systemctl",
    "deploy_in_progress",
    "verification_in_progress",
    "/ppo continue"
  ]) {
    assert.equal(moduleSource.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden)
  }

  assert.match(moduleSource, /merge_method/)
  assert.match(moduleSource, /sha=\$\{normalizeSha\(expectedHeadSha/)
  assert.match(moduleSource, /GITHUB_DELIVERY_AGENT_ID/)
})
