'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { Store } = require('../src/store');

const DEVICE = 'device-secret';
const DASHBOARD = 'dashboard-secret';

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkcm-'));
  const store = new Store(dataDir);
  const server = createApp({
    deviceToken: DEVICE,
    dashboardToken: DASHBOARD,
    store,
    publicDir: path.join(__dirname, '..', 'public'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => {
    for (const c of server.streamClients) c.end();
    server.close(resolve);
  });
  return { base, store, close, dataDir };
}

const event = (overrides = {}) => ({
  id: 'e1',
  type: 'hard_brake',
  ts: Date.now(),
  lat: 32.1,
  lon: 34.8,
  speedKmh: 80,
  value: 4.2,
  ...overrides,
});

const post = (base, token, body) => fetch(`${base}/api/telemetry`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('telemetry requires the device token', async () => {
  const s = await startServer();
  try {
    const res = await post(s.base, DASHBOARD, { events: [] });
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('events are stored once even when the device resends them', async () => {
  const s = await startServer();
  try {
    const first = await post(s.base, DEVICE, { events: [event()] });
    assert.deepEqual(await first.json(), { accepted: 1, duplicates: 0, positions: 0 });

    const again = await post(s.base, DEVICE, { events: [event()] });
    assert.deepEqual(await again.json(), { accepted: 0, duplicates: 1, positions: 0 });

    const list = await fetch(`${s.base}/api/events`, {
      headers: { Authorization: `Bearer ${DASHBOARD}` },
    }).then((r) => r.json());
    assert.equal(list.events.length, 1);
  } finally {
    await s.close();
  }
});

test('invalid event types are rejected with 400', async () => {
  const s = await startServer();
  try {
    const res = await post(s.base, DEVICE, { events: [event({ type: 'phone_use' })] });
    assert.equal(res.status, 400);
  } finally {
    await s.close();
  }
});

test('dashboard endpoints reject a wrong token and accept the right one', async () => {
  const s = await startServer();
  try {
    const bad = await fetch(`${s.base}/api/events`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
    const good = await fetch(`${s.base}/api/events?token=${DASHBOARD}`);
    assert.equal(good.status, 200);
  } finally {
    await s.close();
  }
});

test('events can be filtered by type', async () => {
  const s = await startServer();
  try {
    await post(s.base, DEVICE, {
      events: [event({ id: 'a', type: 'speeding' }), event({ id: 'b', type: 'crash' })],
    });
    const res = await fetch(`${s.base}/api/events?type=crash`, {
      headers: { Authorization: `Bearer ${DASHBOARD}` },
    }).then((r) => r.json());
    assert.deepEqual(res.events.map((e) => e.id), ['b']);
  } finally {
    await s.close();
  }
});

test('status and positions are stored and returned', async () => {
  const s = await startServer();
  try {
    const ts = Date.now();
    await post(s.base, DEVICE, {
      status: { battery: 87, lastFixAt: ts },
      positions: [{ ts, lat: 32.1, lon: 34.8, speedKmh: 50 }],
    });
    const headers = { Authorization: `Bearer ${DASHBOARD}` };
    const status = await fetch(`${s.base}/api/status`, { headers }).then((r) => r.json());
    assert.equal(status.status.battery, 87);
    const positions = await fetch(`${s.base}/api/positions`, { headers }).then((r) => r.json());
    assert.equal(positions.positions.length, 1);
  } finally {
    await s.close();
  }
});

test('live stream pushes newly accepted events', async () => {
  const s = await startServer();
  try {
    const stream = await fetch(`${s.base}/api/stream?token=${DASHBOARD}`);
    const reader = stream.body.getReader();
    await reader.read(); // ": connected"
    await post(s.base, DEVICE, { events: [event({ id: 'live' })] });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /"id":"live"/);
    await reader.cancel();
  } finally {
    await s.close();
  }
});

test('static files are served and path traversal is blocked', async () => {
  const s = await startServer();
  try {
    const index = await fetch(`${s.base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /ניטור נהיגה/);

    const traversal = await fetch(`${s.base}/..%2F..%2Fpackage.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await s.close();
  }
});

test('prune removes events and positions older than the retention window', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkcm-'));
  const store = new Store(dataDir, { retentionDays: 14 });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  store.addEvents([
    event({ id: 'old', ts: now - 15 * day }),
    event({ id: 'recent', ts: now - 13 * day }),
  ]);
  store.addPositions([
    { ts: now - 15 * day, lat: 1, lon: 1, speedKmh: 0 },
    { ts: now - 1 * day, lat: 1, lon: 1, speedKmh: 0 },
  ]);

  assert.equal(store.prune(now), 2);
  assert.deepEqual(store.listEvents().map((e) => e.id), ['recent']);
  assert.equal(store.listPositions().length, 1);

  // The pruned state is what a restart sees, and the old id can be stored again.
  const reopened = new Store(dataDir, { retentionDays: 14 });
  assert.deepEqual(reopened.listEvents().map((e) => e.id), ['recent']);
  assert.equal(reopened.positions.length, 1);
});

test('store survives a restart with the same data directory', async () => {
  const s = await startServer();
  await post(s.base, DEVICE, { events: [event({ id: 'persist' })] });
  await s.close();
  const reopened = new Store(s.dataDir);
  assert.equal(reopened.listEvents()[0].id, 'persist');
});
