# Postelyo – System Architecture

Status: **Proposed – awaiting approval for Phase 1 (implementation)**
Created: 2026-09-21 · Updated: 2026-09-22 (product decisions P1–P9 incorporated, see [product-requirements.md](./product-requirements.md) §9)
Related documents: [product-requirements.md](./product-requirements.md), [domain-model.md](./domain-model.md), [security.md](./security.md), [roadmap.md](./roadmap.md)

---

## 0. Assumptions and risks

### 0.1 Assumptions (please confirm or correct)

| # | Assumption | Impact if wrong |
|---|-----------|-----------------|
| A1 | The MVP is operated by one team (ours or a pilot customer), but the schema is multi-tenant from day one. | If several paying tenants are needed at launch, the auth/onboarding surface in the MVP grows. |
| A2 | Backend stack is **TypeScript on Node.js**, **PostgreSQL**, single deployable container with two process roles (`api`, `worker`). | Any other stack is fine; the architecture is language-neutral, but the folder structure and library choices below would change. |
| A3 | MVP publishes **text posts, optionally one image**, to **one LinkedIn personal (member) profile** per workspace. Confirmed (P1, P4). | Multi-image, video, GIFs, documents, polls, carousels and organization pages are out of scope for the MVP. |
| A4 | Notion is connected as an **internal integration token** provided by the workspace admin (not a public Notion OAuth app) for the MVP. | A public Notion OAuth integration is needed once external tenants onboard themselves. The design isolates this behind a `ContentSource` abstraction. |
| A5 | The Notion content database follows a schema **we define and document** (Status, Publish Date, Platforms, Post Text, Media, plus write-back columns). | Free-form user databases require a mapping UI; deferred. |
| A6 | Personal-profile posting only needs LinkedIn's self-serve "Share on LinkedIn" product. Organization pages (roadmap) require **Community Management API** approval and are not part of the MVP (P1). | If the self-serve product's scopes change, the adapter needs an update; no other impact. |
| A7 | LinkedIn access tokens expire after ~60 days and refresh tokens are **not** generally available; users must periodically re-authorize. | If our app is granted programmatic refresh, the re-auth UX becomes rarer, but the design must handle it either way. |
| A8 | Notion date properties may be set **without a time** or without a time zone; the workspace's default time zone is authoritative. | If users want per-post time zones, an additional Notion property is required (supported by design). |
| A9 | Scheduling precision of **±1 minute** is acceptable. | Second-precision scheduling would need a different dispatcher design. |
| A10 | One deployment region, one Postgres instance, low volume (hundreds of posts/day) for the first 12 months. | Scale-out paths are described in §20 but not built. |
| A11 | A minimal web UI exists in the MVP **only** for sign-in, workspace setup, connecting Notion, and connecting LinkedIn. All content operations happen in Notion. | If no UI is acceptable, OAuth connection still needs at least a browser-based flow. |

### 0.2 Risks

| # | Risk | Likelihood | Mitigation |
|---|------|-----------|-----------|
| R1 | **Duplicate publishing** when a provider call succeeds but our acknowledgement is lost (timeout/crash). LinkedIn's Posts API offers no client idempotency key. | Medium | Single-flight lease per publication, "ambiguous outcome" state that fails closed and requires manual review; reconciliation by recent-post lookup where the provider supports it (§10). |
| R2 | **Token expiry / revocation** silently stops publishing. | High | Track `expires_at`, proactive re-auth reminders, mark account `needs_reauth`, write clear status back to Notion, never retry auth errors automatically. |
| R3 | **Notion API rate limits** (~3 req/s per integration) and polling cost as tenants grow. | Medium | Incremental polling by `last_edited_time`, per-tenant poll budgets, later switch to Notion webhooks. |
| R4 | **LinkedIn API changes** (monthly versioning, product approval, scope changes). | Medium | Provider adapter isolation, pinned `LinkedIn-Version`, contract tests with recorded fixtures. |
| R5 | **Content fidelity loss** converting Notion rich text to a platform's plain-text format (LinkedIn requires escaping of reserved characters, 3 000-char limit). | High | Deterministic renderer per provider with unit tests; pre-publish validation writes errors back to Notion before the scheduled time. |
| R6 | Users editing a Notion page **while** it is being published. | Medium | Snapshot content into our `Post` at schedule time; publish from the snapshot; detect drift and surface it. |
| R7 | Notion being the UI means **weak validation and no approval enforcement** in the MVP. | Medium | Backend validation with write-back of errors; approval workflow is roadmap. |
| R8 | Secret leakage via logs, Notion write-back, or browser. | Low if designed in | Redaction, encryption at rest, server-only OAuth, security review (see [security.md](./security.md)). |
| R9 | Over-engineering the MVP for the SaaS vision. | High (natural pull) | Explicit "MVP vs later" markers in every section; modular monolith; no microservices, no Kafka, no multi-region. |
| R10 | Platform policy risk: LinkedIn may throttle or ban automated posting that looks spammy. | Low | Respect rate limits, no mass posting features, per-account daily caps. |

---

## 1. Product architecture

### 1.1 Product shape

Postelyo is an **orchestration and publishing layer** between a content management surface and social platforms. In the MVP the content surface is Notion; long term it is our own editor, calendar and collaboration tools. The publishing layer is the durable core; everything else is replaceable at the edges.

```
                ┌──────────────────────────────┐
  MVP ────────► │  Notion (content surface)    │
                └─────────────┬────────────────┘
                              │ ContentSource adapter
                ┌─────────────▼────────────────┐
                │  Postelyo Core               │
                │  - Workspaces & members      │
                │  - Posts & publications      │
                │  - Scheduler                 │
                │  - Publishing engine         │
                │  - Audit log                 │
                └─────────────┬────────────────┘
                              │ PublishingProvider adapters
          ┌───────────┬───────┴─────┬─────────────┐
          ▼           ▼             ▼             ▼
      LinkedIn     X (later)   Instagram (later)  Facebook (later)
```

### 1.2 Product principles

1. **Core owns truth for publishing.** Notion (later: our editor) owns authoring; Postelyo owns *what was published, where, when, with which result*.
2. **Adapters at both edges.** `ContentSource` (Notion now; native editor later) and `PublishingProvider` (LinkedIn now; others later) are interfaces. The core never imports a vendor SDK directly.
3. **Every state change is a recorded event.** Auditable, replayable for debugging, and later drives analytics and notifications.
4. **Safe by default.** Unknown outcome → stop and ask, never guess and re-post.
5. **Boring infrastructure.** One database, one queue mechanism, one deployable.

### 1.3 MVP feature boundary

In scope: Notion polling, mirroring of the Notion editorial status (no enforcement), content snapshot and validation, timezone-aware scheduling, LinkedIn text + optional single-image publishing to one personal profile per workspace, late publishing with recorded delay, result write-back to Notion, retry of transient failures, manual retry via Notion, audit log, email notifications (operational alerts to a configurable recipient; token-expiry notices to the connecting admin), minimal web UI for connections.

Out of scope (see [roadmap.md](./roadmap.md)): native editor, calendar, ideas feature, approval enforcement, AI, analytics, campaigns, media library, billing, multiple social accounts per platform, LinkedIn organization pages, public API, outbound webhooks, Slack notifications.

---

## 2. System architecture

### 2.1 Overview

A **modular monolith** deployed as one container image with two process roles sharing the same codebase:

- `api` – HTTP server: web UI/API endpoints, OAuth callbacks, inbound webhooks, health.
- `worker` – background processes: Notion sync poller, scheduler dispatcher, publish job consumer, token-expiry checker.

Both talk to a single **PostgreSQL** database, which is also the **job queue** (via `pg-boss` or an equivalent Postgres-backed queue). No Redis in the MVP.

```
 Browser (admin UI only)      Notion API            LinkedIn API
        │ HTTPS                    ▲  ▲                   ▲
        ▼                          │  │                   │
 ┌────────────┐   ┌────────────────┴──┴───────────────────┴──────┐
 │  api       │   │  worker                                       │
 │  - auth    │   │  - notion-sync   (poll → upsert Post)         │
 │  - oauth   │   │  - scheduler     (due Publications → jobs)    │
 │  - webhooks│   │  - publisher     (job → provider adapter)     │
 │  - admin   │   │  - writeback     (result → ContentSource)     │
 └─────┬──────┘   │  - maintenance   (token expiry, cleanup)      │
       │          └───────────────────────┬───────────────────────┘
       │                                  │
       ▼                                  ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  PostgreSQL: domain tables + job queue + audit log            │
 └──────────────────────────────────────────────────────────────┘
```

### 2.2 Components

| Component | Role | MVP notes |
|-----------|------|-----------|
| **Auth & workspace module** | Users, sessions, workspaces, memberships, roles, invitations, workspace deletion. | Email magic link; a workspace per user at signup; Phase 3 adds invitations with hashed 7-day tokens, role changes with a last-owner rule, extra workspaces, soft delete + purge job. |
| **Connections module** | Stores encrypted credentials for Notion and social accounts; runs OAuth flows. | LinkedIn, X and Meta OAuth; Notion by public OAuth (Phase 3, with a setup wizard that creates the template database or adopts an existing one) or by pasted internal token. |
| **Notifications module** | Sends the two email types: operational alerts to the configured alert recipient; token-expiry/re-auth notices to the connecting admin. | Email only. Phase 3: `notificationEmail` overrides the account-notice recipient per workspace; `alertCopyEmail` receives a copy of alerts that concern the workspace. Alert routing itself stays global. |
| **Billing module** (Phase 3) | Plans and limits, Stripe Checkout/Portal through a `BillingGateway`, signed webhook processing, usage metering from the audit stream, grace periods. | Limits enforced in services: accounts at connect time, members at invite time, posts per month at ingest (`PLAN_LIMIT`). |
| **Web dashboard** (`apps/web`, Phase 3) | Next.js control plane for customers: sign-in, workspaces, setup wizard, connections, team, billing, posts, settings, invitations, legal pages. | Server components and server actions call the api's `/v1` endpoints with the visitor's cookie; Next rewrites proxy `/api/auth`, `/v1`, `/oauth`, `/webhooks`, `/media` so the browser sees one origin. No business logic in the web app. |
| **ContentSource: Notion** | Polls the configured database, maps properties → `Post` draft, writes results back. | Polling every 60 s by default. |
| **Posts module** | Canonical `Post` + `Publication` records, state machine, validation, content snapshot. | |
| **Scheduler** | Finds due publications and enqueues publish jobs exactly once. | DB tick every 30 s. |
| **Publishing engine** | Runs a publish job through a `PublishingProvider` adapter with lease, retry and idempotency guarantees. | LinkedIn adapter + Fake adapter for tests. |
| **Audit module** | Append-only event log for all state transitions and admin actions. | |
| **Observability** | Structured logs, error tracking, metrics. | pino + Sentry + a few counters. |

### 2.3 Key data flow (MVP happy path)

1. Editor sets Notion page `Status = Scheduled`, `Publish Date = 2026-10-01 09:00`, `Platforms = LinkedIn`.
2. `notion-sync` polls, sees the page, upserts `Post` (external_id = Notion page id), snapshots content, validates, creates a `Publication` for the LinkedIn account, transitions it to `scheduled`, writes `Postelyo Status = Scheduled` back to Notion.
3. `scheduler` tick finds `Publication` with `scheduled_at <= now()` and state `scheduled`, transitions to `queued` inside the same transaction that enqueues the job.
4. `publisher` worker acquires the job, transitions `queued → publishing` with a lease, renders content via the LinkedIn adapter, calls the LinkedIn Posts API, stores the returned post URN, transitions to `published`.
5. `writeback` updates Notion: `Postelyo Status = Published`, `Published URL`, `Published At`.
6. Every transition emits an `audit_log` row.

### 2.4 Technology recommendation (MVP)

| Concern | Choice | Why |
|---------|--------|-----|
| Language/runtime | TypeScript, Node.js 22 LTS | Single language for API, workers, later web UI. |
| HTTP framework | Fastify | Fast, schema-validated, plugin model, OpenAPI generation. |
| ORM/migrations | Drizzle ORM + drizzle-kit migrations | Type-safe SQL, explicit migrations, no magic. |
| Database | PostgreSQL 16 | Transactions, `SKIP LOCKED`, JSONB, RLS available later. |
| Job queue | pg-boss (Postgres-backed) | No extra infra; supports delayed jobs, retries, singleton keys. Swap for BullMQ/Redis when volume demands. |
| Auth | Better Auth (self-hosted, Postgres) with magic-link email | Keeps users in our DB, no vendor lock-in; Clerk is an acceptable alternative if speed matters more. |
| HTTP client | undici/fetch with timeouts + a small retry wrapper | Explicit control over timeouts and idempotency. |
| Validation | Zod | Shared schemas for API and domain. |
| Logging | pino (JSON) | Structured, cheap. |
| Errors | Sentry | Free tier suffices. |
| Admin UI | Server-rendered pages (Fastify + minimal templates) in the MVP; Next.js app later | Avoids a second app for four screens. |
| Email | Resend or Postmark | Magic links, operational alerts, re-auth notifications. |

---

## 3. Database / domain model (summary)

Full detail in [domain-model.md](./domain-model.md). Core entities:

- `workspace` – tenant boundary. Every domain table carries `workspace_id`.
- `user`, `membership` (user × workspace × role).
- `content_source` – a connected authoring system (`notion` in MVP) with encrypted credentials and configuration (database id, property mapping).
- `social_account` – a connected publishing identity (`linkedin_member`, `linkedin_organization`) with encrypted OAuth tokens and status.
- `post` – canonical content record, sourced from a `content_source` (external id) or later authored natively. Holds the content **snapshot** used for publishing.
- `publication` – one `post` × one `social_account` publishing intent, with its own state, `scheduled_at`, attempts, provider result. This is the unit of scheduling, publishing, retry and idempotency.
- `publish_attempt` – each concrete call to a provider for a `publication`.
- `audit_log` – append-only event log.
- `job` tables – owned by pg-boss.

Why `post` and `publication` are separate: a post targeting three platforms later needs three independent lifecycles, results and retries without triplicating the content.

---

## 4. Multi-tenant architecture

**Model:** shared database, shared schema, **row-level tenancy** via `workspace_id`.

Rules:

1. Every domain table has a non-null `workspace_id` (except `user` and global config). Composite indexes lead with `workspace_id`.
2. All data access goes through repositories that **require a `TenantContext`** (`workspaceId`, `actor`). There is no "unscoped" repository method outside of system jobs, which must state the workspace explicitly per row.
3. HTTP requests resolve the tenant from the session + URL (`/w/:workspaceSlug/...`) and verify membership before any handler runs.
4. Background jobs carry `workspace_id` in their payload; the worker rebuilds `TenantContext` from it.
5. Provider rate limits and poll budgets are tracked **per workspace** and **per social account**.
6. Encryption: one master key in the MVP; the schema reserves a `key_id` column on credential rows so per-tenant data keys can be introduced without migration pain.
7. **Row-Level Security (Phase 1, done 2026-09-26):** every tenant table has a forced policy that admits a row only when `app.workspace_id` is unset (system scope: jobs that iterate workspaces) or equals the row's `workspace_id`. Tenant-facing services run their queries through `withTenantScope(db, workspaceId, fn)` (`infra/db/tenant-scope.ts`), which binds the setting for one transaction via `set_config(..., true)`. The application must connect as a role that is neither superuser nor `BYPASSRLS`; preflight fails in production otherwise. Optional dedicated database for enterprise tenants remains a routing change, not a rewrite.

Tenant lifecycle in MVP: created at signup; soft-delete flag; hard delete via a maintenance job that also revokes tokens at the provider.

---

## 5. Authentication strategy

### 5.1 Human users (admin UI)

- **Magic-link email sign-in** (passwordless) in the MVP; Google OAuth sign-in as a fast follow.
- **Server-side sessions** stored in Postgres, delivered as `HttpOnly; Secure; SameSite=Lax` cookies. No JWTs in the browser.
- Session lifetime 30 days, rotated on privilege change; explicit sign-out revokes.
- Roles per workspace: `owner`, `admin`, `editor`, `viewer`. Phase 3 uses all four: invitations carry a role, admins may grant up to `admin`, only owners grant `owner`, and the last owner can neither leave nor be demoted.
- Phase 3: the dashboard (`apps/web`) is served on the same public origin and proxies `/api/auth/*` to the api, so the Better Auth cookie is shared without any token in the browser. Server components forward the cookie to the api; nothing about sessions changed.
- CSRF protection on state-changing form posts (double-submit token or `Origin` check).

### 5.2 Machine access

- **Internal workers** do not authenticate over HTTP; they share the database and process boundary.
- **Inbound webhooks** (Notion, future providers) are authenticated by provider signature/verification token, never by session.
- **Public API keys** (roadmap): hashed at rest, scoped to a workspace and role, prefix-identifiable (`pk_live_…`), rotatable.

### 5.3 Why not a hosted IdP in the MVP

Better Auth keeps identity in our Postgres with the same tenancy rules and avoids a per-MAU bill. If the team prefers zero auth code, Clerk plugs into the same `user`/`membership` tables through a webhook sync. Both are acceptable; the rest of the design does not depend on this choice.

---

## 6. Social account / OAuth architecture

### 6.1 Principles

- OAuth is **entirely server-side**. The browser only ever sees a redirect to the provider and a redirect back to our UI.
- Tokens are **encrypted at rest** (AES-256-GCM, envelope encryption) and **never leave the worker process** (no API returns them, no log prints them, no Notion write-back contains them).
- A `social_account` is a first-class entity with a `status` (`active`, `needs_reauth`, `revoked`, `disabled`) that gates publishing.

### 6.2 Flow (LinkedIn, MVP)

```
Admin UI ──(1) GET /w/:ws/connections/linkedin/start──► api
   api: create oauth_state {workspace_id, user_id, nonce, pkce_verifier, expires 10m}
   api ──302──► https://www.linkedin.com/oauth/v2/authorization?... state=nonce
User approves on LinkedIn
LinkedIn ──302──► /oauth/linkedin/callback?code&state
   api: validate state (exists, not expired, matches session), exchange code → tokens (server-to-server)
   api: fetch identity (OpenID userinfo / organization list), upsert social_account, encrypt tokens
   api: audit "social_account.connected"
   api ──302──► /w/:ws/connections (success)
```

Scopes (verify against current LinkedIn docs at release time): `openid profile w_member_social` for personal-profile posting. The organization flow (`?type=organization`, Phase 1) requests `openid profile r_organization_social w_organization_social rw_organization_admin`, lists the Pages the member administers (`organizationAcls?q=roleAssignee&role=ADMINISTRATOR`) and connects each as its own `social_account` with `account_type = organization`; the admin disconnects unwanted Pages. This needs Community Management API approval for the app; until then the flow fails with a clear message and the profile flow keeps working.

### 6.3 Token lifecycle

- Store `access_token_enc`, `refresh_token_enc` (nullable), `expires_at`, `scopes`, `provider_account_id`, `key_id`.
- **Maintenance job** runs daily: accounts expiring within 7 days → `needs_reauth_soon` email to the **admin who connected the account** (`connected_by_user_id`); expired → `needs_reauth`, publications for that account move to `blocked` and Notion shows `Postelyo Status = Needs re-authorization`. These notices are never routed to the operational alert address by default (P9).
- Refresh tokens are used when present; refresh happens in the worker under a per-account lock to avoid concurrent refreshes.
- `401`/`403` invalid-token responses during publishing immediately set `needs_reauth` and are **not retried**.
- Disconnect revokes at the provider (best effort), wipes token columns, keeps the row for audit.

### 6.4 Multiple accounts and platforms

`social_account` supports N accounts per workspace and per provider. Rules today: one personal profile per provider (validation, not schema); any number of organization Pages. Notion's `Platforms` option `LinkedIn` targets the profile, `LinkedIn Page` the single connected Page, and `LinkedIn Page: <name>` one of several (`AMBIGUOUS_ACCOUNT` validation error otherwise). Phase 2 generalises the naming convention across providers.

---

## 7. Content lifecycle / state machine

Two state machines: `Post` (authoring-level) and `Publication` (per-target). All transitions are performed by a single `transition()` function that checks the allowed-transition table, writes the new state, and appends an `audit_log` row **in the same transaction**.

### 7.1 Post states

The editorial states (`draft` … `ready`) are **mirrored** from the content source; the operational states (`scheduled` … `published`) are **owned** by Postelyo.

```
 editorial (mirrored from Notion, not enforced)      operational (owned by Postelyo)

 draft ──► in_review ──► ready ─────────────────────► scheduled ──► publishing ──► published
   ▲          │  ▲                                        │             │
   │          ▼  │                                        │             ▼
   └── changes_requested                                  │      partially_failed / failed
                                                          ▼
                                       cancelled (from any non-terminal state)
```

| State | Owner | Meaning |
|-------|-------|---------|
| `draft` | source | Notion `Idea` or `Draft`. Not publishable. |
| `in_review` | source | Notion `In review`. Not publishable. |
| `changes_requested` | source | Notion `Changes requested`. Not publishable. |
| `ready` | source | Notion `Ready`: approved, waiting to be scheduled. **Never enqueued.** If a `Publish Date` exists, writeback sets `Postelyo Status = Awaiting schedule` (P8). |
| `scheduled` | Postelyo | Notion `Scheduled` with valid date: snapshot taken, publications created and scheduled. Validation failures stay in this state with `validation_errors` and `Postelyo Status = Validation error`. |
| `publishing` | Postelyo | At least one publication in flight. |
| `published` | Postelyo | All publications published (on time or late). |
| `partially_failed` | Postelyo | Some published, some terminally failed. |
| `failed` | Postelyo | All publications terminally failed. |
| `cancelled` | source | Withdrawn from source (`Cancelled`, date cleared, or status moved away from `Scheduled`) before publishing. |

**No enforcement of editorial order (P6).** The sync accepts any observed Notion status, sets the mirrored state, and records `post.source_status_observed { from, to }` in the audit log. A page jumping `Draft → Scheduled` is scheduled normally. Enforcement (reviewers, permissions, blocking) arrives in Phase 2 with the native editor.

Post state after `scheduled` is **derived** from its publications; it is stored for querying but recomputed on every publication transition.

### 7.2 Publication states (the important one)

```
 pending ──► scheduled ──► queued ──► publishing ──► published
                │            │           │
                │            │           ├──► retry_wait ──► queued   (transient error, attempts < max)
                │            │           ├──► failed                 (terminal error or max attempts)
                │            │           └──► ambiguous              (provider call outcome unknown)
                │            │                   │
                │            │                   ├──► published (reconciled: found on provider)
                │            │                   └──► failed    (reconciled: not found / manual)
                ├──► blocked (account needs_reauth) ──► scheduled (after re-auth, if still in future or user re-schedules)
                └──► cancelled
 failed ──► scheduled   (manual retry from source: user sets status back to Scheduled)
```

Guards:
- `scheduled → queued` only by the scheduler, in the same transaction as job creation, with `scheduled_at <= now()`.
- `queued → publishing` only by a worker that obtained the **lease** (`lease_owner`, `lease_expires_at`) via a conditional `UPDATE ... WHERE state='queued'`. If zero rows updated, the job exits without calling the provider. This is the primary duplicate-post guard.
- `publishing → published` stores `provider_post_id` and `provider_post_url`; unique index on `(social_account_id, provider_post_id)`.
- Entering `ambiguous` never auto-retries. It writes `Postelyo Status = Needs review` to the source. **Reconciliation (Phase 1):** the maintenance run asks providers that implement `lookupRecent` for the account's posts around the attempt time and resolves to `published` only when exactly one post matches the rendered text's fingerprint inside the window (5 min before, 30 min after). Zero or several matches, or a failed lookup, count as one check; after 3 checks the row is left to the operator. The alert is raised after reconciliation ran, so confirmable outcomes never page anyone.

### 7.3 Source (Notion) status mapping

Notion has two status-like columns to avoid fighting the user for one field:

- `Status` (user-owned): `Idea | Draft | In review | Changes requested | Ready | Scheduled | Cancelled`.
- `Postelyo Status` (system-owned, read-only by convention): `Awaiting schedule | Validation error | Scheduled | Publishing | Published | Published late | Failed | Needs review | Needs re-authorization`.

| Notion `Status` | Internal `post.state` | Postelyo action |
|-----------------|-----------------------|-----------------|
| `Idea`, `Draft` | `draft` | None (P7: `Idea` maps to `draft`). |
| `In review` | `in_review` | None. |
| `Changes requested` | `changes_requested` | None. |
| `Ready` | `ready` | None. If `Publish Date` set → writeback `Awaiting schedule`. Never enqueued (P8). |
| `Scheduled` + valid date | `scheduled` | Validate, snapshot, create/reschedule publications, writeback `Scheduled` or `Validation error`. |
| `Scheduled` after `Failed` | `scheduled` (new cycle) | Manual retry: `cycle_no + 1`. |
| `Cancelled`, or date cleared, or status moved away from `Scheduled` before `queued` | `cancelled` | Cancel pending publications; writeback cleared. |

Edits after `scheduled` produce a drift warning in the `Postelyo Note` property (content is re-snapshotted only if still ≥ 5 minutes before `scheduled_at`). Once a publication is `queued` or later, Notion status changes no longer affect that cycle.

---

### 7.4 Content operations in Notion (Phase 4)

Everything below is additive to the contract (docs/notion-template.md v2) and runs inside the Notion sync with the same token, so no new job, credential path or webhook is needed.

- **Companion databases.** `Postelyo Campaigns` and `Postelyo Ideas` are created next to the content database (`createTemplateSuite`) or discovered on connect: campaigns through the `Campaign` relation's target, ideas by title or the wizard's choice. Their ids and property maps live in `content_source.config`; their incremental cursors share `content_source.cursor` with the main loop (merged, never replaced).
- **Campaigns.** Pages of the campaigns database are mirrored into `campaign`; `post.campaign_id` follows the page's relation. After every sync the service recomputes counts, next publish time and first/latest links per campaign and patches the campaign page only when the summary hash changed (`campaign.summary_written` audit).
- **Series.** A `Scheduled` page with `Repeat` becomes a series. Occurrences are computed from the page's date string (time and offset preserved; monthly clamps to month end) up to 60 days ahead or `Repeat Until`. Each missing occurrence becomes a real page in the same database (`Status = Scheduled`, `Repeat Of` → source, properties and body copied, external media only) plus a placeholder `post` row carrying `parent_post_id`, `series_key` and `series_fp`; the next sync ingests it like any page. Source edits propagate to future instances whose own text fingerprint still equals the one they were generated with (`series_fp`); hand-edited instances are skipped with a note. Instances due within five minutes are never rewritten.
- **Evergreen.** `Repeat = Evergreen` on a `Ready` page joins the pool. Workspace slots (`evergreen.slots`, weekday + time in the workspace zone) 14 days ahead are filled with the least recently shared pool page that respects `minGapDays` (default 30); the instance is an ordinary Scheduled page keyed `evergreen:<slot instant>`.
- **First comment.** `CanonicalContent.firstComment` comes from the `First Comment` column. Publications are created with `first_comment_state = pending` when the provider declares `capabilities().firstComment`. After a successful publish the engine claims the row (`pending → posting`, conditional update, so it runs once), calls `provider.comment()`, and records `posted` or `failed`; retryable failures go back to `pending` and maintenance retries them up to three attempts. The comment never changes the publication outcome; the Notion note and the dashboard report it.
- **Links.** `workspace.settings.links` holds UTM presets (`{campaign}` and `{platform}` placeholders) and the short-link switch. The engine applies them to the rendered content of each publication before `render()`: UTM parameters are appended unless the URL already has any, and links are replaced by `${APP_BASE_URL}/l/<code>` backed by `short_link` rows keyed (publication, target), so retries reuse codes. `/l/{code}` redirects and counts. The Notion source is never rewritten; `Link Report` and the publication page show the mapping and clicks.
- **Approvals.** With `approval.required`, a reviewer (listed user or any owner) approves a `Ready` post in the dashboard. The approval stores a text-only fingerprint (title, platforms, body, overrides, first comment) of what the page said; every sync of a Ready page refreshes `post.approval_fp` and writes `Approval`/`Postelyo Status`. Scheduling compares the snapshot's fingerprint with the latest approval and refuses with `APPROVAL_REQUIRED` on mismatch. Approving enqueues a page sync so the Notion column flips without an edit. Workspaces without the policy are unchanged.
- **Ideas.** Pages of the ideas database with `Status = Promote` become `Draft` pages in the content database (title, notes, body, platforms); the idea gets `Promoted` and `Post URL` (`idea.promoted` audit).

## 8. Scheduling architecture

### 8.1 Time handling

- All timestamps are stored as `timestamptz` (UTC). Each `publication` stores `scheduled_at` (UTC) **and** `scheduled_tz` (IANA name) **and** `scheduled_local` (the wall-clock the user intended) so that DST changes and later edits are explainable.
- Resolution order for the time zone: Notion date property `time_zone` (if set) → `Post Time Zone` property (optional, IANA) → workspace default time zone → error (workspace tz is mandatory at setup).
- Notion dates **without time** default to the workspace's configured "default publish time" (e.g. 09:00) in the workspace time zone.
- Conversion uses the IANA database (`Intl`/`Temporal`), never fixed offsets. Non-existent local times (DST spring-forward gap) resolve forward; ambiguous times (fall-back) resolve to the first occurrence; both are logged in the audit event.

### 8.2 Dispatch mechanism

The database is the schedule of record; the queue is only a delivery mechanism.

```
every 30 s (scheduler tick, single instance via advisory lock):
  BEGIN;
  SELECT id FROM publication
   WHERE state = 'scheduled' AND scheduled_at <= now()
   ORDER BY scheduled_at
   LIMIT 100
   FOR UPDATE SKIP LOCKED;
  for each: UPDATE state='queued', queued_at=now();
            INSERT job(name='publish', key='publish:'||publication_id||':'||cycle_no, payload)
  COMMIT;
```

- The advisory lock (`pg_try_advisory_lock`) means running two workers is safe; only one ticks at a time.
- The job `singletonKey` (pg-boss) makes double enqueue impossible even if the transaction logic regresses.
- Jobs are enqueued **at due time**, not at schedule time. Rescheduling or cancelling in Notion therefore never needs to find and delete a queued job; it just changes the row before the tick.
- **Late publishing policy (P3): publish late.** The scheduler's due-scan has no upper bound on lateness; after an outage every overdue `scheduled` publication is dispatched on the first tick, oldest first. The engine records `delay_seconds = published_at − scheduled_at` on the attempt, the publication and the audit event, and writeback uses `Published late` when the delay exceeds 5 minutes.
- Late detection: publications more than 15 minutes overdue in `scheduled` state raise a metric and an operational alert (worker down). Rows parked by the daily cap (`deferred_until > now()`) are excluded.

### 8.3 Capacity and fairness

- **Per-account daily cap (Phase 1):** before dispatching a due row the tick counts the account's publications published in the last 24 h plus in-flight ones (`queued|publishing|retry_wait`) and compares with the workspace setting `dailyCapPerAccount` (default 100, `PATCH /v1/workspaces/:id`). Over the cap, the row stays `scheduled` with `deferred_until` = when the oldest publication leaves the window (or +15 min), `last_error_code = daily_cap` and a note the writeback shows in Notion; the sync keeps that note instead of flipping back to "Scheduled for …". A moved date resets the deferral.
- **Provider rate limits:** a `retryable_error` with `code = rate_limit` (LinkedIn 429) is a wait, not an attempt: the engine honours `Retry-After` up to 24 h (default 15 min), keeps `attempt_no` unchanged and writes `rate_limited` to the row; the Notion note explains that publishing resumes automatically.
- Per-tenant concurrency limits become queue partitions when needed; publish concurrency per worker is 5.

---

## 9. Publishing architecture

### 9.1 Provider adapter interface

```ts
// modules/publishing/provider.ts  (illustrative signature only – not implementation)
interface PublishingProvider {
  readonly id: ProviderId;                                    // 'linkedin' | 'x' | ...
  capabilities(): ProviderCapabilities;                        // maxTextLength, media types, org accounts...
  validate(content: RenderedContent, account: SocialAccountRef): ValidationResult;
  render(post: PostSnapshot, account: SocialAccountRef): RenderedContent;   // platform-specific adaptation
  publish(input: PublishInput, ctx: ProviderContext): Promise<PublishResult>;
  lookupRecent?(account: SocialAccountRef, since: Date, ctx: ProviderContext): Promise<ProviderPostRef[]>; // reconciliation
  revoke?(account: SocialAccountRef, ctx: ProviderContext): Promise<void>;
}

type PublishResult =
  | { kind: 'published'; providerPostId: string; url?: string; raw?: unknown }
  | { kind: 'retryable_error'; reason: string; retryAfterMs?: number; raw?: unknown }
  | { kind: 'terminal_error'; reason: string; code: 'auth' | 'content' | 'permission' | 'rate_limit_daily' | 'other'; raw?: unknown }
  | { kind: 'ambiguous'; reason: string; raw?: unknown };
```

Rules for adapters:
- Adapters are **pure I/O translators**: no database access, no state transitions. They receive decrypted credentials via `ProviderContext` for the duration of the call only.
- Adapters classify every outcome into exactly one of the four `PublishResult` kinds. The engine never inspects provider-specific errors.
- Adapters live in `packages/publishing-core/src/providers/<id>/` (Phase 2) next to the contract, the canonical content types, the rendering helpers and the contract test suite (`@postelyo/publishing-core/contract-suite`). The api depends on the package; adding a platform means adding a folder there, passing the contract suite and adding one registry line in `services.ts`.
- A `FakeProvider` implements the same interface for local dev and tests with scripted outcomes.

Phase 2 additions to the contract:
- `ProviderCapabilities.image: ImageSpec` declares how the adapter takes images: `upload` (bytes through `loadMedia`, LinkedIn and X) or `url` (a public URL of a derived variant through `mediaUrl`, Facebook and Instagram), plus output type, width bounds and aspect range. `imageRequired` marks Instagram.
- `CanonicalContent.platformText` carries per-platform plain-text overrides by provider id; `contentForProvider()` returns the content an adapter should render (override or shared body). Media stays shared.
- `AccountType` is `member | organization | page | business`.

### 9.1a Media pipeline (Phase 2)

fetch (SSRF-guarded) → validate (type, size, dimensions) → store once per workspace and content hash in object storage (`media_object`, key `ws/<workspace>/<sha256>.<ext>`) → at publish time either hand bytes to `upload` adapters (from storage, no second download) or derive a variant for `url` adapters with `sharp` (centre-crop toward the nearest allowed aspect, clamp width, convert to JPEG) → public URL valid for an hour. `ObjectStorage` has two drivers: `local` (files under `STORAGE_LOCAL_DIR`, served by the api at `/media/<key>`, keys are unguessable hashes) and `s3` (R2/MinIO/AWS; public base URL or presigned GET). Maintenance deletes objects no asset references after seven days. Provider upload refs remain cached per asset and hash.

### 9.2 Publish engine (job handler)

```
handlePublishJob(job):
  1. Load publication + post snapshot + social_account (tenant-scoped).
  2. Acquire lease: UPDATE publication SET state='publishing', lease_owner=$worker, lease_expires_at=now()+2m,
        attempt_no=attempt_no+1 WHERE id=$id AND state='queued'    → if 0 rows: exit (someone else has it / cancelled).
  3. Insert publish_attempt(state='started').
  4. Guard: social_account.status == active, else → blocked (terminal for this cycle).
  5. Decrypt tokens (in memory), build ProviderContext with timeout (30 s) and a correlation id.
  6. result = provider.publish(...)
  7. Switch on result.kind:
       published        → UPDATE publication state='published', provider_post_id, url; attempt=succeeded
       retryable_error  → compute backoff; state='retry_wait'; enqueue same job key with attempt_no+1 and delay; attempt=failed_retryable
       terminal_error   → state='failed' (auth → also social_account.needs_reauth); attempt=failed_terminal
       ambiguous        → state='ambiguous'; attempt=unknown; alert
  8. Recompute post state; append audit; enqueue writeback job (best effort, idempotent).
  All DB writes in steps 7–8 are one transaction. Steps 1–3 are their own transaction (lease must be visible before the network call).
```

Lease expiry: a sweeper marks `publishing` rows whose lease expired **without** an attempt result as `ambiguous` (not `queued`) because the provider call may have succeeded.

### 9.3 LinkedIn adapter specifics (to verify against current docs)

- Endpoint `POST https://api.linkedin.com/rest/posts` with headers `LinkedIn-Version: YYYYMM` (pinned per release), `X-Restli-Protocol-Version: 2.0.0`, `Authorization: Bearer`.
- Body: `author: urn:li:person:{id}` for profiles, `urn:li:organization:{id}` for Pages (`account_type`), `commentary` (≤ 3 000 chars, reserved characters escaped), `visibility: PUBLIC`, `distribution.feedDistribution: MAIN_FEED`, `lifecycleState: PUBLISHED`, optional `content.media.id: urn:li:image:{id}` (image `owner` = the same author URN).
- Reconciliation lookup: `GET /rest/posts?q=author&author={urn}&count=20&sortBy=LAST_MODIFIED`; the fingerprint is taken over the unescaped `commentary`. Availability of this finder for member posts depends on the app's product tier; verify before relying on it.
- Result: `201` with `x-restli-id` header containing the post URN → `provider_post_id`; URL `https://www.linkedin.com/feed/update/{urn}`.
- Images: initialize upload (`POST /rest/images?action=initializeUpload`), `PUT` bytes to the returned upload URL, then reference the image URN. The upload is a separate idempotent step keyed by media content hash so retries do not re-upload.
- Rendering: Notion rich text → plain text with paragraph breaks; links kept as URLs; mentions/hashtags passed through; reserved characters escaped.
- Classification: `429` → retryable `rate_limit` with `Retry-After` (default 15 min), which the engine treats as a wait that does not consume an attempt; `5xx`/network/timeouts before response → `ambiguous` if the request was sent, else retryable; `401/403` → terminal `auth`; `422/400` → terminal `content`.

### 9.3a X, Facebook Pages and Instagram adapters (Phase 2; verify against current docs)

- **X**: OAuth 2.0 user context with PKCE, confidential client (Basic auth on the token endpoint), scopes `tweet.read tweet.write users.read media.write offline.access`. Access tokens last ~2 h: `SocialAccountService.withAccessToken` refreshes when a refresh token is stored and the token expires within 5 minutes (audited as `social_account.token_refreshed`). Publish: `POST /2/media/upload` (multipart, `tweet_image`) then `POST /2/tweets`; 280 weighted characters (URLs count 23); 429 → `rate_limit` with `x-rate-limit-reset`; 403 "duplicate" → content error; 5xx on the tweet call → ambiguous. Lookup: `GET /2/users/:id/tweets`. Posting needs a paid API tier.
- **Facebook Pages**: Facebook Login, long-lived user token → Page tokens from `GET /me/accounts` (these do not expire); each Page is a `facebook`/`page` account. Publish: `POST /{page}/feed` (text) or `POST /{page}/photos` with `url` (image by public URL). Graph error codes: 190 auth; 4/17/32/613 rate limit; 10/200–299/803 permission; 100 content. Lookup: `GET /{page}/feed`. Needs app review for `pages_manage_posts`.
- **Instagram**: the professional account linked to a Page (`instagram_business_account`) becomes an `instagram`/`business` account that hangs off the Page (`parent_account_id`) and shares its token. Publish: `POST /{ig}/media` (container from `image_url` + caption) → poll `status_code` until `FINISHED` → `POST /{ig}/media_publish` (the only non-idempotent call) → permalink. Image required, JPEG, width 320–1440, aspect 4:5 to 1.91:1: the media pipeline derives a conforming variant. Needs app review for `instagram_content_publish`.
- All three are behind per-workspace flags (`workspace.settings.providers`) and server app credentials; ingest reports `PLATFORM_DISABLED` otherwise.

### 9.4 Idempotency summary

| Layer | Mechanism |
|-------|-----------|
| Source → Post | `UNIQUE(content_source_id, external_id)`; upsert. |
| Post → Publication | `UNIQUE(post_id, social_account_id)`; one row per target forever, cycles tracked by `cycle_no` / `attempt_no`. |
| Scheduler → Queue | Conditional state update + job singleton key `publish:{publication_id}:{cycle_no}`. |
| Queue → Provider | Lease acquired by conditional `UPDATE` before the network call; ambiguous outcomes fail closed. |
| Provider → DB | `UNIQUE(social_account_id, provider_post_id)`. |
| Writeback → Notion | Writeback compares desired vs current Notion properties and patches only when different. |

---

## 10. Retry and failure architecture

### 10.1 Error classification

| Class | Examples | Action |
|-------|----------|--------|
| **Transient** | 502/503/504, DNS/connection reset before the request is sent | Retry with backoff. |
| **Rate limit** | 429 with or without `Retry-After` | Wait (`retry_wait`, up to 24 h) without consuming an attempt; the daily cap in §8.3 prevents most of these. |
| **Ambiguous** | Timeout/connection drop *after* the request was sent, 5xx with no body on a non-idempotent call | Stop. Reconcile or manual review. |
| **Terminal – auth** | 401, 403 `expired token`, revoked | Mark account `needs_reauth`, block all its publications, notify. |
| **Terminal – content** | 400/422 validation, too long, unsupported media | Fail publication, write reason to source, user fixes and re-schedules. |
| **Terminal – policy/quota** | Account restricted, content policy | Fail publication with reason; no auto retry. |
| **Internal bug** | Unhandled exception in our code | Job fails, pg-boss retries up to 3 times, then dead-letter; Sentry alert. Publication stays `queued`/`publishing` and the lease sweeper handles it. |

### 10.2 Retry policy

- Exponential backoff with full jitter: base 30 s, factor 2, cap 15 min, **max 5 attempts** per cycle (~30 min total). Provider `Retry-After` overrides the delay.
- Late publications (worker outage or long retry chains) are always published (P3); `delay_seconds` is recorded and the writeback says `Published late` with the delay in the note. A per-workspace "skip if later than X" policy is a roadmap option, not MVP.
- Retries are enqueued as new delayed jobs with the same singleton key family; the publication row is the retry ledger (`attempt_no`, `next_attempt_at`, `last_error`).

### 10.3 Manual retry

From Notion: set `Status` back to `Scheduled` (optionally with a new date). Sync detects `failed` + user intent → new cycle (`cycle_no + 1`, `attempt_no` reset). From the admin UI: a "Retry" button on the publication does the same and is audited with the actor.

### 10.4 Dead-letter and alerting

- Publications in `ambiguous`, `failed` (internal) or `publishing` with expired lease > 10 min, overdue publications, dead-lettered jobs, worker heartbeat missing → **operational alert email** to the configured alert recipient (`ALERT_EMAIL`, P5). No Slack in the MVP. The recipient is read through a `NotificationTargets` resolver so a per-workspace `notification_email` setting can be added later without touching call sites.
- Alerts are de-duplicated per (kind, entity) with a 1-hour suppression window to avoid floods during an outage.
- Token-expiry and re-authorization notices are a separate notification type sent to the connecting admin (§6.3, P9).
- A daily digest job lists all `needs_reauth` accounts and `failed` publications per workspace, sent to the alert recipient.

### 10.5 Writeback failures

Writeback to Notion is a separate job with its own retries (Notion is also unreliable). A failed writeback never changes publication state; it only marks `writeback_state = pending|done|failed` on the publication and is retried by a sweeper. The user-visible source may lag; the database is truth.

---

## 11. Webhook architecture

### 11.1 Inbound (MVP: none required; design ready)

| Source | Purpose | MVP | Notes |
|--------|---------|-----|-------|
| Notion integration webhooks | Lower latency than polling | **Phase 1 (done 2026-09-26)**, opt-in per workspace (`notionWebhooks` setting) | `POST /webhooks/notion`: the first delivery carries a `verification_token` (logged once so the operator can set `NOTION_WEBHOOK_SECRET`); later deliveries are verified with `X-Notion-Signature` (HMAC-SHA256 over the raw body). Events are stored idempotently in `webhook_event`, matched to the content source by database id, and turn into a `notion-sync-page` job (stately per page). Polling remains authoritative. |
| Notion database automation "Send webhook" | Same, user-configured | Off | Unauthenticated by design; if used, require a per-workspace secret in the URL path and treat as a hint only. |
| LinkedIn | Not needed for publishing | – | Analytics later uses polling APIs, not webhooks. |
| Auth provider (if Clerk) | User/org sync | Only if Clerk chosen | Signature-verified. |

Generic inbound webhook rules: verify signature/token → persist raw event (`webhook_event` table, idempotent on provider event id) → ack `2xx` quickly → process asynchronously via a job. Never do provider calls inside the webhook request.

### 11.2 Outbound (roadmap)

Customer-facing webhooks (`publication.published`, `publication.failed`, ...) built on the audit/event stream: subscriptions per workspace, HMAC-SHA256 signatures, retries with backoff, per-endpoint circuit breaker. The `audit_log` design (typed events with JSON payloads) is chosen so this is an addition, not a refactor.

---

## 12. Security model

Full detail in [security.md](./security.md). Summary:

- **Trust boundaries:** browser (untrusted) → api (trusted, tenant-scoped) → database; worker (trusted) → providers (untrusted, unreliable); Notion content (untrusted input: validate, size-limit, sanitize).
- **Tenancy enforcement** in code (mandatory `TenantContext`) and later in Postgres RLS.
- **Credentials:** encrypted at rest with envelope encryption; decrypted only in the worker, only for the duration of a provider call; never logged, never returned by any API, never written to Notion.
- **Browser never sees provider credentials** or provider API responses; the UI only sees `social_account` metadata (name, status, expiry date).
- **Least privilege** OAuth scopes; Notion integration limited to the one database.
- **Audit log** for every state transition and every admin action, with actor (user / system job / webhook).
- **Input validation** at every boundary with Zod; output encoding in the UI; CSRF on forms; rate limiting on auth and OAuth endpoints.
- **Dependencies:** lockfile, automated vulnerability scanning, pinned provider API versions.

---

## 13. Secret management strategy

Two categories:

1. **Platform secrets** (ours): database URL, master encryption key, LinkedIn client id/secret, Notion OAuth client (later), email API key, Sentry DSN, session secret. (`ALERT_EMAIL` is ordinary configuration, not a secret, but lives in the same env-validated config.)
   - Provided as environment variables injected by the hosting platform's secret store (Railway/Fly/Render secrets, or AWS Secrets Manager/Parameter Store if on AWS). Never in the repository, never in Docker images.
   - `.env.example` documents every variable; `.env` is git-ignored; a startup check fails fast if any required secret is missing.
   - Rotation: master key supports **multiple active key ids** (`ENCRYPTION_KEYS="k2:base64,k1:base64"`, first is current); a re-encrypt job rotates rows lazily.

2. **Tenant credentials** (theirs): Notion tokens, social OAuth tokens.
   - Stored in Postgres columns as ciphertext produced by AES-256-GCM with a per-row random data key (envelope: DEK encrypted by the master key; `key_id` recorded). This makes moving to a KMS (AWS KMS / GCP KMS / Vault) a change in one `KeyProvider` implementation.
   - Access only via a `CredentialVault` service with an explicit reason string that is audited (`credential.accessed`, without the value).
   - Backups of Postgres therefore contain only ciphertext; the master key lives elsewhere.

Never: secrets in Notion properties, in logs, in error messages, in URLs, in client-side code, in Sentry breadcrumbs (Sentry scrubbing configured).

---

## 14. API architecture

### 14.1 Style

- **REST over HTTPS, JSON**, versioned by path (`/v1`). OpenAPI spec generated from Fastify/Zod schemas.
- Tenant in the path: `/v1/workspaces/{workspaceId}/...`. Authorization is membership-based on every route.
- Errors: RFC 9457 problem details (`type`, `title`, `status`, `detail`, `instance`, plus `code`).
- Idempotency on mutating public endpoints via `Idempotency-Key` header (roadmap when the public API ships; the internal admin API uses natural keys).
- Pagination: cursor-based.

### 14.2 MVP endpoints (internal, used by the admin UI)

```
POST /auth/magic-link                    request sign-in link
GET  /auth/callback                      complete sign-in
POST /auth/sign-out

GET  /v1/workspaces/{id}                 settings (time zone, default publish time)
PATCH /v1/workspaces/{id}

GET  /v1/workspaces/{id}/content-sources
POST /v1/workspaces/{id}/content-sources/notion         { token, databaseId }  → validates schema, stores encrypted
POST /v1/workspaces/{id}/content-sources/{sid}/sync     manual sync trigger
DELETE /v1/workspaces/{id}/content-sources/{sid}

GET  /v1/workspaces/{id}/social-accounts
GET  /v1/workspaces/{id}/social-accounts/linkedin/connect   → 302 to LinkedIn
GET  /oauth/linkedin/callback
DELETE /v1/workspaces/{id}/social-accounts/{aid}

GET  /v1/workspaces/{id}/posts?state=&from=&to=          read-only list for debugging/dashboard
GET  /v1/workspaces/{id}/publications/{pid}
POST /v1/workspaces/{id}/publications/{pid}/retry

GET  /health/live   GET /health/ready
POST /webhooks/notion/{sourceId}          (disabled by default in MVP)

# Phase 3 (self-serve)
POST /v1/workspaces                                          create another workspace (owner)
DELETE /v1/workspaces/{id}                                   owner; 202, soft delete + purge job
GET  /v1/workspaces/{id}/content-sources/notion/connect      -> 302 to Notion OAuth
GET  /oauth/notion/callback
GET  /v1/workspaces/{id}/content-sources/{sid}/setup         pages/databases the user shared
POST /v1/workspaces/{id}/content-sources/{sid}/setup         { mode: create, parentPageId, title? } | { mode: existing, databaseId }
GET  /v1/workspaces/{id}/members                             PATCH/DELETE .../members/{userId}
GET  /v1/workspaces/{id}/invitations                         POST { email, role }; DELETE .../invitations/{iid}
GET  /v1/invitations/{token}                                 peek (signed in); POST .../accept
GET  /v1/workspaces/{id}/billing                             usage, limits, subscription, plans
POST /v1/workspaces/{id}/billing/checkout { plan }           owner -> { url } (Stripe Checkout)
POST /v1/workspaces/{id}/billing/portal                      owner -> { url } (Customer Portal)
POST /webhooks/stripe                                        signed, idempotent
GET  /privacy   GET /terms
```

Plan-limit refusals answer `402 { code: "plan_limit" }`; the ingest path records a `PLAN_LIMIT` validation error on the post instead.

```
# Phase 4 (content operations)
GET  /v1/workspaces/{id}/campaigns                           mirrored Campaigns pages with their last summary
GET  /v1/workspaces/{id}/approvals                           Ready posts waiting for a reviewer (policy on)
POST /v1/workspaces/{id}/posts/{postId}/approve              reviewer or owner; binds the current fingerprint
DELETE /v1/workspaces/{id}/posts/{postId}/approvals          admin; revokes open approvals
GET  /l/{code}                                               short link redirect (public), counts the click
PATCH /v1/workspaces/{id} { links, evergreen, approval }     Phase 4 settings (null clears)
```

`GET /v1/workspaces/{id}/publications/{pid}` also returns `firstCommentState`/`firstCommentId`/`firstCommentError` and the publication's tracked `links` with click counts; the setup wizard's `GET …/setup` returns `suggested` databases when a duplicated Postelyo template is found, and `POST …/setup` accepts `ideasDatabaseId` in `existing` mode.

### 14.3 Internal module boundaries

Modules expose TypeScript service interfaces, not HTTP, to each other. The HTTP layer is thin: parse → authorize → call service → map result. This is what allows the future native editor, public API and AI features to reuse the same services.

---

## 15. Recommended folder structure

Single repository, single Node package in the MVP, structured so that `apps/web` and `packages/*` can be split out later without moving domain code.

```
postelyo/
├── docs/                          # this folder
├── apps/
│   └── api/                       # the one deployable (api + worker entrypoints)
│       ├── src/
│       │   ├── main-api.ts        # boots HTTP server
│       │   ├── main-worker.ts     # boots job workers
│       │   ├── config/            # env parsing (zod), feature flags
│       │   ├── http/              # Fastify app, plugins, routes, auth middleware, error mapping
│       │   │   ├── routes/
│       │   │   └── views/         # minimal server-rendered admin pages (MVP only)
│       │   ├── jobs/              # job definitions + handlers (thin: call services)
│       │   │   ├── notion-sync.job.ts
│       │   │   ├── scheduler.job.ts
│       │   │   ├── publish.job.ts
│       │   │   ├── writeback.job.ts
│       │   │   └── maintenance.job.ts
│       │   ├── modules/           # domain modules (services, repositories, state machines)
│       │   │   ├── workspaces/
│       │   │   ├── auth/
│       │   │   ├── connections/   # credential vault, oauth state, social accounts
│       │   │   ├── content-sources/
│       │   │   │   ├── content-source.ts        # interface
│       │   │   │   └── notion/                  # Notion adapter: client, mapping, writeback
│       │   │   ├── posts/         # Post, Publication, state machine, validation, snapshots
│       │   │   ├── scheduling/    # due-scan, time zone resolution
│       │   │   ├── publishing/
│       │   │   │   ├── provider.ts              # PublishingProvider interface + result types
│       │   │   │   ├── registry.ts
│       │   │   │   ├── engine.ts                # lease, classify, retry, transitions
│       │   │   │   └── providers/
│       │   │   │       ├── linkedin/            # client, render, classify, media upload
│       │   │   │       └── fake/
│       │   │   ├── notifications/ # email templates, NotificationTargets resolver (alerts vs account notices)
│       │   │   └── audit/
│       │   ├── infra/             # db client, migrations runner, queue, crypto, http client, email, logger, telemetry
│       │   └── shared/            # result types, errors, ids, clock, tenant context
│       ├── drizzle/               # migrations
│       ├── test/                  # integration + e2e (unit tests sit next to source as *.test.ts)
│       ├── Dockerfile
│       └── package.json
├── .github/workflows/             # ci.yml, deploy.yml
├── docker-compose.yml             # postgres (+ mailpit) for local dev
├── .env.example
└── package.json                   # workspace root (npm workspaces)
```

Boundary rules (enforced with ESLint import rules):
- `modules/*` never import from `http/` or `jobs/`.
- `publishing/providers/*` never import from other modules; they only see `provider.ts` types.
- `content-sources/notion` is the only place that knows Notion property names.
- `infra/` has no domain knowledge.

---

## 16. Testing strategy

| Level | What | Tooling | MVP |
|-------|------|---------|-----|
| **Unit** | State machine transition table, time zone resolution (DST cases), LinkedIn text renderer/escaper, error classification, backoff math, Notion property mapping. | Vitest | Yes, high coverage here; this is where bugs cost real duplicate posts. |
| **Adapter contract tests** | A shared conformance suite that every `PublishingProvider` must pass (returns exactly one result kind, respects capabilities, never throws for classified errors). Runs against `FakeProvider` and against LinkedIn with **recorded HTTP fixtures**. | Vitest + msw/nock recordings | Yes |
| **Integration** | Repositories, scheduler tick, publish engine with lease semantics (two workers racing), writeback idempotency; against a real Postgres. | Vitest against `DATABASE_URL` (CI service container); locally an embedded throwaway Postgres (`embedded-postgres` dev dependency) when no `DATABASE_URL` is set, so no Docker is required | Yes |
| **End-to-end (system)** | Notion sandbox database → sync → schedule → `FakeProvider` publish → writeback, in a running stack. | Playwright for the four admin screens; scripted API flow for the pipeline | Minimal |
| **Live provider smoke** | Manual, gated: publish to a dedicated test LinkedIn account before releases that touch the adapter. | Checklist | Manual |
| **Security** | Dependency audit, secret-scan, tenancy tests (user A cannot read B's rows via any endpoint). | `npm audit`, gitleaks, tenancy test suite | Yes |

Principles: tests for the publish path must cover crash points (before lease, after lease before call, after call before commit). Time is injected (`Clock` interface) so DST and scheduling tests are deterministic. No test ever hits LinkedIn or a real Notion workspace without an explicit `LIVE=1` flag.

---

## 17. Local development strategy

- `docker compose up` starts Postgres and Mailpit (catches magic-link emails).
- `npm run dev:api` and `npm run dev:worker` run the two roles with hot reload from the same repo.
- `.env.example` → `.env`; `PROVIDER_MODE=fake` makes the registry use `FakeProvider` so the whole pipeline runs offline. `PROVIDER_MODE=live` requires LinkedIn credentials.
- OAuth callbacks locally via a tunnel (`cloudflared`/`ngrok`) with a dedicated "Postelyo Dev" LinkedIn app whose redirect URI is the tunnel URL; documented in `docs/dev-setup.md` (to be written with the code).
- A **Notion template database** (shared link) with the required properties is provided; devs duplicate it into a personal Notion workspace and create an internal integration.
- Seed script creates a workspace, a user, a fake social account and a few posts across states.
- `npm test` runs unit + contract; `npm run test:integration` needs a Postgres (Docker or any local instance).
- Conventional commits, ESLint + Prettier, type-check in pre-commit (lightweight; heavy checks in CI).

---

## 18. Deployment strategy

### 18.1 MVP

- One Docker image; two services from it on a PaaS (recommendation: **Railway** or **Fly.io**; Render also fine): `api` (1 instance, HTTP) and `worker` (1 instance). Managed Postgres from the same provider or **Neon**.
- GitHub Actions: `ci.yml` (lint, type-check, unit, integration) on every PR; `deploy.yml` on merge to `main`: build image → run migrations (`drizzle-kit migrate`) as a one-off job → deploy `worker` then `api`.
- Migrations are **expand/contract** (additive first, remove later) so a running worker never breaks mid-deploy.
- Environments: `dev` (local), `staging` (same PaaS, own DB, fake provider by default), `production`.
- Backups: provider's daily automated backups + weekly restore drill in staging.
- Domain: `app.postelyo.com` (api + UI). TLS by the platform.
- Phase 3: the dashboard is a second Fly app built from `apps/web/Dockerfile` (`output: standalone`). It owns the public hostname; `API_INTERNAL_URL` points at the api app's internal address and the api's `APP_BASE_URL` is set to the dashboard's origin so OAuth redirects, invitation links and Stripe return URLs land on the dashboard. The api's own pages remain reachable through the proxy as the operator fallback.

### 18.2 Deploy safety

- `/health/ready` checks DB connectivity and the migration version.
- Worker shutdown handling: on SIGTERM stop taking jobs, finish in-flight publish (≤ 30 s), release leases cleanly; the lease sweeper covers anything missed.
- Feature flags via env/DB for `notion_webhooks`, `provider_mode`.

### 18.3 Later

Kubernetes or ECS are unnecessary until multiple worker pools and regional isolation are needed; the two-role container design ports directly when that day comes.

---

## 19. Observability / logging strategy

- **Structured JSON logs** (pino) with mandatory fields: `ts`, `level`, `service` (`api`/`worker`), `request_id` or `job_id`, `workspace_id`, `publication_id`/`post_id` when relevant, `provider`, `correlation_id` (flows from HTTP request → job → provider call → writeback).
- **Redaction** list applied at the logger: `authorization`, `token`, `access_token`, `refresh_token`, `cookie`, `set-cookie`, Notion `token`, request bodies to OAuth endpoints.
- **Error tracking:** Sentry in both roles, with workspace/publication tags and scrubbing.
- **Metrics** (Prometheus format via `/metrics`, or the PaaS's metrics + a lightweight `stats` table in the MVP):
  - `publications_total{provider,result}`; `publish_latency_seconds{provider}`
  - `scheduler_lag_seconds` (now − scheduled_at at dispatch); `publications_overdue`
  - `jobs_queued{name}`, `jobs_failed{name}`, `jobs_dead_letter{name}`
  - `notion_sync_duration_seconds`, `notion_api_429_total`
  - `social_accounts_needs_reauth`
- **Alerts** (MVP: email only, to the configurable `ALERT_EMAIL` recipient): overdue publications > 15 min, any `ambiguous`, dead-lettered jobs, worker heartbeat missing > 2 min, Notion sync failing > 3 consecutive runs, error rate spike. Slack and per-workspace routing are roadmap items.
- **Lateness metric:** `publish_delay_seconds{provider}` histogram from `delay_seconds`, so "how late were we after the outage" is answerable without reading the audit log.
- **Audit log** doubles as the business-level trace: given a Notion page id you can list every event from sync to writeback.
- **Tracing:** OpenTelemetry SDK wired with a no-op exporter in MVP so spans exist around provider calls, DB transactions and jobs; exporter switched on later (Honeycomb/Grafana Tempo).
- **Retention:** logs 30 days, audit log indefinitely (partition by month later), raw provider responses 30 days (JSONB on `publish_attempt`, pruned by maintenance).

---

## 20. Future SaaS scalability considerations

Designed-in (cheap now, pays later):

| Future need | What the MVP already does | What changes later |
|-------------|---------------------------|--------------------|
| Many tenants | `workspace_id` everywhere, tenant-scoped repositories, per-tenant rate budgets | Postgres RLS; tenant-aware connection routing; dedicated DBs for large tenants. |
| More platforms | `PublishingProvider` interface, registry, contract suite, capability model | Add adapters (X, Instagram Graph, Facebook Pages); media pipeline for video. |
| Native editor / calendar | `ContentSource` interface; `Post` content is a normalized snapshot, not Notion-shaped; `publication` is independent of source | Add `native` content source; UI reads/writes `Post` directly. |
| Approval workflows | `Post` already has `in_review`, `changes_requested`, `ready` (mirrored, unenforced); audit log records every observed transition | Enforce transitions in the native editor, add reviewers and approval policies; no change to publishing. |
| Multiple accounts per platform | `social_account` is N:1 to workspace; publication keyed by account | Platform picker UI; per-account defaults. |
| AI generation/adaptation | `render()` step already separates canonical content from platform variant | Insert an AI adaptation step producing per-publication `content_override`; keep provider adapters ignorant of AI. |
| Analytics | `provider_post_id` stored per publication; audit events | Metrics fetch jobs per provider; `publication_metrics` time series. |
| Media management | `media_asset` referenced by hash; upload step idempotent | Object storage (S3/R2), processing pipeline, library UI. |
| Billing | Workspace-level plan field reserved; usage counted by audit events | Stripe, plan limits enforced in services, not in the DB schema. |
| Public API + webhooks | Services are HTTP-independent; audit events are typed | API keys, `Idempotency-Key`, outbound webhook subscriptions. |
| Throughput | Postgres queue with `SKIP LOCKED`; worker role separate from api | Move queue to Redis/BullMQ or SQS; horizontal worker scaling by job name; partition `audit_log`. |
| Compliance | Encryption at rest, audit trail, data deletion job | SOC 2 controls, data residency (regional deployments of the same image), per-tenant keys. |

Explicitly **not** done in the MVP: microservices, event bus, multi-region, Kubernetes, per-tenant keys, RLS, public API, outbound webhooks, Redis.

---

## 21. Decision log (MVP)

| # | Decision | Alternatives considered | Rationale |
|---|----------|------------------------|-----------|
| D1 | Modular monolith, two process roles | Separate services per concern | Team size, deploy simplicity, clear module boundaries give the same future flexibility. |
| D2 | Postgres as queue (pg-boss) | Redis + BullMQ, SQS | One datastore, transactional enqueue with state change = fewer duplicate-post edge cases. |
| D3 | `publication` as unit of scheduling/idempotency | Post-level jobs | Multi-platform later; per-target retries and results. |
| D4 | Enqueue at due time via scheduler tick, not at schedule time | Delayed jobs created when scheduled | Reschedule/cancel in Notion needs no job deletion; DB stays the schedule of record. |
| D5 | Lease via conditional UPDATE + ambiguous state that fails closed | Optimistic retry on timeout | Duplicate posts are worse than late posts. |
| D6 | Snapshot content at schedule time | Read Notion at publish time | Deterministic, testable, survives Notion outages at publish time. |
| D7 | Two Notion status columns (user `Status`, system `Postelyo Status`) | One shared column | Avoids write conflicts and user confusion. |
| D8 | Polling Notion; webhooks optional | Webhook-first | Correctness never depends on webhook delivery; polling is simple and enough at MVP volume. |
| D9 | App-level envelope encryption with pluggable `KeyProvider` | KMS from day one | No cloud lock-in; KMS is a one-class change. |
| D10 | Better Auth magic link | Clerk/Auth0 | Identity data stays tenant-scoped in our DB; swappable. |
| D11 | TypeScript/Fastify/Drizzle | NestJS, Go, Python | Lightweight, explicit; NestJS acceptable if the team prefers DI conventions. |
| D12 (2026-09-22) | LinkedIn personal profile only in MVP | Member + organization | Product decision P1; avoids Community Management API approval and org-specific code paths. |
| D13 (2026-09-22) | Editorial states mirrored from Notion, not enforced; `Ready` ≠ `Scheduled`; `Ready` never enqueues | Treat `Ready` as schedulable; enforce order in backend | Product decisions P2, P6, P8; Notion cannot enforce transitions, so the backend records and reflects rather than blocks. |
| D14 (2026-09-22) | Late publishing: always publish, record `delay_seconds` | Skip if late; per-workspace policy | Product decision P3; policy option deferred. |
| D15 (2026-09-22) | Text-only and single optional image | Text-only; multi-media | Product decision P4. |
| D16 (2026-09-22) | Email-only notifications with two separate types and recipients (operational → `ALERT_EMAIL`; account notices → connecting admin) | Slack; single address | Product decisions P5, P9; resolver abstraction keeps per-workspace routing a later addition. |
| D17 (2026-09-22) | `Idea` kept in Notion template, mapped to `draft` | Remove `Idea` | Product decision P7. |
| D18 (2026-09-26) | RLS with a permissive-when-unset policy; tenant scope bound per transaction in tenant-facing services; jobs stay in system scope | Scope every query incl. jobs; a separate `SystemScope` role | Jobs legitimately iterate workspaces; the HTTP path is where a forgotten filter would leak, and that path is now covered without rewriting the job layer. |
| D19 (2026-09-26) | Organization flow connects every administered Page; admin disconnects unwanted ones | Picker page holding a pending token | No temporary token storage, no extra state; the Notion `Platforms` option selects the target anyway. |
| D20 (2026-09-26) | Reconciliation resolves only on exactly one fingerprint match in a time window, max 3 checks | Resolve on "any post at that time"; retry after N misses | Duplicate posts remain the top risk; a miss still goes to the operator with the evidence recorded. |
| D21 (2026-09-26) | Daily cap counted from `publication` rows (24 h rolling) rather than a usage table | `account_usage` table | Nothing new to keep consistent; the publication table already holds the facts. |
| D22 (2026-09-26) | Rate limits are waits that keep the attempt budget | Count as attempts; terminal `rate_limit_daily` | A throttled post is not a failed post; waiting up to 24 h then publishing late matches P3. |
| D23 (2026-09-26) | Results for multi-target pages stay in the existing system columns: aggregated `Postelyo Status` (incl. `Partially failed`), one note line per target, optional `Published URLs` | Results child database per page | No extra API calls per sync, no permission friction, additive to v1 databases. |
| D24 (2026-09-26) | Media stored once per workspace and content hash; variants derived per provider spec; local driver served by the api | Store per asset; stream from Notion at publish time | Instagram needs public URLs; hashing dedupes and makes retries cheap; the local driver keeps development Docker-free. |
| D25 (2026-09-26) | Adapters live in the `publishing-core` package, resolved from source in dev/tests (`development` export condition) and from `dist` in production | Keep adapters in the api | Independent contract testing and future external contributions without a build step in the inner loop. |
| D26 (2026-09-26) | Meta connect imports every managed Page and its Instagram account; X connects one profile per callback; any number of accounts per provider | One-per-provider rule | Agencies manage many Pages; the Notion `Platforms` option selects the target. |
| D27 (2026-09-26) | Plan limits live in code and are enforced in services (accounts at connect, members at invite, posts at ingest); Stripe holds prices only | Limits in Stripe metadata; database constraints | Enforcement never needs a Stripe call; a failing limit is a validation error the user can read in Notion or the dashboard. |
| D28 (2026-09-26) | Posts per month are metered from `audit_log` (`publication.state_changed` to `published`, UTC month) | Usage counter table | The audit stream already records every publish exactly once; nothing new to keep consistent. |
| D29 (2026-09-26) | Without a subscription, `workspace.plan` is the source of truth (operator-granted plans); with one, Stripe's state decides and is synced into the column | Always derive from subscriptions | Pilots and partners get comped plans by setting one column; no fake subscriptions. |
| D30 (2026-09-26) | The dashboard is a thin Next.js app calling the api over HTTP with the visitor's cookie; no shared Drizzle access | Shared database package used by both apps | One place enforces tenancy and limits; the web app cannot bypass RLS or plan checks, and the api stays the single deployable that owns data. |
| D31 (2026-09-26) | Workspace deletion is soft delete now, purge by job after 10 minutes, audit anonymised by the FK (`workspace_id` set null) | Immediate hard delete | Cancels in-flight work cleanly, gives a short undo window for operators, keeps the audit trail without tenant attribution. |
| D32 (2026-09-26) | Notion public OAuth creates a pending source (`status = disabled`, no database) that a setup step completes; the pasted-token path stays | Single-step connect requiring a database id up front | Users rarely know a database id; the wizard lists what they shared and creates the template for them. |
| D33 (2026-09-26) | Views ship in a duplicated Notion template page; API-created databases get properties only plus a documented recipe | Generate views through the API | Notion's API cannot create views; the OAuth template duplication is the only automated path. |
| D34 (2026-09-26) | Recurring and evergreen instances are real pages in the content database, linked by `Repeat Of` | Virtual occurrences expanded at schedule time | Instances stay visible in the calendar, editable and cancellable like any page; provenance is a relation plus `parent_post_id`. |
| D35 (2026-09-26) | Source edits reach only future instances whose text fingerprint still matches the generated one | Always overwrite; never propagate | Hand edits are the user's intent; unedited copies should follow the source. |
| D36 (2026-09-26) | First comment is an optional provider capability run after `finish()`, claimed by a conditional update, bounded retries via maintenance | Part of `publish()`; a separate job | Never risks the exactly-once publish path; runs at most once; needs no new queue. |
| D37 (2026-09-26) | Links are rewritten per publication at render time with stable codes per (publication, target); the Notion page is never touched | Rewrite the Notion source; codes per post | Retries are idempotent, per-platform UTM values are possible, and the author's page stays theirs. |
| D38 (2026-09-26) | Approvals are recorded in the dashboard against a text-only fingerprint; Notion mirrors the state; scheduling is refused on mismatch | Notion person property; approve by editing the page | Notion cannot restrict who edits a column, and Postelyo's own writebacks would invalidate an edit-time based check. |
| D39 (2026-09-26) | Companion databases (campaigns, ideas) are synced inside the content sync with merged cursor keys | Separate jobs and tokens | One token read, one schedule, one failure surface; the cursor merge keeps the loops independent. |
