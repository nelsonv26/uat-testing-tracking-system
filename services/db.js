'use strict';

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'uat.db');

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

  db.run(`
    CREATE TABLE IF NOT EXISTS tester_roster (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_user_id TEXT NOT NULL UNIQUE,
      name          TEXT,
      active        INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  persist();
});

// ─── Core helpers ────────────────────────────────────────────────────────────

function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function run(sql, params = []) {
  db.run(sql, params);
  const changes = db.getRowsModified();
  const [[lastInsertRowid]] = db.exec('SELECT last_insert_rowid()')[0]?.values ?? [[0]];
  persist();
  return { changes, lastInsertRowid };
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const results = all(sql, params);
  return results.length ? results[0] : undefined;
}

// ─── UAT cycles ──────────────────────────────────────────────────────────────

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

/** Active cycles that have a due_date set — used by the reminder scheduler. */
function listActiveCyclesWithDueDate() {
  return all(`SELECT * FROM uat_cycles WHERE status = 'active' AND due_date IS NOT NULL`);
}

// ─── Tester assignments ──────────────────────────────────────────────────────

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

// ─── Tester roster ───────────────────────────────────────────────────────────

function getActiveTesters() {
  return all(`SELECT * FROM tester_roster WHERE active = 1 ORDER BY id ASC`);
}

function listAllTesters() {
  return all(`SELECT * FROM tester_roster ORDER BY id ASC`);
}

function rosterIsEmpty() {
  const row = get(`SELECT COUNT(*) AS cnt FROM tester_roster`);
  return !row || row.cnt === 0;
}

function addTesterToRoster({ slackUserId, name }) {
  const { lastInsertRowid } = run(
    `INSERT OR IGNORE INTO tester_roster (slack_user_id, name) VALUES (?, ?)`,
    [slackUserId, name || null]
  );
  return lastInsertRowid;
}

function updateTesterName(id, name) {
  run(`UPDATE tester_roster SET name = ? WHERE id = ?`, [name, id]);
}

function removeTesterFromRoster(id) {
  run(`DELETE FROM tester_roster WHERE id = ?`, [id]);
}

// ─── App config ──────────────────────────────────────────────────────────────

function getConfig(key) {
  const row = get(`SELECT value FROM app_config WHERE key = ?`, [key]);
  return row ? row.value : null;
}

function setConfig(key, value) {
  run(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`, [key, String(value)]);
}

module.exports = {
  ready,
  // cycles
  findActiveCycleByEpic,
  createCycle,
  setCanvasId,
  closeCycle,
  getCycle,
  listCycles,
  listActiveCyclesWithDueDate,
  // assignments
  addAssignment,
  listAssignments,
  getAssignment,
  completeAssignment,
  saveNotes,
  // roster
  getActiveTesters,
  listAllTesters,
  rosterIsEmpty,
  addTesterToRoster,
  updateTesterName,
  removeTesterFromRoster,
  // config
  getConfig,
  setConfig,
};
