# Example Codex Prompt Output

Phase 3A is terminal-only:

```bash
node local-operator/ppo-command.mjs codex khlim-assist "add provider validation tests"
```

Example shape:

```text
Codex Prompt

Project:
KHLIM Assist

Repository:
Linardi1328/khlim-assist

Task:
add provider validation tests

Task Size Estimate:
Small
Reason: Narrow docs, validation, test, bugfix, or hardening wording.

Goal:
Implement the requested task for KHLIM Assist.

Context:
Curated project documentation (may be stale):
- Current role: AI integration for KHLIM admin workflows.
- Current phase: Phase 0 documentation foundation.
Live GitHub read-only facts (GitHub read-only):
- Repo: Linardi1328/khlim-assist
- Default branch: main
- Latest commit: abc1234 Latest safe commit
- Open PRs: none
- Open issues: none
- Updated: 2026-08-17T00:00:00Z

Scope:
- Exact work requested: add provider validation tests
- Inspect the target repository before naming or editing files.
- Keep changes focused on the requested task.

Safety Boundaries:
- Work on a dedicated branch.
- Do not develop directly on main.
- Do not merge.
- Do not expose credentials.
- Do not weaken existing security boundaries.
- No unrelated scope expansion.
```

Do not route `/ppo codex` through Telegram/OpenClaw in Phase 3B.
