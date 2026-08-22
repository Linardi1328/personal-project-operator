import { access, stat } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
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

export const DEVELOPMENT_CONTINUE_RUNTIME_PROFILE_ID = "phase-6k-fixed-local-runtime-profile"

const fixedDarwinPaths = Object.freeze({
  codexExecutablePath: "/Users/richie/.local/bin/codex",
  gitExecutablePath: "/opt/homebrew/bin/git",
  nodeExecutablePath: "/opt/homebrew/bin/node",
  reviewExecutablePath: "/usr/local/bin/ppo-independent-reviewer",
  sandboxExecutablePath: "/usr/bin/sandbox-exec",
  workspaceRoot: "/Users/richie/.local/share/personal-project-operator/development-workspaces",
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
  reviewExecutablePath: "/usr/local/bin/ppo-independent-reviewer",
  sandboxExecutablePath: "/usr/bin/unshare",
  setprivPath: "/usr/bin/setpriv",
  namespacePath: "/var/lib/personal-project-operator/phase6-sandbox/no-outbound.netns",
  readOnlyWorkspaceWrapperPath: "/usr/local/bin/ppo-readonly-workspace-wrapper",
  workspaceRoot: "/var/lib/personal-project-operator/development-workspaces",
  sourceRepoPaths: Object.freeze({
    "khlim-assist": "/var/lib/personal-project-operator/source-repos/khlim-assist",
    "ledgerpilot-ai": "/var/lib/personal-project-operator/source-repos/ledgerpilot-ai",
    "spy-market-agent": "/var/lib/personal-project-operator/source-repos/spy-market-agent",
    portfolio: "/var/lib/personal-project-operator/source-repos/richie-linardi-portfolio-website",
    "rbl-content-engine": "/var/lib/personal-project-operator/source-repos/rbl-content-engine"
  })
})

const ordinaryProjectIds = new Set(listPhase2GitHubProjects().map((project) => project.id))

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

async function assertExecutable(path, options = {}) {
  const executablePath = assertFixedAbsolutePath(path)
  const accessImpl = options.accessImpl || access
  const statImpl = options.statImpl || stat
  const info = await statImpl(executablePath).catch(() => {
    throw runtimeError()
  })

  if (!info.isFile()) {
    throw runtimeError()
  }

  await accessImpl(executablePath, fsConstants.X_OK).catch(() => {
    throw runtimeError()
  })

  return executablePath
}

async function assertDirectory(path, options = {}) {
  const directoryPath = assertFixedAbsolutePath(path)
  const statImpl = options.statImpl || stat
  const info = await statImpl(directoryPath).catch(() => {
    throw runtimeError()
  })

  if (!info.isDirectory()) {
    throw runtimeError()
  }

  return directoryPath
}

function buildCodexSandbox(paths, platform) {
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
    runAsUid: 1000,
    runAsGid: 1000,
    requireNoNewPrivileges: true,
    dropCapabilities: true
  }
}

function buildTestSandbox(paths, platform) {
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
    runAsUid: 1000,
    runAsGid: 1000,
    requireNoNewPrivileges: true,
    dropCapabilities: true
  }
}

function buildReviewSandbox(paths, platform) {
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
    runAsUid: 1000,
    runAsGid: 1000,
    requireNoNewPrivileges: true,
    dropCapabilities: true
  }
}

function testPolicyForProject(projectId, paths, sandbox) {
  return {
    policyId: `phase-6e-${projectId}-fixed-node-test-policy`,
    policyVersion: "1",
    trustedExecutablePaths: [paths.nodeExecutablePath],
    env: {
      PPO_PHASE6K_TEST_POLICY: "fixed"
    },
    sandbox,
    steps: [{
      id: "node-test",
      executablePath: paths.nodeExecutablePath,
      args: ["--test"],
      timeoutMs: 120000,
      maxOutputBytes: MAX_TEST_OUTPUT_BYTES,
      required: true,
      shell: false
    }]
  }
}

export async function loadDevelopmentContinueRuntimeProfile(request = {}, options = {}) {
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
  await assertExecutable(paths.nodeExecutablePath, options)
  await assertExecutable(paths.reviewExecutablePath, options)
  await assertExecutable(paths.sandboxExecutablePath, options)

  if (platform === "linux") {
    await assertExecutable(paths.setprivPath, options)
    await assertExecutable(paths.readOnlyWorkspaceWrapperPath, options)
    await assertDirectory(dirname(paths.namespacePath), options)
  }

  await assertDirectory(sourceRepoPath, options)
  await assertDirectory(paths.workspaceRoot, options)

  const codexSandbox = buildCodexSandbox(paths, platform)
  const testSandbox = buildTestSandbox(paths, platform)
  const reviewSandbox = buildReviewSandbox(paths, platform)

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
