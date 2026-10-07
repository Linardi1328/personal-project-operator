import assert from "node:assert/strict"
import {
  chmod,
  mkdtemp,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createDevelopmentRun,
  readDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  recordSoftwareFactoryDispatchCheckpoint
} from "./software-factory-dispatch-checkpoint.mjs"
import {
  createAntigravityReadinessAdapter
} from "./software-factory-antigravity-readiness.mjs"

function makeClock(start = "2026-10-07T13:00:00.000Z") {
  let tick = 0
  const base = Date.parse(start)

  return () => {
    const value = new Date(base + tick * 1000)
    tick += 1
    return value
  }
}

async function makePlannedRun() {
  const root = await mkdtemp(join(tmpdir(), "ppo-antigravity-readiness-"))
  const writeDataDir = join(root, "write-data")
  const now = makeClock()
  const sha = "b".repeat(40)
  const created = await createDevelopmentRun({
    projectId: "khlim-digital-ecosystem",
    task: "Fix the approved frontend blocker.",
    baseSha: sha,
    branch: "main",
    headSha: sha,
    actor: "factory-readiness-test"
  }, {
    writeDataDir,
    now
  })
  const planning = await transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress",
    actor: "factory-readiness-test"
  }, {
    writeDataDir,
    now
  })
  const planned = await transitionDevelopmentRun(created.runId, {
    expectedVersion: planning.version,
    status: "planned",
    actor: "factory-readiness-test"
  }, {
    writeDataDir,
    now
  })

  return { root, writeDataDir, now, run: planned }
}

async function makeTrustedExecutable(root, mode = 0o755) {
  const path = join(root, "agy")
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8")
  await chmod(path, mode)
  return path
}

function probeResult({
  exitCode = 0,
  stdout = "gemini-3.8-flash-low Gemini 3.8 Flash (Low)\n",
  stderr = ""
} = {}) {
  return { exitCode, stdout, stderr }
}

function adapterFromProbe(probeRunner, now = () => new Date("2026-10-07T13:00:00.000Z")) {
  return createAntigravityReadinessAdapter({
    probeRunner,
    now
  })
}

test("reviewed CLI integration probe reports configured with unknown capacity when quota panel is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-probe-"))
  const executablePath = await makeTrustedExecutable(root)
  const calls = []
  const adapter = createAntigravityReadinessAdapter({
    executableCandidates: [executablePath],
    execFileImpl: async (_path, args) => {
      calls.push(args)
      if (args[0] === "models") {
        return {
          stdout: "gemini-3.8-flash-low Gemini 3.8 Flash (Low)\n",
          stderr: ""
        }
      }

      const error = new Error("usage panel unavailable")
      error.code = 2
      error.stdout = ""
      error.stderr = "interactive panel unavailable"
      throw error
    },
    now: () => new Date("2026-10-07T13:00:00.000Z")
  })

  const observation = await adapter.probe()

  assert.equal(observation.workerId, "antigravity")
  assert.equal(observation.sourceId, "reviewed-runtime-probe")
  assert.equal(observation.integration, "configured")
  assert.equal(observation.capacity, "unknown")
  assert.deepEqual(calls[0], ["models"])
  assert.deepEqual(calls[1], ["-p", "/usage", "--print-timeout", "10s"])
})

test("quota signal is classified as exhausted", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    exitCode: 1,
    stderr: "Individual quota reached. Resets in 5h20m."
  }))
  const observation = await adapter.probe()

  assert.equal(observation.integration, "configured")
  assert.equal(observation.capacity, "exhausted")
})

test("rate-limit signal is classified without guessing availability", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    exitCode: 1,
    stderr: "429 too many requests: rate limited"
  }))
  const observation = await adapter.probe()

  assert.equal(observation.integration, "configured")
  assert.equal(observation.capacity, "rate_limited")
})

test("usage output with remaining quota is classified as available", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    stdout: "Gemini 3.8 Flash (Low)\n40% remaining · Refreshes in 1h 26m"
  }))
  const observation = await adapter.probe()

  assert.equal(observation.integration, "configured")
  assert.equal(observation.capacity, "available")
})

test("low remaining quota is classified as degraded", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    stdout: "Gemini 3.8 Flash (Low)\n15% remaining · Refreshes in 15m"
  }))
  const observation = await adapter.probe()

  assert.equal(observation.integration, "configured")
  assert.equal(observation.capacity, "degraded")
})

test("all-zero remaining quota is classified as exhausted", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    stdout: "Gemini 3.8 Flash (Low)\n0% remaining · Refreshes in 15m"
  }))
  const observation = await adapter.probe()

  assert.equal(observation.capacity, "exhausted")
})

test("authentication failure is classified as unconfigured and unavailable", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    exitCode: 1,
    stderr: "Authentication required. Please sign in."
  }))
  const observation = await adapter.probe()

  assert.equal(observation.integration, "unconfigured")
  assert.equal(observation.capacity, "unavailable")
})

test("unrecognized nonzero probe failure fails closed", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    exitCode: 2,
    stderr: "unexpected local failure"
  }))
  const observation = await adapter.probe()

  assert.equal(observation.integration, "unconfigured")
  assert.equal(observation.capacity, "unavailable")
})

test("unsafe probe output is refused", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    stdout: "token=sk-test-secret-value"
  }))

  await assert.rejects(
    adapter.probe(),
    (error) => error?.code === "ANTIGRAVITY_PROBE_OUTPUT_UNSAFE"
  )
})

test("oversized probe output is refused", async () => {
  const adapter = adapterFromProbe(async () => probeResult({
    stdout: "x".repeat(70 * 1024)
  }))

  await assert.rejects(
    adapter.probe(),
    (error) => error?.code === "ANTIGRAVITY_PROBE_OUTPUT_INVALID"
  )
})

test("symlinked reviewed executable is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-symlink-"))
  const target = await makeTrustedExecutable(root)
  const alias = join(root, "agy-link")
  await symlink(target, alias)
  const adapter = createAntigravityReadinessAdapter({
    executableCandidates: [alias],
    execFileImpl: async () => ({ stdout: "", stderr: "" })
  })

  await assert.rejects(
    adapter.probe(),
    (error) => error?.code === "ANTIGRAVITY_PROBE_UNTRUSTED"
  )
})

test("group or world writable reviewed executable is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-writable-"))
  const executablePath = await makeTrustedExecutable(root, 0o777)
  const adapter = createAntigravityReadinessAdapter({
    executableCandidates: [executablePath],
    execFileImpl: async () => ({ stdout: "", stderr: "" })
  })

  await assert.rejects(
    adapter.probe(),
    (error) => error?.code === "ANTIGRAVITY_PROBE_UNTRUSTED"
  )
})

test("integration probe timeout is refused rather than guessed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-timeout-"))
  const executablePath = await makeTrustedExecutable(root)
  const adapter = createAntigravityReadinessAdapter({
    executableCandidates: [executablePath],
    execFileImpl: async () => {
      const error = new Error("timeout")
      error.killed = true
      error.signal = "SIGTERM"
      throw error
    }
  })

  await assert.rejects(
    adapter.probe(),
    (error) => error?.code === "ANTIGRAVITY_PROBE_TIMEOUT"
  )
})

test("trusted exhausted readiness records blocked capacity without consuming a run attempt", async () => {
  const fixture = await makePlannedRun()
  const before = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  const adapter = adapterFromProbe(async () => probeResult({
    exitCode: 1,
    stderr: "Baseline model quota reached"
  }), () => new Date("2026-10-07T13:00:10.000Z"))

  const checkpoint = await adapter.record({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir
  })
  const after = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(checkpoint.observation.sourceId, "reviewed-runtime-probe")
  assert.equal(checkpoint.dispatch.outcome, "blocked_capacity")
  assert.equal(checkpoint.dispatch.consumeAttempt, false)
  assert.equal(after.version, before.version)
  assert.equal(after.status, before.status)
  assert.deepEqual(after.attempts, before.attempts)
})

test("successful models probe without quota evidence never guesses ready", async () => {
  const fixture = await makePlannedRun()
  const adapter = adapterFromProbe(async () => probeResult({
    stdout: "models available"
  }), () => new Date("2026-10-07T13:00:10.000Z"))

  const checkpoint = await adapter.record({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(checkpoint.observation.capacity, "unknown")
  assert.equal(checkpoint.dispatch.outcome, "blocked_external")
  assert.equal(checkpoint.dispatch.consumeAttempt, false)
})

test("trusted ready checkpoint plus fresh trusted probe yields ephemeral dispatch authorization", async () => {
  const fixture = await makePlannedRun()
  let currentMs = Date.parse("2026-10-07T13:01:00.000Z")
  const adapter = adapterFromProbe(
    async () => probeResult({
      stdout: "Gemini 3.8 Flash (Low)\n40% remaining · Refreshes in 1h"
    }),
    () => new Date(currentMs)
  )

  const ready = await adapter.record({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(ready.dispatch.outcome, "ready")
  currentMs += 2_000

  const authorization = await adapter.authorize({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    checkpointVersion: ready.checkpointVersion,
    capability: "implementation.frontend"
  }, {
    writeDataDir: fixture.writeDataDir
  })

  assert.equal(authorization.workerId, "antigravity")
  assert.equal(authorization.checkpointVersion, ready.checkpointVersion)
  assert.deepEqual(authorization.skills, ["ui-ux-pro-max"])
  assert.equal(adapter.assertAuthorization(authorization), authorization)

  const serializedCopy = JSON.parse(JSON.stringify(authorization))
  assert.throws(
    () => adapter.assertAuthorization(serializedCopy),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_INVALID"
  )
})

test("caller-authored historical checkpoint cannot authorize dispatch", async () => {
  const fixture = await makePlannedRun()
  const checkpoint = await recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0,
    observation: {
      workerId: "antigravity",
      integration: "configured",
      capacity: "available",
      sourceId: "owner-observation",
      observedAt: "2026-10-07T13:01:00.000Z"
    }
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T13:01:01.000Z")
  })
  const adapter = adapterFromProbe(
    async () => probeResult({ stdout: "Quota available" }),
    () => new Date("2026-10-07T13:01:02.000Z")
  )

  await assert.rejects(
    adapter.authorize({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      checkpointVersion: checkpoint.checkpointVersion,
      capability: "implementation.backend"
    }, {
      writeDataDir: fixture.writeDataDir
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH"
  )
})

test("stale checkpoint version cannot authorize dispatch", async () => {
  const fixture = await makePlannedRun()
  const adapter = adapterFromProbe(
    async () => probeResult({ stdout: "100% remaining" }),
    () => new Date("2026-10-07T13:01:00.000Z")
  )
  const ready = await adapter.record({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir
  })

  await assert.rejects(
    adapter.authorize({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      checkpointVersion: ready.checkpointVersion + 1,
      capability: "implementation.backend"
    }, {
      writeDataDir: fixture.writeDataDir
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH"
  )
})

test("stale run cannot receive dispatch authorization", async () => {
  const fixture = await makePlannedRun()
  const adapter = adapterFromProbe(async () => probeResult({ stdout: "100% remaining" }))

  await assert.rejects(
    adapter.authorize({
      runId: fixture.run.runId,
      runVersion: fixture.run.version - 1,
      checkpointVersion: 1,
      capability: "implementation.frontend"
    }, {
      writeDataDir: fixture.writeDataDir
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_RUN_STALE"
  )
})

test("authorization expires quickly and cannot be replayed indefinitely", async () => {
  const fixture = await makePlannedRun()
  let currentMs = Date.parse("2026-10-07T13:00:00.000Z")
  const adapter = adapterFromProbe(
    async () => probeResult({ stdout: "100% remaining" }),
    () => new Date(currentMs)
  )
  const ready = await adapter.record({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir
  })
  currentMs += 30_000
  const authorization = await adapter.authorize({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    checkpointVersion: ready.checkpointVersion,
    capability: "implementation.backend"
  }, {
    writeDataDir: fixture.writeDataDir
  })
  currentMs += 3 * 60 * 1000

  assert.throws(
    () => adapter.assertAuthorization(authorization),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_EXPIRED"
  )
})

test("non-Antigravity capability cannot use Antigravity readiness adapter", async () => {
  const fixture = await makePlannedRun()
  const adapter = adapterFromProbe(async () => probeResult({ stdout: "100% remaining" }))

  await assert.rejects(
    adapter.record({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "testing",
      expectedCheckpointVersion: 0
    }, {
      writeDataDir: fixture.writeDataDir
    }),
    (error) => error?.code === "ANTIGRAVITY_CAPABILITY_MISMATCH"
  )
})
