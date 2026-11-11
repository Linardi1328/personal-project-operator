import { remotePayloadDigest, verifyRemoteEnvelope } from "./software-factory-remote-contract.mjs"
import { createOfflineDurableClaimLedger } from "./software-factory-remote-durable-ledger.mjs"
import { preflightOfflineAssignment } from "./war-room-assignment-preflight.mjs"

// RIC-150: deliberately unconnected to CLI, Telegram, Mac/VPS, workers or the
// canonical PPO run-state transition API. This writes only synthetic test data.
export const WAR_ROOM_OFFLINE_STAGING_ID = "war-room-offline-staging-proof-v1"

export class OfflineAssignmentStagingError extends Error {
  constructor(code) {
    super("Offline assignment staging rejected: " + code + ".")
    this.name = "OfflineAssignmentStagingError"
    this.code = code
  }
}

/** Reject misconfigured or contradictory test authorities with safe error codes. */
function fail(code) { throw new OfflineAssignmentStagingError(code) }

/**
 * Snapshot both trusted configurations BEFORE awaiting external fixture hooks.
 * The shared role selector must be synchronous: Phase 1D awaits it, while the
 * Phase 1C ledger deliberately uses a synchronous role callback.
 *
 * A later mutation to either original config rejects staging. A frozen snapshot
 * also ensures that no temporary mix of old and new callback authorities can
 * be used to create a reservation.
 */
function validateConfig(config) {
  const preflight = config?.preflight
  const ledger = config?.ledger
  if (config?.mode !== "offline-staging-proof-only" ||
      preflight?.mode !== "offline-preflight-only" ||
      ledger?.mode !== "offline-durable-proof-only" ||
      !preflight.coordinatorPublicKey ||
      preflight.coordinatorPublicKey !== ledger.coordinatorPublicKey ||
      typeof preflight.now !== "function" || preflight.now !== ledger.now ||
      typeof preflight.readRun !== "function" || preflight.readRun !== ledger.readRun ||
      typeof preflight.resolveRole !== "function" ||
      preflight.resolveRole !== ledger.resolveRole ||
      !Array.isArray(preflight.approvedProjects) ||
      preflight.approvedProjects !== ledger.approvedProjects) {
    fail("STAGING_CONFIGURATION_INVALID")
  }

  const originalPreflight = { ...preflight }
  const originalLedger = { ...ledger }
  const approved = Object.freeze([...preflight.approvedProjects])
  const resolveRole = run => {
    const role = originalPreflight.resolveRole(run)
    if (role !== null && typeof role === "object" && typeof role.then === "function") {
      // Prevent unhandled rejections from an erroneously async fixture.
      Promise.resolve(role).catch(() => {})
      fail("STAGING_ROLE_ASYNC_UNSUPPORTED")
    }
    return role
  }
  const common = { approvedProjects: approved, resolveRole }
  const trustedPreflight = Object.freeze({ ...originalPreflight, ...common })
  const trustedLedger = Object.freeze({ ...originalLedger, ...common })

  /** Reject any injected-configuration replacement, including in-place allowlist edits. */
  function unchanged() {
    if (config.mode !== "offline-staging-proof-only" ||
        config.preflight !== preflight || config.ledger !== ledger) {
      fail("STAGING_CONFIGURATION_DRIFT")
    }
    for (const [actual, original] of [
      [preflight, originalPreflight], [ledger, originalLedger]
    ]) {
      if (Object.keys(actual).length !== Object.keys(original).length ||
          Object.keys(original).some(key => actual[key] !== original[key])) {
        fail("STAGING_CONFIGURATION_DRIFT")
      }
    }
    const current = preflight.approvedProjects
    if (current.length !== approved.length ||
        current.some((value, index) => value !== approved[index])) {
      fail("STAGING_CONFIGURATION_DRIFT")
    }
  }

  return Object.freeze({ preflight: trustedPreflight, ledger: trustedLedger, unchanged })
}

/** Verify exact durable reservation identity, never trusting an unbound marker. */
function assertSameReservation(result, before, requestHash) {
  if (!result || result.runId !== before.runId ||
      result.expectedVersion !== before.expectedVersion ||
      result.requestHash !== requestHash ||
      result.releaseAuthorized !== false) {
    fail("STAGING_RESERVATION_MISMATCH")
  }
}

/**
 * Re-read the authoritative run AFTER the second owner-approval callback and
 * final ledger inspection. This only narrows the race; it is not an atomic
 * transaction and must never be used as live dispatch authorization.
 */
async function assertLatestCanonicalRun(preflight, payload) {
  let run
  try { run = await preflight.readRun(payload.runId) }
  catch { fail("STAGING_RUN_UNAVAILABLE") }
  if (!run || run.runId !== payload.runId ||
      run.version !== payload.expectedVersion ||
      run.status !== "implementation_in_progress" ||
      run.project?.id !== payload.projectId ||
      run.branch !== payload.branch ||
      run.baseSha !== payload.baseSha ||
      run.headSha !== payload.headSha) {
    fail("STAGING_RUN_STALE")
  }
  let role
  try { role = preflight.resolveRole(run) }
  catch { fail("STAGING_ROLE_UNAVAILABLE") }
  if (role !== payload.capability ||
      (role === "implementation.backend" && payload.workerId !== "codex") ||
      (role === "implementation.frontend" && payload.workerId !== "antigravity")) {
    fail("STAGING_ROLE_STALE")
  }
}

/**
 * Synthetic staging: preflight -> durable reservation -> fresh preflight ->
 * durable inspection -> final run read. Any failure after reservation keeps
 * the append-only tombstone; NEVER retry, delete, claim or authorize execution.
 */
export async function stageOfflineAssignment(signed, config) {
  const trusted = validateConfig(config)
  let payload
  try {
    payload = verifyRemoteEnvelope(signed, "ppo-control-plane", trusted.preflight.coordinatorPublicKey)
  } catch {
    fail("STAGING_SIGNED_REQUEST_INVALID")
  }
  const stable = Object.freeze({
    signerId: "ppo-control-plane",
    payload,
    signature: signed.signature
  })
  const requestHash = remotePayloadDigest(payload)
  // Constructing the ledger checks configuration but does not touch disk.
  const ledger = createOfflineDurableClaimLedger(trusted.ledger)

  const before = await preflightOfflineAssignment(stable, trusted.preflight)
  trusted.unchanged()
  if (before.requestId !== payload.requestId ||
      before.runId !== payload.runId ||
      before.expectedVersion !== payload.expectedVersion ||
      before.sourceRevisionHash !== payload.taskSource.revisionHash ||
      before.canExecute !== false || before.releaseAuthorized !== false) {
    fail("STAGING_PREFLIGHT_MISMATCH")
  }

  const reserved = await ledger.reserve(stable)
  trusted.unchanged()
  assertSameReservation(reserved, before, requestHash)
  if (reserved.outcome !== "reserved") fail("STAGING_RESERVATION_MISMATCH")

  const after = await preflightOfflineAssignment(stable, trusted.preflight)
  trusted.unchanged()
  if (after.requestId !== before.requestId ||
      after.runId !== before.runId ||
      after.expectedVersion !== before.expectedVersion ||
      after.sourceRevisionHash !== before.sourceRevisionHash ||
      after.canExecute !== false || after.releaseAuthorized !== false) {
    fail("STAGING_PREFLIGHT_MISMATCH")
  }
  const inspected = await ledger.inspect(before.runId, before.expectedVersion)
  assertSameReservation(inspected, before, requestHash)
  if (inspected.reserved !== true) fail("STAGING_RESERVATION_MISMATCH")

  await assertLatestCanonicalRun(trusted.preflight, payload)
  trusted.unchanged()
  return Object.freeze({
    outcome: "staged-offline",
    requestId: before.requestId,
    requestHash,
    runId: before.runId,
    expectedVersion: before.expectedVersion,
    sourceRevisionHash: before.sourceRevisionHash,
    canExecute: false,
    releaseAuthorized: false
  })
}
