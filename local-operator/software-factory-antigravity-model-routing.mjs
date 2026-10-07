export const ANTIGRAVITY_MODEL_ROUTING_POLICY_VERSION = 1
export const ANTIGRAVITY_MODEL_CATALOG_MAX_CHARS = 64 * 1024

const modelClassSet = new Set(["economy", "standard", "deep"])
const unsafePattern = /(?:[\u0000-\u001F\u007F-\u009F]|[\p{Zl}\p{Zp}])/u
const slugPattern = /^[a-z0-9][a-z0-9._-]{1,119}$/u

export class AntigravityModelRoutingError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "AntigravityModelRoutingError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function routingError(code, safeMessage) {
  return new AntigravityModelRoutingError(code, safeMessage)
}

function normalizeModelClass(value) {
  const normalized = String(value ?? "").trim()

  if (!modelClassSet.has(normalized)) {
    throw routingError(
      "ANTIGRAVITY_MODEL_CLASS_INVALID",
      "Antigravity model class is outside the reviewed routing policy."
    )
  }

  return normalized
}

function versionTuple(text) {
  const match = String(text).match(/(?:^|[-_.])(\d{1,3})(?:[.-](\d{1,3}))?(?:[.-](\d{1,3}))?/u)

  if (!match) {
    return [0, 0, 0]
  }

  return [1, 2, 3].map((index) => Number.parseInt(match[index] || "0", 10))
}

function compareVersions(left, right) {
  const a = versionTuple(left.slug)
  const b = versionTuple(right.slug)

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return b[index] - a[index]
    }
  }

  return left.index - right.index
}

export function parseAntigravityModelCatalog(output) {
  const text = String(output ?? "")

  if (
    !text.trim() ||
    text.length > ANTIGRAVITY_MODEL_CATALOG_MAX_CHARS ||
    unsafePattern.test(text.replaceAll("\n", "").replaceAll("\r", ""))
  ) {
    throw routingError(
      "ANTIGRAVITY_MODEL_CATALOG_INVALID",
      "Antigravity model catalog is unavailable or unsafe."
    )
  }

  const models = []
  const seen = new Set()

  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim()

    if (!line) {
      continue
    }

    const [slug, ...labelParts] = line.split(/\s+/u)

    if (!slugPattern.test(slug) || seen.has(slug)) {
      continue
    }

    const searchable = `${slug} ${labelParts.join(" ")}`.toLowerCase()

    if (!/(gemini|claude|flash|pro|sonnet|opus|haiku)/u.test(searchable)) {
      continue
    }

    seen.add(slug)
    models.push(Object.freeze({
      slug,
      label: labelParts.join(" ").slice(0, 200),
      searchable,
      index
    }))
  }

  if (models.length === 0) {
    throw routingError(
      "ANTIGRAVITY_MODEL_CATALOG_EMPTY",
      "Antigravity returned no reviewed model candidates."
    )
  }

  return Object.freeze(models)
}

function tier(model) {
  const text = model.searchable

  if (/flash/u.test(text)) {
    if (/medium/u.test(text)) return "flash-medium"
    if (/low/u.test(text)) return "flash-low"
    if (/high/u.test(text)) return "flash-high"
    return "flash"
  }

  if (/\bpro\b/u.test(text)) {
    if (/high/u.test(text)) return "pro-high"
    if (/medium/u.test(text)) return "pro-medium"
    return "pro"
  }

  if (/(opus|sonnet)/u.test(text)) {
    return /(thinking|high)/u.test(text) ? "reasoning-deep" : "reasoning"
  }

  if (/haiku/u.test(text)) {
    return "lightweight"
  }

  return "other"
}

const preferences = Object.freeze({
  economy: Object.freeze([
    "flash-medium",
    "flash-low",
    "lightweight",
    "flash"
  ]),
  standard: Object.freeze([
    "flash-high",
    "pro-medium",
    "flash-medium",
    "reasoning"
  ]),
  deep: Object.freeze([
    "pro-high",
    "reasoning-deep",
    "pro",
    "reasoning"
  ])
})

export function selectAntigravityModel(modelClass, catalog) {
  const normalizedClass = normalizeModelClass(modelClass)

  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw routingError(
      "ANTIGRAVITY_MODEL_CATALOG_EMPTY",
      "Antigravity returned no reviewed model candidates."
    )
  }

  const candidates = catalog.map((model) => ({
    ...model,
    routingTier: tier(model)
  }))

  for (const preferredTier of preferences[normalizedClass]) {
    const matches = candidates
      .filter((candidate) => candidate.routingTier === preferredTier)
      .sort(compareVersions)

    if (matches.length > 0) {
      const selected = matches[0]
      return Object.freeze({
        policyVersion: ANTIGRAVITY_MODEL_ROUTING_POLICY_VERSION,
        modelClass: normalizedClass,
        modelSlug: selected.slug,
        routingTier: selected.routingTier
      })
    }
  }

  throw routingError(
    "ANTIGRAVITY_MODEL_UNAVAILABLE",
    `No reviewed Antigravity model is available for the ${normalizedClass} model class.`
  )
}

export function resolveAntigravityModelSelection(modelClass, output) {
  return selectAntigravityModel(modelClass, parseAntigravityModelCatalog(output))
}
