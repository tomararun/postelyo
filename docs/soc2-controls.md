# SOC 2 readiness: control mapping

Phase 7 deliverable. This maps the Trust Services Criteria (Security, Availability, Confidentiality, Processing Integrity, Privacy) to what Postelyo already does, where the evidence lives, and what is still a manual or organisational control. It is a readiness map, not an attestation: an auditor and a written policy set are still needed.

Legend: **Implemented** = enforced by code or configuration in this repository; **Operational** = a documented procedure someone runs; **Gap** = not yet in place.

## Security (common criteria)

| Criteria | Control | Status | Evidence |
|----------|---------|--------|----------|
| CC1 Control environment | Roles per workspace (owner/admin/editor/viewer), least privilege in the API (`requireMembership`, scopes on API keys) | Implemented | `apps/api/src/http/plugins/tenancy.ts`, `api-key.ts`; auth-tenancy and phase7 tests |
| CC2 Communication | Security model, runbook and compliance docs versioned with the code | Implemented | `docs/security.md`, `docs/runbook.md`, `docs/compliance.md` |
| CC3 Risk assessment | Threat model listing assets and threats considered | Operational | `docs/security.md` §1; review each phase |
| CC5 Control activities | CI runs lint, typecheck, unit and integration suites (including RLS, tenancy, chaos) on every change; deploys run migrations first | Implemented | `.github/workflows/ci.yml`, `deploy.yml`, `deploy/fly.toml` release command |
| CC6.1 Logical access | Magic-link sign-in, server-side sessions, HttpOnly cookies; OIDC SSO per workspace domain (Enterprise) with PKCE, nonce and domain enforcement | Implemented | `modules/auth/auth.ts`, `modules/enterprise/sso.service.ts`, phase7 tests |
| CC6.1 Tenant isolation | `workspace_id` on every tenant table, Postgres row-level security forced on all of them, tenant-scoped transactions | Implemented | `infra/db/tenant-scope.ts`, migrations, `rls.test.ts`, preflight check |
| CC6.1 Secrets at rest | Envelope encryption (AES-256-GCM, per-row DEK, master key ids), optional per-workspace keys with rotation | Implemented | `infra/crypto/*`, `modules/enterprise/tenant-key.service.ts` |
| CC6.1 Secret access | Only through `CredentialVault.withCredential`, every access audited with a reason | Implemented | `credential-vault.ts`; `credential.accessed` audit rows |
| CC6.2/6.3 Provisioning and removal | Invitations with hashed tokens and expiry, role changes and removals audited; API keys revocable; SSO default role | Implemented | `invitation.service.ts`, `api-key.service.ts` |
| CC6.6 Boundaries | HTTPS only, HSTS, Helmet headers, Origin/Sec-Fetch-Site checks on browser posts, SSRF guard on media fetches, optional fixed egress proxy | Implemented | `http/app.ts`, `plugins/auth.ts`, `media-fetcher.ts`, `infra/egress.ts` |
| CC6.7 Data in transit | TLS to browser, providers and Postgres (`sslmode=require`) | Operational | Hosting configuration; `docs/security.md` §6.1 |
| CC6.8 Malicious software | Immutable container images, dependency audit in CI, no runtime package installs | Operational | Dockerfiles, CI |
| CC7.1 Monitoring | Prometheus gauges (`/metrics`) including queue depth and age, worker heartbeat, structured logs with redaction, Sentry | Implemented | `modules/ops/metrics.service.ts`, `queue-health.service.ts` |
| CC7.2 Anomaly detection | Alerts: overdue/stuck publications, sync failures, heartbeat missing, webhook endpoint disabled, queue saturated; daily digest | Implemented | `modules/ops/alerts.service.ts` |
| CC7.3/7.4 Incident response | Runbook procedures per alert kind, correlation ids end to end | Operational | `docs/runbook.md` |
| CC7.5 Recovery | Restore drill script with row-count verification; documented failover plan | Implemented + Operational | `apps/api/src/tools/restore-drill.ts`, runbook "Restore drill" and "Regional failover" |
| CC8.1 Change management | Docs-first phases with decision log, code review, CI gates, expand/contract migrations | Operational | `docs/architecture.md` §21, git history |
| CC9.2 Vendor management | Sub-processor list with purpose and data | Operational | `docs/compliance.md` §3 |

## Availability

| Criteria | Control | Status | Evidence |
|----------|---------|--------|----------|
| A1.1 Capacity | Queue depth/age gauges with thresholds that trigger the scale-out plan | Implemented | `queue-health.service.ts`, architecture §20 |
| A1.2 Backups and recovery | Managed Postgres backups; monthly restore drill; audit archive keeps the hot table small | Operational + Implemented | runbook, `audit-archive.service.ts` |
| A1.3 Recovery testing | Chaos suite proves exactly-once publishing under duplicate jobs, expired leases and random provider failures | Implemented | `test/integration/chaos.test.ts` |

## Confidentiality

| Criteria | Control | Status | Evidence |
|----------|---------|--------|----------|
| C1.1 Identification | Data inventory with classification and retention | Implemented (doc) | `docs/compliance.md` §1 |
| C1.2 Disposal | Disconnect wipes credentials; workspace purge cascades; audit rows anonymised; media pruned; idempotency records expire | Implemented | `workspace-deletion.service.ts`, maintenance job |

## Processing integrity

| Criteria | Control | Status | Evidence |
|----------|---------|--------|----------|
| PI1.1–1.3 | Exactly-once publishing via leases and cycle numbers, idempotent jobs, `Idempotency-Key` on the public API, reconciliation of ambiguous outcomes, typed audit trail of every state change | Implemented | `publishing/engine.ts`, `reconciliation.service.ts`, phase7 and chaos tests |
| PI1.4 Output | Results written back to Notion from the stored publication row, never re-derived | Implemented | `result-writeback.service.ts` |

## Privacy

| Criteria | Control | Status | Evidence |
|----------|---------|--------|----------|
| P1–P8 | Privacy policy and terms served by the app; data minimisation (no passwords, no card data, aggregate click counts only); deletion on request; audit export for accountability; data residency by region | Implemented + Operational | `routes/legal.ts`, `docs/compliance.md`, `REGION` |

## Gaps to close before an audit

1. Written policies (access control, change management, incident response, vendor management) referencing the controls above.
2. Background checks and security training records for staff with production access.
3. Centralised log retention (currently host-dependent) with a stated retention period.
4. Formal risk register reviewed at least annually.
5. Penetration test report by a third party.
6. Automated evidence collection (CI run history, deploy logs, alert history) exported to the audit folder monthly.
