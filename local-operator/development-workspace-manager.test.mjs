import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  lstat,
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
  DEVELOPMENT_WORKSPACE_MANAGER_ID,
  DEVELOPMENT_WORKSPACE_STORE_DIR,
  formatDevelopmentWorkspaceManagerError,
  inspectImplementationWorkspace,
  makeDevelopmentWorkspaceBranchName,
  makeDevelopmentWorkspaceId,
  prepareImplementationWorkspace
} from "./development-workspace-manager.mjs"

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
  const start = Date.parse("2026-08-21T06:00:00.000Z")

  return () => {
    const next = new Date(start + tick * 1000)
    tick += 1
    return next
  }
}

async function canonicalTempRoot(label = "ppo-6c-") {
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

function modeBits(info) {
  return info.mode & 0o777
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

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

test("Phase 6C uses only the fixed project and repository allowlist", () => {
  assert.equal(PROJECT_IDS.length, 5)

  for (const projectId of PROJECT_IDS) {
    const project = resolveDevelopmentRunProject(projectId)
    const run = {
      runId: "A".repeat(43),
      project,
      baseSha: "a".repeat(40)
    }

    assert.equal(project.fullName.startsWith("Linardi1328/"), true)
    assert.match(makeDevelopmentWorkspaceBranchName(run), /^ppo\/[a-z0-9-]+\/implementation\/[a-f0-9]{16}$/u)
    assert.match(makeDevelopmentWorkspaceId(run), /^[a-z0-9-]+-[a-f0-9]{16}$/u)
  }

  assert.throws(() => makeDevelopmentWorkspaceBranchName({
    runId: "A".repeat(43),
    project: { id: "unknown" },
    baseSha: "a".repeat(40)
  }), DevelopmentRunStateError)
})

test("workspace preparation requires a planned run and exact expected version", async () => {
  const fixture = await makeSourceRepo()
  const created = await createDevelopmentRun({
    projectId: fixture.project.id,
    task: "Not planned yet.",
    baseSha: fixture.baseSha
  }, {
    writeDataDir: fixture.writeDataDir,
    now: makeClock()
  })

  await assertRejectsCode(prepareImplementationWorkspace(created.runId, {
    expectedVersion: created.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  }), "WORKSPACE_RUN_NOT_PLANNED")

  const planned = await makePlannedRun(fixture)

  await assertRejectsCode(prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version - 1,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  }), "STALE_RUN_VERSION")
})

test("missing base SHA, repository identity mismatch, and dirty source repo are refused before workspace creation", async () => {
  const nonGitRoot = await canonicalTempRoot()
  const nonGitProject = resolveDevelopmentRunProject("khlim-assist")
  const nonGitSource = join(nonGitRoot, "source")
  const nonGitWriteData = join(nonGitRoot, "write-data")
  await mkdir(nonGitSource)
  const nonGitRun = await makePlannedRun({
    project: nonGitProject,
    sourceRepoPath: nonGitSource,
    workspaceRoot: join(nonGitRoot, "workspaces"),
    writeDataDir: nonGitWriteData,
    baseSha: "a".repeat(40)
  })

  await assertRejectsCode(prepareImplementationWorkspace(nonGitRun.run.runId, {
    expectedVersion: nonGitRun.run.version,
    writeDataDir: nonGitWriteData,
    workspaceRegistry: {
      [nonGitProject.id]: {
        sourceRepoPath: nonGitSource,
        workspaceRoot: join(nonGitRoot, "workspaces")
      }
    }
  }), "WORKSPACE_SOURCE_NOT_GIT_REPO")

  const missingBase = await makeSourceRepo()
  const missingRun = await makePlannedRun(missingBase, {
    baseSha: "f".repeat(40)
  })

  await assertRejectsCode(prepareImplementationWorkspace(missingRun.run.runId, {
    expectedVersion: missingRun.run.version,
    writeDataDir: missingBase.writeDataDir,
    workspaceRegistry: missingBase.registry
  }), "WORKSPACE_BASE_SHA_MISSING")

  const identityMismatch = await makeSourceRepo({
    remote: "git@github.com:Linardi1328/not-approved.git"
  })
  const identityRun = await makePlannedRun(identityMismatch)

  await assertRejectsCode(prepareImplementationWorkspace(identityRun.run.runId, {
    expectedVersion: identityRun.run.version,
    writeDataDir: identityMismatch.writeDataDir,
    workspaceRegistry: identityMismatch.registry
  }), "WORKSPACE_REPOSITORY_IDENTITY_INVALID")

  const dirty = await makeSourceRepo()
  const dirtyRun = await makePlannedRun(dirty)
  await writeFile(join(dirty.sourceRepoPath, "dirty.txt"), "untracked\n", "utf8")

  await assertRejectsCode(prepareImplementationWorkspace(dirtyRun.run.runId, {
    expectedVersion: dirtyRun.run.version,
    writeDataDir: dirty.writeDataDir,
    workspaceRegistry: dirty.registry
  }), "WORKSPACE_SOURCE_DIRTY")
})

test("workspace roots reject traversal, symlinks, nested roots, and collisions", async () => {
  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)

  await assertRejectsCode(prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: {
      [fixture.project.id]: {
        sourceRepoPath: `${fixture.sourceRepoPath}/../source`,
        workspaceRoot: fixture.workspaceRoot
      }
    }
  }), "WORKSPACE_REGISTRY_INVALID")

  await assertRejectsCode(prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: {
      [fixture.project.id]: {
        sourceRepoPath: fixture.sourceRepoPath,
        workspaceRoot: join(fixture.sourceRepoPath, "nested-workspaces")
      }
    }
  }), "WORKSPACE_ROOT_UNSAFE")

  const realWorkspaceRoot = join(fixture.root, "real-workspaces")
  const linkedWorkspaceRoot = join(fixture.root, "linked-workspaces")
  await mkdir(realWorkspaceRoot)
  await symlink(realWorkspaceRoot, linkedWorkspaceRoot)

  await assertRejectsCode(prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: {
      [fixture.project.id]: {
        sourceRepoPath: fixture.sourceRepoPath,
        workspaceRoot: linkedWorkspaceRoot
      }
    }
  }), "WORKSPACE_PATH_ESCAPE")

  await mkdir(join(fixture.workspaceRoot, fixture.project.id), { recursive: true })
  await mkdir(join(fixture.workspaceRoot, fixture.project.id, makeDevelopmentWorkspaceId(planned.run)))

  await assertRejectsCode(prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  }), "WORKSPACE_COLLISION")
})

test("successful workspace creation starts an isolated branch exactly at run base SHA", async () => {
  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)
  const result = await prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    now: planned.now
  })

  assert.equal(result.ok, true)
  assert.equal(result.run.status, "implementation_in_progress")
  assert.equal(result.run.version, planned.run.version + 1)
  assert.equal(result.run.branch, makeDevelopmentWorkspaceBranchName(planned.run))
  assert.notEqual(result.run.branch, "main")
  assert.notEqual(result.run.branch, "master")
  assert.equal(result.run.headSha, fixture.baseSha)
  assert.equal(result.workspace.baseSha, fixture.baseSha)
  assert.equal(result.workspace.workspaceRef, `${DEVELOPMENT_WORKSPACE_STORE_DIR}/${fixture.project.id}/${result.workspace.workspaceId}`)

  const projectWorkspaceRoot = join(fixture.workspaceRoot, fixture.project.id)
  const workspacePath = join(projectWorkspaceRoot, result.workspace.workspaceId)

  assert.equal(modeBits(await stat(fixture.workspaceRoot)), 0o700)
  assert.equal(modeBits(await stat(projectWorkspaceRoot)), 0o700)
  assert.equal((await lstat(workspacePath)).isSymbolicLink(), false)
  assert.equal(await git(["rev-parse", "HEAD"], workspacePath), fixture.baseSha)
  assert.equal(await git(["symbolic-ref", "--short", "HEAD"], workspacePath), result.run.branch)
  assert.equal(await git(["rev-parse", `refs/heads/${result.run.branch}`], fixture.sourceRepoPath), fixture.baseSha)

  const evidence = result.run.evidence.implementation.at(-1)
  assert.equal(evidence.kind, "implementation")
  assert.equal(evidence.sha, fixture.baseSha)
  assert.equal(evidence.source, DEVELOPMENT_WORKSPACE_MANAGER_ID)
  assert.equal(evidence.metadata.branch, result.run.branch)
  assert.equal(evidence.metadata.workspaceId, result.workspace.workspaceId)
  assert.equal(evidence.metadata.repo, fixture.project.fullName)
  assert.doesNotMatch(JSON.stringify(result.run), /fatal:|SENSITIVE_TEST_SENTINEL|gho_fake_token/u)
  assert.doesNotMatch(JSON.stringify(evidence.metadata), new RegExp(fixture.sourceRepoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"))

  const reloaded = await readDevelopmentRun(planned.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(reloaded.status, "implementation_in_progress")
  assert.equal(reloaded.history.at(-1).toStatus, "implementation_in_progress")

  const inspection = await inspectImplementationWorkspace(planned.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })
  assert.equal(inspection.exists, true)
  assert.equal(inspection.matches, true)
  assert.equal(inspection.status, "matching")
  assert.equal(inspection.facts.headSha, fixture.baseSha)
})

test("default managed workspace root is derived from PPO write data", async () => {
  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)
  const result = await prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: {
      [fixture.project.id]: {
        sourceRepoPath: fixture.sourceRepoPath
      }
    }
  })
  const expectedWorkspacePath = join(
    fixture.writeDataDir,
    DEVELOPMENT_WORKSPACE_STORE_DIR,
    fixture.project.id,
    result.workspace.workspaceId
  )

  assert.equal((await stat(expectedWorkspacePath)).isDirectory(), true)
  assert.equal(result.workspace.workspaceRef, `${DEVELOPMENT_WORKSPACE_STORE_DIR}/${fixture.project.id}/${result.workspace.workspaceId}`)
})

test("concurrent workspace creation allows only one owner", async () => {
  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)
  const results = await Promise.allSettled([
    prepareImplementationWorkspace(planned.run.runId, {
      expectedVersion: planned.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry
    }),
    prepareImplementationWorkspace(planned.run.runId, {
      expectedVersion: planned.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry
    })
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => (
    result.status === "rejected" &&
    result.reason instanceof DevelopmentRunStateError &&
    ["WORKSPACE_COLLISION", "WORKSPACE_GIT_FAILED", "STALE_RUN_VERSION"].includes(result.reason.code)
  )).length, 1)
})

function makePreflightFakeRunner({ sourceRepoPath, project, baseSha, branchName, failOn }) {
  const calls = []

  const runner = async (args) => {
    calls.push([...args])
    const signature = args.slice(2).join(" ")

    if (failOn && signature.startsWith(failOn.command)) {
      const error = new DevelopmentRunStateError(
        "WORKSPACE_GIT_FAILED",
        "Git operation failed; no raw Git output was stored."
      )
      if (failOn.ambiguous) {
        error.ambiguous = true
      }
      throw error
    }

    if (signature === "rev-parse --show-toplevel") {
      return { stdout: `${sourceRepoPath}\n` }
    }
    if (signature === "remote get-url origin") {
      return { stdout: `git@github.com:${project.fullName}.git\n` }
    }
    if (signature.startsWith("cat-file -e ")) {
      return { stdout: "" }
    }
    if (signature === "status --porcelain=v1 --untracked-files=all") {
      return { stdout: "" }
    }
    if (signature === "symbolic-ref --short HEAD") {
      return { stdout: "main\n" }
    }
    if (signature === `check-ref-format --branch ${branchName}`) {
      return { stdout: `${branchName}\n` }
    }
    if (signature === `show-ref --verify --quiet refs/heads/${branchName}`) {
      const error = new DevelopmentRunStateError(
        "WORKSPACE_GIT_FAILED",
        "Git operation failed; no raw Git output was stored."
      )
      error.exitCode = 1
      throw error
    }
    if (signature === `branch ${branchName} ${baseSha}`) {
      return { stdout: "" }
    }
    if (signature === `branch -D ${branchName}`) {
      return { stdout: "" }
    }
    if (signature.startsWith(`worktree add `)) {
      return { stdout: "" }
    }
    if (signature.startsWith("worktree remove --force ")) {
      return { stdout: "" }
    }
    if (signature === "rev-parse HEAD") {
      return { stdout: `${baseSha}\n` }
    }
    if (signature === `rev-parse refs/heads/${branchName}`) {
      return { stdout: `${baseSha}\n` }
    }

    return { stdout: "" }
  }

  return {
    calls,
    runner
  }
}

test("definite partial branch creation failure is cleaned up", async () => {
  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)
  const branchName = makeDevelopmentWorkspaceBranchName(planned.run)
  const fake = makePreflightFakeRunner({
    sourceRepoPath: fixture.sourceRepoPath,
    project: fixture.project,
    baseSha: fixture.baseSha,
    branchName,
    failOn: {
      command: "worktree add "
    }
  })

  await assertRejectsCode(prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    gitRunner: fake.runner
  }), "WORKSPACE_GIT_FAILED")

  assert.equal(fake.calls.some((args) => args.slice(2).join(" ") === `branch -D ${branchName}`), true)
})

test("ambiguous workspace mutation outcome fails closed and leaves reconciliation to the owner", async () => {
  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)
  const branchName = makeDevelopmentWorkspaceBranchName(planned.run)
  const fake = makePreflightFakeRunner({
    sourceRepoPath: fixture.sourceRepoPath,
    project: fixture.project,
    baseSha: fixture.baseSha,
    branchName,
    failOn: {
      command: "worktree add ",
      ambiguous: true
    }
  })

  await assertRejectsCode(prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry,
    gitRunner: fake.runner
  }), "WORKSPACE_OUTCOME_AMBIGUOUS")

  assert.equal(fake.calls.some((args) => args.slice(2).join(" ") === `branch -D ${branchName}`), false)
})

test("workspace inspection is read-only and reports missing or mismatched workspaces", async () => {
  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)

  const missing = await inspectImplementationWorkspace(planned.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })

  assert.equal(missing.exists, false)
  assert.equal(missing.matches, false)
  assert.equal(missing.status, "missing")

  const prepared = await prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })
  const workspacePath = join(fixture.workspaceRoot, fixture.project.id, prepared.workspace.workspaceId)
  await git(["checkout", "--detach"], workspacePath)

  const mismatch = await inspectImplementationWorkspace(planned.run.runId, {
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: fixture.registry
  })

  assert.equal(mismatch.exists, true)
  assert.equal(mismatch.matches, false)
  assert.equal(mismatch.status, "mismatch")
})

test("workspace manager preserves Phase 5 and Phase 6A/6B route and execution boundaries", async () => {
  const moduleSource = await readFile(new URL("development-workspace-manager.mjs", import.meta.url), "utf8")
  const commandSource = await readFile(new URL("ppo-command.mjs", import.meta.url), "utf8")
  const bridgeSource = await readFile(new URL("../openclaw/plugins/ppo-local/bridge.mjs", import.meta.url), "utf8")

  assert.equal(commandSource.includes("development-workspace-manager"), false)
  assert.equal(bridgeSource.includes("development-workspace-manager"), false)
  assert.equal(moduleSource.includes("execFileAsync(\"git\", args"), true)
  assert.equal(moduleSource.includes("shell: true"), false)
  assert.equal(moduleSource.includes("api.github.com"), false)
  assert.equal(moduleSource.toLowerCase().includes("openai"), false)
  assert.equal(moduleSource.toLowerCase().includes("codex exec"), false)
  assert.equal(moduleSource.toLowerCase().includes("git push"), false)
  assert.equal(moduleSource.toLowerCase().includes("git merge"), false)
  assert.equal(moduleSource.toLowerCase().includes("workflow_dispatch"), false)
  assert.equal(moduleSource.toLowerCase().includes("systemctl"), false)
  assert.equal(moduleSource.toLowerCase().includes("/ppo continue"), false)

  const fixture = await makeSourceRepo()
  const planned = await makePlannedRun(fixture)

  await assertRejectsCode(prepareImplementationWorkspace(planned.run.runId, {
    expectedVersion: planned.run.version,
    writeDataDir: fixture.writeDataDir,
    workspaceRegistry: {
      unknown: {
        sourceRepoPath: fixture.sourceRepoPath,
        workspaceRoot: fixture.workspaceRoot
      }
    }
  }), "UNKNOWN_PROJECT")

  let formatted = ""

  try {
    const badFake = async () => {
      throw new Error("fatal: SENSITIVE_TEST_SENTINEL gho_fake_token")
    }
    await prepareImplementationWorkspace(planned.run.runId, {
      expectedVersion: planned.run.version,
      writeDataDir: fixture.writeDataDir,
      workspaceRegistry: fixture.registry,
      gitRunner: badFake
    })
  } catch (error) {
    formatted = formatDevelopmentWorkspaceManagerError(error)
  }

  assert.doesNotMatch(formatted, /SENSITIVE_TEST_SENTINEL|gho_fake_token|fatal:/u)
})
