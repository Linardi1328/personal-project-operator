# Codex Usage

## Phase 0 model

Codex usage tracking is manual-first in Phase 0.

The operator must not claim that remaining Codex tokens, credits, or usage limits can always be retrieved automatically. Availability may depend on the user's ChatGPT or Codex interface and the provider details exposed to the user.

## Expected status format

```text
Codex Usage Status
- Status: available / near-limit / limit-reached / unknown
- Last updated:
- Remaining credits/tokens if manually provided:
- Recommended task size:
- Suggested action:
```

## Status meanings

- `available`: normal Codex tasks are acceptable.
- `near-limit`: prefer small tasks, docs, reviews, or split prompts.
- `limit-reached`: avoid starting Codex implementation work.
- `unknown`: ask the user to confirm before large tasks.

## Usage-aware recommendations

If usage is `available`:

- small and medium tasks are acceptable
- large tasks should still be split if scope is broad

If usage is `near-limit`:

- prefer small bugfixes, docs, prompt cleanup, or review
- split large tasks into phases

If usage is `limit-reached`:

- delay implementation
- prepare prompts or review docs only

If usage is `unknown`:

- ask for manual status when planning large tasks
- proceed only with low-risk planning work

