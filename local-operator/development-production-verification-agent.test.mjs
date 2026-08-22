import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  DEVELOPMENT_DEPLOYMENT_AGENT_ID,
  PHASE_6H_DEPLOYMENT_POLICY_HASH,
  PHASE_6H_DEPLOYMENT_POLICY_ID,
  PHASE_6H_PPO_DEPLOYMENT_PROFILE
} from "./development-deployment-agent.mjs"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
  PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
  PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
  executeDevelopmentProductionVerification,
  phase6IProductionVerificationSecurityBoundary,
  reconcileDevelopmentProductionVerification
} from "./development-production-verification-agent.mjs"
import {
  DEVELOPMENT_RUN_EVIDENCE_KINDS,
  DevelopmentRunStateError,
  normalizeDevelopmentRunEvidenceRecord
} from "./development-run-state.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD
} from "./github-delivery-agent.mjs"

const RUN_ID = "V".repeat(43)
const IMPLEMENTATION_SHA = "a".repeat(40)
const MERGE_SHA = "b".repeat(40)
const OLD_SHA = "c".repeat(40)
const WRONG_SHA = "d".repeat(40)
const VERIFY_PRODUCTION_READONLY_SCRIPT_PATH = fileURLToPath(new URL("../deployment/scripts/verify-production-readonly.sh", import.meta.url))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function emptyEvidence() {
  return Object.fromEntries(DEVELOPMENT_RUN_EVIDENCE_KINDS.map((kind) => [kind, []]))
}

function implementationEvidence(sha = IMPLEMENTATION_SHA) {
  return {
    kind: "implementation",
    sha,
    source: "phase-6d-codex-execution-adapter",
    summary: "Implementation evidence.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      adapter: "phase-6d-codex-execution-adapter",
      attempt: 1,
      outcome: "implementation_ready"
    }
  }
}

function testEvidence(sha = IMPLEMENTATION_SHA) {
  return {
    kind: "test",
    sha,
    source: "phase-6e-automated-test-runner",
    summary: "Automated tests passed.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      runner: "phase-6e-automated-test-runner",
      attempt: 1,
      implSha: sha,
      outcome: "passed",
      failed: 0,
      ambiguous: 0
    }
  }
}

function reviewEvidence(reviewer, sha = IMPLEMENTATION_SHA) {
  return {
    kind: "review",
    sha,
    source: reviewer,
    summary: "Review approved.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      reviewer,
      attempt: 1,
      reviewedSha: sha,
      decision: "APPROVED",
      mergeAllowed: true,
      blockers: 0,
      securityFindings: 0,
      testsRequired: 0,
      outcome: "approved"
    }
  }
}

function mergedEvidence({
  implementationSha = IMPLEMENTATION_SHA,
  mergeCommitSha = MERGE_SHA,
  mainSha = MERGE_SHA
} = {}) {
  return {
    kind: "merge",
    sha: implementationSha,
    source: GITHUB_DELIVERY_AGENT_ID,
    summary: "Exact-head merge verified.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: GITHUB_DELIVERY_AGENT_ID,
      policyId: PHASE_6G_DELIVERY_POLICY_ID,
      policyHash: PHASE_6G_DELIVERY_POLICY_HASH,
      implementationSha,
      outcome: "merged",
      prNumber: 42,
      expectedHeadSha: implementationSha,
      mergeMethod: PHASE_6G_APPROVED_MERGE_METHOD,
      mergeCommitSha,
      mainSha
    }
  }
}

function deployedEvidence({
  deploymentSha = MERGE_SHA,
  checkoutSha = MERGE_SHA,
  previousInstalledSha = OLD_SHA,
  service = PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
  preflight = "passed",
  restart = "completed",
  outcome = "deployed",
  policyId = PHASE_6H_DEPLOYMENT_POLICY_ID,
  policyHash = PHASE_6H_DEPLOYMENT_POLICY_HASH,
  source = DEVELOPMENT_DEPLOYMENT_AGENT_ID,
  agent = DEVELOPMENT_DEPLOYMENT_AGENT_ID
} = {}) {
  return {
    kind: "deploy",
    sha: deploymentSha,
    source,
    summary: "Phase 6H exact-SHA deployment completed.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent,
      policyId,
      policyHash,
      deploymentSha,
      outcome,
      attempt: 1,
      previousInstalledSha,
      checkoutSha,
      service,
      preflight,
      restart
    }
  }
}

function makeDeployedRun(overrides = {}) {
  const evidence = emptyEvidence()

  evidence.implementation.push(implementationEvidence())
  evidence.test.push(testEvidence())
  evidence.review.push(reviewEvidence("phase-6f-independent-review-agent"))
  evidence.review.push(reviewEvidence("phase-6g-remote-pr-review-agent"))
  evidence.merge.push(mergedEvidence(overrides.merge || {}))
  evidence.deploy.push(deployedEvidence(overrides.deploy || {}))

  for (const [kind, entries] of Object.entries(overrides.evidence || {})) {
    evidence[kind] = entries
  }

  return {
    schemaVersion: 1,
    runId: RUN_ID,
    version: overrides.version ?? 12,
    stage: overrides.stage || "deploy",
    status: overrides.status || "deployed",
    project: overrides.project || {
      id: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      owner: "Linardi1328",
      repo: "personal-project-operator",
      fullName: PHASE_6H_PPO_DEPLOYMENT_PROFILE.repositoryFullName
    },
    task: "Verify the deployed PPO service.",
    baseSha: "0".repeat(40),
    branch: "phase/6i-production-verification",
    headSha: IMPLEMENTATION_SHA,
    attempts: {
      planning: 1,
      implementation: 1,
      test: 1,
      review: 1,
      merge: 1,
      deploy: 1,
      verification: overrides.verificationAttempts ?? 0
    },
    timestamps: {
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      statusChangedAt: "2026-08-22T00:00:00.000Z",
      terminalAt: null
    },
    evidence,
    historyHash: "h".repeat(64),
    history: []
  }
}

function staleRunStateError() {
  return new DevelopmentRunStateError(
    "STALE_RUN_VERSION",
    "Development run state changed; reload before retrying."
  )
}

function makeStateAdapter(initialRun) {
  const state = {
    run: clone(initialRun),
    transitions: []
  }

  const api = {
    async readDevelopmentRun(runId) {
      assert.equal(runId, state.run.runId)
      return clone(state.run)
    },
    async transitionDevelopmentRun(runId, transition, options = {}) {
      assert.equal(runId, state.run.runId)

      if (transition.expectedVersion !== state.run.version) {
        throw staleRunStateError()
      }

      const evidence = (transition.evidence || []).map((entry) => normalizeDevelopmentRunEvidenceRecord(entry, options))
      const nextAttempts = { ...state.run.attempts }

      if (transition.status === "verification_in_progress") {
        nextAttempts.verification += 1
      }

      state.transitions.push(clone(transition))
      state.run = {
        ...state.run,
        version: state.run.version + 1,
        status: transition.status,
        stage: transition.status === "verified" ? "closed" : "verification",
        attempts: nextAttempts,
        evidence: {
          ...state.run.evidence,
          verification: [...state.run.evidence.verification, ...evidence]
        },
        timestamps: {
          ...state.run.timestamps,
          updatedAt: "2026-08-22T00:00:01.000Z",
          statusChangedAt: "2026-08-22T00:00:01.000Z",
          terminalAt: transition.status === "verified" ? "2026-08-22T00:00:01.000Z" : null
        }
      }

      return clone(state.run)
    }
  }

  return {
    state,
    api
  }
}

function verificationResult(overrides = {}) {
  return {
    schemaVersion: 1,
    ok: true,
    failureClass: "none",
    observedCheckoutSha: MERGE_SHA,
    serviceName: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
    serviceEnabled: true,
    serviceActive: true,
    serviceRunning: true,
    serviceMainPidNonZero: true,
    repository: "passed",
    checkout: "passed",
    clean: "passed",
    previousRevision: "passed",
    runtimePreflight: "passed",
    openclawVersion: "passed",
    serviceIdentity: "passed",
    unitContract: "passed",
    permissionContract: "passed",
    bridge: "passed",
    rollbackInvoked: false,
    deploymentInvoked: false,
    restartInvoked: false,
    githubWriteInvoked: false,
    modelInvoked: false,
    routeInvoked: false,
    ...overrides
  }
}

function verificationContract(overrides = {}) {
  const result = verificationResult(overrides)

  return [
    `repository:${result.repository}`,
    `checkout:${result.checkout}`,
    `clean:${result.clean}`,
    `previousRevision:${result.previousRevision}`,
    `runtimePreflight:${result.runtimePreflight}`,
    `openclawVersion:${result.openclawVersion}`,
    `serviceEnabled:${result.serviceEnabled === true ? "true" : "false"}`,
    `serviceActive:${result.serviceActive === true ? "true" : "false"}`,
    `serviceRunning:${result.serviceRunning === true && result.serviceMainPidNonZero === true ? "true" : "false"}`,
    `serviceIdentity:${result.serviceIdentity}`,
    `unitContract:${result.unitContract}`,
    `permissionContract:${result.permissionContract}`,
    `bridge:${result.bridge}`
  ]
}

function verificationStartedEvidence({ attempt = 1 } = {}) {
  return {
    kind: "verification",
    sha: MERGE_SHA,
    source: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
    summary: "Verification started.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
      policyId: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
      policyHash: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
      deploymentSha: MERGE_SHA,
      outcome: "verification_started",
      attempt,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName
    }
  }
}

function verifiedEvidence({
  attempt = 1,
  deploymentSha = MERGE_SHA,
  checkoutSha = MERGE_SHA,
  policyId = PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
  policyHash = PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
  contract = verificationContract()
} = {}) {
  return {
    kind: "verification",
    sha: deploymentSha,
    source: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
    summary: "Phase 6I production verification completed.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
      policyId,
      policyHash,
      deploymentSha,
      outcome: "verified",
      attempt,
      checkoutSha,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
      contract
    }
  }
}

function makeVerifiedRun(verificationOverrides = {}) {
  const run = makeDeployedRun({
    status: "verified",
    stage: "closed",
    verificationAttempts: 1
  })

  run.timestamps.terminalAt = "2026-08-22T00:00:01.000Z"
  run.evidence.verification.push(verificationStartedEvidence({ attempt: verificationOverrides.startedAttempt || 1 }))
  run.evidence.verification.push(verifiedEvidence(verificationOverrides))
  return run
}

function makeVerificationRunner(options = {}) {
  const state = {
    verifyCalls: [],
    inspectCalls: []
  }

  const runner = async (invocation) => {
    assert.equal(invocation.shell, false)
    assert.equal(invocation.profile.profileId, PHASE_6H_PPO_DEPLOYMENT_PROFILE.profileId)
    assert.equal(invocation.deploymentSha, options.expectedSha || MERGE_SHA)
    assert.equal(invocation.serviceName, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)

    if (invocation.kind === "inspect-production") {
      state.inspectCalls.push(clone(invocation))
      return verificationResult(options.inspectResult || options.result || {})
    }

    if (invocation.kind === "verify-production") {
      state.verifyCalls.push(clone(invocation))

      if (options.ambiguousMode) {
        const error = new Error("ambiguous production verification")

        if (options.ambiguousMode === "timeout") {
          error.timedOut = true
        } else if (options.ambiguousMode === "signal") {
          error.signal = "SIGTERM"
        } else if (options.ambiguousMode === "overflow") {
          error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        } else {
          error.ambiguous = true
        }

        throw error
      }

      if (Object.hasOwn(options, "rawResult")) {
        return options.rawResult
      }

      return verificationResult(options.result || {})
    }

    throw new Error(`unexpected verification operation: ${invocation.kind}`)
  }

  runner.state = state
  return runner
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code)
    return true
  })
}

async function executeWithFixture(fixture, runner, options = {}) {
  return await executeDevelopmentProductionVerification(RUN_ID, {
    ...fixture.api,
    verificationRunner: runner,
    expectedVersion: fixture.state.run.version,
    now: () => new Date("2026-08-22T00:00:01.000Z"),
    ...options
  })
}

test("deployed run with valid exact Phase 6H evidence reserves production verification before ambiguity", async () => {
  const fixture = makeStateAdapter(makeDeployedRun())
  const runner = makeVerificationRunner({ ambiguousMode: "timeout" })

  await assertRejectsCode(executeWithFixture(fixture, runner), "PRODUCTION_VERIFICATION_AMBIGUOUS")

  assert.equal(fixture.state.run.status, "verification_in_progress")
  assert.equal(fixture.state.run.attempts.verification, 1)
  assert.equal(fixture.state.transitions.at(0).status, "verification_in_progress")
  assert.equal(fixture.state.run.evidence.verification.at(-1).metadata.outcome, "verification_started")
  assert.equal(fixture.state.run.evidence.verification.at(-1).metadata.deploymentSha, MERGE_SHA)
  assert.equal(runner.state.verifyCalls.length, 1)
})

test("stale expectedVersion is rejected before production verification", async () => {
  const fixture = makeStateAdapter(makeDeployedRun({ version: 12 }))
  const runner = makeVerificationRunner()

  await assertRejectsCode(executeDevelopmentProductionVerification(RUN_ID, {
    ...fixture.api,
    verificationRunner: runner,
    expectedVersion: 11
  }), "STALE_RUN_VERSION")

  assert.equal(fixture.state.run.status, "deployed")
  assert.equal(runner.state.verifyCalls.length, 0)
})

test("non-deployed runs are rejected without production verification", async () => {
  for (const status of ["merged", "deploy_in_progress", "deploy_failed", "verification_in_progress", "verified"]) {
    const fixture = makeStateAdapter(makeDeployedRun({
      status,
      stage: status === "verified" ? "closed" : "deploy"
    }))
    const runner = makeVerificationRunner()

    await assertRejectsCode(executeDevelopmentProductionVerification(RUN_ID, {
      ...fixture.api,
      verificationRunner: runner,
      expectedVersion: fixture.state.run.version
    }), "PRODUCTION_VERIFICATION_RUN_NOT_DEPLOYED")

    assert.equal(runner.state.verifyCalls.length, 0)
  }
})

test("caller-supplied verification or deployment targets are rejected", async () => {
  for (const key of [
    "deploymentSha",
    "checkoutSha",
    "verificationTarget",
    "repositoryFullName",
    "serviceName",
    "installDir",
    "deploymentProfile",
    "verificationPolicy",
    "command",
    "executablePath",
    "scriptPath"
  ]) {
    const fixture = makeStateAdapter(makeDeployedRun())
    const runner = makeVerificationRunner()

    await assertRejectsCode(executeDevelopmentProductionVerification(RUN_ID, {
      ...fixture.api,
      verificationRunner: runner,
      expectedVersion: fixture.state.run.version,
      [key]: key === "deploymentProfile" ? PHASE_6H_PPO_DEPLOYMENT_PROFILE : "caller-value"
    }), "PRODUCTION_VERIFICATION_TARGET_FROM_CALLER_REFUSED")

    assert.equal(runner.state.verifyCalls.length, 0)
  }
})

test("wrong project and caller profile are rejected", async () => {
  {
    const fixture = makeStateAdapter(makeDeployedRun({
      project: {
        id: "khlim-assist",
        owner: "Linardi1328",
        repo: "khlim-assist",
        fullName: "Linardi1328/khlim-assist"
      }
    }))
    const runner = makeVerificationRunner()

    await assertRejectsCode(executeWithFixture(fixture, runner), "PRODUCTION_VERIFICATION_PROJECT_REFUSED")
    assert.equal(runner.state.verifyCalls.length, 0)
  }

  {
    const fixture = makeStateAdapter(makeDeployedRun())
    const runner = makeVerificationRunner()

    await assertRejectsCode(executeDevelopmentProductionVerification(RUN_ID, {
      ...fixture.api,
      verificationRunner: runner,
      expectedVersion: fixture.state.run.version,
      deploymentProfile: {
        ...PHASE_6H_PPO_DEPLOYMENT_PROFILE,
        serviceName: "other.service"
      }
    }), "PRODUCTION_VERIFICATION_TARGET_FROM_CALLER_REFUSED")
    assert.equal(runner.state.verifyCalls.length, 0)
  }
})

test("stale or malformed Phase 6H deployed evidence is rejected", async () => {
  for (const deploy of [
    { outcome: "deploy_started" },
    { source: "other-agent" },
    { agent: "other-agent" },
    { policyId: "other-policy" },
    { policyHash: "0".repeat(64) },
    { checkoutSha: WRONG_SHA },
    { service: "other.service" },
    { preflight: "failed" },
    { restart: "skipped" }
  ]) {
    const fixture = makeStateAdapter(makeDeployedRun({ deploy }))
    const runner = makeVerificationRunner()

    await assert.rejects(executeWithFixture(fixture, runner), (error) => {
      assert.match(error.code, /^PRODUCTION_VERIFICATION_/)
      return true
    })
    assert.equal(runner.state.verifyCalls.length, 0)
  }
})

test("Phase 6G to Phase 6H SHA chain must target the deployed merge commit", async () => {
  const fixture = makeStateAdapter(makeDeployedRun({
    merge: {
      mergeCommitSha: WRONG_SHA,
      mainSha: WRONG_SHA
    }
  }))
  const runner = makeVerificationRunner()

  await assertRejectsCode(executeWithFixture(fixture, runner), "PRODUCTION_VERIFICATION_SHA_CHAIN_INVALID")
  assert.equal(runner.state.verifyCalls.length, 0)
})

test("production verification failures transition to verification_failed with bounded classes", async () => {
  for (const [name, result, expectedFailureClass] of [
    ["observed checkout SHA mismatch", { observedCheckoutSha: WRONG_SHA }, "checkout_sha_mismatch"],
    ["dirty checkout", { ok: false, clean: "failed", failureClass: "dirty_checkout" }, "dirty_checkout"],
    ["wrong repository identity", { ok: false, repository: "failed", failureClass: "repository_identity_failed" }, "repository_identity_failed"],
    ["inactive service", { ok: false, serviceActive: false, failureClass: "inactive_service" }, "inactive_service"],
    ["wrong service user group workdir or ExecStart", { ok: false, serviceIdentity: "failed", failureClass: "service_identity_mismatch" }, "service_identity_mismatch"],
    ["runtime preflight failure", { ok: false, runtimePreflight: "failed", failureClass: "runtime_preflight_failed" }, "runtime_preflight_failed"],
    ["systemd unit mismatch", { ok: false, unitContract: "failed", failureClass: "unit_contract_failed" }, "unit_contract_failed"],
    ["permission contract failure", { ok: false, permissionContract: "failed", failureClass: "permission_contract_failed" }, "permission_contract_failed"],
    ["bridge help failure", { ok: false, bridge: "failed", failureClass: "bridge_help_failed" }, "bridge_help_failed"]
  ]) {
    const fixture = makeStateAdapter(makeDeployedRun())
    const runner = makeVerificationRunner({ result })
    const response = await executeWithFixture(fixture, runner)
    const evidence = fixture.state.run.evidence.verification.at(-1)

    assert.equal(response.ok, false, name)
    assert.equal(response.outcome, "verification_failed", name)
    assert.equal(fixture.state.run.status, "verification_failed", name)
    assert.equal(evidence.metadata.outcome, "verification_failed", name)
    assert.equal(evidence.metadata.failureClass, expectedFailureClass, name)
    assert.equal(evidence.metadata.deploymentSha, MERGE_SHA, name)
    assert.equal(runner.state.verifyCalls.length, 1, name)
  }
})

test("wrong fixed service identity from verifier fails safely", async () => {
  const fixture = makeStateAdapter(makeDeployedRun())
  const runner = makeVerificationRunner({
    result: {
      serviceName: "other.service"
    }
  })
  const response = await executeWithFixture(fixture, runner)

  assert.equal(response.ok, false)
  assert.equal(fixture.state.run.status, "verification_failed")
  assert.equal(fixture.state.run.evidence.verification.at(-1).metadata.failureClass, "service_identity_mismatch")
})

test("full success transitions to verified with exact-SHA metadata-only evidence", async () => {
  const fixture = makeStateAdapter(makeDeployedRun())
  const runner = makeVerificationRunner()
  const response = await executeWithFixture(fixture, runner)
  const evidence = fixture.state.run.evidence.verification.at(-1)
  const serializedEvidence = JSON.stringify(fixture.state.run.evidence.verification)

  assert.equal(response.ok, true)
  assert.equal(response.outcome, "verified")
  assert.equal(fixture.state.run.status, "verified")
  assert.equal(fixture.state.run.stage, "closed")
  assert.equal(evidence.metadata.outcome, "verified")
  assert.equal(evidence.metadata.deploymentSha, MERGE_SHA)
  assert.equal(evidence.metadata.checkoutSha, MERGE_SHA)
  assert.equal(evidence.metadata.service, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)
  assert.deepEqual(evidence.metadata.contract, verificationContract())
  assert.doesNotMatch(serializedEvidence, /SENSITIVE_TEST_SENTINEL|stdout|stderr|stack|raw|token|secret|credential|authorization|\/opt\/|\/var\/|\/etc\//i)
})

test("definitive scope violation fails without rollback, redeploy, or restart", async () => {
  const fixture = makeStateAdapter(makeDeployedRun())
  const runner = makeVerificationRunner({
    result: {
      rollbackInvoked: true,
      deploymentInvoked: true,
      restartInvoked: true
    }
  })
  const response = await executeWithFixture(fixture, runner)

  assert.equal(response.ok, false)
  assert.equal(fixture.state.run.status, "verification_failed")
  assert.equal(fixture.state.run.evidence.verification.at(-1).metadata.failureClass, "scope_violation")
  assert.equal(runner.state.verifyCalls.length, 1)
})

test("timeout signal and output overflow remain verification_in_progress and require reconciliation", async () => {
  for (const ambiguousMode of ["timeout", "signal", "overflow"]) {
    const fixture = makeStateAdapter(makeDeployedRun())
    const runner = makeVerificationRunner({ ambiguousMode })

    await assertRejectsCode(executeWithFixture(fixture, runner), "PRODUCTION_VERIFICATION_AMBIGUOUS")

    assert.equal(fixture.state.run.status, "verification_in_progress", ambiguousMode)
    assert.equal(fixture.state.run.evidence.verification.at(-1).metadata.outcome, "verification_started", ambiguousMode)

    const reconcileRunner = makeVerificationRunner()
    const beforeTransitions = fixture.state.transitions.length
    const reconciled = await reconcileDevelopmentProductionVerification(RUN_ID, {
      ...fixture.api,
      verificationRunner: reconcileRunner
    })

    assert.equal(fixture.state.transitions.length, beforeTransitions, ambiguousMode)
    assert.equal(reconciled.run.status, "verification_in_progress", ambiguousMode)
    assert.equal(reconciled.verification.expectedDeploymentSha, MERGE_SHA, ambiguousMode)
    assert.equal(reconciled.verification.attempt, 1, ambiguousMode)
    assert.equal(reconciled.verification.currentCheckoutSha, MERGE_SHA, ambiguousMode)
    assert.equal(reconciled.verification.service.active, true, ambiguousMode)
    assert.equal(reconciled.verification.service.running, true, ambiguousMode)
    assert.equal(reconciled.verification.verificationEvidenceComplete, false, ambiguousMode)
    assert.equal(reconciled.verification.completionProven, false, ambiguousMode)
    assert.equal(reconciled.verification.retryRequiresOwnerAction, true, ambiguousMode)
  }
})

test("malformed verification output is ambiguous and does not persist raw output", async () => {
  for (const rawResult of [
    {
      ...verificationResult(),
      stdout: "SENSITIVE_TEST_SENTINEL raw verifier output"
    },
    {
      ...verificationResult(),
      observedCheckoutSha: "not-a-sha"
    }
  ]) {
    const fixture = makeStateAdapter(makeDeployedRun())
    const runner = makeVerificationRunner({ rawResult })

    await assertRejectsCode(executeWithFixture(fixture, runner), "PRODUCTION_VERIFICATION_AMBIGUOUS")

    assert.equal(fixture.state.run.status, "verification_in_progress")
    assert.doesNotMatch(JSON.stringify(fixture.state.run.evidence.verification), /SENSITIVE_TEST_SENTINEL|stdout|stderr|raw|not-a-sha/i)
  }
})

test("reconciliation reports observed production state but never transitions to verified", async () => {
  const fixture = makeStateAdapter(makeDeployedRun({ status: "verification_in_progress", stage: "verification", verificationAttempts: 1 }))

  fixture.state.run.evidence.verification.push(verificationStartedEvidence())

  const runner = makeVerificationRunner()
  const beforeTransitions = fixture.state.transitions.length
  const reconciled = await reconcileDevelopmentProductionVerification(RUN_ID, {
    ...fixture.api,
    verificationRunner: runner
  })

  assert.equal(fixture.state.transitions.length, beforeTransitions)
  assert.equal(runner.state.verifyCalls.length, 0)
  assert.equal(runner.state.inspectCalls.length, 1)
  assert.equal(fixture.state.run.status, "verification_in_progress")
  assert.equal(reconciled.verification.currentCheckoutSha, MERGE_SHA)
  assert.equal(reconciled.verification.service.name, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)
  assert.equal(reconciled.verification.service.enabled, true)
  assert.equal(reconciled.verification.service.active, true)
  assert.equal(reconciled.verification.service.running, true)
  assert.equal(reconciled.verification.completionProven, false)
  assert.equal(reconciled.verification.ownerActionRequired, true)
})

test("reconciliation completion proof requires verified status and current full passing inspection", async () => {
  for (const [name, inspectResult] of [
    ["inactive current service", { ok: false, serviceActive: false, failureClass: "inactive_service" }],
    ["failed current permission contract", { ok: false, permissionContract: "failed", failureClass: "permission_contract_failed" }],
    ["failed current unit contract", { ok: false, unitContract: "failed", failureClass: "unit_contract_failed" }],
    ["failed current runtime preflight", { ok: false, runtimePreflight: "failed", failureClass: "runtime_preflight_failed" }],
    ["failed current bridge check", { ok: false, bridge: "failed", failureClass: "bridge_help_failed" }]
  ]) {
    const fixture = makeStateAdapter(makeVerifiedRun())
    const runner = makeVerificationRunner({ inspectResult })
    const beforeTransitions = fixture.state.transitions.length
    const reconciled = await reconcileDevelopmentProductionVerification(RUN_ID, {
      ...fixture.api,
      verificationRunner: runner
    })

    assert.equal(fixture.state.transitions.length, beforeTransitions, name)
    assert.equal(runner.state.verifyCalls.length, 0, name)
    assert.equal(runner.state.inspectCalls.length, 1, name)
    assert.equal(reconciled.run.status, "verified", name)
    assert.equal(reconciled.verification.completionProven, false, name)
    assert.equal(reconciled.verification.verificationEvidenceComplete, false, name)
  }
})

test("reconciliation rejects stale or partial verified evidence as completion proof", async () => {
  for (const [name, evidenceOverrides] of [
    ["wrong Phase 6I policy id", { policyId: "phase-6i-stale-policy" }],
    ["wrong Phase 6I policy hash", { policyHash: "0".repeat(64) }],
    ["wrong deployment SHA", { deploymentSha: WRONG_SHA }],
    ["wrong checkout SHA", { checkoutSha: WRONG_SHA }],
    ["partial contract", { contract: verificationContract().slice(0, 8) }],
    ["stale attempt", { attempt: 2 }]
  ]) {
    const fixture = makeStateAdapter(makeVerifiedRun(evidenceOverrides))
    const runner = makeVerificationRunner()
    const beforeTransitions = fixture.state.transitions.length
    const reconciled = await reconcileDevelopmentProductionVerification(RUN_ID, {
      ...fixture.api,
      verificationRunner: runner
    })

    assert.equal(fixture.state.transitions.length, beforeTransitions, name)
    assert.equal(runner.state.verifyCalls.length, 0, name)
    assert.equal(runner.state.inspectCalls.length, 1, name)
    assert.equal(reconciled.verification.completionProven, false, name)
    assert.equal(reconciled.verification.verificationEvidenceComplete, false, name)
  }
})

test("reconciliation can prove completion only with full exact evidence and current passing inspection", async () => {
  const fixture = makeStateAdapter(makeVerifiedRun())
  const runner = makeVerificationRunner()
  const beforeTransitions = fixture.state.transitions.length
  const reconciled = await reconcileDevelopmentProductionVerification(RUN_ID, {
    ...fixture.api,
    verificationRunner: runner
  })

  assert.equal(fixture.state.transitions.length, beforeTransitions)
  assert.equal(runner.state.verifyCalls.length, 0)
  assert.equal(runner.state.inspectCalls.length, 1)
  assert.equal(reconciled.run.status, "verified")
  assert.equal(reconciled.verification.currentCheckoutSha, MERGE_SHA)
  assert.equal(reconciled.verification.verificationEvidenceComplete, true)
  assert.equal(reconciled.verification.completionProven, true)
  assert.equal(reconciled.verification.ownerActionRequired, false)
})

function shellPredicate(functionName, value) {
  const result = spawnSync("bash", [
    "-c",
    'source "$1"; "$2" "$3"',
    "bash",
    VERIFY_PRODUCTION_READONLY_SCRIPT_PATH,
    functionName,
    value
  ], {
    encoding: "utf8"
  })

  return result.status === 0
}

test("systemd ExecStart validation accepts only the exact OpenClaw gateway command", () => {
  const exactCommand = "/home/ppo/.local/openclaw/bin/openclaw gateway run"
  const systemdExecStart = `{ path=/home/ppo/.local/openclaw/bin/openclaw ; argv[]=${exactCommand} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`

  assert.equal(shellPredicate("exec_start_matches_fixed_openclaw_gateway", exactCommand), true)
  assert.equal(shellPredicate("exec_start_matches_fixed_openclaw_gateway", systemdExecStart), true)

  for (const value of [
    `${exactCommand} --debug`,
    "/tmp/openclaw gateway run",
    `/usr/bin/env ${exactCommand}`,
    `/bin/sh -c '${exactCommand}'`,
    `${exactCommand} suffix`,
    `{ path=/home/ppo/.local/openclaw/bin/openclaw ; argv[]=${exactCommand} --debug ; ignore_errors=no ; }`,
    `{ path=/tmp/openclaw ; argv[]=/tmp/openclaw gateway run ; ignore_errors=no ; }`,
    `{ path=/home/ppo/.local/openclaw/bin/openclaw ; argv[]=${exactCommand} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 } { path=/bin/echo ; argv[]=/bin/echo suffix ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `prefix ${exactCommand}`
  ]) {
    assert.equal(shellPredicate("exec_start_matches_fixed_openclaw_gateway", value), false, value)
  }
})

test("Phase 6I scope excludes rollback, deploy, restart, GitHub write, model, and production routes", async () => {
  const verificationSource = await readFile(new URL("./development-production-verification-agent.mjs", import.meta.url), "utf8")
  const deploymentSource = await readFile(new URL("./development-deployment-agent.mjs", import.meta.url), "utf8")
  const commandSource = await readFile(new URL("./ppo-command.mjs", import.meta.url), "utf8")
  const bridgeSource = await readFile(new URL("../openclaw/plugins/ppo-local/test-bridge.mjs", import.meta.url), "utf8")

  assert.equal(phase6IProductionVerificationSecurityBoundary.startsFrom, "deployed")
  assert.equal(phase6IProductionVerificationSecurityBoundary.stopsAt, "verified")
  assert.equal(phase6IProductionVerificationSecurityBoundary.readOnlyProduction, true)
  assert.equal(phase6IProductionVerificationSecurityBoundary.rollback, false)
  assert.equal(phase6IProductionVerificationSecurityBoundary.deploymentMutation, false)
  assert.equal(phase6IProductionVerificationSecurityBoundary.serviceRestart, false)
  assert.equal(phase6IProductionVerificationSecurityBoundary.githubWrite, false)
  assert.equal(phase6IProductionVerificationSecurityBoundary.modelExecution, false)
  assert.equal(phase6IProductionVerificationSecurityBoundary.ppoContinue, false)
  assert.equal(phase6IProductionVerificationSecurityBoundary.telegramOrOpenClawRouting, false)
  assert.match(verificationSource, /execFile/)
  assert.match(verificationSource, /shell: false/)
  assert.doesNotMatch(verificationSource, /rollback-repo|deploy-exact-sha|git push|gh api|workflow dispatch|labels|comments|codex --|openclaw gateway run/)
  assert.doesNotMatch(deploymentSource, /development-production-verification-agent/)
  assert.doesNotMatch(commandSource, /development-production-verification-agent|executeDevelopmentProductionVerification|verify-production-readonly|verification_in_progress|verified/)
  assert.doesNotMatch(bridgeSource, /development-production-verification-agent|verification_in_progress|verified/)
})

test("production verification shell primitive has only read-only command shapes", async () => {
  const scriptSource = await readFile(new URL("../deployment/scripts/verify-production-readonly.sh", import.meta.url), "utf8")
  const helperSource = await readFile(new URL("../deployment/scripts/verify-ppo-local-help.mjs", import.meta.url), "utf8")

  assert.match(scriptSource, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m)
  assert.match(scriptSource, /INSTALL_DIR="\/opt\/personal-project-operator"/)
  assert.match(scriptSource, /SERVICE_NAME="ppo-openclaw\.service"/)
  assert.match(scriptSource, /REPO_URL="https:\/\/github\.com\/Linardi1328\/personal-project-operator\.git"/)
  assert.match(scriptSource, /git -C "\$INSTALL_DIR" remote get-url "\$REMOTE_NAME"/)
  assert.match(scriptSource, /git -C "\$INSTALL_DIR" rev-parse --verify HEAD/)
  assert.match(scriptSource, /git -C "\$INSTALL_DIR" symbolic-ref -q HEAD/)
  assert.match(scriptSource, /git --no-optional-locks -C "\$INSTALL_DIR" -c core\.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames/)
  assert.doesNotMatch(scriptSource, /git -C "\$INSTALL_DIR" status --porcelain=v1/)
  assert.match(scriptSource, /sudo -u "\$SERVICE_USER" "\$PREFLIGHT_SCRIPT"/)
  assert.match(scriptSource, /systemctl is-enabled --quiet "\$SERVICE_NAME"/)
  assert.match(scriptSource, /systemctl is-active --quiet "\$SERVICE_NAME"/)
  assert.match(scriptSource, /systemctl show "\$SERVICE_NAME"/)
  assert.match(scriptSource, /--property=DropInPaths --value/)
  assert.match(scriptSource, /\[\[ -z "\$drop_in_paths" \]\] \|\| fail_result "unit_contract_failed"/)
  assert.match(scriptSource, /exec_start_matches_fixed_openclaw_gateway "\$exec_start"/)
  assert.match(scriptSource, /cmp -s "\$SYSTEMD_UNIT" "\$REVIEWED_UNIT"/)
  assert.match(scriptSource, /WRITE_DATA_DIR="\$\{STATE_DIR\}\/write-data"/)
  assert.match(scriptSource, /path_contract "\$WRITE_DATA_DIR" "\$SERVICE_USER" "\$SERVICE_GROUP" 700/)
  assert.match(scriptSource, /"\$NODE_BIN" "\$BRIDGE_HELP_CHECK"/)
  assert.doesNotMatch(scriptSource, /\beval\b|git fetch|git pull|git checkout|git switch|git reset|git update-ref|git branch|git push/)
  assert.doesNotMatch(scriptSource, /\b(?:chmod|chown|install|apt|apt-get|npm|curl|ssh|scp|rsync)\b/)
  assert.doesNotMatch(scriptSource, /systemctl\s+(?:start|stop|restart|reload|enable|disable|daemon-reload)/)
  assert.doesNotMatch(scriptSource, /rollback-repo|gh api|workflow dispatch|authorization|token|secret|credential/i)
  assert.doesNotMatch(helperSource, /execFile|spawn|curl|ssh|gh api|codex|rollback|restart/)
})
