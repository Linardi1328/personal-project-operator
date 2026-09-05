#!/usr/bin/env node

import { readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const gate = process.argv[2]
const allowedGates = new Set([
  "syntax",
  "parallel-regression",
  "serial-regression",
  "critical-lifecycle",
  "integrated-acceptance"
])

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function regularFilesBelow(root, predicate) {
  const output = []

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)

      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile() && predicate(path)) {
        output.push(relative(repositoryRoot, path))
      }
    }
  }

  visit(join(repositoryRoot, root))
  return output.sort()
}

function run(executablePath, args) {
  const result = spawnSync(executablePath, args, {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: "inherit"
  })

  if (result.error || result.signal || result.status !== 0) {
    process.exit(typeof result.status === "number" ? result.status : 1)
  }
}

function runNodeTests(files, options = []) {
  run(process.execPath, [
    "--test",
    "--test-reporter=dot",
    ...options,
    ...files
  ])
}

function allRegressionTests() {
  return [
    ...regularFilesBelow("capabilities", (path) => path.endsWith(".test.mjs")),
    ...regularFilesBelow("local-operator", (path) => path.endsWith(".test.mjs")),
    ...regularFilesBelow("deployment", (path) => path.endsWith(".test.mjs")),
    "openclaw/plugins/ppo-local/test-bridge.mjs"
  ]
}

function runSyntaxGate() {
  const modules = ["capabilities", "local-operator", "deployment", "openclaw"]
    .flatMap((root) => regularFilesBelow(root, (path) => path.endsWith(".mjs")))
  const shellScripts = [
    ...regularFilesBelow("deployment", (path) => path.endsWith(".sh")),
    "deployment/bin/ppo-self-development"
  ].sort()
  const bashExecutable = process.platform === "darwin" ? "/bin/bash" : "/usr/bin/bash"

  for (const modulePath of modules) {
    run(process.execPath, ["--check", modulePath])
  }

  for (const scriptPath of shellScripts) {
    run(bashExecutable, ["-n", scriptPath])
  }
}

function runCriticalLifecycleGate() {
  const files = [
    "local-operator/development-codex-execution-adapter.test.mjs",
    "local-operator/development-hardening-orchestrator.test.mjs",
    "local-operator/development-review-agent.test.mjs",
    "local-operator/development-operation-lease.test.mjs",
    "local-operator/development-continue-orchestrator.test.mjs",
    "local-operator/development-recovery-coordinator.test.mjs",
    "local-operator/development-acceptance-gate.test.mjs"
  ]

  for (let round = 0; round < 2; round += 1) {
    runNodeTests(files, ["--test-concurrency=1"])
  }
}

function runIntegratedAcceptanceGate() {
  runNodeTests([
    "capabilities/customer-zero-project.test.mjs",
    "local-operator/phase-6q-integrated-acceptance.test.mjs",
    "local-operator/github-ppo-status.test.mjs",
    "local-operator/github-ppo-commands.test.mjs",
    "local-operator/codex-prompt-generator.test.mjs",
    "local-operator/codex-planning-tools.test.mjs",
    "local-operator/github-issue-create.test.mjs",
    "local-operator/github-issue-approval.test.mjs",
    "local-operator/project-note-add.test.mjs",
    "local-operator/project-note-approval.test.mjs",
    "local-operator/project-state-promote.test.mjs",
    "local-operator/development-run-state.test.mjs",
    "local-operator/development-next-stage-planner.test.mjs",
    "local-operator/development-workspace-manager.test.mjs",
    "local-operator/development-codex-execution-adapter.test.mjs",
    "local-operator/development-test-runner.test.mjs",
    "local-operator/development-review-agent.test.mjs",
    "local-operator/development-operation-lease.test.mjs",
    "local-operator/development-hardening-orchestrator.test.mjs",
    "local-operator/github-delivery-agent.test.mjs",
    "local-operator/development-deployment-agent.test.mjs",
    "local-operator/development-production-verification-agent.test.mjs",
    "local-operator/development-rollback-agent.test.mjs",
    "local-operator/development-start-route.test.mjs",
    "local-operator/development-continue-orchestrator.test.mjs",
    "local-operator/development-recovery-coordinator.test.mjs",
    "local-operator/development-recovery-route.test.mjs",
    "local-operator/development-run-catalog.test.mjs",
    "local-operator/development-run-catalog-route.test.mjs",
    "local-operator/development-run-cancellation.test.mjs",
    "local-operator/development-run-cancellation-approval.test.mjs",
    "local-operator/development-self-controller.test.mjs",
    "openclaw/plugins/ppo-local/test-bridge.mjs"
  ], ["--test-concurrency=1"])
}

if (!allowedGates.has(gate) || process.argv.length !== 3) {
  fail("Usage: run-ppo-development-quality.mjs <approved-gate>")
}

if (gate === "syntax") {
  runSyntaxGate()
} else if (gate === "parallel-regression") {
  runNodeTests(allRegressionTests())
} else if (gate === "serial-regression") {
  runNodeTests(allRegressionTests(), ["--test-concurrency=1"])
} else if (gate === "critical-lifecycle") {
  runCriticalLifecycleGate()
} else {
  runIntegratedAcceptanceGate()
}
