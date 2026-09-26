# Postelyo – Operations Runbook

Audience: whoever is on call for the pilot. Assumes access to the Fly.io apps, the Postgres console, the alert mailbox, and an admin login in the affected workspace.

Related: [architecture.md](./architecture.md) §10, §18, §19 · [security.md](./security.md)

---

## 1. System at a glance

| Component | Where | What it does |
|-----------|-------|--------------|
| `api` process | Fly process group `api` | Admin UI, `/v1` endpoints, OAuth callback, `/webhooks/notion`, `/metrics`, worker-heartbeat alert |
| `worker` process | Fly process group `worker` | Notion sync (1 min) and webhook page syncs, scheduler tick (30 s, incl. daily caps), publish and writeback jobs, maintenance (5 min: reconciliation, alerts, token notices, digest, pruning) |
| Postgres | Managed | Everything: domain tables, pg-boss queues, audit log |
| Notion | External | Content source; polled, written back to |
| LinkedIn | External | Publishing target |

Health: `GET /health/live` (process up), `GET /health/ready` (database reachable). Metrics: `GET /metrics` (Bearer `METRICS_TOKEN` when set).

**Truth lives in the database.** Notion shows what the writeback last managed to write; when in doubt, trust the publication row and the audit trail on the publication detail page (`/w/<workspace>/publications/<id>`).

---

## 2. Alerts and what to do

All operational alerts go to `ALERT_EMAIL` and repeat at most once per window while the condition persists. Token-related notices go to the admin who connected the account, not to you.

### `worker.heartbeat_missing` (window 30 min)
No worker has written a heartbeat for over 2 minutes. Nothing is being synced or published.
1. `flyctl status --app <app>`: is the `worker` machine running? `flyctl logs --app <app> --process-group worker`.
2. Common causes: crash loop on boot (bad env var → the process exits with `Invalid environment configuration`), database unreachable, out of memory.
3. Restart: `flyctl machine restart <id>`. Once the worker is back, overdue publications publish automatically and are marked "Published late" (product decision P3). No manual re-scheduling is needed.

### `publication.overdue` (window 1 h)
A publication is still `scheduled` more than 15 minutes after its time.
- If the worker heartbeat is also missing, fix the worker (above).
- Otherwise check the worker logs for `scheduler tick` lines. If ticks run but never dispatch, look for `pg_try_advisory_xact_lock` contention (a stuck transaction) with `select * from pg_locks where locktype = 'advisory'`.

### `publication.stuck_queued` (window 1 h)
Queued for over 10 minutes without a worker taking it. The scheduler re-sends stale jobs on every tick, so this usually means the publish queue consumer is down or pg-boss is unhealthy. Check `select name, state, count(*) from pgboss.job group by 1,2`.

### `publication.ambiguous` (window 6 h)
The provider call ended without a definite answer (timeout, 500, expired lease). **Postelyo will not retry on its own, to avoid a duplicate post.** Before alerting, the maintenance run tries to reconcile automatically: it asks LinkedIn for the account's recent posts and resolves to published only when exactly one post matches the text and time window (up to 3 checks; the alert says how many were made). The audit trail on the publication shows `publication.reconciliation_unresolved` with the reason (`no_match`, `multiple_matches`, `lookup_failed`, `provider_has_no_lookup`).
1. Open the publication detail page. Note the attempt time and the reconciliation reasons.
2. Look at the LinkedIn profile or Page for a post at that time with that text.
3. Found → *Resolve as published* and paste the post URL. Not found → *Resolve as failed*, then *Retry now* if it should still go out.
4. Notion updates itself after the resolution.

### Deferred by daily cap (no alert)
A `scheduled` publication past its time with `last_error_code = daily_cap` is waiting because the account already made `dailyCapPerAccount` posts in the last 24 h (default 100). Notion shows the reason and the resume time; `postelyo_publications_deferred` counts them. Raise the cap with `PATCH /v1/workspaces/:id {"dailyCapPerAccount": N}` if the limit is wrong for that account; the next tick re-evaluates. A LinkedIn 429 is handled the same way in spirit: the row waits in `retry_wait` (`rate_limited`) for the `Retry-After` without spending an attempt.

### `publication.writeback_failed` (window 6 h)
The publication is in its final state but Notion could not be updated after six attempts. The publication itself is fine.
- Check the Connections page for the workspace: the Notion token may be revoked or the page deleted.
- After fixing the connection, set `writeback_state = 'pending'` on the row and send a writeback job, or simply let the editor re-trigger by touching the page; the next sync reconciles.

### `content_source.sync_failed` (window 1 h)
Notion rejected the sync. `status = error` means the token is invalid (401): the workspace admin must paste a new token on the Connections page. Other errors (rate limit, 5xx) clear themselves; if they persist for an hour, check Notion's status page.

### Daily digest (once per ~20 h)
Per-workspace counts of published, failed, needs-review, accounts needing re-auth, sources in error. Informational; act on non-zero failed/needs-review counts using the posts page filters.

---

## 3. Operator actions

| Action | Where | Who may |
|--------|-------|---------|
| Retry a failed publication (new cycle, publishes within a minute) | Posts page → *Retry now*, or `POST /v1/workspaces/:ws/publications/:id/retry` | editor+ |
| Resolve an ambiguous publication | Publication detail → *Resolve*, or `POST …/resolve {outcome, providerPostUrl}` | admin+ |
| Force a Notion sync | Connections → *Sync now*, or `POST /v1/workspaces/:ws/content-sources/:id/sync` | admin+ |
| Reconnect LinkedIn | Connections → *Reconnect* | admin+ |
| Connect or disconnect LinkedIn Pages | Connections → *Connect LinkedIn Pages you administer* / *Disconnect* per Page | admin+ |
| Replace the Notion token | Connections → Notion form | admin+ |
| Change the daily cap or enable webhooks | `PATCH /v1/workspaces/:ws {"dailyCapPerAccount": 50}` / `{"notionWebhooks": true}` | admin+ |
| Enable X, Facebook or Instagram for a workspace | `PATCH /v1/workspaces/:ws {"providers": {"x": true, "facebook": true, "instagram": true}}` (server app credentials must be set too) | admin+ |
| Connect X / Facebook Pages + Instagram | Connections → *Connect X profile* / *Connect Facebook Pages you manage* | admin+ |
| Invite a member, change a role, remove a member | Dashboard → Team, or `POST /v1/workspaces/:ws/invitations {email, role}` / `PATCH .../members/:userId {role}` / `DELETE .../members/:userId` | admin+ (owner role: owners only) |
| Comp a plan (pilot, partner) with no Stripe subscription | `update workspace set plan = 'team' where id = '...'` (any of `free`, `solo`, `team`, `agency`); takes effect immediately, overridden the moment a Stripe subscription exists | operator |
| Upgrade / manage billing | Dashboard → Billing → *Upgrade* (Stripe Checkout) / *Manage billing* (Customer Portal) | owner |
| Route account notices or copy alerts to another address | Dashboard → Settings, or `PATCH /v1/workspaces/:ws {"notificationEmail": "...", "alertCopyEmail": "..."}` (`null` clears) | admin+ |
| Delete a workspace | Dashboard → Settings → *Danger zone* (type DELETE), or `DELETE /v1/workspaces/:ws` → 202; purge runs 10 minutes later | owner |
| Undo a deletion within the 10-minute window | `update workspace set deleted_at = null where id = '...'`; the purge job then reports `skipped`. Cancelled publications stay cancelled (reschedule in Notion) | operator |

Editors retry in Notion by moving `Status` away from `Scheduled` and back, or by editing the post. Postelyo never retries a terminal failure by itself.

---

## 4. Routine procedures

### Deploy
`git push` to `main` deploys **staging** automatically (build → push image → `flyctl deploy` with the migration as release command → smoke check). Production is a manual `workflow_dispatch` with target `production` and requires the environment approval in GitHub. Migrations are expand/contract; never drop a column in the same release that stops writing it.

### Rollback
`flyctl releases --app <app>` then `flyctl deploy --image <previous tag>`. Migrations are additive, so the previous image runs against the newer schema.

### Rotate the credential encryption key
1. Generate: `openssl rand -base64 32`.
2. Set `ENCRYPTION_KEYS="k2:<new>,k1:<old>"` (new first) and redeploy. New credentials use `k2`; old rows still decrypt with `k1`.
3. Re-encrypt existing rows by having admins reconnect, or run the re-wrap job (Phase 1). Remove `k1` only when `select distinct credential_key_id from social_account union select distinct credential_key_id from content_source` shows no `k1`.

### Enable Notion webhooks (optional, lowers sync latency)
1. In the Notion integration settings create a webhook subscription pointing at `$APP_BASE_URL/webhooks/notion` with the page events (`page.properties_updated`, `page.content_updated`, `page.created`, `page.deleted`).
2. Notion posts a one-time `verification_token`; the api logs it at `warn` level ("set NOTION_WEBHOOK_SECRET to this value"). Set the variable, redeploy, then confirm the subscription in Notion.
3. Enable per workspace: `PATCH /v1/workspaces/:ws {"notionWebhooks": true}`. Events for other workspaces are stored as `ignored:webhooks_disabled`.
4. Verify: `select external_event_id, event_type, outcome from webhook_event order by received_at desc limit 20`. Polling continues regardless, so a broken subscription only costs latency.

### Configure the public Notion integration ("Connect with Notion")
1. In Notion's integration settings create a **Public** integration: redirect URI `$APP_BASE_URL/oauth/notion/callback`, capabilities read/update/insert content, privacy and terms URLs `$APP_BASE_URL/privacy` and `/terms`.
2. Set `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` (both or neither) and redeploy. The Connections page then shows *Connect with Notion*; the pasted-token form stays.
3. Until Notion approves the integration only workspaces you own can install it; the token path covers everyone else meanwhile.
4. A source that shows *Notion is connected but not set up yet* is a pending OAuth source (`content_source.status = disabled`, `config.setupPending = true`); the user finishes it at `/w/:ws/setup?source=...`. Disconnecting it discards the token.

### Configure Stripe billing
1. Create the products and monthly prices in Stripe (Solo, Team, Agency, placeholder amounts $19 / $49 / $149) and put the price ids in `STRIPE_PRICE_SOLO`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_AGENCY`. A missing id hides that plan.
2. Add a webhook endpoint `$APP_BASE_URL/webhooks/stripe` with `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`; set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Locally: `stripe listen --forward-to localhost:3000/webhooks/stripe`.
3. Enable the Customer Portal in Stripe (cancel, update payment method, switch plan).
4. Verify with a test card: `select plan, status, grace_until from subscription`, `select id, type, outcome from stripe_event order by received_at desc limit 20`, and `workspace.plan`. Failed payment → `past_due` with a 14-day `grace_until`, then maintenance drops the workspace to Free (`billing.plan_changed` audit event with reason `grace_expired`).
5. Without `STRIPE_SECRET_KEY` billing is read-only (`billingConfigured: false`); in `PROVIDER_MODE=fake` a fake gateway returns `https://checkout.stripe.test/...` URLs for development.

### Run the dashboard
`apps/web` listens on 3001 (`npm run dev:web`) and proxies auth, `/v1`, OAuth callbacks, webhooks and media to `API_INTERNAL_URL` (default `http://localhost:3000`). When the dashboard fronts the api, set the api's `APP_BASE_URL` to the dashboard origin so OAuth redirect URIs, invitation links and Stripe return URLs point at it. In production it is a separate Fly app built from `apps/web/Dockerfile`.

### Media storage
Images are stored once per workspace and content hash. With `STORAGE_DRIVER=local` the api serves them at `/media/<key>` from `STORAGE_LOCAL_DIR` (single instance only; the worker and api must share the directory or the volume). In production use `s3` with Cloudflare R2 and a public custom domain (`S3_PUBLIC_BASE_URL`), because Instagram and Facebook fetch the image by URL. Maintenance deletes objects no asset references for 7 days (`mediaPruned` in the maintenance log). A publication failing with "Image could not be prepared" means the variant derivation failed: check the worker log for the `sharp` error and the original file in storage.

### Database role for the application
The app must connect as a role that is **not** a superuser and does not have `BYPASSRLS`; otherwise row-level security is silently inactive (preflight reports `database role`). Migrations may run as the owner. On Fly Postgres, create a dedicated role and grant it the schema privileges (see `test/integration/global-setup.ts` for the exact grants used by the suite). The local docker-compose user is a superuser; preflight warns about it in development.

### Rotate `AUTH_SECRET`
Changing it invalidates outstanding magic links and cookie signatures; sessions stored in the database survive. Do it during low usage.

### Backup and restore drill (quarterly)
Restore the latest Fly Postgres snapshot into a scratch database, point a local api at it (`DATABASE_URL`), sign in, and open a workspace's posts page. Record the date in this file.

### Prune history
Audit rows are kept indefinitely. `publish_attempt.response_meta` and `pgboss` completed jobs are pruned automatically (24 h for jobs). Nothing else needs manual cleanup at pilot volume.

---

## 5. Reading the database

```sql
-- publications by state
select state, count(*) from publication group by 1 order by 2 desc;

-- what happened to one publication
select occurred_at, event, from_state, to_state, actor_type, actor_id, data
from audit_log where entity_type = 'publication' and entity_id = '<id>' order by occurred_at;

-- accounts that need attention
select workspace_id, display_name, status, token_expires_at from social_account
where disconnected_at is null and status <> 'active';

-- sources failing to sync
select workspace_id, external_database_title, status, last_error, last_sync_at from content_source
where last_error is not null and disconnected_at is null;

-- worker liveness
select instance_id, version, started_at, last_seen_at from worker_heartbeat order by last_seen_at desc;
```

Never `select access_token_enc` for any reason other than confirming it is null or ciphertext; there is no supported way to read a token in plaintext outside the worker.

---

## 6. Environment variables

| Variable | Role | Notes |
|----------|------|-------|
| `DATABASE_URL` | both | `sslmode=require` in production |
| `AUTH_SECRET` | api | ≥ 32 chars |
| `ENCRYPTION_KEYS` | both | `id:base64,...`, first is current |
| `APP_BASE_URL` | both | https in production; also the OAuth redirect origin |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | api (worker only for refresh) | both or neither |
| `MAIL_TRANSPORT` / `SMTP_URL` / `MAIL_FROM` | both | `smtp` in production |
| `ALERT_EMAIL` | both | operational alerts (P5); required in production |
| `PROVIDER_MODE` | both | `live` in staging/production; `fake` never publishes |
| `METRICS_TOKEN` | api | protects `/metrics` |
| `NOTION_WEBHOOK_SECRET` | api | Notion webhook verification token; unset = inbound webhooks ignored |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | both | X OAuth 2.0 app (confidential client); worker refreshes tokens. Both or neither |
| `META_APP_ID` / `META_APP_SECRET` | api | Meta app for Facebook Pages and Instagram. Both or neither |
| `STORAGE_DRIVER` | both | `local` (files under `STORAGE_LOCAL_DIR`, served at `/media/*`) or `s3` |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_PUBLIC_BASE_URL` | both | Required for `s3`; R2: endpoint `https://<account>.r2.cloudflarestorage.com`, region `auto`, public base URL = the bucket's custom domain |
| `APP_VERSION` | both | set by the deploy pipeline; shown in heartbeats |
| `INSTANCE_ID` | worker | defaults to hostname-pid |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` | api | Public Notion integration for *Connect with Notion*; both or neither |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | api (the worker only reads the database for grace expiry) | Webhook secret is required with the key |
| `STRIPE_PRICE_SOLO` / `STRIPE_PRICE_TEAM` / `STRIPE_PRICE_AGENCY` | api | Stripe price ids; a missing one hides the plan |
| `API_INTERNAL_URL` | web | Where the dashboard proxies to (api's internal address) |
