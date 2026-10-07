import assert from "node:assert/strict"
import test from "node:test"
import {
  parseAntigravityModelCatalog,
  resolveAntigravityModelSelection,
  selectAntigravityModel
} from "./software-factory-antigravity-model-routing.mjs"

const CATALOG = `
gemini-3.8-flash-high Gemini 3.8 Flash (High)
gemini-3.8-flash-medium Gemini 3.8 Flash (Medium)
gemini-3.7-flash-high Gemini 3.7 Flash (High)
gemini-3.1-pro-high Gemini 3.1 Pro (High)
claude-sonnet-4-6 Claude Sonnet 4.6 (Thinking)
`

test("economy chooses the newest reviewed flash-medium model", () => {
  const selected = resolveAntigravityModelSelection("economy", CATALOG)

  assert.equal(selected.modelSlug, "gemini-3.8-flash-medium")
  assert.equal(selected.routingTier, "flash-medium")
})

test("standard chooses the newest reviewed flash-high model", () => {
  const selected = resolveAntigravityModelSelection("standard", CATALOG)

  assert.equal(selected.modelSlug, "gemini-3.8-flash-high")
  assert.equal(selected.routingTier, "flash-high")
})

test("deep prefers a reviewed pro-high model over generic reasoning models", () => {
  const selected = resolveAntigravityModelSelection("deep", CATALOG)

  assert.equal(selected.modelSlug, "gemini-3.1-pro-high")
  assert.equal(selected.routingTier, "pro-high")
})

test("deep can use a reasoning model when no reviewed pro model exists", () => {
  const selected = resolveAntigravityModelSelection(
    "deep",
    "claude-sonnet-4-6 Claude Sonnet 4.6 (Thinking)\n"
  )

  assert.equal(selected.modelSlug, "claude-sonnet-4-6")
  assert.equal(selected.routingTier, "reasoning-deep")
})

test("deep fails closed rather than silently using a flash-only catalog", () => {
  assert.throws(
    () => resolveAntigravityModelSelection(
      "deep",
      "gemini-3.8-flash-high Gemini 3.8 Flash (High)\n"
    ),
    (error) => error?.code === "ANTIGRAVITY_MODEL_UNAVAILABLE"
  )
})

test("newer model versions win within the same reviewed routing tier", () => {
  const selected = resolveAntigravityModelSelection(
    "standard",
    [
      "gemini-3.6-flash-high Gemini 3.6 Flash (High)",
      "gemini-3.10-flash-high Gemini 3.10 Flash (High)",
      "gemini-3.8-flash-high Gemini 3.8 Flash (High)"
    ].join("\n")
  )

  assert.equal(selected.modelSlug, "gemini-3.10-flash-high")
})

test("catalog parser ignores headings and duplicate model slugs", () => {
  const parsed = parseAntigravityModelCatalog([
    "Available models:",
    "gemini-3.8-flash-high Gemini 3.8 Flash (High)",
    "gemini-3.8-flash-high Gemini 3.8 Flash (High)",
    "not-a-model Some unrelated line"
  ].join("\n"))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].slug, "gemini-3.8-flash-high")
})

test("invalid abstract model class is refused", () => {
  const catalog = parseAntigravityModelCatalog(CATALOG)

  assert.throws(
    () => selectAntigravityModel("maximum", catalog),
    (error) => error?.code === "ANTIGRAVITY_MODEL_CLASS_INVALID"
  )
})

test("control characters in model catalog are refused", () => {
  assert.throws(
    () => parseAntigravityModelCatalog("gemini-3.8-flash-high Gemini\u001b[31m"),
    (error) => error?.code === "ANTIGRAVITY_MODEL_CATALOG_INVALID"
  )
})
