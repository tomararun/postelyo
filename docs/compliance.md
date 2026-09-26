# Postelyo – Compliance and Platform Policy Checklist

Status: living document, started with Phase 3 (2026-09-26). Audience: whoever signs off the public launch and whoever answers a customer's data question. Legal wording in the app (`/privacy`, `/terms`) is a **placeholder** until reviewed by counsel; this document tracks what the software actually does so that review has facts to work from.

---

## 1. Data inventory

| Data | Where | Why | Retention |
|------|-------|-----|-----------|
| User email, display name | `user` | Sign-in, invitations, notices | Until the account is deleted (manual today) |
| Session records | `session` | Sign-in state | 30 days sliding, 90 days hard cap |
| Workspace settings, plan, notification addresses | `workspace` | Operate the workspace | Until workspace purge |
| Notion integration token (internal token or OAuth access token) | `content_source.credential_enc`, envelope-encrypted | Read the content database, write results back | Wiped on disconnect; row removed at purge |
| Notion workspace name, bot id, chosen database id | `content_source.config` | Show which Notion workspace is connected; sync | Until purge |
| Social account tokens (LinkedIn, X, Meta) | `social_account.*_token_enc`, envelope-encrypted | Publish on the user's behalf; refresh | Wiped on disconnect; row removed at purge |
| Social account display name, avatar URL, provider id | `social_account` | Show connections; pick targets | Until purge |
| Content snapshots (text, image references) | `post.content`, `media_asset`, `media_object` (object storage) | Publish deterministically; audit what was sent | Post rows until purge; unreferenced media objects pruned after 7 days |
| Publication results and attempts (provider post ids and URLs, error codes) | `publication`, `publish_attempt` | Status, retries, reconciliation | Until purge; `response_meta` pruned |
| Audit trail | `audit_log` | Accountability, metering, security | Indefinite; `workspace_id` is nulled at purge so entries are no longer attributable to a tenant |
| Billing identity | `billing_customer`, `subscription` | Link the Stripe customer and current plan | Until purge (Stripe keeps its own records) |
| Stripe events | `stripe_event` | Webhook idempotency | Ids and types only, no payload |
| Invitations | `invitation` | Team onboarding | Token hash only; expires after 7 days |

Not stored: passwords (magic links only), card data (Stripe Checkout and Customer Portal handle it), Notion content outside the connected database, social platform content other than what Postelyo itself published.

## 2. Deletion and portability

- **Disconnect** (Notion, social account): credentials wiped immediately, provider revocation attempted where an endpoint exists, audited.
- **Workspace deletion** (owner only, dashboard *Danger zone* or `DELETE /v1/workspaces/:id`): the workspace is soft-deleted at once (hidden from every member, API access ends, waiting publications cancelled, sources disabled), then the `workspace-delete` job purges it after a 10-minute delay: tokens revoked best-effort, then the workspace row is deleted and every tenant table cascades. The audit trail keeps two `workspace.deleted` entries (`requested`, `purged`) with counts only, and `workspace_id` becomes null on all of the tenant's audit rows.
- **User deletion**: not self-serve yet. Operators delete the `user` row after the user has left or deleted their workspaces; memberships and sessions cascade. Add to the dashboard when a request arrives (GDPR art. 17 requires acting within a month).
- **Export**: the Notion database is the customer's own copy of their content and results. A JSON export of publications is a roadmap item; until then operators can run the queries in [runbook.md](./runbook.md) §5 on request.

## 3. Sub-processors (to list in the privacy policy)

| Provider | Purpose | Data |
|----------|---------|------|
| Fly.io (or the chosen PaaS) | Hosting, Postgres | Everything above |
| Cloudflare R2 (when `STORAGE_DRIVER=s3`) | Image storage with public URLs | Images the customer chose to publish |
| Stripe | Subscriptions and payments | Owner email, workspace id (as metadata), payment details (never reach Postelyo) |
| Email provider behind `SMTP_URL` | Magic links, invitations, notices | Recipient email, workspace and account names |
| Sentry (when `SENTRY_DSN` is set) | Error tracking | Redacted errors; tokens are never logged |
| Notion, LinkedIn, X, Meta | The platforms the customer connects | Content published on their instruction |

## 4. Platform policy checklist

Review before public launch and after every provider policy update. Each row names the concrete behaviour in Postelyo that satisfies the requirement.

### Notion (public integration)
- [ ] Integration submitted for Notion's public review with the privacy policy and terms URLs (`$APP_BASE_URL/privacy`, `/terms`).
- [x] The user chooses which pages to share during OAuth; Postelyo reads only the connected database (`content_source.external_database_id`) and the pages under it.
- [x] Tokens are encrypted at rest and never written back to Notion or logs.
- [x] Writeback touches only the allow-listed system properties (`Postelyo Status`, `Postelyo Note`, `Published URL(s)`, `Published At`, `Postelyo ID`).
- [x] Disconnect wipes the token; workspace purge removes everything.

### LinkedIn (Marketing Developer Platform)
- [ ] App approved for "Share on LinkedIn" and, for Pages, the Community Management API.
- [x] Only the minimum scopes are requested; the granted list is stored per account.
- [x] Content is published only on explicit user instruction (`Status = Scheduled` with a date) and never modified or reposted automatically.
- [x] Rate limits are honoured with waits, not retries that count as attempts; daily caps per account exist.
- [x] Token expiry notices and re-authorization flow exist; no token is refreshed without the user having consented to the scopes.
- [ ] Display the LinkedIn brand assets per the brand guidelines if a LinkedIn logo is used in the dashboard (currently text only).

### Meta (Facebook Pages, Instagram)
- [ ] App review passed for `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`.
- [ ] Business verification completed.
- [x] Data deletion: the privacy page describes how to delete data; workspace deletion purges Page and Instagram tokens. Meta also requires a **data deletion callback URL** or instructions URL in the app settings: point it at `$APP_BASE_URL/privacy` until a dedicated endpoint exists.
- [x] Images are served from Postelyo-controlled URLs and removed when unreferenced.
- [x] Publishing is one container per Instagram post with status polling; no scraping, no engagement automation.

### X (API v2)
- [ ] Paid API tier active for the posting volume expected; automation rules reviewed (posting on behalf of the authenticated user only, no duplicate or bulk identical content).
- [x] OAuth 2.0 with PKCE; refresh tokens stored encrypted.
- [x] Per-platform text (`X Text`) prevents accidental over-length posts; validation runs before scheduling.

### Stripe
- [x] Checkout and Customer Portal only; no card data reaches Postelyo.
- [x] Webhook signatures verified against the raw body; events deduplicated by id.
- [ ] Tax settings and invoice footer configured in the Stripe dashboard.
- [ ] Terms mention the grace period (14 days after a failed payment) and that limits then fall back to the Free plan.

## 5. Legal documents

| Document | Status | Location |
|----------|--------|----------|
| Privacy policy | Placeholder text, needs counsel review | `apps/web/src/components/legal.tsx`, mirrored in `apps/api/src/http/routes/legal.ts` |
| Terms of service | Placeholder text, needs counsel review | same |
| Data processing agreement (DPA) | Not written. Use a standard controller/processor template with the sub-processor list above and the deletion behaviour in §2. | to do |
| Cookie notice | Only strictly necessary cookies (session); no analytics cookies. A banner is not required for these, state it in the privacy policy. | privacy policy |

## 6. Pre-launch checklist

- [ ] Counsel has reviewed privacy and terms; the placeholder banner is removed from both pages.
- [ ] Sub-processor list matches the deployed configuration.
- [ ] Notion public integration approved; LinkedIn, Meta and X app reviews passed for the scopes in use.
- [ ] Stripe live keys, webhook endpoint and prices configured; test a full upgrade, failed payment, recovery and cancellation in Stripe test mode first.
- [ ] Workspace deletion tested end to end in staging (request, purge job, audit anonymised).
- [ ] Security checklist in [security.md](./security.md) §12 completed for the release.
- [ ] Support address for privacy requests published and monitored.
