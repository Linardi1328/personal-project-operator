import assert from "node:assert/strict"
import test from "node:test"
import {
  SoftwareFactoryCollaborationError,
  createTrustedCollaborationRegistry,
  SOFTWARE_FACTORY_COLLABORATION_DEFAULT_REGISTRY_CONFIG
} from "./software-factory-collaboration-contract.mjs"
import { routeCollaborationStep } from "./software-factory-collaboration-routing.mjs"
import {
  buildBaselineSoftwareFactoryPlan,
  resolveSoftwareFactoryTaskRole
} from "./software-factory-plan-contract.mjs"
import { assertAntigravityImplementationOwnership } from "./software-factory-antigravity-execution.mjs"
import { SOFTWARE_FACTORY_CAPACITY_STATES } from "./software-factory-control-plane.mjs"

function registry(claudeTrialRoles = []) {
  const config = structuredClone(SOFTWARE_FACTORY_COLLABORATION_DEFAULT_REGISTRY_CONFIG)
  config.providers.claude.trialApprovedRoles = claudeTrialRoles
  return createTrustedCollaborationRegistry(config)
}

const ok = { integration: "configured", capacity: "available", billingPath: "included" }
function states(overrides = {}) {
  return { codex: { ...ok }, claude: { ...ok }, antigravity: { ...ok }, ...overrides }
}
function route(overrides) {
  return routeCollaborationStep({
    registry: registry(),
    role: "backend_implementer",
    taskCapability: "implementation.backend",
    implementers: [],
    providerStates: states(),
    ...overrides
  })
}
const withCapacity = (capacity) => ({ ...ok, capacity })

test("backend work routes to the established primary and never silently to Claude", () => {
  const decision = route()
  assert.equal(decision.outcome, "ready")
  assert.equal(decision.providerId, "codex")
  assert.equal(decision.usedAlternate, false)
  assert.equal(decision.evaluationProvider, false)
  assert.equal(decision.consumeAttempt, true)
  assert.equal(decision.mandatory, false)
})

test("routing decisions are frozen, deterministic, and grant nothing", () => {
  const left = route()
  const right = route()
  assert.deepEqual(left, right)
  assert.ok(Object.isFrozen(left))
  assert.equal(left.grantsAuthority, false)
  assert.deepEqual(left.permissionsGranted, [])
  assert.equal(left.paidApiUsage, "not_authorized")
  assert.equal(left.reviewBypassPermitted, false)
})

test("Codex quota exhaustion routes to Claude only when the owner approved that trial role", () => {
  const exhausted = states({ codex: withCapacity("exhausted") })

  const approved = routeCollaborationStep({
    registry: registry(["backend_implementer"]), role: "backend_implementer", taskCapability: "implementation.backend",
    implementers: [], providerStates: exhausted
  })
  assert.equal(approved.outcome, "ready")
  assert.equal(approved.providerId, "claude")
  assert.equal(approved.usedAlternate, true)
  assert.equal(approved.evaluationProvider, true)
  assert.equal(approved.considered[0].reasonCode, "WORKER_CAPACITY_EXHAUSTED")

  const notApproved = route({ providerStates: exhausted })
  assert.equal(notApproved.outcome, "blocked_capacity")
  assert.equal(notApproved.reasonCode, "NO_ELIGIBLE_PROVIDER")
  assert.equal(notApproved.providerId, null)
  assert.equal(notApproved.checkpointRequired, true)
  assert.equal(notApproved.consumeAttempt, false)
  assert.equal(notApproved.retryable, true)
  assert.deepEqual(notApproved.considered.map((entry) => entry.reasonCode), ["WORKER_CAPACITY_EXHAUSTED", "PROVIDER_TRIAL_NOT_APPROVED"])

  // Approving Claude only as a reviewer does not approve it as a backend worker.
  const reviewerOnly = routeCollaborationStep({
    registry: registry(["independent_reviewer"]), role: "backend_implementer", taskCapability: "implementation.backend",
    implementers: [], providerStates: exhausted
  })
  assert.equal(reviewerOnly.outcome, "blocked_capacity")
})

test("every capacity state is handled and fails closed", () => {
  for (const capacity of SOFTWARE_FACTORY_CAPACITY_STATES) {
    const decision = route({ providerStates: states({ codex: withCapacity(capacity) }) })
    switch (capacity) {
      case "available":
      case "degraded":
        assert.equal(decision.outcome, "ready")
        assert.equal(decision.providerId, "codex")
        assert.equal(decision.reasonCode, capacity === "degraded" ? "WORKER_DEGRADED" : "WORKER_READY")
        break
      case "exhausted":
      case "rate_limited":
        assert.equal(decision.outcome, "blocked_capacity")
        assert.equal(decision.retryable, true)
        break
      case "unavailable":
        assert.equal(decision.outcome, "blocked_external")
        assert.equal(decision.retryable, true)
        break
      case "unknown":
        assert.equal(decision.outcome, "blocked_external")
        assert.equal(decision.retryable, false)
        break
      default:
        assert.fail(`unhandled capacity ${capacity}`)
    }
  }
})

test("a provider with no reported state is never assumed available", () => {
  const decision = route({ providerStates: {} })
  assert.equal(decision.outcome, "blocked_external")
  assert.equal(decision.providerId, null)
  assert.equal(decision.considered[0].reasonCode, "WORKER_CAPACITY_UNKNOWN")
  assert.equal(decision.retryable, false)
})

test("paid or unknown billing paths and unconfigured integrations are never used as silent fallbacks", () => {
  const trial = registry(["backend_implementer", "independent_reviewer"])
  const exhausted = (claude) => states({ codex: withCapacity("exhausted"), claude })
  for (const billingPath of ["paid_api", "unknown"]) {
    const decision = routeCollaborationStep({
      registry: trial, role: "backend_implementer", taskCapability: "implementation.backend", implementers: [],
      providerStates: exhausted({ ...ok, billingPath })
    })
    assert.equal(decision.outcome, "blocked_capacity")
    assert.equal(decision.providerId, null)
    assert.equal(decision.considered[1].reasonCode, "PAID_FALLBACK_NOT_AUTHORIZED")
    assert.equal(decision.paidApiUsage, "not_authorized")
  }
  const unconfigured = routeCollaborationStep({
    registry: trial, role: "backend_implementer", taskCapability: "implementation.backend", implementers: [],
    providerStates: exhausted({ ...ok, integration: "unconfigured" })
  })
  assert.equal(unconfigured.providerId, null)
  assert.equal(unconfigured.considered[1].reasonCode, "PROVIDER_INTEGRATION_UNCONFIGURED")
})

test("frontend work routes only to Antigravity and has no backend fallback", () => {
  const ready = route({ role: "frontend_implementer", taskCapability: "implementation.frontend" })
  assert.equal(ready.providerId, "antigravity")

  const unavailable = route({
    role: "frontend_implementer", taskCapability: "implementation.frontend",
    providerStates: states({ antigravity: withCapacity("unavailable") })
  })
  assert.equal(unavailable.outcome, "blocked_external")
  assert.deepEqual(unavailable.considered.map((entry) => entry.providerId), ["antigravity"])

  const exhausted = route({
    role: "frontend_implementer", taskCapability: "implementation.frontend",
    providerStates: states({ antigravity: withCapacity("exhausted") })
  })
  assert.equal(exhausted.outcome, "blocked_capacity")
  assert.equal(exhausted.providerId, null)
})

test("role classification is never loosened: mixed, mismatched and unresolved work goes to the owner", () => {
  const mixed = route({ role: "frontend_implementer", taskCapability: "debugging" })
  assert.equal(mixed.outcome, "owner_action_required")
  assert.equal(mixed.reasonCode, "OWNER_RECONCILIATION_REQUIRED")
  assert.equal(mixed.providerId, null)

  // A frontend step may never be filled for a backend capability, and vice versa.
  const frontendForBackend = route({ role: "frontend_implementer", taskCapability: "implementation.backend" })
  assert.equal(frontendForBackend.outcome, "owner_action_required")
  assert.equal(frontendForBackend.reasonCode, "CAPABILITY_MISMATCH")
  const backendForFrontend = route({ role: "backend_implementer", taskCapability: "implementation.frontend" })
  assert.equal(backendForFrontend.reasonCode, "CAPABILITY_MISMATCH")
  const missing = route({ taskCapability: undefined })
  assert.equal(missing.reasonCode, "CAPABILITY_MISMATCH")
  assert.equal(route({ taskCapability: "implementation.everything" }).outcome, "owner_action_required")
})

test("the existing plan classifier and Antigravity ownership guard are unchanged by this slice", () => {
  const mixedObjective = "Add a greeting API endpoint on the backend and a responsive greeting page UI on the frontend."
  const plan = buildBaselineSoftwareFactoryPlan({
    runId: "S".repeat(43), projectId: "synthetic-greeter", baseSha: "a".repeat(40), objective: mixedObjective
  })
  // Mixed work stays "debugging" (unresolved ownership). It never becomes an edit role.
  assert.equal(plan.capabilityHint, "debugging")

  const frontendOnly = buildBaselineSoftwareFactoryPlan({
    runId: "S".repeat(43), projectId: "synthetic-greeter", baseSha: "a".repeat(40),
    objective: "Fix the responsive registration form accessibility failure."
  })
  assert.equal(frontendOnly.capabilityHint, "implementation.frontend")

  const backendRun = {
    runId: "S".repeat(43), baseSha: "a".repeat(40), project: { id: "synthetic-greeter" },
    task: "Add a database migration and API endpoint for greetings.", evidence: { planning: [] }
  }
  assert.equal(resolveSoftwareFactoryTaskRole(backendRun), "implementation.backend")
  assert.throws(() => assertAntigravityImplementationOwnership(backendRun), { code: "ANTIGRAVITY_BACKEND_OWNERSHIP_REFUSED" })
})

test("independent review excludes every provider that implemented the candidate", () => {
  const trial = registry(["independent_reviewer"])
  const reviewer = (implementers, providerStates = states()) => routeCollaborationStep({
    registry: trial, role: "independent_reviewer", implementers, providerStates
  })

  const afterCodexBackend = reviewer(["codex", "antigravity"])
  assert.equal(afterCodexBackend.outcome, "ready")
  assert.equal(afterCodexBackend.providerId, "claude")
  assert.equal(afterCodexBackend.mandatory, true)
  assert.equal(afterCodexBackend.considered[0].reasonCode, "REVIEW_INDEPENDENCE_REQUIRED")

  const afterClaudeBackend = reviewer(["claude", "antigravity"])
  assert.equal(afterClaudeBackend.providerId, "codex")

  // Same agent as implementer and reviewer is never allowed, even as the only option.
  const onlyCodexAvailable = reviewer(["codex"], states({ claude: withCapacity("unavailable") }))
  assert.equal(onlyCodexAvailable.providerId, null)
  assert.equal(onlyCodexAvailable.reasonCode, "NO_ELIGIBLE_REVIEWER")
  assert.equal(onlyCodexAvailable.reviewBypassPermitted, false)

  // Both backend-capable providers contributed: nobody independent is left.
  const bothImplemented = reviewer(["codex", "claude", "antigravity"])
  assert.equal(bothImplemented.outcome, "owner_action_required")
  assert.equal(bothImplemented.reasonCode, "NO_ELIGIBLE_REVIEWER")
  assert.equal(bothImplemented.checkpointRequired, true)
})

test("an unavailable mandatory reviewer checkpoints instead of bypassing review", () => {
  const trial = registry(["independent_reviewer"])
  const exhausted = routeCollaborationStep({
    registry: trial, role: "independent_reviewer", implementers: ["claude", "antigravity"],
    providerStates: states({ codex: withCapacity("exhausted") })
  })
  assert.equal(exhausted.outcome, "blocked_capacity")
  assert.equal(exhausted.reasonCode, "NO_ELIGIBLE_REVIEWER")
  assert.equal(exhausted.checkpointRequired, true)
  assert.equal(exhausted.retryable, true)

  const unknown = routeCollaborationStep({
    registry: trial, role: "independent_reviewer", implementers: ["claude", "antigravity"],
    providerStates: states({ codex: withCapacity("unknown") })
  })
  assert.equal(unknown.outcome, "blocked_external")
  assert.equal(unknown.reasonCode, "NO_ELIGIBLE_REVIEWER")

  const untrustedClaude = routeCollaborationStep({
    registry: registry(), role: "independent_reviewer", implementers: ["codex"], providerStates: states()
  })
  assert.equal(untrustedClaude.outcome, "owner_action_required")
  assert.equal(untrustedClaude.considered[1].reasonCode, "PROVIDER_TRIAL_NOT_APPROVED")
})

test("a preferred provider only reorders trusted candidates", () => {
  const trial = registry(["backend_implementer"])
  const preferClaude = routeCollaborationStep({
    registry: trial, role: "backend_implementer", taskCapability: "implementation.backend", implementers: [],
    providerStates: states(), preferProviderId: "claude"
  })
  assert.equal(preferClaude.providerId, "claude")
  // Preference cannot add an untrusted or role-less provider.
  const preferFrontend = routeCollaborationStep({
    registry: trial, role: "backend_implementer", taskCapability: "implementation.backend", implementers: [],
    providerStates: states(), preferProviderId: "antigravity"
  })
  assert.equal(preferFrontend.providerId, "codex")
  const preferUnknown = routeCollaborationStep({
    registry: trial, role: "backend_implementer", taskCapability: "implementation.backend", implementers: [],
    providerStates: states(), preferProviderId: "mallory"
  })
  assert.equal(preferUnknown.providerId, "codex")
  // A preferred but unavailable provider is skipped, not forced.
  const preferExhausted = routeCollaborationStep({
    registry: trial, role: "backend_implementer", taskCapability: "implementation.backend", implementers: [],
    providerStates: states({ claude: withCapacity("exhausted") }), preferProviderId: "claude"
  })
  assert.equal(preferExhausted.providerId, "codex")
})

test("invalid routing input and provider state are rejected", () => {
  const invalid = (input, code) => assert.throws(() => routeCollaborationStep(input), (error) => {
    assert.ok(error instanceof SoftwareFactoryCollaborationError)
    assert.equal(error.code, code)
    return true
  })
  invalid(null, "COLLAB_ROUTING_INPUT_INVALID")
  invalid({ registry: registry(), role: "coordinator", providerStates: states() }, "COLLAB_ROUTING_ROLE_INVALID")
  invalid({ registry: registry(), role: "owner" }, "COLLAB_ROUTING_ROLE_INVALID")
  invalid({ registry: { providers: {}, assignments: {} }, role: "backend_implementer" }, "COLLAB_REGISTRY_UNTRUSTED")
  invalid({ registry: registry(), role: "backend_implementer", taskCapability: "implementation.backend", implementers: ["mallory"], providerStates: states() }, "COLLAB_ROUTING_INPUT_INVALID")
  invalid({ registry: registry(), role: "backend_implementer", taskCapability: "implementation.backend", implementers: [], providerStates: states({ codex: { integration: "configured", capacity: "available" } }) }, "COLLAB_ROUTING_STATE_INVALID")
  invalid({ registry: registry(), role: "backend_implementer", taskCapability: "implementation.backend", implementers: [], providerStates: states({ codex: { ...ok, capacity: "great" } }) }, "COLLAB_ROUTING_STATE_INVALID")
  invalid({ registry: registry(), role: "backend_implementer", taskCapability: "implementation.backend", implementers: [], providerStates: states({ codex: { ...ok, billingPath: "free" } }) }, "COLLAB_ROUTING_STATE_INVALID")
  invalid({ registry: registry(), role: "backend_implementer", taskCapability: "implementation.backend", implementers: [], providerStates: states({ codex: { ...ok, extra: 1 } }) }, "COLLAB_ROUTING_STATE_INVALID")
})
