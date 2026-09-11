import assert from "node:assert/strict"
import test from "node:test"
import {
  OwnershipContextError,
  validateOwnershipBinding,
  validateOwnershipContext
} from "./ownership-context.mjs"
import {
  CUSTOMER_ZERO_OWNER_ID,
  CUSTOMER_ZERO_OWNERSHIP_BINDING,
  CUSTOMER_ZERO_WORKSPACE_ID,
  getCustomerZeroOwnershipContext,
  validateCustomerZeroOwnershipContext
} from "./customer-zero-ownership-context.mjs"

const syntheticBindings = [
  { ownerId: "owner-one", workspaceId: "workspace-one", projectIds: ["project-one"] },
  { ownerId: "owner-two", workspaceId: "workspace-two", projectIds: ["project-two"] }
]
const syntheticAuthorizedProjects = new Set(["project-one", "project-two"])

function expectRefusal(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof OwnershipContextError)
    assert.equal(error.code, code)
    return true
  })
}

test("generic validation accepts a complete synthetic binding without owner-name dependencies", () => {
  assert.deepEqual(
    validateOwnershipContext({
      ownerId: "owner-one",
      workspaceId: "workspace-one",
      projectId: "project-one"
    }, syntheticBindings, syntheticAuthorizedProjects),
    { ownerId: "owner-one", workspaceId: "workspace-one", projectId: "project-one" }
  )
})

test("ownership context refuses missing and caller-selected fields", () => {
  expectRefusal("OWNERSHIP_FIELD_MISSING", () => validateOwnershipContext({
    ownerId: "owner-one",
    workspaceId: "workspace-one"
  }, syntheticBindings, syntheticAuthorizedProjects))

  for (const field of ["account", "repository", "credential", "workspaceRoot"]) {
    expectRefusal("OWNERSHIP_FIELD_NOT_ALLOWED", () => validateOwnershipContext({
      ownerId: "owner-one",
      workspaceId: "workspace-one",
      projectId: "project-one",
      [field]: "caller-value"
    }, syntheticBindings, syntheticAuthorizedProjects))
  }
})

test("ownership context refuses conflicting, unknown, and cross-workspace bindings", () => {
  expectRefusal("OWNERSHIP_OWNER_MISMATCH", () => validateOwnershipContext({
    ownerId: "owner-two", workspaceId: "workspace-one", projectId: "project-one"
  }, syntheticBindings, syntheticAuthorizedProjects))
  expectRefusal("OWNERSHIP_PROJECT_UNKNOWN", () => validateOwnershipContext({
    ownerId: "owner-one", workspaceId: "workspace-one", projectId: "project-unknown"
  }, syntheticBindings, syntheticAuthorizedProjects))
  expectRefusal("OWNERSHIP_CROSS_WORKSPACE", () => validateOwnershipContext({
    ownerId: "owner-one", workspaceId: "workspace-two", projectId: "project-one"
  }, syntheticBindings, syntheticAuthorizedProjects))
  expectRefusal("OWNERSHIP_BINDING_CONFLICT", () => validateOwnershipContext({
    ownerId: "owner-one", workspaceId: "workspace-one", projectId: "project-one"
  }, [...syntheticBindings, {
    ownerId: "owner-one", workspaceId: "workspace-three", projectIds: ["project-one"]
  }], syntheticAuthorizedProjects))
})

test("binding validation is strict and rejects duplicate projects", () => {
  expectRefusal("OWNERSHIP_FIELD_NOT_ALLOWED", () => validateOwnershipBinding({
    ownerId: "owner-one", workspaceId: "workspace-one", projectIds: ["project-one"], repository: "example/repo"
  }))
  expectRefusal("OWNERSHIP_BINDING_CONFLICT", () => validateOwnershipBinding({
    ownerId: "owner-one", workspaceId: "workspace-one", projectIds: ["project-one", "project-one"]
  }))
})

test("fixed Customer Zero binding covers approved projects and refuses unknown context", () => {
  assert.equal(CUSTOMER_ZERO_OWNERSHIP_BINDING.ownerId, CUSTOMER_ZERO_OWNER_ID)
  assert.equal(CUSTOMER_ZERO_OWNERSHIP_BINDING.workspaceId, CUSTOMER_ZERO_WORKSPACE_ID)
  assert.deepEqual(getCustomerZeroOwnershipContext("khlim-assist"), {
    ownerId: CUSTOMER_ZERO_OWNER_ID,
    workspaceId: CUSTOMER_ZERO_WORKSPACE_ID,
    projectId: "khlim-assist"
  })
  assert.deepEqual(getCustomerZeroOwnershipContext("personal-project-operator"), {
    ownerId: CUSTOMER_ZERO_OWNER_ID,
    workspaceId: CUSTOMER_ZERO_WORKSPACE_ID,
    projectId: "personal-project-operator"
  })
  assert.equal(getCustomerZeroOwnershipContext("unknown-project"), null)
  expectRefusal("OWNERSHIP_CROSS_WORKSPACE", () => validateCustomerZeroOwnershipContext({
    ownerId: CUSTOMER_ZERO_OWNER_ID,
    workspaceId: "another-workspace",
    projectId: "khlim-assist"
  }))
})
