import { createHash, randomBytes, randomUUID } from "node:crypto"
import { chmod, link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import { getOrdinaryDevelopmentProject } from "./github-project-registry.mjs"

export const SOFTWARE_FACTORY_OBJECTIVE_QUEUE_ID = "software-factory-v1-7-objective-queue"
export const SOFTWARE_FACTORY_OBJECTIVE_QUEUE_STORE_DIR = "software-factory-objective-queue"
export const SOFTWARE_FACTORY_OBJECTIVE_QUEUE_MAX_PENDING = 50
export const SOFTWARE_FACTORY_OBJECTIVE_QUEUE_MAX_OBJECTIVE_CHARS = 1000

const queueIdPattern = /^[A-Za-z0-9_-]{32}$/u
const runIdPattern = /^[A-Za-z0-9_-]{43}$/u
const unsafeControlPattern = /[\u0000-\u001F\u007F-\u009F]/u
const sensitiveTextPattern = /(?:github_pat_|gh[opusr]_|sk-|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|authorization\s*:|password\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu

export class SoftwareFactoryObjectiveQueueError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryObjectiveQueueError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

export class SoftwareFactoryObjectiveQueueAmbiguousError extends SoftwareFactoryObjectiveQueueError {
  constructor(code, safeMessage) {
    super(code, safeMessage)
    this.name = "SoftwareFactoryObjectiveQueueAmbiguousError"
    this.stateCommitted = true
  }
}

function queueError(code, safeMessage) {
  return new SoftwareFactoryObjectiveQueueError(code, safeMessage)
}

function writeDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]
  return typeof configured === "string" && configured.trim()
    ? configured
    : DEFAULT_PPO_WRITE_DATA_DIR
}

function paths(options = {}) {
  const root = join(writeDataDir(options), SOFTWARE_FACTORY_OBJECTIVE_QUEUE_STORE_DIR)
  return {
    root,
    requests: join(root, "requests"),
    claims: join(root, "claims"),
    results: join(root, "results")
  }
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function ensurePrivateChildDirectory(parentPath, childPath, options = {}) {
  let created = false
  try {
    await mkdir(childPath, { mode: 0o700 })
    created = true
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }
  await chmod(childPath, 0o700)
  if (created) {
    const syncParentDirectoryImpl = options.syncParentDirectoryImpl || syncDirectory
    await syncParentDirectoryImpl(parentPath)
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

async function ensureStore(options = {}) {
  const p = paths(options)
  const base = writeDataDir(options)
  await ensurePrivateDir(base)
  await ensurePrivateChildDirectory(base, p.root, options)
  await ensurePrivateChildDirectory(p.root, p.requests, options)
  await ensurePrivateChildDirectory(p.root, p.claims, options)
  await ensurePrivateChildDirectory(p.root, p.results, options)
  return p
}

function nowIso(options = {}) {
  const value = options.now ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw queueError("FACTORY_QUEUE_TIME_INVALID", "Software factory queue clock is invalid.")
  }
  return date.toISOString()
}

function normalizeProjectId(value) {
  const projectId = String(value ?? "").trim()
  if (!getOrdinaryDevelopmentProject(projectId)) {
    throw queueError(
      "FACTORY_QUEUE_PROJECT_INVALID",
      "Software factory queued objective requires one approved ordinary project."
    )
  }
  return projectId
}

function normalizeObjective(value) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw queueError("FACTORY_QUEUE_OBJECTIVE_INVALID", "Queued objective text is invalid.")
  }
  const objective = value.trim()
  if (
    !objective ||
    objective.length > SOFTWARE_FACTORY_OBJECTIVE_QUEUE_MAX_OBJECTIVE_CHARS ||
    unsafeControlPattern.test(objective) ||
    sensitiveTextPattern.test(objective)
  ) {
    throw queueError("FACTORY_QUEUE_OBJECTIVE_INVALID", "Queued objective text is invalid.")
  }
  return objective
}

function objectiveHash(value) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeQueueId(value) {
  const queueId = String(value ?? "").trim()
  if (!queueIdPattern.test(queueId)) {
    throw queueError("FACTORY_QUEUE_ID_INVALID", "Software factory queue id is invalid.")
  }
  return queueId
}

function makeQueueId(options = {}) {
  const bytes = options.randomBytesImpl
    ? options.randomBytesImpl(24)
    : randomBytes(24)
  const queueId = bytes.toString("base64url")
  return normalizeQueueId(queueId)
}

async function immutableWrite(path, payload, directory, options = {}) {
  const tempPath = join(directory, `.pending-${randomUUID()}.json`)
  let handle
  let published = false
  try {
    handle = await open(tempPath, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await link(tempPath, path)
    published = true
    const syncDirectoryImpl = options.syncDirectoryImpl || syncDirectory
    await syncDirectoryImpl(directory)
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw queueError("FACTORY_QUEUE_CONFLICT", "Software factory queue state changed; reload before retrying.")
    }
    if (error instanceof SoftwareFactoryObjectiveQueueError) throw error
    if (published) {
      throw new SoftwareFactoryObjectiveQueueAmbiguousError(
        "FACTORY_QUEUE_DURABILITY_AMBIGUOUS",
        "Software factory queue state may already be committed; inspect queue state before retrying."
      )
    }
    throw queueError("FACTORY_QUEUE_STORE_UNAVAILABLE", "Software factory objective queue is unavailable.")
  } finally {
    await handle?.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
  }
}

async function readJson(path, notFoundCode = "FACTORY_QUEUE_NOT_FOUND") {
  let raw
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw queueError(notFoundCode, "Software factory queued objective was not found.")
    }
    throw queueError("FACTORY_QUEUE_STORE_UNAVAILABLE", "Software factory objective queue is unavailable.")
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw queueError("FACTORY_QUEUE_CORRUPT", "Software factory objective queue contains invalid state.")
  }
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw queueError("FACTORY_QUEUE_STORE_UNAVAILABLE", "Software factory objective queue is unavailable.")
  }
}

function validateStoredRequest(request, expectedQueueId = null) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw queueError("FACTORY_QUEUE_CORRUPT", "Software factory objective queue contains invalid state.")
  }
  const keys = Object.keys(request).sort()
  const expectedKeys = ["schemaVersion", "queueId", "projectId", "objective", "objectiveHash", "queuedAt"].sort()
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw queueError("FACTORY_QUEUE_CORRUPT", "Software factory objective queue contains invalid state.")
  }
  const queueId = normalizeQueueId(request.queueId)
  const projectId = normalizeProjectId(request.projectId)
  const objective = normalizeObjective(request.objective)
  const hash = String(request.objectiveHash ?? "").trim().toLowerCase()
  const queuedAt = String(request.queuedAt ?? "")
  const queuedMs = Date.parse(queuedAt)
  if (
    request.schemaVersion !== 1 ||
    (expectedQueueId !== null && queueId !== expectedQueueId) ||
    hash !== objectiveHash(objective) ||
    !/^[a-f0-9]{64}$/u.test(hash) ||
    !Number.isFinite(queuedMs) ||
    new Date(queuedMs).toISOString() !== queuedAt
  ) {
    throw queueError("FACTORY_QUEUE_CORRUPT", "Software factory objective queue contains invalid state.")
  }
  return Object.freeze({
    schemaVersion: 1,
    queueId,
    projectId,
    objective,
    objectiveHash: hash,
    queuedAt
  })
}

async function requestFiles(options = {}) {
  const p = await ensureStore(options)
  const names = await readdir(p.requests)
  return {
    p,
    names: names.filter((name) => /^[A-Za-z0-9_-]{32}\.json$/u.test(name)).sort()
  }
}

export async function listSoftwareFactoryQueuedObjectives(options = {}) {
  const { p, names } = await requestFiles(options)
  const pending = []

  for (const name of names) {
    const queueId = name.slice(0, -5)
    const resultPath = join(p.results, name)
    if (await exists(resultPath)) continue
    const request = validateStoredRequest(await readJson(join(p.requests, name)), queueId)
    pending.push({
      ...request,
      claimed: await exists(join(p.claims, name))
    })
  }

  pending.sort((left, right) => {
    const time = Date.parse(left.queuedAt) - Date.parse(right.queuedAt)
    return time || left.queueId.localeCompare(right.queueId)
  })

  return Object.freeze(pending.map((entry) => Object.freeze({ ...entry })))
}

export async function enqueueSoftwareFactoryObjective(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw queueError("FACTORY_QUEUE_INPUT_INVALID", "Software factory queue input is invalid.")
  }
  const projectId = normalizeProjectId(input.projectId)
  const objective = normalizeObjective(input.objective)
  const hash = objectiveHash(objective)
  const pending = await listSoftwareFactoryQueuedObjectives(options)
  const duplicate = pending.find((entry) => (
    entry.projectId === projectId &&
    entry.objectiveHash === hash
  ))

  if (duplicate) {
    return Object.freeze({
      ok: true,
      outcome: "already_queued",
      queueId: duplicate.queueId,
      projectId,
      objectiveHash: hash,
      queuedAt: duplicate.queuedAt
    })
  }

  if (pending.length >= SOFTWARE_FACTORY_OBJECTIVE_QUEUE_MAX_PENDING) {
    throw queueError("FACTORY_QUEUE_FULL", "Software factory objective queue is full.")
  }

  const p = await ensureStore(options)
  const queueId = makeQueueId(options)
  const queuedAt = nowIso(options)
  const request = {
    schemaVersion: 1,
    queueId,
    projectId,
    objective,
    objectiveHash: hash,
    queuedAt
  }
  await immutableWrite(join(p.requests, `${queueId}.json`), request, p.requests, options)

  return Object.freeze({
    ok: true,
    outcome: "queued",
    queueId,
    projectId,
    objectiveHash: hash,
    queuedAt
  })
}

export async function claimSoftwareFactoryQueuedObjective(queueIdInput, options = {}) {
  const queueId = normalizeQueueId(queueIdInput)
  const p = await ensureStore(options)
  const name = `${queueId}.json`
  const request = validateStoredRequest(await readJson(join(p.requests, name)), queueId)
  if (await exists(join(p.results, name))) {
    throw queueError("FACTORY_QUEUE_ALREADY_COMPLETED", "Software factory queued objective is already completed.")
  }
  const claim = {
    schemaVersion: 1,
    queueId,
    claimedAt: nowIso(options)
  }
  await immutableWrite(join(p.claims, name), claim, p.claims, options)
  return Object.freeze({ request: Object.freeze({ ...request }), claim: Object.freeze(claim) })
}

export async function releaseSoftwareFactoryQueueClaim(queueIdInput, options = {}) {
  const queueId = normalizeQueueId(queueIdInput)
  const p = await ensureStore(options)
  const name = `${queueId}.json`
  if (await exists(join(p.results, name))) {
    throw queueError("FACTORY_QUEUE_ALREADY_COMPLETED", "Completed queue claims cannot be released.")
  }
  try {
    await unlink(join(p.claims, name))
    await syncDirectory(p.claims)
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw queueError("FACTORY_QUEUE_STORE_UNAVAILABLE", "Software factory objective queue is unavailable.")
  }
  return true
}

export async function completeSoftwareFactoryQueuedObjective(queueIdInput, input, options = {}) {
  const queueId = normalizeQueueId(queueIdInput)
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw queueError("FACTORY_QUEUE_RESULT_INVALID", "Software factory queue result is invalid.")
  }
  const outcome = String(input.outcome ?? "").trim()
  const reason = input.reason === null || input.reason === undefined
    ? null
    : String(input.reason).trim()
  const runId = input.runId === null || input.runId === undefined
    ? null
    : String(input.runId).trim()

  if (
    !/^[a-z][a-z0-9_]{1,79}$/u.test(outcome) ||
    (reason !== null && (!reason || reason.length > 120 || unsafeControlPattern.test(reason))) ||
    (runId !== null && !runIdPattern.test(runId))
  ) {
    throw queueError("FACTORY_QUEUE_RESULT_INVALID", "Software factory queue result is invalid.")
  }

  const p = await ensureStore(options)
  const name = `${queueId}.json`
  validateStoredRequest(await readJson(join(p.requests, name)), queueId)
  if (!(await exists(join(p.claims, name)))) {
    throw queueError("FACTORY_QUEUE_CLAIM_REQUIRED", "Software factory queue result requires an active claim.")
  }

  const result = {
    schemaVersion: 1,
    queueId,
    outcome,
    reason,
    runId,
    completedAt: nowIso(options)
  }
  await immutableWrite(join(p.results, name), result, p.results, options)
  return Object.freeze(result)
}

export function formatSoftwareFactoryObjectiveQueueError(error) {
  if (error instanceof SoftwareFactoryObjectiveQueueError) {
    return `PPO software factory queue error [${error.code}]: ${error.safeMessage}`
  }
  return "PPO software factory queue error: unexpected local failure."
}
