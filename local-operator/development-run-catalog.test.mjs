import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  chmod,
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
  DEVELOPMENT_RUN_STATUSES,
  MAX_DEVELOPMENT_RUN_RECORD_BYTES,
  createDevelopmentRun,
  createPersonalProjectOperatorSelfDevelopmentRun,
  inspectDevelopmentRunReadOnly,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  DEVELOPMENT_RUN_CATALOG_ID,
  MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED,
  MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES,
  PHASE_6N_RUN_CATALOG_POLICY_HASH,
  PHASE_6N_RUN_CATALOG_POLICY_ID,
  formatDevelopmentRunCatalog,
  formatDevelopmentRunSummary,
  inspectDevelopmentRunSummary,
  listDevelopmentRunSummaries
} from "./development-run-catalog.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const TASK_SENTINEL = "CATALOG_TEST_TASK_TEXT_MUST_NOT_LEAK"
const PROJECT_IDS = [
  "khlim-assist",
  "ledgerpilot-ai",
  "spy-market-agent",
  "portfolio",
  "rbl-content-engine"
]

function runIdForSeed(seed) {
  return Buffer.alloc(32, seed).toString("base64url")
}

function randomBytesForSeed(seed) {
  return (size) => Buffer.alloc(size, seed)
}

function makeClock(start = "2026-08-21T00:00:00.000Z") {
  let tick = 0
  const startMs = Date.parse(start)

  return () => {
    const next = new Date(startMs + tick * 1000)
    tick += 1
    return next
  }
}

async function tempWriteDataDir(label = "ppo-6n-") {
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

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

function eventHash(event) {
  const hashable = { ...event }
  delete hashable.eventHash
  return createHash("sha256").update(stableStringify(hashable)).digest("hex")
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

  throw new Error(`No path to ${targetStatus}`)
}

async function makeRun({
  writeDataDir,
  seed,
  projectId = "khlim-assist",
  status = "created",
  start = "2026-08-21T00:00:00.000Z",
  task = `${TASK_SENTINEL} ${seed}`
}) {
  const now = makeClock(start)
  let record = await createDevelopmentRun({
    projectId,
    task,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    actor: "catalog-test"
  }, {
    writeDataDir,
    now,
    randomBytesImpl: randomBytesForSeed(seed)
  })

  for (const nextStatus of transitionPathTo(status)) {
    record = await transitionDevelopmentRun(record.runId, {
      expectedVersion: record.version,
      status: nextStatus,
      actor: "catalog-test"
    }, {
      writeDataDir,
      now
    })
  }

  return record
}

async function makeSelfDevelopmentRun({ writeDataDir, seed }) {
  return createPersonalProjectOperatorSelfDevelopmentRun({
    task: `${TASK_SENTINEL} self development production details must not leak`,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    branch: "phase-6n-self-development-hidden",
    actor: "catalog-test"
  }, {
    writeDataDir,
    now: makeClock("2026-08-21T12:00:00.000Z"),
    randomBytesImpl: randomBytesForSeed(seed)
  })
}

async function writeRecordClone(writeDataDir, sourceRecord, seed) {
  const runId = runIdForSeed(seed)
  const paths = runPaths(writeDataDir, runId)
  const record = {
    ...JSON.parse(JSON.stringify(sourceRecord)),
    runId
  }
  const payload = `${JSON.stringify(record)}\n`

  await mkdir(paths.versionDir, { recursive: true, mode: 0o700 })
  await writeFile(paths.recordPath, payload, { mode: 0o600 })
  await writeFile(join(paths.versionDir, "000000.json"), payload, { mode: 0o600 })
  return record
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

async function assertCatalogDoesNotMutate(writeDataDir, operation) {
  const root = join(writeDataDir, "development-runs")
  const before = await snapshotTree(root)

  await operation()

  const after = await snapshotTree(root)
  assert.deepEqual(after, before)
}

function validCatalogResultForSummary(summary, overrides = {}) {
  return {
    schemaVersion: 1,
    catalog: DEVELOPMENT_RUN_CATALOG_ID,
    ok: true,
    code: summary.canonicalState,
    summary,
    diagnostics: {
      scanned: 1,
      returned: 1,
      invalid: 0,
      outOfScope: 0,
      truncated: false
    },
    ...overrides
  }
}

function validCatalogListForSummaries(summaries, overrides = {}) {
  return {
    schemaVersion: 1,
    catalog: DEVELOPMENT_RUN_CATALOG_ID,
    policy: {
      id: PHASE_6N_RUN_CATALOG_POLICY_ID,
      hash: PHASE_6N_RUN_CATALOG_POLICY_HASH
    },
    ok: true,
    code: "ok",
    summaries,
    active: summaries.filter((summary) => !summary.terminal),
    terminal: summaries.filter((summary) => summary.terminal),
    diagnostics: {
      scanned: summaries.length,
      returned: summaries.length,
      invalid: 0,
      outOfScope: 0,
      truncated: false
    },
    ...overrides
  }
}

function assertUnavailableOutput(output, forbiddenPattern = /CATALOG_TEST|SENSITIVE|personal-project-operator|\/tmp|token|secret|evidence|history|task/iu) {
  assert.match(output, /Status: unavailable/u)
  assert.equal(output.length < 120, true)
  assert.doesNotMatch(output, forbiddenPattern)
}

function assertCatalogUnavailableOutput(output, forbiddenPattern = /CATALOG_TEST|SENSITIVE|personal-project-operator|\/tmp|token|secret|evidence|history|task/iu) {
  assert.equal(output, [
    "PPO Development Runs",
    "Status: unavailable"
  ].join("\n"))
  assert.doesNotMatch(output, forbiddenPattern)
}

test("Phase 6N discovers ordinary opaque run ids and returns bounded metadata only", async () => {
  const writeDataDir = await tempWriteDataDir()
  const runs = [
    await makeRun({
      writeDataDir,
      seed: 1,
      projectId: "khlim-assist",
      status: "implementation_in_progress",
      start: "2026-08-21T00:00:00.000Z"
    }),
    await makeRun({
      writeDataDir,
      seed: 2,
      projectId: "portfolio",
      status: "review_passed",
      start: "2026-08-21T01:00:00.000Z"
    }),
    await makeRun({
      writeDataDir,
      seed: 3,
      projectId: "rbl-content-engine",
      status: "tests_passed",
      start: "2026-08-21T02:00:00.000Z"
    })
  ]

  const catalog = await listDevelopmentRunSummaries({ writeDataDir })
  const serialized = JSON.stringify(catalog)
  const formatted = formatDevelopmentRunCatalog(catalog)

  assert.equal(catalog.ok, true)
  assert.equal(catalog.catalog, DEVELOPMENT_RUN_CATALOG_ID)
  assert.equal(catalog.diagnostics.scanned, 3)
  assert.equal(catalog.diagnostics.returned, 3)
  assert.deepEqual(new Set(catalog.summaries.map((summary) => summary.runId)), new Set(runs.map((run) => run.runId)))
  assert.equal(catalog.summaries[0].runId, runs[2].runId)
  assert.equal(catalog.summaries[1].runId, runs[1].runId)
  assert.equal(catalog.summaries[2].runId, runs[0].runId)

  for (const run of runs) {
    const summary = catalog.summaries.find((entry) => entry.runId === run.runId)

    assert.equal(summary.project, run.project.id)
    assert.equal(summary.status, run.status)
    assert.equal(summary.stage, run.stage)
    assert.equal(summary.version, run.version)
    assert.equal(summary.baseSha, BASE_SHA)
    assert.equal(summary.headSha, HEAD_SHA)
    assert.equal(summary.updatedAt, run.timestamps.updatedAt)
    assert.equal(summary.canonicalState, "canonical_current")
  }

  assert.doesNotMatch(serialized, new RegExp(TASK_SENTINEL, "u"))
  assert.doesNotMatch(formatted, new RegExp(TASK_SENTINEL, "u"))
  assert.match(formatted, /PPO Development Runs/u)
  assert.match(formatDevelopmentRunSummary({ summary: catalog.summaries[0] }), /PPO Development Run/u)
})

test("Phase 6N exact inspection accepts only an opaque run id as logical input", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await makeRun({
    writeDataDir,
    seed: 4,
    projectId: "ledgerpilot-ai",
    status: "planned"
  })

  const inspected = await inspectDevelopmentRunSummary(run.runId, {
    writeDataDir,
    project: "portfolio",
    status: "failed",
    stage: "closed",
    expectedVersion: 999,
    sha: "f".repeat(40),
    branch: "main",
    repository: "Linardi1328/personal-project-operator",
    workspace: "/tmp/not-used",
    action: "continue",
    sort: "task",
    path: "/tmp/not-used",
    command: "not-used",
    service: "not-used",
    confirmation: "not-used"
  })

  assert.equal(inspected.ok, true)
  assert.equal(inspected.summary.runId, run.runId)
  assert.equal(inspected.summary.project, "ledgerpilot-ai")
  assert.equal(inspected.summary.status, "planned")
  assert.equal(inspected.summary.version, run.version)

  const invalidRoot = await tempWriteDataDir("ppo-6n-invalid-")
  const malformedRunIds = [
    "../not-a-run",
    ` ${run.runId}`,
    `${run.runId} `,
    `\n${run.runId}`,
    `${run.runId}\n`,
    `${run.runId}\r`,
    `${run.runId}\t`,
    `${run.runId}\u0000`,
    run.runId.slice(1),
    `${run.runId}x`,
    null,
    [],
    123
  ]

  for (const malformed of malformedRunIds) {
    const invalid = await inspectDevelopmentRunSummary(malformed, {
      writeDataDir: invalidRoot
    })

    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, "invalid_run_id")
  }

  await assert.rejects(lstat(join(invalidRoot, "development-runs")), { code: "ENOENT" })
})

test("Phase 6N uses active-first deterministic ordering and fixed output bounds", async () => {
  const writeDataDir = await tempWriteDataDir()
  const terminalRun = await makeRun({
    writeDataDir,
    seed: 5,
    status: "cancelled",
    start: "2026-08-21T23:00:00.000Z"
  })
  const activeRun = await makeRun({
    writeDataDir,
    seed: 6,
    status: "created",
    start: "2026-08-21T00:00:00.000Z"
  })

  let catalog = await listDevelopmentRunSummaries({ writeDataDir })

  assert.equal(catalog.summaries[0].runId, activeRun.runId)
  assert.equal(catalog.summaries[1].runId, terminalRun.runId)
  assert.equal(catalog.active.length, 1)
  assert.equal(catalog.terminal.length, 1)

  const boundedRoot = await tempWriteDataDir("ppo-6n-bounds-")
  const source = await makeRun({
    writeDataDir: boundedRoot,
    seed: 1,
    status: "created"
  })

  for (let seed = 2; seed <= MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED + 5; seed += 1) {
    await writeRecordClone(boundedRoot, source, seed)
  }

  catalog = await listDevelopmentRunSummaries({ writeDataDir: boundedRoot })

  assert.equal(catalog.ok, true)
  assert.equal(catalog.code, "catalog_truncated")
  assert.equal(catalog.diagnostics.scanned, MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED)
  assert.equal(catalog.diagnostics.returned, MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES)
  assert.equal(catalog.summaries.length, MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES)
  assert.equal(catalog.diagnostics.truncated, true)
})

test("Phase 6N reports canonical read-only states without repairing records", async () => {
  const currentRoot = await tempWriteDataDir("ppo-6n-current-")
  const current = await makeRun({
    writeDataDir: currentRoot,
    seed: 7,
    status: "planned"
  })
  let inspected = await inspectDevelopmentRunSummary(current.runId, {
    writeDataDir: currentRoot
  })

  assert.equal(inspected.ok, true)
  assert.equal(inspected.summary.canonicalState, "canonical_current")

  const behindRoot = await tempWriteDataDir("ppo-6n-behind-")
  const behind = await makeRun({
    writeDataDir: behindRoot,
    seed: 8,
    status: "planned"
  })
  const behindPaths = runPaths(behindRoot, behind.runId)
  const oldCanonical = await readFile(join(behindPaths.versionDir, "000000.json"), "utf8")

  await writeFile(behindPaths.recordPath, oldCanonical, { mode: 0o600 })
  const beforeBehind = await readFile(behindPaths.recordPath, "utf8")
  inspected = await inspectDevelopmentRunSummary(behind.runId, {
    writeDataDir: behindRoot
  })

  assert.equal(inspected.ok, true)
  assert.equal(inspected.summary.version, behind.version)
  assert.equal(inspected.summary.canonicalState, "canonical_behind")
  assert.equal(inspected.summary.recoveryRequired, true)
  assert.equal(await readFile(behindPaths.recordPath, "utf8"), beforeBehind)

  const missingRoot = await tempWriteDataDir("ppo-6n-missing-canonical-")
  const missing = await makeRun({
    writeDataDir: missingRoot,
    seed: 9,
    status: "planned"
  })
  const missingPaths = runPaths(missingRoot, missing.runId)

  await unlink(missingPaths.recordPath)
  inspected = await inspectDevelopmentRunSummary(missing.runId, {
    writeDataDir: missingRoot
  })

  assert.equal(inspected.ok, true)
  assert.equal(inspected.summary.version, missing.version)
  assert.equal(inspected.summary.canonicalState, "canonical_missing")
  assert.equal(inspected.summary.recoveryRequired, true)
  await assert.rejects(lstat(missingPaths.recordPath), { code: "ENOENT" })

  const conflictRoot = await tempWriteDataDir("ppo-6n-conflict-")
  const conflict = await makeRun({
    writeDataDir: conflictRoot,
    seed: 10,
    status: "created"
  })
  const conflictPaths = runPaths(conflictRoot, conflict.runId)
  const markerPath = join(conflictPaths.versionDir, "000000.json")
  const marker = JSON.parse(await readFile(markerPath, "utf8"))

  marker.task = "Different valid task text for conflict."
  marker.history[0].task = marker.task
  marker.history[0].eventHash = eventHash(marker.history[0])
  marker.historyHash = marker.history[0].eventHash
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 })

  inspected = await inspectDevelopmentRunSummary(conflict.runId, {
    writeDataDir: conflictRoot
  })

  assert.equal(inspected.ok, false)
  assert.equal(inspected.code, "canonical_conflict")
  assert.equal(inspected.canonicalState, "canonical_conflict")
})

test("Phase 6N read-only inspection performs one final whole-observation stability check", async () => {
  const currentRoot = await tempWriteDataDir("ppo-6n-final-current-")
  const current = await makeRun({
    writeDataDir: currentRoot,
    seed: 101,
    status: "planned"
  })
  await assertCatalogDoesNotMutate(currentRoot, async () => {
    const snapshot = await inspectDevelopmentRunReadOnly(current.runId, {
      writeDataDir: currentRoot
    })

    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.canonicalState, "canonical_current")
  })

  const behindRoot = await tempWriteDataDir("ppo-6n-final-behind-")
  const behind = await makeRun({
    writeDataDir: behindRoot,
    seed: 102,
    status: "planned"
  })
  const behindPaths = runPaths(behindRoot, behind.runId)
  await writeFile(behindPaths.recordPath, await readFile(join(behindPaths.versionDir, "000000.json"), "utf8"), { mode: 0o600 })
  await assertCatalogDoesNotMutate(behindRoot, async () => {
    const snapshot = await inspectDevelopmentRunReadOnly(behind.runId, {
      writeDataDir: behindRoot
    })

    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.canonicalState, "canonical_behind")
  })

  const missingRoot = await tempWriteDataDir("ppo-6n-final-missing-")
  const missing = await makeRun({
    writeDataDir: missingRoot,
    seed: 103,
    status: "planned"
  })
  await unlink(runPaths(missingRoot, missing.runId).recordPath)
  await assertCatalogDoesNotMutate(missingRoot, async () => {
    const snapshot = await inspectDevelopmentRunReadOnly(missing.runId, {
      writeDataDir: missingRoot
    })

    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.canonicalState, "canonical_missing")
  })

  const newVersionRoot = await tempWriteDataDir("ppo-6n-final-new-version-")
  const newVersion = await makeRun({
    writeDataDir: newVersionRoot,
    seed: 104,
    status: "planned"
  })
  let snapshot = await inspectDevelopmentRunReadOnly(newVersion.runId, {
    writeDataDir: newVersionRoot,
    __readOnlyBeforeFinalCheck: async () => {
      await transitionDevelopmentRun(newVersion.runId, {
        expectedVersion: newVersion.version,
        status: "implementation_in_progress",
        actor: "concurrent-test"
      }, {
        writeDataDir: newVersionRoot,
        now: makeClock("2026-08-22T00:00:00.000Z")
      })
    }
  })

  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.code, "stale_observation")

  const refreshRoot = await tempWriteDataDir("ppo-6n-final-refresh-")
  const refresh = await makeRun({
    writeDataDir: refreshRoot,
    seed: 105,
    status: "planned"
  })
  const refreshPaths = runPaths(refreshRoot, refresh.runId)
  const latestPayload = await readFile(refreshPaths.recordPath, "utf8")
  await writeFile(refreshPaths.recordPath, await readFile(join(refreshPaths.versionDir, "000000.json"), "utf8"), { mode: 0o600 })
  snapshot = await inspectDevelopmentRunReadOnly(refresh.runId, {
    writeDataDir: refreshRoot,
    __readOnlyBeforeFinalCheck: async () => {
      await writeFile(refreshPaths.recordPath, latestPayload, { mode: 0o600 })
    }
  })

  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.code, "stale_observation")

  const deleteRoot = await tempWriteDataDir("ppo-6n-final-delete-")
  const deleted = await makeRun({
    writeDataDir: deleteRoot,
    seed: 106,
    status: "planned"
  })
  const deletePaths = runPaths(deleteRoot, deleted.runId)
  snapshot = await inspectDevelopmentRunReadOnly(deleted.runId, {
    writeDataDir: deleteRoot,
    __readOnlyBeforeFinalCheck: async () => {
      await unlink(deletePaths.recordPath)
    }
  })

  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.code, "stale_observation")

  const symlinkRoot = await tempWriteDataDir("ppo-6n-final-version-symlink-")
  const symlinked = await makeRun({
    writeDataDir: symlinkRoot,
    seed: 107,
    status: "planned"
  })
  const symlinkPaths = runPaths(symlinkRoot, symlinked.runId)
  snapshot = await inspectDevelopmentRunReadOnly(symlinked.runId, {
    writeDataDir: symlinkRoot,
    __readOnlyBeforeFinalCheck: async () => {
      const target = join(symlinkRoot, "outside-version-dir")
      await mkdir(target, { recursive: true })
      await rm(symlinkPaths.versionDir, { recursive: true, force: true })
      await symlink(target, symlinkPaths.versionDir, "dir")
    }
  })

  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.code, "store_unavailable")
})

test("Phase 6N list fails closed when an ordinary run becomes stale during observation", async () => {
  const writeDataDir = await tempWriteDataDir("ppo-6n-list-stale-")
  const healthy = await makeRun({
    writeDataDir,
    seed: 1,
    status: "created"
  })
  const changing = await makeRun({
    writeDataDir,
    seed: 2,
    status: "planned"
  })

  assert.equal([healthy.runId, changing.runId].sort()[0], healthy.runId)

  let finalCheckCalls = 0
  let afterConcurrentWriter = null

  const catalog = await listDevelopmentRunSummaries({
    writeDataDir,
    __readOnlyBeforeFinalCheck: async () => {
      finalCheckCalls += 1

      if (finalCheckCalls === 2) {
        await transitionDevelopmentRun(changing.runId, {
          expectedVersion: changing.version,
          status: "implementation_in_progress",
          actor: "concurrent-test"
        }, {
          writeDataDir,
          now: makeClock("2026-08-22T00:00:00.000Z")
        })
        afterConcurrentWriter = await snapshotTree(join(writeDataDir, "development-runs"))
      }
    }
  })
  const afterCatalog = await snapshotTree(join(writeDataDir, "development-runs"))

  assert.equal(finalCheckCalls, 2)
  assert.equal(catalog.ok, false)
  assert.equal(catalog.code, "stale_observation")
  assert.equal(catalog.outcome, "stale_observation")
  assert.deepEqual(catalog.summaries, [])
  assert.equal(catalog.diagnostics.invalid, 0)
  assert.equal(catalog.diagnostics.scanned, 2)
  assert.deepEqual(afterCatalog, afterConcurrentWriter)
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(TASK_SENTINEL, "u"))
})

test("Phase 6N corrupt entries and malformed filenames do not compromise ordinary catalog listing", async () => {
  const writeDataDir = await tempWriteDataDir()
  const validA = await makeRun({
    writeDataDir,
    seed: 11,
    projectId: "khlim-assist",
    status: "planned"
  })
  const corrupt = await makeRun({
    writeDataDir,
    seed: 12,
    projectId: "portfolio",
    status: "created"
  })
  const validC = await makeRun({
    writeDataDir,
    seed: 13,
    projectId: "spy-market-agent",
    status: "tests_passed"
  })
  const corruptPaths = runPaths(writeDataDir, corrupt.runId)

  await writeFile(corruptPaths.recordPath, `{not json ${TASK_SENTINEL}}\n`, { mode: 0o600 })
  await writeFile(join(runPaths(writeDataDir, validA.runId).recordsDir, `..${validA.runId}.json`), TASK_SENTINEL, { mode: 0o600 })
  await writeFile(join(runPaths(writeDataDir, validA.runId).recordsDir, "malformed-run-id.json"), TASK_SENTINEL, { mode: 0o600 })
  await writeFile(join(runPaths(writeDataDir, validA.runId).recordsDir, `${validA.runId}.json.tmp`), TASK_SENTINEL, { mode: 0o600 })

  const catalog = await listDevelopmentRunSummaries({ writeDataDir })
  const exactCorrupt = await inspectDevelopmentRunSummary(corrupt.runId, {
    writeDataDir
  })
  const output = `${JSON.stringify(catalog)}\n${formatDevelopmentRunCatalog(catalog)}`

  assert.equal(catalog.ok, true)
  assert.equal(catalog.diagnostics.scanned, 3)
  assert.equal(catalog.diagnostics.invalid, 1)
  assert.equal(catalog.diagnostics.returned, 2)
  assert.deepEqual(new Set(catalog.summaries.map((summary) => summary.runId)), new Set([validA.runId, validC.runId]))
  assert.equal(exactCorrupt.ok, false)
  assert.equal(exactCorrupt.code, "record_invalid")
  assert.doesNotMatch(output, new RegExp(TASK_SENTINEL, "u"))
  assert.doesNotMatch(output, /not json/u)
})

test("Phase 6N excludes PPO self-development records from the ordinary catalog", async () => {
  const writeDataDir = await tempWriteDataDir()
  const ordinaryA = await makeRun({
    writeDataDir,
    seed: 14,
    projectId: "khlim-assist",
    status: "planned"
  })
  const self = await makeSelfDevelopmentRun({
    writeDataDir,
    seed: 15
  })
  const ordinaryC = await makeRun({
    writeDataDir,
    seed: 16,
    projectId: "rbl-content-engine",
    status: "implementation_in_progress"
  })

  const catalog = await listDevelopmentRunSummaries({ writeDataDir })
  const exactSelf = await inspectDevelopmentRunSummary(self.runId, {
    writeDataDir
  })
  const serializedCatalog = JSON.stringify(catalog)
  const serializedExact = JSON.stringify(exactSelf)

  assert.equal(catalog.ok, true)
  assert.equal(catalog.diagnostics.outOfScope, 1)
  assert.deepEqual(new Set(catalog.summaries.map((summary) => summary.runId)), new Set([ordinaryA.runId, ordinaryC.runId]))
  assert.equal(exactSelf.ok, false)
  assert.equal(exactSelf.code, "project_out_of_scope")
  assert.doesNotMatch(serializedCatalog, new RegExp(self.runId, "u"))
  assert.doesNotMatch(serializedCatalog, /personal-project-operator|deployment|rollback|production/u)
  assert.doesNotMatch(serializedExact, new RegExp(self.runId, "u"))
  assert.doesNotMatch(serializedExact, /merged|deployed|verified|rollback|production|phase-6n-self-development-hidden/u)
})

test("Phase 6N marks terminal statuses and safely summarizes every existing run status", async () => {
  for (const status of ["verified", "cancelled", "failed"]) {
    const writeDataDir = await tempWriteDataDir(`ppo-6n-terminal-${status}-`)
    const run = await makeRun({
      writeDataDir,
      seed: status === "verified" ? 17 : status === "cancelled" ? 18 : 19,
      status
    })
    const inspected = await inspectDevelopmentRunSummary(run.runId, {
      writeDataDir
    })

    assert.equal(inspected.ok, true)
    assert.equal(inspected.summary.status, status)
    assert.equal(inspected.summary.stage, "closed")
    assert.equal(inspected.summary.terminal, true)
  }

  let seed = 30
  for (const status of DEVELOPMENT_RUN_STATUSES) {
    const writeDataDir = await tempWriteDataDir(`ppo-6n-status-${status}-`)
    const projectId = PROJECT_IDS[seed % PROJECT_IDS.length]
    const run = await makeRun({
      writeDataDir,
      seed,
      projectId,
      status
    })
    const inspected = await inspectDevelopmentRunSummary(run.runId, {
      writeDataDir
    })

    assert.equal(inspected.ok, true, status)
    assert.equal(inspected.summary.status, run.status, status)
    assert.equal(inspected.summary.stage, run.stage, status)
    assert.equal(inspected.summary.version, run.version, status)
    assert.equal(inspected.summary.terminal, ["verified", "cancelled", "failed"].includes(status), status)
    seed += 1
  }
})

test("Phase 6N list fails closed on unsafe filesystem trust failures without following paths", async () => {
  async function expectUnsafeListFailure(name, setup) {
    const writeDataDir = await tempWriteDataDir(`ppo-6n-unsafe-${name.replaceAll(" ", "-")}-`)
    const run = await makeRun({
      writeDataDir,
      seed: 70 + name.length,
      status: "created"
    })
    const paths = runPaths(writeDataDir, run.runId)

    await setup({ writeDataDir, run, paths })

    await assertCatalogDoesNotMutate(writeDataDir, async () => {
      const exact = await inspectDevelopmentRunSummary(run.runId, {
        writeDataDir
      })
      const catalog = await listDevelopmentRunSummaries({ writeDataDir })
      const serialized = `${JSON.stringify(exact)}\n${JSON.stringify(catalog)}`

      assert.equal(exact.ok, false, name)
      assert.equal(exact.code, "store_unavailable", name)
      assert.equal(catalog.ok, false, name)
      assert.equal(catalog.code, "store_unavailable", name)
      assert.deepEqual(catalog.summaries, [], name)
      assert.doesNotMatch(serialized, new RegExp(run.runId, "u"), name)
      assert.doesNotMatch(serialized, new RegExp(TASK_SENTINEL, "u"), name)
    })
  }

  await expectUnsafeListFailure("records directory symlink", async ({ writeDataDir, paths }) => {
    const target = join(writeDataDir, "outside-records")
    await mkdir(target, { recursive: true })
    await rm(paths.recordsDir, { recursive: true, force: true })
    await symlink(target, paths.recordsDir, "dir")
  })

  await expectUnsafeListFailure("versions directory symlink", async ({ writeDataDir, paths }) => {
    const target = join(writeDataDir, "outside-versions")
    await mkdir(target, { recursive: true })
    await rm(paths.versionsRoot, { recursive: true, force: true })
    await symlink(target, paths.versionsRoot, "dir")
  })

  await expectUnsafeListFailure("canonical run record symlink", async ({ writeDataDir, paths }) => {
    const target = join(writeDataDir, "outside-record.json")
    await writeFile(target, await readFile(paths.recordPath, "utf8"), { mode: 0o600 })
    await rm(paths.recordPath, { force: true })
    await symlink(target, paths.recordPath)
  })

  await expectUnsafeListFailure("run-specific version directory symlink", async ({ writeDataDir, paths }) => {
    const target = join(writeDataDir, "outside-version-dir")
    await mkdir(target, { recursive: true })
    await writeFile(join(target, "000000.json"), await readFile(paths.recordPath, "utf8"), { mode: 0o600 })
    await rm(paths.versionDir, { recursive: true, force: true })
    await symlink(target, paths.versionDir, "dir")
  })

  await expectUnsafeListFailure("version marker symlink", async ({ writeDataDir, paths }) => {
    const target = join(writeDataDir, "outside-marker.json")
    await writeFile(target, await readFile(paths.recordPath, "utf8"), { mode: 0o600 })
    await rm(join(paths.versionDir, "000000.json"), { force: true })
    await symlink(target, join(paths.versionDir, "000000.json"))
  })

  await expectUnsafeListFailure("canonical non-regular directory", async ({ paths }) => {
    await rm(paths.recordPath, { force: true })
    await mkdir(paths.recordPath)
  })

  await expectUnsafeListFailure("version marker non-regular directory", async ({ paths }) => {
    await rm(join(paths.versionDir, "000000.json"), { force: true })
    await mkdir(join(paths.versionDir, "000000.json"))
  })
})

test("Phase 6N list fails closed on permission read failure without changing the file", async () => {
  const writeDataDir = await tempWriteDataDir("ppo-6n-permission-")
  const run = await makeRun({
    writeDataDir,
    seed: 82,
    status: "created"
  })
  const paths = runPaths(writeDataDir, run.runId)
  const beforeContent = await readFile(paths.recordPath, "utf8")

  await chmod(paths.recordPath, 0o000)
  const beforeInfo = await lstat(paths.recordPath)
  const catalog = await listDevelopmentRunSummaries({ writeDataDir })
  const exact = await inspectDevelopmentRunSummary(run.runId, { writeDataDir })
  const afterInfo = await lstat(paths.recordPath)

  assert.equal(catalog.ok, false)
  assert.equal(catalog.code, "store_unavailable")
  assert.deepEqual(catalog.summaries, [])
  assert.equal(exact.ok, false)
  assert.equal(exact.code, "store_unavailable")
  assert.equal(afterInfo.mode & 0o777, beforeInfo.mode & 0o777)
  assert.equal(afterInfo.size, beforeInfo.size)

  await chmod(paths.recordPath, 0o600)
  assert.equal(await readFile(paths.recordPath, "utf8"), beforeContent)
})

test("Phase 6N oversized trusted records remain content-invalid rather than store-unavailable", async () => {
  const writeDataDir = await tempWriteDataDir("ppo-6n-oversized-")
  const healthy = await makeRun({
    writeDataDir,
    seed: 83,
    status: "created"
  })
  const oversized = await makeRun({
    writeDataDir,
    seed: 84,
    status: "created"
  })
  const paths = runPaths(writeDataDir, oversized.runId)

  await writeFile(paths.recordPath, `${"x".repeat(MAX_DEVELOPMENT_RUN_RECORD_BYTES + 1)}\n`, { mode: 0o600 })

  const catalog = await listDevelopmentRunSummaries({ writeDataDir })
  const exact = await inspectDevelopmentRunSummary(oversized.runId, { writeDataDir })

  assert.equal(catalog.ok, true)
  assert.equal(catalog.diagnostics.invalid, 1)
  assert.deepEqual(catalog.summaries.map((summary) => summary.runId), [healthy.runId])
  assert.equal(exact.ok, false)
  assert.equal(exact.code, "record_invalid")
})

test("Phase 6N catalog operations leave the development-runs tree byte-for-byte unchanged", async () => {
  const healthyRoot = await tempWriteDataDir("ppo-6n-sentinel-healthy-")
  const healthy = await makeRun({
    writeDataDir: healthyRoot,
    seed: 90,
    status: "planned"
  })
  await assertCatalogDoesNotMutate(healthyRoot, async () => {
    await inspectDevelopmentRunSummary(healthy.runId, { writeDataDir: healthyRoot })
    await listDevelopmentRunSummaries({ writeDataDir: healthyRoot })
  })

  const behindRoot = await tempWriteDataDir("ppo-6n-sentinel-behind-")
  const behind = await makeRun({
    writeDataDir: behindRoot,
    seed: 91,
    status: "planned"
  })
  const behindPaths = runPaths(behindRoot, behind.runId)
  await writeFile(behindPaths.recordPath, await readFile(join(behindPaths.versionDir, "000000.json"), "utf8"), { mode: 0o600 })
  await assertCatalogDoesNotMutate(behindRoot, async () => {
    await inspectDevelopmentRunSummary(behind.runId, { writeDataDir: behindRoot })
    await listDevelopmentRunSummaries({ writeDataDir: behindRoot })
  })

  const missingCanonicalRoot = await tempWriteDataDir("ppo-6n-sentinel-canonical-missing-")
  const missingCanonical = await makeRun({
    writeDataDir: missingCanonicalRoot,
    seed: 92,
    status: "planned"
  })
  await unlink(runPaths(missingCanonicalRoot, missingCanonical.runId).recordPath)
  await assertCatalogDoesNotMutate(missingCanonicalRoot, async () => {
    await inspectDevelopmentRunSummary(missingCanonical.runId, { writeDataDir: missingCanonicalRoot })
  })

  const corruptRoot = await tempWriteDataDir("ppo-6n-sentinel-corrupt-")
  const corrupt = await makeRun({
    writeDataDir: corruptRoot,
    seed: 93,
    status: "created"
  })
  await writeFile(runPaths(corruptRoot, corrupt.runId).recordPath, `{bad ${TASK_SENTINEL}}\n`, { mode: 0o600 })
  await assertCatalogDoesNotMutate(corruptRoot, async () => {
    await inspectDevelopmentRunSummary(corrupt.runId, { writeDataDir: corruptRoot })
    await listDevelopmentRunSummaries({ writeDataDir: corruptRoot })
  })

  const missingStoreRoot = await tempWriteDataDir("ppo-6n-sentinel-store-missing-")
  await assertCatalogDoesNotMutate(missingStoreRoot, async () => {
    const catalog = await listDevelopmentRunSummaries({ writeDataDir: missingStoreRoot })
    const exact = await inspectDevelopmentRunSummary(runIdForSeed(94), { writeDataDir: missingStoreRoot })

    assert.equal(catalog.ok, true)
    assert.equal(catalog.diagnostics.returned, 0)
    assert.equal(exact.ok, false)
    assert.equal(exact.code, "run_not_found")
  })
})

test("Phase 6N formatters validate hostile caller input before rendering", async () => {
  const writeDataDir = await tempWriteDataDir("ppo-6n-formatters-")
  const run = await makeRun({
    writeDataDir,
    seed: 120,
    projectId: "khlim-assist",
    status: "planned"
  })
  const inspected = await inspectDevelopmentRunSummary(run.runId, { writeDataDir })
  const catalog = await listDevelopmentRunSummaries({ writeDataDir })
  const summary = inspected.summary

  assert.match(formatDevelopmentRunSummary(inspected), new RegExp(run.runId, "u"))
  const validCatalogOutput = formatDevelopmentRunCatalog(catalog)
  assert.match(validCatalogOutput, new RegExp(run.runId, "u"))
  assert.doesNotMatch(validCatalogOutput, /Status: unavailable/u)

  const invalidSummaries = [
    { ...summary, runId: ` ${summary.runId}` },
    { ...summary, runId: `${summary.runId}\n` },
    { ...summary, project: `${summary.project}\u001B[2J` },
    { ...summary, project: "personal-project-operator" },
    { ...summary, project: "unknown-project" },
    { ...summary, status: "surprise_status" },
    { ...summary, stage: "surprise_stage" },
    { ...summary, stage: "review" },
    { ...summary, baseSha: "x".repeat(40) },
    { ...summary, headSha: "z".repeat(40) },
    { ...summary, createdAt: Symbol("bad") },
    { ...summary, updatedAt: Symbol("bad") },
    { ...summary, createdAt: "not-a-timestamp" },
    { ...summary, updatedAt: "2026-08-21T00:00:00.000Z\nInjected: yes" },
    { ...summary, terminal: !summary.terminal },
    { ...summary, canonicalState: "unknown_canonical_state" },
    { ...summary, task: TASK_SENTINEL },
    { ...summary, evidence: [{ secret: "SENSITIVE_TEST_SENTINEL" }] },
    { ...summary, history: [{ status: "created" }] },
    { ...summary, path: "/tmp/secret-path" },
    { ...summary, project: "khlim-assist ghp_fake_token" },
    { ...summary, project: "x".repeat(5000) }
  ]

  for (const invalid of invalidSummaries) {
    assertUnavailableOutput(formatDevelopmentRunSummary(validCatalogResultForSummary(invalid)))
    assertUnavailableOutput(formatDevelopmentRunSummary(invalid))
    assertUnavailableOutput(formatDevelopmentRunCatalog(validCatalogListForSummaries([invalid])))
  }

  const summaryWithThrowingCreatedAt = { ...summary }
  Object.defineProperty(summaryWithThrowingCreatedAt, "createdAt", {
    enumerable: true,
    get() {
      throw new Error(`${TASK_SENTINEL} getter`)
    }
  })

  assertUnavailableOutput(formatDevelopmentRunSummary(summaryWithThrowingCreatedAt))
  assertUnavailableOutput(formatDevelopmentRunSummary(validCatalogResultForSummary(summaryWithThrowingCreatedAt)))
  assertUnavailableOutput(formatDevelopmentRunCatalog(validCatalogListForSummaries([summaryWithThrowingCreatedAt])))

  const resultWithThrowingSummaries = { ...validCatalogListForSummaries([summary]) }
  Object.defineProperty(resultWithThrowingSummaries, "summaries", {
    enumerable: true,
    get() {
      throw new Error(`${TASK_SENTINEL} summaries`)
    }
  })

  const resultWithThrowingDiagnostics = { ...validCatalogListForSummaries([summary]) }
  Object.defineProperty(resultWithThrowingDiagnostics, "diagnostics", {
    enumerable: true,
    get() {
      throw new Error(`${TASK_SENTINEL} diagnostics`)
    }
  })

  assertUnavailableOutput(formatDevelopmentRunCatalog(resultWithThrowingSummaries))
  assertUnavailableOutput(formatDevelopmentRunCatalog(resultWithThrowingDiagnostics))

  const contradictorySummaryResults = [
    validCatalogResultForSummary(summary, { code: "store_unavailable" }),
    validCatalogResultForSummary(summary, { code: "record_invalid" }),
    validCatalogResultForSummary(summary, { code: "stale_observation" }),
    validCatalogResultForSummary({ ...summary, canonicalState: "canonical_behind", recoveryRequired: true }, {
      code: "canonical_current"
    }),
    validCatalogResultForSummary(summary, { code: "canonical_behind" })
  ]

  for (const contradictory of contradictorySummaryResults) {
    assertUnavailableOutput(formatDevelopmentRunSummary(contradictory))
  }

  const fakeSummaries = Array.from({ length: 10_000 }, (_, index) => ({
    ...summary,
    runId: runIdForSeed((index % 200) + 1),
    project: "personal-project-operator",
    task: `${TASK_SENTINEL} ${index}`,
    evidence: [{ token: "ghp_fake_token" }]
  }))
  const hugeOutput = formatDevelopmentRunCatalog({
    ...validCatalogListForSummaries([summary]),
    summaries: fakeSummaries,
    active: fakeSummaries,
    terminal: [],
    diagnostics: {
      scanned: 100,
      returned: 10_000,
      invalid: 0,
      outOfScope: 0,
      truncated: true
    }
  })

  assertUnavailableOutput(hugeOutput)

  const terminalSummary = {
    ...summary,
    runId: runIdForSeed(121),
    status: "failed",
    stage: "closed",
    terminal: true
  }
  const hostilePartitionEntry = {
    ...summary,
    project: "personal-project-operator",
    task: `${TASK_SENTINEL} active terminal partition`
  }

  assertCatalogUnavailableOutput(formatDevelopmentRunCatalog({
    ...validCatalogListForSummaries([summary]),
    active: Array.from({ length: 10_000 }, () => hostilePartitionEntry),
    terminal: []
  }))
  assertCatalogUnavailableOutput(formatDevelopmentRunCatalog({
    ...validCatalogListForSummaries([summary]),
    active: [],
    terminal: Array.from({ length: 10_000 }, () => hostilePartitionEntry)
  }))
  assertCatalogUnavailableOutput(formatDevelopmentRunCatalog({
    ...validCatalogListForSummaries([summary]),
    active: [summary],
    terminal: [summary]
  }))
  assertCatalogUnavailableOutput(formatDevelopmentRunCatalog({
    ...validCatalogListForSummaries([summary, terminalSummary]),
    active: [terminalSummary],
    terminal: [summary]
  }))
  assert.equal(formatDevelopmentRunCatalog(catalog), validCatalogOutput)

  for (const malformed of [null, undefined, [], ["x"], "x", 1, true, { ok: true }, { ...catalog, policy: { id: "wrong", hash: PHASE_6N_RUN_CATALOG_POLICY_HASH } }]) {
    assertUnavailableOutput(formatDevelopmentRunCatalog(malformed))
    assertUnavailableOutput(formatDevelopmentRunSummary(malformed))
  }
})

test("Phase 6N catalog engine stays route-free and mutation-free after Phase 6O exposure", async () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url))
  const catalogSource = await readFile(new URL("development-run-catalog.mjs", import.meta.url), "utf8")
  const commandSource = await readFile(join(repoRoot, "local-operator", "ppo-command.mjs"), "utf8")
  const bridgeSource = await readFile(join(repoRoot, "openclaw", "plugins", "ppo-local", "bridge.mjs"), "utf8")

  for (const forbidden of [
    "createDevelopmentRun",
    "transitionDevelopmentRun",
    "recordDevelopmentRunProgress",
    "createPersonalProjectOperatorSelfDevelopmentRun",
    "transitionPersonalProjectOperatorSelfDevelopmentRun",
    "recordPersonalProjectOperatorSelfDevelopmentRunProgress",
    "readDevelopmentRun",
    "development-recovery-coordinator",
    "development-recovery-route",
    "executeDevelopmentRecovery",
    "development-continue-orchestrator",
    "handlePpoDevelopmentContinueCommand",
    "development-deployment-agent",
    "development-production-verification-agent",
    "development-rollback-agent",
    "node:child_process",
    "execFile",
    "spawnSync",
    "spawn(",
    "curl",
    "wget",
    "ssh",
    "scp",
    "rsync",
    "systemctl"
  ]) {
    assert.equal(catalogSource.includes(forbidden), false, forbidden)
  }

  assert.doesNotMatch(commandSource, /run-status|list-runs|\/ppo cancel|\/ppo retry|\/ppo resume/u)
  assert.doesNotMatch(bridgeSource, /development-run-catalog\.mjs|run-status|list-runs|\/ppo cancel|\/ppo retry|\/ppo resume/u)
})
