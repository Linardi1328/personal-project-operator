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
  ]
])

const blockedProjectStatuses = new Map([
  ["rbl-content-engine", "Future project"],
  ["prooflab", "Future project"],
  ["jom-jelajah", "Paused"]
])

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

export function getBlockedPhase2GitHubProjectStatus(projectId) {
  return blockedProjectStatuses.get(projectId) || null
}
