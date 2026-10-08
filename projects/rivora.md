# RIVORA

## Project

RIVORA

## Repo

`Linardi1328/rivora`

## Connection status

Connected candidate.

## Current role

Reusable tournament operations, live-event, standings, bracket, schedule, and white-label event experience platform.

## OpenClaw priority

High.

## Current phase

Premium white-label event experience development.

## Last known status

The v0.1 visual product experience is merged. A v0.2 premium white-label event-experience pull request is currently under review; PPO must not start overlapping work while that pull request remains open.

## Next action

Owner product decision required before starting the next RIVORA implementation slice.

## Codex fit

Use the Software Factory for bounded event-schema, organizer-sync, live-site, marketing-site, portability, accessibility, and release-hardening work after the owner supplies an explicit objective.

## Do not change

- Do not start overlapping implementation while another RIVORA pull request is open.
- Do not hard-code KHLIM-specific assumptions into reusable event runtime contracts.
- Do not weaken organizer data validation or upstream error sanitization.
- Do not ship inaccessible navigation, forms, tabs, or motion behavior.
- Do not add production deployment authority automatically.
- Do not add paid infrastructure without owner approval.

## Known risks

- White-label configuration can create subtle cross-event leakage if event identity is not isolated.
- Live-event polling and schedule filtering can create concurrency and stale-state bugs.
- Marketing/demo URLs must never fall back to localhost in production.
- Browser accessibility and responsive behavior are core release requirements.
