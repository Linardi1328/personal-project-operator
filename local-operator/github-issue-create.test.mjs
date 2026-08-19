import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GITHUB_ISSUE_CREATE_ACTION,
  GITHUB_WRITE_CONFIRM_ENV,
  GitHubIssueCreateError,
  MAX_ISSUE_BODY_ARGS,
  MAX_ISSUE_BODY_CHARS,
  MAX_ISSUE_TITLE_CHARS,
  buildGhIssuePostArgs,
  buildGitHubWriteAuditRecord,
  createGhIssuePostRunner,
  createGitHubIssueWriter,
  createGitHubWriteAuditRecorder,
  handleGitHubIssueCreateCommand,
  prepareIssueCreateIntent
} from "./github-issue-create.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"
import { toPpoWrapperArgs } from "../openclaw/plugins/ppo-local/bridge.mjs"

const allowedProjectIds = ["khlim-assist", "ledgerpilot-ai", "spy-market-agent", "portfolio", "rbl-content-engine"]
const fixedNow = () => new Date("2026-08-18T00:00:00.000Z")
const khlimEndpoint = "/repos/Linardi1328/khlim-assist/issues"
const khlimConfirmation = "create-issue:khlim-assist"

function makeAuditRecorder(options = {}) {
  const records = []

  return {
    records,

    async record(entry) {
      if (options.failOnStatus === entry.status || options.failAlways) {
        throw new Error("SENSITIVE_TEST_SENTINEL audit failure")
      }

      records.push({ ...entry })
    }
  }
}

function assertSafeOutput(output) {
  assert.doesNotMatch(output, /SENSITIVE_TEST_SENTINEL|raw stderr|raw stdout|token|gho_/i)
}

function assertAuditIsCredentialFree(record, forbidden = /SENSITIVE_TEST_SENTINEL|PPO_GITHUB_WRITE_CONFIRM|Add issue|Body text|gho_/i) {
  const serialized = JSON.stringify(record)
  assert.doesNotMatch(serialized, forbidden)
  assert.equal(Object.hasOwn(record, "title"), false)
  assert.equal(Object.hasOwn(record, "body"), false)
  assert.equal(Object.hasOwn(record, "confirmationValue"), false)
}

async function expectIssueCreateError(fn, expectedCode) {
  await assert.rejects(
    fn,
    (error) => {
      assert.equal(error instanceof GitHubIssueCreateError, true)
      assert.equal(error.code, expectedCode)
      assert.equal(error.message, error.safeMessage)
      assertSafeOutput(error.safeMessage)
      return true
    }
  )
}

assert.deepEqual(listPhase2GitHubProjects().map((project) => project.id), allowedProjectIds)

{
  const auditRecorder = makeAuditRecorder()
  let writerCalls = 0
  const result = await handleGitHubIssueCreateCommand(
    "khlim-assist",
    "Add issue",
    ["Body text with SENSITIVE_TEST_SENTINEL gho_fake"],
    {
      auditRecorder,
      confirmationValue: "",
      now: fixedNow,
      writer: async () => {
        writerCalls += 1
        return { number: 99, url: "https://github.com/Linardi1328/khlim-assist/issues/99" }
      }
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /^GitHub Issue Create Preview/)
  assert.match(result.output, /Action: create-issue/)
  assert.match(result.output, /Project: khlim-assist/)
  assert.match(result.output, /Repo: Linardi1328\/khlim-assist/)
  assert.match(result.output, /Endpoint: POST \/repos\/Linardi1328\/khlim-assist\/issues/)
  assert.match(result.output, /Intended change: create one issue with title "Add issue"/)
  assert.match(result.output, /Body: present \([0-9]+ chars\)/)
  assert.match(result.output, /Danger level: dangerous/)
  assert.match(result.output, /Refused: confirmation missing; no GitHub write was attempted\./)
  assert.match(result.output, /Required confirmation: PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist/)
  assert.match(result.output, /Audit: refusal recorded/)
  assert.equal(writerCalls, 0)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["refused"])
  assert.equal(auditRecorder.records[0].reason, "confirmation_missing")
  assert.equal(auditRecorder.records[0].titleChars, "Add issue".length)
  assert.equal(auditRecorder.records[0].bodyPresent, true)
  assertAuditIsCredentialFree(auditRecorder.records[0])
}

{
  const auditRecorder = makeAuditRecorder()
  let writerCalls = 0
  const result = await handleGitHubIssueCreateCommand(
    "khlim-assist",
    "Mismatch confirmation test",
    [],
    {
      auditRecorder,
      confirmationValue: "create-issue:ledgerpilot-ai",
      now: fixedNow,
      writer: async () => {
        writerCalls += 1
        return { number: 99 }
      }
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /Refused: confirmation mismatch; no GitHub write was attempted\./)
  assert.match(result.output, /Required confirmation: PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist/)
  assert.doesNotMatch(result.output, /create-issue:ledgerpilot-ai/)
  assert.equal(writerCalls, 0)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["refused"])
  assert.equal(auditRecorder.records[0].reason, "confirmation_mismatch")
}

{
  const auditRecorder = makeAuditRecorder()
  const writerCalls = []
  const result = await handleGitHubIssueCreateCommand(
    "khlim-assist",
    "Create mocked issue",
    ["Body", "text"],
    {
      auditRecorder,
      confirmationValue: khlimConfirmation,
      now: fixedNow,
      writer: async (intent) => {
        writerCalls.push({
          action: intent.action,
          method: intent.method,
          endpoint: intent.endpoint,
          project: intent.project.id,
          repo: intent.project.fullName,
          title: intent.title,
          body: intent.body
        })
        return {
          number: 42,
          url: "https://github.com/Linardi1328/khlim-assist/issues/42"
        }
      }
    }
  )

  assert.equal(result.ok, true)
  assert.match(result.output, /^GitHub Issue Created/)
  assert.match(result.output, /Issue: #42/)
  assert.match(result.output, /URL: https:\/\/github.com\/Linardi1328\/khlim-assist\/issues\/42/)
  assert.match(result.output, /Audit: recorded/)
  assert.deepEqual(writerCalls, [
    {
      action: "create-issue",
      method: "POST",
      endpoint: khlimEndpoint,
      project: "khlim-assist",
      repo: "Linardi1328/khlim-assist",
      title: "Create mocked issue",
      body: "Body text"
    }
  ])
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["attempted", "succeeded"])
  assert.equal(auditRecorder.records[0].reason, "confirmed")
  assert.equal(auditRecorder.records[1].issueNumber, 42)
  assert.equal(Object.hasOwn(auditRecorder.records[1], "issueUrl"), false)
  for (const record of auditRecorder.records) {
    assertAuditIsCredentialFree(record, /Create mocked issue|Body text|PPO_GITHUB_WRITE_CONFIRM|gho_/i)
  }
}

for (const projectId of allowedProjectIds) {
  const intent = prepareIssueCreateIntent(projectId, "Allowed project title", [])

  assert.equal(intent.project.id, projectId)
  assert.equal(intent.method, "POST")
  assert.equal(intent.endpoint, `/repos/${intent.project.owner}/${intent.project.repo}/issues`)
  assert.equal(intent.requiredConfirmation, `create-issue:${projectId}`)
}

for (const projectId of [
  "unknown",
  "prooflab",
  "jom-jelajah",
  "KHLIM-assist",
  "Linardi1328/khlim-assist",
  "octocat/Hello-World",
  "khlim-assist && whoami",
  "khlim-assist; touch /tmp/ppo",
  "../../khlim-assist",
  "$(whoami)",
  "`whoami`",
  "",
  null
]) {
  const auditRecorder = makeAuditRecorder()
  let writerCalls = 0
  const result = await handleGitHubIssueCreateCommand(projectId, "Unsafe project test", [], {
    auditRecorder,
    confirmationValue: `create-issue:${projectId}`,
    now: fixedNow,
    writer: async () => {
      writerCalls += 1
      return { number: 1 }
    }
  })

  assert.equal(result.ok, false, `${String(projectId)} is rejected`)
  assert.match(result.output, /^PPO GitHub issue-create error \[/)
  assert.equal(writerCalls, 0, `${String(projectId)} performs zero writer calls`)
  assert.deepEqual(auditRecorder.records, [], `${String(projectId)} performs zero audit records before project resolution`)
  assertSafeOutput(result.output)
}

for (const [title, body, expectedCode] of [
  [undefined, [], "INVALID_TITLE"],
  ["", [], "INVALID_TITLE"],
  ["x".repeat(MAX_ISSUE_TITLE_CHARS + 1), [], "TITLE_TOO_LARGE"],
  ["bad\u001B[31m title", [], "UNSAFE_INPUT"],
  ["bad\nsecond line", [], "UNSAFE_INPUT"],
  ["valid title", ["x".repeat(MAX_ISSUE_BODY_CHARS + 1)], "BODY_TOO_LARGE"],
  ["valid title", ["body\u001B[31m red"], "UNSAFE_INPUT"],
  ["valid title", Array.from({ length: MAX_ISSUE_BODY_ARGS + 1 }, () => "word"), "BODY_TOO_LARGE"]
]) {
  const auditRecorder = makeAuditRecorder()
  let writerCalls = 0
  const result = await handleGitHubIssueCreateCommand("khlim-assist", title, body, {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writer: async () => {
      writerCalls += 1
      return { number: 1 }
    }
  })

  assert.equal(result.ok, false, `${expectedCode} rejects input`)
  assert.match(result.output, new RegExp(`\\[${expectedCode}\\]`))
  assert.equal(writerCalls, 0, `${expectedCode} performs zero writer calls`)
  assert.deepEqual(auditRecorder.records, [], `${expectedCode} performs zero audit records before validation succeeds`)
  assertSafeOutput(result.output)
}

{
  const args = buildGhIssuePostArgs(khlimEndpoint, {
    title: "Add literal @value",
    body: "body=false"
  })

  assert.deepEqual(args, [
    "api",
    "--method",
    "POST",
    khlimEndpoint,
    "--raw-field",
    "title=Add literal @value",
    "--raw-field",
    "body=body=false"
  ])
}

for (const request of [
  { method: "GET", endpoint: khlimEndpoint, fields: { title: "Title", body: "" }, code: "UNSUPPORTED_METHOD" },
  { method: "PATCH", endpoint: khlimEndpoint, fields: { title: "Title", body: "" }, code: "UNSUPPORTED_METHOD" },
  { method: "POST", endpoint: "/repos/octocat/Hello-World/issues", fields: { title: "Title", body: "" }, code: "UNSUPPORTED_ENDPOINT" },
  { method: "POST", endpoint: "/repos/Linardi1328/khlim-assist/pulls", fields: { title: "Title", body: "" }, code: "UNSUPPORTED_ENDPOINT" },
  { method: "POST", endpoint: "/repos/Linardi1328/khlim-assist/issues?labels=bug", fields: { title: "Title", body: "" }, code: "UNSUPPORTED_ENDPOINT" },
  { method: "POST", endpoint: khlimEndpoint, fields: { title: "Title", labels: ["bug"] }, code: "UNSUPPORTED_FIELDS" },
  { method: "POST", endpoint: khlimEndpoint, fields: { title: "Title", body: "", milestone: 1 }, code: "UNSUPPORTED_FIELDS" },
  { method: "POST", endpoint: khlimEndpoint, fields: null, code: "UNSUPPORTED_FIELDS" }
]) {
  const calls = []
  const runner = createGhIssuePostRunner({
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options })
      callback(null, JSON.stringify({ number: 1 }), "")
    }
  })

  await expectIssueCreateError(
    () => runner(request),
    request.code
  )
  assert.equal(calls.length, 0, `${request.code} performs zero execFile calls`)
}

{
  const calls = []
  const runner = createGhIssuePostRunner({
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options })
      callback(null, JSON.stringify({ number: 7 }), "")
    }
  })

  const result = await runner({
    method: "POST",
    endpoint: khlimEndpoint,
    fields: {
      title: "Valid issue",
      body: "Valid body"
    }
  })

  assert.equal(result.stdout, JSON.stringify({ number: 7 }))
  assert.equal(calls[0].file, "gh")
  assert.deepEqual(calls[0].args, [
    "api",
    "--method",
    "POST",
    khlimEndpoint,
    "--raw-field",
    "title=Valid issue",
    "--raw-field",
    "body=Valid body"
  ])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.timeout <= 15000, true)
  assert.equal(calls[0].options.maxBuffer <= 512 * 1024, true)
}

{
  const intent = prepareIssueCreateIntent("khlim-assist", "Writer parse test", ["Body"])
  const writer = createGitHubIssueWriter({
    runner: async (request) => {
      assert.deepEqual(request, {
        method: "POST",
        endpoint: khlimEndpoint,
        fields: {
          title: "Writer parse test",
          body: "Body"
        }
      })

      return {
        stdout: JSON.stringify({
          number: 11,
          title: "Writer parse test",
          html_url: "https://github.com/Linardi1328/khlim-assist/issues/11"
        })
      }
    }
  })

  assert.deepEqual(await writer.createIssue(intent), {
    number: 11,
    title: "Writer parse test",
    url: "https://github.com/Linardi1328/khlim-assist/issues/11"
  })
}

for (const [error, expectedCode] of [
  [Object.assign(new Error("spawn gh ENOENT SENSITIVE_TEST_SENTINEL"), { code: "ENOENT" }), "GITHUB_CLI_UNAVAILABLE"],
  [Object.assign(new Error("HTTP 401: authentication required SENSITIVE_TEST_SENTINEL"), { stderr: "raw stderr SENSITIVE_TEST_SENTINEL" }), "GITHUB_CLI_UNAUTHENTICATED"],
  [Object.assign(new Error("HTTP 403: Forbidden SENSITIVE_TEST_SENTINEL"), { stdout: "raw stdout SENSITIVE_TEST_SENTINEL" }), "GITHUB_REPO_UNAVAILABLE"],
  [Object.assign(new Error("HTTP 500 upstream SENSITIVE_TEST_SENTINEL"), { stderr: "raw stderr SENSITIVE_TEST_SENTINEL" }), "GITHUB_API_FAILED"]
]) {
  const intent = prepareIssueCreateIntent("khlim-assist", "Classify failure", [])
  const writer = createGitHubIssueWriter({
    runner: async () => {
      throw error
    }
  })

  await expectIssueCreateError(
    () => writer.createIssue(intent),
    expectedCode
  )
}

for (const stdout of [
  "{not-json",
  JSON.stringify([]),
  JSON.stringify({ title: "missing number" })
]) {
  const intent = prepareIssueCreateIntent("khlim-assist", "Malformed response", [])
  const writer = createGitHubIssueWriter({
    runner: async () => ({ stdout })
  })

  await expectIssueCreateError(
    () => writer.createIssue(intent),
    "MALFORMED_GITHUB_RESPONSE"
  )
}

{
  const tempDir = await mkdtemp(join(tmpdir(), "ppo-github-audit-"))
  const auditPath = join(tempDir, "github-write-audit.ndjson")
  const recorder = createGitHubWriteAuditRecorder({ auditPath })
  const intent = prepareIssueCreateIntent("khlim-assist", "SENSITIVE_TEST_SENTINEL title", ["Body text"])
  const attemptedRecord = buildGitHubWriteAuditRecord(intent, "attempted", { reason: "confirmed" }, fixedNow())
  const succeededRecord = buildGitHubWriteAuditRecord(
    intent,
    "succeeded",
    {
      issueNumber: 12,
      issueUrl: "https://github.com/Linardi1328/khlim-assist/issues/12?token=SENSITIVE_TEST_SENTINEL"
    },
    fixedNow()
  )

  await recorder.record(attemptedRecord)
  await recorder.record(succeededRecord)

  const lines = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.status), ["attempted", "succeeded"])
  assert.equal(lines[0].timestamp, "2026-08-18T00:00:00.000Z")
  assert.equal(lines[0].action, GITHUB_ISSUE_CREATE_ACTION)
  assert.equal(lines[0].endpoint, khlimEndpoint)
  assert.equal(lines[0].titleChars, "SENSITIVE_TEST_SENTINEL title".length)
  assert.equal(lines[0].bodyChars, "Body text".length)
  assert.equal(lines[1].issueNumber, 12)
  assert.equal(Object.hasOwn(lines[1], "issueUrl"), false)
  for (const record of lines) {
    assertAuditIsCredentialFree(record)
  }

  await rm(tempDir, { recursive: true, force: true })
}

{
  const auditRecorder = makeAuditRecorder({ failOnStatus: "attempted" })
  let writerCalls = 0
  const result = await handleGitHubIssueCreateCommand("khlim-assist", "Audit fail closed", [], {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writer: async () => {
      writerCalls += 1
      return { number: 1 }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[AUDIT_UNAVAILABLE\]/)
  assert.match(result.output, /no GitHub write was attempted/)
  assert.equal(writerCalls, 0)
  assertSafeOutput(result.output)
}

{
  const auditRecorder = makeAuditRecorder()
  const result = await handleGitHubIssueCreateCommand("khlim-assist", "Writer failure", [], {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writer: async () => {
      const error = new Error("SENSITIVE_TEST_SENTINEL raw writer failure")
      error.stderr = "raw stderr SENSITIVE_TEST_SENTINEL"
      throw error
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[GITHUB_API_FAILED\]/)
  assertSafeOutput(result.output)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["attempted", "failed"])
  assert.equal(auditRecorder.records[1].code, "GITHUB_API_FAILED")
}

{
  const auditRecorder = makeAuditRecorder()
  const result = await handleGitHubIssueCreateCommand("khlim-assist", "Malformed writer result", [], {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writer: async () => ({ url: "https://github.com/Linardi1328/khlim-assist/issues/99" })
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[MALFORMED_GITHUB_RESPONSE\]/)
  assertSafeOutput(result.output)
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["attempted", "failed"])
  assert.equal(auditRecorder.records[1].code, "MALFORMED_GITHUB_RESPONSE")
}

{
  const auditRecorder = makeAuditRecorder({ failOnStatus: "failed" })
  const result = await handleGitHubIssueCreateCommand("khlim-assist", "Failure audit unavailable", [], {
    auditRecorder,
    confirmationValue: khlimConfirmation,
    now: fixedNow,
    writer: async () => {
      throw new Error("SENSITIVE_TEST_SENTINEL raw writer failure")
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[AUDIT_UNAVAILABLE\]/)
  assertSafeOutput(result.output)
}

assert.deepEqual(toPpoWrapperArgs("issue-create khlim-assist Title"), [
  "/ppo",
  "issue-create",
  "khlim-assist",
  "Title"
])
assert.deepEqual(toPpoWrapperArgs("/ppo issue-create khlim-assist Title"), [
  "/ppo",
  "issue-create",
  "khlim-assist",
  "Title"
])
assert.equal(toPpoWrapperArgs(`ppo issue-create khlim-assist Title ${GITHUB_WRITE_CONFIRM_ENV}=create-issue:khlim-assist`), null)

{
  const tempDir = await mkdtemp(join(tmpdir(), "ppo-issue-cli-"))
  const tempLocalOperator = join(tempDir, "local-operator")
  await cp(new URL(".", import.meta.url), tempLocalOperator, { recursive: true })

  const result = spawnSync(process.execPath, [
    join(tempLocalOperator, "ppo-command.mjs"),
    "issue-create",
    "khlim-assist",
    "Multi word issue title",
    "Body text with spaces"
  ], { encoding: "utf8" })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /^GitHub Issue Create Preview/)
  assert.match(result.stdout, /Intended change: create one issue with title "Multi word issue title"/)
  assert.match(result.stdout, /Body: present \(21 chars\)/)
  assert.match(result.stdout, /Required confirmation: PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist/)
  assert.equal(result.stderr, "")

  await rm(tempDir, { recursive: true, force: true })
}

{
  const tempDir = await mkdtemp(join(tmpdir(), "ppo-issue-cli-stage-"))
  const result = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "/ppo issue-create khlim-assist Title"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: tempDir
    }
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^GitHub Issue Create Preview/)
  assert.match(result.stdout, /^Confirm: \/ppo issue-confirm [A-Za-z0-9_-]{43}$/m)
  assert.doesNotMatch(result.stdout, /Required confirmation: PPO_GITHUB_WRITE_CONFIRM/)
  assert.equal(result.stderr, "")

  await rm(tempDir, { recursive: true, force: true })
}

console.log("GitHub issue-create tests passed: allowlist, terminal confirmation, POST guard, validation, audit, safe errors, mocked success, and Phase 5B staging route.")
