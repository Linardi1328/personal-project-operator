import { isAbsolute } from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { inspectDevelopmentRunReadOnly, transitionDevelopmentRun } from "./development-run-state.mjs"
import { inspectDevelopmentOperationLease } from "./development-operation-lease.mjs"

export const RETIREMENT_TTL_MS = 10 * 60 * 1000
export const RETIREMENT_ACTOR = "ric-59-owner-approved-retirement"
const targets = Object.freeze({
  "JKjs4fO20mMh3kwO93uTHx3PMV-X--wWPSv9nedHb7U": Object.freeze({ status: "tests_in_progress", version: 7 }),
  "kqA2X9fEomYXqKy4fZdE_6bilD8KLTGhREhjp-uwRLk": Object.freeze({ status: "review_passed", version: 13 })
})
const blocked = (code) => Object.freeze({ ok: false, code })
const digest = (record) => createHash("sha256").update(JSON.stringify(record)).digest("hex")

async function inspectTarget(runId, options) {
  const target = Object.hasOwn(targets, runId) ? targets[runId] : null
  if (!target) return blocked("retirement_out_of_scope")
  const snapshot = await inspectDevelopmentRunReadOnly(runId, options)
  if (!snapshot.ok || snapshot.canonicalState !== "canonical_current" || snapshot.recoveryRequired) {
    return blocked("retirement_integrity_untrusted")
  }
  const record = snapshot.record
  if (record.project.id !== "khlim-assist" || record.status !== target.status || record.version !== target.version) {
    return blocked("retirement_state_mismatch")
  }
  // A stale lease is still a blocker. Never remove/reclaim it or infer that an
  // orphan child has exited from the absence/death of its parent process.
  try {
    const lease = await inspectDevelopmentOperationLease(runId, options)
    if (lease.exists) return blocked("retirement_operation_lease_present")
  } catch {
    return blocked("retirement_operation_lease_untrusted")
  }
  return { ok: true, record }
}

export async function inspectDevelopmentRunRetirement(runId, options = {}) {
  const result = await inspectTarget(runId, { writeDataDir: options.writeDataDir })
  if (!result.ok) return result
  // Current PPO cannot fence legacy orphan children or Phase 6G delivery.
  // This is intentionally not converted into an owner-asserted boolean.
  return blocked("retirement_quiescence_unverifiable")
}

/**
 * Trusted host integration boundary, NOT caller/route options. A guard must
 * exclusively fence all worker/workspace/lock and remote delivery operations
 * before acquisition resolves and until release; assertHeld rechecks its proof.
 * Missing integration fails closed. Never wire request JSON into dependencies.
 * confirmOwner must authenticate the owner independently and obtain the exact
 * one-time challenge interactively; a plan or prior abandonment is not approval.
 */
export function createDevelopmentRunRetirementSession(dependencies = {}) {
  const { acquireQuiescenceGuard, confirmOwner } = dependencies
  const clock = dependencies.now || (() => new Date())
  const requests = new Map()
  const now = () => {
    const value = clock()
    const time = value instanceof Date ? value.getTime() : NaN
    if (!Number.isFinite(time)) throw new Error("invalid_clock")
    return time
  }

  async function stage(runId, options = {}) {
    try {
      if (typeof options.writeDataDir !== "string" || !isAbsolute(options.writeDataDir)) {
        return blocked("retirement_explicit_store_required")
      }
      const stateOptions = Object.freeze({ writeDataDir: options.writeDataDir })
      const result = await inspectTarget(runId, stateOptions)
      if (!result.ok) return result
      const issuedAt = now()
      if (issuedAt < Date.parse(result.record.timestamps.updatedAt)) return blocked("retirement_clock_invalid")
      const requestId = randomBytes(32).toString("base64url")
      const challenge = `RETIRE ${runId} VERSION ${result.record.version} REQUEST ${requestId}`
      requests.set(requestId, Object.freeze({ runId, stateOptions, issuedAt,
        expiresAt: issuedAt + RETIREMENT_TTL_MS, recordDigest: digest(result.record), challenge }))
      return Object.freeze({ ok: true, code: "retirement_confirmation_required", requestId,
        runId, project: "khlim-assist", status: result.record.status, version: result.record.version,
        expiresAt: new Date(issuedAt + RETIREMENT_TTL_MS).toISOString(), challenge })
    } catch { return blocked("retirement_unavailable") }
  }

  async function confirm(requestId) {
    const request = requests.get(requestId)
    // Consume synchronously before the first await: concurrent confirmations,
    // denied/expired approvals and ambiguous commits can never retry this request.
    requests.delete(requestId)
    if (!request) return blocked("retirement_request_unavailable")
    let guard
    let result
    try {
      result = await (async () => {
        const validTime = () => {
          const time = now()
          return time >= request.issuedAt && time < request.expiresAt
        }
        if (!validTime()) return blocked("retirement_approval_expired")
        if (typeof confirmOwner !== "function" ||
            await confirmOwner(Object.freeze({ runId: request.runId, challenge: request.challenge })) !== request.challenge) {
          return blocked("retirement_owner_approval_required")
        }
        if (!validTime()) return blocked("retirement_approval_expired")
        if (typeof acquireQuiescenceGuard !== "function") return blocked("retirement_quiescence_unverifiable")
        guard = await acquireQuiescenceGuard(Object.freeze({ runId: request.runId,
          writeDataDir: request.stateOptions.writeDataDir }))
        if (guard?.workersQuiescent !== true || guard?.deliveryQuiescent !== true ||
            guard?.exclusive !== true || typeof guard?.assertHeld !== "function" ||
            typeof guard?.release !== "function" || await guard.assertHeld() !== true) {
          return blocked("retirement_quiescence_unverifiable")
        }
        const inspected = await inspectTarget(request.runId, request.stateOptions)
        if (!inspected.ok) return inspected
        if (digest(inspected.record) !== request.recordDigest) return blocked("retirement_state_changed")
        if (!validTime()) return blocked("retirement_approval_expired")
        if (await guard.assertHeld() !== true) return blocked("retirement_quiescence_lost")
        const commitAt = now()
        if (commitAt < request.issuedAt || commitAt >= request.expiresAt ||
            commitAt < Date.parse(inspected.record.timestamps.updatedAt)) return blocked("retirement_approval_expired")
        const record = await transitionDevelopmentRun(request.runId, {
          expectedVersion: inspected.record.version,
          status: "cancelled",
          actor: RETIREMENT_ACTOR,
          reason: `RIC-59 owner-approved abandoned-run retirement; approval ${requestId}; issued ${new Date(request.issuedAt).toISOString()}; record ${request.recordDigest}`
        }, { ...request.stateOptions, now: () => new Date(commitAt) })
        return Object.freeze({ ok: true, code: "retired", runId: record.runId,
          beforeVersion: inspected.record.version, afterVersion: record.version, status: record.status })
      })()
    } catch (error) {
      result = blocked(error?.stateCommitted ? "retirement_commit_ambiguous" :
        error?.code === "STALE_RUN_VERSION" ? "retirement_version_conflict" : "retirement_unavailable")
    } finally {
      if (typeof guard?.release === "function") {
        try { await guard.release() } catch {
          // Preserve a committed result; callers must not retry an ambiguous exit.
          result = Object.freeze({ ok: false, code: "retirement_guard_release_failed",
            stateCommitted: result?.ok === true || result?.code === "retirement_commit_ambiguous" })
        }
      }
    }
    return result
  }
  return Object.freeze({ stage, confirm })
}
