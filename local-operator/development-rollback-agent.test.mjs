import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
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
  PHASE_6J_ROLLBACK_COORDINATED_INSPECTION_ID,
  PHASE_6J_ROLLBACK_MANUAL_INSPECTION_SCRIPT,
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
const FIXED_INSTALL_DIR = "/opt/personal-project-operator"
const FIXED_STATE_DIR = "/var/lib/personal-project-operator"
const FIXED_CONFIG_DIR = "/etc/personal-project-operator"
const FIXED_REPOSITORY_URL = "https://github.com/Linardi1328/personal-project-operator.git"
const FIXED_SERVICE_NAME = "ppo-openclaw.service"
const FIXED_NODE_BIN = "/home/ppo/.local/openclaw/tools/node/bin/node"
const FIXED_OPENCLAW_BIN = "/home/ppo/.local/openclaw/bin/openclaw"

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

function rollbackFailedEvidence({
  attempt = 1,
  deploymentSha = DEPLOYMENT_SHA,
  rollbackSha = ROLLBACK_SHA,
  policyId = PHASE_6J_ROLLBACK_POLICY_ID,
  policyHash = PHASE_6J_ROLLBACK_POLICY_HASH,
  failureClass = "dirty_checkout"
} = {}) {
  return {
    kind: "rollback",
    sha: rollbackSha,
    source: DEVELOPMENT_ROLLBACK_AGENT_ID,
    summary: "Phase 6J exact previous-SHA rollback failed definitively.",
    metadata: {
      project: PHASE_6H_PPO_DEPLOYMENT_PROFILE.projectId,
      agent: DEVELOPMENT_ROLLBACK_AGENT_ID,
      policyId,
      policyHash,
      deploymentSha,
      rollbackSha,
      outcome: "rollback_failed",
      attempt,
      failureClass,
      observedCheckoutSha: deploymentSha,
      service: PHASE_6H_PPO_DEPLOYMENT_PROFILE.serviceName,
      contract: rollbackContract({
        ok: false,
        observedCheckoutSha: deploymentSha,
        checkoutSwitch: "not_run",
        serviceRestart: "not_run",
        postrollbackCheckout: "failed"
      })
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

function makeRollbackFailedRun(evidenceOverrides = {}) {
  const run = makeVerificationFailedRun({
    status: "rollback_failed",
    stage: "rollback",
    rollbackAttempts: evidenceOverrides.rollbackAttempts || 1
  })

  run.evidence.rollback.push(rollbackStartedEvidence({ attempt: evidenceOverrides.startedAttempt || 1 }))
  run.evidence.rollback.push(rollbackFailedEvidence(evidenceOverrides))
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

      if (options.inspectAmbiguousMode) {
        const error = new Error("ambiguous rollback inspection")

        if (options.inspectAmbiguousMode === "timeout") {
          error.timedOut = true
        } else if (options.inspectAmbiguousMode === "signal") {
          error.signal = "SIGTERM"
        } else if (options.inspectAmbiguousMode === "overflow") {
          error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        } else {
          error.ambiguous = true
        }

        throw error
      }

      if (Object.hasOwn(options, "inspectRawResult")) {
        return options.inspectRawResult
      }

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

function makeReadOnlyInspectionCommandRunner(options = {}) {
  const inspection = rollbackInspectionResult(options.inspectResult || {})
  const state = {
    calls: []
  }
  const goodStats = new Map([
    [FIXED_INSTALL_DIR, "root ppo 755 directory\n"],
    [`${FIXED_INSTALL_DIR}/local-operator`, "root ppo 755 directory\n"],
    [`${FIXED_INSTALL_DIR}/README.md`, "root ppo 644 regular file\n"],
    [`${FIXED_INSTALL_DIR}/local-operator/tool.mjs`, "root ppo 755 regular file\n"],
    [FIXED_CONFIG_DIR, "root root 750 directory\n"],
    [FIXED_NODE_BIN, "ppo ppo 755 regular file\n"],
    [FIXED_OPENCLAW_BIN, "ppo ppo 755 regular file\n"]
  ])

  const commandResult = (exitCode, stdout = "") => ({ exitCode, stdout })
  const commandText = (invocation) => [invocation.executablePath, ...invocation.args].join("\0")

  const runner = async (invocation) => {
    assert.equal(invocation.shell, false)
    assert.deepEqual(invocation.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })
    assert.equal(invocation.cwd, "/")
    assert.equal(invocation.timeoutMs, 180000)
    assert.equal(invocation.maxOutputBytes, 32768)
    assert.doesNotMatch(invocation.executablePath, /\/opt\/personal-project-operator\/deployment\/scripts\//)

    const serialized = commandText(invocation)
    assert.doesNotMatch(serialized, /rollback-exact-sha\.sh|inspect-rollback-readonly\.sh|preflight-openclaw-runtime\.sh|service-control\.sh/)
    state.calls.push(clone(invocation))

    if (options.ambiguousMode) {
      const error = new Error("ambiguous read-only inspection")

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

    if (options.malformedCommandResult) {
      return { stdout: "malformed" }
    }

    const { executablePath, args } = invocation
    const argsText = args.join(" ")

    if (executablePath === "/usr/bin/git" && argsText === `-C ${FIXED_INSTALL_DIR} remote get-url origin`) {
      return commandResult(0, inspection.repository === "passed" ? `${FIXED_REPOSITORY_URL}\n` : "https://github.com/example/other.git\n")
    }

    if (executablePath === "/usr/bin/git" && argsText === `-C ${FIXED_INSTALL_DIR} rev-parse --verify HEAD`) {
      return inspection.observedCheckoutSha
        ? commandResult(0, `${inspection.observedCheckoutSha}\n`)
        : commandResult(1, "")
    }

    if (executablePath === "/usr/bin/git" && argsText === `-C ${FIXED_INSTALL_DIR} symbolic-ref -q HEAD`) {
      return commandResult(inspection.detached === "passed" ? 1 : 0, inspection.detached === "passed" ? "" : "refs/heads/main\n")
    }

    if (
      executablePath === "/usr/bin/git" &&
      argsText === `--no-optional-locks -C ${FIXED_INSTALL_DIR} -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames`
    ) {
      return commandResult(0, inspection.clean === "passed" ? "" : " M README.md\n")
    }

    if (executablePath === "/usr/bin/cat" && args[0] === `${FIXED_STATE_DIR}/last-deploy-previous-revision`) {
      return commandResult(0, inspection.previousRevision === "passed" ? `${ROLLBACK_SHA}\n` : `${WRONG_SHA}\n`)
    }

    if (executablePath === "/usr/bin/git" && argsText === `-C ${FIXED_INSTALL_DIR} rev-parse --verify --quiet ${ROLLBACK_SHA}^{commit}`) {
      return commandResult(inspection.rollbackCommit === "passed" ? 0 : 1, "")
    }

    if (executablePath === "/usr/bin/find" && argsText === `${FIXED_INSTALL_DIR} -type d -print0`) {
      return commandResult(0, `${FIXED_INSTALL_DIR}\0${FIXED_INSTALL_DIR}/local-operator\0`)
    }

    if (executablePath === "/usr/bin/find" && argsText === `${FIXED_INSTALL_DIR} -type f -print0`) {
      return commandResult(0, `${FIXED_INSTALL_DIR}/README.md\0${FIXED_INSTALL_DIR}/local-operator/tool.mjs\0`)
    }

    if (executablePath === "/usr/bin/stat") {
      const targetPath = args.at(-1)

      if (inspection.permissionContract !== "passed" && targetPath === `${FIXED_INSTALL_DIR}/README.md`) {
        return commandResult(0, "root ppo 600 regular file\n")
      }

      if (inspection.runtimePreflight !== "passed" && targetPath === FIXED_NODE_BIN) {
        return commandResult(0, "ppo ppo 644 regular file\n")
      }

      return commandResult(goodStats.has(targetPath) ? 0 : 1, goodStats.get(targetPath) || "")
    }

    if (executablePath === "/usr/bin/git" && argsText === `-C ${FIXED_INSTALL_DIR} ls-files -s -- README.md`) {
      return commandResult(0, "100644 0000000000000000000000000000000000000000 0\tREADME.md\n")
    }

    if (executablePath === "/usr/bin/git" && argsText === `-C ${FIXED_INSTALL_DIR} ls-files -s -- local-operator/tool.mjs`) {
      return commandResult(0, "100755 0000000000000000000000000000000000000000 0\tlocal-operator/tool.mjs\n")
    }

    if (executablePath === "/usr/bin/sudo" && argsText === `-u ppo ${FIXED_NODE_BIN} --version`) {
      return commandResult(inspection.runtimePreflight === "passed" ? 0 : 1, inspection.runtimePreflight === "passed" ? "v24.15.0\n" : "")
    }

    if (executablePath === "/usr/bin/sudo" && argsText === `-u ppo ${FIXED_OPENCLAW_BIN} --version`) {
      return commandResult(inspection.runtimePreflight === "passed" ? 0 : 1, inspection.runtimePreflight === "passed" ? "openclaw 2026.5.17\n" : "")
    }

    if (executablePath === "/usr/bin/systemctl" && argsText === `is-enabled --quiet ${FIXED_SERVICE_NAME}`) {
      return commandResult(inspection.serviceEnabled === true ? 0 : 1, "")
    }

    if (executablePath === "/usr/bin/systemctl" && argsText === `is-active --quiet ${FIXED_SERVICE_NAME}`) {
      return commandResult(inspection.serviceActive === true ? 0 : 1, "")
    }

    if (executablePath === "/usr/bin/systemctl" && argsText === `show ${FIXED_SERVICE_NAME} --property=SubState --value`) {
      return commandResult(0, inspection.serviceRunning === true ? "running\n" : "dead\n")
    }

    if (executablePath === "/usr/bin/systemctl" && argsText === `show ${FIXED_SERVICE_NAME} --property=MainPID --value`) {
      return commandResult(0, inspection.serviceMainPidNonZero === true ? "1234\n" : "0\n")
    }

    throw new Error(`unexpected read-only inspection command: ${serialized}`)
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

function notStartedInspection(overrides = {}) {
  return {
    ok: false,
    failureClass: "rollback_not_started",
    observedCheckoutSha: DEPLOYMENT_SHA,
    currentCheckout: "passed",
    checkoutSwitch: "not_applicable",
    serviceRestart: "not_applicable",
    postrollbackCheckout: "failed",
    rollbackInvoked: false,
    ...overrides
  }
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

test("only verification_failed and safe rollback_failed runs are accepted for Phase 6J rollback", async () => {
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
    "rollback_in_progress",
    "rolled_back",
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

test("rollback_failed retry is explicit and allowed only after read-only not-started reconciliation", async () => {
  const fixture = makeStateAdapter(makeRollbackFailedRun())
  const runner = makeRollbackRunner()
  const inspectionRunner = makeReadOnlyInspectionCommandRunner({ inspectResult: notStartedInspection() })
  const response = await executeWithFixture(fixture, runner, {
    readOnlyInspectionCommandRunner: inspectionRunner
  })

  assert.equal(response.ok, true)
  assert.equal(response.outcome, "rolled_back")
  assert.equal(fixture.state.run.status, "rolled_back")
  assert.equal(fixture.state.transitions.at(0).status, "rollback_in_progress")
  assert.equal(fixture.state.transitions.at(1).status, "rolled_back")
  assert.equal(fixture.state.run.attempts.rollback, 2)
  assert.equal(fixture.state.run.evidence.rollback.at(-2).metadata.outcome, "rollback_started")
  assert.equal(fixture.state.run.evidence.rollback.at(-2).metadata.attempt, 2)
  assert.equal(inspectionRunner.state.calls.length > 0, true)
  assert.equal(runner.state.inspectCalls.length, 0)
  assert.equal(runner.state.executeCalls.length, 1)
})

test("rollback_failed retry still requires fresh owner confirmation and exact expectedVersion", async () => {
  for (const [name, options, expectedCode] of [
    ["missing owner confirmation", { ownerConfirmation: undefined }, "ROLLBACK_OWNER_CONFIRMATION_REQUIRED"],
    ["mismatched owner confirmation", { ownerConfirmation: "wrong-confirmation" }, "ROLLBACK_OWNER_CONFIRMATION_REQUIRED"],
    ["stale expectedVersion", { expectedVersion: 15 }, "STALE_RUN_VERSION"]
  ]) {
    const fixture = makeStateAdapter(makeRollbackFailedRun({ rollbackAttempts: 1 }))
    const runner = makeRollbackRunner()
    const inspectionRunner = makeReadOnlyInspectionCommandRunner({ inspectResult: notStartedInspection() })

    await assertRejectsCode(executeDevelopmentRollback(RUN_ID, {
      ...fixture.api,
      rollbackRunner: runner,
      readOnlyInspectionCommandRunner: inspectionRunner,
      expectedVersion: fixture.state.run.version,
      ownerConfirmation: PHASE_6J_OWNER_ROLLBACK_CONFIRMATION,
      ...options
    }), expectedCode)

    assert.equal(fixture.state.run.status, "rollback_failed", name)
    assert.equal(fixture.state.transitions.length, 0, name)
    assert.equal(inspectionRunner.state.calls.length, 0, name)
    assert.equal(runner.state.executeCalls.length, 0, name)
  }
})

test("rollback_failed retry refuses applied third-SHA dirty ambiguous or unsafe-service states", async () => {
  for (const [name, inspectionOptions, expectedCode] of [
    ["already applied rollback", {}, "ROLLBACK_RETRY_RECONCILIATION_REQUIRED"],
    ["third SHA", { inspectResult: { observedCheckoutSha: WRONG_SHA, currentCheckout: "failed", failureClass: "rollback_incomplete" } }, "ROLLBACK_RETRY_RECONCILIATION_REQUIRED"],
    ["dirty checkout", { inspectResult: { ...notStartedInspection({ clean: "failed", failureClass: "dirty_checkout" }) } }, "ROLLBACK_RETRY_RECONCILIATION_REQUIRED"],
    ["unsafe inactive service", { inspectResult: { ...notStartedInspection({ serviceActive: false, failureClass: "service_not_running" }) } }, "ROLLBACK_RETRY_RECONCILIATION_REQUIRED"],
    ["ambiguous inspection", { ambiguousMode: "timeout" }, "ROLLBACK_AMBIGUOUS"],
    ["malformed inspection output", { malformedCommandResult: true }, "ROLLBACK_AMBIGUOUS"]
  ]) {
    const fixture = makeStateAdapter(makeRollbackFailedRun())
    const runner = makeRollbackRunner()
    const inspectionRunner = makeReadOnlyInspectionCommandRunner(inspectionOptions)

    await assertRejectsCode(executeWithFixture(fixture, runner, {
      readOnlyInspectionCommandRunner: inspectionRunner
    }), expectedCode)

    assert.equal(fixture.state.run.status, "rollback_failed", name)
    assert.equal(fixture.state.transitions.length, 0, name)
    assert.equal(inspectionRunner.state.calls.length > 0, true, name)
    assert.equal(runner.state.inspectCalls.length, 0, name)
    assert.equal(runner.state.executeCalls.length, 0, name)
  }
})

test("rollback_failed retry requires current Phase 6J policy evidence for the same exact SHAs", async () => {
  for (const [name, overrides] of [
    ["wrong policy id", { policyId: "phase-6j-stale-policy" }],
    ["wrong policy hash", { policyHash: "0".repeat(64) }],
    ["mismatched deployment SHA", { deploymentSha: WRONG_SHA }],
    ["mismatched rollback SHA", { rollbackSha: WRONG_SHA }],
    ["mismatched attempt", { startedAttempt: 2, attempt: 1 }]
  ]) {
    const fixture = makeStateAdapter(makeRollbackFailedRun(overrides))
    const runner = makeRollbackRunner()
    const inspectionRunner = makeReadOnlyInspectionCommandRunner({ inspectResult: notStartedInspection() })

    await assertRejectsCode(executeWithFixture(fixture, runner, {
      readOnlyInspectionCommandRunner: inspectionRunner
    }), "ROLLBACK_RETRY_EVIDENCE_INVALID")

    assert.equal(fixture.state.transitions.length, 0, name)
    assert.equal(inspectionRunner.state.calls.length, 0, name)
    assert.equal(runner.state.executeCalls.length, 0, name)
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
    const inspectionRunner = makeReadOnlyInspectionCommandRunner({ inspectResult })
    const beforeTransitions = fixture.state.transitions.length
    const reconciled = await reconcileDevelopmentRollback(RUN_ID, {
      ...fixture.api,
      readOnlyInspectionCommandRunner: inspectionRunner
    })

    assert.equal(fixture.state.transitions.length, beforeTransitions, name)
    assert.equal(inspectionRunner.state.calls.length > 0, true, name)
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
    const inspectionRunner = makeReadOnlyInspectionCommandRunner({ inspectResult })
    const beforeTransitions = fixture.state.transitions.length
    const reconciled = await reconcileDevelopmentRollback(RUN_ID, {
      ...fixture.api,
      readOnlyInspectionCommandRunner: inspectionRunner
    })

    assert.equal(fixture.state.transitions.length, beforeTransitions, name)
    assert.equal(inspectionRunner.state.calls.length > 0, true, name)
    assert.equal(reconciled.rollback.rollbackEvidenceComplete, expectedComplete, name)
    assert.equal(reconciled.rollback.completionProven, expectedComplete, name)
  }
})

function assertReadOnlyInspectionCommandsOnly(inspectionRunner, name = "read-only inspection") {
  assert.equal(inspectionRunner.state.calls.length > 0, true, name)

  for (const call of inspectionRunner.state.calls) {
    const serialized = [call.executablePath, ...call.args].join(" ")

    assert.doesNotMatch(serialized, /\/opt\/personal-project-operator\/deployment\/scripts\//, name)
    assert.doesNotMatch(serialized, /\b(?:fetch|pull|switch|checkout|reset|branch|update-ref|clean|chmod|chown|restart|start|stop|reload|enable|disable|curl|wget|gh|ssh)\b/u, name)

    if (call.executablePath === "/usr/bin/sudo") {
      assert.match(serialized, /\/usr\/bin\/sudo -u ppo \/home\/ppo\/\.local\/openclaw\/(?:tools\/node\/bin\/node|bin\/openclaw) --version/u, name)
    }
  }
}

test("rollback reconciliation uses embedded inspection when rollback target lacks or tampers with inspection scripts", async () => {
  const fixture = makeStateAdapter(makeRolledBackRun())
  const inspectionRunner = makeReadOnlyInspectionCommandRunner()
  const beforeTransitions = fixture.state.transitions.length
  const reconciled = await reconcileDevelopmentRollback(RUN_ID, {
    ...fixture.api,
    readOnlyInspectionCommandRunner: inspectionRunner
  })

  assert.equal(PHASE_6J_ROLLBACK_COORDINATED_INSPECTION_ID, "phase-6j-agent-embedded-readonly-production-inspection")
  assert.equal(PHASE_6J_ROLLBACK_MANUAL_INSPECTION_SCRIPT, `${FIXED_INSTALL_DIR}/deployment/scripts/inspect-rollback-readonly.sh`)
  assert.equal(fixture.state.transitions.length, beforeTransitions)
  assert.equal(reconciled.rollback.completionProven, true)
  assert.equal(reconciled.rollback.rollbackEvidenceComplete, true)
  assertReadOnlyInspectionCommandsOnly(inspectionRunner, "embedded rollback inspection")
})

test("rollback_failed retry safety reconciliation uses the embedded inspection path before mutation", async () => {
  const fixture = makeStateAdapter(makeRollbackFailedRun())
  const runner = makeRollbackRunner()
  const inspectionRunner = makeReadOnlyInspectionCommandRunner({ inspectResult: notStartedInspection() })
  const response = await executeWithFixture(fixture, runner, {
    readOnlyInspectionCommandRunner: inspectionRunner
  })

  assert.equal(response.outcome, "rolled_back")
  assert.equal(runner.state.inspectCalls.length, 0)
  assert.equal(runner.state.executeCalls.length, 1)
  assertReadOnlyInspectionCommandsOnly(inspectionRunner, "embedded retry inspection")
})

test("ambiguous rollback reconciliation remains possible after checkout moved to rollbackSha without completion evidence", async () => {
  const run = makeVerificationFailedRun({ status: "rollback_in_progress", stage: "rollback", rollbackAttempts: 1 })
  run.evidence.rollback.push(rollbackStartedEvidence())

  const fixture = makeStateAdapter(run)
  const inspectionRunner = makeReadOnlyInspectionCommandRunner()
  const reconciled = await reconcileDevelopmentRollback(RUN_ID, {
    ...fixture.api,
    readOnlyInspectionCommandRunner: inspectionRunner
  })

  assert.equal(reconciled.rollback.rollbackAppearsApplied, true)
  assert.equal(reconciled.rollback.completionProven, false)
  assert.equal(reconciled.rollback.rollbackEvidenceComplete, false)
  assert.equal(reconciled.rollback.ownerActionRequired, true)
  assert.equal(fixture.state.transitions.length, 0)
  assertReadOnlyInspectionCommandsOnly(inspectionRunner, "ambiguous applied inspection")
})

test("embedded rollback reconciliation fails closed for unsafe current production observations", async () => {
  for (const [name, options] of [
    ["third SHA", { inspectResult: { observedCheckoutSha: WRONG_SHA, postrollbackCheckout: "failed", failureClass: "rollback_incomplete" } }],
    ["dirty checkout", { inspectResult: { clean: "failed", failureClass: "dirty_checkout" } }],
    ["inactive service", { inspectResult: { serviceActive: false, failureClass: "service_not_running" } }],
    ["runtime failure", { inspectResult: { runtimePreflight: "failed", failureClass: "runtime_preflight_failed" } }],
    ["permission failure", { inspectResult: { permissionContract: "failed", failureClass: "permission_contract_failed" } }],
    ["malformed command result", { malformedCommandResult: true }]
  ]) {
    const fixture = makeStateAdapter(makeRolledBackRun())
    const inspectionRunner = makeReadOnlyInspectionCommandRunner(options)
    const reconciled = await reconcileDevelopmentRollback(RUN_ID, {
      ...fixture.api,
      readOnlyInspectionCommandRunner: inspectionRunner
    })

    assert.equal(reconciled.rollback.completionProven, false, name)
    assert.equal(reconciled.rollback.rollbackEvidenceComplete, false, name)
    assert.equal(reconciled.rollback.ownerActionRequired, true, name)
    assert.equal(fixture.state.transitions.length, 0, name)

    if (!options.malformedCommandResult) {
      assertReadOnlyInspectionCommandsOnly(inspectionRunner, name)
    }
  }
})

function runInspectPermissionHelper(command) {
  const scriptPath = fileURLToPath(new URL("../deployment/scripts/inspect-rollback-readonly.sh", import.meta.url))

  return spawnSync("bash", ["-c", `source "$1"; ${command}`, "bash", scriptPath], {
    encoding: "utf8"
  })
}

function assertPermissionHelperPass(command, name) {
  const result = runInspectPermissionHelper(command)

  assert.equal(result.status, 0, `${name}: ${result.stderr}`)
}

function assertPermissionHelperFail(command, name) {
  const result = runInspectPermissionHelper(command)

  assert.notEqual(result.status, 0, name)
}

test("rollback read-only permission contract classifies recursive runtime checkout ownership modes and executable bits", () => {
  assertPermissionHelperPass(`
    [[ "$(tracked_file_expected_mode 100644)" == "644" ]] &&
    [[ "$(tracked_file_expected_mode 100755)" == "755" ]] &&
    permission_entry_matches root ppo 755 755 &&
    permission_entry_matches root ppo 644 "$(tracked_file_expected_mode 100644)" &&
    permission_entry_matches root ppo 755 "$(tracked_file_expected_mode 100755)"
  `, "exact recursive permission contract")

  assertPermissionHelperFail("permission_entry_matches ppo ppo 644 644", "wrong tracked-file ownership fails")
  assertPermissionHelperFail("permission_entry_matches root root 644 644", "wrong tracked-file group fails")
  assertPermissionHelperFail("permission_entry_matches root ppo 600 \"$(tracked_file_expected_mode 100644)\"", "wrong regular-file mode fails")
  assertPermissionHelperFail("permission_entry_matches root ppo 644 \"$(tracked_file_expected_mode 100755)\"", "missing executable mode on tracked executable fails")
  assertPermissionHelperFail("permission_entry_matches root ppo 755 \"$(tracked_file_expected_mode 100644)\"", "unexpected executable mode on tracked regular file fails")
  assertPermissionHelperFail("permission_entry_matches root ppo 750 755", "directory mode drift fails")
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
  assert.match(rollbackSource, /PHASE_6J_ROLLBACK_COORDINATED_INSPECTION_ID/)
  assert.match(rollbackSource, /PHASE_6J_ROLLBACK_MANUAL_INSPECTION_SCRIPT/)
  assert.match(rollbackSource, /return await inspectProductionRollbackReadOnly\(invocation, options\)/)
  assert.match(rollbackSource, /git: "\/usr\/bin\/git"/)
  assert.match(rollbackSource, /systemctl: "\/usr\/bin\/systemctl"/)
  assert.match(rollbackSource, /stat: "\/usr\/bin\/stat"/)
  assert.match(rollbackSource, /"--no-optional-locks"/)
  assert.doesNotMatch(rollbackSource, /PHASE_6J_ROLLBACK_INSPECTION_SCRIPT/)
  assert.doesNotMatch(rollbackSource, /runTrustedProcess\(PHASE_6J_ROLLBACK_MANUAL_INSPECTION_SCRIPT/)
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
  assert.match(rollbackScript, /CONFIG_DIR="\/etc\/personal-project-operator"/)
  assert.match(rollbackScript, /NODE_BIN="\$\{OPENCLAW_PREFIX\}\/tools\/node\/bin\/node"/)
  assert.match(rollbackScript, /OPENCLAW_BIN="\$\{OPENCLAW_PREFIX\}\/bin\/openclaw"/)
  assert.match(rollbackScript, /SERVICE_NAME="ppo-openclaw\.service"/)
  assert.match(rollbackScript, /SYSTEMCTL_BIN="\/usr\/bin\/systemctl"/)
  assert.match(rollbackScript, /REMOTE_NAME="origin"/)
  assert.match(rollbackScript, /REPO_URL="https:\/\/github\.com\/Linardi1328\/personal-project-operator\.git"/)
  assert.match(rollbackScript, /git --no-optional-locks -C "\$INSTALL_DIR" -c core\.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames/)
  assert.match(rollbackScript, /git -C "\$INSTALL_DIR" switch --detach "\$ROLLBACK_SHA"/)
  assert.match(rollbackScript, /sudo -u "\$SERVICE_USER" "\$NODE_BIN" --version/)
  assert.match(rollbackScript, /sudo -u "\$SERVICE_USER" "\$OPENCLAW_BIN" --version/)
  assert.match(rollbackScript, /"\$SYSTEMCTL_BIN" restart "\$SERVICE_NAME"/)
  assert.deepEqual(
    rollbackScript.split("\n").filter((line) => line.includes('"$SYSTEMCTL_BIN" restart')).map((line) => line.trim()),
    ['"$SYSTEMCTL_BIN" restart "$SERVICE_NAME" >/dev/null 2>&1 ||']
  )
  assert.doesNotMatch(rollbackScript, /PREFLIGHT_SCRIPT|SERVICE_CONTROL_SCRIPT|preflight-openclaw-runtime\.sh|service-control\.sh/)
  assert.doesNotMatch(rollbackScript, /last-good-revision|git fetch|git pull|git reset --hard|git checkout|git branch|git update-ref|curl|wget|gh\s|ssh|scp|rsync/)
  assert.doesNotMatch(rollbackScript, /systemctl\s+(?:start|stop|restart|reload|enable|disable)\s+\$/)

  assert.match(inspectScript, /git --no-optional-locks -C "\$INSTALL_DIR" -c core\.fsmonitor=false status --porcelain=v1 --untracked-files=all --no-renames/)
  assert.match(inspectScript, /check_runtime_checkout_permission_contract/)
  assert.match(inspectScript, /find "\$INSTALL_DIR" -type d -print0/)
  assert.match(inspectScript, /find "\$INSTALL_DIR" -type f -print0/)
  assert.match(inspectScript, /git -C "\$INSTALL_DIR" ls-files -s -- "\$relative_path"/)
  assert.match(inspectScript, /tracked_file_expected_mode/)
  assert.match(inspectScript, /sudo -u "\$SERVICE_USER" "\$NODE_BIN" --version/)
  assert.match(inspectScript, /sudo -u "\$SERVICE_USER" "\$OPENCLAW_BIN" --version/)
  assert.doesNotMatch(inspectScript, /PREFLIGHT_SCRIPT|SERVICE_CONTROL_SCRIPT|preflight-openclaw-runtime\.sh|service-control\.sh/)
  assert.doesNotMatch(inspectScript, /git fetch|git pull|git switch|git checkout|git reset|systemctl\s+(?:start|stop|restart|reload|enable|disable)|curl|wget|gh\s|ssh|scp|rsync/)
  assert.match(legacyRollback, /last-good-revision/)
})
