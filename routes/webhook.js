'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../services/db');
const slack = require('../services/slack');
const config = require('../services/config');

const router = express.Router();

/** Timing-safe compare for the shared webhook secret. */
function secretValid(provided) {
  const expected = process.env.JIRA_WEBHOOK_SECRET || '';
  if (!expected) return false;
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Orchestrate creating a UAT cycle: persist it, seed tester assignments,
 * create the Slack canvas and DM every tester. Returns the created cycle.
 */
async function startCycle({ epicKey, epicName, dueDate }) {
  console.log(`[webhook] startCycle — epicKey=${epicKey} epicName="${epicName}" dueDate=${dueDate}`);

  const cycle = db.createCycle({ epicKey, epicName, dueDate });
  console.log(`[webhook] DB insert OK — cycle id=${cycle.id}`, cycle);

  const testerIds = config.getTesterIds();
  console.log(`[webhook] resolving ${testerIds.length} tester(s): ${testerIds.join(', ')}`);

  const named = await Promise.all(
    testerIds.map(async (id) => {
      const name = await slack.getUserName(id);
      console.log(`[webhook]   getUserName(${id}) => "${name}"`);
      return { id, name };
    })
  );

  for (const t of named) {
    db.addAssignment({ cycleId: cycle.id, slackUserId: t.id, name: t.name });
    console.log(`[webhook]   assignment added — cycleId=${cycle.id} slackUserId=${t.id} name="${t.name}"`);
  }

  const assignments = db.listAssignments(cycle.id);
  console.log(`[webhook] ${assignments.length} assignment(s) seeded for cycle ${cycle.id}`);

  const jiraUrl = config.jiraEpicUrl(epicKey);

  // Create canvas.
  let canvasUrl = null;
  console.log(`[webhook] creating Slack canvas for cycle ${cycle.id}…`);
  try {
    const { canvasId, canvasUrl: url } = await slack.createCanvas(cycle, assignments, jiraUrl);
    console.log(`[webhook] createCanvas result — canvasId=${canvasId} canvasUrl=${url}`);
    if (canvasId) {
      db.setCanvasId(cycle.id, canvasId);
      cycle.slack_canvas_id = canvasId;
      console.log(`[webhook] canvas id saved to DB for cycle ${cycle.id}`);
    }
    canvasUrl = url;
  } catch (err) {
    console.error('[webhook] createCanvas FAILED:', err.data?.error || err.message, err.data || '');
  }

  // DM each tester.
  console.log(`[webhook] sending DMs to ${assignments.length} tester(s)…`);
  await Promise.all(
    assignments.map(async (a) => {
      try {
        await slack.dmTester({
          slackUserId: a.slack_user_id,
          epicName,
          dueDate,
          canvasUrl,
          jiraUrl,
          testerUrl: config.testerUrl(a.slack_user_id, cycle.id),
        });
        console.log(`[webhook]   DM sent to ${a.slack_user_id}`);
      } catch (err) {
        console.error(
          `[webhook]   dmTester ${a.slack_user_id} FAILED:`,
          err.data?.error || err.message,
          err.data || ''
        );
      }
    })
  );

  const saved = db.getCycle(cycle.id);
  console.log(`[webhook] final cycle object from DB:`, saved);

  return saved;
}

router.post('/jira', async (req, res) => {
  try {
    console.log(`\n[webhook] ── incoming POST /webhook/jira ──────────────────────────`);
    console.log(`[webhook] headers: x-webhook-secret=${req.headers['x-webhook-secret']} query.secret=${req.query.secret}`);
    console.log(`[webhook] body:`, JSON.stringify(req.body, null, 2));

    const provided = req.query.secret || req.headers['x-webhook-secret'];
    if (!secretValid(provided)) {
      console.warn('[webhook] REJECTED — invalid or missing webhook secret');
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
    console.log(`[webhook] secret OK`);

    const body = req.body || {};
    const issue = body.issue || {};
    const fields = issue.fields || {};
    const issueType = fields.issuetype?.name;
    const epicKey = issue.key;
    const epicName = fields.summary || epicKey;
    const dueDate = fields.duedate || null;

    const trigger = config.triggerStatus();
    const changelogItems = body.changelog?.items || [];
    const statusChange = changelogItems.find((it) => it.field === 'status' || it.fieldId === 'status');
    // Use the Jira changelog `toString` field (the status name it changed TO).
    // Access via bracket notation to avoid accidentally calling Object.prototype.toString.
    const changedTo = statusChange?.['toString'];
    const currentStatus = fields.status?.name;
    const newStatus = changedTo || currentStatus;

    console.log(`[webhook] parsed — issueType="${issueType}" epicKey=${epicKey} epicName="${epicName}" dueDate=${dueDate}`);
    console.log(`[webhook] status — changedTo="${changedTo}" currentStatus="${currentStatus}" effectiveStatus="${newStatus}" triggerStatus="${trigger}"`);

    const isEpic = (issueType || '').toLowerCase() === 'epic';
    const matchesStatus = (newStatus || '').toLowerCase() === trigger.toLowerCase();

    if (!isEpic || !matchesStatus) {
      console.log(`[webhook] IGNORED — isEpic=${isEpic} matchesStatus=${matchesStatus}`);
      return res.status(200).json({ ignored: true, reason: 'not an epic transition to trigger status' });
    }

    if (!epicKey) {
      console.warn('[webhook] REJECTED — missing issue key');
      return res.status(400).json({ error: 'missing issue key' });
    }

    const existing = db.findActiveCycleByEpic(epicKey);
    if (existing) {
      console.log(`[webhook] DEDUPLICATED — active cycle already exists: id=${existing.id}`);
      return res.status(200).json({ deduplicated: true, cycleId: existing.id });
    }

    const cycle = await startCycle({ epicKey, epicName, dueDate });
    console.log(`[webhook] cycle created successfully — id=${cycle.id}`);
    console.log(`[webhook] ───────────────────────────────────────────────────────────\n`);
    return res.status(201).json({ created: true, cycleId: cycle.id });
  } catch (err) {
    console.error('[webhook] UNHANDLED ERROR:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

module.exports = { router, startCycle };
