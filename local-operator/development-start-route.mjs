import { createHash } from "node:crypto"
import {
  NEXT_STAGE_PLANNER_ID,
  createPlannedDevelopmentRun
} from "./development-next-stage-planner.mjs"
import {
  getOrdinaryDevelopmentProject,
  listOrdinaryDevelopmentProjects
} from "./github-project-registry.mjs"

export const DEVELOPMENT_START_ROUTE_ID = "phase-7a-controlled-ppo-start-route"
export const PHASE_7A_START_POLICY_ID = "phase-7a-controlled-ppo-start-policy"
export const MAX_PHASE_7A_START_OUTPUT_CHARS = 4096

const allowedProjects = Object.freeze(listOrdinaryDevelopmentProjects().map((project) => project.id))
const allowedProjectSet = new Set(allowedProjects)
const allowedNextStageSet = new Set(["planning", "implementation"])
const trustedPhase6BOptionKeys = Object.freeze([
  "writeDataDir",
  "now",
  "repoRoot",
  "sources",
  "sourceReader",
  "githubClient",
  "githubOptions",
  "randomBytesImpl"
])
const shaPattern = /^[a-f0-9]{40}$/u
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,79}$/u
const safeStatusPattern = /^[a-z][a-z0-9_]{0,79}$/u
const unsafeInputTextPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const unsafeOutputTextPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0009\u000B-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = new RegExp([
  "SENSITIVE_TEST_SENTINEL",
  `gi${"thub_pat_"}[A-Za-z0-9_]+`,
  `${"g"}${"h"}[opusr]_[A-Za-z0-9_]+`,
  "sk-[A-Za-z0-9_-]{8,}",
  "BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY",
  "authorization\\s*:",
  "password\\s*[=:]",
  "token\\s*[=:]",
  "secret\\s*[=:]",
  "credential\\s*[=:]",
  "PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD)"
].join("|"), "iu")

const policyBoundary = Object.freeze({
  route: DEVELOPMENT_START_ROUTE_ID,
  policy: PHASE_7A_START_POLICY_ID,
  schemaVersion: 1,
  callerInput: Object.freeze(["projectId"]),
  inputShape: "exact-one-allowlisted-project-id",
  allowedProjects,
  phase6bReuse: Object.freeze({
    api: "createPlannedDevelopmentRun",
    planner: NEXT_STAGE_PLANNER_ID
  }),
  phase6bInvocation: Object.freeze({
    callerControlledOptionsForwarded: false,
    trustedRuntimeInjection: "explicit-internal-allowlist"
  }),
  runCreation: Object.freeze({
    onPlannedOutcome: "exactly-one-phase-6a-run",
    onOwnerActionRequired: "zero-runs"
  }),
  plannedResultValidation: Object.freeze({
    projectConsistency: "requested-plan-run-match-allowlist",
    requiredRunStatus: "planned",
    requiredNextStages: Object.freeze(["planning", "implementation"]),
    requiredShaConsistency: "plan-base-run-base-run-head-equal"
  }),
  openClaw: Object.freeze({
    existingToolOnly: "ppo_local",
    newTool: false,
    modelRouting: false
  }),
  automaticContinuation: false,
  workspaceCreation: false,
  codexExecution: false,
  testExecution: false,
  reviewExecution: false,
  githubWrite: false,
  gitMutation: false,
  productionActions: false,
  deployment: false,
  productionVerification: false,
  rollback: false,
  maxOutputChars: MAX_PHASE_7A_START_OUTPUT_CHARS
})

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

export const PHASE_7A_START_POLICY_HASH = createHash("sha256")
  .update(stableStringify(policyBoundary))
  .digest("hex")

function routePolicy() {
  return {
    id: PHASE_7A_START_POLICY_ID,
    hash: PHASE_7A_START_POLICY_HASH
  }
}

function allowedProjectIdList() {
  return allowedProjects.join(", ")
}

function safeProjectId(value) {
  return typeof value === "string" && allowedProjectSet.has(value) ? value : "unknown"
}

function safeRunId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null
}

function safeStatus(value, fallback = "unavailable") {
  return typeof value === "string" && safeStatusPattern.test(value) ? value : fallback
}

function safeSha(value) {
  return typeof value === "string" && shaPattern.test(value) ? value : null
}

function safeReasonCode(value, fallback = "ROUTE_UNAVAILABLE") {
  return typeof value === "string" && safeCodePattern.test(value) ? value : fallback
}

function isSafeOutput(output) {
  return (
    typeof output === "string" &&
    output.length > 0 &&
    output.length <= MAX_PHASE_7A_START_OUTPUT_CHARS &&
    !unsafeOutputTextPattern.test(output) &&
    !sensitiveTextPattern.test(output)
  )
}

function validateProjectId(projectId) {
  if (typeof projectId !== "string" || projectId !== projectId.trim() || unsafeInputTextPattern.test(projectId)) {
    return {
      ok: false,
      code: "INVALID_PROJECT"
    }
  }

  if (!allowedProjectSet.has(projectId) || !getOrdinaryDevelopmentProject(projectId)) {
    return {
      ok: false,
      code: "UNKNOWN_PROJECT"
    }
  }

  return {
    ok: true,
    projectId
  }
}

function routeResult({ ok, code, output, outcome = code }) {
  const safeOutput = isSafeOutput(output)
    ? output
    : [
      "PPO Development Start",
      "Status: unavailable",
      "Outcome: owner_action_required",
      "Reason: ROUTE_UNAVAILABLE"
    ].join("\n")

  return {
    schemaVersion: 1,
    route: DEVELOPMENT_START_ROUTE_ID,
    policy: routePolicy(),
    ok: ok === true && safeOutput === output,
    code: safeReasonCode(code),
    outcome,
    output: safeOutput
  }
}

function invalidProjectOutput(code) {
  return [
    "PPO Development Start",
    "Status: refused",
    "Outcome: owner_action_required",
    `Reason: ${safeReasonCode(code)}`,
    `Allowed projects: ${allowedProjectIdList()}`
  ].join("\n")
}

function ownerActionOutput(projectId, plan) {
  return [
    "PPO Development Start",
    `Project: ${safeProjectId(projectId)}`,
    "Status: owner_action_required",
    "Outcome: owner_action_required",
    `Reason: ${safeReasonCode(plan?.reasonCode || "OWNER_ACTION_REQUIRED")}`,
    "Run: none"
  ].join("\n")
}

function routeUnavailableOutput(projectId) {
  return [
    "PPO Development Start",
    `Project: ${safeProjectId(projectId)}`,
    "Status: unavailable",
    "Outcome: owner_action_required",
    "Reason: ROUTE_UNAVAILABLE",
    "Run: none"
  ].join("\n")
}

function plannedOutput(planned) {
  return [
    "PPO Development Start",
    `Project: ${planned.projectId}`,
    `Run: ${planned.runId}`,
    `Status: ${planned.status}`,
    `Next stage: ${planned.nextStage}`,
    `Base SHA: ${planned.baseSha}`,
    `Next command: /ppo continue ${planned.runId}`
  ].join("\n")
}

function plannerApi(runtime = {}) {
  const dependencies = runtime && typeof runtime === "object" && runtime.trustedDependencies &&
    typeof runtime.trustedDependencies === "object" &&
    !Array.isArray(runtime.trustedDependencies)
    ? runtime.trustedDependencies
    : {}

  return typeof dependencies.createPlannedDevelopmentRun === "function"
    ? dependencies.createPlannedDevelopmentRun
    : createPlannedDevelopmentRun
}

function buildTrustedPhase6BOptions(runtime = {}) {
  const trusted = runtime && typeof runtime === "object" && runtime.trustedPhase6BOptions &&
    typeof runtime.trustedPhase6BOptions === "object" &&
    !Array.isArray(runtime.trustedPhase6BOptions)
    ? runtime.trustedPhase6BOptions
    : {}
  const phase6bOptions = {}

  for (const key of trustedPhase6BOptionKeys) {
    if (Object.hasOwn(trusted, key)) {
      phase6bOptions[key] = trusted[key]
    }
  }

  return phase6bOptions
}

function validatePlannedResult(requestedProjectId, result) {
  const plan = result?.plan
  const run = result?.run
  const planProjectId = plan?.project?.id
  const runProjectId = run?.project?.id
  const runId = safeRunId(run?.runId)
  const planBaseSha = safeSha(plan?.baseSha)
  const runBaseSha = safeSha(run?.baseSha)
  const runHeadSha = safeSha(run?.headSha)
  const nextStage = plan?.next?.stage

  if (
    result?.ok !== true ||
    result?.outcome !== "planned" ||
    plan?.outcome !== "planned" ||
    !allowedProjectSet.has(requestedProjectId) ||
    planProjectId !== requestedProjectId ||
    runProjectId !== requestedProjectId ||
    !allowedProjectSet.has(planProjectId) ||
    !allowedProjectSet.has(runProjectId) ||
    run?.status !== "planned" ||
    !runId ||
    !allowedNextStageSet.has(nextStage) ||
    !planBaseSha ||
    !runBaseSha ||
    !runHeadSha ||
    planBaseSha !== runBaseSha ||
    runHeadSha !== planBaseSha
  ) {
    return {
      ok: false
    }
  }

  return {
    ok: true,
    projectId: requestedProjectId,
    runId,
    status: safeStatus(run.status),
    nextStage,
    baseSha: planBaseSha
  }
}

export async function handlePpoDevelopmentStartCommand(projectId, runtime = {}) {
  const validation = validateProjectId(projectId)

  if (!validation.ok) {
    return routeResult({
      ok: false,
      code: validation.code,
      outcome: "owner_action_required",
      output: invalidProjectOutput(validation.code)
    })
  }

  try {
    const result = await plannerApi(runtime)(validation.projectId, buildTrustedPhase6BOptions(runtime))

    if (result?.ok === true && result?.outcome === "planned") {
      const planned = validatePlannedResult(validation.projectId, result)

      if (!planned.ok) {
        return routeResult({
          ok: false,
          code: "ROUTE_UNAVAILABLE",
          outcome: "owner_action_required",
          output: routeUnavailableOutput(validation.projectId)
        })
      }

      return routeResult({
        ok: true,
        code: "PLANNED",
        outcome: "planned",
        output: plannedOutput(planned)
      })
    }

    return routeResult({
      ok: false,
      code: safeReasonCode(result?.plan?.reasonCode || "OWNER_ACTION_REQUIRED"),
      outcome: "owner_action_required",
      output: ownerActionOutput(validation.projectId, result?.plan)
    })
  } catch {
    return routeResult({
      ok: false,
      code: "ROUTE_UNAVAILABLE",
      outcome: "owner_action_required",
      output: routeUnavailableOutput(validation.projectId)
    })
  }
}
