const connectedProjects = new Map([
  [
    "khlim-assist",
    {
      id: "khlim-assist",
      displayName: "KHLIM Assist",
      owner: "Linardi1328",
      repo: "khlim-assist"
    }
  ],
  [
    "ledgerpilot-ai",
    {
      id: "ledgerpilot-ai",
      displayName: "LedgerPilot AI",
      owner: "Linardi1328",
      repo: "ledgerpilot-ai"
    }
  ],
  [
    "spy-market-agent",
    {
      id: "spy-market-agent",
      displayName: "SPY Market Agent",
      owner: "Linardi1328",
      repo: "spy-market-agent"
    }
  ],
  [
    "portfolio",
    {
      id: "portfolio",
      displayName: "Portfolio Website",
      owner: "Linardi1328",
      repo: "richie-linardi-portfolio-website"
    }
  ],
  [
    "rbl-content-engine",
    {
      id: "rbl-content-engine",
      displayName: "RBL Content Engine",
      owner: "Linardi1328",
      repo: "rbl-content-engine"
    }
  ],
  [
    "khlim-digital-ecosystem",
    {
      id: "khlim-digital-ecosystem",
      displayName: "KHLIM Super App",
      owner: "Linardi1328",
      repo: "khlim-digital-ecosystem"
    }
  ]
])

const ordinaryDevelopmentProjectIds = new Set([
  "khlim-assist",
  "ledgerpilot-ai",
  "spy-market-agent",
  "portfolio",
  "rbl-content-engine",
  "khlim-digital-ecosystem"
])

export const PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT = Object.freeze({
  id: "personal-project-operator",
  displayName: "Personal Project Operator",
  owner: "Linardi1328",
  repo: "personal-project-operator",
  fullName: "Linardi1328/personal-project-operator"
})

const blockedProjectStatuses = new Map()

function cloneProject(project) {
  return {
    ...project,
    fullName: `${project.owner}/${project.repo}`
  }
}

export function listPhase2GitHubProjects() {
  return Array.from(connectedProjects.values(), cloneProject)
}

export function getPhase2GitHubProject(projectId) {
  const project = connectedProjects.get(projectId)
  return project ? cloneProject(project) : null
}

export function listOrdinaryDevelopmentProjects() {
  return Array.from(connectedProjects.values())
    .filter((project) => ordinaryDevelopmentProjectIds.has(project.id))
    .map(cloneProject)
}

export function getOrdinaryDevelopmentProject(projectId) {
  if (!ordinaryDevelopmentProjectIds.has(projectId)) {
    return null
  }

  return getPhase2GitHubProject(projectId)
}

export function getApprovedDevelopmentProject(projectId) {
  if (projectId === PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT.id) {
    return cloneProject(PERSONAL_PROJECT_OPERATOR_SELF_DEVELOPMENT_PROJECT)
  }

  return getOrdinaryDevelopmentProject(projectId)
}

export function getBlockedPhase2GitHubProjectStatus(projectId) {
  return blockedProjectStatuses.get(projectId) || null
}
