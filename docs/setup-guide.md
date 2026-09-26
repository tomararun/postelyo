# Postelyo – Setup Guide for the Pilot Team

Audience: the marketing lead or founder setting up Postelyo for their team, and the editors who will use it. No technical background needed. About 20 minutes.

What you get: you keep writing and reviewing posts in Notion. When you set a post to **Scheduled** with a date, Postelyo publishes it to your LinkedIn profile at that time and writes the result back into Notion.

---

## 1. Sign in and set your workspace time zone

1. Open the Postelyo link you were given and enter your email. Click the sign-in link in the email (valid 15 minutes).
2. A workspace is created for you. Open **Connections**.
3. Ask your Postelyo contact to set the workspace **time zone** and **default publish time** if they are not right for you (for example `Europe/Berlin`, `09:00`). Dates in Notion without a time publish at the default time in that zone.

## 2. Create the Notion integration

1. In Notion, go to **Settings & members → Connections → Develop or manage integrations** (or open notion.so/my-integrations).
2. **New integration**: name it `Postelyo`, pick your workspace, type *Internal*. Capabilities needed: read content, update content, insert content. No user information is needed.
3. Copy the **Internal Integration Secret** (starts with `ntn_`). Treat it like a password. Postelyo stores it encrypted and never shows it again.

## 3. Create the content database

Option A, recommended: ask your Postelyo contact to run the template generator against a page you share with the integration. They need the page link and the secret from step 2. The generator creates a database called **Postelyo Content** with every property already correct.

Option B: build it by hand following [notion-template.md](./notion-template.md).

Then, in Notion, open the database page, click **···** → **Connections** → add `Postelyo`. Without this, Postelyo cannot see the database.

## 4. Connect Notion to Postelyo

On the **Connections** page paste the integration secret and the database link, then **Connect Notion database**. Postelyo checks every property and tells you what is missing, if anything. After connecting, use **Sync now** once.

## 5. Connect LinkedIn

Click **Connect LinkedIn profile**, sign in to LinkedIn, and approve. This connects your **personal profile**. LinkedIn authorizations last about 60 days. You will get an email 7 days before it expires with a **Reconnect** link. If it expires, scheduled posts wait until you reconnect and then publish.

**LinkedIn Pages (company pages):** click **Connect LinkedIn Pages you administer**. Every Page where you are an administrator is connected; disconnect the ones Postelyo should not post to. In Notion, choose `LinkedIn Page` in `Platforms` to post as the Page, or `LinkedIn Page: <Page name>` when several Pages are connected. This requires the Postelyo LinkedIn app to have Community Management API access; if the connection reports that it lacks access, the profile still works and your Postelyo contact will follow up.

## 6. Publish a test post

1. In the database, create a page: title, a sentence in the page body, `Platforms = LinkedIn`, `Publish Date` = 5 minutes from now (with time).
2. Set `Status = Scheduled`.
3. Within a minute, `Postelyo Status` shows **Scheduled** and the note shows the local time.
4. At the scheduled time it shows **Publishing**, then **Published** with the LinkedIn link.

If it shows **Validation error**, read the note, fix the page, and it re-checks within a minute.

---

## Daily use

| Do this in Notion | What happens |
|-------------------|--------------|
| Write in `Draft`, move to `In review`, `Changes requested`, `Ready` | Nothing is published. Postelyo only mirrors these for reporting. |
| `Ready` + a date | `Postelyo Status = Awaiting schedule`. Still nothing is published. |
| `Scheduled` + a date + `LinkedIn` | Scheduled. Change the date to reschedule. |
| Edit text while scheduled | Picked up automatically until 5 minutes before publish time. |
| Move away from `Scheduled` or clear the date | Cancelled. Nothing is published. |
| Delete or archive the page | Cancelled. |
| `Failed` | Read the note, fix it, move `Status` away from `Scheduled` and back. |
| `Needs review` | LinkedIn did not confirm. Do nothing; an operator checks LinkedIn and resolves it, so you never get a duplicate post. |

Rules of thumb:
- One image (JPEG or PNG, up to 8 MB) in the `Media` property, or none.
- 3 000 characters maximum.
- Hashtags work: `#launch`.
- Do not edit the `Postelyo …`, `Published …` columns; Postelyo overwrites them.
- A post is never published twice, even if the service restarts.

## Where to look when something is off

- **Posts** page in Postelyo: every post, its state, the LinkedIn link, and for failures the exact reason.
- **Connections** page: shows if the LinkedIn authorization is about to expire and if the background worker is healthy.
- Emails from Postelyo: sign-in links, LinkedIn re-authorization notices.

## Getting help

Send your Postelyo contact the **Postelyo ID** from the Notion page or the Posts page. It identifies the exact publication and its full history.
