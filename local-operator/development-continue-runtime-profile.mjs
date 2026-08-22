import { execFile } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, lstat, stat } from "node:fs/promises"
import { dirname, resolve as resolvePath } from "node:path"
import { promisify } from "node:util"
import {
  CODEX_SANDBOX_BACKENDS,
  MAX_CODEX_TIMEOUT_MS
} from "./development-codex-execution-adapter.mjs"
import {
  MAX_TEST_OUTPUT_BYTES,
  TEST_SANDBOX_BACKENDS
} from "./development-test-runner.mjs"
import {
  MAX_REVIEW_OUTPUT_BYTES,
  REVIEW_SANDBOX_BACKENDS
} from "./development-review-agent.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"

const execFileAsync = promisify(execFile)

export const DEVELOPMENT_CONTINUE_RUNTIME_PROFILE_ID = "phase-6k-fixed-local-runtime-profile"

const fixedDarwinPaths = Object.freeze({
  codexExecutablePath: "/Users/richie/.local/bin/codex",
  gitExecutablePath: "/opt/homebrew/bin/git",
  nodeExecutablePath: "/opt/homebrew/bin/node",
  pythonExecutablePath: "/opt/homebrew/bin/python3.12",
  reviewExecutablePath: "/usr/local/bin/ppo-independent-reviewer",
  sandboxExecutablePath: "/usr/bin/sandbox-exec",
  workspaceRoot: "/Users/richie/.local/share/personal-project-operator/development-workspaces",
  nodeToolPaths: Object.freeze({
    portfolioTypecheck: "/usr/local/lib/personal-project-operator/phase6k-tools/portfolio/typescript/bin/tsc",
    portfolioEslint: "/usr/local/lib/personal-project-operator/phase6k-tools/portfolio/eslint/bin/eslint.js"
  }),
  sourceRepoPaths: Object.freeze({
    "khlim-assist": "/Users/richie/khlim-assist",
    "ledgerpilot-ai": "/Users/richie/ledgerpilot-ai",
    "spy-market-agent": "/Users/richie/spy-market-agent",
    portfolio: "/Users/richie/richie-linardi-portfolio-website",
    "rbl-content-engine": "/Users/richie/rbl-content-engine"
  })
})

const fixedLinuxPaths = Object.freeze({
  codexExecutablePath: "/home/ppo/.local/bin/codex",
  gitExecutablePath: "/usr/bin/git",
  nodeExecutablePath: "/usr/bin/node",
  pythonExecutablePath: "/usr/bin/python3.12",
  reviewExecutablePath: "/usr/local/bin/ppo-independent-reviewer",
  sandboxExecutablePath: "/usr/bin/nsenter",
  idExecutablePath: "/usr/bin/id",
  setprivPath: "/usr/bin/setpriv",
  namespacePath: "/var/lib/personal-project-operator/phase6-sandbox/no-outbound.netns",
  readOnlyWorkspaceWrapperPath: "/usr/local/bin/ppo-readonly-workspace-wrapper",
  workspaceRoot: "/var/lib/personal-project-operator/development-workspaces",
  nodeToolPaths: Object.freeze({
    portfolioTypecheck: "/usr/local/lib/personal-project-operator/phase6k-tools/portfolio/typescript/bin/tsc",
    portfolioEslint: "/usr/local/lib/personal-project-operator/phase6k-tools/portfolio/eslint/bin/eslint.js"
  }),
  sourceRepoPaths: Object.freeze({
    "khlim-assist": "/var/lib/personal-project-operator/source-repos/khlim-assist",
    "ledgerpilot-ai": "/var/lib/personal-project-operator/source-repos/ledgerpilot-ai",
    "spy-market-agent": "/var/lib/personal-project-operator/source-repos/spy-market-agent",
    portfolio: "/var/lib/personal-project-operator/source-repos/richie-linardi-portfolio-website",
    "rbl-content-engine": "/var/lib/personal-project-operator/source-repos/rbl-content-engine"
  })
})

const reviewedProjectTestPolicies = Object.freeze({
  "khlim-assist": Object.freeze({
    policyId: "phase-6e-khlim-assist-fixed-python-pytest-policy",
    kind: "python-pytest",
    pythonTestPaths: Object.freeze(["backend/tests"])
  }),
  "ledgerpilot-ai": Object.freeze({
    policyId: "phase-6e-ledgerpilot-ai-fixed-python-pytest-policy",
    kind: "python-pytest",
    pythonTestPaths: Object.freeze(["tests"])
  }),
  "spy-market-agent": Object.freeze({
    policyId: "phase-6e-spy-market-agent-fixed-python-pytest-policy",
    kind: "python-pytest",
    pythonTestPaths: Object.freeze(["tests"])
  }),
  portfolio: Object.freeze({
    policyId: "phase-6e-portfolio-fixed-next-quality-policy",
    kind: "node-next-quality",
    nodeSteps: Object.freeze([{
      id: "typecheck",
      toolPathKey: "portfolioTypecheck",
      args: Object.freeze(["--noEmit"])
    }, {
      id: "eslint",
      toolPathKey: "portfolioEslint",
      args: Object.freeze(["."])
    }])
  }),
  "rbl-content-engine": Object.freeze({
    policyId: "phase-6e-rbl-content-engine-fixed-python-unittest-policy",
    kind: "python-compile-unittest",
    pythonSteps: Object.freeze([{
      id: "compile",
      args: Object.freeze(["-m", "compileall", "-q", "src", "tests"])
    }, {
      id: "unittest",
      args: Object.freeze(["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"])
    }])
  })
})

const ordinaryProjects = listPhase2GitHubProjects()
const ordinaryProjectIds = new Set(ordinaryProjects.map((project) => project.id))
const sanitizedProbeEnv = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TERM: "dumb",
  NO_COLOR: "1",
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "false",
  SSH_ASKPASS: "false",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
})

export class DevelopmentContinueRuntimeProfileError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "DevelopmentContinueRuntimeProfileError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function runtimeError() {
  return new DevelopmentContinueRuntimeProfileError(
    "CONTINUE_RUNTIME_NOT_READY",
    "Trusted Phase 6K runtime profile is not ready."
  )
}

function fixedPathsForPlatform(platform) {
  if (platform === "darwin") {
    return fixedDarwinPaths
  }

  if (platform === "linux") {
    return fixedLinuxPaths
  }

  throw runtimeError()
}

function assertFixedAbsolutePath(path) {
  if (typeof path !== "string" || path !== resolvePath(path) || path.length > 240) {
    throw runtimeError()
  }

  return path
}

async function pathStat(path, options = {}) {
  const statImpl = options.statImpl || stat

  return await statImpl(assertFixedAbsolutePath(path)).catch(() => {
    throw runtimeError()
  })
}

async function pathLstat(path, options = {}) {
  const lstatImpl = options.lstatImpl || lstat

  return await lstatImpl(assertFixedAbsolutePath(path)).catch(() => {
    throw runtimeError()
  })
}

function assertTrustedLinuxOwnership(info) {
  if (
    info &&
    Number.isInteger(info.uid) &&
    Number.isInteger(info.gid) &&
    Number.isInteger(info.mode)
  ) {
    const groupOrOtherWritable = (info.mode & 0o022) !== 0

    if (info.uid !== 0 || info.gid !== 0 || groupOrOtherWritable) {
      throw runtimeError()
    }
  }
}

async function assertExecutable(path, options = {}) {
  const executablePath = assertFixedAbsolutePath(path)
  const accessImpl = options.accessImpl || access
  const info = await pathStat(executablePath, options)

  if (!info.isFile()) {
    throw runtimeError()
  }

  await accessImpl(executablePath, fsConstants.X_OK).catch(() => {
    throw runtimeError()
  })

  return executablePath
}

async function assertRegularFile(path, options = {}) {
  const filePath = assertFixedAbsolutePath(path)
  const info = await pathStat(filePath, options)

  if (!info.isFile()) {
    throw runtimeError()
  }

  return filePath
}

async function assertDirectory(path, options = {}) {
  const directoryPath = assertFixedAbsolutePath(path)
  const info = await pathStat(directoryPath, options)

  if (!info.isDirectory()) {
    throw runtimeError()
  }

  return directoryPath
}

async function assertTrustedLinuxPath(path, options = {}) {
  const fixedPath = assertFixedAbsolutePath(path)
  const linkInfo = await pathLstat(fixedPath, options)

  if (typeof linkInfo.isSymbolicLink === "function" && linkInfo.isSymbolicLink()) {
    throw runtimeError()
  }

  const info = await pathStat(fixedPath, options)
  assertTrustedLinuxOwnership(info)

  return fixedPath
}

async function runReadOnlyProbe(executablePath, args, options = {}) {
  const execFileImpl = options.execFileImpl || execFileAsync

  try {
    await execFileImpl(executablePath, args, {
      encoding: "utf8",
      env: sanitizedProbeEnv,
      maxBuffer: 4096,
      shell: false,
      timeout: 5000
    })
  } catch {
    throw runtimeError()
  }
}

async function assertPythonPytestRuntime(paths, options = {}) {
  await assertExecutable(paths.pythonExecutablePath, options)
  await runReadOnlyProbe(paths.pythonExecutablePath, ["-m", "pytest", "--version"], options)
}

async function assertPythonStandardLibraryRuntime(paths, options = {}) {
  await assertExecutable(paths.pythonExecutablePath, options)
  await runReadOnlyProbe(paths.pythonExecutablePath, ["-c", "import compileall, unittest"], options)
}

async function assertNodeToolRuntime(paths, toolPath, options = {}) {
  await assertExecutable(paths.nodeExecutablePath, options)
  await assertRegularFile(toolPath, options)
  await runReadOnlyProbe(paths.nodeExecutablePath, [toolPath, "--version"], options)
}

function parsePositiveId(value) {
  const normalized = String(value ?? "").trim()

  if (!/^[1-9][0-9]{0,9}$/u.test(normalized)) {
    throw runtimeError()
  }

  return Number(normalized)
}

function validateLinuxPpoIdentity(identity) {
  const uid = Number(identity?.uid)
  const gid = Number(identity?.gid)
  const userName = String(identity?.userName || "")
  const groupName = String(identity?.groupName || "")

  if (
    !Number.isInteger(uid) ||
    !Number.isInteger(gid) ||
    uid <= 0 ||
    gid <= 0 ||
    userName !== "ppo" ||
    groupName !== "ppo"
  ) {
    throw runtimeError()
  }

  return {
    uid,
    gid,
    userName,
    groupName
  }
}

async function lookupLinuxPpoIdentity(paths, options = {}) {
  if (typeof options.identityLookup === "function") {
    return validateLinuxPpoIdentity(await options.identityLookup({
      user: "ppo",
      group: "ppo",
      idExecutablePath: paths.idExecutablePath
    }))
  }

  await assertExecutable(paths.idExecutablePath, options)

  const execFileImpl = options.execFileImpl || execFileAsync
  const readId = async (args) => {
    try {
      const result = await execFileImpl(paths.idExecutablePath, args, {
        encoding: "utf8",
        env: sanitizedProbeEnv,
        maxBuffer: 1024,
        shell: false,
        timeout: 5000
      })

      return String(result.stdout || "").trim()
    } catch {
      throw runtimeError()
    }
  }

  return validateLinuxPpoIdentity({
    uid: parsePositiveId(await readId(["-u", "ppo"])),
    gid: parsePositiveId(await readId(["-g", "ppo"])),
    userName: await readId(["-un", "ppo"]),
    groupName: await readId(["-gn", "ppo"])
  })
}

async function assertLinuxSandboxCapability(paths, identity, options = {}) {
  await assertTrustedLinuxPath(paths.sandboxExecutablePath, options)
  await assertTrustedLinuxPath(paths.setprivPath, options)
  await assertTrustedLinuxPath(paths.readOnlyWorkspaceWrapperPath, options)
  await assertTrustedLinuxPath(paths.namespacePath, options)
  await assertDirectory(dirname(paths.namespacePath), options)

  if (typeof options.linuxSandboxCapabilityProbe !== "function") {
    throw runtimeError()
  }

  const probe = await options.linuxSandboxCapabilityProbe({
    executablePath: paths.sandboxExecutablePath,
    args: [
      `--net=${paths.namespacePath}`,
      paths.setprivPath,
      "--no-new-privs",
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--clear-groups",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      paths.nodeExecutablePath,
      "--eval",
      "process.exit(typeof process.getuid === 'function' && process.getuid() === 0 ? 70 : 0)"
    ],
    namespacePath: paths.namespacePath,
    runAsUser: "ppo",
    runAsGroup: "ppo",
    uid: identity.uid,
    gid: identity.gid
  })

  if (probe !== true && probe?.ok !== true) {
    throw runtimeError()
  }
}

function buildCodexSandbox(paths, platform, identity = null) {
  if (platform === "darwin") {
    return {
      type: CODEX_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
      platform: "darwin",
      network: "none",
      enforcement: "os-process",
      executablePath: paths.sandboxExecutablePath
    }
  }

  return {
    type: CODEX_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
    platform: "linux",
    network: "none",
    enforcement: "os-network-namespace",
    executablePath: paths.sandboxExecutablePath,
    namespacePath: paths.namespacePath,
    setprivPath: paths.setprivPath,
    runAsUid: identity.uid,
    runAsGid: identity.gid,
    requireNoNewPrivileges: true,
    dropCapabilities: true
  }
}

function buildTestSandbox(paths, platform, identity = null) {
  if (platform === "darwin") {
    return {
      type: TEST_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
      platform: "darwin",
      network: "none",
      enforcement: "os-process",
      executablePath: paths.sandboxExecutablePath
    }
  }

  return {
    type: TEST_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
    platform: "linux",
    network: "none",
    enforcement: "os-network-namespace",
    executablePath: paths.sandboxExecutablePath,
    namespacePath: paths.namespacePath,
    setprivPath: paths.setprivPath,
    runAsUid: identity.uid,
    runAsGid: identity.gid,
    requireNoNewPrivileges: true,
    dropCapabilities: true
  }
}

function buildReviewSandbox(paths, platform, identity = null) {
  if (platform === "darwin") {
    return {
      type: REVIEW_SANDBOX_BACKENDS.MACOS_SANDBOX_EXEC,
      platform: "darwin",
      network: "none",
      enforcement: "os-process",
      readOnlyWorkspace: true,
      readOnlyWorkspaceMode: "trusted-read-only-workspace",
      executablePath: paths.sandboxExecutablePath
    }
  }

  return {
    type: REVIEW_SANDBOX_BACKENDS.LINUX_NETWORK_NAMESPACE,
    platform: "linux",
    network: "none",
    enforcement: "os-network-namespace",
    readOnlyWorkspace: true,
    readOnlyWorkspaceMode: "trusted-read-only-mount-namespace",
    executablePath: paths.sandboxExecutablePath,
    readOnlyWorkspaceWrapperPath: paths.readOnlyWorkspaceWrapperPath,
    namespacePath: paths.namespacePath,
    setprivPath: paths.setprivPath,
    runAsUid: identity.uid,
    runAsGid: identity.gid,
    requireNoNewPrivileges: true,
    dropCapabilities: true
  }
}

function pythonTestPolicy(definition, paths, sandbox) {
  return {
    policyId: definition.policyId,
    policyVersion: "1",
    trustedExecutablePaths: [paths.pythonExecutablePath],
    env: {
      PPO_PHASE6K_TEST_POLICY: "fixed",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1"
    },
    sandbox,
    steps: [{
      id: "pytest",
      executablePath: paths.pythonExecutablePath,
      args: ["-m", "pytest", ...definition.pythonTestPaths],
      timeoutMs: 120000,
      maxOutputBytes: MAX_TEST_OUTPUT_BYTES,
      required: true,
      shell: false
    }]
  }
}

function pythonCompileUnittestPolicy(definition, paths, sandbox) {
  return {
    policyId: definition.policyId,
    policyVersion: "1",
    trustedExecutablePaths: [paths.pythonExecutablePath],
    env: {
      PPO_PHASE6K_TEST_POLICY: "fixed",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1"
    },
    sandbox,
    steps: definition.pythonSteps.map((step) => ({
      id: step.id,
      executablePath: paths.pythonExecutablePath,
      args: [...step.args],
      timeoutMs: 120000,
      maxOutputBytes: MAX_TEST_OUTPUT_BYTES,
      required: true,
      shell: false
    }))
  }
}

function nodeQualityPolicy(definition, paths, sandbox) {
  return {
    policyId: definition.policyId,
    policyVersion: "1",
    trustedExecutablePaths: [paths.nodeExecutablePath],
    env: {
      PPO_PHASE6K_TEST_POLICY: "fixed"
    },
    sandbox,
    steps: definition.nodeSteps.map((step) => ({
      id: step.id,
      executablePath: paths.nodeExecutablePath,
      args: [paths.nodeToolPaths[step.toolPathKey], ...step.args],
      timeoutMs: 120000,
      maxOutputBytes: MAX_TEST_OUTPUT_BYTES,
      required: true,
      shell: false
    }))
  }
}

function testPolicyForProject(projectId, paths, sandbox) {
  const definition = reviewedProjectTestPolicies[projectId]

  if (!definition) {
    throw runtimeError()
  }

  if (definition.kind === "python-pytest") {
    return pythonTestPolicy(definition, paths, sandbox)
  }

  if (definition.kind === "python-compile-unittest") {
    return pythonCompileUnittestPolicy(definition, paths, sandbox)
  }

  if (definition.kind === "node-next-quality") {
    return nodeQualityPolicy(definition, paths, sandbox)
  }

  throw runtimeError()
}

async function assertProjectTestRuntime(projectId, paths, options = {}) {
  const definition = reviewedProjectTestPolicies[projectId]

  if (!definition) {
    throw runtimeError()
  }

  if (definition.kind === "python-pytest") {
    await assertPythonPytestRuntime(paths, options)
    return
  }

  if (definition.kind === "python-compile-unittest") {
    await assertPythonStandardLibraryRuntime(paths, options)
    return
  }

  if (definition.kind === "node-next-quality") {
    for (const step of definition.nodeSteps) {
      await assertNodeToolRuntime(paths, paths.nodeToolPaths[step.toolPathKey], options)
    }
    return
  }

  throw runtimeError()
}

function assertReviewedPolicyCoverage() {
  const policyIds = new Set()

  for (const project of ordinaryProjects) {
    const definition = reviewedProjectTestPolicies[project.id]

    if (!definition || policyIds.has(definition.policyId)) {
      throw runtimeError()
    }

    policyIds.add(definition.policyId)
  }
}

export async function loadDevelopmentContinueRuntimeProfile(request = {}, options = {}) {
  assertReviewedPolicyCoverage()

  const run = request.run
  const projectId = typeof run?.project?.id === "string" ? run.project.id : null

  if (!ordinaryProjectIds.has(projectId)) {
    throw runtimeError()
  }

  const platform = options.platform || process.platform
  const paths = fixedPathsForPlatform(platform)
  const sourceRepoPath = paths.sourceRepoPaths[projectId]

  if (!sourceRepoPath) {
    throw runtimeError()
  }

  await assertExecutable(paths.codexExecutablePath, options)
  await assertExecutable(paths.gitExecutablePath, options)
  await assertExecutable(paths.reviewExecutablePath, options)
  await assertExecutable(paths.sandboxExecutablePath, options)
  await assertProjectTestRuntime(projectId, paths, options)

  let linuxIdentity = null

  if (platform === "linux") {
    await assertExecutable(paths.idExecutablePath, options)
    await assertExecutable(paths.setprivPath, options)
    await assertExecutable(paths.readOnlyWorkspaceWrapperPath, options)
    await assertExecutable(paths.nodeExecutablePath, options)
    linuxIdentity = await lookupLinuxPpoIdentity(paths, options)
    await assertLinuxSandboxCapability(paths, linuxIdentity, options)
  }

  await assertDirectory(sourceRepoPath, options)
  await assertDirectory(paths.workspaceRoot, options)

  const codexSandbox = buildCodexSandbox(paths, platform, linuxIdentity)
  const testSandbox = buildTestSandbox(paths, platform, linuxIdentity)
  const reviewSandbox = buildReviewSandbox(paths, platform, linuxIdentity)

  return {
    workspaceRegistry: {
      [projectId]: {
        sourceRepoPath,
        workspaceRoot: paths.workspaceRoot
      }
    },
    codexConfig: {
      executablePath: paths.codexExecutablePath,
      gitExecutablePath: paths.gitExecutablePath,
      args: [],
      timeoutMs: MAX_CODEX_TIMEOUT_MS,
      env: {},
      remoteGitWritePolicy: {
        mode: "deny",
        enforcement: "adapter-git-wrapper"
      },
      executionSandbox: codexSandbox
    },
    testPolicyRegistry: {
      [projectId]: testPolicyForProject(projectId, paths, testSandbox)
    },
    reviewConfig: {
      executablePath: paths.reviewExecutablePath,
      args: [],
      timeoutMs: 300000,
      maxOutputBytes: MAX_REVIEW_OUTPUT_BYTES,
      env: {
        PPO_PHASE6K_REVIEW_POLICY: "fixed"
      },
      sandbox: reviewSandbox,
      shell: false
    }
  }
}

export async function loadDevelopmentRecoveryRuntimeProfile(request = {}, options = {}) {
  assertReviewedPolicyCoverage()

  const run = request.run
  const projectId = typeof run?.project?.id === "string" ? run.project.id : null

  if (!ordinaryProjectIds.has(projectId)) {
    throw runtimeError()
  }

  const platform = options.platform || process.platform
  const paths = fixedPathsForPlatform(platform)
  const sourceRepoPath = paths.sourceRepoPaths[projectId]

  if (!sourceRepoPath) {
    throw runtimeError()
  }

  const profile = {
    workspaceRegistry: {
      [projectId]: {
        sourceRepoPath,
        workspaceRoot: paths.workspaceRoot
      }
    }
  }

  if (options.includeTestPolicy === true) {
    let linuxIdentity = null

    if (platform === "linux") {
      linuxIdentity = await lookupLinuxPpoIdentity(paths, options)
    }

    profile.testPolicyRegistry = {
      [projectId]: testPolicyForProject(projectId, paths, buildTestSandbox(paths, platform, linuxIdentity))
    }
  }

  return profile
}
