#!/usr/bin/env node
import { generateCodexPrompt, formatCodexPromptError } from "./codex-prompt-generator.mjs"

export const LEARNING_DEBRIEF_VERSION = "ppo.implementation-learning-debrief.v1"

export const LEARNING_DEBRIEF_REQUIREMENTS = [
  "Implementation Learning Debrief (mandatory before phase/task closure):",
  "- After implementation and checks, produce a concise engineering debrief based on the actual changed code and repository evidence.",
  "- Explain WHAT changed, WHY it was needed, and HOW the important parts work.",
  "- For every major architecture, database, API, library, framework, algorithm, security, validation, or workflow decision, explain the purpose and practical trade-off.",
  "- Distinguish required constraints from reasonable engineering choices. Do not present one valid choice as the only possible choice.",
  "- Mention realistic alternatives considered or available, and explain why the implemented option fits this task better when evidence supports that conclusion.",
  "- Explain the data/control flow introduced or changed by the implementation.",
  "- Explain important failure modes, security/safety boundaries, assumptions, limitations, and technical debt.",
  "- Identify the tests/checks that validate the implementation and what each important check proves.",
  "- Name the most important files/functions/classes the owner should inspect to understand the work.",
  "- Add a Learning Notes section that teaches unfamiliar engineering concepts in plain language using examples from this project.",
  "- Add 3-5 short knowledge-check questions that verify the owner can explain the major implementation decisions.",
  "- Do not reveal private chain-of-thought or hidden reasoning. Provide clear decision rationales, evidence, trade-offs, and conclusions instead.",
  "- If the implementation evidence does not support a claimed rationale, say that the rationale is unknown rather than inventing one.",
  "- A task is not considered ready for owner approval until the debrief is present."
]

export function appendLearningDebriefRequirements(basePrompt) {
  const prompt = String(basePrompt ?? "").trimEnd()
  if (!prompt) {
    throw new TypeError("A non-empty base Codex prompt is required.")
  }

  return [
    prompt,
    "",
    `PPO Learning Standard: ${LEARNING_DEBRIEF_VERSION}`,
    ...LEARNING_DEBRIEF_REQUIREMENTS,
    "",
    "Learning Debrief Output Structure:",
    "1. Objective and completed scope",
    "2. Major implementation changes",
    "3. Architecture and data/control flow",
    "4. Major technical decisions and purposes",
    "5. Alternatives and trade-offs",
    "6. Database/data-model decisions (when applicable)",
    "7. API/service/integration decisions (when applicable)",
    "8. Security, safety, validation, and failure handling",
    "9. Tests/checks and what they prove",
    "10. Important files to inspect",
    "11. Known limitations and technical debt",
    "12. Learning notes: concepts the owner should understand",
    "13. Knowledge-check questions",
    "14. Recommended next step",
    "",
    "Owner-learning goal: AI may accelerate implementation, but the owner must be able to explain the system's major engineering decisions before approving the phase."
  ].join("\n")
}

export async function generateCodexLearningPrompt(projectId, taskInput, options = {}) {
  const basePrompt = await generateCodexPrompt(projectId, taskInput, options)
  return appendLearningDebriefRequirements(basePrompt)
}

async function main() {
  const [projectId, ...taskParts] = process.argv.slice(2)

  if (!projectId || taskParts.length === 0) {
    console.log([
      "Personal Project Operator - Codex Learning Prompt",
      "",
      "Usage:",
      "  node local-operator/codex-learning-prompt.mjs <project> <phase-or-task>",
      "",
      "Purpose:",
      "  Generate the normal PPO Codex implementation prompt plus a mandatory engineering learning debrief.",
      "",
      "This command does not run Codex, merge code, or perform repository writes."
    ].join("\n"))
    process.exitCode = 1
    return
  }

  try {
    console.log(await generateCodexLearningPrompt(projectId, taskParts))
  } catch (error) {
    console.error(formatCodexPromptError(error))
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
