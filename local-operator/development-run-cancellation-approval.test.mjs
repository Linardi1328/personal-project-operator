import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  ALLOWED_DEVELOPMENT_RUN_TRANSITIONS,
  createDevelopmentRun,
  createPersonalProjectOperatorSelfDevelopmentRun,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  DEVELOPMENT_RUN_CANCELLATION_APPROVAL_STORE_DIR,
  DEVELOPMENT_RUN_CANCELLATION_APPROVAL_TTL_MS,
  CANCELLATION_REQUEST_ID_PATTERN,
  PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH,
  PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID,
  confirmDevelopmentRunCancellationApproval,
  developmentRunCancellationApprovalPolicy,
  handlePpoDevelopmentCancelCommand,
  handlePpoDevelopmentCancelConfirmCommand,
  makeDevelopmentRunCancellationRequestId,
  stageDevelopmentRunCancellationApproval
} from "./development-run-cancellation-approval.mjs"
import {
  DEVELOPMENT_RUN_CANCELLATION_REASON,
  PHASE_6P_RUN_CANCELLATION_POLICY_HASH,
  PHASE_6P_RUN_CANCELLATION_POLICY_ID
} from "./development-run-cancellation.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const repoRoot = fileURLToPath(new URL("../", import.meta.url))

function randomBytesForSeed(seed) {
  return (size) => Buffer.alloc(size, seed)
}

function makeClock(start = "2026-08-23T00:00:00.000Z") {
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

async function tempWriteDataDir(label = "ppo-6p-approval-") {
  return mkdtemp(join(tmpdir(), label))
}

function runPaths(writeDataDir, runId = "A".repeat(43)) {
  const approvalRoot = join(writeDataDir, DEVELOPMENT_RUN_CANCELLATION_APPROVAL_STORE_DIR)

  return {
    runRoot: join(writeDataDir, "development-runs"),
    approvalRoot,
    pendingDir: join(approvalRoot, "pending"),
    claimedDir: join(approvalRoot, "claimed"),
    pendingPath: join(approvalRoot, "pending", `${runId}.json`)
  }
}

async function makeRun({ writeDataDir, seed = 1, status = "created" }) {
  const now = makeClock()
  let record = await createDevelopmentRun({
    projectId: "khlim-assist",
    task: `PHASE_6P_CANCEL_APPROVAL_TASK ${seed}`,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
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

async function makeStore(writeDataDir) {
  const paths = runPaths(writeDataDir)
  await mkdir(paths.pendingDir, { recursive: true, mode: 0o700 })
  await mkdir(paths.claimedDir, { recursive: true, mode: 0o700 })
  await chmod(paths.approvalRoot, 0o700)
  await chmod(paths.pendingDir, 0o700)
  await chmod(paths.claimedDir, 0o700)
  return paths
}

function validRequestRecord(overrides = {}) {
  const createdAt = "2026-08-24T03:00:00.000Z"

  return {
    schemaVersion: 1,
    requestId: "R".repeat(43),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + DEVELOPMENT_RUN_CANCELLATION_APPROVAL_TTL_MS).toISOString(),
    policyId: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID,
    policyHash: PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH,
    runId: "A".repeat(43),
    expectedVersion: 0,
    projectId: "khlim-assist",
    beforeStatus: "created",
    ...overrides
  }
}

async function writePendingRequest(writeDataDir, record) {
  const paths = await makeStore(writeDataDir)
  await writeFile(join(paths.pendingDir, `${record.requestId}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  return paths
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
        size: info.size
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

function runPpo(args, writeDataDir) {
  return spawnSync(process.execPath, ["local-operator/ppo-command.mjs", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir
    },
    encoding: "utf8"
  })
}

test("Phase 6P approval policy binds cancellation policy, ttl, request id format, and single-use design", () => {
  assert.equal(PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID, "phase-6p-development-run-cancellation-approval-policy")
  assert.match(PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH, /^[a-f0-9]{64}$/u)
  assert.equal(PHASE_6P_RUN_CANCELLATION_POLICY_ID, "phase-6p-quiescent-development-run-cancellation-policy")
  assert.match(PHASE_6P_RUN_CANCELLATION_POLICY_HASH, /^[a-f0-9]{64}$/u)
  assert.equal(DEVELOPMENT_RUN_CANCELLATION_APPROVAL_TTL_MS, 10 * 60 * 1000)
  assert.equal(CANCELLATION_REQUEST_ID_PATTERN.test(makeDevelopmentRunCancellationRequestId({
    randomBytesImpl: randomBytesForSeed(9)
  })), true)

  const policy = developmentRunCancellationApprovalPolicy()
  assert.equal(policy.id, PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID)
  assert.equal(policy.hash, PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH)
  assert.equal(policy.cancellationPolicy.id, PHASE_6P_RUN_CANCELLATION_POLICY_ID)
  assert.equal(policy.cancellationPolicy.hash, PHASE_6P_RUN_CANCELLATION_POLICY_HASH)
  assert.equal(policy.ttlMs, DEVELOPMENT_RUN_CANCELLATION_APPROVAL_TTL_MS)
})

test("Phase 6P staging writes only a bounded cancellation approval record and does not mutate the run", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await makeRun({ writeDataDir, seed: 11, status: "planned" })
  const before = await readDevelopmentRun(run.runId, { writeDataDir })
  const staged = await stageDevelopmentRunCancellationApproval(run.runId, {
    writeDataDir,
    now: () => new Date("2026-08-24T04:00:00.000Z"),
    randomBytesImpl: randomBytesForSeed(12)
  })
  const after = await readDevelopmentRun(run.runId, { writeDataDir })
  const paths = runPaths(writeDataDir, staged.requestId)
  const requestPayload = await readFile(paths.pendingPath, "utf8")
  const request = JSON.parse(requestPayload)
  const info = await lstat(paths.pendingPath)

  assert.equal(staged.ok, true)
  assert.equal(staged.code, "cancellation_staged")
  assert.deepEqual(after, before)
  assert.equal(info.mode & 0o777, 0o600)
  assert.deepEqual(Object.keys(request).sort(), [
    "beforeStatus",
    "createdAt",
    "expectedVersion",
    "expiresAt",
    "policyHash",
    "policyId",
    "projectId",
    "requestId",
    "runId",
    "schemaVersion"
  ].sort())
  assert.equal(request.requestId, staged.requestId)
  assert.equal(request.runId, run.runId)
  assert.equal(request.expectedVersion, run.version)
  assert.equal(request.projectId, "khlim-assist")
  assert.equal(request.beforeStatus, "planned")
  assert.equal(request.policyId, PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_ID)
  assert.equal(request.policyHash, PHASE_6P_RUN_CANCELLATION_APPROVAL_POLICY_HASH)
  assert.doesNotMatch(requestPayload, /PHASE_6P_CANCEL_APPROVAL_TASK|evidence|history|workspace|stdout|stderr|token|secret/i)
})

test("Phase 6P confirmation is single-use and replay cannot add a second cancellation", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await makeRun({ writeDataDir, seed: 21, status: "created" })
  const staged = await stageDevelopmentRunCancellationApproval(run.runId, {
    writeDataDir,
    randomBytesImpl: randomBytesForSeed(22)
  })

  const first = await confirmDevelopmentRunCancellationApproval(staged.requestId, { writeDataDir })
  const second = await confirmDevelopmentRunCancellationApproval(staged.requestId, { writeDataDir })
  const final = await readDevelopmentRun(run.runId, { writeDataDir })

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, "request_already_consumed")
  assert.equal(final.history.filter((event) => event.toStatus === "cancelled").length, 1)
})

test("Phase 6P concurrent confirmations claim at most once and produce one terminal event", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await makeRun({ writeDataDir, seed: 31, status: "created" })
  const staged = await stageDevelopmentRunCancellationApproval(run.runId, {
    writeDataDir,
    randomBytesImpl: randomBytesForSeed(32)
  })

  const results = await Promise.all([
    confirmDevelopmentRunCancellationApproval(staged.requestId, { writeDataDir }),
    confirmDevelopmentRunCancellationApproval(staged.requestId, { writeDataDir })
  ])
  const final = await readDevelopmentRun(run.runId, { writeDataDir })

  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(results.filter((result) => result.code === "request_already_consumed" || result.code === "request_not_found").length, 1)
  assert.equal(final.history.filter((event) => event.toStatus === "cancelled").length, 1)
})

test("Phase 6P confirmation refuses changed state and consumes the request without retry", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await makeRun({ writeDataDir, seed: 41, status: "created" })
  const staged = await stageDevelopmentRunCancellationApproval(run.runId, {
    writeDataDir,
    randomBytesImpl: randomBytesForSeed(42)
  })

  await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "planning_in_progress",
    actor: "phase-6p-test"
  }, {
    writeDataDir
  })

  const stale = await confirmDevelopmentRunCancellationApproval(staged.requestId, { writeDataDir })
  const replay = await confirmDevelopmentRunCancellationApproval(staged.requestId, { writeDataDir })
  const final = await readDevelopmentRun(run.runId, { writeDataDir })

  assert.equal(stale.ok, false)
  assert.equal(stale.code, "stale_state")
  assert.equal(replay.code, "request_already_consumed")
  assert.equal(final.status, "planning_in_progress")
  assert.equal(final.history.filter((event) => event.toStatus === "cancelled").length, 0)
})

test("Phase 6P confirmation maps a post-revalidation stale transition to stale_state without retry", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await makeRun({ writeDataDir, seed: 51, status: "created" })
  const staged = await stageDevelopmentRunCancellationApproval(run.runId, {
    writeDataDir,
    randomBytesImpl: randomBytesForSeed(52)
  })
  let seamCalls = 0

  const stale = await confirmDevelopmentRunCancellationApproval(staged.requestId, {
    writeDataDir,
    __afterCancellationRevalidation: async () => {
      seamCalls += 1
      await transitionDevelopmentRun(run.runId, {
        expectedVersion: run.version,
        status: "planning_in_progress",
        actor: "phase-6p-test"
      }, {
        writeDataDir
      })
    }
  })
  const final = await readDevelopmentRun(run.runId, { writeDataDir })

  assert.equal(seamCalls, 1)
  assert.equal(stale.ok, false)
  assert.equal(stale.code, "stale_state")
  assert.equal(final.status, "planning_in_progress")
  assert.equal(final.history.filter((event) => event.toStatus === "cancelled").length, 0)
})

test("Phase 6P approval store failures are bounded and perform zero cancellation transition", async () => {
  const cases = [
    {
      name: "missing store",
      setup: async (writeDataDir, requestId) => ({ requestId, expected: "request_not_found" })
    },
    {
      name: "symlink pending directory",
      setup: async (writeDataDir, requestId) => {
        const paths = runPaths(writeDataDir)
        await mkdir(paths.approvalRoot, { recursive: true })
        await mkdir(paths.claimedDir, { recursive: true })
        const target = await tempWriteDataDir("ppo-6p-pending-target-")
        await symlink(target, paths.pendingDir)
        return { requestId, expected: "store_unavailable" }
      }
    },
    {
      name: "symlink claimed directory",
      setup: async (writeDataDir, requestId) => {
        const paths = runPaths(writeDataDir)
        await mkdir(paths.pendingDir, { recursive: true })
        const target = await tempWriteDataDir("ppo-6p-claimed-target-")
        await symlink(target, paths.claimedDir)
        return { requestId, expected: "store_unavailable" }
      }
    },
    {
      name: "symlink request file",
      setup: async (writeDataDir, requestId) => {
        const paths = await makeStore(writeDataDir)
        const target = join(await tempWriteDataDir("ppo-6p-request-target-"), "target.json")
        await writeFile(target, "{}\n")
        await symlink(target, join(paths.pendingDir, `${requestId}.json`))
        return { requestId, expected: "store_unavailable" }
      }
    },
    {
      name: "non-regular request file",
      setup: async (writeDataDir, requestId) => {
        const paths = await makeStore(writeDataDir)
        await mkdir(join(paths.pendingDir, `${requestId}.json`))
        return { requestId, expected: "store_unavailable" }
      }
    },
    {
      name: "oversized request record",
      setup: async (writeDataDir, requestId) => {
        const paths = await makeStore(writeDataDir)
        await writeFile(join(paths.pendingDir, `${requestId}.json`), "x".repeat(4097), { mode: 0o600 })
        return { requestId, expected: "store_unavailable" }
      }
    },
    {
      name: "permission read failure",
      setup: async (writeDataDir, requestId) => {
        await writePendingRequest(writeDataDir, validRequestRecord({ requestId }))
        await chmod(runPaths(writeDataDir, requestId).pendingPath, 0o000)
        return { requestId, expected: "store_unavailable" }
      }
    },
    {
      name: "corrupt JSON",
      setup: async (writeDataDir, requestId) => {
        await writePendingRequest(writeDataDir, {
          ...validRequestRecord({ requestId }),
          requestId
        })
        const paths = runPaths(writeDataDir, requestId)
        await writeFile(paths.pendingPath, "{not json SENSITIVE_TEST_SENTINEL}\n", { mode: 0o600 })
        return { requestId, expected: "cancellation_unavailable" }
      }
    },
    {
      name: "wrong request id",
      setup: async (writeDataDir, requestId) => {
        await writePendingRequest(writeDataDir, validRequestRecord({
          requestId,
          requestId: "Q".repeat(43)
        }))
        await writeFile(runPaths(writeDataDir, requestId).pendingPath, `${JSON.stringify(validRequestRecord({
          requestId: "Q".repeat(43)
        }))}\n`, { mode: 0o600 })
        return { requestId, expected: "cancellation_unavailable" }
      }
    },
    {
      name: "wrong policy id/hash",
      setup: async (writeDataDir, requestId) => {
        await writePendingRequest(writeDataDir, validRequestRecord({
          requestId,
          policyId: "wrong",
          policyHash: "0".repeat(64)
        }))
        return { requestId, expected: "cancellation_unavailable" }
      }
    },
    {
      name: "invalid timestamps",
      setup: async (writeDataDir, requestId) => {
        await writePendingRequest(writeDataDir, validRequestRecord({
          requestId,
          createdAt: "not-time"
        }))
        return { requestId, expected: "cancellation_unavailable" }
      }
    },
    {
      name: "expired request",
      setup: async (writeDataDir, requestId) => {
        await writePendingRequest(writeDataDir, validRequestRecord({
          requestId,
          createdAt: "2026-08-24T03:00:00.000Z",
          expiresAt: "2026-08-24T03:01:00.000Z"
        }))
        return { requestId, expected: "request_expired", now: () => new Date("2026-08-24T03:02:00.000Z") }
      }
    }
  ]

  for (const fixture of cases) {
    const writeDataDir = await tempWriteDataDir()
    const requestId = "R".repeat(43)
    const { expected, now } = await fixture.setup(writeDataDir, requestId)
    let transitionCalls = 0
    const result = await confirmDevelopmentRunCancellationApproval(requestId, {
      writeDataDir,
      now,
      stateApi: {
        transitionDevelopmentRun: async () => {
          transitionCalls += 1
          throw new Error("transition must not run")
        }
      }
    })
    const output = await handlePpoDevelopmentCancelConfirmCommand(requestId, {
      writeDataDir,
      now,
      stateApi: {
        transitionDevelopmentRun: async () => {
          throw new Error("transition must not run")
        }
      }
    })

    assert.equal(result.ok, false, fixture.name)
    assert.equal(result.code, expected, fixture.name)
    assert.equal(transitionCalls, 0, fixture.name)
    assert.equal(output.ok, false, fixture.name)
    assert.doesNotMatch(output.output, /SENSITIVE_TEST_SENTINEL|not json|transition must not run|stdout|stderr|stack/i)
  }
})

test("Phase 6P staging fails closed when the approval store boundary is unsafe", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await makeRun({ writeDataDir, seed: 61, status: "created" })
  const paths = runPaths(writeDataDir)
  await mkdir(paths.approvalRoot, { recursive: true })
  const target = await tempWriteDataDir("ppo-6p-stage-pending-target-")
  await symlink(target, paths.pendingDir)
  await mkdir(paths.claimedDir, { recursive: true })
  const beforeRun = await readDevelopmentRun(run.runId, { writeDataDir })
  const result = await stageDevelopmentRunCancellationApproval(run.runId, { writeDataDir })
  const afterRun = await readDevelopmentRun(run.runId, { writeDataDir })

  assert.equal(result.ok, false)
  assert.equal(result.code, "store_unavailable")
  assert.deepEqual(afterRun, beforeRun)
})

test("Phase 6P excludes self-development cancellation through staging and malicious approval records", async () => {
  const writeDataDir = await tempWriteDataDir()
  const self = await createPersonalProjectOperatorSelfDevelopmentRun({
    task: "PPO deployment verification rollback metadata must not leak",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    actor: "phase-6p-test"
  }, {
    writeDataDir,
    randomBytesImpl: randomBytesForSeed(71)
  })
  const staged = await handlePpoDevelopmentCancelCommand(self.runId, { writeDataDir })

  assert.equal(staged.ok, false)
  assert.equal(staged.code, "project_out_of_scope")
  assert.doesNotMatch(staged.output, new RegExp(self.runId, "u"))
  assert.doesNotMatch(staged.output, /personal-project-operator|deployment|verification|rollback/u)

  const requestId = "S".repeat(43)
  await writePendingRequest(writeDataDir, validRequestRecord({
    requestId,
    runId: self.runId,
    projectId: "personal-project-operator"
  }))
  const confirmed = await handlePpoDevelopmentCancelConfirmCommand(requestId, { writeDataDir })
  const after = await readDevelopmentRun(self.runId, {
    writeDataDir,
    allowPersonalProjectOperatorSelfDevelopmentProject: true
  })

  assert.equal(confirmed.ok, false)
  assert.equal(confirmed.code, "project_out_of_scope")
  assert.equal(after.status, self.status)
  assert.doesNotMatch(confirmed.output, new RegExp(self.runId, "u"))
  assert.doesNotMatch(confirmed.output, /personal-project-operator|deployment|verification|rollback/u)
})

test("Phase 6P terminal wrapper stages and confirms cancellation with strict argv", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await makeRun({ writeDataDir, seed: 81, status: "created" })
  const beforeSnapshot = await snapshotTree(runPaths(writeDataDir).runRoot)
  const staged = runPpo(["cancel", run.runId], writeDataDir)

  assert.equal(staged.status, 0)
  assert.match(staged.stdout, /Status: staged/u)
  assert.doesNotMatch(staged.stdout, /PHASE_6P_CANCEL_APPROVAL_TASK/u)

  const afterStageSnapshot = await snapshotTree(runPaths(writeDataDir).runRoot)
  assert.deepEqual(afterStageSnapshot, beforeSnapshot)

  const requestId = staged.stdout.match(/Request: ([A-Za-z0-9_-]{43})/u)?.[1]
  assert.equal(CANCELLATION_REQUEST_ID_PATTERN.test(requestId), true)

  const confirmed = runPpo(["/ppo", "cancel-confirm", requestId], writeDataDir)
  const final = await readDevelopmentRun(run.runId, { writeDataDir })

  assert.equal(confirmed.status, 0)
  assert.match(confirmed.stdout, /Status: cancelled/u)
  assert.equal(final.status, "cancelled")

  for (const [index, buildArgs] of [
    [0, (id) => ["/ppo", "cancel", id]],
    [1, (id) => ["ppo", "cancel", id]],
    [2, (id) => [`/ppo cancel ${id}`]],
    [3, (id) => [`ppo cancel ${id}`]]
  ]) {
    const formRun = await makeRun({ writeDataDir, seed: 90 + index, status: "created" })
    const formResult = runPpo(buildArgs(formRun.runId), writeDataDir)

    assert.equal(formResult.status, 0, buildArgs(formRun.runId).join(" "))
    assert.match(formResult.stdout, /Status: staged/u)
  }

  for (const [index, buildArgs] of [
    [0, (id) => ["cancel-confirm", id]],
    [1, (id) => ["ppo", "cancel-confirm", id]],
    [2, (id) => [`/ppo cancel-confirm ${id}`]],
    [3, (id) => [`ppo cancel-confirm ${id}`]]
  ]) {
    const formRun = await makeRun({ writeDataDir, seed: 100 + index, status: "created" })
    const formStage = await stageDevelopmentRunCancellationApproval(formRun.runId, {
      writeDataDir,
      randomBytesImpl: randomBytesForSeed(110 + index)
    })
    const formConfirm = runPpo(buildArgs(formStage.requestId), writeDataDir)

    assert.equal(formConfirm.status, 0, buildArgs(formStage.requestId).join(" "))
    assert.match(formConfirm.stdout, /Status: cancelled/u)
  }

  for (const args of [
    ["cancel"],
    ["cancel", "short"],
    ["cancel", `${run.runId}x`],
    ["cancel", run.runId, "extra"],
    [`cancel  ${run.runId}`],
    [`cancel ${run.runId} `],
    [`cancel ${run.runId}\nanything`],
    [`cancel ${run.runId}\tanything`],
    ["cancel", "--force", run.runId],
    ["cancel-confirm"],
    ["cancel-confirm", "short"],
    ["cancel-confirm", requestId, "extra"],
    [`cancel-confirm ${requestId}\nanything`],
    ["stop", run.runId],
    ["abort", run.runId],
    ["kill", run.runId],
    ["run-cancel", run.runId],
    ["cancel-run", run.runId],
    ["cancel-force", run.runId]
  ]) {
    const invalidDir = await tempWriteDataDir()
    const before = await snapshotTree(invalidDir)
    const result = runPpo(args, invalidDir)
    const after = await snapshotTree(invalidDir)

    assert.notEqual(result.status, 0, args.join(" "))
    assert.deepEqual(after, before, `${args.join(" ")} performs no store access`)
  }
})
