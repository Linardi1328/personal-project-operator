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
  createDevelopmentRun,
  readDevelopmentRun,
  resolveDevelopmentRunProject,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  prepareImplementationWorkspace,
  resolveImplementationWorkspaceLocation
} from "./development-workspace-manager.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  AUTOMATED_TEST_SANDBOX_ID,
  MAX_AUTOMATED_TEST_ATTEMPTS,
  MAX_AUTOMATED_TEST_STEPS,
  MAX_TEST_OUTPUT_BYTES,
  PHASE_6D_IMPLEMENTATION_EVIDENCE_SOURCE,
  TEST_SANDBOX_BACKENDS,
  executeAutomatedTests,
  reconcileAutomatedTesting
} from "./development-test-runner.mjs"

const execFileAsync = promisify(execFile)
const TRUSTED_GIT_EXECUTABLE = process.env.PPO_TEST_GIT_EXECUTABLE || "/usr/bin/git"
const TRUSTED_MACOS_SANDBOX_EXECUTABLE = process.env.PPO_TEST_SANDBOX_EXECUTABLE || "/usr/bin/sandbox-exec"
const TRUSTED_LINUX_SANDBOX_EXECUTABLE = process.env.PPO_TEST_LINUX_SANDBOX_EXECUTABLE || "/usr/bin/nsenter"
const TRUSTED_LINUX_SETPRIV_EXECUTABLE = process.env.PPO_TEST_LINUX_SETPRIV_EXECUTABLE || "/usr/bin/setpriv"
const TRUSTED_LINUX_NAMESPACE_PATH = process.env.PPO_TEST_LINUX_NAMESPACE_PATH || "/run/netns/ppo-tests-no-network"
const TRUSTED_LINUX_RUN_AS_UID = 1000
const TRUSTED_LINUX_RUN_AS_GID = 1000

function makeClock() {
  let tick = 0
  const start = Date.parse("2026-08-21T10:00:00.000Z")

  return () => {
    const next = new Date(start + tick * 1000)
    tick += 1
    return next
  }
}

async function canonicalTempRoot(label = "ppo-6e-") {
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
    task: options.task || "Implement the next approved local operator phase.",
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
        outcome: "implementation_ready"
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

function trustedSandbox(overrides = {}) {
  return {
    type: TEST_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
    platform: "darwin",
    network: "none",
    enforcement: "os-process",
    executablePath: TRUSTED_MACOS_SANDBOX_EXECUTABLE,
    ...overrides
  }
}

function trustedLinuxSandbox(overrides = {}) {
  return {
    type: TEST_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
    platform: "linux",
    network: "none",
    enforcement: "os-network-namespace",
    executablePath: TRUSTED_LINUX_SANDBOX_EXECUTABLE,
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
    type: TEST_SANDBOX_BACKENDS.CODEX_NATIVE_LINUX,
    platform: "linux",
    network: "none",
    enforcement: "codex-command-sandbox",
    executablePath: process.execPath,
    permissionProfile: ":workspace",
    ...overrides
  }
}

function testStep(overrides = {}) {
  return {
    id: "unit",
    executablePath: process.execPath,
    args: ["--eval", "process.exit(0)"],
    timeoutMs: 2000,
    maxOutputBytes: 2048,
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
      sandbox: trustedSandbox(),
      steps: [testStep()],
      ...overrides
    }
  }
}

function makeSandboxRunner(testRunner = async () => ({ exitCode: 0 }), options = {}) {
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

      if (invocation.probe === "direct-network") {
        if (options.networkInactive) {
          return { exitCode: 66, stdout: "connected", stderr: "" }
        }

        return { exitCode: 0, sandboxDenied: true, stdout: "", stderr: "" }
      }
    }

    return await testRunner(invocation)
  }
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

function latestTestEvidence(run) {
  return run.evidence.test.at(-1)
}

test("automated tests require implementation_ready, exact expected version, and matching Phase 6D implementation evidence", async () => {
  const source = await makeSourceRepo()
  const planned = await makePlannedRun(source)
  const calls = []

  await assertRejectsCode(executeAutomatedTests(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: source.writeDataDir,
    workspaceRegistry: source.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(source),
    sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 }), { calls })
  }), "TEST_RUN_NOT_READY")

  const fixture = await makeImplementationReadyFixture()

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_EXPECTED_VERSION_REQUIRED")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version - 1,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeSandboxRunner()
  }), "STALE_RUN_VERSION")

  const missingEvidence = await makeImplementationReadyFixture({ implementationEvidence: false })

  await assertRejectsCode(executeAutomatedTests(missingEvidence.run.runId, {
    expectedVersion: missingEvidence.run.version,
    writeDataDir: missingEvidence.writeDataDir,
    workspaceRegistry: missingEvidence.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(missingEvidence),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_IMPLEMENTATION_EVIDENCE_MISMATCH")

  const mismatchedEvidence = await makeImplementationReadyFixture({
    implementationEvidenceSha: fixture.baseSha
  })

  await assertRejectsCode(executeAutomatedTests(mismatchedEvidence.run.runId, {
    expectedVersion: mismatchedEvidence.run.version,
    writeDataDir: mismatchedEvidence.writeDataDir,
    workspaceRegistry: mismatchedEvidence.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(mismatchedEvidence),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_IMPLEMENTATION_EVIDENCE_MISMATCH")

  assert.equal(calls.length, 0)
})

test("workspace reconciliation requires the exact isolated branch, HEAD, and a clean workspace", async () => {
  const detached = await makeImplementationReadyFixture()

  await git(["checkout", "--detach"], detached.location.workspacePath)
  await assertRejectsCode(executeAutomatedTests(detached.run.runId, {
    expectedVersion: detached.run.version,
    writeDataDir: detached.writeDataDir,
    workspaceRegistry: detached.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(detached),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_WORKSPACE_BRANCH_MISMATCH")

  const advanced = await makeImplementationReadyFixture()
  await writeFile(join(advanced.location.workspacePath, "advanced.txt"), "advanced\n", "utf8")
  await git(["add", "advanced.txt"], advanced.location.workspacePath)
  await git(["commit", "-m", "unexpected head change"], advanced.location.workspacePath)

  await assertRejectsCode(executeAutomatedTests(advanced.run.runId, {
    expectedVersion: advanced.run.version,
    writeDataDir: advanced.writeDataDir,
    workspaceRegistry: advanced.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(advanced),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_WORKSPACE_HEAD_MISMATCH")

  const dirty = await makeImplementationReadyFixture()
  await writeFile(join(dirty.location.workspacePath, "dirty.txt"), "dirty\n", "utf8")

  await assertRejectsCode(executeAutomatedTests(dirty.run.runId, {
    expectedVersion: dirty.run.version,
    writeDataDir: dirty.writeDataDir,
    workspaceRegistry: dirty.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(dirty),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_WORKSPACE_DIRTY")
})

test("trusted project test policy refuses arbitrary commands, shell execution, unsafe env, and unbounded steps", async () => {
  const fixture = await makeImplementationReadyFixture()

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_REQUIRED")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      steps: [{
        id: "bad",
        command: "npm test",
        timeoutMs: 2000
      }]
    }),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_ARBITRARY_COMMAND_REFUSED")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      steps: [testStep({ shell: true })]
    }),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_ARBITRARY_COMMAND_REFUSED")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      steps: [testStep({ executablePath: "/bin/echo" })]
    }),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_UNTRUSTED_EXECUTABLE")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      trustedExecutablePaths: ["/bin/sh"],
      steps: [testStep({ executablePath: "/bin/sh" })]
    }),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_UNTRUSTED_EXECUTABLE")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      env: {
        GITHUB_TOKEN: "gho_fake"
      }
    }),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_INVALID")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      steps: Array.from({ length: MAX_AUTOMATED_TEST_STEPS + 1 }, (_, index) => testStep({ id: `step-${index}` }))
    }),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_TOO_MANY_STEPS")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      steps: [testStep({ timeoutMs: 1 })]
    }),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_INVALID")

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      steps: [testStep({ maxOutputBytes: MAX_TEST_OUTPUT_BYTES + 1 })]
    }),
    sandboxRunner: makeSandboxRunner()
  }), "TEST_POLICY_INVALID")
})

test("passing tests use explicit argv with shell=false, sanitized env, no-network sandbox, and SHA-pinned metadata-only evidence", async () => {
  const fixture = await makeImplementationReadyFixture()
  const calls = []
  const previousSecret = process.env.PPO_SECRET_TOKEN

  process.env.PPO_SECRET_TOKEN = "SENSITIVE_TEST_SENTINEL"

  try {
    const result = await executeAutomatedTests(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      testPolicyRegistry: trustedTestPolicyRegistry(fixture),
      sandboxRunner: makeSandboxRunner(async () => ({
        exitCode: 0,
        stdout: "SENSITIVE_TEST_SENTINEL gho_fake_token",
        stderr: "raw stderr ignored"
      }), { calls }),
      now: fixture.now
    })

    assert.equal(result.ok, true)
    assert.equal(result.run.status, "tests_passed")
    assert.equal(result.run.headSha, fixture.headSha)
    assert.equal(result.run.attempts.test, 1)

    const testCalls = calls.filter((call) => call.kind === "test")
    assert.equal(testCalls.length, 1)
    assert.equal(testCalls[0].cwd, fixture.location.workspacePath)
    assert.equal(testCalls[0].shell, false)
    assert.equal(testCalls[0].executablePath, process.execPath)
    assert.deepEqual(testCalls[0].args, ["--eval", "process.exit(0)"])
    assert.equal(testCalls[0].env.PPO_SAFE_TEST_FLAG, "1")
    assert.equal(Object.hasOwn(testCalls[0].env, "PPO_SECRET_TOKEN"), false)
    assert.equal(Object.hasOwn(testCalls[0].env, "GITHUB_TOKEN"), false)
    assert.equal(testCalls[0].sandbox.network, "none")

    assert.deepEqual(calls.map((call) => call.probe || call.kind), [
      "local-process",
      "direct-network",
      "test"
    ])

    const evidenceText = JSON.stringify(result.run.evidence.test)
    assert.doesNotMatch(evidenceText, /SENSITIVE_TEST_SENTINEL|raw stderr|stdout|stderr|token|credential/u)
    assert.doesNotMatch(evidenceText, new RegExp(fixture.location.workspacePath.replaceAll("/", "\\/"), "u"))

    const aggregate = latestTestEvidence(result.run)
    assert.equal(aggregate.sha, fixture.headSha)
    assert.equal(aggregate.metadata.runner, AUTOMATED_TEST_RUNNER_ID)
    assert.equal(aggregate.metadata.implSha, fixture.headSha)
    assert.equal(aggregate.metadata.outcome, "passed")
    assert.match(aggregate.metadata.policyHash, /^[a-f0-9]{64}$/u)
    assert.equal(aggregate.metadata.sandbox, AUTOMATED_TEST_SANDBOX_ID)
    assert.equal(aggregate.metadata.network, "none")
  } finally {
    if (previousSecret === undefined) {
      delete process.env.PPO_SECRET_TOKEN
    } else {
      process.env.PPO_SECRET_TOKEN = previousSecret
    }
  }
})

test("one required test failure remains tests_in_progress with metadata-only failed evidence", async () => {
  const fixture = await makeImplementationReadyFixture()
  const registry = trustedTestPolicyRegistry(fixture, {
    steps: [
      testStep({ id: "unit" }),
      testStep({ id: "integration", args: ["--eval", "process.exit(1)"] })
    ]
  })

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: registry,
    sandboxRunner: makeSandboxRunner(async (invocation) => ({
      exitCode: invocation.testId === "integration" ? 1 : 0,
      stdout: "failure details are discarded",
      stderr: "raw failure is discarded"
    })),
    now: fixture.now
  }), "TEST_POLICY_FAILED")

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  const latest = latestTestEvidence(reloaded)

  assert.equal(reloaded.status, "tests_in_progress")
  assert.equal(reloaded.attempts.test, 1)
  assert.equal(latest.metadata.outcome, "failed")
  assert.equal(latest.sha, fixture.headSha)
  assert.doesNotMatch(JSON.stringify(reloaded.evidence.test), /failure details|raw failure|stdout|stderr/u)
})

test("timeout, signal, and output overflow leave an open attempt requiring read-only reconciliation before retry", async () => {
  for (const ambiguousResult of [
    { timedOut: true, killed: true, ambiguous: true },
    { exitCode: null, signal: "SIGTERM" },
    { exitCode: 0, stdout: "x".repeat(2050), stderr: "" }
  ]) {
    const fixture = await makeImplementationReadyFixture()

    await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
        steps: [testStep({ maxOutputBytes: 2048 })]
      }),
      sandboxRunner: makeSandboxRunner(async () => ambiguousResult),
      now: fixture.now
    }), "TEST_EXECUTION_AMBIGUOUS")

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(reloaded.status, "tests_in_progress")
    assert.equal(reloaded.attempts.test, 1)
    assert.equal(latestTestEvidence(reloaded).metadata.outcome, "testing_started")

    const reconciliation = await reconcileAutomatedTesting(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry
    })

    assert.equal(reconciliation.openAttempt, true)
    assert.equal(reconciliation.status, "open_attempt")
    assert.equal(reconciliation.facts.headSha, fixture.headSha)

    await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
      expectedVersion: reloaded.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      testPolicyRegistry: trustedTestPolicyRegistry(fixture),
      sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 }))
    }), "TEST_RECONCILIATION_REQUIRED")
  }
})

test("dirty workspace or HEAD changes during testing invalidate PASS evidence", async () => {
  const dirty = await makeImplementationReadyFixture()

  await assertRejectsCode(executeAutomatedTests(dirty.run.runId, {
    expectedVersion: dirty.run.version,
    writeDataDir: dirty.writeDataDir,
    workspaceRegistry: dirty.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(dirty),
    sandboxRunner: makeSandboxRunner(async (invocation) => {
      await writeFile(join(invocation.cwd, "test-artifact.txt"), "artifact\n", "utf8")
      return { exitCode: 0 }
    }),
    now: dirty.now
  }), "TEST_WORKSPACE_DIRTY")

  const dirtyReloaded = await readDevelopmentRun(dirty.run.runId, {
    writeDataDir: dirty.writeDataDir
  })

  assert.equal(dirtyReloaded.status, "tests_in_progress")
  assert.equal(latestTestEvidence(dirtyReloaded).metadata.outcome, "workspace_dirty")

  const changed = await makeImplementationReadyFixture()

  await assertRejectsCode(executeAutomatedTests(changed.run.runId, {
    expectedVersion: changed.run.version,
    writeDataDir: changed.writeDataDir,
    workspaceRegistry: changed.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(changed),
    sandboxRunner: makeSandboxRunner(async (invocation) => {
      await writeFile(join(invocation.cwd, "mutated.txt"), "mutated\n", "utf8")
      await git(["add", "mutated.txt"], invocation.cwd)
      await git(["commit", "-m", "unexpected test mutation"], invocation.cwd)
      return { exitCode: 0 }
    }),
    now: changed.now
  }), "TEST_WORKSPACE_HEAD_MISMATCH")

  const changedReloaded = await readDevelopmentRun(changed.run.runId, {
    writeDataDir: changed.writeDataDir
  })

  assert.equal(changedReloaded.status, "tests_in_progress")
  assert.equal(latestTestEvidence(changedReloaded).metadata.outcome, "workspace_changed")
})

test("testing attempts are durable, bounded, and retryable only after definitive failed evidence", async () => {
  const fixture = await makeImplementationReadyFixture()

  for (let attempt = 1; attempt <= MAX_AUTOMATED_TEST_ATTEMPTS; attempt += 1) {
    const current = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
      expectedVersion: current.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
        steps: [testStep({ args: ["--eval", "process.exit(1)"] })]
      }),
      sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 1 })),
      now: fixture.now
    }), "TEST_POLICY_FAILED")

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(reloaded.status, "tests_in_progress")
    assert.equal(reloaded.attempts.test, attempt)
    assert.equal(latestTestEvidence(reloaded).metadata.outcome, "failed")
  }

  const exhausted = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: exhausted.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 }))
  }), "TEST_ATTEMPT_LIMIT_REACHED")
})

test("optimistic concurrency allows only one final PASS transition for a run version", async () => {
  const fixture = await makeImplementationReadyFixture()
  const options = {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 })),
    now: fixture.now
  }
  const results = await Promise.allSettled([
    executeAutomatedTests(fixture.run.runId, options),
    executeAutomatedTests(fixture.run.runId, options)
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => (
    result.status === "rejected" &&
    result.reason instanceof DevelopmentRunStateError &&
    result.reason.code === "STALE_RUN_VERSION"
  )).length, 1)

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(reloaded.status, "tests_passed")
  assert.equal(reloaded.attempts.test, 1)
})

test("read-only reconciliation invalidates prior PASS evidence when workspace HEAD changes", async () => {
  const fixture = await makeImplementationReadyFixture()
  const result = await executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 })),
    now: fixture.now
  })

  assert.equal(result.run.status, "tests_passed")

  await writeFile(join(fixture.location.workspacePath, "after-pass.txt"), "changed\n", "utf8")
  await git(["add", "after-pass.txt"], fixture.location.workspacePath)
  await git(["commit", "-m", "invalidate pass evidence"], fixture.location.workspacePath)

  const reconciliation = await reconcileAutomatedTesting(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })

  assert.equal(reconciliation.passEvidenceValid, false)
  assert.equal(reconciliation.status, "head_changed")
  assert.equal(reconciliation.facts.expectedHeadSha, fixture.headSha)
})

test("Linux test sandbox policy uses namespace and privilege-drop argv before executing tests", async () => {
  const fixture = await makeImplementationReadyFixture()
  const calls = []
  const result = await executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      sandbox: trustedLinuxSandbox()
    }),
    sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 }), { calls }),
    now: fixture.now
  })

  assert.equal(result.run.status, "tests_passed")
  assert.deepEqual(calls.map((call) => call.probe || call.kind), [
    "linux-privilege-boundary",
    "local-process",
    "direct-network",
    "test"
  ])

  for (const call of calls) {
    assert.equal(call.sandbox.type, TEST_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE)
    assert.equal(call.sandbox.platform, "linux")
    assert.equal(call.sandbox.enforcement, "os-network-namespace")
    assert.equal(call.sandboxArgs[0], `--net=${TRUSTED_LINUX_NAMESPACE_PATH}`)
    assert.equal(call.sandboxArgs[1], TRUSTED_LINUX_SETPRIV_EXECUTABLE)
    assert.deepEqual(call.sandboxArgs.slice(2, 10), [
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

  const started = result.run.evidence.test.find((entry) => entry.metadata.outcome === "testing_started")
  assert.equal(started.metadata.sandbox, AUTOMATED_TEST_SANDBOX_ID)
  assert.equal(started.metadata.backend, TEST_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE)
  assert.equal(started.metadata.platform, "linux")
  assert.equal(started.metadata.network, "none")
})

test("Codex native Linux test sandbox uses the fixed workspace permission profile", async () => {
  const fixture = await makeImplementationReadyFixture()
  const calls = []
  const result = await executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture, {
      sandbox: trustedNativeLinuxSandbox()
    }),
    sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 }), { calls }),
    now: fixture.now
  })

  assert.equal(result.run.status, "tests_passed")
  assert.deepEqual(calls.map((call) => call.probe || call.kind), [
    "local-process",
    "direct-network",
    "test"
  ])

  for (const call of calls) {
    assert.equal(call.sandbox.type, TEST_SANDBOX_BACKENDS.CODEX_NATIVE_LINUX)
    assert.equal(call.sandboxCommand.executablePath, process.execPath)
    assert.deepEqual(call.sandboxArgs.slice(0, 9), [
      "sandbox",
      "linux",
      "--config",
      `projects."${call.cwd}".trust_level="untrusted"`,
      "--permission-profile",
      ":workspace",
      "--cd",
      call.cwd,
      "--"
    ])
  }
})

test("sandbox must be active before attempt reservation and test execution", async () => {
  const fixture = await makeImplementationReadyFixture()

  await assertRejectsCode(executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 }), { networkInactive: true })
  }), "TEST_SANDBOX_UNAVAILABLE")

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(reloaded.status, "implementation_ready")
  assert.equal(reloaded.attempts.test, 0)
})

test("automated test runner adds no GitHub write, merge, deploy, or OpenClaw route", async () => {
  assert.equal(TRUSTED_GIT_EXECUTABLE.endsWith("/git") || TRUSTED_GIT_EXECUTABLE === "git", true)

  const fixture = await makeImplementationReadyFixture()
  const calls = []

  await executeAutomatedTests(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    testPolicyRegistry: trustedTestPolicyRegistry(fixture),
    sandboxRunner: makeSandboxRunner(async () => ({ exitCode: 0 }), { calls }),
    now: fixture.now
  })

  const invokedExecutables = calls.filter((call) => call.kind === "test").map((call) => call.executablePath)

  assert.deepEqual(invokedExecutables, [process.execPath])
  assert.equal(calls.some((call) => /gh|openclaw|docker|kubectl|systemctl/u.test(call.executablePath)), false)
})
