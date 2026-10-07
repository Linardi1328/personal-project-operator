import { randomUUID } from "node:crypto"
import { open, mkdir, readdir, readFile, chmod, link, unlink } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import {
  isDevelopmentRunTerminalStatus,
  normalizeDevelopmentRunId,
  readDevelopmentRun
} from "./development-run-state.mjs"
import {
  SOFTWARE_FACTORY_CAPACITY_STATES,
  SOFTWARE_FACTORY_INTEGRATION_STATES,
  assessSoftwareFactoryDispatch,
  describeSoftwareFactoryCapability
} from "./software-factory-control-plane.mjs"

export const SOFTWARE_FACTORY_DISPATCH_CHECKPOINT_SCHEMA_VERSION = 1
export const SOFTWARE_FACTORY_DISPATCH_CHECKPOINT_STORE_DIR = "software-factory-dispatch-checkpoints"
export const SOFTWARE_FACTORY_CAPACITY_OBSERVATION_MAX_AGE_MS = 15 * 60 * 1000
export const SOFTWARE_FACTORY_CAPACITY_OBSERVATION_MAX_FUTURE_SKEW_MS = 60 * 1000
export const SOFTWARE_FACTORY_CAPACITY_OBSERVATION_SOURCES = Object.freeze([
  "owner-observation",
  "reviewed-runtime-probe"
])

const sourceSet = new Set(SOFTWARE_FACTORY_CAPACITY_OBSERVATION_SOURCES)
const capacitySet = new Set(SOFTWARE_FACTORY_CAPACITY_STATES)
const integrationSet = new Set(SOFTWARE_FACTORY_INTEGRATION_STATES)
const versionFilePattern = /^(\d{6})\.json$/u
const workerIdPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const unsafeControlPattern = /[\u0000-\u001F\u007F-\u009F]/u

export class SoftwareFactoryDispatchCheckpointError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryDispatchCheckpointError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function checkpointError(code, safeMessage) {
  return new SoftwareFactoryDispatchCheckpointError(code, safeMessage)
}

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return new Date()
  }

  return date
}

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]

  if (typeof configured === "string" && configured.trim()) {
    return configured
  }

  return DEFAULT_PPO_WRITE_DATA_DIR
}

function checkpointRoot(runId, options = {}) {
  return join(
    resolveWriteDataDir(options),
    SOFTWARE_FACTORY_DISPATCH_CHECKPOINT_STORE_DIR,
    normalizeDevelopmentRunId(runId)
  )
}

function checkpointFileName(version) {
  return `${String(version).padStart(6, "0")}.json`
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function syncDirectory(path) {
  const handle = await open(path, "r")

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function normalizeExpectedCheckpointVersion(value) {
  if (!Number.isInteger(value) || value < 0 || value > 999999) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_VERSION_INVALID",
      "Software factory checkpoint version is invalid."
    )
  }

  return value
}

function normalizeRunVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw checkpointError(
      "FACTORY_RUN_VERSION_INVALID",
      "Software factory run version is invalid."
    )
  }

  return value
}

function normalizeObservedAt(value) {
  if (typeof value !== "string") {
    throw checkpointError(
      "FACTORY_OBSERVATION_TIME_INVALID",
      "Software factory capacity observation timestamp is invalid."
    )
  }

  const parsed = Date.parse(value)

  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw checkpointError(
      "FACTORY_OBSERVATION_TIME_INVALID",
      "Software factory capacity observation timestamp is invalid."
    )
  }

  return value
}

function normalizeObservation(observation) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw checkpointError(
      "FACTORY_OBSERVATION_INVALID",
      "Software factory capacity observation is invalid."
    )
  }

  const allowedKeys = new Set([
    "workerId",
    "integration",
    "capacity",
    "sourceId",
    "observedAt"
  ])
  const keys = Object.keys(observation)

  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
    throw checkpointError(
      "FACTORY_OBSERVATION_INVALID",
      "Software factory capacity observation fields are invalid."
    )
  }

  const workerId = String(observation.workerId ?? "").trim()
  const integration = String(observation.integration ?? "").trim()
  const capacity = String(observation.capacity ?? "").trim()
  const sourceId = String(observation.sourceId ?? "").trim()
  const observedAt = normalizeObservedAt(observation.observedAt)

  if (
    !workerIdPattern.test(workerId) ||
    unsafeControlPattern.test(workerId) ||
    !integrationSet.has(integration) ||
    !capacitySet.has(capacity) ||
    !sourceSet.has(sourceId)
  ) {
    throw checkpointError(
      "FACTORY_OBSERVATION_INVALID",
      "Software factory capacity observation is outside the reviewed policy."
    )
  }

  return {
    workerId,
    integration,
    capacity,
    sourceId,
    observedAt
  }
}

function observationFreshness(observation, now, options = {}) {
  const maxAgeMs = Number.isInteger(options.maxObservationAgeMs)
    ? options.maxObservationAgeMs
    : SOFTWARE_FACTORY_CAPACITY_OBSERVATION_MAX_AGE_MS
  const observedMs = Date.parse(observation.observedAt)
  const nowMs = now.getTime()
  const ageMs = nowMs - observedMs

  if (
    maxAgeMs < 1 ||
    ageMs > maxAgeMs ||
    ageMs < -SOFTWARE_FACTORY_CAPACITY_OBSERVATION_MAX_FUTURE_SKEW_MS
  ) {
    return {
      fresh: false,
      expiresAt: new Date(observedMs + Math.max(maxAgeMs, 1)).toISOString()
    }
  }

  return {
    fresh: true,
    expiresAt: new Date(observedMs + maxAgeMs).toISOString()
  }
}

function dispatchFromObservation(capability, observation, options = {}) {
  const policy = describeSoftwareFactoryCapability(capability, {
    failedAttempts: options.failedAttempts,
    risk: options.risk
  })

  if (observation.workerId !== policy.workerId) {
    throw checkpointError(
      "FACTORY_OBSERVATION_WORKER_MISMATCH",
      "Capacity observation does not match the reviewed capability worker."
    )
  }

  const now = nowDate(options)
  const freshness = observationFreshness(observation, now, options)
  const effectiveCapacity = freshness.fresh ? observation.capacity : "unknown"

  const dispatch = assessSoftwareFactoryDispatch({
    capability,
    failedAttempts: options.failedAttempts,
    risk: options.risk,
    workerStates: {
      [observation.workerId]: {
        integration: observation.integration,
        capacity: effectiveCapacity
      }
    }
  })

  return {
    policy,
    freshness,
    dispatch
  }
}

async function listCheckpointVersions(runId, options = {}) {
  const root = checkpointRoot(runId, options)
  const entries = await readdir(root).catch((error) => {
    if (error?.code === "ENOENT") {
      return []
    }

    throw error
  })

  return entries
    .filter((name) => versionFilePattern.test(name))
    .map((name) => Number.parseInt(name.slice(0, 6), 10))
    .sort((left, right) => left - right)
}

async function readCheckpointVersion(runId, version, options = {}) {
  const path = join(checkpointRoot(runId, options), checkpointFileName(version))
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      throw checkpointError(
        "FACTORY_CHECKPOINT_NOT_FOUND",
        "Software factory dispatch checkpoint was not found."
      )
    }

    throw error
  })

  let parsed

  try {
    parsed = JSON.parse(raw)
  } catch {
    throw checkpointError(
      "FACTORY_CHECKPOINT_CORRUPT",
      "Software factory dispatch checkpoint is unreadable."
    )
  }

  if (
    parsed?.schemaVersion !== SOFTWARE_FACTORY_DISPATCH_CHECKPOINT_SCHEMA_VERSION ||
    parsed?.runId !== normalizeDevelopmentRunId(runId) ||
    parsed?.checkpointVersion !== version
  ) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_CORRUPT",
      "Software factory dispatch checkpoint failed validation."
    )
  }

  return parsed
}

async function latestCheckpoint(runId, options = {}) {
  const versions = await listCheckpointVersions(runId, options)

  if (versions.length === 0) {
    return null
  }

  return readCheckpointVersion(runId, versions.at(-1), options)
}

async function loadBoundRun(runId, runVersion, options = {}) {
  const reader = options.readRun || readDevelopmentRun
  const run = await reader(normalizeDevelopmentRunId(runId), options)

  if (run.version !== normalizeRunVersion(runVersion)) {
    throw checkpointError(
      "FACTORY_RUN_VERSION_STALE",
      "Development run changed; reload before updating software factory dispatch state."
    )
  }

  if (isDevelopmentRunTerminalStatus(run.status)) {
    throw checkpointError(
      "FACTORY_RUN_TERMINAL",
      "Terminal development runs cannot receive software factory dispatch checkpoints."
    )
  }

  return run
}

function buildCheckpoint({
  run,
  checkpointVersion,
  capability,
  observation,
  policy,
  freshness,
  dispatch,
  now
}) {
  return {
    schemaVersion: SOFTWARE_FACTORY_DISPATCH_CHECKPOINT_SCHEMA_VERSION,
    checkpointVersion,
    runId: run.runId,
    runVersion: run.version,
    runStatus: run.status,
    projectId: run.project.id,
    capability,
    workerId: policy.workerId,
    modelClass: dispatch.modelClass,
    skills: dispatch.skills,
    observation: {
      sourceId: observation.sourceId,
      integration: observation.integration,
      capacity: observation.capacity,
      observedAt: observation.observedAt,
      expiresAt: freshness.expiresAt,
      fresh: freshness.fresh
    },
    dispatch: {
      outcome: dispatch.outcome,
      reasonCode: dispatch.reasonCode,
      retryable: dispatch.retryable,
      consumeAttempt: dispatch.consumeAttempt,
      ownerApprovalRequired: dispatch.ownerApprovalRequired
    },
    recordedAt: now.toISOString()
  }
}

export async function readSoftwareFactoryDispatchCheckpoint(runId, options = {}) {
  const checkpoint = await latestCheckpoint(runId, options)

  if (!checkpoint) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_NOT_FOUND",
      "Software factory dispatch checkpoint was not found."
    )
  }

  return checkpoint
}

export async function assessSoftwareFactoryDispatchResume(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw checkpointError(
      "FACTORY_RESUME_INPUT_INVALID",
      "Software factory resume input is invalid."
    )
  }

  const run = await loadBoundRun(input.runId, input.runVersion, options)
  const previous = await latestCheckpoint(run.runId, options)

  if (!previous) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_NOT_FOUND",
      "Software factory dispatch checkpoint was not found."
    )
  }

  if (
    previous.runVersion !== run.version ||
    previous.capability !== input.capability
  ) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_BINDING_MISMATCH",
      "Software factory checkpoint no longer matches the development run."
    )
  }

  const observation = normalizeObservation(input.observation)
  const assessed = dispatchFromObservation(input.capability, observation, {
    ...options,
    failedAttempts: input.failedAttempts,
    risk: input.risk
  })

  if (assessed.policy.workerId !== previous.workerId) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_BINDING_MISMATCH",
      "Software factory checkpoint worker no longer matches reviewed policy."
    )
  }

  return {
    ok: assessed.dispatch.outcome === "ready",
    previousCheckpointVersion: previous.checkpointVersion,
    runId: run.runId,
    runVersion: run.version,
    capability: input.capability,
    workerId: assessed.policy.workerId,
    observationFresh: assessed.freshness.fresh,
    dispatch: assessed.dispatch
  }
}

export async function recordSoftwareFactoryDispatchCheckpoint(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_INPUT_INVALID",
      "Software factory checkpoint input is invalid."
    )
  }

  const expectedCheckpointVersion = normalizeExpectedCheckpointVersion(
    input.expectedCheckpointVersion ?? 0
  )
  const run = await loadBoundRun(input.runId, input.runVersion, options)
  const previous = await latestCheckpoint(run.runId, options)
  const currentCheckpointVersion = previous?.checkpointVersion ?? 0

  if (currentCheckpointVersion !== expectedCheckpointVersion) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_VERSION_STALE",
      "Software factory dispatch checkpoint changed; reload before updating."
    )
  }

  if (
    previous &&
    (previous.runVersion !== run.version || previous.capability !== input.capability)
  ) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_BINDING_MISMATCH",
      "Existing software factory checkpoint does not match this development run."
    )
  }

  const observation = normalizeObservation(input.observation)
  const assessed = dispatchFromObservation(input.capability, observation, {
    ...options,
    failedAttempts: input.failedAttempts,
    risk: input.risk
  })

  if (previous && assessed.policy.workerId !== previous.workerId) {
    throw checkpointError(
      "FACTORY_CHECKPOINT_BINDING_MISMATCH",
      "Existing software factory checkpoint worker no longer matches reviewed policy."
    )
  }

  const nextVersion = currentCheckpointVersion + 1
  const now = nowDate(options)
  const checkpoint = buildCheckpoint({
    run,
    checkpointVersion: nextVersion,
    capability: input.capability,
    observation,
    policy: assessed.policy,
    freshness: assessed.freshness,
    dispatch: assessed.dispatch,
    now
  })
  const root = checkpointRoot(run.runId, options)
  await ensurePrivateDir(root)

  const finalPath = join(root, checkpointFileName(nextVersion))
  const tempPath = join(root, `.pending-${randomUUID()}.json`)
  let handle

  try {
    handle = await open(tempPath, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await link(tempPath, finalPath)
    await syncDirectory(root)
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw checkpointError(
        "FACTORY_CHECKPOINT_VERSION_STALE",
        "Software factory dispatch checkpoint changed; reload before updating."
      )
    }

    if (error instanceof SoftwareFactoryDispatchCheckpointError) {
      throw error
    }

    throw checkpointError(
      "FACTORY_CHECKPOINT_STORE_UNAVAILABLE",
      "Software factory dispatch checkpoint store is unavailable."
    )
  } finally {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
  }

  return checkpoint
}

export function formatSoftwareFactoryDispatchCheckpointError(error) {
  if (error instanceof SoftwareFactoryDispatchCheckpointError) {
    return `PPO software factory dispatch-checkpoint error [${error.code}]: ${error.safeMessage}`
  }

  return "PPO software factory dispatch-checkpoint error: unexpected local failure."
}
