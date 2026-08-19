import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ISSUE_APPROVAL_TTL_MS,
  ISSUE_REQUEST_ID_PATTERN,
  cleanupExpiredIssueApprovalRequests,
  claimIssueApprovalRequest,
  handlePpoIssueConfirmCommand,
  handlePpoIssueCreateApprovalCommand,
  parsePpoIssueConfirmRequest,
  parsePpoIssueCreateRequest,
  stageIssueApprovalRequest
} from "./github-issue-approval.mjs"
import { prepareIssueCreateIntent } from "./github-issue-create.mjs"
import { listPhase2GitHubProjects } from "./github-project-registry.mjs"
import { runPpoLocalTool, toPpoWrapperArgs } from "../openclaw/plugins/ppo-local/bridge.mjs"

const allowedProjectIds = ["khlim-assist", "ledgerpilot-ai", "spy-market-agent", "portfolio", "rbl-content-engine"]
const fixedNow = () => new Date("2026-08-19T00:00:00.000Z")
const afterExpiry = () => new Date(fixedNow().getTime() + ISSUE_APPROVAL_TTL_MS + 1)
const validRequestId = "A".repeat(43)

function makeAuditRecorder(options = {}) {
  const records = []

  return {
    records,

    async record(entry) {
      if (options.failOnStatus === entry.status) {
        throw new Error("SENSITIVE_TEST_SENTINEL raw audit failure")
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

function assertNoChatSecretLeak(output) {
  assert.doesNotMatch(output, /PPO_GITHUB_WRITE_CONFIRM|create-issue:khlim-assist|gho_|SENSITIVE_TEST_SENTINEL|raw audit failure/i)
}

async function makeTempStore() {
  return mkdtemp(join(tmpdir(), "ppo-issue-approval-"))
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

async function assertMode(path, expectedMode) {
  const actualMode = (await stat(path)).mode & 0o777
  assert.equal(actualMode, expectedMode, `${path} mode`)
}

async function withStore(fn) {
  const writeDataDir = await makeTempStore()

  try {
    await fn(writeDataDir)
  } finally {
    await rm(writeDataDir, { recursive: true, force: true })
  }
}

assert.deepEqual(listPhase2GitHubProjects().map((project) => project.id), allowedProjectIds)

for (const projectId of allowedProjectIds) {
  const parsed = parsePpoIssueCreateRequest(`${projectId} Allowed title --body Allowed body`)

  assert.equal(parsed.projectId, projectId)
  assert.equal(parsed.title, "Allowed title")
  assert.equal(parsed.body, "Allowed body")
  assert.equal(parsed.intent.requiredConfirmation, `create-issue:${projectId}`)
}

{
  const parsed = parsePpoIssueCreateRequest("khlim-assist Title before delimiter --body Body text --body inert")

  assert.equal(parsed.title, "Title before delimiter")
  assert.equal(parsed.body, "Body text --body inert")
}

{
  const parsed = parsePpoIssueCreateRequest("khlim-assist Title without body")

  assert.equal(parsed.title, "Title without body")
  assert.equal(parsed.body, "")
}

for (const input of [
  "unknown Title",
  "KHLIM-assist Title",
  "Linardi1328/khlim-assist Title",
  "khlim-assist",
  "khlim-assist --body Body without title",
  "khlim-assist Title --body",
  `khlim-assist ${"x".repeat(201)}`,
  `khlim-assist Title --body ${"x".repeat(4001)}`
]) {
  assert.throws(
    () => parsePpoIssueCreateRequest(input),
    /GitHubIssue(Create|Approval)Error/,
    `${input.slice(0, 32)} rejects before staging`
  )
}

for (const input of [
  validRequestId,
  ` ${validRequestId} `
]) {
  assert.equal(parsePpoIssueConfirmRequest(input), validRequestId)
}

for (const input of [
  "",
  "short-id",
  `${validRequestId} extra`,
  "PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist"
]) {
  assert.throws(
    () => parsePpoIssueConfirmRequest(input),
    /GitHubIssueApprovalError/,
    `${input || "(empty)"} rejects as malformed id`
  )
}

await withStore(async (writeDataDir) => {
  let writerCalls = 0
  const result = await handlePpoIssueCreateApprovalCommand(
    "khlim-assist Stage title --body Body text with SENSITIVE_TEST_SENTINEL gho_fake",
    {
      writeDataDir,
      now: fixedNow,
      writer: async () => {
        writerCalls += 1
        return { number: 1 }
      }
    }
  )

  assert.equal(result.ok, true)
  assert.match(result.output, /^GitHub Issue Create Preview/)
  assert.match(result.output, /Project: khlim-assist/)
  assert.match(result.output, /Intended change: create one issue with title "Stage title"/)
  assert.match(result.output, /Body: present \([0-9]+ chars\)/)
  assert.match(result.output, /^Confirm: \/ppo issue-confirm [A-Za-z0-9_-]{43}$/m)
  assertNoChatSecretLeak(result.output)
  assert.equal(writerCalls, 0, "staging performs zero writer calls")

  const requestId = requestIdFromOutput(result.output)
  const files = await listJsonFiles(writeDataDir)

  assert.equal(files.length, 1)
  assert.equal(files[0].endsWith(`${requestId}.json`), true)
  await assertMode(writeDataDir, 0o700)
  await assertMode(join(writeDataDir, "pending-github-issues"), 0o700)
  await assertMode(join(writeDataDir, "pending-github-issues", "pending"), 0o700)
  await assertMode(join(writeDataDir, "pending-github-issues", "claimed"), 0o700)
  await assertMode(files[0], 0o600)

  const stored = JSON.parse(await readFile(files[0], "utf8"))
  assert.equal(stored.requestId, requestId)
  assert.equal(stored.expiresAt, "2026-08-19T00:10:00.000Z")
  assert.equal(stored.intent.title, "Stage title")
  assert.equal(stored.intent.body, "Body text with SENSITIVE_TEST_SENTINEL gho_fake")
  assert.equal(stored.intent.endpoint, "/repos/Linardi1328/khlim-assist/issues")
})

await withStore(async (writeDataDir) => {
  const first = await handlePpoIssueCreateApprovalCommand("khlim-assist Same title", {
    writeDataDir,
    now: fixedNow
  })
  const second = await handlePpoIssueCreateApprovalCommand("khlim-assist Same title", {
    writeDataDir,
    now: fixedNow
  })
  const firstId = requestIdFromOutput(first.output)
  const secondId = requestIdFromOutput(second.output)

  assert.match(firstId, ISSUE_REQUEST_ID_PATTERN)
  assert.match(secondId, ISSUE_REQUEST_ID_PATTERN)
  assert.notEqual(firstId, secondId, "approval request ids are random and opaque")
})

await withStore(async (writeDataDir) => {
  const staged = await handlePpoIssueCreateApprovalCommand("khlim-assist Expiring title", {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  let writerCalls = 0
  const result = await handlePpoIssueConfirmCommand(requestId, {
    writeDataDir,
    now: afterExpiry,
    writer: async () => {
      writerCalls += 1
      return { number: 1 }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[REQUEST_EXPIRED\]/)
  assert.equal(writerCalls, 0)
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "expired request content is deleted")
  assertNoChatSecretLeak(result.output)
})

await withStore(async (writeDataDir) => {
  let writerCalls = 0
  const result = await handlePpoIssueConfirmCommand(validRequestId, {
    writeDataDir,
    now: fixedNow,
    writer: async () => {
      writerCalls += 1
      return { number: 1 }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[REQUEST_NOT_FOUND\]/)
  assert.equal(writerCalls, 0)
  assertNoChatSecretLeak(result.output)
})

await withStore(async (writeDataDir) => {
  let writerCalls = 0
  const result = await handlePpoIssueConfirmCommand("bad-id", {
    writeDataDir,
    writer: async () => {
      writerCalls += 1
      return { number: 1 }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[INVALID_REQUEST_ID\]/)
  assert.equal(writerCalls, 0)
  assertNoChatSecretLeak(result.output)
})

await withStore(async (writeDataDir) => {
  const auditRecorder = makeAuditRecorder()
  const staged = await handlePpoIssueCreateApprovalCommand("khlim-assist Single use title --body Body text", {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  const writerCalls = []
  const confirmed = await handlePpoIssueConfirmCommand(requestId, {
    auditRecorder,
    writeDataDir,
    now: fixedNow,
    writer: async (intent) => {
      writerCalls.push({
        project: intent.project.id,
        endpoint: intent.endpoint,
        title: intent.title,
        body: intent.body,
        confirmation: intent.requiredConfirmation
      })
      return {
        number: 55,
        url: "https://github.com/Linardi1328/khlim-assist/issues/55"
      }
    }
  })
  const replay = await handlePpoIssueConfirmCommand(requestId, {
    auditRecorder,
    writeDataDir,
    now: fixedNow,
    writer: async () => {
      writerCalls.push({ replay: true })
      return { number: 56 }
    }
  })

  assert.equal(confirmed.ok, true)
  assert.match(confirmed.output, /^GitHub Issue Created/)
  assert.match(confirmed.output, /Issue: #55/)
  assert.equal(replay.ok, false)
  assert.match(replay.output, /\[REQUEST_NOT_FOUND\]/)
  assert.equal(writerCalls.length, 1)
  assert.deepEqual(writerCalls[0], {
    project: "khlim-assist",
    endpoint: "/repos/Linardi1328/khlim-assist/issues",
    title: "Single use title",
    body: "Body text",
    confirmation: "create-issue:khlim-assist"
  })
  assert.deepEqual(auditRecorder.records.map((record) => record.status), ["attempted", "succeeded"])
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "confirmed request content is consumed")
  assertNoChatSecretLeak(confirmed.output)
  assertNoChatSecretLeak(replay.output)
})

await withStore(async (writeDataDir) => {
  const staged = await handlePpoIssueCreateApprovalCommand("khlim-assist Concurrent title", {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  let writerCalls = 0
  const confirmations = await Promise.all(Array.from({ length: 12 }, () => handlePpoIssueConfirmCommand(requestId, {
    auditRecorder: makeAuditRecorder(),
    writeDataDir,
    now: fixedNow,
    writer: async () => {
      writerCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { number: 77 }
    }
  })))

  assert.equal(writerCalls, 1, "concurrent confirmations perform exactly one writer call")
  assert.equal(confirmations.filter((result) => result.ok).length, 1)
  assert.equal(confirmations.filter((result) => !result.ok).length, 11)

  for (const result of confirmations) {
    assertNoChatSecretLeak(result.output)
  }
})

await withStore(async (writeDataDir) => {
  const auditRecorder = makeAuditRecorder({ failOnStatus: "attempted" })
  const staged = await handlePpoIssueCreateApprovalCommand("khlim-assist Audit fail title", {
    writeDataDir,
    now: fixedNow
  })
  const requestId = requestIdFromOutput(staged.output)
  let writerCalls = 0
  const result = await handlePpoIssueConfirmCommand(requestId, {
    auditRecorder,
    writeDataDir,
    now: fixedNow,
    writer: async () => {
      writerCalls += 1
      return { number: 1 }
    }
  })
  const replay = await handlePpoIssueConfirmCommand(requestId, {
    auditRecorder: makeAuditRecorder(),
    writeDataDir,
    now: fixedNow,
    writer: async () => {
      writerCalls += 1
      return { number: 2 }
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.output, /\[AUDIT_UNAVAILABLE\]/)
  assert.match(result.output, /no GitHub write was attempted/)
  assert.equal(replay.ok, false)
  assert.equal(writerCalls, 0, "audit failure closes before writer and still consumes the request")
  assert.deepEqual(await listJsonFiles(writeDataDir), [])
  assertNoChatSecretLeak(result.output)
})

await withStore(async (writeDataDir) => {
  const result = await handlePpoIssueCreateApprovalCommand(
    "khlim-assist Safe title --body Body SENSITIVE_TEST_SENTINEL PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist gho_fake",
    {
      writeDataDir,
      now: fixedNow
    }
  )

  assert.equal(result.ok, false)
  assert.match(result.output, /\[CHAT_CONFIRMATION_REJECTED\]/)
  assertNoChatSecretLeak(result.output)
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "rejected chat confirmation does not stage content")
})

await withStore(async (writeDataDir) => {
  const intent = prepareIssueCreateIntent("khlim-assist", "Manual stage title", ["Manual body"])
  const record = await stageIssueApprovalRequest(intent, {
    writeDataDir,
    now: fixedNow
  })
  const claimed = await claimIssueApprovalRequest(record.requestId, {
    writeDataDir,
    now: fixedNow
  })

  assert.equal(claimed.requestId, record.requestId)
  assert.equal(claimed.intent.title, "Manual stage title")
  assert.deepEqual(await listJsonFiles(writeDataDir), [], "claim deletes request content before any writer runs")
})

await withStore(async (writeDataDir) => {
  const intent = prepareIssueCreateIntent("khlim-assist", "Cleanup title", [])
  await stageIssueApprovalRequest(intent, {
    writeDataDir,
    now: fixedNow,
    ttlMs: 1
  })

  await cleanupExpiredIssueApprovalRequests({
    writeDataDir,
    now: () => new Date(fixedNow().getTime() + 2)
  })

  assert.deepEqual(await listJsonFiles(writeDataDir), [])
})

assert.deepEqual(
  toPpoWrapperArgs("issue-create khlim-assist Bridge title --body Bridge body"),
  ["/ppo", "issue-create", "khlim-assist", "Bridge title", "--body", "Bridge body"]
)
assert.deepEqual(
  toPpoWrapperArgs("/ppo issue-create khlim-assist Bridge title"),
  ["/ppo", "issue-create", "khlim-assist", "Bridge title"]
)
assert.deepEqual(
  toPpoWrapperArgs(`issue-confirm ${validRequestId}`),
  ["/ppo", "issue-confirm", validRequestId]
)
assert.deepEqual(
  toPpoWrapperArgs(`/ppo issue-confirm ${validRequestId}`),
  ["/ppo", "issue-confirm", validRequestId]
)

for (const input of [
  "issue-create unknown Title",
  "issue-create khlim-assist Title --body",
  "issue-create khlim-assist Title PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist",
  "issue-confirm bad-id",
  `issue-confirm ${validRequestId} extra`
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
  assertNoChatSecretLeak(result.stdout)
}

{
  const result = await runPpoLocalTool(
    { command: "/ppo issue-create khlim-assist Bridge title --body Bridge body" },
    {
      runWrapper: async (wrapperArgs) => ({
        stdout: `fake wrapper: ${wrapperArgs.join(" | ")}\n`,
        stderr: ""
      })
    }
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.wrapperArgs, ["/ppo", "issue-create", "khlim-assist", "Bridge title", "--body", "Bridge body"])
  assert.equal(result.stdout, "fake wrapper: /ppo | issue-create | khlim-assist | Bridge title | --body | Bridge body\n")
}

await withStore(async (writeDataDir) => {
  const result = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "/ppo issue-create khlim-assist CLI staged title --body CLI staged body"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_WRITE_DATA_DIR: writeDataDir
    }
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /^GitHub Issue Create Preview/)
  assert.match(result.stdout, /^Confirm: \/ppo issue-confirm [A-Za-z0-9_-]{43}$/m)
  assert.equal(result.stderr, "")
  assertNoChatSecretLeak(result.stdout)
  assert.equal((await listJsonFiles(writeDataDir)).length, 1)
})

await withStore(async (writeDataDir) => {
  const auditPath = join(writeDataDir, "audit", "github-write-audit.ndjson")
  const result = spawnSync(process.execPath, [
    "local-operator/ppo-command.mjs",
    "issue-create",
    "khlim-assist",
    "Terminal phase 5A title",
    "Terminal phase 5A body"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PPO_GITHUB_WRITE_AUDIT_PATH: auditPath
    }
  })

  assert.equal(result.status, 1)
  assert.match(result.stdout, /^GitHub Issue Create Preview/)
  assert.match(result.stdout, /Required confirmation: PPO_GITHUB_WRITE_CONFIRM=create-issue:khlim-assist/)
  assert.doesNotMatch(result.stdout, /Confirm: \/ppo issue-confirm/)
  assert.equal(result.stderr, "")
})

console.log("GitHub issue approval tests passed: staging, parsing, TTL, single-use confirmation, concurrency, safe errors, and ppo_local routing.")
