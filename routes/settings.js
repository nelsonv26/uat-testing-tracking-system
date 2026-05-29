'use strict';

const express = require('express');
const path = require('path');
const db = require('../services/db');
const slack = require('../services/slack');

const router = express.Router();

// ─── Settings UI page ────────────────────────────────────────────────────────

router.get('/settings', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'settings.html'));
});

// ─── Tester roster ───────────────────────────────────────────────────────────

/**
 * Seed tester_roster from SLACK_USER_IDS env var the first time the list is
 * fetched and the table is empty. Names are resolved via Slack (best-effort).
 */
async function maybeSeedRoster() {
  if (!db.rosterIsEmpty()) return;
  const ids = (process.env.SLACK_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return;

  console.log(`[settings] seeding tester_roster from env — ${ids.length} id(s)`);
  for (const slackUserId of ids) {
    db.addTesterToRoster({ slackUserId, name: slackUserId }); // placeholder
  }

  // Resolve real names asynchronously and update the roster.
  (async () => {
    const testers = db.listAllTesters();
    for (const t of testers) {
      try {
        const name = await slack.getUserName(t.slack_user_id);
        if (name && name !== t.slack_user_id) {
          db.updateTesterName(t.id, name);
          console.log(`[settings] resolved name for ${t.slack_user_id} => "${name}"`);
        }
      } catch (err) {
        console.error(`[settings] could not resolve name for ${t.slack_user_id}:`, err.message);
      }
    }
  })();
}

router.get('/api/settings/testers', async (req, res) => {
  try {
    await maybeSeedRoster();
    res.json(db.listAllTesters());
  } catch (err) {
    console.error('[settings] GET testers error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.post('/api/settings/testers', async (req, res) => {
  try {
    const { slack_user_id, name } = req.body || {};
    if (!slack_user_id) return res.status(400).json({ error: 'slack_user_id required' });
    const id = db.addTesterToRoster({ slackUserId: slack_user_id.trim(), name: name?.trim() || null });
    // If no name provided, try to resolve it from Slack in the background.
    if (!name) {
      slack.getUserName(slack_user_id.trim()).then((resolved) => {
        if (resolved && resolved !== slack_user_id.trim()) db.updateTesterName(id, resolved);
      }).catch(() => {});
    }
    res.status(201).json(db.listAllTesters());
  } catch (err) {
    console.error('[settings] POST testers error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.delete('/api/settings/testers/:id', (req, res) => {
  try {
    db.removeTesterFromRoster(Number(req.params.id));
    res.json(db.listAllTesters());
  } catch (err) {
    console.error('[settings] DELETE testers error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ─── Slack channel config ─────────────────────────────────────────────────────

router.get('/api/settings/channel', async (req, res) => {
  try {
    const channelId = slack.getChannelId();
    let channelName = null;
    if (channelId) {
      channelName = await slack.getChannelName(channelId);
    }
    res.json({ channel_id: channelId || '', channel_name: channelName });
  } catch (err) {
    console.error('[settings] GET channel error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.post('/api/settings/channel', async (req, res) => {
  try {
    const { channel_id } = req.body || {};
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    db.setConfig('slack_channel_id', channel_id.trim());
    const channelName = await slack.getChannelName(channel_id.trim());
    console.log(`[settings] channel updated — id=${channel_id} name=${channelName}`);
    res.json({ ok: true, channel_id: channel_id.trim(), channel_name: channelName });
  } catch (err) {
    console.error('[settings] POST channel error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = { router };
