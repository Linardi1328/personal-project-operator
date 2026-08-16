# Example Codex Prompt Output

```text
/codex khlim-assist phase-1-readonly-repo-summary
```

```text
Codex Prompt

Goal:
Add a read-only repository summary command for KHLIM Assist.

Scope:
- Project: KHLIM Assist
- Repo: Linardi1328/khlim-assist
- Inspect the existing command registry, project docs, and command docs.
- Implement only the local behavior needed to format a repo summary from read-only data.

Requirements:
- Output repo name, default branch, latest commit, README summary, last updated time, and important files when data is available.
- If live GitHub access is not configured, return a clear unavailable message.
- Keep output concise for phone use.

Do not change:
- Do not add GitHub write permissions.
- Do not add secrets or fake API keys.
- Do not deploy anything.
- Do not refactor unrelated command behavior.

Tests/checks:
- Add focused tests for successful summary and unavailable-data response.
- Run relevant test command if available.
- Document any checks that cannot run.

Exit criteria:
- `/repo khlim-assist` returns the documented format.
- Missing GitHub config fails safely.
- Summary includes changed files and verification results.
```

