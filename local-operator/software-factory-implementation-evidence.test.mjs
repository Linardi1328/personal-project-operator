import assert from "node:assert/strict"
import test from "node:test"
import {
  REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID,
  REVIEWED_CODEX_EXECUTION_ADAPTER_ID,
  classifyReviewedImplementationEvidence,
  latestReviewedImplementationEvidence,
  reviewedImplementationAdapter
} from "./software-factory-implementation-evidence.mjs"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

function entry(adapterId, outcome, {
  sha = SHA_A,
  attempt = 1,
  project = "khlim-digital-ecosystem",
  source = adapterId,
  metadataAdapter = adapterId
} = {}) {
  return {
    kind: "implementation",
    sha,
    source,
    metadata: {
      adapter: metadataAdapter,
      project,
      attempt,
      outcome
    }
  }
}

function run(entries, {
  headSha = SHA_A,
  attempt = 1,
  project = "khlim-digital-ecosystem"
} = {}) {
  return {
    headSha,
    project: { id: project },
    attempts: { implementation: attempt },
    evidence: { implementation: entries }
  }
}

test("recognizes only consistent reviewed adapter identities", () => {
  assert.equal(
    reviewedImplementationAdapter(entry(REVIEWED_CODEX_EXECUTION_ADAPTER_ID, "implementation_ready")),
    REVIEWED_CODEX_EXECUTION_ADAPTER_ID
  )
  assert.equal(
    reviewedImplementationAdapter(entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready")),
    REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID
  )
  assert.equal(
    reviewedImplementationAdapter(entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready", {
      metadataAdapter: REVIEWED_CODEX_EXECUTION_ADAPTER_ID
    })),
    null
  )
  assert.equal(
    reviewedImplementationAdapter(entry("unknown-executor", "implementation_ready")),
    null
  )
})

test("classifies current Antigravity implementation_ready evidence as completed", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_started"),
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready")
  ]))

  assert.equal(result.classification, "completed")
  assert.equal(result.adapterId, REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID)
  assert.equal(result.entry.metadata.outcome, "implementation_ready")
})

test("classifies current Codex implementation_ready evidence as completed", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_CODEX_EXECUTION_ADAPTER_ID, "implementation_ready")
  ]))

  assert.equal(result.classification, "completed")
  assert.equal(result.adapterId, REVIEWED_CODEX_EXECUTION_ADAPTER_ID)
})

test("classifies an open reviewed execution attempt as open", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_started")
  ]))

  assert.equal(result.classification, "open")
})

test("classifies a definitive reviewed execution failure as other", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_started"),
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_failed")
  ]))

  assert.equal(result.classification, "other")
})

test("conflicting terminal evidence fails closed", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_started"),
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "execution_failed"),
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready")
  ]))

  assert.equal(result.classification, "invalid")
})

test("mixed reviewed adapters in the same current attempt fail closed", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_CODEX_EXECUTION_ADAPTER_ID, "execution_started"),
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready")
  ]))

  assert.equal(result.classification, "invalid")
})

test("unknown current-attempt execution evidence fails closed", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry("unknown-executor", "implementation_ready")
  ]))

  assert.equal(result.classification, "invalid")
})

test("source and metadata adapter mismatch fails closed", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready", {
      metadataAdapter: REVIEWED_CODEX_EXECUTION_ADAPTER_ID
    })
  ]))

  assert.equal(result.classification, "invalid")
})

test("stale implementation_ready SHA fails closed", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready", { sha: SHA_A })
  ], {
    headSha: SHA_B
  }))

  assert.equal(result.classification, "invalid")
})

test("older-attempt evidence cannot satisfy the current attempt", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready", {
      attempt: 1
    })
  ], {
    attempt: 2
  }))

  assert.equal(result.classification, "none")
  assert.equal(result.entry, null)
})

test("project mismatch fails closed", () => {
  const result = classifyReviewedImplementationEvidence(run([
    entry(REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, "implementation_ready", {
      project: "other-project"
    })
  ]))

  assert.equal(result.classification, "invalid")
})

test("latestReviewedImplementationEvidence delegates to the shared classification", () => {
  const current = entry(REVIEWED_CODEX_EXECUTION_ADAPTER_ID, "implementation_ready")
  const state = run([current])

  assert.equal(latestReviewedImplementationEvidence(state), current)
})
