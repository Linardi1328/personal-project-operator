import assert from "node:assert/strict"
import test from "node:test"
import {
  ANTIGRAVITY_EXECUTION_ADAPTER_ID,
  ANTIGRAVITY_EXECUTION_PROMPT_MAX_CHARS,
  buildAntigravityExecutionArgs,
  buildAntigravityImplementationPrompt,
  classifyAntigravityExecutionAttemptEvidence,
  resolveLiveAntigravityModel,
  validateAntigravityAutomationSettings
} from "./software-factory-antigravity-execution.mjs"
import {
  buildBaselineSoftwareFactoryPlan,
  softwareFactoryPlanEvidence
} from "./software-factory-plan-contract.mjs"

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

test("execution argv pins the routed model and stays sandboxed without dangerous permission bypass", () => {
  const args = buildAntigravityExecutionArgs(
    "Implement the bounded task.",
    "gemini-3.8-flash-high"
  )
  assert.deepEqual(args, [
    "-p",
    "Implement the bounded task.",
    "--model",
    "gemini-3.8-flash-high",
    "--sandbox",
    "--print-timeout",
    "10m"
  ])
  assert.equal(args.includes("--dangerously-skip-permissions"), false)
})

test("implementation prompt carries validated structured plan criteria and boundaries", () => {
  const objective = "Fix the responsive registration form accessibility failure."
  const runId = "A".repeat(43)
  const baseSha = "a".repeat(40)
  const plan = buildBaselineSoftwareFactoryPlan({
    runId,
    projectId: "khlim-digital-ecosystem",
    baseSha,
    objective
  })
  const prompt = buildAntigravityImplementationPrompt(
    runFixture({
      runId,
      baseSha,
      task: objective,
      evidence: {
        planning: [softwareFactoryPlanEvidence(plan)]
      }
    }),
    workspaceFixture(),
    authorizationFixture()
  )

  assert.match(prompt, /Validated structured plan:/u)
  assert.match(prompt, new RegExp(plan.planHash, "u"))
  assert.match(prompt, /Acceptance criteria:/u)
  assert.match(prompt, /All repository-required deterministic quality gates must pass/u)
  assert.match(prompt, /Explicit exclusions:/u)
  assert.match(prompt, /No credential or secret changes/u)
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


test("live model resolution uses bounded agy models output before execution", async () => {
  const calls = []
  const selection = await resolveLiveAntigravityModel(
    "/opt/homebrew/bin/agy",
    { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
    "standard",
    {
      modelCatalogExecImpl: async (path, args, options) => {
        calls.push({ path, args, options })
        return {
          stdout: [
            "gemini-3.8-flash-medium Gemini 3.8 Flash (Medium)",
            "gemini-3.8-flash-high Gemini 3.8 Flash (High)",
            "gemini-3.1-pro-high Gemini 3.1 Pro (High)"
          ].join("\n"),
          stderr: ""
        }
      }
    }
  )

  assert.equal(selection.modelSlug, "gemini-3.8-flash-high")
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ["models"])
  assert.equal(calls[0].options.shell, false)
})

test("live model resolution fails before execution when no suitable deep model exists", async () => {
  await assert.rejects(
    resolveLiveAntigravityModel(
      "/opt/homebrew/bin/agy",
      { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
      "deep",
      {
        modelCatalogExecImpl: async () => ({
          stdout: "gemini-3.8-flash-high Gemini 3.8 Flash (High)\n",
          stderr: ""
        })
      }
    ),
    (error) => (
      error?.code === "ANTIGRAVITY_MODEL_UNAVAILABLE" &&
      error?.failureClass === "configuration"
    )
  )
})

test("execution argv refuses missing or malformed routed model slugs", () => {
  assert.throws(
    () => buildAntigravityExecutionArgs("Implement.", ""),
    (error) => error?.code === "ANTIGRAVITY_MODEL_SELECTION_INVALID"
  )
  assert.throws(
    () => buildAntigravityExecutionArgs("Implement.", "../expensive-model"),
    (error) => error?.code === "ANTIGRAVITY_MODEL_SELECTION_INVALID"
  )
})
