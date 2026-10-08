import { createHash } from "node:crypto"

export const SOFTWARE_FACTORY_PLAN_CONTRACT_ID = "software-factory-v1-5-plan-contract"
export const SOFTWARE_FACTORY_PLAN_SCHEMA_VERSION = 1
export const SOFTWARE_FACTORY_PLAN_MAX_LIST_ITEMS = 5
export const SOFTWARE_FACTORY_PLAN_MAX_ITEM_CHARS = 140

const shaPattern = /^[a-f0-9]{40}$/u
const hashPattern = /^[a-f0-9]{64}$/u
const runIdPattern = /^[A-Za-z0-9_-]{43}$/u
const projectIdPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const unsafeControlPattern = /[\u0000-\u001F\u007F-\u009F]/u
const sensitiveTextPattern = /(?:github_pat_|gh[opusr]_|sk-|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const capabilities = new Set(["implementation.backend", "implementation.frontend", "debugging"])
const risks = new Set(["low", "normal", "high"])

export class SoftwareFactoryPlanContractError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryPlanContractError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function planError(code, safeMessage) {
  return new SoftwareFactoryPlanContractError(code, safeMessage)
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeText(value, label, maxChars = SOFTWARE_FACTORY_PLAN_MAX_ITEM_CHARS) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw planError("FACTORY_PLAN_INVALID", `${label} is invalid.`)
  }

  const normalized = value.trim()

  if (!normalized || normalized.length > maxChars || unsafeControlPattern.test(normalized) || sensitiveTextPattern.test(normalized)) {
    throw planError("FACTORY_PLAN_INVALID", `${label} is invalid.`)
  }

  return normalized
}

function normalizeList(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > SOFTWARE_FACTORY_PLAN_MAX_LIST_ITEMS) {
    throw planError("FACTORY_PLAN_INVALID", `${label} is invalid.`)
  }

  const normalized = value.map((entry) => normalizeText(entry, label))

  if (new Set(normalized).size !== normalized.length) {
    throw planError("FACTORY_PLAN_INVALID", `${label} contains duplicate entries.`)
  }

  return normalized
}

function classifyCapability(objective) {
  const text = objective.toLowerCase()
  const frontend = /\b(frontend|ui|ux|browser|css|layout|responsive|accessibility|cta|visual|dom|client-side|page|component|form)\b/u
  const debugging = /\bdebug(?:ging)?\b|\bdiagnos(?:e|is|tic)\b|\binvestigat(?:e|ion)\b|\broot cause\b|\bfailing (?:test|build|ci)\b|\breproduce (?:bug|issue|failure)\b|\bfix (?:bug|error|crash|failure)\b/u

  if (frontend.test(text)) return "implementation.frontend"
  if (debugging.test(text)) return "debugging"
  return "implementation.backend"
}

function classifyRisk(objective) {
  const text = objective.toLowerCase()

  if (/\b(auth(?:entication|orization)?|payment|billing|security|encryption|secret|credential|production|deploy(?:ment)?|destructive|database migration|schema migration|infrastructure)\b/u.test(text)) {
    return "high"
  }

  if (/\b(refactor|dependency|migration|database|schema|api|integration)\b/u.test(text)) {
    return "normal"
  }

  return "low"
}

function planHashPayload(plan) {
  const {
    planHash: _ignored,
    ...payload
  } = plan
  return payload
}

export function validateSoftwareFactoryPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw planError("FACTORY_PLAN_INVALID", "Software factory plan is invalid.")
  }

  const expectedKeys = [
    "schemaVersion",
    "runId",
    "projectId",
    "baseSha",
    "objectiveHash",
    "goal",
    "acceptanceCriteria",
    "constraints",
    "exclusions",
    "capabilityHint",
    "risk",
    "origin",
    "planHash"
  ].sort()
  const actualKeys = Object.keys(input).sort()

  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw planError("FACTORY_PLAN_INVALID", "Software factory plan fields are invalid.")
  }

  if (input.schemaVersion !== SOFTWARE_FACTORY_PLAN_SCHEMA_VERSION) {
    throw planError("FACTORY_PLAN_SCHEMA_UNSUPPORTED", "Software factory plan schema is not supported.")
  }

  const runId = String(input.runId ?? "").trim()
  const projectId = String(input.projectId ?? "").trim()
  const baseSha = String(input.baseSha ?? "").trim().toLowerCase()
  const objectiveHash = String(input.objectiveHash ?? "").trim().toLowerCase()
  const capabilityHint = String(input.capabilityHint ?? "").trim()
  const risk = String(input.risk ?? "").trim()
  const origin = normalizeText(input.origin, "Plan origin", 80)

  if (!runIdPattern.test(runId) || !projectIdPattern.test(projectId) || !shaPattern.test(baseSha) || !hashPattern.test(objectiveHash)) {
    throw planError("FACTORY_PLAN_BINDING_INVALID", "Software factory plan binding is invalid.")
  }

  if (!capabilities.has(capabilityHint) || !risks.has(risk)) {
    throw planError("FACTORY_PLAN_POLICY_INVALID", "Software factory plan policy is invalid.")
  }

  const plan = {
    schemaVersion: SOFTWARE_FACTORY_PLAN_SCHEMA_VERSION,
    runId,
    projectId,
    baseSha,
    objectiveHash,
    goal: normalizeText(input.goal, "Plan goal"),
    acceptanceCriteria: normalizeList(input.acceptanceCriteria, "Plan acceptance criterion"),
    constraints: normalizeList(input.constraints, "Plan constraint"),
    exclusions: normalizeList(input.exclusions, "Plan exclusion"),
    capabilityHint,
    risk,
    origin,
    planHash: String(input.planHash ?? "").trim().toLowerCase()
  }

  if (!hashPattern.test(plan.planHash) || sha256(stableStringify(planHashPayload(plan))) !== plan.planHash) {
    throw planError("FACTORY_PLAN_HASH_MISMATCH", "Software factory plan hash does not match its bounded content.")
  }

  return Object.freeze({
    ...plan,
    acceptanceCriteria: Object.freeze([...plan.acceptanceCriteria]),
    constraints: Object.freeze([...plan.constraints]),
    exclusions: Object.freeze([...plan.exclusions])
  })
}

export function buildBaselineSoftwareFactoryPlan({ runId, projectId, baseSha, objective }) {
  if (typeof objective !== "string" || objective !== objective.trim() || !objective.trim() || objective.length > 1000 || unsafeControlPattern.test(objective) || sensitiveTextPattern.test(objective)) {
    throw planError("FACTORY_PLAN_OBJECTIVE_INVALID", "Software factory owner objective is invalid.")
  }

  const draft = {
    schemaVersion: SOFTWARE_FACTORY_PLAN_SCHEMA_VERSION,
    runId,
    projectId,
    baseSha: String(baseSha ?? "").toLowerCase(),
    objectiveHash: sha256(objective),
    goal: "Complete the owner objective exactly within the reviewed PPO Software Factory boundaries.",
    acceptanceCriteria: [
      "Implement the owner objective as written without expanding product scope.",
      "All repository-required deterministic quality gates must pass.",
      "Independent review must report no blocking finding at the reviewed head SHA.",
      "Release evidence must remain pinned to the exact reviewed head SHA."
    ],
    constraints: [
      "Preserve unrelated behavior and make the smallest correct change set.",
      "Use only approved workers, skills, model policy, and isolated workspace boundaries.",
      "Implementation may not mutate remote Git state, deploy, or access production systems."
    ],
    exclusions: [
      "No unrequested architecture replacement, paid service, broad refactor, or dependency expansion.",
      "No credential or secret changes during implementation.",
      "No destructive migration, auth or payment architecture change, or production deployment unless separately permitted by policy."
    ],
    capabilityHint: classifyCapability(objective),
    risk: classifyRisk(objective),
    origin: "deterministic_baseline",
    planHash: ""
  }
  draft.planHash = sha256(stableStringify(planHashPayload(draft)))
  return validateSoftwareFactoryPlan(draft)
}

export function softwareFactoryPlanEvidence(planInput) {
  const plan = validateSoftwareFactoryPlan(planInput)

  return {
    kind: "planning",
    sha: plan.baseSha,
    source: SOFTWARE_FACTORY_PLAN_CONTRACT_ID,
    summary: "Validated structured Software Factory plan bound to the owner objective and exact base SHA.",
    metadata: {
      schemaVersion: plan.schemaVersion,
      runId: plan.runId,
      project: plan.projectId,
      objectiveHash: plan.objectiveHash,
      planHash: plan.planHash,
      goal: plan.goal,
      criteria: plan.acceptanceCriteria,
      constraints: plan.constraints,
      exclusions: plan.exclusions,
      capability: plan.capabilityHint,
      risk: plan.risk,
      origin: plan.origin
    }
  }
}

export function latestSoftwareFactoryPlan(run) {
  const entries = Array.isArray(run?.evidence?.planning) ? run.evidence.planning : []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (entry?.source !== SOFTWARE_FACTORY_PLAN_CONTRACT_ID || entry?.sha !== run?.baseSha) {
      continue
    }

    const metadata = entry.metadata || {}
    const plan = {
      schemaVersion: metadata.schemaVersion,
      runId: metadata.runId,
      projectId: metadata.project,
      baseSha: entry.sha,
      objectiveHash: metadata.objectiveHash,
      goal: metadata.goal,
      acceptanceCriteria: metadata.criteria,
      constraints: metadata.constraints,
      exclusions: metadata.exclusions,
      capabilityHint: metadata.capability,
      risk: metadata.risk,
      origin: metadata.origin,
      planHash: metadata.planHash
    }

    try {
      const validated = validateSoftwareFactoryPlan(plan)
      const currentObjectiveHash = typeof run?.task === "string" ? sha256(run.task) : null

      if (
        validated.runId === run.runId &&
        validated.projectId === run?.project?.id &&
        validated.baseSha === run.baseSha &&
        validated.objectiveHash === currentObjectiveHash
      ) {
        return validated
      }
    } catch {
      return null
    }
  }

  return null
}

export function formatSoftwareFactoryPlanError(error) {
  if (error instanceof SoftwareFactoryPlanContractError) {
    return `PPO software factory plan error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory plan error: unexpected local failure."
}
