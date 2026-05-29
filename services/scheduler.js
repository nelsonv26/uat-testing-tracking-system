'use strict';

const cron = require('node-cron');
const db = require('./db');
const slack = require('./slack');
const config = require('./config');

/** Return today's date as YYYY-MM-DD in UTC. */
function todayUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Number of calendar days from today (UTC) until dateStr (YYYY-MM-DD). */
function daysUntil(dateStr) {
  const today = new Date(todayUTC() + 'T00:00:00Z');
  const due = new Date(dateStr + 'T00:00:00Z');
  return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

async function checkReminders() {
  const cycles = db.listActiveCyclesWithDueDate();
  console.log(`[scheduler] checking reminders — found ${cycles.length} active cycle(s) with due dates`);

  for (const cycle of cycles) {
    const days = daysUntil(cycle.due_date);
    const urgencyMap = { 3: 'soon', 1: 'tomorrow', 0: 'today' };
    const urgency = urgencyMap[days];

    if (!urgency) {
      console.log(`[scheduler] cycle ${cycle.id} "${cycle.jira_epic_name}" — ${days} day(s) away, no reminder needed`);
      continue;
    }

    const assignments = db.listAssignments(cycle.id);
    const incomplete = assignments.filter((a) => !a.completed);

    if (incomplete.length === 0) {
      console.log(`[scheduler] cycle ${cycle.id} "${cycle.jira_epic_name}" — all testers done, skipping reminder`);
      continue;
    }

    const pendingNames = incomplete.map((a) => a.name || a.slack_user_id);
    console.log(
      `[scheduler] sending urgency="${urgency}" reminder for cycle ${cycle.id} ` +
      `"${cycle.jira_epic_name}" — ${incomplete.length} incomplete tester(s): ${pendingNames.join(', ')}`
    );

    const jiraUrl = config.jiraEpicUrl(cycle.jira_epic_key);

    // Channel reminder.
    await slack.postChannelReminder({
      epicName: cycle.jira_epic_name,
      dueDate: cycle.due_date,
      urgency,
      pendingTesters: pendingNames,
    });

    // Personal DM to each incomplete tester only.
    await Promise.all(
      incomplete.map(async (a) => {
        try {
          await slack.dmReminder({
            slackUserId: a.slack_user_id,
            epicName: cycle.jira_epic_name,
            urgency,
            testerUrl: config.testerUrl(a.slack_user_id, cycle.id),
          });
        } catch (err) {
          console.error(
            `[scheduler] dmReminder ${a.slack_user_id} FAILED:`,
            err.data?.error || err.message
          );
        }
      })
    );
  }
}

/** Start the daily 9 AM cron job. Call this once after the DB is ready. */
function start() {
  // Runs at 09:00 every day (server local time).
  cron.schedule('0 9 * * *', async () => {
    console.log(`[scheduler] daily reminder job fired`);
    try {
      await checkReminders();
    } catch (err) {
      console.error('[scheduler] checkReminders error:', err);
    }
  });
  console.log('[scheduler] daily reminder job scheduled (09:00 local time)');
}

module.exports = { start, checkReminders };
