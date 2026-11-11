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
 * Ensure both proofs use one injected PPO authority rather than independent
 * clocks, signing keys, run readers, role selectors or project allowlists.
 * These references are trusted synthetic fixtures, NOT production identity.
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
}

/** Verify the two exact reservation identities and keep inert result fields only. */
function assertSameReservation(result, before, requestHash) {
  if (!result || result.runId !== before.runId ||
      result.expectedVersion !== before.expectedVersion ||
      result.requestHash !== requestHash ||
      result.releaseAuthorized !== false) {
    fail("STAGING_RESERVATION_MISMATCH")
  }
}

/**
 * Synthetic staging: preflight -> durable reservation -> fresh preflight ->
 * durable inspection. Post-reservation denial leaves an immutable tombstone:
 * NEVER delete, retry or treat it as authorization for an agent to execute.
 */
export async function stageOfflineAssignment(signed, config) {
  validateConfig(config)
  // Pin a verified, immutable payload before crossing any async fixture hook;
  // caller mutation cannot swap the request between checks and reservation.
  let payload
  try {
    payload = verifyRemoteEnvelope(signed, "ppo-control-plane", config.preflight.coordinatorPublicKey)
  } catch {
    fail("STAGING_SIGNED_REQUEST_INVALID")
  }
  const stable = Object.freeze({
    signerId: "ppo-control-plane",
    payload,
    signature: signed.signature
  })
  const requestHash = remotePayloadDigest(payload)

  const before = await preflightOfflineAssignment(stable, config.preflight)
  if (before.requestId !== payload.requestId ||
      before.runId !== payload.runId ||
      before.expectedVersion !== payload.expectedVersion ||
      before.sourceRevisionHash !== payload.taskSource.revisionHash ||
      before.canExecute !== false || before.releaseAuthorized !== false) {
    fail("STAGING_PREFLIGHT_MISMATCH")
  }

  // The real merged ledger, not a mock callback, owns the append-only
  // reservation. Any ambiguous failure keeps the version occupied.
  const ledger = createOfflineDurableClaimLedger(config.ledger)
  const reserved = await ledger.reserve(stable)
  assertSameReservation(reserved, before, requestHash)
  if (reserved.outcome !== "reserved") fail("STAGING_RESERVATION_MISMATCH")

  // Re-read issue, approval, catalog, WIP, reviewed repository and canonical
  // state after the reservation. This is NOT an atomic production WIP gate.
  const after = await preflightOfflineAssignment(stable, config.preflight)
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
