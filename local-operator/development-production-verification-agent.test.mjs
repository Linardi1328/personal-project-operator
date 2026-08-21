import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
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
  assert.equal(evidence.metadata.active, true)
  assert.equal(evidence.metadata.running, true)
  assert.equal(evidence.metadata.runtimePreflight, "passed")
  assert.equal(evidence.metadata.bridge, "passed")
  assert.equal(evidence.metadata.permissionContract, "passed")
  assert.equal(evidence.metadata.unitContract, "passed")
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

  fixture.state.run.evidence.verification.push({
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
      attempt: 1,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName
    }
  })

  const runner = makeVerificationRunner()
  const beforeTransitions = fixture.state.transitions.length
  const reconciled = await reconcileDevelopmentProductionVerification(RUN_ID, {
    ...fixture.api,
    verificationRunner: runner
  })

  assert.equal(fixture.state.transitions.length, beforeTransitions)
  assert.equal(fixture.state.run.status, "verification_in_progress")
  assert.equal(reconciled.verification.currentCheckoutSha, MERGE_SHA)
  assert.equal(reconciled.verification.service.name, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)
  assert.equal(reconciled.verification.service.enabled, true)
  assert.equal(reconciled.verification.service.active, true)
  assert.equal(reconciled.verification.service.running, true)
  assert.equal(reconciled.verification.completionProven, false)
  assert.equal(reconciled.verification.ownerActionRequired, true)
})

test("Phase 6I scope excludes rollback, deploy, restart, GitHub write, model, routes, and continue command", async () => {
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
  assert.doesNotMatch(commandSource, /\bcontinue\b|development-production-verification-agent|verification_in_progress|verified/)
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
  assert.match(scriptSource, /git -C "\$INSTALL_DIR" status --porcelain=v1/)
  assert.match(scriptSource, /sudo -u "\$SERVICE_USER" "\$PREFLIGHT_SCRIPT"/)
  assert.match(scriptSource, /systemctl is-enabled --quiet "\$SERVICE_NAME"/)
  assert.match(scriptSource, /systemctl is-active --quiet "\$SERVICE_NAME"/)
  assert.match(scriptSource, /systemctl show "\$SERVICE_NAME"/)
  assert.match(scriptSource, /cmp -s "\$SYSTEMD_UNIT" "\$REVIEWED_UNIT"/)
  assert.match(scriptSource, /"\$NODE_BIN" "\$BRIDGE_HELP_CHECK"/)
  assert.doesNotMatch(scriptSource, /\beval\b|git fetch|git pull|git checkout|git switch|git reset|git update-ref|git branch|git push/)
  assert.doesNotMatch(scriptSource, /\b(?:chmod|chown|install|apt|apt-get|npm|curl|ssh|scp|rsync)\b/)
  assert.doesNotMatch(scriptSource, /systemctl\s+(?:start|stop|restart|reload|enable|disable|daemon-reload)/)
  assert.doesNotMatch(scriptSource, /rollback-repo|gh api|workflow dispatch|authorization|token|secret|credential/i)
  assert.doesNotMatch(helperSource, /execFile|spawn|curl|ssh|gh api|codex|rollback|restart/)
})
