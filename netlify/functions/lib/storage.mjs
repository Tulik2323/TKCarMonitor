// Storage on Netlify Blobs. Events and positions are kept in one blob per UTC day,
// so a sync reads at most a few blobs and retention is a matter of deleting old day blobs.
// The blob store only needs get / setJSON / delete / list, which keeps it easy to fake in tests.

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_KEY = 'status';

export function dayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function daysBetween(fromTs, toTs) {
  const days = [];
  const end = dayOf(toTs);
  for (let ts = Date.UTC(...dateParts(fromTs)); dayOf(ts) <= end; ts += DAY_MS) {
    days.push(dayOf(ts));
  }
  return days;
}

function dateParts(ts) {
  const d = new Date(ts);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

export function createStorage(blobs) {
  async function readDay(key) {
    return (await blobs.get(key, { type: 'json' })) ?? [];
  }

  async function readRange(prefix, sinceTs, untilTs) {
    const rows = [];
    for (const day of daysBetween(sinceTs, untilTs)) {
      rows.push(...(await readDay(`${prefix}/${day}`)));
    }
    return rows.filter((r) => r.ts >= sinceTs && r.ts <= untilTs).sort((a, b) => a.ts - b.ts);
  }

  // Appends rows to their day blobs, skipping any whose key is already stored.
  // Returns the rows that were actually new.
  async function appendToDays(prefix, rows, keyOf) {
    const byDay = new Map();
    for (const row of rows) {
      const day = dayOf(row.ts);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(row);
    }

    const added = [];
    for (const [day, incoming] of byDay) {
      const key = `${prefix}/${day}`;
      const existing = await readDay(key);
      const seen = new Set(existing.map(keyOf));
      const fresh = incoming.filter((row) => {
        const k = keyOf(row);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (fresh.length > 0) {
        await blobs.setJSON(key, [...existing, ...fresh]);
        added.push(...fresh);
      }
    }
    return added;
  }

  return {
    addEvents: (events) => appendToDays('events', events, (e) => e.id),
    addPositions: (positions) => appendToDays('positions', positions, (p) => `${p.ts}`),

    setStatus: (status) => blobs.setJSON(STATUS_KEY, { ...status, receivedAt: Date.now() }),
    readStatus: async () => (await blobs.get(STATUS_KEY, { type: 'json' })) ?? null,

    readEvents: (sinceTs, untilTs = Date.now()) => readRange('events', sinceTs, untilTs),
    readPositions: (sinceTs, untilTs = Date.now()) => readRange('positions', sinceTs, untilTs),

    // Deletes day blobs older than the retention window. Returns how many blobs were removed.
    async prune(retentionDays, nowTs = Date.now()) {
      const cutoffDay = dayOf(nowTs - retentionDays * DAY_MS);
      let removed = 0;
      for (const prefix of ['events', 'positions']) {
        for await (const page of blobs.list({ prefix: `${prefix}/`, paginate: true })) {
          for (const { key } of page.blobs) {
            const day = key.slice(prefix.length + 1);
            if (day < cutoffDay) {
              await blobs.delete(key);
              removed += 1;
            }
          }
        }
      }
      return removed;
    },
  };
}
