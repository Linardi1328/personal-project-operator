import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
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
  CODEX_EXECUTION_ADAPTER_ID,
  MAX_CODEX_OUTPUT_BYTES,
  MAX_CODEX_PROMPT_CHARS,
  buildCodexImplementationPrompt,
  executeCodexImplementation,
  formatDevelopmentCodexExecutionAdapterError,
  reconcileCodexExecution
} from "./development-codex-execution-adapter.mjs"

const execFileAsync = promisify(execFile)
const PROJECT_IDS = [
  "khlim-assist",
  "ledgerpilot-ai",
  "spy-market-agent",
  "portfolio",
  "rbl-content-engine"
]

function makeClock() {
  let tick = 0
  const start = Date.parse("2026-08-21T09:00:00.000Z")

  return () => {
    const next = new Date(start + tick * 1000)
    tick += 1
    return next
  }
}

async function canonicalTempRoot(label = "ppo-6d-") {
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

async function makeImplementationFixture(options = {}) {
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

function trustedCodexConfig(overrides = {}) {
  return {
    executablePath: process.execPath,
    args: ["--version"],
    timeoutMs: 1000,
    env: {},
    ...overrides
  }
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

function makeCommitRunner(calls, options = {}) {
  return async (invocation) => {
    calls.push({ ...invocation })
    const fileName = options.fileName || "implementation.txt"

    await writeFile(join(invocation.cwd, fileName), options.content || "implemented\n", "utf8")
    await git(["add", fileName], invocation.cwd)
    await git(["commit", "-m", options.message || "codex implementation"], invocation.cwd)

    if (options.sourceRepoPath) {
      await writeFile(join(options.sourceRepoPath, "source-mutated.txt"), "unexpected\n", "utf8")
      await git(["add", "source-mutated.txt"], options.sourceRepoPath)
      await git(["commit", "-m", "unexpected source mutation"], options.sourceRepoPath)
    }

    return {
      exitCode: 0,
      stdout: options.stdout || "SENSITIVE_TEST_SENTINEL gho_fake_token",
      stderr: options.stderr || "raw stderr ignored"
    }
  }
}

test("Phase 6D uses the fixed five-project allowlist through Phase 6A/6C state", () => {
  assert.equal(PROJECT_IDS.length, 5)

  for (const projectId of PROJECT_IDS) {
    const project = resolveDevelopmentRunProject(projectId)
    assert.equal(project.id, projectId)
    assert.match(project.fullName, /^Linardi1328\//u)
  }
})

test("Codex execution requires implementation_in_progress status and exact expected version", async () => {
  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)
  const calls = []

  await assertRejectsCode(executeCodexImplementation(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: makeCommitRunner(calls)
  }), "CODEX_RUN_NOT_IMPLEMENTING")

  const implementation = await makeImplementationFixture()

  await assertRejectsCode(executeCodexImplementation(implementation.run.runId, {
    writeDataDir: implementation.writeDataDir,
    workspaceRegistry: implementation.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: makeCommitRunner(calls)
  }), "CODEX_EXPECTED_VERSION_REQUIRED")

  await assertRejectsCode(executeCodexImplementation(implementation.run.runId, {
    expectedVersion: implementation.run.version - 1,
    writeDataDir: implementation.writeDataDir,
    workspaceRegistry: implementation.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: makeCommitRunner(calls)
  }), "STALE_RUN_VERSION")

  assert.equal(calls.length, 0)
})

test("Phase 6C workspace reconciliation is required before Codex execution", async () => {
  const missing = await makeImplementationFixture()
  await git(["worktree", "remove", "--force", missing.location.workspacePath], missing.sourceRepoPath)

  await assertRejectsCode(executeCodexImplementation(missing.run.runId, {
    expectedVersion: missing.run.version,
    writeDataDir: missing.writeDataDir,
    workspaceRegistry: missing.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: async () => ({ exitCode: 0 })
  }), "CODEX_WORKSPACE_NOT_READY")

  const detached = await makeImplementationFixture()
  await git(["checkout", "--detach"], detached.location.workspacePath)

  await assertRejectsCode(executeCodexImplementation(detached.run.runId, {
    expectedVersion: detached.run.version,
    writeDataDir: detached.writeDataDir,
    workspaceRegistry: detached.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: async () => ({ exitCode: 0 })
  }), "CODEX_WORKSPACE_NOT_READY")

  const linked = await makeImplementationFixture()
  const linkedRoot = join(linked.root, "linked-workspaces")
  await symlink(linked.workspaceRoot, linkedRoot)

  await assertRejectsCode(executeCodexImplementation(linked.run.runId, {
    expectedVersion: linked.run.version,
    writeDataDir: linked.writeDataDir,
    workspaceRegistry: {
      [linked.project.id]: {
        sourceRepoPath: linked.sourceRepoPath,
        workspaceRoot: linkedRoot
      }
    },
    codexConfig: trustedCodexConfig(),
    codexRunner: async () => ({ exitCode: 0 })
  }), "WORKSPACE_PATH_ESCAPE")
})

test("workspace HEAD must match run state before Codex starts", async () => {
  const fixture = await makeImplementationFixture()
  await writeFile(join(fixture.location.workspacePath, "preexisting.txt"), "advanced\n", "utf8")
  await git(["add", "preexisting.txt"], fixture.location.workspacePath)
  await git(["commit", "-m", "preexisting implementation"], fixture.location.workspacePath)

  const reconciliation = await reconcileCodexExecution(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })

  assert.equal(reconciliation.status, "advanced")
  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: async () => ({ exitCode: 0 })
  }), "CODEX_WORKSPACE_NOT_READY")
})

test("Codex invocation uses trusted config, explicit argv, shell=false, and verified workspace cwd", async () => {
  const fixture = await makeImplementationFixture()
  const calls = []
  const result = await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig({
      executablePath: process.execPath,
      args: ["--eval", "process.exit(0)"],
      timeoutMs: 2000
    }),
    codexRunner: makeCommitRunner(calls),
    now: fixture.now
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cwd, fixture.location.workspacePath)
  assert.equal(calls[0].shell, false)
  assert.deepEqual(calls[0].args, ["--eval", "process.exit(0)"])
  assert.equal(calls[0].executablePath, process.execPath)
  assert.match(calls[0].promptHash, /^[a-f0-9]{64}$/u)

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: result.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: {
      executablePath: "codex",
      args: []
    },
    codexRunner: async () => ({ exitCode: 0 })
  }), "CODEX_CONFIG_INVALID")

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: result.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexRunner: async () => ({ exitCode: 0 })
  }), "CODEX_CONFIG_REQUIRED")
})

test("implementation prompt is deterministic, bounded, scoped, and secret-excluding", async () => {
  const fixture = await makeImplementationFixture()
  const promptA = buildCodexImplementationPrompt(fixture.run, fixture.location)
  const promptB = buildCodexImplementationPrompt(fixture.run, fixture.location)

  assert.equal(promptA, promptB)
  assert.equal(promptA.length <= MAX_CODEX_PROMPT_CHARS, true)
  assert.match(promptA, /Do not push/u)
  assert.match(promptA, /Do not merge/u)
  assert.match(promptA, /Do not deploy/u)
  assert.match(promptA, /isolated branch/u)
  assert.doesNotMatch(promptA, /SENSITIVE_TEST_SENTINEL|gho_fake_token|PPO_GITHUB_WRITE_CONFIRM/u)

  assert.throws(() => buildCodexImplementationPrompt({
    ...fixture.run,
    task: "SENSITIVE_TEST_SENTINEL token=gho_fake_token"
  }, fixture.location), DevelopmentRunStateError)

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig({
      env: {
        GITHUB_TOKEN: "gho_fake_token"
      }
    }),
    codexRunner: async () => ({ exitCode: 0 })
  }), "CODEX_CONFIG_INVALID")
})

test("successful Codex execution is independently verified and transitions to implementation_ready", async () => {
  const fixture = await makeImplementationFixture()
  const sourceHeadBefore = await git(["rev-parse", "HEAD"], fixture.sourceRepoPath)
  const calls = []
  const result = await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: makeCommitRunner(calls),
    now: fixture.now
  })

  const finalHead = await git(["rev-parse", "HEAD"], fixture.location.workspacePath)
  const finalBranch = await git(["symbolic-ref", "--short", "HEAD"], fixture.location.workspacePath)
  const sourceHeadAfter = await git(["rev-parse", "HEAD"], fixture.sourceRepoPath)
  const ancestorCount = Number.parseInt(await git(["rev-list", "--ancestry-path", "--count", `${fixture.baseSha}..HEAD`], fixture.location.workspacePath), 10)

  assert.equal(result.run.status, "implementation_ready")
  assert.equal(result.run.headSha, finalHead)
  assert.equal(result.run.branch, fixture.run.branch)
  assert.equal(finalBranch, fixture.run.branch)
  assert.match(finalHead, /^[a-f0-9]{40}$/u)
  assert.equal(ancestorCount > 0, true)
  assert.equal(sourceHeadAfter, sourceHeadBefore)

  const evidence = result.run.evidence.implementation.at(-1)
  assert.equal(evidence.source, CODEX_EXECUTION_ADAPTER_ID)
  assert.equal(evidence.sha, finalHead)
  assert.equal(evidence.metadata.promptHash, result.implementation.promptHash)
  assert.equal(evidence.metadata.workspaceId, fixture.location.workspaceId)
  assert.equal(evidence.metadata.workspaceRef, fixture.location.workspaceRef)
  assert.equal(evidence.metadata.branch, fixture.run.branch)
  assert.equal(evidence.metadata.attempt, fixture.run.attempts.implementation)
  assert.equal(evidence.metadata.outcome, "implementation_ready")
  assert.doesNotMatch(JSON.stringify(result.run), /SENSITIVE_TEST_SENTINEL|gho_fake_token|raw stderr ignored/u)

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(reloaded.status, "implementation_ready")
  assert.equal(reloaded.headSha, finalHead)
})

test("Codex no-op, nonzero exit, dirty workspace, and source mutation leave run state unchanged", async () => {
  const noop = await makeImplementationFixture()
  await assertRejectsCode(executeCodexImplementation(noop.run.runId, {
    expectedVersion: noop.run.version,
    writeDataDir: noop.writeDataDir,
    workspaceRegistry: noop.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: async () => ({ exitCode: 0, stdout: "claimed success" })
  }), "CODEX_NO_IMPLEMENTATION")
  assert.equal((await readDevelopmentRun(noop.run.runId, { writeDataDir: noop.writeDataDir })).status, "implementation_in_progress")

  const nonzero = await makeImplementationFixture()
  await assertRejectsCode(executeCodexImplementation(nonzero.run.runId, {
    expectedVersion: nonzero.run.version,
    writeDataDir: nonzero.writeDataDir,
    workspaceRegistry: nonzero.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: async () => ({ exitCode: 1, stdout: "failed" })
  }), "CODEX_EXECUTION_FAILED")
  assert.equal((await readDevelopmentRun(nonzero.run.runId, { writeDataDir: nonzero.writeDataDir })).status, "implementation_in_progress")

  const dirty = await makeImplementationFixture()
  await assertRejectsCode(executeCodexImplementation(dirty.run.runId, {
    expectedVersion: dirty.run.version,
    writeDataDir: dirty.writeDataDir,
    workspaceRegistry: dirty.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: async (invocation) => {
      await writeFile(join(invocation.cwd, "dirty.txt"), "uncommitted\n", "utf8")
      return { exitCode: 0 }
    }
  }), "CODEX_IMPLEMENTATION_INVALID")
  assert.equal((await readDevelopmentRun(dirty.run.runId, { writeDataDir: dirty.writeDataDir })).status, "implementation_in_progress")

  const sourceChanged = await makeImplementationFixture()
  await assertRejectsCode(executeCodexImplementation(sourceChanged.run.runId, {
    expectedVersion: sourceChanged.run.version,
    writeDataDir: sourceChanged.writeDataDir,
    workspaceRegistry: sourceChanged.registry,
    codexConfig: trustedCodexConfig(),
    codexRunner: makeCommitRunner([], {
      sourceRepoPath: sourceChanged.sourceRepoPath
    })
  }), "CODEX_SOURCE_CHANGED")
  assert.equal((await readDevelopmentRun(sourceChanged.run.runId, { writeDataDir: sourceChanged.writeDataDir })).status, "implementation_in_progress")
})

test("ambiguous Codex timeout, signal, interruption, and output overflow leave state unchanged", async () => {
  for (const outcome of [
    { killed: true },
    { signal: "SIGTERM" },
    { interrupted: true },
    { stdout: "x".repeat(MAX_CODEX_OUTPUT_BYTES + 1) }
  ]) {
    const fixture = await makeImplementationFixture()

    await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      codexRunner: async () => outcome
    }), "CODEX_EXECUTION_AMBIGUOUS")

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(reloaded.status, "implementation_in_progress")
    assert.equal(reloaded.headSha, fixture.run.headSha)
  }
})

test("interrupted Codex reconciliation reports unchanged, advanced, and mismatched workspace states", async () => {
  const unchanged = await makeImplementationFixture()
  const unchangedResult = await reconcileCodexExecution(unchanged.run.runId, {
    writeDataDir: unchanged.writeDataDir,
    workspaceRegistry: unchanged.registry
  })
  assert.equal(unchangedResult.status, "unchanged")

  const advanced = await makeImplementationFixture()
  await writeFile(join(advanced.location.workspacePath, "advanced.txt"), "advanced\n", "utf8")
  await git(["add", "advanced.txt"], advanced.location.workspacePath)
  await git(["commit", "-m", "advanced implementation"], advanced.location.workspacePath)
  const advancedResult = await reconcileCodexExecution(advanced.run.runId, {
    writeDataDir: advanced.writeDataDir,
    workspaceRegistry: advanced.registry
  })
  assert.equal(advancedResult.status, "advanced")

  const mismatched = await makeImplementationFixture()
  await git(["checkout", "-b", "unexpected-branch"], mismatched.location.workspacePath)
  const mismatchedResult = await reconcileCodexExecution(mismatched.run.runId, {
    writeDataDir: mismatched.writeDataDir,
    workspaceRegistry: mismatched.registry
  })
  assert.equal(mismatchedResult.status, "mismatched")
})

test("safe error formatting excludes raw execution output", async () => {
  const fixture = await makeImplementationFixture()
  let formatted = ""

  try {
    await executeCodexImplementation(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      codexRunner: async () => {
        throw new Error("SENSITIVE_TEST_SENTINEL gho_fake_token raw failure")
      }
    })
  } catch (error) {
    formatted = formatDevelopmentCodexExecutionAdapterError(error)
  }

  assert.match(formatted, /CODEX_EXECUTION_FAILED/u)
  assert.doesNotMatch(formatted, /SENSITIVE_TEST_SENTINEL|gho_fake_token|raw failure/u)
})

test("Phase 6D adds no GitHub write, deployment, PR automation, or OpenClaw route", async () => {
  const moduleSource = await readFile(new URL("development-codex-execution-adapter.mjs", import.meta.url), "utf8")
  const commandSource = await readFile(new URL("ppo-command.mjs", import.meta.url), "utf8")
  const bridgeSource = await readFile(new URL("../openclaw/plugins/ppo-local/bridge.mjs", import.meta.url), "utf8")

  assert.equal(commandSource.includes("development-codex-execution-adapter"), false)
  assert.equal(bridgeSource.includes("development-codex-execution-adapter"), false)
  assert.equal(moduleSource.includes("shell: false"), true)
  assert.equal(moduleSource.includes("api.github.com"), false)
  assert.equal(moduleSource.includes("gh pr"), false)
  assert.equal(moduleSource.includes("pull request"), false)
  assert.equal(moduleSource.includes("systemctl"), false)
  assert.equal(moduleSource.includes("/ppo continue"), false)
  assert.equal(moduleSource.includes("workflow_dispatch"), false)

  const fixture = await makeImplementationFixture()
  assert.equal((await stat(fixture.location.workspacePath)).isDirectory(), true)
})
