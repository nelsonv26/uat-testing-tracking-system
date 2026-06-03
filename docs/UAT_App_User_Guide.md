# UAT Management App — User Guide
**For:** Patrick Bivona (UAT Owner) & Testers
**Version:** 1.0 · June 2026

---

## What is this app?

The UAT Management App replaces the manual process of tracking who has completed UAT testing. Instead of following up in Slack or waiting for emails, the app automatically notifies testers, tracks their progress, and keeps Patrick informed in real time.

---

## How it works (the big picture)

```
Developer finishes a feature
        ↓
Epic in Jira moves to "Ready for UAT"
        ↓
App automatically:
  • Creates a checklist canvas in the UAT Slack channel
  • Posts a message in the channel with each tester's personal link
  • Sends a personal DM to every tester
        ↓
Each tester opens their link, does their testing, leaves notes, marks done
        ↓
Patrick watches the dashboard — sees live progress
        ↓
When everyone is done, the cycle closes automatically
```

---

## For Patrick — UAT Owner

### Watching progress on the Dashboard

Open your browser and go to:
```
http://[APP_URL]/dashboard
```

The dashboard shows every UAT cycle — past and current. For each cycle you can see:

- The epic name and Jira link
- How many testers have completed (e.g. "3/7 completed — 43%")
- A progress bar
- The status: **ACTIVE** (in progress) or **CLOSED** (everyone done)

**Click on any cycle** to expand it and see the full detail: each tester's name, their status (Done / Pending), their notes, and the time they completed.

The dashboard refreshes automatically every 10 seconds — you don't need to reload the page.

---

### Managing testers and the Slack channel (Settings)

Go to:
```
http://[APP_URL]/settings
```

**Tester Roster section:**
This is the list of people who get assigned to every new UAT cycle. To add someone:
1. Enter their **Slack User ID** (looks like `U012AB3CD` — see below for how to find it)
2. Optionally enter their display name
3. Click **Add Tester**

To remove someone, click **Remove** next to their name.

> Changes take effect on the **next** UAT cycle. Active cycles are not affected.

**How to find someone's Slack User ID:**
In Slack, click on the person's profile → click the three dots (⋯) → **Copy member ID**. It looks like `U0A0EHS8P24`.

**Slack Channel section:**
This shows which channel the app posts announcements to. If you need to change it, enter the new channel ID and click **Save**.

---

### What happens when a cycle starts

When a Jira epic moves to "Ready for UAT", the app automatically:

1. **Posts a message in the UAT channel** with:
   - The epic name and a link to Jira
   - The due date (if set on the Jira epic)
   - A personal link for each tester

2. **Sends a DM to every tester** with the same information and their personal link

You don't need to do anything manually. If the epic doesn't have a due date set in Jira, the app will note "No due date set" — you can always set it in Jira and the reminders will pick it up.

---

### Deadline reminders

The app sends automatic reminders every day at 9:00 AM. If a cycle has a due date set:

- **3 days before:** A channel message + DM to each tester who hasn't finished yet
- **1 day before:** A channel message + DM to pending testers
- **Day of:** A channel message + DM to pending testers (with your name mentioned)

Testers who have already completed don't receive reminders.

---

## For Testers

### You'll receive a DM when a UAT cycle starts

When a new UAT cycle is assigned to you, you'll get a direct message in Slack from the bot. It will include:

- The name of the feature being tested
- The due date
- A link to the Jira epic for context
- **Your personal tester page link** — this is where you do everything

### Your tester page

Click the link in your DM. Your personal page looks like this:

```
[Epic Name]
ATEST-1 · Due: June 15, 2026 · Status: PENDING

Open Jira epic ↗

Signed in as: [Your Name]

Your testing notes
┌─────────────────────────────────────────┐
│ Type your observations here...          │
│                                         │
└─────────────────────────────────────────┘

[Mark as complete]    [Save notes]
```

### Step by step

**1. Log into the Stage environment**
Follow the same process you always use to access the Stage account. Nothing changes here.

**2. Run through the test scenarios**
Refer to the Jira epic (linked on your page) or the Confluence release notes for what to test.

**3. Write your notes**
In the text area on your tester page, write down:
- What you tested
- Any bugs or unexpected behavior you found
- Questions or observations for the team

You can click **Save notes** at any point — this saves your notes without marking you as complete, so you can come back later.

**4. Mark yourself as complete**
When you're done with your testing, click **Mark as complete**. This will:
- Update your status on the checklist
- Post a confirmation in the UAT Slack channel
- Notify Patrick that you're done

> If everyone finishes, the cycle closes automatically and Patrick is notified.

---

### What if I lose my link?

Ask Patrick — he can see all tester links from the dashboard. Or check your DM history with the Automation bot.

---

### What if I complete accidentally?

No problem. You can still update your notes after marking complete. Your page will show a green banner saying when you completed, but you can keep editing your notes and re-submit.

---

### Reminders

If you haven't completed your testing yet, you'll automatically receive DM reminders:
- **3 days before the deadline**
- **1 day before the deadline**
- **On the day of the deadline**

You won't receive reminders once you've marked yourself complete.

---

## Frequently Asked Questions

**Q: What if I don't have a Slack DM with my link?**
A: Check the UAT channel — the bot posts a message there with all tester links when a cycle starts. Or ask Patrick.

**Q: Can I edit my notes after marking complete?**
A: Yes. Open your tester page, update the notes, and click "Mark as complete" again (or "Update & keep complete"). Your completion timestamp stays the same.

**Q: What if the Jira epic doesn't have a due date?**
A: The cycle will still be created and you'll be notified. The app will show "No due date set" and no deadline reminders will be sent. Patrick can set the due date in Jira at any time.

**Q: I was removed from the tester roster — will I still be assigned to active cycles?**
A: Removing yourself from the roster only affects future cycles. If you're already assigned to an active cycle, your assignment stays.

**Q: What does "CLOSED" mean on the dashboard?**
A: It means all testers have completed their UAT for that cycle. The cycle is done.
