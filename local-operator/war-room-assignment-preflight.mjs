import { createHash } from "node:crypto"
import { remotePayloadDigest, verifyRemoteEnvelope } from "./software-factory-remote-contract.mjs"

// RIC-146: offline, read-only admission proof. Deliberately NOT wired to CLI,
// Telegram, a worker, a durable claim store, or a PPO run-state transition.
export const WAR_ROOM_ASSIGNMENT_PREFLIGHT_ID = "war-room-assignment-preflight-v1"
const ISSUE_ID = /^RIC-[1-9][0-9]{0,8}$/u
const PROJECT_ID = /^[a-z][a-z0-9-]{0,63}$/u
const MAX_ISSUE_BYTES = 32768
const ROLE_WORKER = Object.freeze({
  "implementation.backend": "codex",
  "implementation.frontend": "antigravity"
})

export class OfflineAssignmentPreflightError extends Error {
  constructor(code) {
    super(`Offline assignment preflight rejected: ${code}.`)
    this.name = "OfflineAssignmentPreflightError"
    this.code = code
  }
}

/** Fail with stable metadata-only codes, never leaking a provider error or issue text. */
function fail(code) { throw new OfflineAssignmentPreflightError(code) }

/**
 * Hash exact raw source fields in a defined order; presentation sanitation
 * must never silently change the revision bound into a signed dispatch request.
 * The issue body is UNTRUSTED context and is never interpreted as permissions.
 */
export function linearIssueRevisionHash(issue) {
  if (!issue || typeof issue !== "object" || Array.isArray(issue) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(issue)) ||
      !ISSUE_ID.test(issue.identifier ?? "") ||
      typeof issue.title !== "string" || !issue.title.trim() ||
      typeof issue.description !== "string" ||
      typeof issue.updatedAt !== "string" ||
      Number.isNaN(Date.parse(issue.updatedAt)) ||
      new Date(Date.parse(issue.updatedAt)).toISOString() !== issue.updatedAt) {
    fail("PREFLIGHT_ISSUE_INVALID")
  }
  const wire = JSON.stringify([
    "ppo-linear-issue-revision-v1",
    issue.identifier, issue.title, issue.description, issue.updatedAt
  ])
  if (Buffer.byteLength(wire, "utf8") > MAX_ISSUE_BYTES) fail("PREFLIGHT_ISSUE_OVERSIZED")
  return createHash("sha256").update(wire).digest("hex")
}

/** Treat failure or ambiguity in an injected trusted read as denial. */
async function trustedRead(callback, ...args) {
  try { return await callback(...args) }
  catch { fail("PREFLIGHT_TRUSTED_READ_UNAVAILABLE") }
}

/** Require an injected fixed clock; no host or remote-time trust is implied. */
function checkedNow(now) {
  let value
  try { value = now() } catch { fail("PREFLIGHT_CLOCK_INVALID") }
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(timestamp)) fail("PREFLIGHT_CLOCK_INVALID")
  return timestamp
}

/**
 * Evaluate one signed, synthetic assignment preflight without reserving,
 * approving, claiming, executing, changing PPO state or creating authority.
 * All callbacks MUST be trusted PPO-side fixtures, never values from a chat.
 */
export async function preflightOfflineAssignment(signed, config) {
  const callbackNames = [
    "now", "readRun", "resolveRole", "readRepo", "readIssue",
    "resolveIssueProject", "verifyOwnerApproval", "readCatalogAdmission",
    "listActiveProjects"
  ]
  if (!config || config.mode !== "offline-preflight-only" ||
      !config.coordinatorPublicKey ||
      !Array.isArray(config.approvedProjects) ||
      config.approvedProjects.length === 0 ||
      config.approvedProjects.some(p => !PROJECT_ID.test(p)) ||
      new Set(config.approvedProjects).size !== config.approvedProjects.length ||
      callbackNames.some(name => typeof config[name] !== "function")) {
    fail("PREFLIGHT_CONFIGURATION_INVALID")
  }

  let p
  try { p = verifyRemoteEnvelope(signed, "ppo-control-plane", config.coordinatorPublicKey) }
  catch { fail("PREFLIGHT_SIGNED_REQUEST_INVALID") }
  if (p.kind !== "dispatch-request" || !ISSUE_ID.test(p.taskSource.issueId)) fail("PREFLIGHT_REQUEST_INVALID")

  const now = checkedNow(config.now)
  if (now < Date.parse(p.issuedAt) - 60000 || now >= Date.parse(p.expiresAt)) fail("PREFLIGHT_EXPIRED")
  if (!config.approvedProjects.includes(p.projectId)) fail("PREFLIGHT_PROJECT_DENIED")

  const run = await trustedRead(config.readRun, p.runId)
  if (!run || run.runId !== p.runId || run.version !== p.expectedVersion ||
      run.status !== "implementation_in_progress" ||
      run.project?.id !== p.projectId || run.branch !== p.branch ||
      run.baseSha !== p.baseSha || run.headSha !== p.headSha) fail("PREFLIGHT_RUN_STALE")
  const role = await trustedRead(config.resolveRole, run)
  if (role !== p.capability || ROLE_WORKER[role] !== p.workerId) fail("PREFLIGHT_ROLE_MISMATCH")

  const issue = await trustedRead(config.readIssue, p.taskSource.issueId)
  const issueHash = linearIssueRevisionHash(issue)
  if (issue.identifier !== p.taskSource.issueId || issueHash !== p.taskSource.revisionHash) {
    fail("PREFLIGHT_ISSUE_STALE")
  }
  // Project mapping is trusted PPO policy, never a project label in the Linear body.
  const issueProject = await trustedRead(config.resolveIssueProject, issue.identifier)
  if (issueProject !== p.projectId) fail("PREFLIGHT_ISSUE_PROJECT_MISMATCH")

  const repo = await trustedRead(config.readRepo, p.projectId)
  if (!repo || repo.projectId !== p.projectId || repo.branch !== p.branch ||
      repo.baseSha !== p.baseSha || repo.headSha !== p.headSha ||
      repo.reviewedCanonicalPath !== true || repo.isolatedWorktree !== true) {
    fail("PREFLIGHT_REPOSITORY_UNTRUSTED")
  }

  // Catalog and lane admission must be independently supplied by PPO's owner,
  // not inferred from the issue or claimed by the signed request.
  const admission = await trustedRead(config.readCatalogAdmission)
  if (!admission || admission.valid !== true) fail("PREFLIGHT_CATALOG_BLOCKED")
  const active = await trustedRead(config.listActiveProjects)
  if (!Array.isArray(active) || active.some(id => !PROJECT_ID.test(id)) ||
      new Set(active).size !== active.length || active.length > 2 ||
      (active.length === 2 && !active.includes(p.projectId))) fail("PREFLIGHT_WIP_BLOCKED")

  const requestHash = remotePayloadDigest(p)
  const ownerApproved = await trustedRead(config.verifyOwnerApproval, Object.freeze({
    requestId: p.requestId, requestHash, runId: p.runId,
    expectedVersion: p.expectedVersion, issueId: issue.identifier,
    issueHash, approvalId: p.approval.approvalId, ownerId: p.approval.ownerId
  }))
  if (ownerApproved !== true) fail("PREFLIGHT_APPROVAL_REQUIRED")

  // No envelope, permit, path, owner token or agent instruction is returned.
  return Object.freeze({
    preflightPassed: true, requestId: p.requestId, runId: p.runId,
    expectedVersion: p.expectedVersion, sourceRevisionHash: issueHash,
    canExecute: false, releaseAuthorized: false
  })
}
