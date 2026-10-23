'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { Store } = require('./store');

const deviceToken = process.env.DEVICE_TOKEN;
const dashboardToken = process.env.DASHBOARD_TOKEN;

if (!deviceToken || !dashboardToken) {
  console.error('Set DEVICE_TOKEN and DASHBOARD_TOKEN before starting the server.');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const port = Number(process.env.PORT) || 8080;

const retentionDays = Number(process.env.RETENTION_DAYS) || 14;

const store = new Store(dataDir, { retentionDays });
store.prune();
setInterval(() => store.prune(), 60 * 60 * 1000).unref();
const server = createApp({
  deviceToken,
  dashboardToken,
  store,
  publicDir: path.join(__dirname, '..', 'public'),
});

server.listen(port, () => console.log(`TKCarMonitor listening on port ${port}, data in ${dataDir}`));
