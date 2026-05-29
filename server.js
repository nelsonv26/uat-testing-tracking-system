'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

const webhook = require('./routes/webhook');
const dashboard = require('./routes/dashboard');
const tester = require('./routes/tester');
const settings = require('./routes/settings');

const app = express();

// Jira Automation sends POST requests with no Content-Type header, which
// causes express.json() to silently skip body parsing. Force it to JSON
// for any POST/PUT that arrives without a content-type.
app.use((req, _res, next) => {
  if ((req.method === 'POST' || req.method === 'PUT') &&
      (!req.headers['content-type'] || req.headers['content-type'].trim() === '')) {
    req.headers['content-type'] = 'application/json';
  }
  next();
});

// Always capture the raw body string (before JSON parsing) so the webhook
// route can log exactly what arrived, regardless of content-type.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: true }));

// Static assets.
app.use('/static', express.static(path.join(__dirname, 'public')));

// Health check.
app.get('/health', (req, res) => res.json({ ok: true }));

// Routes.
app.use('/webhook', webhook.router);
app.use('/', dashboard.router);
app.use('/', tester.router);
app.use('/', settings.router);

// Root -> dashboard.
app.get('/', (req, res) => res.redirect('/dashboard'));

// 404 fallback.
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Centralised error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

const { ready: dbReady } = require('./services/db');
const scheduler = require('./services/scheduler');

const PORT = process.env.PORT || 3000;
dbReady.then(() => {
  scheduler.start();
  app.listen(PORT, () => {
    console.log(`UAT Management App listening on http://localhost:${PORT}`);
    console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`  Settings:  http://localhost:${PORT}/settings`);
  });
}).catch((err) => {
  console.error('[server] failed to initialise database:', err);
  process.exit(1);
});

module.exports = app;
