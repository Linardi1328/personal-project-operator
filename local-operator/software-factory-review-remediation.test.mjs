import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  resolveSoftwareFactoryImplementationCapability
} from "./development-continue-orchestrator.mjs"
import {
  buildAntigravityImplementationPrompt
} from "./software-factory-antigravity-execution.mjs"
import {
  HARDENING_ORCHESTRATOR_ID
} from "./development-hardening-orchestrator.mjs"
import {
  INDEPENDENT_REVIEW_AGENT_ID,
  REVIEW_DECISIONS,
  REVIEW_FINDINGS_EVIDENCE_OUTCOME
} from "./development-review-agent.mjs"

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }

  return JSON.stringify(value)
}

function findingHash({ reviewedSha, blockers, securityFindings, testsRequired }) {
  return createHash("sha256").update(stableStringify({
    reviewedSha,
    decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
    blockers,
    securityFindings,
    testsRequired
  })).digest("hex")
}

function makeReviewRemediationRun() {
  const headSha = "a".repeat(40)
  const blockers = ["Fix the stale authorization binding before execution."]
  const securityFindings = ["Revalidate authority at the dispatch boundary."]
  const testsRequired = ["Add regression coverage for stale authorization refusal."]
  const hash = findingHash({
    reviewedSha: headSha,
    blockers,
    securityFindings,
    testsRequired
  })
  const decision = {
    kind: "review",
    sha: headSha,
    source: INDEPENDENT_REVIEW_AGENT_ID,
    summary: "RAW REVIEWER TRANSCRIPT MUST NOT ENTER THE IMPLEMENTATION PROMPT.",
    metadata: {
      reviewer: INDEPENDENT_REVIEW_AGENT_ID,
      outcome: "changes_requested",
      decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
      reviewedSha: headSha,
      attempt: 2,
      mergeAllowed: false,
      blockers: blockers.length,
      securityFindings: securityFindings.length,
      testsRequired: testsRequired.length
    }
  }
  const findings = {
    kind: "review",
    sha: headSha,
    source: INDEPENDENT_REVIEW_AGENT_ID,
    summary: "UNTRUSTED FREEFORM REVIEW SUMMARY MUST STAY OUT.",
    metadata: {
      reviewer: INDEPENDENT_REVIEW_AGENT_ID,
      outcome: REVIEW_FINDINGS_EVIDENCE_OUTCOME,
      decision: REVIEW_DECISIONS.CHANGES_REQUESTED,
      reviewedSha: headSha,
      attempt: 2,
      mergeAllowed: false,
      blockers: blockers.length,
      securityFindings: securityFindings.length,
      testsRequired: testsRequired.length,
      blockerItems: blockers,
      securityItems: securityFindings,
      testItems: testsRequired,
      findingHash: hash
    }
  }
  const hardening = {
    kind: "implementation",
    sha: headSha,
    source: HARDENING_ORCHESTRATOR_ID,
    summary: "Phase 6F hardening remediation round started.",
    metadata: {
      project: "khlim-digital-ecosystem",
      orchestrator: HARDENING_ORCHESTRATOR_ID,
      round: 1,
      sourceReviewSha: headSha,
      reviewAttempt: 2,
      blockerCount: blockers.length,
      securityFindingCount: securityFindings.length,
      testRequirementCount: testsRequired.length,
      remediationHash: hash,
      outcome: "hardening_started"
    }
  }

  return {
    runId: "AAAAAAAAAAAAAAAAAAAAAA",
    version: 7,
    status: "implementation_in_progress",
    task: "Implement the approved organizer workflow.",
    headSha,
    branch: "ppo/factory-review-remediation",
    project: {
      id: "khlim-digital-ecosystem",
      fullName: "Linardi1328/khlim-digital-ecosystem"
    },
    evidence: {
      planning: [],
      implementation: [hardening],
      review: [findings, decision]
    }
  }
}

test("review-remediation marker forces the debugging capability", () => {
  const run = makeReviewRemediationRun()

  assert.equal(resolveSoftwareFactoryImplementationCapability(run), "debugging")
})

test("Antigravity review remediation receives only validated bounded findings", () => {
  const run = makeReviewRemediationRun()
  const prompt = buildAntigravityImplementationPrompt(
    run,
    {
      branch: run.branch,
      workspaceRef: "factory/review-remediation"
    },
    {
      capability: "debugging",
      modelClass: "standard",
      skills: ["debugging-and-error-recovery"]
    }
  )

  assert.match(prompt, /Trusted independent-review remediation context:/u)
  assert.match(prompt, /Fix the stale authorization binding before execution\./u)
  assert.match(prompt, /Revalidate authority at the dispatch boundary\./u)
  assert.match(prompt, /Add regression coverage for stale authorization refusal\./u)
  assert.match(prompt, /Use the installed Antigravity skill: debugging-and-error-recovery\./u)
  assert.doesNotMatch(prompt, /RAW REVIEWER TRANSCRIPT/u)
  assert.doesNotMatch(prompt, /UNTRUSTED FREEFORM REVIEW SUMMARY/u)
})
