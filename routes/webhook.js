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

  // Use tester_roster (DB) when populated; fall back to SLACK_USER_IDS env var.
  let testers = db.getActiveTesters(); // [{ id, slack_user_id, name }]
  if (testers.length === 0) {
    console.log(`[webhook] tester_roster is empty — falling back to SLACK_USER_IDS env var`);
    const ids = config.getTesterIds();
    testers = ids.map((id) => ({ slack_user_id: id, name: null }));
  }
  console.log(`[webhook] resolving ${testers.length} tester(s): ${testers.map((t) => t.slack_user_id).join(', ')}`);

  // Resolve display names for any tester without one in the roster.
  const named = await Promise.all(
    testers.map(async (t) => {
      const name = t.name || (await slack.getUserName(t.slack_user_id));
      console.log(`[webhook]   name for ${t.slack_user_id} => "${name}"`);
      return { id: t.slack_user_id, name };
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

  // Post channel notification (Feature 1).
  console.log(`[webhook] posting channel notification for cycle ${cycle.id}…`);
  await slack.postCycleStart({
    cycle,
    assignments,
    jiraUrl,
    testerUrlFn: config.testerUrl,
  });

  // DM each tester individually (Feature 2).
  console.log(`[webhook] sending DMs to ${assignments.length} tester(s)…`);
  await Promise.all(
    assignments.map(async (a) => {
      try {
        await slack.dmTester({
          slackUserId: a.slack_user_id,
          name: a.name,
          epicName,
          epicKey,
          dueDate,
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

/**
 * Extract issue fields from whichever payload shape Jira Automation sends.
 *
 * Shape A — custom JSON body we defined:
 *   { issue: { key, fields: { summary, duedate, issuetype, status } }, changelog: { items } }
 *
 * Shape B — Jira Automation native smart-values (flat top-level keys):
 *   { key, summary, issueType, status, dueDate, ... }
 *
 * Shape C — Jira Automation wraps our JSON as a string in `body` or `data`:
 *   { body: "{\"issue\":{...}}" }
 */
function parsePayload(raw, parsed) {
  // Shape A: standard Jira webhook envelope
  if (parsed.issue?.key) {
    const issue = parsed.issue;
    const fields = issue.fields || {};
    return {
      shape: 'A (standard envelope)',
      epicKey: issue.key,
      epicName: fields.summary || issue.key,
      dueDate: fields.duedate || null,
      issueType: fields.issuetype?.name || null,
      currentStatus: fields.status?.name || null,
      changelogItems: parsed.changelog?.items || [],
    };
  }

  // Shape C: our JSON was sent as a string inside a wrapper key
  const stringField = parsed.body || parsed.data || parsed.payload;
  if (typeof stringField === 'string') {
    try {
      const inner = JSON.parse(stringField);
      if (inner.issue?.key) {
        console.log('[webhook] shape C detected — unwrapped nested JSON string');
        return parsePayload(raw, inner);
      }
    } catch (_) { /* not JSON */ }
  }

  // Shape B: flat Jira Automation smart-values
  const epicKey = parsed.key || parsed.issueKey || parsed.epicKey || null;
  if (epicKey) {
    return {
      shape: 'B (flat smart-values)',
      epicKey,
      epicName: parsed.summary || parsed.epicName || epicKey,
      dueDate: parsed.dueDate || parsed.due_date || null,
      issueType: parsed.issueType || parsed.issue_type || null,
      currentStatus: parsed.status || parsed.statusName || null,
      changelogItems: [],
    };
  }

  // Unknown — return nulls; the caller will log and bail out
  return {
    shape: 'unknown',
    epicKey: null, epicName: null, dueDate: null,
    issueType: null, currentStatus: null, changelogItems: [],
  };
}

router.post('/jira', async (req, res) => {
  try {
    console.log(`\n[webhook] ── incoming POST /webhook/jira ──────────────────────────`);
    console.log(`[webhook] content-type: ${req.headers['content-type']}`);
    console.log(`[webhook] headers: x-webhook-secret=${req.headers['x-webhook-secret']} query.secret=${req.query.secret}`);
    console.log(`[webhook] raw body: ${req.rawBody}`);
    console.log(`[webhook] parsed body:`, JSON.stringify(req.body, null, 2));

    const provided = req.query.secret || req.headers['x-webhook-secret'];
    if (!secretValid(provided)) {
      console.warn('[webhook] REJECTED — invalid or missing webhook secret');
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
    console.log(`[webhook] secret OK`);

    const { shape, epicKey, epicName, dueDate, issueType, currentStatus, changelogItems } =
      parsePayload(req.rawBody, req.body || {});

    console.log(`[webhook] payload shape: ${shape}`);
    console.log(`[webhook] parsed — issueType="${issueType}" epicKey=${epicKey} epicName="${epicName}" dueDate=${dueDate}`);

    const trigger = config.triggerStatus();
    const statusChange = changelogItems.find((it) => it.field === 'status' || it.fieldId === 'status');
    // Bracket notation: avoids accidentally reading Object.prototype.toString instead of
    // the Jira changelog field of the same name.
    const changedTo = statusChange?.['toString'];
    const newStatus = changedTo || currentStatus;

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
