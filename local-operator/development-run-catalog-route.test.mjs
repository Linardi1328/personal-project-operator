import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  ALLOWED_DEVELOPMENT_RUN_TRANSITIONS,
  createDevelopmentRun,
  createPersonalProjectOperatorSelfDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  DEVELOPMENT_RUN_CATALOG_ID,
  MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES,
  PHASE_6N_RUN_CATALOG_POLICY_HASH,
  PHASE_6N_RUN_CATALOG_POLICY_ID
} from "./development-run-catalog.mjs"
import {
  DEVELOPMENT_RUN_CATALOG_ROUTE_ID,
  MAX_PHASE_6O_ROUTE_OUTPUT_CHARS,
  PHASE_6O_RUN_CATALOG_ROUTE_POLICY_HASH,
  PHASE_6O_RUN_CATALOG_ROUTE_POLICY_ID,
  handlePpoDevelopmentRunCommand,
  handlePpoDevelopmentRunsCommand
} from "./development-run-catalog-route.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const TASK_SENTINEL = "PHASE_6O_TASK_TEXT_MUST_NOT_LEAK"
const REVIEWED_PHASE_6N_POLICY_HASH = "fd364fb59fa7dbf383fa280ba1463b0ac860731766f4d4deee1ee3d25d05afa2"

function runIdForSeed(seed) {
  return Buffer.alloc(32, seed).toString("base64url")
}

function randomBytesForSeed(seed) {
  return (size) => Buffer.alloc(size, seed)
}

function makeClock(start = "2026-08-22T00:00:00.000Z") {
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

async function tempWriteDataDir(label = "ppo-6o-") {
  return mkdtemp(join(tmpdir(), label))
}

function runPaths(writeDataDir, runId) {
  return {
    runRoot: join(writeDataDir, "development-runs"),
    recordsDir: join(writeDataDir, "development-runs", "records"),
    versionsRoot: join(writeDataDir, "development-runs", "versions"),
    versionDir: join(writeDataDir, "development-runs", "versions", runId),
    recordPath: join(writeDataDir, "development-runs", "records", `${runId}.json`)
  }
}

async function makeRun({
  writeDataDir,
  seed,
  projectId = "khlim-assist",
  status = "created",
  start = "2026-08-22T00:00:00.000Z",
  task = `${TASK_SENTINEL} ${seed}`
}) {
  const now = makeClock(start)
  let record = await createDevelopmentRun({
    projectId,
    task,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    actor: "phase-6o-test"
  }, {
    writeDataDir,
    now,
    randomBytesImpl: randomBytesForSeed(seed)
  })

  for (const nextStatus of transitionPathTo(status)) {
    record = await transitionDevelopmentRun(record.runId, {
      expectedVersion: record.version,
      status: nextStatus,
      actor: "phase-6o-test"
    }, {
      writeDataDir,
      now
    })
  }

  return record
}

async function makeSelfDevelopmentRun({ writeDataDir, seed }) {
  return createPersonalProjectOperatorSelfDevelopmentRun({
    task: `${TASK_SENTINEL} production lifecycle metadata must not leak`,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    branch: "phase-6o-self-development-hidden",
    actor: "phase-6o-test"
  }, {
    writeDataDir,
    now: makeClock("2026-08-22T12:00:00.000Z"),
    randomBytesImpl: randomBytesForSeed(seed)
  })
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

function runPpoCommand(args, writeDataDir) {
  return spawnSync(process.execPath, ["local-operator/ppo-command.mjs", ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir
    },
    maxBuffer: 1024 * 1024
  })
}

function unavailableRunsOutput() {
  return [
    "PPO Development Runs",
    "Status: unavailable"
  ].join("\n")
}

function unavailableRunOutput() {
  return [
    "PPO Development Run",
    "Status: unavailable"
  ].join("\n")
}

function assertNoSensitiveOutput(output) {
  assert.doesNotMatch(output, new RegExp(TASK_SENTINEL, "u"))
  assert.doesNotMatch(output, /SENSITIVE_TEST_SENTINEL|token|secret|production|rollback|deployment|verification|phase-6o-self-development-hidden/iu)
}

function fakeCatalogApi(overrides = {}) {
  return {
    listDevelopmentRunSummaries: async () => ({ ok: true, code: "ok" }),
    inspectDevelopmentRunSummary: async () => ({ ok: true, code: "canonical_current" }),
    formatDevelopmentRunCatalog: () => "PPO Development Runs\nRuns: 0\nInvalid: 0",
    formatDevelopmentRunSummary: () => "PPO Development Run\nRun: CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\nProject: khlim-assist\nStatus: created\nStage: planning\nVersion: 0\nUpdated: 2026-08-22T00:00:00.000Z\nCanonical: canonical_current",
    ...overrides
  }
}

test("Phase 6O route adapter composes the Phase 6N list route exactly once", async () => {
  let listCalls = 0
  let catalogFormatCalls = 0
  let inspectCalls = 0
  let summaryFormatCalls = 0
  const catalogResult = { ok: true, code: "ok", sentinel: "safe" }
  const result = await handlePpoDevelopmentRunsCommand({
    writeDataDir: "/tmp/not-used-by-fake-catalog",
    catalogApi: fakeCatalogApi({
      listDevelopmentRunSummaries: async (options) => {
        listCalls += 1
        assert.deepEqual(options, { writeDataDir: "/tmp/not-used-by-fake-catalog" })
        return catalogResult
      },
      formatDevelopmentRunCatalog: (input) => {
        catalogFormatCalls += 1
        assert.equal(input, catalogResult)
        return "PPO Development Runs\nRuns: 0\nInvalid: 0"
      },
      inspectDevelopmentRunSummary: async () => {
        inspectCalls += 1
      },
      formatDevelopmentRunSummary: () => {
        summaryFormatCalls += 1
      }
    })
  })

  assert.equal(result.ok, true)
  assert.equal(result.route, DEVELOPMENT_RUN_CATALOG_ROUTE_ID)
  assert.equal(result.policy.id, PHASE_6O_RUN_CATALOG_ROUTE_POLICY_ID)
  assert.equal(result.output, "PPO Development Runs\nRuns: 0\nInvalid: 0")
  assert.equal(listCalls, 1)
  assert.equal(catalogFormatCalls, 1)
  assert.equal(inspectCalls, 0)
  assert.equal(summaryFormatCalls, 0)
})

test("Phase 6O route adapter composes the Phase 6N exact-run route exactly once", async () => {
  let listCalls = 0
  let catalogFormatCalls = 0
  let inspectCalls = 0
  let summaryFormatCalls = 0
  const runId = runIdForSeed(1)
  const summaryResult = { ok: true, code: "canonical_current", sentinel: "safe" }
  const result = await handlePpoDevelopmentRunCommand(runId, {
    catalogApi: fakeCatalogApi({
      listDevelopmentRunSummaries: async () => {
        listCalls += 1
      },
      formatDevelopmentRunCatalog: () => {
        catalogFormatCalls += 1
      },
      inspectDevelopmentRunSummary: async (input, options) => {
        inspectCalls += 1
        assert.equal(input, runId)
        assert.deepEqual(options, {})
        return summaryResult
      },
      formatDevelopmentRunSummary: (input) => {
        summaryFormatCalls += 1
        assert.equal(input, summaryResult)
        return `PPO Development Run\nRun: ${runId}\nProject: khlim-assist\nStatus: created\nStage: planning\nVersion: 0\nUpdated: 2026-08-22T00:00:00.000Z\nCanonical: canonical_current`
      }
    })
  })

  assert.equal(result.ok, true)
  assert.match(result.output, new RegExp(runId, "u"))
  assert.equal(listCalls, 0)
  assert.equal(catalogFormatCalls, 0)
  assert.equal(inspectCalls, 1)
  assert.equal(summaryFormatCalls, 1)
})

test("Phase 6O route adapter rejects malformed run ids before Phase 6N inspection", async () => {
  let inspectCalls = 0
  let summaryFormatCalls = 0

  for (const malformed of [
    runIdForSeed(2).slice(1),
    `${runIdForSeed(2)}x`,
    ` ${runIdForSeed(2)}`,
    `${runIdForSeed(2)} `,
    `${runIdForSeed(2)}\n`,
    `${runIdForSeed(2)}\r`,
    `${runIdForSeed(2)}\t`,
    `${runIdForSeed(2)}\u0000`,
    null,
    [],
    123
  ]) {
    const result = await handlePpoDevelopmentRunCommand(malformed, {
      catalogApi: fakeCatalogApi({
        inspectDevelopmentRunSummary: async () => {
          inspectCalls += 1
        },
        formatDevelopmentRunSummary: () => {
          summaryFormatCalls += 1
        }
      })
    })

    assert.equal(result.ok, false)
    assert.equal(result.code, "invalid_run_id")
    assert.equal(result.output, unavailableRunOutput())
  }

  assert.equal(inspectCalls, 0)
  assert.equal(summaryFormatCalls, 0)
})

test("Phase 6O route adapter collapses Phase 6N failures and hostile formatter output", async () => {
  const runId = runIdForSeed(3)
  let result = await handlePpoDevelopmentRunsCommand({
    catalogApi: fakeCatalogApi({
      listDevelopmentRunSummaries: async () => ({
        ok: false,
        code: "store_unavailable",
        raw: `SENSITIVE_TEST_SENTINEL ${TASK_SENTINEL}`
      }),
      formatDevelopmentRunCatalog: () => unavailableRunsOutput()
    })
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, "store_unavailable")
  assert.equal(result.output, unavailableRunsOutput())
  assertNoSensitiveOutput(result.output)

  result = await handlePpoDevelopmentRunsCommand({
    catalogApi: fakeCatalogApi({
      formatDevelopmentRunCatalog: () => `PPO Development Runs\n${"x".repeat(MAX_PHASE_6O_ROUTE_OUTPUT_CHARS + 1)}\nSENSITIVE_TEST_SENTINEL`
    })
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, "route_unavailable")
  assert.equal(result.output, unavailableRunsOutput())
  assertNoSensitiveOutput(result.output)

  result = await handlePpoDevelopmentRunCommand(runId, {
    catalogApi: fakeCatalogApi({
      inspectDevelopmentRunSummary: async () => ({
        ok: false,
        code: "project_out_of_scope",
        runId,
        project: "personal-project-operator",
        deployment: "SENSITIVE_TEST_SENTINEL production"
      }),
      formatDevelopmentRunSummary: () => unavailableRunOutput()
    })
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, "project_out_of_scope")
  assert.equal(result.output, unavailableRunOutput())
  assertNoSensitiveOutput(result.output)

  result = await handlePpoDevelopmentRunCommand(runId, {
    catalogApi: fakeCatalogApi({
      formatDevelopmentRunSummary: () => ({ hostile: "not a string" })
    })
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, "route_unavailable")
  assert.equal(result.output, unavailableRunOutput())
})

test("Phase 6O exposes a separate route policy without changing Phase 6N policy identity", () => {
  assert.equal(PHASE_6N_RUN_CATALOG_POLICY_ID, "phase-6n-readonly-development-run-catalog-policy")
  assert.equal(PHASE_6N_RUN_CATALOG_POLICY_HASH, REVIEWED_PHASE_6N_POLICY_HASH)
  assert.equal(PHASE_6O_RUN_CATALOG_ROUTE_POLICY_ID, "phase-6o-controlled-development-run-catalog-route-policy")
  assert.match(PHASE_6O_RUN_CATALOG_ROUTE_POLICY_HASH, /^[a-f0-9]{64}$/u)
  assert.notEqual(PHASE_6O_RUN_CATALOG_ROUTE_POLICY_HASH, PHASE_6N_RUN_CATALOG_POLICY_HASH)
})

test("Phase 6O terminal wrapper routes runs and run through the read-only catalog", async () => {
  const writeDataDir = await tempWriteDataDir("ppo-6o-wrapper-")
  const active = await makeRun({
    writeDataDir,
    seed: 10,
    projectId: "khlim-assist",
    status: "created",
    start: "2026-08-22T00:00:00.000Z"
  })
  const terminal = await makeRun({
    writeDataDir,
    seed: 11,
    projectId: "portfolio",
    status: "cancelled",
    start: "2026-08-23T00:00:00.000Z"
  })
  const self = await makeSelfDevelopmentRun({ writeDataDir, seed: 12 })
  const before = await snapshotTree(join(writeDataDir, "development-runs"))

  for (const args of [
    ["runs"],
    ["/ppo", "runs"],
    ["ppo", "runs"],
    ["/ppo runs"],
    ["ppo runs"]
  ]) {
    const result = runPpoCommand(args, writeDataDir)

    assert.equal(result.status, 0, args.join(" "))
    assert.match(result.stdout, /PPO Development Runs/u)
    assert.match(result.stdout, new RegExp(active.runId, "u"))
    assert.match(result.stdout, new RegExp(terminal.runId, "u"))
    assert.equal(result.stdout.indexOf(active.runId) < result.stdout.indexOf(terminal.runId), true)
    assert.doesNotMatch(result.stdout, new RegExp(self.runId, "u"))
    assertNoSensitiveOutput(result.stdout)
  }

  for (const args of [
    ["run", active.runId],
    ["/ppo", "run", active.runId],
    ["ppo", "run", active.runId],
    [`run ${active.runId}`],
    [`/ppo run ${active.runId}`],
    [`ppo run ${active.runId}`]
  ]) {
    const result = runPpoCommand(args, writeDataDir)

    assert.equal(result.status, 0, args.join(" "))
    assert.match(result.stdout, /PPO Development Run/u)
    assert.match(result.stdout, new RegExp(active.runId, "u"))
    assert.match(result.stdout, /Project: khlim-assist/u)
    assert.match(result.stdout, /Canonical: canonical_current/u)
    assertNoSensitiveOutput(result.stdout)
  }

  const after = await snapshotTree(join(writeDataDir, "development-runs"))
  assert.deepEqual(after, before)
})

test("Phase 6O terminal wrapper preserves the Phase 6N twenty-summary bound", async () => {
  const writeDataDir = await tempWriteDataDir("ppo-6o-bound-")

  for (let seed = 20; seed < 45; seed += 1) {
    await makeRun({
      writeDataDir,
      seed,
      projectId: seed % 2 === 0 ? "khlim-assist" : "ledgerpilot-ai",
      status: "created",
      start: `2026-08-22T00:00:${String(seed).padStart(2, "0")}.000Z`
    })
  }

  const before = await snapshotTree(join(writeDataDir, "development-runs"))
  const result = runPpoCommand(["runs"], writeDataDir)
  const after = await snapshotTree(join(writeDataDir, "development-runs"))
  const listed = result.stdout.split("\n").filter((line) => /^\d+\. [A-Za-z0-9_-]{43}$/u.test(line)).length

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Runs: 20/u)
  assert.equal(listed, MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES)
  assert.deepEqual(after, before)
  assertNoSensitiveOutput(result.stdout)
})

test("Phase 6O terminal wrapper rejects malformed catalog commands before store access", async () => {
  const validRunId = runIdForSeed(30)
  const invalidArgVectors = [
    ["runs", "extra"],
    ["/ppo", "runs", "extra"],
    ["ppo", "runs", "extra"],
    ["runs extra"],
    ["/ppo runs extra"],
    ["run"],
    ["/ppo", "run"],
    ["ppo", "run"],
    ["run", validRunId.slice(1)],
    ["run", `${validRunId}x`],
    ["run", validRunId, "extra"],
    ["/ppo", "run", validRunId, "extra"],
    ["run", ` ${validRunId}`],
    ["run", `${validRunId} `],
    ["run", `${validRunId}\nanything`],
    ["run", `${validRunId}\ranything`],
    ["run", `${validRunId}\tanything`],
    [`run ${validRunId} extra`],
    [`run ${validRunId}\nanything`],
    [`run ${validRunId}\ranything`],
    [`run ${validRunId}\tanything`],
    [`/ppo run ${validRunId} --action recover`],
    [`/ppo run ${validRunId} ${HEAD_SHA}`],
    ["run-status"],
    ["list-runs"],
    ["runs-all"],
    ["run-search"]
  ]

  for (const args of invalidArgVectors) {
    const writeDataDir = await tempWriteDataDir("ppo-6o-invalid-")
    const result = runPpoCommand(args, writeDataDir)

    assert.notEqual(result.status, 0, args.join(" "))
    assert.doesNotMatch(result.stdout, new RegExp(validRunId, "u"))
    await assert.rejects(lstat(join(writeDataDir, "development-runs")), { code: "ENOENT" })
  }
})

test("Phase 6O exact run route preserves canonical state and fail-closed catalog behavior", async () => {
  const behindRoot = await tempWriteDataDir("ppo-6o-behind-")
  const behind = await makeRun({
    writeDataDir: behindRoot,
    seed: 40,
    status: "planned"
  })
  const behindPaths = runPaths(behindRoot, behind.runId)
  const oldCanonical = await readFile(join(behindPaths.versionDir, "000000.json"), "utf8")
  await writeFile(behindPaths.recordPath, oldCanonical, { mode: 0o600 })
  const beforeBehind = await readFile(behindPaths.recordPath, "utf8")
  let result = runPpoCommand(["run", behind.runId], behindRoot)

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Canonical: canonical_behind/u)
  assert.equal(await readFile(behindPaths.recordPath, "utf8"), beforeBehind)

  const missingRoot = await tempWriteDataDir("ppo-6o-missing-")
  const missing = await makeRun({
    writeDataDir: missingRoot,
    seed: 41,
    status: "planned"
  })
  const missingPaths = runPaths(missingRoot, missing.runId)
  await unlink(missingPaths.recordPath)
  result = runPpoCommand(["run", missing.runId], missingRoot)

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Canonical: canonical_missing/u)
  await assert.rejects(lstat(missingPaths.recordPath), { code: "ENOENT" })

  const corruptRoot = await tempWriteDataDir("ppo-6o-corrupt-")
  const corrupt = await makeRun({
    writeDataDir: corruptRoot,
    seed: 42,
    status: "created"
  })
  await writeFile(runPaths(corruptRoot, corrupt.runId).recordPath, `{bad ${TASK_SENTINEL}}\n`, { mode: 0o600 })
  result = runPpoCommand(["run", corrupt.runId], corruptRoot)

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout.trim(), unavailableRunOutput())
  assertNoSensitiveOutput(result.stdout)

  const unsafeRoot = await tempWriteDataDir("ppo-6o-unsafe-")
  const unsafe = await makeRun({
    writeDataDir: unsafeRoot,
    seed: 43,
    status: "created"
  })
  const unsafePaths = runPaths(unsafeRoot, unsafe.runId)
  const outside = join(unsafeRoot, "outside-record.json")
  await writeFile(outside, await readFile(unsafePaths.recordPath, "utf8"), { mode: 0o600 })
  await rm(unsafePaths.recordPath, { force: true })
  await symlink(outside, unsafePaths.recordPath)
  const beforeUnsafe = await snapshotTree(join(unsafeRoot, "development-runs"))
  result = runPpoCommand(["run", unsafe.runId], unsafeRoot)
  const afterUnsafe = await snapshotTree(join(unsafeRoot, "development-runs"))

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout.trim(), unavailableRunOutput())
  assertNoSensitiveOutput(result.stdout)
  assert.deepEqual(afterUnsafe, beforeUnsafe)

  const selfRoot = await tempWriteDataDir("ppo-6o-self-")
  const self = await makeSelfDevelopmentRun({ writeDataDir: selfRoot, seed: 44 })
  result = runPpoCommand(["run", self.runId], selfRoot)

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout.trim(), unavailableRunOutput())
  assert.doesNotMatch(result.stdout, new RegExp(self.runId, "u"))
  assertNoSensitiveOutput(result.stdout)
})

test("Phase 6O route preserves stale-observation fail-closed behavior without retry", async () => {
  const exactRoot = await tempWriteDataDir("ppo-6o-stale-exact-")
  const exact = await makeRun({
    writeDataDir: exactRoot,
    seed: 50,
    status: "planned"
  })
  let seamCalls = 0
  let result = await handlePpoDevelopmentRunCommand(exact.runId, {
    writeDataDir: exactRoot,
    __readOnlyBeforeFinalCheck: async () => {
      seamCalls += 1
      await transitionDevelopmentRun(exact.runId, {
        expectedVersion: exact.version,
        status: "implementation_in_progress",
        actor: "phase-6o-concurrent-test"
      }, {
        writeDataDir: exactRoot,
        now: makeClock("2026-08-23T00:00:00.000Z")
      })
    }
  })

  assert.equal(seamCalls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.code, "stale_observation")
  assert.equal(result.output, unavailableRunOutput())

  const listRoot = await tempWriteDataDir("ppo-6o-stale-list-")
  await makeRun({
    writeDataDir: listRoot,
    seed: 1,
    status: "created"
  })
  const changing = await makeRun({
    writeDataDir: listRoot,
    seed: 2,
    status: "planned"
  })
  seamCalls = 0
  result = await handlePpoDevelopmentRunsCommand({
    writeDataDir: listRoot,
    __readOnlyBeforeFinalCheck: async () => {
      seamCalls += 1

      if (seamCalls === 2) {
        await transitionDevelopmentRun(changing.runId, {
          expectedVersion: changing.version,
          status: "implementation_in_progress",
          actor: "phase-6o-concurrent-test"
        }, {
          writeDataDir: listRoot,
          now: makeClock("2026-08-23T00:00:00.000Z")
        })
      }
    }
  })

  assert.equal(seamCalls, 2)
  assert.equal(result.ok, false)
  assert.equal(result.code, "stale_observation")
  assert.equal(result.output, unavailableRunsOutput())
})

test("Phase 6O route adapter source has no mutation, recovery, continuation, production, subprocess, or network surface", async () => {
  const source = await readFile(new URL("development-run-catalog-route.mjs", import.meta.url), "utf8")

  for (const forbidden of [
    "createDevelopmentRun",
    "transitionDevelopmentRun",
    "recordDevelopmentRunProgress",
    "development-continue-orchestrator",
    "development-recovery-coordinator",
    "development-recovery-route",
    "development-deployment-agent",
    "development-production-verification-agent",
    "development-rollback-agent",
    "node:child_process",
    "exec",
    "execFile",
    "spawn",
    "git",
    "gh",
    "curl",
    "wget",
    "ssh",
    "scp",
    "rsync",
    "systemctl"
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})
