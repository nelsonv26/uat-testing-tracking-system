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
  const cycle = db.createCycle({ epicKey, epicName, dueDate });

  const testerIds = config.getTesterIds();
  // Resolve display names (best effort) and seed assignments.
  const named = await Promise.all(
    testerIds.map(async (id) => ({ id, name: await slack.getUserName(id) }))
  );
  for (const t of named) {
    db.addAssignment({ cycleId: cycle.id, slackUserId: t.id, name: t.name });
  }

  const assignments = db.listAssignments(cycle.id);
  const jiraUrl = config.jiraEpicUrl(epicKey);

  // Create canvas.
  let canvasUrl = null;
  try {
    const { canvasId, canvasUrl: url } = await slack.createCanvas(cycle, assignments, jiraUrl);
    if (canvasId) {
      db.setCanvasId(cycle.id, canvasId);
      cycle.slack_canvas_id = canvasId;
    }
    canvasUrl = url;
  } catch (err) {
    console.error('[webhook] createCanvas failed:', err.data?.error || err.message);
  }

  // DM each tester (failures per-tester shouldn't abort the rest).
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
      } catch (err) {
        console.error(`[webhook] dmTester ${a.slack_user_id} failed:`, err.data?.error || err.message);
      }
    })
  );

  return cycle;
}

router.post('/jira', async (req, res) => {
  try {
    const provided = req.query.secret || req.headers['x-webhook-secret'];
    if (!secretValid(provided)) {
      return res.status(401).json({ error: 'invalid webhook secret' });
    }

    const body = req.body || {};
    const issue = body.issue || {};
    const fields = issue.fields || {};
    const issueType = fields.issuetype?.name;
    const epicKey = issue.key;
    const epicName = fields.summary || epicKey;
    const dueDate = fields.duedate || null;

    // Determine the status the issue changed TO. Prefer the changelog (proves a
    // transition happened) and fall back to current status.
    const trigger = config.triggerStatus();
    const changelogItems = body.changelog?.items || [];
    const statusChange = changelogItems.find((it) => it.field === 'status' || it.fieldId === 'status');
    const changedTo = statusChange?.toString;
    const currentStatus = fields.status?.name;
    const newStatus = changedTo || currentStatus;

    const isEpic = (issueType || '').toLowerCase() === 'epic';
    const matchesStatus = (newStatus || '').toLowerCase() === trigger.toLowerCase();

    if (!isEpic || !matchesStatus) {
      return res.status(200).json({ ignored: true, reason: 'not an epic transition to trigger status' });
    }

    if (!epicKey) {
      return res.status(400).json({ error: 'missing issue key' });
    }

    // Deduplicate: if an active cycle already exists for this epic, do nothing.
    const existing = db.findActiveCycleByEpic(epicKey);
    if (existing) {
      return res.status(200).json({ deduplicated: true, cycleId: existing.id });
    }

    const cycle = await startCycle({ epicKey, epicName, dueDate });
    return res.status(201).json({ created: true, cycleId: cycle.id });
  } catch (err) {
    console.error('[webhook] error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

module.exports = { router, startCycle };
