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
