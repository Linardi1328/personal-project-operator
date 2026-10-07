import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createDevelopmentRun,
  transitionDevelopmentRun
} from "./development-run-state.mjs"
import {
  recordSoftwareFactoryDispatchCheckpoint
} from "./software-factory-dispatch-checkpoint.mjs"
import {
  authorizeSoftwareFactoryExecution,
  probeAndAttestSoftwareFactoryWorkerCapacity,
  verifySoftwareFactoryCapacityAttestation
} from "./software-factory-capacity-attestation.mjs"

function makeClock(start = "2026-10-07T12:00:00.000Z") {
  let tick = 0
  const base = Date.parse(start)
  return () => new Date(base + tick++ * 1000)
}

async function makeImplementationRun() {
  const root = await mkdtemp(join(tmpdir(), "ppo-factory-attestation-"))
  const writeDataDir = join(root, "write-data")
  const now = makeClock()
  const sha = "b".repeat(40)
  const created = await createDevelopmentRun({
    projectId: "khlim-digital-ecosystem",
    task: "Fix the approved frontend blocker.",
    baseSha: sha,
    branch: "main",
    headSha: sha,
    actor: "factory-attestation-test"
  }, { writeDataDir, now })
  const planning = await transitionDevelopmentRun(created.runId, {
    expectedVersion: created.version,
    status: "planning_in_progress",
    actor: "factory-attestation-test"
  }, { writeDataDir, now })
  const planned = await transitionDevelopmentRun(created.runId, {
    expectedVersion: planning.version,
    status: "planned",
    actor: "factory-attestation-test"
  }, { writeDataDir, now })
  const implementing = await transitionDevelopmentRun(planned.runId, {
    expectedVersion: planned.version,
    status: "implementation_in_progress",
    actor: "factory-attestation-test"
  }, { writeDataDir, now })

  return { root, writeDataDir, run: implementing }
}

function probe({
  workerId = "antigravity",
  integration = "configured",
  capacity = "available",
  observedAt = "2026-10-07T12:00:10.000Z"
} = {}) {
  return { workerId, integration, capacity, observedAt }
}

async function checkpointFor(fixture, capability = "implementation.frontend") {
  return recordSoftwareFactoryDispatchCheckpoint({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability,
    expectedCheckpointVersion: 0,
    observation: {
      workerId: "antigravity",
      integration: "configured",
      capacity: "available",
      sourceId: "reviewed-runtime-probe",
      observedAt: "2026-10-07T12:00:09.000Z"
    }
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T12:00:10.000Z")
  })
}

test("reviewed runtime probe can mint and verify a fresh attestation", async () => {
  const fixture = await makeImplementationRun()
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("antigravity", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe()
  })
  const verified = await verifySoftwareFactoryCapacityAttestation(attestation, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T12:00:11.000Z")
  })

  assert.equal(verified.workerId, "antigravity")
  assert.equal(verified.capacity, "available")
  assert.equal(verified.issuerId, "reviewed-runtime-probe-v1")
  assert.ok(!Object.hasOwn(verified, "signature"))
})

test("tampered capacity attestation is rejected", async () => {
  const fixture = await makeImplementationRun()
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("antigravity", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe()
  })

  await assert.rejects(
    verifySoftwareFactoryCapacityAttestation({
      ...attestation,
      capacity: "exhausted"
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T12:00:11.000Z")
    }),
    (error) => error?.code === "FACTORY_ATTESTATION_SIGNATURE_INVALID"
  )
})

test("expired attestation is rejected", async () => {
  const fixture = await makeImplementationRun()
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("antigravity", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe({
      observedAt: "2026-10-07T10:00:00.000Z"
    })
  })

  await assert.rejects(
    verifySoftwareFactoryCapacityAttestation(attestation, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T12:00:11.000Z")
    }),
    (error) => error?.code === "FACTORY_ATTESTATION_EXPIRED"
  )
})

test("fresh verified attestation can authorize current implementation execution", async () => {
  const fixture = await makeImplementationRun()
  const checkpoint = await checkpointFor(fixture)
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("antigravity", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe()
  })

  const authorization = await authorizeSoftwareFactoryExecution({
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    checkpointVersion: checkpoint.checkpointVersion,
    attestation
  }, {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T12:00:11.000Z")
  })

  assert.equal(authorization.authorized, true)
  assert.equal(authorization.workerId, "antigravity")
  assert.deepEqual(authorization.skills, ["ui-ux-pro-max"])
  assert.ok(!Object.hasOwn(authorization, "signature"))
  assert.ok(!Object.hasOwn(authorization, "nonce"))
})

test("attestation replay is rejected after successful authorization", async () => {
  const fixture = await makeImplementationRun()
  const checkpoint = await checkpointFor(fixture)
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("antigravity", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe()
  })
  const input = {
    runId: fixture.run.runId,
    runVersion: fixture.run.version,
    capability: "implementation.frontend",
    checkpointVersion: checkpoint.checkpointVersion,
    attestation
  }
  const options = {
    writeDataDir: fixture.writeDataDir,
    now: () => new Date("2026-10-07T12:00:11.000Z")
  }

  await authorizeSoftwareFactoryExecution(input, options)
  await assert.rejects(
    authorizeSoftwareFactoryExecution(input, options),
    (error) => error?.code === "FACTORY_ATTESTATION_REPLAYED"
  )
})

test("stale checkpoint version cannot authorize execution", async () => {
  const fixture = await makeImplementationRun()
  const checkpoint = await checkpointFor(fixture)
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("antigravity", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe()
  })

  await assert.rejects(
    authorizeSoftwareFactoryExecution({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "implementation.frontend",
      checkpointVersion: checkpoint.checkpointVersion + 1,
      attestation
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T12:00:11.000Z")
    }),
    (error) => error?.code === "FACTORY_AUTHORIZATION_CHECKPOINT_STALE"
  )
})

test("wrong worker attestation cannot authorize capability", async () => {
  const fixture = await makeImplementationRun()
  const checkpoint = await checkpointFor(fixture)
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("chatgpt", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe({ workerId: "chatgpt" })
  })

  await assert.rejects(
    authorizeSoftwareFactoryExecution({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "implementation.frontend",
      checkpointVersion: checkpoint.checkpointVersion,
      attestation
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T12:00:11.000Z")
    }),
    (error) => error?.code === "FACTORY_AUTHORIZATION_WORKER_MISMATCH"
  )
})

test("non-ready verified worker state cannot authorize execution", async () => {
  const fixture = await makeImplementationRun()
  const checkpoint = await checkpointFor(fixture)
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("antigravity", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe({ capacity: "exhausted" })
  })

  await assert.rejects(
    authorizeSoftwareFactoryExecution({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "implementation.frontend",
      checkpointVersion: checkpoint.checkpointVersion,
      attestation
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T12:00:11.000Z")
    }),
    (error) => error?.code === "FACTORY_AUTHORIZATION_NOT_READY"
  )
})

test("historical checkpoint alone cannot authorize execution", async () => {
  const fixture = await makeImplementationRun()
  const checkpoint = await checkpointFor(fixture)

  await assert.rejects(
    authorizeSoftwareFactoryExecution({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "implementation.frontend",
      checkpointVersion: checkpoint.checkpointVersion
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T12:00:11.000Z")
    }),
    (error) => error?.code === "FACTORY_ATTESTATION_INVALID"
  )
})

test("owner-gated production capability cannot be authorized by capacity attestation", async () => {
  const fixture = await makeImplementationRun()
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("vercel", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe({ workerId: "vercel" })
  })

  await assert.rejects(
    authorizeSoftwareFactoryExecution({
      runId: fixture.run.runId,
      runVersion: fixture.run.version,
      capability: "deployment.production",
      checkpointVersion: 1,
      attestation
    }, {
      writeDataDir: fixture.writeDataDir,
      now: () => new Date("2026-10-07T12:00:11.000Z")
    }),
    (error) => error?.code === "FACTORY_AUTHORIZATION_OWNER_REQUIRED"
  )
})

test("attestation key is private and does not enter checkpoint JSON", async () => {
  const fixture = await makeImplementationRun()
  const checkpoint = await checkpointFor(fixture)
  const attestation = await probeAndAttestSoftwareFactoryWorkerCapacity("antigravity", {
    writeDataDir: fixture.writeDataDir,
    trustedRuntimeProbeImpl: async () => probe()
  })

  const keyPath = join(
    fixture.writeDataDir,
    "software-factory-capacity-attestations",
    "attestation-key-v1"
  )
  const info = await stat(keyPath)
  assert.equal(info.mode & 0o077, 0)

  const checkpointPath = join(
    fixture.writeDataDir,
    "software-factory-dispatch-checkpoints",
    fixture.run.runId,
    "000001.json"
  )
  const stored = await readFile(checkpointPath, "utf8")
  assert.equal(stored.includes(attestation.signature), false)
  assert.equal(stored.includes(attestation.nonce), false)
})
