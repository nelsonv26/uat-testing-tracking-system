'use strict';

function getTesterIds() {
  return (process.env.SLACK_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function appBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  return `http://localhost:${process.env.PORT || 3000}`;
}

function jiraEpicUrl(epicKey) {
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
  return `${base}/browse/${epicKey}`;
}

function testerUrl(slackUserId, cycleId) {
  return `${appBaseUrl()}/tester/${encodeURIComponent(slackUserId)}/${cycleId}`;
}

function triggerStatus() {
  return (process.env.TRIGGER_STATUS || 'Ready for UAT').trim();
}

module.exports = { getTesterIds, appBaseUrl, jiraEpicUrl, testerUrl, triggerStatus };
