import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MAX_PROJECT_NOTE_CHARS,
  NOTE_WRITE_CONFIRM_ENV,
  PROJECT_NOTE_ACTION,
  PROJECT_NOTE_ID_PATTERN,
  buildProjectNoteAuditRecord,
  createProjectNoteAuditRecorder,
  handleProjectNoteAddCommand,
  prepareProjectNoteIntent,
  readProjectNoteRecords
} from "./project-note-add.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"
import { runPpoLocalTool, toPpoWrapperArgs } from "../openclaw/plugins/ppo-local/bridge.mjs"

const allowedProjectIds = ["khlim-assist", "ledgerpilot-ai", "spy-market-agent", "portfolio", "rbl-content-engine"]
const fixedNow = () => new Date("2026-08-19T01:02:03.000Z")
const khlimConfirmation = "add-note:khlim-assist"
const sensitiveNote = "Phase 5C note with SENSITIVE_TEST_SENTINEL gho_fake_token"

function makeAuditRecorder(options = {}) {
  const records = []

  return {
    records,

    async record(entry) {
      if (options.failAlways || options.failOnStatus === entry.status) {
        throw new Error("SENSITIVE_TEST_SENTINEL raw audit failure PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist")
      }

      records.push({ ...entry })
    }
  }
}

function makeCountingStore(options = {}) {
  const calls = []

  return {
    calls,

    async append(intent, now) {
      calls.push({ intent, now })

      if (options.fail) {
        throw options.fail
      }

      return {
        noteId: "A".repeat(43),
        notePath: intent.notePath
      }
    }
  }
}

function assertSafeErrorOutput(output) {
  assert.doesNotMatch(output, /SENSITIVE_TEST_SENTINEL|raw audit|raw note|gho_|token|PPO_NOTE_WRITE_CONFIRM=/i)
}

function assertNoNoteContent(output) {
  assert.doesNotMatch(output, /SENSITIVE_TEST_SENTINEL|gho_fake_token|Phase 5C note with/i)
}

function assertAuditMetadataOnly(record) {
  const serialized = JSON.stringify(record)

  assert.doesNotMatch(serialized, /SENSITIVE_TEST_SENTINEL|PPO_NOTE_WRITE_CONFIRM|add-note:|gho_|token|raw audit|raw note/i)
  assert.equal(Object.hasOwn(record, "note"), false)
  assert.equal(Object.hasOwn(record, "confirmationValue"), false)
  assert.equal(Object.hasOwn(record, "requestId"), false)
  assert.equal(Object.hasOwn(record, "token"), false)
  assert.equal(Object.hasOwn(record, "rawFailure"), false)
  assert.equal(Object.hasOwn(record, "noteId"), false)
}

async function withStore(fn) {
  const writeDataDir = await mkdtemp(join(tmpdir(), "ppo-project-note-"))

  try {
    await fn(writeDataDir)
  } finally {
    await rm(writeDataDir, { recursive: true, force: true })
  }
}

async function readLines(path) {
  try {
    const content = await readFile(path, "utf8")
    return content.trim() ? content.trim().split("\n") : []
  } catch (error) {
    if (error?.code === "ENOENT") {
      return []
    }

    throw error
  }
}

async function readAuditRecords(writeDataDir) {
  const lines = await readLines(join(writeDataDir, "audit", "project-note-audit.ndjson"))
  return lines.map((line) => JSON.parse(line))
}

async function assertMode(path, expectedMode) {
  const actualMode = (await stat(path)).mode & 0o777
  assert.equal(actualMode, expectedMode, `${path} mode`)
}

assert.deepEqual(listPhase2GitHubProjects().map((project) => project.id), allowedProjectIds)

for (const projectId of allowedProjectIds) {
  const intent = prepareProjectNoteIntent(projectId, "Allowed project note")

  assert.equal(intent.action, PROJECT_NOTE_ACTION)
  assert.equal(intent.project.id, projectId)
  assert.equal(intent.project.fullName, `${intent.project.owner}/${intent.project.repo}`)
  assert.equal(intent.requiredConfirmation, `add-note:${projectId}`)
}

for (const projectId of [
  "unknown",
  "prooflab",
  "jom-jelajah",
  "KHLIM-assist",
  "Linardi1328/khlim-assist",
  "khlim-assist && whoami",
  "khlim-assist; touch /tmp/ppo",
  "../../khlim-assist",
  "$(whoami)",
  "`whoami`",
  "SENSITIVE_TEST_SENTINEL-gho_fake",
  "",
  null
]) {
  const auditRecorder = makeAuditRecorder()
  const store = makeCountingStore()
  const result = await handleProjectNoteAddCommand(projectId, "Unsafe project test", {
    auditRecorder,
    confirmationValue: `add-note:${String(projectId)}`,
    now: fixedNow,
    store
  })

  assert.equal(result.ok, false, `${String(projectId)} is rejected`)
  assert.match(result.output, /^PPO project note error \[/)
  assert.equal(store.calls.length, 0, `${String(projectId)} performs zero note writes`)
  assert.deepEqual(auditRecorder.records, [], `${String(projectId)} performs zero audit records before project resolution`)
  assertSafeErrorOutput(result.output)
}

{
  const auditRecorder = makeAuditRecorder()
  const store = makeCountingStore()
  const result = await handleProjectNoteAddCommand("khlim-assist", sensitiveNote, {
    auditRecorder,
    confirmationValue: "",
    now: fixedNow,
    store
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /^Project Note Add Preview/)
  assert.match(result.output, /Action: add-note/)
  assert.match(result.output, /Project: khlim-assist/)
  assert.match(result.output, /Repo: Linardi1328\/khlim-assist/)
  assert.match(result.output, /Intended change: append one project note/)
  assert.match(result.output, /Note: present \([0-9]+ chars\)/)
  assert.match(result.output, /Danger level: dangerous/)
  assert.match(result.output, /Refused: confirmation missing; no project note write was attempted\./)
  assert.match(result.output, /Required confirmation: PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist/)
  assert.match(result.output, /Audit: refusal recorded/)
  assert.equal(store.calls.length, 0)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["refused"])
  assert.equal(auditRecorder.records[0].reason, "confirmation_missing")
  assert.equal(auditRecorder.records[0].noteChars, sensitiveNote.length)
  assertNoNoteContent(result.output)
  assertAuditMetadataOnly(auditRecorder.records[0])
}

{
  const auditRecorder = makeAuditRecorder()
  const store = makeCountingStore()
  const result = await handleProjectNoteAddCommand("khlim-assist", "Mismatch note", {
    auditRecorder,
    confirmationValue: "add-note:ledgerpilot-ai",
    now: fixedNow,
    store
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /Refused: confirmation mismatch; no project note write was attempted\./)
  assert.match(result.output, /Required confirmation: PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist/)
  assert.doesNotMatch(result.output, /add-note:ledgerpilot-ai/)
  assert.equal(store.calls.length, 0)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["refused"])
  assert.equal(auditRecorder.records[0].reason, "confirmation_mismatch")
  assertAuditMetadataOnly(auditRecorder.records[0])
}

await withStore(async (writeDataDir) => {
  const auditRecorder = makeAuditRecorder()
  const result = await handleProjectNoteAddCommand("khlim-assist", ["Durable", "note"], {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writeDataDir
  })

  assert.equal(result.ok, true)
  assert.match(result.output, /^Project Note Added/)
  assert.match(result.output, /Note ID: [A-Za-z0-9_-]{43}/)
  assert.match(result.output, /Store: .*project-notes\/khlim-assist\.ndjson/)
  assert.match(result.output, /Audit: recorded/)
  assertNoNoteContent(result.output)

  const records = await readProjectNoteRecords("khlim-assist", { writeDataDir })
  assert.equal(records.length, 1)
  assert.match(records[0].noteId, PROJECT_NOTE_ID_PATTERN)
  assert.equal(records[0].timestamp, "2026-08-19T01:02:03.000Z")
  assert.equal(records[0].action, PROJECT_NOTE_ACTION)
  assert.equal(records[0].project, "khlim-assist")
  assert.equal(records[0].projectName, "KHLIM Assist")
  assert.equal(records[0].repo, "Linardi1328/khlim-assist")
  assert.equal(records[0].note, "Durable note")
  assert.deepEqual(Object.keys(records[0]).sort(), [
    "action",
    "note",
    "noteId",
    "project",
    "projectName",
    "repo",
    "schemaVersion",
    "timestamp"
  ].sort())

  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["attempted", "succeeded"])
  assert.equal(auditRecorder.records[0].reason, "confirmed")
  for (const record of auditRecorder.records) {
    assertAuditMetadataOnly(record)
  }
})

await withStore(async (writeDataDir) => {
  const result = await handleProjectNoteAddCommand("khlim-assist", "Private mode note", {
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writeDataDir
  })

  assert.equal(result.ok, true)
  await assertMode(writeDataDir, 0o700)
  await assertMode(join(writeDataDir, "project-notes"), 0o700)
  await assertMode(join(writeDataDir, "audit"), 0o700)
  await assertMode(join(writeDataDir, "project-notes", "khlim-assist.ndjson"), 0o600)
  await assertMode(join(writeDataDir, "audit", "project-note-audit.ndjson"), 0o600)

  const auditRecords = await readAuditRecords(writeDataDir)
  assert.deepEqual(auditRecords.map((record) => record.status), ["attempted", "succeeded"])
  for (const record of auditRecords) {
    assertAuditMetadataOnly(record)
  }
})

await withStore(async (writeDataDir) => {
  await chmod(writeDataDir, 0o755)
  const result = await handleProjectNoteAddCommand("khlim-assist", "Mode repair note", {
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writeDataDir
  })

  assert.equal(result.ok, true)
  await assertMode(writeDataDir, 0o700)
})

await withStore(async (writeDataDir) => {
  const first = await handleProjectNoteAddCommand("khlim-assist", "First append-only note", {
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writeDataDir
  })
  const notePath = join(writeDataDir, "project-notes", "khlim-assist.ndjson")
  const firstRaw = await readFile(notePath, "utf8")
  const second = await handleProjectNoteAddCommand("khlim-assist", "Second append-only note", {
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writeDataDir
  })
  const secondRaw = await readFile(notePath, "utf8")
  const records = secondRaw.trim().split("\n").map((line) => JSON.parse(line))

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(secondRaw.startsWith(firstRaw), true, "second write appends after the first line")
  assert.equal(records.length, 2)
  assert.equal(records[0].note, "First append-only note")
  assert.equal(records[1].note, "Second append-only note")
  assert.notEqual(records[0].noteId, records[1].noteId, "note ids are unique and opaque")
  assert.match(records[0].noteId, PROJECT_NOTE_ID_PATTERN)
  assert.match(records[1].noteId, PROJECT_NOTE_ID_PATTERN)
})

for (const [noteInput, expectedCode] of [
  [undefined, "INVALID_NOTE"],
  ["", "INVALID_NOTE"],
  ["   ", "INVALID_NOTE"],
  ["x".repeat(MAX_PROJECT_NOTE_CHARS + 1), "NOTE_TOO_LARGE"],
  ["bad\u001B[31m note", "UNSAFE_INPUT"],
  ["bad\nsecond line", "UNSAFE_INPUT"],
  ["bad\tsecond field", "UNSAFE_INPUT"],
  ["bad\u0000nul", "UNSAFE_INPUT"]
]) {
  const auditRecorder = makeAuditRecorder()
  const store = makeCountingStore()
  const result = await handleProjectNoteAddCommand("khlim-assist", noteInput, {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    store
  })

  assert.equal(result.ok, false, `${expectedCode} rejects input`)
  assert.match(result.output, new RegExp(`\\[${expectedCode}\\]`))
  assert.equal(store.calls.length, 0, `${expectedCode} performs zero note writes`)
  assert.deepEqual(auditRecorder.records, [], `${expectedCode} performs zero audit records before validation succeeds`)
  assertSafeErrorOutput(result.output)
}

await withStore(async (writeDataDir) => {
  const result = await handleProjectNoteAddCommand("khlim-assist", "x".repeat(MAX_PROJECT_NOTE_CHARS), {
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writeDataDir
  })

  assert.equal(result.ok, true, "exact note character limit is accepted")
  const records = await readProjectNoteRecords("khlim-assist", { writeDataDir })
  assert.equal(records[0].note.length, MAX_PROJECT_NOTE_CHARS)
})

{
  const auditRecord = buildProjectNoteAuditRecord(
    prepareProjectNoteIntent("khlim-assist", sensitiveNote),
    "attempted",
    { reason: "confirmed", code: "SENSITIVE_TEST_SENTINEL raw note failure", noteId: "B".repeat(43) },
    fixedNow()
  )

  assert.equal(auditRecord.timestamp, "2026-08-19T01:02:03.000Z")
  assert.equal(auditRecord.action, PROJECT_NOTE_ACTION)
  assert.equal(auditRecord.project, "khlim-assist")
  assert.equal(auditRecord.repo, "Linardi1328/khlim-assist")
  assert.equal(auditRecord.status, "attempted")
  assert.equal(auditRecord.reason, "confirmed")
  assert.equal(auditRecord.code, "UNCLASSIFIED_FAILURE")
  assert.equal(auditRecord.noteChars, sensitiveNote.length)
  assert.equal(Object.hasOwn(auditRecord, "noteId"), false)
  assertAuditMetadataOnly(auditRecord)
}

{
  const auditRecorder = makeAuditRecorder()
  const rawFailure = new Error("SENSITIVE_TEST_SENTINEL raw note write failure gho_fake_token")
  rawFailure.code = "EACCES"
  const store = makeCountingStore({ fail: rawFailure })
  const result = await handleProjectNoteAddCommand("khlim-assist", sensitiveNote, {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    store
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[NOTE_STORE_UNAVAILABLE\]/)
  assert.equal(store.calls.length, 1)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["attempted", "failed"])
  assert.equal(auditRecorder.records[1].code, "NOTE_STORE_UNAVAILABLE")
  assertSafeErrorOutput(result.output)
  for (const record of auditRecorder.records) {
    assertAuditMetadataOnly(record)
  }
}

{
  const auditRecorder = makeAuditRecorder({ failOnStatus: "attempted" })
  const store = makeCountingStore()
  const result = await handleProjectNoteAddCommand("khlim-assist", "Audit fail closed note", {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    store
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[AUDIT_UNAVAILABLE\]/)
  assert.match(result.output, /no project note write was attempted/)
  assert.equal(store.calls.length, 0)
  assertSafeErrorOutput(result.output)
}

await withStore(async (writeDataDir) => {
  const auditRecorder = makeAuditRecorder({ failOnStatus: "succeeded" })
  const result = await handleProjectNoteAddCommand("khlim-assist", sensitiveNote, {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writeDataDir
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[AUDIT_UNAVAILABLE\]/)
  assert.match(result.output, /may have been written/)
  assert.match(result.output, /Inspect the note store and audit trail before retrying/)
  assertSafeErrorOutput(result.output)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["attempted"])

  const records = await readProjectNoteRecords("khlim-assist", { writeDataDir })
  assert.equal(records.length, 1, "success-audit failure warns after exactly one append")
  assert.equal(records[0].note, sensitiveNote)
})

await withStore(async (writeDataDir) => {
  const auditPath = join(writeDataDir, "custom-audit", "project-note-audit.ndjson")
  const recorder = createProjectNoteAuditRecorder({ auditPath, writeDataDir })
  const intent = prepareProjectNoteIntent("khlim-assist", sensitiveNote)

  await recorder.record(buildProjectNoteAuditRecord(intent, "refused", { reason: "confirmation_missing" }, fixedNow()))
  const auditRecords = (await readLines(auditPath)).map((line) => JSON.parse(line))

  assert.equal(auditRecords.length, 1)
  assert.equal(auditRecords[0].status, "refused")
  assertAuditMetadataOnly(auditRecords[0])
  await assertMode(writeDataDir, 0o700)
  await assertMode(join(writeDataDir, "custom-audit"), 0o700)
  await assertMode(auditPath, 0o600)
})

await withStore(async (writeDataDir) => {
  const result = await handleProjectNoteAddCommand("khlim-assist", sensitiveNote, {
    confirmationValue: "",
    now: fixedNow,
    writeDataDir
  })

  assert.equal(result.ok, false)
  assertNoNoteContent(result.output)
  assert.equal((await readProjectNoteRecords("khlim-assist", { writeDataDir })).length, 0)

  const auditRecords = await readAuditRecords(writeDataDir)
  assert.equal(auditRecords.length, 1)
  assert.equal(auditRecords[0].status, "refused")
  assertAuditMetadataOnly(auditRecords[0])
})

assert.equal(toPpoWrapperArgs("note-add khlim-assist terminal note"), null)
assert.equal(toPpoWrapperArgs("/ppo note-add khlim-assist terminal note"), null)

for (const input of [
  "note-add khlim-assist terminal note",
  "/ppo note-add khlim-assist terminal note"
]) {
  let wrapperCalls = 0
  const result = await runPpoLocalTool(
    { command: input },
    {
      runWrapper: async () => {
        wrapperCalls += 1
        return { stdout: "", stderr: "" }
      }
    }
  )

  assert.equal(result.ok, false, `${input} fails safely through ppo_local`)
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.wrapperArgs, [])
  assert.equal(wrapperCalls, 0, `${input} executes zero wrapper calls`)
  assert.match(result.stdout, /^Unsupported PPO tool input:/)
  assert.doesNotMatch(result.stdout, /PPO_NOTE_WRITE_CONFIRM|SENSITIVE_TEST_SENTINEL|add-note:khlim-assist/)
}

await withStore(async (writeDataDir) => {
  const refused = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "note-add",
    "khlim-assist",
    sensitiveNote
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir,
      [NOTE_WRITE_CONFIRM_ENV]: ""
    }
  })

  assert.equal(refused.status, 1)
  assert.match(refused.stdout, /^Project Note Add Preview/)
  assert.match(refused.stdout, /Required confirmation: PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist/)
  assertNoNoteContent(refused.stdout)
  assert.equal(refused.stderr, "")
  assert.equal((await readProjectNoteRecords("khlim-assist", { writeDataDir })).length, 0)

  const confirmed = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "note-add khlim-assist",
    "terminal confirmed note"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir,
      [NOTE_WRITE_CONFIRM_ENV]: khlimConfirmation
    }
  })

  assert.equal(confirmed.status, 0)
  assert.match(confirmed.stdout, /^Project Note Added/)
  assert.match(confirmed.stdout, /Note ID: [A-Za-z0-9_-]{43}/)
  assert.equal(confirmed.stderr, "")

  const records = await readProjectNoteRecords("khlim-assist", { writeDataDir })
  assert.equal(records.length, 1)
  assert.equal(records[0].note, "terminal confirmed note")
})

await withStore(async (writeDataDir) => {
  const result = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "/ppo note-add khlim-assist should remain unsupported"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir,
      [NOTE_WRITE_CONFIRM_ENV]: khlimConfirmation
    }
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /^Unsupported PPO command: note-add/)
  assert.equal(result.stderr, "")
  assert.equal((await readProjectNoteRecords("khlim-assist", { writeDataDir })).length, 0)
  assert.equal((await readAuditRecords(writeDataDir)).length, 0)
})

console.log("Project note add tests passed: allowlist, terminal confirmation, append-only notes, metadata audit, safe failures, and /ppo rejection.")
