# Postelyo – Notion Content Database Template (v2)

Audience: workspace admins setting up Notion for Postelyo, and developers changing the contract.

The fastest way to a correct setup is **Connect with Notion** on the Connections page: pick a page, and Postelyo creates the three databases below under it (or connects the ones you duplicated from the Postelyo template). The generator does the same from the command line:

```bash
npm run notion:template -- --parent <notion page url> --token <ntn_...>
```

It creates **Postelyo Content**, **Postelyo Campaigns** and **Postelyo Ideas** under the page you pass (share that page with your integration first), wires the relations, validates the result and prints the URL to paste on the Connections page. You can also build the databases by hand from the tables below; validation on connect tells you exactly what is missing.

**Views.** Notion's API cannot create database views. The public Postelyo template page (offered during *Connect with Notion*) ships with Calendar, Board by Status, per-platform and "Needs attention" views. For an API-created or hand-made database, add them yourself: Calendar on `Publish Date`; Board grouped by `Status`; a filtered view per `Platforms` option; and "Needs attention" filtered on `Postelyo Status` in (Validation error, Failed, Partially failed, Needs review, Needs re-authorization, Awaiting approval).

## Content database properties

| Property | Type | Owner | Options / notes |
|----------|------|-------|-----------------|
| `Name` | title | you | Internal title of the post. |
| `Status` | status *or* select | you | `Idea`, `Draft`, `In review`, `Changes requested`, `Ready`, `Scheduled`, `Cancelled`. Only `Scheduled` publishes. The generator creates a `select` because Notion's API cannot create `status` properties; a hand-made `status` property works too. |
| `Publish Date` | date | you | Date with or without time. Without a time, the workspace default publish time applies. A time zone picked in Notion wins; otherwise `Time Zone`, then the workspace default. |
| `Platforms` | multi-select | you | `LinkedIn` (profile), `LinkedIn Page`, `X`, `Facebook Page`, `Instagram`. With several accounts of one kind connected, add an option `<Platform>: <account name>` (e.g. `X: @alice`, `Instagram: @acme`) to pick one; the bare option then fails validation with the names to choose from. X, Facebook and Instagram must be enabled for the workspace. |
| `LinkedIn Text`, `X Text`, `Facebook Text`, `Instagram Caption` | rich text | you, optional | Per-platform text that replaces the page body for that platform only (blank lines separate paragraphs). Leave empty to use the body. |
| `Post Text` | rich text | you | Fallback body. The **page body** is preferred when it has content. |
| `Media` | files & media | you | Optional. One JPEG or PNG up to 8 MB. Recurring instances copy external links only; Notion-hosted files cannot be copied by the API. |
| `Time Zone` | select or rich text | you, optional | IANA name such as `Europe/Berlin` to override the workspace default for this post. |
| `Campaign` | relation → Campaigns | you, optional (v2) | Links the post to a campaign; the campaign page receives scheduled/published/failed counts and the next publish time. |
| `Repeat` | select | you, optional (v2) | `Weekly`, `Every 2 weeks`, `Monthly` turn a Scheduled page into a series: Postelyo creates one instance page per occurrence 60 days ahead. `Evergreen` puts a `Ready` page in the re-share pool (see the workspace's evergreen slots). |
| `Repeat Until` | date | you, optional (v2) | Last date of a series. |
| `First Comment` | rich text | you, optional (v2) | Posted as a comment right after publishing, on LinkedIn, X (as a reply), Facebook Pages and Instagram. A failed comment never fails the post; the note says what happened. |
| `Repeat Of` | relation → this database | Postelyo (v2) | Set on generated instances, pointing at the source page. Do not edit. |
| `Approval` | select | Postelyo (v2) | `Awaiting approval`, `Approved`, `Changes since approval`; written only when the workspace enforces approvals. Do not edit. |
| `Link Report` | rich text | Postelyo (v2) | Tracked links (`short → target (clicks)`) when the workspace shortens links. Do not edit. |
| `Postelyo Status` | select | Postelyo | `Awaiting schedule`, `Awaiting approval`, `In evergreen pool`, `Validation error`, `Scheduled`, `Publishing`, `Published`, `Published late`, `Partially failed`, `Failed`, `Needs review`, `Needs re-authorization`. With several platforms the status summarises all of them. Do not edit. |
| `Postelyo Note` | rich text | Postelyo | Reason or warning in plain language; one line per platform when a page targets several. Do not edit. |
| `Published URL` | url | Postelyo | Link to the live post (the first one when there are several). |
| `Published URLs` | rich text | Postelyo, optional | One link per platform. Add this column to get it; older databases work without it. |
| `Published At` | date | Postelyo | Actual publish time. |
| `Postelyo ID` | rich text | Postelyo | Publication id, useful when asking for support. |

Property names are matched case-insensitively. Missing optional properties produce warnings, not errors; the v2 properties are silent when absent, so a v1 database keeps working unchanged.

## Campaigns database (v2, optional)

| Property | Type | Owner | Notes |
|----------|------|-------|-------|
| `Name` | title | you | Campaign name; `{campaign}` in UTM presets becomes its slug. |
| `Status` | select | you | `Planned`, `Active`, `Done` (informational). |
| `Start`, `End` | date | you | Informational. |
| `Scheduled`, `Published`, `Failed` | number | Postelyo | Counts across the campaign's posts, refreshed on every sync when they change. |
| `Next Publish` | date | Postelyo | Earliest upcoming publication. |
| `Postelyo Summary` | rich text | Postelyo | One-paragraph summary with the first and latest published links. |

Postelyo finds the campaigns database through the `Campaign` relation of the content database.

## Ideas database (v2, optional)

| Property | Type | Owner | Notes |
|----------|------|-------|-------|
| `Name` | title | you | Becomes the post title. |
| `Status` | select or status | you | `New`, `Promote`, `Promoted`. Set **Promote** to turn the idea into a `Draft` page in the content database; Postelyo then sets `Promoted`. |
| `Notes` | rich text | you | Copied as the first paragraph of the draft, followed by the idea's page body. |
| `Platforms` | multi-select | you, optional | Copied to the draft. |
| `Post URL` | url | Postelyo | Link to the created draft. |

Postelyo finds the ideas database by its title (`Postelyo Ideas`) or from the setup wizard's choice.

## Upgrading a v1 database

Everything in v2 is additive. To upgrade by hand: add the properties `Repeat` (select: Weekly, Every 2 weeks, Monthly, Evergreen), `Repeat Until` (date), `First Comment` (rich text), `Approval` (select), `Link Report` (rich text), `Repeat Of` (relation to the same database, one-way) and, if you want campaigns, `Campaign` (relation to a campaigns database with the columns above). Reconnect or run *Sync now*; the property map refreshes on connect. Nothing changes for pages that do not use the new columns.

## Page body formatting

Supported: paragraphs, bulleted and numbered lists, bold and italic, links, `#hashtags`. Headings, quotes and callouts become plain paragraphs. Other block types (toggles, images in the body, embeds) are flattened to their text or skipped, with a warning in `Postelyo Note`. Put the image in the `Media` property, not in the body.

Limits per platform, checked before the scheduled time: LinkedIn 3 000 characters; X 280 (links count as 23); Facebook 63 206; Instagram 2 200 and an image is required (JPEG or PNG; Postelyo converts and crops to Instagram's 4:5 to 1.91:1 range). Use the per-platform text columns when one body cannot fit every platform.

Links: when the workspace has UTM presets or short links switched on, they are applied to the text sent to the platform at publish time. The Notion page is never rewritten.

## What Postelyo writes and when

| You set | Postelyo writes to `Postelyo Status` |
|---------|---------------------------------------|
| `Ready` with a `Publish Date` | `Awaiting schedule` (nothing is published until you set `Scheduled`) |
| `Ready` while the workspace enforces approvals | `Awaiting approval` until a reviewer approves in Postelyo; `Approval` shows the state |
| `Ready` with `Repeat = Evergreen` | `In evergreen pool` |
| `Scheduled` with a valid date, platform and content | `Scheduled`, plus the local time in the note and the id |
| `Scheduled` with a `Repeat` rule | as above, and one instance page per future occurrence appears with `Repeat Of` set |
| `Scheduled` with a problem | `Validation error` and the reasons; fix and it re-validates within a minute |
| any other status, or the date cleared | clears the pre-publish status |
| at publish time | `Publishing`, then `Published` or `Published late` with URL and time (and the first-comment outcome), or `Failed` with the reason, or `Needs review` if the platform did not confirm |

To retry after `Failed`: fix the content or connection, move `Status` away from `Scheduled` and back (or change the date). Postelyo never retries a final failure on its own.

Recurring series: editing the source page updates future instances you have not edited yourself; an instance you changed by hand keeps your version (the sync notes it). Cancelling or deleting an instance only affects that occurrence.

## Changing the contract (developers)

The single source of truth is `NOTION_CONTRACT` (plus `CAMPAIGN_CONTRACT` and `IDEAS_CONTRACT`) in `apps/api/src/modules/content-sources/notion/notion-schema.ts`; the generator in `notion-template.ts` is checked against it by tests. Update both plus this file, and add a warning-only period before making a new property required so existing databases keep validating.
