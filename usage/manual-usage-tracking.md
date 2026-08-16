# Manual Usage Tracking

## Purpose

Manual usage tracking lets the user record the current Codex or credit status without relying on unsupported automation.

## Update examples

```text
/update-usage codex available
/update-usage codex near-limit
/update-usage codex limit-reached
/update-usage credits 12.50
```

## Future local state fields

```text
provider:
status:
remaining:
last_updated:
source:
notes:
```

## Rules

- Treat manual user input as the source of truth.
- Do not scrape the Codex UI in Phase 0.
- Do not call billing APIs in Phase 0.
- Do not infer exact remaining usage if the user did not provide it.
- If status is stale, mark it as `unknown`.

## Phone workflow

The user can quickly send:

```text
/update-usage codex near-limit
/codex-budget ledgerpilot-ai add receipt upload flow
```

The operator should then recommend a smaller task or split.

