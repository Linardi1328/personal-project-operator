# Task Size Rules

Use these rules for `/codex-budget`, `/prompt-size`, and `/split-task`.

## Small

- docs update
- one small bugfix
- one isolated component
- no major tests

Recommended when:

- Codex usage is near-limit
- task can be completed in one focused pass
- scope is clear

## Medium

- multiple files
- normal feature
- tests required
- one app area

Recommended when:

- Codex usage is available
- the feature has a clear boundary
- tests are known

## Large

- architecture changes
- backend + frontend
- database changes
- multiple integrations
- broad refactor

Recommended action:

- split before Codex when possible
- define phases and tests
- prepare hardening and review prompts

## Too large

- unclear scope
- multiple unrelated features
- requires splitting before Codex

Required action:

- use `/split-task <task>`
- create one prompt per phase
- delay implementation until the first phase is clear

