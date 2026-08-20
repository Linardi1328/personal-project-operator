# `/learn <project> <phase-or-task>`

## Purpose

Generate the normal PPO Codex implementation prompt with the mandatory PPO Implementation Learning Debrief standard appended.

The goal is to make AI-assisted development transfer engineering knowledge back to the project owner instead of only producing code.

## Current implementation

Local CLI:

```bash
node local-operator/codex-learning-prompt.mjs <project> <phase-or-task>
```

Example:

```bash
node local-operator/codex-learning-prompt.mjs ledgerpilot-ai "add controlled review comments"
```

The command reuses the existing PPO Codex prompt generator, so supported project IDs and GitHub read-only context follow the existing Codex workflow.

## Required debrief

After implementation and checks, the coding agent must produce a structured debrief covering:

- objective and completed scope;
- major implementation changes;
- architecture and data/control flow;
- major technical decisions and their purpose;
- alternatives and trade-offs;
- database/data-model choices when applicable;
- API/service/integration choices when applicable;
- security, safety, validation, and failure handling;
- tests/checks and what they prove;
- important files to inspect;
- known limitations and technical debt;
- learning notes for unfamiliar concepts;
- 3-5 owner knowledge-check questions;
- recommended next step.

## Owner-learning gate

A task should not be treated as ready for owner approval until the implementation debrief exists.

The debrief is not a request for private chain-of-thought. It should contain concise engineering rationale, evidence, alternatives, trade-offs, and conclusions grounded in the actual implementation.

## Safety

- This command does not run Codex by itself.
- It does not merge, push, deploy, send messages, spend money, or perform production mutations.
- Repository context remains read-only through the existing PPO Codex prompt workflow.
- Unknown rationale must be reported as unknown instead of invented.
