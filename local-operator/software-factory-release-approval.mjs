import { createHash, randomBytes } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename
} from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PPO_WRITE_DATA_DIR,
  PPO_WRITE_DATA_DIR_ENV
} from "./project-note-add.mjs"
import {
  DEVELOPMENT_RUN_ID_PATTERN
} from "./development-run-id.mjs"
import {
  PHASE_6G_APPROVED_MERGE_METHOD,
  executeShaPinnedMerge
} from "./github-delivery-agent.mjs"
import {
  SOFTWARE_FACTORY_RELEASE_PACKAGE_KIND,
  buildSoftwareFactoryReleasePackage
} from "./software-factory-release-package.mjs"

export const SOFTWARE_FACTORY_RELEASE_APPROVAL_ID = "software-factory-v1-3-release-approval"
export const SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_ID = "software-factory-v1-3-release-approval-policy"
export const SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS = 10 * 60 * 1000
export const SOFTWARE_FACTORY_RELEASE_REQUEST_ID_BYTES = 32
export const SOFTWARE_FACTORY_RELEASE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u
export const SOFTWARE_FACTORY_RELEASE_APPROVAL_STORE_DIR = "pending-software-factory-releases"

const MAX_RELEASE_REQUEST_RECORD_BYTES = 4096
const PENDING_DIR = "pending"
const CLAIMED_DIR = "claimed"
const shaPattern = /^[a-f0-9]{40}$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const projectIdPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const claimedFilePattern = /^([A-Za-z0-9_-]{43})\.[0-9]+\.[a-f0-9]{16}\.json$/u

export class SoftwareFactoryReleaseApprovalError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryReleaseApprovalError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function approvalError(code, safeMessage) {
  return new SoftwareFactoryReleaseApprovalError(code, safeMessage)
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

const releaseApprovalContract = Object.freeze({
  approval: SOFTWARE_FACTORY_RELEASE_APPROVAL_ID,
  policy: SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_ID,
  schemaVersion: 1,
  requestTtlMs: SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS,
  requestIdBytes: SOFTWARE_FACTORY_RELEASE_REQUEST_ID_BYTES,
  releasePackageKind: SOFTWARE_FACTORY_RELEASE_PACKAGE_KIND,
  requestBinding: [
    "runId",
    "runVersion",
    "projectId",
    "headSha",
    "prNumber",
    "packageHash",
    "mergeMethod"
  ],
  pendingToClaimedSingleUse: true,
  mergeMethod: PHASE_6G_APPROVED_MERGE_METHOD,
  productionDeployment: false,
  commands: {
    stage: "/ppo release",
    confirm: "/ppo release-confirm"
  }
})

export const SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_HASH = createHash("sha256")
  .update(stableStringify(releaseApprovalContract))
  .digest("hex")

function nowDate(options = {}) {
  const value = typeof options.now === "function" ? options.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function resolveWriteDataDir(options = {}) {
  const configured = options.writeDataDir || process.env[PPO_WRITE_DATA_DIR_ENV]
  return typeof configured === "string" && configured.trim()
    ? configured
    : DEFAULT_PPO_WRITE_DATA_DIR
}

function storePaths(options = {}) {
  const root = resolveWriteDataDir(options)
  const approvalRoot = join(root, SOFTWARE_FACTORY_RELEASE_APPROVAL_STORE_DIR)

  return {
    root,
    approvalRoot,
    pendingDir: join(approvalRoot, PENDING_DIR),
    claimedDir: join(approvalRoot, CLAIMED_DIR)
  }
}

function requestPath(directory, requestId) {
  return join(directory, `${requestId}.json`)
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }
    throw error
  }
}

async function ensurePrivateDir(path) {
  const before = await lstatIfPresent(path)

  if (before && (!before.isDirectory() || before.isSymbolicLink())) {
    throw approvalError("RELEASE_STORE_UNAVAILABLE", "Software factory release approval store is unavailable.")
  }

  if (!before) {
    await mkdir(path, { mode: 0o700 })
  }

  const after = await lstat(path)

  if (!after.isDirectory() || after.isSymbolicLink()) {
    throw approvalError("RELEASE_STORE_UNAVAILABLE", "Software factory release approval store is unavailable.")
  }

  await chmod(path, 0o700)
}

async function syncDirectory(path) {
  let handle

  try {
    handle = await open(path, "r")
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

async function ensureStore(paths) {
  await ensurePrivateDir(paths.root)
  await ensurePrivateDir(paths.approvalRoot)
  await syncDirectory(paths.root)
  await ensurePrivateDir(paths.pendingDir)
  await ensurePrivateDir(paths.claimedDir)
  await syncDirectory(paths.approvalRoot)
}

async function requireExistingStore(paths) {
  for (const path of [paths.approvalRoot, paths.pendingDir, paths.claimedDir]) {
    const info = await lstatIfPresent(path)

    if (!info) {
      return false
    }

    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw approvalError("RELEASE_STORE_UNAVAILABLE", "Software factory release approval store is unavailable.")
    }
  }

  return true
}

function makeRequestId(options = {}) {
  const randomBytesImpl = options.randomBytesImpl || randomBytes
  const value = randomBytesImpl(SOFTWARE_FACTORY_RELEASE_REQUEST_ID_BYTES).toString("base64url")

  if (!SOFTWARE_FACTORY_RELEASE_REQUEST_ID_PATTERN.test(value)) {
    throw approvalError("RELEASE_REQUEST_ID_GENERATION_FAILED", "Software factory release request id could not be generated.")
  }

  return value
}

function normalizeRequestId(value) {
  if (typeof value !== "string" || !SOFTWARE_FACTORY_RELEASE_REQUEST_ID_PATTERN.test(value)) {
    throw approvalError("RELEASE_REQUEST_ID_INVALID", "Software factory release request id is malformed.")
  }
  return value
}

function isIsoTimestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function requestRecord(packageValue, requestId, now) {
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS).toISOString()

  return {
    schemaVersion: 1,
    requestId,
    createdAt,
    expiresAt,
    policyId: SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_ID,
    policyHash: SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_HASH,
    runId: packageValue.run.runId,
    runVersion: packageValue.run.version,
    projectId: packageValue.run.projectId,
    headSha: packageValue.run.headSha,
    prNumber: packageValue.delivery.prNumber,
    packageHash: packageValue.packageHash,
    mergeMethod: PHASE_6G_APPROVED_MERGE_METHOD
  }
}

function serializeRecord(record) {
  const value = `${JSON.stringify(record)}\n`

  if (Buffer.byteLength(value, "utf8") > MAX_RELEASE_REQUEST_RECORD_BYTES) {
    throw approvalError("RELEASE_STORE_UNAVAILABLE", "Software factory release approval store is unavailable.")
  }

  return value
}

async function writePrivateExclusive(path, value) {
  const handle = await open(path, "wx", 0o600)

  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }

  await chmod(path, 0o600)
}

async function writePending(paths, record, options = {}) {
  let current = record

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) {
      current = { ...record, requestId: makeRequestId(options) }
    }

    try {
      await writePrivateExclusive(requestPath(paths.pendingDir, current.requestId), serializeRecord(current))
      await syncDirectory(paths.pendingDir)
      return current
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error
      }
    }
  }

  throw approvalError("RELEASE_STORE_UNAVAILABLE", "Software factory release approval store is unavailable.")
}

function parseStoredRecord(payload, expectedRequestId) {
  let record

  try {
    record = JSON.parse(payload)
  } catch {
    throw approvalError("RELEASE_REQUEST_INVALID", "Stored software factory release request is invalid.")
  }

  const exactKeys = [
    "schemaVersion",
    "requestId",
    "createdAt",
    "expiresAt",
    "policyId",
    "policyHash",
    "runId",
    "runVersion",
    "projectId",
    "headSha",
    "prNumber",
    "packageHash",
    "mergeMethod"
  ]
  const keys = Object.keys(record || {})

  if (
    keys.length !== exactKeys.length ||
    keys.some((key) => !exactKeys.includes(key)) ||
    record.schemaVersion !== 1 ||
    normalizeRequestId(record.requestId) !== expectedRequestId ||
    record.policyId !== SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_ID ||
    record.policyHash !== SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_HASH ||
    !DEVELOPMENT_RUN_ID_PATTERN.test(record.runId) ||
    !Number.isInteger(record.runVersion) ||
    record.runVersion < 1 ||
    !projectIdPattern.test(record.projectId || "") ||
    !shaPattern.test(record.headSha || "") ||
    !Number.isInteger(record.prNumber) ||
    record.prNumber <= 0 ||
    !sha256Pattern.test(record.packageHash || "") ||
    record.mergeMethod !== PHASE_6G_APPROVED_MERGE_METHOD ||
    !isIsoTimestamp(record.createdAt) ||
    !isIsoTimestamp(record.expiresAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.createdAt)
  ) {
    throw approvalError("RELEASE_REQUEST_INVALID", "Stored software factory release request is invalid.")
  }

  return record
}

async function readTrustedRecord(path, expectedRequestId) {
  const before = await lstatIfPresent(path)

  if (!before) {
    throw approvalError("RELEASE_REQUEST_NOT_FOUND", "Software factory release request was not found, expired, or already consumed.")
  }

  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RELEASE_REQUEST_RECORD_BYTES) {
    throw approvalError("RELEASE_STORE_UNAVAILABLE", "Software factory release approval store is unavailable.")
  }

  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))

  try {
    const current = await handle.stat()

    if (!current.isFile() || current.size > MAX_RELEASE_REQUEST_RECORD_BYTES) {
      throw approvalError("RELEASE_STORE_UNAVAILABLE", "Software factory release approval store is unavailable.")
    }

    return parseStoredRecord(await handle.readFile("utf8"), expectedRequestId)
  } finally {
    await handle.close()
  }
}

async function hasClaimed(paths, requestId) {
  const entries = await readdir(paths.claimedDir).catch(() => [])
  return entries.some((entry) => {
    const match = entry.match(claimedFilePattern)
    return match && match[1] === requestId
  })
}

async function claimRequest(requestId, options = {}) {
  const normalized = normalizeRequestId(requestId)
  const paths = storePaths(options)

  if (!await requireExistingStore(paths)) {
    throw approvalError("RELEASE_REQUEST_NOT_FOUND", "Software factory release request was not found, expired, or already consumed.")
  }

  if (await hasClaimed(paths, normalized)) {
    throw approvalError("RELEASE_REQUEST_ALREADY_CONSUMED", "Software factory release request was already consumed.")
  }

  const pending = requestPath(paths.pendingDir, normalized)
  const claimed = join(paths.claimedDir, `${normalized}.${process.pid}.${randomBytes(8).toString("hex")}.json`)

  try {
    await rename(pending, claimed)
    await syncDirectory(paths.pendingDir)
    await syncDirectory(paths.claimedDir)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw approvalError(
        await hasClaimed(paths, normalized) ? "RELEASE_REQUEST_ALREADY_CONSUMED" : "RELEASE_REQUEST_NOT_FOUND",
        "Software factory release request was not found, expired, or already consumed."
      )
    }

    throw approvalError("RELEASE_STORE_UNAVAILABLE", "Software factory release approval store is unavailable.")
  }

  const record = await readTrustedRecord(claimed, normalized)

  if (Date.parse(record.expiresAt) <= nowDate(options).getTime()) {
    throw approvalError("RELEASE_REQUEST_EXPIRED", "Software factory release request expired and cannot authorize a merge.")
  }

  return record
}

function packageMatchesRequest(packageValue, record) {
  return (
    packageValue?.kind === SOFTWARE_FACTORY_RELEASE_PACKAGE_KIND &&
    packageValue.run?.runId === record.runId &&
    packageValue.run?.version === record.runVersion &&
    packageValue.run?.projectId === record.projectId &&
    packageValue.run?.headSha === record.headSha &&
    packageValue.delivery?.prNumber === record.prNumber &&
    packageValue.delivery?.approvedMergeMethod === record.mergeMethod &&
    packageValue.packageHash === record.packageHash
  )
}

function mapFailure(error) {
  const code = error instanceof SoftwareFactoryReleaseApprovalError
    ? error.code
    : "RELEASE_APPROVAL_UNAVAILABLE"

  return {
    ok: false,
    outcome: code.toLowerCase(),
    code
  }
}

export async function stageSoftwareFactoryReleaseApproval(runId, options = {}) {
  try {
    const buildPackage = options.buildReleasePackage || buildSoftwareFactoryReleasePackage
    const packageValue = await buildPackage(runId, options)
    const paths = storePaths(options)
    const requested = requestRecord(packageValue, makeRequestId(options), nowDate(options))
    const record = parseStoredRecord(JSON.stringify(requested), requested.requestId)

    await ensureStore(paths)
    const stored = await writePending(paths, record, options)

    return {
      ok: true,
      outcome: "release_approval_staged",
      requestId: stored.requestId,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
      runId: stored.runId,
      runVersion: stored.runVersion,
      projectId: stored.projectId,
      headSha: stored.headSha,
      prNumber: stored.prNumber,
      packageHash: stored.packageHash,
      mergeMethod: stored.mergeMethod
    }
  } catch (error) {
    return mapFailure(error)
  }
}

export async function confirmSoftwareFactoryReleaseApproval(requestId, options = {}) {
  let record

  try {
    record = await claimRequest(requestId, options)
    const buildPackage = options.buildReleasePackage || buildSoftwareFactoryReleasePackage
    const packageValue = await buildPackage(record.runId, options)

    if (!packageMatchesRequest(packageValue, record)) {
      return {
        ok: false,
        outcome: "release_approval_stale",
        code: "RELEASE_APPROVAL_STALE"
      }
    }

    const mergeImpl = options.executeMerge || executeShaPinnedMerge
    const merged = await mergeImpl(record.runId, {
      ...options,
      expectedVersion: record.runVersion
    })

    if (merged?.ok !== true || merged?.outcome !== "merged") {
      return {
        ok: false,
        outcome: "release_merge_unavailable",
        code: "RELEASE_MERGE_UNAVAILABLE"
      }
    }

    return {
      ok: true,
      outcome: "release_merged",
      requestId: record.requestId,
      runId: record.runId,
      projectId: record.projectId,
      headSha: record.headSha,
      prNumber: record.prNumber,
      packageHash: record.packageHash,
      mergeMethod: record.mergeMethod,
      mergeCommitSha: merged.merge?.mergeCommitSha || null,
      mainSha: merged.merge?.mainSha || null
    }
  } catch (error) {
    return mapFailure(error)
  }
}

export function formatSoftwareFactoryReleaseApproval(result) {
  const lines = [
    "PPO Software Factory Release",
    `Status: ${result?.ok === true ? result.outcome : "unavailable"}`,
    `Outcome: ${result?.outcome || "release_approval_unavailable"}`
  ]

  if (result?.ok === true) {
    lines.push(`Run: ${result.runId}`)
    lines.push(`Project: ${result.projectId}`)
    lines.push(`Head: ${result.headSha}`)
    lines.push(`Pull request: #${result.prNumber}`)
    lines.push(`Package: ${result.packageHash}`)
    lines.push(`Merge method: ${result.mergeMethod}`)

    if (result.outcome === "release_approval_staged") {
      lines.push(`Expires: ${result.expiresAt}`)
      lines.push(`Confirm: /ppo release-confirm ${result.requestId}`)
    } else if (result.outcome === "release_merged") {
      lines.push(`Merge commit: ${result.mergeCommitSha || "verified remotely"}`)
      lines.push("Production deployment: not authorized.")
    }
  }

  return `${lines.join("\n")}\n`
}

export async function handlePpoReleaseCommand(runId, options = {}) {
  const result = await stageSoftwareFactoryReleaseApproval(runId, options)
  return {
    ok: result.ok === true,
    code: result.code || result.outcome,
    output: formatSoftwareFactoryReleaseApproval(result),
    result
  }
}

export async function handlePpoReleaseConfirmCommand(requestId, options = {}) {
  const result = await confirmSoftwareFactoryReleaseApproval(requestId, options)
  return {
    ok: result.ok === true,
    code: result.code || result.outcome,
    output: formatSoftwareFactoryReleaseApproval(result),
    result
  }
}

export function softwareFactoryReleaseApprovalPolicy() {
  return {
    id: SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_ID,
    hash: SOFTWARE_FACTORY_RELEASE_APPROVAL_POLICY_HASH,
    ttlMs: SOFTWARE_FACTORY_RELEASE_APPROVAL_TTL_MS,
    requestIdPattern: SOFTWARE_FACTORY_RELEASE_REQUEST_ID_PATTERN.source,
    mergeMethod: PHASE_6G_APPROVED_MERGE_METHOD,
    productionDeployment: false
  }
}
