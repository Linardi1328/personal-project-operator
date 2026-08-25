import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import {
  chmod,
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
  CODEX_EXECUTION_SANDBOX_ID,
  CODEX_SANDBOX_BACKENDS,
  MAX_CODEX_IMPLEMENTATION_ATTEMPTS,
  MAX_CODEX_OUTPUT_BYTES,
  MAX_CODEX_PROMPT_CHARS,
  PHASE_6F_HARDENING_ORCHESTRATOR_ID,
  PHASE_6F_INDEPENDENT_REVIEW_AGENT_ID,
  PHASE_6F_REVIEW_FINDINGS_OUTCOME,
  buildCodexImplementationPrompt,
  executeCodexImplementation,
  formatDevelopmentCodexExecutionAdapterError,
  reconcileCodexExecution
} from "./development-codex-execution-adapter.mjs"

const execFileAsync = promisify(execFile)
const TRUSTED_GIT_EXECUTABLE = process.env.PPO_TEST_GIT_EXECUTABLE || "/usr/bin/git"
const TRUSTED_MACOS_SANDBOX_EXECUTABLE = process.env.PPO_TEST_SANDBOX_EXECUTABLE || "/usr/bin/sandbox-exec"
const TRUSTED_LINUX_SANDBOX_EXECUTABLE = process.env.PPO_TEST_LINUX_SANDBOX_EXECUTABLE || "/usr/bin/nsenter"
const TRUSTED_LINUX_SETPRIV_EXECUTABLE = process.env.PPO_TEST_LINUX_SETPRIV_EXECUTABLE || "/usr/bin/setpriv"
const TRUSTED_LINUX_NAMESPACE_PATH = process.env.PPO_TEST_LINUX_NAMESPACE_PATH || "/run/netns/ppo-codex-no-network"
const TRUSTED_LINUX_RUN_AS_UID = 1000
const TRUSTED_LINUX_RUN_AS_GID = 1000
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
    gitExecutablePath: TRUSTED_GIT_EXECUTABLE,
    args: ["--version"],
    timeoutMs: 1000,
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

function trustedLinuxCodexConfig(overrides = {}) {
  return trustedCodexConfig({
    executionSandbox: {
      type: CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
      platform: "linux",
      network: "none",
      enforcement: "os-network-namespace",
      executablePath: TRUSTED_LINUX_SANDBOX_EXECUTABLE,
      namespacePath: TRUSTED_LINUX_NAMESPACE_PATH,
      setprivPath: TRUSTED_LINUX_SETPRIV_EXECUTABLE,
      runAsUid: TRUSTED_LINUX_RUN_AS_UID,
      runAsGid: TRUSTED_LINUX_RUN_AS_GID,
      requireNoNewPrivileges: true,
      dropCapabilities: true
    },
    ...overrides
  })
}

function trustedNativeLinuxCodexConfig(overrides = {}) {
  return trustedCodexConfig({
    args: [
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
    ],
    executionSandbox: {
      type: CODEX_SANDBOX_BACKENDS.CODEX_NATIVE_LINUX,
      platform: "linux",
      network: "none",
      enforcement: "codex-command-sandbox",
      executablePath: process.execPath,
      permissionProfile: ":workspace"
    },
    ...overrides
  })
}

function makeSandboxRunner(codexRunner = async () => ({ exitCode: 0 }), options = {}) {
  const sandboxCalls = options.sandboxCalls || []

  return async (invocation) => {
    sandboxCalls.push({ ...invocation })
    assert.equal(invocation.shell, false)
    assert.equal(invocation.sandbox.network, "none")
    assert.ok(new Set(["os-process", "os-network-namespace", "codex-command-sandbox"]).has(invocation.sandbox.enforcement))
    assert.ok(invocation.sandboxCommand)
    assert.equal(invocation.sandboxExecutablePath, invocation.sandboxCommand.executablePath)
    assert.deepEqual(invocation.sandboxArgs, invocation.sandboxCommand.args)

    if (options.unavailable) {
      throw new Error("sandbox unavailable")
    }

    if (options.inactive && invocation.probe === "direct-network") {
      return { exitCode: 66, stdout: "connected", stderr: "" }
    }

    if (invocation.kind === "sandbox-probe") {
      const probeResult = options.probeResults?.[invocation.probe]
      if (probeResult) {
        return typeof probeResult === "function" ? await probeResult(invocation) : { ...probeResult }
      }

      if (invocation.probe === "linux-privilege-boundary") {
        return { exitCode: 0, stdout: "", stderr: "" }
      }

      if (invocation.probe === "local-workspace-git") {
        return { exitCode: 0, stdout: "", stderr: "" }
      }

      if (invocation.probe === "direct-network") {
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

    return await codexRunner(invocation)
  }
}

function sandboxedCodexRunner(codexRunner, options = {}) {
  return {
    sandboxRunner: makeSandboxRunner(codexRunner, options)
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

test("Phase 6D uses the fixed six-project allowlist through Phase 6A/6C state", () => {
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
    ...sandboxedCodexRunner(makeCommitRunner(calls))
  }), "CODEX_RUN_NOT_IMPLEMENTING")

  const implementation = await makeImplementationFixture()

  await assertRejectsCode(executeCodexImplementation(implementation.run.runId, {
    writeDataDir: implementation.writeDataDir,
    workspaceRegistry: implementation.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(makeCommitRunner(calls))
  }), "CODEX_EXPECTED_VERSION_REQUIRED")

  await assertRejectsCode(executeCodexImplementation(implementation.run.runId, {
    expectedVersion: implementation.run.version - 1,
    writeDataDir: implementation.writeDataDir,
    workspaceRegistry: implementation.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(makeCommitRunner(calls))
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
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
  }), "CODEX_WORKSPACE_NOT_READY")

  const detached = await makeImplementationFixture()
  await git(["checkout", "--detach"], detached.location.workspacePath)

  await assertRejectsCode(executeCodexImplementation(detached.run.runId, {
    expectedVersion: detached.run.version,
    writeDataDir: detached.writeDataDir,
    workspaceRegistry: detached.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
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
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
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
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
  }), "CODEX_WORKSPACE_NOT_READY")
})

test("Codex invocation uses trusted config, explicit argv, shell=false, and verified workspace cwd", async () => {
  const fixture = await makeImplementationFixture()
  const calls = []
  const sandboxCalls = []
  const result = await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig({
      executablePath: process.execPath,
      args: ["--eval", "process.exit(0)"],
      timeoutMs: 2000
    }),
    ...sandboxedCodexRunner(makeCommitRunner(calls), { sandboxCalls }),
    now: fixture.now
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cwd, fixture.location.workspacePath)
  assert.equal(calls[0].shell, false)
  assert.deepEqual(calls[0].args, ["--eval", "process.exit(0)"])
  assert.equal(calls[0].executablePath, process.execPath)
  assert.match(calls[0].promptHash, /^[a-f0-9]{64}$/u)
  assert.equal(calls[0].remoteGitWritePolicy.mode, "deny")
  assert.equal(calls[0].remoteGitWritePolicy.enforcement, "adapter-git-wrapper")
  assert.match(calls[0].env.PATH, /codex-execution-policy/u)
  assert.equal(calls[0].env.GIT_CONFIG_VALUE_0, "never")
  assert.equal(calls[0].executionSandbox.sandbox, CODEX_EXECUTION_SANDBOX_ID)
  assert.equal(calls[0].executionSandbox.backend, CODEX_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC)
  assert.equal(calls[0].executionSandbox.platform, "darwin")
  assert.equal(calls[0].executionSandbox.network, "none")
  assert.deepEqual(sandboxCalls.map((call) => call.probe || call.kind), [
    "local-workspace-git",
    "direct-network",
    "direct-ssh-transport",
    "absolute-git-sanitized-env-push",
    "ordinary-git-push",
    "codex"
  ])

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: result.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: {
      executablePath: "codex",
      args: []
    },
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
  }), "CODEX_CONFIG_INVALID")

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: result.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig({
      remoteGitWritePolicy: undefined
    }),
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
  }), "CODEX_REMOTE_POLICY_REQUIRED")

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: result.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig({
      executionSandbox: undefined
    }),
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
  }), "CODEX_SANDBOX_REQUIRED")

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: result.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
  }), "CODEX_CONFIG_REQUIRED")
})

test("Linux no-outbound-network sandbox backend uses namespace and drops privileges", async () => {
  const fixture = await makeImplementationFixture()
  const calls = []
  const sandboxCalls = []
  const result = await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedLinuxCodexConfig(),
    ...sandboxedCodexRunner(makeCommitRunner(calls), { sandboxCalls }),
    now: fixture.now
  })

  assert.equal(result.ok, true)
  assert.deepEqual(sandboxCalls.map((call) => call.probe || call.kind), [
    "linux-privilege-boundary",
    "local-workspace-git",
    "direct-network",
    "direct-ssh-transport",
    "absolute-git-sanitized-env-push",
    "ordinary-git-push",
    "codex"
  ])

  for (const call of sandboxCalls) {
    assert.equal(call.sandbox.type, CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE)
    assert.equal(call.sandbox.platform, "linux")
    assert.equal(call.sandbox.enforcement, "os-network-namespace")
    assert.equal(call.sandboxCommand.backend, CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE)
    assert.equal(call.sandboxCommand.executablePath, TRUSTED_LINUX_SANDBOX_EXECUTABLE)
    assert.deepEqual(call.sandboxArgs.slice(0, 11), [
      `--net=${TRUSTED_LINUX_NAMESPACE_PATH}`,
      TRUSTED_LINUX_SETPRIV_EXECUTABLE,
      "--no-new-privs",
      `--reuid=${TRUSTED_LINUX_RUN_AS_UID}`,
      `--regid=${TRUSTED_LINUX_RUN_AS_GID}`,
      "--clear-groups",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      call.executablePath
    ])
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].executionSandbox.backend, CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE)
  assert.equal(calls[0].executionSandbox.platform, "linux")

  const evidence = result.run.evidence.implementation.at(-1)
  assert.equal(evidence.metadata.sandbox, CODEX_EXECUTION_SANDBOX_ID)
  assert.equal(evidence.metadata.backend, CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE)
  assert.equal(evidence.metadata.platform, "linux")
  assert.equal(evidence.metadata.network, "none")
  assert.doesNotMatch(JSON.stringify(evidence.metadata), /\/run\/netns|\/usr\/bin\/nsenter|\/usr\/bin\/setpriv/u)
})

test("Codex native Linux backend keeps the controller online, sandboxes commands, and commits verified edits locally", async () => {
  const fixture = await makeImplementationFixture()
  const hooksPath = join(fixture.root, "untrusted-hooks")
  const hookMarker = join(fixture.root, "hook-ran")
  await mkdir(hooksPath)
  await writeFile(
    join(hooksPath, "pre-commit"),
    `#!/usr/bin/env bash\nprintf unsafe > ${JSON.stringify(hookMarker)}\n`,
    "utf8"
  )
  await chmod(join(hooksPath, "pre-commit"), 0o755)
  await git(["config", "core.hooksPath", hooksPath], fixture.location.workspacePath)
  const sandboxCalls = []
  const result = await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedNativeLinuxCodexConfig(),
    ...sandboxedCodexRunner(async (invocation) => {
      await writeFile(join(invocation.cwd, "native-runtime.txt"), "implemented\n", "utf8")
      return { exitCode: 0, stdout: "done", stderr: "" }
    }, { sandboxCalls }),
    now: fixture.now
  })

  assert.equal(result.ok, true)
  assert.equal(result.run.status, "implementation_ready")
  assert.equal(result.run.headSha === fixture.baseSha, false)

  const codexCall = sandboxCalls.find((call) => call.kind === "codex")
  assert.ok(codexCall)
  assert.equal(codexCall.sandboxCommand.executablePath, process.execPath)
  assert.deepEqual(codexCall.sandboxCommand.args.slice(-5), [
    "--model",
    "gpt-5.6-sol",
    "-c",
    `projects."${fixture.location.workspacePath}".trust_level="untrusted"`,
    "-"
  ])

  const probeCalls = sandboxCalls.filter((call) => call.kind === "sandbox-probe")
  assert.ok(probeCalls.length > 0)
  for (const call of probeCalls) {
    assert.deepEqual(call.sandboxCommand.args.slice(0, 9), [
      "sandbox",
      "--config",
      `projects."${call.cwd}".trust_level="untrusted"`,
      "--permission-profile",
      ":workspace",
      "--cd",
      call.cwd,
      "--"
    ])
  }

  assert.equal(await git(["status", "--porcelain=v1", "--untracked-files=all"], fixture.location.workspacePath), "")
  assert.equal(await git(["log", "-1", "--pretty=%s"], fixture.location.workspacePath), "PPO implementation")
  await assert.rejects(readFile(hookMarker, "utf8"), /ENOENT/u)
})

test("Codex native Linux commit refuses repository-local content filters", async () => {
  const fixture = await makeImplementationFixture()
  await git([
    "config",
    "filter.unsafe.clean",
    "/bin/false"
  ], fixture.location.workspacePath)

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedNativeLinuxCodexConfig(),
    ...sandboxedCodexRunner(async (invocation) => {
      await writeFile(join(invocation.cwd, "unsafe-filter.txt"), "implemented\n", "utf8")
      return { exitCode: 0, stdout: "done", stderr: "" }
    })
  }), "CODEX_GIT_VERIFY_FAILED")

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(reloaded.status, "implementation_in_progress")
  assert.equal(reloaded.evidence.implementation.at(-1).metadata.outcome, "execution_failed")
})

test("Linux sandbox backend requires explicit namespace and privilege-drop contract", async () => {
  for (const executionSandbox of [
    {
      type: CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
      platform: "linux",
      network: "none",
      enforcement: "os-network-namespace",
      executablePath: TRUSTED_LINUX_SANDBOX_EXECUTABLE,
      setprivPath: TRUSTED_LINUX_SETPRIV_EXECUTABLE,
      runAsUid: TRUSTED_LINUX_RUN_AS_UID,
      runAsGid: TRUSTED_LINUX_RUN_AS_GID,
      requireNoNewPrivileges: true,
      dropCapabilities: true
    },
    {
      type: CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
      platform: "linux",
      network: "none",
      enforcement: "os-network-namespace",
      executablePath: TRUSTED_LINUX_SANDBOX_EXECUTABLE,
      namespacePath: TRUSTED_LINUX_NAMESPACE_PATH,
      setprivPath: TRUSTED_LINUX_SETPRIV_EXECUTABLE,
      runAsUid: 0,
      runAsGid: TRUSTED_LINUX_RUN_AS_GID,
      requireNoNewPrivileges: true,
      dropCapabilities: true
    },
    {
      type: CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
      platform: "linux",
      network: "none",
      enforcement: "os-network-namespace",
      executablePath: TRUSTED_LINUX_SANDBOX_EXECUTABLE,
      namespacePath: TRUSTED_LINUX_NAMESPACE_PATH,
      setprivPath: TRUSTED_LINUX_SETPRIV_EXECUTABLE,
      runAsUid: TRUSTED_LINUX_RUN_AS_UID,
      runAsGid: TRUSTED_LINUX_RUN_AS_GID,
      requireNoNewPrivileges: false,
      dropCapabilities: true
    },
    {
      type: CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
      platform: "darwin",
      network: "none",
      enforcement: "os-network-namespace",
      executablePath: TRUSTED_LINUX_SANDBOX_EXECUTABLE,
      namespacePath: TRUSTED_LINUX_NAMESPACE_PATH,
      setprivPath: TRUSTED_LINUX_SETPRIV_EXECUTABLE,
      runAsUid: TRUSTED_LINUX_RUN_AS_UID,
      runAsGid: TRUSTED_LINUX_RUN_AS_GID,
      requireNoNewPrivileges: true,
      dropCapabilities: true
    }
  ]) {
    const fixture = await makeImplementationFixture()
    let codexCalls = 0

    await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig({ executionSandbox }),
      ...sandboxedCodexRunner(async () => {
        codexCalls += 1
        return { exitCode: 0 }
      })
    }), "CODEX_SANDBOX_REQUIRED")

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })
    assert.equal(codexCalls, 0)
    assert.equal(reloaded.version, fixture.run.version)
    assert.equal(reloaded.attempts.implementation, fixture.run.attempts.implementation)
  }
})

test("Linux sandbox availability preflight failure fails closed before attempt reservation", async () => {
  const fixture = await makeImplementationFixture()
  let codexCalls = 0

  await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedLinuxCodexConfig(),
    ...sandboxedCodexRunner(async () => {
      codexCalls += 1
      return { exitCode: 0 }
    }, {
      probeResults: {
        "linux-privilege-boundary": { exitCode: 69, stdout: "capability present", stderr: "" }
      }
    })
  }), "CODEX_SANDBOX_UNAVAILABLE")

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(codexCalls, 0)
  assert.equal(reloaded.version, fixture.run.version)
  assert.equal(reloaded.attempts.implementation, fixture.run.attempts.implementation)
})

test("no-outbound-network sandbox is verified active before Codex spawn", async () => {
  const unavailable = await makeImplementationFixture()
  let unavailableCodexCalls = 0
  const unavailableReloadedBefore = await readDevelopmentRun(unavailable.run.runId, {
    writeDataDir: unavailable.writeDataDir
  })

  await assertRejectsCode(executeCodexImplementation(unavailable.run.runId, {
    expectedVersion: unavailable.run.version,
    writeDataDir: unavailable.writeDataDir,
    workspaceRegistry: unavailable.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(async () => {
      unavailableCodexCalls += 1
      return { exitCode: 0 }
    }, { unavailable: true })
  }), "CODEX_SANDBOX_UNAVAILABLE")

  const unavailableReloadedAfter = await readDevelopmentRun(unavailable.run.runId, {
    writeDataDir: unavailable.writeDataDir
  })
  assert.equal(unavailableCodexCalls, 0)
  assert.equal(unavailableReloadedAfter.version, unavailableReloadedBefore.version)
  assert.equal(unavailableReloadedAfter.attempts.implementation, unavailableReloadedBefore.attempts.implementation)

  const inactive = await makeImplementationFixture()
  let inactiveCodexCalls = 0

  await assertRejectsCode(executeCodexImplementation(inactive.run.runId, {
    expectedVersion: inactive.run.version,
    writeDataDir: inactive.writeDataDir,
    workspaceRegistry: inactive.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(async () => {
      inactiveCodexCalls += 1
      return { exitCode: 0 }
    }, { inactive: true })
  }), "CODEX_SANDBOX_UNAVAILABLE")

  const inactiveReloaded = await readDevelopmentRun(inactive.run.runId, {
    writeDataDir: inactive.writeDataDir
  })
  assert.equal(inactiveCodexCalls, 0)
  assert.equal(inactiveReloaded.version, inactive.run.version)
  assert.equal(inactiveReloaded.attempts.implementation, inactive.run.attempts.implementation)
})

test("sandbox denies remote-write bypass probes before Codex spawn", async () => {
  const fixture = await makeImplementationFixture()
  const calls = []
  const sandboxCalls = []

  await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(makeCommitRunner(calls), { sandboxCalls }),
    now: fixture.now
  })

  const absoluteGit = sandboxCalls.find((call) => call.probe === "absolute-git-sanitized-env-push")
  const directNetwork = sandboxCalls.find((call) => call.probe === "direct-network")
  const directSsh = sandboxCalls.find((call) => call.probe === "direct-ssh-transport")
  const ordinaryPush = sandboxCalls.find((call) => call.probe === "ordinary-git-push")

  assert.ok(absoluteGit)
  assert.equal(absoluteGit.executablePath, TRUSTED_GIT_EXECUTABLE)
  assert.deepEqual(absoluteGit.args, ["push", "origin", "HEAD"])
  assert.equal(Object.hasOwn(absoluteGit.env, "GIT_CONFIG_COUNT"), false)
  assert.equal(Object.hasOwn(absoluteGit.env, "GIT_SSH_COMMAND"), false)

  assert.ok(directNetwork)
  assert.equal(directNetwork.executablePath, process.execPath)
  assert.deepEqual(directNetwork.args.slice(0, 1), ["--eval"])

  assert.ok(directSsh)
  assert.equal(directSsh.executablePath, "/usr/bin/ssh")
  assert.deepEqual(directSsh.args.slice(0, 2), ["-o", "BatchMode=yes"])
  assert.equal(directSsh.args.includes("127.0.0.1"), true)

  assert.ok(ordinaryPush)
  assert.equal(ordinaryPush.executablePath, "/usr/bin/env")
  assert.deepEqual(ordinaryPush.args, ["git", "push", "origin", "HEAD"])
  assert.match(ordinaryPush.env.PATH, /codex-execution-policy/u)
  assert.equal(calls.length, 1)
})

test("sandbox bypass probe success fails closed before Codex spawn", async () => {
  for (const [probe, probeResult] of [
    ["direct-network", { exitCode: 66, stdout: "connected", stderr: "" }],
    ["direct-ssh-transport", { exitCode: 0, stdout: "connected", stderr: "" }],
    ["absolute-git-sanitized-env-push", { exitCode: 0, stdout: "pushed", stderr: "" }],
    ["ordinary-git-push", { exitCode: 0, stdout: "pushed", stderr: "" }]
  ]) {
    const fixture = await makeImplementationFixture()
    let codexCalls = 0

    await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      ...sandboxedCodexRunner(async () => {
        codexCalls += 1
        return { exitCode: 0 }
      }, {
        probeResults: {
          [probe]: probeResult
        }
      })
    }), "CODEX_SANDBOX_UNAVAILABLE")

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })
    assert.equal(codexCalls, 0, probe)
    assert.equal(reloaded.version, fixture.run.version, probe)
    assert.equal(reloaded.attempts.implementation, fixture.run.attempts.implementation, probe)
  }
})

test("ordinary git push remains denied by defense-in-depth policy env", async () => {
  const fixture = await makeImplementationFixture()
  let pushDenied = false
  const result = await executeCodexImplementation(fixture.run.runId, {
    expectedVersion: fixture.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(async (invocation) => {
      assert.equal(invocation.cwd, fixture.location.workspacePath)
      assert.equal(invocation.shell, false)
      assert.equal(invocation.remoteGitWritePolicy.mode, "deny")
      assert.equal(invocation.remoteGitWritePolicy.enforcement, "adapter-git-wrapper")
      assert.equal(invocation.executionSandbox.sandbox, CODEX_EXECUTION_SANDBOX_ID)
      assert.equal(invocation.executionSandbox.network, "none")

      await assert.rejects(
        execFileAsync("git", ["push", "origin", "HEAD"], {
          cwd: invocation.cwd,
          env: invocation.env,
          encoding: "utf8",
          maxBuffer: 1024,
          shell: false
        }),
        (error) => error.code === 126
      )
      pushDenied = true

      await writeFile(join(invocation.cwd, "policy-local-change.txt"), "local only\n", "utf8")
      await execFileAsync("git", ["add", "policy-local-change.txt"], {
        cwd: invocation.cwd,
        env: invocation.env,
        encoding: "utf8",
        maxBuffer: 128 * 1024,
        shell: false
      })
      await execFileAsync("git", ["commit", "-m", "codex local policy implementation"], {
        cwd: invocation.cwd,
        env: invocation.env,
        encoding: "utf8",
        maxBuffer: 128 * 1024,
        shell: false
      })

      return { exitCode: 0, stdout: "done", stderr: "" }
    }),
    now: fixture.now
  })

  assert.equal(pushDenied, true)
  assert.equal(result.run.status, "implementation_ready")
  assert.equal(result.run.evidence.implementation.at(-1).metadata.remotePolicy, "deny")
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
    ...sandboxedCodexRunner(async () => ({ exitCode: 0 }))
  }), "CODEX_CONFIG_INVALID")
})

test("hardening prompt keeps all remediation items and mandatory safety boundaries at max bounds", async () => {
  const fixture = await makeImplementationFixture()
  const reviewedSha = fixture.run.headSha
  const blockers = Array.from({ length: 5 }, (_, index) => `blocker-${index + 1}-${"b".repeat(145)}`)
  const securityFindings = Array.from({ length: 5 }, (_, index) => `security-${index + 1}-${"s".repeat(143)}`)
  const testsRequired = Array.from({ length: 5 }, (_, index) => `test-${index + 1}-${"t".repeat(148)}`)
  const remediationHash = sha256Text(stableStringify({
    reviewedSha,
    decision: "CHANGES_REQUESTED",
    blockers,
    securityFindings,
    testsRequired
  }))
  const run = {
    ...fixture.run,
    task: `Maximal hardening task ${"x".repeat(976)}`,
    evidence: {
      ...fixture.run.evidence,
      planning: [{
        kind: "planning",
        sha: fixture.run.baseSha,
        source: "test-planner",
        summary: `Optional planning context ${"p".repeat(430)}`,
        metadata: {
          planHash: "a".repeat(64),
          nextStage: "implementation",
          sourceCount: 5
        }
      }],
      implementation: [{
        kind: "implementation",
        sha: reviewedSha,
        source: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
        summary: "Hardening started.",
        metadata: {
          orchestrator: PHASE_6F_HARDENING_ORCHESTRATOR_ID,
          outcome: "hardening_started",
          sourceReviewSha: reviewedSha,
          round: 3,
          reviewAttempt: 2,
          blockerCount: blockers.length,
          securityFindingCount: securityFindings.length,
          testRequirementCount: testsRequired.length,
          remediationHash,
          reviewer: PHASE_6F_INDEPENDENT_REVIEW_AGENT_ID
        }
      }],
      review: [{
        kind: "review",
        sha: reviewedSha,
        source: PHASE_6F_INDEPENDENT_REVIEW_AGENT_ID,
        summary: "Review findings.",
        metadata: {
          reviewer: PHASE_6F_INDEPENDENT_REVIEW_AGENT_ID,
          outcome: PHASE_6F_REVIEW_FINDINGS_OUTCOME,
          reviewedSha,
          attempt: 2,
          decision: "CHANGES_REQUESTED",
          mergeAllowed: false,
          blockers: blockers.length,
          securityFindings: securityFindings.length,
          testsRequired: testsRequired.length,
          blockerItems: blockers,
          securityItems: securityFindings,
          testItems: testsRequired,
          findingHash: remediationHash
        }
      }]
    }
  }
  const prompt = buildCodexImplementationPrompt(run, fixture.location)

  assert.equal(prompt.length <= MAX_CODEX_PROMPT_CHARS, true)

  for (const item of [...blockers, ...securityFindings, ...testsRequired]) {
    assert.match(prompt, new RegExp(item, "u"))
  }

  for (const requiredBoundary of [
    "Work only inside the current isolated branch and worktree.",
    "Do not push to any remote.",
    "Do not merge, rebase, reset, cherry-pick, or change repository history outside the current isolated branch.",
    "Do not deploy, restart services, or change production infrastructure.",
    "Do not modify credentials, tokens, secrets, authentication settings, or confirmation values.",
    "Do not run unrelated work, destructive cleanup, broad refactors, or changes outside the task scope.",
    "Make the requested edits in the workspace; PPO creates the local commit after sandbox verification."
  ]) {
    assert.match(prompt, new RegExp(requiredBoundary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"))
  }
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
    ...sandboxedCodexRunner(makeCommitRunner(calls)),
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
  assert.equal(evidence.metadata.attempt, fixture.run.attempts.implementation + 1)
  assert.equal(result.implementation.attempt, evidence.metadata.attempt)
  assert.equal(evidence.metadata.outcome, "implementation_ready")
  assert.equal(evidence.metadata.remotePolicy, "deny")
  assert.equal(evidence.metadata.sandbox, CODEX_EXECUTION_SANDBOX_ID)
  assert.equal(evidence.metadata.backend, CODEX_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC)
  assert.equal(evidence.metadata.platform, "darwin")
  assert.equal(evidence.metadata.network, "none")
  assert.doesNotMatch(JSON.stringify(result.run), /SENSITIVE_TEST_SENTINEL|gho_fake_token|raw stderr ignored/u)

  const reloaded = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(reloaded.status, "implementation_ready")
  assert.equal(reloaded.headSha, finalHead)
  assert.equal(reloaded.attempts.implementation, fixture.run.attempts.implementation + 1)
})

test("Codex no-op, nonzero exit, dirty workspace, and source mutation leave run in progress with failed-attempt evidence", async () => {
  const noop = await makeImplementationFixture()
  await assertRejectsCode(executeCodexImplementation(noop.run.runId, {
    expectedVersion: noop.run.version,
    writeDataDir: noop.writeDataDir,
    workspaceRegistry: noop.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(async () => ({ exitCode: 0, stdout: "claimed success" }))
  }), "CODEX_NO_IMPLEMENTATION")
  const noopReloaded = await readDevelopmentRun(noop.run.runId, { writeDataDir: noop.writeDataDir })
  assert.equal(noopReloaded.status, "implementation_in_progress")
  assert.equal(noopReloaded.attempts.implementation, noop.run.attempts.implementation + 1)
  assert.equal(noopReloaded.evidence.implementation.at(-1).metadata.outcome, "execution_failed")

  const nonzero = await makeImplementationFixture()
  await assertRejectsCode(executeCodexImplementation(nonzero.run.runId, {
    expectedVersion: nonzero.run.version,
    writeDataDir: nonzero.writeDataDir,
    workspaceRegistry: nonzero.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(async () => ({ exitCode: 1, stdout: "failed" }))
  }), "CODEX_EXECUTION_FAILED")
  const nonzeroReloaded = await readDevelopmentRun(nonzero.run.runId, { writeDataDir: nonzero.writeDataDir })
  assert.equal(nonzeroReloaded.status, "implementation_in_progress")
  assert.equal(nonzeroReloaded.attempts.implementation, nonzero.run.attempts.implementation + 1)
  assert.equal(nonzeroReloaded.evidence.implementation.at(-1).metadata.outcome, "execution_failed")

  const dirty = await makeImplementationFixture()
  await assertRejectsCode(executeCodexImplementation(dirty.run.runId, {
    expectedVersion: dirty.run.version,
    writeDataDir: dirty.writeDataDir,
    workspaceRegistry: dirty.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(async (invocation) => {
      await writeFile(join(invocation.cwd, "dirty.txt"), "uncommitted\n", "utf8")
      return { exitCode: 0 }
    })
  }), "CODEX_IMPLEMENTATION_INVALID")
  const dirtyReloaded = await readDevelopmentRun(dirty.run.runId, { writeDataDir: dirty.writeDataDir })
  assert.equal(dirtyReloaded.status, "implementation_in_progress")
  assert.equal(dirtyReloaded.attempts.implementation, dirty.run.attempts.implementation + 1)
  assert.equal(dirtyReloaded.evidence.implementation.at(-1).metadata.outcome, "execution_failed")

  const sourceChanged = await makeImplementationFixture()
  await assertRejectsCode(executeCodexImplementation(sourceChanged.run.runId, {
    expectedVersion: sourceChanged.run.version,
    writeDataDir: sourceChanged.writeDataDir,
    workspaceRegistry: sourceChanged.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(makeCommitRunner([], {
      sourceRepoPath: sourceChanged.sourceRepoPath
    }))
  }), "CODEX_SOURCE_CHANGED")
  const sourceChangedReloaded = await readDevelopmentRun(sourceChanged.run.runId, { writeDataDir: sourceChanged.writeDataDir })
  assert.equal(sourceChangedReloaded.status, "implementation_in_progress")
  assert.equal(sourceChangedReloaded.attempts.implementation, sourceChanged.run.attempts.implementation + 1)
  assert.equal(sourceChangedReloaded.evidence.implementation.at(-1).metadata.outcome, "execution_failed")
})

test("definitive implementation retries persist attempt counters, survive reload, and enforce max", async () => {
  const fixture = await makeImplementationFixture()
  let current = fixture.run
  let calls = 0

  while (current.attempts.implementation < MAX_CODEX_IMPLEMENTATION_ATTEMPTS) {
    await assertRejectsCode(executeCodexImplementation(current.runId, {
      expectedVersion: current.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      ...sandboxedCodexRunner(async () => {
        calls += 1
        return { exitCode: 1, stdout: "definitive failure" }
      })
    }), "CODEX_EXECUTION_FAILED")

    const reloaded = await readDevelopmentRun(current.runId, {
      writeDataDir: fixture.writeDataDir
    })
    assert.equal(reloaded.status, "implementation_in_progress")
    assert.equal(reloaded.attempts.implementation, current.attempts.implementation + 1)
    assert.equal(reloaded.evidence.implementation.at(-1).metadata.outcome, "execution_failed")
    current = reloaded
  }

  await assertRejectsCode(executeCodexImplementation(current.runId, {
    expectedVersion: current.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    codexConfig: trustedCodexConfig(),
    ...sandboxedCodexRunner(async () => {
      calls += 1
      return { exitCode: 1 }
    })
  }), "CODEX_ATTEMPT_LIMIT_REACHED")

  assert.equal(calls, MAX_CODEX_IMPLEMENTATION_ATTEMPTS - fixture.run.attempts.implementation)
})

test("concurrent Codex execution attempts use optimistic concurrency before spawn", async () => {
  const fixture = await makeImplementationFixture()
  const calls = []
  const results = await Promise.allSettled([
    executeCodexImplementation(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      ...sandboxedCodexRunner(makeCommitRunner(calls, {
        fileName: "concurrent-a.txt",
        content: "a\n",
        message: "codex implementation a"
      }))
    }),
    executeCodexImplementation(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      ...sandboxedCodexRunner(makeCommitRunner(calls, {
        fileName: "concurrent-b.txt",
        content: "b\n",
        message: "codex implementation b"
      }))
    })
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => (
    result.status === "rejected" &&
    result.reason instanceof DevelopmentRunStateError &&
    result.reason.code === "STALE_RUN_VERSION"
  )).length, 1)
  assert.equal(calls.length, 1)
})

test("ambiguous Codex timeout, signal, interruption, and output overflow require reconciliation before retry", async () => {
  for (const outcome of [
    { killed: true },
    { signal: "SIGTERM" },
    { interrupted: true },
    { stdout: "x".repeat(MAX_CODEX_OUTPUT_BYTES + 1) }
  ]) {
    const fixture = await makeImplementationFixture()
    let calls = 0

    await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
      expectedVersion: fixture.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      ...sandboxedCodexRunner(async () => {
        calls += 1
        return outcome
      })
    }), "CODEX_EXECUTION_AMBIGUOUS")

    const reloaded = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })

    assert.equal(reloaded.status, "implementation_in_progress")
    assert.equal(reloaded.headSha, fixture.run.headSha)
    assert.equal(reloaded.attempts.implementation, fixture.run.attempts.implementation + 1)
    assert.equal(reloaded.evidence.implementation.at(-1).metadata.outcome, "execution_started")

    await assertRejectsCode(executeCodexImplementation(fixture.run.runId, {
      expectedVersion: reloaded.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      codexConfig: trustedCodexConfig(),
      ...sandboxedCodexRunner(async () => {
        calls += 1
        return { exitCode: 0 }
      })
    }), "CODEX_RECONCILIATION_REQUIRED")

    assert.equal(calls, 1)
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
      ...sandboxedCodexRunner(async () => {
        throw new Error("SENSITIVE_TEST_SENTINEL gho_fake_token raw failure")
      })
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
  assert.equal(moduleSource.includes("remoteRefsHash"), false)
  assert.equal(moduleSource.includes("for-each-ref"), false)

  const fixture = await makeImplementationFixture()
  assert.equal((await stat(fixture.location.workspacePath)).isDirectory(), true)
})
