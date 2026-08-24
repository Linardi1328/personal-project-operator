import { createHash } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import {
  DEVELOPMENT_RUN_STATUSES,
  DEVELOPMENT_RUN_STAGES,
  DEVELOPMENT_RUN_ID_PATTERN,
  DEVELOPMENT_RUN_STORE_DIR,
  MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES,
  PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT,
  inspectDevelopmentRunReadOnly,
  isDevelopmentRunTerminalStatus,
  stageForDevelopmentRunStatus
} from "./development-run-state.mjs"
import { getOrdinaryDevelopmentProject } from "./github-project-registry.mjs"

export const DEVELOPMENT_RUN_CATALOG_ID = "phase-6n-readonly-development-run-catalog"
export const PHASE_6N_RUN_CATALOG_POLICY_ID = "phase-6n-readonly-development-run-catalog-policy"
export const MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED = 100
export const MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES = 20

const canonicalRunRecordFilePattern = /^([A-Za-z0-9_-]{43})\.json$/u
const shaPattern = /^[a-f0-9]{40}$/u
const policyHashPattern = /^[a-f0-9]{64}$/u
const unsafeTextPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u001F\u007F-\u009F])/u
const sensitiveTextPattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_[A-Za-z0-9_]+|gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const pathLikeTextPattern = /(?:^\.{1,2}(?:\/|$)|\/|\\|[A-Za-z]:\\|~\/)/u
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
const contentFailureCodes = new Set([
  "record_invalid",
  "history_invalid",
  "canonical_conflict"
])
const catalogSummaryCanonicalStates = new Set([
  "canonical_current",
  "canonical_behind",
  "canonical_missing"
])
const catalogFailureCanonicalStates = new Set([
  "run_not_found",
  "project_out_of_scope",
  "store_missing",
  "store_unavailable",
  "record_invalid",
  "history_invalid",
  "canonical_conflict",
  "stale_observation"
])
const statusSet = new Set(DEVELOPMENT_RUN_STATUSES)
const stageSet = new Set(DEVELOPMENT_RUN_STAGES)

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

function hasOnlyKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false
  }

  const allowed = new Set(keys)
  const actual = Object.keys(value)

  return actual.length === keys.length && actual.every((key) => allowed.has(key))
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isSafeCatalogScalar(value, maxChars = 120) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !unsafeTextPattern.test(value) &&
    !sensitiveTextPattern.test(value) &&
    !pathLikeTextPattern.test(value)
  )
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
    outcome: safeCode(code),
    summary: null,
    summaries: [],
    active: [],
    terminal: [],
    diagnostics
  }

  if (runId && code !== "project_out_of_scope" && code !== "store_unavailable") {
    result.runId = runId
  }

  if (canonicalState && catalogFailureCanonicalStates.has(canonicalState)) {
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
  const stateOptions = {
    writeDataDir: options.writeDataDir,
    allowPersonalProjectOperatorSelfDevelopmentProject: true
  }

  if (typeof options.__readOnlyBeforeFinalCheck === "function") {
    stateOptions.__readOnlyBeforeFinalCheck = options.__readOnlyBeforeFinalCheck
  }

  return stateOptions
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
  if (typeof runId !== "string" || !DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    return catalogFailure("invalid_run_id")
  }

  const snapshot = await inspectDevelopmentRunReadOnly(runId, catalogStateOptions(options))

  if (!snapshot.ok) {
    const code = snapshot.code === "store_missing" ? "run_not_found" : snapshot.code

    return catalogFailure(code, {
      runId: code === "project_out_of_scope" || code === "store_unavailable" ? null : runId,
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

    if (contentFailureCodes.has(inspected.code)) {
      diagnostics.invalid += 1
      continue
    }

    return catalogFailure(inspected.code === "stale_observation" ? "stale_observation" : "store_unavailable", {
      diagnostics
    })
  }

  return catalogSuccess(summaries, diagnostics)
}

function validSummary(summary) {
  if (!hasOnlyKeys(summary, [
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
  ])) {
    return false
  }

  if (
    summary.schemaVersion !== 1 ||
    summary.catalog !== DEVELOPMENT_RUN_CATALOG_ID ||
    !DEVELOPMENT_RUN_ID_PATTERN.test(summary.runId) ||
    !isSafeCatalogScalar(summary.runId, 43) ||
    !isSafeCatalogScalar(summary.project, 80) ||
    !getOrdinaryDevelopmentProject(summary.project) ||
    !statusSet.has(summary.status) ||
    !stageSet.has(summary.stage) ||
    stageForDevelopmentRunStatus(summary.status) !== summary.stage ||
    !Number.isInteger(summary.version) ||
    summary.version < 0 ||
    summary.version >= MAX_DEVELOPMENT_RUN_HISTORY_ENTRIES ||
    typeof summary.baseSha !== "string" ||
    !shaPattern.test(summary.baseSha) ||
    !(summary.headSha === null || (typeof summary.headSha === "string" && shaPattern.test(summary.headSha))) ||
    !isIsoTimestamp(summary.createdAt) ||
    !isIsoTimestamp(summary.updatedAt) ||
    typeof summary.terminal !== "boolean" ||
    isDevelopmentRunTerminalStatus(summary.status) !== summary.terminal ||
    !catalogSummaryCanonicalStates.has(summary.canonicalState) ||
    typeof summary.recoveryRequired !== "boolean"
  ) {
    return false
  }

  if (summary.project === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id) {
    return false
  }

  if (
    (summary.canonicalState === "canonical_current" && summary.recoveryRequired !== false) ||
    (summary.canonicalState !== "canonical_current" && summary.recoveryRequired !== true)
  ) {
    return false
  }

  return true
}

function validDiagnostics(diagnostics, expectedReturned) {
  return (
    hasOnlyKeys(diagnostics, ["scanned", "returned", "invalid", "outOfScope", "truncated"]) &&
    Number.isInteger(diagnostics.scanned) &&
    diagnostics.scanned >= 0 &&
    diagnostics.scanned <= MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED &&
    Number.isInteger(diagnostics.returned) &&
    diagnostics.returned === expectedReturned &&
    diagnostics.returned >= 0 &&
    diagnostics.returned <= MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES &&
    Number.isInteger(diagnostics.invalid) &&
    diagnostics.invalid >= 0 &&
    diagnostics.invalid <= MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED &&
    Number.isInteger(diagnostics.outOfScope) &&
    diagnostics.outOfScope >= 0 &&
    diagnostics.outOfScope <= MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED &&
    typeof diagnostics.truncated === "boolean"
  )
}

function validPolicy(policy) {
  return (
    hasOnlyKeys(policy, ["id", "hash"]) &&
    policy.id === PHASE_6N_RUN_CATALOG_POLICY_ID &&
    policy.hash === PHASE_6N_RUN_CATALOG_POLICY_HASH &&
    policyHashPattern.test(policy.hash)
  )
}

function validSummaryResult(result) {
  return (
    hasOnlyKeys(result, ["schemaVersion", "catalog", "ok", "code", "summary", "diagnostics"]) &&
    result.schemaVersion === 1 &&
    result.catalog === DEVELOPMENT_RUN_CATALOG_ID &&
    result.ok === true &&
    validSummary(result.summary) &&
    catalogSummaryCanonicalStates.has(result.code) &&
    result.code === result.summary.canonicalState &&
    validDiagnostics(result.diagnostics, 1)
  )
}

function validCatalogResult(result) {
  if (
    !hasOnlyKeys(result, [
      "schemaVersion",
      "catalog",
      "policy",
      "ok",
      "code",
      "summaries",
      "active",
      "terminal",
      "diagnostics"
    ]) ||
    result.schemaVersion !== 1 ||
    result.catalog !== DEVELOPMENT_RUN_CATALOG_ID ||
    result.ok !== true ||
    !(result.code === "ok" || result.code === "catalog_truncated") ||
    !validPolicy(result.policy) ||
    !Array.isArray(result.summaries) ||
    result.summaries.length > MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES ||
    !Array.isArray(result.active) ||
    result.active.length > MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES ||
    !Array.isArray(result.terminal) ||
    result.terminal.length > MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES ||
    result.active.length + result.terminal.length !== result.summaries.length
  ) {
    return false
  }

  if (!result.summaries.every(validSummary)) {
    return false
  }

  if (!validDiagnostics(result.diagnostics, result.summaries.length)) {
    return false
  }

  if (result.code === "catalog_truncated" && result.diagnostics.truncated !== true) {
    return false
  }

  if (result.code === "ok" && result.diagnostics.truncated !== false) {
    return false
  }

  const active = result.summaries.filter((summary) => !summary.terminal)
  const terminal = result.summaries.filter((summary) => summary.terminal)

  return stableStringify(result.active) === stableStringify(active) &&
    stableStringify(result.terminal) === stableStringify(terminal)
}

function unavailableSummaryOutput() {
  return [
    "PPO Development Run",
    "Status: unavailable"
  ].join("\n")
}

function unavailableCatalogOutput() {
  return [
    "PPO Development Runs",
    "Status: unavailable"
  ].join("\n")
}

export function formatDevelopmentRunSummary(result) {
  try {
    const summary = validSummaryResult(result)
      ? result.summary
      : validSummary(result)
        ? result
        : null

    if (!summary) {
      return unavailableSummaryOutput()
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
  } catch {
    return unavailableSummaryOutput()
  }
}

export function formatDevelopmentRunCatalog(result) {
  try {
    if (!validCatalogResult(result)) {
      return unavailableCatalogOutput()
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
  } catch {
    return unavailableCatalogOutput()
  }
}
