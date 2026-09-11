import {
  getApprovedDevelopmentProject,
  listOrdinaryDevelopmentProjects,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
} from "./github-project-registry.mjs"
import { validateOwnershipBinding, validateOwnershipContext } from "./ownership-context.mjs"

export const CUSTOMER_ZERO_OWNER_ID = "customer-zero-owner"
export const CUSTOMER_ZERO_WORKSPACE_ID = "customer-zero-workspace"

const projectIds = Object.freeze([
  ...listOrdinaryDevelopmentProjects().map((project) => project.id),
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id
])

export const CUSTOMER_ZERO_OWNERSHIP_BINDING = validateOwnershipBinding({
  ownerId: CUSTOMER_ZERO_OWNER_ID,
  workspaceId: CUSTOMER_ZERO_WORKSPACE_ID,
  projectIds
})

const authorizedProjectIds = new Set(projectIds)

export function getCustomerZeroOwnershipContext(projectId) {
  if (!getApprovedDevelopmentProject(projectId)) {
    return null
  }

  return validateOwnershipContext({
    ownerId: CUSTOMER_ZERO_OWNER_ID,
    workspaceId: CUSTOMER_ZERO_WORKSPACE_ID,
    projectId
  }, [CUSTOMER_ZERO_OWNERSHIP_BINDING], authorizedProjectIds)
}

export function validateCustomerZeroOwnershipContext(context) {
  return validateOwnershipContext(context, [CUSTOMER_ZERO_OWNERSHIP_BINDING], authorizedProjectIds)
}
