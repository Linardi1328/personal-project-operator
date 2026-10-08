import assert from "node:assert/strict"
import test from "node:test"
import {
  SOFTWARE_FACTORY_MAX_ACTIVE_PROJECTS,
  assessSoftwareFactoryAdmission
} from "./software-factory-admission.mjs"

function catalog(active = [], overrides = {}) {
  return {
    ok: true,
    code: "ok",
    active,
    diagnostics: { scanned: active.length, returned: active.length, invalid: 0, outOfScope: 0, truncated: false },
    ...overrides
  }
}

function run(project, runId = "A".repeat(43), overrides = {}) {
  return {
    project,
    runId,
    status: "implementation_in_progress",
    terminal: false,
    recoveryRequired: false,
    ...overrides
  }
}

test("admits work when no active runs exist", () => {
  const result = assessSoftwareFactoryAdmission("kynexa", catalog())
  assert.equal(result.ok, true)
  assert.equal(result.outcome, "admitted")
  assert.equal(result.activeProjectCount, 0)
})

test("blocks a second active run for the same project", () => {
  const result = assessSoftwareFactoryAdmission("kynexa", catalog([
    run("kynexa")
  ]))
  assert.equal(result.ok, false)
  assert.equal(result.outcome, "blocked_work_in_progress")
  assert.equal(result.reasonCode, "PROJECT_ACTIVE_RUN_LIMIT")
})

test("blocks a third active project", () => {
  const result = assessSoftwareFactoryAdmission("axiom-quantum", catalog([
    run("kynexa", "A".repeat(43)),
    run("rivora", "B".repeat(43))
  ]))
  assert.equal(SOFTWARE_FACTORY_MAX_ACTIVE_PROJECTS, 2)
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, "GLOBAL_ACTIVE_PROJECT_LIMIT")
  assert.deepEqual(result.activeProjects, ["kynexa", "rivora"])
})

test("release-waiting runs still consume WIP", () => {
  const result = assessSoftwareFactoryAdmission("kynexa", catalog([
    run("kynexa", "A".repeat(43), { status: "merge_ready" })
  ]))
  assert.equal(result.ok, false)
  assert.equal(result.reasonCode, "PROJECT_ACTIVE_RUN_LIMIT")
})

test("fails closed on truncated catalog", () => {
  assert.throws(
    () => assessSoftwareFactoryAdmission("kynexa", catalog([], {
      code: "catalog_truncated",
      diagnostics: { truncated: true }
    })),
    (error) => error?.code === "FACTORY_ADMISSION_CATALOG_UNAVAILABLE"
  )
})

test("fails closed when an active run requires recovery", () => {
  assert.throws(
    () => assessSoftwareFactoryAdmission("kynexa", catalog([
      run("rivora", "A".repeat(43), { recoveryRequired: true })
    ])),
    (error) => error?.code === "FACTORY_ADMISSION_CATALOG_UNTRUSTED"
  )
})


test("merged runs release Software Factory development WIP", () => {
  const result = assessSoftwareFactoryAdmission("kynexa", catalog([
    run("kynexa", "A".repeat(43), { status: "merged" })
  ]))
  assert.equal(result.ok, true)
  assert.equal(result.activeProjectCount, 0)
  assert.equal(result.projectActiveRunCount, 0)
})

test("post-merge production stages do not consume development WIP", () => {
  const result = assessSoftwareFactoryAdmission("axiom-quantum", catalog([
    run("kynexa", "A".repeat(43), { status: "deploy_in_progress" }),
    run("rivora", "B".repeat(43), { status: "verification_failed" })
  ]))
  assert.equal(result.ok, true)
  assert.equal(result.activeProjectCount, 0)
})

test("recovery-required post-merge state still fails closed", () => {
  assert.throws(
    () => assessSoftwareFactoryAdmission("kynexa", catalog([
      run("rivora", "A".repeat(43), {
        status: "merged",
        recoveryRequired: true
      })
    ])),
    (error) => error?.code === "FACTORY_ADMISSION_CATALOG_UNTRUSTED"
  )
})
