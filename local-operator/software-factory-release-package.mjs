import { createHash } from "node:crypto"
import {
  readDevelopmentRun
} from "./development-run-state.mjs"
import {
  classifyReviewedImplementationEvidence
} from "./software-factory-implementation-evidence.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID
} from "./development-test-runner.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS
} from "./development-review-agent.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD,
  PPO_PR_VALIDATION_WORKFLOW_NAME,
  REQUIRED_PPO_PR_VALIDATION_STEPS
} from "./github-delivery-agent.mjs"
import {
  PHASE_6G_DEFAULT_BASE_BRANCH,
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"

export const SOFTWARE_FACTORY_RELEASE_PACKAGE_SCHEMA_VERSION = 1
export const SOFTWARE_FACTORY_RELEASE_PACKAGE_KIND = "software_factory_release_candidate"

const shaPattern = /^[a-f0-9]{40}$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const repositoryPattern = /^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/u
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u
const safeIdentifierPattern = /^[A-Za-z0-9_.:-]{1,160}$/u
const unsafeControlPattern = /[\u0000-\u001F\u007F-\u009F]/u
const sensitiveTextPattern = /(?:github_pat_|gh[opusr]_|sk-|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:])/iu

export class SoftwareFactoryReleasePackageError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryReleasePackageError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function releaseError(code, safeMessage) {
  return new SoftwareFactoryReleasePackageError(code, safeMessage)
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

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

function normalizeSha(value, label = "SHA") {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!shaPattern.test(normalized)) {
    throw releaseError(
      "FACTORY_RELEASE_SHA_INVALID",
      `${label} is invalid for the release package.`
    )
  }

  return normalized
}

function safeIdentifier(value, label) {
  const normalized = String(value ?? "").trim()

  if (!safeIdentifierPattern.test(normalized) || unsafeControlPattern.test(normalized)) {
    throw releaseError(
      "FACTORY_RELEASE_METADATA_INVALID",
      `${label} is invalid for the release package.`
    )
  }

  return normalized
}

function safeText(value, label, maxChars = 160) {
  const normalized = String(value ?? "").trim()

  if (
    !normalized ||
    normalized.length > maxChars ||
    unsafeControlPattern.test(normalized) ||
    sensitiveTextPattern.test(normalized)
  ) {
    throw releaseError(
      "FACTORY_RELEASE_METADATA_INVALID",
      `${label} is invalid for the release package.`
    )
  }

  return normalized
}

function safeRepository(value) {
  const normalized = String(value ?? "").trim()

  if (!repositoryPattern.test(normalized) || unsafeControlPattern.test(normalized)) {
    throw releaseError(
      "FACTORY_RELEASE_METADATA_INVALID",
      "Repository metadata is invalid for the release package."
    )
  }

  return normalized
}

function normalizeSha256(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase()

  if (!sha256Pattern.test(normalized)) {
    throw releaseError(
      "FACTORY_RELEASE_METADATA_INVALID",
      `${label} is invalid for the release package.`
    )
  }

  return normalized
}

function safeBranch(value) {
  const normalized = String(value ?? "").trim()

  if (
    !branchPattern.test(normalized) ||
    normalized.includes("..") ||
    normalized.includes("//") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".lock")
  ) {
    throw releaseError(
      "FACTORY_RELEASE_METADATA_INVALID",
      "Release branch metadata is invalid."
    )
  }

  return normalized
}

function safeTask(value) {
  const normalized = String(value ?? "").trim()

  if (
    !normalized ||
    normalized.length > 1000 ||
    unsafeControlPattern.test(normalized) ||
    sensitiveTextPattern.test(normalized)
  ) {
    throw releaseError(
      "FACTORY_RELEASE_METADATA_INVALID",
      "Release task metadata is invalid."
    )
  }

  return normalized
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw releaseError(
      "FACTORY_RELEASE_METADATA_INVALID",
      `${label} is invalid for the release package.`
    )
  }

  return value
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw releaseError(
      "FACTORY_RELEASE_METADATA_INVALID",
      `${label} is invalid for the release package.`
    )
  }

  return value
}

function latestEvidence(run, kind, predicate) {
  const entries = Array.isArray(run?.evidence?.[kind]) ? run.evidence[kind] : []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (predicate(entry)) {
      return entry
    }
  }

  return null
}

function currentHead(run) {
  return normalizeSha(run?.headSha, "Run head SHA")
}

function assertMergeReadyRun(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw releaseError(
      "FACTORY_RELEASE_RUN_INVALID",
      "Release package requires a valid development run."
    )
  }

  if (run.status !== "merge_ready") {
    throw releaseError(
      "FACTORY_RELEASE_RUN_NOT_READY",
      "Development run must be merge_ready before a release package can be built."
    )
  }

  if (!Number.isInteger(run.version) || run.version < 1) {
    throw releaseError(
      "FACTORY_RELEASE_RUN_INVALID",
      "Release package requires a current development run version."
    )
  }
}

function implementationFacts(run, headSha) {
  const classified = classifyReviewedImplementationEvidence(run)
  const entry = classified.entry
  const metadata = entry?.metadata || {}

  if (
    classified.classification !== "completed" ||
    !classified.adapterId ||
    !entry ||
    entry.sha !== headSha ||
    metadata.outcome !== "implementation_ready" ||
    metadata.project !== run.project?.id ||
    metadata.attempt !== run.attempts?.implementation
  ) {
    throw releaseError(
      "FACTORY_RELEASE_IMPLEMENTATION_EVIDENCE_INVALID",
      "Reviewed implementation evidence does not prove the current release SHA."
    )
  }

  return {
    adapterId: classified.adapterId,
    attempt: positiveInteger(metadata.attempt, "Implementation attempt"),
    outcome: "implementation_ready",
    changedFiles: Number.isInteger(metadata.changedFiles) && metadata.changedFiles >= 0
      ? metadata.changedFiles
      : null,
    model: typeof (metadata.modelSlug ?? metadata.model) === "string" && String(metadata.modelSlug ?? metadata.model).trim()
      ? safeText(metadata.modelSlug ?? metadata.model, "Implementation model", 160)
      : null
  }
}

function testFacts(run, headSha) {
  const latest = latestEvidence(run, "test", (entry) => (
    entry?.source === AUTOMATED_TEST_RUNNER_ID ||
    entry?.metadata?.runner === AUTOMATED_TEST_RUNNER_ID
  ))
  const metadata = latest?.metadata || {}

  if (
    !latest ||
    latest.sha !== headSha ||
    metadata.runner !== AUTOMATED_TEST_RUNNER_ID ||
    metadata.implSha !== headSha ||
    metadata.outcome !== "passed" ||
    Number(metadata.failed) !== 0 ||
    Number(metadata.ambiguous) !== 0
  ) {
    throw releaseError(
      "FACTORY_RELEASE_TEST_EVIDENCE_INVALID",
      "Deterministic test evidence does not prove the current release SHA."
    )
  }

  const total = nonNegativeInteger(Number(metadata.total), "Test total")
  const passed = nonNegativeInteger(Number(metadata.passed), "Passed test count")

  if (passed !== total) {
    throw releaseError(
      "FACTORY_RELEASE_TEST_EVIDENCE_INVALID",
      "Deterministic test evidence is internally inconsistent."
    )
  }

  return {
    runner: AUTOMATED_TEST_RUNNER_ID,
    attempt: positiveInteger(metadata.attempt, "Test attempt"),
    policyId: safeIdentifier(metadata.policyId, "Test policy id"),
    policyHash: normalizeSha256(metadata.policyHash, "Test policy hash"),
    outcome: "passed",
    total,
    passed,
    failed: 0,
    ambiguous: 0
  }
}

function localReviewFacts(run, headSha) {
  const latest = latestEvidence(run, "review", (entry) => (
    entry?.source === INDEPENDENT_REVIEW_AGENT_ID ||
    entry?.metadata?.reviewer === INDEPENDENT_REVIEW_AGENT_ID
  ))
  const metadata = latest?.metadata || {}

  if (
    !latest ||
    latest.sha !== headSha ||
    metadata.reviewer !== INDEPENDENT_REVIEW_AGENT_ID ||
    metadata.reviewedSha !== headSha ||
    metadata.decision !== REVIEW_DECISIONS.APPROVED ||
    metadata.mergeAllowed !== true ||
    metadata.outcome !== "approved" ||
    Number(metadata.blockers) !== 0 ||
    Number(metadata.securityFindings) !== 0 ||
    Number(metadata.testsRequired) !== 0
  ) {
    throw releaseError(
      "FACTORY_RELEASE_LOCAL_REVIEW_INVALID",
      "Local independent review does not approve the current release SHA."
    )
  }

  return {
    reviewer: INDEPENDENT_REVIEW_AGENT_ID,
    attempt: positiveInteger(metadata.attempt, "Local review attempt"),
    decision: REVIEW_DECISIONS.APPROVED,
    mergeAllowed: true,
    blockers: 0,
    securityFindings: 0,
    testsRequired: 0,
    outcome: "approved"
  }
}

function remoteReviewFacts(run, headSha) {
  const latest = latestEvidence(run, "review", (entry) => (
    entry?.source === REMOTE_PR_REVIEW_AGENT_ID ||
    entry?.metadata?.reviewer === REMOTE_PR_REVIEW_AGENT_ID
  ))
  const metadata = latest?.metadata || {}

  if (
    !latest ||
    latest.sha !== headSha ||
    metadata.reviewer !== REMOTE_PR_REVIEW_AGENT_ID ||
    metadata.project !== run.project?.id ||
    metadata.policyId !== PHASE_6G_DELIVERY_POLICY_ID ||
    metadata.policyHash !== PHASE_6G_DELIVERY_POLICY_HASH ||
    metadata.reviewedSha !== headSha ||
    metadata.decision !== REVIEW_DECISIONS.APPROVED ||
    metadata.mergeAllowed !== true ||
    metadata.outcome !== "approved" ||
    Number(metadata.blockers) !== 0 ||
    Number(metadata.securityFindings) !== 0 ||
    Number(metadata.testsRequired) !== 0
  ) {
    throw releaseError(
      "FACTORY_RELEASE_REMOTE_REVIEW_INVALID",
      "Remote exact-head review does not approve the current release SHA."
    )
  }

  return {
    reviewer: REMOTE_PR_REVIEW_AGENT_ID,
    attempt: positiveInteger(metadata.attempt, "Remote review attempt"),
    prNumber: positiveInteger(metadata.prNumber, "Remote review PR number"),
    decision: REVIEW_DECISIONS.APPROVED,
    mergeAllowed: true,
    blockers: 0,
    securityFindings: 0,
    testsRequired: 0,
    outcome: "approved"
  }
}

function ciFacts(run, headSha) {
  const latest = latestEvidence(run, "merge", (entry) => (
    entry?.source === GITHUB_DELIVERY_AGENT_ID &&
    entry?.metadata?.agent === GITHUB_DELIVERY_AGENT_ID &&
    entry?.metadata?.outcome === "ci_passed"
  ))
  const metadata = latest?.metadata || {}

  if (
    !latest ||
    latest.sha !== headSha ||
    metadata.project !== run.project?.id ||
    metadata.policyId !== PHASE_6G_DELIVERY_POLICY_ID ||
    metadata.policyHash !== PHASE_6G_DELIVERY_POLICY_HASH ||
    metadata.implementationSha !== headSha ||
    metadata.workflowName !== PPO_PR_VALIDATION_WORKFLOW_NAME ||
    metadata.workflowConclusion !== "success" ||
    metadata.requiredSteps !== REQUIRED_PPO_PR_VALIDATION_STEPS.length
  ) {
    throw releaseError(
      "FACTORY_RELEASE_CI_EVIDENCE_INVALID",
      "Exact-head CI evidence does not prove the current release SHA."
    )
  }

  return {
    prNumber: positiveInteger(metadata.prNumber, "CI PR number"),
    workflowName: PPO_PR_VALIDATION_WORKFLOW_NAME,
    workflowRunId: positiveInteger(metadata.workflowRunId, "Workflow run id"),
    conclusion: "success",
    requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length
  }
}

function deliveryFacts(run, headSha, remoteReview, ci) {
  const latest = latestEvidence(run, "merge", (entry) => (
    entry?.source === GITHUB_DELIVERY_AGENT_ID &&
    entry?.metadata?.agent === GITHUB_DELIVERY_AGENT_ID
  ))
  const metadata = latest?.metadata || {}
  const branch = safeBranch(run.branch)

  if (
    !latest ||
    latest.sha !== headSha ||
    metadata.outcome !== "merge_ready" ||
    metadata.policyId !== PHASE_6G_DELIVERY_POLICY_ID ||
    metadata.policyHash !== PHASE_6G_DELIVERY_POLICY_HASH ||
    metadata.implementationSha !== headSha ||
    metadata.prHeadSha !== headSha ||
    metadata.remoteReviewedSha !== headSha ||
    metadata.remoteDecision !== REVIEW_DECISIONS.APPROVED ||
    metadata.prNumber !== remoteReview.prNumber ||
    metadata.prNumber !== ci.prNumber ||
    metadata.workflowRunId !== ci.workflowRunId ||
    metadata.branch !== branch ||
    metadata.base !== PHASE_6G_DEFAULT_BASE_BRANCH
  ) {
    throw releaseError(
      "FACTORY_RELEASE_DELIVERY_EVIDENCE_INVALID",
      "Phase 6G delivery evidence does not prove a current merge-ready release."
    )
  }

  return {
    agent: GITHUB_DELIVERY_AGENT_ID,
    policyId: PHASE_6G_DELIVERY_POLICY_ID,
    policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
    outcome: "merge_ready",
    prNumber: remoteReview.prNumber,
    branch,
    base: PHASE_6G_DEFAULT_BASE_BRANCH,
    workflowRunId: ci.workflowRunId,
    remoteReviewedSha: headSha,
    approvedMergeMethod: PHASE_6G_APPROVED_MERGE_METHOD
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }

  return value
}

export function buildSoftwareFactoryReleasePackageFromRun(run) {
  assertMergeReadyRun(run)

  const headSha = currentHead(run)
  const implementation = implementationFacts(run, headSha)
  const tests = testFacts(run, headSha)
  const localReview = localReviewFacts(run, headSha)
  const remoteReview = remoteReviewFacts(run, headSha)
  const ci = ciFacts(run, headSha)
  const delivery = deliveryFacts(run, headSha, remoteReview, ci)

  const core = {
    schemaVersion: SOFTWARE_FACTORY_RELEASE_PACKAGE_SCHEMA_VERSION,
    kind: SOFTWARE_FACTORY_RELEASE_PACKAGE_KIND,
    run: {
      runId: safeIdentifier(run.runId, "Run id"),
      version: run.version,
      status: "merge_ready",
      projectId: safeIdentifier(run.project?.id, "Project id"),
      repository: safeRepository(run.project?.fullName),
      task: safeTask(run.task),
      branch: delivery.branch,
      headSha
    },
    implementation,
    tests,
    localReview,
    remoteReview,
    ci,
    delivery,
    authority: {
      merge: "owner_approval_required",
      productionDeployment: "not_authorized"
    }
  }

  return deepFreeze({
    ...core,
    packageHash: stableHash(core)
  })
}

export async function buildSoftwareFactoryReleasePackage(runId, options = {}) {
  const readRunImpl = options.readRun || readDevelopmentRun
  const run = await readRunImpl(runId, options)
  return buildSoftwareFactoryReleasePackageFromRun(run)
}

export function formatSoftwareFactoryReleasePackage(packageValue) {
  if (
    !packageValue ||
    packageValue.kind !== SOFTWARE_FACTORY_RELEASE_PACKAGE_KIND ||
    !sha256Pattern.test(String(packageValue.packageHash || ""))
  ) {
    throw releaseError(
      "FACTORY_RELEASE_PACKAGE_INVALID",
      "Software factory release package is invalid."
    )
  }

  return [
    "PPO Release Candidate",
    `Project: ${packageValue.run.projectId}`,
    `Repository: ${packageValue.run.repository}`,
    `Head: ${packageValue.run.headSha}`,
    `Pull request: #${packageValue.delivery.prNumber}`,
    `Implementation: ${packageValue.implementation.adapterId} attempt ${packageValue.implementation.attempt}`,
    `Tests: ${packageValue.tests.passed}/${packageValue.tests.total} passed`,
    `Local review: ${packageValue.localReview.decision}`,
    `Remote review: ${packageValue.remoteReview.decision}`,
    `CI: ${packageValue.ci.conclusion} (run ${packageValue.ci.workflowRunId})`,
    `Package: ${packageValue.packageHash}`,
    "Authority: owner approval required for merge; production deployment not authorized."
  ].join("\n")
}

export function formatSoftwareFactoryReleasePackageError(error) {
  if (error instanceof SoftwareFactoryReleasePackageError) {
    return `PPO software factory release-package error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory release-package error: unexpected local failure."
}
