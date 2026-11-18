import { createHash } from "node:crypto"
import { SOFTWARE_FACTORY_CAPACITY_STATES } from "./software-factory-control-plane.mjs"

// RIC-181 offline multi-provider collaboration contract.
//
// Everything in this module is pure and non-authorizing. It validates untrusted
// handoff data, never executes it, never reads or writes canonical PPO run
// state, never starts a process or opens a network connection, and never grants
// a permission. A validated envelope is evidence that a message is well formed
// and addressed along an allowed route. It is not an approval, a dispatch, or a
// source of authority. Authority stays with the canonical PPO run, the trusted
// registry, the owner, and the existing fencing and gateway work (RIC-157,
// RIC-177).

export const SOFTWARE_FACTORY_COLLABORATION_CONTRACT_ID = "software-factory-collaboration-handoff-v2"
export const SOFTWARE_FACTORY_COLLABORATION_SCHEMA_VERSION = 2
export const SOFTWARE_FACTORY_COLLABORATION_MAX_ENVELOPE_BYTES = 8192
export const SOFTWARE_FACTORY_COLLABORATION_MAX_EVIDENCE_REFS = 8
export const SOFTWARE_FACTORY_COLLABORATION_MAX_EVIDENCE_REF_BYTES = 64 * 1024
export const SOFTWARE_FACTORY_COLLABORATION_MAX_EVIDENCE_TOTAL_BYTES = 256 * 1024
export const SOFTWARE_FACTORY_COLLABORATION_MAX_FINDINGS = 5
export const SOFTWARE_FACTORY_COLLABORATION_MAX_SUMMARY_CHARS = 200
export const SOFTWARE_FACTORY_COLLABORATION_MAX_ATTEMPT = 10

export const SOFTWARE_FACTORY_COLLABORATION_MESSAGE_TYPES = Object.freeze([
  "contract_ready",
  "implementation_ready",
  "review_finding",
  "correction_requested",
  "provider_unavailable",
  "task_blocked",
  "owner_decision_required",
  "release_package_ready"
])

export const SOFTWARE_FACTORY_COLLABORATION_ROLES = Object.freeze([
  "coordinator",
  "backend_implementer",
  "frontend_implementer",
  "independent_reviewer",
  "owner"
])

export const SOFTWARE_FACTORY_COLLABORATION_EVIDENCE_KINDS = Object.freeze([
  "contract",
  "implementation",
  "test",
  "review",
  "release_package",
  "provider_status"
])

// A requested action is a closed vocabulary label. It selects which already
// reviewed PPO step the coordinator may consider next; it is never a command.
export const SOFTWARE_FACTORY_COLLABORATION_REQUESTED_ACTIONS = Object.freeze([
  "relay_contract",
  "implement_frontend",
  "run_tests",
  "evaluate_review",
  "apply_correction",
  "reroute_or_checkpoint",
  "await_owner"
])

export const SOFTWARE_FACTORY_COLLABORATION_REVIEW_DECISIONS = Object.freeze([
  "approved",
  "changes_requested"
])

export const SOFTWARE_FACTORY_COLLABORATION_SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"])
export const SOFTWARE_FACTORY_COLLABORATION_AREAS = Object.freeze(["backend", "frontend"])

const reasonCodesByType = Object.freeze({
  provider_unavailable: Object.freeze([
    "quota_exhausted",
    "rate_limited",
    "provider_unavailable",
    "availability_unknown",
    "capability_mismatch"
  ]),
  task_blocked: Object.freeze([
    "capability_mismatch",
    "no_eligible_provider",
    "no_eligible_reviewer",
    "contract_changed",
    "workspace_conflict",
    "ambiguous_outcome",
    "timeout",
    "stale_evidence"
  ]),
  owner_decision_required: Object.freeze([
    "correction_budget_exhausted",
    "contract_changed",
    "ambiguous_outcome",
    "timeout",
    "scope_exception",
    "security_exception",
    "budget",
    "sensitive_data",
    "unresolved_p1",
    "no_eligible_provider",
    "no_eligible_reviewer",
    "release_decision"
  ])
})

export const SOFTWARE_FACTORY_COLLABORATION_REASON_CODES = Object.freeze(
  [...new Set(Object.values(reasonCodesByType).flat())].sort()
)

const agentRoles = Object.freeze(["backend_implementer", "frontend_implementer", "independent_reviewer"])

// Allowed (sender role -> recipient role, requested action) routes per message
// type. Agents talk only to the coordinator; PPO relays. This keeps one
// authoritative ordering point and prevents agent-to-agent side channels.
const routesByType = Object.freeze({
  contract_ready: Object.freeze([
    ["backend_implementer", "coordinator", "relay_contract"],
    ["coordinator", "frontend_implementer", "implement_frontend"]
  ]),
  implementation_ready: Object.freeze([
    ["backend_implementer", "coordinator", "run_tests"],
    ["frontend_implementer", "coordinator", "run_tests"]
  ]),
  review_finding: Object.freeze([
    ["independent_reviewer", "coordinator", "evaluate_review"]
  ]),
  correction_requested: Object.freeze([
    ["coordinator", "backend_implementer", "apply_correction"],
    ["coordinator", "frontend_implementer", "apply_correction"]
  ]),
  provider_unavailable: Object.freeze([
    ...agentRoles.map((role) => [role, "coordinator", "reroute_or_checkpoint"]),
    ["coordinator", "owner", "await_owner"]
  ]),
  task_blocked: Object.freeze([
    ...agentRoles.map((role) => [role, "coordinator", "reroute_or_checkpoint"]),
    ["coordinator", "owner", "await_owner"]
  ]),
  owner_decision_required: Object.freeze([
    ["coordinator", "owner", "await_owner"]
  ]),
  release_package_ready: Object.freeze([
    ["coordinator", "owner", "await_owner"]
  ])
})

const candidateRequiredTypes = new Set([
  "contract_ready",
  "implementation_ready",
  "review_finding",
  "correction_requested",
  "release_package_ready"
])
const contractDigestRequiredTypes = new Set([
  "contract_ready",
  "implementation_ready",
  "release_package_ready"
])
const requiredEvidenceByType = Object.freeze({
  contract_ready: Object.freeze(["contract"]),
  implementation_ready: Object.freeze(["implementation"]),
  review_finding: Object.freeze(["review"]),
  // Corrections may cite review or test evidence; see normalizeEvidence.
  correction_requested: Object.freeze([]),
  provider_unavailable: Object.freeze(["provider_status"]),
  task_blocked: Object.freeze([]),
  owner_decision_required: Object.freeze([]),
  release_package_ready: Object.freeze(["release_package", "test", "review"])
})

const shaPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const correlationPattern = /^[a-f0-9]{32}$/u
const runIdPattern = /^[A-Za-z0-9_-]{43}$/u
const projectIdPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u
const stepIdPattern = /^[a-z][a-z0-9-]{0,31}$/u
const providerIdPattern = /^[a-z][a-z0-9-]{0,31}$/u
const findingCodePattern = /^[a-z][a-z0-9_]{0,39}$/u
// Evidence references are opaque identifiers resolved by PPO from its own
// evidence store. They are intentionally not paths: no slash, backslash or dot
// run can be smuggled through them.
const evidenceRefPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u

const controlPattern = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u
const sensitivePattern = /(?:SENSITIVE_TEST_SENTINEL|github_pat_|gh[opusr]_[A-Za-z0-9]|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY|bearer\s+[A-Za-z0-9._-]{8,}|api[_-]?key\s*[=:]|authorization\s*:|password\s*[=:]|passwd\s*[=:]|token\s*[=:]|secret\s*[=:]|credential\s*[=:]|PPO_[A-Z0-9_]*(?:CONFIRM|TOKEN|SECRET|PASSWORD))/iu
const pathPattern = /(?:(?:^|[\s"'`(=])(?:~\/|\.{1,2}\/|\/[A-Za-z0-9._-]+)|[A-Za-z]:\\|\.\.[\\/]|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}\b)/u
const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\//iu
const commandPattern = /(?:`|\$\(|&&|\|\||;\s*(?:rm|sudo|curl|wget|sh|bash|zsh|cat|echo|kill|chmod|chown|git|npm|npx|node|python3?|perl|ruby)\b|\|\s*(?:sh|bash|zsh)\b|\b(?:sudo|curl|wget|chmod|chown|pkill|killall|eval|exec|rm\s+-[A-Za-z]|kill\s+-[0-9A-Za-z]+|git\s+(?:push|reset|clean|checkout|commit|merge|rebase)|npm\s+(?:install|publish|run)|npx|docker|kubectl|ssh|scp)\b)/iu
const injectionPattern = /(?:\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(?:instructions?|rules?|polic(?:y|ies)|guardrails?|checks?|reviews?|restrictions?)\b|\b(?:system|developer)\s+(?:prompt|message)\b|\byou are now\b|\bact as\b|\bnew instructions?\b|\b(?:approve|authorize|authorise|grant|allow)\b[^.\n]{0,30}\b(?:release|merge|deploy(?:ment)?|permission|access|privilege|production|owner)\b|\bpre-?approved\b|\bowner (?:has )?(?:approved|authorized|authorised)\b|<\/?(?:system|assistant|instructions?|tool)\b|\bjailbreak\b)/iu

export class SoftwareFactoryCollaborationError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "SoftwareFactoryCollaborationError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

export function collaborationError(code, safeMessage) {
  return new SoftwareFactoryCollaborationError(code, safeMessage)
}

export function formatSoftwareFactoryCollaborationError(error) {
  if (error instanceof SoftwareFactoryCollaborationError) {
    return `PPO software factory collaboration error [${error.code}]: ${error.safeMessage}`
  }
  return "PPO software factory collaboration error: unexpected local failure."
}

export function collaborationStableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => collaborationStableStringify(entry)).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${collaborationStableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function collaborationSha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function collaborationDeepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) collaborationDeepFreeze(child)
  }
  return value
}

// ---------------------------------------------------------------------------
// Plain-data and text safety

function assertPlainData(value, label, seen = new WeakSet(), depth = 0) {
  if (depth > 8) throw collaborationError("COLLAB_ENVELOPE_INVALID", `${label} is nested too deeply.`)
  if (value === null || typeof value !== "object") {
    if (["function", "symbol", "bigint", "undefined"].includes(typeof value)) {
      throw collaborationError("COLLAB_ENVELOPE_INVALID", `${label} contains a non-data value.`)
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw collaborationError("COLLAB_ENVELOPE_INVALID", `${label} contains a non-finite number.`)
    }
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (seen.has(value) || (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)) {
    throw collaborationError("COLLAB_ENVELOPE_INVALID", `${label} is not plain data.`)
  }
  seen.add(value)
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw collaborationError("COLLAB_ENVELOPE_INVALID", `${label} contains sparse or decorated arrays.`)
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw collaborationError("COLLAB_ENVELOPE_INVALID", `${label} contains a symbol key.`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw collaborationError("COLLAB_ENVELOPE_INVALID", `${label} contains an accessor property.`)
    }
    assertPlainData(descriptor.value, label, seen, depth + 1)
  }
}

function snapshotPlainData(value, label) {
  assertPlainData(value, label)
  return structuredClone(value)
}

function requireExactKeys(value, keys, code, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== [...keys].sort().join("|")
  ) {
    throw collaborationError(code, `${label} fields are invalid.`)
  }
}

export function assertCollaborationSafeText(value, label, maxChars = SOFTWARE_FACTORY_COLLABORATION_MAX_SUMMARY_CHARS) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maxChars) {
    throw collaborationError("COLLAB_TEXT_INVALID", `${label} is invalid.`)
  }
  if (controlPattern.test(value)) {
    throw collaborationError("COLLAB_TEXT_INVALID", `${label} contains control characters.`)
  }
  if (sensitivePattern.test(value)) {
    throw collaborationError("COLLAB_SENSITIVE_DATA", `${label} contains sensitive-looking data.`)
  }
  if (injectionPattern.test(value)) {
    throw collaborationError("COLLAB_PROMPT_INJECTION", `${label} contains instruction-like or authority-claiming text.`)
  }
  if (commandPattern.test(value)) {
    throw collaborationError("COLLAB_COMMAND_REJECTED", `${label} contains command-like text.`)
  }
  if (pathPattern.test(value) || urlPattern.test(value)) {
    throw collaborationError("COLLAB_PATH_REJECTED", `${label} contains a path or URL; use an evidence reference.`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Trusted registry

const registryBrand = new WeakSet()

const registryProviderKeys = ["roles", "status", "trialApprovedRoles"]
const registryKeys = ["version", "providers", "assignments"]

export const SOFTWARE_FACTORY_COLLABORATION_DEFAULT_REGISTRY_CONFIG = Object.freeze({
  version: 1,
  providers: Object.freeze({
    ppo: Object.freeze({ roles: Object.freeze(["coordinator"]), status: "authoritative", trialApprovedRoles: Object.freeze([]) }),
    owner: Object.freeze({ roles: Object.freeze(["owner"]), status: "authoritative", trialApprovedRoles: Object.freeze([]) }),
    codex: Object.freeze({
      roles: Object.freeze(["backend_implementer", "independent_reviewer"]),
      status: "established",
      trialApprovedRoles: Object.freeze([])
    }),
    // Claude is under evaluation. It is registered, but never promoted: every
    // role it may hold must also be listed in trialApprovedRoles by the owner.
    claude: Object.freeze({
      roles: Object.freeze(["backend_implementer", "independent_reviewer"]),
      status: "evaluation",
      trialApprovedRoles: Object.freeze([])
    }),
    antigravity: Object.freeze({
      roles: Object.freeze(["frontend_implementer"]),
      status: "established",
      trialApprovedRoles: Object.freeze([])
    })
  }),
  // Provider order is preference order. The first entry is the primary; later
  // entries are alternates and only usable when the trusted policy lists them.
  assignments: Object.freeze({
    backend_implementer: Object.freeze(["codex", "claude"]),
    frontend_implementer: Object.freeze(["antigravity"]),
    independent_reviewer: Object.freeze(["codex", "claude"])
  })
})

/**
 * Build the trusted registry from reviewed configuration. Only a registry made
 * here is accepted by the validators; a caller-built lookalike is rejected.
 */
export function createTrustedCollaborationRegistry(config = SOFTWARE_FACTORY_COLLABORATION_DEFAULT_REGISTRY_CONFIG) {
  const snapshot = snapshotPlainData(config, "Collaboration registry")
  requireExactKeys(snapshot, registryKeys, "COLLAB_REGISTRY_INVALID", "Collaboration registry")

  if (snapshot.version !== 1) {
    throw collaborationError("COLLAB_REGISTRY_INVALID", "Collaboration registry version is unsupported.")
  }

  const providers = {}
  for (const [providerId, provider] of Object.entries(snapshot.providers)) {
    if (!providerIdPattern.test(providerId)) {
      throw collaborationError("COLLAB_REGISTRY_INVALID", "Collaboration registry provider id is invalid.")
    }
    requireExactKeys(provider, registryProviderKeys, "COLLAB_REGISTRY_INVALID", "Collaboration registry provider")
    if (
      !Array.isArray(provider.roles) || provider.roles.length < 1 ||
      new Set(provider.roles).size !== provider.roles.length ||
      provider.roles.some((role) => !SOFTWARE_FACTORY_COLLABORATION_ROLES.includes(role)) ||
      !["authoritative", "established", "evaluation"].includes(provider.status) ||
      !Array.isArray(provider.trialApprovedRoles) ||
      provider.trialApprovedRoles.some((role) => !provider.roles.includes(role))
    ) {
      throw collaborationError("COLLAB_REGISTRY_INVALID", "Collaboration registry provider policy is invalid.")
    }
    if (provider.roles.includes("coordinator") && providerId !== "ppo") {
      throw collaborationError("COLLAB_REGISTRY_INVALID", "Only PPO may hold the coordinator role.")
    }
    if (provider.roles.includes("owner") && providerId !== "owner") {
      throw collaborationError("COLLAB_REGISTRY_INVALID", "Only the owner principal may hold the owner role.")
    }
    providers[providerId] = provider
  }

  if (!providers.ppo?.roles.includes("coordinator") || !providers.owner?.roles.includes("owner")) {
    throw collaborationError("COLLAB_REGISTRY_INVALID", "Collaboration registry must define PPO and the owner.")
  }

  const assignments = {}
  requireExactKeys(
    snapshot.assignments,
    ["backend_implementer", "frontend_implementer", "independent_reviewer"],
    "COLLAB_REGISTRY_INVALID",
    "Collaboration registry assignments"
  )
  for (const [role, providerList] of Object.entries(snapshot.assignments)) {
    if (
      !Array.isArray(providerList) || providerList.length < 1 ||
      new Set(providerList).size !== providerList.length ||
      providerList.some((providerId) => !providers[providerId]?.roles.includes(role))
    ) {
      throw collaborationError("COLLAB_REGISTRY_INVALID", "Collaboration registry assignment is not backed by provider roles.")
    }
    assignments[role] = providerList
  }

  // Role separation: the frontend role must never be able to perform backend
  // mutations, and a backend provider must never be assigned frontend edits.
  const overlap = assignments.frontend_implementer.filter((providerId) => assignments.backend_implementer.includes(providerId))
  if (overlap.length > 0) {
    throw collaborationError(
      "COLLAB_REGISTRY_ROLE_CONFLICT",
      "A provider may not hold both backend and frontend implementation assignments."
    )
  }

  const registry = collaborationDeepFreeze({ version: 1, providers, assignments })
  registryBrand.add(registry)
  return registry
}

export function assertTrustedCollaborationRegistry(registry) {
  if (!registry || typeof registry !== "object" || !registryBrand.has(registry)) {
    throw collaborationError("COLLAB_REGISTRY_UNTRUSTED", "Collaboration registry is not a trusted registry.")
  }
  return registry
}

export function collaborationProviderHasRole(registry, providerId, role) {
  assertTrustedCollaborationRegistry(registry)
  return registry.providers[providerId]?.roles.includes(role) === true
}

// ---------------------------------------------------------------------------
// Envelope

const envelopeKeys = [
  "schemaVersion", "messageType", "projectId", "runId", "expectedRunVersion",
  "stepId", "attemptNumber", "correlationId", "idempotencyKey",
  "sender", "recipient", "planHash", "scopeDigest", "baseSha", "candidateSha",
  "contractDigest", "evidence", "findings", "resolvedFindings", "reviewDecision", "reasonCode",
  "requestedAction", "summary"
]

function normalizeParty(value, label, registry) {
  requireExactKeys(value, ["role", "providerId"], "COLLAB_IDENTITY_INVALID", label)
  if (
    !SOFTWARE_FACTORY_COLLABORATION_ROLES.includes(value.role) ||
    typeof value.providerId !== "string" ||
    !providerIdPattern.test(value.providerId)
  ) {
    throw collaborationError("COLLAB_IDENTITY_INVALID", `${label} identity is invalid.`)
  }
  if (!collaborationProviderHasRole(registry, value.providerId, value.role)) {
    throw collaborationError("COLLAB_IDENTITY_UNTRUSTED", `${label} is not a trusted provider for that role.`)
  }
  return { role: value.role, providerId: value.providerId }
}

function normalizeEvidence(list, messageType, candidateSha) {
  if (
    !Array.isArray(list) ||
    list.length > SOFTWARE_FACTORY_COLLABORATION_MAX_EVIDENCE_REFS
  ) {
    throw collaborationError("COLLAB_EVIDENCE_INVALID", "Evidence reference list is invalid.")
  }

  let total = 0
  const seen = new Set()
  const normalized = list.map((entry) => {
    requireExactKeys(entry, ["kind", "ref", "digest", "sizeBytes", "candidateSha"], "COLLAB_EVIDENCE_INVALID", "Evidence reference")
    if (
      !SOFTWARE_FACTORY_COLLABORATION_EVIDENCE_KINDS.includes(entry.kind) ||
      typeof entry.ref !== "string" || !evidenceRefPattern.test(entry.ref) ||
      typeof entry.digest !== "string" || !digestPattern.test(entry.digest) ||
      (entry.candidateSha !== null && (typeof entry.candidateSha !== "string" || !shaPattern.test(entry.candidateSha)))
    ) {
      throw collaborationError("COLLAB_EVIDENCE_INVALID", "Evidence reference is invalid.")
    }
    if (
      !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 ||
      entry.sizeBytes > SOFTWARE_FACTORY_COLLABORATION_MAX_EVIDENCE_REF_BYTES
    ) {
      throw collaborationError("COLLAB_EVIDENCE_OVERSIZED", "Evidence reference size is outside the bounded limit.")
    }
    if (seen.has(entry.ref)) {
      throw collaborationError("COLLAB_EVIDENCE_INVALID", "Evidence references must be unique.")
    }
    // Stale-candidate evidence: evidence bound to a different head than the
    // message's candidate is never accepted as support for this message.
    if (entry.candidateSha !== null && candidateSha !== null && entry.candidateSha !== candidateSha) {
      throw collaborationError("COLLAB_EVIDENCE_STALE", "Evidence is bound to a different candidate SHA.")
    }
    seen.add(entry.ref)
    total += entry.sizeBytes
    return { kind: entry.kind, ref: entry.ref, digest: entry.digest, sizeBytes: entry.sizeBytes, candidateSha: entry.candidateSha }
  })

  if (total > SOFTWARE_FACTORY_COLLABORATION_MAX_EVIDENCE_TOTAL_BYTES) {
    throw collaborationError("COLLAB_EVIDENCE_OVERSIZED", "Evidence references exceed the bounded total size.")
  }

  for (const kind of requiredEvidenceByType[messageType]) {
    if (!normalized.some((entry) => entry.kind === kind)) {
      throw collaborationError("COLLAB_EVIDENCE_MISSING", `Message type ${messageType} requires ${kind} evidence.`)
    }
  }
  if (messageType === "correction_requested" && !normalized.some((entry) => entry.kind === "review" || entry.kind === "test")) {
    throw collaborationError("COLLAB_EVIDENCE_MISSING", "A correction request requires review or test evidence.")
  }

  return normalized
}

function normalizeFindings(list, messageType, reviewDecision, recipientRole) {
  if (!Array.isArray(list) || list.length > SOFTWARE_FACTORY_COLLABORATION_MAX_FINDINGS) {
    throw collaborationError("COLLAB_FINDINGS_INVALID", "Findings list is invalid.")
  }

  const allowsFindings = messageType === "review_finding" || messageType === "correction_requested"
  if (!allowsFindings && list.length > 0) {
    throw collaborationError("COLLAB_FINDINGS_INVALID", "Findings are only valid on review and correction messages.")
  }

  const seen = new Set()
  const normalized = list.map((entry) => {
    requireExactKeys(entry, ["code", "severity", "area", "summary"], "COLLAB_FINDINGS_INVALID", "Finding")
    if (
      typeof entry.code !== "string" || !findingCodePattern.test(entry.code) ||
      !SOFTWARE_FACTORY_COLLABORATION_SEVERITIES.includes(entry.severity) ||
      !SOFTWARE_FACTORY_COLLABORATION_AREAS.includes(entry.area)
    ) {
      throw collaborationError("COLLAB_FINDINGS_INVALID", "Finding is invalid.")
    }
    if (seen.has(entry.code)) {
      throw collaborationError("COLLAB_FINDINGS_INVALID", "Finding codes must be unique.")
    }
    seen.add(entry.code)
    return {
      code: entry.code,
      severity: entry.severity,
      area: entry.area,
      summary: assertCollaborationSafeText(entry.summary, "Finding summary", 140)
    }
  })

  if (messageType === "correction_requested") {
    const expectedArea = recipientRole === "backend_implementer" ? "backend" : "frontend"
    if (normalized.length < 1 || normalized.some((finding) => finding.area !== expectedArea)) {
      throw collaborationError("COLLAB_FINDINGS_INVALID", "Correction findings must target the recipient's own area.")
    }
  }

  if (messageType === "review_finding") {
    const blocking = normalized.some((finding) => finding.severity === "P0" || finding.severity === "P1")
    if (reviewDecision === "approved" && blocking) {
      throw collaborationError("COLLAB_FINDINGS_INVALID", "An approving review cannot carry P0 or P1 findings.")
    }
    if (reviewDecision === "changes_requested" && normalized.length < 1) {
      throw collaborationError("COLLAB_FINDINGS_INVALID", "A change request must carry at least one finding.")
    }
  }

  return normalized
}

// A reviewer may explicitly close findings it raised earlier. This is only a
// claim: the run model decides whether each code is eligible to be resolved
// (it must exist and a correction for its area must have been accepted).
function normalizeResolvedFindings(list, messageType, findings) {
  if (!Array.isArray(list) || list.length > SOFTWARE_FACTORY_COLLABORATION_MAX_FINDINGS) {
    throw collaborationError("COLLAB_FINDINGS_INVALID", "Resolved findings list is invalid.")
  }
  if (messageType !== "review_finding" && list.length > 0) {
    throw collaborationError("COLLAB_FINDINGS_INVALID", "Findings can only be resolved by a review message.")
  }
  const raised = new Set(findings.map((finding) => finding.code))
  const seen = new Set()
  for (const code of list) {
    if (typeof code !== "string" || !findingCodePattern.test(code) || seen.has(code)) {
      throw collaborationError("COLLAB_FINDINGS_INVALID", "Resolved finding code is invalid or repeated.")
    }
    if (raised.has(code)) {
      throw collaborationError("COLLAB_FINDINGS_INVALID", "A finding cannot be both raised and resolved in one review.")
    }
    seen.add(code)
  }
  return [...list]
}

export function deriveCollaborationIdempotencyKey(fields) {
  return collaborationSha256(collaborationStableStringify({
    contractId: SOFTWARE_FACTORY_COLLABORATION_CONTRACT_ID,
    projectId: fields.projectId,
    runId: fields.runId,
    stepId: fields.stepId,
    attemptNumber: fields.attemptNumber,
    messageType: fields.messageType,
    sender: fields.sender,
    recipient: fields.recipient,
    baseSha: fields.baseSha,
    candidateSha: fields.candidateSha
  }))
}

/**
 * Validate one untrusted handoff envelope against the trusted registry. This
 * checks shape, identity-against-registry, route legality, bounds and text
 * safety only. Run, version, plan, candidate and ordering checks need run
 * context and live in the coordinator.
 */
export function validateCollaborationEnvelope(input, registry) {
  assertTrustedCollaborationRegistry(registry)
  const envelope = snapshotPlainData(input, "Collaboration envelope")
  requireExactKeys(envelope, envelopeKeys, "COLLAB_ENVELOPE_FIELDS_INVALID", "Collaboration envelope")

  if (Buffer.byteLength(collaborationStableStringify(envelope), "utf8") > SOFTWARE_FACTORY_COLLABORATION_MAX_ENVELOPE_BYTES) {
    throw collaborationError("COLLAB_ENVELOPE_OVERSIZED", "Collaboration envelope exceeds the bounded size.")
  }

  if (envelope.schemaVersion !== SOFTWARE_FACTORY_COLLABORATION_SCHEMA_VERSION) {
    throw collaborationError("COLLAB_SCHEMA_UNSUPPORTED", "Collaboration envelope schema is not supported.")
  }

  const messageType = envelope.messageType
  if (!SOFTWARE_FACTORY_COLLABORATION_MESSAGE_TYPES.includes(messageType)) {
    throw collaborationError("COLLAB_MESSAGE_TYPE_INVALID", "Collaboration message type is not supported.")
  }

  const patterns = [
    ["projectId", projectIdPattern], ["runId", runIdPattern], ["stepId", stepIdPattern],
    ["correlationId", correlationPattern], ["idempotencyKey", digestPattern],
    ["planHash", digestPattern], ["scopeDigest", digestPattern], ["baseSha", shaPattern]
  ]
  for (const [field, pattern] of patterns) {
    if (typeof envelope[field] !== "string" || !pattern.test(envelope[field])) {
      throw collaborationError("COLLAB_BINDING_INVALID", `Collaboration ${field} is invalid.`)
    }
  }
  if (
    !Number.isSafeInteger(envelope.expectedRunVersion) || envelope.expectedRunVersion < 1 || envelope.expectedRunVersion > 10_000_000 ||
    !Number.isSafeInteger(envelope.attemptNumber) || envelope.attemptNumber < 1 ||
    envelope.attemptNumber > SOFTWARE_FACTORY_COLLABORATION_MAX_ATTEMPT
  ) {
    throw collaborationError("COLLAB_BINDING_INVALID", "Collaboration version or attempt is invalid.")
  }

  if (candidateRequiredTypes.has(messageType)) {
    if (typeof envelope.candidateSha !== "string" || !shaPattern.test(envelope.candidateSha)) {
      throw collaborationError("COLLAB_CANDIDATE_REQUIRED", `Message type ${messageType} requires a candidate SHA.`)
    }
  } else if (envelope.candidateSha !== null && (typeof envelope.candidateSha !== "string" || !shaPattern.test(envelope.candidateSha))) {
    throw collaborationError("COLLAB_CANDIDATE_REQUIRED", "Candidate SHA is invalid.")
  }

  if (contractDigestRequiredTypes.has(messageType)) {
    if (typeof envelope.contractDigest !== "string" || !digestPattern.test(envelope.contractDigest)) {
      throw collaborationError("COLLAB_CONTRACT_DIGEST_REQUIRED", `Message type ${messageType} requires a contract digest.`)
    }
  } else if (envelope.contractDigest !== null && (typeof envelope.contractDigest !== "string" || !digestPattern.test(envelope.contractDigest))) {
    throw collaborationError("COLLAB_CONTRACT_DIGEST_REQUIRED", "Contract digest is invalid.")
  }

  const sender = normalizeParty(envelope.sender, "Sender", registry)
  const recipient = normalizeParty(envelope.recipient, "Recipient", registry)
  const route = routesByType[messageType].find(([from, to]) => from === sender.role && to === recipient.role)

  if (!route) {
    throw collaborationError("COLLAB_ROLE_UNAUTHORIZED", `A ${sender.role} may not send ${messageType} to a ${recipient.role}.`)
  }
  if (envelope.requestedAction !== route[2]) {
    throw collaborationError("COLLAB_ACTION_INVALID", "Requested action is outside the allowed vocabulary for this route.")
  }

  const reasonCodes = reasonCodesByType[messageType]
  if (reasonCodes) {
    if (!reasonCodes.includes(envelope.reasonCode)) {
      throw collaborationError("COLLAB_REASON_INVALID", `Message type ${messageType} requires a reviewed reason code.`)
    }
  } else if (envelope.reasonCode !== null) {
    throw collaborationError("COLLAB_REASON_INVALID", "A reason code is not valid for this message type.")
  }

  if (messageType === "review_finding") {
    if (!SOFTWARE_FACTORY_COLLABORATION_REVIEW_DECISIONS.includes(envelope.reviewDecision)) {
      throw collaborationError("COLLAB_REVIEW_DECISION_INVALID", "Review messages require an explicit decision.")
    }
  } else if (envelope.reviewDecision !== null) {
    throw collaborationError("COLLAB_REVIEW_DECISION_INVALID", "A review decision is not valid for this message type.")
  }

  const evidence = normalizeEvidence(envelope.evidence, messageType, envelope.candidateSha)
  const findings = normalizeFindings(envelope.findings, messageType, envelope.reviewDecision, recipient.role)
  const resolvedFindings = normalizeResolvedFindings(envelope.resolvedFindings, messageType, findings)
  const summary = assertCollaborationSafeText(envelope.summary, "Message summary")

  const normalized = {
    schemaVersion: SOFTWARE_FACTORY_COLLABORATION_SCHEMA_VERSION,
    messageType,
    projectId: envelope.projectId,
    runId: envelope.runId,
    expectedRunVersion: envelope.expectedRunVersion,
    stepId: envelope.stepId,
    attemptNumber: envelope.attemptNumber,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    sender,
    recipient,
    planHash: envelope.planHash,
    scopeDigest: envelope.scopeDigest,
    baseSha: envelope.baseSha,
    candidateSha: envelope.candidateSha,
    contractDigest: envelope.contractDigest,
    evidence,
    findings,
    resolvedFindings,
    reviewDecision: envelope.reviewDecision,
    reasonCode: envelope.reasonCode,
    requestedAction: envelope.requestedAction,
    summary
  }

  if (normalized.idempotencyKey !== deriveCollaborationIdempotencyKey(normalized)) {
    throw collaborationError("COLLAB_IDEMPOTENCY_INVALID", "Idempotency key does not match the message binding.")
  }

  return collaborationDeepFreeze({
    envelope: normalized,
    envelopeDigest: collaborationSha256(collaborationStableStringify(normalized)),
    authority: "none"
  })
}

/** Fixture helper: fill schema and derived key, then validate. Not a transport. */
export function buildCollaborationEnvelope(fields, registry) {
  const draft = {
    schemaVersion: SOFTWARE_FACTORY_COLLABORATION_SCHEMA_VERSION,
    candidateSha: null,
    contractDigest: null,
    evidence: [],
    findings: [],
    resolvedFindings: [],
    reviewDecision: null,
    reasonCode: null,
    ...fields
  }
  draft.idempotencyKey = fields.idempotencyKey ?? deriveCollaborationIdempotencyKey(draft)
  return validateCollaborationEnvelope(draft, registry)
}

// ---------------------------------------------------------------------------
// Approved scope

/**
 * Bind an owner-approved step decomposition to a validated plan hash. A single
 * structured plan classifies mixed frontend/backend work as "debugging" and that
 * classification is deliberately unchanged. The decomposition is what lets an
 * owner approve separate single-role steps without giving any one worker both
 * edit roles.
 */
export function buildCollaborationScope({ planHash, steps }) {
  if (typeof planHash !== "string" || !digestPattern.test(planHash)) {
    throw collaborationError("COLLAB_SCOPE_INVALID", "Collaboration scope plan hash is invalid.")
  }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 6) {
    throw collaborationError("COLLAB_SCOPE_INVALID", "Collaboration scope steps are invalid.")
  }
  const seen = new Set()
  const normalized = steps.map((step) => {
    requireExactKeys(step, ["stepId", "role"], "COLLAB_SCOPE_INVALID", "Collaboration scope step")
    if (
      typeof step.stepId !== "string" || !stepIdPattern.test(step.stepId) || seen.has(step.stepId) ||
      !["backend_implementer", "frontend_implementer", "independent_reviewer"].includes(step.role)
    ) {
      throw collaborationError("COLLAB_SCOPE_INVALID", "Collaboration scope step is invalid.")
    }
    seen.add(step.stepId)
    return { stepId: step.stepId, role: step.role }
  })
  return collaborationDeepFreeze({
    planHash,
    steps: normalized,
    scopeDigest: collaborationSha256(collaborationStableStringify({ planHash, steps: normalized }))
  })
}

// ---------------------------------------------------------------------------
// One writer per workspace

/**
 * Models the one-writer-per-workspace discipline for the offline simulation.
 * It only tracks in-memory ownership; it does not lock a real directory.
 */
export function createCollaborationWorkspaceGuard() {
  const holders = new Map()
  const history = []

  function record(event, workspaceId, holder) {
    history.push(Object.freeze({ sequence: history.length + 1, event, workspaceId, holder }))
  }

  return Object.freeze({
    acquireWriter(workspaceId, holder) {
      const current = holders.get(workspaceId)
      if (current) {
        record("writer_conflict_refused", workspaceId, holder)
        throw collaborationError(
          current.state === "quarantined" ? "COLLAB_WORKSPACE_QUARANTINED" : "COLLAB_WORKSPACE_WRITER_CONFLICT",
          current.state === "quarantined"
            ? "Workspace is quarantined after an ambiguous outcome and needs owner resolution."
            : "Workspace already has an active writer."
        )
      }
      holders.set(workspaceId, { holder, state: "held" })
      record("writer_acquired", workspaceId, holder)
    },
    assertReadable(workspaceId, holder) {
      const current = holders.get(workspaceId)
      if (current) {
        record("reader_refused", workspaceId, holder)
        throw collaborationError("COLLAB_WORKSPACE_WRITER_ACTIVE", "A reviewer needs a workspace with no active writer.")
      }
    },
    releaseWriter(workspaceId, holder) {
      const current = holders.get(workspaceId)
      if (!current || current.holder !== holder || current.state !== "held") {
        throw collaborationError("COLLAB_WORKSPACE_RELEASE_REFUSED", "Only the active writer can release a workspace.")
      }
      holders.delete(workspaceId)
      record("writer_released", workspaceId, holder)
    },
    // After a timeout or ambiguous completion the writer's process state is
    // unknown. The workspace stays unavailable until the owner resolves it.
    quarantine(workspaceId, holder) {
      const current = holders.get(workspaceId)
      if (!current || current.holder !== holder) {
        throw collaborationError("COLLAB_WORKSPACE_RELEASE_REFUSED", "Only the active writer can be quarantined.")
      }
      holders.set(workspaceId, { holder, state: "quarantined" })
      record("writer_quarantined", workspaceId, holder)
    },
    state(workspaceId) {
      const current = holders.get(workspaceId)
      return current ? { ...current } : { holder: null, state: "free" }
    },
    history() {
      return [...history]
    }
  })
}

// ---------------------------------------------------------------------------
// Task-owned cleanup (future adapter contract)

const cleanupRecordKeys = ["taskId", "workspacePath", "processes", "ports"]
const cleanupTargetKeys = ["taskId", "workspacePath", "pid", "startToken", "port"]

/**
 * Future adapters may only ever clean up a process, port or workspace they can
 * prove they started. This verifier never authorizes anything: a match only
 * means the target is eligible for a separately authorized, explicit cleanup.
 * Pattern, name and machine-wide matching are structurally impossible because
 * the target schema has no field for them.
 */
export function verifyTaskOwnedCleanupTarget(ownershipRecord, target) {
  const record = snapshotPlainData(ownershipRecord, "Ownership record")
  const candidate = snapshotPlainData(target, "Cleanup target")
  requireExactKeys(record, cleanupRecordKeys, "COLLAB_CLEANUP_RECORD_INVALID", "Ownership record")
  requireExactKeys(candidate, cleanupTargetKeys, "COLLAB_CLEANUP_TARGET_INVALID", "Cleanup target")

  const absolute = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{2,200}$/u
  if (
    typeof record.taskId !== "string" || !stepIdPattern.test(record.taskId) ||
    typeof record.workspacePath !== "string" || !absolute.test(record.workspacePath) || record.workspacePath === "/" ||
    !Array.isArray(record.processes) || record.processes.length > 8 ||
    !Array.isArray(record.ports) || record.ports.length > 8
  ) {
    throw collaborationError("COLLAB_CLEANUP_RECORD_INVALID", "Ownership record is invalid.")
  }
  for (const processRecord of record.processes) {
    requireExactKeys(processRecord, ["pid", "startToken"], "COLLAB_CLEANUP_RECORD_INVALID", "Ownership process")
    if (!Number.isSafeInteger(processRecord.pid) || processRecord.pid < 2 || typeof processRecord.startToken !== "string" || !digestPattern.test(processRecord.startToken)) {
      throw collaborationError("COLLAB_CLEANUP_RECORD_INVALID", "Ownership process is invalid.")
    }
  }
  if (record.ports.some((port) => !Number.isSafeInteger(port) || port < 1024 || port > 65535)) {
    throw collaborationError("COLLAB_CLEANUP_RECORD_INVALID", "Ownership port is invalid.")
  }

  if (
    candidate.taskId !== record.taskId ||
    candidate.workspacePath !== record.workspacePath ||
    !Number.isSafeInteger(candidate.pid) ||
    !(candidate.port === null || Number.isSafeInteger(candidate.port))
  ) {
    return Object.freeze({ eligible: false, reasonCode: "OWNERSHIP_MISMATCH", requiresExplicitAuthorization: true, grantsAuthority: false })
  }

  const ownedProcess = record.processes.find((entry) => entry.pid === candidate.pid && entry.startToken === candidate.startToken)
  if (!ownedProcess) {
    // A reused pid with a different start token is not the task's process.
    return Object.freeze({ eligible: false, reasonCode: "PROCESS_NOT_TASK_OWNED", requiresExplicitAuthorization: true, grantsAuthority: false })
  }
  if (candidate.port !== null && !record.ports.includes(candidate.port)) {
    return Object.freeze({ eligible: false, reasonCode: "PORT_NOT_TASK_OWNED", requiresExplicitAuthorization: true, grantsAuthority: false })
  }

  return Object.freeze({ eligible: true, reasonCode: "TASK_OWNED_TARGET_VERIFIED", requiresExplicitAuthorization: true, grantsAuthority: false })
}

export const SOFTWARE_FACTORY_COLLABORATION_CAPACITY_STATES = SOFTWARE_FACTORY_CAPACITY_STATES
