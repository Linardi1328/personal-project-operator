import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { buildCollaborationEnvelope } from "./software-factory-collaboration-contract.mjs"
import { verifyCollaborationEventChain } from "./software-factory-collaboration-simulation-model.mjs"
import {
  SIMULATION_SCENARIOS,
  SOFTWARE_FACTORY_COLLABORATION_SIMULATION_EFFECTS,
  SYNTHETIC_BASE_SHA,
  SYNTHETIC_CORRELATION_ID,
  SYNTHETIC_OBJECTIVE,
  SYNTHETIC_PROJECT_ID,
  SYNTHETIC_RUN_ID,
  assertSimulationIsSynthetic,
  runCollaborationSimulation,
  syntheticContractDigest,
  syntheticProviderStates,
  syntheticRegistry
} from "./software-factory-collaboration-simulation.mjs"
import { DEVELOPMENT_RUN_STATUSES } from "./development-run-state.mjs"
import {
  SOFTWARE_FACTORY_AUTONOMOUS_MAX_STEPS,
  SOFTWARE_FACTORY_AUTONOMOUS_RUNNER_ID
} from "./software-factory-autonomous-run.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const lifecycle = SIMULATION_SCENARIOS.full_lifecycle_with_correction
const quota = SIMULATION_SCENARIOS.codex_quota_alternate_routing

function transcriptKeys(result) {
  return result.transcript.map((entry) => {
    if (entry.event === "assigned") return `assigned:${entry.providerId}:${entry.stepId}#${entry.attemptNumber}`
    if (entry.event === "accepted") return `accepted:${entry.messageType}:${entry.providerId}`
    if (entry.event === "tests_recorded") return `tests:${entry.passed}`
    return entry.event
  })
}

test("lifecycle: backend contract, frontend, tests, review, correction, re-verification, release package, owner still required", async () => {
  const result = await runCollaborationSimulation(lifecycle)

  // 1. An approved synthetic task is received. The existing classifier keeps mixed work as "debugging",
  //    so the owner-approved decomposition, not a loosened classifier, is what splits it.
  assert.equal(result.planCapabilityHint, "debugging")
  assert.equal(result.taskRoleForSyntheticObjective, "debugging")
  assert.match(SYNTHETIC_OBJECTIVE, /backend/u)
  assert.match(SYNTHETIC_OBJECTIVE, /frontend/u)

  assert.deepEqual(transcriptKeys(result), [
    // 2. Backend worker produces a versioned API contract.
    "assigned:codex:backend#1",
    "accepted:contract_ready:codex",
    // 3. Frontend worker receives it. 4. Implementation evidence is produced.
    "assigned:antigravity:frontend#1",
    "accepted:implementation_ready:antigravity",
    // 5. Automated test evidence is attached.
    "tests:true",
    // 6. Independent reviewer returns a required correction.
    "assigned:claude:review#1",
    "accepted:review_finding:claude",
    // 7. The appropriate worker receives the correction. 8. A new candidate is produced.
    "assigned:antigravity:frontend#2",
    "accepted:implementation_ready:antigravity",
    // 10. Exact-candidate verification is repeated.
    "tests:true",
    "assigned:claude:review#2",
    "accepted:review_finding:claude",
    // 11. A release package is prepared.
    "release_package_prepared"
  ])

  const { snapshot } = result
  // 12. Owner approval remains required; nothing merged, deployed, or approved.
  assert.equal(result.stoppedAt, "awaiting_owner_approval")
  assert.equal(snapshot.status, "merge_ready")
  assert.equal(snapshot.ownerDecision, null)
  assert.equal(result.ownerApprovalRequired, true)
  assert.equal(snapshot.releasePackage.authority.merge, "owner_approval_required")
  assert.equal(snapshot.releasePackage.authority.productionDeployment, "not_authorized")
  assert.equal(snapshot.authority.grantsAuthority, false)
  assert.equal(result.authority.grantsAuthority, false)
  assert.equal(snapshot.releasePackage.kind, "simulated_software_factory_release_candidate")

  // Reviewer independence: the reviewer never implemented any part of the candidate.
  assert.deepEqual(snapshot.implementers, ["antigravity", "codex"])
  assert.ok(!snapshot.implementers.includes("claude"))
  assert.equal(snapshot.releasePackage.review.reviewer, "claude")

  // The role split was never loosened: only codex wrote backend steps, only antigravity wrote frontend steps.
  for (const entry of result.transcript.filter((item) => item.event === "assigned")) {
    if (entry.stepId === "backend") assert.equal(entry.providerId, "codex")
    if (entry.stepId === "frontend") assert.equal(entry.providerId, "antigravity")
    if (entry.stepId === "review") assert.ok(entry.evaluationProvider, "Claude reviewer is flagged as a trial provider")
  }
})

test("lifecycle: the corrected candidate invalidates old evidence and the release binds to the exact new head", async () => {
  const result = await runCollaborationSimulation(lifecycle)
  const heads = result.transcript.filter((entry) => entry.event === "tests_recorded").map((entry) => entry.candidateSha)
  assert.equal(heads.length, 2)
  assert.notEqual(heads[0], heads[1])

  // 9. Old test, review and implementation evidence are invalid; new evidence is current.
  assert.equal(result.invalidatedEvidence.length, 3)
  assert.deepEqual(result.invalidatedEvidence.map((entry) => entry.kind).sort(), ["implementation", "review", "test"])
  for (const invalid of result.invalidatedEvidence) assert.equal(result.evidenceCurrent[invalid.ref], false)

  const pkg = result.snapshot.releasePackage
  assert.equal(pkg.headSha, heads[1])
  assert.equal(pkg.baseSha, SYNTHETIC_BASE_SHA)
  assert.equal(pkg.contractDigest, syntheticContractDigest(1))
  assert.equal(pkg.correctionRounds, 1)
  assert.ok(result.evidenceCurrent[pkg.tests.ref])
  assert.ok(result.evidenceCurrent[pkg.review.ref])
  assert.ok(![...result.invalidatedEvidence.map((entry) => entry.ref)].includes(pkg.tests.ref))
  assert.equal(result.snapshot.testsPassedForCandidate, true)
  assert.equal(result.snapshot.approvedReviewForCandidate, true)
})

test("lifecycle: status transitions use only the existing development run vocabulary and table", async () => {
  const result = await runCollaborationSimulation(lifecycle)
  const transitions = result.events.filter((event) => event.type === "run_transition").map((event) => `${event.data.from}>${event.data.to}`)
  assert.deepEqual(transitions, [
    "created>planning_in_progress", "planning_in_progress>planned", "planned>implementation_in_progress",
    "implementation_in_progress>implementation_ready", "implementation_ready>tests_in_progress", "tests_in_progress>tests_passed",
    "tests_passed>review_in_progress", "review_in_progress>review_changes_requested", "review_changes_requested>implementation_in_progress",
    "implementation_in_progress>implementation_ready", "implementation_ready>tests_in_progress", "tests_in_progress>tests_passed",
    "tests_passed>review_in_progress", "review_in_progress>review_passed", "review_passed>merge_ready"
  ])
  for (const entry of transitions) {
    for (const status of entry.split(">")) assert.ok(DEVELOPMENT_RUN_STATUSES.includes(status), status)
  }
})

test("lifecycle: PPO-issued messages are valid, well-formed envelopes sent only to the right roles", async () => {
  const result = await runCollaborationSimulation(lifecycle)
  const issued = result.outbox.map((entry) => `${entry.messageType}->${entry.recipient.role}`)
  assert.deepEqual(issued, [
    "contract_ready->frontend_implementer",
    "correction_requested->frontend_implementer",
    "release_package_ready->owner"
  ])
  const registry = syntheticRegistry({ claudeTrialRoles: ["independent_reviewer"] })
  for (const entry of result.model.outbox()) {
    const rebuilt = buildCollaborationEnvelope({ ...entry.envelope, idempotencyKey: undefined }, registry)
    assert.equal(rebuilt.envelopeDigest, entry.envelopeDigest)
    assert.equal(rebuilt.authority, "none")
    assert.equal(entry.envelope.projectId, SYNTHETIC_PROJECT_ID)
    assert.equal(entry.envelope.runId, SYNTHETIC_RUN_ID)
    assert.equal(entry.envelope.correlationId, SYNTHETIC_CORRELATION_ID)
  }
})

test("the stepping loop is the existing autonomous runner, not a reimplementation", async () => {
  const result = await runCollaborationSimulation(lifecycle)
  assert.equal(result.runner.id, SOFTWARE_FACTORY_AUTONOMOUS_RUNNER_ID)
  // The runner's own release stop: merge_ready means a human release approval is required.
  assert.equal(result.runner.outcome, "release_ready")
  assert.equal(result.runner.reason, "human_release_approval_required")
  assert.ok(result.runner.stepCount > 0 && result.runner.stepCount <= SOFTWARE_FACTORY_AUTONOMOUS_MAX_STEPS)
  // Its history records each continuation with the existing before/after status and version fields.
  const statuses = result.runner.history.map((entry) => `${entry.beforeStatus}>${entry.afterStatus}`)
  assert.equal(statuses[0], "created>implementation_in_progress")
  assert.equal(statuses.at(-1), "review_passed>merge_ready")
  for (const entry of result.runner.history) {
    assert.ok(entry.afterVersion > entry.beforeVersion, "every continuation makes recorded progress")
    assert.ok(DEVELOPMENT_RUN_STATUSES.includes(entry.beforeStatus) && DEVELOPMENT_RUN_STATUSES.includes(entry.afterStatus))
  }
})

test("capacity blocks surface as the runner's own blocked_capacity outcome and resume on the next runner call", async () => {
  const result = await runCollaborationSimulation(quota)
  assert.deepEqual(result.runner.outcomes, ["blocked_capacity", "release_ready"])
  assert.equal(result.runner.invocations, 2)
  const ownerBlocked = await runCollaborationSimulation({ ...quota, id: "owner-blocked", claudeTrialRoles: [], recover: undefined })
  assert.deepEqual(ownerBlocked.runner.outcomes, ["blocked_capacity"])
  const ambiguous = await runCollaborationSimulation({ id: "amb", providerStates: syntheticProviderStates(), adapterBehavior: { "backend:1": "ambiguous" } })
  assert.deepEqual(ambiguous.runner.outcomes, ["owner_action_required"])
})

test("mixed findings: both areas are corrected before tests, then both are explicitly resolved", async () => {
  const result = await runCollaborationSimulation(SIMULATION_SCENARIOS.mixed_area_findings_two_corrections)
  assert.deepEqual(transcriptKeys(result), [
    "assigned:codex:backend#1", "accepted:contract_ready:codex",
    "assigned:antigravity:frontend#1", "accepted:implementation_ready:antigravity",
    "tests:true",
    "assigned:claude:review#1", "accepted:review_finding:claude",
    // Two corrections in a row, with no test or review of an incomplete candidate between them.
    "assigned:codex:backend#2", "accepted:implementation_ready:codex",
    "assigned:antigravity:frontend#2", "accepted:implementation_ready:antigravity",
    "tests:true",
    "assigned:claude:review#2", "accepted:review_finding:claude",
    "release_package_prepared"
  ])
  const pkg = result.snapshot.releasePackage
  assert.equal(pkg.correctionRounds, 2)
  assert.deepEqual(pkg.findings.map((entry) => [entry.code, entry.area, entry.status]), [
    ["wrong_status_code", "backend", "resolved"],
    ["missing_aria_label", "frontend", "resolved"]
  ])
  assert.equal(result.runner.outcome, "release_ready")
  assert.equal(result.snapshot.ownerDecision, null)
  // Evidence for both intermediate candidates and the first reviewed head is invalid; only the last head is current.
  assert.ok(result.invalidatedEvidence.length >= 4)
  assert.ok(result.evidenceCurrent[pkg.tests.ref] && result.evidenceCurrent[pkg.review.ref])
})

test("quota exhaustion: Codex exhausted routes backend to the approved trial alternate, then checkpoints for the only independent reviewer", async () => {
  const result = await runCollaborationSimulation(quota)
  assert.deepEqual(transcriptKeys(result), [
    "assigned:claude:backend#1",
    "accepted:contract_ready:claude",
    "assigned:antigravity:frontend#1",
    "accepted:implementation_ready:antigravity",
    "tests:true",
    "checkpoint",
    "trusted_capacity_observation",
    "assigned:codex:review#1",
    "accepted:review_finding:codex",
    "release_package_prepared"
  ])

  const backend = result.transcript.find((entry) => entry.stepId === "backend")
  assert.equal(backend.usedAlternate, true)
  assert.equal(backend.evaluationProvider, true)

  const checkpoint = result.transcript.find((entry) => entry.event === "checkpoint")
  assert.equal(checkpoint.reasonCode, "NO_ELIGIBLE_REVIEWER")
  assert.equal(checkpoint.kind, "blocked_capacity")
  // While blocked, no reviewer ran; the review was not bypassed.
  const events = result.events.map((event) => event.type)
  assert.ok(events.indexOf("checkpoint_entered") < events.indexOf("resume_requested"))
  assert.ok(result.outbox.some((entry) => entry.messageType === "owner_decision_required" && entry.reasonCode === "no_eligible_reviewer"))

  // After resume the reviewer is Codex, which implemented nothing here.
  assert.deepEqual(result.snapshot.implementers, ["antigravity", "claude"])
  assert.equal(result.snapshot.releasePackage.review.reviewer, "codex")
  assert.equal(result.stoppedAt, "awaiting_owner_approval")
  assert.equal(result.snapshot.ownerDecision, null)
})

test("quota exhaustion without an owner-approved alternate stops at a checkpoint", async () => {
  const result = await runCollaborationSimulation({ ...quota, id: "no-trial", claudeTrialRoles: [], recover: undefined })
  assert.equal(result.stoppedAt, "checkpoint")
  assert.equal(result.snapshot.checkpoint.kind, "blocked_capacity")
  assert.equal(result.adapterCalls.length, 0)
  assert.equal(result.snapshot.status, "planned")
})

test("provider unavailable and unknown states never route silently", async () => {
  for (const capacity of ["unavailable", "unknown", "rate_limited"]) {
    const result = await runCollaborationSimulation({
      ...quota, id: `codex-${capacity}`, claudeTrialRoles: [], recover: undefined,
      providerStates: { ...quota.providerStates, codex: { integration: "configured", capacity, billingPath: "included" } }
    })
    assert.equal(result.stoppedAt, "checkpoint", capacity)
    assert.equal(result.adapterCalls.length, 0, capacity)
  }
})

test("the simulation is deterministic: two runs produce identical hash-chained records", async () => {
  for (const scenario of Object.values(SIMULATION_SCENARIOS)) {
    const left = await runCollaborationSimulation(scenario)
    const right = await runCollaborationSimulation(scenario)
    assert.deepEqual(left.events.map((event) => event.hash), right.events.map((event) => event.hash))
    assert.equal(left.snapshot.releasePackage.packageHash, right.snapshot.releasePackage.packageHash)
    assert.equal(left.eventChainValid, true)
    assert.equal(verifyCollaborationEventChain(left.events), true)
  }
})

test("only fake adapters ran and the declared effects are all zero", async () => {
  for (const scenario of Object.values(SIMULATION_SCENARIOS)) {
    const result = await runCollaborationSimulation(scenario)
    assert.ok(result.adapterCalls.length > 0)
    assert.equal(assertSimulationIsSynthetic(result), true)
  }
  assert.ok(Object.isFrozen(SOFTWARE_FACTORY_COLLABORATION_SIMULATION_EFFECTS))
  assert.deepEqual(Object.values(SOFTWARE_FACTORY_COLLABORATION_SIMULATION_EFFECTS), [0, 0, 0, 0, 0])
  assert.throws(() => assertSimulationIsSynthetic({ adapterCalls: [{ fake: false }] }), { code: "COLLAB_SIMULATION_NOT_SYNTHETIC" })
})

test("running the simulation performs no network access, process spawn, or environment change", async () => {
  const originalFetch = globalThis.fetch
  const envBefore = JSON.stringify(process.env)
  let touched = 0
  globalThis.fetch = () => { touched += 1; throw new Error("network is forbidden in the offline simulation") }
  try {
    for (const scenario of Object.values(SIMULATION_SCENARIOS)) await runCollaborationSimulation(scenario)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(touched, 0)
  assert.equal(JSON.stringify(process.env), envBefore)
})

// Layering. The reusable layer is what a future real coordinator may import. The
// test-only layer is disposable simulation scaffolding and must stay isolated.
const REUSABLE_LAYER = [
  "software-factory-collaboration-contract.mjs",
  "software-factory-collaboration-routing.mjs",
  "software-factory-collaboration-handoff-rules.mjs"
]
const TEST_ONLY_LAYER = [
  "software-factory-collaboration-simulation-model.mjs",
  "software-factory-collaboration-simulation.mjs"
]
const collaborationSources = [...REUSABLE_LAYER, ...TEST_ONLY_LAYER]

function importsOf(name) {
  const source = readFileSync(join(here, name), "utf8")
  return [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)"/gmu)].map((match) => match[1])
}

test("layering: the reusable contract layer imports only node:crypto, the control-plane vocabulary and itself", () => {
  const allowed = {
    "software-factory-collaboration-contract.mjs": ["node:crypto", "./software-factory-control-plane.mjs"],
    "software-factory-collaboration-routing.mjs": ["./software-factory-control-plane.mjs", "./software-factory-collaboration-contract.mjs"],
    "software-factory-collaboration-handoff-rules.mjs": ["./software-factory-collaboration-contract.mjs"]
  }
  for (const name of REUSABLE_LAYER) {
    assert.deepEqual(importsOf(name).sort(), [...allowed[name]].sort(), `${name} import list changed`)
  }
})

test("layering: nothing reusable can import a lifecycle, the runner, run state, or any test-only file", () => {
  const forbidden = [
    /development-run-state/u, /development-hardening-orchestrator/u, /software-factory-release-/u, /software-factory-admission/u,
    /software-factory-autonomous-run/u, /software-factory-dispatch-checkpoint/u, /software-factory-plan-contract/u,
    /collaboration-simulation/u
  ]
  for (const name of REUSABLE_LAYER) {
    for (const specifier of importsOf(name)) {
      for (const pattern of forbidden) assert.ok(!pattern.test(specifier), `${name} imports ${specifier}`)
    }
  }
})

test("layering: only the test-only layer imports the existing lifecycle components, and only named read-only symbols", () => {
  const model = readFileSync(join(here, "software-factory-collaboration-simulation-model.mjs"), "utf8")
  const runState = [...model.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/development-run-state\.mjs"/gu)].map((match) => match[1].trim())
  assert.deepEqual(runState, ["ALLOWED_DEVELOPMENT_RUN_TRANSITIONS"])
  const simulation = readFileSync(join(here, "software-factory-collaboration-simulation.mjs"), "utf8")
  // The runner is constructed only through its injectable factory. The default
  // runner and the default execute function would read canonical run state.
  assert.match(simulation, /createSoftwareFactoryAutonomousRunner/u)
  assert.ok(!/executeSoftwareFactoryAutonomousRun/u.test(simulation))
  for (const dependency of ["listRuns", "readRun", "continueRun", "buildReleasePackage"]) {
    assert.match(simulation, new RegExp(`${dependency}[:,]`, "u"), `${dependency} must be injected`)
  }
  for (const name of TEST_ONLY_LAYER) {
    const source = readFileSync(join(here, name), "utf8")
    assert.match(source, /TEST-ONLY/u, `${name} must declare itself test-only`)
    assert.ok(!/transitionDevelopmentRun|createDevelopmentRun|recordDevelopmentRunProgress|DEVELOPMENT_RUN_STORE_DIR|development-runs/u.test(source), `${name} touches canonical state`)
  }
})

test("layering: the test-only layer is imported only by collaboration tests and itself", () => {
  const importers = readdirSync(here)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => /collaboration-simulation/u.test(readFileSync(join(here, name), "utf8")))
    .filter((name) => !TEST_ONLY_LAYER.includes(name))
  for (const name of importers) assert.match(name, /^software-factory-collaboration-.*\.test\.mjs$/u, `${name} imports a test-only fixture`)
})

test("static scan: direct imports are node:crypto or local modules (test file adds read-only fs for scanning)", () => {
  assert.equal(collaborationSources.length, 5)
  for (const name of collaborationSources) {
    for (const specifier of importsOf(name)) {
      if (specifier.startsWith("node:")) assert.equal(specifier, "node:crypto", `${name} imports ${specifier}`)
      else assert.ok(specifier.startsWith("./"), `${name} imports non-local ${specifier}`)
    }
    const source = readFileSync(join(here, name), "utf8")
    for (const forbidden of [/child_process/u, /\bspawn(?:Sync)?\b/u, /\bexecFile/u, /\bfetch\s*\(/u, /node:(?:net|http|https|dns|tls|dgram|fs|worker_threads|cluster|vm)\b/u, /process\.env/u, /process\.kill/u, /writeFile|appendFile|mkdir|rmSync|unlink/u, /Date\.now\s*\(/u, /Math\.random/u, /randomBytes|randomUUID/u]) {
      assert.ok(!forbidden.test(source), `${name} must not use ${forbidden}`)
    }
  }
})

test("static scan: broad process matching is only ever a rejection pattern, never an action", () => {
  for (const name of collaborationSources) {
    const lines = readFileSync(join(here, name), "utf8").split("\n")
    for (const line of lines) {
      if (/\b(?:pkill|killall)\b/u.test(line)) {
        assert.ok(/const commandPattern =/u.test(line) || /^\s*(?:\/\/|\*)/u.test(line), `${name}: ${line.trim().slice(0, 80)}`)
      }
    }
  }
})

test("static scan: nothing registers or imports the collaboration modules as a dispatcher", () => {
  const sourceFiles = readdirSync(here).filter((name) => name.endsWith(".mjs") && !/^software-factory-collaboration-/u.test(name))
  for (const name of sourceFiles) {
    const source = readFileSync(join(here, name), "utf8")
    assert.ok(!/software-factory-collaboration-/u.test(source), `${name} must not import collaboration modules`)
  }
  const commands = readFileSync(join(here, "commands.json"), "utf8")
  assert.ok(!/collaboration/iu.test(commands), "collaboration is not a registered command")
  const deployment = join(here, "..", "deployment")
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
  for (const path of walk(deployment).filter((file) => /\.(?:mjs|sh|plist|service|json)$/u.test(file))) {
    assert.ok(!/software-factory-collaboration-/u.test(readFileSync(path, "utf8")), `${path} must not reference collaboration modules`)
  }
})
