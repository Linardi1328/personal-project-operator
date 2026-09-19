import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  STAGE3B_PILOT_ID,
  STAGE3B_TASK,
  Stage3BPilotError,
  startKhlimAssistStage3BPilot
} from "./customer-zero-stage3b-pilot.mjs"
import {
  STAGE3A_PROJECT_ID,
  STAGE3A_REPOSITORY
} from "./customer-zero-stage3a-readiness.mjs"

const SHA = "3333333333333333333333333333333333333333"
const OTHER_SHA = "4444444444444444444444444444444444444444"
const RUN_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const NOW = new Date("2026-09-19T13:00:00.000Z")

function readiness(overrides = {}) {
  return {
    schema: "personal-project-operator.customer-zero.stage3a-readiness.v1",
    project: {
      id: STAGE3A_PROJECT_ID,
      repository: STAGE3A_REPOSITORY
    },
    ready: true,
    exactRevision: SHA,
    observations: [
      { id: "project-identity", status: "PASS" },
      { id: "reviewed-policy", status: "PASS" },
      { id: "host-dependencies", status: "PASS" },
      { id: "checkout-clean", status: "PASS" },
      { id: "github-readonly", status: "PASS" },
      { id: "observation-freshness", status: "PASS" },
      { id: "exact-revision", status: "PASS" },
      { id: "validation-workflow", status: "PASS" }
    ],
    observedAt: NOW.toISOString(),
    ...overrides
  }
}

function snapshot(overrides = {}) {
  return {
    project: {
      id: STAGE3A_PROJECT_ID,
      fullName: STAGE3A_REPOSITORY
    },
    repository: {
      fullName: STAGE3A_REPOSITORY,
      defaultBranch: "main"
    },
    recentCommits: [{ sha: SHA }],
    openPullRequests: [],
    openIssues: [],
    retrievedAt: NOW.toISOString(),
    source: "GitHub read-only",
    ...overrides
  }
}

function projectDoc(task = STAGE3B_TASK) {
  return [
    "# KHLIM Assist",
    "",
    "## Project",
    "",
    "KHLIM Assist",
    "",
    "## Repo",
    "",
    "`Linardi1328/khlim-assist`",
    "",
    "## Connection status",
    "",
    "Connected candidate.",
    "",
    "## Current role",
    "",
    "AI integration for KHLIM admin workflows.",
    "",
    "## OpenClaw priority",
    "",
    "High.",
    "",
    "## Current phase",
    "",
    "KHLIM Assist v0.1 Phase 2 — AI FAQ Engine.",
    "",
    "## Last known status",
    "",
    "Phase 2 implements multilingual interpretation, approved knowledge retrieval, deterministic GREEN/YELLOW/RED decisions, and draft response generation. AI participant auto-replies remain disabled.",
    "",
    "## Next action",
    "",
    task,
    "",
    "## Codex fit",
    "",
    "Useful for focused tests.",
    "",
    "## Do not change",
    "",
    "- Do not add credentials."
  ].join("\n")
}

function fakePlan(overrides = {}) {
  return {
    outcome: "planned",
    project: {
      id: STAGE3A_PROJECT_ID,
      fullName: STAGE3A_REPOSITORY
    },
    baseSha: SHA,
    next: {
      stage: "implementation",
      task: STAGE3B_TASK
    },
    ...overrides
  }
}

function fakeCreated(overrides = {}) {
  return {
    ok: true,
    outcome: "planned",
    plan: fakePlan(),
    run: {
      runId: RUN_ID,
      project: {
        id: STAGE3A_PROJECT_ID,
        fullName: STAGE3A_REPOSITORY
      },
      task: STAGE3B_TASK,
      status: "planned",
      baseSha: SHA,
      headSha: SHA
    },
    ...overrides
  }
}

function emptyCatalog() {
  return {
    ok: true,
    code: "ok",
    summaries: [],
    diagnostics: {
      scanned: 0,
      returned: 0,
      invalid: 0,
      outOfScope: 0,
      truncated: false
    }
  }
}

function defaultOptions(overrides = {}) {
  return {
    now: () => NOW,
    readinessObserver: async () => readiness(),
    githubClient: {
      async getProjectSnapshot() {
        return snapshot()
      }
    },
    listRuns: async () => emptyCatalog(),
    sourceLoader: async () => ({
      projectDoc: projectDoc(),
      roadmap: "### Phase 6B - Deterministic autonomous next-stage planner foundation"
    }),
    planOnly: async () => fakePlan(),
    createPlannedRun: async () => fakeCreated(),
    ...overrides
  }
}

test("Stage 3B plans exactly one fixed KHLIM Assist pilot run and stops", async () => {
  const result = await startKhlimAssistStage3BPilot({}, defaultOptions())

  assert.deepEqual(result, {
    schemaVersion: 1,
    pilot: STAGE3B_PILOT_ID,
    projectId: STAGE3A_PROJECT_ID,
    outcome: "planned",
    code: "STAGE3B_PILOT_PLANNED",
    runId: RUN_ID,
    status: "planned",
    exactRevision: SHA,
    nextCommand: `/ppo continue ${RUN_ID}`,
    automaticContinuation: false,
    deploymentAuthorized: false,
    customerMessagingAuthorized: false
  })
})

test("Stage 3B refuses caller-selected project or task input", async () => {
  await assert.rejects(
    () => startKhlimAssistStage3BPilot({ task: "anything else" }, defaultOptions()),
    (error) => {
      assert.ok(error instanceof Stage3BPilotError)
      assert.equal(error.code, "STAGE3B_CALLER_INPUT_FORBIDDEN")
      return true
    }
  )
})

test("Stage 3B creates no run unless Stage 3A is a complete PASS", async () => {
  let creates = 0
  const report = readiness({
    ready: false,
    observations: [{ id: "project-identity", status: "FAIL" }]
  })

  const result = await startKhlimAssistStage3BPilot({}, defaultOptions({
    readinessObserver: async () => report,
    createPlannedRun: async () => {
      creates += 1
      return fakeCreated()
    }
  }))

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.code, "STAGE3A_READINESS_REQUIRED")
  assert.equal(creates, 0)
})

test("Stage 3B refuses task drift before run creation", async () => {
  let creates = 0
  const result = await startKhlimAssistStage3BPilot({}, defaultOptions({
    sourceLoader: async () => ({
      projectDoc: projectDoc("Change production classification behavior."),
      roadmap: "### Phase 6B - Deterministic autonomous next-stage planner foundation"
    }),
    createPlannedRun: async () => {
      creates += 1
      return fakeCreated()
    }
  }))

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.code, "STAGE3B_TASK_DRIFT")
  assert.equal(creates, 0)
})

test("Stage 3B refuses a GitHub head that moved after readiness", async () => {
  let creates = 0
  const result = await startKhlimAssistStage3BPilot({}, defaultOptions({
    githubClient: {
      async getProjectSnapshot() {
        return snapshot({
          recentCommits: [{ sha: OTHER_SHA }]
        })
      }
    },
    createPlannedRun: async () => {
      creates += 1
      return fakeCreated()
    }
  }))

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.code, "STAGE3B_REVISION_NOT_PINNED")
  assert.equal(creates, 0)
})

test("Stage 3B returns the existing canonical pilot instead of duplicating it", async () => {
  let creates = 0
  const summary = {
    runId: RUN_ID,
    project: STAGE3A_PROJECT_ID,
    terminal: false,
    canonicalState: "canonical_current",
    recoveryRequired: false
  }

  const result = await startKhlimAssistStage3BPilot({}, defaultOptions({
    listRuns: async () => ({
      ...emptyCatalog(),
      summaries: [summary],
      diagnostics: {
        ...emptyCatalog().diagnostics,
        scanned: 1,
        returned: 1
      }
    }),
    readRun: async () => ({
      runId: RUN_ID,
      project: { id: STAGE3A_PROJECT_ID },
      task: STAGE3B_TASK,
      status: "tests_passed"
    }),
    createPlannedRun: async () => {
      creates += 1
      return fakeCreated()
    }
  }))

  assert.equal(result.outcome, "existing")
  assert.equal(result.runId, RUN_ID)
  assert.equal(result.status, "tests_passed")
  assert.equal(creates, 0)
})

test("Stage 3B refuses duplicate pilot records", async () => {
  const otherRunId = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  const summaries = [RUN_ID, otherRunId].map((runId) => ({
    runId,
    project: STAGE3A_PROJECT_ID,
    terminal: true,
    canonicalState: "canonical_current",
    recoveryRequired: false
  }))

  const result = await startKhlimAssistStage3BPilot({}, defaultOptions({
    listRuns: async () => ({
      ...emptyCatalog(),
      summaries,
      diagnostics: {
        ...emptyCatalog().diagnostics,
        scanned: 2,
        returned: 2
      }
    }),
    readRun: async (runId) => ({
      runId,
      project: { id: STAGE3A_PROJECT_ID },
      task: STAGE3B_TASK,
      status: "merged"
    })
  }))

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.code, "STAGE3B_DUPLICATE_PILOT_RUNS")
})

test("Stage 3B refuses an unrelated active KHLIM Assist run", async () => {
  const summary = {
    runId: RUN_ID,
    project: STAGE3A_PROJECT_ID,
    terminal: false,
    canonicalState: "canonical_current",
    recoveryRequired: false
  }

  const result = await startKhlimAssistStage3BPilot({}, defaultOptions({
    listRuns: async () => ({
      ...emptyCatalog(),
      summaries: [summary],
      diagnostics: {
        ...emptyCatalog().diagnostics,
        scanned: 1,
        returned: 1
      }
    }),
    readRun: async () => ({
      runId: RUN_ID,
      project: { id: STAGE3A_PROJECT_ID },
      task: "A different KHLIM Assist development task.",
      status: "planned"
    })
  }))

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.code, "STAGE3B_KHLIM_RUN_ALREADY_ACTIVE")
  assert.equal(result.runId, RUN_ID)
})

test("Stage 3B refuses planner drift before creating a run", async () => {
  let creates = 0
  const result = await startKhlimAssistStage3BPilot({}, defaultOptions({
    planOnly: async () => fakePlan({
      next: {
        stage: "implementation",
        task: "Different task"
      }
    }),
    createPlannedRun: async () => {
      creates += 1
      return fakeCreated()
    }
  }))

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.code, "STAGE3B_PLAN_MISMATCH")
  assert.equal(creates, 0)
})

test("Stage 3B integrates with the real Phase 6B planner and run store without continuing", async () => {
  const writeDataDir = await mkdtemp(join(tmpdir(), "ppo-stage3b-"))

  try {
    const result = await startKhlimAssistStage3BPilot({}, {
      now: () => NOW,
      writeDataDir,
      readinessObserver: async () => readiness(),
      githubClient: {
        async getProjectSnapshot() {
          return snapshot()
        }
      },
      listRuns: async () => emptyCatalog(),
      randomBytesImpl: () => Buffer.alloc(32, 7)
    })

    assert.equal(result.outcome, "planned")
    assert.equal(result.status, "planned")
    assert.equal(result.exactRevision, SHA)
    assert.equal(result.automaticContinuation, false)
    assert.equal(result.deploymentAuthorized, false)
    assert.equal(result.customerMessagingAuthorized, false)
  } finally {
    await rm(writeDataDir, { recursive: true, force: true })
  }
})
