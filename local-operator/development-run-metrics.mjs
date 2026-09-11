import {
  DEVELOPMENT_RUN_ATTEMPT_KEYS,
  DEVELOPMENT_RUN_EVIDENCE_KINDS,
  MAX_DEVELOPMENT_RUN_STAGE_ATTEMPTS
} from "./development-run-state.mjs"
import { getCustomerZeroProviderContract } from "./customer-zero-provider-contracts.mjs"
import {
  assertDevelopmentRunEvidenceOwnership,
  resolveDevelopmentRunOwnership
} from "./development-run-ownership-context.mjs"

export const CUSTOMER_ZERO_RUN_METRICS_SCHEMA_VERSION = 1
export const MAX_CUSTOMER_ZERO_METRIC_DURATIONS = 16
export const MAX_CUSTOMER_ZERO_METRICS_BYTES = 12 * 1024
const maxDurationMs = 31 * 24 * 60 * 60 * 1000
const safeOutcomePattern = /^[a-z0-9][a-z0-9_-]{0,79}$/u
const allowedProjectionOptions = new Set(["requestedContext"])

export class DevelopmentRunMetricsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "DevelopmentRunMetricsError"
    this.code = code
  }
}

function refuse(code, message) {
  throw new DevelopmentRunMetricsError(code, message)
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

function normalizedAttempts(run) {
  const attempts = {}
  for (const key of DEVELOPMENT_RUN_ATTEMPT_KEYS) {
    const value = run?.attempts?.[key]
    if (!Number.isInteger(value) || value < 0 || value > MAX_DEVELOPMENT_RUN_STAGE_ATTEMPTS) {
      refuse("RUN_METRICS_INVALID", "Development run attempts are invalid.")
    }
    attempts[key] = value
  }
  return attempts
}

function evidenceEntries(run) {
  return DEVELOPMENT_RUN_EVIDENCE_KINDS.flatMap((kind) => (
    (Array.isArray(run.evidence[kind]) ? run.evidence[kind] : []).map((entry) => ({ kind, entry }))
  ))
}

function recordedProvider(entries) {
  const ids = new Set()
  for (const { entry } of entries) {
    const providerId = entry?.metadata?.providerId
    if (providerId !== undefined) {
      if (typeof providerId !== "string" || !getCustomerZeroProviderContract(providerId)) {
        refuse("RUN_METRICS_PROVIDER_INVALID", "Recorded provider identity is invalid.")
      }
      ids.add(providerId)
    }
  }
  if (ids.size > 1) {
    refuse("RUN_METRICS_PROVIDER_CONFLICT", "Development run records conflicting providers.")
  }
  return ids.size === 1 ? [...ids][0] : null
}

function recordedDurations(entries) {
  const durations = []
  for (const { kind, entry } of entries) {
    const durationMs = entry?.metadata?.durationMs
    if (
      Number.isInteger(durationMs) &&
      durationMs >= 0 &&
      durationMs <= maxDurationMs &&
      durations.length < MAX_CUSTOMER_ZERO_METRIC_DURATIONS
    ) {
      durations.push(Object.freeze({
        stage: kind,
        durationMs,
        attempt: Number.isInteger(entry.metadata.attempt) ? entry.metadata.attempt : null
      }))
    }
  }
  return Object.freeze(durations)
}

function recordedOutcomes(run) {
  return Object.freeze(Object.fromEntries(DEVELOPMENT_RUN_EVIDENCE_KINDS.map((kind) => {
    const entries = Array.isArray(run.evidence[kind]) ? run.evidence[kind] : []
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const outcome = entries[index]?.metadata?.outcome
      if (typeof outcome === "string" && safeOutcomePattern.test(outcome)) {
        return [kind, outcome]
      }
    }
    return [kind, null]
  })))
}

function remediationRounds(entries) {
  const rounds = new Set(entries
    .filter(({ entry }) => entry?.metadata?.outcome === "hardening_started")
    .map(({ entry }) => entry.metadata.round)
    .filter((round) => Number.isInteger(round) && round > 0 && round <= 20))
  return rounds.size
}

function ownerInterventions(entries) {
  return entries.filter(({ entry }) => entry?.metadata?.outcome === "owner_action_required").length
}

export function projectDevelopmentRunMetrics(run, options = {}) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowedProjectionOptions.has(key))
  ) {
    refuse("RUN_METRICS_OPTIONS_INVALID", "Development run metrics options are invalid.")
  }
  const ownership = resolveDevelopmentRunOwnership(run, {
    requestedContext: options.requestedContext
  })
  assertDevelopmentRunEvidenceOwnership(run, ownership)
  const entries = evidenceEntries(run)
  const result = {
    schemaVersion: CUSTOMER_ZERO_RUN_METRICS_SCHEMA_VERSION,
    projectId: ownership.context.projectId,
    ownership: {
      ownerId: ownership.context.ownerId,
      workspaceId: ownership.context.workspaceId,
      compatibility: ownership.compatibility
    },
    providerId: recordedProvider(entries),
    attempts: normalizedAttempts(run),
    remediationRounds: remediationRounds(entries),
    outcomes: recordedOutcomes(run),
    stageDurations: recordedDurations(entries),
    ownerInterventions: ownerInterventions(entries),
    limitations: Object.freeze({
      costs: "unknown",
      missingDurations: "unknown",
      source: "recorded-metadata-only"
    })
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_CUSTOMER_ZERO_METRICS_BYTES) {
    refuse("RUN_METRICS_BOUNDS_EXCEEDED", "Development run metrics exceed the output bound.")
  }
  return deepFreeze(result)
}
