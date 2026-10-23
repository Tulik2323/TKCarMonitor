'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_IN_MEMORY = 50000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;

function writeJsonLines(file, rows) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, rows.map((row) => JSON.stringify(row) + '\n').join(''));
  fs.renameSync(tmp, file);
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn last line after a crash is skipped rather than blocking startup.
    }
  }
  return rows;
}

class Store {
  constructor(dataDir, { retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.retentionMs = retentionDays * DAY_MS;
    this.eventsFile = path.join(dataDir, 'events.jsonl');
    this.positionsFile = path.join(dataDir, 'positions.jsonl');
    this.statusFile = path.join(dataDir, 'status.json');

    this.events = readJsonLines(this.eventsFile).slice(-MAX_IN_MEMORY);
    this.eventIds = new Set(this.events.map((e) => e.id));
    this.positions = readJsonLines(this.positionsFile).slice(-MAX_IN_MEMORY);
    this.status = fs.existsSync(this.statusFile)
      ? JSON.parse(fs.readFileSync(this.statusFile, 'utf8'))
      : null;
  }

  // Returns the events that were new. Duplicates (same id) are ignored so the
  // device can safely resend a batch after a lost response.
  addEvents(events) {
    const added = [];
    for (const e of events) {
      if (this.eventIds.has(e.id)) continue;
      this.eventIds.add(e.id);
      this.events.push(e);
      fs.appendFileSync(this.eventsFile, JSON.stringify(e) + '\n');
      added.push(e);
    }
    if (this.events.length > MAX_IN_MEMORY) {
      const dropped = this.events.splice(0, this.events.length - MAX_IN_MEMORY);
      dropped.forEach((e) => this.eventIds.delete(e.id));
    }
    return added;
  }

  addPositions(positions) {
    for (const p of positions) {
      this.positions.push(p);
      fs.appendFileSync(this.positionsFile, JSON.stringify(p) + '\n');
    }
    if (this.positions.length > MAX_IN_MEMORY) {
      this.positions.splice(0, this.positions.length - MAX_IN_MEMORY);
    }
    return positions;
  }

  // Drops events and positions older than the retention window and rewrites the files.
  // Returns how many rows were removed.
  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    const keptEvents = this.events.filter((e) => e.ts >= cutoff);
    const keptPositions = this.positions.filter((p) => p.ts >= cutoff);
    const removed = this.events.length - keptEvents.length + this.positions.length - keptPositions.length;
    if (removed === 0) return 0;

    this.events = keptEvents;
    this.eventIds = new Set(keptEvents.map((e) => e.id));
    this.positions = keptPositions;
    writeJsonLines(this.eventsFile, this.events);
    writeJsonLines(this.positionsFile, this.positions);
    return removed;
  }

  setStatus(status) {
    this.status = { ...status, receivedAt: Date.now() };
    fs.writeFileSync(this.statusFile, JSON.stringify(this.status));
    return this.status;
  }

  listEvents({ type, since = 0, limit = 200 } = {}) {
    const out = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i];
      if (e.ts < since) break;
      if (type && e.type !== type) continue;
      out.push(e);
    }
    return out;
  }

  listPositions({ since = 0, limit = 2000 } = {}) {
    const out = [];
    for (let i = this.positions.length - 1; i >= 0 && out.length < limit; i--) {
      const p = this.positions[i];
      if (p.ts < since) break;
      out.push(p);
    }
    return out.reverse();
  }
}

module.exports = { Store };
