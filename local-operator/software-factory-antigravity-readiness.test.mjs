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
  assertAntigravityDispatchAuthorization,
  classifyAntigravityCommandFailure,
  classifyAntigravityProbeText,
  validateAntigravityDispatchCheckpointBinding,
  validateAntigravityExecutableCandidate,
  validateAntigravityProbeOutput
} from "./software-factory-antigravity-readiness.mjs"

async function makeExecutable(mode = 0o755) {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-executable-"))
  const path = join(root, "agy")
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8")
  await chmod(path, mode)
  return { root, path }
}

function readyRun(overrides = {}) {
  return {
    runId: "abcdefghijklmnop",
    version: 3,
    status: "planned",
    project: {
      id: "khlim-digital-ecosystem"
    },
    ...overrides
  }
}

function readyCheckpoint(overrides = {}) {
  return {
    checkpointVersion: 2,
    runVersion: 3,
    capability: "implementation.frontend",
    workerId: "antigravity",
    modelClass: "standard",
    skills: ["ui-ux-pro-max"],
    observation: {
      sourceId: "reviewed-runtime-probe",
      fresh: true,
      expiresAt: "2026-10-07T13:15:00.000Z"
    },
    dispatch: {
      outcome: "ready",
      consumeAttempt: true
    },
    ...overrides
  }
}

function bindingInput(overrides = {}) {
  return {
    runId: "abcdefghijklmnop",
    runVersion: 3,
    checkpointVersion: 2,
    capability: "implementation.frontend",
    ...overrides
  }
}

test("quota reached is classified as exhausted", () => {
  assert.deepEqual(
    classifyAntigravityProbeText("Individual quota reached."),
    { integration: "configured", capacity: "exhausted" }
  )
})

test("rate limiting is classified without guessing availability", () => {
  assert.deepEqual(
    classifyAntigravityProbeText("429 too many requests: rate limited"),
    { integration: "configured", capacity: "rate_limited" }
  )
})

test("authentication failure is unavailable", () => {
  assert.deepEqual(
    classifyAntigravityProbeText("Authentication required. Please sign in."),
    { integration: "unconfigured", capacity: "unavailable" }
  )
})

test("remaining quota above twenty percent is available", () => {
  assert.deepEqual(
    classifyAntigravityProbeText("Gemini 3.8 Flash\n40% remaining · Refreshes in 1h"),
    { integration: "configured", capacity: "available" }
  )
})

test("reset timestamp does not imply exhaustion while quota remains", () => {
  assert.deepEqual(
    classifyAntigravityProbeText("Gemini 3.8 Flash\n40% remaining · Resets in 1h"),
    { integration: "configured", capacity: "available" }
  )
})

test("low remaining quota is degraded", () => {
  assert.deepEqual(
    classifyAntigravityProbeText("15% remaining"),
    { integration: "configured", capacity: "degraded" }
  )
})

test("zero remaining quota is exhausted", () => {
  assert.deepEqual(
    classifyAntigravityProbeText("0% remaining"),
    { integration: "configured", capacity: "exhausted" }
  )
})

test("quota available phrase is available", () => {
  assert.deepEqual(
    classifyAntigravityProbeText("Quota available"),
    { integration: "configured", capacity: "available" }
  )
})

test("unrecognized text yields no capacity classification", () => {
  assert.equal(classifyAntigravityProbeText("models available"), null)
})

test("sensitive probe output is refused", () => {
  assert.throws(
    () => validateAntigravityProbeOutput("token=sk-test-secret-value", ""),
    (error) => error?.code === "ANTIGRAVITY_PROBE_OUTPUT_UNSAFE"
  )
})

test("oversized probe output is refused", () => {
  assert.throws(
    () => validateAntigravityProbeOutput("x".repeat(70 * 1024), ""),
    (error) => error?.code === "ANTIGRAVITY_PROBE_OUTPUT_INVALID"
  )
})

test("maxBuffer overflow maps to output-invalid failure class", () => {
  assert.equal(
    classifyAntigravityCommandFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }),
    "output_invalid"
  )
  assert.equal(
    classifyAntigravityCommandFailure({ code: "ENOBUFS", killed: true }),
    "output_invalid"
  )
})

test("timeout remains distinct from output overflow", () => {
  assert.equal(
    classifyAntigravityCommandFailure({ code: "ETIMEDOUT", killed: true }),
    "timeout"
  )
  assert.equal(
    classifyAntigravityCommandFailure({ signal: "SIGTERM", killed: true }),
    "timeout"
  )
})

test("ordinary nonzero command failure remains generic", () => {
  assert.equal(classifyAntigravityCommandFailure({ code: 2 }), "failure")
})

test("canonical private executable candidate is accepted", async () => {
  const fixture = await makeExecutable()
  assert.equal(await validateAntigravityExecutableCandidate(fixture.path), fixture.path)
})

test("symlinked executable candidate is refused", async () => {
  const fixture = await makeExecutable()
  const alias = join(fixture.root, "agy-link")
  await symlink(fixture.path, alias)

  await assert.rejects(
    validateAntigravityExecutableCandidate(alias),
    (error) => error?.code === "ANTIGRAVITY_PROBE_UNTRUSTED"
  )
})

test("group or world writable executable candidate is refused", async () => {
  const fixture = await makeExecutable(0o777)

  await assert.rejects(
    validateAntigravityExecutableCandidate(fixture.path),
    (error) => error?.code === "ANTIGRAVITY_PROBE_UNTRUSTED"
  )
})

test("missing executable candidate is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ppo-agy-missing-"))

  await assert.rejects(
    validateAntigravityExecutableCandidate(join(root, "missing")),
    (error) => error?.code === "ANTIGRAVITY_PROBE_UNAVAILABLE"
  )
})

test("current reviewed ready checkpoint passes structural authorization binding", () => {
  const result = validateAntigravityDispatchCheckpointBinding({
    run: readyRun(),
    checkpoint: readyCheckpoint(),
    input: bindingInput(),
    now: new Date("2026-10-07T13:10:00.000Z")
  })

  assert.deepEqual(result, {
    runId: "abcdefghijklmnop",
    runVersion: 3,
    checkpointVersion: 2,
    capability: "implementation.frontend",
    workerId: "antigravity",
    modelClass: "standard",
    skills: ["ui-ux-pro-max"]
  })
})

test("caller-authored observation cannot satisfy trusted authorization binding", () => {
  assert.throws(
    () => validateAntigravityDispatchCheckpointBinding({
      run: readyRun(),
      checkpoint: readyCheckpoint({
        observation: {
          sourceId: "owner-observation",
          fresh: true,
          expiresAt: "2026-10-07T13:15:00.000Z"
        }
      }),
      input: bindingInput(),
      now: new Date("2026-10-07T13:10:00.000Z")
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH"
  )
})

test("stale checkpoint version cannot satisfy authorization binding", () => {
  assert.throws(
    () => validateAntigravityDispatchCheckpointBinding({
      run: readyRun(),
      checkpoint: readyCheckpoint(),
      input: bindingInput({ checkpointVersion: 3 }),
      now: new Date("2026-10-07T13:10:00.000Z")
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH"
  )
})

test("expired trusted observation cannot satisfy authorization binding", () => {
  assert.throws(
    () => validateAntigravityDispatchCheckpointBinding({
      run: readyRun(),
      checkpoint: readyCheckpoint({
        observation: {
          sourceId: "reviewed-runtime-probe",
          fresh: true,
          expiresAt: "2026-10-07T13:09:59.000Z"
        }
      }),
      input: bindingInput(),
      now: new Date("2026-10-07T13:10:00.000Z")
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH"
  )
})

test("non-ready checkpoint cannot satisfy authorization binding", () => {
  assert.throws(
    () => validateAntigravityDispatchCheckpointBinding({
      run: readyRun(),
      checkpoint: readyCheckpoint({
        dispatch: {
          outcome: "blocked_capacity",
          consumeAttempt: false
        }
      }),
      input: bindingInput(),
      now: new Date("2026-10-07T13:10:00.000Z")
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH"
  )
})

test("terminal run cannot satisfy authorization binding", () => {
  assert.throws(
    () => validateAntigravityDispatchCheckpointBinding({
      run: readyRun({ status: "verified" }),
      checkpoint: readyCheckpoint(),
      input: bindingInput(),
      now: new Date("2026-10-07T13:10:00.000Z")
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH"
  )
})

test("reconstructed authorization object is rejected by production authority", () => {
  assert.throws(
    () => assertAntigravityDispatchAuthorization({
      kind: "software-factory-antigravity-dispatch-authorization",
      runId: "abcdefghijklmnop",
      runVersion: 3,
      checkpointVersion: 2
    }),
    (error) => error?.code === "ANTIGRAVITY_AUTHORIZATION_INVALID"
  )
})
