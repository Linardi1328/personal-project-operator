import assert from "node:assert/strict"
import test from "node:test"

import {
  LEARNING_DEBRIEF_REQUIREMENTS,
  LEARNING_DEBRIEF_VERSION,
  MAX_CODEX_LEARNING_PROMPT_CHARS,
  appendLearningDebriefRequirements
} from "./codex-learning-prompt.mjs"

test("appends the PPO learning debrief as a non-blocking learning artifact", () => {
  const output = appendLearningDebriefRequirements("Codex Prompt\n\nTask:\nImplement feature X")

  assert.match(output, /Codex Prompt/)
  assert.match(output, new RegExp(LEARNING_DEBRIEF_VERSION.replaceAll(".", "\\.")))
  assert.match(output, /Major technical decisions and purposes/)
  assert.match(output, /Alternatives and trade-offs/)
  assert.match(output, /Optional knowledge-check questions/)
  assert.match(output, /never a delivery gate/i)
  assert.match(output, /without turning learning into a required supervision gate/i)
})

test("keeps the standard focused on rationale rather than hidden chain-of-thought", () => {
  const output = appendLearningDebriefRequirements("Base prompt")

  assert.match(output, /Do not reveal private chain-of-thought or hidden reasoning/)
  assert.match(output, /decision rationales, evidence, trade-offs, and conclusions/)
})

test("standard contains the expected cross-project learning requirements without adding an owner approval gate", () => {
  const combined = LEARNING_DEBRIEF_REQUIREMENTS.join("\n")

  assert.match(combined, /database/)
  assert.match(combined, /API/)
  assert.match(combined, /security/)
  assert.match(combined, /tests\/checks/)
  assert.match(combined, /3-5 short knowledge-check questions/)
  assert.match(combined, /not required for approval, merge, deployment, or phase closure/)
  assert.match(combined, /must never block autonomous implementation, review, hardening, merge, deployment, or phase closure/)
  assert.doesNotMatch(combined, /not considered ready for owner approval/i)
})

test("rejects an empty base prompt", () => {
  assert.throws(
    () => appendLearningDebriefRequirements("   "),
    /non-empty base Codex prompt/
  )
})

test("enforces a deterministic final learning-prompt size bound", () => {
  const normal = appendLearningDebriefRequirements("B".repeat(100))
  assert.ok(normal.length <= MAX_CODEX_LEARNING_PROMPT_CHARS)

  assert.throws(
    () => appendLearningDebriefRequirements("X".repeat(MAX_CODEX_LEARNING_PROMPT_CHARS)),
    new RegExp(`${MAX_CODEX_LEARNING_PROMPT_CHARS}-character learning prompt bound`)
  )
})
