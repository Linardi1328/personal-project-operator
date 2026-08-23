import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  ALLOWED_DEVELOPMENT_RUN_TRANSITIONS,
  DEVELOPMENT_RUN_STATUSES,
  createDevelopmentRun,
  createPersonalProjectOperatorSelfDevelopmentRun,
  isDevelopmentRunTerminalStatus,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  DEVELOPMENT_RUN_CANCELLATION_ACTOR,
  DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES,
  DEVELOPMENT_RUN_CANCELLATION_DELIVERY_STATUSES,
  DEVELOPMENT_RUN_CANCELLATION_ID,
  DEVELOPMENT_RUN_CANCELLATION_IN_PROGRESS_STATUSES,
  DEVELOPMENT_RUN_CANCELLATION_PRODUCTION_STATUSES,
  DEVELOPMENT_RUN_CANCELLATION_REASON,
  PHASE_6P_RUN_CANCELLATION_POLICY_HASH,
  PHASE_6P_RUN_CANCELLATION_POLICY_ID,
  classifyDevelopmentRunCancellationStatus,
  executeDevelopmentRunCancellation,
  formatDevelopmentRunCancellation,
  inspectDevelopmentRunCancellationEligibility
} from "./development-run-cancellation.mjs"
import {
  confirmDevelopmentRunCancellationApproval,
  stageDevelopmentRunCancellationApproval
} from "./development-run-cancellation-approval.mjs"
import {
  handlePpoDevelopmentRunCommand,
  handlePpoDevelopmentRunsCommand
} from "./development-run-catalog-route.mjs"
import {
  DEVELOPMENT_RUN_CATALOG_ID,
  PHASE_6N_RUN_CATALOG_POLICY_HASH,
  PHASE_6N_RUN_CATALOG_POLICY_ID
} from "./development-run-catalog.mjs"
import { handlePpoDevelopmentContinueCommand } from "./development-continue-orchestrator.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const TASK_TEXT = "PHASE_6P_TASK_TEXT_MUST_NOT_LEAK"

function randomBytesForSeed(seed) {
  return (size) => Buffer.alloc(size, seed)
}

function makeClock(start = "2026-08-24T00:00:00.000Z") {
  let tick = 0
  const startMs = Date.parse(start)

  return () => {
    const next = new Date(startMs + tick * 1000)
    tick += 1
    return next
  }
}

function transitionPathTo(targetStatus) {
  const queue = [{ status: "created", path: [] }]
  const seen = new Set(["created"])

  while (queue.length) {
    const current = queue.shift()

    if (current.status === targetStatus) {
      return current.path
    }

    for (const next of ALLOWED_DEVELOPMENT_RUN_TRANSITIONS[current.status]) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push({
          status: next,
          path: [...current.path, next]
        })
      }
    }
  }

  throw new Error(`No transition path to ${targetStatus}`)
}

async function tempWriteDataDir(label = "ppo-6p-cancel-") {
  return mkdtemp(join(tmpdir(), label))
}

function runPaths(writeDataDir, runId) {
  return {
    runRoot: join(writeDataDir, "development-runs"),
    recordPath: join(writeDataDir, "development-runs", "records", `${runId}.json`),
    versionPath: (version) => join(
      writeDataDir,
      "development-runs",
      "versions",
      runId,
      `${String(version).padStart(6, "0")}.json`
    )
  }
}

async function makeRun({
  writeDataDir,
  seed,
  status = "created",
  projectId = "khlim-assist",
  headSha = HEAD_SHA,
  task = `${TASK_TEXT} ${seed}`
}) {
  const now = makeClock()
  let record = await createDevelopmentRun({
    projectId,
    task,
    baseSha: BASE_SHA,
    headSha,
    actor: "phase-6p-test"
  }, {
    writeDataDir,
    now,
    randomBytesImpl: randomBytesForSeed(seed)
  })

  for (const nextStatus of transitionPathTo(status)) {
    record = await transitionDevelopmentRun(record.runId, {
      expectedVersion: record.version,
      status: nextStatus,
      actor: "phase-6p-test"
    }, {
      writeDataDir,
      now
    })
  }

  return record
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

function policyHashFor(contract) {
  return createHash("sha256").update(stableStringify(contract)).digest("hex")
}

function cancellationPolicyContract(overrides = {}) {
  const statusClassification = {
    eligible: DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES,
    refusedInProgress: DEVELOPMENT_RUN_CANCELLATION_IN_PROGRESS_STATUSES,
    refusedDelivery: DEVELOPMENT_RUN_CANCELLATION_DELIVERY_STATUSES,
    refusedProduction: DEVELOPMENT_RUN_CANCELLATION_PRODUCTION_STATUSES,
    refusedTerminal: DEVELOPMENT_RUN_STATUSES.filter((status) => isDevelopmentRunTerminalStatus(status)),
    refusalCodes: {
      inProgress: "state_not_quiescent",
      delivery: "delivery_state_out_of_scope",
      production: "production_state_out_of_scope",
      terminal: "terminal_state"
    }
  }

  return {
    cancellation: DEVELOPMENT_RUN_CANCELLATION_ID,
    policy: PHASE_6P_RUN_CANCELLATION_POLICY_ID,
    schemaVersion: 1,
    ordinaryProjects: listPhase2GitHubProjects().map((project) => project.id).sort(),
    statusClassification,
    canonicalStateRequired: "canonical_current",
    expectedVersionRequired: true,
    targetStatus: "cancelled",
    fixedActor: DEVELOPMENT_RUN_CANCELLATION_ACTOR,
    fixedReason: DEVELOPMENT_RUN_CANCELLATION_REASON,
    evidence: false,
    cleanup: false,
    processInterruption: false,
    githubActions: false,
    hostedSourceActions: false,
    productionActions: false,
    engine: {
      catalog: DEVELOPMENT_RUN_CATALOG_ID,
      policy: {
        id: PHASE_6N_RUN_CATALOG_POLICY_ID,
        hash: PHASE_6N_RUN_CATALOG_POLICY_HASH
      }
    },
    ...overrides
  }
}

async function snapshotTree(root) {
  const rows = []

  async function walk(path, relativePath) {
    let info

    try {
      info = await lstat(path)
    } catch (error) {
      if (error?.code === "ENOENT" && relativePath === ".") {
        rows.push({ path: ".", type: "missing" })
        return
      }

      throw error
    }

    const row = {
      path: relativePath,
      mode: info.mode & 0o777
    }

    if (info.isSymbolicLink()) {
      rows.push({
        ...row,
        type: "symlink",
        target: await readlink(path)
      })
      return
    }

    if (info.isDirectory()) {
      const entries = (await readdir(path)).sort()
      rows.push({
        ...row,
        type: "directory",
        entries
      })

      for (const entry of entries) {
        await walk(join(path, entry), relativePath === "." ? entry : join(relativePath, entry))
      }
      return
    }

    if (info.isFile()) {
      rows.push({
        ...row,
        type: "file",
        size: info.size,
        hash: createHash("sha256").update(await readFile(path)).digest("hex")
      })
      return
    }

    rows.push({
      ...row,
      type: "other"
    })
  }

  await walk(root, ".")
  return rows.sort((left, right) => left.path.localeCompare(right.path))
}

function assertNoPhase6PEvidence(record) {
  for (const evidence of Object.values(record.evidence)) {
    assert.equal(evidence.some((entry) => JSON.stringify(entry).includes("phase-6p")), false)
  }

  assert.equal(record.history.at(-1).evidence.length, 0)
}

test("Phase 6P cancellation policy has fixed identity and exact status classification", () => {
  assert.equal(DEVELOPMENT_RUN_CANCELLATION_ID, "phase-6p-quiescent-development-run-cancellation")
  assert.equal(PHASE_6P_RUN_CANCELLATION_POLICY_ID, "phase-6p-quiescent-development-run-cancellation-policy")
  assert.match(PHASE_6P_RUN_CANCELLATION_POLICY_HASH, /^[a-f0-9]{64}$/u)
  assert.equal(policyHashFor(cancellationPolicyContract()), PHASE_6P_RUN_CANCELLATION_POLICY_HASH)

  const expected = {
    created: "eligible",
    planning_in_progress: "state_not_quiescent",
    planned: "eligible",
    implementation_in_progress: "state_not_quiescent",
    implementation_ready: "eligible",
    tests_in_progress: "state_not_quiescent",
    tests_failed: "eligible",
    tests_passed: "eligible",
    review_in_progress: "state_not_quiescent",
    review_changes_requested: "eligible",
    review_passed: "delivery_state_out_of_scope",
    merge_ready: "delivery_state_out_of_scope",
    merged: "delivery_state_out_of_scope",
    deploy_in_progress: "production_state_out_of_scope",
    deploy_failed: "production_state_out_of_scope",
    deployed: "production_state_out_of_scope",
    verification_in_progress: "production_state_out_of_scope",
    verification_failed: "production_state_out_of_scope",
    rollback_in_progress: "production_state_out_of_scope",
    rollback_failed: "production_state_out_of_scope",
    rolled_back: "production_state_out_of_scope",
    verified: "terminal_state",
    cancelled: "terminal_state",
    failed: "terminal_state"
  }

  assert.deepEqual(Object.keys(expected), DEVELOPMENT_RUN_STATUSES)
  assert.deepEqual(DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES, [
    "created",
    "planned",
    "implementation_ready",
    "tests_failed",
    "tests_passed",
    "review_changes_requested"
  ])
  assert.deepEqual(DEVELOPMENT_RUN_CANCELLATION_IN_PROGRESS_STATUSES, [
    "planning_in_progress",
    "implementation_in_progress",
    "tests_in_progress",
    "review_in_progress"
  ])
  assert.deepEqual(DEVELOPMENT_RUN_CANCELLATION_DELIVERY_STATUSES, [
    "review_passed",
    "merge_ready",
    "merged"
  ])
  assert.deepEqual(DEVELOPMENT_RUN_CANCELLATION_PRODUCTION_STATUSES, [
    "deploy_in_progress",
    "deploy_failed",
    "deployed",
    "verification_in_progress",
    "verification_failed",
    "rollback_in_progress",
    "rollback_failed",
    "rolled_back"
  ])

  const observed = {
    eligible: [],
    state_not_quiescent: [],
    delivery_state_out_of_scope: [],
    production_state_out_of_scope: [],
    terminal_state: [],
    cancellation_unavailable: []
  }

  for (const status of DEVELOPMENT_RUN_STATUSES) {
    const classification = classifyDevelopmentRunCancellationStatus(status)
    assert.equal(classification, expected[status], status)
    observed[classification].push(status)
  }

  const observedStatuses = Object.values(observed).flat()
  assert.equal(observedStatuses.length, DEVELOPMENT_RUN_STATUSES.length)
  assert.equal(new Set(observedStatuses).size, DEVELOPMENT_RUN_STATUSES.length)
  assert.deepEqual(observed.eligible, DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES)
  assert.deepEqual(observed.state_not_quiescent, DEVELOPMENT_RUN_CANCELLATION_IN_PROGRESS_STATUSES)
  assert.deepEqual(observed.delivery_state_out_of_scope, DEVELOPMENT_RUN_CANCELLATION_DELIVERY_STATUSES)
  assert.deepEqual(observed.production_state_out_of_scope, DEVELOPMENT_RUN_CANCELLATION_PRODUCTION_STATUSES)
  assert.deepEqual(
    observed.terminal_state,
    DEVELOPMENT_RUN_STATUSES.filter((status) => isDevelopmentRunTerminalStatus(status))
  )
  assert.deepEqual(observed.cancellation_unavailable, [])

  const baseContract = cancellationPolicyContract()
  const mutateClassification = (key, value) => ({
    ...baseContract,
    statusClassification: {
      ...baseContract.statusClassification,
      [key]: value
    }
  })
  const policySignificantMutations = [
    ["ordinary projects", { ...baseContract, ordinaryProjects: baseContract.ordinaryProjects.slice(1) }],
    ["eligible statuses", mutateClassification("eligible", baseContract.statusClassification.eligible.slice(1))],
    ["in-progress refused statuses", mutateClassification("refusedInProgress", baseContract.statusClassification.refusedInProgress.slice(1))],
    ["delivery refused statuses", mutateClassification("refusedDelivery", baseContract.statusClassification.refusedDelivery.slice(1))],
    ["production refused statuses", mutateClassification("refusedProduction", baseContract.statusClassification.refusedProduction.slice(1))],
    ["terminal refused statuses", mutateClassification("refusedTerminal", baseContract.statusClassification.refusedTerminal.slice(1))],
    ["terminal refusal code", mutateClassification("refusalCodes", {
      ...baseContract.statusClassification.refusalCodes,
      terminal: "production_state_out_of_scope"
    })],
    ["canonical state", { ...baseContract, canonicalStateRequired: "canonical_behind" }],
    ["expected version", { ...baseContract, expectedVersionRequired: false }],
    ["target status", { ...baseContract, targetStatus: "failed" }],
    ["fixed actor", { ...baseContract, fixedActor: "different-actor" }],
    ["fixed reason", { ...baseContract, fixedReason: "different_reason" }],
    ["evidence", { ...baseContract, evidence: true }],
    ["cleanup", { ...baseContract, cleanup: true }],
    ["process interruption", { ...baseContract, processInterruption: true }],
    ["GitHub actions", { ...baseContract, githubActions: true }],
    ["hosted source actions", { ...baseContract, hostedSourceActions: true }],
    ["production actions", { ...baseContract, productionActions: true }],
    ["Phase 6N policy id", {
      ...baseContract,
      engine: {
        ...baseContract.engine,
        policy: {
          ...baseContract.engine.policy,
          id: "different-policy"
        }
      }
    }],
    ["Phase 6N policy hash", {
      ...baseContract,
      engine: {
        ...baseContract.engine,
        policy: {
          ...baseContract.engine.policy,
          hash: "0".repeat(64)
        }
      }
    }]
  ]

  for (const [label, mutated] of policySignificantMutations) {
    assert.notEqual(policyHashFor(mutated), PHASE_6P_RUN_CANCELLATION_POLICY_HASH, label)
  }
})

test("Phase 6P successfully cancels every eligible quiescent status with one transition", async () => {
  let seed = 1

  for (const status of DEVELOPMENT_RUN_CANCELLATION_ELIGIBLE_STATUSES) {
    const writeDataDir = await tempWriteDataDir()
    const before = await makeRun({ writeDataDir, seed, status })
    seed += 1
    const beforeSnapshot = await snapshotTree(runPaths(writeDataDir, before.runId).runRoot)
    const staged = await stageDevelopmentRunCancellationApproval(before.runId, {
      writeDataDir,
      now: () => new Date("2026-08-24T01:00:00.000Z"),
      randomBytesImpl: randomBytesForSeed(seed)
    })
    const afterStage = await readDevelopmentRun(before.runId, { writeDataDir })
    const afterStageSnapshot = await snapshotTree(runPaths(writeDataDir, before.runId).runRoot)

    assert.equal(staged.ok, true, `${status} stages`)
    assert.equal(staged.beforeStatus, status)
    assert.equal(staged.expectedVersion, before.version)
    assert.deepEqual(afterStage, before, `${status} staging does not mutate run record`)
    assert.deepEqual(afterStageSnapshot, beforeSnapshot, `${status} staging leaves development-runs tree unchanged`)

    const confirmed = await confirmDevelopmentRunCancellationApproval(staged.requestId, {
      writeDataDir,
      now: () => new Date("2026-08-24T01:01:00.000Z")
    })
    const final = await readDevelopmentRun(before.runId, { writeDataDir })

    assert.equal(confirmed.ok, true, `${status} confirms`)
    assert.equal(confirmed.code, "cancelled")
    assert.equal(confirmed.beforeStatus, status)
    assert.equal(confirmed.afterStatus, "cancelled")
    assert.equal(confirmed.beforeVersion, before.version)
    assert.equal(confirmed.afterVersion, before.version + 1)
    assert.equal(final.status, "cancelled")
    assert.equal(final.stage, "closed")
    assert.equal(final.version, before.version + 1)
    assert.equal(final.timestamps.terminalAt, final.timestamps.updatedAt)
    assert.equal(final.branch, before.branch)
    assert.equal(final.headSha, before.headSha)
    assert.equal(final.baseSha, before.baseSha)
    assert.equal(final.project.id, before.project.id)
    assert.equal(final.task, before.task)
    assert.equal(final.history.length, before.history.length + 1)
    assert.equal(final.history.at(-1).actor, DEVELOPMENT_RUN_CANCELLATION_ACTOR)
    assert.equal(final.history.at(-1).reason, DEVELOPMENT_RUN_CANCELLATION_REASON)
    assert.equal(final.history.at(-1).fromStatus, status)
    assert.equal(final.history.at(-1).toStatus, "cancelled")
    assertNoPhase6PEvidence(final)

    const exactCatalog = await handlePpoDevelopmentRunCommand(before.runId, { writeDataDir })
    assert.equal(exactCatalog.ok, true)
    assert.match(exactCatalog.output, /Status: cancelled/u)

    const listCatalog = await handlePpoDevelopmentRunsCommand({ writeDataDir })
    assert.equal(listCatalog.ok, true)
    assert.match(listCatalog.output, new RegExp(before.runId, "u"))
    assert.doesNotMatch(listCatalog.output, new RegExp(TASK_TEXT, "u"))

    const continued = await handlePpoDevelopmentContinueCommand(before.runId, {
      writeDataDir,
      childApi: {
        planNextDevelopmentRunStage: async () => {
          throw new Error("continue child must not run")
        }
      }
    })
    assert.equal(continued.ok, false)
    assert.doesNotMatch(continued.output, /continue child must not run/u)
  }
})

test("Phase 6P preserves nullable headSha through eligibility, staging, and cancellation", async () => {
  let seed = 170

  for (const status of ["created", "planned"]) {
    const writeDataDir = await tempWriteDataDir()
    const before = await makeRun({
      writeDataDir,
      seed,
      status,
      headSha: null
    })
    seed += 1

    assert.equal(before.headSha, null)

    const ready = await inspectDevelopmentRunCancellationEligibility(before.runId, { writeDataDir })
    const readyOutput = formatDevelopmentRunCancellation(ready)

    assert.equal(ready.ok, true)
    assert.equal(ready.code, "cancellation_ready")
    assert.equal(ready.headSha, null)
    assert.match(readyOutput, /Status: ready/u)
    assert.match(readyOutput, /Head: \(none\)/u)

    const staged = await stageDevelopmentRunCancellationApproval(before.runId, {
      writeDataDir,
      now: () => new Date("2026-08-24T06:00:00.000Z"),
      randomBytesImpl: randomBytesForSeed(seed)
    })
    const stagedOutput = formatDevelopmentRunCancellation(staged)
    const afterStage = await readDevelopmentRun(before.runId, { writeDataDir })

    assert.equal(staged.ok, true)
    assert.equal(staged.code, "cancellation_staged")
    assert.equal(staged.headSha, null)
    assert.equal(afterStage.headSha, null)
    assert.equal(afterStage.version, before.version)
    assert.match(stagedOutput, /Status: staged/u)
    assert.match(stagedOutput, /Head: \(none\)/u)

    const confirmed = await confirmDevelopmentRunCancellationApproval(staged.requestId, {
      writeDataDir,
      now: () => new Date("2026-08-24T06:01:00.000Z")
    })
    const confirmedOutput = formatDevelopmentRunCancellation(confirmed)
    const final = await readDevelopmentRun(before.runId, { writeDataDir })

    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.code, "cancelled")
    assert.equal(confirmed.headSha, null)
    assert.equal(confirmed.beforeVersion, before.version)
    assert.equal(confirmed.afterVersion, before.version + 1)
    assert.equal(final.status, "cancelled")
    assert.equal(final.headSha, null)
    assert.equal(final.version, before.version + 1)
    assert.equal(final.history.filter((event) => event.toStatus === "cancelled").length, 1)
    assert.match(confirmedOutput, /Status: cancelled/u)
    assert.match(confirmedOutput, /Head: \(none\)/u)
  }
})

test("Phase 6P refuses non-quiescent, delivery, production, terminal, and unsafe canonical states", async () => {
  const writeDataDir = await tempWriteDataDir()
  const inProgress = await makeRun({ writeDataDir, seed: 20, status: "implementation_in_progress" })
  const delivery = await makeRun({ writeDataDir, seed: 21, status: "review_passed" })
  const production = await makeRun({ writeDataDir, seed: 22, status: "deployed" })
  const terminal = await makeRun({ writeDataDir, seed: 23, status: "verified" })

  assert.equal((await inspectDevelopmentRunCancellationEligibility(inProgress.runId, { writeDataDir })).code, "state_not_quiescent")
  assert.equal((await inspectDevelopmentRunCancellationEligibility(delivery.runId, { writeDataDir })).code, "delivery_state_out_of_scope")
  assert.equal((await inspectDevelopmentRunCancellationEligibility(production.runId, { writeDataDir })).code, "production_state_out_of_scope")
  assert.equal((await inspectDevelopmentRunCancellationEligibility(terminal.runId, { writeDataDir })).code, "terminal_state")

  const behind = await makeRun({ writeDataDir, seed: 24, status: "planned" })
  const paths = runPaths(writeDataDir, behind.runId)
  const versionZero = await readFile(paths.versionPath(0), "utf8")
  await writeFile(paths.recordPath, versionZero, { mode: 0o600 })
  const before = await readFile(paths.recordPath, "utf8")
  const result = await inspectDevelopmentRunCancellationEligibility(behind.runId, { writeDataDir })
  const after = await readFile(paths.recordPath, "utf8")

  assert.equal(result.ok, false)
  assert.equal(result.code, "canonical_recovery_required")
  assert.equal(after, before, "read-only preflight does not repair lagging canonical")
})

test("Phase 6P excludes PPO self-development runs without self-development mutation", async () => {
  const writeDataDir = await tempWriteDataDir()
  const self = await createPersonalProjectOperatorSelfDevelopmentRun({
    task: "PPO production deployment metadata must not leak",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    actor: "phase-6p-test"
  }, {
    writeDataDir,
    randomBytesImpl: randomBytesForSeed(31)
  })

  const result = await inspectDevelopmentRunCancellationEligibility(self.runId, { writeDataDir })
  const output = formatDevelopmentRunCancellation(result)

  assert.equal(result.ok, false)
  assert.equal(result.code, "project_out_of_scope")
  assert.doesNotMatch(output, new RegExp(self.runId, "u"))
  assert.doesNotMatch(output, /personal-project-operator|deploy|verification|rollback|production/u)
})

test("Phase 6P cancellation formatter is total and fail-closed for hostile input", () => {
  const fallback = [
    "PPO Development Run Cancellation",
    "Status: unavailable"
  ].join("\n")
  const hostile = [
    null,
    undefined,
    [],
    ["x"],
    Symbol("bad"),
    "SENSITIVE_TEST_SENTINEL",
    { ok: true },
    {
      schemaVersion: 1,
      cancellation: DEVELOPMENT_RUN_CANCELLATION_ID,
      policy: {
        id: PHASE_6P_RUN_CANCELLATION_POLICY_ID,
        hash: PHASE_6P_RUN_CANCELLATION_POLICY_HASH
      },
      ok: true,
      code: "cancelled",
      outcome: "cancelled",
      runId: "A".repeat(43),
      project: "khlim-assist\nInjected",
      beforeStatus: "created",
      afterStatus: "cancelled",
      beforeVersion: 0,
      afterVersion: 1,
      headSha: HEAD_SHA,
      reason: DEVELOPMENT_RUN_CANCELLATION_REASON
    },
    {
      get requestId() {
        throw new Error("SENSITIVE_TEST_SENTINEL getter")
      }
    },
    new Proxy({}, {
      ownKeys() {
        throw new Error("SENSITIVE_TEST_SENTINEL proxy")
      }
    })
  ]

  for (const value of hostile) {
    assert.equal(formatDevelopmentRunCancellation(value), fallback)
  }
})

test("Phase 6P cancellation engine source excludes recovery, continuation, production, subprocess, and self-development mutation APIs", async () => {
  const source = await readFile(new URL("development-run-cancellation.mjs", import.meta.url), "utf8")

  for (const forbidden of [
    "createDevelopmentRun",
    "recordDevelopmentRunProgress",
    "createPersonalProjectOperatorSelfDevelopmentRun",
    "transitionPersonalProjectOperatorSelfDevelopmentRun",
    "recordPersonalProjectOperatorSelfDevelopmentRunProgress",
    "development-continue-orchestrator",
    "development-recovery-coordinator",
    "development-recovery-route",
    "github-delivery-agent",
    "development-deployment-agent",
    "development-production-verification-agent",
    "development-rollback-agent",
    "node:child_process",
    "execFile",
    "spawn",
    "process.kill",
    "curl",
    "wget",
    "ssh",
    "systemctl"
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }

  assert.equal(source.includes("transitionDevelopmentRun"), true)
  assert.equal(source.includes("inspectDevelopmentRunSummary"), true)
})
