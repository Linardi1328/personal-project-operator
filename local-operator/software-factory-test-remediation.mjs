import {
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID,
  classifyAutomatedTestAttemptEvidence,
  resolveAutomatedTestPolicyIdentity
} from "./development-test-runner.mjs"
import {
  recordTrustedAntigravityReadiness
} from "./software-factory-antigravity-readiness.mjs"
import {
  readSoftwareFactoryDispatchCheckpoint
} from "./software-factory-dispatch-checkpoint.mjs"

export const SOFTWARE_FACTORY_TEST_REMEDIATION_ID = "software-factory-v0-7-test-remediation"
export const MAX_REMEDIATION_TEST_IDS = 5

export class SoftwareFactoryTestRemediationError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryTestRemediationError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function remediationError(code, safeMessage) {
  return new SoftwareFactoryTestRemediationError(code, safeMessage)
}

function normalizeExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw remediationError(
      "TEST_REMEDIATION_EXPECTED_VERSION_REQUIRED",
      "Expected development run version is required for test remediation."
    )
  }
  return value
}

async function latestCheckpointVersion(runId, options = {}) {
  try {
    const checkpoint = await (options.readCheckpoint || readSoftwareFactoryDispatchCheckpoint)(runId, options)
    return checkpoint.checkpointVersion
  } catch (error) {
    if (error?.code === "FACTORY_CHECKPOINT_NOT_FOUND") {
      return 0
    }
    throw error
  }
}

function matchingFailureEvidence(run, policyIdentity) {
  if (classifyAutomatedTestAttemptEvidence(run, policyIdentity) !== "definitive_failed") {
    throw remediationError(
      "TEST_REMEDIATION_EVIDENCE_INVALID",
      "Trusted deterministic failed-test evidence is required before automated remediation."
    )
  }

  const entries = Array.isArray(run?.evidence?.test) ? run.evidence.test : []
  const attempt = run.attempts.test
  const headSha = run.headSha
  let aggregate = null
  const failedTestIds = []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const metadata = entry?.metadata || {}

    if (
      entry?.source !== AUTOMATED_TEST_RUNNER_ID ||
      entry?.sha !== headSha ||
      metadata.runner !== AUTOMATED_TEST_RUNNER_ID ||
      metadata.attempt !== attempt ||
      metadata.implSha !== headSha ||
      metadata.policyId !== policyIdentity.policyId ||
      metadata.policyHash !== policyIdentity.policyHash
    ) {
      continue
    }

    if (!aggregate && metadata.outcome === "failed" && metadata.testId === undefined) {
      aggregate = entry
      continue
    }

    if (
      metadata.outcome === "failed" &&
      typeof metadata.testId === "string" &&
      metadata.testId.length > 0 &&
      metadata.testId.length <= 80 &&
      !failedTestIds.includes(metadata.testId) &&
      failedTestIds.length < MAX_REMEDIATION_TEST_IDS
    ) {
      failedTestIds.push(metadata.testId)
    }
  }

  if (
    !aggregate ||
    !Number.isInteger(aggregate.metadata?.failed) ||
    aggregate.metadata.failed <= 0 ||
    !Number.isInteger(aggregate.metadata?.total) ||
    aggregate.metadata.total <= 0
  ) {
    throw remediationError(
      "TEST_REMEDIATION_EVIDENCE_INVALID",
      "Trusted deterministic failed-test evidence is incomplete."
    )
  }

  return Object.freeze({
    attempt,
    headSha,
    policyId: policyIdentity.policyId,
    policyHash: policyIdentity.policyHash,
    failed: aggregate.metadata.failed,
    total: aggregate.metadata.total,
    failedTestIds: Object.freeze(failedTestIds)
  })
}

function remediationEvidence(run, context) {
  return {
    kind: "implementation",
    sha: context.headSha,
    source: SOFTWARE_FACTORY_TEST_REMEDIATION_ID,
    summary: "Software Factory opened a bounded Antigravity debugging remediation for trusted failed tests.",
    metadata: {
      project: run.project.id,
      orchestrator: SOFTWARE_FACTORY_TEST_REMEDIATION_ID,
      outcome: "test_remediation_started",
      capability: "debugging",
      sourceTestAttempt: context.attempt,
      sourceTestSha: context.headSha,
      testPolicyId: context.policyId,
      testPolicyHash: context.policyHash,
      failedTests: context.failed,
      totalTests: context.total,
      failedTestIds: [...context.failedTestIds]
    }
  }
}

export function latestSoftwareFactoryTestRemediation(run) {
  const entries = Array.isArray(run?.evidence?.implementation)
    ? run.evidence.implementation
    : []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      entry?.source === SOFTWARE_FACTORY_TEST_REMEDIATION_ID &&
      entry?.metadata?.orchestrator === SOFTWARE_FACTORY_TEST_REMEDIATION_ID &&
      entry?.metadata?.outcome === "test_remediation_started" &&
      entry?.metadata?.capability === "debugging"
    ) {
      return entry
    }
  }

  return null
}

export function createSoftwareFactoryTestRemediationPreparer(dependencies = {}) {
  const readRun = dependencies.readRun || readDevelopmentRun
  const recordReadiness = dependencies.recordReadiness || recordTrustedAntigravityReadiness
  const transitionRun = dependencies.transitionRun || transitionDevelopmentRun

  return async function prepareSoftwareFactoryTestRemediation(runId, options = {}) {
    const expectedVersion = normalizeExpectedVersion(options.expectedVersion)
    const run = await readRun(runId, options)

    if (run.version !== expectedVersion || run.status !== "tests_failed") {
      throw remediationError(
        "TEST_REMEDIATION_RUN_STALE",
        "Development run changed before test remediation could be prepared."
      )
    }

    const policyIdentity = resolveAutomatedTestPolicyIdentity(run, options)
    const context = matchingFailureEvidence(run, policyIdentity)
    const expectedCheckpointVersion = await latestCheckpointVersion(run.runId, {
      ...options,
      readCheckpoint: dependencies.readCheckpoint
    })
    const checkpoint = await recordReadiness({
      runId: run.runId,
      runVersion: run.version,
      capability: "debugging",
      expectedCheckpointVersion,
      failedAttempts: run.attempts.implementation
    }, options)

    if (checkpoint.dispatch?.outcome !== "ready" || checkpoint.dispatch?.consumeAttempt !== true) {
      return {
        ok: false,
        outcome: checkpoint.dispatch?.outcome || "blocked_external",
        reason: String(checkpoint.dispatch?.reasonCode || "antigravity_not_ready").toLowerCase(),
        run
      }
    }

    const transitioned = await transitionRun(run.runId, {
      expectedVersion: run.version,
      status: "implementation_in_progress",
      headSha: context.headSha,
      ...(run.branch ? { branch: run.branch } : {}),
      actor: SOFTWARE_FACTORY_TEST_REMEDIATION_ID,
      reason: "software-factory-test-remediation-ready",
      evidence: [remediationEvidence(run, context)]
    }, options)

    return {
      ok: true,
      outcome: "test_remediation_ready",
      run: transitioned,
      remediation: {
        capability: "debugging",
        sourceTestAttempt: context.attempt,
        sourceTestSha: context.headSha,
        failedTests: context.failed,
        failedTestIds: [...context.failedTestIds]
      }
    }
  }
}

const defaultPreparer = createSoftwareFactoryTestRemediationPreparer()

export function prepareSoftwareFactoryTestRemediation(runId, options = {}) {
  return defaultPreparer(runId, options)
}

export function formatSoftwareFactoryTestRemediationError(error) {
  if (error instanceof SoftwareFactoryTestRemediationError) {
    return `PPO software factory test-remediation error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory test-remediation error: unexpected local failure."
}
