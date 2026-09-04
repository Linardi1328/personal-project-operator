import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import {
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  createPersonalProjectOperatorSelfDevelopmentRun,
  readPersonalProjectOperatorSelfDevelopmentRun,
  transitionPersonalProjectOperatorSelfDevelopmentRun
} from "./development-run-state.mjs"
import {
  createPlannedPersonalProjectOperatorSelfDevelopmentRun,
  planNextDevelopmentStage
} from "./development-next-stage-planner.mjs"
import {
  PPO_SELF_DEVELOPMENT_CONTINUE_POLICY_ID,
  executeDevelopmentContinue,
  executePersonalProjectOperatorSelfDevelopmentContinue
} from "./development-continue-orchestrator.mjs"
import {
  loadPersonalProjectOperatorSelfDevelopmentRuntimeProfile
} from "./development-continue-runtime-profile.mjs"
import {
  PPO_SELF_DEVELOPMENT_RECOVERY_POLICY_ID,
  executePersonalProjectOperatorSelfDevelopmentRecovery
} from "./development-recovery-coordinator.mjs"
import {
  PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION,
  confirmPersonalProjectOperatorSelfDevelopmentCancellation,
  stagePersonalProjectOperatorSelfDevelopmentCancellation
} from "./development-self-cancellation.mjs"
import {
  inspectPersonalProjectOperatorSelfDevelopment,
  startPersonalProjectOperatorSelfDevelopment
} from "./development-self-controller.mjs"
import { handlePpoSelfDevelopmentCommand } from "./ppo-self-development-command.mjs"
import { prepareImplementationWorkspace } from "./development-workspace-manager.mjs"
import {
  getApprovedDevelopmentProject,
  getOrdinaryDevelopmentProject,
  listOrdinaryDevelopmentProjects
} from "./github-project-registry.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const RUN_ID = "S".repeat(43)
const SELF = PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
const execFileAsync = promisify(execFile)

function makeClock() {
  let tick = 0
  return () => new Date(Date.parse("2026-09-04T00:00:00.000Z") + tick++ * 1000)
}

async function tempWriteDataDir() {
  return await mkdtemp(join(tmpdir(), "ppo-stage0-"))
}

async function git(args, cwd) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false
  })
  return String(result.stdout || "").trim()
}

function roadmap() {
  return [
    "# Roadmap",
    "",
    "### Phase 6B - Deterministic autonomous next-stage planner foundation",
    "",
    "Approved deterministic planning boundary."
  ].join("\n")
}

function projectDocument() {
  return [
    "# Personal Project Operator",
    "",
    "## Project",
    "",
    SELF.displayName,
    "",
    "## Repo",
    "",
    `\`${SELF.fullName}\``,
    "",
    "## Connection status",
    "",
    "Connected candidate.",
    "",
    "## Current phase",
    "",
    "Stage 0.",
    "",
    "## Last known status",
    "",
    "The local self-development controller is ready.",
    "",
    "## Next action",
    "",
    "Add the Customer Zero project capability manifest implementation foundation.",
    ""
  ].join("\n")
}

function githubClient() {
  return {
    async getProjectSnapshot(projectId) {
      assert.equal(projectId, SELF.id)
      return {
        project: {
          id: SELF.id,
          displayName: SELF.displayName,
          fullName: SELF.fullName
        },
        repository: {
          fullName: SELF.fullName,
          defaultBranch: "main",
          updatedAt: "2026-09-04T00:00:00.000Z"
        },
        recentCommits: [{
          sha: BASE_SHA,
          shortSha: BASE_SHA.slice(0, 7),
          timestamp: "2026-09-04T00:00:00.000Z"
        }],
        openPullRequests: [],
        openIssues: []
      }
    }
  }
}

function planningOptions(writeDataDir) {
  return {
    writeDataDir,
    now: makeClock(),
    sources: {
      "ROADMAP.md": roadmap(),
      "projects/personal-project-operator.md": projectDocument()
    },
    githubClient: githubClient()
  }
}

function selfRun(status, overrides = {}) {
  return {
    runId: RUN_ID,
    version: overrides.version ?? 4,
    project: { ...SELF },
    task: "Add the bounded Customer Zero foundation.",
    status,
    stage: status === "created" ? "intake" : "implementation",
    baseSha: BASE_SHA,
    branch: "main",
    headSha: overrides.headSha || HEAD_SHA,
    attempts: {
      planning: 0,
      implementation: 0,
      test: 0,
      review: 0,
      merge: 0,
      deploy: 0,
      verification: 0,
      rollback: 0
    },
    evidence: {
      planning: [],
      implementation: [],
      review: [],
      test: [],
      merge: [],
      deploy: [],
      verification: [],
      rollback: []
    },
    ...overrides
  }
}

test("Stage 0 keeps six ordinary projects while approving only the fixed PPO self project internally", () => {
  assert.equal(listOrdinaryDevelopmentProjects().length, 6)
  assert.equal(getOrdinaryDevelopmentProject(SELF.id), null)
  assert.deepEqual(getApprovedDevelopmentProject(SELF.id), SELF)
})

test("Stage 0 planner creates a fixed PPO run while the ordinary planner still refuses PPO", async () => {
  const writeDataDir = await tempWriteDataDir()
  const planned = await createPlannedPersonalProjectOperatorSelfDevelopmentRun(planningOptions(writeDataDir))

  assert.equal(planned.ok, true)
  assert.equal(planned.run.project.id, SELF.id)
  assert.equal(planned.run.project.fullName, SELF.fullName)
  assert.equal(planned.run.status, "planned")
  assert.equal(planned.run.baseSha, BASE_SHA)
  assert.equal(planned.run.headSha, BASE_SHA)

  await assert.rejects(
    planNextDevelopmentStage(SELF.id, planningOptions(writeDataDir)),
    (error) => error?.code === "UNKNOWN_PROJECT"
  )
})

test("Stage 0 planner accepts the checked-in PPO project next action", async () => {
  const writeDataDir = await tempWriteDataDir()
  const checkedInProjectDocument = await readFile(
    new URL("../projects/personal-project-operator.md", import.meta.url),
    "utf8"
  )
  const planned = await createPlannedPersonalProjectOperatorSelfDevelopmentRun({
    ...planningOptions(writeDataDir),
    sources: {
      "ROADMAP.md": roadmap(),
      "projects/personal-project-operator.md": checkedInProjectDocument
    }
  })

  assert.equal(planned.ok, true)
  assert.equal(planned.outcome, "planned")
  assert.equal(planned.run.status, "planned")
  assert.equal(planned.run.task.includes("deployment-provider metadata"), true)
})

test("Stage 0 start validates the self project and returns only bounded run metadata", async () => {
  const writeDataDir = await tempWriteDataDir()
  const result = await startPersonalProjectOperatorSelfDevelopment({
    createPlannedRun: (options) => createPlannedPersonalProjectOperatorSelfDevelopmentRun({
      ...planningOptions(writeDataDir),
      ...options
    })
  })

  assert.equal(result.ok, true)
  assert.equal(result.project, SELF.id)
  assert.equal(result.status, "planned")
  assert.equal(result.headSha, BASE_SHA)
  assert.equal(Object.hasOwn(result, "evidence"), false)
})

test("Stage 0 reuses the real isolated workspace manager for the fixed PPO repository", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ppo-stage0-workspace-")))
  const sourceRepoPath = join(root, "source")
  const workspaceRoot = join(root, "workspaces")
  const writeDataDir = join(root, "write-data")
  const now = makeClock()

  await mkdir(sourceRepoPath)
  await git(["init"], sourceRepoPath)
  await git(["checkout", "-B", "main"], sourceRepoPath)
  await git(["config", "user.email", "ppo-stage0@example.invalid"], sourceRepoPath)
  await git(["config", "user.name", "PPO Stage 0"], sourceRepoPath)
  await git(["remote", "add", "origin", `git@github.com:${SELF.fullName}.git`], sourceRepoPath)
  await writeFile(join(sourceRepoPath, "README.md"), "# PPO Stage 0 fixture\n", "utf8")
  await git(["add", "README.md"], sourceRepoPath)
  await git(["commit", "-m", "fixture"], sourceRepoPath)
  const baseSha = await git(["rev-parse", "HEAD"], sourceRepoPath)
  const created = await createPersonalProjectOperatorSelfDevelopmentRun({
    task: "Prepare the fixed self-development implementation workspace.",
    baseSha,
    branch: "main",
    headSha: baseSha,
    actor: "stage-0-test"
  }, { writeDataDir, now })
  const planning = await transitionPersonalProjectOperatorSelfDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress",
    actor: "stage-0-test"
  }, { writeDataDir, now })
  const planned = await transitionPersonalProjectOperatorSelfDevelopmentRun(created.runId, {
    expectedVersion: planning.version,
    status: "planned",
    actor: "stage-0-test"
  }, { writeDataDir, now })
  const prepared = await prepareImplementationWorkspace(planned.runId, {
    expectedVersion: planned.version,
    writeDataDir,
    now,
    allowPersonalProjectOperatorSelfDevelopmentProject: true,
    workspaceRegistry: {
      [SELF.id]: {
        sourceRepoPath,
        workspaceRoot
      }
    }
  })

  assert.equal(prepared.ok, true)
  assert.equal(prepared.run.status, "implementation_in_progress")
  assert.match(prepared.run.branch, /^ppo\/personal-project-operator\/implementation\/[a-f0-9]{16}$/u)
  assert.equal(prepared.run.project.fullName, SELF.fullName)
})

test("Stage 0 continuation dispatches one self child and ordinary continuation still refuses it", async () => {
  const run = selfRun("planned")
  const calls = []
  const options = {
    readRun: async () => structuredClone(run),
    childHandlers: {
      prepareImplementationWorkspace: async (runId, childOptions) => {
        calls.push({ runId, childOptions })
        return {
          ok: true,
          outcome: "implementation_workspace_ready",
          run: selfRun("implementation_in_progress", { version: 5 })
        }
      }
    },
    trustedRuntimeProfileProvider: async () => ({
      workspaceRegistry: {},
      codexConfig: {},
      testPolicyRegistry: {},
      reviewConfig: {}
    })
  }
  const selfResult = await executePersonalProjectOperatorSelfDevelopmentContinue(RUN_ID, options)
  const ordinaryResult = await executeDevelopmentContinue(RUN_ID, options)

  assert.equal(selfResult.ok, true)
  assert.equal(selfResult.policyId, PPO_SELF_DEVELOPMENT_CONTINUE_POLICY_ID)
  assert.equal(selfResult.after, "implementation_in_progress")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].childOptions.allowPersonalProjectOperatorSelfDevelopmentProject, true)
  assert.equal(ordinaryResult.ok, false)
  assert.equal(ordinaryResult.reason, "project_refused")
})

test("Stage 0 recovery is read-only, self-scoped, and separately policy-bound", async () => {
  const run = selfRun("implementation_ready")
  const result = await executePersonalProjectOperatorSelfDevelopmentRecovery(RUN_ID, {
    readRun: async () => structuredClone(run)
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "recovery_not_required")
  assert.equal(result.policyId, PPO_SELF_DEVELOPMENT_RECOVERY_POLICY_ID)
  assert.equal(result.run.project, SELF.id)
})

test("Stage 0 cancellation requires a current canonical run, exact version, and exact local confirmation", async () => {
  const writeDataDir = await tempWriteDataDir()
  const created = await createPersonalProjectOperatorSelfDevelopmentRun({
    task: "Cancel a quiescent self-development fixture.",
    baseSha: BASE_SHA,
    branch: "main",
    headSha: BASE_SHA,
    actor: "stage-0-test"
  }, { writeDataDir, now: makeClock() })
  const ready = await stagePersonalProjectOperatorSelfDevelopmentCancellation(created.runId, { writeDataDir })

  assert.equal(ready.ok, true)
  assert.equal(ready.outcome, "cancellation_ready")

  const refused = await confirmPersonalProjectOperatorSelfDevelopmentCancellation(
    created.runId,
    created.version,
    "wrong-confirmation",
    { writeDataDir }
  )
  assert.equal(refused.outcome, "confirmation_required")

  const cancelled = await confirmPersonalProjectOperatorSelfDevelopmentCancellation(
    created.runId,
    created.version,
    PPO_SELF_DEVELOPMENT_CANCELLATION_CONFIRMATION,
    { writeDataDir }
  )
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.afterStatus, "cancelled")

  const stored = await readPersonalProjectOperatorSelfDevelopmentRun(created.runId, { writeDataDir })
  assert.equal(stored.status, "cancelled")
})

test("Stage 0 status inspection is read-only and fails closed for a non-current canonical record", async () => {
  const result = await inspectPersonalProjectOperatorSelfDevelopment(RUN_ID, {
    inspectRun: async () => ({
      ok: true,
      canonicalState: "canonical_behind",
      recoveryRequired: true,
      record: selfRun("planned")
    })
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, "canonical_recovery_required")
})

test("Stage 0 fixed runtime uses five repository-wide gates and refuses Linux self-development", async () => {
  const files = new Set([
    "/Users/richie/.local/bin/codex",
    "/opt/homebrew/bin/git",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/ppo-independent-reviewer",
    "/usr/bin/sandbox-exec"
  ])
  const directories = new Set([
    "/Users/richie/personal-project-operator",
    "/Users/richie/.local/share/personal-project-operator/development-workspaces"
  ])
  const statImpl = async (path) => ({
    isFile: () => files.has(path),
    isDirectory: () => directories.has(path),
    isSymbolicLink: () => false
  })
  const profile = await loadPersonalProjectOperatorSelfDevelopmentRuntimeProfile({
    run: selfRun("implementation_ready")
  }, {
    platform: "darwin",
    statImpl,
    lstatImpl: statImpl,
    accessImpl: async () => {},
    execFileImpl: async () => ({ stdout: "ok\n", stderr: "" })
  })
  const policy = profile.testPolicyRegistry[SELF.id]

  assert.deepEqual(policy.steps.map((step) => step.id), [
    "syntax",
    "parallel-regression",
    "serial-regression",
    "critical-lifecycle",
    "integrated-acceptance"
  ])
  assert.equal(profile.workspaceRegistry[SELF.id].sourceRepoPath, "/Users/richie/personal-project-operator")

  await assert.rejects(
    loadPersonalProjectOperatorSelfDevelopmentRuntimeProfile({ run: selfRun("planned") }, {
      platform: "linux"
    }),
    (error) => error?.code === "CONTINUE_RUNTIME_NOT_READY"
  )
})

test("Stage 0 command parser exposes only strict local commands", async () => {
  const calls = []
  const result = await handlePpoSelfDevelopmentCommand(["continue", RUN_ID], {
    continueRun: async (runId) => {
      calls.push(runId)
      return {
        ok: true,
        runId,
        project: SELF.id,
        before: "planned",
        action: "phase-6c-prepare-workspace",
        outcome: "implementation_workspace_ready",
        after: "implementation_in_progress",
        headSha: HEAD_SHA
      }
    }
  })
  const malformed = await handlePpoSelfDevelopmentCommand(["continue", RUN_ID, "extra"], {
    continueRun: async () => assert.fail("malformed command must not dispatch")
  })

  assert.equal(result.ok, true)
  assert.deepEqual(calls, [RUN_ID])
  assert.match(result.output, /PPO Self-Development Continue/u)
  assert.equal(malformed.ok, false)
  assert.match(malformed.output, /invalid_command/u)
})

test("Stage 0 does not add self-development to ordinary OpenClaw command surfaces", async () => {
  const ppoCommandSource = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("ppo-command.mjs", import.meta.url), "utf8")
  ))
  const bridgeSource = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("../openclaw/plugins/ppo-local/bridge.mjs", import.meta.url), "utf8")
  ))

  assert.doesNotMatch(ppoCommandSource, /ppo-self-development-command|development-self-controller/u)
  assert.doesNotMatch(bridgeSource, /self-development/u)
})
