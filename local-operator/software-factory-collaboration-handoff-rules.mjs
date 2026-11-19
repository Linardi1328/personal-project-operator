import { SOFTWARE_FACTORY_COLLABORATION_MAX_FINDINGS, collaborationDeepFreeze, collaborationError } from "./software-factory-collaboration-contract.mjs"

// RIC-181 reusable handoff rules. Pure functions only.
//
// This module is part of the reusable collaboration contract layer. It owns no
// state, performs no I/O, and has no notion of a run lifecycle, a dispatcher, a
// store, a checkpoint file or a release mechanism. A future coordinator (the
// existing autonomous runner and development-continue path) would call these
// functions to decide whether one untrusted handoff message is acceptable for the
// run context it already owns. Nothing here grants authority.

const shaPattern = /^[a-f0-9]{40}$/u

// ---------------------------------------------------------------------------
// Run-context checks

/**
 * Check one schema-valid envelope against the run context the caller already
 * trusts. Throws a fixed collaboration error on the first mismatch. The order is
 * part of the contract: binding, then checkpoint, then exact version, then plan,
 * scope and base, then the outstanding assignment.
 *
 * run: {
 *   projectId, runId, correlationId, runVersion, planHash, scopeDigest, baseSha,
 *   checkpointReason,   // string when the run is checkpointed, otherwise null
 *   expected            // { providerId, role, stepId, attemptNumber, messageType } or null
 * }
 */
export function assessCollaborationEnvelopeContext(envelope, run) {
  if (envelope.projectId !== run.projectId) throw collaborationError("COLLAB_WRONG_PROJECT", "Message is bound to a different project.")
  if (envelope.runId !== run.runId) throw collaborationError("COLLAB_WRONG_RUN", "Message is bound to a different run.")
  if (envelope.correlationId !== run.correlationId) throw collaborationError("COLLAB_WRONG_CORRELATION", "Message belongs to a different collaboration chain.")
  if (run.checkpointReason) throw collaborationError("COLLAB_RUN_CHECKPOINTED", `Run is checkpointed (${run.checkpointReason}).`)
  if (envelope.expectedRunVersion !== run.runVersion) throw collaborationError("COLLAB_STALE_RUN_VERSION", "Message was built against a different run version.")
  if (envelope.planHash !== run.planHash) throw collaborationError("COLLAB_PLAN_MISMATCH", "Message is bound to a different approved plan.")
  if (envelope.scopeDigest !== run.scopeDigest) throw collaborationError("COLLAB_SCOPE_MISMATCH", "Message is bound to a different approved scope.")
  if (envelope.baseSha !== run.baseSha) throw collaborationError("COLLAB_BASE_MISMATCH", "Message is bound to a different base SHA.")

  const expected = run.expected
  if (!expected) throw collaborationError("COLLAB_OUT_OF_ORDER", "No handoff is currently expected.")
  if (envelope.sender.providerId !== expected.providerId || envelope.sender.role !== expected.role) {
    throw collaborationError("COLLAB_SENDER_NOT_ASSIGNED", "Sender was not assigned to this step.")
  }
  if (envelope.stepId !== expected.stepId || envelope.attemptNumber !== expected.attemptNumber) {
    throw collaborationError("COLLAB_OUT_OF_ORDER", "Message step or attempt is not the one currently expected.")
  }

  const isStatusMessage = envelope.messageType === "provider_unavailable" || envelope.messageType === "task_blocked"
  if (!isStatusMessage && envelope.messageType !== expected.messageType) {
    throw collaborationError("COLLAB_OUT_OF_ORDER", "Message type is not the one currently expected.")
  }
  return true
}

export function assertCollaborationCandidateIsNew(candidateSha, knownCandidates) {
  if (knownCandidates.has(candidateSha)) {
    throw collaborationError("COLLAB_CANDIDATE_REPLAYED", "Candidate SHA was already seen; stale or replayed heads are rejected.")
  }
  return true
}

/** A contract_ready message must carry contract evidence for the digest it declares. */
export function assertContractEvidenceMatchesDigest(envelope) {
  const evidence = envelope.evidence.find((entry) => entry.kind === "contract")
  if (!evidence || evidence.digest !== envelope.contractDigest) {
    throw collaborationError("COLLAB_CONTRACT_INVALID", "Contract evidence does not match the declared contract digest.")
  }
  return evidence
}

/**
 * Decide how an implementation message relates to the frozen contract.
 * Returns { changed: false } or { changed: true, evidence }. A frontend built on a
 * different digest, or a backend change with no matching contract evidence, throws.
 */
export function assessImplementationContract(envelope, area, currentContractDigest) {
  if (envelope.contractDigest === currentContractDigest) return { changed: false, evidence: null }
  if (area === "frontend") {
    throw collaborationError("COLLAB_CONTRACT_MISMATCH", "Frontend candidate was built against a different API contract.")
  }
  const evidence = envelope.evidence.find((entry) => entry.kind === "contract" && entry.digest === envelope.contractDigest)
  if (!evidence) {
    throw collaborationError("COLLAB_CONTRACT_INVALID", "A changed contract needs contract evidence matching its declared digest.")
  }
  return { changed: true, evidence }
}

export function assertReviewerIndependent(reviewerProviderId, implementerProviderIds) {
  if (implementerProviderIds.has(reviewerProviderId)) {
    throw collaborationError("COLLAB_REVIEW_NOT_INDEPENDENT", "The reviewer also implemented this candidate.")
  }
  return true
}

// ---------------------------------------------------------------------------
// Finding accountability ledger
//
// Every finding a reviewer raises stays accounted for until the independent
// reviewer explicitly resolves it. A finding moves:
//   open -> addressed   when an implementation for its area is accepted
//   addressed -> resolved   only when a later review names the code in resolvedFindings
// "noted" is a non-blocking P2/P3 remark made on an approving review.
// A reviewer cannot resolve a finding nobody has addressed, cannot resolve an
// unknown code, and cannot approve while any finding is still open or addressed.
// These are claims by untrusted models; the ledger is what the run trusts.

export function createFindingLedger() {
  return Object.freeze([])
}

function entryOf(finding, reviewNumber) {
  return Object.freeze({
    code: finding.code,
    severity: finding.severity,
    area: finding.area,
    summary: finding.summary,
    status: "open",
    openedInReview: reviewNumber,
    reopenedCount: 0,
    addressedAt: null,
    resolvedAt: null,
    history: Object.freeze([])
  })
}

// A reopened finding keeps what it was before. The snapshot is appended, never replaced.
function dispositionSnapshot(entry) {
  return Object.freeze({
    status: entry.status,
    severity: entry.severity,
    summary: entry.summary,
    addressedAt: entry.addressedAt,
    resolvedAt: entry.resolvedAt
  })
}

export function assertFindingsAccountedFor(ledger) {
  const unresolved = ledger.filter((entry) => entry.status === "open" || entry.status === "addressed")
  if (unresolved.length > 0) {
    throw collaborationError(
      "COLLAB_FINDINGS_UNRESOLVED",
      `Findings still need explicit resolution: ${unresolved.map((entry) => entry.code).join(", ")}.`
    )
  }
  return true
}

/**
 * Apply one accepted-in-principle review message to the ledger and return the
 * next ledger. Throws without producing a ledger if the review is not coherent
 * with the findings already on record. `reviewNumber` is 1 for the first review.
 */
export function applyCollaborationReview(ledger, envelope, reviewNumber) {
  const byCode = new Map(ledger.map((entry) => [entry.code, entry]))
  const next = new Map(byCode)

  // Validate every raised finding against the ledger before anything is applied, so a
  // rejected review can never leave a partially updated ledger.
  for (const finding of envelope.findings) {
    const existing = byCode.get(finding.code)
    if (!existing) continue
    // A finding code has one owner for the whole run. Ownership is never transferred.
    if (existing.area !== finding.area) {
      throw collaborationError("COLLAB_FINDING_AREA_CONFLICT", `Finding ${finding.code} belongs to the ${existing.area} area and cannot be reused for ${finding.area}.`)
    }
    // An approving review adds only fresh notes. It cannot overwrite any existing disposition.
    if (envelope.reviewDecision === "approved") {
      throw collaborationError("COLLAB_FINDINGS_INVALID", `An approving review cannot reuse existing finding code ${finding.code}; use a fresh code for a note.`)
    }
  }

  for (const code of envelope.resolvedFindings) {
    const entry = byCode.get(code)
    if (!entry) throw collaborationError("COLLAB_FINDING_UNKNOWN", `Review resolves a finding that was never raised: ${code}.`)
    if (entry.status !== "addressed") {
      throw collaborationError("COLLAB_FINDING_NOT_ADDRESSED", `Finding ${code} cannot be resolved before its area was corrected.`)
    }
    next.set(code, Object.freeze({ ...entry, status: "resolved", resolvedAt: envelope.candidateSha }))
  }

  const approving = envelope.reviewDecision === "approved"
  // No newly raised findings means previously addressed but unresolved
  // findings are still disputed; reopen them for another bounded correction.
  if (!approving && envelope.findings.length === 0) {
    if (![...next.values()].some((entry) => entry.status === "addressed")) {
      throw collaborationError("COLLAB_FINDINGS_INVALID", "A change request without new findings needs an unresolved addressed finding.")
    }
    // A correction request carries at most MAX_FINDINGS findings for one area, so
    // reject an oversized reopen before the review is recorded.
    for (const area of ["backend", "frontend"]) {
      const count = [...next.values()].filter((entry) => entry.area === area && entry.status === "addressed").length
      if (count > SOFTWARE_FACTORY_COLLABORATION_MAX_FINDINGS) {
        throw collaborationError("COLLAB_FINDINGS_INVALID", `Reopening would send ${count} ${area} findings; a correction carries at most ${SOFTWARE_FACTORY_COLLABORATION_MAX_FINDINGS}.`)
      }
    }
    for (const [code, entry] of next) {
      if (entry.status !== "addressed") continue
      next.set(code, Object.freeze({
        ...entry, status: "open", reopenedCount: entry.reopenedCount + 1,
        addressedAt: null, resolvedAt: null,
        history: Object.freeze([...entry.history, dispositionSnapshot(entry)])
      }))
    }
  }
  for (const finding of envelope.findings) {
    const existing = byCode.get(finding.code)
    if (approving) {
      next.set(finding.code, Object.freeze({ ...entryOf(finding, reviewNumber), status: "noted" }))
    } else if (existing) {
      const reopened = existing.status !== "open"
      next.set(finding.code, Object.freeze({
        ...existing,
        severity: finding.severity,
        summary: finding.summary,
        status: "open",
        reopenedCount: existing.reopenedCount + (reopened ? 1 : 0),
        addressedAt: null,
        resolvedAt: null,
        // Reopening preserves the previous disposition, including addressed and resolution SHAs.
        history: reopened ? Object.freeze([...existing.history, dispositionSnapshot(existing)]) : existing.history
      }))
    } else {
      next.set(finding.code, entryOf(finding, reviewNumber))
    }
  }

  const result = Object.freeze([...next.values()])
  if (approving) assertFindingsAccountedFor(result)
  return result
}

/** An accepted implementation for `area` addresses that area's open findings. */
export function markFindingAreaAddressed(ledger, area, candidateSha) {
  return Object.freeze(ledger.map((entry) => (
    entry.area === area && entry.status === "open"
      ? Object.freeze({ ...entry, status: "addressed", addressedAt: candidateSha })
      : entry
  )))
}

/** Areas that still have unaddressed findings, in the fixed order backend then frontend. */
export function openFindingAreas(ledger) {
  return ["backend", "frontend"].filter((area) => ledger.some((entry) => entry.area === area && entry.status === "open"))
}

export function openFindingsForArea(ledger, area) {
  return ledger
    .filter((entry) => entry.area === area && entry.status === "open")
    .map((entry) => ({ code: entry.code, severity: entry.severity, area: entry.area, summary: entry.summary }))
}

export function summarizeFindingLedger(ledger) {
  return collaborationDeepFreeze(ledger.map((entry) => ({
    code: entry.code, area: entry.area, severity: entry.severity, status: entry.status,
    openedInReview: entry.openedInReview, reopenedCount: entry.reopenedCount, history: entry.history
  })))
}

// ---------------------------------------------------------------------------
// Owner approval binding

/**
 * Check that a simulated or future owner decision is bound to exactly the
 * current package, head and scope, and is fresh. Never records or grants anything.
 */
export function assessOwnerReleaseApproval({ decision, releasePackage, headSha, scopeDigest, nowMs, ttlMs }) {
  if (!releasePackage) {
    throw collaborationError("COLLAB_STALE_OWNER_APPROVAL", "No current release package exists for this approval.")
  }
  if (
    !decision || decision.ownerId !== "owner" || !["approve", "reject"].includes(decision.decision) ||
    decision.packageHash !== releasePackage.packageHash ||
    decision.headSha !== headSha || !shaPattern.test(decision.headSha) ||
    decision.scopeDigest !== scopeDigest
  ) {
    throw collaborationError("COLLAB_STALE_OWNER_APPROVAL", "Owner approval is not bound to the exact current candidate package.")
  }
  const age = nowMs - decision.issuedAtMs
  if (!Number.isSafeInteger(decision.issuedAtMs) || age < 0 || age > ttlMs) {
    throw collaborationError("COLLAB_STALE_OWNER_APPROVAL", "Owner approval is expired or not yet valid.")
  }
  return true
}
