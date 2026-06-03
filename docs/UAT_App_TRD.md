# Technical Reference Document (TRD)
## UAT Management App — v1.0.0
**Prepared by:** Automation Team — Nelson Villalba
**Date:** June 2026
**Status:** MVP — Local / Development

---

## 1. Purpose

This document describes the technical architecture, data model, API surface, and integration points of the UAT Management App. It is intended for developers who need to understand, extend, or deploy the system.

---

## 2. System Overview

The UAT Management App automates the coordination of User Acceptance Testing (UAT) cycles at Adoreal. When a Jira epic transitions to **"Ready for UAT"**, the app creates a tracking cycle, notifies testers via Slack, and provides a dashboard for Patrick (UAT owner) to monitor progress in real time.

### High-Level Flow

```
Jira Epic → "Ready for UAT"
        ↓
Jira Automation Rule (HTTP POST)
        ↓
POST /webhook/jira  ← Express App (Node.js)
        ↓
┌───────────────────────────────────────┐
│  1. Create cycle in SQLite DB         │
│  2. Seed tester assignments           │
│  3. Create Slack Canvas               │
│  4. Post channel announcement         │
│  5. DM each tester individually       │
└───────────────────────────────────────┘
        ↓
Daily cron (09:00) → deadline reminders
        ↓
Tester marks complete → canvas updated, channel notified
        ↓
All done → cycle auto-closes
```

---

## 3. Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | ≥ 20 LTS |
| Web framework | Express | ^4.22 |
| Database | SQLite via sql.js | ^1.12 |
| Slack integration | @slack/web-api | ^7.8 |
| Scheduler | node-cron | ^3.0 |
| Config | dotenv | ^16.4 |
| Frontend | Vanilla HTML/CSS/JS | — |

> **Why sql.js instead of better-sqlite3?** sql.js is a pure JavaScript SQLite implementation compiled to WebAssembly. It requires no native compilation (no node-gyp, no Visual Studio Build Tools), making it fully compatible with Windows development environments.

---

## 4. Project Structure

```
/
├── server.js                  # Express entry point, DB init, scheduler start
├── routes/
│   ├── webhook.js             # POST /webhook/jira — Jira event receiver + cycle orchestration
│   ├── dashboard.js           # GET /dashboard, /api/cycles, /api/cycles/:id
│   ├── tester.js              # GET /tester/:id/:cycle, POST /api/tester/complete
│   └── settings.js            # GET/POST /settings, /api/settings/*
├── services/
│   ├── slack.js               # All Slack Web API calls
│   ├── db.js                  # SQLite schema, queries, persistence
│   ├── scheduler.js           # Daily cron job for deadline reminders
│   └── config.js              # Env-derived helpers (URLs, trigger status)
├── public/
│   ├── dashboard.html         # Patrick's live dashboard
│   ├── tester.html            # Individual tester page
│   └── settings.html          # Admin settings page
├── data/
│   └── uat.db                 # SQLite database file (gitignored)
├── .env                       # Secret config (gitignored)
├── .env.example               # Template for environment variables
└── .gitignore
```

---

## 5. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JIRA_WEBHOOK_SECRET` | Yes | Shared secret validated on every webhook call (timing-safe) |
| `JIRA_BASE_URL` | Yes | e.g. `https://adoreal.atlassian.net` |
| `JIRA_API_TOKEN` | Optional | For future Jira REST API calls |
| `JIRA_EMAIL` | Optional | Account email for the API token |
| `JIRA_PROJECT_KEY` | Optional | Reference only — not used in routing logic |
| `SLACK_BOT_TOKEN` | Yes | Bot token starting with `xoxb-` |
| `SLACK_CHANNEL_ID` | Yes | Default UAT channel (overridable via Settings UI) |
| `SLACK_USER_IDS` | Yes | Comma-separated tester IDs — fallback when DB roster is empty |
| `PORT` | No | Default: `3000` |
| `APP_BASE_URL` | Yes | Public base URL for tester links (e.g. ngrok URL or production domain) |
| `TRIGGER_STATUS` | No | Jira status that fires the cycle. Default: `Ready for UAT` |

**No-op Slack mode:** if `SLACK_BOT_TOKEN` is empty, all Slack calls are silently skipped. The database and UI continue to work, which is useful for local UI testing.

---

## 6. Database Schema

The SQLite database lives at `data/uat.db` and is persisted to disk after every write via `db.export()` + `fs.writeFileSync()`.

### Table: `uat_cycles`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `jira_epic_key` | TEXT | e.g. `ATEST-1` |
| `jira_epic_name` | TEXT | Epic summary from Jira payload |
| `slack_canvas_id` | TEXT | Slack Canvas file ID (nullable until canvas is created) |
| `due_date` | TEXT | ISO date string `YYYY-MM-DD` (nullable) |
| `status` | TEXT | `active` or `closed` |
| `created_at` | TEXT | UTC datetime (SQLite `datetime('now')`) |

### Table: `tester_assignments`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `cycle_id` | INTEGER FK | References `uat_cycles.id` (CASCADE DELETE) |
| `slack_user_id` | TEXT | Slack member ID (e.g. `U0A0EHS8P24`) |
| `name` | TEXT | Display name resolved via `users.info` |
| `completed` | INTEGER | `0` or `1` |
| `notes` | TEXT | Tester's free-text observations |
| `completed_at` | TEXT | UTC datetime when marked complete (nullable) |

Unique constraint: `(cycle_id, slack_user_id)`.

### Table: `tester_roster`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `slack_user_id` | TEXT UNIQUE | Slack member ID |
| `name` | TEXT | Display name |
| `active` | INTEGER | `1` = included in next cycle, `0` = excluded |

### Table: `app_config`

| Column | Type | Description |
|---|---|---|
| `key` | TEXT PK | Config key (e.g. `slack_channel_id`) |
| `value` | TEXT | Config value |

---

## 7. API Reference

### Webhook

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/webhook/jira` | `?secret=` query param | Jira Automation receiver |

**Trigger logic:**
1. Validates the shared secret (timing-safe `crypto.timingSafeEqual`)
2. Forces `Content-Type: application/json` if header is missing (Jira Automation sends it blank)
3. Parses payload — supports 3 shapes: standard Jira envelope (A), Jira flat smart-values (B), double-encoded JSON string (C)
4. Checks `issueType === 'Epic'` AND `effectiveStatus === TRIGGER_STATUS`
5. Deduplicates: if an active cycle already exists for the epic key, returns `{ deduplicated: true }`
6. Otherwise calls `startCycle()` and returns `201 { created: true, cycleId }`

### Dashboard

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Patrick's dashboard HTML |
| GET | `/api/cycles` | JSON list of all cycles with progress counts |
| GET | `/api/cycles/:id` | JSON detail of one cycle including all assignments |

### Tester

| Method | Path | Description |
|---|---|---|
| GET | `/tester/:slackUserId/:cycleId` | Tester page HTML |
| GET | `/api/tester/:slackUserId/:cycleId` | JSON data for the tester page |
| POST | `/api/tester/notes` | Save notes only (no completion) |
| POST | `/api/tester/complete` | Mark complete + save notes + Slack side effects |

On `complete`: updates DB, rewrites Canvas checklist, posts completion notice to channel. If all testers are done, auto-closes the cycle.

### Settings

| Method | Path | Description |
|---|---|---|
| GET | `/settings` | Settings page HTML |
| GET | `/api/settings/testers` | List all testers in roster (seeds from env on first call) |
| POST | `/api/settings/testers` | Add tester `{ slack_user_id, name }` |
| DELETE | `/api/settings/testers/:id` | Remove tester |
| GET | `/api/settings/channel` | Current channel ID + resolved name |
| POST | `/api/settings/channel` | Update channel `{ channel_id }` |

### Utility

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Returns `{ ok: true }` — for uptime monitoring |

---

## 8. Slack Integration

### Required Bot Token Scopes

| Scope | Used for |
|---|---|
| `canvases:write` | Create and edit UAT Canvas documents |
| `canvases:read` | Read canvas metadata |
| `files:read` | Fetch the canvas permalink (shareable URL) |
| `chat:write` | Post messages to channels and DMs |
| `im:write` | Open DM conversations with testers |
| `users:read` | Resolve tester display names from Slack user IDs |
| `channels:read` | Resolve channel name in Settings UI (public channels) |
| `groups:read` | Resolve channel name in Settings UI (private channels) |

### Key Slack Calls (services/slack.js)

| Function | API Method | Purpose |
|---|---|---|
| `createCanvas()` | `canvases.create` + `canvases.access.set` + `files.info` | Create cycle canvas and share to channel |
| `updateCanvas()` | `canvases.edit` | Rewrite checklist when a tester completes |
| `postCycleStart()` | `chat.postMessage` | Channel announcement on cycle creation |
| `dmTester()` | `conversations.open` + `chat.postMessage` | Personal DM to each tester |
| `postCompletion()` | `chat.postMessage` | Confirmation when a tester marks done |
| `dmReminder()` | `conversations.open` + `chat.postMessage` | Deadline reminder DM |
| `postChannelReminder()` | `chat.postMessage` | Channel-level deadline reminder |
| `getUserName()` | `users.info` | Resolve display name from Slack user ID |
| `getChannelName()` | `conversations.info` | Resolve channel name for Settings UI |

All Slack calls handle errors gracefully — a Slack failure logs the error but never crashes the app or fails the HTTP response.

---

## 9. Scheduler

`services/scheduler.js` runs a cron job at **09:00 local server time** daily using `node-cron`.

On each run it:
1. Queries all active cycles with a `due_date` set
2. For each cycle, calculates days until due date (UTC date comparison)
3. If days = 3, 1, or 0: sends a channel reminder + individual DMs to incomplete testers only
4. Skips cycles where all testers are already complete

Urgency levels:

| Days until due | Urgency | Emoji prefix |
|---|---|---|
| 3 | `soon` | ⏰ |
| 1 | `tomorrow` | ⚠️ |
| 0 | `today` | 🚨 |

---

## 10. Jira Automation Configuration

Because global Jira webhooks require admin access, the app uses a **Jira Automation rule** at the project level:

- **Trigger:** Issue transitioned → To status: `Ready for UAT`
- **Action:** Send web request
  - Method: `POST`
  - URL: `{APP_BASE_URL}/webhook/jira?secret={JIRA_WEBHOOK_SECRET}`
  - Content-Type: `application/json` *(Note: Jira Automation sends requests with a blank Content-Type header; the app normalises this automatically via a pre-parser middleware)*
  - Body (custom data):
```json
{
  "webhookEvent": "jira:issue_updated",
  "issue": {
    "key": "{{issue.key}}",
    "fields": {
      "summary": "{{issue.summary}}",
      "issuetype": { "name": "{{issue.issueType.name}}" },
      "status": { "name": "{{issue.status.name}}" },
      "duedate": "{{issue.dueDate}}"
    }
  }
}
```

---

## 11. Known Limitations (MVP)

| Limitation | Notes |
|---|---|
| SQLite single-file DB | Not suitable for concurrent multi-instance deploy without migration to Postgres |
| ngrok URL changes on restart | `APP_BASE_URL` and Jira Automation URL must be updated each session |
| No authentication on dashboard/tester URLs | Anyone with the URL can access. Acceptable for internal use; add auth before public exposure |
| Scheduler runs on server local time | On UTC servers, 09:00 UTC = 09:00 local. Verify timezone on production deploy |
| Canvas URL requires `files:read` scope | If scope is missing, Canvas is still created but the permalink won't be embedded in DMs |
| `@Patrick` mention in reminders | Currently hardcoded as plain text. Should use Patrick's actual Slack user ID |

---

## 12. Local Development Checklist

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in all values in .env

# 3. Start the app
npm start
# Expected output:
# [slack] initialised
# [scheduler] daily reminder job scheduled (09:00 local time)
# UAT Management App listening on http://localhost:3000

# 4. Expose locally via ngrok (in a second terminal)
ngrok http 3000
# Copy the https://xxxx.ngrok-free.dev URL

# 5. Update .env
# APP_BASE_URL=https://xxxx.ngrok-free.dev
# Restart the app after changing .env

# 6. Update Jira Automation rule URL with the new ngrok URL

# 7. Test: change an epic to "Ready for UAT" in Jira
# Watch the terminal logs for the full cycle creation flow
```

---

## 13. Future Considerations

- **Production deploy:** Docker + Kubernetes manifests (to be documented once infra access is confirmed with Adoreal DevOps)
- **Database migration:** Replace sql.js with PostgreSQL for multi-instance support
- **Authentication:** Add session-based or OAuth auth to dashboard and tester pages
- **Due date from Jira:** Currently `duedate` field may be blank in the Jira Automation payload — consider enriching via Jira REST API using `JIRA_API_TOKEN`
- **Patrick's Slack ID:** Hardcode `@Patrick` mention in reminders using his actual user ID
- **Webhook HMAC signing:** Migrate from query-param secret to `X-Webhook-Secret` header HMAC for stricter security
