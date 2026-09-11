import {
  getCustomerZeroOwnershipContext,
  validateCustomerZeroOwnershipContext
} from "./customer-zero-ownership-context.mjs"

const ownershipFields = ["ownerId", "workspaceId", "projectId"]
const allowedResolutionOptions = new Set(["requestedContext"])

export class DevelopmentRunOwnershipError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "DevelopmentRunOwnershipError"
    this.code = code
  }
}

function refuse(code, message) {
  throw new DevelopmentRunOwnershipError(code, message)
}

function sameContext(left, right) {
  return ownershipFields.every((field) => left[field] === right[field])
}

function projectIdForRun(run) {
  const projectId = run?.project?.id
  if (typeof projectId !== "string" || !projectId) {
    refuse("RUN_OWNERSHIP_INVALID", "Development run project is invalid.")
  }
  return projectId
}

export const RUN_UNIT_INTERFACE_CONTRACT = Object.freeze({
  schemaVersion: 1,
  kind: "customer-zero-run-unit",
  identityFields: Object.freeze(["runId", "ownerId", "workspaceId", "projectId"]),
  lifecycle: "existing-development-run",
  parallelExecution: false,
  addsLifecycleStates: false,
  grantsExecutionAuthority: false
})

export function resolveDevelopmentRunOwnership(run, options = {}) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowedResolutionOptions.has(key))
  ) {
    refuse("RUN_OWNERSHIP_OPTIONS_INVALID", "Development run ownership options are invalid.")
  }
  const projectId = projectIdForRun(run)
  const fixedContext = getCustomerZeroOwnershipContext(projectId)
  if (!fixedContext) {
    refuse("RUN_PROJECT_UNKNOWN", "Development run project is not in the approved registry.")
  }

  const embedded = Object.hasOwn(run, "ownershipContext")
    ? validateCustomerZeroOwnershipContext(run.ownershipContext)
    : null
  const context = embedded || fixedContext
  if (context.projectId !== projectId) {
    refuse("RUN_OWNERSHIP_MISMATCH", "Development run ownership does not match its project.")
  }

  if (options.requestedContext !== undefined) {
    const requested = validateCustomerZeroOwnershipContext(options.requestedContext)
    if (!sameContext(requested, context)) {
      refuse("RUN_OWNERSHIP_MISMATCH", "Requested ownership does not match the development run.")
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    context,
    compatibility: embedded ? "explicit-context" : "legacy-fixed-customer-zero-binding",
    migrationRequired: false
  })
}

export function assertDevelopmentRunEvidenceOwnership(run, resolution = resolveDevelopmentRunOwnership(run)) {
  const evidence = run?.evidence
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    refuse("RUN_EVIDENCE_OWNERSHIP_INVALID", "Development run evidence is invalid.")
  }

  const evidenceKeys = Object.keys(evidence)
  const expectedEvidenceKinds = new Set([
    "planning",
    "implementation",
    "review",
    "test",
    "merge",
    "deploy",
    "verification",
    "rollback"
  ])
  if (
    evidenceKeys.length !== expectedEvidenceKinds.size ||
    evidenceKeys.some((key) => !expectedEvidenceKinds.has(key))
  ) {
    refuse("RUN_EVIDENCE_OWNERSHIP_INVALID", "Development run evidence kinds are invalid.")
  }

  for (const entries of Object.values(evidence)) {
    if (!Array.isArray(entries)) {
      refuse("RUN_EVIDENCE_OWNERSHIP_INVALID", "Development run evidence is invalid.")
    }
    for (const entry of entries) {
      const metadata = entry?.metadata
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        continue
      }
      if (Object.hasOwn(metadata, "project") && metadata.project !== resolution.context.projectId) {
        refuse("RUN_EVIDENCE_OWNERSHIP_MISMATCH", "Evidence belongs to a different project.")
      }
      const present = ownershipFields.filter((field) => Object.hasOwn(metadata, field))
      if (present.length > 0) {
        if (present.length !== ownershipFields.length) {
          refuse("RUN_EVIDENCE_OWNERSHIP_INVALID", "Evidence ownership context is incomplete.")
        }
        let evidenceContext
        try {
          evidenceContext = validateCustomerZeroOwnershipContext(Object.fromEntries(
            ownershipFields.map((field) => [field, metadata[field]])
          ))
        } catch {
          refuse("RUN_EVIDENCE_OWNERSHIP_MISMATCH", "Evidence ownership context is invalid.")
        }
        if (!sameContext(evidenceContext, resolution.context)) {
          refuse("RUN_EVIDENCE_OWNERSHIP_MISMATCH", "Evidence belongs to a different ownership context.")
        }
      }
    }
  }
  return resolution
}
