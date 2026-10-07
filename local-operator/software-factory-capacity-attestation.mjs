import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  unlink
} from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import {
  SOFTWARE_FACTORY_CAPACITY_STATES,
  SOFTWARE_FACTORY_CONTROL_PLANE_VERSION,
  SOFTWARE_FACTORY_INTEGRATION_STATES,
  assessSoftwareFactoryDispatch,
  describeSoftwareFactoryCapability
} from "./software-factory-control-plane.mjs"
import {
  SOFTWARE_FACTORY_CAPACITY_OBSERVATION_MAX_AGE_MS,
  readSoftwareFactoryDispatchCheckpoint
} from "./software-factory-dispatch-checkpoint.mjs"
import {
  isDevelopmentRunTerminalStatus,
  normalizeDevelopmentRunId,
  readDevelopmentRun
} from "./development-run-state.mjs"

export const SOFTWARE_FACTORY_CAPACITY_ATTESTATION_SCHEMA_VERSION = 1
export const SOFTWARE_FACTORY_CAPACITY_ATTESTATION_ISSUER = "reviewed-runtime-probe-v1"
export const SOFTWARE_FACTORY_CAPACITY_ATTESTATION_DIR = "software-factory-capacity-attestations"
export const SOFTWARE_FACTORY_CAPACITY_ATTESTATION_KEY_FILE = "attestation-key-v1"
export const SOFTWARE_FACTORY_CAPACITY_ATTESTATION_NONCE_DIR = "consumed-nonces"
export const SOFTWARE_FACTORY_CAPACITY_ATTESTATION_MAX_FUTURE_SKEW_MS = 60 * 1000

const capacitySet = new Set(SOFTWARE_FACTORY_CAPACITY_STATES)
const integrationSet = new Set(SOFTWARE_FACTORY_INTEGRATION_STATES)
const workerIdPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const noncePattern = /^[A-Za-z0-9_-]{22}$/u
const signaturePattern = /^[a-f0-9]{64}$/u

export class SoftwareFactoryCapacityAttestationError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryCapacityAttestationError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function attestationError(code, safeMessage) {
  return new SoftwareFactoryCapacityAttestationError(code, safeMessage)
}

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]
  return typeof configured === "string" && configured.trim()
    ? configured
    : DEFAULT_PPO_WRITE_DATA_DIR
}

function paths(options = {}) {
  const root = join(resolveWriteDataDir(options), SOFTWARE_FACTORY_CAPACITY_ATTESTATION_DIR)
  return {
    root,
    keyPath: join(root, SOFTWARE_FACTORY_CAPACITY_ATTESTATION_KEY_FILE),
    nonceDir: join(root, SOFTWARE_FACTORY_CAPACITY_ATTESTATION_NONCE_DIR)
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function ensureDurablePrivateDir(path, options = {}) {
  const mkdirImpl = options.mkdirImpl || mkdir
  const chmodImpl = options.chmodImpl || chmod
  const syncDirectoryImpl = options.syncDirectoryImpl || syncDirectory
  let firstCreated

  try {
    firstCreated = await mkdirImpl(path, { recursive: true, mode: 0o700 })
    await chmodImpl(path, 0o700)
  } catch {
    throw attestationError(
      "FACTORY_ATTESTATION_STORE_UNAVAILABLE",
      "Software factory attestation store is unavailable."
    )
  }

  if (firstCreated) {
    const rel = relative(firstCreated, path)
    const created = [firstCreated]
    if (rel && rel !== ".") {
      let current = firstCreated
      for (const part of rel.split(sep).filter(Boolean)) {
        current = join(current, part)
        created.push(current)
      }
    }

    try {
      await syncDirectoryImpl(dirname(firstCreated))
      for (const directory of created) {
        await syncDirectoryImpl(directory)
      }
    } catch {
      throw attestationError(
        "FACTORY_ATTESTATION_DURABILITY_UNAVAILABLE",
        "Software factory attestation directory durability could not be established."
      )
    }
  }
}

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw attestationError(
      "FACTORY_ATTESTATION_CLOCK_INVALID",
      "Software factory attestation clock is invalid."
    )
  }

  return date
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

async function readOrCreateAttestationKey(options = {}) {
  const { root, keyPath } = paths(options)
  await ensureDurablePrivateDir(root, options)

  async function readExisting() {
    let info
    let handle
    try {
      info = await lstat(keyPath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
        throw new Error("unsafe key metadata")
      }
      handle = await open(keyPath, "r")
      const key = await handle.readFile()
      if (key.length !== 32) {
        throw new Error("invalid key length")
      }
      return key
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null
      }
      throw attestationError(
        "FACTORY_ATTESTATION_KEY_INVALID",
        "Software factory attestation key is unavailable or invalid."
      )
    } finally {
      await handle?.close()
    }
  }

  const existing = await readExisting()
  if (existing) {
    return existing
  }

  const candidate = randomBytes(32)
  let handle
  let created = false
  try {
    handle = await open(keyPath, "wx", 0o600)
    await handle.writeFile(candidate)
    await handle.sync()
    await handle.close()
    handle = null
    created = true
    const syncDirectoryImpl = options.syncDirectoryImpl || syncDirectory
    await syncDirectoryImpl(root)
    return candidate
  } catch (error) {
    if (error?.code === "EEXIST") {
      const concurrent = await readExisting()
      if (concurrent) {
        return concurrent
      }
    }

    if (created) {
      throw attestationError(
        "FACTORY_ATTESTATION_KEY_DURABILITY_AMBIGUOUS",
        "Software factory attestation key may already exist; reload before retrying."
      )
    }

    throw attestationError(
      "FACTORY_ATTESTATION_STORE_UNAVAILABLE",
      "Software factory attestation store is unavailable."
    )
  } finally {
    await handle?.close().catch(() => {})
  }
}

function normalizeProbeResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw attestationError(
      "FACTORY_PROBE_RESULT_INVALID",
      "Software factory runtime probe result is invalid."
    )
  }

  const allowed = new Set(["workerId", "integration", "capacity", "observedAt"])
  const keys = Object.keys(input)
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw attestationError(
      "FACTORY_PROBE_RESULT_INVALID",
      "Software factory runtime probe result fields are invalid."
    )
  }

  const workerId = String(input.workerId ?? "").trim()
  const integration = String(input.integration ?? "").trim()
  const capacity = String(input.capacity ?? "").trim()
  const observedAt = String(input.observedAt ?? "")
  const parsed = Date.parse(observedAt)

  if (
    !workerIdPattern.test(workerId) ||
    !integrationSet.has(integration) ||
    !capacitySet.has(capacity) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== observedAt
  ) {
    throw attestationError(
      "FACTORY_PROBE_RESULT_INVALID",
      "Software factory runtime probe result is invalid."
    )
  }

  return { workerId, integration, capacity, observedAt }
}

function unsignedPayload(probeResult, nonce) {
  return {
    schemaVersion: SOFTWARE_FACTORY_CAPACITY_ATTESTATION_SCHEMA_VERSION,
    controlPlaneVersion: SOFTWARE_FACTORY_CONTROL_PLANE_VERSION,
    issuerId: SOFTWARE_FACTORY_CAPACITY_ATTESTATION_ISSUER,
    workerId: probeResult.workerId,
    integration: probeResult.integration,
    capacity: probeResult.capacity,
    observedAt: probeResult.observedAt,
    nonce
  }
}

function signPayload(payload, key) {
  return createHmac("sha256", key).update(stableStringify(payload)).digest("hex")
}

async function mintReviewedRuntimeAttestation(probeResult, options = {}) {
  const normalized = normalizeProbeResult(probeResult)
  const nonce = randomBytes(16).toString("base64url")
  const payload = unsignedPayload(normalized, nonce)
  const key = await readOrCreateAttestationKey(options)
  return Object.freeze({
    ...payload,
    signature: signPayload(payload, key)
  })
}

export async function probeAndAttestSoftwareFactoryWorkerCapacity(workerId, options = {}) {
  const normalizedWorkerId = String(workerId ?? "").trim()
  if (!workerIdPattern.test(normalizedWorkerId)) {
    throw attestationError(
      "FACTORY_RUNTIME_PROBE_WORKER_INVALID",
      "Software factory runtime probe worker is invalid."
    )
  }

  const probeImpl = options.trustedRuntimeProbeImpl
  if (typeof probeImpl !== "function") {
    throw attestationError(
      "FACTORY_RUNTIME_PROBE_UNAVAILABLE",
      "Reviewed software factory runtime probe is not configured."
    )
  }

  let raw
  try {
    raw = await probeImpl(normalizedWorkerId)
  } catch {
    throw attestationError(
      "FACTORY_RUNTIME_PROBE_FAILED",
      "Reviewed software factory runtime probe failed safely."
    )
  }

  const normalized = normalizeProbeResult(raw)
  if (normalized.workerId !== normalizedWorkerId) {
    throw attestationError(
      "FACTORY_RUNTIME_PROBE_WORKER_MISMATCH",
      "Reviewed runtime probe result does not match the requested worker."
    )
  }

  return await mintReviewedRuntimeAttestation(normalized, options)
}

function normalizeAttestation(attestation) {
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    throw attestationError(
      "FACTORY_ATTESTATION_INVALID",
      "Software factory capacity attestation is invalid."
    )
  }

  const allowed = new Set([
    "schemaVersion",
    "controlPlaneVersion",
    "issuerId",
    "workerId",
    "integration",
    "capacity",
    "observedAt",
    "nonce",
    "signature"
  ])
  const keys = Object.keys(attestation)
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw attestationError(
      "FACTORY_ATTESTATION_INVALID",
      "Software factory capacity attestation fields are invalid."
    )
  }

  const normalizedProbe = normalizeProbeResult({
    workerId: attestation.workerId,
    integration: attestation.integration,
    capacity: attestation.capacity,
    observedAt: attestation.observedAt
  })
  if (
    attestation.schemaVersion !== SOFTWARE_FACTORY_CAPACITY_ATTESTATION_SCHEMA_VERSION ||
    attestation.controlPlaneVersion !== SOFTWARE_FACTORY_CONTROL_PLANE_VERSION ||
    attestation.issuerId !== SOFTWARE_FACTORY_CAPACITY_ATTESTATION_ISSUER ||
    !noncePattern.test(String(attestation.nonce ?? "")) ||
    !signaturePattern.test(String(attestation.signature ?? ""))
  ) {
    throw attestationError(
      "FACTORY_ATTESTATION_INVALID",
      "Software factory capacity attestation is invalid."
    )
  }

  return {
    ...unsignedPayload(normalizedProbe, attestation.nonce),
    signature: attestation.signature
  }
}

export async function verifySoftwareFactoryCapacityAttestation(attestation, options = {}) {
  const normalized = normalizeAttestation(attestation)
  const key = await readOrCreateAttestationKey(options)
  const { signature, ...payload } = normalized
  const expected = Buffer.from(signPayload(payload, key), "hex")
  const actual = Buffer.from(signature, "hex")

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw attestationError(
      "FACTORY_ATTESTATION_SIGNATURE_INVALID",
      "Software factory capacity attestation signature is invalid."
    )
  }

  const now = nowDate(options)
  const observedMs = Date.parse(payload.observedAt)
  const ageMs = now.getTime() - observedMs
  const maxAgeMs = Number.isInteger(options.maxObservationAgeMs)
    ? options.maxObservationAgeMs
    : SOFTWARE_FACTORY_CAPACITY_OBSERVATION_MAX_AGE_MS

  if (
    maxAgeMs < 1 ||
    ageMs > maxAgeMs ||
    ageMs < -SOFTWARE_FACTORY_CAPACITY_ATTESTATION_MAX_FUTURE_SKEW_MS
  ) {
    throw attestationError(
      "FACTORY_ATTESTATION_EXPIRED",
      "Software factory capacity attestation is expired or outside the allowed clock window."
    )
  }

  return Object.freeze({
    issuerId: payload.issuerId,
    workerId: payload.workerId,
    integration: payload.integration,
    capacity: payload.capacity,
    observedAt: payload.observedAt,
    nonce: payload.nonce
  })
}

async function consumeNonce(attestation, options = {}) {
  const { nonceDir } = paths(options)
  await ensureDurablePrivateDir(nonceDir, options)
  const noncePath = join(nonceDir, attestation.nonce)
  let handle

  try {
    handle = await open(noncePath, "wx", 0o600)
    await handle.writeFile(`${attestation.observedAt}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    const syncDirectoryImpl = options.syncDirectoryImpl || syncDirectory
    await syncDirectoryImpl(nonceDir)
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw attestationError(
        "FACTORY_ATTESTATION_REPLAYED",
        "Software factory capacity attestation was already consumed."
      )
    }
    throw attestationError(
      "FACTORY_ATTESTATION_STORE_UNAVAILABLE",
      "Software factory attestation store is unavailable."
    )
  } finally {
    await handle?.close().catch(() => {})
  }
}

function assertRunVersion(run, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || run.version !== expectedVersion) {
    throw attestationError(
      "FACTORY_AUTHORIZATION_RUN_STALE",
      "Development run changed; reload before requesting software factory execution authorization."
    )
  }
  if (isDevelopmentRunTerminalStatus(run.status)) {
    throw attestationError(
      "FACTORY_AUTHORIZATION_RUN_TERMINAL",
      "Terminal development runs cannot receive software factory execution authorization."
    )
  }
}

function assertImplementationStatus(capability, run) {
  if (
    (capability === "implementation.backend" ||
      capability === "implementation.frontend" ||
      capability === "debugging" ||
      capability === "review.frontend") &&
    run.status !== "implementation_in_progress" &&
    run.status !== "review_changes_requested"
  ) {
    throw attestationError(
      "FACTORY_AUTHORIZATION_STATUS_INVALID",
      "Development run is not at an execution-eligible lifecycle status."
    )
  }
}

export async function authorizeSoftwareFactoryExecution(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw attestationError(
      "FACTORY_AUTHORIZATION_INPUT_INVALID",
      "Software factory execution authorization input is invalid."
    )
  }

  const runId = normalizeDevelopmentRunId(input.runId)
  const readRunImpl = options.readRun || readDevelopmentRun
  const run = await readRunImpl(runId, options)
  assertRunVersion(run, input.runVersion)
  assertImplementationStatus(input.capability, run)

  const policy = describeSoftwareFactoryCapability(input.capability, {
    failedAttempts: input.failedAttempts,
    risk: input.risk
  })

  if (policy.ownerApprovalRequired) {
    throw attestationError(
      "FACTORY_AUTHORIZATION_OWNER_REQUIRED",
      "Software factory capability still requires explicit owner approval."
    )
  }

  const checkpoint = await readSoftwareFactoryDispatchCheckpoint(runId, options)
  if (
    checkpoint.checkpointVersion !== input.checkpointVersion ||
    checkpoint.runVersion !== run.version ||
    checkpoint.capability !== input.capability ||
    checkpoint.workerId !== policy.workerId
  ) {
    throw attestationError(
      "FACTORY_AUTHORIZATION_CHECKPOINT_STALE",
      "Software factory checkpoint no longer matches the current execution request."
    )
  }

  const verified = await verifySoftwareFactoryCapacityAttestation(input.attestation, options)
  if (verified.workerId !== policy.workerId) {
    throw attestationError(
      "FACTORY_AUTHORIZATION_WORKER_MISMATCH",
      "Verified worker readiness does not match the reviewed capability policy."
    )
  }

  const dispatch = assessSoftwareFactoryDispatch({
    capability: input.capability,
    failedAttempts: input.failedAttempts,
    risk: input.risk,
    workerStates: {
      [verified.workerId]: {
        integration: verified.integration,
        capacity: verified.capacity
      }
    }
  })

  if (dispatch.outcome !== "ready" || dispatch.consumeAttempt !== true) {
    throw attestationError(
      "FACTORY_AUTHORIZATION_NOT_READY",
      "Verified worker readiness does not permit software factory execution."
    )
  }

  await consumeNonce(verified, options)

  return Object.freeze({
    authorized: true,
    runId,
    runVersion: run.version,
    capability: input.capability,
    workerId: policy.workerId,
    modelClass: dispatch.modelClass,
    skills: [...dispatch.skills],
    checkpointVersion: checkpoint.checkpointVersion,
    attestationIssuer: verified.issuerId,
    attestationObservedAt: verified.observedAt
  })
}

export function formatSoftwareFactoryCapacityAttestationError(error) {
  if (error instanceof SoftwareFactoryCapacityAttestationError) {
    return `PPO software factory attestation error [${error.code}]: ${error.safeMessage}`
  }
  return "PPO software factory attestation error: unexpected local failure."
}
