'use strict';

const express = require('express');
const path = require('path');
const db = require('../services/db');
const slack = require('../services/slack');
const config = require('../services/config');

const router = express.Router();

// Tester UI page (data is loaded client-side from the JSON endpoint below).
router.get('/tester/:slackUserId/:cycleId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'tester.html'));
});

// JSON the tester page fetches to render itself.
router.get('/api/tester/:slackUserId/:cycleId', (req, res) => {
  try {
    const cycleId = Number(req.params.cycleId);
    const cycle = db.getCycle(cycleId);
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });

    const assignment = db.getAssignment(cycleId, req.params.slackUserId);
    if (!assignment) return res.status(404).json({ error: 'you are not assigned to this UAT cycle' });

    res.json({
      cycle: {
        id: cycle.id,
        jira_epic_key: cycle.jira_epic_key,
        jira_epic_name: cycle.jira_epic_name,
        due_date: cycle.due_date,
        status: cycle.status,
        jira_url: config.jiraEpicUrl(cycle.jira_epic_key),
      },
      assignment: {
        slack_user_id: assignment.slack_user_id,
        name: assignment.name,
        completed: Boolean(assignment.completed),
        notes: assignment.notes || '',
        completed_at: assignment.completed_at,
      },
    });
  } catch (err) {
    console.error('[tester] GET data error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Save notes without marking complete (autosave / partial save).
router.post('/api/tester/notes', (req, res) => {
  try {
    const { slackUserId, cycleId, notes } = req.body || {};
    if (!slackUserId || !cycleId) return res.status(400).json({ error: 'slackUserId and cycleId required' });
    const assignment = db.getAssignment(Number(cycleId), slackUserId);
    if (!assignment) return res.status(404).json({ error: 'assignment not found' });
    db.saveNotes({ cycleId: Number(cycleId), slackUserId, notes });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tester] save notes error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Mark complete + save notes, then update canvas + post to channel.
router.post('/api/tester/complete', async (req, res) => {
  try {
    const { slackUserId, cycleId, notes } = req.body || {};
    if (!slackUserId || !cycleId) return res.status(400).json({ error: 'slackUserId and cycleId required' });

    const id = Number(cycleId);
    const cycle = db.getCycle(id);
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });

    const assignment = db.getAssignment(id, slackUserId);
    if (!assignment) return res.status(404).json({ error: 'assignment not found' });

    const changed = db.completeAssignment({ cycleId: id, slackUserId, notes });
    if (!changed) return res.status(500).json({ error: 'could not update assignment' });

    const updatedAssignments = db.listAssignments(id);
    const jiraUrl = config.jiraEpicUrl(cycle.jira_epic_key);
    const testerName = assignment.name || slackUserId;

    // Best-effort Slack side effects — don't fail the request if Slack errors.
    try {
      await slack.updateCanvas(cycle, updatedAssignments, jiraUrl);
    } catch (err) {
      console.error('[tester] updateCanvas failed:', err.data?.error || err.message);
    }
    try {
      await slack.postCompletion({ testerName, epicName: cycle.jira_epic_name });
    } catch (err) {
      console.error('[tester] postCompletion failed:', err.data?.error || err.message);
    }

    // Auto-close the cycle once everyone is done.
    const allDone = updatedAssignments.length > 0 && updatedAssignments.every((a) => a.completed);
    if (allDone && cycle.status === 'active') db.closeCycle(id);

    res.json({ ok: true, allDone });
  } catch (err) {
    console.error('[tester] complete error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = { router };
