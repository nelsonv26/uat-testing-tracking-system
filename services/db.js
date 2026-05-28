'use strict';

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'uat.db');

// sql.js is async-initialised; we expose a promise that callers await via
// the module-level `ready` export, but all the named functions below defer
// internally so callers that await `ready` first will work correctly.
let db;

const ready = initSqlJs().then((SQL) => {
  const buf = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  db = buf ? new SQL.Database(buf) : new SQL.Database();

  db.run(`PRAGMA foreign_keys = ON`);

  db.run(`
    CREATE TABLE IF NOT EXISTS uat_cycles (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      jira_epic_key   TEXT NOT NULL,
      jira_epic_name  TEXT NOT NULL,
      slack_canvas_id TEXT,
      due_date        TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
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
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_assignments_cycle ON tester_assignments(cycle_id)`);

  persist();
});

// Flush the in-memory database to disk as a binary buffer.
function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Execute a statement that does not return rows (INSERT / UPDATE / DELETE).
// Returns { changes, lastInsertRowid } to mirror the better-sqlite3 interface.
function run(sql, params = []) {
  db.run(sql, params);
  const changes = db.getRowsModified();
  const [[lastInsertRowid]] = db.exec('SELECT last_insert_rowid()')[0]?.values ?? [[0]];
  persist();
  return { changes, lastInsertRowid };
}

// Return all matching rows as plain objects.
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Return the first matching row or undefined.
function get(sql, params = []) {
  const results = all(sql, params);
  return results.length ? results[0] : undefined;
}

// ─── UAT cycles ────────────────────────────────────────────────────────────

function findActiveCycleByEpic(epicKey) {
  return get(
    `SELECT * FROM uat_cycles WHERE jira_epic_key = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    [epicKey]
  );
}

function createCycle({ epicKey, epicName, dueDate }) {
  const { lastInsertRowid } = run(
    `INSERT INTO uat_cycles (jira_epic_key, jira_epic_name, due_date) VALUES (?, ?, ?)`,
    [epicKey, epicName, dueDate || null]
  );
  return getCycle(lastInsertRowid);
}

function setCanvasId(cycleId, canvasId) {
  run(`UPDATE uat_cycles SET slack_canvas_id = ? WHERE id = ?`, [canvasId, cycleId]);
}

function closeCycle(cycleId) {
  run(`UPDATE uat_cycles SET status = 'closed' WHERE id = ?`, [cycleId]);
}

function getCycle(id) {
  return get(`SELECT * FROM uat_cycles WHERE id = ?`, [id]);
}

function listCycles() {
  const cycles = all(`SELECT * FROM uat_cycles ORDER BY created_at DESC, id DESC`);
  return cycles.map((c) => {
    const counts = get(
      `SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS done
       FROM tester_assignments WHERE cycle_id = ?`,
      [c.id]
    );
    return { ...c, total_testers: counts.total, completed_testers: counts.done };
  });
}

// ─── Tester assignments ──────────────────────────────────────────────────

function addAssignment({ cycleId, slackUserId, name }) {
  run(
    `INSERT OR IGNORE INTO tester_assignments (cycle_id, slack_user_id, name) VALUES (?, ?, ?)`,
    [cycleId, slackUserId, name || null]
  );
}

function listAssignments(cycleId) {
  return all(
    `SELECT * FROM tester_assignments WHERE cycle_id = ? ORDER BY id ASC`,
    [cycleId]
  );
}

function getAssignment(cycleId, slackUserId) {
  return get(
    `SELECT * FROM tester_assignments WHERE cycle_id = ? AND slack_user_id = ?`,
    [cycleId, slackUserId]
  );
}

function completeAssignment({ cycleId, slackUserId, notes }) {
  const { changes } = run(
    `UPDATE tester_assignments
     SET completed = 1, notes = ?, completed_at = datetime('now')
     WHERE cycle_id = ? AND slack_user_id = ?`,
    [notes || null, cycleId, slackUserId]
  );
  return changes > 0;
}

function saveNotes({ cycleId, slackUserId, notes }) {
  run(
    `UPDATE tester_assignments SET notes = ? WHERE cycle_id = ? AND slack_user_id = ?`,
    [notes || null, cycleId, slackUserId]
  );
}

module.exports = {
  ready,
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
