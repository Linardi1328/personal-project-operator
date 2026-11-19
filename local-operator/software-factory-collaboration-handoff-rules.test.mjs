import assert from "node:assert/strict"
import test from "node:test"
import { buildCollaborationEnvelope, createTrustedCollaborationRegistry } from "./software-factory-collaboration-contract.mjs"
import {
  applyCollaborationReview,
  assertCollaborationCandidateIsNew,
  assertContractEvidenceMatchesDigest,
  assertFindingsAccountedFor,
  assertReviewerIndependent,
  assessCollaborationEnvelopeContext,
  assessImplementationContract,
  assessOwnerReleaseApproval,
  createFindingLedger,
  markFindingAreaAddressed,
  openFindingAreas,
  openFindingsForArea,
  summarizeFindingLedger
} from "./software-factory-collaboration-handoff-rules.mjs"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
const SHA_C = "c".repeat(40)
const D1 = "1".repeat(64)
const D2 = "2".repeat(64)

const run = (overrides = {}) => ({
  projectId: "proj", runId: "R".repeat(43), correlationId: "ab".repeat(16), runVersion: 5,
  planHash: "3".repeat(64), scopeDigest: "4".repeat(64), baseSha: SHA_A, checkpointReason: null,
  expected: { providerId: "codex", role: "backend_implementer", stepId: "backend", attemptNumber: 1, messageType: "contract_ready" },
  ...overrides
})
const envelope = (overrides = {}) => ({
  projectId: "proj", runId: "R".repeat(43), correlationId: "ab".repeat(16), expectedRunVersion: 5,
  planHash: "3".repeat(64), scopeDigest: "4".repeat(64), baseSha: SHA_A, messageType: "contract_ready",
  sender: { providerId: "codex", role: "backend_implementer" }, stepId: "backend", attemptNumber: 1,
  ...overrides
})
const throwsCode = (fn, code) => assert.throws(fn, (error) => { assert.equal(error.code, code); return true })

test("context rules accept the one expected message and refuse every mismatch in a fixed order", () => {
  assert.equal(assessCollaborationEnvelopeContext(envelope(), run()), true)
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ projectId: "other" }), run()), "COLLAB_WRONG_PROJECT")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ runId: "X".repeat(43) }), run()), "COLLAB_WRONG_RUN")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ correlationId: "cd".repeat(16) }), run()), "COLLAB_WRONG_CORRELATION")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope(), run({ checkpointReason: "NO_ELIGIBLE_REVIEWER" })), "COLLAB_RUN_CHECKPOINTED")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ expectedRunVersion: 4 }), run()), "COLLAB_STALE_RUN_VERSION")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ planHash: "9".repeat(64) }), run()), "COLLAB_PLAN_MISMATCH")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ scopeDigest: "9".repeat(64) }), run()), "COLLAB_SCOPE_MISMATCH")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ baseSha: SHA_B }), run()), "COLLAB_BASE_MISMATCH")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope(), run({ expected: null })), "COLLAB_OUT_OF_ORDER")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ sender: { providerId: "claude", role: "backend_implementer" } }), run()), "COLLAB_SENDER_NOT_ASSIGNED")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ sender: { providerId: "codex", role: "independent_reviewer" } }), run()), "COLLAB_SENDER_NOT_ASSIGNED")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ stepId: "frontend" }), run()), "COLLAB_OUT_OF_ORDER")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ attemptNumber: 2 }), run()), "COLLAB_OUT_OF_ORDER")
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ messageType: "implementation_ready" }), run()), "COLLAB_OUT_OF_ORDER")
  // Status messages from the assigned sender are allowed in place of the expected type.
  assert.equal(assessCollaborationEnvelopeContext(envelope({ messageType: "provider_unavailable" }), run()), true)
  assert.equal(assessCollaborationEnvelopeContext(envelope({ messageType: "task_blocked" }), run()), true)
  // Project is checked before anything else, so a wrong project never leaks run state.
  throwsCode(() => assessCollaborationEnvelopeContext(envelope({ projectId: "other", expectedRunVersion: 1 }), run({ expected: null })), "COLLAB_WRONG_PROJECT")
})

test("candidate, contract and independence rules", () => {
  assert.equal(assertCollaborationCandidateIsNew(SHA_B, new Set([SHA_A])), true)
  throwsCode(() => assertCollaborationCandidateIsNew(SHA_A, new Set([SHA_A])), "COLLAB_CANDIDATE_REPLAYED")

  const evidence = (kind, digest) => ({ kind, ref: `${kind}-1`, digest, sizeBytes: 10, candidateSha: SHA_B })
  assert.equal(assertContractEvidenceMatchesDigest({ contractDigest: D1, evidence: [evidence("contract", D1)] }).digest, D1)
  throwsCode(() => assertContractEvidenceMatchesDigest({ contractDigest: D1, evidence: [evidence("contract", D2)] }), "COLLAB_CONTRACT_INVALID")
  throwsCode(() => assertContractEvidenceMatchesDigest({ contractDigest: D1, evidence: [] }), "COLLAB_CONTRACT_INVALID")

  assert.deepEqual(assessImplementationContract({ contractDigest: D1, evidence: [] }, "frontend", D1), { changed: false, evidence: null })
  throwsCode(() => assessImplementationContract({ contractDigest: D2, evidence: [] }, "frontend", D1), "COLLAB_CONTRACT_MISMATCH")
  throwsCode(() => assessImplementationContract({ contractDigest: D2, evidence: [evidence("implementation", D2)] }, "backend", D1), "COLLAB_CONTRACT_INVALID")
  const changed = assessImplementationContract({ contractDigest: D2, evidence: [evidence("contract", D2)] }, "backend", D1)
  assert.equal(changed.changed, true)
  assert.equal(changed.evidence.digest, D2)

  assert.equal(assertReviewerIndependent("claude", new Set(["codex", "antigravity"])), true)
  throwsCode(() => assertReviewerIndependent("codex", new Set(["codex", "antigravity"])), "COLLAB_REVIEW_NOT_INDEPENDENT")
})

const finding = (code, area, severity = "P1") => ({ code, area, severity, summary: `Synthetic ${code}.` })
const review = (decision, findings = [], resolvedFindings = [], candidateSha = SHA_B) => ({ reviewDecision: decision, findings, resolvedFindings, candidateSha })

test("every raised finding stays accounted for until it is explicitly resolved", () => {
  let ledger = createFindingLedger()
  assert.ok(Object.isFrozen(ledger))

  // Review 1 raises one backend and one frontend finding. Both are open.
  ledger = applyCollaborationReview(ledger, review("changes_requested", [finding("wrong_status", "backend"), finding("missing_label", "frontend")]), 1)
  assert.deepEqual(ledger.map((entry) => `${entry.code}:${entry.status}`), ["wrong_status:open", "missing_label:open"])
  assert.deepEqual(openFindingAreas(ledger), ["backend", "frontend"])
  assert.deepEqual(openFindingsForArea(ledger, "frontend").map((entry) => entry.code), ["missing_label"])

  // A backend correction alone addresses only the backend finding.
  ledger = markFindingAreaAddressed(ledger, "backend", SHA_B)
  assert.deepEqual(ledger.map((entry) => `${entry.code}:${entry.status}`), ["wrong_status:addressed", "missing_label:open"])
  assert.deepEqual(openFindingAreas(ledger), ["frontend"])
  assert.throws(() => assertFindingsAccountedFor(ledger), { code: "COLLAB_FINDINGS_UNRESOLVED" })

  // Approving now is refused: nothing resolved the backend finding and the frontend one is untouched.
  throwsCode(() => applyCollaborationReview(ledger, review("approved"), 2), "COLLAB_FINDINGS_UNRESOLVED")
  // Resolving the backend finding alone is still not enough to approve.
  throwsCode(() => applyCollaborationReview(ledger, review("approved", [], ["wrong_status"]), 2), "COLLAB_FINDINGS_UNRESOLVED")
  // A finding nobody addressed cannot be resolved by assertion.
  throwsCode(() => applyCollaborationReview(ledger, review("approved", [], ["wrong_status", "missing_label"]), 2), "COLLAB_FINDING_NOT_ADDRESSED")
  // Unknown codes cannot be resolved.
  throwsCode(() => applyCollaborationReview(ledger, review("approved", [], ["invented_code"]), 2), "COLLAB_FINDING_UNKNOWN")

  // After the frontend correction both are addressed; only an explicit resolution of both allows approval.
  ledger = markFindingAreaAddressed(ledger, "frontend", SHA_C)
  assert.deepEqual(openFindingAreas(ledger), [])
  throwsCode(() => applyCollaborationReview(ledger, review("approved", [], ["wrong_status"], SHA_C), 2), "COLLAB_FINDINGS_UNRESOLVED")
  const approved = applyCollaborationReview(ledger, review("approved", [], ["wrong_status", "missing_label"], SHA_C), 2)
  assert.deepEqual(approved.map((entry) => entry.status), ["resolved", "resolved"])
  assert.equal(assertFindingsAccountedFor(approved), true)
  assert.deepEqual(approved.map((entry) => entry.resolvedAt), [SHA_C, SHA_C])
  assert.deepEqual(summarizeFindingLedger(approved).map((entry) => entry.status), ["resolved", "resolved"])
})

test("a re-review that re-raises a fixed finding reopens it and keeps the history", () => {
  let ledger = applyCollaborationReview(createFindingLedger(), review("changes_requested", [finding("bad_label", "frontend")]), 1)
  ledger = markFindingAreaAddressed(ledger, "frontend", SHA_B)
  // The reviewer says it is not fixed and also raises a second finding.
  ledger = applyCollaborationReview(ledger, review("changes_requested", [finding("bad_label", "frontend"), finding("low_contrast", "frontend", "P2")]), 2)
  const byCode = Object.fromEntries(ledger.map((entry) => [entry.code, entry]))
  assert.equal(byCode.bad_label.status, "open")
  assert.equal(byCode.bad_label.reopenedCount, 1)
  assert.equal(byCode.bad_label.addressedAt, null)
  assert.equal(byCode.low_contrast.status, "open")
  assert.equal(byCode.low_contrast.openedInReview, 2)
})

test("a changes-requested review that stays silent leaves addressed findings pending, not closed", () => {
  let ledger = applyCollaborationReview(createFindingLedger(), review("changes_requested", [finding("a_issue", "backend"), finding("b_issue", "frontend")]), 1)
  ledger = markFindingAreaAddressed(markFindingAreaAddressed(ledger, "backend", SHA_B), "frontend", SHA_C)
  ledger = applyCollaborationReview(ledger, review("changes_requested", [finding("c_issue", "backend")]), 2)
  assert.deepEqual(ledger.map((entry) => `${entry.code}:${entry.status}`), ["a_issue:addressed", "b_issue:addressed", "c_issue:open"])
  assert.throws(() => assertFindingsAccountedFor(ledger), { code: "COLLAB_FINDINGS_UNRESOLVED" })
})

test("an approving review may only add non-blocking notes and never re-raise an unresolved finding", () => {
  const ledger = applyCollaborationReview(createFindingLedger(), review("approved", [finding("naming_nit", "frontend", "P3")]), 1)
  assert.deepEqual(ledger.map((entry) => entry.status), ["noted"])
  assert.equal(assertFindingsAccountedFor(ledger), true)

  let open = applyCollaborationReview(createFindingLedger(), review("changes_requested", [finding("wrong_status", "backend")]), 1)
  throwsCode(() => applyCollaborationReview(open, review("approved", [finding("wrong_status", "backend", "P3")]), 2), "COLLAB_FINDINGS_INVALID")
  open = markFindingAreaAddressed(open, "backend", SHA_B)
  throwsCode(() => applyCollaborationReview(open, review("approved", [finding("wrong_status", "backend", "P3")]), 2), "COLLAB_FINDINGS_INVALID")
})

test("ledger functions never mutate their inputs", () => {
  const first = applyCollaborationReview(createFindingLedger(), review("changes_requested", [finding("a_issue", "backend")]), 1)
  const snapshot = JSON.stringify(first)
  markFindingAreaAddressed(first, "backend", SHA_B)
  openFindingAreas(first)
  assert.equal(JSON.stringify(first), snapshot)
  assert.ok(Object.isFrozen(first))
  assert.ok(Object.isFrozen(first[0]))
})

test("owner approval binding is exact, fresh, and records nothing", () => {
  const releasePackage = { packageHash: D1 }
  const base = { releasePackage, headSha: SHA_B, scopeDigest: D2, nowMs: 1_000_000, ttlMs: 600_000 }
  const decision = { ownerId: "owner", decision: "approve", packageHash: D1, headSha: SHA_B, scopeDigest: D2, issuedAtMs: 999_000 }
  assert.equal(assessOwnerReleaseApproval({ ...base, decision }), true)
  throwsCode(() => assessOwnerReleaseApproval({ ...base, releasePackage: null, decision }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: { ...decision, packageHash: D2 } }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: { ...decision, headSha: SHA_C } }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: { ...decision, scopeDigest: D1 } }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: { ...decision, ownerId: "claude" } }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: { ...decision, decision: "maybe" } }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: { ...decision, issuedAtMs: 1_000_000 - 600_001 } }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: { ...decision, issuedAtMs: 1_000_001 } }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: { ...decision, issuedAtMs: 1.5 } }), "COLLAB_STALE_OWNER_APPROVAL")
  throwsCode(() => assessOwnerReleaseApproval({ ...base, decision: null }), "COLLAB_STALE_OWNER_APPROVAL")
})

// ---------------------------------------------------------------------------
// Revision 3: finding identity and disposition consistency across reviews (P2-03)

const REGISTRY = createTrustedCollaborationRegistry()
// A real, schema-validated review envelope, so these cases go through actual contract validation.
function realReview(decision, { findings = [], resolvedFindings = [], candidateSha = SHA_B, attemptNumber = 1 } = {}) {
  return buildCollaborationEnvelope({
    messageType: "review_finding", projectId: "proj", runId: "R".repeat(43), expectedRunVersion: 7, stepId: "review", attemptNumber,
    correlationId: "ab".repeat(16), sender: { role: "independent_reviewer", providerId: "claude" }, recipient: { role: "coordinator", providerId: "ppo" },
    planHash: "3".repeat(64), scopeDigest: "4".repeat(64), baseSha: SHA_A, candidateSha, contractDigest: null,
    evidence: [{ kind: "review", ref: `review-${attemptNumber}`, digest: D1, sizeBytes: 10, candidateSha }],
    findings, resolvedFindings, reviewDecision: decision, requestedAction: "evaluate_review", summary: "Synthetic review."
  }, REGISTRY).envelope
}
const snap = (ledger) => JSON.stringify(ledger)

test("P2-03 case A: reusing a finding code for a different area is rejected and the ledger is untouched", () => {
  let ledger = applyCollaborationReview(createFindingLedger(), realReview("changes_requested", { findings: [finding("shared_code", "backend")] }), 1)
  ledger = markFindingAreaAddressed(ledger, "backend", SHA_B)
  const before = snap(ledger)
  const conflicting = realReview("changes_requested", { candidateSha: SHA_C, attemptNumber: 2, findings: [finding("shared_code", "frontend", "P2")] })
  throwsCode(() => applyCollaborationReview(ledger, conflicting, 2), "COLLAB_FINDING_AREA_CONFLICT")
  assert.equal(snap(ledger), before, "rejected review must not alter the ledger")
  assert.deepEqual(openFindingAreas(ledger), [], "no area is routed from the rejected review")
  // Also rejected when the conflict is not the first finding, with no partial application.
  const mixed = realReview("changes_requested", { candidateSha: SHA_C, attemptNumber: 2, findings: [finding("fresh_code", "backend"), finding("shared_code", "frontend")] })
  throwsCode(() => applyCollaborationReview(ledger, mixed, 2), "COLLAB_FINDING_AREA_CONFLICT")
  assert.equal(snap(ledger), before)
  // The same conflict is refused for an already-resolved code too.
  const resolved = applyCollaborationReview(ledger, realReview("approved", { resolvedFindings: ["shared_code"], candidateSha: SHA_C, attemptNumber: 2 }), 2)
  throwsCode(() => applyCollaborationReview(resolved, realReview("changes_requested", { candidateSha: SHA_C, attemptNumber: 3, findings: [finding("shared_code", "frontend")] }), 3), "COLLAB_FINDING_AREA_CONFLICT")
})

test("P2-03 case B: an approving note cannot overwrite an existing finding disposition", () => {
  let ledger = applyCollaborationReview(createFindingLedger(), realReview("changes_requested", { findings: [finding("api_status", "backend")] }), 1)
  ledger = markFindingAreaAddressed(ledger, "backend", SHA_B)
  ledger = applyCollaborationReview(ledger, realReview("approved", { resolvedFindings: ["api_status"], candidateSha: SHA_C, attemptNumber: 2 }), 2)
  const before = snap(ledger)
  assert.deepEqual([ledger[0].area, ledger[0].severity, ledger[0].addressedAt, ledger[0].resolvedAt], ["backend", "P1", SHA_B, SHA_C])

  // A later approving review reuses the resolved code as a P3 frontend note.
  const overwrite = realReview("approved", { candidateSha: SHA_C, attemptNumber: 3, findings: [finding("api_status", "frontend", "P3")] })
  assert.throws(() => applyCollaborationReview(ledger, overwrite, 3), (error) => ["COLLAB_FINDINGS_INVALID", "COLLAB_FINDING_AREA_CONFLICT"].includes(error.code))
  // Same area and severity downgrade is also not allowed to replace a resolved or noted disposition.
  throwsCode(() => applyCollaborationReview(ledger, realReview("approved", { candidateSha: SHA_C, attemptNumber: 3, findings: [finding("api_status", "backend", "P3")] }), 3), "COLLAB_FINDINGS_INVALID")
  assert.equal(snap(ledger), before, "resolution evidence is preserved")

  // A noted code cannot be silently re-noted or overwritten either.
  const noted = applyCollaborationReview(ledger, realReview("approved", { candidateSha: SHA_C, attemptNumber: 3, findings: [finding("naming_nit", "frontend", "P3")] }), 3)
  throwsCode(() => applyCollaborationReview(noted, realReview("approved", { candidateSha: SHA_C, attemptNumber: 4, findings: [finding("naming_nit", "frontend", "P2")] }), 4), "COLLAB_FINDINGS_INVALID")
})

test("P2-03: a fresh-code P2/P3 note on an approving review is still accepted", () => {
  const ledger = applyCollaborationReview(createFindingLedger(), realReview("approved", { findings: [finding("naming_nit", "frontend", "P3"), finding("copy_nit", "backend", "P2")] }), 1)
  assert.deepEqual(ledger.map((entry) => `${entry.code}:${entry.status}:${entry.area}`), ["naming_nit:noted:frontend", "copy_nit:noted:backend"])
  assert.equal(assertFindingsAccountedFor(ledger), true)
})

test("P2-03: same-area reopening keeps the prior disposition in history and needs resolution again", () => {
  let ledger = applyCollaborationReview(createFindingLedger(), realReview("changes_requested", { findings: [finding("api_status", "backend")] }), 1)
  ledger = markFindingAreaAddressed(ledger, "backend", SHA_B)
  ledger = applyCollaborationReview(ledger, realReview("changes_requested", { candidateSha: SHA_C, attemptNumber: 2, resolvedFindings: [], findings: [finding("other_issue", "frontend"), finding("api_status", "backend", "P0")] }), 2)
  const entry = ledger.find((item) => item.code === "api_status")
  assert.equal(entry.status, "open")
  assert.equal(entry.severity, "P0")
  assert.equal(entry.reopenedCount, 1)
  assert.equal(entry.addressedAt, null)
  assert.equal(entry.history.length, 1)
  assert.deepEqual([entry.history[0].status, entry.history[0].severity, entry.history[0].addressedAt], ["addressed", "P1", SHA_B])
  assert.ok(Object.isFrozen(entry.history) && Object.isFrozen(entry.history[0]))
  // Reopening a RESOLVED finding also preserves the resolution evidence.
  let resolved = applyCollaborationReview(createFindingLedger(), realReview("changes_requested", { findings: [finding("api_status", "backend")] }), 1)
  resolved = markFindingAreaAddressed(resolved, "backend", SHA_B)
  resolved = applyCollaborationReview(resolved, realReview("approved", { resolvedFindings: ["api_status"], candidateSha: SHA_C, attemptNumber: 2 }), 2)
  const reopened = applyCollaborationReview(resolved, realReview("changes_requested", { candidateSha: SHA_C, attemptNumber: 3, findings: [finding("api_status", "backend")] }), 3).find((item) => item.code === "api_status")
  assert.equal(reopened.status, "open")
  assert.equal(reopened.history.length, 1)
  assert.deepEqual([reopened.history[0].status, reopened.history[0].addressedAt, reopened.history[0].resolvedAt], ["resolved", SHA_B, SHA_C])
  // It must be addressed and resolved again before approval.
  throwsCode(() => applyCollaborationReview([reopened], realReview("approved", { candidateSha: SHA_C, attemptNumber: 4 }), 4), "COLLAB_FINDINGS_UNRESOLVED")
  throwsCode(() => applyCollaborationReview([reopened], realReview("approved", { resolvedFindings: ["api_status"], candidateSha: SHA_C, attemptNumber: 4 }), 4), "COLLAB_FINDING_NOT_ADDRESSED")
})

test("P2-03: a rejected review leaves no partially updated entries", () => {
  let ledger = applyCollaborationReview(createFindingLedger(), realReview("changes_requested", { findings: [finding("one_issue", "backend"), finding("two_issue", "frontend")] }), 1)
  ledger = markFindingAreaAddressed(ledger, "backend", SHA_B)
  const before = snap(ledger)
  const attempts = [
    // resolution of a valid code, then an unknown one
    realReview("approved", { resolvedFindings: ["one_issue", "invented"], candidateSha: SHA_C, attemptNumber: 2 }),
    // valid resolution plus an unaddressed one
    realReview("approved", { resolvedFindings: ["one_issue", "two_issue"], candidateSha: SHA_C, attemptNumber: 2 }),
    // valid new finding plus an area conflict
    realReview("changes_requested", { candidateSha: SHA_C, attemptNumber: 2, findings: [finding("fresh_issue", "backend"), finding("one_issue", "frontend")] }),
    // approval that resolves one finding but leaves the other unresolved
    realReview("approved", { resolvedFindings: ["one_issue"], candidateSha: SHA_C, attemptNumber: 2 })
  ]
  for (const attempt of attempts) {
    assert.throws(() => applyCollaborationReview(ledger, attempt, 2))
    assert.equal(snap(ledger), before)
  }
})

test("P2-03: the original rejection, mixed-area and unresolved-completion rules still hold", () => {
  let ledger = applyCollaborationReview(createFindingLedger(), realReview("changes_requested", { findings: [finding("be_issue", "backend"), finding("fe_issue", "frontend")] }), 1)
  assert.deepEqual(openFindingAreas(ledger), ["backend", "frontend"])
  ledger = markFindingAreaAddressed(ledger, "backend", SHA_B)
  assert.deepEqual(openFindingAreas(ledger), ["frontend"])
  throwsCode(() => applyCollaborationReview(ledger, realReview("approved", { resolvedFindings: ["invented"], candidateSha: SHA_C, attemptNumber: 2 }), 2), "COLLAB_FINDING_UNKNOWN")
  throwsCode(() => applyCollaborationReview(ledger, realReview("approved", { resolvedFindings: ["fe_issue"], candidateSha: SHA_C, attemptNumber: 2 }), 2), "COLLAB_FINDING_NOT_ADDRESSED")
  throwsCode(() => applyCollaborationReview(ledger, realReview("approved", { resolvedFindings: ["be_issue"], candidateSha: SHA_C, attemptNumber: 2 }), 2), "COLLAB_FINDINGS_UNRESOLVED")
})

test("review with no newly raised findings reopens previously addressed, unresolved issues", () => {
  const issue = { code: "existing_issue", severity: "P1", area: "frontend", summary: "Existing finding persists." }
  const raised = applyCollaborationReview(createFindingLedger(), { reviewDecision: "changes_requested", findings: [issue], resolvedFindings: [], candidateSha: SHA_B }, 1)
  const addressed = markFindingAreaAddressed(raised, "frontend", SHA_B)
  const reopened = applyCollaborationReview(addressed, { reviewDecision: "changes_requested", findings: [], resolvedFindings: [], candidateSha: SHA_C }, 2)
  assert.equal(reopened[0].status, "open")
  assert.equal(reopened[0].reopenedCount, 1)
  assert.equal(reopened[0].history[0].status, "addressed")
  assert.deepEqual(openFindingAreas(reopened), ["frontend"])
  assert.deepEqual(addressed[0].status, "addressed")
})

test("an empty change request is refused if no previous finding needs correction", () => {
  assert.throws(() => applyCollaborationReview(createFindingLedger(), {
    reviewDecision: "changes_requested", findings: [], resolvedFindings: [], candidateSha: SHA_B
  }, 1), { code: "COLLAB_FINDINGS_INVALID" })
})

test("a finding-free change request cannot reopen more findings than one correction can carry", () => {
  const raise = (codes) => review("changes_requested", codes.map((code) => finding(code, "backend")))
  let ledger = applyCollaborationReview(createFindingLedger(), raise(["b1", "b2", "b3", "b4", "b5"]), 1)
  ledger = markFindingAreaAddressed(ledger, "backend", SHA_B)
  // Five addressed findings can still be reopened as one correction batch.
  const five = applyCollaborationReview(ledger, review("changes_requested"), 2)
  assert.equal(five.filter((entry) => entry.status === "open").length, 5)
  // A sixth raised alongside leaves six addressed after its own correction.
  let six = applyCollaborationReview(ledger, raise(["b6"]), 2)
  six = markFindingAreaAddressed(six, "backend", SHA_C)
  assert.equal(six.filter((entry) => entry.status === "addressed").length, 6)
  throwsCode(() => applyCollaborationReview(six, review("changes_requested"), 3), "COLLAB_FINDINGS_INVALID")
  assert.equal(six.filter((entry) => entry.status === "addressed").length, 6)
})
