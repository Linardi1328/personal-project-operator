import { ALLOWED_DEVELOPMENT_RUN_TRANSITIONS } from "./development-run-state.mjs"
import { MAX_HARDENING_ROUNDS } from "./development-hardening-orchestrator.mjs"
import { SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS } from "./software-factory-release-approval.mjs"
import { validateSoftwareFactoryPlan } from "./software-factory-plan-contract.mjs"
import { assessSoftwareFactoryAdmission } from "./software-factory-admission.mjs"
import {
  assertTrustedCollaborationRegistry,
  buildCollaborationEnvelope,
  buildCollaborationScope,
  collaborationDeepFreeze,
  collaborationError,
  collaborationSha256,
  collaborationStableStringify,
  createCollaborationWorkspaceGuard,
  SoftwareFactoryCollaborationError,
  validateCollaborationEnvelope
} from "./software-factory-collaboration-contract.mjs"
import { routeCollaborationStep } from "./software-factory-collaboration-routing.mjs"
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

// RIC-181 TEST-ONLY SIMULATION RUN MODEL. Not a coordinator.
//
// This file is a disposable fixture. It exists so the reusable collaboration
// contract (envelope, registry, routing, handoff rules) can be exercised end to
// end without a real run. It is NOT a second production coordinator, NOT a
// dispatcher, NOT a state store and NOT a release mechanism, and nothing outside
// tests and the simulation fixture may import it. Every stateful lifecycle piece
// below is a stand-in for an existing PPO component and must never be promoted:
//
//   in-memory version/status ......... development-run-state (canonical run)
//   assignment and stepping .......... development-continue-orchestrator, driven
//                                      by software-factory-autonomous-run (the
//                                      real runner drives this model in the
//                                      simulation; its loop is not re-implemented)
//   in-memory checkpoint/capacity .... software-factory-dispatch-checkpoint
//   correction rounds ................ development-hardening-orchestrator
//   simulated release package ........ software-factory-release-package
//   simulated owner decision ......... software-factory-release-approval
//
// The simulated run version and status use the existing development run status
// vocabulary and transition table so the model cannot invent a lifecycle PPO does
// not already have. It never reads or writes canonical run records. Every output
// is explicitly non-authorizing.

export const SOFTWARE_FACTORY_COLLABORATION_SIMULATION_MODEL_ID = "software-factory-collaboration-test-only-run-model-v2"
export const SOFTWARE_FACTORY_COLLABORATION_MAX_CORRECTION_ROUNDS = MAX_HARDENING_ROUNDS
export const SOFTWARE_FACTORY_COLLABORATION_OWNER_APPROVAL_TTL_MS = SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS

const digestPattern = /^[a-f0-9]{64}$/u
const GENESIS = "0".repeat(64)

const stepByRole = Object.freeze({
  backend_implementer: "backend",
  frontend_implementer: "frontend",
  independent_reviewer: "review"
})
const capabilityByRole = Object.freeze({
  backend_implementer: "implementation.backend",
  frontend_implementer: "implementation.frontend"
})
const roleByArea = Object.freeze({ backend: "backend_implementer", frontend: "frontend_implementer" })
const capacityByClaim = Object.freeze({
  quota_exhausted: "exhausted",
  rate_limited: "rate_limited",
  provider_unavailable: "unavailable",
  availability_unknown: "unknown",
  capability_mismatch: "unavailable"
})
const retryableCheckpointKinds = new Set(["blocked_capacity", "blocked_external"])

function hashEvent(previousHash, entry) {
  return collaborationSha256(`${previousHash}:${collaborationStableStringify(entry)}`)
}

/** Verify an exported event chain is unbroken. Used by tests and evidence review. */
export function verifyCollaborationEventChain(events) {
  let previous = GENESIS
  for (const [index, event] of events.entries()) {
    const { hash, ...entry } = event
    if (event.sequence !== index + 1 || event.previousHash !== previous || hash !== hashEvent(previous, entry)) {
      return false
    }
    previous = hash
  }
  return true
}

/**
 * Create one TEST-ONLY in-memory collaboration run model.
 *
 * options: {
 *   registry,        // trusted registry (createTrustedCollaborationRegistry)
 *   plan,            // validated-by-this-call structured Software Factory plan
 *   scope,           // owner-approved decomposition from buildCollaborationScope
 *   correlationId,   // 32 hex chars shared by every message in this run
 *   workspaceId,     // synthetic workspace identifier (never a real path)
 *   providerStates,  // trusted provider capacity/integration/billing observations
 *   inspectWorkspace,// () => ({ head, clean }) trusted workspace verification fake
 *   workspaceGuard,  // optional shared guard (to model a conflicting writer)
 *   now              // () => epoch milliseconds
 * }
 */
export function createSimulationRunModel(options = {}) {
  const registry = assertTrustedCollaborationRegistry(options.registry)
  const plan = validateSoftwareFactoryPlan(options.plan)
  const scope = options.scope

  if (
    !scope || scope.planHash !== plan.planHash ||
    buildCollaborationScope({ planHash: scope.planHash, steps: scope.steps }).scopeDigest !== scope.scopeDigest ||
    scope.steps.map((step) => `${step.stepId}:${step.role}`).join("|") !==
      "backend:backend_implementer|frontend:frontend_implementer|review:independent_reviewer"
  ) {
    throw collaborationError("COLLAB_SCOPE_INVALID", "Approved scope does not match the validated plan.")
  }
  if (typeof options.correlationId !== "string" || !/^[a-f0-9]{32}$/u.test(options.correlationId)) {
    throw collaborationError("COLLAB_BINDING_INVALID", "Collaboration correlation id is invalid.")
  }
  if (typeof options.workspaceId !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(options.workspaceId)) {
    throw collaborationError("COLLAB_BINDING_INVALID", "Collaboration workspace id is invalid.")
  }
  if (typeof options.inspectWorkspace !== "function") {
    throw collaborationError("COLLAB_BINDING_INVALID", "A trusted workspace inspection function is required.")
  }

  const projectId = plan.projectId
  const runId = plan.runId
  const baseSha = plan.baseSha
  const correlationId = options.correlationId
  const workspaceId = options.workspaceId
  const guard = options.workspaceGuard ?? createCollaborationWorkspaceGuard()
  const now = typeof options.now === "function" ? options.now : () => 0
  const providerStates = { ...(options.providerStates ?? {}) }
  const suspended = new Map()

  let version = 1
  let status = "created"
  let phase = "awaiting_scope_approval"
  let scopeApproved = false
  let admitted = false
  let candidateSha = null
  let candidateArea = null
  let contract = null
  let expected = null
  let checkpoint = null
  let correctionRound = 0
  let tests = null
  let review = null
  let releasePackage = null
  let lastOwnerDecision = null
  let checkpointResume = null
  let pendingContract = null
  let currentSpec = null
  let lastHash = GENESIS
  let findingLedger = createFindingLedger()
  let reviewCount = 0
  let lastReviewRef = null
  const attempts = { backend: 0, frontend: 0, review: 0 }
  const implementers = new Set()
  const lastProviderByRole = {}
  const knownCandidates = new Set([baseSha])
  const seen = new Map()
  const evidenceLedger = new Map()
  const invalidations = []
  const events = []
  const outbox = []

  // -- append-only record -------------------------------------------------

  function note(type, data = {}) {
    const entry = { sequence: events.length + 1, type, runVersion: version, data: collaborationDeepFreeze(structuredClone(data)), previousHash: lastHash }
    const hash = hashEvent(lastHash, entry)
    lastHash = hash
    events.push(Object.freeze({ ...entry, hash }))
  }

  function commit(type, data = {}) {
    version += 1
    note(type, data)
  }

  function transition(to) {
    if (!ALLOWED_DEVELOPMENT_RUN_TRANSITIONS[status]?.includes(to)) {
      throw collaborationError("COLLAB_TRANSITION_ILLEGAL", `Run status ${status} cannot move to ${to}.`)
    }
    const from = status
    status = to
    commit("run_transition", { from, to })
  }

  // -- evidence ledger ----------------------------------------------------

  function registerEvidence(entry, source) {
    const existing = evidenceLedger.get(entry.ref)
    if (existing) {
      if (existing.digest !== entry.digest || existing.kind !== entry.kind || existing.candidateSha !== entry.candidateSha) {
        throw collaborationError("COLLAB_EVIDENCE_CONFLICT", "Evidence reference was already recorded with different content.")
      }
      return existing
    }
    const record = Object.freeze({ ...entry, source })
    evidenceLedger.set(entry.ref, record)
    note("evidence_recorded", { ref: entry.ref, kind: entry.kind, digest: entry.digest, candidateSha: entry.candidateSha, source })
    return record
  }

  function isEvidenceCurrent(ref) {
    const entry = evidenceLedger.get(ref)
    if (!entry || invalidations.some((record) => record.ref === ref)) return false
    if (entry.kind === "contract") return contract !== null && entry.digest === contract.evidenceDigest
    return entry.candidateSha === null || entry.candidateSha === candidateSha
  }

  function invalidateCandidateEvidence(oldCandidate, reason) {
    if (!oldCandidate) return
    for (const entry of evidenceLedger.values()) {
      if (entry.candidateSha === oldCandidate && entry.kind !== "contract" && !invalidations.some((record) => record.ref === entry.ref)) {
        invalidations.push(Object.freeze({ ref: entry.ref, kind: entry.kind, reason, atVersion: version }))
        note("evidence_invalidated", { ref: entry.ref, kind: entry.kind, reason, candidateSha: oldCandidate })
      }
    }
    if (tests?.candidateSha === oldCandidate) tests = null
    if (review?.candidateSha === oldCandidate) review = null
    if (releasePackage?.headSha === oldCandidate) {
      note("release_package_superseded", { packageHash: releasePackage.packageHash, headSha: oldCandidate })
      releasePackage = null
    }
  }

  // -- provider state -----------------------------------------------------

  function effectiveProviderStates() {
    const states = { ...providerStates }
    for (const [providerId, capacity] of suspended) {
      const base = states[providerId] ?? { integration: "configured", capacity: "unknown", billingPath: "unknown" }
      states[providerId] = { ...base, capacity }
    }
    return states
  }

  function observeProviderState(providerId, state) {
    if (!registry.providers[providerId]) {
      throw collaborationError("COLLAB_IDENTITY_UNTRUSTED", "Provider observation is for an untrusted provider.")
    }
    providerStates[providerId] = { ...state }
    if (state.capacity === "available" || state.capacity === "degraded") suspended.delete(providerId)
    note("provider_observed", { providerId, ...state })
  }

  // -- outbound messages --------------------------------------------------

  function outbound(fields) {
    const result = buildCollaborationEnvelope({
      projectId,
      runId,
      expectedRunVersion: version,
      correlationId,
      planHash: plan.planHash,
      scopeDigest: scope.scopeDigest,
      baseSha,
      sender: { role: "coordinator", providerId: "ppo" },
      ...fields
    }, registry)
    outbox.push(result)
    note("message_issued", { messageType: result.envelope.messageType, recipient: result.envelope.recipient, stepId: result.envelope.stepId, attemptNumber: result.envelope.attemptNumber, envelopeDigest: result.envelopeDigest })
    return result
  }

  function evidenceEntry(ref) {
    const entry = evidenceLedger.get(ref)
    return { kind: entry.kind, ref: entry.ref, digest: entry.digest, sizeBytes: entry.sizeBytes, candidateSha: entry.candidateSha }
  }

  // Evidence cited as the provenance of a correction. When the head has moved on
  // since that evidence was produced (a second correction in the same review
  // round), it is cited unbound. Accountability for the findings themselves is
  // carried by the finding ledger, not by binding old evidence to a new head.
  function provenanceEvidenceEntry(ref) {
    const entry = evidenceEntry(ref)
    return entry.candidateSha === candidateSha ? entry : { ...entry, candidateSha: null }
  }

  // -- checkpoints --------------------------------------------------------

  function enterCheckpoint(kind, reasonCode, details, resumeSpec = null) {
    checkpoint = Object.freeze({ kind, reasonCode, details, resumable: resumeSpec !== null && retryableCheckpointKinds.has(kind), atVersion: version })
    expected = null
    checkpointResume = resumeSpec
    phase = "checkpointed"
    commit("checkpoint_entered", { kind, reasonCode, details })
    return checkpoint
  }

  function escalateToOwner(reasonCode, summary) {
    outbound({
      messageType: "owner_decision_required",
      recipient: { role: "owner", providerId: "owner" },
      stepId: "owner",
      attemptNumber: Math.max(1, correctionRound + 1),
      candidateSha,
      reasonCode,
      requestedAction: "await_owner",
      summary
    })
  }

  function routeDecision(role, preferProviderId) {
    const decision = routeCollaborationStep({
      registry,
      role,
      taskCapability: capabilityByRole[role],
      implementers: [...implementers],
      providerStates: effectiveProviderStates(),
      preferProviderId
    })
    note("routing_decision", {
      role,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      providerId: decision.providerId,
      usedAlternate: decision.usedAlternate,
      evaluationProvider: decision.evaluationProvider,
      considered: decision.considered
    })
    return decision
  }

  // -- assignment ---------------------------------------------------------

  function releaseOrQuarantine(holder, expectedHead) {
    // A provider that stops without delivering leaves an unknown workspace. Reuse
    // is allowed only when trusted inspection shows the exact prior head and no
    // uncommitted change. Anything else keeps the workspace quarantined.
    let inspection
    try {
      inspection = options.inspectWorkspace()
    } catch {
      inspection = null
    }
    if (inspection && inspection.clean === true && inspection.head === expectedHead) {
      guard.releaseWriter(workspaceId, holder)
      note("workspace_verified_clean", { workspaceId, head: expectedHead })
      return true
    }
    guard.quarantine(workspaceId, holder)
    note("workspace_quarantined", { workspaceId })
    return false
  }

  function tryAssign(spec) {
    const decision = routeDecision(spec.role, spec.preferProviderId)
    if (decision.outcome !== "ready") {
      const reviewMissing = spec.role === "independent_reviewer"
      const kind = decision.outcome
      enterCheckpoint(kind, decision.reasonCode, { role: spec.role, retryable: decision.retryable }, kind === "owner_action_required" ? null : spec)
      if (decision.outcome === "owner_action_required" || reviewMissing) {
        escalateToOwner(reviewMissing ? "no_eligible_reviewer" : "no_eligible_provider",
          reviewMissing ? "No eligible independent reviewer is available; review cannot be bypassed." : "No eligible provider is available for this step.")
      }
      return { status: "checkpoint", checkpoint }
    }

    const providerId = decision.providerId
    const holder = `${providerId}:${stepByRole[spec.role]}`
    if (spec.role === "independent_reviewer") {
      guard.assertReadable(workspaceId, holder)
    } else {
      guard.acquireWriter(workspaceId, holder)
    }

    if (spec.onAssigned) spec.onAssigned(providerId)
    currentSpec = spec
    const stepId = stepByRole[spec.role]
    attempts[stepId] += 1
    lastProviderByRole[spec.role] = providerId
    checkpoint = null
    checkpointResume = null
    phase = spec.phase
    const issued = spec.issue ? spec.issue(providerId, attempts[stepId]) : null
    expected = Object.freeze({
      providerId,
      role: spec.role,
      stepId,
      attemptNumber: attempts[stepId],
      messageType: spec.messageType,
      runVersion: version,
      holder,
      usedAlternate: decision.usedAlternate,
      evaluationProvider: decision.evaluationProvider,
      issued: issued ? issued.envelope : null
    })
    note("assignment_issued", { providerId, role: spec.role, stepId, attemptNumber: attempts[stepId], messageType: spec.messageType, usedAlternate: decision.usedAlternate, evaluationProvider: decision.evaluationProvider })
    return { status: "assigned", assignment: expected }
  }

  function backendSpec() {
    return {
      kind: "backend", role: "backend_implementer", messageType: "contract_ready", phase: "awaiting_backend_contract",
      preferProviderId: lastProviderByRole.backend_implementer,
      onAssigned: () => { if (status === "planned") transition("implementation_in_progress") }
    }
  }

  function frontendSpec() {
    return {
      kind: "frontend", role: "frontend_implementer", messageType: "implementation_ready", phase: "awaiting_frontend_implementation",
      preferProviderId: lastProviderByRole.frontend_implementer,
      issue: (providerId, attempt) => outbound({
        messageType: "contract_ready",
        recipient: { role: "frontend_implementer", providerId },
        stepId: "frontend",
        attemptNumber: attempt,
        candidateSha: contract.candidateSha,
        contractDigest: contract.digest,
        evidence: [evidenceEntry(contract.evidenceRef)],
        requestedAction: "implement_frontend",
        summary: "Approved API contract relayed for frontend implementation."
      })
    }
  }

  function reviewSpec() {
    return {
      kind: "review", role: "independent_reviewer", messageType: "review_finding", phase: "awaiting_independent_review",
      preferProviderId: lastProviderByRole.independent_reviewer,
      onAssigned: () => { if (status === "tests_passed") transition("review_in_progress") }
    }
  }

  function correctionSpec(area, findings, evidenceRef) {
    const role = roleByArea[area]
    return {
      kind: "correction", role, messageType: "implementation_ready", phase: "awaiting_correction",
      preferProviderId: lastProviderByRole[role],
      onAssigned: () => { if (status !== "implementation_in_progress") transition("implementation_in_progress") },
      issue: (providerId, attempt) => outbound({
        messageType: "correction_requested",
        recipient: { role, providerId },
        stepId: stepByRole[role],
        attemptNumber: attempt,
        candidateSha,
        evidence: [provenanceEvidenceEntry(evidenceRef)],
        findings,
        requestedAction: "apply_correction",
        summary: "Apply the listed findings and return a new candidate."
      })
    }
  }

  function issueCorrection(area, findings, evidenceRef) {
    if (correctionRound >= SOFTWARE_FACTORY_COLLABORATION_MAX_CORRECTION_ROUNDS) {
      enterCheckpoint("owner_action_required", "CORRECTION_BUDGET_EXHAUSTED", { rounds: correctionRound })
      escalateToOwner("correction_budget_exhausted", "The bounded correction budget is exhausted; owner decision required.")
      return { status: "checkpoint", checkpoint }
    }
    // The round is spent when the correction is decided, so re-routing after a
    // provider stops cannot reset or double count the bounded budget.
    correctionRound += 1
    note("correction_round_spent", { round: correctionRound, area })
    return tryAssign(correctionSpec(area, findings, evidenceRef))
  }

  // -- public lifecycle ---------------------------------------------------

  function approveScope(decision) {
    if (!decision || decision.scopeDigest !== scope.scopeDigest || decision.approvedBy !== "owner") {
      throw collaborationError("COLLAB_SCOPE_APPROVAL_INVALID", "Scope approval does not match the approved decomposition.")
    }
    scopeApproved = true
    commit("scope_approved", { scopeDigest: scope.scopeDigest })
  }

  function admit(catalog) {
    // Existing admission policy: WIP <= 2 projects, one run per project, trusted
    // catalog only. An invalid or truncated catalog throws and nothing is admitted.
    const admission = assessSoftwareFactoryAdmission(projectId, catalog)
    if (!admission.ok) {
      throw collaborationError("COLLAB_ADMISSION_BLOCKED", `Admission refused: ${admission.reasonCode}.`)
    }
    admitted = true
    note("admission_checked", { outcome: admission.outcome, reasonCode: admission.reasonCode })
  }

  function start() {
    if (!scopeApproved) throw collaborationError("COLLAB_SCOPE_NOT_APPROVED", "The decomposed scope has not been approved by the owner.")
    if (!admitted) throw collaborationError("COLLAB_ADMISSION_REQUIRED", "Admission has not been checked against the run catalog.")
    if (status !== "created") throw collaborationError("COLLAB_OUT_OF_ORDER", "The run has already started.")
    transition("planning_in_progress")
    transition("planned")
    return tryAssign(backendSpec())
  }

  function accept(input, channel) {
    try {
      return acceptInner(input, channel)
    } catch (error) {
      // Failed attempts are preserved. Only the fixed code is recorded, never
      // the rejected content.
      note("message_rejected", { code: error instanceof SoftwareFactoryCollaborationError ? error.code : "COLLAB_UNEXPECTED" })
      throw error
    }
  }

  function acceptInner(input, channel) {
    const { envelope, envelopeDigest } = validateCollaborationEnvelope(input, registry)

    // The transport-authenticated identity is the only proof of who spoke. The
    // sender fields inside the message are a claim and must match it.
    if (!channel || channel.providerId !== envelope.sender.providerId) {
      throw collaborationError("COLLAB_FORGED_SENDER", "Sender identity does not match the authenticated channel.")
    }

    const prior = seen.get(envelope.idempotencyKey)
    if (prior) {
      if (prior !== envelopeDigest) {
        throw collaborationError("COLLAB_IDEMPOTENCY_CONFLICT", "The same idempotency key was reused with different content.")
      }
      note("duplicate_ignored", { envelopeDigest })
      return Object.freeze({ status: "duplicate_ignored", runVersion: version })
    }

    // Reusable, pure rules decide whether this message fits the run context.
    assessCollaborationEnvelopeContext(envelope, {
      projectId, runId, correlationId, runVersion: version, planHash: plan.planHash, scopeDigest: scope.scopeDigest, baseSha,
      checkpointReason: checkpoint?.reasonCode ?? null, expected
    })
    const isStatusMessage = envelope.messageType === "provider_unavailable" || envelope.messageType === "task_blocked"

    let result
    if (isStatusMessage) {
      result = handleStatusMessage(envelope)
    } else if (envelope.messageType === "contract_ready") {
      result = handleContractReady(envelope)
    } else if (envelope.messageType === "implementation_ready") {
      result = handleImplementationReady(envelope)
    } else {
      result = handleReviewFinding(envelope)
    }

    seen.set(envelope.idempotencyKey, envelopeDigest)
    return result
  }

  function recordAgentEvidence(envelope) {
    for (const entry of envelope.evidence) registerEvidence(entry, envelope.sender.providerId)
  }

  function handleContractReady(envelope) {
    assertCollaborationCandidateIsNew(envelope.candidateSha, knownCandidates)
    const contractEvidence = assertContractEvidenceMatchesDigest(envelope)
    recordAgentEvidence(envelope)
    guard.releaseWriter(workspaceId, expected.holder)
    knownCandidates.add(envelope.candidateSha)
    candidateSha = envelope.candidateSha
    candidateArea = "backend"
    implementers.add(envelope.sender.providerId)
    findingLedger = markFindingAreaAddressed(findingLedger, "backend", candidateSha)
    contract = Object.freeze({ digest: envelope.contractDigest, evidenceRef: contractEvidence.ref, evidenceDigest: contractEvidence.digest, candidateSha: envelope.candidateSha })
    commit("contract_accepted", { contractDigest: contract.digest, candidateSha, provider: envelope.sender.providerId })
    return Object.freeze({ status: "accepted", next: tryAssign(frontendSpec()) })
  }

  function handleImplementationReady(envelope) {
    assertCollaborationCandidateIsNew(envelope.candidateSha, knownCandidates)
    const area = envelope.sender.role === "backend_implementer" ? "backend" : "frontend"
    if (!contract) throw collaborationError("COLLAB_OUT_OF_ORDER", "Implementation arrived before an approved contract.")
    // A frontend built on another contract, or a backend contract change without
    // matching contract evidence, is refused before anything is recorded.
    const contractChange = assessImplementationContract(envelope, area, contract.digest)

    recordAgentEvidence(envelope)
    guard.releaseWriter(workspaceId, expected.holder)
    const previousCandidate = candidateSha
    knownCandidates.add(envelope.candidateSha)
    candidateSha = envelope.candidateSha
    candidateArea = area
    implementers.add(envelope.sender.providerId)
    invalidateCandidateEvidence(previousCandidate, "candidate_superseded")
    // An accepted implementation addresses that area's open findings. Addressed
    // is not resolved: only a later independent review can resolve them.
    findingLedger = markFindingAreaAddressed(findingLedger, area, candidateSha)
    commit("implementation_accepted", { candidateSha, area, provider: envelope.sender.providerId, attemptNumber: envelope.attemptNumber })

    if (contractChange.changed) {
      // A changed contract is never adopted silently. The frontend work built on
      // the old contract is stale until the owner explicitly reconciles it.
      const evidenceRef = contractChange.evidence.ref
      enterCheckpoint("owner_action_required", "CONTRACT_CHANGED", { previousDigest: contract.digest, proposedDigest: envelope.contractDigest, evidenceRef })
      pendingContract = Object.freeze({ digest: envelope.contractDigest, candidateSha: envelope.candidateSha, evidenceRef })
      escalateToOwner("contract_changed", "The API contract changed during correction; explicit reconciliation is required.")
      return Object.freeze({ status: "accepted", next: { status: "checkpoint", checkpoint } })
    }

    // Original findings in the other area are still open: that area must be
    // corrected before any test or review of a candidate that cannot be complete.
    const [nextArea] = openFindingAreas(findingLedger)
    if (nextArea) {
      return Object.freeze({ status: "accepted", next: issueCorrection(nextArea, openFindingsForArea(findingLedger, nextArea), lastReviewRef) })
    }

    transition("implementation_ready")
    phase = "awaiting_test_evidence"
    expected = null
    return Object.freeze({ status: "accepted", next: { status: "awaiting_test_evidence", candidateSha } })
  }

  function handleReviewFinding(envelope) {
    if (envelope.candidateSha !== candidateSha) {
      throw collaborationError("COLLAB_STALE_CANDIDATE", "Review is bound to a candidate that is no longer current.")
    }
    assertReviewerIndependent(envelope.sender.providerId, implementers)
    // Pure rule: throws if the review resolves an unknown or unaddressed finding,
    // or approves while any finding is still unresolved. Nothing is recorded yet.
    const nextLedger = applyCollaborationReview(findingLedger, envelope, reviewCount + 1)

    recordAgentEvidence(envelope)
    findingLedger = nextLedger
    reviewCount += 1
    const reviewEvidence = envelope.evidence.find((entry) => entry.kind === "review")
    lastReviewRef = reviewEvidence.ref
    review = Object.freeze({ candidateSha, decision: envelope.reviewDecision, ref: reviewEvidence.ref, findings: envelope.findings, reviewer: envelope.sender.providerId })
    expected = null
    note("review_recorded", { decision: envelope.reviewDecision, raised: envelope.findings.map((finding) => finding.code), resolved: envelope.resolvedFindings })

    if (envelope.reviewDecision === "approved") {
      transition("review_passed")
      phase = "ready_for_release_package"
      return Object.freeze({ status: "accepted", next: { status: "ready_for_release_package", candidateSha } })
    }

    transition("review_changes_requested")
    const [area] = openFindingAreas(findingLedger)
    return Object.freeze({ status: "accepted", next: issueCorrection(area, openFindingsForArea(findingLedger, area), reviewEvidence.ref) })
  }

  function handleStatusMessage(envelope) {
    recordAgentEvidence(envelope)
    commit("provider_status_accepted", { messageType: envelope.messageType, reasonCode: envelope.reasonCode })
    // An agent's claim can only restrict future routing, never expand it.
    if (envelope.messageType === "provider_unavailable") {
      suspended.set(envelope.sender.providerId, capacityByClaim[envelope.reasonCode])
    }
    const spec = expected
    const wasWriter = spec.role !== "independent_reviewer"
    const lastGood = candidateSha ?? baseSha
    if (wasWriter) releaseOrQuarantine(spec.holder, lastGood)

    if (envelope.messageType === "task_blocked") {
      enterCheckpoint("owner_action_required", "TASK_BLOCKED", { reasonCode: envelope.reasonCode, stepId: envelope.stepId })
      escalateToOwner("scope_exception", "A worker reported the task blocked; owner decision required.")
      return Object.freeze({ status: "accepted", next: { status: "checkpoint", checkpoint } })
    }

    if (wasWriter && guard.state(workspaceId).state === "quarantined") {
      enterCheckpoint("owner_action_required", "WORKSPACE_QUARANTINED", { providerId: envelope.sender.providerId })
      escalateToOwner("ambiguous_outcome", "Workspace state is unverified after a provider stopped; owner decision required.")
      return Object.freeze({ status: "accepted", next: { status: "checkpoint", checkpoint } })
    }

    // Workspace verified clean at the last good head: re-route with the provider
    // now suspended. This is a fresh routing decision, not a blind retry.
    expected = null
    const next = tryAssign(currentSpec)
    return Object.freeze({ status: "accepted", next })
  }

  function recordAdapterOutcome(outcome) {
    if (!expected || !["timeout", "ambiguous"].includes(outcome?.outcome) || outcome.providerId !== expected.providerId) {
      throw collaborationError("COLLAB_OUTCOME_INVALID", "Adapter outcome does not match the outstanding assignment.")
    }
    if (checkpoint) throw collaborationError("COLLAB_RUN_CHECKPOINTED", "Run is already checkpointed.")
    // A timeout or ambiguous completion is never success and never retried.
    // Whatever the provider may have left behind stays quarantined.
    const holder = expected.holder
    if (expected.role !== "independent_reviewer") {
      guard.quarantine(workspaceId, holder)
      note("workspace_quarantined", { workspaceId })
    }
    expected = null
    enterCheckpoint("owner_action_required", outcome.outcome === "timeout" ? "ADAPTER_TIMEOUT" : "AMBIGUOUS_COMPLETION", { providerId: outcome.providerId })
    escalateToOwner(outcome.outcome === "timeout" ? "timeout" : "ambiguous_outcome", "Provider outcome is unverified; owner decision required before any retry.")
    return Object.freeze({ status: "checkpoint", checkpoint })
  }

  function recordTestEvidence(result) {
    if (phase !== "awaiting_test_evidence" || status !== "implementation_ready") {
      throw collaborationError("COLLAB_OUT_OF_ORDER", "Test evidence is not expected now.")
    }
    if (!result || result.candidateSha !== candidateSha) {
      throw collaborationError("COLLAB_STALE_CANDIDATE", "Test evidence is bound to a candidate that is not current.")
    }
    if (typeof result.passed !== "boolean" || !digestPattern.test(result.digest ?? "")) {
      throw collaborationError("COLLAB_EVIDENCE_INVALID", "Test evidence is invalid.")
    }
    transition("tests_in_progress")
    const ref = `test-${candidateSha.slice(0, 12)}`
    registerEvidence({ kind: "test", ref, digest: result.digest, sizeBytes: 1024, candidateSha }, "ppo-test-runner")
    tests = Object.freeze({ candidateSha, passed: result.passed, ref, digest: result.digest })

    if (!result.passed) {
      transition("tests_failed")
      const area = candidateArea ?? "frontend"
      return issueCorrection(area, [{ code: "tests_failed", severity: "P1", area, summary: "Automated tests failed for the candidate." }], ref)
    }
    transition("tests_passed")
    return tryAssign(reviewSpec())
  }

  function prepareRelease() {
    if (status !== "review_passed" || !tests?.passed || tests.candidateSha !== candidateSha || review?.decision !== "approved" || review.candidateSha !== candidateSha) {
      throw collaborationError("COLLAB_RELEASE_NOT_READY", "Release package needs passing tests and an approving independent review for the exact current candidate.")
    }
    assertReviewerIndependent(review.reviewer, implementers)
    if (!isEvidenceCurrent(tests.ref) || !isEvidenceCurrent(review.ref)) {
      throw collaborationError("COLLAB_EVIDENCE_STALE", "Release evidence is not current for this candidate.")
    }
    // Defence in depth: every original finding must be explicitly resolved or noted.
    assertFindingsAccountedFor(findingLedger)
    const core = {
      kind: "simulated_software_factory_release_candidate",
      runId,
      runVersion: version,
      projectId,
      baseSha,
      headSha: candidateSha,
      planHash: plan.planHash,
      scopeDigest: scope.scopeDigest,
      contractDigest: contract.digest,
      tests: { ref: tests.ref, digest: tests.digest },
      review: { ref: review.ref, reviewer: review.reviewer },
      implementers: [...implementers].sort(),
      correctionRounds: correctionRound,
      findings: summarizeFindingLedger(findingLedger),
      authority: { merge: "owner_approval_required", productionDeployment: "not_authorized" }
    }
    const packageHash = collaborationSha256(collaborationStableStringify(core))
    releasePackage = collaborationDeepFreeze({ ...core, packageHash })
    registerEvidence({ kind: "release_package", ref: `release-${packageHash.slice(0, 12)}`, digest: packageHash, sizeBytes: 2048, candidateSha }, "ppo-release-package")
    transition("merge_ready")
    phase = "awaiting_owner_approval"
    outbound({
      messageType: "release_package_ready",
      recipient: { role: "owner", providerId: "owner" },
      stepId: "release",
      attemptNumber: correctionRound + 1,
      candidateSha,
      contractDigest: contract.digest,
      evidence: [`release-${packageHash.slice(0, 12)}`, tests.ref, review.ref].map(evidenceEntry),
      requestedAction: "await_owner",
      summary: "Release package prepared; owner approval is required."
    })
    return releasePackage
  }

  function recordOwnerDecision(decision) {
    // Simulated owner decision. Reusable pure rule checks the exact binding and
    // freshness; this model only records the result. It performs no merge.
    if (status !== "merge_ready") {
      throw collaborationError("COLLAB_STALE_OWNER_APPROVAL", "No current release package exists for this approval.")
    }
    assessOwnerReleaseApproval({
      decision, releasePackage, headSha: candidateSha, scopeDigest: scope.scopeDigest,
      nowMs: now(), ttlMs: SOFTWARE_FACTORY_COLLABORATION_OWNER_APPROVAL_TTL_MS
    })
    lastOwnerDecision = Object.freeze({
      decision: decision.decision,
      packageHash: decision.packageHash,
      headSha: decision.headSha,
      simulated: true,
      mergePerformed: false,
      authority: "simulated_decision_only"
    })
    commit("simulated_owner_decision", { decision: decision.decision, packageHash: decision.packageHash, headSha: decision.headSha })
    return lastOwnerDecision
  }

  function reconcileContract(decision) {
    if (!checkpoint || checkpoint.reasonCode !== "CONTRACT_CHANGED" || !pendingContract) {
      throw collaborationError("COLLAB_OUT_OF_ORDER", "No contract change is awaiting reconciliation.")
    }
    if (!decision || decision.ownerId !== "owner" || decision.newContractDigest !== pendingContract.digest) {
      throw collaborationError("COLLAB_RECONCILIATION_INVALID", "Reconciliation is not bound to the proposed contract digest.")
    }
    if (decision.decision === "reject") {
      checkpoint = null
      transition("cancelled")
      return Object.freeze({ status: "cancelled" })
    }
    const evidence = evidenceLedger.get(pendingContract.evidenceRef)
    const accepted = pendingContract
    pendingContract = null
    contract = Object.freeze({ digest: accepted.digest, evidenceRef: accepted.evidenceRef, evidenceDigest: evidence.digest, candidateSha: accepted.candidateSha })
    commit("contract_reconciled", { contractDigest: contract.digest })
    checkpoint = null
    review = null
    tests = null
    return tryAssign(frontendSpec())
  }

  function resume() {
    if (!checkpoint || !checkpointResume || !checkpoint.resumable) {
      throw collaborationError("COLLAB_RESUME_REFUSED", "This checkpoint cannot be resumed without an owner decision.")
    }
    const spec = checkpointResume
    checkpoint = null
    checkpointResume = null
    commit("resume_requested", { role: spec.role })
    return tryAssign(spec)
  }

  function snapshot() {
    return collaborationDeepFreeze({
      modelId: SOFTWARE_FACTORY_COLLABORATION_SIMULATION_MODEL_ID,
      runId,
      projectId,
      runVersion: version,
      status,
      phase,
      baseSha,
      candidateSha,
      contractDigest: contract?.digest ?? null,
      correctionRound,
      implementers: [...implementers].sort(),
      findingLedger: summarizeFindingLedger(findingLedger),
      checkpoint,
      expected,
      testsPassedForCandidate: tests?.passed === true && tests.candidateSha === candidateSha,
      approvedReviewForCandidate: review?.decision === "approved" && review.candidateSha === candidateSha,
      releasePackage,
      ownerDecision: lastOwnerDecision,
      workspace: guard.state(workspaceId),
      authority: { grantsAuthority: false, merge: "owner_approval_required", productionDeployment: "not_authorized" }
    })
  }

  return Object.freeze({
    approveScope,
    admit,
    start,
    accept,
    observeProviderState,
    recordAdapterOutcome,
    recordTestEvidence,
    prepareRelease,
    recordOwnerDecision,
    reconcileContract,
    resume,
    isEvidenceCurrent,
    snapshot,
    events: () => [...events],
    outbox: () => [...outbox],
    invalidations: () => [...invalidations],
    ledger: () => [...evidenceLedger.values()],
    findingLedger: () => summarizeFindingLedger(findingLedger),
    workspaceHistory: () => guard.history()
  })
}
