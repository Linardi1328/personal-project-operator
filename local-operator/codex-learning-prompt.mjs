#!/usr/bin/env node
import { generateCodexPrompt, formatCodexPromptError } from "./codex-prompt-generator.mjs"

export const LEARNING_DEBRIEF_VERSION = "ppo.implementation-learning-debrief.v1"
export const MAX_CODEX_LEARNING_PROMPT_CHARS = 10000

export const LEARNING_DEBRIEF_REQUIREMENTS = [
  "Implementation Learning Debrief (optional learning artifact; never a delivery gate):",
  "- After implementation and checks, produce a concise engineering debrief based on the actual changed code and repository evidence when the owner requests learning output or the learning workflow is selected.",
  "- Explain WHAT changed, WHY it was needed, and HOW the important parts work.",
  "- For every major architecture, database, API, library, framework, algorithm, security, validation, or workflow decision, explain the purpose and practical trade-off.",
  "- Distinguish required constraints from reasonable engineering choices. Do not present one valid choice as the only possible choice.",
  "- Mention realistic alternatives considered or available, and explain why the implemented option fits this task better when evidence supports that conclusion.",
  "- Explain the data/control flow introduced or changed by the implementation.",
  "- Explain important failure modes, security/safety boundaries, assumptions, limitations, and technical debt.",
  "- Identify the tests/checks that validate the implementation and what each important check proves.",
  "- Name the most important files/functions/classes the owner should inspect to understand the work.",
  "- Add a Learning Notes section that teaches unfamiliar engineering concepts in plain language using examples from this project.",
  "- Add 3-5 short knowledge-check questions for optional owner self-check; answering them is not required for approval, merge, deployment, or phase closure.",
  "- Do not reveal private chain-of-thought or hidden reasoning. Provide clear decision rationales, evidence, trade-offs, and conclusions instead.",
  "- If the implementation evidence does not support a claimed rationale, say that the rationale is unknown rather than inventing one.",
  "- The learning artifact must never block autonomous implementation, review, hardening, merge, deployment, or phase closure when the engineering policy gates have passed."
]

export function appendLearningDebriefRequirements(basePrompt) {
  const prompt = String(basePrompt ?? "").trimEnd()
  if (!prompt) {
    throw new TypeError("A non-empty base Codex prompt is required.")
  }

  const output = [
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
    "13. Optional knowledge-check questions",
    "14. Recommended next step",
    "",
    "Owner-learning goal: preserve engineering understanding without turning learning into a required supervision gate."
  ].join("\n")

  if (output.length > MAX_CODEX_LEARNING_PROMPT_CHARS) {
    throw new RangeError(
      `Codex learning prompt exceeds the ${MAX_CODEX_LEARNING_PROMPT_CHARS}-character learning prompt bound. Split or compact the task before retrying.`
    )
  }

  return output
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
      "  Generate the normal PPO Codex implementation prompt plus an optional engineering learning debrief.",
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
