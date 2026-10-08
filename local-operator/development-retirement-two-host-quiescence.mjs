import { randomBytes } from "node:crypto"
import { isAbsolute } from "node:path"

// Contract-only coordination. No host adapter is installed or constructed here.
// An injected authority is NOT an attestation: trusted, reviewed host adapters
// must enforce each port's claims before any production wiring is considered.
export const RETIREMENT_QUIESCENCE_PORT_ORDER = Object.freeze([
  "writer", "mac", "vps", "delivery"
])

const TARGET_RUN_IDS = new Set([
  "JKjs4fO20mMh3kwO93uTHx3PMV-X--wWPSv9nedHb7U",
  "kqA2X9fEomYXqKy4fZdE_6bilD8KLTGhREhjp-uwRLk"
])

export class RetirementQuiescenceUnavailableError extends Error {
  constructor() {
    super("retirement_quiescence_unverifiable")
    this.name = "RetirementQuiescenceUnavailableError"
    this.code = "RETIREMENT_QUIESCENCE_UNVERIFIABLE"
  }
}

function unavailable() {
  return new RetirementQuiescenceUnavailableError()
}

function validLease(lease, role, context) {
  return lease && typeof lease === "object" && !Array.isArray(lease) &&
    lease.role === role &&
    lease.runId === context.runId &&
    lease.writeDataDir === context.writeDataDir &&
    lease.epoch === context.epoch &&
    lease.exclusive === true && lease.quiescent === true &&
    Array.isArray(lease.unknownOperations) && lease.unknownOperations.length === 0 &&
    typeof lease.assertHeld === "function" && typeof lease.release === "function"
}

/**
 * Internal coordination contract for a FUTURE authenticated host integration.
 *
 * port.acquire(context) must atomically establish and KEEP an exclusive fence
 * on the writer set, Mac, VPS, or GitHub delivery before returning its lease.
 * The writer fence MUST exclude all concurrent canonical-state writers and
 * any route able to dispatch new work on either host. Host leases MUST account
 * for legacy children, workspace locks and queued operations. The delivery
 * lease MUST fence remote Phase 6G pushes/PR/merges. No port is supplied here.
 *
 * A plain object implementing this contract is only useful in fixture tests;
 * it is NOT proof that a remote host is authenticated or actually fenced.
 * Never construct these ports from CLI, chat, environment assertions or JSON.
 */
export function createTwoHostRetirementQuiescenceCoordinator(ports = {}) {
  let inUse = false
  let poisoned = false

  async function acquireQuiescenceGuard(input) {
    if (poisoned || inUse ||
        !TARGET_RUN_IDS.has(input?.runId) ||
        typeof input.writeDataDir !== "string" ||
        !isAbsolute(input.writeDataDir) ||
        RETIREMENT_QUIESCENCE_PORT_ORDER.some(role => typeof ports[role]?.acquire !== "function")) {
      throw unavailable()
    }

    // This protects the coordinator within one process. Real interprocess and
    // cross-host exclusion MUST be provided by the trusted writer port.
    inUse = true
    const context = Object.freeze({
      runId: input.runId,
      writeDataDir: input.writeDataDir,
      epoch: randomBytes(32).toString("base64url")
    })
    const acquired = []

    async function releaseAll() {
      let failed = false
      for (const { lease } of [...acquired].reverse()) {
        if (typeof lease?.release !== "function") {
          failed = true
          continue
        }
        try {
          await lease.release(context)
        } catch {
          failed = true
        }
      }
      if (failed) poisoned = true
      else inUse = false
      if (failed) throw unavailable()
    }

    async function held() {
      if (poisoned || !inUse) return false
      for (const { role, lease } of acquired) {
        if (!validLease(lease, role, context)) return false
        try {
          if (await lease.assertHeld(context) !== true) return false
        } catch {
          return false
        }
      }
      return acquired.length === RETIREMENT_QUIESCENCE_PORT_ORDER.length
    }

    try {
      for (const role of RETIREMENT_QUIESCENCE_PORT_ORDER) {
        const lease = await ports[role].acquire(context)
        // Hold even an invalid returned lease for cleanup, not authorization.
        acquired.push({ role, lease })
        if (!validLease(lease, role, context)) throw unavailable()
      }
      if (!(await held())) throw unavailable()
    } catch {
      // On incomplete cleanup poison the coordinator; never treat cleanup
      // uncertainty as free capacity. No data or sensitive exception is logged.
      try { await releaseAll() } catch { /* still blocked */ }
      throw unavailable()
    }

    let released = false
    let closing = false

    return Object.freeze({
      workersQuiescent: true,
      deliveryQuiescent: true,
      exclusive: true,
      async assertHeld() {
        if (released || closing) return false
        return await held()
      },
      async release() {
        if (released || closing) throw unavailable()
        closing = true
        try {
          await releaseAll()
          released = true
        } finally {
          // Failed release poisons the coordinator and cannot be retried.
          closing = false
        }
      }
    })
  }

  return Object.freeze({ acquireQuiescenceGuard })
}
