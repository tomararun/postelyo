# Postelyo – Pilot Go/No-Go Checklist

Audience: the product owner and the engineer running the pilot.

Status: **Tooling complete (2026-09-24). Live pilot pending: needs LinkedIn app credentials, a Notion workspace, an SMTP account and a Fly.io (or equivalent) account.**

Related: [product-requirements.md](./product-requirements.md) §8 · [runbook.md](./runbook.md) · [setup-guide.md](./setup-guide.md)

---

## A. Acceptance criteria (PRD §8) and how each is verified

| # | Criterion | Verification | Status |
|---|-----------|--------------|--------|
| 1 | A Notion page set to `Scheduled` 5 minutes ahead publishes to LinkedIn and Notion shows the URL within 2 minutes of the scheduled time. | Automated with fake provider: `publishing.test.ts` "dispatches due publications…". **Live**: step C3 below. | automated ✅ · live ☐ |
| 2 | A page in `Ready` with a date is not published; Notion shows `Awaiting schedule`. | `content-pipeline.test.ts` "mirrors editorial statuses…" | ✅ |
| 3 | `Draft → Scheduled` directly is published; the audit log shows the observed transition. | `content-pipeline.test.ts` (source_status_observed) | ✅ |
| 4 | Killing the worker mid-publish never yields a duplicate; result is `Published` or `Needs review`. | `publishing.test.ts` "two workers racing…", "expired leases become ambiguous" | ✅ |
| 5 | Worker stopped across a scheduled time publishes late with `delay_seconds` and `Published late`. | `publishing.test.ts` "publishes late after an outage" | ✅ |
| 6 | 5xx before request → retry succeeds; 401 → `Needs re-authorization`, no retry, email to connecting admin. | `publishing.test.ts` retry/auth tests; `ops.test.ts` re-auth notice | ✅ |
| 7 | Two workers concurrently → exactly one LinkedIn post per publication. | `publishing.test.ts` race test, pg-boss end-to-end test | ✅ |
| 8 | Date without time publishes at the workspace default time in the workspace zone, including on a DST change day. | `schedule-time.test.ts` (DST gap, fall-back), `content-pipeline.test.ts` | ✅ |
| 9 | Text-only and text+image posts both publish. | `images.test.ts`, LinkedIn adapter image tests. **Live**: C3/C4. | automated ✅ · live ☐ |
| 10 | Operational alerts reach `ALERT_EMAIL`; changing it needs no code change. | `ops.test.ts`; env-driven | ✅ |
| 11 | Tokens appear in no log line, API response, Notion property or Sentry event. | `logger.test.ts`, `connections.test.ts` DTO assertions, `sentry.test.ts`. **Live**: step C6 manual grep. | automated ✅ · live ☐ |
| 12 | Tenancy: user A cannot read or mutate workspace B via any endpoint. | `auth-tenancy.test.ts`, `connections.test.ts`, `content-pipeline.test.ts`, `ops.test.ts` (404s) | ✅ |
| 13 | Audit log contains every transition for a sample publication, with actor. | `publishing.test.ts` trail assertion; publication detail page | ✅ |

## B. Before creating the production environment

- [ ] LinkedIn developer app created; products **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** approved; redirect URL `https://<app>/oauth/linkedin/callback` registered. Verify the Posts API version pinned in `linkedin-provider.ts` (`202509`) is still supported; bump and rerun the contract tests if not.
- [ ] SMTP provider account (Resend or Postmark) with a verified sender for `MAIL_FROM`.
- [ ] `ALERT_EMAIL` decided (product decision P5).
- [ ] Fly.io apps created for staging and production, Fly Postgres attached, secrets set (see `deploy/fly.toml` header). GitHub: `FLY_API_TOKEN` secret, `FLY_APP_STAGING` / `FLY_APP_PRODUCTION` variables, `production` environment with required reviewer.
- [ ] `ENCRYPTION_KEYS` and `AUTH_SECRET` generated with `openssl rand -base64 32`; stored only in the host secret store.
- [ ] Sentry project created; `SENTRY_DSN` set (optional but recommended).

## C. Staging rehearsal (do everything here first, with a test LinkedIn account)

1. [ ] `npm run preflight` against staging shows no FAIL (including `database role`: the app must not connect as a superuser, and `row level security`).
2. [ ] Sign in, connect a **test** Notion workspace via `npm run notion:template`, connect a **test** LinkedIn profile.
3. [ ] Text post scheduled 5 minutes ahead → appears on LinkedIn; Notion shows `Published` with URL; Posts page shows the attempt. *(criteria 1, 9)*
4. [ ] Post with one PNG → appears on LinkedIn with the image. *(criterion 9)*
5. [ ] Deliberately schedule a 3 100-character post → `Validation error` before the time.
6. [ ] Grep staging logs for the LinkedIn access token prefix (`AQV`) and `ntn_`: zero hits. Check a Sentry test event is scrubbed. *(criterion 11)*
7. [ ] Stop the worker machine for 3 minutes with a post due: alert `worker.heartbeat_missing` arrives; restart → post publishes as `Published late`. *(criteria 5, 10)*
8. [ ] Disconnect and reconnect LinkedIn; confirm the reminder cycle resets (`reauth_reminder_sent_at` null).
9. [ ] Trigger a rollback (`flyctl deploy --image <previous>`) and confirm `/health/ready` stays green.

## D. Production go-live

- [ ] Same steps as C1–C3 with the pilot team's real Notion workspace and the real LinkedIn profile, using a harmless "hello" post agreed with the team.
- [ ] Hand the team [setup-guide.md](./setup-guide.md); confirm they can reach the Posts page.
- [ ] Record the pilot start date here: ________.

## E. During the 30 days

- Daily: read the digest; resolve any `Needs review` within the same day.
- Weekly: `npm run preflight`; check `postelyo_publications_overdue` and `postelyo_writebacks_failed` are 0 in `/metrics`.
- Track in this file: duplicates (must stay 0), publications late by more than 15 minutes, validation errors the team found confusing, and every manual intervention.

## F. Exit criteria (PRD §2)

- [ ] 30 days of use with **zero duplicate posts**.
- [ ] Every failure was visible in Notion within a minute.
- [ ] No manual copy-paste publishing by the team.
- [ ] Decision recorded in [roadmap.md](./roadmap.md) "Decision points": proceed to Phase 1 (hardening, second platform) or bring the native editor forward.
