import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, rm } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { RECOVERY_ACCEPTANCE_CASES, runCase, withOwnedChild, readinessFailureCode, acceptanceCaseResult } from "./phase-6-recovery-acceptance.mjs"
import { fixture, git, options, PROJECT } from "./phase-6-acceptance-fixture.mjs"
import { resolveAutomatedTestPolicyIdentity } from "./development-test-runner.mjs"

test("readiness diagnostics retain bounded codes and exclude raw output", () => {
  assert.equal(readinessFailureCode("codex_execution_ambiguous"), "codex_execution_ambiguous")
  for (const value of [undefined, {}, "raw output with spaces", "/private/path", "x".repeat(81)]) {
    assert.equal(readinessFailureCode(value), "unclassified")
  }
})

for (const platform of ["darwin", "linux"]) {
  test(`fixture test policy is accepted by production validation: ${platform}`, () => {
    const config = options({}, 0, platform)
    const identity = resolveAutomatedTestPolicyIdentity({ project: { id: PROJECT } }, config)
    assert.equal(identity.requiredTestCount, 2)
    assert.equal(config.testPolicyRegistry[PROJECT].sandbox.type,
      platform === "darwin" ? "macos-sandbox-exec" : "codex-native-linux")
  })
}

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const revision = await git(["rev-parse", "HEAD"], ROOT)
for (const mode of ["fail-before-ready", "silent"]) {
  test(`matrix reports ${mode} and observes child cleanup`, { timeout: 20000 }, async () => {
    const f = await fixture(ROOT, revision, "6D")
    let child
    try {
      const result = await acceptanceCaseResult("OWN-01", revision, () =>
        withOwnedChild(f, mode, () => { throw Error("unexpected ready") }, {
          spawned(c) { child = c }, readyTimeoutMs: mode === "silent" ? 300 : 15000
        }))
      assert.equal(result.outcome, "FAIL")
      assert.equal(result.reason, mode === "silent" ? "ready-timeout" : "readiness-failed")
      assert.equal(result.childReason, mode === "silent" ? undefined : "FIXTURE_PRE_READY_FAILURE")
      assert.ok(JSON.stringify(result).length < 600)
      assert.ok(child.exitCode !== null || child.signalCode !== null)
      assert.throws(() => process.kill(child.pid, 0), e => e.code === "ESRCH")
    } finally {
      if (child && (child.exitCode !== null || child.signalCode !== null)) await rm(f.temp, { recursive: true })
    }
  })
}

test("matrix excludes arbitrary exception content and labels SKIP", async () => {
  const result = await acceptanceCaseResult("OWN-01", revision, () => {
    throw Object.assign(Error("secret /private/path"), { reason: "secret", code: "SECRET" })
  })
  assert.equal(result.reason, "case-failed")
  assert.doesNotMatch(JSON.stringify(result), /secret|private|SECRET/)
  assert.equal((await acceptanceCaseResult("MAC-STALE", revision, () => "SKIP")).reason, "unsupported-host")
  assert.equal((await acceptanceCaseResult("OWN-01", revision, () => "PASS")).reason, undefined)
})
for (const id of RECOVERY_ACCEPTANCE_CASES.filter(id => id !== "MAC-STALE")) {
  test(`same-fixture interruption and recovery: ${id}`, { timeout: 30000 }, async () => {
    assert.equal(await runCase(id, revision), "PASS")
  })
}

for (const failure of ["spawned", "ready", "operation", "readiness-timeout"]) {
  test(`child is observed dead on ${failure} failure`, { timeout: 20000 }, async () => {
    const f = await fixture(ROOT, revision, "6D")
    let child
    const fail = () => { throw Error("injected") }
    const hooks = {
      spawned(c) { child = c; if (failure === "spawned") fail() },
      ready: failure === "ready" ? fail : undefined,
      readyTimeoutMs: failure === "readiness-timeout" ? 300 : 15000
    }
    try {
      await assert.rejects(() => withOwnedChild(f, failure === "readiness-timeout" ? "silent" : "edit", fail, hooks))
      assert.ok(child)
      assert.ok(child.exitCode !== null || child.signalCode !== null)
      assert.throws(() => process.kill(child.pid, 0), error => error.code === "ESRCH")
    } finally {
      if (child && (child.exitCode !== null || child.signalCode !== null)) await rm(f.temp, { recursive: true })
    }
  })
}

test("documented CLI includes revision and rejects a wrong revision before cases", async () => {
  const doc = await readFile(new URL("./phase-6-recovery-acceptance.md", import.meta.url), "utf8")
  assert.match(doc, /phase-6-recovery-acceptance\.mjs --expected-revision/u)
  await assert.rejects(promisify(execFile)(process.execPath, [
    "local-operator/phase-6-recovery-acceptance.mjs", "--expected-revision", "0".repeat(40)
  ], { cwd: ROOT, timeout: 5000 }), error => {
    assert.equal(error.code, 1)
    assert.equal(error.stdout, "")
    return true
  })
})

test("cleanup escalates and observes a real child ignoring SIGTERM", { timeout: 20000 }, async () => {
  const f = await fixture(ROOT, revision, "6D")
  let child
  try {
    await withOwnedChild(f, "ignore-term", async ({ stop }) => {
      assert.equal((await stop()).signal, "SIGKILL")
    }, { spawned(c) { child = c } })
    assert.equal(child.signalCode, "SIGKILL")
    assert.throws(() => process.kill(child.pid, 0), error => error.code === "ESRCH")
  } finally {
    if (child && (child.exitCode !== null || child.signalCode !== null)) await rm(f.temp, { recursive: true })
  }
})
