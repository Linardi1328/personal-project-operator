# KYNEXA

## Project

KYNEXA

## Repo

`Linardi1328/kynexa`

## Connection status

Connected candidate.

## Current role

Basketball-first sports opportunity network and two-sided marketplace for athletes, parents, organizers, and clubs.

## OpenClaw priority

High.

## Current phase

Registration and application workflow development.

## Last known status

The marketplace and Athlete Passport foundations are merged. Registration Studio templates and custom fields are merged. A follow-on application-drafts and immutable-athlete-snapshot pull request is currently under review; PPO must not start overlapping work while that pull request remains open.

## Next action

Owner product decision required before starting the next KYNEXA implementation slice.

## Codex fit

Use the Software Factory for bounded application, registration, marketplace, database, accessibility, browser-flow, and release-hardening work after the owner supplies an explicit objective.

## Do not change

- Do not start overlapping implementation while another KYNEXA pull request is open.
- Do not weaken organizer, athlete, parent, or roster authorization.
- Do not bypass Supabase row-level security or audit boundaries.
- Do not add production payment or refund behavior without an explicit objective and acceptance criteria.
- Do not expose participant data, secrets, or credentials.
- Do not deploy production automatically.

## Known risks

- The product may process youth-athlete and family information.
- Registration changes can affect published forms and stored athlete snapshots.
- Marketplace authorization mistakes can expose private roster or application data.
- Database migrations need exact rollback and production-rehearsal evidence.
