import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"

const exec = promisify(execFile)
const root = fileURLToPath(new URL("../../", import.meta.url))
const runner = "deployment/scripts/run-ppo-development-quality.mjs"
const gates = ["syntax", "parallel-regression", "serial-regression", "critical-lifecycle", "integrated-acceptance"]

test("quality runner blocks every workload on capability drift and missing validator", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "ppo-quality-preflight-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  // Copy only checked-in source directories from this checkout, never run data.
  for (const directory of ["capabilities", "local-operator", ".github"]) {
    await cp(join(root, directory), join(fixture, directory), {
      recursive: true, filter: path => !path.split("/").includes("write-data")
    })
  }
  await cp(join(root, runner), join(fixture, runner))
  const manifestPath = join(fixture, "capabilities/personal-project-operator.json")
  const original = await readFile(manifestPath, "utf8")
  const manifest = JSON.parse(original)
  manifest.localQualityGates[0].timeoutMs++
  await writeFile(manifestPath, JSON.stringify(manifest))

  for (const gate of gates) {
    await assert.rejects(exec(process.execPath, [runner, gate], { cwd: fixture, timeout: 10000 }), error => {
      assert.equal(error.code, 1)
      const checks = error.stdout.trim().split("\n").map(JSON.parse)
      assert.equal(checks.length, 7)
      assert.deepEqual(checks.find(check => check.id === "quality-gates"), { id: "quality-gates", outcome: "FAIL" })
      // Workload execution would encounter absent deployment/bin or test fixtures.
      assert.equal(error.stderr, "")
      return true
    })
  }

  await rm(manifestPath)
  await assert.rejects(exec(process.execPath, [runner, "syntax"], { cwd: fixture, timeout: 10000 }), error => {
    assert.equal(error.code, 1)
    assert.deepEqual(JSON.parse(error.stdout), { id: "sources", outcome: "FAIL" })
    assert.equal(error.stderr, "")
    return true
  })
  await writeFile(manifestPath, original)
  await rm(join(fixture, "capabilities/validate-ppo.mjs"))
  await assert.rejects(exec(process.execPath, [runner, "syntax"], { cwd: fixture, timeout: 10000 }), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /MODULE_NOT_FOUND/)
    assert.equal(error.stdout, "")
    return true
  })
})
