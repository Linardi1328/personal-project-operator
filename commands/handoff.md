# /handoff

## Command name

`/handoff <project>`

## Purpose

Create a compact handoff summary for ChatGPT or Codex.

## Input format

```text
/handoff <project>
```

## Example input

```text
/handoff spy-market-agent
```

## Expected output

The handoff must include:

- project purpose
- current phase
- active repo
- last approved state
- next action
- do-not-change constraints
- known risks

Example:

```text
Handoff: SPY Market Agent
- Purpose: SPY market research and trading-system project.
- Current phase: documentation/read-only planning.
- Active repo: Linardi1328/spy-market-agent.
- Last approved state: Phase 0 docs only.
- Next action: prepare read-only repo summary.
- Do not change: no trading execution, no brokerage integration.
- Known risks: financial automation must remain non-executing.
```

## Safety boundary

The command produces a text handoff only. It must not modify project state. Phase 5C note append is a separate terminal-only command and does not update handoff output or project memory docs.

## Future upgrade path

- Include recent read-only GitHub state.
- Include latest Codex prompt and result summary.
- Export to project memory docs after approval.
