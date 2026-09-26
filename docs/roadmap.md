# Postelyo – Roadmap

Status: **Approved – Phase 0 tooling done, live pilot pending; Phase 1 hardening and Phase 2 multi-platform core built**
Created: 2026-09-21 · Updated: 2026-09-26 (Phase 2 built; pilot findings and live verification of X/Meta pending)
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

## Phase 2 – Multi-platform core (built 2026-09-26)

Goal: one Notion page becomes several platform posts, each adapted, each independently tracked. The product-level plan is [product-roadmap.md](./product-roadmap.md) Phase 2; the native editor items that used to sit here moved to a later phase there.

| Item | Notes | Hook | Status |
|------|-------|------|--------|
| `packages/publishing-core` | Provider contract, canonical content, rendering helpers, registry, contract suite and all adapters extracted; api depends on it | §9.1, §15 | Done |
| Object storage + media pipeline | `ObjectStorage` (local filesystem, S3-compatible/R2), `media_object` by content hash, `sharp` variants per provider `ImageSpec`, public URLs, `/media/*` for the local driver, pruning in maintenance | §9.3 media | Done |
| Notion contract v1.1 | Optional `LinkedIn Text`, `X Text`, `Facebook Text`, `Instagram Caption`; `Platforms` options `X`, `Facebook Page`, `Instagram`; optional `Published URLs`; `Partially failed` status; post-level writeback | PRD §4.4 | Done |
| X adapter | Text + one image (API v2, media upload), weighted length, OAuth 2.0 PKCE with refresh, `lookupRecent` | Registry, `social_account` refresh | Done · live verification needs a paid X API tier |
| Facebook Pages adapter | Text + image by URL, Page tokens via Facebook Login, `lookupRecent` | Registry | Done · needs Meta app review |
| Instagram adapter | Image required, container publish with status polling, JPEG variant within 4:5–1.91:1 | Registry, media pipeline | Done · needs Meta app review |
| Multiple accounts per provider | Any number per provider; `<Platform>: <name>` picks one; Instagram accounts hang off their Page | `social_account.parent_account_id` | Done |
| Per-workspace provider flags | `providers.{x,facebook,instagram}` in workspace settings; LinkedIn always on | `workspace.settings` | Done |
| One publication per target | Independent failures, aggregated Notion status (`Partially failed`), one note line and one URL per platform | Existing schema | Done |

Moved to the product roadmap's later phases: Next.js web app (Phase 3), native editor and collaboration (decision point 4), calendar/ideas/approval enforcement (Phase 4).

---

## Phase 3 – Self-serve SaaS (built 2026-09-26)

Goal: a stranger signs up, connects Notion and their socials, invites their team and pays, without talking to us. Product plan: [product-roadmap.md](./product-roadmap.md) Phase 3.

| Item | Notes | Hook | Status |
|------|-------|------|--------|
| Public Notion OAuth + setup wizard | `NotionOAuthClient`, pending source until setup; create the template in a chosen page or adopt an existing database; pasted-token path kept | `content_source.config.authKind`, `oauth_state` | Done · Notion public review pending |
| Teams | `invitation` (hashed 7-day tokens), invite/list/revoke/peek/accept, role changes and removal with the last-owner rule, extra workspaces | §5.1 | Done |
| Stripe billing | `BillingGateway` (Stripe + fake), Checkout and Customer Portal, signed idempotent webhook, plans Free/Solo/Team/Agency (placeholder prices), limits enforced in services, metering from audit, 14-day grace, operator-granted plans | `billing_customer`, `subscription`, `stripe_event`, `workspace.plan` | Done · prices to decide |
| `apps/web` dashboard | Next.js App Router + Tailwind, server actions over the api, rewrites for auth/api/oauth/webhooks/media; pages: sign-in, workspaces, setup, connections, team, billing, posts, publication detail, settings, invitations, privacy, terms | §2.2, §18.1 | Done · Fastify pages stay as operator fallback |
| Notification settings | `notificationEmail`, `alertCopyEmail` per workspace | `workspace.settings` | Done |
| Deletion and compliance | Soft delete + `workspace-delete` purge job, anonymised audit, `/privacy` and `/terms` placeholders, [compliance.md](./compliance.md) | §11 | Done · legal review pending |

---

## Phase 4 – Content operations in Notion (built 2026-09-26)

Goal: the Notion database becomes the content calendar and operations hub. Product plan: [product-roadmap.md](./product-roadmap.md) Phase 4; contract: [notion-template.md](./notion-template.md) v2.

| Item | Notes | Hook | Status |
|------|-------|------|--------|
| Template v2 | Additive columns (`Campaign`, `Repeat`, `Repeat Until`, `First Comment`, system `Repeat Of`, `Approval`, `Link Report`), Campaigns and Ideas databases, relations wired after creation, duplicated-template detection in the wizard, v1 upgrade path | `NOTION_CONTRACT`, `createTemplateSuite` | Done · views only via the duplicated template (D33) |
| Campaigns | `campaign` table, `post.campaign_id`, summary writeback on change | §7.4 | Done |
| Recurring and evergreen | Instances as real pages with provenance, propagation to unedited future instances, evergreen slots with minimum gap | `series.service.ts` | Done |
| First comment | Provider capability + contract test; LinkedIn, X, Facebook, Instagram, fake; bounded retries from maintenance | `PublishingProvider.comment` | Done · live verification with each platform pending |
| Links | UTM presets with placeholders, short links on our domain with click counts, `Link Report` | `short_link`, `/l/{code}` | Done · Bitly deferred |
| Approval enforcement | Opt-in policy, reviewers, fingerprint-bound approvals, `APPROVAL_REQUIRED`, Notion mirror | `approval` | Done |
| Ideas | Promotion to draft with link back | `idea.service.ts` | Done |

Deferred: best-time suggestions (Phase 5 analytics), bulk CSV import (Notion-native), Bitly.

---

## Later – Intelligence and growth

| Item | Notes | Hook |
|------|-------|------|
| AI content generation | Draft from an idea/brief; human-in-the-loop | Produces canonical content |
| AI platform adaptation | Per-publication `content_override` generated before render | `publication.content_override` |
| Analytics | Metrics fetch jobs per provider; `publication_metrics` time series; dashboards | `provider_post_id` |
| Campaigns | Group posts, campaign-level scheduling and reporting | New `campaign` table, `post.campaign_id` |
| Public API + outbound webhooks | API keys, `Idempotency-Key`, signed webhooks from the audit stream | §11.2, §14 |
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
