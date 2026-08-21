import { createHash } from "node:crypto"
import {
  DevelopmentRunStateError,
  readDevelopmentRun,
  recordDevelopmentRunProgress,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID,
  PHASE_6F_HARDENING_ORCHESTRATOR_ID,
  executeCodexImplementation
} from "./development-codex-execution-adapter.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  executeAutomatedTests
} from "./development-test-runner.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS,
  REVIEW_FINDINGS_EVIDENCE_OUTCOME,
  executeIndependentReview
} from "./development-review-agent.mjs"

export const HARDENING_ORCHESTRATOR_ID = PHASE_6F_HARDENING_ORCHESTRATOR_ID
export const MAX_HARDENING_ROUNDS = 3

const shaPattern = /^[a-f0-9]{40}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const hardeningReviewSources = new Set([
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID
])

export class DevelopmentHardeningOrchestratorError extends DevelopmentRunStateError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "DevelopmentHardeningOrchestratorError"
  }
}

function hardeningError(code, safeMessage) {
  return new DevelopmentHardeningOrchestratorError(code, safeMessage)
}

function safeHardeningFailure(error) {
  if (error instanceof DevelopmentRunStateError) {
    return error
  }

  return hardeningError(
    "HARDENING_ORCHESTRATOR_UNAVAILABLE",
    "Hardening orchestrator is unavailable; no raw failure was stored."
  )
}

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date()
  }

  return date
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString()
  }

  return date.toISOString()
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw hardeningError(
      "HARDENING_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required."
    )
  }

  return value
}

function normalizeSha(value, fieldName = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw hardeningError(
      "HARDENING_INVALID_SHA",
      `${fieldName} must be a full 40-character Git SHA.`
    )
  }

  return normalized
}

function normalizeFindingText(value) {
  const normalized = String(value ?? "").trim()

  if (!normalized || normalized.length > 160 || unsafeControlPattern.test(normalized) || sensitiveTextPattern.test(normalized)) {
    throw hardeningError(
      "HARDENING_REVIEW_FINDINGS_INVALID",
      "Review findings are missing, malformed, oversized, or unsafe for automated hardening."
    )
  }

  return normalized
}

function normalizeFindingList(value) {
  if (!Array.isArray(value) || value.length > 5) {
    throw hardeningError(
      "HARDENING_REVIEW_FINDINGS_INVALID",
      "Review findings are missing, malformed, oversized, or unsafe for automated hardening."
    )
  }

  return value.map((entry) => normalizeFindingText(entry))
}

function hardeningRemediationHash(context) {
  return sha256Text(stableStringify({
    reviewedSha: context.reviewedSha,
    decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
    blockers: context.blockers,
    securityFindings: context.securityFindings,
    testsRequired: context.testsRequired
  }))
}

function latestIndependentReviewDecisionEvidence(run) {
  const evidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      hardeningReviewSources.has(entry?.source) &&
      hardeningReviewSources.has(entry?.metadata?.reviewer) &&
      ["approved", "changes_requested", "owner_action_required"].includes(entry?.metadata?.outcome)
    ) {
      return entry
    }
  }

  return null
}

function matchingReviewFindingsEvidence(run, decisionEvidence) {
  const evidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []
  const reviewedSha = decisionEvidence?.metadata?.reviewedSha
  const attempt = decisionEvidence?.metadata?.attempt

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      hardeningReviewSources.has(entry?.source) &&
      hardeningReviewSources.has(entry?.metadata?.reviewer) &&
      entry?.metadata?.outcome === REVIEW_FINDINGS_EVIDENCE_OUTCOME &&
      entry?.sha === reviewedSha &&
      entry?.metadata?.reviewedSha === reviewedSha &&
      entry?.metadata?.attempt === attempt
    ) {
      return entry
    }
  }

  return null
}

function latestHardeningEvidence(run, outcome = null) {
  const implementationEvidence = Array.isArray(run?.evidence?.implementation) ? run.evidence.implementation : []
  const reviewEvidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []
  const evidence = [...implementationEvidence, ...reviewEvidence]

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]

    if (
      entry?.source === HARDENING_ORCHESTRATOR_ID &&
      entry?.metadata?.orchestrator === HARDENING_ORCHESTRATOR_ID &&
      (outcome === null || entry?.metadata?.outcome === outcome)
    ) {
      return entry
    }
  }

  return null
}

function hardeningRoundCount(run) {
  const evidence = Array.isArray(run?.evidence?.implementation) ? run.evidence.implementation : []

  return evidence.filter((entry) => (
    entry?.source === HARDENING_ORCHESTRATOR_ID &&
    entry?.metadata?.orchestrator === HARDENING_ORCHESTRATOR_ID &&
    entry?.metadata?.outcome === "hardening_started"
  )).length
}

function validateChangesRequestedReview(run) {
  const reviewedSha = normalizeSha(run.headSha, "Run head SHA")
  const decisionEvidence = latestIndependentReviewDecisionEvidence(run)

  if (
    !decisionEvidence ||
    decisionEvidence.sha !== reviewedSha ||
    decisionEvidence.metadata?.reviewedSha !== reviewedSha
  ) {
    throw hardeningError(
      "HARDENING_REVIEW_EVIDENCE_MISMATCH",
      "Latest independent review evidence does not match the run head SHA."
    )
  }

  if (decisionEvidence.metadata?.decision !== REVIEW_DECISIONS.CHANGES_REQUESTED) {
    throw hardeningError(
      "HARDENING_REVIEW_NOT_REMEDIABLE",
      "Only CHANGES_REQUESTED review decisions may enter automated hardening."
    )
  }

  if (decisionEvidence.metadata?.mergeAllowed !== false) {
    throw hardeningError(
      "HARDENING_REVIEW_NOT_REMEDIABLE",
      "Review evidence is contradictory and cannot enter automated hardening."
    )
  }

  const findingsEvidence = matchingReviewFindingsEvidence(run, decisionEvidence)

  if (!findingsEvidence || findingsEvidence.metadata?.decision !== REVIEW_DECISIONS.CHANGES_REQUESTED || findingsEvidence.metadata?.mergeAllowed !== false) {
    throw hardeningError(
      "HARDENING_REVIEW_FINDINGS_INVALID",
      "Review findings are missing, malformed, oversized, or unsafe for automated hardening."
    )
  }

  const context = {
    reviewedSha,
    reviewer: decisionEvidence.metadata.reviewer,
    reviewAttempt: decisionEvidence.metadata.attempt,
    blockers: normalizeFindingList(findingsEvidence.metadata?.blockerItems),
    securityFindings: normalizeFindingList(findingsEvidence.metadata?.securityItems),
    testsRequired: normalizeFindingList(findingsEvidence.metadata?.testItems)
  }

  if (context.blockers.length + context.securityFindings.length <= 0) {
    throw hardeningError(
      "HARDENING_REVIEW_FINDINGS_INVALID",
      "Review findings are missing, malformed, oversized, or unsafe for automated hardening."
    )
  }

  const hash = hardeningRemediationHash(context)

  if (
    findingsEvidence.metadata?.findingHash !== hash ||
    findingsEvidence.metadata?.blockers !== context.blockers.length ||
    findingsEvidence.metadata?.securityFindings !== context.securityFindings.length ||
    findingsEvidence.metadata?.testsRequired !== context.testsRequired.length ||
    decisionEvidence.metadata?.blockers !== context.blockers.length ||
    decisionEvidence.metadata?.securityFindings !== context.securityFindings.length ||
    decisionEvidence.metadata?.testsRequired !== context.testsRequired.length
  ) {
    throw hardeningError(
      "HARDENING_REVIEW_FINDINGS_INVALID",
      "Review findings are missing, malformed, oversized, or unsafe for automated hardening."
    )
  }

  return {
    ...context,
    remediationHash: hash,
    decisionEvidence,
    findingsEvidence
  }
}

function buildHardeningStartedEvidence(run, context, round, startedAt) {
  return {
    kind: "implementation",
    sha: context.reviewedSha,
    source: HARDENING_ORCHESTRATOR_ID,
    summary: "Phase 6F hardening remediation round started.",
    metadata: {
      project: run.project.id,
      orchestrator: HARDENING_ORCHESTRATOR_ID,
      round,
      sourceReviewSha: context.reviewedSha,
      reviewAttempt: context.reviewAttempt,
      blockerCount: context.blockers.length,
      securityFindingCount: context.securityFindings.length,
      testRequirementCount: context.testsRequired.length,
      remediationHash: context.remediationHash,
      startedAt,
      outcome: "hardening_started",
      codex: CODEX_EXECUTION_ADAPTER_ID,
      tests: AUTOMATED_TEST_RUNNER_ID,
      reviewer: context.reviewer
    }
  }
}

function buildHardeningOwnerActionEvidence(run, context, round, recordedAt) {
  return {
    kind: "review",
    sha: context.reviewedSha,
    source: HARDENING_ORCHESTRATOR_ID,
    summary: "Phase 6F hardening stopped after reaching the automatic round limit.",
    metadata: {
      project: run.project.id,
      orchestrator: HARDENING_ORCHESTRATOR_ID,
      round,
      sourceReviewSha: context.reviewedSha,
      blockerCount: context.blockers.length,
      securityFindingCount: context.securityFindings.length,
      testRequirementCount: context.testsRequired.length,
      remediationHash: context.remediationHash,
      recordedAt,
      outcome: "owner_action_required",
      reason: "max_hardening_rounds_exhausted",
      maxRounds: MAX_HARDENING_ROUNDS,
      codex: CODEX_EXECUTION_ADAPTER_ID,
      tests: AUTOMATED_TEST_RUNNER_ID,
      reviewer: context.reviewer
    }
  }
}

async function transitionToHardeningImplementation(run, context, round, options) {
  const startedAt = timestamp(nowDate(options))

  return await transitionDevelopmentRun(run.runId, {
    expectedVersion: run.version,
    status: "implementation_in_progress",
    ...(run.branch ? { branch: run.branch } : {}),
    headSha: context.reviewedSha,
    actor: HARDENING_ORCHESTRATOR_ID,
    reason: "phase-6f-hardening-remediation-start",
    evidence: [
      buildHardeningStartedEvidence(run, context, round, startedAt)
    ]
  }, options)
}

async function recordHardeningCap(run, context, options) {
  const existing = latestHardeningEvidence(run, "owner_action_required")

  if (existing?.sha === context.reviewedSha && existing?.metadata?.reason === "max_hardening_rounds_exhausted") {
    return run
  }

  return await recordDevelopmentRunProgress(run.runId, {
    expectedVersion: run.version,
    status: "review_changes_requested",
    actor: HARDENING_ORCHESTRATOR_ID,
    reason: "phase-6f-hardening-round-limit",
    evidence: [
      buildHardeningOwnerActionEvidence(run, context, hardeningRoundCount(run), timestamp(nowDate(options)))
    ]
  }, options)
}

async function executeBoundedHardeningInternal(runId, options = {}) {
  let expectedVersion = normalizeExpectedVersion(options.expectedVersion)
  let run = await readDevelopmentRun(runId, options)
  const rounds = []

  if (run.version !== expectedVersion) {
    throw hardeningError(
      "STALE_RUN_VERSION",
      "Development run state changed; reload before retrying."
    )
  }

  while (run.status === "review_changes_requested") {
    const context = validateChangesRequestedReview(run)
    const completedRounds = hardeningRoundCount(run)

    if (completedRounds >= MAX_HARDENING_ROUNDS) {
      const capped = await recordHardeningCap(run, context, options)

      return {
        ok: false,
        outcome: "owner_action_required",
        reason: "max_hardening_rounds_exhausted",
        run: capped,
        hardening: {
          project: run.project.id,
          repo: run.project.fullName,
          currentSha: context.reviewedSha,
          currentRound: completedRounds,
          maxRounds: MAX_HARDENING_ROUNDS,
          rounds
        }
      }
    }

    const round = completedRounds + 1
    const implementationRun = await transitionToHardeningImplementation(run, context, round, options)
    const implementation = await executeCodexImplementation(run.runId, {
      ...options,
      expectedVersion: implementationRun.version
    })
    const testing = await executeAutomatedTests(run.runId, {
      ...options,
      expectedVersion: implementation.run.version
    })
    const review = await executeIndependentReview(run.runId, {
      ...options,
      expectedVersion: testing.run.version
    })

    rounds.push({
      round,
      sourceReviewSha: context.reviewedSha,
      resultingImplementationSha: implementation.run.headSha,
      reviewDecision: review.review.decision,
      outcome: review.outcome
    })

    run = review.run
    expectedVersion = run.version

    if (review.outcome === "approved") {
      return {
        ok: true,
        outcome: "review_passed",
        run,
        hardening: {
          project: run.project.id,
          repo: run.project.fullName,
          currentSha: run.headSha,
          currentRound: hardeningRoundCount(run),
          maxRounds: MAX_HARDENING_ROUNDS,
          rounds
        }
      }
    }

    if (review.outcome === "owner_action_required") {
      return {
        ok: false,
        outcome: "owner_action_required",
        run,
        hardening: {
          project: run.project.id,
          repo: run.project.fullName,
          currentSha: run.headSha,
          currentRound: hardeningRoundCount(run),
          maxRounds: MAX_HARDENING_ROUNDS,
          rounds
        }
      }
    }
  }

  throw hardeningError(
    "HARDENING_RUN_NOT_READY",
    "Development run must be review_changes_requested before automated hardening."
  )
}

async function reconcileBoundedHardeningInternal(runId, options = {}) {
  const run = await readDevelopmentRun(runId, options)
  const currentSha = run.headSha ? normalizeSha(run.headSha, "Run head SHA") : null
  const latestReview = latestIndependentReviewDecisionEvidence(run)
  const latestHardening = latestHardeningEvidence(run)
  const currentRound = hardeningRoundCount(run)
  let reviewEvidenceValid = false
  let remediationEligible = false
  let latestReviewDecision = latestReview?.metadata?.decision || null
  let testEvidenceValid = false

  try {
    if (latestReview && latestReview.sha === currentSha && latestReview.metadata?.reviewedSha === currentSha) {
      reviewEvidenceValid = true
    }

    if (run.status === "review_changes_requested" && latestReviewDecision === REVIEW_DECISIONS.CHANGES_REQUESTED) {
      validateChangesRequestedReview(run)
      remediationEligible = currentRound < MAX_HARDENING_ROUNDS
    }
  } catch {
    remediationEligible = false
  }

  const testEvidence = Array.isArray(run?.evidence?.test) ? run.evidence.test : []
  const latestPass = testEvidence.findLast((entry) => (
    entry?.source === AUTOMATED_TEST_RUNNER_ID &&
    entry?.metadata?.runner === AUTOMATED_TEST_RUNNER_ID &&
    entry?.metadata?.outcome === "passed"
  ))

  testEvidenceValid = Boolean(
    latestPass &&
    latestPass.sha === currentSha &&
    latestPass.metadata?.implSha === currentSha
  )

  const remediationInProgress = Boolean(
    ["hardening_started", "implementation_ready"].includes(latestHardening?.metadata?.outcome) &&
    (latestHardening.sha === currentSha || latestHardening.metadata?.sourceReviewSha === currentSha) &&
    [
      "implementation_in_progress",
      "implementation_ready",
      "tests_in_progress",
      "tests_passed",
      "review_in_progress"
    ].includes(run.status)
  )
  const ownerActionRequired = Boolean(
    latestReviewDecision === REVIEW_DECISIONS.OWNER_ACTION_REQUIRED ||
    latestHardening?.metadata?.outcome === "owner_action_required" ||
    (run.status === "review_changes_requested" && latestReviewDecision === REVIEW_DECISIONS.CHANGES_REQUESTED && currentRound >= MAX_HARDENING_ROUNDS)
  )

  return {
    ok: true,
    outcome: "bounded_hardening_reconciled",
    run: {
      runId: run.runId,
      version: run.version,
      status: run.status,
      project: run.project.id,
      headSha: currentSha
    },
    hardening: {
      currentRound,
      maxRounds: MAX_HARDENING_ROUNDS,
      currentSha,
      latestReviewDecision,
      remediationPending: remediationEligible,
      remediationInProgress,
      testEvidenceValid,
      reviewEvidenceValid,
      ownerActionRequired,
      nonConverged: ownerActionRequired && currentRound >= MAX_HARDENING_ROUNDS
    }
  }
}

export async function executeBoundedHardening(runId, options = {}) {
  try {
    return await executeBoundedHardeningInternal(runId, options)
  } catch (error) {
    throw safeHardeningFailure(error)
  }
}

export async function reconcileBoundedHardening(runId, options = {}) {
  try {
    return await reconcileBoundedHardeningInternal(runId, options)
  } catch (error) {
    throw safeHardeningFailure(error)
  }
}

export function formatDevelopmentHardeningOrchestratorError(error) {
  if (error instanceof DevelopmentRunStateError) {
    return `PPO hardening error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO hardening error: unexpected local failure."
}
