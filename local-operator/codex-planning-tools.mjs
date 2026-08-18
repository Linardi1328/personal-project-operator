import {
  CodexPromptError,
  MAX_TASK_CHARS,
  estimateTaskSize,
  normalizeTaskText
} from "./codex-prompt-generator.mjs"
import {
  getBlockedPhase2GitHubProjectStatus,
  getPhase2GitHubProject,
  listPhase2GitHubProjects
} from "./github-project-registry.mjs"

export const MAX_PROMPT_DRAFT_CHARS = 8000
export const MAX_PLANNING_OUTPUT_CHARS = 6000
export const MAX_SPLIT_PHASES = 8

const COMPACTED_DRAFT_OUTPUT_CHARS = 1800

const ansiTerminalSequences = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_])/gu
const unsafeDraftControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu

const taskDomains = [
  {
    key: "documentation",
    label: "Documentation",
    patterns: [/\bdocs?\b|\bdocumentation\b|\breadme\b|\bcopy\b|\bcontent\b/u],
    goal: "Clarify the requested documentation or project-memory change.",
    boundary: "Planning only; keep docs changes separate from implementation unless explicitly requested."
  },
  {
    key: "github",
    label: "Repository integration",
    patterns: [/\bgithub\b|\brepo(?:sitory)?\b|\bpull requests?\b|\bprs?\b|\bissues?\b/u],
    goal: "Plan the repository or GitHub read-only integration work.",
    boundary: "Do not add new endpoint families or writes without separate approval."
  },
  {
    key: "telegram",
    label: "Telegram/OpenClaw routing",
    patterns: [/\btelegram\b|\bopenclaw\b|\bbot\b|\brouting\b|\bslash command\b|\bbridge\b/u],
    goal: "Plan deterministic command routing and validation.",
    boundary: "Keep arbitrary text routing behind separate review."
  },
  {
    key: "codex",
    label: "Codex prompt tooling",
    patterns: [/\bcodex\b|\bprompt\b|\bprompt generator\b|\bbudget\b|\bsplit-task\b/u],
    goal: "Plan text-only Codex prompt or planning-tool behavior.",
    boundary: "Do not invoke Codex or any model from this planning command."
  },
  {
    key: "frontend",
    label: "Frontend/UI",
    patterns: [/\bfrontend\b|\bui\b|\bux\b|\bpage\b|\bcomponent\b|\bform\b|\bdashboard\b/u],
    goal: "Plan the user-facing interface changes.",
    boundary: "Avoid inventing exact files or layouts before inspecting the target repo."
  },
  {
    key: "backend",
    label: "Backend/API",
    patterns: [/\bbackend\b|\bapi\b|\bserver\b|\bhandler\b|\bservice\b|\bworkflow\b/u],
    goal: "Plan the backend or API behavior change.",
    boundary: "Keep behavior and regression checks explicit."
  },
  {
    key: "database",
    label: "Database/schema migration",
    patterns: [/\bdatabase\b|\bschema\b|\bmigration\b|\bmigrate\b|\bsql\b|\bpersistence\b/u],
    goal: "Plan schema or persistence work as a distinct phase.",
    boundary: "Do not apply migrations or mutate data from this planning command."
  },
  {
    key: "deployment",
    label: "Deployment planning",
    patterns: [/\bvps\b|\bdeploy(?:ment)?\b|\bproduction\b|\bhosting\b|\brelease\b/u],
    goal: "Plan deployment or production-readiness work.",
    boundary: "Planning only; this command does not deploy."
  },
  {
    key: "write-actions",
    label: "Permission-gated write-action design",
    patterns: [/\bwrite actions?\b|\bmutations?\b|\bmerge\b|\bpush\b|\bcreate issue\b|\bexternal write\b|\bcreate pr\b|\bcommit\b/u],
    goal: "Define the write-action boundary and approval requirement.",
    boundary: "Implementation requires separate explicit approval and is outside current PPO write permissions."
  },
  {
    key: "hardening",
    label: "Tests/hardening/security",
    patterns: [/\btests?\b|\btesting\b|\bharden(?:ing)?\b|\bsecurity\b|\babuse\b|\bmalformed\b|\berror handling\b|\bleak(?:age)?\b|\bsecret\b|\bregression\b/u],
    goal: "Plan regression, malformed-input, and safe-error coverage.",
    boundary: "Keep hardening focused on the requested behavior."
  }
]

export class CodexPlanningError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "CodexPlanningError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function sanitizeDraftText(value) {
  return String(value ?? "")
    .replace(ansiTerminalSequences, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(unsafeDraftControls, "")
}

function safeInline(value, limit = 120) {
  const compact = sanitizeDraftText(value).replace(/\s+/gu, " ").trim()

  if (compact.length <= limit) {
    return compact
  }

  return `${compact.slice(0, limit - 3).trim()}...`
}

function projectLabel(projectId) {
  return safeInline(projectId || "(missing)") || "(missing)"
}

function resolvePlanningProject(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new CodexPlanningError(
      "INVALID_PROJECT",
      "Project id is required. Use one of: khlim-assist, ledgerpilot-ai, spy-market-agent, portfolio."
    )
  }

  const normalizedProjectId = projectId.trim()
  const project = getPhase2GitHubProject(normalizedProjectId)

  if (project) {
    return project
  }

  const blockedStatus = getBlockedPhase2GitHubProjectStatus(normalizedProjectId)

  if (blockedStatus) {
    throw new CodexPlanningError(
      "PROJECT_NOT_CONNECTED",
      `Project "${projectLabel(normalizedProjectId)}" is ${blockedStatus} and is not connected for Phase 3B planning.`
    )
  }

  throw new CodexPlanningError(
    "UNKNOWN_PROJECT",
    `Project "${projectLabel(projectId)}" is not in the connected project allowlist.`
  )
}

function normalizePlanningTaskText(taskInput) {
  try {
    return normalizeTaskText(taskInput)
  } catch (error) {
    if (error instanceof CodexPromptError && error.code === "INVALID_TASK") {
      throw new CodexPlanningError(
        "INVALID_TASK",
        "Task text is required for this Phase 3B planning command."
      )
    }

    if (error instanceof CodexPromptError && error.code === "TASK_TOO_LARGE") {
      throw new CodexPlanningError(
        "TASK_TOO_LARGE",
        `Task text is too long for Phase 3B. Keep it at ${MAX_TASK_CHARS} characters or fewer.`
      )
    }

    throw error
  }
}

export function normalizePromptDraftText(draftInput) {
  const rawDraft = Array.isArray(draftInput)
    ? draftInput.map((part) => String(part)).join(" ")
    : String(draftInput ?? "")

  const sanitizedDraft = sanitizeDraftText(rawDraft)
  const trimmedDraft = sanitizedDraft.trim()

  if (trimmedDraft.length > MAX_PROMPT_DRAFT_CHARS) {
    throw new CodexPlanningError(
      "DRAFT_TOO_LARGE",
      `Prompt draft is too long for Phase 3B. Keep it at ${MAX_PROMPT_DRAFT_CHARS} characters or fewer.`
    )
  }

  const draft = trimmedDraft
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim()

  if (!draft) {
    throw new CodexPlanningError(
      "INVALID_DRAFT",
      "Prompt draft text is required. Use: prompt-size <draft>."
    )
  }

  return draft
}

function countWords(text) {
  return text.trim().match(/\S+/gu)?.length || 0
}

export function detectTaskDomains(taskText) {
  const task = String(taskText || "").toLowerCase()

  return taskDomains
    .filter((domain) => domain.patterns.some((pattern) => pattern.test(task)))
    .map((domain) => ({
      key: domain.key,
      label: domain.label,
      goal: domain.goal,
      boundary: domain.boundary
    }))
}

function detectedDomainKeys(taskText) {
  return detectTaskDomains(taskText).map((domain) => domain.key)
}

function suggestedBudgetAction(estimate) {
  if (estimate.label === "Small") {
    return "One focused implementation or review cycle."
  }

  if (estimate.label === "Medium") {
    return "Keep one bounded implementation phase plus tests and review."
  }

  if (estimate.label === "Large") {
    return "Consider splitting implementation from hardening and review."
  }

  return "Run split-task before implementation."
}

function boundPlanningOutput(output) {
  if (output.length <= MAX_PLANNING_OUTPUT_CHARS) {
    return output
  }

  throw new CodexPlanningError(
    "OUTPUT_TOO_LARGE",
    "Generated planning output exceeded the Phase 3B size bound after context budgeting."
  )
}

export function createCodexBudget(projectId, taskInput) {
  const project = resolvePlanningProject(projectId)
  const task = normalizePlanningTaskText(taskInput)
  const estimate = estimateTaskSize(task)

  return boundPlanningOutput([
    "Codex Budget Estimate",
    "",
    "Project:",
    project.displayName,
    "",
    "Repository:",
    `${project.owner}/${project.repo}`,
    "",
    "Task:",
    task,
    "",
    "Estimate:",
    estimate.label,
    "",
    "Reason:",
    estimate.reason,
    "",
    "Evidence Boundary:",
    "- Deterministic heuristic only.",
    "- Does not inspect arbitrary repository files.",
    "- Does not estimate actual token cost.",
    "- Does not inspect Codex account usage.",
    "",
    "Suggested Action:",
    suggestedBudgetAction(estimate)
  ].join("\n"))
}

function classifyPromptSize(draft) {
  const characters = draft.length
  const words = countWords(draft)
  const lines = draft.split("\n").length
  const domainCount = detectedDomainKeys(draft).length
  const broadLanguage = /\bwhole\b|\beverything\b|\ball phases\b|\bend-to-end\b|\bunrelated\b/u.test(draft.toLowerCase())

  if (characters > 6000 || domainCount >= 4 || (broadLanguage && domainCount >= 3)) {
    return "Too broad"
  }

  if (characters > 3000 || words > 500 || lines > 60 || domainCount >= 3) {
    return "Long"
  }

  if (characters <= 800 && words <= 140 && lines <= 12 && domainCount <= 1) {
    return "Compact"
  }

  return "Acceptable"
}

function promptSectionFindings(draft) {
  const checks = [
    ["current goal", /\bgoal\b/u],
    ["exact scope", /\bscope\b/u],
    ["requirements", /\brequirements?\b/u],
    ["tests/checks", /\btests?\b|\bchecks?\b/u],
    ["safety boundaries", /\bsafety\b|\bboundaries?\b/u],
    ["exit criteria", /\bexit criteria\b|\bdone when\b/u]
  ]
  const lowerDraft = draft.toLowerCase()
  const present = checks.filter(([, pattern]) => pattern.test(lowerDraft)).map(([label]) => label)

  return present.length > 0
    ? present
    : ["current goal", "exact scope", "requirements", "tests/checks", "safety boundaries", "exit criteria"]
}

function compactPromptDraft(draft) {
  const lines = draft.split("\n")
  const compacted = []
  const seenBullets = new Set()
  let adjacentDuplicates = 0
  let duplicateBullets = 0
  let blankLinesReduced = 0
  let previousWasBlank = false

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (!trimmedLine) {
      if (previousWasBlank) {
        blankLinesReduced += 1
        continue
      }

      compacted.push("")
      previousWasBlank = true
      continue
    }

    previousWasBlank = false

    if (compacted.at(-1)?.trim() === trimmedLine) {
      adjacentDuplicates += 1
      continue
    }

    if (/^[-*]\s+/u.test(trimmedLine)) {
      const bulletKey = trimmedLine.replace(/^[-*]\s+/u, "- ")

      if (seenBullets.has(bulletKey)) {
        duplicateBullets += 1
        continue
      }

      seenBullets.add(bulletKey)
    }

    compacted.push(line.trimEnd())
  }

  const compactedDraft = compacted.join("\n").trim()

  return {
    compactedDraft,
    changed: compactedDraft !== draft,
    adjacentDuplicates,
    duplicateBullets,
    blankLinesReduced
  }
}

function removeReduceLines(compaction, draft) {
  const lines = []

  if (compaction.adjacentDuplicates > 0) {
    lines.push("- repeated adjacent lines")
  }

  if (compaction.duplicateBullets > 0) {
    lines.push("- exact duplicate bullets")
  }

  if (compaction.blankLinesReduced > 0) {
    lines.push("- repeated blank lines")
  }

  if (detectedDomainKeys(draft).length >= 3) {
    lines.push("- unrelated future phases or major-system breadth")
  }

  return lines.length > 0 ? lines : ["- none obvious from deterministic checks"]
}

function compactedDraftLines(compaction) {
  if (!compaction.changed) {
    return ["No deterministic compaction needed."]
  }

  if (compaction.compactedDraft.length > COMPACTED_DRAFT_OUTPUT_CHARS) {
    return [
      "Deterministic cleanup removed exact repetition, but the compacted draft remains too long to include fully without truncating unique content."
    ]
  }

  return compaction.compactedDraft.split("\n")
}

export function reviewPromptSize(draftInput) {
  const draft = normalizePromptDraftText(draftInput)
  const compaction = compactPromptDraft(draft)
  const lines = draft.split("\n")
  const output = [
    "Prompt Size Review",
    "",
    "Characters:",
    String(draft.length),
    "",
    "Approx. words:",
    String(countWords(draft)),
    "",
    "Lines:",
    String(lines.length),
    "",
    "Estimate:",
    classifyPromptSize(draft),
    "",
    "Keep:",
    ...promptSectionFindings(draft).map((item) => `- ${item}`),
    "",
    "Remove / Reduce:",
    ...removeReduceLines(compaction, draft),
    "",
    "Suggested Action:",
    classifyPromptSize(draft) === "Too broad"
      ? "Split the draft by current goal before implementation."
      : "Keep the current goal, exact scope, requirements, tests/checks, safety boundaries, and exit criteria.",
    "",
    "Compaction Rules:",
    "- Sanitized terminal controls.",
    "- Trimmed leading and trailing whitespace.",
    "- Normalized repeated blank lines.",
    "- Removed exact repeated adjacent lines and exact duplicate bullets only.",
    "- Did not paraphrase or invent requirements.",
    "",
    "Compacted Draft:",
    ...compactedDraftLines(compaction)
  ].join("\n")

  return boundPlanningOutput(output)
}

function chooseSplitDomains(task, estimate, domains) {
  if (domains.length === 0) {
    return [
      {
        key: "implementation",
        label: "Implementation planning",
        goal: "Plan the requested change as one focused phase.",
        boundary: "Inspect the target repo before naming exact files or architecture."
      }
    ]
  }

  const includeCrossCutting = estimate.label === "Large" || estimate.label === "Too large - split required"
  const needsReview = includeCrossCutting
  const hardeningDomain = domains.find((domain) => domain.key === "hardening")
  const writeDomain = domains.find((domain) => domain.key === "write-actions")
  const nonHardeningDomains = domains.filter((domain) => domain.key !== "hardening")
  const reserve = (needsReview ? 1 : 0) + (includeCrossCutting && !hardeningDomain ? 1 : 0)
  const maxDomainPhases = Math.max(1, MAX_SPLIT_PHASES - reserve)
  const chosen = nonHardeningDomains.slice(0, maxDomainPhases)

  if (writeDomain && !chosen.some((domain) => domain.key === writeDomain.key)) {
    chosen.splice(Math.max(0, chosen.length - 1), 1, writeDomain)
  }

  if (hardeningDomain) {
    if (chosen.length < MAX_SPLIT_PHASES - (needsReview ? 1 : 0)) {
      chosen.push(hardeningDomain)
    }
  } else if (includeCrossCutting) {
    chosen.push({
      key: "hardening",
      label: "Hardening",
      goal: "Add regression, abuse-case, and safe-error checks.",
      boundary: "Do not expand scope beyond the approved behavior."
    })
  }

  if (needsReview && chosen.length < MAX_SPLIT_PHASES) {
    chosen.push({
      key: "review",
      label: "Review",
      goal: "Verify scope, tests, and safety boundaries before handoff.",
      boundary: "Leave implementation approval and merges to owner review."
    })
  }

  return chosen.slice(0, MAX_SPLIT_PHASES)
}

function formatSplitPhases(phases) {
  return phases.flatMap((phase, index) => [
    `${index + 1}. ${phase.label}`,
    `   Goal: ${phase.goal}`,
    `   Boundary: ${phase.boundary}`
  ])
}

export function splitTask(taskInput) {
  const task = normalizePlanningTaskText(taskInput)
  const estimate = estimateTaskSize(task)
  const domains = detectTaskDomains(task)

  if (estimate.label === "Small") {
    return boundPlanningOutput([
      "Task Split",
      "",
      "Original Task:",
      task,
      "",
      "Estimate:",
      estimate.label,
      "",
      "Split:",
      "Split not required.",
      "",
      "Suggested Workflow:",
      "1. Implementation",
      "2. Tests/Hardening",
      "3. Review"
    ].join("\n"))
  }

  if (estimate.label === "Medium") {
    return boundPlanningOutput([
      "Task Split",
      "",
      "Original Task:",
      task,
      "",
      "Estimate:",
      estimate.label,
      "",
      "Split:",
      "Optional for this task.",
      "",
      "Suggested Workflow:",
      "1. Focused implementation",
      "2. Tests/Hardening",
      "3. Review"
    ].join("\n"))
  }

  const phases = chooseSplitDomains(task, estimate, domains)
  const outputLines = [
    "Task Split",
    "",
    "Original Task:",
    task,
    "",
    "Estimate:",
    estimate.label,
    ""
  ]

  if (estimate.label === "Too large - split required") {
    outputLines.push("Suggested Action:", "Split before implementation.", "")
  }

  outputLines.push(
    "Recommended Split:",
    "",
    ...formatSplitPhases(phases),
    "",
    "Safety:",
    "- Planning only.",
    "- This output is not approval to mutate external systems.",
    "- Separate explicit approval is required for writes, deployment, or production changes."
  )

  return boundPlanningOutput(outputLines.join("\n"))
}

export function formatCodexPlanningError(error) {
  if (error instanceof CodexPlanningError) {
    return `Codex planning failed [${error.code}]: ${error.safeMessage}`
  }

  return [
    "Codex planning failed:",
    "Unexpected local failure."
  ].join("\n")
}

function handlePlanningOutput(factory) {
  try {
    return {
      ok: true,
      output: factory()
    }
  } catch (error) {
    return {
      ok: false,
      output: formatCodexPlanningError(error)
    }
  }
}

export function handleCodexBudgetCommand(projectId, taskInput) {
  return handlePlanningOutput(() => createCodexBudget(projectId, taskInput))
}

export function handlePromptSizeCommand(draftInput) {
  return handlePlanningOutput(() => reviewPromptSize(draftInput))
}

export function handleSplitTaskCommand(taskInput) {
  return handlePlanningOutput(() => splitTask(taskInput))
}

export function listPlanningProjectIds() {
  return listPhase2GitHubProjects().map((project) => project.id)
}
