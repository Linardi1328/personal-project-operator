import assert from "node:assert/strict"
import test from "node:test"
import {
  SOFTWARE_FACTORY_CONTROL_PLANE_VERSION,
  assessSoftwareFactoryDispatch,
  describeSoftwareFactoryCapability,
  resolveSoftwareFactoryModelClass
} from "./software-factory-control-plane.mjs"

function configured(workerId, capacity = "available") {
  return {
    [workerId]: {
      integration: "configured",
      capacity
    }
  }
}

test("frontend implementation routes to Antigravity with the UI UX skill", () => {
  const policy = describeSoftwareFactoryCapability("implementation.frontend")

  assert.equal(policy.controlPlaneVersion, SOFTWARE_FACTORY_CONTROL_PLANE_VERSION)
  assert.equal(policy.workerId, "antigravity")
  assert.equal(policy.modelClass, "standard")
  assert.deepEqual(policy.skills, ["ui-ux-pro-max"])
  assert.equal(policy.ownerApprovalRequired, false)
})

test("backend implementation also routes to Antigravity without a Codex fallback", () => {
  const policy = describeSoftwareFactoryCapability("implementation.backend")

  assert.equal(policy.workerId, "antigravity")
  assert.equal(policy.modelClass, "standard")
  assert.deepEqual(policy.skills, [])
})

test("debugging carries the approved debugging skill", () => {
  const policy = describeSoftwareFactoryCapability("debugging")

  assert.equal(policy.workerId, "antigravity")
  assert.deepEqual(policy.skills, ["debugging-and-error-recovery"])
})

test("frontend review runs through Antigravity with the Vercel web-design-guidelines skill", () => {
  const policy = describeSoftwareFactoryCapability("review.frontend")

  assert.equal(policy.workerId, "antigravity")
  assert.equal(policy.modelClass, "standard")
  assert.deepEqual(policy.skills, ["web-design-guidelines"])
})

test("exhausted worker capacity blocks without consuming an implementation attempt", () => {
  const result = assessSoftwareFactoryDispatch({
    capability: "implementation.frontend",
    workerStates: configured("antigravity", "exhausted")
  })

  assert.equal(result.outcome, "blocked_capacity")
  assert.equal(result.reasonCode, "WORKER_CAPACITY_EXHAUSTED")
  assert.equal(result.retryable, true)
  assert.equal(result.consumeAttempt, false)
})

test("rate limited worker capacity also blocks without consuming an attempt", () => {
  const result = assessSoftwareFactoryDispatch({
    capability: "debugging",
    workerStates: configured("antigravity", "rate_limited")
  })

  assert.equal(result.outcome, "blocked_capacity")
  assert.equal(result.reasonCode, "WORKER_RATE_LIMITED")
  assert.equal(result.retryable, true)
  assert.equal(result.consumeAttempt, false)
})

test("missing integration fails closed instead of inventing a fallback worker", () => {
  const result = assessSoftwareFactoryDispatch({
    capability: "implementation.backend",
    workerStates: {}
  })

  assert.equal(result.workerId, "antigravity")
  assert.equal(result.outcome, "blocked_external")
  assert.equal(result.reasonCode, "WORKER_INTEGRATION_UNCONFIGURED")
  assert.equal(result.consumeAttempt, false)
})

test("unknown capacity fails closed", () => {
  const result = assessSoftwareFactoryDispatch({
    capability: "planning",
    workerStates: configured("chatgpt", "unknown")
  })

  assert.equal(result.outcome, "blocked_external")
  assert.equal(result.reasonCode, "WORKER_CAPACITY_UNKNOWN")
  assert.equal(result.consumeAttempt, false)
})

test("available deterministic workers can be dispatched without a model class", () => {
  const result = assessSoftwareFactoryDispatch({
    capability: "testing.browser",
    workerStates: configured("playwright")
  })

  assert.equal(result.outcome, "ready")
  assert.equal(result.modelClass, "none")
  assert.equal(result.consumeAttempt, true)
})

test("degraded capacity remains runnable but is surfaced explicitly", () => {
  const result = assessSoftwareFactoryDispatch({
    capability: "repository.inspect",
    workerStates: configured("chatgpt", "degraded")
  })

  assert.equal(result.outcome, "ready")
  assert.equal(result.reasonCode, "WORKER_DEGRADED")
  assert.equal(result.consumeAttempt, true)
})

test("production deployment always requires owner approval", () => {
  const result = assessSoftwareFactoryDispatch({
    capability: "deployment.production",
    workerStates: configured("vercel")
  })

  assert.equal(result.outcome, "owner_action_required")
  assert.equal(result.reasonCode, "OWNER_APPROVAL_REQUIRED")
  assert.equal(result.ownerApprovalRequired, true)
  assert.equal(result.consumeAttempt, false)
})

test("economy work escalates to standard after one failed attempt", () => {
  assert.equal(
    resolveSoftwareFactoryModelClass("repository.inspect", { failedAttempts: 1 }),
    "standard"
  )
})

test("economy work escalates to deep after two failed attempts", () => {
  assert.equal(
    resolveSoftwareFactoryModelClass("repository.inspect", { failedAttempts: 2 }),
    "deep"
  )
})

test("standard work escalates to deep after two failed attempts", () => {
  assert.equal(
    resolveSoftwareFactoryModelClass("debugging", { failedAttempts: 2 }),
    "deep"
  )
})

test("high risk work uses deep reasoning immediately", () => {
  assert.equal(
    resolveSoftwareFactoryModelClass("planning", { risk: "high" }),
    "deep"
  )
})

test("tool-only work never consumes a reasoning-model tier", () => {
  assert.equal(
    resolveSoftwareFactoryModelClass("review.code", { failedAttempts: 8, risk: "high" }),
    "none"
  )
})

test("unknown capability is refused", () => {
  assert.throws(
    () => describeSoftwareFactoryCapability("implementation.magic"),
    (error) => error?.code === "FACTORY_CAPABILITY_UNKNOWN"
  )
})

test("invalid worker state is refused", () => {
  assert.throws(
    () => assessSoftwareFactoryDispatch({
      capability: "planning",
      workerStates: {
        chatgpt: {
          integration: "configured",
          capacity: "infinite"
        }
      }
    }),
    (error) => error?.code === "FACTORY_WORKER_STATE_INVALID"
  )
})
