import { createHash } from "node:crypto"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS,
  REVIEW_FINDINGS_EVIDENCE_OUTCOME
} from "./development-review-agent.mjs"
import {
  MAX_REVIEW_FINDING_CHARS,
  MAX_REVIEW_FINDINGS
} from "./development-review-findings-contract.mjs"

const shaPattern = /^[a-f0-9]{40}$/u
const unsafeControlPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const reviewedSources = new Set([
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID
])

export class SoftwareFactoryReviewRemediationContextError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryReviewRemediationContextError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function contextError(code, safeMessage) {
  return new SoftwareFactoryReviewRemediationContextError(code, safeMessage)
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

function normalizeSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (!shaPattern.test(normalized)) {
    throw contextError(
      "REVIEW_REMEDIATION_CONTEXT_INVALID",
      "Trusted review remediation context is invalid."
    )
  }
  return normalized
}

function normalizeFindingText(value) {
  const normalized = String(value ?? "").trim()

  if (
    !normalized ||
    normalized.length > MAX_REVIEW_FINDING_CHARS ||
    unsafeControlPattern.test(normalized) ||
    sensitiveTextPattern.test(normalized)
  ) {
    throw contextError(
      "REVIEW_REMEDIATION_CONTEXT_INVALID",
      "Trusted review remediation context is invalid."
    )
  }

  return normalized
}

function normalizeFindingList(value) {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_FINDINGS) {
    throw contextError(
      "REVIEW_REMEDIATION_CONTEXT_INVALID",
      "Trusted review remediation context is invalid."
    )
  }

  return value.map((entry) => normalizeFindingText(entry))
}

function latestDecision(run) {
  const evidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]
    if (
      reviewedSources.has(entry?.source) &&
      ["approved", "changes_requested", "owner_action_required"].includes(entry?.metadata?.outcome)
    ) {
      return entry
    }
  }

  return null
}

function matchingFindings(run, decision) {
  const evidence = Array.isArray(run?.evidence?.review) ? run.evidence.review : []
  const reviewedSha = decision?.metadata?.reviewedSha
  const attempt = decision?.metadata?.attempt

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index]
    if (
      reviewedSources.has(entry?.source) &&
      entry?.source === decision?.source &&
      entry?.metadata?.reviewer === decision?.metadata?.reviewer &&
      entry?.metadata?.reviewer === entry?.source &&
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

function remediationHash(context) {
  return sha256Text(stableStringify({
    reviewedSha: context.reviewedSha,
    decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
    blockers: context.blockers,
    securityFindings: context.securityFindings,
    testsRequired: context.testsRequired
  }))
}

export function readTrustedReviewRemediationContext(run) {
  const reviewedSha = normalizeSha(run?.headSha)
  const decision = latestDecision(run)

  if (
    !decision ||
    decision.sha !== reviewedSha ||
    decision.metadata?.reviewedSha !== reviewedSha ||
    decision.metadata?.decision !== REVIEW_DECISIONS.CHANGES_REQUESTED ||
    decision.metadata?.mergeAllowed !== false ||
    !reviewedSources.has(decision.source) ||
    decision.metadata?.reviewer !== decision.source ||
    !Number.isInteger(decision.metadata?.attempt) ||
    decision.metadata.attempt <= 0
  ) {
    throw contextError(
      "REVIEW_REMEDIATION_CONTEXT_INVALID",
      "Trusted review remediation context is invalid."
    )
  }

  const findings = matchingFindings(run, decision)
  if (
    !findings ||
    findings.metadata?.decision !== REVIEW_DECISIONS.CHANGES_REQUESTED ||
    findings.metadata?.mergeAllowed !== false
  ) {
    throw contextError(
      "REVIEW_REMEDIATION_CONTEXT_INVALID",
      "Trusted review remediation context is invalid."
    )
  }

  const context = {
    reviewedSha,
    reviewer: decision.source,
    reviewAttempt: decision.metadata.attempt,
    blockers: normalizeFindingList(findings.metadata?.blockerItems),
    securityFindings: normalizeFindingList(findings.metadata?.securityItems),
    testsRequired: normalizeFindingList(findings.metadata?.testItems)
  }

  if (context.blockers.length + context.securityFindings.length <= 0) {
    throw contextError(
      "REVIEW_REMEDIATION_CONTEXT_INVALID",
      "Trusted review remediation context is invalid."
    )
  }

  const hash = remediationHash(context)
  if (
    findings.metadata?.findingHash !== hash ||
    findings.metadata?.blockers !== context.blockers.length ||
    findings.metadata?.securityFindings !== context.securityFindings.length ||
    findings.metadata?.testsRequired !== context.testsRequired.length ||
    decision.metadata?.blockers !== context.blockers.length ||
    decision.metadata?.securityFindings !== context.securityFindings.length ||
    decision.metadata?.testsRequired !== context.testsRequired.length
  ) {
    throw contextError(
      "REVIEW_REMEDIATION_CONTEXT_INVALID",
      "Trusted review remediation context is invalid."
    )
  }

  return Object.freeze({
    reviewedSha: context.reviewedSha,
    reviewer: context.reviewer,
    reviewAttempt: context.reviewAttempt,
    blockers: Object.freeze([...context.blockers]),
    securityFindings: Object.freeze([...context.securityFindings]),
    testsRequired: Object.freeze([...context.testsRequired]),
    remediationHash: hash
  })
}
