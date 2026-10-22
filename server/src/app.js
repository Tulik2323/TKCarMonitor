'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { validateTelemetry } = require('./validate');

const MAX_BODY_BYTES = 1024 * 1024;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  // Hash both sides so the comparison length does not leak the secret's length.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createApp({ deviceToken, dashboardToken, store, publicDir }) {
  const streamClients = new Set();

  function broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of streamClients) client.write(data);
  }

  function requireDashboard(req, res, url) {
    // EventSource cannot set headers, so the live stream accepts ?token= too.
    const token = bearerToken(req) || url.searchParams.get('token');
    if (tokenMatches(token, dashboardToken)) return true;
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }

  async function handleApi(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/telemetry') {
      if (!tokenMatches(bearerToken(req), deviceToken)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = validateTelemetry(await readJsonBody(req));
      const added = store.addEvents(body.events);
      store.addPositions(body.positions);
      if (body.status) store.setStatus(body.status);
      added.forEach(broadcast);
      return sendJson(res, 200, {
        accepted: added.length,
        duplicates: body.events.length - added.length,
        positions: body.positions.length,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (!requireDashboard(req, res, url)) return;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
      const events = store.listEvents({
        type: url.searchParams.get('type') || undefined,
        since: Number(url.searchParams.get('since')) || 0,
        limit,
      });
      return sendJson(res, 200, { events });
    }

    if (req.method === 'GET' && url.pathname === '/api/positions') {
      if (!requireDashboard(req, res, url)) return;
      const positions = store.listPositions({ since: Number(url.searchParams.get('since')) || 0 });
      return sendJson(res, 200, { positions });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (!requireDashboard(req, res, url)) return;
      return sendJson(res, 200, { status: store.status });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      if (!requireDashboard(req, res, url)) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      streamClients.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(heartbeat);
        streamClients.delete(res);
      });
      return;
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  function serveStatic(res, pathname) {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(publicDir, requested));
    const type = STATIC_TYPES[path.extname(file)];
    if (!file.startsWith(publicDir + path.sep) || !type || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return serveStatic(res, url.pathname);
    } catch (err) {
      if (res.headersSent) return res.end();
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
    }
  });

  server.streamClients = streamClients;
  return server;
}

module.exports = { createApp, tokenMatches };
