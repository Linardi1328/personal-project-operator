import { createHash } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import {
  DEVELOPMENT_RUN_ID_PATTERN,
  DEVELOPMENT_RUN_STORE_DIR,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  inspectDevelopmentRunReadOnly,
  isDevelopmentRunTerminalStatus
} from "./development-run-state.mjs"

export const DEVELOPMENT_RUN_CATALOG_ID = "phase-6n-readonly-development-run-catalog"
export const PHASE_6N_RUN_CATALOG_POLICY_ID = "phase-6n-readonly-development-run-catalog-policy"
export const MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED = 100
export const MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES = 20

const canonicalRunRecordFilePattern = /^([A-Za-z0-9_-]{43})\.json$/u
const safeCatalogCodes = new Set([
  "ok",
  "invalid_run_id",
  "run_not_found",
  "project_out_of_scope",
  "store_missing",
  "store_unavailable",
  "canonical_current",
  "canonical_behind",
  "canonical_missing",
  "record_invalid",
  "history_invalid",
  "canonical_conflict",
  "stale_observation",
  "catalog_truncated"
])

const catalogContract = Object.freeze({
  catalog: DEVELOPMENT_RUN_CATALOG_ID,
  policy: PHASE_6N_RUN_CATALOG_POLICY_ID,
  schemaVersion: 1,
  scope: "ordinary-five-project-development-runs",
  filesystem: "read-only-fixed-development-runs-store",
  maxRecordsInspected: MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED,
  maxSummariesReturned: MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES,
  sort: ["active-first", "updatedAt-desc", "runId-asc"],
  summaryFields: [
    "schemaVersion",
    "catalog",
    "runId",
    "project",
    "status",
    "stage",
    "version",
    "baseSha",
    "headSha",
    "createdAt",
    "updatedAt",
    "terminal",
    "canonicalState",
    "recoveryRequired"
  ]
})

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

export const PHASE_6N_RUN_CATALOG_POLICY_HASH = createHash("sha256")
  .update(stableStringify(catalogContract))
  .digest("hex")

function resolveCatalogWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PPO_WRITE_DATA_DIR
}

function catalogStorePaths(options = {}) {
  const root = resolveCatalogWriteDataDir(options)
  const runRoot = join(root, DEVELOPMENT_RUN_STORE_DIR)

  return {
    runRoot,
    recordsDir: join(runRoot, "records"),
    versionsRoot: join(runRoot, "versions")
  }
}

function safeCode(code) {
  return safeCatalogCodes.has(code) ? code : "store_unavailable"
}

function emptyDiagnostics(overrides = {}) {
  return {
    scanned: 0,
    returned: 0,
    invalid: 0,
    outOfScope: 0,
    truncated: false,
    ...overrides
  }
}

function catalogFailure(code, {
  runId = null,
  canonicalState = null,
  diagnostics = emptyDiagnostics()
} = {}) {
  const result = {
    schemaVersion: 1,
    catalog: DEVELOPMENT_RUN_CATALOG_ID,
    ok: false,
    code: safeCode(code),
    summary: null,
    diagnostics
  }

  if (runId && code !== "project_out_of_scope") {
    result.runId = runId
  }

  if (canonicalState) {
    result.canonicalState = canonicalState
  }

  return result
}

function catalogSuccess(summaries, diagnostics) {
  const ordered = orderSummaries(summaries)
  const selected = ordered.slice(0, MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES)
  const active = selected.filter((summary) => !summary.terminal)
  const terminal = selected.filter((summary) => summary.terminal)
  const truncated = diagnostics.truncated || ordered.length > selected.length

  return {
    schemaVersion: 1,
    catalog: DEVELOPMENT_RUN_CATALOG_ID,
    policy: {
      id: PHASE_6N_RUN_CATALOG_POLICY_ID,
      hash: PHASE_6N_RUN_CATALOG_POLICY_HASH
    },
    ok: true,
    code: truncated ? "catalog_truncated" : "ok",
    summaries: selected,
    active,
    terminal,
    diagnostics: {
      ...diagnostics,
      returned: selected.length,
      truncated
    }
  }
}

async function safeDirectoryIfPresent(path) {
  let info

  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  }

  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("unsafe_catalog_store")
  }

  return info
}

async function readCatalogRecordRunIds(options = {}) {
  const paths = catalogStorePaths(options)
  const runRoot = await safeDirectoryIfPresent(paths.runRoot)

  if (runRoot === null) {
    return {
      ok: true,
      missing: true,
      runIds: []
    }
  }

  const recordsDir = await safeDirectoryIfPresent(paths.recordsDir)
  const versionsRoot = await safeDirectoryIfPresent(paths.versionsRoot)

  if (recordsDir === null || versionsRoot === null) {
    return {
      ok: false,
      code: "store_missing",
      runIds: []
    }
  }

  let entries

  try {
    entries = await readdir(paths.recordsDir)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        code: "stale_observation",
        runIds: []
      }
    }

    throw error
  }

  const runIds = []

  for (const entry of entries) {
    const match = entry.match(canonicalRunRecordFilePattern)

    if (!match || !DEVELOPMENT_RUN_ID_PATTERN.test(match[1])) {
      continue
    }

    runIds.push(match[1])
  }

  runIds.sort()

  return {
    ok: true,
    missing: false,
    runIds
  }
}

function catalogStateOptions(options = {}) {
  return {
    writeDataDir: options.writeDataDir,
    allowPersonalProjectOperatorSelfDevelopmentProject: true
  }
}

function summaryFromSnapshot(snapshot) {
  const record = snapshot.record

  if (record.project.id === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id) {
    return {
      outOfScope: true
    }
  }

  return {
    outOfScope: false,
    summary: {
      schemaVersion: 1,
      catalog: DEVELOPMENT_RUN_CATALOG_ID,
      runId: record.runId,
      project: record.project.id,
      status: record.status,
      stage: record.stage,
      version: record.version,
      baseSha: record.baseSha,
      headSha: record.headSha,
      createdAt: record.timestamps.createdAt,
      updatedAt: record.timestamps.updatedAt,
      terminal: isDevelopmentRunTerminalStatus(record.status),
      canonicalState: snapshot.canonicalState,
      recoveryRequired: snapshot.recoveryRequired === true
    }
  }
}

function compareUpdatedDescendingRunIdAscending(left, right) {
  const leftTime = Date.parse(left.updatedAt)
  const rightTime = Date.parse(right.updatedAt)

  if (leftTime !== rightTime) {
    return rightTime - leftTime
  }

  return left.runId.localeCompare(right.runId)
}

function orderSummaries(summaries) {
  const active = summaries
    .filter((summary) => !summary.terminal)
    .sort(compareUpdatedDescendingRunIdAscending)
  const terminal = summaries
    .filter((summary) => summary.terminal)
    .sort(compareUpdatedDescendingRunIdAscending)

  return [...active, ...terminal]
}

export async function inspectDevelopmentRunSummary(runId, options = {}) {
  const normalizedRunId = String(runId ?? "").trim()

  if (!DEVELOPMENT_RUN_ID_PATTERN.test(normalizedRunId)) {
    return catalogFailure("invalid_run_id")
  }

  const snapshot = await inspectDevelopmentRunReadOnly(normalizedRunId, catalogStateOptions(options))

  if (!snapshot.ok) {
    const code = snapshot.code === "store_missing" ? "run_not_found" : snapshot.code

    return catalogFailure(code, {
      runId: code === "project_out_of_scope" ? null : normalizedRunId,
      canonicalState: snapshot.canonicalState
    })
  }

  const scoped = summaryFromSnapshot(snapshot)

  if (scoped.outOfScope) {
    return catalogFailure("project_out_of_scope", {
      canonicalState: "project_out_of_scope"
    })
  }

  return {
    schemaVersion: 1,
    catalog: DEVELOPMENT_RUN_CATALOG_ID,
    ok: true,
    code: snapshot.code,
    summary: scoped.summary,
    diagnostics: emptyDiagnostics({
      scanned: 1,
      returned: 1
    })
  }
}

export async function listDevelopmentRunSummaries(options = {}) {
  const diagnostics = emptyDiagnostics()
  let recordRunIds

  try {
    recordRunIds = await readCatalogRecordRunIds(options)
  } catch {
    return catalogFailure("store_unavailable", {
      diagnostics
    })
  }

  if (!recordRunIds.ok) {
    return catalogFailure(recordRunIds.code, {
      diagnostics
    })
  }

  if (recordRunIds.missing) {
    return catalogSuccess([], diagnostics)
  }

  const inspectedRunIds = recordRunIds.runIds.slice(0, MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED)
  diagnostics.truncated = recordRunIds.runIds.length > inspectedRunIds.length
  const summaries = []

  for (const inspectedRunId of inspectedRunIds) {
    diagnostics.scanned += 1
    const inspected = await inspectDevelopmentRunSummary(inspectedRunId, options)

    if (inspected.ok) {
      summaries.push(inspected.summary)
      continue
    }

    if (inspected.code === "project_out_of_scope") {
      diagnostics.outOfScope += 1
      continue
    }

    diagnostics.invalid += 1
  }

  return catalogSuccess(summaries, diagnostics)
}

export function formatDevelopmentRunSummary(result) {
  const summary = result?.summary || (result?.runId && result?.catalog === DEVELOPMENT_RUN_CATALOG_ID ? result : null)

  if (!summary) {
    return [
      "PPO Development Run",
      `Status: ${safeCode(result?.code || "store_unavailable")}`
    ].join("\n")
  }

  return [
    "PPO Development Run",
    `Run: ${summary.runId}`,
    `Project: ${summary.project}`,
    `Status: ${summary.status}`,
    `Stage: ${summary.stage}`,
    `Version: ${summary.version}`,
    `Updated: ${summary.updatedAt}`,
    `Canonical: ${summary.canonicalState}`
  ].join("\n")
}

export function formatDevelopmentRunCatalog(result) {
  if (!result?.ok) {
    return [
      "PPO Development Runs",
      `Status: ${safeCode(result?.code || "store_unavailable")}`
    ].join("\n")
  }

  const lines = [
    "PPO Development Runs",
    `Runs: ${result.summaries.length}`,
    `Invalid: ${result.diagnostics.invalid}`
  ]

  if (result.diagnostics.outOfScope > 0) {
    lines.push(`Out of scope: ${result.diagnostics.outOfScope}`)
  }

  if (result.diagnostics.truncated) {
    lines.push("Truncated: yes")
  }

  result.summaries.forEach((summary, index) => {
    lines.push(
      "",
      `${index + 1}. ${summary.runId}`,
      `   Project: ${summary.project}`,
      `   Status: ${summary.status}`,
      `   Stage: ${summary.stage}`,
      `   Updated: ${summary.updatedAt}`
    )
  })

  return lines.join("\n")
}
