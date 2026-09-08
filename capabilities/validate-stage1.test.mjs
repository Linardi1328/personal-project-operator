import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { validateOrdinaryCatalog } from "./validate-stage1.mjs"

const catalog = JSON.parse(await readFile(new URL("./ordinary-projects.json", import.meta.url)))
test("fixed catalog covers six policies and cannot grant authority", () => {
  assert.equal(catalog.projects.length, 6)
  assert.ok(validateOrdinaryCatalog(catalog))
  for (const mutate of [
    c => c.projects.pop(), c => c.projects.push(c.projects[0]),
    c => c.projects.reverse(), c => { c.extra = true },
    c => { c.projects[0].repository = "other/repo" },
    c => { c.projects[0].gates[0].timeoutMs++ },
    c => { c.projects[0].gates[0].command.push("--override") },
    c => { c.projects[0].gates[0].required = false },
    c => { c.projects[0].gates[0].shell = true },
    c => { c.projects[0].githubWorkflow = "verified" },
    c => { c.projects[0].manifestCanExecute = true },
    c => { c.projects[0].manifestCanDeploy = true }
  ]) {
    const changed = structuredClone(catalog)
    mutate(changed)
    assert.equal(validateOrdinaryCatalog(changed), false)
  }
})

test("combined CLI is read-only, bounded, and distinguishes unverified acceptance", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const exec = promisify(execFile)
  const args = ["--permission", `--allow-fs-read=${root}`, "capabilities/validate-stage1.mjs"]
  const { stdout } = await exec(process.execPath, args, { cwd: root, timeout: 10000 })
  const checks = stdout.trim().split("\n").map(JSON.parse)
  assert.equal(checks.length, 14)
  assert.equal(checks.filter(c => c.outcome === "PASS").length, 8)
  assert.equal(checks.filter(c => c.outcome === "SKIP").length, 6)
  await assert.rejects(exec(process.execPath, [...args, "../other"], { cwd: root }), e => {
    assert.equal(e.code, 1)
    assert.deepEqual(JSON.parse(e.stdout), { id: "arguments", outcome: "FAIL" })
    return true
  })
})
