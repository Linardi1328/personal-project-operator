# Secrets Policy

## Never store secrets in the repo

Do not commit:

- passwords
- API keys
- GitHub tokens
- Telegram bot tokens
- OpenClaw secrets
- database URLs with credentials
- private SSH keys
- customer credentials
- brokerage credentials

## Local development

Use `.env` locally only.

Rules:

- keep `.env` out of git
- use example variable names only in docs
- do not paste real secrets into Markdown
- do not print secrets in logs
- rotate any secret that is accidentally exposed

## VPS deployment

Use environment variables or a secure secret manager on the VPS.

Rules:

- configure secrets outside the repo
- restrict file permissions
- avoid shell history leaks
- avoid copying secrets into chat
- document required variable names without real values

Phase 5B write-data configuration uses paths, not secrets:

```text
PPO_WRITE_DATA_DIR=/var/lib/personal-project-operator/write-data
PPO_GITHUB_WRITE_AUDIT_PATH=/var/lib/personal-project-operator/audit/github-write-audit.ndjson
```

Do not paste terminal write confirmation environment values into chat. The `/ppo issue-confirm <request-id>` flow supplies the Phase 5A confirmation internally after the local request id has been atomically claimed.

Phase 5C project notes use the same non-secret `PPO_WRITE_DATA_DIR` root:

```text
PPO_WRITE_DATA_DIR=/var/lib/personal-project-operator/write-data
```

Notes are stored under `${PPO_WRITE_DATA_DIR}/project-notes`. Phase 5D pending note requests are stored temporarily under `${PPO_WRITE_DATA_DIR}/pending-project-notes` and are consumed on confirmation or expiry. Note audit records are metadata-only and must not include note text, Phase 5D request ids, terminal confirmation values, tokens, or raw failures. `PPO_NOTE_WRITE_CONFIRM=add-note:<project>` is for trusted terminal use only and must not be pasted into OpenClaw/Telegram chat.

Phase 6A development run state uses the same non-secret `PPO_WRITE_DATA_DIR` root:

```text
PPO_WRITE_DATA_DIR=/var/lib/personal-project-operator/write-data
```

Run records are stored under `${PPO_WRITE_DATA_DIR}/development-runs`. Evidence records must be structured metadata only and must not include raw credentials, access tokens, passwords, authorization headers, terminal confirmation values, raw stdout/stderr, raw exception objects, stack traces, or unbounded logs.

## Documentation examples

Allowed:

```text
GITHUB_READONLY_TOKEN=
TELEGRAM_BOT_TOKEN=
```

Not allowed:

```text
Real token values pasted into Markdown, chat, commit history, or example files.
```
