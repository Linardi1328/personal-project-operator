import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  NOTE_APPROVAL_TTL_MS,
  NOTE_REQUEST_ID_PATTERN,
  cleanupExpiredProjectNoteApprovalRequests,
  claimProjectNoteApprovalRequest,
  handlePpoNoteAddApprovalCommand,
  handlePpoNoteConfirmCommand,
  parsePpoNoteAddRequest,
  parsePpoNoteConfirmRequest,
  stageProjectNoteApprovalRequest
} from "./project-note-approval.mjs"
import {
  NOTE_WRITE_CONFIRM_ENV,
  PROJECT_NOTE_ID_PATTERN,
  createProjectNoteAuditRecorder,
  handleProjectNoteAddCommand,
  prepareProjectNoteIntent,
  readProjectNoteRecords
} from "./project-note-add.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"
import { runPpoLocalTool, toPpoWrapperArgs } from "../openclaw/plugins/ppo-local/bridge.mjs"

const allowedProjectIds = ["khlim-assist", "ledgerpilot-ai", "spy-market-agent", "portfolio", "rbl-content-engine"]
const fixedNow = () => new Date("2026-08-19T02:00:00.000Z")
const afterExpiry = () => new Date(fixedNow().getTime() + NOTE_APPROVAL_TTL_MS + 1)
const validRequestId = "A".repeat(43)
const sensitiveNote = "Phase 5D sensitive note  with  SENSITIVE_TEST_SENTINEL gho_fake_token"
const khlimConfirmation = "add-note:khlim-assist"

function makeAuditRecorder(options = {}) {
  const records = []

  return {
    records,

    async record(entry) {
      if (options.failOnStatus === entry.status) {
        throw new Error("SENSITIVE_TEST_SENTINEL raw audit failure PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist")
      }

      records.push({ ...entry })
    }
  }
}

function requestIdFromOutput(output) {
  const match = output.match(/^Request ID: ([A-Za-z0-9_-]{43})$/mu)
  assert.ok(match, "staged output includes an opaque request id")
  return match[1]
}

function assertSafeChatOutput(output) {
  assert.doesNotMatch(output, /PPO_NOTE_WRITE_CONFIRM|add-note:khlim-assist|gho_fake_token|SENSITIVE_TEST_SENTINEL|raw audit|raw note|raw writer/i)
}

function assertNoNoteContent(output) {
  assert.doesNotMatch(output, /Phase 5D sensitive note|SENSITIVE_TEST_SENTINEL|gho_fake_token/i)
}

function assertAuditMetadataOnly(record) {
  const serialized = JSON.stringify(record)

  assert.doesNotMatch(serialized, /Phase 5D sensitive note|SENSITIVE_TEST_SENTINEL|PPO_NOTE_WRITE_CONFIRM|add-note:|gho_fake_token|raw audit|raw note|requestId|REQUEST_ID/i)
  assert.equal(Object.hasOwn(record, "note"), false)
  assert.equal(Object.hasOwn(record, "confirmationValue"), false)
  assert.equal(Object.hasOwn(record, "requestId"), false)
  assert.equal(Object.hasOwn(record, "token"), false)
  assert.equal(Object.hasOwn(record, "rawFailure"), false)

  if (Object.hasOwn(record, "noteId")) {
    assert.match(record.noteId, PROJECT_NOTE_ID_PATTERN)
  }
}

async function makeTempStore() {
  return mkdtemp(join(tmpdir(), "ppo-note-approval-"))
}

async function withStore(fn) {
  const writeDataDir = await makeTempStore()

  try {
    await fn(writeDataDir)
  } finally {
    await rm(writeDataDir, { recursive: true, force: true })
  }
}

async function listJsonFiles(directory) {
  const names = []

  async function walk(path) {
    let entries

    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const child = join(path, entry.name)

      if (entry.isDirectory()) {
        await walk(child)
      } else if (entry.name.endsWith(".json")) {
        names.push(child)
      }
    }
  }

  await walk(directory)
  return names.sort()
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
  const parsed = parsePpoNoteAddRequest(`${projectId} Allowed project note`)

  assert.equal(parsed.projectId, projectId)
  assert.equal(parsed.note, "Allowed project note")
  assert.equal(parsed.intent.requiredConfirmation, `add-note:${projectId}`)
}

{
  const parsed = parsePpoNoteAddRequest("khlim-assist   Preserve  interior   spacing  ")

  assert.equal(parsed.note, "Preserve  interior   spacing")
}

for (const input of [
  "unknown Allowed note",
  "prooflab Allowed note",
  "jom-jelajah Allowed note",
  "KHLIM-assist Allowed note",
  "Linardi1328/khlim-assist Allowed note",
  "khlim-assist",
  "khlim-assist    ",
  `khlim-assist ${"x".repeat(2001)}`,
  "khlim-assist bad\u001B[31m note",
  "khlim-assist bad\nsecond line",
  "khlim-assist bad\tsecond field",
  "khlim-assist bad\u0000nul"
]) {
  assert.throws(
    () => parsePpoNoteAddRequest(input),
    /ProjectNote(Add|Approval)Error/,
    `${input.slice(0, 32)} rejects before staging`
  )
}

for (const input of [
  `khlim-assist note PPO_NOTE_WRITE_CONFIRM=${khlimConfirmation}`,
  `khlim-assist note ppo_note_write_confirm=${khlimConfirmation}`
]) {
  assert.throws(
    () => parsePpoNoteAddRequest(input),
    /ProjectNoteApprovalError/,
    "chat confirmation values are rejected before staging"
  )
}

for (const input of [
  validRequestId,
  ` ${validRequestId} `
]) {
  assert.equal(parsePpoNoteConfirmRequest(input), validRequestId)
}

for (const input of [
  "",
  "short-id",
  `${validRequestId} extra`,
  "PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist"
]) {
  assert.throws(
    () => parsePpoNoteConfirmRequest(input),
    /ProjectNoteApprovalError/,
    `${input || "(empty)"} rejects as malformed id`
  )
}

await withStore(async (writeDataDir) => {
  let writerCalls = 0
  const result = await handlePpoNoteAddApprovalCommand(
    `khlim-assist ${sensitiveNote}`,
    {
      writeDataDir,
      now: fixedNow,
      writer: async () => {
        writerCalls += 1
        return { ok: true, output: "writer should not run\n" }
      }
    }
  )

  assert.equal(result.ok, true)
  assert.match(result.output, /^Project Note Add Preview/)
  assert.match(result.output, /Project: khlim-assist/)
  assert.match(result.output, /Repo: Linardi1328\/khlim-assist/)
  assert.match(result.output, /Intended change: append one project note after confirmation/)
  assert.match(result.output, /Note: present \([0-9]+ chars\)/)
  assert.match(result.output, /Danger level: dangerous/)
  assert.match(result.output, /^Confirm: \/ppo note-confirm [A-Za-z0-9_-]{43}$/m)
  assertNoNoteContent(result.output)
  assertSafeChatOutput(result.output)
  assert.equal(writerCalls, 0, "staging performs zero writer calls")
  assert.equal((await readProjectNoteRecords("khlim-assist", { writeDataDir })).length, 0)

  const requestId = requestIdFromOutput(result.output)
  const files = await listJsonFiles(writeDataDir)

  assert.equal(files.length, 1)
  assert.equal(files[0].endsWith(`${requestId}.json`), true)
  await assertMode(writeDataDir, 0o700)
  await assertMode(join(writeDataDir, "pending-project-notes"), 0o700)
  await assertMode(join(writeDataDir, "pending-project-notes", "pending"), 0o700)
  await assertMode(join(writeDataDir, "pending-project-notes", "claimed"), 0o700)
  await assertMode(files[0], 0o600)

  const stored = JSON.parse(await readFile(files[0], "utf8"))

  assert.equal(stored.requestId, requestId)
  assert.equal(stored.expiresAt, "2026-08-19T02:10:00.000Z")
  assert.equal(stored.intent.action, "add-note")
  assert.equal(stored.intent.project.id, "khlim-assist")
  assert.equal(stored.intent.project.fullName, "Linardi1328/khlim-assist")
  assert.equal(stored.intent.note, sensitiveNote)
  assert.equal(stored.intent.noteChars, sensitiveNote.length)
  assert.equal(stored.intent.requiredConfirmation, khlimConfirmation)
})

await withStore(async (writeDataDir) => {
  const first = await handlePpoNoteAddApprovalCommand("khlim-assist Same note", {
    writeDataDir,
    now: fixedNow
  })
  const second = await handlePpoNoteAddApprovalCommand("khlim-assist Same note", {
    writeDataDir,
    now: fixedNow
  })
  const firstId = requestIdFromOutput(first.output)
  const secondId = requestIdFromOutput(second.output)

  assert.match(firstId, NOTE_REQUEST_ID_PATTERN)
  assert.match(secondId, NOTE_REQUEST_ID_PATTERN)
  assert.notEqual(firstId, secondId, "approval request ids are random and opaque")
})

await withStore(async (writeDataDir) => {
  const staged = await handlePpoNoteAddApprovalCommand("khlim-assist Expiring note", {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  let writerCalls = 0
  const result = await handlePpoNoteConfirmCommand(requestId, {
    writeDataDir,
    now: afterExpiry,
    writer: async () => {
      writerCalls += 1
      return { ok: true, output: "writer should not run\n" }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[REQUEST_EXPIRED\]/)
  assert.equal(writerCalls, 0)
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "expired request content is deleted")
  assertSafeChatOutput(result.output)
})

await withStore(async (writeDataDir) => {
  const intent = prepareProjectNoteIntent("khlim-assist", "Cleanup note")

  await stageProjectNoteApprovalRequest(intent, {
    writeDataDir,
    now: fixedNow,
    ttlMs: 1
  })
  await cleanupExpiredProjectNoteApprovalRequests({
    writeDataDir,
    now: () => new Date(fixedNow().getTime() + 2)
  })

  assert.deepEqual(await listJsonFiles(writeDataDir), [])
})

await withStore(async (writeDataDir) => {
  let writerCalls = 0
  const result = await handlePpoNoteConfirmCommand(validRequestId, {
    writeDataDir,
    now: fixedNow,
    writer: async () => {
      writerCalls += 1
      return { ok: true, output: "writer should not run\n" }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[REQUEST_NOT_FOUND\]/)
  assert.equal(writerCalls, 0)
  assertSafeChatOutput(result.output)
})

await withStore(async (writeDataDir) => {
  let writerCalls = 0
  const result = await handlePpoNoteConfirmCommand("bad-id", {
    writeDataDir,
    writer: async () => {
      writerCalls += 1
      return { ok: true, output: "writer should not run\n" }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[INVALID_REQUEST_ID\]/)
  assert.equal(writerCalls, 0)
  assertSafeChatOutput(result.output)
})

await withStore(async (writeDataDir) => {
  const staged = await handlePpoNoteAddApprovalCommand(`khlim-assist ${sensitiveNote}`, {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  const confirmed = await handlePpoNoteConfirmCommand(requestId, {
    writeDataDir,
    now: fixedNow
  })
  const replay = await handlePpoNoteConfirmCommand(requestId, {
    writeDataDir,
    now: fixedNow
  })
  const notes = await readProjectNoteRecords("khlim-assist", { writeDataDir })
  const auditRecords = await readAuditRecords(writeDataDir)

  assert.equal(confirmed.ok, true)
  assert.match(confirmed.output, /^Project Note Added/)
  assert.match(confirmed.output, /Note ID: [A-Za-z0-9_-]{43}/)
  assert.doesNotMatch(confirmed.output, new RegExp(requestId))
  assert.equal(replay.ok, false)
  assert.match(replay.output, /\[REQUEST_NOT_FOUND\]/)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].note, sensitiveNote)
  assert.match(notes[0].noteId, PROJECT_NOTE_ID_PATTERN)
  assert.deepEqual(auditRecords.map((record) => record.status), ["attempted", "succeeded"])
  assert.equal(auditRecords[0].noteId, notes[0].noteId)
  assert.equal(auditRecords[1].noteId, notes[0].noteId)
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "confirmed request content is consumed")
  assertNoNoteContent(confirmed.output)
  assertSafeChatOutput(confirmed.output)
  assertSafeChatOutput(replay.output)

  for (const record of auditRecords) {
    assertAuditMetadataOnly(record)
  }
})

await withStore(async (writeDataDir) => {
  const staged = await handlePpoNoteAddApprovalCommand(`khlim-assist ${sensitiveNote}`, {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  const writerCalls = []
  const confirmed = await handlePpoNoteConfirmCommand(requestId, {
    confirmationValue: "PPO_NOTE_WRITE_CONFIRM=add-note:wrong",
    writeDataDir,
    now: fixedNow,
    writer: async (intent, writerOptions) => {
      writerCalls.push({
        project: intent.project.id,
        note: intent.note,
        confirmationValue: writerOptions.confirmationValue
      })

      return {
        ok: true,
        output: "Project Note Added\n"
      }
    }
  })

  assert.equal(confirmed.ok, true)
  assert.deepEqual(writerCalls, [{
    project: "khlim-assist",
    note: sensitiveNote,
    confirmationValue: khlimConfirmation
  }])
  assertSafeChatOutput(confirmed.output)
  assertNoNoteContent(confirmed.output)
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "confirmed request is consumed after injected writer")
})

await withStore(async (writeDataDir) => {
  const staged = await handlePpoNoteAddApprovalCommand("khlim-assist Concurrent note", {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  const confirmations = await Promise.all(Array.from({ length: 12 }, () => handlePpoNoteConfirmCommand(requestId, {
    writeDataDir,
    now: fixedNow
  })))
  const notes = await readProjectNoteRecords("khlim-assist", { writeDataDir })

  assert.equal(confirmations.filter((result) => result.ok).length, 1)
  assert.equal(confirmations.filter((result) => !result.ok).length, 11)
  assert.equal(notes.length, 1, "concurrent confirmations append exactly one note")
  assert.equal(notes[0].note, "Concurrent note")

  for (const result of confirmations) {
    assertSafeChatOutput(result.output)
  }
})

await withStore(async (writeDataDir) => {
  const staged = await handlePpoNoteAddApprovalCommand(`khlim-assist ${sensitiveNote}`, {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  let storeCalls = 0
  const rawFailure = new Error("SENSITIVE_TEST_SENTINEL raw note failure gho_fake_token")
  rawFailure.code = "EACCES"
  const result = await handlePpoNoteConfirmCommand(requestId, {
    writeDataDir,
    now: fixedNow,
    store: {
      async append() {
        storeCalls += 1
        throw rawFailure
      }
    }
  })
  const replay = await handlePpoNoteConfirmCommand(requestId, {
    writeDataDir,
    now: fixedNow,
    store: {
      async append() {
        storeCalls += 1
        return { noteId: "B".repeat(43), notePath: "unused" }
      }
    }
  })
  const auditRecords = await readAuditRecords(writeDataDir)

  assert.equal(result.ok, false)
  assert.match(result.output, /\[NOTE_STORE_UNAVAILABLE\]/)
  assert.equal(replay.ok, false)
  assert.match(replay.output, /\[REQUEST_NOT_FOUND\]/)
  assert.equal(storeCalls, 1, "request is consumed before failed writer can be retried")
  assert.equal((await readProjectNoteRecords("khlim-assist", { writeDataDir })).length, 0)
  assert.deepEqual(auditRecords.map((record) => record.status), ["attempted", "failed"])
  assert.match(auditRecords[0].noteId, PROJECT_NOTE_ID_PATTERN)
  assert.equal(auditRecords[1].noteId, auditRecords[0].noteId)
  assertSafeChatOutput(result.output)
  assertNoNoteContent(result.output)

  for (const record of auditRecords) {
    assertAuditMetadataOnly(record)
  }
})

await withStore(async (writeDataDir) => {
  const auditRecorder = makeAuditRecorder({ failOnStatus: "attempted" })
  const staged = await handlePpoNoteAddApprovalCommand("khlim-assist Attempted audit fail note", {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  let storeCalls = 0
  const result = await handlePpoNoteConfirmCommand(requestId, {
    auditRecorder,
    writeDataDir,
    now: fixedNow,
    store: {
      async append() {
        storeCalls += 1
        return { noteId: "B".repeat(43), notePath: "unused" }
      }
    }
  })
  const replay = await handlePpoNoteConfirmCommand(requestId, {
    auditRecorder: makeAuditRecorder(),
    writeDataDir,
    now: fixedNow,
    store: {
      async append() {
        storeCalls += 1
        return { noteId: "C".repeat(43), notePath: "unused" }
      }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[AUDIT_UNAVAILABLE\]/)
  assert.match(result.output, /no project note write was attempted/)
  assert.equal(replay.ok, false)
  assert.match(replay.output, /\[REQUEST_NOT_FOUND\]/)
  assert.equal(storeCalls, 0, "attempted-audit failure closes before note mutation and still consumes the request")
  assert.equal((await readProjectNoteRecords("khlim-assist", { writeDataDir })).length, 0)
  assertSafeChatOutput(result.output)
})

await withStore(async (writeDataDir) => {
  const auditRecorder = makeAuditRecorder({ failOnStatus: "succeeded" })
  const staged = await handlePpoNoteAddApprovalCommand(`khlim-assist ${sensitiveNote}`, {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  const result = await handlePpoNoteConfirmCommand(requestId, {
    auditRecorder,
    writeDataDir,
    now: fixedNow
  })
  const replay = await handlePpoNoteConfirmCommand(requestId, {
    auditRecorder: makeAuditRecorder(),
    writeDataDir,
    now: fixedNow
  })
  const notes = await readProjectNoteRecords("khlim-assist", { writeDataDir })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[AUDIT_UNAVAILABLE\]/)
  assert.match(result.output, /may have been written/)
  assert.match(result.output, /Inspect the note store and audit trail before retrying/)
  assert.equal(replay.ok, false)
  assert.match(replay.output, /\[REQUEST_NOT_FOUND\]/)
  assert.equal(notes.length, 1, "success-audit failure warns after exactly one append")
  assert.equal(notes[0].note, sensitiveNote)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["attempted"])
  assert.equal(auditRecorder.records[0].noteId, notes[0].noteId)
  assertSafeChatOutput(result.output)
  assertNoNoteContent(result.output)
  assertAuditMetadataOnly(auditRecorder.records[0])
})

await withStore(async (writeDataDir) => {
  const result = await handlePpoNoteAddApprovalCommand(
    `khlim-assist ${sensitiveNote} PPO_NOTE_WRITE_CONFIRM=${khlimConfirmation}`,
    {
      writeDataDir,
      now: fixedNow
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /\[CHAT_CONFIRMATION_REJECTED\]/)
  assertSafeChatOutput(result.output)
  assertNoNoteContent(result.output)
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "rejected chat confirmation does not stage content")
  assert.equal((await readProjectNoteRecords("khlim-assist", { writeDataDir })).length, 0)
})

await withStore(async (writeDataDir) => {
  const refused = await handleProjectNoteAddCommand("khlim-assist", sensitiveNote, {
    confirmationValue: "",
    now: fixedNow,
    writeDataDir
  })
  const auditRecords = await readAuditRecords(writeDataDir)

  assert.equal(refused.ok, false)
  assert.equal(auditRecords.length, 1)
  assert.equal(auditRecords[0].status, "refused")
  assert.equal(Object.hasOwn(auditRecords[0], "noteId"), false)
  assertAuditMetadataOnly(auditRecords[0])
})

await withStore(async (writeDataDir) => {
  const recorder = createProjectNoteAuditRecorder({ writeDataDir })

  assert.equal(recorder.auditPath, join(writeDataDir, "audit", "project-note-audit.ndjson"))
})

await withStore(async (writeDataDir) => {
  const intent = prepareProjectNoteIntent("khlim-assist", "Manual claim note")
  const record = await stageProjectNoteApprovalRequest(intent, {
    writeDataDir,
    now: fixedNow
  })
  const claimed = await claimProjectNoteApprovalRequest(record.requestId, {
    writeDataDir,
    now: fixedNow
  })

  assert.equal(claimed.requestId, record.requestId)
  assert.equal(claimed.intent.note, "Manual claim note")
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "claim deletes request content before any writer runs")
})

assert.deepEqual(
  toPpoWrapperArgs("note-add khlim-assist Bridge note text"),
  ["/ppo", "note-add", "khlim-assist", "Bridge note text"]
)
assert.deepEqual(
  toPpoWrapperArgs("/ppo note-add khlim-assist Bridge note text"),
  ["/ppo", "note-add", "khlim-assist", "Bridge note text"]
)
assert.deepEqual(
  toPpoWrapperArgs(`note-confirm ${validRequestId}`),
  ["/ppo", "note-confirm", validRequestId]
)
assert.deepEqual(
  toPpoWrapperArgs(`/ppo note-confirm ${validRequestId}`),
  ["/ppo", "note-confirm", validRequestId]
)

for (const input of [
  "note-add unknown Title",
  "note-add khlim-assist",
  "note-add khlim-assist PPO_NOTE_WRITE_CONFIRM=add-note:khlim-assist SENSITIVE_TEST_SENTINEL",
  "note-confirm bad-id",
  `note-confirm ${validRequestId} extra`
]) {
  assert.equal(toPpoWrapperArgs(input), null, `${input} rejected before wrapper execution`)

  const result = await runPpoLocalTool(
    { command: input },
    {
      runWrapper: async () => {
        throw new Error("wrapper must not run")
      }
    }
  )

  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.wrapperArgs, [])
  assert.match(result.stdout, /^Unsupported PPO tool input:/)
  assertSafeChatOutput(result.stdout)
  assertNoNoteContent(result.stdout)
}

{
  const result = await runPpoLocalTool(
    { command: "/ppo note-add khlim-assist Bridge note text" },
    {
      runWrapper: async (wrapperArgs) => {
        assert.deepEqual(wrapperArgs, ["/ppo", "note-add", "khlim-assist", "Bridge note text"])
        return {
          stdout: "fake note staging wrapper\n",
          stderr: ""
        }
      }
    }
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.wrapperArgs, ["/ppo", "note-add", "khlim-assist", "Bridge note text"])
  assert.equal(result.stdout, "fake note staging wrapper\n")
}

{
  const result = await runPpoLocalTool(
    { command: `/ppo note-confirm ${validRequestId}` },
    {
      runWrapper: async (wrapperArgs) => {
        assert.deepEqual(wrapperArgs, ["/ppo", "note-confirm", validRequestId])
        return {
          stdout: "fake note confirmation wrapper\n",
          stderr: ""
        }
      }
    }
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.wrapperArgs, ["/ppo", "note-confirm", validRequestId])
  assert.equal(result.stdout, "fake note confirmation wrapper\n")
}

await withStore(async (writeDataDir) => {
  const staged = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "/ppo note-add khlim-assist CLI staged note SENSITIVE_TEST_SENTINEL gho_fake_token"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir,
      [NOTE_WRITE_CONFIRM_ENV]: khlimConfirmation
    }
  })

  assert.equal(staged.status, 0)
  assert.match(staged.stdout, /^Project Note Add Preview/)
  assert.match(staged.stdout, /^Confirm: \/ppo note-confirm [A-Za-z0-9_-]{43}$/m)
  assert.equal(staged.stderr, "")
  assertNoNoteContent(staged.stdout)
  assertSafeChatOutput(staged.stdout)
  assert.equal((await readProjectNoteRecords("khlim-assist", { writeDataDir })).length, 0)

  const requestId = requestIdFromOutput(staged.stdout)
  const confirmed = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    `/ppo note-confirm ${requestId}`
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir,
      [NOTE_WRITE_CONFIRM_ENV]: ""
    }
  })

  assert.equal(confirmed.status, 0)
  assert.match(confirmed.stdout, /^Project Note Added/)
  assert.doesNotMatch(confirmed.stdout, new RegExp(requestId))
  assert.equal(confirmed.stderr, "")

  const notes = await readProjectNoteRecords("khlim-assist", { writeDataDir })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].note, "CLI staged note SENSITIVE_TEST_SENTINEL gho_fake_token")
})

await withStore(async (writeDataDir) => {
  const confirmed = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "note-add",
    "khlim-assist",
    "terminal confirmed note"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir,
      [NOTE_WRITE_CONFIRM_ENV]: khlimConfirmation
    }
  })
  const unsupported = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "note-confirm",
    validRequestId
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir
    }
  })
  const notes = await readProjectNoteRecords("khlim-assist", { writeDataDir })

  assert.equal(confirmed.status, 0)
  assert.match(confirmed.stdout, /^Project Note Added/)
  assert.equal(unsupported.status, 1)
  assert.match(unsupported.stdout, /^Unsupported PPO command: note-confirm/)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].note, "terminal confirmed note")
})

console.log("Project note approval tests passed: /ppo staging, TTL, single-use confirmation, audit metadata, ppo_local routing, and Phase 5C terminal regression.")
