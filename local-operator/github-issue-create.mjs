import { execFile } from "node:child_process"
import { chmod, mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  getBlockedPhase2GitHubProjectStatus,
  getPhase2GitHubProject,
  listPhase2GitHubProjects
} from "./github-project-registry.mjs"
import { sanitizeGitHubText } from "./github-readonly.mjs"

export const GITHUB_ISSUE_CREATE_ACTION = "create-issue"
export const GITHUB_ISSUE_CREATE_DANGER_LEVEL = "dangerous"
export const GITHUB_WRITE_CONFIRM_ENV = "PPO_GITHUB_WRITE_CONFIRM"
export const MAX_ISSUE_TITLE_CHARS = 200
export const MAX_ISSUE_BODY_CHARS = 4000
export const MAX_ISSUE_BODY_ARGS = 80
export const DEFAULT_GITHUB_WRITE_AUDIT_PATH = fileURLToPath(
  new URL("./audit/github-write-audit.ndjson", import.meta.url)
)
export const GITHUB_WRITE_AUDIT_PATH_ENV = "PPO_GITHUB_WRITE_AUDIT_PATH"

const GITHUB_WRITE_TIMEOUT_MS = 15000
const GITHUB_WRITE_MAX_BUFFER = 512 * 1024
const ansiTerminalSequence = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_])/u
const unsafeTitleControls = /[\u0000-\u001F\u007F-\u009F]/u
const unsafeBodyControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u

export class GitHubIssueCreateError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "GitHubIssueCreateError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function issueCreateError(code, safeMessage) {
  return new GitHubIssueCreateError(code, safeMessage)
}

function allowedProjectIdList() {
  return listPhase2GitHubProjects().map((project) => project.id).join(", ")
}

function safeInline(value, limit = 120) {
  const compact = sanitizeGitHubText(String(value ?? "")).replace(/\s+/gu, " ").trim()

  if (compact.length <= limit) {
    return compact
  }

  return `${compact.slice(0, limit - 3).trim()}...`
}

function projectLabel(projectId) {
  return safeInline(projectId || "(missing)") || "(missing)"
}

function repoFullName(project) {
  return `${project.owner}/${project.repo}`
}

function repoIssueEndpoint(project) {
  return `/repos/${project.owner}/${project.repo}/issues`
}

function issueEndpointProject(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("/")) {
    throw issueCreateError(
      "UNSUPPORTED_ENDPOINT",
      "GitHub issue-create transport requires an approved GitHub API endpoint path."
    )
  }

  if (endpoint.includes("?") || endpoint.includes("#")) {
    throw issueCreateError(
      "UNSUPPORTED_ENDPOINT",
      "GitHub issue-create transport accepts endpoint paths only; query strings and fragments are rejected."
    )
  }

  for (const project of listPhase2GitHubProjects()) {
    if (endpoint === repoIssueEndpoint(project)) {
      return {
        ...project,
        fullName: repoFullName(project)
      }
    }
  }

  throw issueCreateError(
    "UNSUPPORTED_ENDPOINT",
    `GitHub issue-create transport is limited to POST /repos/<approved repo>/issues. Rejected POST ${safeInline(endpoint)}.`
  )
}

export function resolveIssueCreateProject(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw issueCreateError(
      "INVALID_PROJECT",
      `Project id is required. Use one of: ${allowedProjectIdList()}.`
    )
  }

  const normalizedProjectId = projectId.trim()
  const project = getPhase2GitHubProject(normalizedProjectId)

  if (project) {
    return {
      ...project,
      fullName: repoFullName(project)
    }
  }

  const blockedStatus = getBlockedPhase2GitHubProjectStatus(normalizedProjectId)

  if (blockedStatus) {
    throw issueCreateError(
      "PROJECT_NOT_CONNECTED",
      `Project "${projectLabel(normalizedProjectId)}" is ${blockedStatus} and is not connected for Phase 5A issue creation.`
    )
  }

  throw issueCreateError(
    "UNKNOWN_PROJECT",
    `Project "${projectLabel(projectId)}" is not in the connected project allowlist.`
  )
}

function hasUnsafeTerminalInput(value, controlsPattern) {
  return ansiTerminalSequence.test(value) || controlsPattern.test(value)
}

export function normalizeIssueTitle(titleInput) {
  if (typeof titleInput !== "string") {
    throw issueCreateError(
      "INVALID_TITLE",
      "Issue title is required. Use: issue-create <project> <title> [body...]."
    )
  }

  if (hasUnsafeTerminalInput(titleInput, unsafeTitleControls)) {
    throw issueCreateError(
      "UNSAFE_INPUT",
      "Issue title contains terminal control characters or escape sequences and was rejected."
    )
  }

  const title = titleInput.trim()

  if (!title) {
    throw issueCreateError(
      "INVALID_TITLE",
      "Issue title is required. Use: issue-create <project> <title> [body...]."
    )
  }

  if (title.length > MAX_ISSUE_TITLE_CHARS) {
    throw issueCreateError(
      "TITLE_TOO_LARGE",
      `Issue title is too long for Phase 5A. Keep it at ${MAX_ISSUE_TITLE_CHARS} characters or fewer.`
    )
  }

  return title
}

export function normalizeIssueBody(bodyInput = "") {
  if (Array.isArray(bodyInput) && bodyInput.length > MAX_ISSUE_BODY_ARGS) {
    throw issueCreateError(
      "BODY_TOO_LARGE",
      `Issue body has too many terminal arguments for Phase 5A. Keep it at ${MAX_ISSUE_BODY_ARGS} arguments or fewer.`
    )
  }

  const rawBody = Array.isArray(bodyInput)
    ? bodyInput.map((part) => String(part)).join(" ")
    : String(bodyInput ?? "")

  if (hasUnsafeTerminalInput(rawBody, unsafeBodyControls)) {
    throw issueCreateError(
      "UNSAFE_INPUT",
      "Issue body contains terminal control characters or escape sequences and was rejected."
    )
  }

  const body = rawBody.replace(/\r\n?/gu, "\n").trim()

  if (body.length > MAX_ISSUE_BODY_CHARS) {
    throw issueCreateError(
      "BODY_TOO_LARGE",
      `Issue body is too long for Phase 5A. Keep it at ${MAX_ISSUE_BODY_CHARS} characters or fewer.`
    )
  }

  return body
}

function normalizeIssueFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw issueCreateError(
      "UNSUPPORTED_FIELDS",
      "GitHub issue-create transport accepts only structured title/body fields."
    )
  }

  const keys = Object.keys(fields)

  if (!keys.every((key) => key === "title" || key === "body")) {
    throw issueCreateError(
      "UNSUPPORTED_FIELDS",
      "GitHub issue-create transport permits only title and body fields."
    )
  }

  return {
    title: normalizeIssueTitle(fields.title),
    body: normalizeIssueBody(fields.body ?? "")
  }
}

export function prepareIssueCreateIntent(projectId, titleInput, bodyInput = "") {
  const project = resolveIssueCreateProject(projectId)
  const title = normalizeIssueTitle(titleInput)
  const body = normalizeIssueBody(bodyInput)
  const endpoint = repoIssueEndpoint(project)

  return {
    action: GITHUB_ISSUE_CREATE_ACTION,
    dangerLevel: GITHUB_ISSUE_CREATE_DANGER_LEVEL,
    project,
    method: "POST",
    endpoint,
    title,
    body,
    requiredConfirmation: `${GITHUB_ISSUE_CREATE_ACTION}:${project.id}`
  }
}

export function normalizePreparedIssueCreateIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw issueCreateError(
      "INVALID_INTENT",
      "GitHub issue-create intent is invalid; no GitHub write was attempted."
    )
  }

  const expected = prepareIssueCreateIntent(intent.project?.id, intent.title, intent.body)
  const storedProject = intent.project || {}
  const matchesExpectedIntent =
    intent.action === expected.action &&
    intent.dangerLevel === expected.dangerLevel &&
    intent.method === expected.method &&
    intent.endpoint === expected.endpoint &&
    intent.requiredConfirmation === expected.requiredConfirmation &&
    storedProject.id === expected.project.id &&
    storedProject.owner === expected.project.owner &&
    storedProject.repo === expected.project.repo &&
    storedProject.fullName === expected.project.fullName

  if (!matchesExpectedIntent) {
    throw issueCreateError(
      "INVALID_INTENT",
      "GitHub issue-create intent is invalid; no GitHub write was attempted."
    )
  }

  return {
    ...expected,
    title: expected.title,
    body: expected.body
  }
}

export function buildIssueCreatePreview(intent) {
  const bodyLabel = intent.body ? `present (${intent.body.length} chars)` : "empty"

  return [
    "GitHub Issue Create Preview",
    `Action: ${intent.action}`,
    `Project: ${intent.project.id}`,
    `Repo: ${intent.project.fullName}`,
    `Endpoint: ${intent.method} ${intent.endpoint}`,
    `Intended change: create one issue with title "${safeInline(intent.title, 160)}"`,
    `Body: ${bodyLabel}`,
    `Danger level: ${intent.dangerLevel}`
  ].join("\n")
}

function confirmationRefusalLine(intent, confirmationValue) {
  if (confirmationValue) {
    return "Refused: confirmation mismatch; no GitHub write was attempted."
  }

  return "Refused: confirmation missing; no GitHub write was attempted."
}

function confirmationInstruction(intent) {
  return `Required confirmation: ${GITHUB_WRITE_CONFIRM_ENV}=${intent.requiredConfirmation}`
}

export function buildGhIssuePostArgs(endpoint, fields) {
  issueEndpointProject(endpoint)
  const normalizedFields = normalizeIssueFields(fields)

  return [
    "api",
    "--method",
    "POST",
    endpoint,
    "--raw-field",
    `title=${normalizedFields.title}`,
    "--raw-field",
    `body=${normalizedFields.body}`
  ]
}

function execFilePromise(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    try {
      execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
        if (error) {
          const failure = new Error("gh api issue-create request failed")
          failure.code = error.code
          failure.exitCode = error.exitCode ?? error.code
          failure.signal = error.signal
          failure.stdout = stdout || error.stdout || ""
          failure.stderr = stderr || error.stderr || ""
          reject(failure)
          return
        }

        resolve({ stdout, stderr })
      })
    } catch (error) {
      reject(error)
    }
  })
}

export function createGhIssuePostRunner({ execFileImpl = execFile } = {}) {
  return async function runGhIssuePost(request) {
    if (!request || request.method !== "POST") {
      throw issueCreateError(
        "UNSUPPORTED_METHOD",
        "GitHub issue-create transport supports POST requests only."
      )
    }

    const args = buildGhIssuePostArgs(request.endpoint, request.fields)

    return execFilePromise(execFileImpl, "gh", args, {
      encoding: "utf8",
      maxBuffer: GITHUB_WRITE_MAX_BUFFER,
      shell: false,
      timeout: GITHUB_WRITE_TIMEOUT_MS
    })
  }
}

function combinedFailureText(error) {
  return [error?.stderr, error?.stdout, error?.message].filter(Boolean).join("\n")
}

function classifyIssueCreateFailure(error, intent) {
  if (error instanceof GitHubIssueCreateError) {
    return error
  }

  if (error?.code === "ENOENT") {
    return issueCreateError(
      "GITHUB_CLI_UNAVAILABLE",
      "GitHub CLI `gh` is unavailable. Install it, verify with `gh --version`, then run `gh auth status`."
    )
  }

  const failureText = combinedFailureText(error)

  if (/(not logged in|authentication required|authenticate|auth login|HTTP 401|Bad credentials|requires authentication|no oauth token)/i.test(failureText)) {
    return issueCreateError(
      "GITHUB_CLI_UNAUTHENTICATED",
      "GitHub CLI `gh` is not authenticated. Run `gh auth status`; if needed, run `gh auth login` outside this repo and retry."
    )
  }

  if (/(HTTP 403|HTTP 404|Forbidden|Not Found|Could not resolve to a Repository|repository not found|Resource not accessible|permission denied|insufficient permissions)/i.test(failureText)) {
    return issueCreateError(
      "GITHUB_REPO_UNAVAILABLE",
      `Repository is unavailable or permission is denied for creating an issue in ${intent.project.fullName}. Confirm repo access with \`gh repo view\` and \`gh auth status\`.`
    )
  }

  return issueCreateError(
    "GITHUB_API_FAILED",
    `GitHub issue creation failed for ${intent.project.fullName}. Retry later or confirm GitHub availability with \`gh auth status\`.`
  )
}

function parseCreatedIssue(result, intent) {
  const stdout = typeof result === "string" ? result : result?.stdout
  let payload

  try {
    payload = JSON.parse(stdout)
  } catch {
    throw issueCreateError(
      "MALFORMED_GITHUB_RESPONSE",
      `GitHub CLI returned malformed JSON after issue creation for ${intent.project.fullName}. Inspect the repository before retrying.`
    )
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw issueCreateError(
      "MALFORMED_GITHUB_RESPONSE",
      `GitHub CLI returned an unexpected issue response shape for ${intent.project.fullName}.`
    )
  }

  if (!Number.isInteger(payload.number) || payload.number < 1) {
    throw issueCreateError(
      "MALFORMED_GITHUB_RESPONSE",
      `GitHub CLI returned an issue response without a valid issue number for ${intent.project.fullName}.`
    )
  }

  return {
    number: payload.number,
    title: typeof payload.title === "string" ? sanitizeGitHubText(payload.title) : null,
    url: typeof payload.html_url === "string" ? sanitizeGitHubText(payload.html_url) : null
  }
}

export function createGitHubIssueWriter({ runner = createGhIssuePostRunner() } = {}) {
  return {
    async createIssue(intent) {
      let result

      try {
        result = await runner({
          method: "POST",
          endpoint: intent.endpoint,
          fields: {
            title: intent.title,
            body: intent.body
          }
        })
      } catch (error) {
        throw classifyIssueCreateFailure(error, intent)
      }

      return parseCreatedIssue(result, intent)
    }
  }
}

function auditTimestamp(now) {
  const value = now instanceof Date ? now : new Date(now)

  if (Number.isNaN(value.getTime())) {
    return new Date().toISOString()
  }

  return value.toISOString()
}

export function buildGitHubWriteAuditRecord(intent, status, details = {}, now = new Date()) {
  const record = {
    schemaVersion: 1,
    timestamp: auditTimestamp(now),
    action: intent.action,
    project: intent.project.id,
    repo: intent.project.fullName,
    method: intent.method,
    endpoint: intent.endpoint,
    dangerLevel: intent.dangerLevel,
    status,
    titleChars: intent.title.length,
    bodyChars: intent.body.length,
    bodyPresent: intent.body.length > 0
  }

  if (typeof details.reason === "string") {
    record.reason = details.reason
  }

  if (typeof details.code === "string") {
    record.code = details.code
  }

  if (Number.isInteger(details.issueNumber)) {
    record.issueNumber = details.issueNumber
  }

  return record
}

export function createGitHubWriteAuditRecorder({
  auditPath = process.env[GITHUB_WRITE_AUDIT_PATH_ENV] || DEFAULT_GITHUB_WRITE_AUDIT_PATH
} = {}) {
  return {
    auditPath,

    async record(entry) {
      const line = `${JSON.stringify(entry)}\n`
      await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 })
      await chmod(dirname(auditPath), 0o700)
      const file = await open(auditPath, "a", 0o600)

      try {
        await file.writeFile(line, "utf8")
        await file.sync()
      } finally {
        await file.close()
      }

      await chmod(auditPath, 0o600)
    }
  }
}

async function recordAudit(auditRecorder, intent, status, details, now) {
  await auditRecorder.record(buildGitHubWriteAuditRecord(intent, status, details, now))
}

async function tryRecordAudit(auditRecorder, intent, status, details, now) {
  try {
    await recordAudit(auditRecorder, intent, status, details, now)
    return true
  } catch {
    return false
  }
}

function formatCreatedIssue(intent, createdIssue) {
  const lines = [
    "GitHub Issue Created",
    `Action: ${intent.action}`,
    `Project: ${intent.project.id}`,
    `Repo: ${intent.project.fullName}`,
    `Issue: #${createdIssue.number}`
  ]

  if (createdIssue.url) {
    lines.push(`URL: ${createdIssue.url}`)
  }

  lines.push("Audit: recorded")

  return lines.join("\n")
}

export function formatGitHubIssueCreateError(error) {
  if (error instanceof GitHubIssueCreateError) {
    return `PPO GitHub issue-create error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO GitHub issue-create error: unexpected local failure."
}

async function runInjectedWriter(writer, intent) {
  if (typeof writer === "function") {
    return writer(intent)
  }

  return writer.createIssue(intent)
}

function normalizeCreatedIssueResult(createdIssue, intent) {
  if (!createdIssue || typeof createdIssue !== "object" || !Number.isInteger(createdIssue.number) || createdIssue.number < 1) {
    throw issueCreateError(
      "MALFORMED_GITHUB_RESPONSE",
      `GitHub issue writer returned an invalid issue result for ${intent.project.fullName}. Inspect the repository before retrying.`
    )
  }

  return {
    number: createdIssue.number,
    url: typeof createdIssue.url === "string" ? sanitizeGitHubText(createdIssue.url) : null
  }
}

async function runGitHubIssueCreateIntent(intent, options = {}) {
  const now = options.now ? options.now() : new Date()
  const auditRecorder = options.auditRecorder || createGitHubWriteAuditRecorder({
    auditPath: options.auditPath || process.env[GITHUB_WRITE_AUDIT_PATH_ENV] || DEFAULT_GITHUB_WRITE_AUDIT_PATH
  })
  const confirmationValue = String(options.confirmationValue ?? "")
  const preview = buildIssueCreatePreview(intent)

  if (confirmationValue !== intent.requiredConfirmation) {
    const reason = confirmationValue ? "confirmation_mismatch" : "confirmation_missing"
    const auditRecorded = await tryRecordAudit(auditRecorder, intent, "refused", { reason }, now)
    const auditLine = auditRecorded
      ? "Audit: refusal recorded"
      : "Audit: unavailable for refused write attempt; no GitHub write was attempted"

    return {
      ok: false,
      output: [
        preview,
        confirmationRefusalLine(intent, confirmationValue),
        confirmationInstruction(intent),
        auditLine
      ].join("\n")
    }
  }

  try {
    await recordAudit(auditRecorder, intent, "attempted", { reason: "confirmed" }, now)
  } catch {
    return {
      ok: false,
      output: formatGitHubIssueCreateError(issueCreateError(
        "AUDIT_UNAVAILABLE",
        "GitHub write audit trail is unavailable; no GitHub write was attempted."
      ))
    }
  }

  const writer = options.writer || createGitHubIssueWriter()
  let createdIssue

  try {
    createdIssue = normalizeCreatedIssueResult(await runInjectedWriter(writer, intent), intent)
  } catch (error) {
    const safeError = classifyIssueCreateFailure(error, intent)
    const failureRecorded = await tryRecordAudit(
      auditRecorder,
      intent,
      "failed",
      { code: safeError.code },
      options.now ? options.now() : new Date()
    )

    if (!failureRecorded) {
      return {
        ok: false,
        output: formatGitHubIssueCreateError(issueCreateError(
          "AUDIT_UNAVAILABLE",
          "GitHub issue creation failed and the failure audit record could not be written."
        ))
      }
    }

    return {
      ok: false,
      output: formatGitHubIssueCreateError(safeError)
    }
  }

  try {
    await recordAudit(
      auditRecorder,
      intent,
      "succeeded",
      { issueNumber: createdIssue.number },
      options.now ? options.now() : new Date()
    )
  } catch {
    return {
      ok: false,
      output: formatGitHubIssueCreateError(issueCreateError(
        "AUDIT_UNAVAILABLE",
        "GitHub issue may have been created, but the success audit record could not be written. Inspect the repository and audit trail before retrying."
      ))
    }
  }

  return {
    ok: true,
    output: formatCreatedIssue(intent, createdIssue)
  }
}

export async function handlePreparedGitHubIssueCreateIntent(intent, options = {}) {
  try {
    return await runGitHubIssueCreateIntent(normalizePreparedIssueCreateIntent(intent), options)
  } catch (error) {
    return {
      ok: false,
      output: formatGitHubIssueCreateError(error)
    }
  }
}

export async function handleGitHubIssueCreateCommand(projectId, titleInput, bodyInput = [], options = {}) {
  try {
    const intent = prepareIssueCreateIntent(projectId, titleInput, bodyInput)
    return await runGitHubIssueCreateIntent(intent, options)
  } catch (error) {
    return {
      ok: false,
      output: formatGitHubIssueCreateError(error)
    }
  }
}
