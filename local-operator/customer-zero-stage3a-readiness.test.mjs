import test from "node:test"
import assert from "node:assert/strict"
import {
  STAGE3A_PROJECT_ID,
  STAGE3A_REPOSITORY,
  STAGE3A_REQUIRED_WORKFLOW,
  Stage3AReadinessError,
  observeKhlimAssistStage3Readiness
} from "./customer-zero-stage3a-readiness.mjs"

const SHA = "1111111111111111111111111111111111111111"
const OTHER_SHA = "2222222222222222222222222222222222222222"
const NOW = new Date("2026-09-19T12:00:00.000Z")

function fakeProject() {
  return {
    id: STAGE3A_PROJECT_ID,
    displayName: "KHLIM Assist",
    owner: "Linardi1328",
    repo: "khlim-assist",
    fullName: STAGE3A_REPOSITORY
  }
}

function fakeCapabilities() {
  return [{
    projectId: STAGE3A_PROJECT_ID,
    repository: STAGE3A_REPOSITORY,
    runtimeProfileId: "phase-6k-fixed-local-runtime-profile",
    policyId: "phase-6e-khlim-assist-fixed-python-quality-policy",
    policyVersion: "1",
    gates: [{ id: "ruff" }, { id: "mypy" }, { id: "pytest" }],
    manifestCanExecute: false,
    manifestCanDeploy: false
  }]
}

function fakeRuntimeProfile() {
  return {
    workspaceRegistry: {
      [STAGE3A_PROJECT_ID]: {
        sourceRepoPath: "/tmp/khlim-assist",
        workspaceRoot: "/tmp/workspaces"
      }
    },
    codexConfig: {
      gitExecutablePath: "/usr/bin/git"
    }
  }
}

function fakeSnapshot({ sha = SHA, retrievedAt = NOW.toISOString() } = {}) {
  return {
    project: {
      id: STAGE3A_PROJECT_ID,
      fullName: STAGE3A_REPOSITORY
    },
    repository: {
      fullName: STAGE3A_REPOSITORY,
      defaultBranch: "main"
    },
    recentCommits: [{ sha }],
    openPullRequests: [],
    openIssues: [],
    retrievedAt,
    source: "GitHub read-only"
  }
}

function fakeCommandRunner({
  localSha = SHA,
  dirty = false,
  remote = "git@github.com:Linardi1328/khlim-assist.git",
  workflow = { id: 123, path: STAGE3A_REQUIRED_WORKFLOW, state: "active" },
  failWorkflow = false
} = {}) {
  return async ({ file, args }) => {
    if (file === "gh") {
      if (failWorkflow) {
        throw new Error("unavailable")
      }
      return { stdout: JSON.stringify(workflow), stderr: "" }
    }

    const joined = args.join(" ")
    if (joined.includes("rev-parse HEAD")) {
      return { stdout: `${localSha}\n`, stderr: "" }
    }
    if (joined.includes("status --porcelain=v1")) {
      return { stdout: dirty ? " M backend/app/main.py\n" : "", stderr: "" }
    }
    if (joined.includes("remote get-url origin")) {
      return { stdout: `${remote}\n`, stderr: "" }
    }

    throw new Error("unexpected command")
  }
}

function options(overrides = {}) {
  return {
    now: () => NOW,
    projectResolver: () => fakeProject(),
    capabilityDescriber: () => fakeCapabilities(),
    runtimeProfileLoader: async () => fakeRuntimeProfile(),
    githubClient: {
      async getProjectSnapshot() {
        return fakeSnapshot()
      }
    },
    commandRunner: fakeCommandRunner(),
    ...overrides
  }
}

test("Stage 3A emits bounded PASS evidence for a clean exact KHLIM Assist checkout", async () => {
  const report = await observeKhlimAssistStage3Readiness({}, options())

  assert.equal(report.ready, true)
  assert.equal(report.exactRevision, SHA)
  assert.equal(report.project.id, STAGE3A_PROJECT_ID)
  assert.equal(report.project.repository, STAGE3A_REPOSITORY)
  assert.deepEqual(
    report.observations.map((entry) => [entry.id, entry.status]),
    [
      ["project-identity", "PASS"],
      ["reviewed-policy", "PASS"],
      ["host-dependencies", "PASS"],
      ["checkout-clean", "PASS"],
      ["github-readonly", "PASS"],
      ["observation-freshness", "PASS"],
      ["exact-revision", "PASS"],
      ["validation-workflow", "PASS"]
    ]
  )

  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes("/tmp/"), false)
  assert.equal(serialized.includes("git@github.com"), false)
  assert.equal(serialized.includes("stdout"), false)
  assert.equal(serialized.includes("stderr"), false)
})

test("Stage 3A refuses caller-selected targets", async () => {
  await assert.rejects(
    () => observeKhlimAssistStage3Readiness({ projectId: "ledgerpilot-ai" }, options()),
    (error) => {
      assert.ok(error instanceof Stage3AReadinessError)
      assert.equal(error.code, "STAGE3A_CALLER_TARGET_FORBIDDEN")
      return true
    }
  )
})

test("Stage 3A fails readiness when the canonical checkout is dirty", async () => {
  const report = await observeKhlimAssistStage3Readiness({}, options({
    commandRunner: fakeCommandRunner({ dirty: true })
  }))

  assert.equal(report.ready, false)
  assert.deepEqual(
    report.observations.find((entry) => entry.id === "checkout-clean"),
    { id: "checkout-clean", status: "FAIL", code: "CHECKOUT_DIRTY" }
  )
})

test("Stage 3A fails exact revision when local HEAD differs from GitHub", async () => {
  const report = await observeKhlimAssistStage3Readiness({}, options({
    githubClient: {
      async getProjectSnapshot() {
        return fakeSnapshot({ sha: OTHER_SHA })
      }
    }
  }))

  assert.equal(report.ready, false)
  assert.deepEqual(
    report.observations.find((entry) => entry.id === "exact-revision"),
    { id: "exact-revision", status: "FAIL", code: "REVISION_MISMATCH" }
  )
})

test("Stage 3A leaves missing workflow evidence as SKIP", async () => {
  const report = await observeKhlimAssistStage3Readiness({}, options({
    commandRunner: fakeCommandRunner({ failWorkflow: true })
  }))

  assert.equal(report.ready, false)
  assert.deepEqual(
    report.observations.find((entry) => entry.id === "validation-workflow"),
    { id: "validation-workflow", status: "SKIP", code: "WORKFLOW_UNAVAILABLE" }
  )
})

test("Stage 3A rejects stale GitHub observations", async () => {
  const report = await observeKhlimAssistStage3Readiness({}, options({
    githubClient: {
      async getProjectSnapshot() {
        return fakeSnapshot({ retrievedAt: "2026-09-19T11:40:00.000Z" })
      }
    }
  }))

  assert.equal(report.ready, false)
  assert.deepEqual(
    report.observations.find((entry) => entry.id === "observation-freshness"),
    { id: "observation-freshness", status: "FAIL", code: "REMOTE_OBSERVATION_STALE" }
  )
})

test("Stage 3A fails closed when fixed host dependencies are unavailable", async () => {
  const report = await observeKhlimAssistStage3Readiness({}, options({
    runtimeProfileLoader: async () => {
      throw new Error("missing")
    }
  }))

  assert.equal(report.ready, false)
  assert.deepEqual(
    report.observations.find((entry) => entry.id === "host-dependencies"),
    { id: "host-dependencies", status: "FAIL", code: "HOST_DEPENDENCIES_NOT_READY" }
  )
  assert.equal(
    report.observations.find((entry) => entry.id === "checkout-clean").status,
    "SKIP"
  )
})

test("Stage 3A fails registry identity mismatches without changing target", async () => {
  const report = await observeKhlimAssistStage3Readiness({}, options({
    projectResolver: () => ({
      ...fakeProject(),
      fullName: "Linardi1328/not-khlim-assist"
    })
  }))

  assert.equal(report.ready, false)
  assert.deepEqual(
    report.observations.find((entry) => entry.id === "project-identity"),
    { id: "project-identity", status: "FAIL", code: "PROJECT_IDENTITY_MISMATCH" }
  )
})
