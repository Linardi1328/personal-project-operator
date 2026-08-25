import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import {
  DevelopmentRunStateError,
  REVIEW_ORPHAN_RECOVERY_ACTOR,
  REVIEW_ORPHAN_RECOVERY_CONFIRMATION,
  createDevelopmentRun,
  readDevelopmentRun,
  recoverDevelopmentRunReviewOrphanState,
  resolveDevelopmentRunProject,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  prepareImplementationWorkspace,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  INDEPENDENT_REVIEW_SANDBOX_ID,
  MAX_INDEPENDENT_REVIEW_ATTEMPTS,
  MAX_REVIEW_OUTPUT_BYTES,
  MAX_REVIEW_STDERR_BYTES,
  PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
  PHASE_6E_TEST_EVIDENCE_SOURCE,
  REVIEW_DECISIONS,
  REVIEW_SANDBOX_BACKENDS,
  executeIndependentReview,
  reconcileIndependentReview,
  runSandboxedProcess
} from "./development-review-agent.mjs"

const execFileAsync = promisify(execFile)
const TRUSTED_MACOS_SANDBOX_EXECUTABLE = process.env.PPO_REVIEW_TEST_SANDBOX_EXECUTABLE || "/usr/bin/sandbox-exec"
const TRUSTED_LINUX_SANDBOX_EXECUTABLE = process.env.PPO_REVIEW_TEST_LINUX_SANDBOX_EXECUTABLE || "/usr/bin/nsenter"
const TRUSTED_LINUX_SETPRIV_EXECUTABLE = process.env.PPO_REVIEW_TEST_LINUX_SETPRIV_EXECUTABLE || "/usr/bin/setpriv"
const TRUSTED_LINUX_READONLY_WRAPPER_EXECUTABLE = process.env.PPO_REVIEW_TEST_LINUX_READONLY_WRAPPER_EXECUTABLE || "/usr/local/bin/ppo-readonly-workspace-wrapper"
const TRUSTED_LINUX_NAMESPACE_PATH = process.env.PPO_REVIEW_TEST_LINUX_NAMESPACE_PATH || "/run/netns/ppo-review-no-network"
const TRUSTED_LINUX_RUN_AS_UID = 1000
const TRUSTED_LINUX_RUN_AS_GID = 1000

function makeClock() {
  let tick = 0
  const start = Date.parse("2026-08-21T11:00:00.000Z")

  return () => {
    const next = new Date(start + tick * 1000)
    tick += 1
    return next
  }
}

test("review sandbox keeps final stdout tight while allowing bounded stderr progress", async () => {
  const result = await runSandboxedProcess({
    sandboxCommand: {
      executablePath: process.execPath,
      args: [
        "--eval",
        "process.stderr.write('x'.repeat(2048)); process.stdout.write('ok')"
      ]
    },
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin"
    },
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    maxStderrBytes: 4096
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, "ok")
  assert.equal(result.outputOverflow, false)
  assert.equal(result.stdoutOverflow, false)
  assert.equal(result.stderrOverflow, false)

  const overflow = await runSandboxedProcess({
    sandboxCommand: {
      executablePath: process.execPath,
      args: [
        "--eval",
        "process.stderr.write('x'.repeat(4097)); setTimeout(() => {}, 1000)"
      ]
    },
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin"
    },
    stdin: "",
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    maxStderrBytes: 4096
  })

  assert.equal(overflow.outputOverflow, true)
  assert.equal(overflow.stdoutOverflow, false)
  assert.equal(overflow.stderrOverflow, true)
  assert.equal(overflow.ambiguous, true)
  assert.equal(MAX_REVIEW_STDERR_BYTES > MAX_REVIEW_OUTPUT_BYTES, true)
})

test("review sandbox process absorbs child stdin EPIPE and reports the child exit", async () => {
  const result = await runSandboxedProcess({
    sandboxCommand: {
      executablePath: process.execPath,
      args: ["--eval", "process.stdin.destroy(); process.exit(23)"]
    },
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin"
    },
    stdin: "x".repeat(8 * 1024 * 1024),
    timeoutMs: 5000,
    maxOutputBytes: 1024
  })

  assert.equal(result.exitCode, 23)
  assert.equal(result.signal, null)
  assert.equal(result.killed, false)
  assert.equal(result.timedOut, false)
  assert.equal(result.outputOverflow, false)
  assert.equal(result.ambiguous, false)
})

async function canonicalTempRoot(label = "ppo-6f-") {
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
    task: options.task || "Implement the next approved local operator phase without changing credentials.",
    baseSha: options.baseSha || fixture.baseSha,
    branch: "main",
    headSha: options.baseSha || fixture.baseSha,
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

async function makeImplementationReadyFixture(options = {}) {
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

  await writeFile(join(location.workspacePath, "implementation.txt"), "implemented\n", "utf8")
  await git(["add", "implementation.txt"], location.workspacePath)
  await git(["commit", "-m", "phase 6d implementation"], location.workspacePath)

  const headSha = await git(["rev-parse", "HEAD"], location.workspacePath)
  const implementationEvidence = options.implementationEvidence === false
    ? []
    : [{
      kind: "implementation",
      sha: options.implementationEvidenceSha || headSha,
      source: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
      summary: "Codex implementation completed and verified locally.",
      metadata: {
        project: fixture.project.id,
        branch: location.branch,
        workspaceId: location.workspaceId,
        workspaceRef: location.workspaceRef,
        adapter: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
        attempt: 1,
        promptHash: "a".repeat(64),
        outcome: "implementation_ready",
        changedFiles: 1
      }
    }]
  const ready = await transitionDevelopmentRun(prepared.run.runId, {
    expectedVersion: prepared.run.version,
    status: "implementation_ready",
    branch: location.branch,
    headSha,
    actor: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
    reason: "phase-6d-codex-implementation-ready",
    evidence: implementationEvidence
  }, {
    writeDataDir: fixture.writeDataDir,
    now: planned.now
  })

  return {
    ...fixture,
    now: planned.now,
    run: ready,
    location,
    headSha
  }
}

async function makeTestsPassedFixture(options = {}) {
  const fixture = await makeImplementationReadyFixture(options)
  const startedEvidence = [{
    kind: "test",
    sha: fixture.headSha,
    source: PHASE_6E_TEST_EVIDENCE_SOURCE,
    summary: "Automated test attempt reserved.",
    metadata: {
      project: fixture.project.id,
      runner: PHASE_6E_TEST_EVIDENCE_SOURCE,
      attempt: 1,
      policyId: "phase-6e-local-node-policy",
      policyHash: "b".repeat(64),
      implSha: fixture.headSha,
      outcome: "testing_started",
      sandbox: "phase-6e-no-outbound-network-test-sandbox",
      network: "none"
    }
  }]
  const testing = await transitionDevelopmentRun(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    status: "tests_in_progress",
    branch: fixture.location.branch,
    headSha: fixture.headSha,
    actor: PHASE_6E_TEST_EVIDENCE_SOURCE,
    reason: "phase-6e-automated-testing-attempt",
    evidence: startedEvidence
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  const passEvidence = options.testPassEvidence === false
    ? []
    : [{
      kind: "test",
      sha: options.testPassEvidenceSha || fixture.headSha,
      source: PHASE_6E_TEST_EVIDENCE_SOURCE,
      summary: "Automated test policy completed with metadata-only aggregate result.",
      metadata: {
        project: fixture.project.id,
        runner: PHASE_6E_TEST_EVIDENCE_SOURCE,
        attempt: 1,
        policyId: "phase-6e-local-node-policy",
        policyHash: "b".repeat(64),
        implSha: options.testPassEvidenceImplSha || fixture.headSha,
        outcome: "passed",
        total: 1,
        passed: 1,
        failed: 0,
        ambiguous: 0,
        sandbox: "phase-6e-no-outbound-network-test-sandbox",
        network: "none"
      }
    }]
  const passed = await transitionDevelopmentRun(testing.runId, {
    expectedVersion: testing.version,
    status: "tests_passed",
    branch: fixture.location.branch,
    headSha: fixture.headSha,
    actor: PHASE_6E_TEST_EVIDENCE_SOURCE,
    reason: "phase-6e-automated-testing-passed",
    evidence: passEvidence
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })

  return {
    ...fixture,
    run: passed
  }
}

function trustedSandbox(overrides = {}) {
  return {
    type: REVIEW_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
    platform: "darwin",
    network: "none",
    enforcement: "os-process",
    readOnlyWorkspace: true,
    readOnlyWorkspaceMode: "trusted-read-only-workspace",
    executablePath: TRUSTED_MACOS_SANDBOX_EXECUTABLE,
    ...overrides
  }
}

function trustedLinuxSandbox(overrides = {}) {
  return {
    type: REVIEW_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
    platform: "linux",
    network: "none",
    enforcement: "os-network-namespace",
    readOnlyWorkspace: true,
    readOnlyWorkspaceMode: "trusted-read-only-mount-namespace",
    executablePath: TRUSTED_LINUX_SANDBOX_EXECUTABLE,
    readOnlyWorkspaceWrapperPath: TRUSTED_LINUX_READONLY_WRAPPER_EXECUTABLE,
    namespacePath: TRUSTED_LINUX_NAMESPACE_PATH,
    setprivPath: TRUSTED_LINUX_SETPRIV_EXECUTABLE,
    runAsUid: TRUSTED_LINUX_RUN_AS_UID,
    runAsGid: TRUSTED_LINUX_RUN_AS_GID,
    requireNoNewPrivileges: true,
    dropCapabilities: true,
    ...overrides
  }
}

function trustedNativeLinuxSandbox(overrides = {}) {
  return {
    type: REVIEW_SANDBOX_BACKENDS.CODEX_NATIVE_LINUX,
    platform: "linux",
    network: "none",
    enforcement: "codex-command-sandbox",
    readOnlyWorkspace: true,
    readOnlyWorkspaceMode: "codex-native-read-only",
    executablePath: process.execPath,
    permissionProfile: ":read-only",
    ...overrides
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
    sandbox: trustedSandbox(),
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

function makeReviewRunner(reviewRunner = async (invocation) => ({
  exitCode: 0,
  stdout: `${JSON.stringify(decision(invocation.reviewedSha))}\n`,
  stderr: "ignored stderr"
}), options = {}) {
  const calls = options.calls || []

  return async (invocation) => {
    calls.push({
      ...invocation,
      args: [...invocation.args],
      env: { ...invocation.env },
      sandboxArgs: [...invocation.sandboxArgs]
    })
    assert.equal(invocation.shell, false)
    assert.equal(invocation.sandbox.network, "none")
    assert.equal(invocation.sandbox.readOnlyWorkspace, true)
    assert.equal(invocation.sandboxCommand.executablePath, invocation.sandboxExecutablePath)
    assert.deepEqual(invocation.sandboxCommand.args, invocation.sandboxArgs)

    if (options.unavailable) {
      throw new Error("sandbox unavailable")
    }

    if (invocation.kind === "sandbox-probe") {
      if (invocation.probe === "linux-privilege-boundary") {
        return { exitCode: 0, stdout: "", stderr: "" }
      }

      if (invocation.probe === "local-process") {
        return { exitCode: 0, stdout: "", stderr: "" }
      }

      if (invocation.probe === "workspace-read") {
        return { exitCode: 0, stdout: "", stderr: "" }
      }

      if (invocation.probe === "workspace-file-write") {
        return options.workspaceWriteAllowed
          ? { exitCode: 70, stdout: "write allowed", stderr: "" }
          : { exitCode: 0, sandboxDenied: true, stdout: "", stderr: "" }
      }

      if (invocation.probe === "source-file-write") {
        return options.sourceWriteAllowed
          ? { exitCode: 70, stdout: "source write allowed", stderr: "" }
          : { exitCode: 0, sandboxDenied: true, stdout: "", stderr: "" }
      }

      if (invocation.probe === "workspace-git-mutation") {
        return options.gitMutationAllowed
          ? { exitCode: 70, stdout: "git mutation allowed", stderr: "" }
          : { exitCode: 0, sandboxDenied: true, stdout: "", stderr: "" }
      }

      if (invocation.probe === "direct-network") {
        if (options.networkInactive) {
          return { exitCode: 66, stdout: "connected", stderr: "" }
        }

        return { exitCode: 0, sandboxDenied: true, stdout: "", stderr: "" }
      }
    }

    return await reviewRunner(invocation)
  }
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

function latestReviewEvidence(run) {
  return run.evidence.review.at(-1)
}

test("orphan recovery closes the prior review boundary before a fresh attempt", async () => {
  const fixture = await makeTestsPassedFixture()
  const started = await transitionDevelopmentRun(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    status: "review_in_progress",
    branch: fixture.location.branch,
    headSha: fixture.headSha,
    actor: INDEPENDENT_REVIEW_AGENT_ID,
    reason: "phase-6f-independent-review-attempt",
    evidence: [{
      kind: "review",
      sha: fixture.headSha,
      source: INDEPENDENT_REVIEW_AGENT_ID,
      summary: "Independent review attempt reserved.",
      metadata: {
        project: fixture.project.id,
        reviewer: INDEPENDENT_REVIEW_AGENT_ID,
        attempt: 1,
        reviewedSha: fixture.headSha,
        startedAt: "2026-08-21T11:10:00.000Z",
        outcome: "review_started",
        sandbox: INDEPENDENT_REVIEW_SANDBOX_ID,
        backend: "codex-native-linux",
        platform: "linux",
        network: "none",
        readOnlyWorkspace: true
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  const recovered = await recoverDevelopmentRunReviewOrphanState(started.runId, {
    expectedVersion: started.version,
    expectedHeadSha: fixture.headSha,
    reviewAttempt: 1,
    confirmation: REVIEW_ORPHAN_RECOVERY_CONFIRMATION
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })

  assert.equal(recovered.status, "tests_passed")
  assert.equal(latestReviewEvidence(recovered).source, REVIEW_ORPHAN_RECOVERY_ACTOR)
  assert.equal(latestReviewEvidence(recovered).metadata.outcome, "review_orphan_recovered")
  assert.equal(latestReviewEvidence(recovered).metadata.recovery, REVIEW_ORPHAN_RECOVERY_ACTOR)
  assert.equal(Object.hasOwn(latestReviewEvidence(recovered).metadata, "reviewer"), false)

  const reviewed = await executeIndependentReview(recovered.runId, {
    expectedVersion: recovered.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(),
    now: fixture.now
  })

  assert.equal(reviewed.run.status, "review_passed")
  assert.equal(reviewed.run.attempts.review, 2)
  assert.equal(latestReviewEvidence(reviewed.run).metadata.outcome, "approved")
})

test("independent review requires tests_passed status, exact expected version, and exact Phase 6D/6E evidence", async () => {
  const implementationReady = await makeImplementationReadyFixture()

  await assertRejectsCode(executeIndependentReview(implementationReady.run.runId, {
    expectedVersion: implementationReady.run.version,
    writeDataDir: implementationReady.writeDataDir,
    workspaceRegistry: implementationReady.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_RUN_NOT_READY")

  const fixture = await makeTestsPassedFixture()

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_EXPECTED_VERSION_REQUIRED")

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version - 1,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "STALE_RUN_VERSION")

  const missingImplementationEvidence = await makeTestsPassedFixture({ implementationEvidence: false })

  await assertRejectsCode(executeIndependentReview(missingImplementationEvidence.run.runId, {
    expectedVersion: missingImplementationEvidence.run.version,
    writeDataDir: missingImplementationEvidence.writeDataDir,
    workspaceRegistry: missingImplementationEvidence.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_IMPLEMENTATION_EVIDENCE_MISMATCH")

  const missingTestPass = await makeTestsPassedFixture({ testPassEvidence: false })

  await assertRejectsCode(executeIndependentReview(missingTestPass.run.runId, {
    expectedVersion: missingTestPass.run.version,
    writeDataDir: missingTestPass.writeDataDir,
    workspaceRegistry: missingTestPass.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_TEST_EVIDENCE_MISMATCH")

  const mismatchedTestPass = await makeTestsPassedFixture({
    testPassEvidenceSha: fixture.baseSha
  })

  await assertRejectsCode(executeIndependentReview(mismatchedTestPass.run.runId, {
    expectedVersion: mismatchedTestPass.run.version,
    writeDataDir: mismatchedTestPass.writeDataDir,
    workspaceRegistry: mismatchedTestPass.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_TEST_EVIDENCE_MISMATCH")
})

test("workspace reconciliation requires exact branch, HEAD, and clean tree before review", async () => {
  const detached = await makeTestsPassedFixture()

  await git(["checkout", "--detach"], detached.location.workspacePath)
  await assertRejectsCode(executeIndependentReview(detached.run.runId, {
    expectedVersion: detached.run.version,
    writeDataDir: detached.writeDataDir,
    workspaceRegistry: detached.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_WORKSPACE_BRANCH_MISMATCH")

  const changed = await makeTestsPassedFixture()
  await writeFile(join(changed.location.workspacePath, "after-tests.txt"), "changed\n", "utf8")
  await git(["add", "after-tests.txt"], changed.location.workspacePath)
  await git(["commit", "-m", "unexpected head change"], changed.location.workspacePath)

  await assertRejectsCode(executeIndependentReview(changed.run.runId, {
    expectedVersion: changed.run.version,
    writeDataDir: changed.writeDataDir,
    workspaceRegistry: changed.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_WORKSPACE_HEAD_MISMATCH")

  const dirty = await makeTestsPassedFixture()
  await writeFile(join(dirty.location.workspacePath, "dirty.txt"), "dirty\n", "utf8")

  await assertRejectsCode(executeIndependentReview(dirty.run.runId, {
    expectedVersion: dirty.run.version,
    writeDataDir: dirty.writeDataDir,
    workspaceRegistry: dirty.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_WORKSPACE_DIRTY")
})

test("trusted reviewer config uses explicit argv, shell=false, sanitized env, sandbox, and deterministic bounded prompt", async () => {
  const fixture = await makeTestsPassedFixture()
  const calls = []
  const previousSecret = process.env.PPO_SECRET_TOKEN

  process.env.PPO_SECRET_TOKEN = "SENSITIVE_TEST_SENTINEL"

  try {
    const result = await executeIndependentReview(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      reviewConfig: trustedReviewConfig(),
      reviewRunner: makeReviewRunner(async (invocation) => ({
        exitCode: 0,
        stdout: `${JSON.stringify(decision(fixture.headSha))}\n`,
        stderr: "raw stderr ignored"
      }), { calls }),
      now: fixture.now
    })

    assert.equal(result.run.status, "review_passed")
    assert.equal(result.run.headSha, fixture.headSha)
    assert.equal(result.run.attempts.review, 1)

    const reviewCalls = calls.filter((call) => call.kind === "review")
    assert.equal(reviewCalls.length, 1)
    assert.equal(reviewCalls[0].cwd, fixture.location.workspacePath)
    assert.equal(reviewCalls[0].shell, false)
    assert.equal(reviewCalls[0].executablePath, process.execPath)
    assert.deepEqual(reviewCalls[0].args, ["--eval", "process.exit(0)"])
    assert.equal(reviewCalls[0].env.PPO_SAFE_REVIEW_FLAG, "1")
    assert.equal(Object.hasOwn(reviewCalls[0].env, "PPO_SECRET_TOKEN"), false)
    assert.equal(Object.hasOwn(reviewCalls[0].env, "GITHUB_TOKEN"), false)
    assert.equal(reviewCalls[0].sandbox.network, "none")
    assert.equal(reviewCalls[0].sandbox.readOnlyWorkspace, true)
    assert.equal(reviewCalls[0].readOnlyPaths.includes(fixture.location.workspacePath), true)
    assert.equal(reviewCalls[0].readOnlyPaths.includes(fixture.sourceRepoPath), true)
    assert.equal(reviewCalls[0].readOnlyPaths.length >= 3, true)
    assert.match(reviewCalls[0].sandboxArgs[1], /deny file-write\* \(subpath /u)
    assert.match(reviewCalls[0].sandboxArgs[1], new RegExp(fixture.location.workspacePath.replaceAll("/", "\\/"), "u"))
    assert.match(reviewCalls[0].sandboxArgs[1], new RegExp(fixture.sourceRepoPath.replaceAll("/", "\\/"), "u"))
    assert.match(reviewCalls[0].promptHash, /^[a-f0-9]{64}$/u)
    assert.equal(reviewCalls[0].prompt.length < 6000, true)
    assert.match(reviewCalls[0].prompt, /PPO Phase 6F independent exact-SHA review/u)
    assert.match(reviewCalls[0].prompt, new RegExp(fixture.headSha, "u"))
    assert.match(reviewCalls[0].prompt, /APPROVED => mergeAllowed=true and blockers\/securityFindings\/testsRequired all empty/u)
    assert.match(reviewCalls[0].prompt, /CHANGES_REQUESTED => mergeAllowed=false/u)
    assert.match(reviewCalls[0].prompt, /OWNER_ACTION_REQUIRED => mergeAllowed=false/u)
    assert.doesNotMatch(reviewCalls[0].prompt, /APPROVED[^\n]*mergeAllowed[^\n]*false/u)
    assert.doesNotMatch(reviewCalls[0].prompt, /SENSITIVE_TEST_SENTINEL|gho_fake_token|raw stderr|stdout|stderr/u)
    assert.doesNotMatch(reviewCalls[0].prompt, new RegExp(fixture.location.workspacePath.replaceAll("/", "\\/"), "u"))
    assert.deepEqual(calls.map((call) => call.probe || call.kind), [
      "local-process",
      "workspace-read",
      "workspace-file-write",
      "source-file-write",
      "workspace-git-mutation",
      "direct-network",
      "review"
    ])
    assert.equal(calls.find((call) => call.probe === "workspace-file-write").cwd, fixture.location.workspacePath)
    assert.equal(calls.find((call) => call.probe === "source-file-write").cwd, fixture.sourceRepoPath)
    assert.equal(calls.find((call) => call.probe === "workspace-git-mutation").cwd, fixture.location.workspacePath)

    const evidenceText = JSON.stringify(result.run.evidence.review)
    assert.doesNotMatch(evidenceText, /SENSITIVE_TEST_SENTINEL|raw stderr|stdout|stderr|token|credential/u)
    assert.doesNotMatch(evidenceText, new RegExp(fixture.location.workspacePath.replaceAll("/", "\\/"), "u"))

    const evidence = latestReviewEvidence(result.run)
    assert.equal(evidence.sha, fixture.headSha)
    assert.equal(evidence.metadata.reviewer, INDEPENDENT_REVIEW_AGENT_ID)
    assert.equal(evidence.metadata.reviewedSha, fixture.headSha)
    assert.equal(evidence.metadata.decision, REVIEW_DECISIONS.APPROVED)
    assert.equal(evidence.metadata.mergeAllowed, true)
    assert.equal(evidence.metadata.outcome, "approved")
    assert.equal(evidence.metadata.sandbox, INDEPENDENT_REVIEW_SANDBOX_ID)
    assert.equal(evidence.metadata.network, "none")
  } finally {
    if (previousSecret === undefined) {
      delete process.env.PPO_SECRET_TOKEN
    } else {
      process.env.PPO_SECRET_TOKEN = previousSecret
    }
  }
})

test("reviewer config refuses arbitrary commands, shell execution, secret env, and Codex/GitHub/deploy executables", async () => {
  const fixture = await makeTestsPassedFixture()

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewRunner: makeReviewRunner()
  }), "REVIEW_CONFIG_REQUIRED")

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig({ command: "codex review" }),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_CONFIG_INVALID")

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig({ shell: true }),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_CONFIG_INVALID")

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig({ executablePath: "reviewer" }),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_CONFIG_INVALID")

  for (const executablePath of ["/usr/bin/codex", "/usr/bin/gh", "/bin/sh", "/bin/systemctl"]) {
    await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      reviewConfig: trustedReviewConfig({ executablePath }),
      reviewRunner: makeReviewRunner()
    }), "REVIEW_CONFIG_INVALID")
  }

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig({
      env: {
        GITHUB_TOKEN: "gho_fake"
      }
    }),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_CONFIG_INVALID")
})

test("valid blockers transition review_in_progress to review_changes_requested with merge disabled", async () => {
  const fixture = await makeTestsPassedFixture()
  const result = await executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(fixture.headSha, {
        decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
        mergeAllowed: false,
        blockers: ["Provider validation regression is missing."],
        summary: "Changes are required before merge."
      }))}\n`,
      stderr: ""
    })),
    now: fixture.now
  })

  assert.equal(result.run.status, "review_changes_requested")
  assert.equal(result.review.decision, REVIEW_DECISIONS.CHANGES_REQUESTED)
  assert.equal(result.review.mergeAllowed, false)
  assert.equal(latestReviewEvidence(result.run).metadata.outcome, "changes_requested")
  assert.equal(latestReviewEvidence(result.run).metadata.blockers, 1)
})

test("valid owner-action-required review uses review_changes_requested without inventing approval", async () => {
  const fixture = await makeTestsPassedFixture()
  const result = await executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(fixture.headSha, {
        decision: REVIEW_DECISIONS.OWNER_ACTION_REQUIRED,
        mergeAllowed: false,
        summary: "Owner must decide product scope before approval."
      }))}\n`,
      stderr: ""
    })),
    now: fixture.now
  })

  assert.equal(result.run.status, "review_changes_requested")
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(latestReviewEvidence(result.run).metadata.decision, REVIEW_DECISIONS.OWNER_ACTION_REQUIRED)
  assert.equal(latestReviewEvidence(result.run).metadata.mergeAllowed, false)
})

test("malformed, contradictory, and reviewedSha-mismatched output fails closed", async () => {
  for (const [reviewResult, code] of [
    [{ exitCode: 0, stdout: "not json" }, "REVIEW_OUTPUT_INVALID"],
    [{ exitCode: 0, stdout: `${JSON.stringify(decision("c".repeat(40)))}\n` }, "REVIEW_SHA_MISMATCH"],
    [{ exitCode: 0, stdout: null, makeStdout: (sha) => `${JSON.stringify(decision(sha, { blockers: ["blocker"] }))}\n` }, "REVIEW_OUTPUT_CONTRADICTORY"],
    [{ exitCode: 0, stdout: null, makeStdout: (sha) => `${JSON.stringify(decision(sha, { decision: REVIEW_DECISIONS.CHANGES_REQUESTED, mergeAllowed: true }))}\n` }, "REVIEW_OUTPUT_CONTRADICTORY"],
    [{ exitCode: 0, stdout: null, makeStdout: (sha) => `${JSON.stringify(decision(sha, { decision: REVIEW_DECISIONS.OWNER_ACTION_REQUIRED, mergeAllowed: true }))}\n` }, "REVIEW_OUTPUT_CONTRADICTORY"]
  ]) {
    const fixture = await makeTestsPassedFixture()
    const result = {
      ...reviewResult,
      stdout: reviewResult.makeStdout ? reviewResult.makeStdout(fixture.headSha) : reviewResult.stdout
    }

    await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      reviewConfig: trustedReviewConfig(),
      reviewRunner: makeReviewRunner(async () => result),
      now: fixture.now
    }), code)

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(reloaded.status, "review_changes_requested")
    assert.equal(latestReviewEvidence(reloaded).metadata.decision, REVIEW_DECISIONS.OWNER_ACTION_REQUIRED)
    assert.equal(latestReviewEvidence(reloaded).metadata.mergeAllowed, false)
  }
})

test("timeout, signal, and output overflow record bounded ambiguity requiring recovery", async () => {
  for (const ambiguousResult of [
    { timedOut: true, killed: true, ambiguous: true },
    { exitCode: null, signal: "SIGTERM" },
    { exitCode: 0, stdout: "x".repeat(4097), stderr: "" }
  ]) {
    const fixture = await makeTestsPassedFixture()

    await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      reviewConfig: trustedReviewConfig({ maxOutputBytes: 4096 }),
      reviewRunner: makeReviewRunner(async () => ambiguousResult),
      now: fixture.now
    }), "REVIEW_EXECUTION_AMBIGUOUS")

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(reloaded.status, "review_in_progress")
    assert.equal(reloaded.attempts.review, 1)
    assert.equal(latestReviewEvidence(reloaded).metadata.outcome, "review_execution_ambiguous")
    assert.equal(typeof latestReviewEvidence(reloaded).metadata.failureClass, "string")
    assert.equal(latestReviewEvidence(reloaded).metadata.attempt, 1)
    assert.equal(latestReviewEvidence(reloaded).metadata.reviewedSha, fixture.headSha)

    const reconciliation = await reconcileIndependentReview(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry
    })

    assert.equal(reconciliation.openAttempt, false)
    assert.equal(reconciliation.ambiguousAttempt, true)
    assert.equal(reconciliation.status, "ambiguous_attempt")
    assert.equal(reconciliation.facts.headSha, fixture.headSha)

    await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
      expectedVersion: reloaded.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      reviewConfig: trustedReviewConfig(),
      reviewRunner: makeReviewRunner()
    }), "REVIEW_RECONCILIATION_REQUIRED")
  }
})

test("reviewer file or commit mutation blocks approval and records metadata-only evidence", async () => {
  const dirty = await makeTestsPassedFixture()

  await assertRejectsCode(executeIndependentReview(dirty.run.runId, {
    expectedVersion: dirty.run.version,
    writeDataDir: dirty.writeDataDir,
    workspaceRegistry: dirty.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async (invocation) => {
      await writeFile(join(invocation.cwd, "review-artifact.txt"), "artifact\n", "utf8")
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(decision(dirty.headSha))}\n`,
        stderr: ""
      }
    }),
    now: dirty.now
  }), "REVIEW_WORKSPACE_DIRTY")

  const dirtyReloaded = await readDevelopmentRun(dirty.run.runId, {
    writeDataDir: dirty.writeDataDir
  })

  assert.equal(dirtyReloaded.status, "review_changes_requested")
  assert.equal(latestReviewEvidence(dirtyReloaded).metadata.decision, REVIEW_DECISIONS.CHANGES_REQUESTED)
  assert.equal(latestReviewEvidence(dirtyReloaded).metadata.mergeAllowed, false)

  const changed = await makeTestsPassedFixture()

  await assertRejectsCode(executeIndependentReview(changed.run.runId, {
    expectedVersion: changed.run.version,
    writeDataDir: changed.writeDataDir,
    workspaceRegistry: changed.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async (invocation) => {
      await writeFile(join(invocation.cwd, "review-commit.txt"), "changed\n", "utf8")
      await git(["add", "review-commit.txt"], invocation.cwd)
      await git(["commit", "-m", "unexpected review mutation"], invocation.cwd)
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(decision(changed.headSha))}\n`,
        stderr: ""
      }
    }),
    now: changed.now
  }), "REVIEW_WORKSPACE_HEAD_MISMATCH")
})

test("bounded durable review attempts are enforced across implementation cycles", async () => {
  const fixture = await makeTestsPassedFixture()
  let current = fixture.run

  for (let attempt = 1; attempt <= MAX_INDEPENDENT_REVIEW_ATTEMPTS; attempt += 1) {
    await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
      expectedVersion: current.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      reviewConfig: trustedReviewConfig(),
      reviewRunner: makeReviewRunner(async () => ({
        exitCode: 0,
        stdout: "not json"
      })),
      now: fixture.now
    }), "REVIEW_OUTPUT_INVALID")

    current = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(current.status, "review_changes_requested")
    assert.equal(current.attempts.review, attempt)

    if (attempt < MAX_INDEPENDENT_REVIEW_ATTEMPTS) {
      current = await transitionDevelopmentRun(current.runId, {
        expectedVersion: current.version,
        status: "implementation_in_progress",
        actor: "test-cycle"
      }, {
        writeDataDir: fixture.writeDataDir,
        now: fixture.now
      })
      current = await transitionDevelopmentRun(current.runId, {
        expectedVersion: current.version,
        status: "implementation_ready",
        branch: fixture.location.branch,
        headSha: fixture.headSha,
        actor: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
        evidence: [{
          kind: "implementation",
          sha: fixture.headSha,
          source: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
          metadata: {
            project: fixture.project.id,
            adapter: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
            attempt,
            outcome: "implementation_ready"
          }
        }]
      }, {
        writeDataDir: fixture.writeDataDir,
        now: fixture.now
      })
      current = await transitionDevelopmentRun(current.runId, {
        expectedVersion: current.version,
        status: "tests_in_progress",
        actor: PHASE_6E_TEST_EVIDENCE_SOURCE
      }, {
        writeDataDir: fixture.writeDataDir,
        now: fixture.now
      })
      current = await transitionDevelopmentRun(current.runId, {
        expectedVersion: current.version,
        status: "tests_passed",
        branch: fixture.location.branch,
        headSha: fixture.headSha,
        actor: PHASE_6E_TEST_EVIDENCE_SOURCE,
        evidence: [{
          kind: "test",
          sha: fixture.headSha,
          source: PHASE_6E_TEST_EVIDENCE_SOURCE,
          metadata: {
            project: fixture.project.id,
            runner: PHASE_6E_TEST_EVIDENCE_SOURCE,
            attempt,
            policyId: "phase-6e-local-node-policy",
            policyHash: "b".repeat(64),
            implSha: fixture.headSha,
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
    }
  }

  current = await transitionDevelopmentRun(current.runId, {
    expectedVersion: current.version,
    status: "implementation_in_progress",
    actor: "test-cycle"
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  current = await transitionDevelopmentRun(current.runId, {
    expectedVersion: current.version,
    status: "implementation_ready",
    branch: fixture.location.branch,
    headSha: fixture.headSha,
    actor: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
    evidence: [{
      kind: "implementation",
      sha: fixture.headSha,
      source: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
      metadata: {
        project: fixture.project.id,
        adapter: PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
        attempt: 6,
        outcome: "implementation_ready"
      }
    }]
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  current = await transitionDevelopmentRun(current.runId, {
    expectedVersion: current.version,
    status: "tests_in_progress",
    actor: PHASE_6E_TEST_EVIDENCE_SOURCE
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  current = await transitionDevelopmentRun(current.runId, {
    expectedVersion: current.version,
    status: "tests_passed",
    branch: fixture.location.branch,
    headSha: fixture.headSha,
    actor: PHASE_6E_TEST_EVIDENCE_SOURCE,
    evidence: [{
      kind: "test",
      sha: fixture.headSha,
      source: PHASE_6E_TEST_EVIDENCE_SOURCE,
      metadata: {
        project: fixture.project.id,
        runner: PHASE_6E_TEST_EVIDENCE_SOURCE,
        attempt: 6,
        policyId: "phase-6e-local-node-policy",
        policyHash: "b".repeat(64),
        implSha: fixture.headSha,
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

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    expectedVersion: current.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner()
  }), "REVIEW_ATTEMPT_LIMIT_REACHED")
})

test("optimistic concurrency allows only one reviewer to reserve the exact run version", async () => {
  const fixture = await makeTestsPassedFixture()
  const calls = []
  const options = {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(fixture.headSha))}\n`
    }), { calls }),
    now: fixture.now
  }
  const results = await Promise.allSettled([
    executeIndependentReview(fixture.run.runId, options),
    executeIndependentReview(fixture.run.runId, options)
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => (
    result.status === "rejected" &&
    result.reason instanceof DevelopmentRunStateError &&
    result.reason.code === "STALE_RUN_VERSION"
  )).length, 1)
  assert.equal(calls.filter((call) => call.kind === "review").length, 1)
})

test("read-only reconciliation invalidates prior approval when SHA or PASS evidence changes", async () => {
  const fixture = await makeTestsPassedFixture()
  const result = await executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(fixture.headSha))}\n`
    })),
    now: fixture.now
  })

  assert.equal(result.run.status, "review_passed")

  await writeFile(join(fixture.location.workspacePath, "after-review.txt"), "changed\n", "utf8")
  await git(["add", "after-review.txt"], fixture.location.workspacePath)
  await git(["commit", "-m", "invalidate review evidence"], fixture.location.workspacePath)

  const reconciliation = await reconcileIndependentReview(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })

  assert.equal(reconciliation.approvalValid, false)
  assert.equal(reconciliation.status, "head_changed")
  assert.equal(reconciliation.facts.expectedHeadSha, fixture.headSha)
})

test("Linux review sandbox policy uses namespace, read-only wrapper, and privilege-drop argv before reviewer execution", async () => {
  const fixture = await makeTestsPassedFixture()
  const calls = []
  const result = await executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig({
      sandbox: trustedLinuxSandbox()
    }),
    reviewRunner: makeReviewRunner(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(fixture.headSha))}\n`
    }), { calls }),
    now: fixture.now
  })

  assert.equal(result.run.status, "review_passed")
  assert.deepEqual(calls.map((call) => call.probe || call.kind), [
    "linux-privilege-boundary",
    "local-process",
    "workspace-read",
    "workspace-file-write",
    "source-file-write",
    "workspace-git-mutation",
    "direct-network",
    "review"
  ])

  for (const call of calls) {
    assert.equal(call.sandbox.type, REVIEW_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE)
    assert.equal(call.sandbox.platform, "linux")
    assert.equal(call.sandbox.enforcement, "os-network-namespace")
    assert.equal(call.sandboxArgs[0], `--net=${TRUSTED_LINUX_NAMESPACE_PATH}`)
    assert.equal(call.sandboxArgs[1], TRUSTED_LINUX_READONLY_WRAPPER_EXECUTABLE)
    assert.equal(call.readOnlyPaths.includes(fixture.location.workspacePath), true)
    assert.equal(call.readOnlyPaths.includes(fixture.sourceRepoPath), true)
    const readOnlySeparator = call.sandboxArgs.indexOf("--", 2)
    assert.deepEqual(call.sandboxArgs.slice(2, readOnlySeparator), call.readOnlyPaths.flatMap((entry) => [
      "--read-only-path",
      entry
    ]))
    assert.equal(call.sandboxArgs[readOnlySeparator + 1], TRUSTED_LINUX_SETPRIV_EXECUTABLE)
    assert.deepEqual(call.sandboxArgs.slice(readOnlySeparator + 2, readOnlySeparator + 10), [
      "--no-new-privs",
      `--reuid=${TRUSTED_LINUX_RUN_AS_UID}`,
      `--regid=${TRUSTED_LINUX_RUN_AS_GID}`,
      "--clear-groups",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--"
    ])
  }

  const started = result.run.evidence.review.find((entry) => entry.metadata.outcome === "review_started")
  assert.equal(started.metadata.sandbox, INDEPENDENT_REVIEW_SANDBOX_ID)
  assert.equal(started.metadata.backend, REVIEW_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE)
  assert.equal(started.metadata.platform, "linux")
  assert.equal(started.metadata.network, "none")
  assert.equal(started.metadata.readOnlyWorkspace, true)
})

test("Codex native Linux review sandbox keeps probes read-only and invokes the fixed reviewer directly", async () => {
  const fixture = await makeTestsPassedFixture()
  const calls = []
  const result = await executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig({
      sandbox: trustedNativeLinuxSandbox()
    }),
    reviewRunner: makeReviewRunner(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(fixture.headSha))}\n`
    }), { calls }),
    now: fixture.now
  })

  assert.equal(result.run.status, "review_passed")
  assert.deepEqual(calls.map((call) => call.probe || call.kind), [
    "local-process",
    "workspace-read",
    "workspace-file-write",
    "source-file-write",
    "workspace-git-mutation",
    "direct-network",
    "review"
  ])

  for (const call of calls.filter((entry) => entry.kind === "sandbox-probe")) {
    assert.deepEqual(call.sandboxArgs.slice(0, 8), [
      "sandbox",
      "--config",
      `projects."${call.cwd}".trust_level="untrusted"`,
      "--permission-profile",
      ":read-only",
      "--cd",
      call.cwd,
      "--"
    ])
  }

  const reviewCall = calls.find((call) => call.kind === "review")
  assert.ok(reviewCall)
  assert.equal(reviewCall.sandboxCommand.executablePath, process.execPath)
  assert.deepEqual(reviewCall.sandboxCommand.args, trustedReviewConfig().args)
})

test("sandbox must be active before review attempt reservation", async () => {
  const fixture = await makeTestsPassedFixture()

  await assertRejectsCode(executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(fixture.headSha))}\n`
    }), { networkInactive: true })
  }), "REVIEW_SANDBOX_UNAVAILABLE")

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(reloaded.status, "tests_passed")
  assert.equal(reloaded.attempts.review, 0)

  for (const options of [
    { workspaceWriteAllowed: true },
    { sourceWriteAllowed: true },
    { gitMutationAllowed: true }
  ]) {
    const unsafe = await makeTestsPassedFixture()
    const calls = []
    const sourceHeadBefore = await git(["rev-parse", "HEAD"], unsafe.sourceRepoPath)
    const sourceStatusBefore = await git(["status", "--porcelain=v1", "--untracked-files=all"], unsafe.sourceRepoPath)

    await assertRejectsCode(executeIndependentReview(unsafe.run.runId, {
      expectedVersion: unsafe.run.version,
      writeDataDir: unsafe.writeDataDir,
      workspaceRegistry: unsafe.registry,
      reviewConfig: trustedReviewConfig(),
      reviewRunner: makeReviewRunner(async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(decision(unsafe.headSha))}\n`
      }), { ...options, calls })
    }), "REVIEW_SANDBOX_UNAVAILABLE")

    const unsafeReloaded = await readDevelopmentRun(unsafe.run.runId, {
      writeDataDir: unsafe.writeDataDir
    })

    assert.equal(unsafeReloaded.status, "tests_passed")
    assert.equal(unsafeReloaded.attempts.review, 0)
    assert.equal(calls.some((call) => call.kind === "review"), false)
    assert.equal(calls.some((call) => call.probe === "workspace-file-write"), true)
    assert.equal(calls.some((call) => call.probe === "source-file-write"), !options.workspaceWriteAllowed)
    assert.equal(calls.some((call) => call.probe === "workspace-git-mutation"), Boolean(options.gitMutationAllowed))
    assert.equal(await git(["rev-parse", "HEAD"], unsafe.sourceRepoPath), sourceHeadBefore)
    assert.equal(await git(["status", "--porcelain=v1", "--untracked-files=all"], unsafe.sourceRepoPath), sourceStatusBefore)
  }
})

test("independent review agent adds no implementation adapter, GitHub write, push, merge, deploy, or OpenClaw path", async () => {
  const fixture = await makeTestsPassedFixture()
  const calls = []

  await executeIndependentReview(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    reviewConfig: trustedReviewConfig(),
    reviewRunner: makeReviewRunner(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(decision(fixture.headSha))}\n`
    }), { calls }),
    now: fixture.now
  })

  const reviewExecutables = calls.filter((call) => call.kind === "review").map((call) => call.executablePath)

  assert.deepEqual(reviewExecutables, [process.execPath])
  assert.equal(calls.some((call) => /gh|openclaw|docker|kubectl|systemctl/u.test(call.executablePath)), false)
})
