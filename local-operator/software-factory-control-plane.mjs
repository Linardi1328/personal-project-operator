export const SOFTWARE_FACTORY_CONTROL_PLANE_VERSION = 1

export const SOFTWARE_FACTORY_MODEL_CLASSES = Object.freeze([
  "none",
  "economy",
  "standard",
  "deep"
])

export const SOFTWARE_FACTORY_CAPACITY_STATES = Object.freeze([
  "available",
  "degraded",
  "exhausted",
  "rate_limited",
  "unavailable",
  "unknown"
])

export const SOFTWARE_FACTORY_INTEGRATION_STATES = Object.freeze([
  "configured",
  "unconfigured"
])

export const SOFTWARE_FACTORY_DISPATCH_OUTCOMES = Object.freeze([
  "ready",
  "blocked_capacity",
  "blocked_external",
  "owner_action_required"
])

export const SOFTWARE_FACTORY_CAPABILITIES = Object.freeze([
  "repository.inspect",
  "planning",
  "architecture",
  "implementation.backend",
  "implementation.frontend",
  "testing",
  "testing.browser",
  "debugging",
  "browser.runtime",
  "review.code",
  "review.frontend",
  "review.security",
  "review.release",
  "deployment.preview",
  "deployment.production"
])

const capabilitySet = new Set(SOFTWARE_FACTORY_CAPABILITIES)
const capacityStateSet = new Set(SOFTWARE_FACTORY_CAPACITY_STATES)
const integrationStateSet = new Set(SOFTWARE_FACTORY_INTEGRATION_STATES)
const modelClassSet = new Set(SOFTWARE_FACTORY_MODEL_CLASSES)

const MODEL_CLASS_RANK = Object.freeze({
  none: 0,
  economy: 1,
  standard: 2,
  deep: 3
})

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

export class SoftwareFactoryControlPlaneError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryControlPlaneError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function controlPlaneError(code, safeMessage) {
  return new SoftwareFactoryControlPlaneError(code, safeMessage)
}

export const SOFTWARE_FACTORY_WORKERS = deepFreeze({
  chatgpt: {
    workerId: "chatgpt",
    kind: "reasoning",
    adapterId: null
  },
  antigravity: {
    workerId: "antigravity",
    kind: "implementation",
    adapterId: null,
    readinessAdapterId: "software-factory-v0-antigravity-readiness"
  },
  "github-ci": {
    workerId: "github-ci",
    kind: "deterministic-tool",
    adapterId: null
  },
  playwright: {
    workerId: "playwright",
    kind: "deterministic-tool",
    adapterId: null
  },
  "chrome-devtools": {
    workerId: "chrome-devtools",
    kind: "deterministic-tool",
    adapterId: null
  },
  coderabbit: {
    workerId: "coderabbit",
    kind: "review-tool",
    adapterId: null
  },
  vercel: {
    workerId: "vercel",
    kind: "deployment-tool",
    adapterId: null
  }
})

export const SOFTWARE_FACTORY_CAPABILITY_POLICY = deepFreeze({
  "repository.inspect": {
    workerId: "chatgpt",
    modelClass: "economy",
    ownerApprovalRequired: false,
    skills: []
  },
  planning: {
    workerId: "chatgpt",
    modelClass: "standard",
    ownerApprovalRequired: false,
    skills: []
  },
  architecture: {
    workerId: "chatgpt",
    modelClass: "deep",
    ownerApprovalRequired: false,
    skills: []
  },
  "implementation.backend": {
    workerId: "antigravity",
    modelClass: "standard",
    ownerApprovalRequired: false,
    skills: []
  },
  "implementation.frontend": {
    workerId: "antigravity",
    modelClass: "standard",
    ownerApprovalRequired: false,
    skills: ["ui-ux-pro-max"]
  },
  testing: {
    workerId: "github-ci",
    modelClass: "none",
    ownerApprovalRequired: false,
    skills: []
  },
  "testing.browser": {
    workerId: "playwright",
    modelClass: "none",
    ownerApprovalRequired: false,
    skills: []
  },
  debugging: {
    workerId: "antigravity",
    modelClass: "standard",
    ownerApprovalRequired: false,
    skills: ["debugging-and-error-recovery"]
  },
  "browser.runtime": {
    workerId: "chrome-devtools",
    modelClass: "none",
    ownerApprovalRequired: false,
    skills: []
  },
  "review.code": {
    workerId: "coderabbit",
    modelClass: "none",
    ownerApprovalRequired: false,
    skills: []
  },
  "review.frontend": {
    workerId: "antigravity",
    modelClass: "standard",
    ownerApprovalRequired: false,
    skills: ["web-design-guidelines"]
  },
  "review.security": {
    workerId: "chatgpt",
    modelClass: "deep",
    ownerApprovalRequired: false,
    skills: []
  },
  "review.release": {
    workerId: "chatgpt",
    modelClass: "deep",
    ownerApprovalRequired: false,
    skills: []
  },
  "deployment.preview": {
    workerId: "vercel",
    modelClass: "none",
    ownerApprovalRequired: false,
    skills: []
  },
  "deployment.production": {
    workerId: "vercel",
    modelClass: "none",
    ownerApprovalRequired: true,
    skills: []
  }
})

function normalizeCapability(capability) {
  const normalized = String(capability ?? "").trim()

  if (!capabilitySet.has(normalized)) {
    throw controlPlaneError(
      "FACTORY_CAPABILITY_UNKNOWN",
      "Software factory capability is not reviewed."
    )
  }

  return normalized
}

function normalizeFailedAttempts(value) {
  if (value === undefined || value === null) {
    return 0
  }

  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw controlPlaneError(
      "FACTORY_ATTEMPT_COUNT_INVALID",
      "Software factory failed-attempt count is invalid."
    )
  }

  return value
}

function normalizeRisk(value) {
  const normalized = value === undefined || value === null ? "normal" : String(value).trim()

  if (!new Set(["low", "normal", "high"]).has(normalized)) {
    throw controlPlaneError(
      "FACTORY_RISK_INVALID",
      "Software factory task risk is invalid."
    )
  }

  return normalized
}

export function resolveSoftwareFactoryModelClass(capability, options = {}) {
  const normalizedCapability = normalizeCapability(capability)
  const policy = SOFTWARE_FACTORY_CAPABILITY_POLICY[normalizedCapability]
  const failedAttempts = normalizeFailedAttempts(options.failedAttempts)
  const risk = normalizeRisk(options.risk)
  let modelClass = policy.modelClass

  if (!modelClassSet.has(modelClass)) {
    throw controlPlaneError(
      "FACTORY_MODEL_POLICY_INVALID",
      "Software factory model policy is invalid."
    )
  }

  if (modelClass === "none") {
    return "none"
  }

  if (risk === "high" && MODEL_CLASS_RANK[modelClass] < MODEL_CLASS_RANK.deep) {
    modelClass = "deep"
  } else if (failedAttempts >= 2 && MODEL_CLASS_RANK[modelClass] < MODEL_CLASS_RANK.deep) {
    modelClass = "deep"
  } else if (failedAttempts >= 1 && modelClass === "economy") {
    modelClass = "standard"
  }

  return modelClass
}

function normalizeWorkerState(workerId, workerStates) {
  const state = workerStates?.[workerId]

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return {
      integration: "unconfigured",
      capacity: "unknown"
    }
  }

  const integration = String(state.integration ?? "").trim()
  const capacity = String(state.capacity ?? "").trim()

  if (!integrationStateSet.has(integration) || !capacityStateSet.has(capacity)) {
    throw controlPlaneError(
      "FACTORY_WORKER_STATE_INVALID",
      "Software factory worker state is invalid."
    )
  }

  return { integration, capacity }
}

export function describeSoftwareFactoryCapability(capability, options = {}) {
  const normalizedCapability = normalizeCapability(capability)
  const policy = SOFTWARE_FACTORY_CAPABILITY_POLICY[normalizedCapability]

  return deepFreeze({
    controlPlaneVersion: SOFTWARE_FACTORY_CONTROL_PLANE_VERSION,
    capability: normalizedCapability,
    workerId: policy.workerId,
    workerKind: SOFTWARE_FACTORY_WORKERS[policy.workerId].kind,
    modelClass: resolveSoftwareFactoryModelClass(normalizedCapability, options),
    ownerApprovalRequired: policy.ownerApprovalRequired,
    skills: [...policy.skills]
  })
}

export function assessSoftwareFactoryDispatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw controlPlaneError(
      "FACTORY_DISPATCH_INPUT_INVALID",
      "Software factory dispatch input is invalid."
    )
  }

  const capability = normalizeCapability(input.capability)
  const policy = SOFTWARE_FACTORY_CAPABILITY_POLICY[capability]
  const modelClass = resolveSoftwareFactoryModelClass(capability, {
    failedAttempts: input.failedAttempts,
    risk: input.risk
  })
  const worker = SOFTWARE_FACTORY_WORKERS[policy.workerId]
  const workerState = normalizeWorkerState(worker.workerId, input.workerStates)
  const base = {
    controlPlaneVersion: SOFTWARE_FACTORY_CONTROL_PLANE_VERSION,
    capability,
    workerId: worker.workerId,
    modelClass,
    skills: [...policy.skills],
    ownerApprovalRequired: policy.ownerApprovalRequired
  }

  if (policy.ownerApprovalRequired) {
    return deepFreeze({
      ...base,
      outcome: "owner_action_required",
      reasonCode: "OWNER_APPROVAL_REQUIRED",
      retryable: false,
      consumeAttempt: false
    })
  }

  if (workerState.integration !== "configured") {
    return deepFreeze({
      ...base,
      outcome: "blocked_external",
      reasonCode: "WORKER_INTEGRATION_UNCONFIGURED",
      retryable: false,
      consumeAttempt: false
    })
  }

  if (workerState.capacity === "exhausted" || workerState.capacity === "rate_limited") {
    return deepFreeze({
      ...base,
      outcome: "blocked_capacity",
      reasonCode: workerState.capacity === "exhausted"
        ? "WORKER_CAPACITY_EXHAUSTED"
        : "WORKER_RATE_LIMITED",
      retryable: true,
      consumeAttempt: false
    })
  }

  if (workerState.capacity === "unavailable" || workerState.capacity === "unknown") {
    return deepFreeze({
      ...base,
      outcome: "blocked_external",
      reasonCode: workerState.capacity === "unavailable"
        ? "WORKER_UNAVAILABLE"
        : "WORKER_CAPACITY_UNKNOWN",
      retryable: workerState.capacity === "unavailable",
      consumeAttempt: false
    })
  }

  return deepFreeze({
    ...base,
    outcome: "ready",
    reasonCode: workerState.capacity === "degraded"
      ? "WORKER_DEGRADED"
      : "WORKER_READY",
    retryable: false,
    consumeAttempt: true
  })
}

export function formatSoftwareFactoryControlPlaneError(error) {
  if (error instanceof SoftwareFactoryControlPlaneError) {
    return `PPO software factory control-plane error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory control-plane error: unexpected local failure."
}
