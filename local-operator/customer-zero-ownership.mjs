import {
  getApprovedDevelopmentProject,
  listOrdinaryDevelopmentProjects,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT
} from "./github-project-registry.mjs"
import { OwnershipContextError, validateOwnershipContext } from "./ownership-context.mjs"

export const CUSTOMER_ZERO_OWNER_ID = "customer-zero-owner"
export const CUSTOMER_ZERO_WORKSPACE_ID = "customer-zero-workspace"

const projectIds = Object.freeze([
  ...listOrdinaryDevelopmentProjects().map((project) => project.id),
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id
])

const customerZeroPolicy = Object.freeze({
  workspaces: Object.freeze([
    Object.freeze({
      ownerId: CUSTOMER_ZERO_OWNER_ID,
      workspaceId: CUSTOMER_ZERO_WORKSPACE_ID,
      projectIds
    })
  ])
})

export function getCustomerZeroOwnershipContext(projectId) {
  // Authorization deliberately stays with the existing reviewed project registry.
  if (!getApprovedDevelopmentProject(projectId)) {
    throw new OwnershipContextError(
      "UNKNOWN_PROJECT",
      "Project is not in the approved Customer Zero project registry."
    )
  }

  return validateOwnershipContext(
    {
      ownerId: CUSTOMER_ZERO_OWNER_ID,
      workspaceId: CUSTOMER_ZERO_WORKSPACE_ID,
      projectId
    },
    customerZeroPolicy
  )
}

export function validateCustomerZeroOwnershipContext(context) {
  if (!getApprovedDevelopmentProject(context?.projectId)) {
    throw new OwnershipContextError(
      "UNKNOWN_PROJECT",
      "Project is not in the approved Customer Zero project registry."
    )
  }

  return validateOwnershipContext(context, customerZeroPolicy)
}
