# `/learn <project> <phase-or-task>`

## Purpose

Generate the normal PPO Codex implementation prompt with the PPO Implementation Learning Debrief standard appended as an optional learning artifact.

The goal is to make AI-assisted development transfer engineering knowledge back to the project owner without turning learning into a required supervision gate.

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

The final learning prompt has its own deterministic size bound. If the base prompt plus learning contract exceeds that bound, generation fails safely and the task must be split or compacted before retrying.

## Learning debrief

When the owner selects the learning workflow, the coding agent should produce a structured debrief covering:

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
- 3-5 optional owner knowledge-check questions;
- recommended next step.

## Non-blocking learning policy

The debrief and knowledge-check questions are learning aids only. They are not prerequisites for automated implementation, review, hardening, merge, deployment, or phase closure when the engineering policy gates have already passed.

The debrief is not a request for private chain-of-thought. It should contain concise engineering rationale, evidence, alternatives, trade-offs, and conclusions grounded in the actual implementation.

## Safety

- This command does not run Codex by itself.
- It does not merge, push, deploy, send messages, spend money, or perform production mutations.
- Repository context remains read-only through the existing PPO Codex prompt workflow.
- Unknown rationale must be reported as unknown instead of invented.
- Learning output must not create an additional mandatory owner-approval checkpoint.
