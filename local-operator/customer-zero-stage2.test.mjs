import assert from "node:assert/strict"
import test from "node:test"
import {
  CUSTOMER_ZERO_CONNECTION_REFERENCES,
  CUSTOMER_ZERO_PROVIDER_CONTRACTS,
  getCustomerZeroProjectProviderPolicy,
  resolveCustomerZeroProvider,
  validateWorkspaceConnectionReference
} from "./customer-zero-provider-contracts.mjs"
import {
  CUSTOMER_ZERO_OWNER_ID,
  CUSTOMER_ZERO_WORKSPACE_ID,
  getCustomerZeroOwnershipContext
} from "./customer-zero-ownership-context.mjs"
import { inspectCustomerZeroStage2Run } from "./customer-zero-stage2.mjs"
import {
  assertDevelopmentRunEvidenceOwnership,
  resolveDevelopmentRunOwnership,
  RUN_UNIT_INTERFACE_CONTRACT
} from "./development-run-ownership-context.mjs"
import { projectDevelopmentRunMetrics } from "./development-run-metrics.mjs"
import { listOrdinaryDevelopmentProjects } from "./github-project-registry.mjs"

const EVIDENCE_KINDS = [
  "planning",
  "implementation",
  "review",
  "test",
  "merge",
  "deploy",
  "verification",
  "rollback"
]

function emptyAttempts() {
  return Object.fromEntries(EVIDENCE_KINDS.map((kind) => [kind, 0]))
}

function emptyEvidence() {
  return Object.fromEntries(EVIDENCE_KINDS.map((kind) => [kind, []]))
}

function runFixture(projectId = "khlim-assist") {
  return {
    runId: "R".repeat(43),
    version: 12,
    status: "review_changes_requested",
    headSha: "a".repeat(40),
    project: { id: projectId },
    attempts: {
      ...emptyAttempts(),
      planning: 1,
      implementation: 3,
      test: 2,
      review: 2
    },
    evidence: {
      ...emptyEvidence(),
      implementation: [{
        kind: "implementation",
        sha: "a".repeat(40),
        summary: "private implementation summary must not be projected",
        metadata: {
          project: projectId,
          providerId: "codex",
          outcome: "hardening_started",
          round: 1,
          durationMs: 1250,
          attempt: 2,
          prompt: "private prompt sentinel"
        }
      }],
      test: [{
        kind: "test",
        sha: "a".repeat(40),
        metadata: {
          project: projectId,
          outcome: "passed",
          durationMs: 2500,
          attempt: 2,
          rawOutput: "raw log sentinel"
        }
      }],
      review: [{
        kind: "review",
        sha: "a".repeat(40),
        metadata: {
          project: projectId,
          outcome: "owner_action_required",
          reason: "private owner task body"
        }
      }]
    }
  }
}

function throwsCode(code) {
  return (error) => error?.code === code
}

test("Stage 2B connection references are workspace-owned identifiers with no credential fields", () => {
  assert.deepEqual(Object.keys(CUSTOMER_ZERO_CONNECTION_REFERENCES).sort(), [
    "customer-zero-antigravity",
    "customer-zero-codex"
  ])
  for (const reference of Object.values(CUSTOMER_ZERO_CONNECTION_REFERENCES)) {
    assert.equal(reference.ownerId, CUSTOMER_ZERO_OWNER_ID)
    assert.equal(reference.workspaceId, CUSTOMER_ZERO_WORKSPACE_ID)
    assert.deepEqual(Object.keys(reference).sort(), ["connectionId", "ownerId", "providerId", "workspaceId"])
    assert.equal(JSON.stringify(reference).match(/credential|secret|token|password/giu), null)
  }

  assert.throws(() => validateWorkspaceConnectionReference({
    ...CUSTOMER_ZERO_CONNECTION_REFERENCES["customer-zero-codex"],
    token: "must-not-be-accepted"
  }), throwsCode("CONNECTION_REFERENCE_INVALID"))
  assert.throws(() => validateWorkspaceConnectionReference({
    ...CUSTOMER_ZERO_CONNECTION_REFERENCES["customer-zero-codex"],
    workspaceId: "different-workspace"
  }), throwsCode("CONNECTION_OWNERSHIP_MISMATCH"))
})

test("Stage 2B provider policy is deterministic, project-bound, and never falls back", () => {
  const projectIds = listOrdinaryDevelopmentProjects().map(({ id }) => id)
  for (const projectId of [...projectIds, "personal-project-operator"]) {
    const context = getCustomerZeroOwnershipContext(projectId)
    const policy = getCustomerZeroProjectProviderPolicy(projectId)
    assert.equal(policy.projectId, projectId)

    const backend = resolveCustomerZeroProvider({ ownershipContext: context, capability: "backend" })
    assert.deepEqual(backend, {
      ok: true,
      outcome: "provider_available",
      projectId,
      capability: "backend",
      providerId: "codex",
      connectionId: "customer-zero-codex",
      adapterId: "phase-6d-codex-execution-adapter",
      fallbackAllowed: false
    })

    const frontend = resolveCustomerZeroProvider({ ownershipContext: context, capability: "frontend" })
    assert.equal(frontend.ok, false)
    assert.equal(frontend.outcome, "provider_unavailable")
    assert.equal(frontend.providerId, "antigravity")
    assert.equal(frontend.connectionId, "customer-zero-antigravity")
    assert.equal(frontend.adapterId, null)
    assert.equal(frontend.fallbackAllowed, false)

    for (const capability of ["optional-frontend", "preview", "deployment"]) {
      const disabled = resolveCustomerZeroProvider({ ownershipContext: context, capability })
      assert.equal(disabled.ok, false)
      assert.equal(disabled.outcome, "provider_disabled")
      assert.equal(disabled.connectionId, null)
      assert.equal(disabled.adapterId, null)
      assert.equal(disabled.fallbackAllowed, false)
    }
  }

  assert.equal(CUSTOMER_ZERO_PROVIDER_CONTRACTS.lovable.state, "disabled")
  assert.equal(CUSTOMER_ZERO_PROVIDER_CONTRACTS.vercel.state, "disabled")
  assert.equal(getCustomerZeroProjectProviderPolicy("unknown-project"), null)
  assert.equal(getCustomerZeroProjectProviderPolicy("toString"), null)
})

test("Stage 2B refuses unknown capabilities, mismatched connections, and extra resolution input", () => {
  const ownershipContext = getCustomerZeroOwnershipContext("khlim-assist")
  assert.throws(() => resolveCustomerZeroProvider({
    ownershipContext,
    capability: "frontend",
    connectionReference: CUSTOMER_ZERO_CONNECTION_REFERENCES["customer-zero-codex"]
  }), throwsCode("CONNECTION_REFERENCE_MISMATCH"))
  assert.throws(() => resolveCustomerZeroProvider({
    ownershipContext,
    capability: "unknown"
  }), throwsCode("PROVIDER_CAPABILITY_UNKNOWN"))
  assert.throws(() => resolveCustomerZeroProvider({
    ownershipContext,
    capability: "backend",
    credential: "not-an-input"
  }), throwsCode("PROVIDER_RESOLUTION_INVALID"))
  assert.throws(() => resolveCustomerZeroProvider({
    ownershipContext,
    capability: "preview",
    connectionReference: CUSTOMER_ZERO_CONNECTION_REFERENCES["customer-zero-codex"]
  }), throwsCode("CONNECTION_REFERENCE_MISMATCH"))
})

test("Stage 2C resolves legacy and explicit run ownership without mutating stored records", () => {
  const legacy = runFixture()
  const before = structuredClone(legacy)
  const legacyResolution = resolveDevelopmentRunOwnership(legacy)
  assert.equal(legacyResolution.compatibility, "legacy-fixed-customer-zero-binding")
  assert.equal(legacyResolution.migrationRequired, false)
  assert.deepEqual(legacyResolution.context, getCustomerZeroOwnershipContext("khlim-assist"))
  assert.deepEqual(legacy, before)

  const explicit = {
    ...runFixture(),
    ownershipContext: getCustomerZeroOwnershipContext("khlim-assist")
  }
  const explicitResolution = resolveDevelopmentRunOwnership(explicit)
  assert.equal(explicitResolution.compatibility, "explicit-context")
  assert.equal(explicitResolution.migrationRequired, false)
  assert.equal(explicit.version, 12)
  assert.equal(explicit.headSha, "a".repeat(40))
  assert.equal(explicit.attempts.implementation, 3)
})

test("Stage 2C ownership cannot cross projects, workspaces, or evidence boundaries", () => {
  const legacy = runFixture()
  assert.throws(() => resolveDevelopmentRunOwnership(legacy, {
    requestedContext: {
      ...getCustomerZeroOwnershipContext("khlim-assist"),
      workspaceId: "different-workspace"
    }
  }), (error) => error?.code === "OWNERSHIP_CROSS_WORKSPACE")

  const wrongProjectContext = {
    ...runFixture(),
    ownershipContext: getCustomerZeroOwnershipContext("portfolio")
  }
  assert.throws(() => resolveDevelopmentRunOwnership(wrongProjectContext), throwsCode("RUN_OWNERSHIP_MISMATCH"))

  const wrongProjectEvidence = runFixture()
  wrongProjectEvidence.evidence.test[0].metadata.project = "portfolio"
  assert.throws(() => assertDevelopmentRunEvidenceOwnership(wrongProjectEvidence), throwsCode("RUN_EVIDENCE_OWNERSHIP_MISMATCH"))

  const incompleteEvidence = runFixture()
  incompleteEvidence.evidence.test[0].metadata.ownerId = CUSTOMER_ZERO_OWNER_ID
  assert.throws(() => assertDevelopmentRunEvidenceOwnership(incompleteEvidence), throwsCode("RUN_EVIDENCE_OWNERSHIP_INVALID"))

  const extraEvidenceKind = runFixture()
  extraEvidenceKind.evidence.shadow = []
  assert.throws(() => assertDevelopmentRunEvidenceOwnership(extraEvidenceKind), throwsCode("RUN_EVIDENCE_OWNERSHIP_INVALID"))
})

test("Stage 2C reserves RunUnit identity without parallelism, states, or authority", () => {
  assert.deepEqual(RUN_UNIT_INTERFACE_CONTRACT.identityFields, ["runId", "ownerId", "workspaceId", "projectId"])
  assert.equal(RUN_UNIT_INTERFACE_CONTRACT.lifecycle, "existing-development-run")
  assert.equal(RUN_UNIT_INTERFACE_CONTRACT.parallelExecution, false)
  assert.equal(RUN_UNIT_INTERFACE_CONTRACT.addsLifecycleStates, false)
  assert.equal(RUN_UNIT_INTERFACE_CONTRACT.grantsExecutionAuthority, false)
})

test("Stage 2D projects only bounded recorded operational metrics", () => {
  const run = runFixture()
  const before = structuredClone(run)
  const metrics = projectDevelopmentRunMetrics(run)

  assert.equal(metrics.projectId, "khlim-assist")
  assert.equal(metrics.providerId, "codex")
  assert.equal(metrics.attempts.implementation, 3)
  assert.equal(metrics.remediationRounds, 1)
  assert.equal(metrics.outcomes.implementation, "hardening_started")
  assert.equal(metrics.outcomes.test, "passed")
  assert.equal(metrics.outcomes.merge, null)
  assert.deepEqual(metrics.stageDurations, [
    { stage: "implementation", durationMs: 1250, attempt: 2 },
    { stage: "test", durationMs: 2500, attempt: 2 }
  ])
  assert.equal(metrics.ownerInterventions, 1)
  assert.deepEqual(metrics.limitations, {
    costs: "unknown",
    missingDurations: "unknown",
    source: "recorded-metadata-only"
  })
  assert.equal(Object.isFrozen(metrics), true)
  assert.equal(Object.isFrozen(metrics.attempts), true)
  assert.deepEqual(run, before)

  const serialized = JSON.stringify(metrics)
  for (const forbidden of [
    "private implementation summary",
    "private prompt sentinel",
    "raw log sentinel",
    "private owner task body"
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "u"))
  }
})

test("Stage 2D keeps absent observations unknown and rejects malformed metrics", () => {
  const empty = runFixture("portfolio")
  empty.evidence = emptyEvidence()
  const metrics = projectDevelopmentRunMetrics(empty)
  assert.equal(metrics.providerId, null)
  assert.deepEqual(metrics.stageDurations, [])
  assert.equal(metrics.remediationRounds, 0)
  assert.equal(metrics.ownerInterventions, 0)
  assert.ok(Object.values(metrics.outcomes).every((outcome) => outcome === null))

  const providerConflict = runFixture()
  providerConflict.evidence.review[0].metadata.providerId = "antigravity"
  assert.throws(() => projectDevelopmentRunMetrics(providerConflict), throwsCode("RUN_METRICS_PROVIDER_CONFLICT"))

  const inheritedProviderName = runFixture()
  inheritedProviderName.evidence.review[0].metadata.providerId = "toString"
  assert.throws(() => projectDevelopmentRunMetrics(inheritedProviderName), throwsCode("RUN_METRICS_PROVIDER_INVALID"))

  const malformedAttempts = runFixture()
  malformedAttempts.attempts.test = -1
  assert.throws(() => projectDevelopmentRunMetrics(malformedAttempts), throwsCode("RUN_METRICS_INVALID"))
  assert.throws(() => projectDevelopmentRunMetrics(runFixture(), { arbitrary: true }), throwsCode("RUN_METRICS_OPTIONS_INVALID"))
})

test("Stage 2E facade integrates ownership, providers, compatibility, and metrics read-only", () => {
  const run = runFixture()
  const before = structuredClone(run)
  const result = inspectCustomerZeroStage2Run(run, {
    requestedContext: getCustomerZeroOwnershipContext("khlim-assist")
  })

  assert.equal(result.ownership.compatibility, "legacy-fixed-customer-zero-binding")
  assert.equal(result.providers.backend.ok, true)
  assert.equal(result.providers.frontend.outcome, "provider_unavailable")
  assert.equal(result.providers["optional-frontend"].outcome, "provider_disabled")
  assert.equal(result.providers.preview.outcome, "provider_disabled")
  assert.equal(result.providers.deployment.outcome, "provider_disabled")
  assert.equal(result.metrics.projectId, "khlim-assist")
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.providers), true)
  assert.deepEqual(run, before)

  assert.throws(() => inspectCustomerZeroStage2Run(run, { providerId: "codex" }), TypeError)
})
