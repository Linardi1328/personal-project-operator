import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdtemp,
  readFile,
  readdir
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { readDevelopmentRun } from "./development-run-state.mjs"
import {
  DEVELOPMENT_START_ROUTE_ID,
  MAX_PHASE_7A_START_OUTPUT_CHARS,
  PHASE_7A_START_POLICY_HASH,
  PHASE_7A_START_POLICY_ID,
  handlePpoDevelopmentStartCommand
} from "./development-start-route.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"

const BASE_SHA = "a".repeat(40)
const RUN_ID = "C".repeat(43)
const PROJECTS = listPhase2GitHubProjects()
const PROJECTS_BY_ID = new Map(PROJECTS.map((project) => [project.id, project]))

function makeClock(start = "2026-08-25T00:00:00.000Z") {
  let tick = 0
  const startMs = Date.parse(start)

  return () => {
    const value = new Date(startMs + tick * 1000)
    tick += 1
    return value
  }
}

async function tempWriteDataDir(label = "ppo-7a-") {
  return mkdtemp(join(tmpdir(), label))
}

function roadmap() {
  return [
    "# Roadmap",
    "",
    "## Phase 6 - Autonomous Development Orchestration Foundations",
    "",
    "### Phase 6B - Deterministic autonomous next-stage planner foundation",
    "",
    "- Determine the next supported stage from approved project docs and GitHub read-only facts.",
    ""
  ].join("\n")
}

function projectDocument(projectId, overrides = {}) {
  const project = PROJECTS_BY_ID.get(projectId)

  return [
    `# ${project.displayName}`,
    "",
    "## Project",
    "",
    project.displayName,
    "",
    "## Repo",
    "",
    `\`${project.fullName}\``,
    "",
    "## Connection status",
    "",
    "Connected candidate.",
    "",
    "## Current role",
    "",
    "Fixture role.",
    "",
    "## OpenClaw priority",
    "",
    "High.",
    "",
    "## Current phase",
    "",
    overrides.currentPhase ?? "Phase 0 documentation foundation.",
    "",
    "## Last known status",
    "",
    overrides.lastKnownStatus ?? "Documented as an active project candidate.",
    "",
    "## Next action",
    "",
    overrides.nextAction ?? "Add provider validation tests.",
    "",
    "## Codex fit",
    "",
    "Small deterministic prompts only.",
    "",
    "## Do not change",
    "",
    "- Do not add credentials.",
    "",
    "## Known risks",
    "",
    "- Fixture risk.",
    ""
  ].join("\n")
}

function sourcesFor(projectId, overrides = {}) {
  return {
    "ROADMAP.md": roadmap(),
    [`projects/${projectId}.md`]: projectDocument(projectId, overrides)
  }
}

function snapshotFor(projectId) {
  const project = PROJECTS_BY_ID.get(projectId)

  return {
    project: {
      id: project.id,
      displayName: project.displayName,
      fullName: project.fullName
    },
    repository: {
      fullName: project.fullName,
      defaultBranch: "main",
      updatedAt: "2026-08-25T00:00:00Z"
    },
    recentCommits: [{
      sha: BASE_SHA,
      shortSha: BASE_SHA.slice(0, 7),
      timestamp: "2026-08-25T00:00:00Z"
    }],
    openPullRequests: [],
    openIssues: []
  }
}

function fakeGitHubClient(calls = []) {
  return {
    async getProjectSnapshot(projectId) {
      calls.push(["getProjectSnapshot", projectId])
      return snapshotFor(projectId)
    }
  }
}

function trustedRuntime(phase6bOptions = {}, trustedDependencies = {}) {
  const runtime = {
    trustedPhase6BOptions: phase6bOptions
  }

  if (Object.keys(trustedDependencies).length > 0) {
    runtime.trustedDependencies = trustedDependencies
  }

  return runtime
}

function validPlannedChildResult(projectId = "khlim-assist") {
  return {
    ok: true,
    outcome: "planned",
    plan: {
      outcome: "planned",
      project: { id: projectId },
      next: { stage: "implementation" },
      baseSha: BASE_SHA
    },
    run: {
      runId: RUN_ID,
      project: { id: projectId },
      status: "planned",
      baseSha: BASE_SHA,
      headSha: BASE_SHA
    }
  }
}

async function snapshotTree(root) {
  const rows = []

  async function walk(path, relativePath) {
    const info = await lstat(path)

    if (info.isDirectory()) {
      const entries = (await readdir(path)).sort()
      rows.push({ path: relativePath, type: "directory", entries })

      for (const entry of entries) {
        await walk(join(path, entry), relativePath === "." ? entry : join(relativePath, entry))
      }
      return
    }

    if (info.isFile()) {
      rows.push({
        path: relativePath,
        type: "file",
        size: info.size,
        hash: createHash("sha256").update(await readFile(path)).digest("hex")
      })
      return
    }

    rows.push({ path: relativePath, type: "other" })
  }

  await walk(root, ".")
  return rows
}

function runPpoCommand(args) {
  return spawnSync(process.execPath, ["local-operator/ppo-command.mjs", ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  })
}

function assertStartOutputIsBounded(output) {
  assert.equal(output.length <= MAX_PHASE_7A_START_OUTPUT_CHARS, true)
  assert.doesNotMatch(output, /SENSITIVE_TEST_SENTINEL|token|secret|password|authorization|stack|stderr|stdout/iu)
}

test("Phase 7A route exposes the fixed five-project registry through Phase 6B run creation", async () => {
  for (const project of PROJECTS) {
    const writeDataDir = await tempWriteDataDir()
    const calls = []
    const result = await handlePpoDevelopmentStartCommand(project.id, trustedRuntime({
      writeDataDir,
      now: makeClock(),
      sources: sourcesFor(project.id),
      githubClient: fakeGitHubClient(calls)
    }))

    assert.equal(result.ok, true, project.id)
    assert.equal(result.route, DEVELOPMENT_START_ROUTE_ID)
    assert.equal(result.policy.id, PHASE_7A_START_POLICY_ID)
    assert.equal(result.policy.hash, PHASE_7A_START_POLICY_HASH)
    assert.match(result.output, /^PPO Development Start/u)
    assert.match(result.output, new RegExp(`Project: ${project.id}`, "u"))
    assert.match(result.output, /Status: planned/u)
    assert.match(result.output, /Next stage: implementation/u)
    assert.match(result.output, new RegExp(`Base SHA: ${BASE_SHA}`, "u"))
    assert.match(result.output, /Next command: \/ppo continue [A-Za-z0-9_-]{43}/u)
    assertStartOutputIsBounded(result.output)
    assert.deepEqual(calls, [["getProjectSnapshot", project.id]])
  }
})

test("Phase 7A successful start creates exactly one planned Phase 6A run through Phase 6B", async () => {
  const writeDataDir = await tempWriteDataDir()
  const result = await handlePpoDevelopmentStartCommand("khlim-assist", trustedRuntime({
    writeDataDir,
    now: makeClock(),
    sources: sourcesFor("khlim-assist"),
    githubClient: fakeGitHubClient()
  }))
  const runId = result.output.match(/Run: ([A-Za-z0-9_-]{43})/u)?.[1]

  assert.equal(result.ok, true)
  assert.ok(runId)

  const run = await readDevelopmentRun(runId, { writeDataDir })
  assert.equal(run.project.id, "khlim-assist")
  assert.equal(run.status, "planned")
  assert.equal(run.baseSha, BASE_SHA)
  assert.equal(run.headSha, BASE_SHA)
  assert.deepEqual(run.history.map((event) => event.toStatus), [
    "created",
    "planning_in_progress",
    "planned"
  ])
  assert.equal(run.evidence.planning.length, 1)
  assert.equal(run.evidence.planning[0].source, "phase-6b-next-stage-planner")
  assert.match(result.output, new RegExp(`Next command: /ppo continue ${runId}`, "u"))
})

test("Phase 7A route adapter delegates to createPlannedDevelopmentRun exactly once with isolated trusted options", async () => {
  let calls = 0
  const trustedPhase6BOptions = {
    writeDataDir: "/tmp/phase-7a-trusted-write-data",
    now: makeClock(),
    sources: sourcesFor("khlim-assist"),
    githubClient: fakeGitHubClient(),
    expectedVersion: 99,
    branch: "main",
    action: "continue",
    policy: "phase-6b"
  }
  const result = await handlePpoDevelopmentStartCommand("khlim-assist", {
    marker: "internal-test-option",
    createPlannedDevelopmentRun: async () => {
      assert.fail("top-level route options must not provide the child planner dependency")
    },
    trustedPhase6BOptions,
    trustedDependencies: {
      createPlannedDevelopmentRun: async (projectId, options) => {
        calls += 1
        assert.equal(projectId, "khlim-assist")
        assert.equal(options.writeDataDir, trustedPhase6BOptions.writeDataDir)
        assert.equal(options.now, trustedPhase6BOptions.now)
        assert.equal(options.sources, trustedPhase6BOptions.sources)
        assert.equal(options.githubClient, trustedPhase6BOptions.githubClient)
        assert.equal(options.expectedVersion, undefined)
        assert.equal(options.branch, undefined)
        assert.equal(options.action, undefined)
        assert.equal(options.policy, undefined)
        assert.equal(options.marker, undefined)

        return {
          ...validPlannedChildResult(),
          plan: {
            ...validPlannedChildResult().plan,
            next: { stage: "planning" }
          }
        }
      }
    }
  })

  assert.equal(calls, 1)
  assert.equal(result.ok, true)
  assert.match(result.output, new RegExp(`Run: ${RUN_ID}`, "u"))
  assert.match(result.output, /Next stage: planning/u)
})

test("Phase 7A rejects malformed or inconsistent Phase 6B planned child results", async () => {
  for (const [label, mutate] of [
    ["missing plan", (result) => {
      result.plan = null
    }],
    ["missing run", (result) => {
      result.run = null
    }],
    ["plan outcome mismatch", (result) => {
      result.plan.outcome = "owner_action_required"
    }],
    ["plan project mismatch", (result) => {
      result.plan.project.id = "portfolio"
    }],
    ["run project mismatch", (result) => {
      result.run.project.id = "portfolio"
    }],
    ["run status mismatch", (result) => {
      result.run.status = "created"
    }],
    ["bad run id", (result) => {
      result.run.runId = "short"
    }],
    ["unsupported next stage", (result) => {
      result.plan.next.stage = "deploy"
    }],
    ["missing next stage", (result) => {
      delete result.plan.next.stage
    }],
    ["bad plan base SHA", (result) => {
      result.plan.baseSha = "not-a-sha"
    }],
    ["run base SHA mismatch", (result) => {
      result.run.baseSha = "b".repeat(40)
    }],
    ["bad run head SHA", (result) => {
      result.run.headSha = "not-a-sha"
    }],
    ["run head SHA mismatch", (result) => {
      result.run.headSha = "c".repeat(40)
    }],
    ["missing required run head SHA", (result) => {
      delete result.run.headSha
    }]
  ]) {
    let calls = 0
    const childResult = validPlannedChildResult()
    mutate(childResult)
    const result = await handlePpoDevelopmentStartCommand("khlim-assist", trustedRuntime({}, {
      createPlannedDevelopmentRun: async (projectId, options) => {
        calls += 1
        assert.equal(projectId, "khlim-assist")
        assert.deepEqual(options, {})
        return childResult
      }
    }))

    assert.equal(calls, 1, label)
    assert.equal(result.ok, false, label)
    assert.equal(result.code, "ROUTE_UNAVAILABLE", label)
    assert.equal(result.outcome, "owner_action_required", label)
    assert.match(result.output, /Reason: ROUTE_UNAVAILABLE/u, label)
    assert.match(result.output, /Run: none/u, label)
    assert.doesNotMatch(result.output, /Next command:|\/ppo continue|Run: C{43}/u, label)
  }
})

test("Phase 7A allows only exact planning or implementation child stages", async () => {
  for (const stage of ["planning", "implementation"]) {
    const result = await handlePpoDevelopmentStartCommand("khlim-assist", trustedRuntime({}, {
      createPlannedDevelopmentRun: async () => {
        const childResult = validPlannedChildResult()
        childResult.plan.next.stage = stage
        return childResult
      }
    }))

    assert.equal(result.ok, true, stage)
    assert.match(result.output, new RegExp(`Next stage: ${stage}`, "u"))
    assert.match(result.output, new RegExp(`Next command: /ppo continue ${RUN_ID}`, "u"))
  }
})

test("owner-action-required Phase 6B outcomes create no run and expose only bounded reason data", async () => {
  const writeDataDir = await tempWriteDataDir()
  const before = await snapshotTree(writeDataDir)
  const result = await handlePpoDevelopmentStartCommand("khlim-assist", trustedRuntime({
    writeDataDir,
    now: makeClock(),
    sources: sourcesFor("khlim-assist", {
      nextAction: "Choose the product workflow to implement next."
    }),
    githubClient: fakeGitHubClient()
  }))
  const after = await snapshotTree(writeDataDir)

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "owner_action_required")
  assert.match(result.output, /Status: owner_action_required/u)
  assert.match(result.output, /Reason: PRODUCT_DECISION_REQUIRED/u)
  assert.match(result.output, /Run: none/u)
  assert.doesNotMatch(result.output, /Choose the product workflow|Next command|planning_in_progress|created/u)
  assertStartOutputIsBounded(result.output)
  assert.deepEqual(after, before)
})

test("unknown, missing, extra, path, repo-name, and option start inputs are rejected before planning", async () => {
  for (const projectId of [
    undefined,
    "",
    "unknown",
    "prooflab",
    "KHLIM-assist",
    "../khlim-assist",
    "Linardi1328/khlim-assist",
    "khlim-assist extra",
    "khlim-assist --branch main",
    `${"d".repeat(40)}`
  ]) {
    let calls = 0
    const result = await handlePpoDevelopmentStartCommand(projectId, trustedRuntime({}, {
      createPlannedDevelopmentRun: async () => {
        calls += 1
      }
    }))

    assert.equal(result.ok, false, String(projectId))
    assert.equal(calls, 0, String(projectId))
    assert.match(result.output, /Outcome: owner_action_required/u)
    assert.doesNotMatch(result.output, /Next command:/u)
  }
})

test("terminal start parser rejects malformed envelopes and start-adjacent commands before legacy normalization", () => {
  for (const args of [
    ["start"],
    ["start", "unknown"],
    ["start", "khlim-assist", "extra"],
    ["start  khlim-assist"],
    [" start khlim-assist"],
    ["start khlim-assist "],
    ["/ppo", "start"],
    ["/ppo", "start", "unknown"],
    ["/ppo", "start", "khlim-assist", "extra"],
    ["/ppo  start khlim-assist"],
    ["/ppo start  khlim-assist"],
    ["/ppo start khlim-assist --continue"],
    ["start-run", "khlim-assist"],
    ["develop", "khlim-assist"],
    ["continue", "khlim-assist"]
  ]) {
    const result = runPpoCommand(args)

    assert.notEqual(result.status, 0, args.join(" "))
    assert.match(result.stdout, /^Unsupported PPO command:/u, args.join(" "))
    assert.doesNotMatch(result.stdout, /PPO Development Start|Next command:/u, args.join(" "))
  }
})

test("Phase 7A source excludes model routing, new OpenClaw tool, automatic continue, and production actions", async () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url))
  const routeSource = await readFile(join(repoRoot, "local-operator", "development-start-route.mjs"), "utf8")
  const commandSource = await readFile(join(repoRoot, "local-operator", "ppo-command.mjs"), "utf8")
  const bridgeSource = await readFile(join(repoRoot, "openclaw", "plugins", "ppo-local", "bridge.mjs"), "utf8")
  const pluginSource = await readFile(join(repoRoot, "openclaw", "plugins", "ppo-local", "index.mjs"), "utf8")

  assert.equal(routeSource.includes("createPlannedDevelopmentRun"), true)
  assert.equal(routeSource.includes("planNextDevelopmentStage("), false)
  assert.equal(routeSource.includes("createDevelopmentRun("), false)
  assert.equal(bridgeSource.includes("shell: false"), true)
  assert.equal(pluginSource.match(/name: "ppo_local"/gu)?.length, 1)

  for (const forbidden of [
    "openai",
    "chatgpt",
    "codex exec",
    "--method POST",
    "git add",
    "git commit",
    "git push",
    "git merge",
    "git checkout",
    "systemctl",
    "deploy_in_progress",
    "verification_in_progress",
    "rollback_in_progress",
    "workflow_dispatch"
  ]) {
    assert.equal(routeSource.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden)
  }

  assert.equal(commandSource.includes("handlePpoDevelopmentContinueCommand(strictStart"), false)
  assert.equal(bridgeSource.includes("parseStartCommand(rawCommand)"), true)
})
