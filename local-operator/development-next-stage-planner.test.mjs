import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  DevelopmentRunStateError,
  createDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  DevelopmentNextStagePlannerError,
  MAX_PLANNER_RECORD_BYTES,
  MAX_PLANNER_PROJECT_DOC_BYTES,
  MAX_PLANNER_SOURCE_FACT_CHARS,
  MAX_PLANNER_TASK_CHARS,
  createPlannedDevelopmentRun,
  formatDevelopmentNextStagePlannerError,
  planExistingDevelopmentRun,
  planNextDevelopmentStage
} from "./development-next-stage-planner.mjs"
import { listOrdinaryDevelopmentProjects } from "./github-project-registry.mjs"
import {
  handleProjectNoteAddCommand,
  readProjectNoteRecords
} from "./project-note-add.mjs"

const BASE_SHA = "a".repeat(40)
const NEXT_SHA = "b".repeat(40)
const PROJECTS = listOrdinaryDevelopmentProjects()
const PROJECTS_BY_ID = new Map(PROJECTS.map((project) => [project.id, {
  ...project,
  fullName: `${project.owner}/${project.repo}`
}]))

function roadmap() {
  return [
    "# Roadmap",
    "",
    "## Phase 6 - Autonomous Development Orchestration Foundations",
    "",
    "### Phase 6B - Deterministic autonomous next-stage planner foundation",
    "",
    "- Determine the next supported stage from approved project docs and GitHub read-only facts.",
    "- Do not add Codex execution, GitHub writes, branch operations, deployments, or OpenClaw routes.",
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
    overrides.projectName ?? project.displayName,
    "",
    "## Repo",
    "",
    overrides.repo ?? `\`${project.fullName}\``,
    "",
    "## Connection status",
    "",
    overrides.connectionStatus ?? "Connected candidate.",
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
    overrides.nextAction ?? "Prepare read-only repository inspection before planning implementation work.",
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
  const sources = {
    "ROADMAP.md": overrides.roadmap ?? roadmap(),
    [`projects/${projectId}.md`]: overrides.projectDoc ?? projectDocument(projectId, overrides)
  }

  return sources
}

function snapshotFor(projectId, overrides = {}) {
  const project = PROJECTS_BY_ID.get(projectId)

  return {
    project: {
      id: project.id,
      displayName: project.displayName,
      fullName: project.fullName
    },
    repository: {
      fullName: overrides.fullName ?? project.fullName,
      defaultBranch: overrides.defaultBranch ?? "main",
      updatedAt: "2026-08-21T00:00:00Z"
    },
    recentCommits: overrides.recentCommits ?? [{
      sha: overrides.sha ?? BASE_SHA,
      shortSha: (overrides.sha ?? BASE_SHA).slice(0, 7),
      timestamp: "2026-08-21T00:00:00Z"
    }],
    openPullRequests: overrides.openPullRequests ?? [],
    openIssues: overrides.openIssues ?? []
  }
}

function fakeGitHubClient({ snapshots = {}, calls = [] } = {}) {
  return {
    async getProjectSnapshot(projectId) {
      calls.push({
        method: "getProjectSnapshot",
        projectId
      })

      return snapshots[projectId] || snapshotFor(projectId)
    }
  }
}

function makeClock() {
  let tick = 0
  const start = Date.parse("2026-08-21T00:00:00.000Z")

  return () => {
    const value = new Date(start + tick * 1000)
    tick += 1
    return value
  }
}

async function tempWriteDataDir(label = "ppo-6b-") {
  return mkdtemp(join(tmpdir(), label))
}

async function assertRejectsCode(promise, code, errorClass = DevelopmentNextStagePlannerError) {
  await assert.rejects(
    promise,
    (error) => error instanceof errorClass && error.code === code
  )
}

test("Phase 6B planner uses the fixed six-project allowlist", async () => {
  for (const project of PROJECTS) {
    const plan = await planNextDevelopmentStage(project.id, {
      sources: sourcesFor(project.id),
      githubClient: fakeGitHubClient()
    })

    assert.equal(plan.outcome, "planned", project.id)
    assert.equal(plan.project.id, project.id)
    assert.equal(plan.project.repo, `${project.owner}/${project.repo}`)
  }

  let reads = 0
  await assertRejectsCode(planNextDevelopmentStage("../khlim-assist", {
    sourceReader: async () => {
      reads += 1
      return ""
    },
    githubClient: fakeGitHubClient()
  }), "UNKNOWN_PROJECT")
  assert.equal(reads, 0)
})

test("same approved inputs produce the same structured plan", async () => {
  const options = {
    sources: sourcesFor("khlim-assist"),
    githubClient: fakeGitHubClient()
  }
  const first = await planNextDevelopmentStage("khlim-assist", options)
  const second = await planNextDevelopmentStage("khlim-assist", options)

  assert.deepEqual(second, first)
  assert.equal(first.outcome, "planned")
  assert.equal(first.next.stage, "planning")
  assert.equal(first.baseSha, BASE_SHA)
})

test("planner extracts explicit planning and implementation next stages", async () => {
  const planning = await planNextDevelopmentStage("khlim-assist", {
    sources: sourcesFor("khlim-assist", {
      nextAction: "Prepare read-only repository inspection before planning implementation work."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(planning.outcome, "planned")
  assert.equal(planning.next.stage, "planning")
  assert.equal(planning.next.task, "Prepare read-only repository inspection before planning implementation work.")

  const implementation = await planNextDevelopmentStage("khlim-assist", {
    sources: sourcesFor("khlim-assist", {
      nextAction: "Add provider validation tests."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(implementation.outcome, "planned")
  assert.equal(implementation.next.stage, "implementation")
  assert.equal(implementation.next.task, "Add provider validation tests.")
})

test("completed project or stage state requires owner action", async () => {
  const plan = await planNextDevelopmentStage("portfolio", {
    sources: sourcesFor("portfolio", {
      currentPhase: "Complete.",
      lastKnownStatus: "Verified as complete.",
      nextAction: "None."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(plan.outcome, "owner_action_required")
  assert.equal(plan.reasonCode, "ALREADY_COMPLETE")
  assert.equal(plan.next, null)
})

test("missing project state requires owner action", async () => {
  const doc = projectDocument("khlim-assist").replace(/## Next action[\s\S]*?## Codex fit/u, "## Codex fit")
  const plan = await planNextDevelopmentStage("khlim-assist", {
    sources: {
      ...sourcesFor("khlim-assist"),
      "projects/khlim-assist.md": doc
    },
    githubClient: fakeGitHubClient()
  })

  assert.equal(plan.outcome, "owner_action_required")
  assert.equal(plan.reasonCode, "MISSING_PROJECT_STATE")
})

test("contradictory project state requires owner action", async () => {
  const repoMismatch = await planNextDevelopmentStage("khlim-assist", {
    sources: sourcesFor("khlim-assist", {
      repo: "`Linardi1328/not-khlim-assist`"
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(repoMismatch.outcome, "owner_action_required")
  assert.equal(repoMismatch.reasonCode, "CONTRADICTORY_PROJECT_STATE")

  const completeButAction = await planNextDevelopmentStage("khlim-assist", {
    sources: sourcesFor("khlim-assist", {
      currentPhase: "Complete.",
      nextAction: "Add provider validation tests."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(completeButAction.outcome, "owner_action_required")
  assert.equal(completeButAction.reasonCode, "CONTRADICTORY_PROJECT_STATE")
})

test("ambiguous project state requires owner action", async () => {
  const plan = await planNextDevelopmentStage("khlim-assist", {
    sources: sourcesFor("khlim-assist", {
      nextAction: "Either add provider validation tests or redesign the dashboard."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(plan.outcome, "owner_action_required")
  assert.equal(plan.reasonCode, "AMBIGUOUS_PROJECT_STATE")
})

test("product-choice-dependent state requires owner action", async () => {
  const plan = await planNextDevelopmentStage("ledgerpilot-ai", {
    sources: sourcesFor("ledgerpilot-ai", {
      nextAction: "Choose the product workflow to implement next."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(plan.outcome, "owner_action_required")
  assert.equal(plan.reasonCode, "PRODUCT_DECISION_REQUIRED")
})

test("unsafe or unapproved stages are refused", async () => {
  for (const nextAction of [
    "Deploy the production service.",
    "Add production deployment automation.",
    "Build a deployment workflow.",
    "Create branch and push implementation.",
    "Run tests automatically.",
    "Merge the pull request."
  ]) {
    const plan = await planNextDevelopmentStage("khlim-assist", {
      sources: sourcesFor("khlim-assist", { nextAction }),
      githubClient: fakeGitHubClient()
    })

    assert.equal(plan.outcome, "owner_action_required", nextAction)
    assert.equal(plan.reasonCode, "UNSUPPORTED_STAGE", nextAction)
  }
})

test("declarative deployment artifacts remain supported implementation work", async () => {
  for (const nextAction of [
    "Add versioned deployment-provider metadata to the capability manifest.",
    "Add the deployment manifest schema.",
    "Create a bounded deployment configuration descriptor."
  ]) {
    const plan = await planNextDevelopmentStage("khlim-assist", {
      sources: sourcesFor("khlim-assist", { nextAction }),
      githubClient: fakeGitHubClient()
    })

    assert.equal(plan.outcome, "planned", nextAction)
    assert.equal(plan.next.stage, "implementation", nextAction)
  }
})

test("plan task, source evidence, and output size are bounded", async () => {
  const plan = await planNextDevelopmentStage("spy-market-agent", {
    sources: sourcesFor("spy-market-agent", {
      nextAction: "Add non-executing backtest report validation."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(plan.outcome, "planned")
  assert.ok(plan.next.task.length <= MAX_PLANNER_TASK_CHARS)
  assert.ok(Buffer.byteLength(JSON.stringify(plan), "utf8") <= MAX_PLANNER_RECORD_BYTES)

  for (const entry of plan.sourceEvidence) {
    assert.ok(entry.fact.length <= MAX_PLANNER_SOURCE_FACT_CHARS)
  }

  const oversized = await planNextDevelopmentStage("spy-market-agent", {
    sources: sourcesFor("spy-market-agent", {
      nextAction: `Add ${"x".repeat(MAX_PLANNER_TASK_CHARS)}.`
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(oversized.outcome, "owner_action_required")
  assert.equal(oversized.reasonCode, "MALFORMED_SOURCE_STATE")

  const oversizedSource = await planNextDevelopmentStage("spy-market-agent", {
    sources: {
      ...sourcesFor("spy-market-agent"),
      "projects/spy-market-agent.md": "x".repeat(MAX_PLANNER_PROJECT_DOC_BYTES + 1)
    },
    githubClient: fakeGitHubClient()
  })

  assert.equal(oversizedSource.outcome, "owner_action_required")
  assert.equal(oversizedSource.reasonCode, "MALFORMED_SOURCE_STATE")
})

test("planner reads only approved fixed source refs", async () => {
  const reads = []
  const sourceMap = sourcesFor("khlim-assist")
  const plan = await planNextDevelopmentStage("khlim-assist", {
    sourceReader: async (ref) => {
      reads.push(ref)
      return sourceMap[ref]
    },
    githubClient: fakeGitHubClient()
  })

  assert.equal(plan.outcome, "planned")
  assert.deepEqual(reads.sort(), ["ROADMAP.md", "projects/khlim-assist.md"].sort())
})

test("planner can create a new Phase 6A run through planning_in_progress then planned", async () => {
  const writeDataDir = await tempWriteDataDir()
  const result = await createPlannedDevelopmentRun("khlim-assist", {
    writeDataDir,
    now: makeClock(),
    sources: sourcesFor("khlim-assist", {
      nextAction: "Add provider validation tests."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "planned")
  assert.equal(result.run.status, "planned")
  assert.deepEqual(result.run.history.map((event) => event.toStatus), [
    "created",
    "planning_in_progress",
    "planned"
  ])
  assert.equal(result.run.task, "Add provider validation tests.")
  assert.equal(result.run.baseSha, BASE_SHA)
  assert.equal(result.run.evidence.planning.length, 1)
  assert.equal(result.run.evidence.planning[0].sha, BASE_SHA)
  assert.equal(result.run.evidence.planning[0].metadata.planHash, result.plan.planHash)
})

test("planner can transition an existing created run through planning_in_progress then planned", async () => {
  const writeDataDir = await tempWriteDataDir()
  const created = await createDevelopmentRun({
    projectId: "khlim-assist",
    task: "Add provider validation tests.",
    baseSha: BASE_SHA
  }, {
    writeDataDir,
    now: makeClock()
  })
  const result = await planExistingDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    writeDataDir,
    now: makeClock(),
    sources: sourcesFor("khlim-assist", {
      nextAction: "Add provider validation tests."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(result.ok, true)
  assert.equal(result.run.status, "planned")
  assert.deepEqual(result.run.history.map((event) => event.toStatus), [
    "created",
    "planning_in_progress",
    "planned"
  ])
})

test("stale expected versions are refused by Phase 6A optimistic concurrency", async () => {
  const writeDataDir = await tempWriteDataDir()
  const created = await createDevelopmentRun({
    projectId: "khlim-assist",
    task: "Add provider validation tests.",
    baseSha: BASE_SHA
  }, {
    writeDataDir,
    now: makeClock()
  })
  await transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress"
  }, {
    writeDataDir,
    now: makeClock()
  })

  await assertRejectsCode(planExistingDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    writeDataDir,
    now: makeClock(),
    sources: sourcesFor("khlim-assist", {
      nextAction: "Add provider validation tests."
    }),
    githubClient: fakeGitHubClient()
  }), "STALE_RUN_VERSION", DevelopmentRunStateError)
})

test("planner output does not skip Phase 6A lifecycle transitions", async () => {
  const writeDataDir = await tempWriteDataDir()
  const result = await createPlannedDevelopmentRun("khlim-assist", {
    writeDataDir,
    now: makeClock(),
    sources: sourcesFor("khlim-assist", {
      nextAction: "Add provider validation tests."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(result.run.history[1].fromStatus, "created")
  assert.equal(result.run.history[1].toStatus, "planning_in_progress")
  assert.equal(result.run.history[2].fromStatus, "planning_in_progress")
  assert.equal(result.run.history[2].toStatus, "planned")

  const created = await createDevelopmentRun({
    projectId: "khlim-assist",
    task: "Add provider validation tests.",
    baseSha: BASE_SHA
  }, {
    writeDataDir,
    now: makeClock()
  })
  await assertRejectsCode(transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planned"
  }, {
    writeDataDir,
    now: makeClock()
  }), "INVALID_RUN_TRANSITION", DevelopmentRunStateError)
})

test("owner-action-required plans do not mutate run state", async () => {
  const writeDataDir = await tempWriteDataDir()
  const result = await createPlannedDevelopmentRun("khlim-assist", {
    writeDataDir,
    now: makeClock(),
    sources: sourcesFor("khlim-assist", {
      nextAction: "Choose the product workflow to implement next."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.plan.reasonCode, "PRODUCT_DECISION_REQUIRED")
  assert.equal(result.run, null)
})

test("secrets and raw source failures are excluded from plans and safe errors", async () => {
  const secretPlan = await planNextDevelopmentStage("khlim-assist", {
    sources: sourcesFor("khlim-assist", {
      nextAction: "Add provider validation tests with SENSITIVE_TEST_SENTINEL gho_fake_token."
    }),
    githubClient: fakeGitHubClient()
  })

  assert.equal(secretPlan.outcome, "owner_action_required")
  assert.equal(secretPlan.reasonCode, "UNSAFE_SOURCE_STATE")
  assert.doesNotMatch(JSON.stringify(secretPlan), /SENSITIVE_TEST_SENTINEL|gho_fake_token/u)

  let formatted = ""

  try {
    await planNextDevelopmentStage("khlim-assist", {
      sourceReader: async () => {
        throw new Error("SENSITIVE_TEST_SENTINEL raw reader failure")
      },
      githubClient: fakeGitHubClient()
    })
  } catch (error) {
    formatted = formatDevelopmentNextStagePlannerError(error)
  }

  assert.match(formatted, /PLANNER_FAILED|SOURCE_UNAVAILABLE/u)
  assert.doesNotMatch(formatted, /SENSITIVE_TEST_SENTINEL|raw reader/u)
})

test("trusted repository docs can document confirmation placeholders without blocking KHLIM planning", async () => {
  const plan = await planNextDevelopmentStage("khlim-digital-ecosystem", {
    githubClient: fakeGitHubClient()
  })

  assert.equal(plan.outcome, "planned")
  assert.equal(plan.reasonCode, "READY")
  assert.equal(plan.next.stage, "implementation")
  assert.equal(
    plan.next.task,
    "Add one focused shared ESLint flat-configuration foundation. Populate `packages/eslint-config` with bounded reusable configurations for TypeScript, Node.js, Next.js, and Expo, add only minimal consumer `eslint.config.mjs` files proving reuse, and extend `tests/foundation.test.mjs` with deterministic guardrail checks."
  )
  assert.doesNotMatch(JSON.stringify(plan), /PPO_GITHUB_WRITE_CONFIRM|PPO_NOTE_WRITE_CONFIRM/u)
})

test("malformed source state fails closed", async () => {
  const malformedDoc = `${projectDocument("khlim-assist")}\n## Next action\n\nAdd duplicate next action.\n`
  const plan = await planNextDevelopmentStage("khlim-assist", {
    sources: {
      ...sourcesFor("khlim-assist"),
      "projects/khlim-assist.md": malformedDoc
    },
    githubClient: fakeGitHubClient()
  })

  assert.equal(plan.outcome, "owner_action_required")
  assert.equal(plan.reasonCode, "MALFORMED_SOURCE_STATE")
})

test("GitHub access remains within the existing read-only snapshot boundary", async () => {
  const calls = []
  const client = fakeGitHubClient({ calls })
  const plan = await planNextDevelopmentStage("khlim-assist", {
    sources: sourcesFor("khlim-assist"),
    githubClient: client
  })

  assert.equal(plan.outcome, "planned")
  assert.deepEqual(calls, [{
    method: "getProjectSnapshot",
    projectId: "khlim-assist"
  }])

  const openPrPlan = await planNextDevelopmentStage("khlim-assist", {
    sources: sourcesFor("khlim-assist"),
    githubClient: fakeGitHubClient({
      snapshots: {
        "khlim-assist": snapshotFor("khlim-assist", {
          openPullRequests: [{ number: 7 }]
        })
      }
    })
  })

  assert.equal(openPrPlan.outcome, "owner_action_required")
  assert.equal(openPrPlan.reasonCode, "AMBIGUOUS_PROJECT_STATE")
})

test("Phase 6B adds no model, Codex execution, GitHub write, git mutation, deployment, or OpenClaw route", async () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url))
  const plannerSource = await readFile(join(repoRoot, "local-operator", "development-next-stage-planner.mjs"), "utf8")
  const commandSource = await readFile(join(repoRoot, "local-operator", "ppo-command.mjs"), "utf8")
  const bridgeSource = await readFile(join(repoRoot, "openclaw", "plugins", "ppo-local", "bridge.mjs"), "utf8")

  assert.equal(commandSource.includes("development-next-stage-planner"), false)
  assert.equal(bridgeSource.includes("development-next-stage-planner"), false)

  for (const forbidden of [
    "child_process",
    "execFile",
    "openai",
    "chatgpt",
    "codex exec",
    "--method POST",
    "git add",
    "git commit",
    "git push",
    "git merge",
    "git checkout",
    "git branch",
    "systemctl",
    "/ppo continue",
    "workflow_dispatch"
  ]) {
    assert.equal(plannerSource.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden)
  }
})

test("Phase 5 and Phase 6A foundations remain usable", async () => {
  const writeDataDir = await tempWriteDataDir("ppo-6b-regression-")
  const note = await handleProjectNoteAddCommand(
    "khlim-assist",
    ["Phase 5 regression note after Phase 6B."],
    {
      writeDataDir,
      confirmationValue: "add-note:khlim-assist"
    }
  )

  assert.equal(note.ok, true)
  const records = await readProjectNoteRecords("khlim-assist", { writeDataDir })
  assert.equal(records.length, 1)

  const run = await createDevelopmentRun({
    projectId: "khlim-assist",
    task: "Add provider validation tests.",
    baseSha: NEXT_SHA
  }, {
    writeDataDir,
    now: makeClock()
  })
  const planning = await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "planning_in_progress"
  }, {
    writeDataDir,
    now: makeClock()
  })

  assert.equal(planning.status, "planning_in_progress")
})
