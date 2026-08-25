import { readFile } from "node:fs/promises"
import {
  GITHUB_READONLY_SOURCE,
  GitHubReadOnlyError,
  createGitHubReadOnlyClient,
  resolveProject,
  sanitizeGitHubText
} from "./github-readonly.mjs"

export const MAX_TASK_CHARS = 1000
export const MAX_GENERATED_PROMPT_CHARS = 6000

const PROMPT_COMMIT_LIMIT = 1
const PROMPT_PR_LIMIT = 5
const PROMPT_ISSUE_LIMIT = 5
const TEXT_FIELD_LIMIT = 180
const TASK_SCOPE_REPEAT_LIMIT = 240

const projectDocumentUrls = new Map([
  ["khlim-assist", new URL("../projects/khlim-assist.md", import.meta.url)],
  ["ledgerpilot-ai", new URL("../projects/ledgerpilot-ai.md", import.meta.url)],
  ["spy-market-agent", new URL("../projects/spy-market-agent.md", import.meta.url)],
  ["portfolio", new URL("../projects/portfolio.md", import.meta.url)],
  ["rbl-content-engine", new URL("../projects/rbl-content-engine.md", import.meta.url)],
  ["khlim-digital-ecosystem", new URL("../projects/khlim-digital-ecosystem.md", import.meta.url)]
])

const projectContextFields = [
  ["connection status", "Documentation status"],
  ["current role", "Current role"],
  ["openclaw priority", "OpenClaw priority"],
  ["current phase", "Current phase"],
  ["next action", "Next action"],
  ["codex fit", "Codex fit"],
  ["do not change", "Safety note"],
  ["known risks", "Risk note"]
]

export class CodexPromptError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage)
    this.name = "CodexPromptError"
    this.code = code
    this.safeMessage = safeMessage
  }
}

function collapseWhitespace(value) {
  return sanitizeGitHubText(String(value)).replace(/\s+/g, " ").trim()
}

function clipText(value, limit = TEXT_FIELD_LIMIT) {
  const compact = collapseWhitespace(value)

  if (compact.length <= limit) {
    return compact
  }

  return `${compact.slice(0, limit - 3).trim()}...`
}

function valueOrFallback(value) {
  return value || "n/a"
}

export function normalizeTaskText(taskInput) {
  const rawTask = Array.isArray(taskInput)
    ? taskInput.map((part) => String(part)).join(" ")
    : String(taskInput ?? "")
  const task = collapseWhitespace(rawTask)

  if (!task) {
    throw new CodexPromptError(
      "INVALID_TASK",
      "Task text is required. Use: codex <project> <phase-or-task>."
    )
  }

  if (task.length > MAX_TASK_CHARS) {
    throw new CodexPromptError(
      "TASK_TOO_LARGE",
      `Task text is too long for Phase 3A. Keep it at ${MAX_TASK_CHARS} characters or fewer.`
    )
  }

  return task
}

function normalizeHeading(value) {
  return collapseWhitespace(value).toLowerCase()
}

function parseMarkdownSections(markdown) {
  const sections = new Map()
  let activeHeading = null
  let activeLines = []

  for (const line of String(markdown || "").split(/\r?\n/)) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/)

    if (headingMatch) {
      if (activeHeading) {
        sections.set(activeHeading, activeLines.join("\n"))
      }

      activeHeading = normalizeHeading(headingMatch[1])
      activeLines = []
      continue
    }

    if (activeHeading) {
      activeLines.push(line)
    }
  }

  if (activeHeading) {
    sections.set(activeHeading, activeLines.join("\n"))
  }

  return sections
}

function sectionFirstLine(sectionText) {
  const lines = String(sectionText || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)

  return lines[0] ? clipText(lines[0]) : null
}

function fallbackDocExcerpt(markdown) {
  const excerpt = String(markdown || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 3)
    .join(" ")

  return excerpt ? [`Documentation excerpt: ${clipText(excerpt, 240)}`] : []
}

export function extractProjectDocContext(markdown) {
  const sections = parseMarkdownSections(markdown)
  const bullets = []

  for (const [heading, label] of projectContextFields) {
    if (!sections.has(heading)) {
      continue
    }

    const value = sectionFirstLine(sections.get(heading))

    if (value) {
      bullets.push(`${label}: ${value}`)
    }
  }

  return bullets.length > 0 ? bullets.slice(0, 7) : fallbackDocExcerpt(markdown)
}

function countLabel(items, limit) {
  if (items.length === 0) {
    return "none"
  }

  if (items.length >= limit) {
    return `${limit}+`
  }

  return String(items.length)
}

function issueCountLabel(openIssuesPage) {
  const issues = Array.isArray(openIssuesPage)
    ? openIssuesPage
    : openIssuesPage?.issues || []
  const limitHit = !Array.isArray(openIssuesPage) && Boolean(openIssuesPage?.limitHit)

  if (limitHit) {
    return issues.length === 0 ? "unknown (page limit hit)" : `${issues.length}+`
  }

  return countLabel(issues, PROMPT_ISSUE_LIMIT)
}

function latestCommitLabel(recentCommits) {
  const latestCommit = recentCommits[0]

  if (!latestCommit) {
    return "none returned"
  }

  const ref = latestCommit.shortSha || (latestCommit.sha ? latestCommit.sha.slice(0, 7) : "unknown")
  const message = clipText(valueOrFallback(latestCommit.message))

  return `${clipText(ref, 40)} ${message}`
}

function liveRepoContextLines(project, liveContext) {
  const repository = liveContext.repository || {}

  return [
    `Repo: ${clipText(repository.fullName || project.fullName)}`,
    `Default branch: ${clipText(valueOrFallback(repository.defaultBranch))}`,
    `Latest commit: ${latestCommitLabel(liveContext.recentCommits || [])}`,
    `Open PRs: ${countLabel(liveContext.openPullRequests || [], PROMPT_PR_LIMIT)}`,
    `Open issues: ${issueCountLabel(liveContext.openIssuesPage)}`,
    `Updated: ${clipText(valueOrFallback(repository.updatedAt))}`
  ]
}

function matchedSignals(task, patterns) {
  return patterns.filter((pattern) => pattern.test(task)).length
}

export function estimateTaskSize(taskText) {
  const task = taskText.toLowerCase()
  const majorDomainPatterns = [
    /\bgithub\b|\brepo\b|\bpull request\b|\bissues?\b/u,
    /\btelegram\b|\bopenclaw\b|\bbot\b|\brouting\b/u,
    /\bvps\b|\bdeploy(?:ment)?\b|\bproduction\b/u,
    /\bwrite actions?\b|\bmutat(?:e|ion)\b|\bcommit\b|\bpush\b|\bmerge\b/u,
    /\bdatabase\b|\bschema\b|\bmigration\b/u,
    /\bfrontend\b|\bbackend\b/u
  ]
  const majorDomainCount = matchedSignals(task, majorDomainPatterns)

  if (
    majorDomainCount >= 3 ||
    /\ball phases\b|\bmultiple unrelated\b|\beverything\b|\bend-to-end\b.*\bdeploy\b/u.test(task)
  ) {
    return {
      label: "Too large - split required",
      reason: "Combines multiple major systems or phases.",
      suggestedAction: "split before implementation"
    }
  }

  if (
    /\barchitecture\b|\barchitectural\b|\bmigration\b|\bmigrate\b|\bbroad refactor\b|\brefactor\b|\bdatabase\b|\bschema\b|\bmulti[- ]component\b|\bmultiple components\b|\bintegration\b|\bdeploy(?:ment)?\b|\bvps\b/u.test(task) ||
    (/\bfrontend\b/u.test(task) && /\bbackend\b/u.test(task))
  ) {
    return {
      label: "Large",
      reason: "Likely touches architecture, integration, deployment, or multiple components."
    }
  }

  if (
    /\bdocs?\b|\bdocumentation\b|\breadme\b|\bcopy\b|\btypo\b/u.test(task) ||
    (/\btests?\b|\btesting\b|\bvalidation\b|\bbugfix\b|\bfix\b|\berror handling\b|\bharden(?:ing)?\b/u.test(task) && task.length <= 180)
  ) {
    return {
      label: "Small",
      reason: "Narrow docs, validation, test, bugfix, or hardening wording."
    }
  }

  if (/\bfeature\b|\bimplement\b|\badd\b|\bbuild\b|\broute\b|\brouting\b|\bhandler\b|\bapi\b|\bui\b|\bform\b|\bworkflow\b/u.test(task)) {
    return {
      label: "Medium",
      reason: "Implementation wording with a bounded feature or workflow scope."
    }
  }

  return {
    label: "Small",
    reason: "No broad implementation signals detected."
  }
}

function isHardeningTask(taskText) {
  return /\bharden(?:ing)?\b|\bsecurity\b|\babuse\b|\bmalformed\b|\berror handling\b|\bleak(?:age)?\b|\bsecrets?\b|\bboundary tests?\b/u.test(taskText.toLowerCase())
}

function isPlanningOnlyTask(taskText, estimate) {
  if (estimate.label === "Too large - split required") {
    return true
  }

  const task = taskText.toLowerCase()
  const planning = /\b(review|inspect|analy[sz]e|assess|summarize|propose|recommend|plan|research|compare|identify|investigate)\b/u.test(task)
  const implementation = /\b(implement|add|build|create|update|fix|harden|refactor|wire|integrate|write|edit|remove|delete|migrate|deploy)\b/u.test(task)

  return planning && !implementation
}

async function defaultLoadProjectDocument(project) {
  const documentUrl = projectDocumentUrls.get(project.id)

  if (!documentUrl) {
    throw new CodexPromptError(
      "PROJECT_DOC_UNAVAILABLE",
      "Project documentation is unavailable for this project."
    )
  }

  return readFile(documentUrl, "utf8")
}

async function loadProjectDocument(project, loadProjectDocumentOption) {
  const loadDocument = loadProjectDocumentOption || defaultLoadProjectDocument

  try {
    return await loadDocument(project)
  } catch (error) {
    if (error instanceof CodexPromptError) {
      throw error
    }

    throw new CodexPromptError(
      "PROJECT_DOC_UNAVAILABLE",
      "Project documentation is unavailable for this project."
    )
  }
}

async function readLiveRepoContext(client, project) {
  const [repository, recentCommits, openPullRequests, openIssuesPage] = await Promise.all([
    client.getRepoMetadata(project.id),
    client.getRecentCommits(project.id, PROMPT_COMMIT_LIMIT),
    client.getOpenPullRequests(project.id, PROMPT_PR_LIMIT),
    client.getOpenIssuesPage(project.id, PROMPT_ISSUE_LIMIT)
  ])

  return {
    repository,
    recentCommits,
    openPullRequests,
    openIssuesPage
  }
}

function appendSection(lines, heading, entries) {
  lines.push("", `${heading}:`)
  lines.push(...entries)
}

function scopeTaskLine(task) {
  if (task.length > TASK_SCOPE_REPEAT_LIMIT) {
    return "- Exact work requested: see Task section above."
  }

  return `- Exact work requested: ${task}`
}

function buildPrompt(project, task, docContextBullets, liveContext, estimate, hardening) {
  const planningOnly = isPlanningOnlyTask(task, estimate)
  const lines = [
    "Codex Prompt",
    "",
    "Project:",
    project.displayName,
    "",
    "Repository:",
    project.fullName,
    "",
    "Task:",
    task,
    "",
    "Task Size Estimate:",
    estimate.label,
    `Reason: ${estimate.reason}`
  ]

  if (estimate.suggestedAction) {
    lines.push(`Suggested action: ${estimate.suggestedAction}.`)
  }

  appendSection(lines, "Goal", [
    estimate.label === "Too large - split required"
      ? `Plan a safe split for ${project.displayName} before implementation.`
      : planningOnly
        ? `Produce the requested analysis or proposal for ${project.displayName} without modifying the repository.`
        : `Implement the requested task for ${project.displayName}.`
  ])

  appendSection(lines, "Context", [
    "Curated project documentation (may be stale):",
    ...docContextBullets.map((line) => `- ${clipText(line)}`),
    `Live GitHub read-only facts (${GITHUB_READONLY_SOURCE}):`,
    ...liveRepoContextLines(project, liveContext).map((line) => `- ${line}`)
  ])

  appendSection(lines, "Scope", [
    scopeTaskLine(task),
    "- Inspect the target repository before naming or editing files.",
    "- Use project docs as background and live GitHub facts as current repo context.",
    planningOnly
      ? "- Keep the analysis focused on the requested task; avoid unrelated scope."
      : "- Keep changes focused on the requested task; avoid unrelated refactors."
  ])

  appendSection(lines, "Requirements", planningOnly ? [
    "- Keep this response read-only; do not edit files or create repository changes.",
    "- Propose only work supported by inspected repository evidence.",
    "- Do not fabricate missing project state, file paths, or repository details.",
    "- Document assumptions or blockers instead of expanding scope."
  ] : [
    "- Implement only the task-specific changes.",
    "- Preserve existing behavior unless the task explicitly requires a change.",
    "- Do not fabricate missing project state, file paths, or repository details.",
    "- Document assumptions or blockers instead of expanding scope."
  ])

  if (hardening) {
    appendSection(lines, "Hardening Emphasis", [
      "- Preserve regression behavior and existing security boundaries.",
      "- Cover malformed inputs, abuse cases, and safe error handling.",
      "- Check for secret, raw stderr, or environment-value leakage.",
      "- Add focused boundary tests without broadening the feature."
    ])
  }

  appendSection(lines, "Tests / Checks", planningOnly ? [
    "- Validate the proposal against inspected documentation and live repository facts.",
    "- Name the automated checks a later implementation should run when those checks are verified.",
    "- Report any repository evidence that could not be inspected.",
    "- Do not run mutation, deployment, or release commands."
  ] : [
    "- Add or update appropriate automated tests for the requested behavior.",
    "- Run relevant syntax, lint, type, or unit checks when available.",
    "- Run regression checks for affected behavior.",
    "- Report any checks that cannot run."
  ])

  appendSection(lines, "Safety Boundaries", planningOnly ? [
    "- Keep repository access read-only.",
    "- Do not create a branch, commit, pull request, or issue.",
    "- Do not merge or deploy.",
    "- Do not expose credentials.",
    "- Do not weaken existing security boundaries.",
    "- No unrelated scope expansion."
  ] : [
    "- Work on a dedicated branch.",
    "- Do not develop directly on main.",
    "- Do not merge.",
    "- Do not expose credentials.",
    "- Do not weaken existing security boundaries.",
    "- No unrelated scope expansion."
  ])

  appendSection(lines, "Exit Criteria", planningOnly ? [
    "- Requested analysis, recommendation, or split plan produced.",
    "- One bounded next task is named when the evidence supports it.",
    "- Suggested checks and relevant verified files are identified.",
    "- Assumptions and blockers are reported.",
    "- No repository changes were made."
  ] : [
    "- Requested task implemented or split plan produced.",
    "- Tests/checks pass or failures are explained.",
    "- Changed files summarized.",
    "- Assumptions/blockers reported.",
    "- Branch pushed and ready for review.",
    "- NOT merged."
  ])

  return lines.join("\n")
}

function boundPrompt(prompt) {
  if (prompt.length <= MAX_GENERATED_PROMPT_CHARS) {
    return prompt
  }

  throw new CodexPromptError(
    "PROMPT_TOO_LARGE",
    "Generated prompt exceeded the Phase 3A size bound after context budgeting. Split the task and retry."
  )
}

export async function generateCodexPrompt(projectId, taskInput, options = {}) {
  const project = resolveProject(projectId)
  const task = normalizeTaskText(taskInput)
  const projectDocument = await loadProjectDocument(project, options.loadProjectDocument)
  const docContextBullets = extractProjectDocContext(projectDocument)
  const client = options.client || createGitHubReadOnlyClient()
  const liveContext = await readLiveRepoContext(client, project)
  const estimate = estimateTaskSize(task)

  return boundPrompt(buildPrompt(
    project,
    task,
    docContextBullets,
    liveContext,
    estimate,
    isHardeningTask(task)
  ))
}

export function formatCodexPromptError(error) {
  if (error instanceof CodexPromptError || error instanceof GitHubReadOnlyError) {
    return `Codex prompt generation failed [${error.code}]: ${error.safeMessage}`
  }

  return [
    "Codex prompt generation failed:",
    "Unexpected local failure."
  ].join("\n")
}

export async function handleCodexPromptCommand(projectId, taskInput, options = {}) {
  try {
    return {
      ok: true,
      output: await generateCodexPrompt(projectId, taskInput, options)
    }
  } catch (error) {
    return {
      ok: false,
      output: formatCodexPromptError(error)
    }
  }
}
