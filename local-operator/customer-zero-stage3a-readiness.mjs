import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { getOrdinaryDevelopmentProject } from "./github-project-registry.mjs"
import {
  DEVELOPMENT_CONTINUE_RUNTIME_PROFILE_ID,
  describeOrdinaryProjectCapabilities,
  loadDevelopmentContinueRuntimeProfile
} from "./development-continue-runtime-profile.mjs"
import { createGitHubReadOnlyClient } from "./github-readonly.mjs"

const execFileAsync = promisify(execFile)

export const STAGE3A_PROJECT_ID = "khlim-assist"
export const STAGE3A_REPOSITORY = "Linardi1328/khlim-assist"
export const STAGE3A_REQUIRED_WORKFLOW = ".github/workflows/ppo-pr-validation.yml"
export const STAGE3A_MAX_REMOTE_AGE_MS = 5 * 60 * 1000

const OBSERVATION_IDS = Object.freeze([
  "project-identity",
  "reviewed-policy",
  "host-dependencies",
  "checkout-clean",
  "github-readonly",
  "observation-freshness",
  "exact-revision",
  "validation-workflow"
])

export class Stage3AReadinessError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "Stage3AReadinessError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function observation(id, status, code = null) {
  return Object.freeze({
    id,
    status,
    ...(code ? { code } : {})
  })
}

function assertNoCallerSelectedTarget(request) {
  if (
    request === undefined ||
    request === null ||
    (typeof request === "object" && !Array.isArray(request) && Object.keys(request).length === 0)
  ) {
    return
  }

  throw new Stage3AReadinessError(
    "STAGE3A_CALLER_TARGET_FORBIDDEN",
    "Stage 3A readiness is fixed to KHLIM Assist and accepts no caller-selected target."
  )
}

function normalizeGitHubRemote(remote) {
  if (typeof remote !== "string") {
    return null
  }

  const value = remote.trim()
  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u)
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`
  }

  try {
    const parsed = new URL(value)
    if (parsed.hostname !== "github.com") {
      return null
    }

    const parts = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/")
    if (parts.length !== 2) {
      return null
    }

    return `${parts[0]}/${parts[1].replace(/\.git$/u, "")}`
  } catch {
    return null
  }
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value.trim())
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function publicPolicyMetadata(capability) {
  if (!capability) {
    return null
  }

  return {
    runtimeProfileId: capability.runtimeProfileId,
    policyId: capability.policyId,
    policyVersion: capability.policyVersion,
    gateIds: capability.gates.map((gate) => gate.id)
  }
}

function safeNow(options) {
  const value = typeof options.now === "function" ? options.now() : new Date()
  return value instanceof Date ? value : new Date(value)
}

function defaultCommandRunner({ file, args, cwd, env }) {
  return execFileAsync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024,
    shell: false,
    timeout: 15_000
  })
}

async function observeWorkflow(commandRunner, now) {
  let result

  try {
    result = await commandRunner({
      file: "gh",
      args: [
        "api",
        "--method",
        "GET",
        "/repos/Linardi1328/khlim-assist/actions/workflows/ppo-pr-validation.yml"
      ],
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        TERM: "dumb",
        NO_COLOR: "1",
        GIT_TERMINAL_PROMPT: "0"
      }
    })
  } catch {
    return {
      observation: observation("validation-workflow", "SKIP", "WORKFLOW_UNAVAILABLE"),
      workflow: null
    }
  }

  try {
    const payload = JSON.parse(String(result?.stdout ?? ""))
    const valid =
      payload &&
      payload.path === STAGE3A_REQUIRED_WORKFLOW &&
      payload.state === "active" &&
      Number.isInteger(payload.id)

    return {
      observation: valid
        ? observation("validation-workflow", "PASS")
        : observation("validation-workflow", "FAIL", "WORKFLOW_MISMATCH"),
      workflow: valid
        ? {
            path: STAGE3A_REQUIRED_WORKFLOW,
            state: "active",
            observedAt: now.toISOString()
          }
        : null
    }
  } catch {
    return {
      observation: observation("validation-workflow", "FAIL", "WORKFLOW_MALFORMED"),
      workflow: null
    }
  }
}

async function observeCheckout(runtimeProfile, commandRunner) {
  const registryEntry = runtimeProfile?.workspaceRegistry?.[STAGE3A_PROJECT_ID]
  const sourceRepoPath = registryEntry?.sourceRepoPath
  const gitExecutablePath = runtimeProfile?.codexConfig?.gitExecutablePath

  if (typeof sourceRepoPath !== "string" || typeof gitExecutablePath !== "string") {
    return {
      clean: observation("checkout-clean", "SKIP", "CHECKOUT_UNAVAILABLE"),
      revision: null,
      revisionObservation: observation("exact-revision", "SKIP", "CHECKOUT_UNAVAILABLE")
    }
  }

  try {
    const [headResult, statusResult, remoteResult] = await Promise.all([
      commandRunner({
        file: gitExecutablePath,
        args: ["-C", sourceRepoPath, "rev-parse", "HEAD"]
      }),
      commandRunner({
        file: gitExecutablePath,
        args: ["-C", sourceRepoPath, "status", "--porcelain=v1", "--untracked-files=normal"]
      }),
      commandRunner({
        file: gitExecutablePath,
        args: ["-C", sourceRepoPath, "remote", "get-url", "origin"]
      })
    ])

    const headSha = String(headResult?.stdout ?? "").trim()
    const dirty = String(statusResult?.stdout ?? "").trim().length > 0
    const remoteIdentity = normalizeGitHubRemote(String(remoteResult?.stdout ?? ""))

    if (!isSha(headSha) || remoteIdentity !== STAGE3A_REPOSITORY) {
      return {
        clean: observation("checkout-clean", "FAIL", "CHECKOUT_IDENTITY_MISMATCH"),
        revision: isSha(headSha) ? headSha : null,
        revisionObservation: observation("exact-revision", "SKIP", "CHECKOUT_IDENTITY_MISMATCH")
      }
    }

    return {
      clean: dirty
        ? observation("checkout-clean", "FAIL", "CHECKOUT_DIRTY")
        : observation("checkout-clean", "PASS"),
      revision: headSha,
      revisionObservation: null
    }
  } catch {
    return {
      clean: observation("checkout-clean", "SKIP", "CHECKOUT_UNAVAILABLE"),
      revision: null,
      revisionObservation: observation("exact-revision", "SKIP", "CHECKOUT_UNAVAILABLE")
    }
  }
}

export async function observeKhlimAssistStage3Readiness(request = {}, options = {}) {
  assertNoCallerSelectedTarget(request)

  const now = safeNow(options)
  const projectResolver = options.projectResolver || getOrdinaryDevelopmentProject
  const capabilityDescriber = options.capabilityDescriber || describeOrdinaryProjectCapabilities
  const runtimeProfileLoader = options.runtimeProfileLoader || loadDevelopmentContinueRuntimeProfile
  const githubClient = options.githubClient || createGitHubReadOnlyClient()
  const commandRunner = options.commandRunner || defaultCommandRunner

  const observations = new Map()
  const project = projectResolver(STAGE3A_PROJECT_ID)
  const projectIdentityValid =
    project?.id === STAGE3A_PROJECT_ID &&
    project?.fullName === STAGE3A_REPOSITORY

  observations.set(
    "project-identity",
    projectIdentityValid
      ? observation("project-identity", "PASS")
      : observation("project-identity", "FAIL", "PROJECT_IDENTITY_MISMATCH")
  )

  const capability = capabilityDescriber()
    .find((entry) => entry.projectId === STAGE3A_PROJECT_ID)
  const policyValid =
    capability?.repository === STAGE3A_REPOSITORY &&
    capability?.runtimeProfileId === DEVELOPMENT_CONTINUE_RUNTIME_PROFILE_ID &&
    typeof capability?.policyId === "string" &&
    capability.policyId.length > 0 &&
    capability?.manifestCanExecute === false &&
    capability?.manifestCanDeploy === false

  observations.set(
    "reviewed-policy",
    policyValid
      ? observation("reviewed-policy", "PASS")
      : observation("reviewed-policy", "FAIL", "POLICY_MISMATCH")
  )

  let runtimeProfile = null
  try {
    runtimeProfile = await runtimeProfileLoader({
      action: "stage-3a-readiness",
      run: {
        project: {
          id: STAGE3A_PROJECT_ID
        }
      }
    }, options.runtimeProfileOptions || {})

    observations.set("host-dependencies", observation("host-dependencies", "PASS"))
  } catch {
    observations.set(
      "host-dependencies",
      observation("host-dependencies", "FAIL", "HOST_DEPENDENCIES_NOT_READY")
    )
  }

  const checkout = runtimeProfile
    ? await observeCheckout(runtimeProfile, commandRunner)
    : {
        clean: observation("checkout-clean", "SKIP", "HOST_DEPENDENCIES_NOT_READY"),
        revision: null,
        revisionObservation: observation("exact-revision", "SKIP", "HOST_DEPENDENCIES_NOT_READY")
      }

  observations.set("checkout-clean", checkout.clean)

  let remoteHeadSha = null
  let snapshot = null
  try {
    snapshot = await githubClient.getProjectSnapshot(STAGE3A_PROJECT_ID)
    const remoteIdentityValid =
      snapshot?.project?.id === STAGE3A_PROJECT_ID &&
      snapshot?.project?.fullName === STAGE3A_REPOSITORY &&
      snapshot?.repository?.fullName === STAGE3A_REPOSITORY &&
      snapshot?.repository?.defaultBranch === "main"

    observations.set(
      "github-readonly",
      remoteIdentityValid
        ? observation("github-readonly", "PASS")
        : observation("github-readonly", "FAIL", "REMOTE_IDENTITY_MISMATCH")
    )

    remoteHeadSha = snapshot?.recentCommits?.[0]?.sha || null
  } catch {
    observations.set(
      "github-readonly",
      observation("github-readonly", "SKIP", "GITHUB_READONLY_UNAVAILABLE")
    )
  }

  if (snapshot) {
    const observedAt = parseTimestamp(snapshot.retrievedAt)
    const ageMs = observedAt === null ? null : now.getTime() - observedAt
    const fresh =
      ageMs !== null &&
      ageMs >= -30_000 &&
      ageMs <= STAGE3A_MAX_REMOTE_AGE_MS

    observations.set(
      "observation-freshness",
      fresh
        ? observation("observation-freshness", "PASS")
        : observation("observation-freshness", "FAIL", "REMOTE_OBSERVATION_STALE")
    )
  } else {
    observations.set(
      "observation-freshness",
      observation("observation-freshness", "SKIP", "GITHUB_READONLY_UNAVAILABLE")
    )
  }

  if (checkout.revisionObservation) {
    observations.set("exact-revision", checkout.revisionObservation)
  } else if (!isSha(remoteHeadSha)) {
    observations.set(
      "exact-revision",
      observation("exact-revision", "SKIP", "REMOTE_REVISION_UNAVAILABLE")
    )
  } else {
    observations.set(
      "exact-revision",
      checkout.revision === remoteHeadSha
        ? observation("exact-revision", "PASS")
        : observation("exact-revision", "FAIL", "REVISION_MISMATCH")
    )
  }

  const workflowResult = await observeWorkflow(commandRunner, now)
  observations.set("validation-workflow", workflowResult.observation)

  const orderedObservations = OBSERVATION_IDS.map((id) => observations.get(id))
  const ready = orderedObservations.every((entry) => entry?.status === "PASS")

  return Object.freeze({
    schema: "personal-project-operator.customer-zero.stage3a-readiness.v1",
    project: Object.freeze({
      id: STAGE3A_PROJECT_ID,
      repository: STAGE3A_REPOSITORY
    }),
    ready,
    exactRevision: isSha(checkout.revision) ? checkout.revision : null,
    policy: publicPolicyMetadata(capability),
    requiredWorkflow: STAGE3A_REQUIRED_WORKFLOW,
    observations: Object.freeze(orderedObservations),
    observedAt: now.toISOString()
  })
}
