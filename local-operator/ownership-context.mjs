const identifierPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const contextFields = new Set(["ownerId", "workspaceId", "projectId"])
const bindingFields = new Set(["ownerId", "workspaceId", "projectIds"])

export class OwnershipContextError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "OwnershipContextError"
    this.code = code
  }
}

function refuse(code, message) {
  throw new OwnershipContextError(code, message)
}

function requireRecord(value, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    refuse(code, `${label} must be a plain object.`)
  }
}

function requireExactFields(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) {
      refuse("OWNERSHIP_FIELD_NOT_ALLOWED", `${label} field "${key}" is not allowed.`)
    }
  }

  for (const key of fields) {
    if (!Object.hasOwn(value, key)) {
      refuse("OWNERSHIP_FIELD_MISSING", `${label} field "${key}" is required.`)
    }
  }
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    refuse("OWNERSHIP_IDENTIFIER_INVALID", `${label} must be a stable lowercase identifier.`)
  }
}

export function validateOwnershipBinding(binding) {
  requireRecord(binding, "OWNERSHIP_BINDING_INVALID", "Ownership binding")
  requireExactFields(binding, bindingFields, "Ownership binding")
  requireIdentifier(binding.ownerId, "ownerId")
  requireIdentifier(binding.workspaceId, "workspaceId")

  if (!Array.isArray(binding.projectIds) || binding.projectIds.length === 0) {
    refuse("OWNERSHIP_BINDING_INVALID", "Ownership binding projectIds must be a non-empty array.")
  }

  const projectIds = new Set()
  for (const projectId of binding.projectIds) {
    requireIdentifier(projectId, "projectId")
    if (projectIds.has(projectId)) {
      refuse("OWNERSHIP_BINDING_CONFLICT", `Project "${projectId}" occurs more than once in an ownership binding.`)
    }
    projectIds.add(projectId)
  }

  return Object.freeze({
    ownerId: binding.ownerId,
    workspaceId: binding.workspaceId,
    projectIds: Object.freeze([...projectIds])
  })
}

export function validateOwnershipContext(context, bindings, authorizedProjectIds) {
  requireRecord(context, "OWNERSHIP_CONTEXT_INVALID", "Ownership context")
  requireExactFields(context, contextFields, "Ownership context")
  requireIdentifier(context.ownerId, "ownerId")
  requireIdentifier(context.workspaceId, "workspaceId")
  requireIdentifier(context.projectId, "projectId")

  if (!Array.isArray(bindings) || bindings.length === 0) {
    refuse("OWNERSHIP_BINDING_INVALID", "At least one reviewed ownership binding is required.")
  }
  if (!(authorizedProjectIds instanceof Set)) {
    refuse("OWNERSHIP_AUTHORIZATION_INVALID", "An authoritative project-id set is required.")
  }

  const reviewedBindings = bindings.map(validateOwnershipBinding)
  const projectBindings = reviewedBindings.filter((binding) => binding.projectIds.includes(context.projectId))
  if (projectBindings.length === 0 || !authorizedProjectIds.has(context.projectId)) {
    refuse("OWNERSHIP_PROJECT_UNKNOWN", "Project is not present in the reviewed binding and authorization registry.")
  }
  if (projectBindings.length !== 1) {
    refuse("OWNERSHIP_BINDING_CONFLICT", "Project belongs to more than one reviewed ownership binding.")
  }

  const projectBinding = projectBindings[0]
  if (projectBinding.ownerId !== context.ownerId) {
    refuse("OWNERSHIP_OWNER_MISMATCH", "Owner does not match the reviewed project binding.")
  }
  if (projectBinding.workspaceId !== context.workspaceId) {
    refuse("OWNERSHIP_CROSS_WORKSPACE", "Project does not belong to the requested workspace.")
  }

  return Object.freeze({
    ownerId: context.ownerId,
    workspaceId: context.workspaceId,
    projectId: context.projectId
  })
}
