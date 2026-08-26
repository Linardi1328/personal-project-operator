import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  CODEX_EXECUTION_SANDBOX_ID,
  classifyCodexExecutionAttemptEvidence
} from "./development-codex-execution-adapter.mjs"
import {
  CODEX_NO_CHANGE_RECOVERY_CONFIRMATION,
  CODEX_NO_CHANGE_RECOVERY_REASON,
  recoverCodexNoChangeRun
} from "./development-codex-no-change-recovery.mjs"
import {
  DevelopmentRunStateError,
  createDevelopmentRun,
  readDevelopmentRun,
  recordDevelopmentRunProgress,
  transitionDevelopmentRun
} from "./development-run-state.mjs"

const BASE_SHA = "b".repeat(40)
const PROMPT_HASH = "e".repeat(64)
const CLI_PATH = resolve("deployment/scripts/recover-phase6d-codex-no-change.mjs")

function makeClock() {
  let tick = 0
  const start = Date.parse("2026-08-25T14:00:00.000Z")

  return () => {
    const value = new Date(start + tick * 1000)
    tick += 1
    return value
  }
}

async function tempWriteDataDir() {
  return await mkdtemp(join(tmpdir(), "ppo-phase6d-no-change-"))
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
}

function executionEvidence({ attempt, outcome }) {
  return {
    kind: "implementation",
    sha: BASE_SHA,
    source: CODEX_EXECUTION_ADAPTER_ID,
    summary: outcome === "execution_started"
      ? "Codex execution attempt reserved."
      : "Codex execution attempt ended without a verified implementation.",
    metadata: {
      project: "khlim-digital-ecosystem",
      branch: "ppo/khlim-digital-ecosystem/implementation/no-change",
      workspaceId: "khlim-digital-ecosystem-no-change",
      workspaceRef: "development-workspaces/khlim-digital-ecosystem-no-change",
      adapter: CODEX_EXECUTION_ADAPTER_ID,
      attempt,
      promptHash: PROMPT_HASH,
      startedAt: "2026-08-25T14:00:00.000Z",
      ...(outcome === "execution_failed"
        ? { endedAt: "2026-08-25T14:01:00.000Z" }
        : {}),
      outcome,
      remotePolicy: "deny",
      sandbox: CODEX_EXECUTION_SANDBOX_ID,
      backend: "codex-native-linux",
      platform: "linux",
      network: "none"
    }
  }
}

async function makeDefinitiveFailureRun({ closeAttempt = true } = {}) {
  const writeDataDir = await tempWriteDataDir()
  const now = makeClock()
  let run = await createDevelopmentRun({
    projectId: "khlim-digital-ecosystem",
    task: "Repeat a scaffold that is already present.",
    baseSha: BASE_SHA,
    branch: "ppo/khlim-digital-ecosystem/implementation/no-change",
    headSha: BASE_SHA,
    actor: "test-planner"
  }, {
    writeDataDir,
    now
  })

  for (const status of [
    "planning_in_progress",
    "planned",
    "implementation_in_progress"
  ]) {
    run = await transitionDevelopmentRun(run.runId, {
      expectedVersion: run.version,
      status,
      actor: "test-agent"
    }, {
      writeDataDir,
      now
    })
  }

  run = await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "implementation_in_progress",
    actor: CODEX_EXECUTION_ADAPTER_ID,
    reason: "phase-6d-codex-execution-attempt",
    incrementAttempt: true,
    evidence: [executionEvidence({ attempt: 2, outcome: "execution_started" })]
  }, {
    writeDataDir,
    now
  })

  if (closeAttempt) {
    run = await recordDevelopmentRunProgress(run.runId, {
      expectedVersion: run.version,
      status: "implementation_in_progress",
      actor: CODEX_EXECUTION_ADAPTER_ID,
      reason: "phase-6d-codex-execution-definitive-failure",
      evidence: [executionEvidence({ attempt: 2, outcome: "execution_failed" })]
    }, {
      writeDataDir,
      now
    })

    assert.equal(
      classifyCodexExecutionAttemptEvidence(run),
      "definitive_failed",
      JSON.stringify(run.evidence.implementation.at(-1))
    )
  }

  return { writeDataDir, now, run }
}

function recoveryRequest(run, confirmation = CODEX_NO_CHANGE_RECOVERY_CONFIRMATION) {
  return {
    runId: run.runId,
    expectedVersion: run.version,
    expectedHeadSha: run.headSha,
    expectedAttempt: run.attempts.implementation,
    confirmation
  }
}

function matchingReconciliation(run, overrides = {}) {
  return {
    ok: true,
    outcome: "codex_execution_reconciled",
    status: "unchanged",
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id
    },
    facts: {
      branch: run.branch,
      headSha: run.headSha,
      expectedStartSha: run.headSha,
      dirty: false
    },
    ...overrides
  }
}

function recoveryOptions(fixture, reconciliation = matchingReconciliation(fixture.run)) {
  return {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now,
    loadRuntimeProfile: async () => ({
      workspaceRegistry: {
        "khlim-digital-ecosystem": {
          workspaceRoot: "/var/lib/personal-project-operator/development-workspaces"
        }
      }
    }),
    reconcileCodex: async () => reconciliation
  }
}

test("confirmed definitive no-change recovery cancels the stranded run", async () => {
  const fixture = await makeDefinitiveFailureRun()
  const result = await recoverCodexNoChangeRun(
    recoveryRequest(fixture.run),
    recoveryOptions(fixture)
  )

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "codex_no_change_run_cancelled")
  assert.equal(result.before.status, "implementation_in_progress")
  assert.equal(result.run.status, "cancelled")
  assert.equal(result.run.stage, "closed")
  assert.equal(result.run.version, fixture.run.version + 1)
  assert.equal(result.run.headSha, BASE_SHA)
  assert.equal(result.run.implementationAttempt, 2)

  const stored = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  assert.equal(stored.status, "cancelled")
  assert.equal(stored.history.at(-1).reason, CODEX_NO_CHANGE_RECOVERY_REASON)
  assert.equal(stored.evidence.implementation.at(-1).metadata.outcome, "execution_failed")
})

test("recovery refuses missing confirmation, stale identity, and open attempts", async () => {
  const missingConfirmation = await makeDefinitiveFailureRun()
  await assertRejectsCode(recoverCodexNoChangeRun(
    recoveryRequest(missingConfirmation.run, "wrong-confirmation"),
    recoveryOptions(missingConfirmation)
  ), "CODEX_NO_CHANGE_RECOVERY_CONFIRMATION_REQUIRED")

  const stale = await makeDefinitiveFailureRun()
  await assertRejectsCode(recoverCodexNoChangeRun({
    ...recoveryRequest(stale.run),
    expectedVersion: stale.run.version - 1
  }, recoveryOptions(stale)), "CODEX_NO_CHANGE_RECOVERY_STATE_MISMATCH")

  const open = await makeDefinitiveFailureRun({ closeAttempt: false })
  await assertRejectsCode(recoverCodexNoChangeRun(
    recoveryRequest(open.run),
    recoveryOptions(open)
  ), "CODEX_NO_CHANGE_RECOVERY_EVIDENCE_MISMATCH")
})

test("recovery refuses dirty, advanced, or mismatched workspace reconciliation", async () => {
  const cases = [
    { facts: { branch: "branch", headSha: BASE_SHA, expectedStartSha: BASE_SHA, dirty: true } },
    { status: "advanced" },
    { status: "mismatched" }
  ]

  for (const override of cases) {
    const fixture = await makeDefinitiveFailureRun()
    const reconciliation = matchingReconciliation(fixture.run, override)

    await assertRejectsCode(recoverCodexNoChangeRun(
      recoveryRequest(fixture.run),
      recoveryOptions(fixture, reconciliation)
    ), "CODEX_NO_CHANGE_RECOVERY_RECONCILIATION_FAILED")

    const stored = await readDevelopmentRun(fixture.run.runId, {
      writeDataDir: fixture.writeDataDir
    })
    assert.equal(stored.status, "implementation_in_progress")
    assert.equal(stored.version, fixture.run.version)
  }
})

test("recovery CLI refuses malformed invocation before reading run state", () => {
  const result = spawnSync(process.execPath, [CLI_PATH], {
    encoding: "utf8",
    env: {}
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: recover-phase6d-codex-no-change\.mjs/u)
})

test("KHLIM project brief records merged TypeScript configuration and a bounded ESLint task", async () => {
  const brief = await readFile(
    new URL("../projects/khlim-digital-ecosystem.md", import.meta.url),
    "utf8"
  )

  assert.match(brief, /shared TypeScript configuration foundation are merged/u)
  assert.match(brief, /shared TypeScript configuration foundation/u)
  assert.match(brief, /shared ESLint flat-configuration foundation/u)
  assert.match(brief, /Do not repeat or replace the merged monorepo or shared TypeScript configuration foundations/u)
  assert.doesNotMatch(brief, /Add one focused shared TypeScript configuration foundation/u)
  assert.doesNotMatch(brief, /have not been scaffolded yet/u)
})
