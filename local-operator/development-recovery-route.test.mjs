import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createDevelopmentRun,
  createPersonalProjectOperatorSelfDevelopmentRun
} from "./development-run-state.mjs"
import {
  DEVELOPMENT_RECOVERY_ROUTE_ID,
  PHASE_6M_RECOVERY_ROUTE_POLICY_HASH,
  PHASE_6M_RECOVERY_ROUTE_POLICY_ID,
  handlePpoDevelopmentRecoverCommand
} from "./development-recovery-route.mjs"
import {
  formatDevelopmentRecoveryResult
} from "./development-recovery-coordinator.mjs"

const RUN_ID = "R".repeat(43)
const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "b".repeat(40)

async function tempWriteDataDir(label = "ppo-6m-route-") {
  return await mkdtemp(join(tmpdir(), label))
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function runPpoCommand(args, options = {}) {
  return spawnSync(process.execPath, ["local-operator/ppo-command.mjs", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env || {})
    }
  })
}

async function createOrdinaryRun(writeDataDir) {
  return await createDevelopmentRun({
    projectId: "khlim-assist",
    task: "Recover one ordinary Phase 6 development run.",
    baseSha: BASE_SHA,
    branch: "main",
    headSha: BASE_SHA,
    actor: "phase-6m-test"
  }, {
    writeDataDir
  })
}

test("Phase 6M recovery route invokes Phase 6L once and returns bounded formatted output", async () => {
  let calls = 0
  const phase6LResult = {
    schemaVersion: 1,
    coordinator: "phase-6l-readonly-development-recovery-coordinator",
    policyId: "phase-6l-readonly-development-recovery-policy",
    policyHash: "c".repeat(64),
    ok: true,
    run: {
      runId: RUN_ID,
      project: "khlim-assist",
      version: 7,
      status: "created",
      headSha: BASE_SHA
    },
    phase: "none",
    operation: "none",
    outcome: "recovery_not_required",
    observation: "not_applicable",
    ownerActionRequired: false,
    continuationCandidate: true
  }

  const handled = await handlePpoDevelopmentRecoverCommand(RUN_ID, {
    executeDevelopmentRecoveryImpl: async (runId) => {
      calls += 1
      assert.equal(runId, RUN_ID)
      return phase6LResult
    }
  })

  assert.equal(calls, 1)
  assert.equal(handled.ok, true)
  assert.equal(handled.result, phase6LResult)
  assert.equal(handled.output, formatDevelopmentRecoveryResult(phase6LResult))
  assert.match(handled.output, /^PPO Development Recovery\n/)
  assert.doesNotMatch(handled.output, /stdout|stderr|stack|token|secret|SENSITIVE_TEST_SENTINEL/i)
})

test("Phase 6M recovery route rejects malformed run ids before Phase 6L execution", async () => {
  for (const runId of [
    "",
    "short",
    "R".repeat(42),
    "R".repeat(44),
    ` ${RUN_ID}`,
    `${RUN_ID} `,
    `${RUN_ID}\n`,
    `${RUN_ID}\r`,
    `${RUN_ID}\t`,
    `${RUN_ID} --status review_passed`,
    "../development-runs"
  ]) {
    let calls = 0
    const handled = await handlePpoDevelopmentRecoverCommand(runId, {
      executeDevelopmentRecoveryImpl: async () => {
        calls += 1
        throw new Error("SENSITIVE_TEST_SENTINEL should not execute")
      }
    })

    assert.equal(calls, 0, runId)
    assert.equal(handled.ok, false, runId)
    assert.match(handled.output, /^PPO Development Recovery\n/, runId)
    assert.match(handled.output, /Outcome: recovery_unavailable/u, runId)
    assert.doesNotMatch(handled.output, /SENSITIVE_TEST_SENTINEL|stack|token|secret/i, runId)
  }
})

test("Phase 6M terminal wrapper exposes recover for valid run ids and never continues", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await createOrdinaryRun(writeDataDir)

  for (const argv of [
    ["recover", run.runId],
    ["/ppo", "recover", run.runId],
    ["ppo", "recover", run.runId]
  ]) {
    const result = runPpoCommand(argv, {
      env: {
        PPO_WRITE_DATA_DIR: writeDataDir
      }
    })

    assert.equal(result.status, 0, argv.join(" "))
    assert.match(result.stdout, /^PPO Development Recovery\n/, argv.join(" "))
    assert.match(result.stdout, /Outcome: recovery_not_required/u, argv.join(" "))
    assert.doesNotMatch(result.stdout, /PPO Development Continue|continue_runtime_not_ready|stdout|stderr|token|secret/i, argv.join(" "))
    assert.equal(result.stderr, "")
  }
})

test("Phase 6M terminal wrapper rejects malformed recover argv before run-state access", async () => {
  const malformedArgvCases = [
    ["recover"],
    ["recover", "short"],
    ["recover", "R".repeat(42)],
    ["recover", "R".repeat(44)],
    ["recover\n" + RUN_ID],
    ["recover\r\n" + RUN_ID],
    ["recover", `${RUN_ID}\n`],
    ["recover", `${RUN_ID}\r`],
    ["recover", `${RUN_ID}\t`],
    [" recover", RUN_ID],
    ["recover", ` ${RUN_ID}`],
    ["recover", `${RUN_ID} `],
    ["recover " + RUN_ID],
    ["recover", RUN_ID, "extra"],
    ["recover", RUN_ID, "--expectedVersion", "7"],
    ["recover", RUN_ID, "--project", "khlim-assist"],
    ["recover", RUN_ID, HEAD_SHA],
    ["recover", RUN_ID, "--status", "review_passed"],
    ["recover", RUN_ID, "--action", "merge"],
    ["/ppo", "recover"],
    ["/ppo", "recover", RUN_ID, "extra"],
    ["/ppo\nrecover", RUN_ID],
    ["ppo", "recover", `${RUN_ID}\r\n`],
    ["/ppo", "recovery", RUN_ID],
    ["/ppo", "reconcile", RUN_ID],
    ["/ppo", "repair", RUN_ID],
    ["/ppo", "retry", RUN_ID],
    ["/ppo", "resume", RUN_ID]
  ]

  for (const argv of malformedArgvCases) {
    const writeDataDir = await tempWriteDataDir()
    const result = runPpoCommand(argv, {
      env: {
        PPO_WRITE_DATA_DIR: writeDataDir,
        PPO_GITHUB_WRITE_CONFIRM: "SENSITIVE_TEST_SENTINEL",
        PPO_NOTE_WRITE_CONFIRM: "SENSITIVE_TEST_SENTINEL"
      }
    })

    assert.notEqual(result.status, 0, argv.join(" "))
    assert.match(result.stdout, /^Unsupported PPO command:/, argv.join(" "))
    assert.doesNotMatch(result.stdout, /PPO Development Recovery|PPO Development Continue|SENSITIVE_TEST_SENTINEL|token|secret/i, argv.join(" "))
    assert.equal(await pathExists(join(writeDataDir, "development-runs")), false, argv.join(" "))
  }
})

test("Phase 6M recover keeps PPO self-development production recovery out of scope", async () => {
  const writeDataDir = await tempWriteDataDir()
  const run = await createPersonalProjectOperatorSelfDevelopmentRun({
    task: "PPO production recovery stays local-only and out of route scope.",
    baseSha: BASE_SHA,
    branch: "main",
    headSha: BASE_SHA,
    actor: "phase-6m-test"
  }, {
    writeDataDir
  })
  const handled = await handlePpoDevelopmentRecoverCommand(run.runId, {
    recoveryCoordinatorOptions: {
      writeDataDir
    }
  })

  assert.equal(handled.ok, false)
  assert.match(handled.output, /Outcome: production_recovery_out_of_scope/u)
  assert.match(handled.output, /Observation: project_out_of_scope/u)
  assert.doesNotMatch(handled.output, /deploy|rollback|systemctl|service-control|token|secret/i)
})

test("Phase 6M route source does not call continue, production, or command execution paths", async () => {
  const routeSource = await readFile(new URL("./development-recovery-route.mjs", import.meta.url), "utf8")
  const commandSource = await readFile(new URL("./ppo-command.mjs", import.meta.url), "utf8")

  assert.equal(DEVELOPMENT_RECOVERY_ROUTE_ID, "phase-6m-controlled-development-recovery-route")
  assert.equal(PHASE_6M_RECOVERY_ROUTE_POLICY_ID, "phase-6m-controlled-development-recovery-route-policy")
  assert.match(PHASE_6M_RECOVERY_ROUTE_POLICY_HASH, /^[a-f0-9]{64}$/u)
  assert.doesNotMatch(routeSource, /development-continue-orchestrator|handlePpoDevelopmentContinueCommand|executeDevelopmentContinue/)
  assert.doesNotMatch(routeSource, /development-deployment-agent|development-production-verification-agent|development-rollback-agent/)
  assert.doesNotMatch(routeSource, /\b(?:exec|execFile|spawn|spawnSync)\b|systemctl|deploy-exact-sha|rollback-exact-sha/)
  assert.match(commandSource, /handlePpoDevelopmentRecoverCommand/)
  assert.match(commandSource, /parseStrictRecoverArgs\(rawProcessArgs\)/)
})
