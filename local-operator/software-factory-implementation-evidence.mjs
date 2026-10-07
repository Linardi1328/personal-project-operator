import {
  CODEX_EXECUTION_ADAPTER_ID,
  classifyCodexExecutionAttemptEvidence
} from "./development-codex-execution-adapter.mjs"
import {
  ANTIGRAVITY_EXECUTION_ADAPTER_ID,
  classifyAntigravityExecutionAttemptEvidence
} from "./software-factory-antigravity-execution.mjs"

export const REVIEWED_IMPLEMENTATION_ADAPTER_IDS = Object.freeze([
  CODEX_EXECUTION_ADAPTER_ID,
  ANTIGRAVITY_EXECUTION_ADAPTER_ID
])

const reviewedAdapterSet = new Set(REVIEWED_IMPLEMENTATION_ADAPTER_IDS)
const shaPattern = /^[a-f0-9]{40}$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const unsafeTextPattern = /[\u0000-\u001F\u007F-\u009F\p{Zl}\p{Zp}]/u

function safeSha(value) {
  const normalized = typeof value === "string" ? value.toLowerCase() : ""
  return shaPattern.test(normalized) ? normalized : null
}

function safeBoundedText(value, maxChars = 200) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !unsafeTextPattern.test(value)
  )
}

export function reviewedImplementationAdapter(entry) {
  const source = entry?.source
  const adapter = entry?.metadata?.adapter

  return (
    reviewedAdapterSet.has(source) &&
    adapter === source
  ) ? source : null
}

export function latestReviewedImplementationEvidence(run) {
  const entries = Array.isArray(run?.evidence?.implementation)
    ? run.evidence.implementation
    : []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (reviewedImplementationAdapter(entries[index])) {
      return entries[index]
    }
  }

  return null
}

function completedEvidenceValid(run, entry, adapterId) {
  const metadata = entry?.metadata || {}
  const expectedSha = safeSha(run?.headSha)

  return (
    Boolean(expectedSha) &&
    Number.isInteger(run?.attempts?.implementation) &&
    run.attempts.implementation > 0 &&
    entry?.kind === "implementation" &&
    entry?.source === adapterId &&
    safeSha(entry?.sha) === expectedSha &&
    metadata.adapter === adapterId &&
    metadata.project === run?.project?.id &&
    metadata.attempt === run.attempts.implementation &&
    metadata.outcome === "implementation_ready" &&
    sha256Pattern.test(String(metadata.promptHash || "")) &&
    safeBoundedText(metadata.startedAt, 80) &&
    safeBoundedText(metadata.endedAt, 80) &&
    metadata.remotePolicy === "deny" &&
    (run.branch === null || run.branch === undefined || metadata.branch === run.branch) &&
    (
      adapterId !== CODEX_EXECUTION_ADAPTER_ID ||
      metadata.network === "none"
    ) &&
    (
      adapterId !== ANTIGRAVITY_EXECUTION_ADAPTER_ID ||
      metadata.networkPolicy === "antigravity-sandbox"
    )
  )
}

export function classifyReviewedImplementationEvidence(run) {
  const entry = latestReviewedImplementationEvidence(run)

  if (!entry) {
    return Object.freeze({
      classification: "none",
      adapterId: null,
      entry: null
    })
  }

  const adapterId = reviewedImplementationAdapter(entry)

  if (
    entry?.metadata?.outcome === "implementation_ready" &&
    completedEvidenceValid(run, entry, adapterId)
  ) {
    return Object.freeze({
      classification: "completed",
      adapterId,
      entry
    })
  }

  const adapterClassification = adapterId === ANTIGRAVITY_EXECUTION_ADAPTER_ID
    ? classifyAntigravityExecutionAttemptEvidence(run)
    : classifyCodexExecutionAttemptEvidence(run)

  return Object.freeze({
    classification: adapterClassification === "none" ? "invalid" : adapterClassification,
    adapterId,
    entry
  })
}

export function hasUnreviewedCurrentImplementationEvidence(run, approvedSha = run?.headSha) {
  const targetSha = safeSha(approvedSha)
  const entries = Array.isArray(run?.evidence?.implementation)
    ? run.evidence.implementation
    : []
  const executionOutcomes = new Set([
    "execution_started",
    "execution_failed",
    "implementation_ready"
  ])

  if (!targetSha) {
    return true
  }

  return entries.some((entry) => (
    safeSha(entry?.sha) === targetSha &&
    executionOutcomes.has(entry?.metadata?.outcome) &&
    reviewedImplementationAdapter(entry) === null
  ))
}
