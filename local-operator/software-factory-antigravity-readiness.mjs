import { execFile } from "node:child_process"
import { lstat, realpath, stat } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import { promisify } from "node:util"
import {
  isDevelopmentRunTerminalStatus,
  normalizeDevelopmentRunId,
  readDevelopmentRun
} from "./development-run-state.mjs"
import {
  SOFTWARE_FACTORY_CAPACITY_STATES,
  describeSoftwareFactoryCapability
} from "./software-factory-control-plane.mjs"
import {
  readSoftwareFactoryDispatchCheckpoint,
  recordSoftwareFactoryDispatchCheckpoint
} from "./software-factory-dispatch-checkpoint.mjs"

const execFileAsync = promisify(execFile)

export const ANTIGRAVITY_READINESS_ADAPTER_ID = "software-factory-v0-antigravity-readiness"
export const ANTIGRAVITY_READINESS_SCHEMA_VERSION = 1
export const ANTIGRAVITY_READINESS_TIMEOUT_MS = 10_000
export const ANTIGRAVITY_READINESS_MAX_OUTPUT_BYTES = 64 * 1024
export const ANTIGRAVITY_AUTHORIZATION_MAX_AGE_MS = 2 * 60 * 1000

export const ANTIGRAVITY_REVIEWED_EXECUTABLE_PATHS = Object.freeze({
  darwin: Object.freeze([
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "/Users/richie/.local/bin/agy"
  ]),
  linux: Object.freeze([
    "/usr/local/bin/agy",
    "/usr/bin/agy",
    "/home/ppo/.local/bin/agy"
  ])
})

const quotaPattern = /(?:quota (?:reached|exhausted)|limit(?:s)? exhausted|baseline model quota reached|individual quota reached|resets in)/iu
const rateLimitPattern = /(?:rate limit(?:ed)?|too many requests|429)/iu
const authPattern = /(?:not authenticated|authentication required|sign in|login required|unauthorized|401)/iu
const unsafeOutputPattern = /(?:github_pat_|gh[opusr]_|sk-[A-Za-z0-9_-]{8,}|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:])/iu

export class SoftwareFactoryReadinessError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryReadinessError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function readinessError(code, safeMessage) {
  return new SoftwareFactoryReadinessError(code, safeMessage)
}

function defaultNow() {
  return new Date()
}

function normalizedNow(nowImpl) {
  const value = nowImpl()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function fixedExecutableCandidates(platform) {
  return ANTIGRAVITY_REVIEWED_EXECUTABLE_PATHS[platform] || []
}

function classifyProbeText(text) {
  if (quotaPattern.test(text)) {
    return { integration: "configured", capacity: "exhausted" }
  }

  if (rateLimitPattern.test(text)) {
    return { integration: "configured", capacity: "rate_limited" }
  }

  if (authPattern.test(text)) {
    return { integration: "unconfigured", capacity: "unavailable" }
  }

  const remaining = [...text.matchAll(/(\d{1,3})%\s+remaining/giu)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 100)

  if (remaining.length > 0) {
    const maxRemaining = Math.max(...remaining)

    if (maxRemaining === 0) {
      return { integration: "configured", capacity: "exhausted" }
    }

    return {
      integration: "configured",
      capacity: maxRemaining <= 20 ? "degraded" : "available"
    }
  }

  if (/\bquota available\b/iu.test(text)) {
    return { integration: "configured", capacity: "available" }
  }

  return null
}

function boundedOutput(stdout, stderr) {
  const combined = `${String(stdout ?? "")}\n${String(stderr ?? "")}`

  if (Buffer.byteLength(combined, "utf8") > ANTIGRAVITY_READINESS_MAX_OUTPUT_BYTES) {
    throw readinessError(
      "ANTIGRAVITY_PROBE_OUTPUT_INVALID",
      "Antigravity readiness output exceeded the reviewed size bound."
    )
  }

  if (unsafeOutputPattern.test(combined)) {
    throw readinessError(
      "ANTIGRAVITY_PROBE_OUTPUT_UNSAFE",
      "Antigravity readiness output contained sensitive material and was refused."
    )
  }

  return combined
}

function assertAntigravityCapability(capability) {
  const policy = describeSoftwareFactoryCapability(capability)

  if (policy.workerId !== "antigravity") {
    throw readinessError(
      "ANTIGRAVITY_CAPABILITY_MISMATCH",
      "Capability is not assigned to the Antigravity worker."
    )
  }

  return policy
}

export function createAntigravityReadinessAdapter(dependencies = {}) {
  const platform = dependencies.platform || process.platform
  const candidates = dependencies.executableCandidates || fixedExecutableCandidates(platform)
  const execFileImpl = dependencies.execFileImpl || execFileAsync
  const lstatImpl = dependencies.lstatImpl || lstat
  const realpathImpl = dependencies.realpathImpl || realpath
  const statImpl = dependencies.statImpl || stat
  const nowImpl = dependencies.now || defaultNow
  const readRunImpl = dependencies.readRun || readDevelopmentRun
  const readCheckpointImpl = dependencies.readCheckpoint || readSoftwareFactoryDispatchCheckpoint
  const recordCheckpointImpl = dependencies.recordCheckpoint || recordSoftwareFactoryDispatchCheckpoint
  const probeRunner = dependencies.probeRunner || null
  const authorizationSet = new WeakSet()

  async function validateReviewedExecutable(path) {
    if (typeof path !== "string" || path !== resolvePath(path)) {
      throw readinessError(
        "ANTIGRAVITY_PROBE_UNTRUSTED",
        "Reviewed Antigravity readiness executable is not trusted."
      )
    }

    const linkInfo = await lstatImpl(path).catch(() => null)

    if (!linkInfo) {
      throw readinessError(
        "ANTIGRAVITY_PROBE_UNAVAILABLE",
        "Reviewed Antigravity readiness executable is unavailable."
      )
    }

    if (linkInfo.isSymbolicLink()) {
      throw readinessError(
        "ANTIGRAVITY_PROBE_UNTRUSTED",
        "Reviewed Antigravity readiness executable is not trusted."
      )
    }

    const canonical = await realpathImpl(path).catch(() => null)
    const info = canonical ? await statImpl(canonical).catch(() => null) : null

    if (
      canonical !== path ||
      !info?.isFile?.() ||
      (info.mode & 0o022) !== 0
    ) {
      throw readinessError(
        "ANTIGRAVITY_PROBE_UNTRUSTED",
        "Reviewed Antigravity readiness executable is not trusted."
      )
    }

    return canonical
  }

  async function resolveReviewedExecutable() {
    for (const candidate of candidates) {
      try {
        return await validateReviewedExecutable(candidate)
      } catch (error) {
        if (error?.code !== "ANTIGRAVITY_PROBE_UNAVAILABLE") {
          throw error
        }
      }
    }

    throw readinessError(
      "ANTIGRAVITY_PROBE_UNAVAILABLE",
      "Reviewed Antigravity readiness executable is unavailable."
    )
  }

  async function runCommand(executablePath, args) {
    const common = {
      cwd: "/",
      encoding: "utf8",
      timeout: ANTIGRAVITY_READINESS_TIMEOUT_MS,
      maxBuffer: ANTIGRAVITY_READINESS_MAX_OUTPUT_BYTES,
      shell: false,
      env: {
        PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        HOME: process.env.HOME || "",
        TERM: "dumb",
        NO_COLOR: "1",
        CI: "true",
        GIT_TERMINAL_PROMPT: "0"
      }
    }

    try {
      const result = await execFileImpl(executablePath, args, common)
      return {
        exitCode: 0,
        stdout: result.stdout || "",
        stderr: result.stderr || ""
      }
    } catch (error) {
      if (error?.killed || error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT") {
        return {
          exitCode: 124,
          stdout: error?.stdout || "",
          stderr: error?.stderr || "",
          timedOut: true
        }
      }

      return {
        exitCode: Number.isInteger(error?.code) ? error.code : 1,
        stdout: error?.stdout || "",
        stderr: error?.stderr || ""
      }
    }
  }

  async function runReviewedProbe() {
    if (probeRunner) {
      return probeRunner()
    }

    const executablePath = await resolveReviewedExecutable()
    const models = await runCommand(executablePath, ["models"])
    const modelText = boundedOutput(models.stdout, models.stderr)
    const modelClassification = classifyProbeText(modelText)

    if (models.timedOut) {
      throw readinessError(
        "ANTIGRAVITY_PROBE_TIMEOUT",
        "Antigravity readiness probe timed out."
      )
    }

    if (models.exitCode !== 0 || modelClassification?.integration === "unconfigured") {
      return {
        ...models,
        classification: modelClassification
      }
    }

    const usage = await runCommand(
      executablePath,
      ["-p", "/usage", "--print-timeout", "10s"]
    )
    const usageText = boundedOutput(usage.stdout, usage.stderr)
    const usageClassification = classifyProbeText(usageText)

    return {
      exitCode: models.exitCode,
      stdout: `${models.stdout || ""}\n${usage.stdout || ""}`,
      stderr: `${models.stderr || ""}\n${usage.stderr || ""}`,
      classification: usageClassification || modelClassification || null
    }
  }

  async function probe() {
    const result = await runReviewedProbe()
    const text = boundedOutput(result.stdout, result.stderr)
    const classified = result.classification || classifyProbeText(text)
    const observedAt = normalizedNow(nowImpl).toISOString()

    if (classified) {
      return Object.freeze({
        schemaVersion: ANTIGRAVITY_READINESS_SCHEMA_VERSION,
        adapterId: ANTIGRAVITY_READINESS_ADAPTER_ID,
        workerId: "antigravity",
        sourceId: "reviewed-runtime-probe",
        observedAt,
        integration: classified.integration,
        capacity: classified.capacity
      })
    }

    if (result.exitCode !== 0) {
      return Object.freeze({
        schemaVersion: ANTIGRAVITY_READINESS_SCHEMA_VERSION,
        adapterId: ANTIGRAVITY_READINESS_ADAPTER_ID,
        workerId: "antigravity",
        sourceId: "reviewed-runtime-probe",
        observedAt,
        integration: "unconfigured",
        capacity: "unavailable"
      })
    }

    return Object.freeze({
      schemaVersion: ANTIGRAVITY_READINESS_SCHEMA_VERSION,
      adapterId: ANTIGRAVITY_READINESS_ADAPTER_ID,
      workerId: "antigravity",
      sourceId: "reviewed-runtime-probe",
      observedAt,
      integration: "configured",
      capacity: "unknown"
    })
  }

  async function record(input, options = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw readinessError(
        "ANTIGRAVITY_READINESS_INPUT_INVALID",
        "Antigravity readiness input is invalid."
      )
    }

    assertAntigravityCapability(input.capability)
    const observation = await probe()

    return recordCheckpointImpl({
      runId: input.runId,
      runVersion: input.runVersion,
      capability: input.capability,
      expectedCheckpointVersion: input.expectedCheckpointVersion ?? 0,
      failedAttempts: input.failedAttempts,
      risk: input.risk,
      observation: {
        workerId: observation.workerId,
        integration: observation.integration,
        capacity: observation.capacity,
        sourceId: observation.sourceId,
        observedAt: observation.observedAt
      }
    }, {
      ...options,
      now: () => normalizedNow(nowImpl)
    })
  }

  async function authorize(input, options = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw readinessError(
        "ANTIGRAVITY_AUTHORIZATION_INPUT_INVALID",
        "Antigravity dispatch authorization input is invalid."
      )
    }

    const policy = assertAntigravityCapability(input.capability)
    const run = await readRunImpl(normalizeDevelopmentRunId(input.runId), options)

    if (
      run.version !== input.runVersion ||
      isDevelopmentRunTerminalStatus(run.status)
    ) {
      throw readinessError(
        "ANTIGRAVITY_AUTHORIZATION_RUN_STALE",
        "Development run is not current for Antigravity dispatch."
      )
    }

    const checkpoint = await readCheckpointImpl(run.runId, options)
    const checkpointExpiresAt = Date.parse(checkpoint?.observation?.expiresAt || "")
    const now = normalizedNow(nowImpl)

    if (
      checkpoint.runVersion !== run.version ||
      checkpoint.capability !== input.capability ||
      checkpoint.workerId !== "antigravity" ||
      checkpoint.checkpointVersion !== input.checkpointVersion ||
      checkpoint.dispatch?.outcome !== "ready" ||
      checkpoint.dispatch?.consumeAttempt !== true ||
      checkpoint.observation?.sourceId !== "reviewed-runtime-probe" ||
      checkpoint.observation?.fresh !== true ||
      !Number.isFinite(checkpointExpiresAt) ||
      checkpointExpiresAt < now.getTime()
    ) {
      throw readinessError(
        "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH",
        "Software factory checkpoint does not authorize this Antigravity dispatch."
      )
    }

    const observation = await probe()

    if (
      observation.integration !== "configured" ||
      !SOFTWARE_FACTORY_CAPACITY_STATES.includes(observation.capacity) ||
      !["available", "degraded"].includes(observation.capacity)
    ) {
      throw readinessError(
        "ANTIGRAVITY_AUTHORIZATION_NOT_READY",
        "Antigravity is not currently ready for dispatch."
      )
    }

    const authorization = Object.freeze({
      kind: "software-factory-antigravity-dispatch-authorization",
      adapterId: ANTIGRAVITY_READINESS_ADAPTER_ID,
      runId: run.runId,
      runVersion: run.version,
      projectId: run.project.id,
      capability: input.capability,
      workerId: policy.workerId,
      modelClass: checkpoint.modelClass,
      skills: [...checkpoint.skills],
      checkpointVersion: checkpoint.checkpointVersion,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ANTIGRAVITY_AUTHORIZATION_MAX_AGE_MS).toISOString()
    })

    authorizationSet.add(authorization)
    return authorization
  }

  function assertAuthorization(authorization) {
    if (!authorizationSet.has(authorization)) {
      throw readinessError(
        "ANTIGRAVITY_AUTHORIZATION_INVALID",
        "Antigravity dispatch authorization is invalid."
      )
    }

    const issuedMs = Date.parse(authorization.issuedAt)
    const age = normalizedNow(nowImpl).getTime() - issuedMs

    if (age < 0 || age > ANTIGRAVITY_AUTHORIZATION_MAX_AGE_MS) {
      throw readinessError(
        "ANTIGRAVITY_AUTHORIZATION_EXPIRED",
        "Antigravity dispatch authorization expired."
      )
    }

    return authorization
  }

  return Object.freeze({
    probe,
    record,
    authorize,
    assertAuthorization
  })
}

const defaultAntigravityReadinessAdapter = createAntigravityReadinessAdapter()

export function probeAntigravityReadiness() {
  return defaultAntigravityReadinessAdapter.probe()
}

export function recordTrustedAntigravityReadiness(input, options = {}) {
  return defaultAntigravityReadinessAdapter.record(input, options)
}

export function authorizeAntigravityDispatch(input, options = {}) {
  return defaultAntigravityReadinessAdapter.authorize(input, options)
}

export function assertAntigravityDispatchAuthorization(authorization) {
  return defaultAntigravityReadinessAdapter.assertAuthorization(authorization)
}

export function formatSoftwareFactoryReadinessError(error) {
  if (error instanceof SoftwareFactoryReadinessError) {
    return `PPO software factory readiness error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory readiness error: unexpected local failure."
}
