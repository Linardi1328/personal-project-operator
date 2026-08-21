import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  PHASE_6G_DELIVERY_POLICY_HASH,
  PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  CODEX_EXECUTION_ADAPTER_ID
} from "./development-codex-execution-adapter.mjs"
import {
  DEVELOPMENT_DEPLOYMENT_AGENT_ID,
  PHASE_6H_DEPLOYMENT_POLICY_HASH,
  PHASE_6H_DEPLOYMENT_POLICY_ID,
  PHASE_6H_PPO_DEPLOYMENT_PROFILE,
  executeDevelopmentDeployment,
  phase6HDeploymentSecurityBoundary,
  reconcileDevelopmentDeployment,
  resolveApprovedDeploymentProfile
} from "./development-deployment-agent.mjs"
import {
  DevelopmentRunStateError,
  DEVELOPMENT_RUN_EVIDENCE_KINDS,
  normalizeDevelopmentRunEvidenceRecord,
  resolveDevelopmentRunProject
} from "./development-run-state.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REMOTE_PR_REVIEW_AGENT_ID,
  REVIEW_DECISIONS
} from "./development-review-agent.mjs"
import {
  AUTOMATED_TEST_RUNNER_ID
} from "./development-test-runner.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID,
  PHASE_6G_APPROVED_MERGE_METHOD
} from "./github-delivery-agent.mjs"

const RUN_ID = "A".repeat(43)
const IMPLEMENTATION_SHA = "a".repeat(40)
const MERGE_SHA = "b".repeat(40)
const OLD_SHA = "c".repeat(40)
const NEWER_SHA = "d".repeat(40)
const WRONG_SHA = "e".repeat(40)

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
    source: CODEX_EXECUTION_ADAPTER_ID,
    summary: "Implementation evidence.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      adapter: CODEX_EXECUTION_ADAPTER_ID,
      attempt: 1,
      outcome: "implementation_ready"
    }
  }
}

function testEvidence(sha = IMPLEMENTATION_SHA) {
  return {
    kind: "test",
    sha,
    source: AUTOMATED_TEST_RUNNER_ID,
    summary: "Automated tests passed.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      runner: AUTOMATED_TEST_RUNNER_ID,
      attempt: 1,
      implSha: sha,
      outcome: "passed",
      failed: 0,
      ambiguous: 0
    }
  }
}

function approvedReviewEvidence(reviewer, sha = IMPLEMENTATION_SHA) {
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
      decision: REVIEW_DECISIONS.APPROVED,
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

function makeMergedRun(overrides = {}) {
  const headSha = overrides.headSha || IMPLEMENTATION_SHA
  const evidence = emptyEvidence()

  evidence.implementation.push(implementationEvidence(headSha))
  evidence.test.push(testEvidence(headSha))
  evidence.review.push(approvedReviewEvidence(INDEPENDENT_REVIEW_AGENT_ID, headSha))
  evidence.review.push(approvedReviewEvidence(REMOTE_PR_REVIEW_AGENT_ID, headSha))
  evidence.merge.push(mergedEvidence({
    implementationSha: headSha,
    mergeCommitSha: overrides.mergeCommitSha || MERGE_SHA,
    mainSha: Object.hasOwn(overrides, "mainSha") ? overrides.mainSha : MERGE_SHA
  }))

  for (const [kind, entries] of Object.entries(overrides.evidence || {})) {
    evidence[kind] = entries
  }

  return {
    schemaVersion: 1,
    runId: RUN_ID,
    version: overrides.version ?? 9,
    stage: overrides.stage || "merge",
    status: overrides.status || "merged",
    project: overrides.project || {
      id: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      owner: "Linardi1328",
      repo: "personal-project-operator",
      fullName: PHASE_6H_PPO_DEPLOYMENT_PROFILE.repositoryFullName
    },
    task: "Deploy the Phase 6G merge commit.",
    baseSha: "0".repeat(40),
    branch: "phase/6g-acceptance-github-delivery",
    headSha,
    attempts: {
      planning: 1,
      implementation: 1,
      test: 1,
      review: 1,
      merge: 1,
      deploy: overrides.deployAttempts ?? 0,
      verification: 0
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

      if (transition.status === "deploy_in_progress") {
        nextAttempts.deploy += 1
      }

      state.transitions.push(clone(transition))
      state.run = {
        ...state.run,
        version: state.run.version + 1,
        status: transition.status,
        stage: "deploy",
        attempts: nextAttempts,
        evidence: {
          ...state.run.evidence,
          deploy: [...state.run.evidence.deploy, ...evidence]
        },
        timestamps: {
          ...state.run.timestamps,
          updatedAt: "2026-08-22T00:00:01.000Z",
          statusChangedAt: "2026-08-22T00:00:01.000Z"
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

function makeDeploymentRunner(options = {}) {
  const state = {
    checkoutSha: options.checkoutSha ?? OLD_SHA,
    repositoryFullName: options.repositoryFullName || PHASE_6H_PPO_DEPLOYMENT_PROFILE.repositoryFullName,
    remoteUrl: options.remoteUrl || PHASE_6H_PPO_DEPLOYMENT_PROFILE.approvedRemote,
    installDir: options.installDir || PHASE_6H_PPO_DEPLOYMENT_PROFILE.installDir,
    deployCalls: [],
    inspectCalls: [],
    rollbackCalls: 0,
    verificationCalls: 0
  }

  const runner = async (invocation) => {
    assert.equal(invocation.shell, false)
    assert.equal(invocation.profile.profileId, PHASE_6H_PPO_DEPLOYMENT_PROFILE.profileId)

    if (invocation.kind === "inspect-deployment") {
      state.inspectCalls.push(clone(invocation))

      return {
        ok: true,
        installDir: state.installDir,
        remoteUrl: state.remoteUrl,
        repositoryFullName: state.repositoryFullName,
        checkoutSha: state.checkoutSha
      }
    }

    if (invocation.kind === "deploy-exact-sha") {
      state.deployCalls.push(clone(invocation))
      assert.equal(invocation.expectedSha, MERGE_SHA)
      assert.equal(invocation.serviceName, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)

      if (options.mode === "ambiguous") {
        if (options.installOnAmbiguous === true) {
          state.checkoutSha = invocation.expectedSha
        }

        const error = new Error("ambiguous")
        error.ambiguous = true
        throw error
      }

      if (options.mode === "failure") {
        return {
          ok: false,
          failureClass: options.failureClass || "runtime_preflight_failed"
        }
      }

      if (options.mode === "wrong-checkout") {
        state.checkoutSha = options.checkoutAfter || OLD_SHA
      } else {
        state.checkoutSha = options.checkoutAfter || invocation.expectedSha
      }

      if (options.rollbackInvoked === true) {
        state.rollbackCalls += 1
      }

      if (options.verificationInvoked === true) {
        state.verificationCalls += 1
      }

      return {
        ok: true,
        installDir: state.installDir,
        remoteUrl: state.remoteUrl,
        repositoryFullName: state.repositoryFullName,
        serviceName: options.resultServiceName || PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
        checkoutSha: state.checkoutSha,
        preflight: options.preflight || "passed",
        serviceRestart: options.serviceRestart || "completed",
        rollbackInvoked: options.rollbackInvoked === true,
        verificationInvoked: options.verificationInvoked === true
      }
    }

    throw new Error(`unexpected deployment operation: ${invocation.kind}`)
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

function runWithDeployStarted() {
  const run = makeMergedRun({
    status: "deploy_in_progress",
    stage: "deploy",
    deployAttempts: 1
  })

  run.evidence.deploy.push({
    kind: "deploy",
    sha: MERGE_SHA,
    source: DEVELOPMENT_DEPLOYMENT_AGENT_ID,
    summary: "Deployment started.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: DEVELOPMENT_DEPLOYMENT_AGENT_ID,
      policyId: PHASE_6H_DEPLOYMENT_POLICY_ID,
      policyHash: PHASE_6H_DEPLOYMENT_POLICY_HASH,
      deploymentSha: MERGE_SHA,
      outcome: "deploy_started",
      attempt: 1,
      previousInstalledSha: OLD_SHA,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName
    }
  })

  return run
}

test("merged run with valid Phase 6G evidence reserves deploy_in_progress before ambiguous outcome", async () => {
  const fixture = makeStateAdapter(makeMergedRun())
  const runner = makeDeploymentRunner({ mode: "ambiguous" })

  await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  }), "DEPLOYMENT_AMBIGUOUS")

  assert.equal(fixture.state.run.status, "deploy_in_progress")
  assert.equal(fixture.state.run.attempts.deploy, 1)
  assert.equal(fixture.state.transitions.at(0).status, "deploy_in_progress")
  assert.equal(fixture.state.run.evidence.deploy.at(-1).metadata.outcome, "deploy_started")
  assert.equal(fixture.state.run.evidence.deploy.at(-1).metadata.deploymentSha, MERGE_SHA)
  assert.equal(runner.state.deployCalls.length, 1)
})

test("Phase 6H does not expand the shared development project registry", () => {
  assert.throws(() => resolveDevelopmentRunProject(PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId), (error) => {
    assert.equal(error.code, "UNKNOWN_PROJECT")
    return true
  })
})

test("non-merged run is rejected without deployment mutation", async () => {
  const fixture = makeStateAdapter(makeMergedRun({ status: "merge_ready" }))
  const runner = makeDeploymentRunner()

  await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  }), "DEPLOYMENT_RUN_NOT_MERGED")

  assert.equal(fixture.state.run.status, "merge_ready")
  assert.equal(runner.state.deployCalls.length, 0)
})

test("stale expectedVersion is rejected", async () => {
  const fixture = makeStateAdapter(makeMergedRun({ version: 12 }))
  const runner = makeDeploymentRunner()

  await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: 11
  }), "STALE_RUN_VERSION")

  assert.equal(fixture.state.run.status, "merged")
  assert.equal(runner.state.deployCalls.length, 0)
})

test("missing Phase 6G merged evidence is rejected", async () => {
  const fixture = makeStateAdapter(makeMergedRun({ evidence: { merge: [] } }))
  const runner = makeDeploymentRunner()

  await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  }), "DEPLOYMENT_MERGED_EVIDENCE_INVALID")

  assert.equal(runner.state.deployCalls.length, 0)
})

test("wrong merge SHA or unproven main SHA is rejected", async () => {
  const fixture = makeStateAdapter(makeMergedRun({ mergeCommitSha: WRONG_SHA, mainSha: MERGE_SHA }))
  const runner = makeDeploymentRunner()

  await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  }), "DEPLOYMENT_MERGED_EVIDENCE_INVALID")

  assert.equal(runner.state.deployCalls.length, 0)
})

test("caller-supplied deployment target is refused", async () => {
  const fixture = makeStateAdapter(makeMergedRun())
  const runner = makeDeploymentRunner()

  await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version,
    expectedDeploymentSha: WRONG_SHA
  }), "DEPLOYMENT_TARGET_FROM_CALLER_REFUSED")

  assert.equal(runner.state.deployCalls.length, 0)
})

test("arbitrary repository identity, install path, service, and executable are rejected", async () => {
  {
    const fixture = makeStateAdapter(makeMergedRun())
    const runner = makeDeploymentRunner({ remoteUrl: "https://github.com/example/other.git" })

    await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
      ...fixture.api,
      deploymentRunner: runner,
      expectedVersion: fixture.state.run.version
    }), "DEPLOYMENT_REPOSITORY_IDENTITY_INVALID")

    assert.equal(runner.state.deployCalls.length, 0)
  }

  {
    const fixture = makeStateAdapter(makeMergedRun())
    const runner = makeDeploymentRunner({ installDir: "/tmp/personal-project-operator" })

    await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
      ...fixture.api,
      deploymentRunner: runner,
      expectedVersion: fixture.state.run.version
    }), "DEPLOYMENT_INSTALL_PATH_REFUSED")

    assert.equal(runner.state.deployCalls.length, 0)
  }

  assert.throws(() => resolveApprovedDeploymentProfile({
    ...PHASE_6H_PPO_DEPLOYMENT_PROFILE,
    serviceName: "other.service"
  }), /Deployment profile is not the approved/)

  assert.throws(() => resolveApprovedDeploymentProfile({
    ...PHASE_6H_PPO_DEPLOYMENT_PROFILE,
    gitExecutable: "/tmp/git"
  }), /Deployment profile is not the approved/)
})

test("deployed checkout must equal the exact Phase 6G merge SHA", async () => {
  const fixture = makeStateAdapter(makeMergedRun())
  const runner = makeDeploymentRunner({ mode: "wrong-checkout", checkoutAfter: OLD_SHA })

  const result = await executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "deploy_failed")
  assert.equal(fixture.state.run.status, "deploy_failed")
  assert.equal(fixture.state.run.evidence.deploy.at(-1).metadata.failureClass, "checkout_sha_mismatch")
})

test("newer main SHA does not replace the approved deployment target", async () => {
  const fixture = makeStateAdapter(makeMergedRun())
  const runner = makeDeploymentRunner({ checkoutSha: NEWER_SHA })

  const result = await executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  })

  assert.equal(result.ok, true)
  assert.equal(runner.state.deployCalls.at(0).expectedSha, MERGE_SHA)
  assert.equal(result.deployment.previousInstalledSha, NEWER_SHA)
  assert.equal(result.deployment.checkoutSha, MERGE_SHA)
})

test("successful exact-SHA deployment transitions to deployed with metadata-only evidence", async () => {
  const fixture = makeStateAdapter(makeMergedRun())
  const runner = makeDeploymentRunner()

  const result = await executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  })

  const evidence = fixture.state.run.evidence.deploy.at(-1)
  const serializedEvidence = JSON.stringify(fixture.state.run.evidence.deploy)

  assert.equal(result.ok, true)
  assert.equal(result.outcome, "deployed")
  assert.equal(fixture.state.run.status, "deployed")
  assert.equal(evidence.metadata.outcome, "deployed")
  assert.equal(evidence.metadata.deploymentSha, MERGE_SHA)
  assert.equal(evidence.metadata.checkoutSha, MERGE_SHA)
  assert.equal(evidence.metadata.service, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)
  assert.equal(evidence.metadata.preflight, "passed")
  assert.equal(evidence.metadata.restart, "completed")
  assert.equal(runner.state.deployCalls.length, 1)
  assert.equal(runner.state.rollbackCalls, 0)
  assert.equal(runner.state.verificationCalls, 0)
  assert.doesNotMatch(serializedEvidence, /token|secret|credential|authorization|stdout|stderr|raw/i)
  assert.doesNotMatch(serializedEvidence, /\/opt\/personal-project-operator|\/var\/lib\/personal-project-operator/)
})

test("definitive deployment failure transitions to deploy_failed without rollback", async () => {
  const fixture = makeStateAdapter(makeMergedRun())
  const runner = makeDeploymentRunner({ mode: "failure", failureClass: "runtime_preflight_failed" })

  const result = await executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, "deploy_failed")
  assert.equal(fixture.state.run.status, "deploy_failed")
  assert.equal(fixture.state.run.evidence.deploy.at(-1).metadata.failureClass, "runtime_preflight_failed")
  assert.equal(runner.state.rollbackCalls, 0)
})

test("ambiguous deployment remains unreconciled and is not blindly retried", async () => {
  const fixture = makeStateAdapter(makeMergedRun())
  const runner = makeDeploymentRunner({ mode: "ambiguous", installOnAmbiguous: true })

  await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  }), "DEPLOYMENT_AMBIGUOUS")

  assert.equal(fixture.state.run.status, "deploy_in_progress")
  assert.equal(runner.state.deployCalls.length, 1)

  await assertRejectsCode(executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  }), "DEPLOYMENT_RUN_NOT_MERGED")

  const beforeTransitions = fixture.state.transitions.length
  const reconciled = await reconcileDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner
  })

  assert.equal(runner.state.deployCalls.length, 1)
  assert.equal(fixture.state.transitions.length, beforeTransitions)
  assert.equal(reconciled.deployment.currentCheckoutSha, MERGE_SHA)
  assert.equal(reconciled.deployment.targetInstalled, true)
  assert.equal(reconciled.deployment.completionProven, false)
  assert.equal(reconciled.deployment.ownerActionRequired, true)
})

test("reconciliation is read-only and older installed SHA does not count as success", async () => {
  const fixture = makeStateAdapter(runWithDeployStarted())
  const runner = makeDeploymentRunner({ checkoutSha: OLD_SHA })

  const beforeTransitions = fixture.state.transitions.length
  const reconciled = await reconcileDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner
  })

  assert.equal(runner.state.deployCalls.length, 0)
  assert.equal(fixture.state.transitions.length, beforeTransitions)
  assert.equal(reconciled.deployment.currentCheckoutSha, OLD_SHA)
  assert.equal(reconciled.deployment.targetInstalled, false)
  assert.equal(reconciled.deployment.completionProven, false)
  assert.equal(reconciled.deployment.ownerActionRequired, true)
})

test("service restart is restricted to the fixed PPO service", async () => {
  const fixture = makeStateAdapter(makeMergedRun())
  const runner = makeDeploymentRunner()

  await executeDevelopmentDeployment(RUN_ID, {
    ...fixture.api,
    deploymentRunner: runner,
    expectedVersion: fixture.state.run.version
  })

  assert.equal(runner.state.deployCalls.at(0).serviceName, PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName)
})

test("Phase 6H scope excludes rollback, production verification, routes, and continue command", async () => {
  const deploymentSource = await readFile(new URL("./development-deployment-agent.mjs", import.meta.url), "utf8")
  const commandSource = await readFile(new URL("./ppo-command.mjs", import.meta.url), "utf8")
  const bridgeSource = await readFile(new URL("../openclaw/plugins/ppo-local/test-bridge.mjs", import.meta.url), "utf8")
  const scriptSource = await readFile(new URL("../deployment/scripts/deploy-exact-sha.sh", import.meta.url), "utf8")

  assert.equal(phase6HDeploymentSecurityBoundary.stopsAt, "deployed")
  assert.equal(phase6HDeploymentSecurityBoundary.rollback, false)
  assert.equal(phase6HDeploymentSecurityBoundary.productionVerification, false)
  assert.equal(phase6HDeploymentSecurityBoundary.ppoContinue, false)
  assert.equal(phase6HDeploymentSecurityBoundary.telegramOrOpenClawRouting, false)
  assert.doesNotMatch(deploymentSource, /rollback-repo|vps-health|git pull|gh api|workflow dispatch|labels|comments/)
  assert.doesNotMatch(scriptSource, /\beval\b|git pull|rollback-repo|vps-health|gh api|git push|workflow dispatch/)
  assert.doesNotMatch(commandSource, /\bcontinue\b/)
  assert.doesNotMatch(bridgeSource, /development-deployment-agent|deploy_in_progress|deployed/)
})
