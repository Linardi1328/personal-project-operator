#!/usr/bin/env node
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual as equal } from "node:util"
import { describePersonalProjectOperatorQualityPolicy } from "../local-operator/development-continue-runtime-profile.mjs"
import { PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT as project } from "../local-operator/github-project-registry.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const paths = Object.freeze({
  manifest: "capabilities/personal-project-operator.json",
  schema: "capabilities/customer-zero-project.schema.json",
  workflow: ".github/workflows/ppo-pr-validation.yml",
  runner: "deployment/scripts/run-ppo-development-quality.mjs"
})

// Implements only the vocabulary used by the repository's v1 schema.
// Unknown keywords fail closed; no remote references are resolved.
export function matchesSchema(value, schema) {
  const supported = new Set(["$schema", "$id", "title", "description", "type", "const", "enum",
    "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
    "minLength", "maxLength", "pattern", "minimum", "maximum", "allOf", "if", "then", "else", "not"])
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || Object.keys(schema).some(k => !supported.has(k))) return false
  if ("const" in schema && !equal(value, schema.const)) return false
  if (schema.enum && !schema.enum.some(v => equal(v, value))) return false
  const object = value !== null && typeof value === "object" && !Array.isArray(value)
  if (schema.type && !({ object, array: Array.isArray(value), string: typeof value === "string",
    integer: Number.isInteger(value), boolean: typeof value === "boolean" })[schema.type]) return false
  if (object) {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties || {}, k))) return false
    for (const [k, s] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, k) && !matchesSchema(value[k], s)) return false
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false
    if (schema.items && !value.every(v => matchesSchema(v, schema.items))) return false
  }
  if (typeof value === "string") {
    const length = [...value].length
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) return false
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return false
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false
  if (schema.allOf && !schema.allOf.every(s => matchesSchema(value, s))) return false
  if (schema.not && matchesSchema(value, schema.not)) return false
  if (schema.if) {
    const branch = matchesSchema(value, schema.if) ? schema.then : schema.else
    if (branch && !matchesSchema(value, branch)) return false
  }
  return true
}

// Deliberately supports only this workflow's simple, unconditional run steps.
// New YAML constructs require explicit review rather than optimistic parsing.
function workflowSteps(text) {
  const job = text.split("\n  validate:\n")
  if (job.length !== 2 || /\n  [A-Za-z_-]+:/.test(job[1])) return null
  const steps = job[1].split("\n    steps:\n")
  if (steps.length !== 2 || steps[0].trim() !== "runs-on: ubuntu-latest") return null
  const blocks = steps[1].trimEnd().split(/\n(?=      - )/u).map(block => block.trimEnd())
  if (!/^      - uses: actions\/checkout@v4\n        with:\n          fetch-depth: 0$/u.test(blocks.shift())) return null
  return blocks.map(block => {
    const match = /^      - name: ([^\n]+)\n        run: (.+)$/su.exec(block)
    if (!match) return null
    const command = match[2] === "|\n          git diff --check\n          git diff --check origin/main...HEAD"
      ? "git diff --check" : match[2]
    if (command.includes("\n")) return null
    return { name: match[1], command }
  })
}

export function validatePpoSources(sources) {
  const checks = []
  const check = (id, pass) => checks.push({ id, outcome: pass ? "PASS" : "FAIL" })
  let manifest, schema
  try { manifest = JSON.parse(sources.manifest); schema = JSON.parse(sources.schema) }
  catch { return [{ id: "schema", outcome: "FAIL" }] }
  try { check("schema", matchesSchema(manifest, schema)) } catch { check("schema", false) }
  if (checks[0].outcome === "FAIL") return checks
  const policy = describePersonalProjectOperatorQualityPolicy()
  check("repository", equal(manifest.repository, { projectId: project.id, fullName: project.fullName, defaultBranch: "main" }))
  check("runtime", equal(manifest.runtimePreparation, { platform: "darwin", mode: "preconfigured",
    profileId: policy.profileId, ownerManaged: true, callerOverridesAllowed: false }))
  check("quality-gates", equal(manifest.localQualityGates, policy.gates))
  const runnerMatch = /const allowedGates = new Set\(\[([\s\S]*?)\]\)/u.exec(sources.runner)
  let runnerIds = null
  try { runnerIds = JSON.parse(`[${runnerMatch?.[1]}]`) } catch { /* unsupported source */ }
  check("runner-gates", equal(runnerIds, policy.gates.map(g => g.id)))
  const steps = workflowSteps(sources.workflow)
  check("github-workflow", manifest.github.workflow === paths.workflow && manifest.github.job === "validate" &&
    Array.isArray(steps) && steps.every(Boolean) &&
    equal(steps.map(s => s.name), manifest.github.requiredSteps) &&
    equal(steps.map(s => s.command), [...policy.gates.map(g => g.command.join(" ")), "git diff --check"]) &&
    /^  pull_request:\n    branches:\n      - main$/mu.test(sources.workflow))
  check("deployment-boundary", equal(manifest.deploymentProvider, { id: "ppo-self-managed-ubuntu",
    kind: "self-managed-ubuntu-vps", profileId: "personal-project-operator-production",
    authority: "reviewed-agent", exactShaRequired: true, manifestCanDeploy: false }))
  return checks
}

async function readFixed(relative) {
  let current = root
  for (const part of relative.split("/").slice(0, -1)) {
    current = join(current, part)
    if (!(await lstat(current)).isDirectory()) throw Error("source unavailable")
  }
  const handle = await open(join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 262144) throw Error("source unavailable")
    const buffer = Buffer.alloc(262145)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 262144) throw Error("source unavailable")
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally { await handle.close() }
}

export async function validatePpoCapabilities() {
  try {
    const values = await Promise.all(Object.values(paths).map(readFixed))
    return validatePpoSources(Object.fromEntries(Object.keys(paths).map((k, i) => [k, values[i]])))
  } catch { return [{ id: "sources", outcome: "FAIL" }] }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checks = process.argv.length === 2 ? await validatePpoCapabilities() : [{ id: "arguments", outcome: "FAIL" }]
  for (const result of checks) process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = checks.every(c => c.outcome === "PASS") ? 0 : 1
}
