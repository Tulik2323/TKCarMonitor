import { createHash, timingSafeEqual } from 'node:crypto';
import { validateTelemetry } from './validate.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POSITION_HOURS = 24;

function tokenMatches(given, expected) {
  if (!expected) return 'unconfigured';
  if (typeof given !== 'string' || given.length === 0) return false;
  // Hash both sides so the comparison does not leak the secret's length.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function checkAuth(req, expected) {
  const ok = tokenMatches(bearerToken(req), expected);
  if (ok === 'unconfigured') return json(503, { error: 'token not configured on server' });
  if (ok !== true) return json(401, { error: 'unauthorized' });
  return null;
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
  try {
    return JSON.parse(text || 'null');
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

async function handleTelemetry(req, { storage, deviceToken }) {
  const denied = checkAuth(req, deviceToken);
  if (denied) return denied;
  const body = validateTelemetry(await readBody(req));

  const addedEvents = await storage.addEvents(body.events);
  await storage.addPositions(body.positions);
  if (body.status) await storage.setStatus(body.status);

  return json(200, {
    accepted: addedEvents.length,
    duplicates: body.events.length - addedEvents.length,
    positions: body.positions.length,
  });
}

// Deletes the events in a time window (the dashboard sends one local day). Dashboard only.
async function handleDeleteEvents(req, url, { storage, dashboardToken }) {
  const denied = checkAuth(req, dashboardToken);
  if (denied) return denied;

  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to < from) {
    return json(400, { error: 'from and to must be epoch ms, with from <= to' });
  }
  return json(200, { removed: await storage.removeEvents(from, to) });
}

// One dashboard request returns events, positions and status for a time window.
// - Live view: the first call uses the defaults; later polls pass eventsSince / positionsSince.
// - Past day: the dashboard passes from and to, which apply to both events and positions.
async function handleSync(req, url, { storage, dashboardToken, retentionDays }) {
  const denied = checkAuth(req, dashboardToken);
  if (denied) return denied;

  const now = Date.now();
  const from = Number(url.searchParams.get('from')) || 0;
  const to = Number(url.searchParams.get('to')) || now;
  if (from > to) return json(400, { error: 'from must be before to' });

  const eventsSince = from || Number(url.searchParams.get('eventsSince')) || now - retentionDays * DAY_MS;
  const positionsSince = from || Number(url.searchParams.get('positionsSince')) || now - DEFAULT_POSITION_HOURS * 60 * 60 * 1000;

  const [events, positions, status] = await Promise.all([
    storage.readEvents(eventsSince, to),
    storage.readPositions(positionsSince, to),
    storage.readStatus(),
  ]);
  return json(200, { events, positions, status });
}

export async function handleRequest(req, deps) {
  const url = new URL(req.url);
  try {
    if (req.method === 'POST' && url.pathname === '/api/telemetry') return await handleTelemetry(req, deps);
    if (req.method === 'GET' && url.pathname === '/api/sync') return await handleSync(req, url, deps);
    if (req.method === 'DELETE' && url.pathname === '/api/events') return await handleDeleteEvents(req, url, deps);
    return json(404, { error: 'not found' });
  } catch (err) {
    return json(err.status || 500, { error: err.status ? err.message : 'internal error' });
  }
}
