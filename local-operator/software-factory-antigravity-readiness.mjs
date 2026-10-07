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
const authorizationSet = new WeakSet()

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

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function fixedExecutableCandidates(platform = process.platform) {
  return ANTIGRAVITY_REVIEWED_EXECUTABLE_PATHS[platform] || []
}

async function validateReviewedExecutable(path, options = {}) {
  if (typeof path !== "string" || path !== resolvePath(path)) {
    throw readinessError(
      "ANTIGRAVITY_PROBE_UNTRUSTED",
      "Reviewed Antigravity readiness executable is not trusted."
    )
  }

  const lstatImpl = options.lstatImpl || lstat
  const realpathImpl = options.realpathImpl || realpath
  const statImpl = options.statImpl || stat
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

async function resolveReviewedExecutable(options = {}) {
  if (options.testExecutablePath) {
    if (options.allowTestOverrides !== true) {
      throw readinessError(
        "ANTIGRAVITY_PROBE_UNTRUSTED",
        "Reviewed Antigravity readiness executable is not trusted."
      )
    }
    return validateReviewedExecutable(options.testExecutablePath, options)
  }

  for (const candidate of fixedExecutableCandidates(options.platform)) {
    try {
      return await validateReviewedExecutable(candidate, options)
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

async function runReviewedProbe(options = {}) {
  if (options.probeRunner) {
    if (options.allowTestOverrides !== true) {
      throw readinessError(
        "ANTIGRAVITY_PROBE_UNTRUSTED",
        "Reviewed Antigravity readiness probe override is not trusted."
      )
    }
    return options.probeRunner()
  }

  const executablePath = await resolveReviewedExecutable(options)
  const execFileImpl = options.execFileImpl || execFileAsync

  try {
    const result = await execFileImpl(executablePath, ["models"], {
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
    })

    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr
    }
  } catch (error) {
    if (error?.killed || error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT") {
      throw readinessError(
        "ANTIGRAVITY_PROBE_TIMEOUT",
        "Antigravity readiness probe timed out."
      )
    }

    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout || "",
      stderr: error?.stderr || ""
    }
  }
}

export async function probeAntigravityReadiness(options = {}) {
  const result = await runReviewedProbe(options)
  const text = boundedOutput(result.stdout, result.stderr)
  const classified = classifyProbeText(text)
  const observedAt = nowDate(options).toISOString()

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

export async function recordTrustedAntigravityReadiness(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw readinessError(
      "ANTIGRAVITY_READINESS_INPUT_INVALID",
      "Antigravity readiness input is invalid."
    )
  }

  assertAntigravityCapability(input.capability)
  const observation = await probeAntigravityReadiness(options)

  return recordSoftwareFactoryDispatchCheckpoint({
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
  }, options)
}

function authorizationAgeValid(authorization, now) {
  const issuedMs = Date.parse(authorization.issuedAt)
  const age = now.getTime() - issuedMs
  return age >= 0 && age <= ANTIGRAVITY_AUTHORIZATION_MAX_AGE_MS
}

export async function authorizeAntigravityDispatch(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw readinessError(
      "ANTIGRAVITY_AUTHORIZATION_INPUT_INVALID",
      "Antigravity dispatch authorization input is invalid."
    )
  }

  const policy = assertAntigravityCapability(input.capability)
  const reader = options.readRun || readDevelopmentRun
  const run = await reader(normalizeDevelopmentRunId(input.runId), options)

  if (
    run.version !== input.runVersion ||
    isDevelopmentRunTerminalStatus(run.status)
  ) {
    throw readinessError(
      "ANTIGRAVITY_AUTHORIZATION_RUN_STALE",
      "Development run is not current for Antigravity dispatch."
    )
  }

  const checkpoint = await readSoftwareFactoryDispatchCheckpoint(run.runId, options)

  if (
    checkpoint.runVersion !== run.version ||
    checkpoint.capability !== input.capability ||
    checkpoint.workerId !== "antigravity"
  ) {
    throw readinessError(
      "ANTIGRAVITY_AUTHORIZATION_BINDING_MISMATCH",
      "Software factory checkpoint does not authorize this Antigravity dispatch."
    )
  }

  const observation = await probeAntigravityReadiness(options)

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

  const now = nowDate(options)
  const authorization = Object.freeze({
    kind: "software-factory-antigravity-dispatch-authorization",
    adapterId: ANTIGRAVITY_READINESS_ADAPTER_ID,
    runId: run.runId,
    runVersion: run.version,
    projectId: run.project.id,
    capability: input.capability,
    workerId: policy.workerId,
    modelClass: policy.modelClass,
    skills: [...policy.skills],
    checkpointVersion: checkpoint.checkpointVersion,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ANTIGRAVITY_AUTHORIZATION_MAX_AGE_MS).toISOString()
  })

  authorizationSet.add(authorization)
  return authorization
}

export function assertAntigravityDispatchAuthorization(authorization, options = {}) {
  if (!authorizationSet.has(authorization)) {
    throw readinessError(
      "ANTIGRAVITY_AUTHORIZATION_INVALID",
      "Antigravity dispatch authorization is invalid."
    )
  }

  if (!authorizationAgeValid(authorization, nowDate(options))) {
    throw readinessError(
      "ANTIGRAVITY_AUTHORIZATION_EXPIRED",
      "Antigravity dispatch authorization expired."
    )
  }

  return authorization
}

export function formatSoftwareFactoryReadinessError(error) {
  if (error instanceof SoftwareFactoryReadinessError) {
    return `PPO software factory readiness error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory readiness error: unexpected local failure."
}
