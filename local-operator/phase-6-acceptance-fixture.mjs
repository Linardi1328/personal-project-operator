import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPersonalProjectOperatorSelfDevelopmentRun, transitionDevelopmentRun, readDevelopmentRun } from "./development-run-state.mjs"
import { prepareImplementationWorkspace, resolveImplementationWorkspaceLocation } from "./development-workspace-manager.mjs"
import { executeCodexImplementation } from "./development-codex-execution-adapter.mjs"
import { executeAutomatedTests } from "./development-test-runner.mjs"
import { executeIndependentReview } from "./development-review-agent.mjs"
import { executePersonalProjectOperatorSelfDevelopmentContinue } from "./development-continue-orchestrator.mjs"

const exec = promisify(execFile)
export const PROJECT = "personal-project-operator"
export async function git(args, cwd) {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", timeout: 15000, maxBuffer: 65536,
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  })).stdout.trim()
}

export function options(f, offset = 0, platform = process.platform) {
  const native = { type: `codex-native-${platform}`, platform, network: "none",
    enforcement: "codex-command-sandbox", executablePath: process.execPath, permissionProfile: ":workspace" }
  const testSandbox = platform === "darwin"
    ? { type: "macos-sandbox-exec", platform, network: "none",
      enforcement: "os-process", executablePath: "/usr/bin/sandbox-exec" }
    : native
  return {
    writeDataDir: f.writeDataDir, allowPersonalProjectOperatorSelfDevelopmentProject: true,
    now: () => new Date(Date.now() + offset),
    workspaceRegistry: { [PROJECT]: { sourceRepoPath: f.source, workspaceRoot: f.workspaces } },
    codexConfig: { executablePath: process.execPath, gitExecutablePath: f.gitPath,
      args: ["exec", "--ephemeral", "--color", "never", "--sandbox", "workspace-write", "-c", 'approval_policy="never"',
        "--ignore-user-config", "--ignore-rules", "--strict-config", "--model", "gpt-5.6-sol", "-"],
      timeoutMs: 5000, env: {}, remoteGitWritePolicy: { mode: "deny", enforcement: "adapter-git-wrapper" },
      executionSandbox: native },
    testPolicyRegistry: { [PROJECT]: { policyId: "phase-6e-acceptance-fixture", policyVersion: "1",
      trustedExecutablePaths: [process.execPath], env: {},
      sandbox: testSandbox,
      steps: ["first", "second"].map(id => ({ id, executablePath: process.execPath,
        args: ["-e", "process.exit(0)"], timeoutMs: 2000, maxOutputBytes: 2048 })) } },
    reviewConfig: { executablePath: process.execPath, args: ["--version"], timeoutMs: 5000, maxOutputBytes: 4096, env: {},
      sandbox: { ...native, readOnlyWorkspace: true, readOnlyWorkspaceMode: "codex-native-read-only", permissionProfile: ":read-only" } }
  }
}

// Only the model/sandbox boundary is simulated. Run-state, worktree, evidence,
// lease and recovery code are the real implementations. No model/network call.
export function adapter(work) {
  return async invocation => {
    if (invocation.kind === "sandbox-probe") {
      const allow = ["local-workspace-git", "local-process", "workspace-read", "linux-privilege-boundary"]
      return { exitCode: /ssh|push/.test(invocation.probe) ? 1 : 0,
        sandboxDenied: !allow.includes(invocation.probe), stdout: "", stderr: "" }
    }
    return work(invocation)
  }
}

export async function read(f) { return readDevelopmentRun(f.runId, options(f)) }
export async function advance(f, work, offset = 0) {
  const o = options(f, offset)
  const { writeDataDir, allowPersonalProjectOperatorSelfDevelopmentProject, ...profile } = o
  const runner = adapter(work || (() => { throw Error("Unexpected execution during recovery") }))
  return executePersonalProjectOperatorSelfDevelopmentContinue(f.runId, {
    writeDataDir, now: o.now,
    trustedRuntimeProfileProvider: async () => ({ ...profile,
      sandboxRunner: runner, reviewRunner: runner })
  })
}

export async function fixture(root, revision, phase, { missingTestEvidence = false } = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "ppo-acceptance-fixture-")))
  const f = { temp, revision, phase, source: join(temp, "source"), workspaces: join(temp, "workspaces"), writeDataDir: join(temp, "state") }
  await mkdir(f.source, { mode: 0o700 })
  await git(["init", "-b", "main"], f.source)
  // Fetch one exact local revision into a fresh private repository. No remote network.
  await git(["fetch", "--no-tags", root, revision], f.source)
  await git(["checkout", "-B", "main", revision], f.source)
  await git(["config", "user.name", "PPO Acceptance Fixture"], f.source)
  await git(["config", "user.email", "acceptance@example.invalid"], f.source)
  await git(["remote", "add", "origin", "git@github.com:Linardi1328/personal-project-operator.git"], f.source)
  f.gitPath = (await exec("/bin/sh", ["-c", "command -v git"], { encoding: "utf8", timeout: 5000 })).stdout.trim()
  const o = options(f)
  let run = await createPersonalProjectOperatorSelfDevelopmentRun({ projectId: PROJECT, task: "Validate disposable recovery fixture.",
    baseSha: revision, headSha: revision, branch: "main", actor: "acceptance-fixture" }, o)
  f.runId = run.runId
  for (const status of ["planning_in_progress", "planned"]) {
    run = await transitionDevelopmentRun(run.runId, { expectedVersion: run.version, status, actor: "acceptance-fixture" }, o)
  }
  const prepared = await prepareImplementationWorkspace(run.runId, { ...o, expectedVersion: run.version })
  f.location = await resolveImplementationWorkspaceLocation(prepared.run, o)
  assert.equal(await git(["rev-parse", "HEAD"], f.location.workspacePath), revision)
  if (phase !== "6D") {
    run = await read(f)
    await executeCodexImplementation(run.runId, { ...o, expectedVersion: run.version,
      sandboxRunner: adapter(async () => {
        await writeFile(join(f.location.workspacePath, "acceptance-evidence.txt"), `${revision}\n`)
        return { exitCode: 0, stdout: "", stderr: "" }
      }) })
  }
  if (phase === "6F" || phase === "HARD") {
    run = await read(f)
    if (missingTestEvidence) {
      // Negative fixture: status alone must never substitute for PASS evidence.
      for (const status of ["tests_in_progress", "tests_passed"]) {
        run = await transitionDevelopmentRun(run.runId, { expectedVersion: run.version, status, actor: "acceptance-fixture" }, o)
      }
    } else {
      await executeAutomatedTests(run.runId, { ...o, expectedVersion: run.version,
        sandboxRunner: adapter(async () => ({ exitCode: 0, stdout: "", stderr: "" })) })
    }
  }
  if (phase === "HARD") {
    run = await read(f)
    await executeIndependentReview(run.runId, { ...o, expectedVersion: run.version,
      reviewRunner: adapter(async i => ({ exitCode: 0, stdout: JSON.stringify({
        decision: "CHANGES_REQUESTED", reviewedSha: i.reviewedSha, mergeAllowed: false,
        blockers: ["Add the fixture correction."], securityFindings: [], testsRequired: [], summary: "Fixture findings."
      }), stderr: "" })) })
  }
  return f
}
