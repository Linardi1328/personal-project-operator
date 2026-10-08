export const REVIEWED_CODEX_EXECUTION_ADAPTER_ID = "phase-6d-codex-execution-adapter"
export const REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID = "software-factory-v0-antigravity-execution"

export const REVIEWED_IMPLEMENTATION_ADAPTER_IDS = Object.freeze([
  REVIEWED_CODEX_EXECUTION_ADAPTER_ID,
  REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID
])

export const REVIEWED_IMPLEMENTATION_EXECUTION_OUTCOMES = Object.freeze([
  "execution_started",
  "execution_failed",
  "implementation_ready"
])

const adapterSet = new Set(REVIEWED_IMPLEMENTATION_ADAPTER_IDS)
const executionOutcomeSet = new Set(REVIEWED_IMPLEMENTATION_EXECUTION_OUTCOMES)
const shaPattern = /^[a-f0-9]{40}$/u

function currentRunSha(run) {
  const value = String(run?.headSha || run?.baseSha || "").trim().toLowerCase()
  return shaPattern.test(value) ? value : null
}

function currentAttempt(run) {
  return Number.isInteger(run?.attempts?.implementation) && run.attempts.implementation > 0
    ? run.attempts.implementation
    : null
}

export function reviewedImplementationAdapter(entry) {
  const source = entry?.source
  const adapter = entry?.metadata?.adapter

  if (
    adapterSet.has(source) &&
    adapter === source
  ) {
    return source
  }

  return null
}

function currentAttemptExecutionEntries(run) {
  const entries = run?.evidence?.implementation

  if (!Array.isArray(entries)) {
    return {
      malformed: true,
      entries: [],
      hasUnreviewedCurrentAttemptEvidence: false
    }
  }

  const attempt = currentAttempt(run)

  if (!attempt) {
    return {
      malformed: false,
      entries: [],
      hasUnreviewedCurrentAttemptEvidence: false
    }
  }

  const selected = []
  let hasUnreviewedCurrentAttemptEvidence = false

  for (const entry of entries) {
    const metadata = entry?.metadata || {}
    const outcome = metadata.outcome

    if (metadata.attempt !== attempt || !executionOutcomeSet.has(outcome)) {
      continue
    }

    const adapterId = reviewedImplementationAdapter(entry)

    if (!adapterId) {
      hasUnreviewedCurrentAttemptEvidence = true
      continue
    }

    selected.push({ entry, adapterId })
  }

  return {
    malformed: false,
    entries: selected,
    hasUnreviewedCurrentAttemptEvidence
  }
}

function latestSelectedEntry(selected) {
  return selected.length > 0 ? selected.at(-1).entry : null
}

function invalidResult(entry = null, adapterId = null) {
  return Object.freeze({
    classification: "invalid",
    adapterId,
    entry
  })
}

export function classifyReviewedImplementationEvidence(run) {
  const expectedSha = currentRunSha(run)
  const attempt = currentAttempt(run)
  const selected = currentAttemptExecutionEntries(run)

  if (
    selected.malformed ||
    !expectedSha ||
    !attempt ||
    selected.hasUnreviewedCurrentAttemptEvidence
  ) {
    return invalidResult(latestSelectedEntry(selected.entries))
  }

  if (selected.entries.length === 0) {
    return Object.freeze({
      classification: "none",
      adapterId: null,
      entry: null
    })
  }

  const adapterIds = new Set(selected.entries.map((item) => item.adapterId))
  const latest = selected.entries.at(-1)
  const latestEntry = latest.entry

  if (adapterIds.size !== 1) {
    return invalidResult(latestEntry, latest.adapterId)
  }

  const adapterId = latest.adapterId
  let started = 0
  let failed = 0
  let ready = 0

  for (const { entry, adapterId: entryAdapterId } of selected.entries) {
    const metadata = entry?.metadata || {}

    if (
      entry?.kind !== "implementation" ||
      entryAdapterId !== adapterId ||
      metadata.project !== run?.project?.id ||
      metadata.attempt !== attempt ||
      !shaPattern.test(String(entry?.sha || "").toLowerCase())
    ) {
      return invalidResult(latestEntry, adapterId)
    }

    if (metadata.outcome === "execution_started") started += 1
    if (metadata.outcome === "execution_failed") failed += 1
    if (metadata.outcome === "implementation_ready") ready += 1
  }

  if (
    failed > 1 ||
    ready > 1 ||
    (failed > 0 && ready > 0)
  ) {
    return invalidResult(latestEntry, adapterId)
  }

  const latestOutcome = latestEntry?.metadata?.outcome

  if (latestOutcome === "implementation_ready") {
    if (
      ready !== 1 ||
      latestEntry.sha !== expectedSha
    ) {
      return invalidResult(latestEntry, adapterId)
    }

    return Object.freeze({
      classification: "completed",
      adapterId,
      entry: latestEntry
    })
  }

  if (latestOutcome === "execution_started") {
    if (
      failed !== 0 ||
      ready !== 0 ||
      latestEntry.sha !== expectedSha
    ) {
      return invalidResult(latestEntry, adapterId)
    }

    return Object.freeze({
      classification: "open",
      adapterId,
      entry: latestEntry
    })
  }

  if (latestOutcome === "execution_failed") {
    if (
      failed !== 1 ||
      ready !== 0
    ) {
      return invalidResult(latestEntry, adapterId)
    }

    return Object.freeze({
      classification: "other",
      adapterId,
      entry: latestEntry
    })
  }

  return invalidResult(latestEntry, adapterId)
}

export function latestReviewedImplementationEvidence(run) {
  return classifyReviewedImplementationEvidence(run).entry
}
