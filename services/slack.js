'use strict';

const { WebClient } = require('@slack/web-api');

const token = process.env.SLACK_BOT_TOKEN;

const enabled = Boolean(token);
const client = enabled ? new WebClient(token) : null;

if (!enabled) {
  console.warn('[slack] SLACK_BOT_TOKEN not set — Slack calls will be skipped (no-op mode).');
} else {
  console.log(`[slack] initialised`);
}

/**
 * Runtime channel ID: reads from app_config first, falls back to env var.
 * Returns null if neither is set.
 */
function getChannelId() {
  try {
    const db = require('./db');
    return db.getConfig('slack_channel_id') || process.env.SLACK_CHANNEL_ID || null;
  } catch {
    return process.env.SLACK_CHANNEL_ID || null;
  }
}

/** Build the canvas markdown body from the current cycle + assignments state. */
function buildCanvasMarkdown(cycle, assignments, jiraUrl) {
  const due = cycle.due_date ? ` (Due: ${cycle.due_date})` : '';
  const lines = [];
  lines.push(`# UAT Cycle — ${cycle.jira_epic_name}${due}`);
  lines.push('');
  lines.push(`**Jira epic:** [${cycle.jira_epic_key}](${jiraUrl})`);
  lines.push('');
  lines.push('## Instructions');
  lines.push(
    '> Please run through the test scenarios for this epic. Record any issues in your tester page, ' +
      'then mark yourself complete. Reach out to Patrick with blockers.'
  );
  lines.push('');
  lines.push('## Tester checklist');
  for (const a of assignments) {
    const box = a.completed ? '[x]' : '[ ]';
    const who = a.name || a.slack_user_id;
    lines.push(`- ${box} ${who}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Post a channel message when a UAT cycle starts (Feature 1).
 * Includes epic link, due date, per-tester personal links, and a footer.
 */
async function postCycleStart({ cycle, assignments, jiraUrl, testerUrlFn }) {
  const channelId = getChannelId();
  if (!enabled || !channelId) {
    console.log('[slack] postCycleStart — no-op (no token or channel)');
    return;
  }

  const due = cycle.due_date || 'No due date set';
  const testerLines = assignments
    .map((a) => `• ${a.name || a.slack_user_id} → ${testerUrlFn(a.slack_user_id, cycle.id)}`)
    .join('\n');

  const text =
    `:rocket: *New UAT Cycle started: ${cycle.jira_epic_name}*\n\n` +
    `*Jira epic:* <${jiraUrl}|${cycle.jira_epic_key}>\n` +
    `*Due date:* ${due}\n\n` +
    `*Testers:*\n${testerLines}\n\n` +
    `_Please complete your UAT before the deadline and mark yourself done at your personal link above._`;

  console.log(`[slack] postCycleStart — channel=${channelId}`);
  try {
    await client.chat.postMessage({ channel: channelId, text });
    console.log(`[slack] postCycleStart OK`);
  } catch (err) {
    console.error('[slack] postCycleStart FAILED:', err.data?.error || err.message, err.data || '');
  }
}

/**
 * Create a canvas for a UAT cycle and return { canvasId, canvasUrl }.
 * In no-op mode returns nulls.
 */
async function createCanvas(cycle, assignments, jiraUrl) {
  if (!enabled) {
    console.log('[slack] createCanvas — no-op (no token)');
    return { canvasId: null, canvasUrl: null };
  }

  const markdown = buildCanvasMarkdown(cycle, assignments, jiraUrl);
  const title = `UAT Cycle — ${cycle.jira_epic_name}${cycle.due_date ? ` (Due: ${cycle.due_date})` : ''}`;
  console.log(`[slack] canvases.create — title="${title}"`);

  const res = await client.canvases.create({
    title,
    document_content: { type: 'markdown', markdown },
  });
  const canvasId = res.canvas_id;
  console.log(`[slack] canvases.create OK — canvasId=${canvasId}`);

  const channelId = getChannelId();
  if (channelId) {
    console.log(`[slack] canvases.access.set — canvasId=${canvasId} channelId=${channelId}`);
    try {
      await client.canvases.access.set({
        canvas_id: canvasId,
        access_level: 'write',
        channel_ids: [channelId],
      });
      console.log(`[slack] canvases.access.set OK`);
    } catch (err) {
      console.error('[slack] canvases.access.set FAILED:', err.data?.error || err.message, err.data || '');
    }
  }

  let canvasUrl = null;
  console.log(`[slack] files.info — canvasId=${canvasId}`);
  try {
    const info = await client.files.info({ file: canvasId });
    canvasUrl = info.file?.permalink || null;
    console.log(`[slack] files.info OK — permalink=${canvasUrl}`);
  } catch (err) {
    console.error('[slack] files.info FAILED:', err.data?.error || err.message, err.data || '');
  }

  return { canvasId, canvasUrl };
}

/** Rewrite the entire canvas document to reflect current checklist state. */
async function updateCanvas(cycle, assignments, jiraUrl) {
  if (!enabled || !cycle.slack_canvas_id) return;
  console.log(`[slack] canvases.edit — canvasId=${cycle.slack_canvas_id}`);
  const markdown = buildCanvasMarkdown(cycle, assignments, jiraUrl);
  await client.canvases.edit({
    canvas_id: cycle.slack_canvas_id,
    changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown } }],
  });
  console.log(`[slack] canvases.edit OK`);
}

/**
 * DM a single tester their UAT details (Feature 2).
 * name is the tester's display name for the greeting.
 */
async function dmTester({ slackUserId, name, epicName, epicKey, dueDate, jiraUrl, testerUrl }) {
  if (!enabled) {
    console.log(`[slack] dmTester ${slackUserId} — no-op (no token)`);
    return;
  }
  console.log(`[slack] conversations.open — userId=${slackUserId}`);
  const open = await client.conversations.open({ users: slackUserId });
  const dmChannel = open.channel?.id;
  if (!dmChannel) throw new Error(`Could not open DM with ${slackUserId}`);
  console.log(`[slack] conversations.open OK — dmChannel=${dmChannel}`);

  const greeting = name ? `👋 Hi ${name}!` : '👋 Hi!';
  const due = dueDate ? `*Due date:* ${dueDate}\n` : '';
  const text =
    `${greeting} A new UAT cycle has been assigned to you.\n\n` +
    `*Epic:* <${jiraUrl}|${epicName || epicKey}>\n` +
    due +
    `\n*Your personal tester page (complete your testing here):*\n${testerUrl}\n\n` +
    `_Please complete your testing and mark yourself done._`;

  console.log(`[slack] chat.postMessage (DM) — channel=${dmChannel} userId=${slackUserId}`);
  await client.chat.postMessage({ channel: dmChannel, text });
  console.log(`[slack] chat.postMessage (DM) OK — delivered to ${slackUserId}`);
}

/** Resolve a Slack user's display name; falls back to the id in no-op mode. */
async function getUserName(slackUserId) {
  if (!enabled) {
    console.log(`[slack] getUserName ${slackUserId} — no-op, returning id`);
    return slackUserId;
  }
  console.log(`[slack] users.info — userId=${slackUserId}`);
  try {
    const res = await client.users.info({ user: slackUserId });
    const p = res.user?.profile;
    const name = p?.real_name || p?.display_name || res.user?.name || slackUserId;
    console.log(`[slack] users.info OK — name="${name}"`);
    return name;
  } catch (err) {
    console.error('[slack] users.info FAILED:', err.data?.error || err.message, err.data || '');
    return slackUserId;
  }
}

/** Post a completion notice to the UAT channel when a tester finishes. */
async function postCompletion({ testerName, epicName }) {
  const channelId = getChannelId();
  if (!enabled || !channelId) return;
  console.log(`[slack] chat.postMessage (completion) — testerName="${testerName}" epicName="${epicName}"`);
  try {
    await client.chat.postMessage({
      channel: channelId,
      text: `:white_check_mark: *${testerName}* has completed UAT for *${epicName}*.`,
    });
    console.log(`[slack] chat.postMessage (completion) OK`);
  } catch (err) {
    console.error('[slack] postCompletion FAILED:', err.data?.error || err.message, err.data || '');
  }
}

/**
 * Send a reminder DM to a single tester (used by the scheduler).
 * urgency: 'soon' (3 days) | 'tomorrow' (1 day) | 'today' (due today)
 */
async function dmReminder({ slackUserId, epicName, urgency, testerUrl }) {
  if (!enabled) {
    console.log(`[slack] dmReminder ${slackUserId} urgency=${urgency} — no-op`);
    return;
  }
  const messages = {
    soon:     `⏰ Reminder: your UAT for *${epicName}* is due in 3 days. Don't forget to complete it:\n${testerUrl}`,
    tomorrow: `⚠️ Your UAT for *${epicName}* is due *TOMORROW*. Please complete it today:\n${testerUrl}`,
    today:    `🚨 Your UAT for *${epicName}* is *DUE TODAY*. Complete it now:\n${testerUrl}`,
  };
  const text = messages[urgency];
  if (!text) return;

  console.log(`[slack] dmReminder — userId=${slackUserId} urgency=${urgency}`);
  try {
    const open = await client.conversations.open({ users: slackUserId });
    const dmChannel = open.channel?.id;
    if (!dmChannel) throw new Error(`Could not open DM with ${slackUserId}`);
    await client.chat.postMessage({ channel: dmChannel, text });
    console.log(`[slack] dmReminder OK — ${slackUserId}`);
  } catch (err) {
    console.error(`[slack] dmReminder FAILED ${slackUserId}:`, err.data?.error || err.message, err.data || '');
  }
}

/**
 * Post a reminder message to the UAT channel (used by the scheduler).
 * urgency: 'soon' | 'tomorrow' | 'today'
 */
async function postChannelReminder({ epicName, dueDate, urgency, pendingTesters }) {
  const channelId = getChannelId();
  if (!enabled || !channelId) return;

  const pending = pendingTesters.length ? pendingTesters.join(', ') : '(none)';
  const messages = {
    soon:     `⏰ Reminder: UAT cycle *${epicName}* is due in 3 days (${dueDate}). Still pending: ${pending}`,
    tomorrow: `⚠️ UAT cycle *${epicName}* is due *TOMORROW* (${dueDate}). Pending: ${pending}`,
    today:    `🚨 UAT cycle *${epicName}* is *DUE TODAY* (${dueDate}). Still incomplete: ${pending}. <@Patrick> please review.`,
  };
  const text = messages[urgency];
  if (!text) return;

  console.log(`[slack] postChannelReminder — urgency=${urgency} epicName="${epicName}"`);
  try {
    await client.chat.postMessage({ channel: channelId, text });
    console.log(`[slack] postChannelReminder OK`);
  } catch (err) {
    console.error('[slack] postChannelReminder FAILED:', err.data?.error || err.message, err.data || '');
  }
}

/**
 * Resolve a channel's display name via conversations.info.
 * Returns null on any error (missing_scope, not found, etc.).
 */
async function getChannelName(channelId) {
  if (!enabled || !channelId) return null;
  try {
    const res = await client.conversations.info({ channel: channelId });
    return res.channel?.name || null;
  } catch (err) {
    console.error('[slack] conversations.info FAILED:', err.data?.error || err.message);
    return null;
  }
}

module.exports = {
  enabled,
  getChannelId,
  buildCanvasMarkdown,
  getUserName,
  createCanvas,
  updateCanvas,
  postCycleStart,
  dmTester,
  dmReminder,
  postChannelReminder,
  postCompletion,
  getChannelName,
};
