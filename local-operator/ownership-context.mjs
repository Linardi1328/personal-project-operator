const identifierPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const contextKeys = ["ownerId", "projectId", "workspaceId"]
const workspaceKeys = ["ownerId", "projectIds", "workspaceId"]

export class OwnershipContextError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "OwnershipContextError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function refuse(code, safeMessage) {
  throw new OwnershipContextError(code, safeMessage)
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expectedKeys) {
  return Object.keys(value).sort().join("\0") === [...expectedKeys].sort().join("\0")
}

function validIdentifier(value) {
  return typeof value === "string" && identifierPattern.test(value)
}

function validateWorkspaceBinding(binding) {
  if (!isPlainObject(binding) || !hasExactKeys(binding, workspaceKeys)) {
    refuse("INVALID_OWNERSHIP_POLICY", "Ownership policy contains an invalid workspace binding.")
  }

  if (!validIdentifier(binding.ownerId) || !validIdentifier(binding.workspaceId)) {
    refuse("INVALID_OWNERSHIP_POLICY", "Ownership policy identifiers are invalid.")
  }

  if (!Array.isArray(binding.projectIds) || binding.projectIds.length === 0) {
    refuse("INVALID_OWNERSHIP_POLICY", "Ownership policy must bind at least one project.")
  }

  const projectIds = new Set()
  for (const projectId of binding.projectIds) {
    if (!validIdentifier(projectId) || projectIds.has(projectId)) {
      refuse("INVALID_OWNERSHIP_POLICY", "Ownership policy project identifiers are invalid or duplicated.")
    }
    projectIds.add(projectId)
  }

  return projectIds
}

function indexPolicy(workspaces) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    refuse("INVALID_OWNERSHIP_POLICY", "Ownership validation requires at least one workspace binding.")
  }

  const byWorkspace = new Map()
  const projectWorkspace = new Map()

  for (const binding of workspaces) {
    const projectIds = validateWorkspaceBinding(binding)
    if (byWorkspace.has(binding.workspaceId)) {
      refuse("INVALID_OWNERSHIP_POLICY", "Ownership policy contains a duplicate workspace identifier.")
    }

    byWorkspace.set(binding.workspaceId, { ownerId: binding.ownerId, projectIds })
    for (const projectId of projectIds) {
      if (projectWorkspace.has(projectId)) {
        refuse("INVALID_OWNERSHIP_POLICY", "Ownership policy binds a project to more than one workspace.")
      }
      projectWorkspace.set(projectId, binding.workspaceId)
    }
  }

  return { byWorkspace, projectWorkspace }
}

export function validateOwnershipContext(context, policy) {
  if (!isPlainObject(context) || !hasExactKeys(context, contextKeys)) {
    refuse(
      "INVALID_OWNERSHIP_CONTEXT",
      "Ownership context must contain only ownerId, workspaceId, and projectId."
    )
  }

  for (const key of contextKeys) {
    if (!validIdentifier(context[key])) {
      refuse("INVALID_OWNERSHIP_CONTEXT", `Ownership context ${key} is missing or invalid.`)
    }
  }

  const { byWorkspace, projectWorkspace } = indexPolicy(policy?.workspaces)
  const workspace = byWorkspace.get(context.workspaceId)
  if (!workspace) {
    refuse("UNKNOWN_WORKSPACE", "Ownership context references an unknown workspace.")
  }

  if (workspace.ownerId !== context.ownerId) {
    refuse("OWNER_WORKSPACE_MISMATCH", "Ownership context owner does not own the selected workspace.")
  }

  const expectedWorkspaceId = projectWorkspace.get(context.projectId)
  if (!expectedWorkspaceId) {
    refuse("UNKNOWN_PROJECT", "Ownership context references an unknown project.")
  }

  if (expectedWorkspaceId !== context.workspaceId) {
    refuse("PROJECT_WORKSPACE_MISMATCH", "Ownership context project belongs to a different workspace.")
  }

  return Object.freeze({
    ownerId: context.ownerId,
    workspaceId: context.workspaceId,
    projectId: context.projectId
  })
}
