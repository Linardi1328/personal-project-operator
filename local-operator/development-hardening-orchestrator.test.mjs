import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
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
  prepareImplementationWorkspace,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  CODEX_SANDBOX_BACKENDS,
  PHASE_6F_HARDENING_ORCHESTRATOR_ID,
  buildCodexImplementationPrompt,
  executeCodexImplementation
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  TEST_SANDBOX_BACKENDS,
  executeAutomatedTests
} from "./development-test-runner.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS,
  REVIEW_FINDINGS_EVIDENCE_OUTCOME,
  REVIEW_SANDBOX_BACKENDS,
  executeIndependentReview
} from "./development-review-agent.mjs"
import {
  HARDENING_ORCHESTRATOR_ID,
  MAX_HARDENING_ROUNDS,
  executeBoundedHardening,
  reconcileBoundedHardening
} from "./development-hardening-orchestrator.mjs"

const execFileAsync = promisify(execFile)
const TRUSTED_GIT_EXECUTABLE = process.env.PPO_TEST_GIT_EXECUTABLE || "/usr/bin/git"
const TRUSTED_MACOS_SANDBOX_EXECUTABLE = process.env.PPO_TEST_SANDBOX_EXECUTABLE || "/usr/bin/sandbox-exec"

function makeClock() {
  let tick = 0
  const start = Date.parse("2026-08-21T12:00:00.000Z")

  return () => {
    const next = new Date(start + tick * 1000)
    tick += 1
    return next
  }
}

async function canonicalTempRoot(label = "ppo-6f-hardening-") {
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

  const baseSha = await git(["rev-parse", "HEAD"], sourceRepoPath)

  return {
    root,
    project,
    sourceRepoPath,
    workspaceRoot,
    writeDataDir,
    baseSha,
    registry: {
      [project.id]: {
        sourceRepoPath,
        workspaceRoot
      }
    }
  }
}

async function makePlannedRun(fixture, options = {}) {
  const now = options.now || makeClock()
  const created = await createDevelopmentRun({
    projectId: fixture.project.id,
    task: options.task || "Implement provider validation without changing credentials.",
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

  return {
    now,
    run: planned
  }
}

function trustedCodexConfig(overrides = {}) {
  return {
    executablePath: process.execPath,
    gitExecutablePath: TRUSTED_GIT_EXECUTABLE,
    args: ["--version"],
    timeoutMs: 2000,
    env: {},
    remoteGitWritePolicy: {
      mode: "deny",
      enforcement: "adapter-git-wrapper"
    },
    executionSandbox: {
      type: CODEX_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
      platform: "darwin",
      network: "none",
      enforcement: "os-process",
      executablePath: TRUSTED_MACOS_SANDBOX_EXECUTABLE
    },
    ...overrides
  }
}

function trustedTestPolicyRegistry(fixture, overrides = {}) {
  return {
    [fixture.project.id]: {
      policyId: "phase-6e-local-node-policy",
      policyVersion: "1",
      trustedExecutablePaths: [process.execPath],
      env: {
        PPO_SAFE_TEST_FLAG: "1"
      },
      sandbox: {
        type: TEST_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
        platform: "darwin",
        network: "none",
        enforcement: "os-process",
        executablePath: TRUSTED_MACOS_SANDBOX_EXECUTABLE
      },
      steps: [{
        id: "unit",
        executablePath: process.execPath,
        args: ["--eval", "process.exit(0)"],
        timeoutMs: 2000,
        maxOutputBytes: 2048
      }],
      ...overrides
    }
  }
}

function trustedReviewConfig(overrides = {}) {
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
      executablePath: TRUSTED_MACOS_SANDBOX_EXECUTABLE
    },
    ...overrides
  }
}

function decision(reviewedSha, overrides = {}) {
  return {
    decision: REVIEW_DECISIONS.APPROVED,
    reviewedSha,
    mergeAllowed: true,
    blockers: [],
    securityFindings: [],
    testsRequired: [],
    summary: "Exact SHA review approved.",
    ...overrides
  }
}

function changesRequestedDecision(reviewedSha, overrides = {}) {
  return decision(reviewedSha, {
    decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
    mergeAllowed: false,
    blockers: ["Provider validation regression is missing."],
    securityFindings: [],
    testsRequired: ["Add focused validation regression coverage."],
    summary: "Changes are required before approval.",
    ...overrides
  })
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex")
}

function hardeningReviewFindingHash({ reviewedSha, blockers, securityFindings, testsRequired }) {
  return sha256Text(stableStringify({
    reviewedSha,
    decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
    blockers,
    securityFindings,
    testsRequired
  }))
}

function reviewFindingEvidence(run, {
  source,
  reviewer = source,
  attempt = 1,
  blockers = ["Provider validation regression is missing."],
  securityFindings = [],
  testsRequired = ["Add focused validation regression coverage."]
}) {
  const findingHash = hardeningReviewFindingHash({
    reviewedSha: run.headSha,
    blockers,
    securityFindings,
    testsRequired
  })

  return {
    kind: "review",
    sha: run.headSha,
    source,
    summary: "Synthetic review findings for hardening validation.",
    metadata: {
      project: run.project.id,
      reviewer,
      attempt,
      reviewedSha: run.headSha,
      decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
      mergeAllowed: false,
      blockers: blockers.length,
      securityFindings: securityFindings.length,
      testsRequired: testsRequired.length,
      blockerItems: blockers,
      securityItems: securityFindings,
      testItems: testsRequired,
      findingHash,
      outcome: REVIEW_FINDINGS_EVIDENCE_OUTCOME
    }
  }
}

function reviewDecisionEvidence(run, {
  source,
  reviewer = source,
  attempt = 1,
  blockers = ["Provider validation regression is missing."],
  securityFindings = [],
  testsRequired = ["Add focused validation regression coverage."]
}) {
  return {
    kind: "review",
    sha: run.headSha,
    source,
    summary: "Synthetic review decision for hardening validation.",
    metadata: {
      project: run.project.id,
      reviewer,
      attempt,
      reviewedSha: run.headSha,
      decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
      mergeAllowed: false,
      blockers: blockers.length,
      securityFindings: securityFindings.length,
      testsRequired: testsRequired.length,
      summaryHash: "d".repeat(64),
      outcome: "changes_requested"
    }
  }
}

function sandboxProbeResult(invocation, options = {}) {
  if (options.unavailable) {
    throw new Error("sandbox unavailable")
  }

  if (invocation.probe === "linux-privilege-boundary") {
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  if (invocation.probe === "local-process" || invocation.probe === "local-workspace-git" || invocation.probe === "workspace-read") {
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  if (
    invocation.probe === "workspace-file-write" ||
    invocation.probe === "source-file-write" ||
    invocation.probe === "workspace-git-mutation"
  ) {
    return { exitCode: 0, sandboxDenied: true, stdout: "", stderr: "" }
  }

  if (invocation.probe === "direct-network") {
    if (options.networkInactive) {
      return { exitCode: 66, stdout: "connected", stderr: "" }
    }

    return { exitCode: 0, sandboxDenied: true, stdout: "", stderr: "" }
  }

  if (
    invocation.probe === "direct-ssh-transport" ||
    invocation.probe === "absolute-git-sanitized-env-push" ||
    invocation.probe === "ordinary-git-push"
  ) {
    return { exitCode: 1, sandboxDenied: true, stdout: "", stderr: "" }
  }

  return { exitCode: 1, stdout: "", stderr: "" }
}

function makeCombinedSandboxRunner({
  codexRunner = async () => ({ exitCode: 0 }),
  testRunner = async () => ({ exitCode: 0 }),
  calls = [],
  unavailable = false,
  networkInactive = false
} = {}) {
  return async (invocation) => {
    calls.push({
      ...invocation,
      args: [...invocation.args],
      env: { ...invocation.env },
      sandboxArgs: [...invocation.sandboxArgs]
    })
    assert.equal(invocation.shell, false)
    assert.equal(invocation.sandbox.network, "none")
    assert.equal(invocation.sandboxCommand.executablePath, invocation.sandboxExecutablePath)
    assert.deepEqual(invocation.sandboxCommand.args, invocation.sandboxArgs)

    if (invocation.kind === "sandbox-probe") {
      return sandboxProbeResult(invocation, { unavailable, networkInactive })
    }

    if (invocation.kind === "codex") {
      return await codexRunner(invocation)
    }

    if (invocation.kind === "test") {
      return await testRunner(invocation)
    }

    throw new Error(`unexpected sandbox invocation: ${invocation.kind}`)
  }
}

function makeReviewRunner(reviewRunner = async (invocation) => ({
  exitCode: 0,
  stdout: `${JSON.stringify(decision(invocation.reviewedSha))}\n`,
  stderr: "ignored stderr"
}), options = {}) {
  const calls = options.calls || []

  return async (invocation) => {
    const reviewedSha = invocation.kind === "review"
      ? await git(["rev-parse", "HEAD"], invocation.cwd)
      : null
    calls.push({
      ...invocation,
      reviewedSha,
      args: [...invocation.args],
      env: { ...invocation.env },
      sandboxArgs: [...invocation.sandboxArgs]
    })
    assert.equal(invocation.shell, false)
    assert.equal(invocation.sandbox.network, "none")
    assert.equal(invocation.sandbox.readOnlyWorkspace, true)
    assert.equal(invocation.sandboxCommand.executablePath, invocation.sandboxExecutablePath)
    assert.deepEqual(invocation.sandboxCommand.args, invocation.sandboxArgs)

    if (invocation.kind === "sandbox-probe") {
      return sandboxProbeResult(invocation, options)
    }

    if (invocation.kind !== "review") {
      throw new Error(`unexpected review invocation: ${invocation.kind}`)
    }

    return await reviewRunner({
      ...invocation,
      reviewedSha
    })
  }
}

function makeCommitRunner(calls, options = {}) {
  return async (invocation) => {
    calls.push({ ...invocation })
    const index = calls.length
    const fileName = options.fileName || `implementation-${index}.txt`

    await writeFile(join(invocation.cwd, fileName), options.content || `implemented ${index}\n`, "utf8")
    await git(["add", fileName], invocation.cwd)
    await git(["commit", "-m", options.message || `codex implementation ${index}`], invocation.cwd)

    return {
      exitCode: 0,
      stdout: "SENSITIVE_TEST_SENTINEL gho_fake_token",
      stderr: "raw stderr ignored"
    }
  }
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

async function makePreparedFixture(options = {}) {
  const fixture = await makeSourceRepo(options)
  const planned = await makePlannedRun(fixture, options)
  const prepared = await prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    now: planned.now
  })
  const location = await resolveImplementationWorkspaceLocation(prepared.run, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })

  return {
    ...fixture,
    now: planned.now,
    run: prepared.run,
    location
  }
}

async function makeReviewChangesRequestedFixture(options = {}) {
  const fixture = await makePreparedFixture(options)
  const initialCodexCalls = []
  const initialSandboxCalls = []
  const initialImplementation = await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    sandboxRunner: makeCombinedSandboxRunner({
      calls: initialSandboxCalls,
      codexRunner: makeCommitRunner(initialCodexCalls, {
        fileName: "initial-implementation.txt",
        message: "initial implementation"
      })
    }),
    now: fixture.now
  })
  const initialTestCalls = []
  const tested = await executeAutomatedTests(fixture.run.runId, {
    expectedVersion: initialImplementation.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeCombinedSandboxRunner({ calls: initialTestCalls }),
    now: fixture.now
  })
  const initialReviewCalls = []
  const reviewed = await executeIndependentReview(fixture.run.runId, {
    expectedVersion: tested.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async (invocation) => ({
      exitCode: 0,
      stdout: `${JSON.stringify(changesRequestedDecision(invocation.reviewedSha, options.reviewDecision || {}))}\n`,
      stderr: "ignored stderr"
    }), { calls: initialReviewCalls }),
    now: fixture.now
  })

  return {
    ...fixture,
    run: reviewed.run,
    initialImplementationSha: initialImplementation.run.headSha,
    initialTestCalls,
    initialReviewCalls
  }
}

async function appendReviewEvidence(run, fixture, evidence) {
  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "review_changes_requested",
    actor: "test-review-evidence",
    reason: "test-review-evidence-binding",
    evidence
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
}

async function assertHardeningStartsFromEvidence(run, fixture, reviewer, expectedText, unexpectedText = null) {
  await assertRejectsCode(executeBoundedHardening(run.runId, {
    expectedVersion: run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    now: fixture.now
  }), "CODEX_CONFIG_REQUIRED")

  const reloaded = await readDevelopmentRun(run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  const started = latestHardeningEvidence(reloaded, "hardening_started")

  assert.equal(reloaded.status, "implementation_in_progress")
  assert.equal(started.metadata.reviewer, reviewer)
  const prompt = buildCodexImplementationPrompt(reloaded, fixture.location)
  assert.match(prompt, new RegExp(expectedText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"))

  if (unexpectedText) {
    assert.doesNotMatch(prompt, new RegExp(unexpectedText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"))
  }

  return reloaded
}

async function assertHardeningRejectsBeforeStart(run, fixture, code) {
  await assertRejectsCode(executeBoundedHardening(run.runId, {
    expectedVersion: run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    now: fixture.now
  }), code)

  const reloaded = await readDevelopmentRun(run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(reloaded.status, "review_changes_requested")
  assert.equal(latestHardeningEvidence(reloaded, "hardening_started"), undefined)
}

async function makeTestsPassedFixture(options = {}) {
  const fixture = await makePreparedFixture(options)
  const initialImplementation = await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    sandboxRunner: makeCombinedSandboxRunner({
      codexRunner: makeCommitRunner([], {
        fileName: "initial-implementation.txt",
        message: "initial implementation"
      })
    }),
    now: fixture.now
  })
  const tested = await executeAutomatedTests(fixture.run.runId, {
    expectedVersion: initialImplementation.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeCombinedSandboxRunner(),
    now: fixture.now
  })

  return {
    ...fixture,
    run: tested.run
  }
}

function latestHardeningEvidence(run, outcome = null) {
  const evidence = [...run.evidence.implementation, ...run.evidence.review]

  return evidence.findLast((entry) => (
    entry.source === HARDENING_ORCHESTRATOR_ID &&
    entry.metadata.orchestrator === HARDENING_ORCHESTRATOR_ID &&
    (outcome === null || entry.metadata.outcome === outcome)
  ))
}

test("hardening starts only from review_changes_requested and requires exact expected version", async () => {
  const prepared = await makePreparedFixture()

  await assertRejectsCode(executeBoundedHardening(prepared.run.runId, {
    expectedVersion: prepared.run.version,
    writeDataDir: prepared.writeDataDir,
    workspaceRegistry: prepared.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(prepared),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner(),
    reviewRunner: makeReviewRunner()
  }), "HARDENING_RUN_NOT_READY")

  const fixture = await makeReviewChangesRequestedFixture()

  await assertRejectsCode(executeBoundedHardening(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner(),
    reviewRunner: makeReviewRunner()
  }), "HARDENING_EXPECTED_VERSION_REQUIRED")

  await assertRejectsCode(executeBoundedHardening(fixture.run.runId, {
    expectedVersion: fixture.run.version - 1,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner(),
    reviewRunner: makeReviewRunner()
  }), "STALE_RUN_VERSION")
})

test("latest exact-SHA CHANGES_REQUESTED evidence with validated findings is required", async () => {
  const approved = await makeReviewChangesRequestedFixture()
  const approvedInProgress = await transitionDevelopmentRun(approved.run.runId, {
    expectedVersion: approved.run.version,
    status: "implementation_in_progress",
    actor: "test-reset"
  }, {
    writeDataDir: approved.writeDataDir,
    now: approved.now
  })
  await writeFile(join(approved.location.workspacePath, "approved.txt"), "approved\n", "utf8")
  await git(["add", "approved.txt"], approved.location.workspacePath)
  await git(["commit", "-m", "approved implementation"], approved.location.workspacePath)
  const approvedSha = await git(["rev-parse", "HEAD"], approved.location.workspacePath)
  const ready = await transitionDevelopmentRun(approved.run.runId, {
    expectedVersion: approvedInProgress.version,
    status: "implementation_ready",
    branch: approved.location.branch,
    headSha: approvedSha,
    actor: CODEX_EXECUTION_ADAPTER_ID,
    evidence: [{
      kind: "implementation",
      sha: approvedSha,
      source: CODEX_EXECUTION_ADAPTER_ID,
      summary: "Codex implementation completed and verified locally.",
      metadata: {
        project: approved.project.id,
        branch: approved.location.branch,
        workspaceId: approved.location.workspaceId,
        workspaceRef: approved.location.workspaceRef,
        adapter: CODEX_EXECUTION_ADAPTER_ID,
        attempt: 1,
        promptHash: "a".repeat(64),
        outcome: "implementation_ready",
        changedFiles: 1
      }
    }]
  }, {
    writeDataDir: approved.writeDataDir,
    now: approved.now
  })
  const testing = await executeAutomatedTests(approved.run.runId, {
    expectedVersion: ready.version,
    writeDataDir: approved.writeDataDir,
    workspaceRegistry: approved.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(approved),
    sandboxRunner: makeCombinedSandboxRunner(),
    now: approved.now
  })
  const passed = await executeIndependentReview(approved.run.runId, {
    expectedVersion: testing.run.version,
    writeDataDir: approved.writeDataDir,
    workspaceRegistry: approved.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: approved.now
  })

  await assertRejectsCode(executeBoundedHardening(passed.run.runId, {
    expectedVersion: passed.run.version,
    writeDataDir: approved.writeDataDir,
    workspaceRegistry: approved.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(approved),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner(),
    reviewRunner: makeReviewRunner()
  }), "HARDENING_RUN_NOT_READY")

  const staleSha = await makeReviewChangesRequestedFixture()
  const advanced = await recordDevelopmentRunProgress(staleSha.run.runId, {
    expectedVersion: staleSha.run.version,
    status: "review_changes_requested",
    headSha: staleSha.baseSha,
    actor: "test-invalidator"
  }, {
    writeDataDir: staleSha.writeDataDir,
    now: staleSha.now
  })

  await assertRejectsCode(executeBoundedHardening(advanced.runId, {
    expectedVersion: advanced.version,
    writeDataDir: staleSha.writeDataDir,
    workspaceRegistry: staleSha.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(staleSha),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner(),
    reviewRunner: makeReviewRunner()
  }), "HARDENING_REVIEW_EVIDENCE_MISMATCH")

  const missingFindings = await makeReviewChangesRequestedFixture({
    reviewDecision: {
      blockers: [],
      securityFindings: [],
      testsRequired: ["Only tests are missing."]
    }
  })

  await assertRejectsCode(executeBoundedHardening(missingFindings.run.runId, {
    expectedVersion: missingFindings.run.version,
    writeDataDir: missingFindings.writeDataDir,
    workspaceRegistry: missingFindings.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(missingFindings),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner(),
    reviewRunner: makeReviewRunner()
  }), "HARDENING_REVIEW_FINDINGS_INVALID")
})

test("hardening binds remote decisions only to remote findings for the same SHA and attempt", async () => {
  const fixture = await makeReviewChangesRequestedFixture()
  const localText = "Local reviewer requested provider validation coverage."
  const remoteText = "Remote reviewer requested exact-head PR coverage."
  let run = await appendReviewEvidence(fixture.run, fixture, [
    reviewFindingEvidence(fixture.run, {
      source: INDEPENDENT_REVIEW_AGENT_ID,
      attempt: 1,
      blockers: [localText]
    }),
    reviewFindingEvidence(fixture.run, {
      source: REMOTE_PR_REVIEW_AGENT_ID,
      attempt: 1,
      blockers: [remoteText]
    }),
    reviewDecisionEvidence(fixture.run, {
      source: REMOTE_PR_REVIEW_AGENT_ID,
      attempt: 1,
      blockers: [remoteText]
    })
  ])

  run = await assertHardeningStartsFromEvidence(run, fixture, REMOTE_PR_REVIEW_AGENT_ID, remoteText, localText)
  assert.equal(latestHardeningEvidence(run, "hardening_started").metadata.reviewAttempt, 1)
})

test("hardening binds local decisions only to local findings for the same SHA and attempt", async () => {
  const fixture = await makeReviewChangesRequestedFixture()
  const localText = "Local reviewer requested implementation coverage."
  const remoteText = "Remote reviewer requested delivery coverage."
  let run = await appendReviewEvidence(fixture.run, fixture, [
    reviewFindingEvidence(fixture.run, {
      source: INDEPENDENT_REVIEW_AGENT_ID,
      attempt: 1,
      blockers: [localText]
    }),
    reviewFindingEvidence(fixture.run, {
      source: REMOTE_PR_REVIEW_AGENT_ID,
      attempt: 1,
      blockers: [remoteText]
    }),
    reviewDecisionEvidence(fixture.run, {
      source: REMOTE_PR_REVIEW_AGENT_ID,
      attempt: 1,
      blockers: [remoteText]
    }),
    reviewDecisionEvidence(fixture.run, {
      source: INDEPENDENT_REVIEW_AGENT_ID,
      attempt: 1,
      blockers: [localText]
    })
  ])

  run = await assertHardeningStartsFromEvidence(run, fixture, INDEPENDENT_REVIEW_AGENT_ID, localText, remoteText)
  assert.equal(latestHardeningEvidence(run, "hardening_started").metadata.reviewAttempt, 1)
})

test("remote and local decisions cannot consume findings from the other reviewer", async () => {
  {
    const fixture = await makeReviewChangesRequestedFixture()
    const localText = "Only local findings exist for attempt two."
    const remoteText = "Remote decision must not consume local findings."
    const run = await appendReviewEvidence(fixture.run, fixture, [
      reviewFindingEvidence(fixture.run, {
        source: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 2,
        blockers: [localText]
      }),
      reviewDecisionEvidence(fixture.run, {
        source: REMOTE_PR_REVIEW_AGENT_ID,
        attempt: 2,
        blockers: [remoteText]
      })
    ])

    await assertHardeningRejectsBeforeStart(run, fixture, "HARDENING_REVIEW_FINDINGS_INVALID")
  }

  {
    const fixture = await makeReviewChangesRequestedFixture()
    const remoteText = "Only remote findings exist for attempt two."
    const localText = "Local decision must not consume remote findings."
    const run = await appendReviewEvidence(fixture.run, fixture, [
      reviewFindingEvidence(fixture.run, {
        source: REMOTE_PR_REVIEW_AGENT_ID,
        attempt: 2,
        blockers: [remoteText]
      }),
      reviewDecisionEvidence(fixture.run, {
        source: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 2,
        blockers: [localText]
      })
    ])

    await assertHardeningRejectsBeforeStart(run, fixture, "HARDENING_REVIEW_FINDINGS_INVALID")
  }
})

test("review evidence with mismatched source and reviewer identity fails closed", async () => {
  {
    const fixture = await makeReviewChangesRequestedFixture()
    const text = "Mismatched decision identity must fail."
    const run = await appendReviewEvidence(fixture.run, fixture, [
      reviewFindingEvidence(fixture.run, {
        source: REMOTE_PR_REVIEW_AGENT_ID,
        attempt: 2,
        blockers: [text]
      }),
      reviewDecisionEvidence(fixture.run, {
        source: REMOTE_PR_REVIEW_AGENT_ID,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 2,
        blockers: [text]
      })
    ])

    await assertHardeningRejectsBeforeStart(run, fixture, "HARDENING_REVIEW_FINDINGS_INVALID")
  }

  {
    const fixture = await makeReviewChangesRequestedFixture()
    const text = "Mismatched findings identity must fail."
    const run = await appendReviewEvidence(fixture.run, fixture, [
      reviewFindingEvidence(fixture.run, {
        source: REMOTE_PR_REVIEW_AGENT_ID,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 2,
        blockers: [text]
      }),
      reviewDecisionEvidence(fixture.run, {
        source: REMOTE_PR_REVIEW_AGENT_ID,
        attempt: 2,
        blockers: [text]
      })
    ])

    await assertHardeningRejectsBeforeStart(run, fixture, "HARDENING_REVIEW_FINDINGS_INVALID")
  }
})

test("remediation context is derived only from durable review evidence and reruns tests and review for the new SHA", async () => {
  const fixture = await makeReviewChangesRequestedFixture()
  const codexCalls = []
  const sandboxCalls = []
  const reviewCalls = []
  const result = await executeBoundedHardening(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    reviewConfig: trustedReviewConfig(),
    remediationText: "SENSITIVE_TEST_SENTINEL arbitrary caller remediation must be ignored",
    sandboxRunner: makeCombinedSandboxRunner({
      calls: sandboxCalls,
      codexRunner: makeCommitRunner(codexCalls, {
        fileName: "hardening-fix.txt",
        message: "hardening remediation"
      })
    }),
    reviewRunner: makeReviewRunner(async (invocation) => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(invocation.reviewedSha))}\n`,
      stderr: "ignored stderr"
    }), { calls: reviewCalls }),
    now: fixture.now
  })

  assert.equal(result.run.status, "review_passed")
  assert.notEqual(result.run.headSha, fixture.initialImplementationSha)
  assert.equal(codexCalls.length, 1)
  assert.match(codexCalls[0].prompt, /Provider validation regression is missing/u)
  assert.match(codexCalls[0].prompt, /Add focused validation regression coverage/u)
  assert.doesNotMatch(codexCalls[0].prompt, /arbitrary caller remediation|SENSITIVE_TEST_SENTINEL/u)
  assert.equal(reviewCalls.filter((call) => call.kind === "review").length, 1)
  assert.equal(reviewCalls.find((call) => call.kind === "review").reviewedSha, result.run.headSha)

  const testPassEvidence = result.run.evidence.test.filter((entry) => (
    entry.source === AUTOMATED_TEST_RUNNER_ID &&
    entry.metadata.outcome === "passed" &&
    Number.isInteger(entry.metadata.total)
  ))
  assert.equal(testPassEvidence.length >= 2, true)
  assert.equal(testPassEvidence.at(-2).sha, fixture.initialImplementationSha)
  assert.equal(testPassEvidence.at(-1).sha, result.run.headSha)

  const hardeningReconciliation = await reconcileBoundedHardening(result.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })
  assert.equal(hardeningReconciliation.hardening.testEvidenceValid, true)
  assert.equal(hardeningReconciliation.hardening.reviewEvidenceValid, true)

  const hardeningEvidence = latestHardeningEvidence(result.run, "implementation_ready")
  assert.equal(hardeningEvidence.sha, result.run.headSha)
  assert.equal(hardeningEvidence.metadata.sourceReviewSha, fixture.initialImplementationSha)
  assert.equal(hardeningEvidence.metadata.resultingSha, result.run.headSha)
  assert.equal(hardeningEvidence.metadata.blockerCount, 1)
  assert.equal(result.run.evidence.review.at(-1).source, INDEPENDENT_REVIEW_AGENT_ID)
  assert.equal(result.run.evidence.review.at(-1).metadata.decision, REVIEW_DECISIONS.APPROVED)
  assert.equal(result.run.evidence.implementation.some((entry) => entry.metadata?.decision === REVIEW_DECISIONS.APPROVED), false)

  const evidenceText = JSON.stringify(result.run.evidence)
  assert.doesNotMatch(evidenceText, /raw stderr|stdout|stderr|SENSITIVE_TEST_SENTINEL|gho_fake_token|arbitrary caller remediation|"prompt":/u)
  assert.doesNotMatch(evidenceText, new RegExp(fixture.location.workspacePath.replaceAll("/", "\\/"), "u"))
})

test("review blocker size and unsafe content validation fails closed before hardening", async () => {
  const oversized = await makeReviewChangesRequestedFixture({
    reviewDecision: {
      blockers: ["x".repeat(170)]
    }
  })

  await assertRejectsCode(executeBoundedHardening(oversized.run.runId, {
    expectedVersion: oversized.run.version,
    writeDataDir: oversized.writeDataDir,
    workspaceRegistry: oversized.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(oversized),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner(),
    reviewRunner: makeReviewRunner()
  }), "HARDENING_REVIEW_FINDINGS_INVALID")

  const unsafe = await makeTestsPassedFixture()
  await assertRejectsCode(executeIndependentReview(unsafe.run.runId, {
    expectedVersion: unsafe.run.version,
    writeDataDir: unsafe.writeDataDir,
    workspaceRegistry: unsafe.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async (invocation) => ({
      exitCode: 0,
      stdout: `${JSON.stringify(changesRequestedDecision(invocation.reviewedSha, {
        blockers: ["credential token=secret"]
      }))}\n`,
      stderr: ""
    })),
    now: unsafe.now
  }), "REVIEW_OUTPUT_INVALID")

  const contradictory = await makeReviewChangesRequestedFixture()
  const findingsEvidence = contradictory.run.evidence.review.at(-2)
  const decisionEvidence = contradictory.run.evidence.review.at(-1)
  const corrupted = await recordDevelopmentRunProgress(contradictory.run.runId, {
    expectedVersion: contradictory.run.version,
    status: "review_changes_requested",
    actor: "test-corruptor",
    evidence: [{
      kind: "review",
      sha: contradictory.run.headSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      summary: "Corrupted findings count should be rejected.",
      metadata: {
        project: contradictory.project.id,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: decisionEvidence.metadata.attempt,
        reviewedSha: contradictory.run.headSha,
        decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
        mergeAllowed: false,
        blockers: 2,
        securityFindings: findingsEvidence.metadata.securityFindings,
        testsRequired: findingsEvidence.metadata.testsRequired,
        blockerItems: findingsEvidence.metadata.blockerItems,
        securityItems: findingsEvidence.metadata.securityItems,
        testItems: findingsEvidence.metadata.testItems,
        findingHash: findingsEvidence.metadata.findingHash,
        outcome: REVIEW_FINDINGS_EVIDENCE_OUTCOME
      }
    }]
  }, {
    writeDataDir: contradictory.writeDataDir,
    now: contradictory.now
  })

  await assertRejectsCode(executeBoundedHardening(corrupted.runId, {
    expectedVersion: corrupted.version,
    writeDataDir: contradictory.writeDataDir,
    workspaceRegistry: contradictory.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(contradictory),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner(),
    reviewRunner: makeReviewRunner()
  }), "HARDENING_REVIEW_FINDINGS_INVALID")
})

test("maximum three hardening rounds survive reload and stop with owner_action_required", async () => {
  const fixture = await makeReviewChangesRequestedFixture()
  const codexCalls = []
  const reviewCalls = []
  const result = await executeBoundedHardening(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    reviewConfig: trustedReviewConfig(),
    sandboxRunner: makeCombinedSandboxRunner({
      codexRunner: makeCommitRunner(codexCalls)
    }),
    reviewRunner: makeReviewRunner(async (invocation) => {
      reviewCalls.push(invocation.reviewedSha)
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(changesRequestedDecision(invocation.reviewedSha, {
          blockers: [`Still missing remediation round ${reviewCalls.length}.`],
          testsRequired: []
        }))}\n`,
        stderr: ""
      }
    }),
    now: fixture.now
  })

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.hardening.currentRound, MAX_HARDENING_ROUNDS)
  assert.equal(codexCalls.length, MAX_HARDENING_ROUNDS)
  assert.equal(reviewCalls.length, MAX_HARDENING_ROUNDS)

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  const reconciliation = await reconcileBoundedHardening(reloaded.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(reconciliation.hardening.currentRound, MAX_HARDENING_ROUNDS)
  assert.equal(reconciliation.hardening.ownerActionRequired, true)
  assert.equal(reconciliation.hardening.nonConverged, true)
  assert.equal(latestHardeningEvidence(reloaded, "owner_action_required").metadata.reason, "max_hardening_rounds_exhausted")
})

test("optimistic concurrency allows only one hardening coordinator to reserve remediation", async () => {
  const fixture = await makeReviewChangesRequestedFixture()
  const codexCalls = []
  const results = await Promise.allSettled([
    executeBoundedHardening(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      testPolicyRegistry: trustedTestPolicyRegistry(fixture),
      reviewConfig: trustedReviewConfig(),
      sandboxRunner: makeCombinedSandboxRunner({
        codexRunner: makeCommitRunner(codexCalls, { fileName: "race-a.txt" })
      }),
      reviewRunner: makeReviewRunner(),
      now: fixture.now
    }),
    executeBoundedHardening(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      testPolicyRegistry: trustedTestPolicyRegistry(fixture),
      reviewConfig: trustedReviewConfig(),
      sandboxRunner: makeCombinedSandboxRunner({
        codexRunner: makeCommitRunner(codexCalls, { fileName: "race-b.txt" })
      }),
      reviewRunner: makeReviewRunner(),
      now: fixture.now
    })
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => (
    result.status === "rejected" &&
    result.reason instanceof DevelopmentRunStateError &&
    result.reason.code === "STALE_RUN_VERSION"
  )).length, 1)
})

test("ambiguous Codex, test, and review outcomes stop the loop and require reconciliation", async () => {
  for (const [kind, expectedCode, runnerOptions] of [
    ["codex", "CODEX_EXECUTION_AMBIGUOUS", {
      codexRunner: async () => ({ timedOut: true, killed: true, ambiguous: true })
    }],
    ["test", "TEST_EXECUTION_AMBIGUOUS", {
      codexRunner: makeCommitRunner([]),
      testRunner: async () => ({ timedOut: true, killed: true, ambiguous: true })
    }],
    ["review", "REVIEW_EXECUTION_AMBIGUOUS", {
      codexRunner: makeCommitRunner([]),
      reviewRunner: makeReviewRunner(async () => ({ timedOut: true, killed: true, ambiguous: true }))
    }]
  ]) {
    const fixture = await makeReviewChangesRequestedFixture()
    const sandboxRunner = makeCombinedSandboxRunner(runnerOptions)
    const reviewRunner = runnerOptions.reviewRunner || makeReviewRunner()

    await assertRejectsCode(executeBoundedHardening(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      testPolicyRegistry: trustedTestPolicyRegistry(fixture),
      reviewConfig: trustedReviewConfig(),
      sandboxRunner,
      reviewRunner,
      now: fixture.now
    }), expectedCode)

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })
    const reconciliation = await reconcileBoundedHardening(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(reconciliation.hardening.currentRound, 1, kind)
    assert.equal(reconciliation.hardening.remediationInProgress, true, kind)
    assert.notEqual(reloaded.status, "review_changes_requested", kind)

    await assertRejectsCode(executeBoundedHardening(fixture.run.runId, {
      expectedVersion: reloaded.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      testPolicyRegistry: trustedTestPolicyRegistry(fixture),
      reviewConfig: trustedReviewConfig(),
      sandboxRunner,
      reviewRunner,
      now: fixture.now
    }), "HARDENING_RUN_NOT_READY")
  }
})

test("hardening adds no implementation, review, push, GitHub write, merge, deploy, or OpenClaw route", async () => {
  const source = await readFile(new URL("./development-hardening-orchestrator.mjs", import.meta.url), "utf8")
  const exports = Object.keys(await import("./development-hardening-orchestrator.mjs")).sort()

  assert.deepEqual(exports, [
    "DevelopmentHardeningOrchestratorError",
    "HARDENING_ORCHESTRATOR_ID",
    "MAX_HARDENING_ROUNDS",
    "executeBoundedHardening",
    "formatDevelopmentHardeningOrchestratorError",
    "reconcileBoundedHardening"
  ])
  assert.doesNotMatch(source, /from "node:child_process"|from ".*github|from ".*openclaw|gh api|git push|createPr|openPr|deployment/i)
  assert.match(source, /executeCodexImplementation/u)
  assert.match(source, /executeAutomatedTests/u)
  assert.match(source, /executeIndependentReview/u)
  assert.equal(HARDENING_ORCHESTRATOR_ID, PHASE_6F_HARDENING_ORCHESTRATOR_ID)
  assert.equal(buildCodexImplementationPrompt.length, 2)
})
