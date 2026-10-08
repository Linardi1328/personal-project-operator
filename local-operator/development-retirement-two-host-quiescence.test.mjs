import assert from "node:assert/strict"
import test from "node:test"
import {
  createTwoHostRetirementQuiescenceCoordinator,
  RETIREMENT_QUIESCENCE_PORT_ORDER
} from "./development-retirement-two-host-quiescence.mjs"

const RUN_A = "JKjs4fO20mMh3kwO93uTHx3PMV-X--wWPSv9nedHb7U"
const RUN_B = "kqA2X9fEomYXqKy4fZdE_6bilD8KLTGhREhjp-uwRLk"
const request = { runId: RUN_A, writeDataDir: "/synthetic/ppo-private-store" }
const failure = { code: "RETIREMENT_QUIESCENCE_UNVERIFIABLE" }

function fixture(overrides = {}) {
  const events = []
  const states = {}
  const ports = Object.fromEntries(RETIREMENT_QUIESCENCE_PORT_ORDER.map(role => [
    role,
    {
      async acquire(context) {
        events.push("acquire:" + role)
        states[role] = { context, held: true }
        return {
          role, runId: context.runId, writeDataDir: context.writeDataDir,
          epoch: context.epoch, exclusive: true, quiescent: true,
          unknownOperations: [],
          async assertHeld(probe) {
            events.push("assert:" + role)
            return states[role].held && probe.epoch === context.epoch
          },
          async release(probe) {
            events.push("release:" + role)
            assert.equal(probe.epoch, context.epoch)
            states[role].held = false
          }
        }
      }
    }
  ]))
  for (const [role, port] of Object.entries(overrides)) {
    ports[role] = port
  }
  return { events, states, ports }
}

test("missing uninstalled host authorities fail closed without invoking any port", async () => {
  const coordinator = createTwoHostRetirementQuiescenceCoordinator()
  await assert.rejects(coordinator.acquireQuiescenceGuard(request), failure)
})

test("out-of-scope run and invalid storage fail before any acquisition", async () => {
  const f = fixture()
  const coordinator = createTwoHostRetirementQuiescenceCoordinator(f.ports)
  for (const input of [
    { ...request, runId: RUN_A.slice(1) },
    { ...request, runId: "mbd-YnAdRpZoCjdmXKZc1mz1m9hn7RZuO9ewsKctfZ4" },
    { ...request, writeDataDir: "relative/path" },
    {},
    null
  ]) {
    await assert.rejects(coordinator.acquireQuiescenceGuard(input), failure)
  }
  assert.deepEqual(f.events, [])
})

test("complete synthetic guard checks both hosts, writer and delivery through release", async () => {
  const f = fixture()
  const coordinator = createTwoHostRetirementQuiescenceCoordinator(f.ports)
  const guard = await coordinator.acquireQuiescenceGuard(request)
  assert.deepEqual(f.events.slice(0, 4), RETIREMENT_QUIESCENCE_PORT_ORDER.map(r => "acquire:" + r))
  assert.equal(guard.exclusive, true)
  assert.equal(guard.workersQuiescent, true)
  assert.equal(guard.deliveryQuiescent, true)
  assert.equal(await guard.assertHeld(), true)
  await assert.rejects(coordinator.acquireQuiescenceGuard({ ...request, runId: RUN_B }), failure)
  await guard.release()
  assert.deepEqual(f.events.slice(-4), [...RETIREMENT_QUIESCENCE_PORT_ORDER].reverse().map(r => "release:" + r))
  assert.equal(await guard.assertHeld(), false)
  await assert.rejects(guard.release(), failure)
  // New requests use a new epoch, never accept a stale assertion.
  const next = await coordinator.acquireQuiescenceGuard({ ...request, runId: RUN_B })
  assert.notEqual(f.states.writer.context.epoch, null)
  await next.release()
})

for (const role of RETIREMENT_QUIESCENCE_PORT_ORDER) {
  for (const errorCase of ["unreachable", "forged-role", "wrong-epoch", "unknown-work", "not-exclusive", "unproven-quiescence", "missing-assertion"]) {
    test(role + " " + errorCase + " blocks and releases all acquired synthetic authorities", async () => {
      const f = fixture()
      const original = f.ports[role].acquire
      f.ports[role].acquire = async context => {
        if (errorCase === "unreachable") throw Error("SENSITIVE_REMOTE_FAILURE")
        const lease = await original(context)
        if (errorCase === "forged-role") lease.role = "not-" + role
        if (errorCase === "wrong-epoch") lease.epoch = "stale-epoch"
        if (errorCase === "unknown-work") lease.unknownOperations = ["untracked"]
        if (errorCase === "not-exclusive") lease.exclusive = false
        if (errorCase === "unproven-quiescence") lease.quiescent = null
        if (errorCase === "missing-assertion") lease.assertHeld = null
        return lease
      }
      const coordinator = createTwoHostRetirementQuiescenceCoordinator(f.ports)
      await assert.rejects(coordinator.acquireQuiescenceGuard(request), failure)
      const attained = f.events.filter(e => e.startsWith("acquire:")).map(e => e.slice(8))
      const released = f.events.filter(e => e.startsWith("release:")).map(e => e.slice(8))
      assert.deepEqual(released, attained.filter(r => r !== role || errorCase !== "unreachable").reverse())
      // A failed remote acquisition could have partially succeeded; the same
      // coordinator must never silently start a fresh acquisition.
      const before = f.events.length
      await assert.rejects(coordinator.acquireQuiescenceGuard({ ...request, runId: RUN_B }), failure)
      assert.equal(f.events.length, before)
    })
  }
}

for (const role of RETIREMENT_QUIESCENCE_PORT_ORDER) {
  test("held guard fails closed if " + role + " loses its fence", async () => {
    const f = fixture()
    const coordinator = createTwoHostRetirementQuiescenceCoordinator(f.ports)
    const guard = await coordinator.acquireQuiescenceGuard(request)
    f.states[role].held = false
    assert.equal(await guard.assertHeld(), false)
    f.states[role].held = true
    assert.equal(await guard.assertHeld(), false, "a lost fence cannot become trusted again")
    await guard.release()
    await assert.rejects(coordinator.acquireQuiescenceGuard(request), failure)
  })
}

test("partial release failure poisons coordinator against subsequent acquisitions", async () => {
  const f = fixture()
  const original = f.ports.mac.acquire
  f.ports.mac.acquire = async context => {
    const lease = await original(context)
    lease.release = async () => { throw Error("SENSITIVE_RELEASE_FAILURE") }
    return lease
  }
  const coordinator = createTwoHostRetirementQuiescenceCoordinator(f.ports)
  const guard = await coordinator.acquireQuiescenceGuard(request)
  await assert.rejects(guard.release(), failure)
  await assert.rejects(coordinator.acquireQuiescenceGuard(request), failure)
})

test("partial acquisition cleanup failure poisons coordinator and leaves live data untouched", async () => {
  const f = fixture()
  const orig = f.ports.mac.acquire
  f.ports.mac.acquire = async context => {
    const lease = await orig(context)
    lease.release = async () => { throw Error("SENSITIVE_CLEANUP_FAILURE") }
    return lease
  }
  f.ports.vps.acquire = async () => { throw Error("SENSITIVE_REMOTE_FAILURE") }
  const coordinator = createTwoHostRetirementQuiescenceCoordinator(f.ports)
  await assert.rejects(coordinator.acquireQuiescenceGuard(request), failure)
  assert.deepEqual(f.events.filter(e => e.startsWith("release:")), ["release:writer"])
  await assert.rejects(coordinator.acquireQuiescenceGuard(request), failure)
})

test("unknown/uncooperative asynchronous second host never produces a guard", async () => {
  const f = fixture()
  let unblock, signalReached
  const reached = new Promise(resolve => { signalReached = resolve })
  f.ports.vps.acquire = async () => await new Promise(resolve => {
    unblock = resolve
    signalReached()
  })
  const coordinator = createTwoHostRetirementQuiescenceCoordinator(f.ports)
  const pending = coordinator.acquireQuiescenceGuard(request)
  await reached
  await assert.rejects(coordinator.acquireQuiescenceGuard(request), failure)
  unblock(null)
  await assert.rejects(pending, failure)
})

test("single use guard cannot be rereleased or treated as held after release", async () => {
  const f = fixture()
  const coordinator = createTwoHostRetirementQuiescenceCoordinator(f.ports)
  const guard = await coordinator.acquireQuiescenceGuard(request)
  await guard.release()
  assert.equal(await guard.assertHeld(), false)
  await assert.rejects(guard.release(), failure)
})
