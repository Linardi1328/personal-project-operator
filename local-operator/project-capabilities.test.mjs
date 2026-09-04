import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import test from "node:test"

const manifestUrl = new URL("../.ppo/project-capabilities.v1.json", import.meta.url)

test("Customer Zero capability manifest stays fixed to reviewed repository capabilities", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"))

  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(manifest.repository, {
    identityVersion: 1,
    projectId: "personal-project-operator",
    owner: "Linardi1328",
    name: "personal-project-operator",
    fullName: "Linardi1328/personal-project-operator",
    defaultBranch: "main",
    remote: "https://github.com/Linardi1328/personal-project-operator.git"
  })

  assert.equal(manifest.runtimePreparation.automatic, false)
  assert.equal(manifest.runtimePreparation.ownerApprovalRequired, true)
  await access(new URL(`../${manifest.runtimePreparation.script}`, import.meta.url))

  assert.deepEqual(manifest.localQualityGates.gates, [
    { id: "syntax", timeoutMs: 60_000, required: true },
    { id: "parallel-regression", timeoutMs: 180_000, required: true },
    { id: "serial-regression", timeoutMs: 300_000, required: true },
    { id: "critical-lifecycle", timeoutMs: 300_000, required: true },
    { id: "integrated-acceptance", timeoutMs: 300_000, required: true }
  ])
  await access(new URL(`../${manifest.localQualityGates.runner}`, import.meta.url))
  await access(new URL(`../${manifest.github.workflow}`, import.meta.url))

  assert.deepEqual(manifest.github.requiredChecks, [{
    workflow: "PPO PR validation",
    job: "validate",
    context: "PPO PR validation / validate"
  }])
  assert.deepEqual(manifest.deployment, {
    version: 1,
    provider: "self-hosted-systemd",
    profileId: "personal-project-operator-production",
    environment: "production",
    installDir: "/opt/personal-project-operator",
    service: "ppo-openclaw.service",
    strategy: "exact-sha",
    automatic: false,
    ownerApprovalRequired: true
  })
})

test("Customer Zero capability schema is versioned and strict", async () => {
  const schemaUrl = new URL("../.ppo/project-capabilities.schema.json", import.meta.url)
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"))

  assert.equal(schema.properties.schemaVersion.const, 1)
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.$defs.runtimePreparation.additionalProperties, false)
  assert.equal(schema.$defs.localQualityGates.additionalProperties, false)
  assert.equal(schema.$defs.github.additionalProperties, false)
  assert.equal(schema.$defs.deployment.additionalProperties, false)
})
