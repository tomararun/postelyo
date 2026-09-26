# Postelyo

Content workflow and social publishing platform. MVP: Notion content database → Postelyo → LinkedIn (personal profile) → result written back to Notion.

Design documents live in [docs/](docs/): start with [architecture.md](docs/architecture.md) and [product-requirements.md](docs/product-requirements.md).

## Repository layout

```
apps/api      the single deployable: HTTP api (main-api) and background worker (main-worker)
docs/         architecture, product requirements, domain model, security, roadmap
```

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

`PROVIDER_MODE=fake` (default) runs the whole pipeline without calling LinkedIn.

## Scripts

| Command                                                          | Purpose                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev:api` / `npm run dev:worker`                         | Run with hot reload                                                                     |
| `npm run build`                                                  | Compile to `apps/api/dist`                                                              |
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

Phase 0 milestones 0.1–0.7 done; 0.8 (pilot) tooling done, live pilot pending credentials. See [docs/pilot-checklist.md](docs/pilot-checklist.md) for the go/no-go steps and [docs/setup-guide.md](docs/setup-guide.md) for the pilot team. Operational alerts and token-expiry notices go out by email, `/metrics` exposes Prometheus gauges, operators retry and resolve publications from the Posts page, and `deploy/fly.toml` plus the Deploy workflow ship staging and production. See [docs/runbook.md](docs/runbook.md). The worker syncs Notion every minute, dispatches due publications every 30 seconds, publishes through the provider adapter with exactly-once leases, and writes results back to Notion. `PROVIDER_MODE=fake` exercises the whole path without calling LinkedIn. See [docs/roadmap.md](docs/roadmap.md).

## Connecting LinkedIn and Notion locally

- LinkedIn: create an app in the LinkedIn developer portal, enable "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn", register `http://localhost:3000/oauth/linkedin/callback` as a redirect URL, and set `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`. Leave both empty to run without LinkedIn.
- Notion: create an internal integration, share your content database with it, then paste the token and the database URL on the workspace's Connections page. The database is validated against the template before the token is stored (encrypted).
