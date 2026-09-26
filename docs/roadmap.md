# Postelyo – Roadmap

Status: **Approved – Phase 0 tooling done, live pilot pending; Phase 1 hardening built**
Created: 2026-09-21 · Updated: 2026-09-26 (Phase 1 items 2–7 of the product roadmap prompt built; pilot findings pending)
Related: [product-requirements.md](./product-requirements.md), [architecture.md](./architecture.md), [product-roadmap.md](./product-roadmap.md) (phase-by-phase product direction with build prompts)

Phases are sequential by default; each phase ends with a usable product. Durations are rough and assume a small team (1–2 engineers). Nothing in a later phase requires rewriting the publishing engine; each row lists the architectural hook it relies on.

---

## Phase 0 – Foundation and MVP (Notion → LinkedIn)

Goal: a pilot team publishes to LinkedIn from Notion for 30 days with zero duplicates.

| Milestone | Deliverables | Architectural hook | Status |
|-----------|--------------|--------------------|--------|
| 0.1 Skeleton | Repo, CI, Docker, Postgres, migrations, config, logging, health, `FakeProvider` | Folder structure §15 | Done 2026-09-22 |
| 0.2 Identity & tenancy | Magic-link auth, workspace, membership, `TenantContext`, tenancy tests | §4, §5 | Done 2026-09-22 |
| 0.3 Connections | Credential vault, LinkedIn OAuth (personal profile only), Notion token + database validation | §6, §13 | Done 2026-09-23 |
| 0.4 Content pipeline | Notion sync with editorial-status mirroring (`Idea`/`Draft`/`In review`/`Changes requested`/`Ready`/`Scheduled`/`Cancelled`, unenforced, audited), `Awaiting schedule` writeback, canonical content, validation, snapshot, `Post`/`Publication` state machine, audit log | §7, domain model | Done 2026-09-23 |
| 0.5 Scheduling & publishing | Scheduler tick, late-publish policy with `delay_seconds`, publish engine with lease/retry/ambiguous, LinkedIn adapter (text), writeback incl. `Published late` | §8–§10 | Done 2026-09-23 |
| 0.6 Images | Optional single image via LinkedIn Images API, `media_asset` | §9.3 | Done 2026-09-24 |
| 0.7 Ops | Email alerts to configurable `ALERT_EMAIL`, token-expiry emails to the connecting admin, admin list/retry UI, runbook, staging + production deploy | §18–§19 | Done 2026-09-24 |
| 0.8 Pilot | Notion template generator (`npm run notion:template`), setup guide, preflight (`npm run preflight`), Sentry with token scrubbing, seed script, go/no-go checklist, pilot with one team | PRD §8, pilot-checklist.md | Tooling done 2026-09-24 · live pilot pending credentials |

Not in Phase 0 (product decisions 2026-09-22): organization pages, Slack, review-order enforcement, Ideas feature, multi-media.

---

## Phase 1 – Hardening and second platform

Goal: confidence to onboard external teams; prove the adapter pattern with a second provider. The product-level plan with prompts is in [product-roadmap.md](./product-roadmap.md); items marked done were built 2026-09-26 (pilot findings, item 1 of that prompt, wait for the live pilot).

| Item | Notes | Hook | Status |
|------|-------|------|--------|
| LinkedIn organization pages | `account_type = organization`, org author URN, org scopes, `?type=organization` connect flow, `LinkedIn Page` Notion option | `social_account.account_type`, adapter `render`/`publish` | Done 2026-09-26 · live verification needs Community Management API approval |
| Per-workspace notification settings | `notification_email`, later Slack; operational alerts and account notices stay separate types | `NotificationTargets` resolver | Open |
| Public Notion OAuth integration | Self-serve onboarding without pasting tokens | `ContentSource` credential abstraction | Open (product roadmap Phase 3) |
| Notion webhooks (optional) | Signed inbound events → `notion-sync-page` job; polling stays authoritative; per-workspace flag | §11.1 | Done 2026-09-26 |
| Second provider: **X** | Text + image; contract suite must pass | `PublishingProvider` + registry | Open (product roadmap Phase 2) |
| Multiple social accounts per platform | Pages: any number, `LinkedIn Page: <name>`; profiles still one per workspace | `social_account` N:1 | Partly done 2026-09-26 |
| Team invitations and roles | `admin`, `editor`, `viewer` become real | Role enum already present | Open (product roadmap Phase 3) |
| Reconciliation for ambiguous outcomes | `lookupRecent` + text fingerprint + time window; exactly one match resolves; 3 checks max | `PublishResult.ambiguous` | Done 2026-09-26 |
| Workspace-level policies | Per-account daily cap (`dailyCapPerAccount`), rate-limit waits; late-publish policy still open | `workspace.settings` | Partly done 2026-09-26 |
| Postgres RLS | Forced policies on all tenant tables; `withTenantScope` in tenant-facing services; restricted app role | §4 item 7 | Done 2026-09-26 |

---

## Phase 2 – Native content workspace

Goal: Postelyo becomes the primary authoring surface; Notion becomes one source among several.

| Item | Notes | Hook |
|------|-------|------|
| Web app (`apps/web`, Next.js) | Replaces server-rendered admin pages | Thin HTTP layer; services unchanged |
| Native editor | Writes canonical content directly; `content_source.kind = native` | Canonical content format §4 of domain model |
| Content calendar | Views over `post`/`publication` by `scheduled_at` in workspace tz | Existing schema |
| Content ideas | Dedicated Ideas feature (board, promotion to draft); replaces the Notion `Idea` status that the MVP simply maps to `draft` | New table, no publishing change |
| Approval workflow enforcement | The states `in_review`, `changes_requested`, `ready` exist from the MVP (mirrored, unenforced). Phase 2 adds reviewers, permissions, blocked transitions and policies in the native editor | Post state machine (no new states needed); audit actor |
| Collaboration | Comments, mentions, assignments on posts | New tables |
| Media library | Object storage (S3/R2), processing, reuse across posts | `media_asset` + `content_hash` |
| Instagram, Facebook adapters | Instagram requires media hosting (object storage from this phase) | Registry |

---

## Phase 3 – Intelligence and growth

| Item | Notes | Hook |
|------|-------|------|
| AI content generation | Draft from an idea/brief; human-in-the-loop | Produces canonical content |
| AI platform adaptation | Per-publication `content_override` generated before render | `publication.content_override` |
| Analytics | Metrics fetch jobs per provider; `publication_metrics` time series; dashboards | `provider_post_id` |
| Campaigns | Group posts, campaign-level scheduling and reporting | New `campaign` table, `post.campaign_id` |
| Public API + outbound webhooks | API keys, `Idempotency-Key`, signed webhooks from the audit stream | §11.2, §14 |
| Billing / subscriptions | Stripe; plan limits enforced in services | `workspace.plan` |
| Multiple workspaces per user, workspace switching | Already supported by `membership`; UI work | |
| Scale-out | Redis/BullMQ or SQS if Postgres queue saturates; audit partitioning; regional deployments | §20 |
| Compliance | SOC 2 readiness, per-tenant keys, data residency | `KeyProvider`, `credential_key_id` |

---

## Explicit non-goals (all phases, for now)

- Editing or deleting posts on the platform after publishing (each provider differs; revisit with analytics).
- Inbox / engagement replies.
- Paid ads management.
- Self-hosted / on-prem distribution.

---

## Decision points that gate the roadmap

1. **LinkedIn Community Management API approval** – gates organization pages (Phase 1; explicitly excluded from Phase 0).
2. **Pilot outcome** – if teams want the editor before more platforms, Phase 2 moves ahead of Phase 1's second provider.
3. **Queue technology** – stay on Postgres until sustained > 5 000 jobs/hour or cross-region workers are needed.
4. **Auth vendor** – if invitations/SSO become urgent early, switching to Clerk is a contained change.
