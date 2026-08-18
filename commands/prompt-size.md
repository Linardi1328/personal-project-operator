# prompt-size

## Command name

`prompt-size <draft>`

## Purpose

Review a Codex prompt draft with deterministic local measurements and safe mechanical compaction.

Phase 3B introduced the terminal command:

```bash
node local-operator/ppo-command.mjs prompt-size <draft>
```

Phase 3C routes the same deterministic text command through:

```text
/ppo prompt-size <draft>
```

Multiline drafts are preserved as one wrapper argv value when routed through `ppo_local`.

## Example input

```bash
node local-operator/ppo-command.mjs prompt-size "Goal: build the whole operator. Add GitHub integration. Add Telegram routing. Add VPS deployment. Add write actions."
```

## Expected output

The output includes:

- character count
- approximate word count
- line count
- deterministic size label: `Compact`, `Acceptable`, `Long`, or `Too broad`
- prompt sections to keep
- exact repetition or breadth to reduce
- safe deterministic compaction rules

The command does not claim exact token cost or provider billing usage.

## Safe compaction

Allowed deterministic cleanup:

- terminal-control sanitization
- leading/trailing whitespace trimming
- repeated blank-line normalization
- exact repeated adjacent line removal
- preservation of indentation, nested bullets, and repeated text under separate headings

It does not paraphrase meaning, invent requirements, fabricate file paths, or silently remove unique safety boundaries or exit criteria.

## Safety boundary

This command reviews text only. It must not invoke Codex, call OpenAI APIs, call another model, execute the draft, edit project files, deploy services, or modify OpenClaw configuration.

## Future upgrade path

- Add richer prompt-size heuristics only after separate approval.
- Keep richer arbitrary text workflows behind later review.
