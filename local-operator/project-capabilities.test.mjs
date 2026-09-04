import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import test from "node:test"

const manifestUrl = new URL("../.ppo/project-capabilities.v1.json", import.meta.url)
const schemaUrl = new URL("../.ppo/project-capabilities.schema.json", import.meta.url)

function validate(instance, schema, rootSchema = schema) {
  if (schema.$ref) {
    const target = schema.$ref.slice(2).split("/").reduce((value, key) => value[key], rootSchema)
    return validate(instance, target, rootSchema)
  }

  if (Object.hasOwn(schema, "const") && instance !== schema.const) return false
  if (schema.enum && !schema.enum.includes(instance)) return false
  if (schema.type === "object" && (instance === null || Array.isArray(instance) || typeof instance !== "object")) return false
  if (schema.type === "array" && !Array.isArray(instance)) return false
  if (schema.type === "integer" && !Number.isInteger(instance)) return false
  if (schema.minimum !== undefined && instance < schema.minimum) return false
  if (schema.maximum !== undefined && instance > schema.maximum) return false
  if (schema.required?.some((key) => !Object.hasOwn(instance, key))) return false
  if (schema.properties) {
    if (schema.additionalProperties === false && Object.keys(instance).some((key) => !Object.hasOwn(schema.properties, key))) return false
    if (Object.entries(schema.properties).some(([key, child]) => Object.hasOwn(instance, key) && !validate(instance[key], child, rootSchema))) return false
  }
  if (schema.minItems !== undefined && instance.length < schema.minItems) return false
  if (schema.maxItems !== undefined && instance.length > schema.maxItems) return false
  if (schema.items && instance.some((item) => !validate(item, schema.items, rootSchema))) return false
  if (schema.allOf?.some((child) => !validate(instance, child, rootSchema))) return false
  if (schema.contains) {
    const matches = instance.filter((item) => validate(item, schema.contains, rootSchema)).length
    if (matches < (schema.minContains ?? 1) || matches > (schema.maxContains ?? Infinity)) return false
  }
  return true
}

function changed(manifest, mutate) {
  const copy = structuredClone(manifest)
  mutate(copy)
  return copy
}

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
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"))

  assert.equal(schema.properties.schemaVersion.const, 1)
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.$defs.runtimePreparation.additionalProperties, false)
  assert.equal(schema.$defs.localQualityGates.additionalProperties, false)
  assert.equal(schema.$defs.github.additionalProperties, false)
  assert.equal(schema.$defs.deployment.additionalProperties, false)
})

test("Customer Zero manifest and safety boundaries validate against the schema", async () => {
  const [manifest, schema] = await Promise.all([
    readFile(manifestUrl, "utf8").then(JSON.parse),
    readFile(schemaUrl, "utf8").then(JSON.parse)
  ])

  assert.equal(validate(manifest, schema), true)

  const malformed = [
    changed(manifest, (copy) => { copy.localQualityGates.gates.pop() }),
    changed(manifest, (copy) => { copy.localQualityGates.gates[4] = structuredClone(copy.localQualityGates.gates[0]) }),
    changed(manifest, (copy) => { copy.unreviewedCapability = true }),
    changed(manifest, (copy) => { copy.repository.fullName = "someone/else" }),
    changed(manifest, (copy) => { copy.runtimePreparation.automatic = true }),
    changed(manifest, (copy) => { copy.runtimePreparation.ownerApprovalRequired = false }),
    changed(manifest, (copy) => { copy.deployment.automatic = true }),
    changed(manifest, (copy) => { copy.deployment.ownerApprovalRequired = false })
  ]

  for (const candidate of malformed) assert.equal(validate(candidate, schema), false)
})
