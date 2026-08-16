# Local Setup

## Purpose

Phase 1 local setup should prove that OpenClaw can route phone/chat commands to Personal Project Operator behavior without connecting risky write actions.

## MacBook/local test assumptions

- Development happens on a local MacBook first.
- The repo is cloned locally.
- OpenClaw runs locally for testing.
- One chat platform may be connected in Phase 1.
- Secrets are loaded from local environment variables only, not committed files.

## What should be tested locally

- `/status`
- `/menu`
- `/help`
- command parsing
- project alias handling
- phone-friendly response length
- safe-mode messaging

## What should not be connected yet

- GitHub write access
- production deployment
- customer messaging
- trading execution
- paid API calls
- credential-changing actions
- automatic Codex usage scraping

## Phase 1 local test checklist

- Confirm OpenClaw starts locally.
- Confirm one chat platform can send commands.
- Confirm `/menu` returns grouped commands.
- Confirm `/help` explains phone usage.
- Confirm `/status` uses documented project state.
- Confirm unsupported commands fail safely.
- Confirm no GitHub writes are possible.
- Confirm no secrets are printed in logs.

