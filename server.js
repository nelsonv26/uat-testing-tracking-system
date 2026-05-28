'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

const webhook = require('./routes/webhook');
const dashboard = require('./routes/dashboard');
const tester = require('./routes/tester');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Static assets (css/js could live here too).
app.use('/static', express.static(path.join(__dirname, 'public')));

// Health check.
app.get('/health', (req, res) => res.json({ ok: true }));

// Routes.
app.use('/webhook', webhook.router);
app.use('/', dashboard.router);
app.use('/', tester.router);

// Root -> dashboard.
app.get('/', (req, res) => res.redirect('/dashboard'));

// 404 fallback.
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Centralized error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

const { ready: dbReady } = require('./services/db');

const PORT = process.env.PORT || 3000;
dbReady.then(() => {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`UAT Management App listening on http://localhost:${PORT}`);
    console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  });
}).catch((err) => {
  console.error('[server] failed to initialise database:', err);
  process.exit(1);
});

module.exports = app;
