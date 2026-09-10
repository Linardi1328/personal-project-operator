import assert from "node:assert/strict"
import test from "node:test"
import { OwnershipContextError, validateOwnershipContext } from "./ownership-context.mjs"
import {
  CUSTOMER_ZERO_OWNER_ID,
  CUSTOMER_ZERO_WORKSPACE_ID,
  getCustomerZeroOwnershipContext,
  validateCustomerZeroOwnershipContext
} from "./customer-zero-ownership.mjs"

const syntheticPolicy = {
  workspaces: [
    { ownerId: "owner-one", workspaceId: "workspace-one", projectIds: ["project-one"] },
    { ownerId: "owner-two", workspaceId: "workspace-two", projectIds: ["project-two"] }
  ]
}

function assertRefused(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof OwnershipContextError, true)
    assert.equal(error.code, code)
    return true
  })
}

test("generic ownership validation accepts a complete internally consistent context", () => {
  assert.deepEqual(
    validateOwnershipContext(
      { ownerId: "owner-one", workspaceId: "workspace-one", projectId: "project-one" },
      syntheticPolicy
    ),
    { ownerId: "owner-one", workspaceId: "workspace-one", projectId: "project-one" }
  )
})

test("generic ownership validation refuses missing and caller-added binding fields", () => {
  assertRefused(
    () => validateOwnershipContext({ ownerId: "owner-one", workspaceId: "workspace-one" }, syntheticPolicy),
    "INVALID_OWNERSHIP_CONTEXT"
  )
  assertRefused(
    () => validateOwnershipContext({
      ownerId: "owner-one",
      workspaceId: "workspace-one",
      projectId: "project-one",
      repository: "caller/repository"
    }, syntheticPolicy),
    "INVALID_OWNERSHIP_CONTEXT"
  )
  assertRefused(
    () => validateOwnershipContext({
      ownerId: "owner-one",
      workspaceId: "workspace-one",
      projectId: "project-one",
      workspaceRoot: "/caller/root"
    }, syntheticPolicy),
    "INVALID_OWNERSHIP_CONTEXT"
  )
})

test("generic ownership validation refuses conflicting, unknown, and cross-workspace bindings", () => {
  assertRefused(
    () => validateOwnershipContext(
      { ownerId: "owner-two", workspaceId: "workspace-one", projectId: "project-one" },
      syntheticPolicy
    ),
    "OWNER_WORKSPACE_MISMATCH"
  )
  assertRefused(
    () => validateOwnershipContext(
      { ownerId: "owner-one", workspaceId: "workspace-unknown", projectId: "project-one" },
      syntheticPolicy
    ),
    "UNKNOWN_WORKSPACE"
  )
  assertRefused(
    () => validateOwnershipContext(
      { ownerId: "owner-one", workspaceId: "workspace-one", projectId: "project-unknown" },
      syntheticPolicy
    ),
    "UNKNOWN_PROJECT"
  )
  assertRefused(
    () => validateOwnershipContext(
      { ownerId: "owner-one", workspaceId: "workspace-one", projectId: "project-two" },
      syntheticPolicy
    ),
    "PROJECT_WORKSPACE_MISMATCH"
  )
})

test("Customer Zero binding is fixed and derives project authorization from the registry", () => {
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
  assertRefused(() => getCustomerZeroOwnershipContext("unknown-project"), "UNKNOWN_PROJECT")
})

test("Customer Zero validation refuses owner, workspace, project, and caller-selected authority changes", () => {
  const approved = getCustomerZeroOwnershipContext("khlim-assist")

  assertRefused(
    () => validateCustomerZeroOwnershipContext({ ...approved, ownerId: "another-owner" }),
    "OWNER_WORKSPACE_MISMATCH"
  )
  assertRefused(
    () => validateCustomerZeroOwnershipContext({ ...approved, workspaceId: "another-workspace" }),
    "UNKNOWN_WORKSPACE"
  )
  assertRefused(
    () => validateCustomerZeroOwnershipContext({ ...approved, projectId: "unknown-project" }),
    "UNKNOWN_PROJECT"
  )
  assertRefused(
    () => validateCustomerZeroOwnershipContext({ ...approved, account: "caller-account" }),
    "INVALID_OWNERSHIP_CONTEXT"
  )
  assertRefused(
    () => validateCustomerZeroOwnershipContext({ ...approved, credential: "caller-credential" }),
    "INVALID_OWNERSHIP_CONTEXT"
  )
})
