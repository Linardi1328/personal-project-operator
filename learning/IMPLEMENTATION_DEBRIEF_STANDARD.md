# PPO Implementation Learning Debrief Standard

Version: `ppo.implementation-learning-debrief.v1`

## Objective

Personal Project Operator should optimize for two outcomes at the same time:

1. AI accelerates implementation with minimal routine owner supervision.
2. The project owner can request concise engineering explanations that improve understanding of major implementation decisions.

This standard applies to PPO-managed software projects and future projects that use the optional PPO learning-prompt workflow.

## Lifecycle

```text
Plan
  -> Generate implementation prompt
  -> Implement
  -> Test / validate
  -> Review actual changes
  -> Harden when required
  -> Engineering policy gates
  -> Merge / deploy / close phase when policy permits

Optional learning path:
  -> Produce Implementation Learning Debrief
  -> Owner learning / knowledge check
```

The learning path is informational. It must not become a prerequisite for autonomous implementation, review, hardening, merge, deployment, or phase closure when the engineering policy gates have passed.

## Evidence rule

The debrief must be grounded in the actual implementation, changed code, tests, project requirements, and repository evidence available to the coding/review agent.

If the evidence does not establish why a choice was made, the debrief must say that the rationale is unknown or inferred. It must not invent certainty.

## Learning output sections

### 1. Objective and completed scope

Explain what the task was intended to achieve and what was actually completed.

### 2. Major implementation changes

Summarize important code, schema, configuration, test, documentation, and workflow changes. Avoid noisy file-by-file changelogs when several files support the same decision.

### 3. Architecture and data/control flow

Explain how the changed system works from input to output and how important components interact.

### 4. Major technical decisions and purposes

For each important decision, explain:

- what was chosen;
- what problem it solves;
- why it is appropriate for this phase;
- whether it was required by an existing constraint or was one reasonable engineering choice.

Typical decisions include databases, schemas, indexes, frameworks, libraries, API boundaries, services, repositories, queues, webhooks, concurrency controls, AI provider boundaries, model/evaluation approaches, caching, deployment patterns, validation, authorization, and audit mechanisms.

### 5. Alternatives and trade-offs

Name realistic alternatives when useful and explain the trade-off. Do not claim an implementation is objectively best without evidence.

### 6. Database and data-model decisions

When applicable, explain entities, relationships, constraints, transactions, indexes, migrations, persistence boundaries, and why the chosen storage technology fits the current workload.

### 7. API, service, and integration decisions

When applicable, explain endpoint/service boundaries, external integrations, retries, idempotency, authentication/authorization, provider abstractions, and error contracts.

### 8. Security, safety, validation, and failure handling

Explain important trust boundaries, validation, permissions, safe defaults, error paths, recovery behavior, and actions that remain intentionally blocked.

### 9. Tests and checks

Explain what tests/checks were run and what important behavior each verifies. A passing command alone is not enough context for learning.

### 10. Important files to inspect

Point the owner to the smallest useful set of files, functions, classes, migrations, tests, or configuration needed to understand the implementation.

### 11. Known limitations and technical debt

State intentionally deferred work, shortcuts, edge cases, unresolved risks, and boundaries of the current phase.

### 12. Learning notes

Teach unfamiliar concepts in plain language using examples from the project. Prefer project-specific explanations over generic textbook definitions.

### 13. Optional knowledge-check questions

Ask 3-5 short questions focused on major decisions. Questions should test explanation and judgment, not memorization. Answering them is optional and must not affect engineering approval or delivery state.

Examples:

- Why was PostgreSQL preferable to a local-only SQLite database for this workflow?
- What consistency problem does the transaction boundary prevent here?
- Why is AI output validated before it can affect a deterministic business decision?
- What would happen if this webhook were processed twice, and where is idempotency enforced?

### 14. Recommended next step

Explain the next technically coherent step without silently expanding the approved phase scope.

## Debrief depth

Use proportional depth:

- Small/routine change: concise debrief.
- New dependency, schema, integration, security boundary, ML method, or architecture: deeper explanation.
- Major phase: full debrief.

Do not create long lectures for trivial changes.

## Autonomous-delivery compatibility

The learning standard is deliberately separate from delivery policy. PPO may continue through implementation, automated review, hardening, acceptance gates, merge, deployment, rollback, and project-state advancement without waiting for the owner to consume a debrief or answer knowledge-check questions, provided the relevant engineering policy authorizes those actions.

The owner may request a debrief before, during, or after delivery without changing the reviewed SHA or delivery decision.

## Knowledge map direction

Future PPO phases may maintain a cross-project owner knowledge map with concept states such as:

```text
Introduced -> Explained -> Practiced -> Demonstrated -> Comfortable
```

The map should connect repeated concepts across projects so that, for example, idempotency learned from KHLIM Assist can be reinforced when it appears in LedgerPilot AI.

The current v1 implementation does not persist proficiency claims automatically. It establishes an optional prompt/debrief contract first.

## Reasoning privacy

The standard requires engineering rationale, evidence, alternatives, trade-offs, assumptions, and conclusions. It does not require or permit disclosure of private chain-of-thought or hidden reasoning.
