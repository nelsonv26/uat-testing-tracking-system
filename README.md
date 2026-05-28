# UAT Management App

A small local Node.js + Express app that turns a Jira epic transition into a
coordinated UAT cycle on Slack.

When an **Epic** moves to **"Ready for UAT"** in Jira, the app:

1. Creates a **Slack Canvas** in the UAT channel with a checklist of testers, the
   Jira link, and instructions.
2. **DMs each tester** the UAT name, due date, canvas link, Jira link, and a
   personal link to their tester page.
3. Serves a **dashboard** (`/dashboard`) for Patrick to watch progress live.
4. Serves a **tester page** (`/tester/:slackUserId/:cycleId`) where each tester
   leaves notes and marks themselves done — which checks their box on the Canvas
   and posts a confirmation in the channel.

> **Scope:** this app is wired to a **test** Jira project and a **test** Slack
> channel only. The channel ID and project key come entirely from `.env` —
> nothing is hardcoded.

---

## Tech stack

- Node.js + Express
- SQLite via `better-sqlite3` (file lives in `./data/uat.db`)
- Slack Web API (`@slack/web-api`)
- Vanilla HTML/CSS/JS frontend (dark theme)

---

## 1. Install & run

```bash
npm install
cp .env.example .env   # then fill in the values (see below)
npm start
```

The server starts on `http://localhost:3000` (override with `PORT`).

- Dashboard: <http://localhost:3000/dashboard>
- Health check: <http://localhost:3000/health>

For development with auto-reload:

```bash
npm run dev
```

> **Note:** If you want Jira (running in the cloud) to reach your local server,
> expose it with a tunnel such as [ngrok](https://ngrok.com):
> `ngrok http 3000`, then set `APP_BASE_URL` to the public https URL so the
> tester links in DMs/Canvas are clickable from anywhere.

---

## 2. Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
| --- | --- |
| `JIRA_WEBHOOK_SECRET` | Long random string. Must match the `?secret=` you put on the webhook URL. |
| `JIRA_BASE_URL` | e.g. `https://adoreal.atlassian.net` (no trailing slash). |
| `JIRA_API_TOKEN` | Jira API token (only needed if you later enrich data via the REST API). |
| `JIRA_EMAIL` | Email of the account that owns the token. |
| `JIRA_PROJECT_KEY` | The **test** project key (e.g. `TEST`). |
| `SLACK_BOT_TOKEN` | Bot token, starts with `xoxb-`. |
| `SLACK_CHANNEL_ID` | The **test** UAT channel ID (e.g. `C0123456789`). |
| `SLACK_USER_IDS` | Comma-separated tester user IDs, e.g. `U01,U02,...` (up to 7). |
| `PORT` | Default `3000`. |
| `APP_BASE_URL` | Public base URL of this app, used to build tester links. Falls back to `http://localhost:PORT`. |
| `TRIGGER_STATUS` | Status that triggers a cycle. Default `Ready for UAT`. |

> If `SLACK_BOT_TOKEN` is empty, the app runs in **no-op Slack mode**: cycles and
> the UI work fully, but no Canvas/DMs are sent. Handy for local UI testing.

---

## 3. Set up the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → *From scratch*.
   Pick your **test** workspace.
2. **OAuth & Permissions** → add these **Bot Token Scopes**:
   - `canvases:write` — create & edit canvases
   - `canvases:read` — read canvas metadata
   - `files:read` — fetch the canvas permalink for shareable links
   - `chat:write` — post messages / DMs
   - `im:write` — open DM channels with testers
   - `users:read` — resolve tester display names
   - `channels:read` (public UAT channel) **or** `groups:read` (private channel)
3. Click **Install to Workspace** and copy the **Bot User OAuth Token**
   (`xoxb-…`) into `SLACK_BOT_TOKEN`.
4. **Invite the bot to the UAT channel**: in Slack, open the channel and type
   `/invite @YourBotName`. (Required for it to post and share the canvas there.)

### Get the channel ID
Open the channel in Slack → click the channel name → scroll to the bottom of the
**About** tab → copy the ID (looks like `C0123456789`). Put it in
`SLACK_CHANNEL_ID`.

### Get the 7 testers' Slack user IDs
For each tester: click their profile → **⋮ (More)** → **Copy member ID**
(looks like `U0123ABC`). Put all of them comma-separated in `SLACK_USER_IDS`,
e.g.:

```
SLACK_USER_IDS=U01AAAA,U02BBBB,U03CCCC,U04DDDD,U05EEEE,U06FFFF,U07GGGG
```

---

## 4. Configure the Jira webhook

1. In Jira, go to **Settings (⚙) → System → WebHooks** → **Create a WebHook**.
   *(Jira admin permission required.)*
2. **Name:** `UAT Management`.
3. **URL:** your app's webhook endpoint with the secret as a query param:
   ```
   https://<your-public-host>/webhook/jira?secret=<JIRA_WEBHOOK_SECRET>
   ```
   For local testing use your ngrok URL, e.g.
   `https://abc123.ngrok.io/webhook/jira?secret=...`.
4. **Events:** under *Issue*, check **updated** (the app filters for the status
   transition itself).
5. **JQL filter (recommended):** scope it to the test project and epics, e.g.
   ```
   project = TEST AND issuetype = Epic
   ```
6. Save. The app verifies the secret on every call (timing-safe), confirms the
   issue is an **Epic**, and that the status changed **to** `Ready for UAT`
   before creating a cycle.

> **Alternative — Jira Automation:** create a rule
> *When: Issue transitioned → To: Ready for UAT*, condition *Issue Type = Epic*,
> action *Send web request* (POST, JSON, the same URL with `?secret=`). The app
> also accepts the secret via an `x-webhook-secret` header.

### Deduplication
Jira may fire the webhook more than once. The app keeps **one active cycle per
epic key** — repeat fires for an epic that already has an active cycle return
`{ deduplicated: true }` and do nothing.

---

## 5. Day-to-day flow

1. An epic moves to **Ready for UAT** → a cycle is created, the Canvas appears in
   the UAT channel, and all testers get a DM.
2. Patrick watches **/dashboard** (auto-refreshes every 10s). Click a cycle to
   expand per-tester status, notes, and timestamps.
3. Each tester opens their DM link (or Patrick re-shares
   `/tester/<slackUserId>/<cycleId>`), writes notes, and clicks **Mark as
   complete** → their box is checked on the Canvas and a confirmation posts to
   the channel.
4. When all testers are done the cycle auto-closes.

---

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/webhook/jira` | Jira webhook receiver (secret-protected). |
| `GET` | `/dashboard` | Patrick's dashboard UI. |
| `GET` | `/tester/:slackUserId/:cycleId` | Tester UI. |
| `GET` | `/api/cycles` | JSON list of all cycles + progress counts. |
| `GET` | `/api/cycles/:id` | JSON detail of one cycle incl. assignments. |
| `GET` | `/api/tester/:slackUserId/:cycleId` | JSON for the tester page. |
| `POST` | `/api/tester/notes` | Save notes (no completion). |
| `POST` | `/api/tester/complete` | Mark complete + save notes + Slack side effects. |
| `GET` | `/health` | Health check. |

### Manually testing the webhook
With the server running and a real (or no-op) Slack config:

```bash
curl -X POST "http://localhost:3000/webhook/jira?secret=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookEvent": "jira:issue_updated",
    "issue": {
      "key": "TEST-123",
      "fields": {
        "summary": "Checkout revamp",
        "issuetype": { "name": "Epic" },
        "status": { "name": "Ready for UAT" },
        "duedate": "2026-06-15"
      }
    },
    "changelog": { "items": [{ "field": "status", "toString": "Ready for UAT" }] }
  }'
```

Then open <http://localhost:3000/dashboard>.

---

## Project structure

```
/
├── server.js              # Express entry point
├── routes/
│   ├── webhook.js         # Jira webhook handler + cycle orchestration
│   ├── dashboard.js       # Patrick's UI + cycle JSON endpoints
│   └── tester.js          # Tester UI + complete/notes endpoints
├── services/
│   ├── slack.js           # All Slack API calls (canvas, DMs, channel posts)
│   ├── db.js              # SQLite setup + queries
│   └── config.js          # Env-derived helpers (testers, URLs)
├── public/
│   ├── dashboard.html
│   └── tester.html
├── data/                  # SQLite db lives here (gitignored)
├── .env.example
├── package.json
└── README.md
```
#   u a t - t e s t i n g - t r a c k i n g - s y s t e m  
 