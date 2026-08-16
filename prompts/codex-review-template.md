# Codex Review Template

Use this for a code-review pass.

```text
Goal:
Review <branch/PR/feature> for correctness, regressions, safety, and missing tests.

Scope:
- Project: <project>
- Repo: <repo>
- Inspect: <changed files or feature area>
- Focus on bugs, risks, behavior changes, and test gaps.

Requirements:
- Prioritize findings by severity.
- Include exact file and line references when possible.
- Explain why each finding matters.
- Suggest focused fixes.

Do not change:
- Do not edit files unless explicitly asked.
- Do not approve, merge, deploy, or comment on PRs.
- Do not include unrelated style preferences.

Tests/checks:
- Note relevant tests that exist.
- Identify missing tests or checks.
- Mention checks that should be run before merge.

Exit criteria:
- Findings are listed first.
- If no issues are found, say so clearly.
- Residual risks and test gaps are documented.
```

