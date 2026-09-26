# Postelyo

Content workflow and social publishing platform: a Notion content database → Postelyo → LinkedIn, X, Facebook Pages and Instagram → results written back to Notion.

Design documents live in [docs/](docs/): start with [architecture.md](docs/architecture.md), [product-requirements.md](docs/product-requirements.md) and the phase plan in [product-roadmap.md](docs/product-roadmap.md).

## Repository layout

```
apps/api                    the single deployable: HTTP api (main-api) and background worker (main-worker)
packages/publishing-core    provider contract, canonical content, rendering, contract suite and the platform adapters
docs/                       architecture, product requirements, domain model, security, roadmap, runbook
```

The api consumes the package from source in development and tests (`development` export condition, set by the `tsx --conditions=development` scripts and the vitest alias) and from `packages/publishing-core/dist` in production; `npm run build` builds both in order.

## Local development

Requirements: Node 22 (see `.node-version`), Docker (for Postgres and Mailpit).

```bash
cp .env.example .env
docker compose up -d
npm ci
npm run db:migrate
npm run dev:api      # http://localhost:3000/health/live
npm run dev:worker   # in a second terminal
```

`PROVIDER_MODE=fake` (default) runs the whole pipeline without calling any social platform. Media is stored under `.data/media` (`STORAGE_DRIVER=local`) and served by the api at `/media/*`; production uses `STORAGE_DRIVER=s3` (Cloudflare R2). Image processing uses `sharp`, which ships prebuilt binaries for Windows, macOS, Linux and the Alpine Docker image.

## Scripts

| Command                                                          | Purpose                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev:api` / `npm run dev:worker`                         | Run with hot reload                                                                     |
| `npm run build`                                                  | Compile `packages/publishing-core/dist` then `apps/api/dist`                            |
| `npm run lint` / `npm run typecheck`                             | Static checks                                                                           |
| `npm run test`                                                   | Unit and contract tests (no database needed)                                            |
| `npm run test:integration`                                       | Tests against `DATABASE_URL`, or an embedded throwaway Postgres when it is unset        |
| `npm run db:generate`                                            | Generate a migration from schema changes                                                |
| `npm run db:migrate`                                             | Apply migrations                                                                        |
| `npm run preflight`                                              | Go-live checks for the configured environment (env, database, migrations, worker, mail) |
| `npm run notion:template -- --parent <page url> --token <ntn_…>` | Create the Notion content database under a page                                         |
| `npm run seed -- --email you@example.com`                        | Local dev only: user, workspace, fake LinkedIn account and a due publication            |

## Sign-in during development

With `MAIL_TRANSPORT=log` the magic link is printed in the api log. Open it in the browser to sign in; a workspace is created on first sign-in.

## Status

Phase 0 (MVP) built; the live pilot waits for credentials. Phase 1 (hardening: LinkedIn Pages, Notion webhooks, ambiguous reconciliation, daily caps, row-level security) and Phase 2 (multi-platform core: X, Facebook Pages, Instagram, media pipeline, per-platform text, multiple accounts) are built and tested against fakes; live verification needs X API keys and Meta app review. See [docs/pilot-checklist.md](docs/pilot-checklist.md) for the go/no-go steps and [docs/setup-guide.md](docs/setup-guide.md) for the pilot team. Operational alerts and token-expiry notices go out by email, `/metrics` exposes Prometheus gauges, operators retry and resolve publications from the Posts page, and `deploy/fly.toml` plus the Deploy workflow ship staging and production. See [docs/runbook.md](docs/runbook.md). The worker syncs Notion every minute, dispatches due publications every 30 seconds, publishes through the provider adapter with exactly-once leases, and writes results back to Notion. `PROVIDER_MODE=fake` exercises the whole path without calling LinkedIn. See [docs/roadmap.md](docs/roadmap.md).

## Connecting platforms and Notion locally

- LinkedIn: create an app in the LinkedIn developer portal, enable "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" (plus the Community Management API for Pages), register `http://localhost:3000/oauth/linkedin/callback` as a redirect URL, and set `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`. Leave both empty to run without LinkedIn.
- X: create an OAuth 2.0 app (confidential client, user context, a paid tier for posting), register `http://localhost:3000/oauth/x/callback`, set `X_CLIENT_ID` / `X_CLIENT_SECRET`, and enable X for the workspace: `PATCH /v1/workspaces/:id {"providers": {"x": true}}`.
- Facebook Pages and Instagram: create a Meta app with Facebook Login, register `http://localhost:3000/oauth/meta/callback`, set `META_APP_ID` / `META_APP_SECRET`, request `pages_manage_posts` and `instagram_content_publish` in app review, and enable the providers for the workspace. Instagram needs a public image URL, so the api must be reachable from the internet (or use the S3 driver).
- Notion: create an internal integration, share your content database with it, then paste the token and the database URL on the workspace's Connections page. The database is validated against the template before the token is stored (encrypted).
