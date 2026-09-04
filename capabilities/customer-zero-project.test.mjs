import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import test from "node:test"

const manifestPath = new URL("./personal-project-operator.json", import.meta.url)
const repositoryRoot = new URL("../", import.meta.url)
const expectedGateTimeouts = new Map([
  ["syntax", 60_000],
  ["parallel-regression", 180_000],
  ["serial-regression", 300_000],
  ["critical-lifecycle", 300_000],
  ["integrated-acceptance", 300_000]
])

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

test("Customer Zero capability manifest fixes repository and runtime identity", async () => {
  const manifest = await readJson(manifestPath)
  const schema = await readJson(new URL(manifest.$schema, manifestPath))

  assert.equal(manifest.$schema, "./customer-zero-project.schema.json")
  assert.equal(schema.properties.$schema.const, manifest.$schema)
  assert.equal(schema.properties.schemaVersion.const, manifest.schemaVersion)
  assert.equal(schema.properties.manifestVersion.const, manifest.manifestVersion)
  assert.equal(manifest.schemaVersion, "customer-zero-project-capability.v1")
  assert.equal(manifest.manifestVersion, 1)
  assert.deepEqual(manifest.repository, {
    projectId: "personal-project-operator",
    fullName: "Linardi1328/personal-project-operator",
    defaultBranch: "main"
  })
  assert.deepEqual(manifest.runtimePreparation, {
    platform: "darwin",
    mode: "preconfigured",
    profileId: "phase-6k-fixed-local-runtime-profile",
    ownerManaged: true,
    callerOverridesAllowed: false
  })
})

test("manifest quality gates retain local and GitHub validation parity", async () => {
  const manifest = await readJson(manifestPath)
  const workflow = await readFile(new URL(manifest.github.workflow, repositoryRoot), "utf8")

  assert.deepEqual(
    manifest.localQualityGates.map(({ id }) => id),
    [...expectedGateTimeouts.keys()]
  )

  for (const gate of manifest.localQualityGates) {
    assert.deepEqual(gate.command, [
      "node",
      "deployment/scripts/run-ppo-development-quality.mjs",
      gate.id
    ])
    assert.equal(gate.timeoutMs, expectedGateTimeouts.get(gate.id))
  }

  assert.equal(manifest.github.workflow, ".github/workflows/ppo-pr-validation.yml")
  assert.match(workflow, /^\s{2}validate:/mu)
  for (const step of manifest.github.requiredSteps) {
    assert.match(workflow, new RegExp(`- name: ${step.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`))
  }
})

test("deployment metadata is declarative and preserves exact-SHA authority", async () => {
  const manifest = await readJson(manifestPath)

  assert.deepEqual(manifest.deploymentProvider, {
    id: "ppo-self-managed-ubuntu",
    kind: "self-managed-ubuntu-vps",
    profileId: "personal-project-operator-production",
    authority: "reviewed-agent",
    exactShaRequired: true,
    manifestCanDeploy: false
  })
  await access(new URL("../local-operator/development-deployment-agent.mjs", manifestPath))
})
