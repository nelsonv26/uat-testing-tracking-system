'use strict';

const express = require('express');
const path = require('path');
const db = require('../services/db');

const router = express.Router();

router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

router.get('/api/cycles', (req, res) => {
  try {
    res.json(db.listCycles());
  } catch (err) {
    console.error('[dashboard] /api/cycles error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/api/cycles/:id', (req, res) => {
  try {
    const cycle = db.getCycle(Number(req.params.id));
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });
    const assignments = db.listAssignments(cycle.id);
    const done = assignments.filter((a) => a.completed).length;
    res.json({ ...cycle, total_testers: assignments.length, completed_testers: done, assignments });
  } catch (err) {
    console.error('[dashboard] /api/cycles/:id error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = { router };
