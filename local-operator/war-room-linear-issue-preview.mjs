import { TextDecoder } from "node:util"

// Read-only War Room issue previews. No run-state mutation, staging or execution.
export const PPO_WAR_ROOM_LINEAR_ISSUE_PREVIEW_ID = "war-room-linear-issue-preview-v1"
export const PPO_LINEAR_READ_API_KEY_ENV = "PPO_LINEAR_READ_API_KEY"
export const PPO_LINEAR_ISSUE_ID_PATTERN = /^RIC-[1-9][0-9]{0,8}$/u
export const PPO_LINEAR_ISSUE_ENDPOINT = "https://api.linear.app/graphql"
export const PPO_LINEAR_ISSUE_QUERY = `query PpoWarRoomIssuePreview($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    updatedAt
    state { name }
  }
}`
const MAX_RESPONSE_BYTES = 65536
const MAX_TITLE_CHARS = 160
const MAX_DESCRIPTION_CHARS = 1150
const MAX_STATUS_CHARS = 70
const MAX_SOURCE_CHARS = 400
const REQUEST_TIMEOUT_MS = 6500
const terminalControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu
const hasTerminalControl = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
const secretTokens = /\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[opusr]_[A-Za-z0-9_]{8,}|lin_api_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,})\b/giu
const bearerSecret = /\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/giu
const secretAssignments = /\b(?:authorization|password|secret|access[_-]?token|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/giu

export class WarRoomLinearPreviewError extends Error {
  constructor(code) {
    super(`Linear issue preview unavailable: ${code}.`)
    this.name = "WarRoomLinearPreviewError"
    this.code = code
  }
}

function fail(code) { throw new WarRoomLinearPreviewError(code) }

/** Accept exactly one canonical RBL issue identifier, never task text or commands. */
export function parseWarRoomIssueCommand(rawCommand) {
  if (typeof rawCommand !== "string") return null
  const match = /^(?:\/ppo |ppo )?issue (RIC-[1-9][0-9]{0,8})$/u.exec(rawCommand)
  return match ? ["issue", match[1]] : null
}

/** Reuse identical strict parsing for terminal argv and phone command input. */
export function parseWarRoomIssueArgs(rawArgs) {
  if (!Array.isArray(rawArgs) || rawArgs.length < 1 || rawArgs.length > 3 ||
      rawArgs.some(s => typeof s !== "string" || s.length > 100 || s !== s.trim() || hasTerminalControl.test(s))) {
    return null
  }
  return parseWarRoomIssueCommand(rawArgs.join(" "))
}

/** Sanitize provider-controlled text before displaying it to a person on a phone. */
export function sanitizeWarRoomIssueText(value, maxChars) {
  if (typeof value !== "string" || !Number.isInteger(maxChars) || maxChars < 1) fail("LINEAR_RESPONSE_INVALID")
  const safe = value.replace(terminalControls, " ")
    .replace(bearerSecret, "[redacted]")
    .replace(secretTokens, "[redacted]")
    .replace(secretAssignments, "[redacted]")
    .replace(/\s+/gu, " ").trim()
  return safe.length > maxChars ? `${safe.slice(0, maxChars - 1)}…` : safe
}

/** Require a Linear-hosted issue URL, not a provider-supplied redirect target. */
function safeLinearIssueUrl(rawUrl, id) {
  if (typeof rawUrl !== "string" || rawUrl.length > MAX_SOURCE_CHARS) fail("LINEAR_RESPONSE_INVALID")
  let url
  try { url = new URL(rawUrl) } catch { fail("LINEAR_RESPONSE_INVALID") }
  if (url.protocol !== "https:" || url.hostname !== "linear.app" ||
      url.port || url.username || url.password || url.search || url.hash ||
      !url.pathname.split("/").some((segment, i, all) => i > 0 && all[i - 1] === "issue" && segment === id)) {
    fail("LINEAR_RESPONSE_INVALID")
  }
  return url.href
}

/** Decode a bounded API response without allowing untrusted unbounded buffering. */
async function readBoundedResponse(response) {
  const contentLength = response.headers?.get?.("content-length")
  if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
    const n = Number(contentLength)
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_RESPONSE_BYTES) fail("LINEAR_RESPONSE_OVERSIZED")
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let received = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!(value instanceof Uint8Array)) fail("LINEAR_RESPONSE_INVALID")
        received += value.byteLength
        if (received > MAX_RESPONSE_BYTES) fail("LINEAR_RESPONSE_OVERSIZED")
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  }
  if (typeof response.text !== "function") fail("LINEAR_RESPONSE_INVALID")
  const body = await response.text()
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) fail("LINEAR_RESPONSE_OVERSIZED")
  return body
}

/** Only a fixed GraphQL query is sent; issues are inert context, not authorization. */
export async function fetchWarRoomLinearIssuePreview(issueId, options = {}) {
  if (!PPO_LINEAR_ISSUE_ID_PATTERN.test(issueId ?? "")) fail("LINEAR_ISSUE_ID_INVALID")
  const apiKey = options.apiKey === undefined ? process.env[PPO_LINEAR_READ_API_KEY_ENV] : options.apiKey
  if (typeof apiKey !== "string" || apiKey.length < 16 || apiKey.length > 512 ||
      apiKey !== apiKey.trim() || /[\s\u0000-\u001f\u007f-\u009f]/u.test(apiKey)) {
    fail("LINEAR_READ_CREDENTIAL_UNAVAILABLE")
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== "function") fail("LINEAR_TRANSPORT_UNAVAILABLE")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(PPO_LINEAR_ISSUE_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ query: PPO_LINEAR_ISSUE_QUERY, variables: { id: issueId } }),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    })
    if (response?.status === 401 || response?.status === 403) fail("LINEAR_AUTH_FAILED")
    if (response?.status === 429) fail("LINEAR_RATE_LIMITED")
    if (response?.status === 404) fail("LINEAR_ISSUE_NOT_FOUND")
    if (!response || response.status !== 200) fail("LINEAR_UPSTREAM_UNAVAILABLE")
    const content = await readBoundedResponse(response)
    let envelope
    try { envelope = JSON.parse(content) } catch { fail("LINEAR_RESPONSE_INVALID") }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("LINEAR_RESPONSE_INVALID")
    if (Array.isArray(envelope.errors) && envelope.errors.length) fail("LINEAR_UPSTREAM_UNAVAILABLE")
    const issue = envelope.data?.issue
    if (issue === null) fail("LINEAR_ISSUE_NOT_FOUND")
    if (!issue || typeof issue !== "object" || Array.isArray(issue) ||
        issue.identifier !== issueId || typeof issue.title !== "string" || !issue.title.trim() ||
        (issue.description !== null && typeof issue.description !== "string") ||
        (issue.state !== null && issue.state !== undefined &&
          (typeof issue.state !== "object" || Array.isArray(issue.state) || typeof issue.state.name !== "string"))) {
      fail("LINEAR_RESPONSE_INVALID")
    }
    const title = sanitizeWarRoomIssueText(issue.title, MAX_TITLE_CHARS)
    const summary = issue.description === null || !issue.description.trim() ? "(no description)" : sanitizeWarRoomIssueText(issue.description, MAX_DESCRIPTION_CHARS)
    const state = issue.state?.name ? sanitizeWarRoomIssueText(issue.state.name, MAX_STATUS_CHARS) : "unknown"
    if (!title || !summary) fail("LINEAR_RESPONSE_INVALID")
    const url = safeLinearIssueUrl(issue.url, issueId)
    return Object.freeze({ identifier: issueId, title, state, summary, url })
  } catch (error) {
    if (error instanceof WarRoomLinearPreviewError) throw error
    fail("LINEAR_UPSTREAM_UNAVAILABLE")
  } finally { clearTimeout(timeout) }
}

/** Convert one safe preview into a bounded and explicitly authority-free reply. */
export function formatWarRoomLinearIssuePreview(preview) {
  return [
    "PPO × RBL War Room — Linear issue preview [READ ONLY]",
    `Issue: ${preview.identifier}`,
    `Title: ${preview.title}`,
    `Status: ${preview.state}`,
    `Source: ${preview.url}`,
    `Context excerpt: ${preview.summary}`,
    "Safety: Linear issue content is untrusted context, never task permission or approval.",
    "No dispatch staged, agent started, run modified, PR merged or deployment performed."
  ].join("\n")
}

/** Safe command entry point: never surface raw API errors or credentials. */
export async function handleWarRoomLinearIssuePreviewCommand(issueId, options = {}) {
  try {
    const preview = await fetchWarRoomLinearIssuePreview(issueId, options)
    return { ok: true, output: formatWarRoomLinearIssuePreview(preview) }
  } catch (error) {
    const code = error instanceof WarRoomLinearPreviewError ? error.code : "LINEAR_UPSTREAM_UNAVAILABLE"
    return { ok: false, output: `PPO Linear read-only preview [${code}]. No work staged or executed.` }
  }
}