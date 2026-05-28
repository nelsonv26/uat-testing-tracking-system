'use strict';

const { WebClient } = require('@slack/web-api');

const token = process.env.SLACK_BOT_TOKEN;
const channelId = process.env.SLACK_CHANNEL_ID;

// When no token is configured (local dev without Slack) we run in a no-op mode
// so the rest of the app stays usable for UI / DB testing.
const enabled = Boolean(token);
const client = enabled ? new WebClient(token) : null;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn('[slack] SLACK_BOT_TOKEN not set — Slack calls will be skipped (no-op mode).');
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
 * Create a canvas for a UAT cycle and return { canvasId, canvasUrl }.
 * In no-op mode returns nulls.
 */
async function createCanvas(cycle, assignments, jiraUrl) {
  if (!enabled) return { canvasId: null, canvasUrl: null };

  const markdown = buildCanvasMarkdown(cycle, assignments, jiraUrl);
  const title = `UAT Cycle — ${cycle.jira_epic_name}${cycle.due_date ? ` (Due: ${cycle.due_date})` : ''}`;

  const res = await client.canvases.create({
    title,
    document_content: { type: 'markdown', markdown },
  });
  const canvasId = res.canvas_id;

  // Grant the UAT channel access so testers can open it.
  if (channelId) {
    try {
      await client.canvases.access.set({
        canvas_id: canvasId,
        access_level: 'write',
        channel_ids: [channelId],
      });
    } catch (err) {
      console.error('[slack] canvases.access.set failed:', err.data?.error || err.message);
    }
  }

  // A canvas is a file — pull its permalink for a shareable URL.
  let canvasUrl = null;
  try {
    const info = await client.files.info({ file: canvasId });
    canvasUrl = info.file?.permalink || null;
  } catch (err) {
    console.error('[slack] files.info failed:', err.data?.error || err.message);
  }

  return { canvasId, canvasUrl };
}

/** Rewrite the entire canvas document to reflect current checklist state. */
async function updateCanvas(cycle, assignments, jiraUrl) {
  if (!enabled || !cycle.slack_canvas_id) return;
  const markdown = buildCanvasMarkdown(cycle, assignments, jiraUrl);
  await client.canvases.edit({
    canvas_id: cycle.slack_canvas_id,
    changes: [
      {
        operation: 'replace',
        document_content: { type: 'markdown', markdown },
      },
    ],
  });
}

/** DM a single tester their UAT details + links. */
async function dmTester({ slackUserId, epicName, dueDate, canvasUrl, jiraUrl, testerUrl }) {
  if (!enabled) return;
  const open = await client.conversations.open({ users: slackUserId });
  const dmChannel = open.channel?.id;
  if (!dmChannel) throw new Error(`Could not open DM with ${slackUserId}`);

  const due = dueDate ? `*Due:* ${dueDate}\n` : '';
  const canvasLine = canvasUrl ? `*Canvas:* <${canvasUrl}|Open the UAT canvas>\n` : '';
  const text =
    `:test_tube: *You've been assigned to a UAT cycle*\n\n` +
    `*UAT:* ${epicName}\n` +
    due +
    `*Jira epic:* <${jiraUrl}|View in Jira>\n` +
    canvasLine +
    `*Your tester page:* <${testerUrl}|Leave notes & mark complete>`;

  await client.chat.postMessage({ channel: dmChannel, text });
}

/** Resolve a Slack user's display name; falls back to the id in no-op mode. */
async function getUserName(slackUserId) {
  if (!enabled) return slackUserId;
  try {
    const res = await client.users.info({ user: slackUserId });
    const p = res.user?.profile;
    return p?.real_name || p?.display_name || res.user?.name || slackUserId;
  } catch (err) {
    console.error('[slack] users.info failed:', err.data?.error || err.message);
    return slackUserId;
  }
}

/** Post a confirmation in the UAT channel when a tester finishes. */
async function postCompletion({ testerName, epicName }) {
  if (!enabled || !channelId) return;
  await client.chat.postMessage({
    channel: channelId,
    text: `:white_check_mark: *${testerName}* has completed UAT for *${epicName}*.`,
  });
}

module.exports = {
  enabled,
  buildCanvasMarkdown,
  getUserName,
  createCanvas,
  updateCanvas,
  dmTester,
  postCompletion,
};
