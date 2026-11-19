import { SOFTWARE_FACTORY_CAPACITY_STATES } from "./software-factory-control-plane.mjs"
import {
  assertTrustedCollaborationRegistry,
  collaborationDeepFreeze,
  collaborationError
} from "./software-factory-collaboration-contract.mjs"

// RIC-181 provider-aware role routing. Pure and non-authorizing.
//
// This module decides which trusted provider could fill a role for one step. It
// never starts a provider, reads a credential, spends money, or changes a run.
// A routing decision is advice to the coordinator; it is not a dispatch
// authorization. Real dispatch still needs the existing fencing, capacity
// checkpoint and (for Antigravity) readiness authorization.
//
// It reuses the existing control-plane capacity vocabulary and dispatch outcome
// names so checkpoints stay comparable across the factory.

export const SOFTWARE_FACTORY_COLLABORATION_ROUTING_VERSION = 1

// Existing role classification is the only source of task capability. The
// existing classifier labels mixed frontend/backend work "debugging" on purpose.
// That label means "ownership unresolved", so it routes to the owner here and is
// never turned into an edit assignment for any provider.
const capabilityByRole = Object.freeze({
  backend_implementer: "implementation.backend",
  frontend_implementer: "implementation.frontend"
})

const billingPaths = new Set(["included", "paid_api", "unknown"])
const integrations = new Set(["configured", "unconfigured"])
const capacityStates = new Set(SOFTWARE_FACTORY_CAPACITY_STATES)

function normalizeProviderState(raw) {
  // A provider with no reported state is treated as unconfigured and unknown.
  // Fail closed: silence is never availability.
  if (raw === undefined || raw === null) {
    return { integration: "unconfigured", capacity: "unknown", billingPath: "unknown" }
  }
  if (
    typeof raw !== "object" || Array.isArray(raw) ||
    Object.keys(raw).sort().join("|") !== "billingPath|capacity|integration" ||
    !integrations.has(raw.integration) || !capacityStates.has(raw.capacity) || !billingPaths.has(raw.billingPath)
  ) {
    throw collaborationError("COLLAB_ROUTING_STATE_INVALID", "Provider state is invalid.")
  }
  return { integration: raw.integration, capacity: raw.capacity, billingPath: raw.billingPath }
}

function capacityOutcome(capacity) {
  switch (capacity) {
    case "available":
    case "degraded":
      return null
    case "exhausted":
      return { reason: "WORKER_CAPACITY_EXHAUSTED", blocked: "blocked_capacity", retryable: true }
    case "rate_limited":
      return { reason: "WORKER_RATE_LIMITED", blocked: "blocked_capacity", retryable: true }
    case "unavailable":
      return { reason: "WORKER_UNAVAILABLE", blocked: "blocked_external", retryable: true }
    default:
      return { reason: "WORKER_CAPACITY_UNKNOWN", blocked: "blocked_external", retryable: false }
  }
}

function blockedDecision(base, outcome, reasonCode, retryable, considered) {
  return collaborationDeepFreeze({
    ...base,
    outcome,
    reasonCode,
    providerId: null,
    retryable,
    consumeAttempt: false,
    checkpointRequired: true,
    usedAlternate: false,
    evaluationProvider: false,
    considered
  })
}

/**
 * Decide which trusted provider may fill `role` for one step.
 *
 * input: {
 *   registry,            // trusted registry from createTrustedCollaborationRegistry
 *   role,                // backend_implementer | frontend_implementer | independent_reviewer
 *   taskCapability,      // implementer roles only: existing role-classification result
 *   implementers,        // provider ids that produced the current candidate
 *   providerStates       // { providerId: { integration, capacity, billingPath } }
 * }
 */
export function routeCollaborationStep(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw collaborationError("COLLAB_ROUTING_INPUT_INVALID", "Routing input is invalid.")
  }
  const registry = assertTrustedCollaborationRegistry(input.registry)
  const role = input.role
  const providerList = registry.assignments[role]

  if (!providerList) {
    throw collaborationError("COLLAB_ROUTING_ROLE_INVALID", "Routing role is not an assignable role.")
  }

  const implementers = Array.isArray(input.implementers) ? input.implementers : []
  if (implementers.some((providerId) => typeof providerId !== "string" || !registry.providers[providerId])) {
    throw collaborationError("COLLAB_ROUTING_INPUT_INVALID", "Routing implementers must be trusted providers.")
  }

  const mandatoryReview = role === "independent_reviewer"
  const base = {
    routingVersion: SOFTWARE_FACTORY_COLLABORATION_ROUTING_VERSION,
    role,
    mandatory: mandatoryReview,
    // None of the following can be changed by a routing decision.
    grantsAuthority: false,
    permissionsGranted: [],
    paidApiUsage: "not_authorized",
    reviewBypassPermitted: false
  }

  const expectedCapability = capabilityByRole[role]
  if (expectedCapability) {
    // "debugging" (mixed or unresolved) and any other label fail closed to the
    // owner. A frontend step can never be fulfilled for a backend capability.
    if (input.taskCapability === "debugging") {
      return blockedDecision(base, "owner_action_required", "OWNER_RECONCILIATION_REQUIRED", false, [])
    }
    if (input.taskCapability !== expectedCapability) {
      return blockedDecision(base, "owner_action_required", "CAPABILITY_MISMATCH", false, [])
    }
  }

  // A provider that already handled this role may be preferred for continuity.
  // Preference only reorders trusted candidates; it can never add a provider.
  const prefer = typeof input.preferProviderId === "string" && providerList.includes(input.preferProviderId)
    ? input.preferProviderId
    : null
  const ordered = prefer ? [prefer, ...providerList.filter((providerId) => providerId !== prefer)] : providerList
  const considered = []
  let eligible = null

  for (const providerId of ordered) {
    const provider = registry.providers[providerId]
    const state = normalizeProviderState(input.providerStates?.[providerId])
    const entry = { providerId, eligible: false, reasonCode: null, stage: null }
    considered.push(entry)

    if (provider.status === "evaluation" && !provider.trialApprovedRoles.includes(role)) {
      Object.assign(entry, { reasonCode: "PROVIDER_TRIAL_NOT_APPROVED", stage: "policy" })
      continue
    }
    if (mandatoryReview && implementers.includes(providerId)) {
      Object.assign(entry, { reasonCode: "REVIEW_INDEPENDENCE_REQUIRED", stage: "policy" })
      continue
    }
    if (input.providerStates?.[providerId] === undefined || input.providerStates?.[providerId] === null) {
      // Silence is never availability: no observation means unknown, not ready.
      Object.assign(entry, { reasonCode: "WORKER_CAPACITY_UNKNOWN", stage: "external", retryable: false, blocked: "blocked_external" })
      continue
    }
    if (state.billingPath !== "included") {
      // Neither a paid API path nor an unknown billing path is silently used as
      // a fallback. Only the owner can approve new spend.
      Object.assign(entry, { reasonCode: "PAID_FALLBACK_NOT_AUTHORIZED", stage: "policy" })
      continue
    }
    if (state.integration !== "configured") {
      Object.assign(entry, { reasonCode: "PROVIDER_INTEGRATION_UNCONFIGURED", stage: "external", retryable: false, blocked: "blocked_external" })
      continue
    }
    const blocked = capacityOutcome(state.capacity)
    if (blocked) {
      Object.assign(entry, { reasonCode: blocked.reason, stage: "capacity", retryable: blocked.retryable, blocked: blocked.blocked })
      continue
    }

    entry.eligible = true
    entry.reasonCode = state.capacity === "degraded" ? "WORKER_DEGRADED" : "WORKER_READY"
    eligible = eligible ?? { providerId, provider, entry }
    // Keep evaluating nothing further: the first eligible provider in trusted
    // preference order wins, deterministically.
    break
  }

  const publicConsidered = considered.map(({ providerId, eligible: isEligible, reasonCode }) => ({
    providerId,
    eligible: isEligible,
    reasonCode
  }))

  if (eligible) {
    return collaborationDeepFreeze({
      ...base,
      outcome: "ready",
      reasonCode: eligible.entry.reasonCode,
      providerId: eligible.providerId,
      retryable: false,
      consumeAttempt: true,
      checkpointRequired: false,
      usedAlternate: eligible.providerId !== providerList[0],
      evaluationProvider: eligible.provider.status === "evaluation",
      considered: publicConsidered
    })
  }

  const noProviderCode = mandatoryReview ? "NO_ELIGIBLE_REVIEWER" : "NO_ELIGIBLE_PROVIDER"
  const capacityBlocked = considered.find((entry) => entry.blocked === "blocked_capacity")
  const externalBlocked = considered.find((entry) => entry.blocked === "blocked_external")

  if (capacityBlocked) {
    return blockedDecision(base, "blocked_capacity", noProviderCode, true, publicConsidered)
  }
  if (externalBlocked) {
    return blockedDecision(base, "blocked_external", noProviderCode, externalBlocked.retryable === true, publicConsidered)
  }
  return blockedDecision(base, "owner_action_required", noProviderCode, false, publicConsidered)
}
