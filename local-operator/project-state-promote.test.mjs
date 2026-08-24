import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"
import {
  PROJECT_STATE_FIELDS,
  atomicDurableProjectStateReplace,
  handleProjectStatePromoteCommand,
  normalizeProjectStateField,
  normalizeProjectStateNoteId,
  replaceProjectStateSection,
  resolveProjectStateProject
} from "./project-state-promote.mjs"
import {
  handleProjectNoteAddCommand,
  readProjectNoteRecords
} from "./project-note-add.mjs"
import {
  handlePpoNoteAddApprovalCommand,
  handlePpoNoteConfirmCommand
} from "./project-note-approval.mjs"

const execFileAsync = promisify(execFile)
const NOTE_ID = "A".repeat(43)
const OTHER_NOTE_ID = "B".repeat(43)
const PROJECT_IDS = [
  "khlim-assist",
  "ledgerpilot-ai",
  "spy-market-agent",
  "portfolio",
  "rbl-content-engine",
  "khlim-digital-ecosystem"
]

function projectDocument(eol = "\n") {
  return [
    "# Fixture Project",
    "",
    "## Project",
    "",
    "Fixture Project",
    "",
    "## Repo",
    "",
    "`Linardi1328/fixture`",
    "",
    "## Connection status",
    "",
    "Connected candidate.",
    "",
    "## Current role",
    "",
    "Fixture role.",
    "",
    "## OpenClaw priority",
    "",
    "High.",
    "",
    "## Current phase",
    "",
    "Old phase.",
    "",
    "## Last known status",
    "",
    "Old status.",
    "",
    "## Next action",
    "",
    "Old next action.",
    "",
    "## Codex fit",
    "",
    "Focused implementation only.",
    "",
    "## Do not change",
    "",
    "- Protected rule one.",
    "- Protected rule two.",
    "",
    "## Known risks",
    "",
    "- Protected risk.",
    ""
  ].join(eol)
}

function noteRecord(projectId, noteId, note) {
  return {
    schemaVersion: 1,
    noteId,
    timestamp: "2026-08-20T00:00:00.000Z",
    action: "add-note",
    project: projectId,
    projectName: projectId,
    repo: `Linardi1328/${projectId}`,
    note
  }
}

async function createFixture({
  projectId = "khlim-assist",
  noteId = NOTE_ID,
  note = "Phase 5E promoted state text.",
  storedProjectId = projectId,
  eol = "\n",
  includeSelectedNote = true
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ppo-5e-"))
  const repoRoot = join(root, "repo")
  const writeDataDir = join(root, "write-data")
  const projectDir = join(repoRoot, "projects")
  const noteDir = join(writeDataDir, "project-notes")
  const projectPath = join(projectDir, `${projectId}.md`)

  await mkdir(projectDir, { recursive: true })
  await mkdir(noteDir, { recursive: true })
  await writeFile(projectPath, projectDocument(eol), "utf8")

  if (includeSelectedNote) {
    await writeFile(
      join(noteDir, `${projectId}.ndjson`),
      `${JSON.stringify(noteRecord(storedProjectId, noteId, note))}\n`,
      "utf8"
    )
  }

  return {
    root,
    repoRoot,
    writeDataDir,
    projectId,
    projectPath,
    noteId,
    note,
    original: Buffer.from(projectDocument(eol), "utf8")
  }
}

function cleanGitRunner({ branch = "phase/test", dirty = false } = {}) {
  return async (args) => {
    if (args[0] === "rev-parse") {
      return { stdout: `${branch}\n`, stderr: "" }
    }

    if (args[0] === "status") {
      return {
        stdout: dirty ? " M projects/khlim-assist.md\n" : "",
        stderr: ""
      }
    }

    throw new Error(`Unexpected git command: ${args.join(" ")}`)
  }
}

function confirmation(fixture, field = "current-phase") {
  return `promote-note:${fixture.projectId}:${fixture.noteId}:${field}`
}

async function readAudit(writeDataDir) {
  const text = await readFile(
    join(writeDataDir, "audit", "project-state-promotion-audit.ndjson"),
    "utf8"
  )

  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

function sectionBytes(buffer, heading) {
  const headingBytes = Buffer.from(`${heading}\n`)
  const start = buffer.indexOf(headingBytes)
  assert.notEqual(start, -1)
  const bodyStart = start + headingBytes.length
  const next = buffer.indexOf(Buffer.from("\n## "), bodyStart)
  const end = next === -1 ? buffer.length : next + 1
  return buffer.subarray(start, end)
}

test("Phase 5E uses the fixed connected-project allowlist", () => {
  assert.deepEqual(
    PROJECT_IDS.map((projectId) => resolveProjectStateProject(projectId).id),
    PROJECT_IDS
  )
  assert.throws(() => resolveProjectStateProject("unknown-project"), /allowlist/u)
})

test("only current-phase, last-known-status, and next-action are allowed", () => {
  assert.deepEqual(Object.keys(PROJECT_STATE_FIELDS), [
    "current-phase",
    "last-known-status",
    "next-action"
  ])

  for (const field of Object.keys(PROJECT_STATE_FIELDS)) {
    assert.equal(normalizeProjectStateField(field).field, field)
  }

  for (const blocked of ["repo", "project", "current-role", "openclaw-priority", "codex-fit", "do-not-change", "known-risks"]) {
    assert.throws(() => normalizeProjectStateField(blocked), /not allowed/u)
  }
})

test("note ids must be exactly the 43-character Phase 5C/5D opaque form", () => {
  assert.equal(normalizeProjectStateNoteId(NOTE_ID), NOTE_ID)
  assert.throws(() => normalizeProjectStateNoteId("A".repeat(42)), /43-character/u)
  assert.throws(() => normalizeProjectStateNoteId(`${"A".repeat(42)}!`), /43-character/u)
})

test("a note id found under another project is refused", async () => {
  const fixture = await createFixture({ includeSelectedNote: false })
  const otherDir = join(fixture.writeDataDir, "project-notes")

  await writeFile(
    join(otherDir, "ledgerpilot-ai.ndjson"),
    `${JSON.stringify(noteRecord("ledgerpilot-ai", fixture.noteId, fixture.note))}\n`,
    "utf8"
  )

  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture),
      gitRunner: cleanGitRunner()
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /NOTE_PROJECT_MISMATCH/u)
  assert.deepEqual(await readFile(fixture.projectPath), fixture.original)
})

test("a selected note record with mismatched project metadata is refused", async () => {
  const fixture = await createFixture({ storedProjectId: "ledgerpilot-ai" })
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture),
      gitRunner: cleanGitRunner()
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /NOTE_PROJECT_MISMATCH/u)
  assert.deepEqual(await readFile(fixture.projectPath), fixture.original)
})

test("missing and mismatched confirmation cause zero project-state mutation", async () => {
  for (const confirmationValue of [undefined, "promote-note:wrong:confirmation"]) {
    const fixture = await createFixture()
    const result = await handleProjectStatePromoteCommand(
      fixture.projectId,
      fixture.noteId,
      "current-phase",
      {
        repoRoot: fixture.repoRoot,
        writeDataDir: fixture.writeDataDir,
        confirmationValue,
        gitRunner: cleanGitRunner()
      }
    )

    assert.equal(result.ok, false)
    assert.deepEqual(await readFile(fixture.projectPath), fixture.original)
  }
})

test("exact confirmation promotes the note text verbatim", async () => {
  const fixture = await createFixture({ note: "Verbatim Phase 5E note text." })
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture),
      gitRunner: cleanGitRunner()
    }
  )

  assert.equal(result.ok, true)
  const after = await readFile(fixture.projectPath, "utf8")
  assert.match(after, /## Current phase\n\nVerbatim Phase 5E note text\.\n\n## Last known status/u)
})

test("main branch is refused with zero target mutation", async () => {
  const fixture = await createFixture()
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture),
      gitRunner: cleanGitRunner({ branch: "main" })
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /MAIN_BRANCH_REFUSED/u)
  assert.deepEqual(await readFile(fixture.projectPath), fixture.original)
})

test("dirty target project file is refused with zero target mutation", async () => {
  const fixture = await createFixture()
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture),
      gitRunner: cleanGitRunner({ dirty: true })
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /DIRTY_TARGET_REFUSED/u)
  assert.deepEqual(await readFile(fixture.projectPath), fixture.original)
})

test("replacement changes exactly one selected Markdown section and preserves all other bytes", () => {
  const original = Buffer.from(projectDocument("\r\n"), "utf8")
  const replacement = replaceProjectStateSection(
    original,
    "## Last known status",
    "Promoted status verbatim."
  )

  assert.equal(replacement.changed, true)
  assert.deepEqual(
    replacement.output.subarray(0, replacement.bodyStart),
    original.subarray(0, replacement.bodyStart)
  )

  const suffixLength = original.length - replacement.bodyEnd
  assert.deepEqual(
    replacement.output.subarray(replacement.output.length - suffixLength),
    original.subarray(replacement.bodyEnd)
  )
  assert.match(replacement.output.toString("utf8"), /## Last known status\r\n\r\nPromoted status verbatim\.\r\n\r\n## Next action/u)
})

test("protected identity, repo, role, priority, Codex fit, Do not change, and Known risks sections remain byte-identical", () => {
  const original = Buffer.from(projectDocument(), "utf8")
  const replacement = replaceProjectStateSection(original, "## Next action", "New next action.")

  for (const heading of [
    "## Project",
    "## Repo",
    "## Current role",
    "## OpenClaw priority",
    "## Codex fit",
    "## Do not change",
    "## Known risks"
  ]) {
    assert.deepEqual(sectionBytes(replacement.output, heading), sectionBytes(original, heading))
  }
})

test("atomic durable replacement uses same-directory rename semantics and leaves no temp file", async () => {
  const fixture = await createFixture()
  const beforeEntries = await readdir(join(fixture.repoRoot, "projects"))
  await atomicDurableProjectStateReplace(fixture.projectPath, Buffer.from("replacement\n", "utf8"))
  const afterEntries = await readdir(join(fixture.repoRoot, "projects"))

  assert.equal(await readFile(fixture.projectPath, "utf8"), "replacement\n")
  assert.deepEqual(afterEntries, beforeEntries)
  assert.equal(afterEntries.some((entry) => entry.includes(".ppo-state-promote.")), false)
})

test("successful promotion records attempted then succeeded audit entries with before/after hashes", async () => {
  const fixture = await createFixture()
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "last-known-status",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture, "last-known-status"),
      gitRunner: cleanGitRunner()
    }
  )

  assert.equal(result.ok, true)
  const records = await readAudit(fixture.writeDataDir)
  assert.deepEqual(records.map((record) => record.status), ["attempted", "succeeded"])

  for (const record of records) {
    assert.match(record.beforeHash, /^[a-f0-9]{64}$/u)
    assert.match(record.afterHash, /^[a-f0-9]{64}$/u)
    assert.equal(record.project, fixture.projectId)
    assert.equal(record.field, "last-known-status")
    assert.equal(record.noteId, fixture.noteId)
  }

  assert.notEqual(records[1].beforeHash, records[1].afterHash)
})

test("definite replacement failure records attempted then failed and keeps target unchanged", async () => {
  const fixture = await createFixture()
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture),
      gitRunner: cleanGitRunner(),
      replaceFile: async () => {
        const error = new Error("raw failure must not reach audit")
        error.code = "EIO"
        throw error
      }
    }
  )

  assert.equal(result.ok, false)
  assert.deepEqual(await readFile(fixture.projectPath), fixture.original)
  const records = await readAudit(fixture.writeDataDir)
  assert.deepEqual(records.map((record) => record.status), ["attempted", "failed"])
  assert.equal(records[1].afterHash, records[1].beforeHash)
})

test("attempted-audit failure closes before project-state mutation", async () => {
  const fixture = await createFixture()
  const seen = []
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture),
      gitRunner: cleanGitRunner(),
      auditRecorder: {
        async record(entry) {
          seen.push(entry)
          if (entry.status === "attempted") {
            throw new Error("audit unavailable")
          }
        }
      }
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /AUDIT_UNAVAILABLE/u)
  assert.deepEqual(await readFile(fixture.projectPath), fixture.original)
  assert.deepEqual(seen.map((entry) => entry.status), ["attempted"])
})

test("success-audit failure returns an ambiguous warning after mutation", async () => {
  const fixture = await createFixture()
  const seen = []
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: confirmation(fixture),
      gitRunner: cleanGitRunner(),
      auditRecorder: {
        async record(entry) {
          seen.push(entry)
          if (entry.status === "succeeded") {
            throw new Error("audit unavailable")
          }
        }
      }
    }
  )

  assert.equal(result.ok, false)
  assert.equal(result.ambiguous, true)
  assert.match(result.output, /SUCCESS_AUDIT_UNAVAILABLE/u)
  assert.notDeepEqual(await readFile(fixture.projectPath), fixture.original)
  assert.deepEqual(seen.map((entry) => entry.status), ["attempted", "succeeded"])
})

test("promotion audit never contains note text, confirmations, tokens, or raw failures", async () => {
  const note = "TOP_SECRET_NOTE_TEXT_5E"
  const fixture = await createFixture({ note })
  const exactConfirmation = confirmation(fixture)
  const result = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    {
      repoRoot: fixture.repoRoot,
      writeDataDir: fixture.writeDataDir,
      confirmationValue: exactConfirmation,
      gitRunner: cleanGitRunner()
    }
  )

  assert.equal(result.ok, true)
  const auditText = await readFile(
    join(fixture.writeDataDir, "audit", "project-state-promotion-audit.ndjson"),
    "utf8"
  )
  assert.equal(auditText.includes(note), false)
  assert.equal(auditText.includes(exactConfirmation), false)
  assert.equal(auditText.includes("PPO_PROJECT_STATE_CONFIRM"), false)
  assert.equal(auditText.includes("raw failure"), false)
  assert.equal(auditText.toLowerCase().includes("token"), false)
})

test("same note cannot be promoted into the same field again after a prior succeeded audit", async () => {
  const fixture = await createFixture()
  const options = {
    repoRoot: fixture.repoRoot,
    writeDataDir: fixture.writeDataDir,
    confirmationValue: confirmation(fixture),
    gitRunner: cleanGitRunner()
  }
  const first = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    options
  )

  assert.equal(first.ok, true)
  await writeFile(fixture.projectPath, fixture.original)

  const second = await handleProjectStatePromoteCommand(
    fixture.projectId,
    fixture.noteId,
    "current-phase",
    options
  )

  assert.equal(second.ok, false)
  assert.match(second.output, /DUPLICATE_PROMOTION/u)
  assert.deepEqual(await readFile(fixture.projectPath), fixture.original)
})

test("all connected projects can use the same controlled promotion primitive", async () => {
  for (const projectId of PROJECT_IDS) {
    const fixture = await createFixture({
      projectId,
      noteId: OTHER_NOTE_ID,
      note: `Promoted state for ${projectId}.`
    })
    const result = await handleProjectStatePromoteCommand(
      projectId,
      fixture.noteId,
      "next-action",
      {
        repoRoot: fixture.repoRoot,
        writeDataDir: fixture.writeDataDir,
        confirmationValue: confirmation(fixture, "next-action"),
        gitRunner: cleanGitRunner()
      }
    )

    assert.equal(result.ok, true, `${projectId}: ${result.output}`)
  }
})

test("Phase 5C terminal note-add remains functional", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-5c-regression-"))
  const result = await handleProjectNoteAddCommand(
    "khlim-assist",
    ["Phase 5C regression note"],
    {
      writeDataDir: root,
      confirmationValue: "add-note:khlim-assist"
    }
  )

  assert.equal(result.ok, true)
  const records = await readProjectNoteRecords("khlim-assist", { writeDataDir: root })
  assert.equal(records.length, 1)
  assert.equal(records[0].note, "Phase 5C regression note")
})

test("Phase 5D staged /ppo note approval remains functional", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-5d-regression-"))
  const staged = await handlePpoNoteAddApprovalCommand(
    "khlim-assist Phase 5D regression note",
    { writeDataDir: root }
  )

  assert.equal(staged.ok, true)
  const requestId = staged.output.match(/Request ID: ([A-Za-z0-9_-]{43})/u)?.[1]
  assert.ok(requestId)

  const confirmed = await handlePpoNoteConfirmCommand(requestId, { writeDataDir: root })
  assert.equal(confirmed.ok, true)
  const records = await readProjectNoteRecords("khlim-assist", { writeDataDir: root })
  assert.equal(records.length, 1)
  assert.equal(records[0].note, "Phase 5D regression note")
})

test("/ppo state-promote remains unsupported while bare terminal state-promote is reserved for Phase 5E", async () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url))
  const commandPath = fileURLToPath(new URL("ppo-command.mjs", import.meta.url))
  let error

  try {
    await execFileAsync(process.execPath, [commandPath, `/ppo state-promote khlim-assist ${NOTE_ID} current-phase`], {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024
    })
  } catch (caught) {
    error = caught
  }

  assert.ok(error)
  assert.match(String(error.stdout ?? ""), /Unsupported PPO command: state-promote/u)
})

test("Phase 5E module contains no GitHub API, model-call, deployment, or mutating git command path", async () => {
  const source = await readFile(new URL("project-state-promote.mjs", import.meta.url), "utf8")

  for (const forbidden of [
    "api.github.com",
    "openai",
    "chatgpt",
    "codex exec",
    "git add",
    "git commit",
    "git push",
    "git merge",
    "git checkout",
    "git reset",
    "git branch",
    "workflow_dispatch",
    "deploy"
  ]) {
    assert.equal(source.toLowerCase().includes(forbidden), false, forbidden)
  }

  assert.match(source, /"rev-parse"/u)
  assert.match(source, /"status"/u)
})
