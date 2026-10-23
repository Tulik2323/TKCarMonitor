import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../netlify/functions/lib/api.mjs';
import { createStorage } from '../netlify/functions/lib/storage.mjs';

const DEVICE = 'device-secret';
const DASHBOARD = 'dashboard-secret';
const DAY = 24 * 60 * 60 * 1000;

// In-memory stand-in for Netlify Blobs: only the methods storage.mjs uses.
function fakeBlobs() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return data.has(key) ? JSON.parse(data.get(key)) : null;
    },
    async setJSON(key, value) {
      data.set(key, JSON.stringify(value));
    },
    async delete(key) {
      data.delete(key);
    },
    list({ prefix }) {
      async function* pages() {
        yield { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
      }
      return pages();
    },
  };
}

function setup() {
  const blobs = fakeBlobs();
  const storage = createStorage(blobs);
  const deps = { storage, deviceToken: DEVICE, dashboardToken: DASHBOARD, retentionDays: 14 };
  const call = (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const init = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return handleRequest(new Request(`http://localhost${path}`, init), deps);
  };
  return { blobs, storage, call };
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

test('telemetry requires the device token', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/api/telemetry', { token: DASHBOARD, body: { events: [] } })).status, 401);
  assert.equal((await call('POST', '/api/telemetry', { body: { events: [] } })).status, 401);
});

test('telemetry answers 503 when the device token is not configured', async () => {
  const storage = createStorage(fakeBlobs());
  const deps = { storage, deviceToken: undefined, dashboardToken: DASHBOARD, retentionDays: 14 };
  const res = await handleRequest(
    new Request('http://localhost/api/telemetry', {
      method: 'POST',
      headers: { authorization: 'Bearer anything' },
      body: '{}',
    }),
    deps,
  );
  assert.equal(res.status, 503);
});

test('events are stored once even when the device resends them', async () => {
  const { call } = setup();
  const first = await call('POST', '/api/telemetry', { token: DEVICE, body: { events: [event()] } });
  assert.deepEqual(await first.json(), { accepted: 1, duplicates: 0, positions: 0 });

  const again = await call('POST', '/api/telemetry', { token: DEVICE, body: { events: [event()] } });
  assert.deepEqual(await again.json(), { accepted: 0, duplicates: 1, positions: 0 });

  const sync = await (await call('GET', '/api/sync', { token: DASHBOARD })).json();
  assert.equal(sync.events.length, 1);
});

test('invalid event types are rejected with 400', async () => {
  const { call } = setup();
  const res = await call('POST', '/api/telemetry', { token: DEVICE, body: { events: [event({ type: 'phone_use' })] } });
  assert.equal(res.status, 400);
});

test('invalid JSON is rejected with 400', async () => {
  const { call } = setup();
  const res = await handleRequest(
    new Request('http://localhost/api/telemetry', {
      method: 'POST',
      headers: { authorization: `Bearer ${DEVICE}` },
      body: '{not json',
    }),
    { storage: createStorage(fakeBlobs()), deviceToken: DEVICE, dashboardToken: DASHBOARD, retentionDays: 14 },
  );
  assert.equal(res.status, 400);
});

test('sync requires the dashboard token', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/sync', { token: DEVICE })).status, 401);
  assert.equal((await call('GET', '/api/sync')).status, 401);
  assert.equal((await call('GET', '/api/sync', { token: DASHBOARD })).status, 200);
});

test('sync returns only events newer than eventsSince', async () => {
  const { call } = setup();
  const now = Date.now();
  await call('POST', '/api/telemetry', {
    token: DEVICE,
    body: {
      events: [
        event({ id: 'old', ts: now - 2 * DAY }),
        event({ id: 'new', ts: now - 60_000 }),
      ],
    },
  });
  const res = await call('GET', `/api/sync?eventsSince=${now - DAY}`, { token: DASHBOARD });
  const body = await res.json();
  assert.deepEqual(body.events.map((e) => e.id), ['new']);
});

test('events from several days are read back in time order', async () => {
  const { call } = setup();
  const now = Date.now();
  await call('POST', '/api/telemetry', {
    token: DEVICE,
    body: { events: [event({ id: 'today', ts: now - 60_000 }), event({ id: 'yesterday', ts: now - 2 * DAY })] },
  });
  const body = await (await call('GET', `/api/sync?eventsSince=${now - 3 * DAY}`, { token: DASHBOARD })).json();
  assert.deepEqual(body.events.map((e) => e.id), ['yesterday', 'today']);
});

test('positions and status are stored and returned', async () => {
  const { call } = setup();
  const now = Date.now();
  await call('POST', '/api/telemetry', {
    token: DEVICE,
    body: {
      status: { battery: 87, lastFixAt: now },
      positions: [{ ts: now - 1000, lat: 32.1, lon: 34.8, speedKmh: 50 }],
    },
  });
  const body = await (await call('GET', '/api/sync', { token: DASHBOARD })).json();
  assert.equal(body.positions.length, 1);
  assert.equal(body.status.battery, 87);
});

test('resending the same position does not duplicate it', async () => {
  const { call } = setup();
  const position = { ts: Date.now() - 1000, lat: 32.1, lon: 34.8, speedKmh: 50 };
  await call('POST', '/api/telemetry', { token: DEVICE, body: { positions: [position] } });
  await call('POST', '/api/telemetry', { token: DEVICE, body: { positions: [position] } });
  const body = await (await call('GET', '/api/sync', { token: DASHBOARD })).json();
  assert.equal(body.positions.length, 1);
});

test('prune deletes day blobs older than the retention window and keeps recent ones', async () => {
  const { blobs, storage, call } = setup();
  const now = Date.now();
  await call('POST', '/api/telemetry', {
    token: DEVICE,
    body: {
      events: [event({ id: 'old', ts: now - 30 * DAY }), event({ id: 'recent', ts: now - 2 * DAY })],
      positions: [{ ts: now - 30 * DAY, lat: 1, lon: 1, speedKmh: 0 }],
    },
  });

  const removed = await storage.prune(14, now);
  assert.equal(removed, 2);
  assert.equal([...blobs.data.keys()].filter((k) => k.startsWith('events/')).length, 1);
  assert.equal([...blobs.data.keys()].filter((k) => k.startsWith('positions/')).length, 0);

  const body = await (await call('GET', `/api/sync?eventsSince=${now - 40 * DAY}`, { token: DASHBOARD })).json();
  assert.deepEqual(body.events.map((e) => e.id), ['recent']);
});

test('unknown paths return 404', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/nope', { token: DASHBOARD })).status, 404);
});
