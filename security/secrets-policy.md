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

Phase 6B planner evidence uses the Phase 6A run-state store. It may store plan hashes, source hashes, bounded counts, project ids, next-stage labels, and Git SHAs. It must not store raw project documents, raw GitHub payloads, raw planner failures, credentials, tokens, or terminal confirmation values.

Phase 6C workspace evidence uses the Phase 6A run-state store. It may store project id, approved repo identity, base SHA, deterministic branch name, workspace id, bounded workspace reference, manager id, and verification timestamp. It must not store credentials, access tokens, passwords, authorization headers, raw Git stdout/stderr, raw Git failures, arbitrary user-controlled paths, source repository paths, task text, terminal confirmation values, stack traces, or unbounded logs.

Phase 6D Codex execution uses a deterministic bounded prompt generated from the Phase 6A run task and metadata-only planning evidence. The prompt must not include credentials, tokens, terminal confirmation values, environment dumps, raw logs, raw errors, arbitrary paths, or secrets. Phase 6D implementation evidence may store project id, approved repo identity, branch, workspace id/reference, resulting implementation SHA, adapter id, attempt number, prompt hash, timestamps, sandbox id, sandbox backend id, sandbox platform id, no-network status, remote-write defense status, and bounded outcome counts. It must not store prompt contents, raw Codex stdout/stderr, raw Codex failures, credentials, tokens, source repository paths, workspace absolute paths, sandbox executable paths, Linux namespace paths, policy wrapper paths, or unbounded logs.

Phase 6E automated testing uses only trusted local per-project test policy metadata. Test evidence may store test id, policy id/hash, implementation SHA, exit status class, duration, timestamps, attempt number, aggregate outcome, sandbox id, and no-network status. It must not store raw test stdout/stderr, raw failures, environment dumps, credentials, tokens, source repository paths, workspace absolute paths, executable paths, argv, sandbox executable paths, Linux namespace paths, terminal confirmation values, or unbounded logs. Test environments must be sanitized and must not inherit secret, auth, credential, confirmation, askpass, Git config, cloud, package-manager, model-provider, or home-directory env values.

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
