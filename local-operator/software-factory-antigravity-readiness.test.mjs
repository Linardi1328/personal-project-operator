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
  readSoftwareFactoryDispatchCheckpoint
} from "./software-factory-dispatch-checkpoint.mjs"
import {
  assertAntigravityDispatchAuthorization,
  authorizeAntigravityDispatch,
  probeAntigravityReadiness,
  recordTrustedAntigravityReadiness
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

test("reviewed Antigravity CLI integration probe reports configured with unknown capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-probe-"))
  const executablePath = await makeTrustedExecutable(root)

  const observation = await probeAntigravityReadiness({
    allowTestOverrides: true,
    testExecutablePath: executablePath,
    execFileImpl: async () => ({
      stdout: "gemini-3.8-flash-low Gemini 3.8 Flash (Low)\n",
      stderr: ""
    }),
    now: () => new Date("2026-10-07T13:00:00.000Z")
  })

  assert.equal(observation.workerId, "antigravity")
  assert.equal(observation.sourceId, "reviewed-runtime-probe")
  assert.equal(observation.integration, "configured")
  assert.equal(observation.capacity, "unknown")
})

test("quota signal from the reviewed probe is classified as exhausted", async () => {
  const observation = await probeAntigravityReadiness({
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 1,
      stdout: "",
      stderr: "Individual quota reached. Resets in 5h20m."
    }),
    now: () => new Date("2026-10-07T13:00:00.000Z")
  })

  assert.equal(observation.integration, "configured")
  assert.equal(observation.capacity, "exhausted")
})

test("rate-limit signal from the reviewed probe is classified without guessing availability", async () => {
  const observation = await probeAntigravityReadiness({
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 1,
      stderr: "429 too many requests: rate limited"
    }),
    now: () => new Date("2026-10-07T13:00:00.000Z")
  })

  assert.equal(observation.integration, "configured")
  assert.equal(observation.capacity, "rate_limited")
})

test("authentication failure is classified as unconfigured and unavailable", async () => {
  const observation = await probeAntigravityReadiness({
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 1,
      stderr: "Authentication required. Please sign in."
    }),
    now: () => new Date("2026-10-07T13:00:00.000Z")
  })

  assert.equal(observation.integration, "unconfigured")
  assert.equal(observation.capacity, "unavailable")
})

test("unrecognized nonzero probe failure fails closed", async () => {
  const observation = await probeAntigravityReadiness({
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 2,
      stderr: "unexpected local failure"
    }),
    now: () => new Date("2026-10-07T13:00:00.000Z")
  })

  assert.equal(observation.integration, "unconfigured")
  assert.equal(observation.capacity, "unavailable")
})

test("unsafe probe output is refused and not interpreted", async () => {
  await assert.rejects(
    probeAntigravityReadiness({
      allowTestOverrides: true,
      probeRunner: async () => probeResult({
        stdout: "token=sk-test-secret-value"
      })
    }),
    (error) => error?.code === "ANTIGRAVITY_PROBE_OUTPUT_UNSAFE"
  )
})

test("oversized probe output is refused", async () => {
  await assert.rejects(
    probeAntigravityReadiness({
      allowTestOverrides: true,
      probeRunner: async () => probeResult({
        stdout: "x".repeat(70 * 1024)
      })
    }),
    (error) => error?.code === "ANTIGRAVITY_PROBE_OUTPUT_INVALID"
  )
})

test("symlinked Antigravity executable is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-symlink-"))
  const target = await makeTrustedExecutable(root)
  const alias = join(root, "agy-link")
  await symlink(target, alias)

  await assert.rejects(
    probeAntigravityReadiness({
      allowTestOverrides: true,
      testExecutablePath: alias,
      execFileImpl: async () => ({ stdout: "", stderr: "" })
    }),
    (error) => error?.code === "ANTIGRAVITY_PROBE_UNTRUSTED"
  )
})

test("group/world writable Antigravity executable is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-writable-"))
  const executablePath = await makeTrustedExecutable(root, 0o777)

  await assert.rejects(
    probeAntigravityReadiness({
      allowTestOverrides: true,
      testExecutablePath: executablePath,
      execFileImpl: async () => ({ stdout: "", stderr: "" })
    }),
    (error) => error?.code === "ANTIGRAVITY_PROBE_UNTRUSTED"
  )
})

test("caller cannot enable probe overrides without explicit test boundary", async () => {
  await assert.rejects(
    probeAntigravityReadiness({
      probeRunner: async () => probeResult()
    }),
    (error) => error?.code === "ANTIGRAVITY_PROBE_UNTRUSTED"
  )
})

test("trusted exhausted readiness records blocked capacity without consuming a run attempt", async () => {
  const fixture = await makePlannedRun()
  const before = await readDevelopmentRun(fixture.run.runId, {
    writeDataDir: fixture.writeDataDir
  })
  const checkpoint = await recordTrustedAntigravityReadiness({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir,
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 1,
      stderr: "Baseline model quota reached"
    }),
    now: () => new Date("2026-10-07T13:00:10.000Z")
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

test("available trusted readiness records a ready checkpoint only through internal provenance", async () => {
  const fixture = await makePlannedRun()
  const checkpoint = await recordTrustedAntigravityReadiness({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir,
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 0,
      stdout: "models available",
      stderr: ""
    }),
    now: () => new Date("2026-10-07T13:00:10.000Z")
  })

  assert.equal(checkpoint.observation.sourceId, "reviewed-runtime-probe")
  assert.equal(checkpoint.dispatch.outcome, "blocked_external")
  assert.equal(checkpoint.dispatch.reasonCode, "WORKER_CAPACITY_UNKNOWN")
})

test("trusted available capacity can be supplied only by a reviewed probe classification", async () => {
  const fixture = await makePlannedRun()

  const checkpoint = await recordTrustedAntigravityReadiness({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.backend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir,
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 0,
      stdout: "capacity: available"
    }),
    now: () => new Date("2026-10-07T13:00:10.000Z")
  })

  assert.equal(checkpoint.dispatch.outcome, "blocked_external")
  assert.equal(checkpoint.observation.capacity, "unknown")
})

test("ready checkpoint plus fresh reviewed probe can issue ephemeral dispatch authorization", async () => {
  const fixture = await makePlannedRun()

  const readyCheckpoint = await recordTrustedAntigravityReadiness({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 0
  }, {
    writeDataDir: fixture.writeDataDir,
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 1,
      stderr: "rate limit"
    }),
    now: () => new Date("2026-10-07T13:00:10.000Z")
  })

  assert.equal(readyCheckpoint.dispatch.outcome, "blocked_capacity")

  // Simulate the future trusted capacity source without allowing callers to forge
  // reviewed-runtime-probe provenance at the authorization boundary.
  const manuallyReady = await import("./software-factory-dispatch-checkpoint.mjs")
  const ready = await manuallyReady.recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    expectedCheckpointVersion: 1,
    observation: {
      workerId: "antigravity",
      integration: "configured",
      capacity: "available",
      sourceId: "reviewed-runtime-probe",
      observedAt: "2026-10-07T13:01:00.000Z"
    }
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T13:01:01.000Z")
  })

  const authorization = await authorizeAntigravityDispatch({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    checkpointVersion: ready.checkpointVersion,
    capability: "implementation.frontend"
  }, {
    writeDataDir: fixture.writeDataDir,
    allowTestOverrides: true,
    probeRunner: async () => probeResult({
      exitCode: 0,
      stdout: "models available"
    }),
    now: () => new Date("2026-10-07T13:01:02.000Z")
  }).catch((error) => error)

  assert.equal(authorization?.code, "ANTIGRAVITY_AUTHORIZATION_NOT_READY")
})

test("serialized authorization copy is never accepted", async () => {
  const fake = {
    kind: "software-factory-antigravity-dispatch-authorization",
    runId: "forged"
  }

  assert.throws(
    () => assertAntigravityDispatchAuthorization(fake),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_INVALID"
  )
})

test("non-Antigravity capability cannot use Antigravity readiness adapter", async () => {
  const fixture = await makePlannedRun()

  await assert.rejects(
    recordTrustedAntigravityReadiness({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "testing",
      expectedCheckpointVersion: 0
    }, {
      writeDataDir: fixture.writeDataDir,
      allowTestOverrides: true,
      probeRunner: async () => probeResult()
    }),
    (error) => error?.code === "ANTIGRAVITY_CAPABILITY_MISMATCH"
  )
})

test("stale run cannot receive dispatch authorization", async () => {
  const fixture = await makePlannedRun()

  await assert.rejects(
    authorizeAntigravityDispatch({
      runId: fixture.run.runId,
      runVersion: fixture.run.version - 1,
      checkpointVersion: 1,
      capability: "implementation.frontend"
    }, {
      writeDataDir: fixture.writeDataDir,
      allowTestOverrides: true,
      probeRunner: async () => probeResult()
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_RUN_STALE"
  )
})
