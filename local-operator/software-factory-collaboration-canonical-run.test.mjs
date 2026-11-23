import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  PHASE_6G_DELIVERY_POLICY_HASH, PHASE_6G_DELIVERY_POLICY_ID
} from "./development-acceptance-gate.mjs"
import {
  hasTrustedDevelopmentRunCatalogDiagnostics, listDevelopmentRunSummaries
} from "./development-run-catalog.mjs"
import {
  createDevelopmentRun, DEVELOPMENT_RUN_STORE_DIR, readDevelopmentRun,
  recordDevelopmentRunProgress, transitionDevelopmentRun
} from "./development-run-state.mjs"
import { INDEPENDENT_REVIEW_AGENT_ID, REMOTE_PR_REVIEW_AGENT_ID } from "./development-review-agent.mjs"
import { AUTOMATED_TEST_RUNNER_ID } from "./development-test-runner.mjs"
import {
  GITHUB_DELIVERY_AGENT_ID, PPO_PR_VALIDATION_WORKFLOW_NAME, REQUIRED_PPO_PR_VALIDATION_STEPS
} from "./github-delivery-agent.mjs"
import { softwareFactoryRunConsumesWip } from "./software-factory-admission.mjs"
import { createSoftwareFactoryAutonomousRunner } from "./software-factory-autonomous-run.mjs"
import {
  buildCollaborationEnvelope, buildCollaborationScope, collaborationSha256,
  createTrustedCollaborationRegistry, SOFTWARE_FACTORY_COLLABORATION_DEFAULT_REGISTRY_CONFIG
} from "./software-factory-collaboration-contract.mjs"
import {
  applyCollaborationReview, assessCollaborationEnvelopeContext, assessImplementationContract,
  assertCollaborationCandidateIsNew, assertContractEvidenceMatchesDigest, assertReviewerIndependent,
  createFindingLedger, markFindingAreaAddressed, openFindingsForArea
} from "./software-factory-collaboration-handoff-rules.mjs"
import { routeCollaborationStep } from "./software-factory-collaboration-routing.mjs"
import { REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID } from "./software-factory-implementation-evidence.mjs"
import {
  buildBaselineSoftwareFactoryPlan, latestSoftwareFactoryPlan, resolveSoftwareFactoryTaskRole,
  softwareFactoryPlanEvidence
} from "./software-factory-plan-contract.mjs"
import {
  confirmSoftwareFactoryReleaseApproval, SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS,
  stageSoftwareFactoryReleaseApproval
} from "./software-factory-release-approval.mjs"
import { buildSoftwareFactoryReleasePackageFromRun } from "./software-factory-release-package.mjs"
import { remotePayloadDigest, signRemoteEnvelope } from "./software-factory-remote-contract.mjs"
import { createOfflineDurableClaimLedger } from "./software-factory-remote-durable-ledger.mjs"
import { linearIssueRevisionHash, preflightOfflineAssignment } from "./war-room-assignment-preflight.mjs"
import { stageOfflineAssignment } from "./war-room-offline-staging.mjs"

// Test-only. All PPO lifecycle writes use the real CAS API and a fresh private
// store. Provider replies and delivery facts are inert fixture data.
const ACTOR = "ric187-offline-fixture"
const PROJECT = "rivora"
const BRANCH = "ppo/rivora/implementation/synthetic-greeter"
const BASE = "a".repeat(40)
const START = Date.parse("2026-11-11T05:02:00.000Z")
const BACKEND_TASK = "Implement a synthetic greeting API endpoint."
const FRONTEND_TASK = "Implement the synthetic greeting page UI."
const PPO = Object.freeze({ role: "coordinator", providerId: "ppo" })
const FINDING = Object.freeze({
  code: "missing_aria_label", area: "frontend", severity: "P1",
  summary: "The greeting control needs an accessible label."
})
const NO_AUTHORITY = Object.freeze({ grant: false, canExecute: false, releaseAuthorized: false })

function evidence(kind, source, sha, metadata) {
  return { kind, source, sha, summary: "Synthetic RIC-187 fixture evidence.", metadata: { ...metadata, synthetic: true } }
}

function evidenceRef(kind, candidateSha, content) {
  const digest = collaborationSha256(content)
  return { kind, ref: kind + "-" + digest.slice(0, 12), digest, sizeBytes: Buffer.byteLength(content), candidateSha }
}

function syntheticDelivery(run) {
  // The builder validates these records with its normal production schema.
  // The identifiers and verdicts exist only inside this test's private store.
  const sha = run.headSha
  const common = { project: run.project.id, policyId: PHASE_6G_DELIVERY_POLICY_ID,
    policyHash: PHASE_6G_DELIVERY_POLICY_HASH, prNumber: 1_871_000_001 }
  const delivery = { ...common, agent: GITHUB_DELIVERY_AGENT_ID, implementationSha: sha, workflowRunId: 1_871_000_002 }
  return [
    evidence("review", REMOTE_PR_REVIEW_AGENT_ID, sha, {
      ...common, reviewer: REMOTE_PR_REVIEW_AGENT_ID, attempt: 1, reviewedSha: sha,
      decision: "APPROVED", mergeAllowed: true, blockers: 0, securityFindings: 0,
      testsRequired: 0, outcome: "approved"
    }),
    evidence("merge", GITHUB_DELIVERY_AGENT_ID, sha, {
      ...delivery, outcome: "ci_passed", workflowName: PPO_PR_VALIDATION_WORKFLOW_NAME,
      workflowConclusion: "success", requiredSteps: REQUIRED_PPO_PR_VALIDATION_STEPS.length
    }),
    evidence("merge", GITHUB_DELIVERY_AGENT_ID, sha, {
      ...delivery, outcome: "merge_ready", branch: run.branch, base: "main", prHeadSha: sha,
      remoteReviewedSha: sha, remoteDecision: "APPROVED"
    })
  ]
}

async function fixture(t, { backendCapacity = "available", trialReview = true, reply = fields => fields } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ppo-ric187-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const storeDir = join(root, "reservations")
  await mkdir(storeDir, { mode: 0o700 })
  const input = { projectId: PROJECT, task: BACKEND_TASK, baseSha: BASE, headSha: BASE, branch: BRANCH, actor: ACTOR }
  let clock = START
  const now = () => new Date(clock)
  const options = { writeDataDir: root, now }
  const readRun = id => readDevelopmentRun(id, options)
  const listRuns = () => listDevelopmentRunSummaries(options)
  const transition = (run, status, update = {}) => transitionDevelopmentRun(run.runId, {
    ...update, status, actor: ACTOR, expectedVersion: run.version
  }, options)
  const progress = (run, update) => recordDevelopmentRunProgress(run.runId, {
    ...update, status: run.status, actor: ACTOR, expectedVersion: run.version
  }, options)

  const created = await createDevelopmentRun(input, options)
  const plan = buildBaselineSoftwareFactoryPlan({
    runId: created.runId, projectId: PROJECT, baseSha: BASE, objective: BACKEND_TASK
  })
  const scope = buildCollaborationScope({ planHash: plan.planHash, steps: [
    { stepId: "backend", role: "backend_implementer" },
    { stepId: "frontend", role: "frontend_implementer" },
    { stepId: "review", role: "independent_reviewer" }
  ] })
  const planning = await transition(created, "planning_in_progress")
  const planned = await transition(planning, "planned", { evidence: [softwareFactoryPlanEvidence(plan)] })
  const initial = await transition(planned, "implementation_in_progress")

  const issue = Object.freeze({
    identifier: "RIC-987187", title: "Synthetic greeting fixture",
    description: BACKEND_TASK + " " + FRONTEND_TASK,
    updatedAt: new Date(START - 180_000).toISOString()
  })
  const signer = generateKeyPairSync("ed25519")
  const payload = {
    kind: "dispatch-request", schemaVersion: 1, requestId: "1".repeat(32),
    runId: initial.runId, expectedVersion: initial.version, projectId: initial.project.id,
    branch: initial.branch, baseSha: initial.baseSha, headSha: initial.headSha,
    capability: "implementation.backend", workerId: "codex",
    taskSource: { kind: "linear-issue", issueId: issue.identifier, revisionHash: linearIssueRevisionHash(issue) },
    scope: { mode: "implementation", allowedPaths: ["src/"], permits: ["workspace.read"] },
    approval: { ownerId: "owner", approvalId: "2".repeat(32), approvedAt: new Date(START - 120_000).toISOString() },
    nonce: "3".repeat(32), idempotencyKey: "4".repeat(64),
    issuedAt: new Date(START - 60_000).toISOString(), expiresAt: new Date(START + 600_000).toISOString(),
    maxDurationMs: 120_000
  }
  const sign = (overrides = {}) => signRemoteEnvelope({ ...payload, ...overrides }, "ppo-control-plane", signer.privateKey)
  const signed = sign()
  const approved = Object.freeze({
    requestHash: remotePayloadDigest(payload), scopeDigest: scope.scopeDigest, expiresAt: START + 180_000
  })
  const common = {
    coordinatorPublicKey: signer.publicKey, now, readRun, resolveRole: resolveSoftwareFactoryTaskRole,
    approvedProjects: Object.freeze([PROJECT, "kynexa", "khlim-digital-ecosystem"])
  }
  const preflight = {
    ...common, mode: "offline-preflight-only", readIssue: () => issue,
    resolveIssueProject: () => PROJECT,
    readRepo: () => ({
      projectId: PROJECT, branch: BRANCH, baseSha: BASE, headSha: BASE,
      reviewedCanonicalPath: true, isolatedWorktree: true
    }),
    async readCatalogAdmission() {
      const catalog = await listRuns()
      return { valid: catalog.ok === true && catalog.code === "ok" && hasTrustedDevelopmentRunCatalogDiagnostics(catalog.diagnostics) }
    },
    async listActiveProjects() {
      return [...new Set((await listRuns()).active.filter(softwareFactoryRunConsumesWip).map(run => run.project))]
    },
    verifyOwnerApproval: binding => binding.requestHash === approved.requestHash &&
      scope.scopeDigest === approved.scopeDigest && clock < approved.expiresAt
  }
  const ledgerConfig = { ...common, mode: "offline-durable-proof-only", storeDir, workerRegistry: {} }
  const stage = (request = signed, observations = {}) => stageOfflineAssignment(request, {
    mode: "offline-staging-proof-only", preflight: { ...preflight, ...observations }, ledger: ledgerConfig
  })
  const inspectReservation = () => createOfflineDurableClaimLedger(ledgerConfig).inspect(initial.runId, initial.version)
  const read = () => readRun(initial.runId)
  let mergeCalls = 0
  const approval = {
    ...options, readRun,
    executeMerge() { mergeCalls++; assert.fail("The offline fixture must never reach merge") },
    drainQueue() { assert.fail("The offline fixture must never drain the queue") }
  }

  const registryConfig = structuredClone(SOFTWARE_FACTORY_COLLABORATION_DEFAULT_REGISTRY_CONFIG)
  registryConfig.providers.claude.trialApprovedRoles = trialReview ? ["independent_reviewer"] : []
  const registry = createTrustedCollaborationRegistry(registryConfig)
  const available = { integration: "configured", capacity: "available", billingPath: "included" }
  const providerStates = {
    codex: { ...available, capacity: backendCapacity }, antigravity: available, claude: available
  }
  const assignmentCalls = []

  async function continueFixture(id, receipt) {
    const current = await readRun(id)
    const handoff = { projectId: current.project.id, runId: current.runId, baseSha: current.baseSha,
      correlationId: receipt.requestId, planHash: latestSoftwareFactoryPlan(current).planHash,
      scopeDigest: current.evidence.planning.at(-1).metadata.scopeDigest }
    const contract = current.evidence.implementation.find(entry => entry.metadata.outcome === "contract_ready")
    const firstReview = current.evidence.review.find(entry => entry.metadata.finding === FINDING.code)
    const testRecord = current.evidence.test.at(-1)

    function send(step, route, attemptNumber, fields, outgoing) {
      const context = { ...handoff, stepId: step.stepId, attemptNumber, expectedRunVersion: current.version }
      const party = { role: step.role, providerId: route.providerId }
      const request = outgoing && buildCollaborationEnvelope({ ...context, ...outgoing,
        sender: PPO, recipient: party
      }, registry)
      if (request) assert.equal(request.authority, "none")
      assignmentCalls.push(route.providerId)
      const fixtureResponse = fields(request?.envelope)
      const response = reply({ ...context, sender: party, recipient: PPO, ...fixtureResponse })
      const validated = buildCollaborationEnvelope(response, registry)
      assert.equal(validated.authority, "none")
      assessCollaborationEnvelopeContext(validated.envelope, {
        ...handoff, runVersion: current.version,
        expected: { ...step, providerId: route.providerId, attemptNumber,
          messageType: fixtureResponse.messageType }
      })
      return validated.envelope
    }

    const advance = async (status, update) => {
      await transition(current, status, update)
      return { ok: true, outcome: "progressed", action: status }
    }
    function route(stepId, taskCapability) {
      const step = scope.steps.find(item => item.stepId === stepId)
      const implementers = [...new Set(current.evidence.implementation.map(entry => entry.metadata.provider))]
      const decision = routeCollaborationStep({ registry, role: step.role, providerStates, taskCapability, implementers })
      assert.equal(decision.grantsAuthority, false)
      assert.deepEqual(decision.permissionsGranted, [])
      return { step, decision, implementers }
    }
    const blocked = decision => ({ ok: false, outcome: decision.outcome, reason: decision.reasonCode })

    switch (current.status) {
      case "implementation_in_progress": {
        const attempt = current.attempts.implementation
        const priorHeads = new Set(current.history.map(event => event.headSha))
        if (!contract) {
          const { step, decision } = route("backend", resolveSoftwareFactoryTaskRole(current))
          if (decision.outcome !== "ready") return blocked(decision)
          assert.equal(decision.providerId, signed.payload.workerId)
          const sha = collaborationSha256("synthetic backend").slice(0, 40)
          const ref = evidenceRef("contract", sha, '{"version":1,"greeting":"string"}')
          const message = send(step, decision, attempt, () => ({
            messageType: "contract_ready", requestedAction: "relay_contract", candidateSha: sha,
            contractDigest: ref.digest, evidence: [ref], summary: "Synthetic greeting contract."
          }))
          assertCollaborationCandidateIsNew(message.candidateSha, priorHeads)
          assert.deepEqual(assertContractEvidenceMatchesDigest(message), ref)
          await progress(current, { headSha: message.candidateSha, evidence: [
            evidence("implementation", ACTOR, message.candidateSha, {
              outcome: "contract_ready", provider: message.sender.providerId, ref: ref.ref,
              digest: ref.digest, sizeBytes: ref.sizeBytes
            })
          ] })
          return { ok: true, outcome: "progressed", action: "contract_ready" }
        }

        const { step, decision } = route("frontend", resolveSoftwareFactoryTaskRole({ task: FRONTEND_TASK }))
        if (decision.outcome !== "ready") return blocked(decision)
        const sha = collaborationSha256("synthetic frontend attempt " + attempt).slice(0, 40)
        const outgoing = firstReview
          ? { messageType: "correction_requested", requestedAction: "apply_correction",
              candidateSha: current.headSha, contractDigest: contract.metadata.digest,
              findings: [FINDING], evidence: [evidenceRef("review", firstReview.sha, FINDING.code)],
              summary: "One synthetic frontend correction." }
          : { messageType: "contract_ready", requestedAction: "implement_frontend",
              candidateSha: contract.sha, contractDigest: contract.metadata.digest,
              evidence: [{ kind: "contract", ref: contract.metadata.ref, digest: contract.metadata.digest,
                sizeBytes: contract.metadata.sizeBytes, candidateSha: contract.sha }],
              summary: "Synthetic contract for the frontend." }
        if (firstReview) assert.equal(firstReview.sha, current.headSha)
        const ref = evidenceRef("implementation", sha, "synthetic implementation " + attempt)
        const message = send(step, decision, attempt, handoffMessage => ({
          messageType: "implementation_ready", requestedAction: "run_tests", candidateSha: sha,
          contractDigest: handoffMessage.contractDigest, evidence: [ref], summary: "Synthetic frontend candidate."
        }), outgoing)
        assertCollaborationCandidateIsNew(message.candidateSha, priorHeads)
        assessImplementationContract(message, "frontend", contract.metadata.digest)
        assert.deepEqual(message.evidence, [ref])
        return advance("implementation_ready", { headSha: message.candidateSha, evidence: [
          evidence("implementation", REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, message.candidateSha, {
            adapter: REVIEWED_ANTIGRAVITY_EXECUTION_ADAPTER_ID, project: PROJECT, attempt,
            outcome: "implementation_ready", provider: message.sender.providerId,
            contractDigest: message.contractDigest, addresses: outgoing.findings?.[0].code ?? null,
            digest: ref.digest
          })
        ] })
      }
      case "implementation_ready":
        return advance("tests_in_progress")
      case "tests_in_progress": {
        const implementation = current.evidence.implementation.at(-1)
        assert.equal(implementation.sha, current.headSha)
        const digest = collaborationSha256("synthetic test pass for " + current.headSha)
        return advance("tests_passed", { evidence: [evidence("test", AUTOMATED_TEST_RUNNER_ID, current.headSha, {
          runner: AUTOMATED_TEST_RUNNER_ID, project: PROJECT, attempt: current.attempts.test,
          implSha: current.headSha, policyId: ACTOR, policyHash: collaborationSha256(ACTOR),
          outcome: "passed", total: 1, passed: 1, failed: 0, ambiguous: 0, digest
        })] })
      }
      case "tests_passed":
        return advance("review_in_progress")
      case "review_in_progress": {
        assert.equal(testRecord.sha, current.headSha)
        const { step, decision, implementers } = route("review")
        if (decision.outcome !== "ready") return blocked(decision)
        const attempt = current.attempts.review
        const ref = evidenceRef("review", current.headSha, firstReview ? "synthetic review approved" : FINDING.code)
        const message = send(step, decision, attempt, () => ({
          messageType: "review_finding", requestedAction: "evaluate_review", candidateSha: current.headSha,
          reviewDecision: firstReview ? "approved" : "changes_requested",
          findings: firstReview ? [] : [FINDING], resolvedFindings: firstReview ? [FINDING.code] : [],
          evidence: [ref], summary: "Synthetic candidate review."
        }))
        assertReviewerIndependent(message.sender.providerId, new Set(implementers))
        assert.equal(message.candidateSha, current.headSha)
        assert.deepEqual(message.evidence, [ref])
        let findings = createFindingLedger()
        if (firstReview) {
          const correction = current.evidence.implementation.at(-1)
          assert.notEqual(firstReview.sha, current.headSha)
          assert.equal(correction.sha, current.headSha)
          assert.equal(correction.metadata.addresses, firstReview.metadata.finding)
          findings = applyCollaborationReview(findings, {
            reviewDecision: "changes_requested", findings: [FINDING], resolvedFindings: [],
            candidateSha: firstReview.sha
          }, 1)
          findings = markFindingAreaAddressed(findings, "frontend", current.headSha)
        }
        findings = applyCollaborationReview(findings, message, attempt)
        const approved = message.reviewDecision === "approved"
        const frontendFindings = openFindingsForArea(findings, "frontend")
        if (!firstReview) assert.deepEqual(frontendFindings, [FINDING])
        return advance(approved ? "review_passed" : "review_changes_requested", {
          evidence: [evidence("review", INDEPENDENT_REVIEW_AGENT_ID, current.headSha, {
            reviewer: INDEPENDENT_REVIEW_AGENT_ID, project: PROJECT, attempt, reviewedSha: current.headSha,
            provider: message.sender.providerId, decision: approved ? "APPROVED" : "CHANGES_REQUESTED",
            mergeAllowed: approved, blockers: frontendFindings.length, securityFindings: 0, testsRequired: 0,
            outcome: message.reviewDecision, finding: frontendFindings[0]?.code ?? null,
            resolved: message.resolvedFindings, digest: ref.digest
          })]
        })
      }
      case "review_changes_requested":
        if (current.attempts.implementation !== 1) {
          return { ok: false, outcome: "owner_action_required", reason: "correction_budget_exhausted" }
        }
        return advance("implementation_in_progress")
      case "review_passed":
        return advance("merge_ready", { evidence: syntheticDelivery(current) })
      default:
        assert.fail("Unexpected canonical status in offline fixture")
    }
  }

  async function drive() {
    const preflightResult = await preflightOfflineAssignment(signed, preflight)
    assert.equal(preflightResult.preflightPassed, true)
    assert.equal(preflightResult.canExecute, false)
    assert.equal(preflightResult.releaseAuthorized, false)
    assert.deepEqual(await readdir(storeDir), [])
    const receipt = await stage()
    assert.equal(receipt.outcome, "staged-offline")
    assert.equal(receipt.canExecute, false)
    assert.equal(receipt.releaseAuthorized, false)
    const reserved = await inspectReservation()
    assert.deepEqual(reserved, {
      reserved: true, requestHash: approved.requestHash, runId: initial.runId,
      expectedVersion: initial.version, releaseAuthorized: false
    })
    const run = await read()
    assert.deepEqual(run, initial)
    assert.equal(receipt.requestHash, reserved.requestHash)
    assert.equal(receipt.runId, run.runId)
    assert.equal(receipt.expectedVersion, run.version)

    await progress(run, { evidence: [evidence("planning", ACTOR, run.headSha, {
      planHash: plan.planHash, scopeDigest: approved.scopeDigest, requestHash: reserved.requestHash,
      issueRevisionHash: receipt.sourceRevisionHash, reservedVersion: reserved.expectedVersion
    })] })

    // Only the continuation leaf is a fixture. The existing runner controls
    // iteration, catalog checks, the step bound and the real release builder.
    const runner = createSoftwareFactoryAutonomousRunner({
      listRuns, readRun, continueRun: id => continueFixture(id, receipt)
    })
    return { ...(await runner(receipt.runId)), ...NO_AUTHORITY }
  }

  return { initial, issue, sign, stage, read, progress, drive, storeDir, inspectReservation, assignmentCalls, approval,
    mergeCalls: () => mergeCalls, advanceClock: ms => { clock += ms },
    createOther: projectId => createDevelopmentRun({ ...input, projectId }, options),
    invalidateCatalogue: () => writeFile(join(root, DEVELOPMENT_RUN_STORE_DIR, "records", "_".repeat(43) + ".json"), "{}")
  }
}

test("RIC-187 connects one canonical run from signed reservation to owner-gated synthetic release", async t => {
  const f = await fixture(t)
  const result = await f.drive()
  const run = await f.read()
  assert.equal(result.outcome, "release_ready")
  assert.equal(result.reason, "human_release_approval_required")
  assert.equal(run.status, "merge_ready")
  assert.equal(run.runId, f.initial.runId)
  assert.equal(run.project.id, f.initial.project.id)
  assert.equal(run.baseSha, f.initial.baseSha)
  assert.equal(run.branch, f.initial.branch)
  assert.equal(run.history.length, run.version + 1)
  assert.deepEqual(result.history.map(entry => [entry.beforeVersion, entry.afterVersion]),
    Array.from({ length: result.stepCount }, (_, i) => [f.initial.version + 1 + i, f.initial.version + 2 + i]))
  assert.deepEqual(result.history.map(entry => entry.action), [
    "contract_ready", "implementation_ready", "tests_in_progress", "tests_passed",
    "review_in_progress", "review_changes_requested", "implementation_in_progress",
    "implementation_ready", "tests_in_progress", "tests_passed", "review_in_progress", "review_passed", "merge_ready"
  ])
  await assert.rejects(f.progress(f.initial, { reason: "Stale synthetic writer." }), { code: "STALE_RUN_VERSION" })
  assert.deepEqual(await f.read(), run)
  assert.deepEqual(f.assignmentCalls, ["codex", "antigravity", "claude", "antigravity", "claude"])
  assert.equal(run.attempts.implementation, 2)
  assert.equal(run.attempts.test, 2)
  assert.equal(run.attempts.review, 2)
  const [oldTest, freshTest] = run.evidence.test
  const [firstReview, freshReview, syntheticRemoteReview] = run.evidence.review
  const [contract, oldImplementation, freshImplementation] = run.evidence.implementation
  assert.notEqual(oldTest.sha, run.headSha)
  assert.equal(oldImplementation.sha, oldTest.sha)
  assert.equal(firstReview.sha, oldTest.sha)
  assert.equal(firstReview.metadata.decision, "CHANGES_REQUESTED")
  assert.equal(freshImplementation.sha, run.headSha)
  assert.equal(freshImplementation.metadata.contractDigest, contract.metadata.digest)
  assert.equal(freshTest.sha, run.headSha)
  assert.equal(freshReview.sha, run.headSha)
  assert.deepEqual(freshReview.metadata.resolved, [FINDING.code])
  assert.equal(syntheticRemoteReview.sha, run.headSha)
  assert.ok([contract, oldImplementation, freshImplementation, oldTest, freshTest, firstReview, freshReview,
    syntheticRemoteReview, ...run.evidence.merge].every(entry => entry.metadata.synthetic === true))
  const release = result.releasePackage
  assert.deepEqual(release, buildSoftwareFactoryReleasePackageFromRun(run))
  assert.equal(release.run.headSha, run.headSha)
  assert.equal(release.run.runId, run.runId)
  assert.equal(release.run.version, run.version)
  assert.equal(release.tests.attempt, 2)
  assert.equal(release.localReview.attempt, 2)
  assert.equal(release.authority.merge, "owner_approval_required")
  assert.equal(release.authority.productionDeployment, "not_authorized")
  for (const [flag, value] of Object.entries(NO_AUTHORITY)) assert.equal(result[flag], value)
  assert.ok((await f.inspectReservation()).reserved)
  assert.equal(f.mergeCalls(), 0)
})

for (const [name, code, request, observations] of [
  ["stale SHA", "PREFLIGHT_RUN_STALE", f => f.sign({ headSha: "b".repeat(40) })],
  ["stale version", "PREFLIGHT_RUN_STALE", f => f.sign({ expectedVersion: f.initial.version - 1 })],
  ["wrong project", "PREFLIGHT_RUN_STALE", f => f.sign({ projectId: "kynexa" })],
  ["forged assignment", "STAGING_SIGNED_REQUEST_INVALID", f => ({ ...f.sign(), signature: "A".repeat(86) })],
  ["altered issue", "PREFLIGHT_ISSUE_STALE", undefined, f => ({
    readIssue: () => ({ ...f.issue, description: "Revised synthetic scope." })
  })],
  ["missing assignment approval", "PREFLIGHT_APPROVAL_REQUIRED", undefined, () => ({ verifyOwnerApproval: () => false })]
]) {
  test("RIC-187 denies " + name + " before reservation", async t => {
    const f = await fixture(t)
    await assert.rejects(f.stage(request?.(f), observations?.(f)), { code })
    assert.deepEqual(await readdir(f.storeDir), [])
    assert.deepEqual(await f.read(), f.initial)
  })
}

test("RIC-187 checks the real private catalogue and WIP before reservation", async t => {
  const f = await fixture(t)
  await f.createOther("kynexa")
  await f.createOther("khlim-digital-ecosystem")
  await assert.rejects(f.stage(), { code: "PREFLIGHT_WIP_BLOCKED" })
  await f.invalidateCatalogue()
  await assert.rejects(f.stage(), { code: "PREFLIGHT_CATALOG_BLOCKED" })
  assert.deepEqual(await readdir(f.storeDir), [])
  assert.deepEqual(await f.read(), f.initial)
})

test("RIC-187 denies stale assignment approval without a reservation", async t => {
  const f = await fixture(t)
  f.advanceClock(180_000)
  await assert.rejects(f.stage(), { code: "PREFLIGHT_APPROVAL_REQUIRED" })
  assert.deepEqual(await readdir(f.storeDir), [])
  assert.deepEqual(await f.read(), f.initial)
})

test("RIC-187 keeps the reservation when post-reservation issue recheck fails and refuses replay", async t => {
  const f = await fixture(t)
  let reads = 0
  await assert.rejects(f.stage(undefined, {
    readIssue: () => ++reads === 1 ? f.issue : { ...f.issue, description: "Synthetic issue changed after reservation." }
  }), { code: "PREFLIGHT_ISSUE_STALE" })
  assert.equal(reads, 2)
  const reserved = await f.inspectReservation()
  assert.equal(reserved.reserved, true)
  assert.equal(reserved.releaseAuthorized, false)
  assert.equal(reserved.requestHash, remotePayloadDigest(f.sign().payload))
  await assert.rejects(f.stage(), { code: "LEDGER_RUN_RESERVED" })
  assert.deepEqual(await f.inspectReservation(), reserved)
  assert.deepEqual(await f.read(), f.initial)
  assert.deepEqual(f.assignmentCalls, [])
})

test("RIC-187 refuses conflicting frontend evidence on a staged canonical run", async t => {
  const f = await fixture(t, {
    reply: fields => fields.messageType === "implementation_ready"
      ? { ...fields, contractDigest: "f".repeat(64) } : fields
  })
  await assert.rejects(f.drive(), { code: "COLLAB_CONTRACT_MISMATCH" })
  const run = await f.read()
  assert.equal(run.status, "implementation_in_progress")
  assert.equal(run.evidence.implementation.length, 1)
  assert.equal(run.headSha, run.evidence.implementation[0].sha)
  assert.deepEqual(run.evidence.test, [])
  assert.equal((await f.inspectReservation()).reserved, true)
})

test("RIC-187 denies a stale collaboration reply before canonical evidence is written", async t => {
  const f = await fixture(t, { reply: fields => ({ ...fields, expectedRunVersion: fields.expectedRunVersion - 1 }) })
  await assert.rejects(f.drive(), { code: "COLLAB_STALE_RUN_VERSION" })
  const run = await f.read()
  assert.equal(run.version, f.initial.version + 1)
  assert.equal(run.headSha, f.initial.headSha)
  assert.deepEqual(run.evidence.implementation, [])
  assert.equal((await f.inspectReservation()).reserved, true)
})

test("RIC-187 blocks review by the existing implementer when no independent trial is approved", async t => {
  const f = await fixture(t, { trialReview: false })
  const result = await f.drive()
  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reason, "NO_ELIGIBLE_REVIEWER")
  assert.equal(result.releasePackage, undefined)
  assert.deepEqual(f.assignmentCalls, ["codex", "antigravity"])
  assert.deepEqual((await f.read()).evidence.review, [])
})

test("RIC-187 checkpoints exhausted backend quota without an eligible alternate", async t => {
  const f = await fixture(t, { backendCapacity: "exhausted" })
  const result = await f.drive()
  assert.equal(result.outcome, "blocked_capacity")
  assert.equal(result.reason, "NO_ELIGIBLE_PROVIDER")
  assert.equal(result.run.status, f.initial.status)
  assert.equal(result.run.version, f.initial.version + 1)
  assert.equal(result.releasePackage, undefined)
  const run = await f.read()
  assert.deepEqual(run.evidence.implementation, [])
  assert.deepEqual(run.attempts, f.initial.attempts)
  assert.deepEqual(f.assignmentCalls, [])
})

test("RIC-187 real release approval refuses absent, stale and expired synthetic approvals", async t => {
  const f = await fixture(t)
  const { releasePackage } = await f.drive()
  const id = releasePackage.run.runId
  const missing = await confirmSoftwareFactoryReleaseApproval("A".repeat(43), f.approval)
  assert.equal(missing.code, "RELEASE_REQUEST_NOT_FOUND")
  const staged = await stageSoftwareFactoryReleaseApproval(id, f.approval)
  assert.equal(staged.ok, true)
  assert.equal(staged.packageHash, releasePackage.packageHash)
  await f.progress(await f.read(), { reason: "Synthetic owner approval version drift." })
  const stale = await confirmSoftwareFactoryReleaseApproval(staged.requestId, f.approval)
  assert.equal(stale.code, "RELEASE_APPROVAL_STALE")
  const refreshed = await stageSoftwareFactoryReleaseApproval(id, f.approval)
  assert.equal(refreshed.ok, true)
  f.advanceClock(SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS + 1)
  const expired = await confirmSoftwareFactoryReleaseApproval(refreshed.requestId, f.approval)
  assert.equal(expired.code, "RELEASE_REQUEST_EXPIRED")
  assert.equal((await f.read()).status, "merge_ready")
  assert.equal(f.mergeCalls(), 0)
})

test("RIC-187 builder rejects superseded test evidence supplied after correction", async t => {
  const f = await fixture(t)
  await f.drive()
  const ready = await f.read()
  const superseded = ready.evidence.test[0]
  const conflicted = await f.progress(ready, { evidence: [superseded] })
  assert.equal(conflicted.status, "merge_ready")
  assert.throws(() => buildSoftwareFactoryReleasePackageFromRun(conflicted), {
    code: "FACTORY_RELEASE_TEST_EVIDENCE_INVALID"
  })
  assert.equal(f.mergeCalls(), 0)
})
