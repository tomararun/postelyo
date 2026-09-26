# Postelyo – Notion Content Database Template

Audience: workspace admins setting up Notion for Postelyo, and developers changing the contract.

The fastest way to get a correct database is the generator:

```bash
npm run notion:template -- --parent <notion page url> --token <ntn_...>
```

It creates a database named **Postelyo Content** under the page you pass (share that page with your integration first), then validates it and prints the URL to paste on the Connections page. You can also build the database by hand from the table below; validation on connect will tell you exactly what is missing.

## Properties

| Property | Type | Owner | Options / notes |
|----------|------|-------|-----------------|
| `Name` | title | you | Internal title of the post. |
| `Status` | status *or* select | you | `Idea`, `Draft`, `In review`, `Changes requested`, `Ready`, `Scheduled`, `Cancelled`. Only `Scheduled` publishes. The generator creates a `select` because Notion's API cannot create `status` properties; a hand-made `status` property works too. |
| `Publish Date` | date | you | Date with or without time. Without a time, the workspace default publish time applies. A time zone picked in Notion wins; otherwise `Time Zone`, then the workspace default. |
| `Platforms` | multi-select | you | `LinkedIn` (profile), `LinkedIn Page`, `X`, `Facebook Page`, `Instagram`. With several accounts of one kind connected, add an option `<Platform>: <account name>` (e.g. `X: @alice`, `Instagram: @acme`) to pick one; the bare option then fails validation with the names to choose from. X, Facebook and Instagram must be enabled for the workspace. |
| `LinkedIn Text`, `X Text`, `Facebook Text`, `Instagram Caption` | rich text | you, optional | Per-platform text that replaces the page body for that platform only (blank lines separate paragraphs). Leave empty to use the body. Handy for the 280-character X version. |
| `Post Text` | rich text | you | Fallback body. The **page body** is preferred when it has content. |
| `Media` | files & media | you | Optional. One JPEG or PNG up to 8 MB. |
| `Time Zone` | select or rich text | you, optional | IANA name such as `Europe/Berlin` to override the workspace default for this post. |
| `Postelyo Status` | select | Postelyo | `Awaiting schedule`, `Validation error`, `Scheduled`, `Publishing`, `Published`, `Published late`, `Partially failed`, `Failed`, `Needs review`, `Needs re-authorization`. With several platforms the status summarises all of them. Do not edit. |
| `Postelyo Note` | rich text | Postelyo | Reason or warning in plain language; one line per platform when a page targets several. Do not edit. |
| `Published URL` | url | Postelyo | Link to the live post (the first one when there are several). |
| `Published URLs` | rich text | Postelyo, optional | One link per platform. Add this column to get it; older databases work without it. |
| `Published At` | date | Postelyo | Actual publish time. |
| `Postelyo ID` | rich text | Postelyo | Publication id, useful when asking for support. |

Property names are matched case-insensitively. Missing optional properties produce warnings, not errors.

## Page body formatting

Supported: paragraphs, bulleted and numbered lists, bold and italic, links, `#hashtags`. Headings, quotes and callouts become plain paragraphs. Other block types (toggles, images in the body, embeds) are flattened to their text or skipped, with a warning in `Postelyo Note`. Put the image in the `Media` property, not in the body.

Limits per platform, checked before the scheduled time: LinkedIn 3 000 characters; X 280 (links count as 23); Facebook 63 206; Instagram 2 200 and an image is required (JPEG or PNG; Postelyo converts and crops to Instagram's 4:5 to 1.91:1 range). Use the per-platform text columns when one body cannot fit every platform.

## What Postelyo writes and when

| You set | Postelyo writes to `Postelyo Status` |
|---------|---------------------------------------|
| `Ready` with a `Publish Date` | `Awaiting schedule` (nothing is published until you set `Scheduled`) |
| `Scheduled` with a valid date, platform and content | `Scheduled`, plus the local time in the note and the id |
| `Scheduled` with a problem | `Validation error` and the reasons; fix and it re-validates within a minute |
| any other status, or the date cleared | clears the pre-publish status |
| at publish time | `Publishing`, then `Published` or `Published late` with URL and time, or `Failed` with the reason, or `Needs review` if LinkedIn did not confirm |

To retry after `Failed`: fix the content or connection, move `Status` away from `Scheduled` and back (or change the date). Postelyo never retries a final failure on its own.

## Changing the contract (developers)

The single source of truth is `NOTION_CONTRACT` in `apps/api/src/modules/content-sources/notion/notion-schema.ts`; the generator in `notion-template.ts` is checked against it by tests. Update both plus this file, and add a warning-only period before making a new property required so existing pilot databases keep validating.
