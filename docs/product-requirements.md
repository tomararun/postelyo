# Postelyo – Product Requirements (MVP)

Status: **Proposed – awaiting approval for Phase 1 (implementation)**
Created: 2026-09-21 · Updated: 2026-09-22 (product decisions incorporated, see §9)
Related: [architecture.md](./architecture.md), [domain-model.md](./domain-model.md), [security.md](./security.md), [roadmap.md](./roadmap.md)

---

## 1. Vision

A multi-tenant SaaS where teams create content, manage ideas, collaborate on drafts, approve posts, schedule and publish them to multiple social platforms, and later view analytics and use AI for content creation and platform-specific adaptation.

## 2. MVP thesis

Validate the **publishing core** (schedule → publish → report) with a real team's workflow **before** building an editor. Notion is the content interface; Postelyo is the orchestration and publishing layer.

```
Notion content database → Postelyo backend → LinkedIn (personal profile) → result → Notion
```

Success for the MVP means: a team can run its LinkedIn publishing from Notion for 30 days with zero duplicate posts, every failure visible in Notion, and no manual copy-paste.

## 3. Users and roles (MVP)

| Persona | Needs | MVP role |
|---------|-------|----------|
| **Workspace admin** (marketing lead, founder) | Connect Notion and LinkedIn, set time zone, see what failed and why. | `owner` / `admin` in the admin UI |
| **Content editor / reviewer** | Write in Notion, move pages through review, set a date, mark as scheduled, see the result. | Works only in Notion; no Postelyo login required |
| **Operator** (us) | Diagnose issues, retry, see audit trail, receive operational alerts. | Internal admin tools / DB access |

## 4. In scope (MVP)

### 4.1 Workspace setup
- Sign in via magic link; a workspace is created on first sign-in.
- Workspace settings: name, default IANA time zone, default publish time (used when a Notion date has no time).

### 4.2 Notion connection
- Admin pastes an internal integration token and the content database id (or URL).
- Backend validates that the database has the required properties and reports missing ones.
- Token stored encrypted; never displayed again.
- Manual "Sync now" button.

### 4.3 LinkedIn connection
- Admin clicks "Connect LinkedIn"; OAuth completes server-side.
- **Personal (member) profile only in the MVP.** One LinkedIn profile per workspace. *Phase 1 addition (2026-09-26):* company Pages can be connected too ("Connect LinkedIn Pages you administer"); each Page is its own account and needs LinkedIn Community Management API approval for the app.
- Shows account name, connection status and token expiry; supports disconnect and reconnect.

### 4.4 Notion content database contract

Required properties (names fixed in MVP; configurable mapping is a roadmap item):

| Property | Type | Owner | Purpose |
|----------|------|-------|---------|
| `Name` | title | user | Internal title |
| `Status` | status | user | Editorial workflow state, see §4.5 |
| `Publish Date` | date | user | When to publish (time optional) |
| `Platforms` | multi-select | user | `LinkedIn`; Phase 1 adds `LinkedIn Page`; Phase 2 adds `X`, `Facebook Page`, `Instagram` and the `<Platform>: <account name>` picker |
| `LinkedIn Text`, `X Text`, `Facebook Text`, `Instagram Caption` | rich text | user (optional) | Phase 2: per-platform text override; the body is used when empty |
| `Published URLs` | rich text | system (optional) | Phase 2: one link per platform; `Postelyo Status` aggregates (`Partially failed` when some targets failed) |
| `Post Text` | rich text or page body | user | The content; page body preferred (longer, formatting) |
| `Media` | files | user | Optional single image |
| `Time Zone` | select/text | user (optional) | IANA name overriding the workspace default |
| `Postelyo Status` | select | **system** | See §4.5 |
| `Postelyo Note` | rich text | **system** | Human-readable reason / warning |
| `Published URL` | url | **system** | Link to the live post |
| `Published At` | date | **system** | Actual publish time |
| `Postelyo ID` | rich text | **system** | Our publication id for support |

A ready-made Notion template is provided.

### 4.5 Editorial workflow and scheduling

**User-owned `Status` values** (the editorial workflow lives in Notion):

| `Status` | Meaning | Postelyo behaviour |
|----------|---------|--------------------|
| `Idea` | Raw idea, not yet a draft | Mirrored internally as `draft`. No action. |
| `Draft` | Being written | No action. |
| `In review` | Awaiting reviewer | No action. |
| `Changes requested` | Reviewer sent it back | No action. |
| `Ready` | **Approved, waiting to be scheduled** | Not enqueued. If a `Publish Date` is present, Postelyo writes `Postelyo Status = Awaiting schedule` so editors see that an explicit `Scheduled` is still required. |
| `Scheduled` | **Approved, has an explicit date/time, queued for publishing** | Validated, snapshotted, scheduled. |
| `Cancelled` | Withdrawn | Cancels any unpublished publication. |

Recommended path: `Idea → Draft → In review → Changes requested → In review → Ready → Scheduled → (Publishing → Published)`.

**Enforcement:** the MVP does **not** block transitions made directly in Notion (for example `Draft → Scheduled`). It mirrors the observed status and records every observed transition in the audit log. Strict enforcement of the review order (reviewers, permissions, blocking) is a Phase 2 feature together with the native editor.

**System-owned `Postelyo Status` values:** `Awaiting schedule`, `Validation error`, `Scheduled`, `Publishing`, `Published`, `Published late`, `Failed`, `Needs review`, `Needs re-authorization`.

**Scheduling rules**
- A page is scheduled when `Status = Scheduled`, `Platforms` is non-empty and `Publish Date` is valid. A date up to 10 minutes in the past is accepted and published immediately; older dates produce a `Validation error`.
- `Ready` never triggers scheduling, even with a date.
- Time zone resolution: Notion date time zone → `Time Zone` property → workspace default.
- Changing the date while `Scheduled` reschedules; clearing the date, or moving `Status` to anything other than `Scheduled`, cancels the pending publication (unless it is already being published).
- Content is snapshotted at schedule time; edits made more than 5 minutes before the scheduled time are picked up; later edits produce a warning in `Postelyo Note`.

### 4.6 Publishing
- Text posts up to LinkedIn's limit (3 000 characters) with paragraphs, links and hashtags.
- **Optional single image** (JPEG/PNG ≤ 8 MB from the Notion `Media` property). Text-only posts are fully supported. Multiple images, carousels, video and GIFs are out of scope.
- Exactly-once semantics per publication: a post is never published twice by Postelyo, even across crashes and retries. Unknown outcomes stop and ask (`Needs review`).
- Publish within 1 minute of the scheduled time under normal conditions.
- **Late publishing policy: publish late.** If the worker is unavailable at the scheduled time, the post is published as soon as the worker recovers. The original scheduled time, the actual publish time and the delay are recorded on the publish attempt and in the audit log; Notion shows `Postelyo Status = Published late` with the delay in `Postelyo Note`.

### 4.7 Results and errors
- After each attempt, Notion is updated with `Postelyo Status`, `Postelyo Note`, `Published URL`, `Published At`.
- Validation errors (missing text, too long, unsupported media, no LinkedIn account) are written back **before** the scheduled time, at sync.
- Transient errors are retried automatically (up to 5 times over ~30 minutes); terminal errors are reported with a reason.
- Users retry by fixing the content and setting `Status` to `Scheduled` again (after a failure Postelyo does not change the user's `Status`; the editor moves it back, e.g. to `Changes requested`, then to `Scheduled`). A new publishing cycle starts only when the user changed something since the failure: the `Status` value, the content, or the `Publish Date`. Postelyo's own write-back edits never trigger a retry, so a terminal failure is never retried automatically.
- LinkedIn token expiry: the admin who connected the account gets an email 7 days before expiry; posts are blocked with a clear status if expired.

### 4.8 Operations and notifications

Two separate notification types; they are **not** routed to the same address by default:

| Type | Recipient | Channel | Configuration |
|------|-----------|---------|---------------|
| **Operational alerts** (overdue publications, ambiguous outcomes, dead-lettered jobs, worker down, sync failures) | Product owner / operator | Email | Platform-level `ALERT_EMAIL` setting, configurable, not hardcoded. A per-workspace notification setting is reserved for later. |
| **LinkedIn token-expiry / re-authorization notices** | The admin who connected the LinkedIn account | Email | Derived from `social_account.connected_by_user_id`. |

- Slack or other channels are not implemented in the MVP.
- Every state transition is stored in an audit log with actor and timestamp.
- Operators can list posts/publications per workspace and trigger a retry via the admin UI.

## 5. Out of scope (MVP)

Native editor, content calendar UI, a dedicated Ideas feature (the `Idea` status is just a Notion option), enforcement of the review workflow, team invitations beyond a single admin, multiple accounts per platform, LinkedIn organization pages, X/Instagram/Facebook, video/multi-image/carousel/GIF, analytics, AI features, campaigns, media library, billing, public API, outbound webhooks, Slack notifications, per-workspace notification settings, Notion public OAuth app, custom Notion property mapping, deleting/editing already-published posts.

## 6. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Correctness | Zero duplicate posts. Ambiguity resolves to human review, never to re-post. |
| Timeliness | 95 % of publications within 60 s of scheduled time; 99.9 % within 15 min when the worker is healthy. After an outage, all overdue publications are published within 15 min of recovery, with delay recorded. |
| Reliability | Survives Notion or LinkedIn outages: scheduling continues, publishing retries, writeback catches up. |
| Availability | Single region; target 99.5 % for the worker path in MVP. |
| Security | See [security.md](./security.md). OAuth tokens encrypted; never in Notion, logs or browser. |
| Privacy | Only the Notion database explicitly shared with the integration is read. Content retained as snapshots for audit; deletable on request. |
| Scale (MVP) | ≤ 50 workspaces, ≤ 500 publications/day, ≤ 10 000 Notion pages per database. |
| Time zones | Full IANA support including DST transitions. |
| Observability | Every publication traceable end-to-end by id. |
| Cost | Runs on a single small PaaS instance pair plus managed Postgres. |

## 7. Key user flows

### 7.1 First-time setup
1. Admin signs in with email → workspace created.
2. Sets time zone and default publish time.
3. Duplicates the Notion template, creates an internal integration, shares the database with it, pastes token + database id.
4. Postelyo validates the database, first sync runs.
5. Admin connects their LinkedIn personal profile (OAuth).
6. Admin creates a test page in Notion, sets `Status = Scheduled` with a time 5 minutes ahead, watches it publish and the URL appear.

### 7.2 Daily editorial flow
1. Author writes in Notion (`Draft`), sets `Platforms`, optionally a `Publish Date`.
2. Author sets `Status = In review`. Reviewer either sets `Changes requested` (back to author) or `Ready`.
3. If a date is present at `Ready`, `Postelyo Status` shows `Awaiting schedule` within a minute.
4. A scheduler/editor confirms the date and sets `Status = Scheduled`.
5. Within a minute `Postelyo Status` shows `Scheduled`, or `Validation error` with a note.
6. At publish time the status moves through `Publishing` → `Published` (or `Published late`) with a link, or `Failed` with a reason.

### 7.3 Failure flow
1. `Postelyo Status = Failed`, `Postelyo Note = "LinkedIn rejected the post: commentary exceeds 3000 characters"`.
2. Editor moves `Status` to `Changes requested` (or edits in place), shortens the text, then sets `Status = Scheduled` again.
3. Postelyo starts a new cycle; result reported as above.

### 7.4 Re-authorization flow
1. Email to the connecting admin: "Your LinkedIn connection for Acme expires in 7 days."
2. Admin clicks Reconnect → OAuth → status `active`.
3. Any `blocked` publications return to `scheduled` automatically if still in the future; overdue ones publish immediately as late.

### 7.5 Outage / late flow
1. Worker is down from 08:55 to 09:40; a post was scheduled for 09:00.
2. On recovery the scheduler finds it overdue and publishes it at ~09:41.
3. Notion shows `Postelyo Status = Published late`, `Postelyo Note = "Scheduled 09:00, published 09:41 (41 min late)"`, and the audit log holds `scheduled_at`, `published_at`, `delay_seconds`.
4. An operational alert about the overdue publication was sent to the alert email while the worker was down.

## 8. Acceptance criteria (MVP exit)

- [ ] A Notion page set to `Scheduled` 5 minutes ahead publishes to the LinkedIn personal profile and Notion shows the URL within 2 minutes of the scheduled time.
- [ ] A page in `Ready` with a `Publish Date` is **not** published; Notion shows `Awaiting schedule`.
- [ ] A page moved directly from `Draft` to `Scheduled` is published (no enforcement) and the audit log shows the observed transition.
- [ ] Killing the worker mid-publish never yields a duplicate post; it yields either `Published` or `Needs review`.
- [ ] Stopping the worker across a scheduled time and restarting it publishes the post late, with `delay_seconds` recorded and `Published late` in Notion.
- [ ] Simulated LinkedIn 5xx before request → automatic retry succeeds; simulated 401 → `Needs re-authorization`, no retry, email to the connecting admin.
- [ ] Two worker instances running concurrently produce exactly one LinkedIn post per publication.
- [ ] A date without time in Notion publishes at the workspace default time in the workspace time zone, including on a DST change day.
- [ ] A text-only post and a text + single image post both publish successfully.
- [ ] Operational alerts reach the configured `ALERT_EMAIL`; changing the setting requires no code change.
- [ ] Tokens are not present in any log line, API response, Notion property, or Sentry event (verified by tests and a manual check).
- [ ] Tenancy test suite: a user from workspace A cannot read or mutate workspace B data through any endpoint.
- [ ] Audit log contains every transition for a sample publication, with actor.

## 9. Product decisions (2026-09-22)

| # | Question | Decision |
|---|----------|----------|
| P1 | Personal profile vs organization page | **Personal profile only** in the MVP. Organization pages later; no organization API complexity now. |
| P2 | `Ready` vs `Scheduled` | **Separate states.** `Ready` = approved, waiting to be scheduled. `Scheduled` = approved, explicit date/time, queued. Workflow `Draft → In review → Changes requested → In review → Ready → Scheduled → Publishing → Published`, plus `Failed` and `Cancelled`. |
| P3 | Late publishing | **Publish late** as soon as the worker recovers; record scheduled time, actual time and delay in the attempt and audit log. |
| P4 | Media | **Text-only and single-image** posts; image optional. No multi-image, carousel, video, GIF, media management. |
| P5 | Operational alerts | **Email to a configurable product-owner/alert recipient.** No Slack. Recipient configurable so workspace-level settings can follow. |
| P6 | Review-state enforcement | **Not enforced** in the MVP; backend mirrors observed Notion status and audits the transition. Enforcement in Phase 2 with the native editor. |
| P7 | `Idea` status | **Kept** in the Notion template, mapped internally to `draft`. No Ideas feature yet. |
| P8 | `Ready` + `Publish Date` | Write `Postelyo Status = Awaiting schedule`; **do not enqueue**. |
| P9 | Email routing | **Two separate types.** Operational alerts → configurable alert recipient. Token-expiry notices → admin who connected the account. Not merged by default. |

## 10. Remaining open questions

None blocking Phase 1. Non-blocking items are tracked in [roadmap.md](./roadmap.md) §"Decision points".
