import assert from "node:assert/strict"
import test from "node:test"
import {
  classifySoftwareFactoryImplementationCapability
} from "./software-factory-implementation-route.mjs"

function run(task, planningSummary = "") {
  return {
    task,
    evidence: {
      planning: planningSummary ? [{ summary: planningSummary }] : []
    }
  }
}

test("frontend-impact tasks route to frontend implementation capability", () => {
  for (const task of [
    "Fix the hidden Register Interest CTA in the browser acceptance flow.",
    "Improve responsive layout and accessibility for the registration form.",
    "Repair the React component and CSS focus state.",
    "Fix Playwright E2E behavior for the dashboard modal."
  ]) {
    assert.equal(
      classifySoftwareFactoryImplementationCapability(run(task)),
      "implementation.frontend",
      task
    )
  }
})

test("backend-only tasks route to backend implementation capability", () => {
  for (const task of [
    "Add idempotent webhook persistence and database validation.",
    "Fix API rate limiting and transaction rollback handling.",
    "Repair the queue retry policy for failed jobs."
  ]) {
    assert.equal(
      classifySoftwareFactoryImplementationCapability(run(task)),
      "implementation.backend",
      task
    )
  }
})

test("planning evidence can promote an otherwise generic task to frontend capability", () => {
  assert.equal(
    classifySoftwareFactoryImplementationCapability(
      run(
        "Implement the approved fix.",
        "The failure is in the browser form component and accessibility focus behavior."
      )
    ),
    "implementation.frontend"
  )
})

test("generic implementation remains backend-biased rather than inventing UI scope", () => {
  assert.equal(
    classifySoftwareFactoryImplementationCapability(run("Implement the approved bounded change.")),
    "implementation.backend"
  )
})
