import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyPhase6DImplementationEvidenceForAcceptance,
  latestPhase6DImplementationEvidence
} from "./development-acceptance-gate.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID
} from "./development-codex-execution-adapter.mjs"
import {
  ANTIGRAVITY_EXECUTION_ADAPTER_ID
} from "./software-factory-antigravity-execution.mjs"

const SHA = "a".repeat(40)

function runWith(entries, attempt = 1) {
  return {
    headSha: SHA,
    attempts: { implementation: attempt },
    evidence: { implementation: entries }
  }
}

function entry(source, outcome, attempt = 1, overrides = {}) {
  return {
    kind: "implementation",
    sha: SHA,
    source,
    metadata: {
      adapter: source,
      attempt,
      outcome,
      ...overrides
    }
  }
}

test("reviewed Antigravity implementation_ready evidence is accepted as completed Phase 6D evidence", () => {
  const run = runWith([
    entry(ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_started"),
    entry(ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready")
  ])

  const latest = latestPhase6DImplementationEvidence(run)
  const classified = classifyPhase6DImplementationEvidenceForAcceptance(run)

  assert.equal(latest.source, ANTIGRAVITY_EXECUTION_ADAPTER_ID)
  assert.equal(latest.metadata.outcome, "implementation_ready")
  assert.equal(classified.adapterId, ANTIGRAVITY_EXECUTION_ADAPTER_ID)
  assert.equal(classified.classification, "completed")
})

test("open Antigravity implementation attempt remains open for reconciliation", () => {
  const run = runWith([
    entry(ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_started")
  ])

  const classified = classifyPhase6DImplementationEvidenceForAcceptance(run)

  assert.equal(classified.adapterId, ANTIGRAVITY_EXECUTION_ADAPTER_ID)
  assert.equal(classified.classification, "open")
})

test("conflicting Antigravity terminal evidence is invalid and cannot satisfy acceptance", () => {
  const run = runWith([
    entry(ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_started"),
    entry(ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_failed"),
    entry(ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready")
  ])

  const classified = classifyPhase6DImplementationEvidenceForAcceptance(run)

  assert.equal(classified.adapterId, ANTIGRAVITY_EXECUTION_ADAPTER_ID)
  assert.equal(classified.classification, "invalid")
})

test("unknown executor evidence is not recognized as Phase 6D implementation evidence", () => {
  const run = runWith([
    entry("unreviewed-executor", "implementation_ready")
  ])

  assert.equal(latestPhase6DImplementationEvidence(run), null)
  assert.deepEqual(classifyPhase6DImplementationEvidenceForAcceptance(run), {
    classification: "none",
    adapterId: null,
    entry: null
  })
})

test("contradictory source and adapter identity is not recognized", () => {
  const run = runWith([{
    kind: "implementation",
    sha: SHA,
    source: ANTIGRAVITY_EXECUTION_ADAPTER_ID,
    metadata: {
      adapter: CODEX_EXECUTION_ADAPTER_ID,
      attempt: 1,
      outcome: "implementation_ready"
    }
  }])

  assert.equal(latestPhase6DImplementationEvidence(run), null)
})

test("legacy Codex implementation_ready evidence remains compatible", () => {
  const codex = entry(CODEX_EXECUTION_ADAPTER_ID, "implementation_ready")
  const run = runWith([codex])

  const latest = latestPhase6DImplementationEvidence(run)
  const classified = classifyPhase6DImplementationEvidenceForAcceptance(run)

  assert.equal(latest, codex)
  assert.equal(classified.adapterId, CODEX_EXECUTION_ADAPTER_ID)
  assert.equal(classified.classification, "completed")
})
