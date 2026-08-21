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
  DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
  PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
  PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID
} from "./development-production-verification-agent.mjs"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  DEVELOPMENT_ROLLBACK_AGENT_ID,
  PHASE_6J_OWNER_ROLLBACK_CONFIRMATION,
  PHASE_6J_ROLLBACK_POLICY_HASH,
  PHASE_6J_ROLLBACK_POLICY_ID,
  executeDevelopmentRollback,
  phase6JRollbackSecurityBoundary,
  reconcileDevelopmentRollback
} from "./development-rollback-agent.mjs"
import {
  DEVELOPMENT_RUN_EVIDENCE_KINDS,
  DevelopmentRunStateError,
  normalizeDevelopmentRunEvidenceRecord
} from "./development-run-state.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD
} from "./github-delivery-agent.mjs"

const RUN_ID = "R".repeat(43)
const IMPLEMENTATION_SHA = "a".repeat(40)
const DEPLOYMENT_SHA = "b".repeat(40)
const ROLLBACK_SHA = "c".repeat(40)
const WRONG_SHA = "d".repeat(40)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function emptyEvidence() {
  return Object.fromEntries(DEVELOPMENT_RUN_EVIDENCE_KINDS.map((kind) => [kind, []]))
}

function mergedEvidence({
  implementationSha = IMPLEMENTATION_SHA,
  mergeCommitSha = DEPLOYMENT_SHA,
  mainSha = DEPLOYMENT_SHA,
  policyId = PHASE_6G_DELIVERY_POLICY_ID,
  policyHash = PHASE_6G_DELIVERY_POLICY_HASH
} = {}) {
  return {
    kind: "merge",
    sha: implementationSha,
    source: GITHUB_DELIVERY_AGENT_ID,
    summary: "Exact-head merge verified.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: GITHUB_DELIVERY_AGENT_ID,
      policyId,
      policyHash,
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
  deploymentSha = DEPLOYMENT_SHA,
  checkoutSha = DEPLOYMENT_SHA,
  previousInstalledSha = ROLLBACK_SHA,
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

function verificationStartedEvidence({ deploymentSha = DEPLOYMENT_SHA, attempt = 1 } = {}) {
  return {
    kind: "verification",
    sha: deploymentSha,
    source: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
    summary: "Phase 6I production verification started.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
      policyId: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
      policyHash: PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH,
      deploymentSha,
      outcome: "verification_started",
      attempt,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName
    }
  }
}

function verificationFailedEvidence({
  deploymentSha = DEPLOYMENT_SHA,
  attempt = 1,
  outcome = "verification_failed",
  policyId = PHASE_6I_PRODUCTION_VERIFICATION_POLICY_ID,
  policyHash = PHASE_6I_PRODUCTION_VERIFICATION_POLICY_HASH
} = {}) {
  return {
    kind: "verification",
    sha: deploymentSha,
    source: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
    summary: "Phase 6I production verification failed.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: DEVELOPMENT_PRODUCTION_VERIFICATION_AGENT_ID,
      policyId,
      policyHash,
      deploymentSha,
      outcome,
      attempt,
      failureClass: "runtime_preflight_failed",
      checkoutSha: deploymentSha,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName
    }
  }
}

function makeVerificationFailedRun(overrides = {}) {
  const evidence = emptyEvidence()

  evidence.merge.push(mergedEvidence(overrides.merge || {}))
  evidence.deploy.push(deployedEvidence(overrides.deploy || {}))
  evidence.verification.push(verificationStartedEvidence(overrides.verificationStarted || {}))
  evidence.verification.push(verificationFailedEvidence(overrides.verificationFailed || {}))

  for (const [kind, entries] of Object.entries(overrides.evidence || {})) {
    evidence[kind] = entries
  }

  return {
    schemaVersion: 1,
    runId: RUN_ID,
    version: overrides.version ?? 16,
    stage: overrides.stage || "verification",
    status: overrides.status || "verification_failed",
    project: overrides.project || {
      id: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      owner: "Linardi1328",
      repo: "personal-project-operator",
      fullName: PHASE_6H_PPO_DEPLOYMENT_PROFILE.repositoryFullName
    },
    task: "Rollback a failed PPO deployment verification.",
    baseSha: "0".repeat(40),
    branch: "phase/6j-exact-previous-sha-rollback",
    headSha: IMPLEMENTATION_SHA,
    attempts: {
      planning: 1,
      implementation: 1,
      test: 1,
      review: 1,
      merge: 1,
      deploy: 1,
      verification: 1,
      rollback: overrides.rollbackAttempts ?? 0
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

function rollbackResult(overrides = {}) {
  return {
    schemaVersion: 1,
    ok: true,
    failureClass: "none",
    observedCheckoutSha: ROLLBACK_SHA,
    serviceName: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
    serviceEnabled: true,
    serviceActive: true,
    serviceRunning: true,
    serviceMainPidNonZero: true,
    repository: "passed",
    currentCheckout: "passed",
    detached: "passed",
    clean: "passed",
    previousRevision: "passed",
    rollbackCommit: "passed",
    checkoutSwitch: "passed",
    permissionContract: "passed",
    runtimePreflight: "passed",
    serviceRestart: "passed",
    postrollbackCheckout: "passed",
    rollbackInvoked: true,
    deploymentInvoked: false,
    githubWriteInvoked: false,
    modelInvoked: false,
    routeInvoked: false,
    networkRefreshInvoked: false,
    legacyRollbackInvoked: false,
    ...overrides
  }
}

function rollbackInspectionResult(overrides = {}) {
  return rollbackResult({
    currentCheckout: "failed",
    checkoutSwitch: "not_applicable",
    serviceRestart: "not_applicable",
    rollbackInvoked: false,
    ...overrides
  })
}

function rollbackContract(overrides = {}) {
  const result = rollbackResult(overrides)

  return [
    `repository:${result.repository}`,
    `currentCheckout:${result.currentCheckout}`,
    `detached:${result.detached}`,
    `clean:${result.clean}`,
    `previousRevision:${result.previousRevision}`,
    `rollbackCommit:${result.rollbackCommit}`,
    `checkoutSwitch:${result.checkoutSwitch}`,
    `permissionContract:${result.permissionContract}`,
    `runtimePreflight:${result.runtimePreflight}`,
    `serviceRestart:${result.serviceRestart}`,
    `postrollbackCheckout:${result.postrollbackCheckout}`,
    `serviceActive:${result.serviceActive === true ? "true" : "false"}`,
    `serviceRunning:${result.serviceRunning === true ? "true" : "false"}`,
    `serviceMainPidNonZero:${result.serviceMainPidNonZero === true ? "true" : "false"}`
  ]
}

function rollbackStartedEvidence({ attempt = 1 } = {}) {
  return {
    kind: "rollback",
    sha: ROLLBACK_SHA,
    source: DEVELOPMENT_ROLLBACK_AGENT_ID,
    summary: "Phase 6J exact previous-SHA rollback attempt was reserved.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: DEVELOPMENT_ROLLBACK_AGENT_ID,
      policyId: PHASE_6J_ROLLBACK_POLICY_ID,
      policyHash: PHASE_6J_ROLLBACK_POLICY_HASH,
      deploymentSha: DEPLOYMENT_SHA,
      rollbackSha: ROLLBACK_SHA,
      outcome: "rollback_started",
      attempt,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName
    }
  }
}

function rolledBackEvidence({
  attempt = 1,
  policyId = PHASE_6J_ROLLBACK_POLICY_ID,
  policyHash = PHASE_6J_ROLLBACK_POLICY_HASH,
  contract = rollbackContract()
} = {}) {
  return {
    kind: "rollback",
    sha: ROLLBACK_SHA,
    source: DEVELOPMENT_ROLLBACK_AGENT_ID,
    summary: "Phase 6J exact previous-SHA rollback completed.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: DEVELOPMENT_ROLLBACK_AGENT_ID,
      policyId,
      policyHash,
      deploymentSha: DEPLOYMENT_SHA,
      rollbackSha: ROLLBACK_SHA,
      outcome: "rolled_back",
      attempt,
      observedCheckoutSha: ROLLBACK_SHA,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
      contract
    }
  }
}

function makeRolledBackRun(evidenceOverrides = {}) {
  const run = makeVerificationFailedRun({
    status: "rolled_back",
    stage: "rollback",
    rollbackAttempts: 1
  })

  run.evidence.rollback.push(rollbackStartedEvidence({ attempt: evidenceOverrides.startedAttempt || 1 }))
  run.evidence.rollback.push(rolledBackEvidence(evidenceOverrides))
  return run
}

function staleRunStateError() {
  return new DevelopmentRunStateError(
    "STALE_RUN_VERSION",
    "Development run state changed; reload before retrying."
  )
}

function stageForStatus(status) {
  if (status === "verified") {
    return "closed"
  }

  if (["rollback_in_progress", "rollback_failed", "rolled_back"].includes(status)) {
    return "rollback"
  }

  if (status.startsWith("verification")) {
    return "verification"
  }

  if (status.includes("deploy") || status === "deployed") {
    return "deploy"
  }

  return "implementation"
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

      if (transition.status === "rollback_in_progress") {
        nextAttempts.rollback += 1
      }

      state.transitions.push(clone(transition))
      state.run = {
        ...state.run,
        version: state.run.version + 1,
        status: transition.status,
        stage: stageForStatus(transition.status),
        attempts: nextAttempts,
        evidence: {
          ...state.run.evidence,
          rollback: [...state.run.evidence.rollback, ...evidence]
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

function makeRollbackRunner(options = {}) {
  const state = {
    executeCalls: [],
    inspectCalls: []
  }

  const runner = async (invocation) => {
    assert.equal(invocation.shell, false)
    assert.equal(invocation.profile.profileId, PHASE_6H_PPO_DEPLOYMENT_PROFILE.profileId)
    assert.equal(invocation.deploymentSha, options.expectedDeploymentSha || DEPLOYMENT_SHA)
    assert.equal(invocation.rollbackSha, options.expectedRollbackSha || ROLLBACK_SHA)
    assert.equal(invocation.serviceName, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)

    if (invocation.kind === "inspect-rollback") {
      state.inspectCalls.push(clone(invocation))
      return rollbackInspectionResult(options.inspectResult || {})
    }

    if (invocation.kind === "execute-rollback") {
      state.executeCalls.push(clone(invocation))

      if (options.ambiguousMode) {
        const error = new Error("ambiguous rollback")

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

      return rollbackResult(options.result || {})
    }

    throw new Error(`unexpected rollback operation: ${invocation.kind}`)
  }

  runner.state = state
  return runner
}

async function executeWithFixture(fixture, runner, options = {}) {
  return await executeDevelopmentRollback(RUN_ID, {
    ...fixture.api,
    rollbackRunner: runner,
    expectedVersion: fixture.state.run.version,
    ownerConfirmation: PHASE_6J_OWNER_ROLLBACK_CONFIRMATION,
    now: () => new Date("2026-08-22T00:00:01.000Z"),
    ...options
  })
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code)
    return true
  })
}

test("verification_failed run with valid Phase 6H and Phase 6I evidence reserves rollback before ambiguity", async () => {
  const fixture = makeStateAdapter(makeVerificationFailedRun())
  const runner = makeRollbackRunner({ ambiguousMode: "timeout" })

  await assertRejectsCode(executeWithFixture(fixture, runner), "ROLLBACK_AMBIGUOUS")

  assert.equal(fixture.state.run.status, "rollback_in_progress")
  assert.equal(fixture.state.run.attempts.rollback, 1)
  assert.equal(fixture.state.transitions.at(0).status, "rollback_in_progress")
  assert.equal(fixture.state.run.evidence.rollback.at(-1).metadata.outcome, "rollback_started")
  assert.equal(fixture.state.run.evidence.rollback.at(-1).metadata.deploymentSha, DEPLOYMENT_SHA)
  assert.equal(fixture.state.run.evidence.rollback.at(-1).metadata.rollbackSha, ROLLBACK_SHA)
  assert.equal(runner.state.executeCalls.length, 1)
})

test("only verification_failed runs are accepted for Phase 6J rollback", async () => {
  for (const status of [
    "created",
    "planning_in_progress",
    "planned",
    "implementation_in_progress",
    "implementation_ready",
    "tests_in_progress",
    "tests_failed",
    "tests_passed",
    "review_in_progress",
    "review_changes_requested",
    "review_passed",
    "merge_ready",
    "merged",
    "deploy_in_progress",
    "deploy_failed",
    "deployed",
    "verification_in_progress",
    "verified",
    "cancelled",
    "failed"
  ]) {
    const fixture = makeStateAdapter(makeVerificationFailedRun({
      status,
      stage: stageForStatus(status)
    }))
    const runner = makeRollbackRunner()

    await assertRejectsCode(executeWithFixture(fixture, runner), "ROLLBACK_RUN_NOT_VERIFICATION_FAILED")
    assert.equal(runner.state.executeCalls.length, 0, status)
  }
})

test("stale expectedVersion is rejected before rollback mutation", async () => {
  const fixture = makeStateAdapter(makeVerificationFailedRun({ version: 16 }))
  const runner = makeRollbackRunner()

  await assertRejectsCode(executeDevelopmentRollback(RUN_ID, {
    ...fixture.api,
    rollbackRunner: runner,
    expectedVersion: 15,
    ownerConfirmation: PHASE_6J_OWNER_ROLLBACK_CONFIRMATION
  }), "STALE_RUN_VERSION")

  assert.equal(fixture.state.run.status, "verification_failed")
  assert.equal(runner.state.executeCalls.length, 0)
})

test("missing or mismatched owner confirmation performs no transition or rollback", async () => {
  for (const ownerConfirmation of [undefined, "", "wrong-confirmation"]) {
    const fixture = makeStateAdapter(makeVerificationFailedRun())
    const runner = makeRollbackRunner()

    await assertRejectsCode(executeDevelopmentRollback(RUN_ID, {
      ...fixture.api,
      rollbackRunner: runner,
      expectedVersion: fixture.state.run.version,
      ownerConfirmation
    }), "ROLLBACK_OWNER_CONFIRMATION_REQUIRED")

    assert.equal(fixture.state.run.status, "verification_failed")
    assert.equal(fixture.state.transitions.length, 0)
    assert.equal(runner.state.executeCalls.length, 0)
  }
})

test("caller-supplied rollback or deployment targets are rejected", async () => {
  for (const key of [
    "rollbackSha",
    "targetSha",
    "previousSha",
    "deploymentSha",
    "checkoutSha",
    "repositoryFullName",
    "serviceName",
    "installDir",
    "stateDir",
    "command",
    "executablePath",
    "scriptPath",
    "policy",
    "profile"
  ]) {
    const fixture = makeStateAdapter(makeVerificationFailedRun())
    const runner = makeRollbackRunner()

    await assertRejectsCode(executeDevelopmentRollback(RUN_ID, {
      ...fixture.api,
      rollbackRunner: runner,
      expectedVersion: fixture.state.run.version,
      ownerConfirmation: PHASE_6J_OWNER_ROLLBACK_CONFIRMATION,
      [key]: "caller-value"
    }), "ROLLBACK_TARGET_FROM_CALLER_REFUSED")

    assert.equal(fixture.state.transitions.length, 0, key)
    assert.equal(runner.state.executeCalls.length, 0, key)
  }
})

test("trusted rollback evidence chain is required before mutation", async () => {
  for (const [name, overrides] of [
    ["wrong PPO identity", { project: { id: "khlim-assist", owner: "Linardi1328", repo: "khlim-assist", fullName: "Linardi1328/khlim-assist" } }],
    ["invalid Phase 6G chain", { merge: { mergeCommitSha: WRONG_SHA, mainSha: WRONG_SHA } }],
    ["invalid Phase 6H policy", { deploy: { policyId: "other-policy" } }],
    ["invalid Phase 6H outcome", { deploy: { outcome: "deploy_failed" } }],
    ["missing previous installed SHA", { deploy: { previousInstalledSha: "" } }],
    ["malformed previous installed SHA", { deploy: { previousInstalledSha: "not-a-sha" } }],
    ["previous installed SHA equals deployment", { deploy: { previousInstalledSha: DEPLOYMENT_SHA } }],
    ["invalid Phase 6I policy", { verificationFailed: { policyHash: "0".repeat(64) } }],
    ["invalid Phase 6I outcome", { verificationFailed: { outcome: "verified" } }],
    ["mismatched Phase 6I deployment SHA", { verificationFailed: { deploymentSha: WRONG_SHA } }],
    ["mismatched Phase 6I attempt", { verificationFailed: { attempt: 2 } }]
  ]) {
    const fixture = makeStateAdapter(makeVerificationFailedRun(overrides))
    const runner = makeRollbackRunner()

    await assert.rejects(executeWithFixture(fixture, runner), (error) => {
      assert.match(error.code, /^ROLLBACK_/u, name)
      return true
    })
    assert.equal(fixture.state.transitions.length, 0, name)
    assert.equal(runner.state.executeCalls.length, 0, name)
  }
})

test("pre-mutation rollback prerequisite failures transition rollback_failed with bounded classes", async () => {
  for (const [name, result, expectedFailureClass] of [
    ["current checkout mismatch", { ok: false, observedCheckoutSha: WRONG_SHA, currentCheckout: "failed", failureClass: "current_checkout_mismatch", rollbackInvoked: false }, "current_checkout_mismatch"],
    ["dirty checkout", { ok: false, observedCheckoutSha: DEPLOYMENT_SHA, clean: "failed", failureClass: "dirty_checkout", rollbackInvoked: false, serviceRestart: "not_run" }, "dirty_checkout"],
    ["branch attached checkout", { ok: false, observedCheckoutSha: DEPLOYMENT_SHA, detached: "failed", failureClass: "checkout_not_detached", rollbackInvoked: false, serviceRestart: "not_run" }, "checkout_not_detached"],
    ["wrong repository origin", { ok: false, observedCheckoutSha: DEPLOYMENT_SHA, repository: "failed", failureClass: "repository_identity_failed", rollbackInvoked: false, serviceRestart: "not_run" }, "repository_identity_failed"],
    ["previous marker mismatch", { ok: false, observedCheckoutSha: DEPLOYMENT_SHA, previousRevision: "failed", failureClass: "previous_revision_mismatch", rollbackInvoked: false, serviceRestart: "not_run" }, "previous_revision_mismatch"],
    ["rollback commit missing", { ok: false, observedCheckoutSha: DEPLOYMENT_SHA, rollbackCommit: "failed", failureClass: "rollback_commit_missing", rollbackInvoked: false, serviceRestart: "not_run" }, "rollback_commit_missing"]
  ]) {
    const fixture = makeStateAdapter(makeVerificationFailedRun())
    const runner = makeRollbackRunner({ result })
    const response = await executeWithFixture(fixture, runner)
    const evidence = fixture.state.run.evidence.rollback.at(-1)

    assert.equal(response.ok, false, name)
    assert.equal(response.outcome, "rollback_failed", name)
    assert.equal(fixture.state.run.status, "rollback_failed", name)
    assert.equal(evidence.metadata.outcome, "rollback_failed", name)
    assert.equal(evidence.metadata.failureClass, expectedFailureClass, name)
    assert.equal(evidence.metadata.deploymentSha, DEPLOYMENT_SHA, name)
    assert.equal(evidence.metadata.rollbackSha, ROLLBACK_SHA, name)
    assert.equal(runner.state.executeCalls.length, 1, name)
  }
})

test("successful rollback transitions to rolled_back with exact-SHA metadata-only evidence", async () => {
  const fixture = makeStateAdapter(makeVerificationFailedRun())
  const runner = makeRollbackRunner()
  const response = await executeWithFixture(fixture, runner)
  const evidence = fixture.state.run.evidence.rollback.at(-1)
  const serializedEvidence = JSON.stringify(fixture.state.run.evidence.rollback)
  const invocation = runner.state.executeCalls[0]

  assert.equal(response.ok, true)
  assert.equal(response.outcome, "rolled_back")
  assert.equal(fixture.state.run.status, "rolled_back")
  assert.equal(fixture.state.run.stage, "rollback")
  assert.equal(invocation.deploymentSha, DEPLOYMENT_SHA)
  assert.equal(invocation.rollbackSha, ROLLBACK_SHA)
  assert.equal(invocation.serviceName, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)
  assert.equal(evidence.metadata.outcome, "rolled_back")
  assert.equal(evidence.metadata.deploymentSha, DEPLOYMENT_SHA)
  assert.equal(evidence.metadata.rollbackSha, ROLLBACK_SHA)
  assert.equal(evidence.metadata.observedCheckoutSha, ROLLBACK_SHA)
  assert.deepEqual(evidence.metadata.contract, rollbackContract())
  assert.doesNotMatch(serializedEvidence, /rollback-verification-failure|SENSITIVE_TEST_SENTINEL|stdout|stderr|stack|raw|token|secret|credential|authorization|\/opt\/|\/var\/|\/etc\//i)
})

test("post-switch failures are bounded and do not trigger automatic redeploy or second rollback", async () => {
  for (const [name, result, expectedFailureClass] of [
    ["checkout switch failure", { ok: false, observedCheckoutSha: DEPLOYMENT_SHA, checkoutSwitch: "failed", failureClass: "checkout_switch_failed", rollbackInvoked: true }, "checkout_switch_failed"],
    ["permission failure", { ok: false, permissionContract: "failed", failureClass: "permission_contract_failed", rollbackInvoked: true }, "permission_contract_failed"],
    ["runtime preflight failure after checkout", { ok: false, runtimePreflight: "failed", serviceRestart: "not_run", failureClass: "runtime_preflight_failed", rollbackInvoked: true }, "runtime_preflight_failed"],
    ["service restart failure", { ok: false, serviceRestart: "failed", failureClass: "service_restart_failed", rollbackInvoked: true }, "service_restart_failed"],
    ["postrollback checkout mismatch", { ok: false, observedCheckoutSha: WRONG_SHA, postrollbackCheckout: "failed", failureClass: "postrollback_checkout_mismatch", rollbackInvoked: true }, "postrollback_checkout_mismatch"],
    ["service not running", { ok: false, serviceActive: false, failureClass: "service_not_running", rollbackInvoked: true }, "service_not_running"]
  ]) {
    const fixture = makeStateAdapter(makeVerificationFailedRun())
    const runner = makeRollbackRunner({ result })
    const response = await executeWithFixture(fixture, runner)
    const evidence = fixture.state.run.evidence.rollback.at(-1)

    assert.equal(response.ok, false, name)
    assert.equal(response.outcome, "rollback_failed", name)
    assert.equal(evidence.metadata.failureClass, expectedFailureClass, name)
    assert.equal(runner.state.executeCalls.length, 1, name)
    assert.equal(runner.state.inspectCalls.length, 0, name)
    assert.equal(fixture.state.transitions.filter((transition) => transition.status === "rollback_in_progress").length, 1, name)
  }
})

test("timeout signal output overflow and malformed rollback output remain rollback_in_progress", async () => {
  for (const options of [
    { ambiguousMode: "timeout" },
    { ambiguousMode: "signal" },
    { ambiguousMode: "overflow" },
    { rawResult: { ...rollbackResult(), stdout: "SENSITIVE_TEST_SENTINEL raw output" } },
    { rawResult: { ...rollbackResult(), observedCheckoutSha: "not-a-sha" } }
  ]) {
    const fixture = makeStateAdapter(makeVerificationFailedRun())
    const runner = makeRollbackRunner(options)

    await assertRejectsCode(executeWithFixture(fixture, runner), "ROLLBACK_AMBIGUOUS")

    assert.equal(fixture.state.run.status, "rollback_in_progress")
    assert.equal(fixture.state.run.evidence.rollback.at(-1).metadata.outcome, "rollback_started")
    assert.equal(runner.state.executeCalls.length, 1)
    assert.doesNotMatch(JSON.stringify(fixture.state.run.evidence.rollback), /SENSITIVE_TEST_SENTINEL|stdout|stderr|raw|not-a-sha/i)
  }
})

test("rollback reconciliation reports not-started, incomplete, and failed current observations without mutation", async () => {
  for (const [name, run, inspectResult, expected] of [
    ["still at deployment SHA", makeVerificationFailedRun(), { observedCheckoutSha: DEPLOYMENT_SHA, currentCheckout: "passed", postrollbackCheckout: "failed", failureClass: "rollback_not_started" }, { notStarted: true, applied: false }],
    ["rollback SHA without completion evidence", makeVerificationFailedRun({ status: "rollback_in_progress", stage: "rollback", rollbackAttempts: 1 }), {}, { notStarted: false, applied: true }],
    ["wrong third SHA", makeVerificationFailedRun({ status: "rollback_in_progress", stage: "rollback", rollbackAttempts: 1 }), { observedCheckoutSha: WRONG_SHA, postrollbackCheckout: "failed", failureClass: "rollback_incomplete" }, { notStarted: false, applied: false }],
    ["inactive service", makeRolledBackRun(), { serviceActive: false, failureClass: "service_not_running" }, { notStarted: false, applied: true }]
  ]) {
    if (run.status === "rollback_in_progress" && run.evidence.rollback.length === 0) {
      run.evidence.rollback.push(rollbackStartedEvidence())
    }

    const fixture = makeStateAdapter(run)
    const runner = makeRollbackRunner({ inspectResult })
    const beforeTransitions = fixture.state.transitions.length
    const reconciled = await reconcileDevelopmentRollback(RUN_ID, {
      ...fixture.api,
      rollbackRunner: runner
    })

    assert.equal(fixture.state.transitions.length, beforeTransitions, name)
    assert.equal(runner.state.executeCalls.length, 0, name)
    assert.equal(runner.state.inspectCalls.length, 1, name)
    assert.equal(reconciled.rollback.rollbackAppearsNotStarted, expected.notStarted, name)
    assert.equal(reconciled.rollback.rollbackAppearsApplied, expected.applied, name)
    assert.equal(reconciled.rollback.completionProven, false, name)
    assert.equal(reconciled.rollback.rollbackEvidenceComplete, false, name)
    assert.equal(reconciled.rollback.ownerActionRequired, !["rolled_back"].includes(run.status) || name === "inactive service", name)
  }
})

test("rollback reconciliation proves completion only with full exact evidence and passing current observation", async () => {
  for (const [name, run, inspectResult, expectedComplete] of [
    ["wrong policy id", makeRolledBackRun({ policyId: "phase-6j-stale-policy" }), {}, false],
    ["wrong policy hash", makeRolledBackRun({ policyHash: "0".repeat(64) }), {}, false],
    ["partial evidence", makeRolledBackRun({ contract: rollbackContract().slice(0, 8) }), {}, false],
    ["stale attempt", makeRolledBackRun({ attempt: 2 }), {}, false],
    ["full evidence", makeRolledBackRun(), {}, true]
  ]) {
    const fixture = makeStateAdapter(run)
    const runner = makeRollbackRunner({ inspectResult })
    const beforeTransitions = fixture.state.transitions.length
    const reconciled = await reconcileDevelopmentRollback(RUN_ID, {
      ...fixture.api,
      rollbackRunner: runner
    })

    assert.equal(fixture.state.transitions.length, beforeTransitions, name)
    assert.equal(runner.state.executeCalls.length, 0, name)
    assert.equal(runner.state.inspectCalls.length, 1, name)
    assert.equal(reconciled.rollback.rollbackEvidenceComplete, expectedComplete, name)
    assert.equal(reconciled.rollback.completionProven, expectedComplete, name)
  }
})

test("Phase 6J scope excludes automatic rollback, GitHub writes, model execution, routes, and continue command", async () => {
  const rollbackSource = await readFile(new URL("./development-rollback-agent.mjs", import.meta.url), "utf8")
  const verificationSource = await readFile(new URL("./development-production-verification-agent.mjs", import.meta.url), "utf8")
  const deploymentSource = await readFile(new URL("./development-deployment-agent.mjs", import.meta.url), "utf8")
  const commandSource = await readFile(new URL("./ppo-command.mjs", import.meta.url), "utf8")
  const bridgeSource = await readFile(new URL("../openclaw/plugins/ppo-local/test-bridge.mjs", import.meta.url), "utf8")

  assert.equal(phase6JRollbackSecurityBoundary.startsFrom, "verification_failed")
  assert.equal(phase6JRollbackSecurityBoundary.rollbackFromVerified, false)
  assert.equal(phase6JRollbackSecurityBoundary.automaticRollback, false)
  assert.equal(phase6JRollbackSecurityBoundary.networkRefresh, false)
  assert.equal(phase6JRollbackSecurityBoundary.githubWrite, false)
  assert.equal(phase6JRollbackSecurityBoundary.modelExecution, false)
  assert.equal(phase6JRollbackSecurityBoundary.ppoContinue, false)
  assert.equal(phase6JRollbackSecurityBoundary.telegramOrOpenClawRouting, false)
  assert.match(rollbackSource, /execFile/)
  assert.match(rollbackSource, /shell: false/)
  assert.doesNotMatch(rollbackSource, /gh api|workflow dispatch|codex --|openclaw gateway run|curl|wget|ssh/)
  assert.doesNotMatch(verificationSource, /development-rollback-agent|executeDevelopmentRollback|rollback-exact-sha/)
  assert.doesNotMatch(deploymentSource, /development-rollback-agent|executeDevelopmentRollback|rollback-exact-sha/)
  assert.doesNotMatch(commandSource, /development-rollback-agent|rollback_in_progress|rolled_back|\bcontinue\b/)
  assert.doesNotMatch(bridgeSource, /development-rollback-agent|rollback_in_progress|rolled_back/)
})

test("Phase 6J rollback shell primitives use fixed identities and avoid forbidden command shapes", async () => {
  const rollbackScript = await readFile(new URL("../deployment/scripts/rollback-exact-sha.sh", import.meta.url), "utf8")
  const inspectScript = await readFile(new URL("../deployment/scripts/inspect-rollback-readonly.sh", import.meta.url), "utf8")
  const legacyRollback = await readFile(new URL("../deployment/scripts/rollback-repo.sh", import.meta.url), "utf8")

  assert.match(rollbackScript, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail/m)
  assert.match(rollbackScript, /INSTALL_DIR="\/opt\/personal-project-operator"/)
  assert.match(rollbackScript, /STATE_DIR="\/var\/lib\/personal-project-operator"/)
  assert.match(rollbackScript, /SERVICE_NAME="ppo-openclaw\.service"/)
  assert.match(rollbackScript, /REMOTE_NAME="origin"/)
  assert.match(rollbackScript, /REPO_URL="https:\/\/github\.com\/Linardi1328\/personal-project-operator\.git"/)
  assert.match(rollbackScript, /git --no-optional-locks -C "\$INSTALL_DIR" -c core\.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames/)
  assert.match(rollbackScript, /git -C "\$INSTALL_DIR" switch --detach "\$ROLLBACK_SHA"/)
  assert.match(rollbackScript, /sudo -u "\$SERVICE_USER" "\$PREFLIGHT_SCRIPT"/)
  assert.match(rollbackScript, /PPO_SERVICE_CONFIRM="\$SERVICE_CONFIRMATION" "\$SERVICE_CONTROL_SCRIPT" restart/)
  assert.doesNotMatch(rollbackScript, /last-good-revision|git fetch|git pull|git reset --hard|git checkout|git branch|git update-ref|curl|wget|gh\s|ssh|scp|rsync/)
  assert.doesNotMatch(rollbackScript, /systemctl\s+(?:start|stop|restart|reload|enable|disable)\s+\$/)

  assert.match(inspectScript, /git --no-optional-locks -C "\$INSTALL_DIR" -c core\.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames/)
  assert.doesNotMatch(inspectScript, /git fetch|git pull|git switch|git checkout|git reset|systemctl\s+(?:start|stop|restart|reload|enable|disable)|curl|wget|gh\s|ssh|scp|rsync/)
  assert.match(legacyRollback, /last-good-revision/)
})
