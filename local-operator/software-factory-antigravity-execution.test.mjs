import assert from "node:assert/strict"
import test from "node:test"
import {
  ANTIGRAVITY_EXECUTION_ADAPTER_ID,
  ANTIGRAVITY_EXECUTION_PROMPT_MAX_CHARS,
  buildAntigravityExecutionArgs,
  buildAntigravityImplementationPrompt,
  classifyAntigravityExecutionAttemptEvidence,
  validateAntigravityAutomationSettings
} from "./software-factory-antigravity-execution.mjs"

function runFixture(overrides = {}) {
  return {
    task: "Fix the approved registration CTA browser blocker.",
    project: {
      id: "khlim-digital-ecosystem",
      fullName: "Linardi1328/khlim-digital-ecosystem"
    },
    evidence: {
      planning: [{
        summary: "Fix only the current approved browser acceptance failure."
      }]
    },
    ...overrides
  }
}

function workspaceFixture(overrides = {}) {
  return {
    branch: "ppo/khlim-digital-ecosystem/implementation/example",
    workspaceRef: "khlim-digital-ecosystem/example",
    ...overrides
  }
}

function authorizationFixture(overrides = {}) {
  return {
    capability: "implementation.frontend",
    modelClass: "standard",
    skills: ["ui-ux-pro-max"],
    checkpointVersion: 2,
    ...overrides
  }
}

function safeSettings(overrides = {}) {
  return {
    toolPermission: "always-proceed",
    trustedWorkspaces: ["/Users/richie/.local/share/personal-project-operator/development-workspaces"],
    permissions: {
      allow: ["read_file(*)", "write_file(*)"]
    },
    ...overrides
  }
}

test("reviewed automation settings accept trusted PPO workspace with file operations", () => {
  const result = validateAntigravityAutomationSettings(
    safeSettings(),
    "/Users/richie/.local/share/personal-project-operator/development-workspaces",
    "/Users/richie/.local/share/personal-project-operator/development-workspaces/khlim-digital-ecosystem/run"
  )

  assert.equal(result.toolPermission, "always-proceed")
  assert.equal(result.nonWorkspaceAccess, false)
  assert.equal(result.fileReadAllowed, true)
  assert.equal(result.fileWriteAllowed, true)
})

test("request-review mode is refused before unattended execution", () => {
  assert.throws(
    () => validateAntigravityAutomationSettings(
      safeSettings({ toolPermission: "request-review" }),
      "/Users/richie/.local/share/personal-project-operator/development-workspaces",
      "/Users/richie/.local/share/personal-project-operator/development-workspaces/project/run"
    ),
    (error) => error?.code === "ANTIGRAVITY_AUTOMATION_SETTINGS_REQUIRED"
  )
})

test("non-workspace access must remain disabled", () => {
  assert.throws(
    () => validateAntigravityAutomationSettings(
      safeSettings({ nonWorkspaceAccess: true }),
      "/Users/richie/.local/share/personal-project-operator/development-workspaces",
      "/Users/richie/.local/share/personal-project-operator/development-workspaces/project/run"
    ),
    (error) => error?.code === "ANTIGRAVITY_NON_WORKSPACE_ACCESS_ENABLED"
  )
})

test("file write permission must be explicitly allowlisted", () => {
  assert.throws(
    () => validateAntigravityAutomationSettings({
      ...safeSettings(),
      permissions: { allow: ["read_file(*)"] }
    },
      "/Users/richie/.local/share/personal-project-operator/development-workspaces",
      "/Users/richie/.local/share/personal-project-operator/development-workspaces/project/run"
    ),
    (error) => error?.code === "ANTIGRAVITY_FILE_POLICY_REQUIRED"
  )
})

test("untrusted workspace is refused", () => {
  assert.throws(
    () => validateAntigravityAutomationSettings(
      safeSettings(),
      "/Users/richie/.local/share/personal-project-operator/development-workspaces",
      "/Users/richie/Downloads/untrusted-project"
    ),
    (error) => error?.code === "ANTIGRAVITY_WORKSPACE_NOT_TRUSTED"
  )
})

test("execution argv is non-interactive and sandboxed without dangerous permission bypass", () => {
  const args = buildAntigravityExecutionArgs("Implement the bounded task.")
  assert.deepEqual(args, [
    "-p",
    "Implement the bounded task.",
    "--sandbox",
    "--print-timeout",
    "10m"
  ])
  assert.equal(args.includes("--dangerously-skip-permissions"), false)
})

test("implementation prompt carries approved capability and skills", () => {
  const prompt = buildAntigravityImplementationPrompt(
    runFixture(),
    workspaceFixture(),
    authorizationFixture()
  )

  assert.match(prompt, /Capability: implementation\.frontend/u)
  assert.match(prompt, /ui-ux-pro-max/u)
  assert.match(prompt, /Do not push, fetch, pull, merge, rebase, reset, cherry-pick/u)
  assert.match(prompt, /Do not deploy, publish, restart services/u)
  assert.match(prompt, /Do not commit\. PPO will inspect and create the local commit/u)
  assert.match(prompt, /Edit only files inside the current workspace/u)
})

test("debugging authorization carries debugging skill into prompt", () => {
  const prompt = buildAntigravityImplementationPrompt(
    runFixture({ task: "Debug the deterministic browser acceptance failure." }),
    workspaceFixture(),
    authorizationFixture({
      capability: "debugging",
      skills: ["debugging-and-error-recovery"]
    })
  )

  assert.match(prompt, /debugging-and-error-recovery/u)
  assert.match(prompt, /Capability: debugging/u)
})

test("prompt rejects sensitive task material", () => {
  assert.throws(
    () => buildAntigravityImplementationPrompt(
      runFixture({ task: "Use token=sk-super-secret-value to fix this." }),
      workspaceFixture(),
      authorizationFixture()
    ),
    (error) => error?.code === "ANTIGRAVITY_PROMPT_UNSAFE"
  )
})

test("prompt size remains bounded", () => {
  assert.throws(
    () => buildAntigravityImplementationPrompt(
      runFixture({ task: "x".repeat(ANTIGRAVITY_EXECUTION_PROMPT_MAX_CHARS) }),
      workspaceFixture(),
      authorizationFixture()
    ),
    (error) => (
      error?.code === "ANTIGRAVITY_EXECUTION_INPUT_INVALID" ||
      error?.code === "ANTIGRAVITY_PROMPT_UNSAFE"
    )
  )
})


test("overly broad trusted home directory does not satisfy PPO workspace trust", () => {
  assert.throws(
    () => validateAntigravityAutomationSettings(
      safeSettings({ trustedWorkspaces: ["/Users/richie"] }),
      "/Users/richie/.local/share/personal-project-operator/development-workspaces",
      "/Users/richie/.local/share/personal-project-operator/development-workspaces/project/run"
    ),
    (error) => error?.code === "ANTIGRAVITY_WORKSPACE_NOT_TRUSTED"
  )
})


function attemptRun(entries, attempt = 1) {
  return {
    attempts: { implementation: attempt },
    evidence: { implementation: entries }
  }
}

function antigravityAttemptEntry(outcome, attempt = 1) {
  return {
    kind: "implementation",
    sha: "a".repeat(40),
    source: ANTIGRAVITY_EXECUTION_ADAPTER_ID,
    metadata: {
      attempt,
      outcome,
      capability: "implementation.backend",
      modelClass: "standard",
      checkpointVersion: 1
    }
  }
}

test("Antigravity attempt evidence classifies open, failed, and completed attempts", () => {
  assert.equal(
    classifyAntigravityExecutionAttemptEvidence(
      attemptRun([antigravityAttemptEntry("execution_started")])
    ),
    "open"
  )

  assert.equal(
    classifyAntigravityExecutionAttemptEvidence(
      attemptRun([
        antigravityAttemptEntry("execution_started"),
        antigravityAttemptEntry("execution_failed")
      ])
    ),
    "definitive_failed"
  )

  assert.equal(
    classifyAntigravityExecutionAttemptEvidence(
      attemptRun([
        antigravityAttemptEntry("execution_started"),
        antigravityAttemptEntry("implementation_ready")
      ])
    ),
    "completed"
  )
})

test("Antigravity attempt evidence rejects malformed or conflicting terminal outcomes", () => {
  assert.equal(
    classifyAntigravityExecutionAttemptEvidence(
      attemptRun([
        antigravityAttemptEntry("execution_started"),
        antigravityAttemptEntry("execution_failed"),
        antigravityAttemptEntry("implementation_ready")
      ])
    ),
    "invalid"
  )

  assert.equal(
    classifyAntigravityExecutionAttemptEvidence(
      attemptRun([antigravityAttemptEntry("execution_failed", 1)], 2)
    ),
    "none"
  )
})
