import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { validatePpoSources, matchesSchema } from "./validate-ppo.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const sources = Object.fromEntries(await Promise.all(Object.entries({
  manifest: "capabilities/personal-project-operator.json", schema: "capabilities/customer-zero-project.schema.json",
  workflow: ".github/workflows/ppo-pr-validation.yml", runner: "deployment/scripts/run-ppo-development-quality.mjs"
}).map(async ([k, path]) => [k, await readFile(new URL(`../${path}`, import.meta.url), "utf8")])))

test("current PPO metadata agrees with runtime and workflow", () => {
  assert.equal(validatePpoSources(sources).length, 7)
  assert.ok(validatePpoSources(sources).every(c => c.outcome === "PASS"))
})

for (const [label, mutate, id] of [
  ["unknown property", m => { m.extra = true }, "schema"],
  ["missing required property", m => { delete m.github }, "schema"],
  ["wrong type", m => { m.localQualityGates[0].timeoutMs = "60000" }, "schema"],
  ["repository drift", m => { m.repository.fullName = "another/repo" }, "repository"],
  ["runtime drift", m => { m.runtimePreparation.profileId = "other-profile" }, "runtime"],
  ["timeout drift", m => { m.localQualityGates[0].timeoutMs++ }, "quality-gates"],
  ["command drift", m => { m.localQualityGates[0].command[0] = "bash" }, "quality-gates"],
  ["duplicate gate", m => { m.localQualityGates[1] = m.localQualityGates[0] }, "quality-gates"],
  ["workflow path override", m => { m.github.workflow = ".github/workflows/other.yml" }, "github-workflow"],
  ["deployment authority drift", m => { m.deploymentProvider.manifestCanDeploy = true }, "deployment-boundary"]
]) {
  test(`rejects ${label}`, () => {
    const manifest = JSON.parse(sources.manifest)
    mutate(manifest)
    assert.ok(validatePpoSources({ ...sources, manifest: JSON.stringify(manifest) }).some(c => c.id === id && c.outcome === "FAIL"))
  })
}

for (const [label, workflow] of [
  ["changed command", sources.workflow.replace(".mjs syntax", ".mjs unknown")],
  ["conditional step", sources.workflow.replace("        run: node", "        if: false\n        run: node")],
  ["allowed failure", sources.workflow.replace("        run: node", "        continue-on-error: true\n        run: node")],
  ["missing step", sources.workflow.replace(/      - name: Repository syntax checks[\s\S]*?(?=      - name:)/, "")],
  ["duplicate job", sources.workflow + "\n  validate:\n    steps: []\n"]
]) {
  test(`workflow rejects ${label}`, () => {
    assert.equal(validatePpoSources({ ...sources, workflow }).find(c => c.id === "github-workflow").outcome, "FAIL")
  })
}

test("schema conditional script requirement and unknown vocabulary", () => {
  const schema = JSON.parse(sources.schema)
  const manifest = JSON.parse(sources.manifest)
  manifest.runtimePreparation.mode = "script"
  assert.equal(matchesSchema(manifest, schema), false)
  manifest.runtimePreparation.script = "prepare.sh"
  assert.equal(matchesSchema(manifest, schema), true)
  manifest.runtimePreparation.mode = "preconfigured"
  assert.equal(matchesSchema(manifest, schema), false)
  assert.equal(matchesSchema({}, { type: "object", $ref: "https://example.invalid/schema" }), false)
})

test("CLI passes with filesystem read permission only and rejects caller paths", async () => {
  const exec = promisify(execFile)
  const args = ["--permission", `--allow-fs-read=${root}`, "capabilities/validate-ppo.mjs"]
  const { stdout } = await exec(process.execPath, args, { cwd: root, timeout: 10000 })
  assert.equal(stdout.trim().split("\n").length, 7)
  assert.ok(stdout.trim().split("\n").map(JSON.parse).every(c => c.outcome === "PASS"))
  await assert.rejects(exec(process.execPath, [...args, "/private/secret"], { cwd: root, timeout: 10000 }), e => {
    assert.equal(e.code, 1)
    assert.deepEqual(JSON.parse(e.stdout), { id: "arguments", outcome: "FAIL" })
    return true
  })
})
