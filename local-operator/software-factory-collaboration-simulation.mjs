import {
  buildCollaborationEnvelope,
  buildCollaborationScope,
  collaborationDeepFreeze,
  collaborationError,
  collaborationSha256,
  collaborationStableStringify,
  createTrustedCollaborationRegistry,
  SOFTWARE_FACTORY_COLLABORATION_DEFAULT_REGISTRY_CONFIG
} from "./software-factory-collaboration-contract.mjs"
import {
  createSimulationRunModel,
  verifyCollaborationEventChain
} from "./software-factory-collaboration-simulation-model.mjs"
import { buildBaselineSoftwareFactoryPlan, resolveSoftwareFactoryTaskRole } from "./software-factory-plan-contract.mjs"
import { createSoftwareFactoryAutonomousRunner } from "./software-factory-autonomous-run.mjs"

// RIC-181 TEST-ONLY deterministic offline simulation fixture.
//
// Everything here is a disposable fixture. The "adapters" are plain functions that
// return data. Nothing in this module spawns a process, opens a socket, reads or
// writes a file, calls a provider, registers a dispatcher, or touches canonical
// PPO run records. It is not imported by any command, runner or service.
//
// The stepping loop is the EXISTING software-factory autonomous runner
// (createSoftwareFactoryAutonomousRunner), constructed with all four of its
// injectable dependencies replaced by in-memory fakes. Its catalog gate, stale
// state retry, no-progress detection, step limit and release-ready stop all apply
// unchanged. The default runner, which would read canonical run state, is never
// used (a test enforces this).

export const SOFTWARE_FACTORY_COLLABORATION_SIMULATION_ID = "software-factory-collaboration-offline-simulation-v1"
export const SOFTWARE_FACTORY_COLLABORATION_SIMULATION_EFFECTS = Object.freeze({
  realProviderProcesses: 0,
  networkCalls: 0,
  filesystemWrites: 0,
  canonicalRunWrites: 0,
  dispatcherRegistrations: 0
})

export const SYNTHETIC_RUN_ID = "S".repeat(43)
export const SYNTHETIC_PROJECT_ID = "synthetic-greeter"
export const SYNTHETIC_BASE_SHA = "a".repeat(40)
export const SYNTHETIC_CORRELATION_ID = "c0ffee".repeat(5) + "ab"
export const SYNTHETIC_WORKSPACE_ID = "synthetic-ws-1"
export const SYNTHETIC_OBJECTIVE =
  "Add a greeting API endpoint on the backend and a responsive greeting page UI on the frontend."

export const SYNTHETIC_NOW_MS = 1_800_000_000_000
const NOW_MS = SYNTHETIC_NOW_MS

export function syntheticSha(label) {
  return collaborationSha256(`synthetic-sha:${label}`).slice(0, 40)
}

export function syntheticApiContract(version = 1) {
  return {
    endpoint: "GET /v1/greetings",
    contractVersion: version,
    response: { greeting: "string", locale: "string" },
    errors: ["400 invalid_locale"]
  }
}

export function syntheticContractDigest(version = 1) {
  return collaborationSha256(collaborationStableStringify(syntheticApiContract(version)))
}

export function syntheticCatalog(active = []) {
  return {
    ok: true,
    code: "ok",
    active,
    diagnostics: { scanned: active.length, returned: active.length, invalid: 0, outOfScope: 0, truncated: false }
  }
}

export function syntheticRegistry({ claudeTrialRoles = [] } = {}) {
  const config = structuredClone(SOFTWARE_FACTORY_COLLABORATION_DEFAULT_REGISTRY_CONFIG)
  config.providers.claude.trialApprovedRoles = [...claudeTrialRoles]
  return createTrustedCollaborationRegistry(config)
}

export function syntheticPlanAndScope() {
  const plan = buildBaselineSoftwareFactoryPlan({
    runId: SYNTHETIC_RUN_ID,
    projectId: SYNTHETIC_PROJECT_ID,
    baseSha: SYNTHETIC_BASE_SHA,
    objective: SYNTHETIC_OBJECTIVE
  })
  const scope = buildCollaborationScope({
    planHash: plan.planHash,
    steps: [
      { stepId: "backend", role: "backend_implementer" },
      { stepId: "frontend", role: "frontend_implementer" },
      { stepId: "review", role: "independent_reviewer" }
    ]
  })
  return { plan, scope }
}

// Existing providers, all synthetic observations. billingPath "included" means
// the simulation assumes no per-token spend; it is not a claim about any real
// subscription (see the compatibility matrix for the real unknowns).
export function syntheticProviderStates(overrides = {}) {
  const available = { integration: "configured", capacity: "available", billingPath: "included" }
  return { codex: { ...available }, claude: { ...available }, antigravity: { ...available }, ...overrides }
}

// ---------------------------------------------------------------------------
// Fake workspace and adapters

export function createFakeWorkspace() {
  const workspace = { head: SYNTHETIC_BASE_SHA, clean: true }
  return Object.freeze({
    inspect: () => ({ head: workspace.head, clean: workspace.clean }),
    commit(sha) {
      workspace.head = sha
      workspace.clean = true
    },
    leaveDirty() {
      workspace.clean = false
    }
  })
}

function evidence(kind, label, candidateSha, digest) {
  const ref = `${kind.replace("_", "-")}-${collaborationSha256(label).slice(0, 12)}`
  return { kind, ref, digest: digest ?? collaborationSha256(`evidence:${label}`), sizeBytes: 2048, candidateSha }
}

function agentEnvelope(registry, assignment, providerId, role, fields) {
  return buildCollaborationEnvelope({
    projectId: SYNTHETIC_PROJECT_ID,
    runId: SYNTHETIC_RUN_ID,
    expectedRunVersion: assignment.runVersion,
    correlationId: SYNTHETIC_CORRELATION_ID,
    stepId: assignment.stepId,
    attemptNumber: assignment.attemptNumber,
    sender: { role, providerId },
    recipient: { role: "coordinator", providerId: "ppo" },
    baseSha: SYNTHETIC_BASE_SHA,
    ...fields
  }, registry).envelope
}

/**
 * Fake provider adapters. Each returns either a handoff envelope (as plain
 * data) or a non-success outcome. Nothing is executed.
 */
export function createFakeAdapters({ registry, planHash, scopeDigest, workspace, script }) {
  const calls = []

  function bound(fields) {
    return { planHash, scopeDigest, ...fields }
  }

  function backend(assignment, snapshot) {
    const providerId = assignment.providerId
    calls.push({ fake: true, providerId, role: assignment.role, stepId: assignment.stepId, attemptNumber: assignment.attemptNumber })
    const behavior = script.adapterBehavior?.[`backend:${assignment.attemptNumber}`]
    if (behavior === "timeout" || behavior === "ambiguous") {
      workspace.leaveDirty()
      return { outcome: behavior }
    }
    if (behavior === "quota_exhausted") {
      return { envelope: agentEnvelope(registry, assignment, providerId, "backend_implementer", bound({
        messageType: "provider_unavailable",
        reasonCode: "quota_exhausted",
        evidence: [evidence("provider_status", `status:${providerId}:${assignment.attemptNumber}`, null)],
        requestedAction: "reroute_or_checkpoint",
        summary: "Provider reports its usage quota is exhausted."
      })) }
    }
    const contractVersion = script.contractVersionByAttempt?.[assignment.attemptNumber] ?? 1
    const contractDigest = syntheticContractDigest(contractVersion)
    const candidateSha = syntheticSha(`backend:${providerId}:${assignment.attemptNumber}`)
    workspace.commit(candidateSha)
    const base = bound({
      candidateSha,
      contractDigest,
      requestedAction: assignment.messageType === "contract_ready" ? "relay_contract" : "run_tests"
    })
    if (assignment.messageType === "contract_ready") {
      return { envelope: agentEnvelope(registry, assignment, providerId, "backend_implementer", {
        ...base,
        messageType: "contract_ready",
        evidence: [evidence("contract", `contract:${contractVersion}:${candidateSha}`, candidateSha, contractDigest)],
        summary: "Versioned greeting API contract is ready."
      }) }
    }
    return { envelope: agentEnvelope(registry, assignment, providerId, "backend_implementer", {
      ...base,
      messageType: "implementation_ready",
      evidence: [
        evidence("implementation", `backend-impl:${candidateSha}`, candidateSha),
        // A backend change that alters the API contract must carry its own contract evidence.
        ...(contractDigest === syntheticContractDigest(1) ? [] : [evidence("contract", `contract:${contractVersion}:${candidateSha}`, candidateSha, contractDigest)])
      ],
      summary: "Backend correction applied and a new candidate is ready."
    }) }
  }

  function frontend(assignment, snapshot) {
    const providerId = assignment.providerId
    calls.push({ fake: true, providerId, role: assignment.role, stepId: assignment.stepId, attemptNumber: assignment.attemptNumber })
    const contractDigest = assignment.issued?.contractDigest ?? snapshot.contractDigest
    const candidateSha = syntheticSha(`frontend:${providerId}:${assignment.attemptNumber}`)
    workspace.commit(candidateSha)
    return { envelope: agentEnvelope(registry, assignment, providerId, "frontend_implementer", bound({
      messageType: "implementation_ready",
      candidateSha,
      contractDigest,
      evidence: [evidence("implementation", `frontend-impl:${candidateSha}`, candidateSha)],
      requestedAction: "run_tests",
      summary: "Frontend greeting page implemented against the approved contract."
    })) }
  }

  function reviewer(assignment, snapshot) {
    const providerId = assignment.providerId
    calls.push({ fake: true, providerId, role: assignment.role, stepId: assignment.stepId, attemptNumber: assignment.attemptNumber })
    const verdict = script.reviews?.[assignment.attemptNumber - 1] ?? { decision: "approved" }
    const candidateSha = snapshot.candidateSha
    // By default a reviewer explicitly resolves every addressed finding it does not
    // re-raise. A scenario can override this with `resolves` to model a reviewer
    // that fails to account for a finding.
    const raised = new Set((verdict.findings ?? []).map((finding) => finding.code))
    const resolvedFindings = verdict.resolves ?? snapshot.findingLedger
      .filter((entry) => entry.status === "addressed" && !raised.has(entry.code))
      .map((entry) => entry.code)
    return { envelope: agentEnvelope(registry, assignment, providerId, "independent_reviewer", bound({
      messageType: "review_finding",
      candidateSha,
      reviewDecision: verdict.decision,
      findings: verdict.findings ?? [],
      resolvedFindings,
      evidence: [evidence("review", `review:${providerId}:${assignment.attemptNumber}:${candidateSha}`, candidateSha)],
      requestedAction: "evaluate_review",
      summary: verdict.decision === "approved"
        ? "No blocking finding for the reviewed candidate."
        : "Blocking finding requires a correction."
    })) }
  }

  function execute(assignment, snapshot) {
    if (assignment.role === "backend_implementer") return backend(assignment, snapshot)
    if (assignment.role === "frontend_implementer") return frontend(assignment, snapshot)
    return reviewer(assignment, snapshot)
  }

  function testRunner(candidateSha, index) {
    const passed = script.tests?.[index] ?? true
    return { candidateSha, passed, digest: collaborationSha256(`tests:${candidateSha}:${passed}`) }
  }

  return Object.freeze({ execute, testRunner, calls: () => [...calls] })
}

// ---------------------------------------------------------------------------
// Scenarios

export const SIMULATION_SCENARIOS = Object.freeze({
  full_lifecycle_with_correction: Object.freeze({
    id: "full_lifecycle_with_correction",
    description: "Backend contract, frontend implementation, tests, independent review requiring a correction, corrected candidate, exact-candidate re-verification and release package.",
    claudeTrialRoles: ["independent_reviewer"],
    providerStates: syntheticProviderStates(),
    reviews: [
      {
        decision: "changes_requested",
        findings: [{ code: "missing_aria_label", severity: "P1", area: "frontend", summary: "The greeting form control has no accessible label." }]
      },
      { decision: "approved" }
    ],
    tests: [true, true]
  }),
  mixed_area_findings_two_corrections: Object.freeze({
    id: "mixed_area_findings_two_corrections",
    description: "A review raises one backend and one frontend finding. Both areas must be corrected, then the re-review must explicitly resolve both before a release package can exist.",
    claudeTrialRoles: ["independent_reviewer"],
    providerStates: syntheticProviderStates(),
    reviews: [
      {
        decision: "changes_requested",
        findings: [
          { code: "wrong_status_code", severity: "P1", area: "backend", summary: "The endpoint returns the wrong status for an invalid locale." },
          { code: "missing_aria_label", severity: "P1", area: "frontend", summary: "The greeting form control has no accessible label." }
        ]
      },
      { decision: "approved" }
    ],
    tests: [true, true]
  }),
  codex_quota_alternate_routing: Object.freeze({
    id: "codex_quota_alternate_routing",
    description: "Codex quota exhaustion routes backend work to the trial alternate, then checkpoints because the only independent reviewer is exhausted, then resumes after a trusted capacity observation.",
    claudeTrialRoles: ["backend_implementer", "independent_reviewer"],
    providerStates: syntheticProviderStates({ codex: { integration: "configured", capacity: "exhausted", billingPath: "included" } }),
    recover: { afterCheckpoint: 1, observe: { providerId: "codex", state: { integration: "configured", capacity: "available", billingPath: "included" } } },
    reviews: [{ decision: "approved" }],
    tests: [true]
  })
})

function blockedOutcome(checkpoint) {
  const outcome = checkpoint.kind === "blocked_capacity" || checkpoint.kind === "blocked_external"
    ? checkpoint.kind
    : "owner_action_required"
  return { ok: false, outcome, action: "checkpoint", reason: checkpoint.reasonCode.toLowerCase() }
}

/**
 * Run one scenario to its stopping point by driving the existing autonomous
 * runner. Every scenario stops at "release ready" (merge_ready, owner approval
 * required) or at an unrecovered checkpoint; none merges, deploys or approves.
 */
export async function runCollaborationSimulation(scenario) {
  const registry = syntheticRegistry({ claudeTrialRoles: scenario.claudeTrialRoles ?? [] })
  const { plan, scope } = syntheticPlanAndScope()
  const workspace = createFakeWorkspace()
  const adapters = createFakeAdapters({ registry, planHash: plan.planHash, scopeDigest: scope.scopeDigest, workspace, script: scenario })

  const model = createSimulationRunModel({
    registry,
    plan,
    scope,
    correlationId: SYNTHETIC_CORRELATION_ID,
    workspaceId: SYNTHETIC_WORKSPACE_ID,
    providerStates: scenario.providerStates ?? syntheticProviderStates(),
    inspectWorkspace: workspace.inspect,
    now: () => NOW_MS
  })

  model.approveScope({ scopeDigest: scope.scopeDigest, approvedBy: "owner" })
  model.admit(syntheticCatalog())

  const transcript = []
  let testRuns = 0

  function note(step) {
    if (step?.status === "assigned") {
      const assignment = step.assignment
      transcript.push({ event: "assigned", providerId: assignment.providerId, role: assignment.role, stepId: assignment.stepId, attemptNumber: assignment.attemptNumber, usedAlternate: assignment.usedAlternate, evaluationProvider: assignment.evaluationProvider })
    }
    if (step?.status === "checkpoint") {
      transcript.push({ event: "checkpoint", reasonCode: step.checkpoint.reasonCode, kind: step.checkpoint.kind })
    }
    return step
  }

  // One continuation = one handoff, one test run or the release package. This is
  // the injected equivalent of executeDevelopmentContinue for the offline model.
  async function continueRun() {
    const snapshot = model.snapshot()

    if (snapshot.status === "created") {
      const step = note(model.start())
      return step.status === "checkpoint" ? blockedOutcome(step.checkpoint) : { ok: true, outcome: "progressed", action: "start" }
    }

    if (snapshot.checkpoint) {
      if (!snapshot.checkpoint.resumable) return blockedOutcome(snapshot.checkpoint)
      // Resume re-evaluates routing from current trusted state. It is not a blind retry.
      const step = note(model.resume())
      return step.status === "checkpoint" ? blockedOutcome(step.checkpoint) : { ok: true, outcome: "progressed", action: "resume" }
    }

    if (snapshot.expected) {
      const assignment = snapshot.expected
      const response = adapters.execute(assignment, snapshot)
      if (response.outcome) {
        transcript.push({ event: "adapter_outcome", providerId: assignment.providerId, outcome: response.outcome })
        const step = note(model.recordAdapterOutcome({ providerId: assignment.providerId, outcome: response.outcome }))
        return blockedOutcome(step.checkpoint)
      }
      const result = model.accept(response.envelope, { providerId: assignment.providerId })
      transcript.push({ event: "accepted", messageType: response.envelope.messageType, providerId: assignment.providerId })
      const next = note(result.next)
      return next.status === "checkpoint" ? blockedOutcome(next.checkpoint) : { ok: true, outcome: "progressed", action: "handoff" }
    }

    if (snapshot.phase === "awaiting_test_evidence") {
      const result = adapters.testRunner(snapshot.candidateSha, testRuns)
      testRuns += 1
      transcript.push({ event: "tests_recorded", candidateSha: snapshot.candidateSha, passed: result.passed })
      const next = note(model.recordTestEvidence(result))
      return next.status === "checkpoint" ? blockedOutcome(next.checkpoint) : { ok: true, outcome: "progressed", action: "tests" }
    }

    if (snapshot.phase === "ready_for_release_package") {
      const releasePackage = model.prepareRelease()
      transcript.push({ event: "release_package_prepared", headSha: releasePackage.headSha, packageHash: releasePackage.packageHash })
      return { ok: true, outcome: "progressed", action: "release_package" }
    }

    return { ok: false, outcome: "owner_action_required", action: "none", reason: "no_next_action" }
  }

  function projectRun() {
    const snapshot = model.snapshot()
    return {
      runId: SYNTHETIC_RUN_ID,
      version: snapshot.runVersion,
      status: snapshot.status,
      project: { id: SYNTHETIC_PROJECT_ID },
      headSha: snapshot.candidateSha,
      baseSha: SYNTHETIC_BASE_SHA,
      task: SYNTHETIC_OBJECTIVE
    }
  }

  // All four dependencies are injected; the default runner (which reads canonical
  // run state) is never constructed here.
  const runner = createSoftwareFactoryAutonomousRunner({
    listRuns: async () => syntheticCatalog(),
    readRun: async () => projectRun(),
    continueRun,
    buildReleasePackage: async () => model.snapshot().releasePackage
  })

  const runnerResults = []
  let runnerResult = await runner(SYNTHETIC_RUN_ID)
  runnerResults.push(runnerResult)
  let checkpointsSeen = 0

  // Between runner calls only trusted or owner inputs may change anything.
  for (let attempt = 0; attempt < 4 && runnerResult.outcome !== "release_ready"; attempt += 1) {
    const snapshot = model.snapshot()
    if (!snapshot.checkpoint) break
    checkpointsSeen += 1

    if (snapshot.checkpoint.reasonCode === "CONTRACT_CHANGED" && scenario.ownerContractDecision) {
      // The simulated owner explicitly reconciles a changed API contract.
      transcript.push({ event: "owner_contract_reconciliation", decision: scenario.ownerContractDecision })
      note(model.reconcileContract({
        ownerId: "owner",
        decision: scenario.ownerContractDecision,
        newContractDigest: snapshot.checkpoint.details.proposedDigest
      }))
      runnerResult = await runner(SYNTHETIC_RUN_ID)
      runnerResults.push(runnerResult)
      continue
    }

    const recovery = scenario.recover
    if (recovery && recovery.afterCheckpoint === checkpointsSeen && snapshot.checkpoint.resumable) {
      model.observeProviderState(recovery.observe.providerId, recovery.observe.state)
      transcript.push({ event: "trusted_capacity_observation", providerId: recovery.observe.providerId, capacity: recovery.observe.state.capacity })
      runnerResult = await runner(SYNTHETIC_RUN_ID)
      runnerResults.push(runnerResult)
      continue
    }
    break
  }

  const events = model.events()
  const snapshot = model.snapshot()
  return collaborationDeepFreeze({
    simulationId: SOFTWARE_FACTORY_COLLABORATION_SIMULATION_ID,
    scenarioId: scenario.id,
    taskRoleForSyntheticObjective: resolveSoftwareFactoryTaskRole({ task: SYNTHETIC_OBJECTIVE, runId: SYNTHETIC_RUN_ID, baseSha: SYNTHETIC_BASE_SHA, project: { id: SYNTHETIC_PROJECT_ID }, evidence: { planning: [] } }),
    planCapabilityHint: plan.capabilityHint,
    runner: {
      id: runnerResult.runnerId,
      outcome: runnerResult.outcome,
      reason: runnerResult.reason,
      stepCount: runnerResult.stepCount,
      invocations: runnerResults.length,
      outcomes: runnerResults.map((entry) => entry.outcome),
      history: runnerResult.history
    },
    stoppedAt: runnerResult.outcome === "release_ready" ? "awaiting_owner_approval" : "checkpoint",
    snapshot,
    transcript,
    events,
    eventChainValid: verifyCollaborationEventChain(events),
    outbox: model.outbox().map((entry) => ({ messageType: entry.envelope.messageType, recipient: entry.envelope.recipient, reasonCode: entry.envelope.reasonCode })),
    invalidatedEvidence: model.invalidations(),
    evidenceCurrent: Object.fromEntries(model.ledger().map((entry) => [entry.ref, model.isEvidenceCurrent(entry.ref)])),
    adapterCalls: adapters.calls(),
    effects: SOFTWARE_FACTORY_COLLABORATION_SIMULATION_EFFECTS,
    ownerApprovalRequired: snapshot.releasePackage ? snapshot.ownerDecision === null : null,
    authority: { grantsAuthority: false, merge: "owner_approval_required", productionDeployment: "not_authorized" },
    model
  })
}

export function assertSimulationIsSynthetic(result) {
  if (!result.adapterCalls.every((call) => call.fake === true)) {
    throw collaborationError("COLLAB_SIMULATION_NOT_SYNTHETIC", "Simulation invoked a non-fake adapter.")
  }
  return true
}
