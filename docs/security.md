# Postelyo – Security Model

Status: **Proposed – awaiting approval for Phase 1 (implementation)**
Created: 2026-09-21 · Updated: 2026-09-22 (no conflicts with product decisions P1–P9; notification note added in §7)
Related: [architecture.md](./architecture.md) §4–§6, §12–§13; [domain-model.md](./domain-model.md)

---

## 1. Assets and threat model

### 1.1 What we protect

| Asset | Sensitivity | Where it lives |
|-------|-------------|----------------|
| Social OAuth tokens (LinkedIn) | **Critical** – allow posting as the customer | `social_account.*_token_enc` (ciphertext), worker memory during a call |
| Notion integration tokens | **Critical** – read/write customer content | `content_source.credential_enc` |
| Platform secrets (LinkedIn client secret, master key, DB URL, session secret) | **Critical** | Host secret store → env vars |
| Customer content snapshots | Confidential (pre-publication drafts) | `post.content`, `publish_attempt.response_meta` |
| User identities and sessions | Confidential | `user`, auth tables, cookies |
| Audit log | Integrity-critical | `audit_log` |

### 1.2 Threats considered

| Threat | Primary controls |
|--------|------------------|
| Cross-tenant data access (IDOR, missing scope) | Mandatory `TenantContext`, membership check per route, tenancy test suite, RLS later |
| Token theft via logs, error tracker, Notion write-back, API response, browser | Field redaction, Sentry scrubbing, allow-list of writeback properties, DTOs never include token columns, server-only OAuth |
| Database dump exposure | Envelope encryption; master key outside the DB |
| OAuth CSRF / code injection | Single-use `state` bound to session and workspace, PKCE where supported, exact redirect URI match |
| Session hijack / CSRF on admin actions | `HttpOnly Secure SameSite=Lax` cookies, CSRF token or `Origin` check, session rotation |
| Malicious content from Notion (XSS in admin UI, oversized payloads) | Notion content treated as untrusted: size limits, canonical JSON with closed type set, output encoding in templates, no HTML pass-through |
| Webhook forgery | Signature/verification-token check, per-workspace secret path, events are hints only (polling remains authoritative) |
| Duplicate posting / replay | Lease + state machine + unique constraints (see architecture §9.4) |
| Supply chain | Lockfile, `npm audit` in CI, Dependabot, minimal dependency surface, pinned provider API versions |
| Insider / operator misuse | Credential access audited with reason; no plaintext token viewer; production DB access via break-glass only |
| Abuse of our platform for spam | Per-account daily caps, respect provider limits, no bulk import in MVP |

Out of scope for MVP threat model: nation-state adversaries, hardware attacks, DDoS beyond what the PaaS/CDN absorbs.

---

## 2. Trust boundaries

```
[Browser] --untrusted--> [api] --trusted--> [Postgres]
                            |                   ^
                            | server-to-server  | trusted
                            v                   |
                        [LinkedIn / Notion] <--untrusted/unreliable-- [worker]
```

- The **browser** receives only: session cookie, HTML/JSON views of workspace metadata, `social_account` display fields (`display_name`, `status`, `token_expires_at`), never tokens or raw provider responses.
- The **api** process never calls a social provider's posting API; it only runs OAuth code exchange and Notion schema validation.
- The **worker** is the only place tokens are decrypted. Decryption happens per job, in memory, and the plaintext is not stored on any long-lived object.
- **Provider and Notion responses** are untrusted data: parsed with schemas, truncated before storage, never rendered as HTML.

---

## 3. Authentication and sessions

- Magic-link email sign-in (single-use token, 15-minute expiry, hashed at rest).
- Sessions: opaque id in an `HttpOnly; Secure; SameSite=Lax; Path=/` cookie; server-side record with `user_id`, `expires_at`, `last_seen_at`, user agent hash. 30-day sliding expiry, hard cap 90 days.
- Sign-out deletes the session server-side. Changing email or role invalidates other sessions.
- Rate limits: magic-link requests 5 / 15 min per email and per IP; OAuth start 10 / 15 min per user.
- Google sign-in (roadmap) uses the same session model.
- Phase 3: the dashboard (`apps/web`) runs on the public origin and proxies `/api/auth/*` to the api, so the same cookie serves both; server components forward it on every api call. Invitation links carry a random 256-bit token that is hashed at rest, expires after 7 days, and is single-use; accepting requires a signed-in session, and the invited email is shown but not enforced (the inviter chose the recipient).

---

## 4. Authorization

### 4.1 Model

Role per workspace membership: `owner > admin > editor > viewer`.

| Action | owner | admin | editor | viewer |
|--------|-------|-------|--------|--------|
| Manage workspace settings | ✓ | ✓ | | |
| Connect/disconnect Notion & social accounts | ✓ | ✓ | | |
| Invite/remove members, change roles (owner role only by owners; last owner protected) | ✓ | ✓ | | |
| Manage billing (Checkout, Customer Portal) | ✓ | | | |
| Delete workspace | ✓ | | | |
| View posts/publications | ✓ | ✓ | ✓ | ✓ |
| Retry publication | ✓ | ✓ | ✓ | |
| Create/edit posts natively (roadmap) | ✓ | ✓ | ✓ | |

Sign-up creates an `owner`; invitations create the other roles (Phase 3). Any member may leave except the last owner. Plan limits are a second gate on top of roles: exceeding accounts, members or monthly posts answers `402 plan_limit` or a `PLAN_LIMIT` validation error.

### 4.2 Enforcement

1. Route-level: `requireMembership(minRole)` resolves `{ user, workspace, role }` or returns 404 (not 403, to avoid tenant enumeration).
2. Service-level: every service method takes `TenantContext`; repositories append `WHERE workspace_id = $ctx.workspaceId` automatically; there is no way to construct a query without it except through a clearly named `SystemScope` used only by jobs that iterate workspaces.
3. Object-level: an object id from the URL is fetched **with** the workspace filter; a mismatch yields 404.
4. Defence in depth (Phase 1, done 2026-09-26): Postgres RLS policies, **forced** on every tenant table, keyed on `current_setting('app.workspace_id', true)`. Tenant-facing services bind the setting per transaction through `withTenantScope`; a query inside that scope that forgets its `WHERE workspace_id` returns nothing from other tenants, and an insert or update that would place a row in another tenant fails with `42501`. Background jobs run unscoped (system scope) by design. The application role must be neither superuser nor `BYPASSRLS`; `npm run preflight` fails in production when it is, and the integration suite connects as a restricted role so the policies are actually exercised.

### 4.3 Tenancy tests

An automated suite creates two workspaces with full data and asserts, for every registered route, that workspace A's session gets 404/403 for workspace B's ids. New routes fail CI until covered.

---

## 5. OAuth security (social accounts)

- Authorization Code flow, server-side; PKCE when the provider supports it; `state` = random 256-bit value stored in `oauth_state` with workspace, user, expiry (10 min), single use.
- Callback validates: state exists, not expired, not consumed, the current session's user matches `oauth_state.user_id`; otherwise abort and audit `oauth.state_mismatch`.
- Redirect URIs are registered exactly per environment; no wildcard, no open redirect (`redirect_to` must be a same-origin path).
- Scopes are the minimum needed for posting; the granted scope list is stored. The profile flow asks for `openid profile w_member_social`; the Page flow (Phase 1) adds `r_organization_social w_organization_social rw_organization_admin` and connects only Pages where LinkedIn reports the member as an approved administrator.
- Inbound webhooks (`/webhooks/notion`) are unauthenticated endpoints by nature: every delivery after the one-time verification handshake must carry a valid `X-Notion-Signature` (HMAC-SHA256 over the raw body with `NOTION_WEBHOOK_SECRET`, compared in constant time); payloads are capped at 64 KB; a valid event can only trigger a sync of a page we would poll anyway, never a publish. The verification token is logged once, on purpose, so the operator can configure it; it is the only secret ever written to a log.
- Client secret lives only in the api process environment; the worker does not need it unless refreshing tokens (then it is present there too, never in the UI).
- Disconnect calls the provider's revocation endpoint when one exists, wipes token columns, sets `disconnected_at`, audits.
- Notion public OAuth (Phase 3) uses the same `oauth_state` model (`provider = notion`, `owner=user`); the token exchange authenticates with HTTP Basic client credentials from the api environment. The access token is sealed like any other credential; the pending source has no database until the setup step, and Notion search results are only ever shown to the workspace admin who connected.
- Stripe webhooks (`/webhooks/stripe`, Phase 3) are verified with `Stripe.webhooks.constructEvent` over the raw body and `STRIPE_WEBHOOK_SECRET` (constant-time, 5-minute tolerance); unsigned or badly signed requests get 400. Event ids are inserted into `stripe_event` before processing, so replays are `duplicate`. Handlers never trust the payload for tenancy beyond the `workspaceId` metadata Postelyo itself set on Checkout, resolved through `billing_customer` when absent. Invalid events are recorded and ignored, never retried into a different tenant.

---

## 6. Encryption

### 6.1 In transit

TLS 1.2+ everywhere (browser ↔ api, api/worker ↔ providers, api/worker ↔ Postgres with `sslmode=require`). HSTS on the app domain.

### 6.2 At rest – envelope encryption

```
master keys:  ENCRYPTION_KEYS="k2:<base64 32B>,k1:<base64 32B>"   (first = current)
per row:      DEK = random 32 B
              ciphertext = AES-256-GCM(DEK, plaintext, aad = row_id || column_name)
              wrapped_dek = AES-256-GCM(master[key_id], DEK)
stored:       key_id || wrapped_dek || nonce || ciphertext || tag   (single bytea)
```

- `aad` binds ciphertext to its row and column so values cannot be swapped between rows.
- Rotation: add a new key as first entry; a maintenance job re-wraps DEKs lazily; remove the old key after all rows report the new `key_id`.
- The `KeyProvider` interface has one implementation in the MVP (`EnvKeyProvider`); `KmsKeyProvider` (AWS/GCP/Vault) is a drop-in later.
- Database-level encryption (provider disk encryption) is assumed in addition, not instead.

### 6.3 Access to plaintext

Only through `CredentialVault.withCredential(accountId, reason, fn)`, which decrypts, runs `fn`, and drops the plaintext. Each call writes `audit_log` event `credential.accessed` with `reason` (`publish`, `refresh`, `validate_connection`, `revoke`). Any other path is a code-review blocker.

---

## 7. Secrets handling rules

| Rule | Enforcement |
|------|-------------|
| No secrets in the repository | gitleaks in CI; `.env` git-ignored; `.env.example` has placeholders only |
| No secrets in Docker images | Secrets injected at runtime by the host |
| Fail fast on missing secrets | Zod-validated config at boot |
| No secrets in logs | pino `redact` on `authorization`, `cookie`, `set-cookie`, `*.token`, `*.access_token`, `*.refresh_token`, `*.client_secret`, `*.credential*` |
| No secrets in error tracking | Sentry `beforeSend` scrubber + `sendDefaultPii=false` |
| No secrets in Notion | Writeback uses an allow-list of properties (`Postelyo Status`, `Postelyo Note`, `Published URL`, `Published At`, `Postelyo ID`) with typed values; free text goes through a redaction filter that rejects anything matching token patterns |
| No secrets in URLs | OAuth codes are exchanged immediately and never logged with the query string; access logs strip query strings on `/oauth/*` |
| No secrets in the browser | DTO layer explicitly maps columns; token columns are not selectable by the API repository |
| No secrets or content in notification emails | Operational alert emails carry ids, states and reasons only, never tokens or post content; account-notice emails go only to the connecting admin; the audit event `notification.sent` records the recipient kind, not the address |

---

## 8. Input validation and output encoding

- All HTTP input validated with Zod schemas (body, params, query, headers of interest). Reject unknown keys on mutations.
- Notion content: max 20 000 characters of text per post at ingestion; max 10 media items; unknown block types degraded; canonical JSON has a closed type set.
- Provider responses: parsed with schemas; bodies truncated to 4 KB before storing in `publish_attempt.response_meta`.
- Admin UI templates auto-escape; no `innerHTML`/raw rendering; CSP `default-src 'self'` with nonce for the little inline script that exists.
- File uploads (media) are fetched server-side from Notion's signed URLs or user-provided external links, content-type sniffed from the bytes (declared type and extension are ignored), size-limited (8 MB, enforced while streaming), never executed or served back.
- Media URLs are user-controlled, so the fetcher is an SSRF boundary: only `http(s)`; `localhost`, `.local`/`.internal` hosts and literal private, loopback, link-local and carrier-NAT addresses are refused. DNS-rebinding to a private address is not detected in the MVP (accepted risk; the worker runs in an isolated network segment with no internal services reachable by name). Revisit with an egress proxy or resolved-address pinning before multi-tenant launch.
- Stored media (Phase 2) is served back, but only images that passed sniffing, under content-addressed keys (`ws/<workspace>/<sha256>…`) with a strict key grammar (no `..`, no leading slash) and an immutable cache header. The URLs are unguessable, not secret: anyone holding one can fetch the image, which is what the publishing providers need. Derived variants are produced by `sharp` from the validated original with `failOn: 'error'`; a decode failure fails the publication as a content error rather than crashing the worker. With the S3 driver, objects live in a dedicated bucket the app writes with a scoped key; presigned URLs expire after an hour unless a public base URL is configured.

---

## 9. Audit logging

- Every state transition of `post`, `publication`, `social_account`, `content_source` and every admin action (`workspace.updated`, `membership.*`, `content_source.connected`, `social_account.connected/disconnected`, `publication.retry_requested`) is recorded with actor, timestamp, correlation id and secret-free data.
- Credential access is audited (`credential.accessed`) without values.
- Rows are append-only; the application role has `INSERT` and `SELECT` on `audit_log` but no `UPDATE`/`DELETE` grant.
- Retention: indefinite in MVP; export per workspace on request.

---

## 10. Infrastructure and operations

- Principle of least privilege for the Postgres application role (no superuser, no DDL at runtime; migrations run with a separate role).
- Separate secrets per environment; staging never holds production tokens.
- Production database access only via the PaaS console with MFA; queries against production are logged in a runbook.
- Automated backups; restore drill quarterly; backups contain ciphertext only.
- Dependencies updated weekly (Dependabot); CI blocks on high/critical advisories.
- Health endpoints expose no configuration.
- Rate limiting at the edge for auth and webhook routes; body size limits (1 MB default, 16 MB for webhook/media routes).

---

## 11. Data protection and privacy

- Data collected: user email/name, workspace settings, social account display metadata, content snapshots, publication results, audit trail.
- Data minimisation: only the connected Notion database is read; only properties in the contract are parsed.
- Deletion (built in Phase 3): disconnecting a source or account wipes credentials immediately; deleting a workspace soft-deletes it at once (hidden, API access ends, waiting publications cancelled, sources disabled) and the `workspace-delete` job purges it 10 minutes later: tokens revoked best-effort, the workspace row deleted with cascades, `audit_log.workspace_id` nulled by the FK, and two `workspace.deleted` audit entries (`requested`, `purged`) kept with counts only. See [compliance.md](./compliance.md) for the data inventory and platform checklists.
- Content snapshots are retained for the lifetime of the publication for auditability; a per-workspace retention setting is a roadmap item.
- Provider policies (LinkedIn API Terms, Notion terms) must be reviewed before public launch; the app must display which data it stores.

---

## 12. Security checklist per release

- [ ] `npm audit` clean of high/critical
- [ ] gitleaks clean
- [ ] Tenancy test suite green
- [ ] Redaction test: sample logs and Sentry events from a publish run contain no token-shaped strings
- [ ] OAuth flow manually tested for state reuse and expired state
- [ ] Migration reviewed for new tenant-owned tables having `workspace_id` + index **and an RLS policy** (add the table to `RLS_TABLES` so preflight and the suite check it)
- [ ] New tenant-facing service methods run inside `withTenantScope`
- [ ] New writeback properties reviewed against the allow-list
- [ ] New limit-relevant resources (accounts, members, posts) go through the billing service's capacity checks
- [ ] New Stripe event types handled idempotently and mapped in `stripe_event.outcome`
