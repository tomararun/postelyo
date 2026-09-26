# Postelyo – Setup Guide for the Pilot Team

Audience: the marketing lead or founder setting up Postelyo for their team, and the editors who will use it. No technical background needed. About 20 minutes.

What you get: you keep writing and reviewing posts in Notion. When you set a post to **Scheduled** with a date, Postelyo publishes it to your LinkedIn profile at that time and writes the result back into Notion.

There are two ways to connect Notion. **Connect with Notion** (one click, recommended) creates the content database for you; skip to section 2a. The **integration token** path (sections 2 to 4) is for teams that prefer their own internal integration.

---

## 1. Sign in and set your workspace time zone

1. Open the Postelyo link you were given and enter your email. Click the sign-in link in the email (valid 15 minutes).
2. A workspace is created for you. Open **Connections**.
3. Ask your Postelyo contact to set the workspace **time zone** and **default publish time** if they are not right for you (for example `Europe/Berlin`, `09:00`). Dates in Notion without a time publish at the default time in that zone.

## 2a. Connect with Notion (recommended)

1. On **Connections** click **Connect with Notion**. Notion asks which pages Postelyo may use: pick one page (for example your marketing wiki page) and confirm.
2. Back in Postelyo, choose **Create the content database** and the page you shared. Postelyo creates a database called **Postelyo Content** under it with every property already correct.
3. Already have a matching database? Choose **Use an existing database** instead; Postelyo checks it against the template and tells you what is missing.
4. Skip to section 5.

## 2. Create the Notion integration (token path)

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

**X, Facebook Pages and Instagram** appear on the Connections page once your Postelyo admin has enabled them for the workspace. **Connect X profile** signs you in to X (the authorization refreshes itself). **Connect Facebook Pages you manage** signs you in to Facebook and connects every Page you manage plus the Instagram professional account linked to each Page; disconnect the ones Postelyo should not post to. Instagram posts need an image. In Notion, pick `X`, `Facebook Page` or `Instagram` in `Platforms`, and use `X Text` or `Instagram Caption` when the shared body does not fit that platform.

**LinkedIn Pages (company pages):** click **Connect LinkedIn Pages you administer**. Every Page where you are an administrator is connected; disconnect the ones Postelyo should not post to. In Notion, choose `LinkedIn Page` in `Platforms` to post as the Page, or `LinkedIn Page: <Page name>` when several Pages are connected. This requires the Postelyo LinkedIn app to have Community Management API access; if the connection reports that it lacks access, the profile still works and your Postelyo contact will follow up.

## 6. Publish a test post

1. In the database, create a page: title, a sentence in the page body, `Platforms = LinkedIn`, `Publish Date` = 5 minutes from now (with time).
2. Set `Status = Scheduled`.
3. Within a minute, `Postelyo Status` shows **Scheduled** and the note shows the local time.
4. At the scheduled time it shows **Publishing**, then **Published** with the LinkedIn link.

If it shows **Validation error**, read the note, fix the page, and it re-checks within a minute.

---

## Your team

**Team** page: invite colleagues by email with a role. *Editor* can retry posts; *Admin* can also manage connections and settings; *Owner* can manage billing and delete the workspace. Invitations expire after 7 days; the invited person signs in with their email and accepts. The number of members depends on your plan.

## Plans and billing

**Billing** page: what your plan allows (connected accounts, posts per month, members), what you use, and the upgrade buttons. Payment happens on Stripe's checkout page; *Manage billing* opens Stripe's portal for invoices, cards and cancellations. If a payment fails you keep your plan for 14 days, then the workspace falls back to Free until the payment goes through. A post that would exceed the monthly limit shows **Validation error** in Notion with the reason.

## Settings

Owners and admins set the time zone, default publish time, daily cap, which platforms are enabled, and two email addresses: where account notices (like LinkedIn expiring) go, and an optional copy of operational alerts. Owners can delete the workspace from the **Danger zone**: scheduled posts are cancelled at once and everything is purged shortly after.

## Campaigns, series and more (template v2)

- **Campaigns**: create a page in *Postelyo Campaigns* and pick it in a post's `Campaign` relation. The campaign page shows scheduled, published and failed counts, the next publish time and the first and latest links, refreshed automatically.
- **Recurring posts**: set `Repeat` (Weekly, Every 2 weeks, Monthly) and optionally `Repeat Until` on a Scheduled page. Postelyo creates one page per future occurrence (60 days ahead), each linked through `Repeat Of`. Edit the source page to update the copies you have not touched; edit a copy to make it your own.
- **Evergreen**: set `Repeat = Evergreen` and `Status = Ready` on posts worth re-sharing. Your admin defines weekly slots in Settings; Postelyo fills them, never re-sharing the same page within the minimum gap.
- **First comment**: fill `First Comment` to post it right after the post goes live (LinkedIn, X, Facebook, Instagram). If it fails, the note says so; the post itself is unaffected.
- **Links**: with UTM presets and short links switched on in Settings, links in your post are tagged and shortened when published (never in Notion). Clicks show on the post's page in Postelyo and in `Link Report`.
- **Approvals**: when your admin turns the policy on, a Ready post shows `Awaiting approval` until a reviewer approves it in Postelyo → Posts. Any edit afterwards needs a new approval. Scheduling without one shows a validation error.
- **Ideas**: jot ideas in *Postelyo Ideas*; set `Status = Promote` and a Draft appears in the content database with a link back.

## Results (analytics)

About an hour after a post goes live its page in Notion fills `Impressions`, `Reach`, `Reactions`, `Comments`, `Shares` and `Clicks` (where the platform reports them), refreshed at 6 hours, 24 hours, 7 days and 30 days. The *Postelyo Analytics* database holds one row per week and platform plus the best times to publish. In Postelyo, **Analytics** shows the weekly trend, top posts, hashtags and best-time suggestions. Owners and admins get a Monday morning email with last week's numbers; switch it off in Settings.

## Daily use

| Do this in Notion | What happens |
|-------------------|--------------|
| Write in `Draft`, move to `In review`, `Changes requested`, `Ready` | Nothing is published. Postelyo only mirrors these for reporting. |
| `Ready` + a date | `Postelyo Status = Awaiting schedule` (or `Awaiting approval` when approvals are enforced). Still nothing is published. |
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
- **Billing** page: whether a plan limit is what stopped a post or a connection.
- Emails from Postelyo: sign-in links, LinkedIn re-authorization notices.

## Getting help

Send your Postelyo contact the **Postelyo ID** from the Notion page or the Posts page. It identifies the exact publication and its full history.
