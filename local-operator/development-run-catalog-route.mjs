import { createHash } from "node:crypto"
import { DEVELOPMENT_RUN_ID_PATTERN } from "./development-run-id.mjs"
import {
  DEVELOPMENT_RUN_CATALOG_ID,
  MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED,
  MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES,
  PHASE_6N_RUN_CATALOG_POLICY_HASH,
  PHASE_6N_RUN_CATALOG_POLICY_ID,
  formatDevelopmentRunCatalog,
  formatDevelopmentRunSummary,
  inspectDevelopmentRunSummary,
  listDevelopmentRunSummaries
} from "./development-run-catalog.mjs"

export const DEVELOPMENT_RUN_CATALOG_ROUTE_ID = "phase-6o-controlled-development-run-catalog-route"
export const PHASE_6O_RUN_CATALOG_ROUTE_POLICY_ID = "phase-6o-controlled-development-run-catalog-route-policy"
export const MAX_PHASE_6O_ROUTE_OUTPUT_CHARS = 8192

const unsafeRouteOutputPattern = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|[\u0000-\u0009\u000B-\u001F\u007F-\u009F])/u
const sensitiveRouteOutputPattern = new RegExp([
  "SENSITIVE_TEST_SENTINEL",
  `gi${"thub_pat_"}[A-Za-z0-9_]+`,
  `${"g"}${"h"}[opusr]_[A-Za-z0-9_]+`,
  "sk-[A-Za-z0-9_-]{8,}",
  "BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY",
  "authorization\\s*:",
  "password\\s*[=:]",
  "token\\s*[=:]",
  "secret\\s*[=:]",
  "credential\\s*[=:]",
  "PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD)"
].join("|"), "iu")
const routeCodes = new Set([
  "ok",
  "catalog_truncated",
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
  "route_unavailable"
])

const routeContract = Object.freeze({
  route: DEVELOPMENT_RUN_CATALOG_ROUTE_ID,
  policy: PHASE_6O_RUN_CATALOG_ROUTE_POLICY_ID,
  schemaVersion: 1,
  engine: {
    catalog: DEVELOPMENT_RUN_CATALOG_ID,
    policy: {
      id: PHASE_6N_RUN_CATALOG_POLICY_ID,
      hash: PHASE_6N_RUN_CATALOG_POLICY_HASH
    }
  },
  commands: {
    runs: {
      callerInput: []
    },
    run: {
      callerInput: ["runId"],
      runIdPattern: DEVELOPMENT_RUN_ID_PATTERN.source
    }
  },
  readOnly: true,
  filesystemMutation: false,
  runStateMutation: false,
  recoveryActions: false,
  continuationActions: false,
  cancellationActions: false,
  productionActions: false,
  modelActions: false,
  maxRecordsInspected: MAX_DEVELOPMENT_RUN_CATALOG_RECORDS_INSPECTED,
  maxSummariesReturned: MAX_DEVELOPMENT_RUN_CATALOG_SUMMARIES,
  maxOutputChars: MAX_PHASE_6O_ROUTE_OUTPUT_CHARS
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

export const PHASE_6O_RUN_CATALOG_ROUTE_POLICY_HASH = createHash("sha256")
  .update(stableStringify(routeContract))
  .digest("hex")

function routePolicy() {
  return {
    id: PHASE_6O_RUN_CATALOG_ROUTE_POLICY_ID,
    hash: PHASE_6O_RUN_CATALOG_ROUTE_POLICY_HASH
  }
}

function unavailableCatalogOutput() {
  return [
    "PPO Development Runs",
    "Status: unavailable"
  ].join("\n")
}

function unavailableSummaryOutput() {
  return [
    "PPO Development Run",
    "Status: unavailable"
  ].join("\n")
}

function safeRouteCode(code) {
  return typeof code === "string" && routeCodes.has(code) ? code : "route_unavailable"
}

function isSafeRouteOutput(output) {
  return (
    typeof output === "string" &&
    output.length > 0 &&
    output.length <= MAX_PHASE_6O_ROUTE_OUTPUT_CHARS &&
    !unsafeRouteOutputPattern.test(output) &&
    !sensitiveRouteOutputPattern.test(output)
  )
}

function routeResult({ ok, code, output, fallback }) {
  const safeOutput = isSafeRouteOutput(output) ? output : fallback
  const outputAccepted = safeOutput === output

  return {
    schemaVersion: 1,
    route: DEVELOPMENT_RUN_CATALOG_ROUTE_ID,
    policy: routePolicy(),
    ok: ok === true && outputAccepted,
    code: outputAccepted ? safeRouteCode(code) : "route_unavailable",
    output: safeOutput
  }
}

function catalogOptions(options = {}) {
  const next = {}

  if (Object.prototype.hasOwnProperty.call(options, "writeDataDir")) {
    next.writeDataDir = options.writeDataDir
  }

  if (typeof options.__readOnlyBeforeFinalCheck === "function") {
    next.__readOnlyBeforeFinalCheck = options.__readOnlyBeforeFinalCheck
  }

  return next
}

function catalogApi(options = {}) {
  const injected = options.catalogApi && typeof options.catalogApi === "object" ? options.catalogApi : {}

  return {
    listDevelopmentRunSummaries: typeof injected.listDevelopmentRunSummaries === "function"
      ? injected.listDevelopmentRunSummaries
      : listDevelopmentRunSummaries,
    inspectDevelopmentRunSummary: typeof injected.inspectDevelopmentRunSummary === "function"
      ? injected.inspectDevelopmentRunSummary
      : inspectDevelopmentRunSummary,
    formatDevelopmentRunCatalog: typeof injected.formatDevelopmentRunCatalog === "function"
      ? injected.formatDevelopmentRunCatalog
      : formatDevelopmentRunCatalog,
    formatDevelopmentRunSummary: typeof injected.formatDevelopmentRunSummary === "function"
      ? injected.formatDevelopmentRunSummary
      : formatDevelopmentRunSummary
  }
}

export async function handlePpoDevelopmentRunsCommand(options = {}) {
  const api = catalogApi(options)

  try {
    const result = await api.listDevelopmentRunSummaries(catalogOptions(options))
    const output = api.formatDevelopmentRunCatalog(result)

    return routeResult({
      ok: result?.ok === true,
      code: result?.code,
      output,
      fallback: unavailableCatalogOutput()
    })
  } catch {
    return routeResult({
      ok: false,
      code: "route_unavailable",
      output: unavailableCatalogOutput(),
      fallback: unavailableCatalogOutput()
    })
  }
}

export async function handlePpoDevelopmentRunCommand(runId, options = {}) {
  if (typeof runId !== "string" || !DEVELOPMENT_RUN_ID_PATTERN.test(runId)) {
    return routeResult({
      ok: false,
      code: "invalid_run_id",
      output: unavailableSummaryOutput(),
      fallback: unavailableSummaryOutput()
    })
  }

  const api = catalogApi(options)

  try {
    const result = await api.inspectDevelopmentRunSummary(runId, catalogOptions(options))
    const output = api.formatDevelopmentRunSummary(result)

    return routeResult({
      ok: result?.ok === true,
      code: result?.code,
      output,
      fallback: unavailableSummaryOutput()
    })
  } catch {
    return routeResult({
      ok: false,
      code: "route_unavailable",
      output: unavailableSummaryOutput(),
      fallback: unavailableSummaryOutput()
    })
  }
}
