# Integrations: public API, webhooks, Zapier and Make

Phase 7 opens Postelyo to other tools. Everything below uses the same services, tenancy rules and audit trail as the dashboard; nothing is a side door.

## 1. Public API

- Base URL: `https://<your-dashboard-origin>/api/v1` (the dashboard proxies `/api/v1/*` to the api process).
- Specification: `GET /api/v1/openapi.json` (OpenAPI 3.1, no auth needed).
- Authentication: `Authorization: Bearer pk_live_…`. Keys are created on **Developers** (admins), carry `read` and/or `write` scopes, may expire, and can be revoked at any time. Only a SHA-256 hash is stored; the secret is shown once.
- Plans: Team, Agency and Enterprise. Keys of a workspace that drops below Team stop working (401) until the plan is restored.
- Rate limit: 60 requests per minute per key (token bucket). Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; over the limit answers `429` with `Retry-After`.
- Idempotency: send `Idempotency-Key: <unique string>` on `POST`/`PATCH`. The first response is stored for 24 hours and replayed (`Idempotent-Replayed: true`); the same key with a different request answers `422 idempotency_mismatch`.
- Errors: RFC 9457 problem documents (`application/problem+json`) with a `code` where useful.

| Method | Path | Scope | What |
|--------|------|-------|------|
| GET | `/workspace` | read | The key's workspace (same DTO as the dashboard, plus `region`) |
| GET | `/posts?state=&since=` | read | Posts with publications, newest updated first (200 max) |
| GET | `/posts/{postId}` | read | One post |
| POST | `/posts` | write | Creates a page in the connected Notion content database (`title`, `body`, `platforms`, `publishAt`, `status` Draft/Scheduled, `note`); the sync turns it into a post within a minute |
| GET | `/publications/{id}` | read | Publication with attempts, links, metrics |
| POST | `/publications/{id}/retry` | write | Retry a failed publication |
| GET | `/campaigns` | read | Campaign mirrors and summaries |
| GET | `/analytics/summary?weeks=` | read | Weekly rollups, top posts, hashtags, best times |
| GET | `/audit?since=&event=&limit=` | read | Recent audit events |
| GET | `/audit/export?from=&to=` | read | NDJSON export (Team+) |
| GET/POST | `/webhooks` | read/write | Endpoints (secret returned once on create) |
| PATCH/DELETE | `/webhooks/{id}` | write | Update or delete |
| GET | `/webhooks/{id}/deliveries` | read | Recent deliveries |
| POST | `/webhooks/{id}/test` | write | Send a `webhook.test` delivery now |

Example, create a draft:

```bash
curl -X POST "$BASE/api/v1/posts" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: zap-8f3c" \
  -d '{"title":"Launch week recap","body":"We shipped…\n\nThanks to everyone.","platforms":["LinkedIn","X"],"publishAt":"2026-10-02T09:00:00+02:00","status":"Scheduled"}'
```

The page appears in Notion like any other row: the team sees it, the sync validates it, and publishing follows the normal rules (approval policy, daily caps, plan limits).

## 2. Outbound webhooks

Webhooks deliver **audit events** (the same events the dashboard log shows) as signed HTTP POSTs.

- Create an endpoint on **Developers** or through `POST /api/v1/webhooks` with an `https` URL and an optional event filter (empty = every deliverable event). Deliveries start from the moment the subscription is created; history is not replayed.
- Deliverable events: `post.created`, `post.state_changed`, `post.archived`, `post.validation_failed`, `publication.created`, `publication.state_changed`, `publication.rescheduled`, `publication.first_comment`, `metrics.fetched`, `approval.granted`, `approval.revoked`, `ai.generated`, `campaign.summary_written`, `social_account.connected`, `social_account.disconnected`, `social_account.status_changed`, `content_source.sync_failed`, `invitation.accepted`, `membership.removed`. Internal events (credential access, billing, operator actions) are never delivered.
- Headers: `X-Postelyo-Event`, `X-Postelyo-Delivery` (id, use it to de-duplicate), `X-Postelyo-Signature: t=<unix seconds>,v1=<hex>`, `User-Agent: Postelyo-Webhooks/1`.
- Body:

```json
{
  "id": "0192…",                  
  "event": "publication.state_changed",
  "occurredAt": "2026-09-28T09:00:03.120Z",
  "workspaceId": "…",
  "entityType": "publication",
  "entityId": "…",
  "fromState": "publishing",
  "toState": "published",
  "actor": { "type": "system", "id": "publish" },
  "data": { "providerPostId": "urn:li:share:…", "url": "https://www.linkedin.com/…" },
  "auditId": "0192…"
}
```

- Verify: `v1 == HMAC_SHA256(secret, "<t>.<raw body>")` (hex) and `|now - t| <= 300 s`. Node example:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

- Retries: a non-2xx response or a 10-second timeout is retried after 1 m, 5 m, 15 m, 1 h, 3 h, 6 h, 12 h and 24 h (8 attempts), then the delivery is marked `dead`. Ten consecutive failures across deliveries disable the endpoint (`webhook.endpoint_disabled` audit event, operator alert); re-enable it on Developers once the receiver is fixed.
- Ordering: deliveries are created in audit order per endpoint but sent independently; use `occurredAt` and `auditId` to order on your side.
- Secrets: the signing secret is shown once; rotate by deleting and re-creating the endpoint. Secrets are envelope-encrypted at rest like every other credential (and under the workspace key when per-tenant keys are enabled).

## 3. Zapier

Build the Zapier app on the public API (Platform CLI or the visual builder). Definitions that fit the API as shipped:

**Authentication**: API key (`Authorization: Bearer {{bundle.authData.api_key}}`); test call `GET /workspace`; connection label from `name`.

**Triggers (REST hooks)** – subscribe with `POST /webhooks` `{ url: bundle.targetUrl, events: [...] }`, unsubscribe with `DELETE /webhooks/{id}`, perform list for samples with `GET /audit?event=<event>&limit=5`:

| Trigger | Events |
|---------|--------|
| New post | `post.created` |
| Post published | `publication.state_changed` with `toState = published` (filter in `perform`) |
| Publication failed | `publication.state_changed` with `toState = failed` |
| Metrics updated | `metrics.fetched` |
| Approval granted | `approval.granted` |
| Campaign summary written | `campaign.summary_written` |
| Account needs attention | `social_account.status_changed` |

**Actions**:

| Action | Call |
|--------|------|
| Create post | `POST /posts` with `Idempotency-Key: {{bundle.meta.zap.id}}-{{bundle.inputData.title}}` |
| Retry publication | `POST /publications/{id}/retry` |

**Searches**: Find post (`GET /posts?state=`), Get publication (`GET /publications/{id}`), List campaigns (`GET /campaigns`).

**Signature check in the perform**: Zapier gives the raw body in `bundle.rawRequest.content`; verify with the secret stored at subscribe time (`bundle.subscribeData.secret`).

## 4. Make (Integromat)

Make apps are declared in JSON. Use the same endpoints:

- **Connection**: API key in a header (`Authorization: Bearer {{parameters.apiKey}}`), verified with `GET /workspace`.
- **Instant triggers (webhooks)**: `attach` = `POST /webhooks` with Make's hook URL and the chosen `events`; `detach` = `DELETE /webhooks/{id}`. Make's webhook module receives the JSON body; add a "verify signature" step with the built-in `sha256` HMAC function on `t + "." + rawBody` if the scenario handles sensitive data.
- **Modules**: Create Post (`POST /posts`, map `Idempotency-Key` to the scenario execution id), Retry Publication, List Posts (`GET /posts`), Get Publication, List Campaigns, Analytics Summary.
- **Searches with pagination**: none needed at the current limits (200 posts per call, newest first; use `since` for incremental scenarios).

## 5. Deferred

Publishing the Zapier and Make apps to their marketplaces (partner review, branding, listing copy) is tracked in the roadmap; the API contract above is what they will be built on and is covered by the phase 7 integration tests.
