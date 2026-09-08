#!/usr/bin/env node
import { constants } from "node:fs"
import { open, lstat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { describeOrdinaryProjectCapabilities } from "../local-operator/development-continue-runtime-profile.mjs"
import { validatePpoCapabilities } from "./validate-ppo.mjs"

const directory = new URL("./", import.meta.url)
const catalog = new URL("./ordinary-projects.json", import.meta.url)

export function validateOrdinaryCatalog(value) {
  return isDeepStrictEqual(value, {
    schemaVersion: "customer-zero-ordinary-policy-catalog.v1",
    projects: describeOrdinaryProjectCapabilities()
  })
}

export async function validateStage1() {
  const checks = (await validatePpoCapabilities()).map(check => ({ projectId: "personal-project-operator", ...check }))
  let valid = false
  try {
    if (!(await lstat(directory)).isDirectory()) throw Error("source")
    const file = await open(catalog, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 65536) throw Error("source")
      const buffer = Buffer.alloc(65537)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 65536) throw Error("source")
      valid = validateOrdinaryCatalog(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")))
    } finally { await file.close() }
  } catch { /* bounded failure, never expose input or raw errors */ }
  checks.push({ id: "ordinary-policy-catalog", outcome: valid ? "PASS" : "FAIL" })
  for (const project of describeOrdinaryProjectCapabilities()) {
    checks.push({ projectId: project.projectId, id: "remote-and-host-acceptance", outcome: "SKIP", reason: "not-verified-by-local-policy-parity" })
  }
  return checks
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checks = process.argv.length === 2 ? await validateStage1() : [{ id: "arguments", outcome: "FAIL" }]
  for (const check of checks) process.stdout.write(`${JSON.stringify(check)}\n`)
  // SKIP is explicitly outside this local configuration gate, never acceptance proof.
  process.exitCode = checks.some(check => check.outcome === "FAIL") ? 1 : 0
}
