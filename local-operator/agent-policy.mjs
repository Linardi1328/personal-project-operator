export const AgentActionRisk = Object.freeze({
  READ: "read",
  PROPOSE: "propose",
  MUTATE: "mutate",
  RESTRICTED: "restricted",
});

export function evaluateAgentAction({ risk, approved = false }) {
  if (!Object.values(AgentActionRisk).includes(risk)) {
    return { allowed: false, reason: "unknown-risk" };
  }

  if (risk === AgentActionRisk.RESTRICTED) {
    return { allowed: false, reason: "restricted-action" };
  }

  if (risk === AgentActionRisk.MUTATE && !approved) {
    return { allowed: false, reason: "explicit-approval-required" };
  }

  return { allowed: true, reason: risk === AgentActionRisk.MUTATE ? "approved" : "safe-by-policy" };
}

export function assertAgentActionAllowed(action) {
  const decision = evaluateAgentAction(action);
  if (!decision.allowed) {
    throw new Error(`Agent action blocked: ${decision.reason}`);
  }
  return decision;
}
