import {
  CUSTOMER_ZERO_OWNER_ID,
  CUSTOMER_ZERO_WORKSPACE_ID,
  validateCustomerZeroOwnershipContext
} from "./customer-zero-ownership-context.mjs"
import {
  getApprovedDevelopmentProject,
  listOrdinaryDevelopmentProjects,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
} from "./github-project-registry.mjs"

const identifierPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const connectionFields = new Set(["connectionId", "ownerId", "workspaceId", "providerId"])
const resolutionFields = new Set(["ownershipContext", "capability", "connectionReference"])
const capabilities = Object.freeze(["backend", "frontend", "optional-frontend", "preview", "deployment"])

export class CustomerZeroProviderContractError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "CustomerZeroProviderContractError"
    this.code = code
  }
}

function refuse(code, message) {
  throw new CustomerZeroProviderContractError(code, message)
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    refuse("PROVIDER_IDENTIFIER_INVALID", `${label} is invalid.`)
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

export function validateWorkspaceConnectionReference(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    refuse("CONNECTION_REFERENCE_INVALID", "Connection reference must be a plain object.")
  }
  const keys = Object.keys(reference)
  if (keys.length !== connectionFields.size || keys.some((key) => !connectionFields.has(key))) {
    refuse("CONNECTION_REFERENCE_INVALID", "Connection reference fields are invalid.")
  }
  for (const field of connectionFields) {
    requireIdentifier(reference[field], field)
  }
  if (reference.ownerId !== CUSTOMER_ZERO_OWNER_ID || reference.workspaceId !== CUSTOMER_ZERO_WORKSPACE_ID) {
    refuse("CONNECTION_OWNERSHIP_MISMATCH", "Connection does not belong to the fixed Customer Zero workspace.")
  }
  return deepFreeze({ ...reference })
}

export const CUSTOMER_ZERO_PROVIDER_CONTRACTS = deepFreeze({
  codex: {
    providerId: "codex",
    capabilities: ["backend"],
    state: "available",
    adapterId: "phase-6d-codex-execution-adapter",
    fallbackAllowed: false
  },
  antigravity: {
    providerId: "antigravity",
    capabilities: ["frontend"],
    state: "unavailable",
    adapterId: null,
    fallbackAllowed: false
  },
  lovable: {
    providerId: "lovable",
    capabilities: ["optional-frontend"],
    state: "disabled",
    adapterId: null,
    fallbackAllowed: false
  },
  vercel: {
    providerId: "vercel",
    capabilities: ["preview", "deployment"],
    state: "disabled",
    adapterId: null,
    fallbackAllowed: false
  }
})

export const CUSTOMER_ZERO_CONNECTION_REFERENCES = deepFreeze({
  "customer-zero-codex": validateWorkspaceConnectionReference({
    connectionId: "customer-zero-codex",
    ownerId: CUSTOMER_ZERO_OWNER_ID,
    workspaceId: CUSTOMER_ZERO_WORKSPACE_ID,
    providerId: "codex"
  }),
  "customer-zero-antigravity": validateWorkspaceConnectionReference({
    connectionId: "customer-zero-antigravity",
    ownerId: CUSTOMER_ZERO_OWNER_ID,
    workspaceId: CUSTOMER_ZERO_WORKSPACE_ID,
    providerId: "antigravity"
  })
})

const fixedRolePolicy = deepFreeze({
  backend: { providerId: "codex", connectionId: "customer-zero-codex" },
  frontend: { providerId: "antigravity", connectionId: "customer-zero-antigravity" },
  "optional-frontend": { providerId: "lovable", connectionId: null },
  preview: { providerId: "vercel", connectionId: null },
  deployment: { providerId: "vercel", connectionId: null }
})

const projectIds = Object.freeze([
  ...listOrdinaryDevelopmentProjects().map((project) => project.id),
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id
])

export const CUSTOMER_ZERO_PROJECT_PROVIDER_POLICIES = deepFreeze(Object.fromEntries(
  projectIds.map((projectId) => [projectId, {
    projectId,
    roles: fixedRolePolicy
  }])
))

export function getCustomerZeroProviderContract(providerId) {
  return typeof providerId === "string" && Object.hasOwn(CUSTOMER_ZERO_PROVIDER_CONTRACTS, providerId)
    ? CUSTOMER_ZERO_PROVIDER_CONTRACTS[providerId]
    : null
}

export function getCustomerZeroProjectProviderPolicy(projectId) {
  return getApprovedDevelopmentProject(projectId)
    ? Object.hasOwn(CUSTOMER_ZERO_PROJECT_PROVIDER_POLICIES, projectId)
      ? CUSTOMER_ZERO_PROJECT_PROVIDER_POLICIES[projectId]
      : null
    : null
}

function sameConnection(left, right) {
  return [...connectionFields].every((field) => left[field] === right[field])
}

export function resolveCustomerZeroProvider(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !resolutionFields.has(key)) ||
    !Object.hasOwn(input, "ownershipContext") ||
    !Object.hasOwn(input, "capability")
  ) {
    refuse("PROVIDER_RESOLUTION_INVALID", "Provider resolution input is invalid.")
  }
  const { ownershipContext, capability, connectionReference } = input
  const context = validateCustomerZeroOwnershipContext(ownershipContext)
  if (!capabilities.includes(capability)) {
    refuse("PROVIDER_CAPABILITY_UNKNOWN", "Provider capability is not reviewed.")
  }
  const policy = getCustomerZeroProjectProviderPolicy(context.projectId)
  const selection = policy?.roles?.[capability]
  const provider = selection && getCustomerZeroProviderContract(selection.providerId)
  if (!selection || !provider || !provider.capabilities.includes(capability)) {
    refuse("PROVIDER_POLICY_INVALID", "Approved project provider policy is invalid.")
  }

  let connection = null
  if (selection.connectionId !== null) {
    const expected = CUSTOMER_ZERO_CONNECTION_REFERENCES[selection.connectionId]
    connection = connectionReference === undefined
      ? expected
      : validateWorkspaceConnectionReference(connectionReference)
    if (!expected || !sameConnection(connection, expected) || connection.providerId !== provider.providerId) {
      refuse("CONNECTION_REFERENCE_MISMATCH", "Connection does not match approved project provider policy.")
    }
  } else if (connectionReference !== undefined && connectionReference !== null) {
    refuse("CONNECTION_REFERENCE_MISMATCH", "Disabled provider policy accepts no connection reference.")
  }

  return deepFreeze({
    ok: provider.state === "available",
    outcome: provider.state === "available" ? "provider_available" : `provider_${provider.state}`,
    projectId: context.projectId,
    capability,
    providerId: provider.providerId,
    connectionId: connection?.connectionId || null,
    adapterId: provider.adapterId,
    fallbackAllowed: false
  })
}
