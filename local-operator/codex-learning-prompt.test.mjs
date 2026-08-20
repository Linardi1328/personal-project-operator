import assert from "node:assert/strict"
import test from "node:test"

import {
  LEARNING_DEBRIEF_REQUIREMENTS,
  LEARNING_DEBRIEF_VERSION,
  appendLearningDebriefRequirements
} from "./codex-learning-prompt.mjs"

test("appends the mandatory PPO learning debrief to a base prompt", () => {
  const output = appendLearningDebriefRequirements("Codex Prompt\n\nTask:\nImplement feature X")

  assert.match(output, /Codex Prompt/)
  assert.match(output, new RegExp(LEARNING_DEBRIEF_VERSION.replaceAll(".", "\\.")))
  assert.match(output, /Major technical decisions and purposes/)
  assert.match(output, /Alternatives and trade-offs/)
  assert.match(output, /Knowledge-check questions/)
  assert.match(output, /owner must be able to explain/i)
})

test("keeps the standard focused on rationale rather than hidden chain-of-thought", () => {
  const output = appendLearningDebriefRequirements("Base prompt")

  assert.match(output, /Do not reveal private chain-of-thought or hidden reasoning/)
  assert.match(output, /decision rationales, evidence, trade-offs, and conclusions/)
})

test("standard contains the expected cross-project learning requirements", () => {
  const combined = LEARNING_DEBRIEF_REQUIREMENTS.join("\n")

  assert.match(combined, /database/)
  assert.match(combined, /API/)
  assert.match(combined, /security/)
  assert.match(combined, /tests\/checks/)
  assert.match(combined, /3-5 short knowledge-check questions/)
  assert.match(combined, /not considered ready for owner approval/)
})

test("rejects an empty base prompt", () => {
  assert.throws(
    () => appendLearningDebriefRequirements("   "),
    /non-empty base Codex prompt/
  )
})
