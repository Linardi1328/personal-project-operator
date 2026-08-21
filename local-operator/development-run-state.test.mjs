import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  ALLOWED_DEVELOPMENT_RUN_TRANSITIONS,
  DEVELOPMENT_RUN_EVIDENCE_KINDS,
  DEVELOPMENT_RUN_ID_PATTERN,
  DevelopmentRunStateError,
  MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES,
  MAX_DEVELOPMENT_RUN_TASK_CHARS,
  createDevelopmentRun,
  formatDevelopmentRunStateError,
  makeDevelopmentRunId,
  recordDevelopmentRunProgress,
  readDevelopmentRun,
  resolveDevelopmentRunProject,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  handleProjectNoteAddCommand,
  readProjectNoteRecords
} from "./project-note-add.mjs"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)
const NEXT_SHA = "c".repeat(40)
const PROJECT_IDS = [
  "khlim-assist",
  "ledgerpilot-ai",
  "spy-market-agent",
  "portfolio",
  "rbl-content-engine"
]

function makeClock() {
  let tick = 0
  const start = Date.parse("2026-08-21T00:00:00.000Z")

  return () => {
    const next = new Date(start + tick * 1000)
    tick += 1
    return next
  }
}

function runPaths(writeDataDir, runId) {
  return {
    root: writeDataDir,
    runRoot: join(writeDataDir, "development-runs"),
    recordsDir: join(writeDataDir, "development-runs", "records"),
    versionsRoot: join(writeDataDir, "development-runs", "versions"),
    versionDir: join(writeDataDir, "development-runs", "versions", runId),
    recordPath: join(writeDataDir, "development-runs", "records", `${runId}.json`)
  }
}

function modeBits(info) {
  return info.mode & 0o777
}

async function tempWriteDataDir(label = "ppo-6a-") {
  return mkdtemp(join(tmpdir(), label))
}

async function makeRun(options = {}) {
  const writeDataDir = options.writeDataDir || await tempWriteDataDir()
  const now = options.now || makeClock()
  const record = await createDevelopmentRun({
    projectId: options.projectId || "khlim-assist",
    task: options.task || "Phase 6A local run-state foundation.",
    baseSha: options.baseSha || BASE_SHA,
    branch: options.branch,
    headSha: options.headSha,
    actor: options.actor
  }, {
    writeDataDir,
    now
  })

  return {
    writeDataDir,
    now,
    record
  }
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof DevelopmentRunStateError && error.code === code
  )
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

async function runToStatus(targetStatus, options = {}) {
  const fixture = await makeRun(options)
  let record = fixture.record

  for (const status of transitionPathTo(targetStatus)) {
    record = await transitionDevelopmentRun(record.runId, {
      expectedVersion: record.version,
      status,
      actor: "test-agent"
    }, {
      writeDataDir: fixture.writeDataDir,
      now: fixture.now
    })
  }

  return {
    ...fixture,
    record
  }
}

test("Phase 6A uses the fixed existing project allowlist", async () => {
  for (const projectId of PROJECT_IDS) {
    const project = resolveDevelopmentRunProject(projectId)
    assert.equal(project.id, projectId)
    assert.match(project.fullName, /^Linardi1328\//u)

    const fixture = await makeRun({ projectId })
    assert.equal(fixture.record.project.id, projectId)
  }

  for (const invalid of ["unknown", "Linardi1328/khlim-assist", "../khlim-assist", "KHLIM-assist", ""]) {
    assert.throws(() => resolveDevelopmentRunProject(invalid), DevelopmentRunStateError)
    await assertRejectsCode(createDevelopmentRun({
      projectId: invalid,
      task: "invalid project",
      baseSha: BASE_SHA
    }, {
      writeDataDir: await tempWriteDataDir(),
      now: makeClock()
    }), invalid ? "UNKNOWN_PROJECT" : "INVALID_PROJECT")
  }
})

test("development run ids are cryptographically opaque base64url ids", () => {
  const ids = new Set()

  for (let index = 0; index < 50; index += 1) {
    const runId = makeDevelopmentRunId()
    assert.match(runId, DEVELOPMENT_RUN_ID_PATTERN)
    assert.equal(ids.has(runId), false)
    ids.add(runId)
  }
})

test("initial run creation writes one canonical private record", async () => {
  const writeDataDir = await tempWriteDataDir()
  const fixture = await makeRun({
    writeDataDir,
    branch: "phase/6a-orchestration-run-state",
    headSha: HEAD_SHA,
    actor: "planner"
  })
  const record = fixture.record

  assert.equal(record.version, 0)
  assert.equal(record.status, "created")
  assert.equal(record.stage, "intake")
  assert.equal(record.baseSha, BASE_SHA)
  assert.equal(record.branch, "phase/6a-orchestration-run-state")
  assert.equal(record.headSha, HEAD_SHA)
  assert.equal(record.history.length, 1)
  assert.equal(record.history[0].toStatus, "created")
  assert.equal(record.history[0].previousHistoryHash, null)

  const paths = runPaths(writeDataDir, record.runId)
  assert.equal(modeBits(await stat(paths.root)), 0o700)
  assert.equal(modeBits(await stat(paths.runRoot)), 0o700)
  assert.equal(modeBits(await stat(paths.recordsDir)), 0o700)
  assert.equal(modeBits(await stat(paths.versionsRoot)), 0o700)
  assert.equal(modeBits(await stat(paths.versionDir)), 0o700)
  assert.equal(modeBits(await stat(paths.recordPath)), 0o600)
  assert.equal(modeBits(await stat(join(paths.versionDir, "000000.json"))), 0o600)

  const stored = JSON.parse(await readFile(paths.recordPath, "utf8"))
  assert.equal(stored.runId, record.runId)
  assert.equal(stored.historyHash, record.historyHash)
})

test("every explicit Phase 6A lifecycle transition is accepted", async () => {
  for (const [sourceStatus, targets] of Object.entries(ALLOWED_DEVELOPMENT_RUN_TRANSITIONS)) {
    for (const targetStatus of targets) {
      const fixture = await runToStatus(sourceStatus)
      const next = await transitionDevelopmentRun(fixture.record.runId, {
        expectedVersion: fixture.record.version,
        status: targetStatus,
        actor: "lifecycle-test"
      }, {
        writeDataDir: fixture.writeDataDir,
        now: fixture.now
      })

      assert.equal(next.status, targetStatus, `${sourceStatus} -> ${targetStatus}`)
      assert.equal(next.version, fixture.record.version + 1)
      assert.equal(next.history.at(-1).fromStatus, sourceStatus)
      assert.equal(next.history.at(-1).toStatus, targetStatus)
    }
  }
})

test("invalid, skipped, and backward lifecycle transitions are refused", async () => {
  const created = await makeRun()

  await assertRejectsCode(transitionDevelopmentRun(created.record.runId, {
    expectedVersion: created.record.version,
    status: "implementation_in_progress"
  }, {
    writeDataDir: created.writeDataDir,
    now: created.now
  }), "INVALID_RUN_TRANSITION")

  const testsPassed = await runToStatus("tests_passed")

  await assertRejectsCode(transitionDevelopmentRun(testsPassed.record.runId, {
    expectedVersion: testsPassed.record.version,
    status: "implementation_ready"
  }, {
    writeDataDir: testsPassed.writeDataDir,
    now: testsPassed.now
  }), "INVALID_RUN_TRANSITION")

  const verified = await runToStatus("verified")

  await assertRejectsCode(transitionDevelopmentRun(verified.record.runId, {
    expectedVersion: verified.record.version,
    status: "deploy_in_progress"
  }, {
    writeDataDir: verified.writeDataDir,
    now: verified.now
  }), "INVALID_RUN_TRANSITION")
})

test("stale and concurrent optimistic updates are refused", async () => {
  const fixture = await makeRun()
  const first = await transitionDevelopmentRun(fixture.record.runId, {
    expectedVersion: 0,
    status: "planning_in_progress",
    actor: "agent-a"
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })

  assert.equal(first.version, 1)
  await assertRejectsCode(transitionDevelopmentRun(fixture.record.runId, {
    expectedVersion: 0,
    status: "planning_in_progress",
    actor: "stale-agent"
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  }), "STALE_RUN_VERSION")

  const concurrent = await makeRun()
  const results = await Promise.allSettled([
    transitionDevelopmentRun(concurrent.record.runId, {
      expectedVersion: 0,
      status: "planning_in_progress",
      actor: "agent-a"
    }, {
      writeDataDir: concurrent.writeDataDir,
      now: concurrent.now
    }),
    transitionDevelopmentRun(concurrent.record.runId, {
      expectedVersion: 0,
      status: "planning_in_progress",
      actor: "agent-b"
    }, {
      writeDataDir: concurrent.writeDataDir,
      now: concurrent.now
    })
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => (
    result.status === "rejected" &&
    result.reason instanceof DevelopmentRunStateError &&
    result.reason.code === "STALE_RUN_VERSION"
  )).length, 1)
})

test("same-status implementation progress updates are bounded and optimistic", async () => {
  const fixture = await runToStatus("implementation_in_progress")
  const next = await recordDevelopmentRunProgress(fixture.record.runId, {
    expectedVersion: fixture.record.version,
    status: "implementation_in_progress",
    actor: "implementation-agent",
    reason: "implementation-attempt-reserved",
    incrementAttempt: true,
    evidence: {
      kind: "implementation",
      sha: fixture.record.baseSha,
      source: "implementation-agent",
      summary: "Implementation attempt metadata.",
      metadata: {
        outcome: "started",
        attempt: fixture.record.attempts.implementation + 1
      }
    }
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })

  assert.equal(next.status, "implementation_in_progress")
  assert.equal(next.version, fixture.record.version + 1)
  assert.equal(next.history.at(-1).fromStatus, "implementation_in_progress")
  assert.equal(next.history.at(-1).toStatus, "implementation_in_progress")
  assert.equal(next.attempts.implementation, fixture.record.attempts.implementation + 1)

  await assertRejectsCode(recordDevelopmentRunProgress(fixture.record.runId, {
    expectedVersion: fixture.record.version,
    status: "implementation_in_progress",
    actor: "stale-agent"
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  }), "STALE_RUN_VERSION")

  const planned = await runToStatus("planned")
  await assertRejectsCode(recordDevelopmentRunProgress(planned.record.runId, {
    expectedVersion: planned.record.version,
    status: "planned",
    actor: "wrong-stage"
  }, {
    writeDataDir: planned.writeDataDir,
    now: planned.now
  }), "INVALID_RUN_TRANSITION")
})

test("atomic durable records leave canonical JSON and version markers without temp files", async () => {
  const fixture = await runToStatus("implementation_ready")
  const paths = runPaths(fixture.writeDataDir, fixture.record.runId)
  const next = await transitionDevelopmentRun(fixture.record.runId, {
    expectedVersion: fixture.record.version,
    status: "tests_in_progress",
    headSha: NEXT_SHA,
    actor: "test-agent"
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })
  const after = await stat(paths.recordPath)

  assert.equal(next.version, fixture.record.version + 1)
  assert.equal(after.mode & 0o777, 0o600)
  const canonicalJson = await readFile(paths.recordPath, "utf8")
  assert.doesNotThrow(() => JSON.parse(canonicalJson))

  const recordEntries = await readdir(paths.recordsDir)
  const versionEntries = await readdir(paths.versionDir)
  assert.equal(recordEntries.some((entry) => entry.endsWith(".tmp")), false)
  assert.equal(versionEntries.some((entry) => entry.endsWith(".tmp")), false)

  for (let version = 0; version <= next.version; version += 1) {
    assert.equal(versionEntries.includes(`${String(version).padStart(6, "0")}.json`), true)
  }
})

test("run state recovers safely from durable version markers after restart", async () => {
  const fixture = await runToStatus("planned")
  const paths = runPaths(fixture.writeDataDir, fixture.record.runId)

  await unlink(paths.recordPath)

  const recovered = await readDevelopmentRun(fixture.record.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(recovered.status, "planned")
  assert.equal(recovered.version, fixture.record.version)
  assert.equal(modeBits(await stat(paths.recordPath)), 0o600)
})

test("legacy Phase 6A records without planning evidence remain readable", async () => {
  const fixture = await makeRun()
  const paths = runPaths(fixture.writeDataDir, fixture.record.runId)
  const canonical = JSON.parse(await readFile(paths.recordPath, "utf8"))
  const markerPath = join(paths.versionDir, "000000.json")
  const marker = JSON.parse(await readFile(markerPath, "utf8"))

  delete canonical.evidence.planning
  delete marker.evidence.planning
  await writeFile(paths.recordPath, `${JSON.stringify(canonical)}\n`, { mode: 0o600 })
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 })

  const recovered = await readDevelopmentRun(fixture.record.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.deepEqual(recovered.evidence.planning, [])
})

test("transition history integrity is enforced", async () => {
  const fixture = await runToStatus("planned")
  const paths = runPaths(fixture.writeDataDir, fixture.record.runId)
  const stored = JSON.parse(await readFile(paths.recordPath, "utf8"))

  stored.history[1].eventHash = "0".repeat(64)
  await writeFile(paths.recordPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 })

  await assertRejectsCode(readDevelopmentRun(fixture.record.runId, {
    writeDataDir: fixture.writeDataDir
  }), "RUN_HISTORY_INVALID")
})

test("inputs, transition history, and evidence sizes are bounded", async () => {
  await assertRejectsCode(createDevelopmentRun({
    projectId: "khlim-assist",
    task: "x".repeat(MAX_DEVELOPMENT_RUN_TASK_CHARS + 1),
    baseSha: BASE_SHA
  }, {
    writeDataDir: await tempWriteDataDir(),
    now: makeClock()
  }), "INVALID_TASK")

  const fixture = await makeRun()

  await assertRejectsCode(transitionDevelopmentRun(fixture.record.runId, {
    expectedVersion: 0,
    status: "planning_in_progress",
    evidence: Array.from({ length: 9 }, () => ({
      kind: "test",
      sha: BASE_SHA
    }))
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  }), "EVIDENCE_LIMIT_REACHED")

  const paths = runPaths(fixture.writeDataDir, fixture.record.runId)
  const stored = JSON.parse(await readFile(paths.recordPath, "utf8"))

  stored.history = Array.from({ length: MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES + 1 }, () => stored.history[0])
  await writeFile(paths.recordPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 })

  await assertRejectsCode(readDevelopmentRun(fixture.record.runId, {
    writeDataDir: fixture.writeDataDir
  }), "RUN_HISTORY_INVALID")
})

test("evidence supports SHA-pinned implementation, review, test, and deploy metadata", async () => {
  const fixture = await makeRun()
  const evidence = [
    ["implementation", "implementation-agent"],
    ["review", "review-agent"],
    ["test", "node-test"],
    ["deploy", "deploy-plan"]
  ].map(([kind, source], index) => ({
    kind,
    sha: `${String(index + 1).repeat(40)}`,
    source,
    summary: `${kind} metadata recorded`,
    metadata: {
      status: "recorded",
      attempt: index + 1
    }
  }))

  const next = await transitionDevelopmentRun(fixture.record.runId, {
    expectedVersion: 0,
    status: "planning_in_progress",
    actor: "evidence-test",
    evidence
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  })

  for (const kind of ["implementation", "review", "test", "deploy"]) {
    assert.equal(next.evidence[kind].length, 1)
    assert.equal(next.evidence[kind][0].kind, kind)
    assert.match(next.evidence[kind][0].sha, /^[a-f0-9]{40}$/u)
    assert.equal(next.evidence[kind][0].metadata.status, "recorded")
  }

  for (const kind of DEVELOPMENT_RUN_EVIDENCE_KINDS) {
    assert.equal(Array.isArray(next.evidence[kind]), true)
  }
})

test("secrets and raw-error evidence are rejected and never stored", async () => {
  const fixture = await makeRun()

  await assertRejectsCode(transitionDevelopmentRun(fixture.record.runId, {
    expectedVersion: 0,
    status: "planning_in_progress",
    evidence: {
      kind: "test",
      sha: BASE_SHA,
      metadata: {
        rawError: "SENSITIVE_TEST_SENTINEL gho_fake_token"
      }
    }
  }, {
    writeDataDir: fixture.writeDataDir,
    now: fixture.now
  }), "INVALID_EVIDENCE")

  let formatted = ""

  try {
    await transitionDevelopmentRun(fixture.record.runId, {
      expectedVersion: 0,
      status: "planning_in_progress",
      evidence: {
        kind: "test",
        sha: BASE_SHA,
        summary: "SENSITIVE_TEST_SENTINEL gho_fake_token"
      }
    }, {
      writeDataDir: fixture.writeDataDir,
      now: fixture.now
    })
  } catch (error) {
    formatted = formatDevelopmentRunStateError(error)
  }

  assert.match(formatted, /INVALID_EVIDENCE/u)
  assert.doesNotMatch(formatted, /SENSITIVE_TEST_SENTINEL|gho_fake_token/u)

  const serialized = JSON.stringify(await readDevelopmentRun(fixture.record.runId, {
    writeDataDir: fixture.writeDataDir
  }))

  assert.doesNotMatch(serialized, /SENSITIVE_TEST_SENTINEL|gho_fake_token|rawError/u)
})

test("corrupt or malformed canonical records fail safe", async () => {
  const fixture = await makeRun()
  const paths = runPaths(fixture.writeDataDir, fixture.record.runId)

  await writeFile(paths.recordPath, "{not json SENSITIVE_TEST_SENTINEL}\n", { mode: 0o600 })

  let formatted = ""

  try {
    await readDevelopmentRun(fixture.record.runId, {
      writeDataDir: fixture.writeDataDir
    })
  } catch (error) {
    formatted = formatDevelopmentRunStateError(error)
  }

  assert.match(formatted, /RUN_RECORD_INVALID/u)
  assert.doesNotMatch(formatted, /SENSITIVE_TEST_SENTINEL|not json/u)
})

test("Phase 6A adds no command route and Phase 5 local note storage still works", async () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url))
  const commandSource = await readFile(join(repoRoot, "local-operator", "ppo-command.mjs"), "utf8")
  const bridgeSource = await readFile(join(repoRoot, "openclaw", "plugins", "ppo-local", "bridge.mjs"), "utf8")
  const moduleSource = await readFile(new URL("development-run-state.mjs", import.meta.url), "utf8")

  assert.equal(commandSource.includes("development-run-state"), false)
  assert.equal(bridgeSource.includes("development-run-state"), false)

  for (const forbidden of [
    "child_process",
    "execFile",
    "api.github.com",
    "gh api",
    "openai",
    "chatgpt",
    "codex exec",
    "git add",
    "git commit",
    "git push",
    "git merge",
    "git checkout",
    "git reset",
    "workflow_dispatch",
    "systemctl",
    "/ppo continue"
  ]) {
    assert.equal(moduleSource.toLowerCase().includes(forbidden), false, forbidden)
  }

  const writeDataDir = await tempWriteDataDir("ppo-5-regression-")
  const noteResult = await handleProjectNoteAddCommand(
    "khlim-assist",
    ["Phase 5 regression note after Phase 6A."],
    {
      writeDataDir,
      confirmationValue: "add-note:khlim-assist"
    }
  )

  assert.equal(noteResult.ok, true)
  const notes = await readProjectNoteRecords("khlim-assist", { writeDataDir })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].note, "Phase 5 regression note after Phase 6A.")
})
