'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'uat.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS uat_cycles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    jira_epic_key   TEXT NOT NULL,
    jira_epic_name  TEXT NOT NULL,
    slack_canvas_id TEXT,
    due_date        TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tester_assignments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id      INTEGER NOT NULL,
    slack_user_id TEXT NOT NULL,
    name          TEXT,
    completed     INTEGER NOT NULL DEFAULT 0,
    notes         TEXT,
    completed_at  TEXT,
    FOREIGN KEY (cycle_id) REFERENCES uat_cycles(id) ON DELETE CASCADE,
    UNIQUE (cycle_id, slack_user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_cycle ON tester_assignments(cycle_id);
`);

// ─── UAT cycles ────────────────────────────────────────────────────────────

/**
 * Find an active cycle for a given epic key. Used to deduplicate webhook fires.
 */
function findActiveCycleByEpic(epicKey) {
  return db
    .prepare(`SELECT * FROM uat_cycles WHERE jira_epic_key = ? AND status = 'active' ORDER BY id DESC LIMIT 1`)
    .get(epicKey);
}

function createCycle({ epicKey, epicName, dueDate }) {
  const info = db
    .prepare(`INSERT INTO uat_cycles (jira_epic_key, jira_epic_name, due_date) VALUES (?, ?, ?)`)
    .run(epicKey, epicName, dueDate || null);
  return getCycle(info.lastInsertRowid);
}

function setCanvasId(cycleId, canvasId) {
  db.prepare(`UPDATE uat_cycles SET slack_canvas_id = ? WHERE id = ?`).run(canvasId, cycleId);
}

function closeCycle(cycleId) {
  db.prepare(`UPDATE uat_cycles SET status = 'closed' WHERE id = ?`).run(cycleId);
}

function getCycle(id) {
  return db.prepare(`SELECT * FROM uat_cycles WHERE id = ?`).get(id);
}

function listCycles() {
  const cycles = db.prepare(`SELECT * FROM uat_cycles ORDER BY created_at DESC, id DESC`).all();
  return cycles.map((c) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS done
         FROM tester_assignments WHERE cycle_id = ?`
      )
      .get(c.id);
    return { ...c, total_testers: counts.total, completed_testers: counts.done };
  });
}

// ─── Tester assignments ──────────────────────────────────────────────────

function addAssignment({ cycleId, slackUserId, name }) {
  db.prepare(
    `INSERT OR IGNORE INTO tester_assignments (cycle_id, slack_user_id, name) VALUES (?, ?, ?)`
  ).run(cycleId, slackUserId, name || null);
}

function listAssignments(cycleId) {
  return db
    .prepare(`SELECT * FROM tester_assignments WHERE cycle_id = ? ORDER BY id ASC`)
    .all(cycleId);
}

function getAssignment(cycleId, slackUserId) {
  return db
    .prepare(`SELECT * FROM tester_assignments WHERE cycle_id = ? AND slack_user_id = ?`)
    .get(cycleId, slackUserId);
}

function completeAssignment({ cycleId, slackUserId, notes }) {
  const info = db
    .prepare(
      `UPDATE tester_assignments
       SET completed = 1, notes = ?, completed_at = datetime('now')
       WHERE cycle_id = ? AND slack_user_id = ?`
    )
    .run(notes || null, cycleId, slackUserId);
  return info.changes > 0;
}

function saveNotes({ cycleId, slackUserId, notes }) {
  db.prepare(
    `UPDATE tester_assignments SET notes = ? WHERE cycle_id = ? AND slack_user_id = ?`
  ).run(notes || null, cycleId, slackUserId);
}

module.exports = {
  db,
  findActiveCycleByEpic,
  createCycle,
  setCanvasId,
  closeCycle,
  getCycle,
  listCycles,
  addAssignment,
  listAssignments,
  getAssignment,
  completeAssignment,
  saveNotes,
};
