# Postelyo – Product Roadmap and Build Prompts

Audience: the product owner planning the next phases, and whoever (human or AI agent) executes them.

Date: 2026-09-26 · Related: [roadmap.md](./roadmap.md) (engineering milestones to date), [architecture.md](./architecture.md), [product-requirements.md](./product-requirements.md)

---

## The direction

Postelyo becomes **the content hub that lives in Notion**: teams plan, write, review and approve in Notion; Postelyo turns that into scheduled, adapted, published posts across social platforms, and writes results and analytics back into Notion. Postelyo's own UI is a thin control plane (connections, billing, monitoring, operator tools), not a second editor.

Why this direction and not a native editor:

- Notion already gives teams views, calendars, comments, permissions, templates and mobile. Rebuilding that is a multi-year effort with no moat.
- The differentiation is the pipeline: reliable, exactly-once, multi-platform publishing with per-platform adaptation and analytics that land where the team already works.
- The architecture built in Phase 0 already treats Notion as one `ContentSource` behind an interface. Nothing prevents a native editor later if a segment demands it.

Guiding rules for every phase:

1. Never ship a phase without the previous one's acceptance criteria met.
2. Every platform goes behind the existing `PublishingProvider` contract and passes the contract test suite before it is enabled for customers.
3. Every Notion-facing change is additive: new optional properties, warnings before errors, never a breaking template change without a migration note.
4. Zero duplicate posts remains the top non-functional requirement; anything ambiguous fails closed.

---

## Phase map

| Phase | Name | Outcome | Rough size |
|-------|------|---------|-----------|
| 0 | MVP (done) | Notion → LinkedIn personal profile, exactly-once, ops tooling | done |
| 1 | Pilot and hardening | One real team publishes for 30 days; rough edges fixed; LinkedIn pages | 3–5 weeks incl. pilot |
| 2 | Multi-platform core | X, Facebook Pages, Instagram; per-platform text in Notion; multiple accounts; media hosting | 6–8 weeks |
| 3 | Self-serve SaaS | Public Notion OAuth, onboarding, teams and roles, billing, control-plane dashboard | 6–8 weeks |
| 4 | Content operations in Notion | Campaigns, recurring posts, first comments, links/UTM, approval enforcement, ideas | 4–6 weeks |
| 5 | Analytics back into Notion | Per-post metrics, weekly reports, workspace analytics database | 4–5 weeks |
| 6 | AI assistance | Platform adaptation, drafts from ideas, repurposing, alt text, all human-approved | 4–6 weeks |
| 7 | Scale, integrations and enterprise | Public API and webhooks, Zapier/Make, RLS, per-tenant keys, SSO, audit export | ongoing |

Decision points between phases are listed at the end.

---

## How to use the prompts

Each phase below ends with a prompt. They are written for the working style used so far: the agent investigates, proposes, waits for approval, then implements with tests and reports verification results. Paste one prompt per phase. Replace bracketed values. Keep the "Before you start" and "Before you finish" blocks; they are what keeps quality consistent across phases.

Common preamble to paste before any phase prompt:

```
You are the lead engineer on Postelyo (repo at E:\postelyo\postelyo). Read docs/architecture.md,
docs/product-requirements.md, docs/domain-model.md, docs/roadmap.md and docs/product-roadmap.md first.
Follow the existing conventions: TypeScript, Fastify, Drizzle, pg-boss, Better Auth, Vitest with the
embedded-Postgres integration suite, provider adapters behind the PublishingProvider contract, tenant
context on every service, audit rows for every state change, no secrets in logs, Notion, DTOs or Sentry.

Before you start: list the files you will add or change, any schema changes, new env vars, new external
API assumptions to verify, and any conflict with the approved architecture. Wait for my approval.
Before you finish: run typecheck, lint, format check, unit and integration tests, and generate migrations;
update docs (architecture, domain model, runbook, setup guide, roadmap status) and report what was
verified and what was not.
```

---

## Phase 1 – Pilot and hardening

**Status (2026-09-26).** Items 2–7 of the prompt are built and tested (organization pages, webhooks, reconciliation, caps and rate limits, RLS; see [roadmap.md](./roadmap.md) Phase 1 for details). Item 1, the pilot findings, waits for the live pilot. Organization posting and the post-lookup finder are implemented against LinkedIn's documented API and must be verified live once the app has Community Management API access.

**Goal.** Prove the core with a real team, then remove everything that made the pilot awkward.

**Scope.**
- Run the pilot per `docs/pilot-checklist.md`; log every manual intervention.
- LinkedIn organization pages (needs Community Management API approval; start the application on day one).
- Notion webhooks as a latency improvement, polling stays authoritative.
- Reconciliation for `ambiguous` outcomes via `lookupRecent` so most never need a human.
- Token refresh where LinkedIn grants programmatic refresh; otherwise smoother re-auth reminders.
- Rate-limit awareness per account and per app (LinkedIn daily caps) with clear Notion messages.
- Fixes from pilot feedback; usually validation wording, time-zone confusion, template friction.
- Postgres row-level security as a second tenancy defence.

**Acceptance.** 30 pilot days with zero duplicates; organization page publishing verified live; at least 80 % of ambiguous outcomes auto-reconciled in staging fault tests; RLS enabled with the tenancy suite still green.

**Risks.** LinkedIn approval time; API version drift. Mitigation: apply early, keep the version pin and contract tests.

**Prompt.**
```
Phase 1: pilot hardening.
1. Read the pilot log I paste below and group findings by cause. [paste findings]
2. Propose fixes ordered by pilot impact; implement the approved ones.
3. Add LinkedIn organization-page publishing: account_type=organization, org scopes, author URN,
   organization picker on the Connections page, `Platforms` option "LinkedIn Page" in the Notion
   template (additive), contract tests with recorded fixtures.
4. Add Notion integration webhooks: verified endpoint, webhook_event table, enqueue a sync-page job,
   polling unchanged. Feature-flag it per workspace.
5. Implement reconciliation for ambiguous publications using lookupRecent on providers that support
   it, with a content-hash and time-window match; only auto-resolve on an unambiguous single match.
6. Add per-account daily caps and 429-aware scheduling; write a clear Notion note when a post is
   deferred by a cap.
7. Enable Postgres RLS with app.workspace_id set per transaction; keep repositories as the first line.
Do not add new platforms in this phase.
```

---

## Phase 2 – Multi-platform core

**Status (2026-09-26).** Built and tested end to end against fakes: the `publishing-core` package, object storage and the media pipeline, the Notion contract extension with column-based results (the child-database alternative was not chosen), the X, Facebook Pages and Instagram adapters behind per-workspace flags, multiple accounts per provider, and one publication per target with an aggregated writeback. Details in [roadmap.md](./roadmap.md) Phase 2. Not verified live: X needs a paid API tier and app keys; Facebook and Instagram need Meta app review; production storage needs R2 credentials.

**Goal.** One Notion page becomes several platform posts, each adapted, each independently tracked.

**Platform order and why.**
1. **X**: simple text API, but paid tiers and low free limits; validate willingness to pay before building. 280 characters, threads later.
2. **Facebook Pages**: needs a Facebook app review for `pages_manage_posts`; images by URL.
3. **Instagram**: Business/Creator account linked to a Facebook Page; images must be publicly reachable URLs, so this phase adds **object storage** (S3/R2) and a media pipeline; two-step container publish.
4. Cheap wins after those, if customers ask: Threads, Bluesky, Mastodon (open APIs, low approval friction).

**Notion model for variants.** Keep one page per post. Add optional per-platform properties (`LinkedIn Text`, `X Text`, `Instagram Caption`, `Facebook Text`) that override the body for that platform, plus `Platforms` multi-select expanded. Per-platform status and URL columns become one `Postelyo Status` column plus a **Results** child database or a rich text summary per platform, decided by user testing in the pilot team.

**Scope.**
- `packages/` split: extract `PublishingProvider` and content types into a package so adapters are independently testable and, later, third-party contributable.
- Adapters for X, Facebook Pages, Instagram; contract suite green for each; recorded fixtures.
- Media pipeline: fetch → validate → store in object storage → per-platform transforms (size, aspect) → public URL with expiry; provider refs cached by hash as today.
- Multiple accounts per platform per workspace; `Platforms` values map to specific accounts; an account picker property or naming convention (`X: @handle`).
- Per-platform validation surfaced per platform in Notion before scheduled time.
- Post-level view in Postelyo showing all publications of a page.

**Acceptance.** A page with three platforms selected publishes to all three with platform-specific text; one failure does not block the others; results per platform visible in Notion; contract suite covers every adapter; media works for Instagram from a Notion-hosted file.

**Risks.** App reviews (Meta), X pricing, image hosting cost. Mitigation: start reviews at phase start; make each platform a feature flag per workspace.

**Prompt.**
```
Phase 2: multi-platform core.
1. Extract the publishing contract and canonical content types into packages/publishing-core with the
   contract test suite; the api depends on it. No behaviour change; all tests green.
2. Add object storage (S3-compatible; R2 in production, MinIO locally in docker-compose) and a media
   pipeline: fetch, validate, store by content hash, per-platform derived variants, signed or public URLs
   with expiry, cleanup job. Keep the existing inspection-at-sync behaviour.
3. Extend the Notion contract additively: optional per-platform text properties [list], Platforms
   options for each new platform and for multiple accounts ("X: @handle" convention), and a per-platform
   results representation [choose: results child database or per-platform columns; propose with pros/cons].
4. Implement adapters in this order, each behind a per-workspace feature flag and fully covered by the
   contract suite with recorded fixtures: X (text + single image), Facebook Pages (text + image),
   Instagram (single image via container publish). Document every external API assumption to verify.
5. Support multiple social accounts per provider per workspace, with the account picker on Connections
   and account resolution in ingest.
6. Update ingest so one page yields one publication per selected account; failures are independent.
Do not implement analytics or AI in this phase.
```

---

## Phase 3 – Self-serve SaaS (built 2026-09-26)

**Status.** Built and tested against fakes: Notion public OAuth with the setup wizard, teams, Stripe billing with plan limits (placeholder prices), the `apps/web` dashboard, notification settings, workspace deletion and the compliance checklist. Pending outside the code: Notion public integration review, Stripe live configuration and real prices, counsel review of privacy/terms. Details in [roadmap.md](./roadmap.md) Phase 3 and [compliance.md](./compliance.md).

**Goal.** A stranger can sign up, connect Notion and their socials, and pay, without talking to us.

**Scope.**
- Public Notion OAuth integration (replaces pasted tokens; keeps the internal-token path for power users).
- Onboarding wizard: sign in → create workspace → connect Notion (one click, auto-creates the template in a chosen page) → connect socials → schedule a test post.
- Teams: invitations by email, roles enforced (owner/admin/editor/viewer already modelled), workspace switching.
- Billing with Stripe: plans (e.g. Solo, Team, Agency), limits on connected accounts, posts per month, workspaces; grace periods; usage metering from audit events; customer portal.
- Control-plane dashboard as `apps/web` (Next.js, Tailwind, shadcn/ui): connections, team, billing, posts overview, publication detail, notifications settings. The Fastify pages stay as operator fallback until parity, then retire.
- Per-workspace notification settings (alert routing stays separate from account notices).
- Legal and trust: privacy policy, terms, data deletion job, DPA template, platform policy compliance review.

**Acceptance.** Ten external sign-ups complete onboarding unaided; a paid plan limit is enforced and upgradable; team invitation flow works with role-appropriate UI; dashboard has parity with the operator pages.

**Risks.** Stripe edge cases (proration, failed payments), Notion public integration review. Mitigation: use Stripe Checkout and Customer Portal, not custom billing UI.

**Prompt.**
```
Phase 3: self-serve SaaS.
1. Public Notion OAuth integration alongside the internal token path; onboarding wizard that creates the
   template database in a chosen page automatically.
2. Team invitations (email, expiring links), role enforcement across API and pages, workspace switching.
3. Stripe billing: plans and limits [list plans], Checkout and Customer Portal, webhook handling with
   idempotency, plan limits enforced in services (not schema), usage metered from audit events, grace
   period behaviour, downgrade rules. Add billing tables and a per-workspace plan snapshot.
4. apps/web: Next.js App Router + Tailwind + shadcn/ui control-plane dashboard sharing the Drizzle schema
   and Better Auth session through packages/; pages: connections, team, billing, posts, publication
   detail, notification settings. Reuse the existing tenant-scoped services via the API; no duplicated
   business logic. Keep it simple; we are validating flows, not visual polish.
5. Per-workspace notification settings; alert routing and account notices remain separate.
6. Data deletion job, privacy/terms pages, and a compliance checklist for LinkedIn, Meta and X policies.
Do not build a native content editor.
```

---

## Phase 4 – Content operations in Notion (built 2026-09-26)

**Status.** Built and tested against fakes: template v2 with Campaigns and Ideas databases, campaign summaries, recurring and evergreen series, first comments, UTM presets and short links, opt-in approval enforcement, idea promotion. Views ship through the duplicated Notion template (the API cannot create them). Deferred: best-time suggestions (Phase 5), CSV import (Notion-native), Bitly. Details in [roadmap.md](./roadmap.md) Phase 4 and [notion-template.md](./notion-template.md).

**Goal.** The Notion database becomes a full content calendar and operations hub without leaving Notion.

**Scope.**
- Template v2 with Notion views shipped as part of the template: Calendar, Kanban by Status, per-platform views, "Needs attention" view.
- Campaigns: a `Campaigns` database related to posts; campaign-level summary written back (scheduled/published counts).
- Recurring and evergreen posts: `Repeat` property (weekly, monthly, custom) generating child instances; evergreen pool with re-share rules and minimum gaps.
- First comment for LinkedIn/Instagram/X (`First Comment` property).
- Link handling: UTM templates per workspace, optional short links with click counts (own domain or Bitly).
- Approval enforcement as an opt-in workspace policy: required reviewers, `Ready` only settable by reviewers (enforced by Postelyo refusing to schedule pages without an approval record, since Notion cannot enforce), approval audit.
- Content ideas: `Ideas` database with one-click promotion to a draft post.
- Best-time suggestions from historical analytics (after Phase 5) or platform defaults; `Publish Date` helper.
- Bulk operations: CSV import into Notion, bulk reschedule guardrails.

**Acceptance.** A team runs a month-long campaign end to end in Notion with recurring posts, first comments and UTM links, and every derived post is traceable to its source page.

**Prompt.**
```
Phase 4: content operations in Notion.
1. Ship template v2: additive properties [Campaign relation, Repeat, First Comment, Link UTM preset,
   Approval] and predefined Notion views; a migration note for v1 databases; validation treats new
   properties as optional with warnings.
2. Campaigns database with relation and campaign summaries written back on a schedule.
3. Recurring posts: Repeat rules generate publications with clear provenance; edits to the source
   propagate only to future instances; evergreen pool with minimum gap rules.
4. First comment per platform where the API supports it; add to the provider contract as optional.
5. UTM presets per workspace and optional short links with click tracking; links rewritten at render
   time, never in the Notion source.
6. Opt-in approval enforcement: reviewers per workspace, approval records, scheduling refused without
   approval; keep the default unenforced behaviour for existing workspaces.
7. Ideas database with promotion to draft.
Keep every change additive to the Notion contract; document the v1→v2 upgrade path.
```

---

## Phase 5 – Analytics back into Notion

**Goal.** Results live next to the content: every post page shows how it performed, and the team gets a weekly picture.

**Scope.**
- Metrics fetch jobs per provider (impressions, reactions, comments, shares, clicks, saves where available) on a decaying schedule (1h, 6h, 24h, 7d, 30d after publish).
- Write-back to per-post properties (or the Results child database from Phase 2) plus an `Analytics` rollup database per workspace (per week, per platform, per campaign).
- Weekly report email per workspace with top posts, totals, and comparisons.
- Dashboard charts in the control plane (Phase 3 web app).
- Best-time suggestions and hashtag performance derived from history.
- Data model: `publication_metric` time series, retention policy, backfill for existing published posts.

**Acceptance.** A published post shows metrics in Notion within 24 hours; weekly report matches platform dashboards within provider-documented tolerances; no metrics job ever affects publishing throughput (separate queue).

**Prompt.**
```
Phase 5: analytics into Notion.
1. Add publication_metric time series and a metrics job queue separate from publishing; per-provider
   metric adapters added to the provider contract as an optional capability with a contract test.
2. Decaying fetch schedule; provider rate-limit budgets; backfill for existing published posts.
3. Write-back: per-post metric properties (additive to the template) and a workspace Analytics
   database with weekly/platform/campaign rollups; idempotent upserts.
4. Weekly report email per workspace; opt-out per user.
5. Control-plane charts (reuse the dataviz guidance); best-time and hashtag insights derived from
   history, shown as suggestions only.
Document every provider metric field and its refresh limits.
```

---

## Phase 6 – AI assistance

**Goal.** AI does the tedious adaptation and drafting inside the Notion workflow; humans keep control.

**Scope.**
- Platform adaptation: from the page body, generate per-platform variants into the per-platform properties (Phase 2) as suggestions, marked with a `Postelyo AI` note; never overwrite human-written variants.
- Drafts from ideas: turn an `Ideas` entry plus workspace voice guidelines into a draft page.
- Repurposing: long post → thread/carousel outline → short variants.
- Alt text for images; hashtag and mention suggestions informed by Phase 5 analytics.
- Guardrails: brand voice document per workspace, banned phrases, length limits, mandatory human approval before scheduling AI-generated content, full prompt/response audit, per-workspace token budget and cost display, provider abstraction (Claude by default, model configurable).
- Trigger via Notion: a checkbox property (`Generate variants`) or a button-like status, processed by the sync loop.

**Acceptance.** Editors accept at least half of AI variants without edits in a two-week trial; no AI content is ever published without a human setting `Scheduled`; cost per workspace is visible and capped.

**Prompt.**
```
Phase 6: AI assistance.
1. Add an AI service with a provider abstraction (Anthropic Claude default; read the claude-api skill
   before choosing models and parameters), per-workspace budgets, cost accounting, and a prompt/response
   audit table that stores no secrets.
2. Platform adaptation triggered from Notion (checkbox/status), writing suggestions into the per-platform
   properties without overwriting human text; brand-voice and banned-phrase guardrails per workspace.
3. Drafts from Ideas and repurposing flows; alt-text generation for media at inspection time.
4. Hashtag and timing suggestions using Phase 5 data.
5. Enforce: AI output is never scheduled automatically; approval enforcement (Phase 4) applies.
Ship behind a per-workspace flag and a plan entitlement.
```

---

## Phase 7 – Scale, integrations and enterprise

**Goal.** Postelyo runs for thousands of workspaces and fits into customers' other tools.

**Scope.**
- Public REST API with API keys and `Idempotency-Key`; outbound webhooks from the audit stream with HMAC signatures and retries; Zapier and Make apps; OpenAPI published.
- Queue move to Redis/BullMQ or SQS when Postgres queue metrics say so; horizontal workers per job type; audit partitioning; read replicas for analytics.
- Security and compliance: per-tenant encryption keys, SSO (SAML/OIDC) for enterprise plans, audit export, SOC 2 readiness, data residency (EU/US deployments of the same image), egress proxy for media fetching.
- Reliability: multi-region failover plan, restore drills automated, chaos tests for the publishing engine.
- Marketplace presence: Notion template gallery listing, LinkedIn/Meta partner programs where available.

**Prompt.**
```
Phase 7: scale, integrations and enterprise.
1. Public API v1 with API keys, scopes, rate limits and Idempotency-Key; OpenAPI spec published;
   outbound webhooks with signatures, retries and per-endpoint circuit breakers, built on audit events.
2. Zapier and Make integrations using the public API.
3. Queue and worker scale-out plan with measured thresholds; implement the switch only if metrics
   justify it; partition audit_log by month.
4. Enterprise security: per-tenant data keys via the KeyProvider abstraction, SSO, audit export,
   egress proxy for media fetch, SOC 2 control mapping document.
5. Regional deployment option using the same image; documented failover and restore drills.
Each item behind a plan entitlement; nothing changes behaviour for existing plans by default.
```

---

## Decision points

1. **After Phase 1 (pilot).** Did the team want more platforms, or a better UI? Platforms → Phase 2 as planned. UI → bring the control-plane dashboard forward from Phase 3, still not an editor.
2. **Before X in Phase 2.** Confirm at least three prospects will pay a plan that covers X API costs; otherwise start with Facebook/Instagram or the open platforms.
3. **Before Phase 3 billing.** Pick pricing from pilot usage data: accounts connected and posts per month are the two natural meters.
4. **Native editor or not (any time).** Only if a paying segment cannot use Notion. The `ContentSource` interface and canonical content format are ready; it would be its own phase, not a rewrite.
5. **Queue migration (Phase 7).** Only when sustained load exceeds the thresholds recorded in `architecture.md` §20.

---

## What stays true in every phase

- The Notion template is versioned and additive; validation warns before it errors.
- Every provider is an adapter that passes the contract suite; no provider logic leaks into the engine.
- Exactly-once publishing: lease, ambiguous-fails-closed, operator resolution, reconciliation.
- Tenant context on every query; tests that prove cross-tenant 404s for every new route.
- Alerts and account notices stay separate; the runbook gains a section for every new alert.
- Docs are updated in the same change as the code; roadmap status columns are kept current.
