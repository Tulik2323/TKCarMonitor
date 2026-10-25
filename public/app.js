'use strict';

const GRAVITY = 9.80665;
const TYPES = {
  hard_brake: { label: 'בלימה חזקה' },
  hard_accel: { label: 'האצה חזקה' },
  sharp_turn: { label: 'פנייה חדה' },
  speeding: { label: 'מעל המהירות המותרת' },
  crash: { label: 'פגיעה (חשד לתאונה)' },
};
const TYPE_COLORS = {
  hard_brake: '#dc2626',
  hard_accel: '#ea580c',
  sharp_turn: '#7c3aed',
  speeding: '#ca8a04',
  crash: '#b91c1c',
};
const TOKEN_KEY = 'tkcarmonitor.token';
const POLL_MS = 30_000;
const $ = (id) => document.getElementById(id);

// day is null in live mode (today, polled every 30 seconds), otherwise a "YYYY-MM-DD" string.
const state = {
  token: null,
  day: null,
  filter: '',
  events: [],
  positions: [],
  status: null,
  map: null,
  marker: null,
  track: null,
  eventLayer: null,
  timer: null,
};

function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be blocked (private mode); the user just logs in again next visit.
  }
}

// Returns the response body, or throws. A 401 logs the user out.
async function sync(params = {}) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`/api/sync${query ? `?${query}` : ''}`, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (res.status === 401) {
    logout();
    throw new Error('unauthorized');
  }
  if (res.status === 503) throw new Error('server-not-configured');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Local date as "YYYY-MM-DD" (not UTC, so "today" matches the user's clock).
function localDayString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Start and end (inclusive) of a local calendar day, in epoch ms.
function dayBounds(dayString) {
  const [y, m, d] = dayString.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1);
  return { from: start.getTime(), to: end.getTime() - 1 };
}

function shiftDay(dayString, delta) {
  const [y, m, d] = dayString.split('-').map(Number);
  return localDayString(new Date(y, m - 1, d + delta));
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The numbers shown under each event. Speed is left out when the fix had none.
function describe(e) {
  const parts = [];
  if (e.speedKmh !== null) parts.push(`${Math.round(e.speedKmh)} קמ"ש`);
  if (e.value !== null) {
    if (e.type === 'speeding') parts.push(`+${Math.round(e.value)} מעל הגבול`);
    else parts.push(`${(e.value / GRAVITY).toFixed(2)} g`);
  }
  return parts;
}

function renderSummary() {
  const speeds = state.positions.map((p) => p.speedKmh).filter((v) => typeof v === 'number');
  const first = state.positions[0];
  const last = state.positions[state.positions.length - 1];
  $('clear-day').disabled = state.events.length === 0;
  $('stat-events').textContent = state.events.length;
  $('stat-max-speed').textContent = speeds.length ? `${Math.round(Math.max(...speeds))} קמ"ש` : '—';
  $('stat-start').textContent = first ? formatClock(first.ts) : '—';
  $('stat-end').textContent = last ? formatClock(last.ts) : '—';
}

function renderFilters() {
  const counts = { '': state.events.length };
  for (const e of state.events) counts[e.type] = (counts[e.type] || 0) + 1;

  const box = $('filters');
  box.innerHTML = '';
  const options = [['', 'הכל'], ...Object.entries(TYPES).map(([type, { label }]) => [type, label])];
  for (const [type, label] of options) {
    const chip = el('button', `chip ${type}`, label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(state.filter === type));
    chip.append(el('span', 'chip-count', String(counts[type] || 0)));
    chip.addEventListener('click', () => {
      state.filter = type;
      render();
    });
    box.append(chip);
  }
}

function renderEvents() {
  const list = $('events');
  list.innerHTML = '';
  const shown = state.events.filter((e) => !state.filter || e.type === state.filter);
  $('empty').classList.toggle('hidden', shown.length > 0);

  for (const e of shown) {
    const li = el('li', `event ${e.type}`);
    const body = el('div', 'event-body');
    const chips = el('div', 'event-chips');
    for (const text of describe(e)) chips.append(el('span', 'event-chip', text));
    body.append(el('div', 'event-title', TYPES[e.type]?.label || e.type), chips);
    const time = el('time', 'event-time', formatClock(e.ts));
    time.dateTime = new Date(e.ts).toISOString();
    li.append(body, time);
    list.append(li);
  }
}

function renderMap() {
  if (!state.map) return;
  const hasPositions = state.positions.length > 0;
  $('map-empty').classList.toggle('hidden', hasPositions);

  if (!hasPositions) {
    state.track.setLatLngs([]);
    if (state.marker) state.marker.remove();
    state.marker = null;
  } else {
    const points = state.positions.map((p) => [p.lat, p.lon]);
    state.track.setLatLngs(points);
    const last = points[points.length - 1];
    if (!state.marker) {
      state.marker = L.marker(last).addTo(state.map);
    } else {
      state.marker.setLatLng(last);
    }

    // Frame the route and any located events together, so the markers are on screen.
    const located = state.events.filter((e) => e.lat !== null && e.lon !== null).map((e) => [e.lat, e.lon]);
    if (state.day || located.length > 0) {
      state.map.fitBounds(L.latLngBounds([...points, ...located]), { padding: [24, 24], maxZoom: 15 });
    } else {
      state.map.setView(last, 15);
    }
  }
  renderEventMarkers();
}

// One dot per event that has a location, following the current filter.
// Events without a fix (for example a fix that never came) are skipped.
function renderEventMarkers() {
  state.eventLayer.clearLayers();
  const shown = state.events.filter((e) => e.lat !== null && e.lon !== null && (!state.filter || e.type === state.filter));
  for (const e of shown) {
    const dot = L.circleMarker([e.lat, e.lon], {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: TYPE_COLORS[e.type] || '#6b7280',
      fillOpacity: 1,
    });
    dot.bindPopup(eventPopup(e));
    state.eventLayer.addLayer(dot);
  }
}

function eventPopup(e) {
  const box = el('div', 'map-popup');
  box.append(el('strong', null, TYPES[e.type]?.label || e.type));
  const details = describe(e).join(' · ');
  if (details) box.append(el('div', null, details));
  box.append(el('div', 'map-popup-time', formatDateTime(e.ts)));
  return box;
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  $('last-seen').textContent = formatDateTime(status.receivedAt);
  $('battery').textContent = status.battery === null ? '—' : `${status.battery}%`;
  $('last-fix').textContent = status.lastFixAt ? formatDateTime(status.lastFixAt) : '—';
  // The device uploads about every 10 seconds while driving; 3 minutes of silence means it is offline.
  const online = Date.now() - status.receivedAt < 3 * 60 * 1000;
  $('connection').textContent = online ? 'מחובר' : 'לא מחובר';
  $('connection').classList.toggle('online', online);
}

function renderDayControls() {
  $('day-label').textContent = state.day ? formatDay(state.day) : 'היום · בזמן אמת';
  $('today').classList.toggle('hidden', !state.day);
  // Nothing after today.
  $('next-day').disabled = state.day === null;
  $('day').value = state.day || localDayString();
}

function formatDay(dayString) {
  const [y, m, d] = dayString.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Adds new rows, skipping ones already shown (the same event can come back in two polls).
function merge(current, incoming, keyOf) {
  const seen = new Set(current.map(keyOf));
  const fresh = incoming.filter((row) => !seen.has(keyOf(row)));
  return [...fresh, ...current];
}

function render() {
  state.events.sort((a, b) => b.ts - a.ts);
  state.positions.sort((a, b) => a.ts - b.ts);
  renderSummary();
  renderFilters();
  renderEvents();
  renderStatus();
  renderMap();
  renderDayControls();
}

function applyLive(data) {
  state.events = merge(state.events, data.events, (e) => e.id);
  state.positions = merge(state.positions, data.positions, (p) => p.ts);
  if (data.status) state.status = data.status;
  render();
}

function applyDay(data) {
  state.events = data.events;
  state.positions = data.positions;
  if (data.status) state.status = data.status;
  render();
}

// Live mode only shows today. The server defaults to 14 days, so every request
// passes today's start, otherwise an empty list would pull old events back in.
async function poll() {
  const todayStart = dayBounds(localDayString()).from;
  const newestEvent = state.events[0];
  const newestPosition = state.positions[state.positions.length - 1];
  applyLive(
    await sync({
      eventsSince: newestEvent ? newestEvent.ts + 1 : todayStart,
      positionsSince: newestPosition ? newestPosition.ts + 1 : todayStart,
    }),
  );
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(() => {
    poll().catch(() => {
      $('connection').textContent = 'מתחבר מחדש…';
    });
  }, POLL_MS);
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// Switches to live mode (today) and starts polling.
async function showLive() {
  state.day = null;
  state.events = [];
  state.positions = [];
  const todayStart = dayBounds(localDayString()).from;
  $('day').max = localDayString();
  applyLive(await sync({ eventsSince: todayStart, positionsSince: todayStart }));
  startPolling();
}

// Shows one past day. No polling: the data for a past day does not change.
async function showDay(dayString) {
  if (dayString === localDayString()) return showLive();
  stopPolling();
  state.day = dayString;
  const { from, to } = dayBounds(dayString);
  applyDay(await sync({ from, to }));
}

// Deletes the events in a time window on the server. Returns how many were removed.
async function deleteEvents(from, to) {
  const res = await fetch(`/api/events?from=${from}&to=${to}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (res.status === 401) {
    logout();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).removed;
}

// Deletes the events of the day on screen. Positions and the route stay.
async function clearDayEvents() {
  const day = state.day || localDayString();
  const label = formatDay(day);
  if (!window.confirm(`למחוק את כל האירועים של ${label}?\nאי אפשר לבטל את הפעולה. המסלול על המפה לא יימחק.`)) return;
  const { from, to } = dayBounds(day);
  await deleteEvents(from, to);
  // Reload the same view so the list, counts and markers match the server.
  await (state.day ? showDay(state.day) : showLive());
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  if (!state.map && window.L) {
    state.map = L.map('map').setView([32.08, 34.78], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(state.map);
    state.track = L.polyline([], { color: '#2563eb' }).addTo(state.map);
    state.eventLayer = L.layerGroup().addTo(state.map);
    // The data may have loaded before the map existed, so draw it now.
    render();
  }
}

// Returns true when the token is accepted.
async function login(token) {
  state.token = token;
  try {
    await showLive();
  } catch (err) {
    state.token = null;
    stopPolling();
    if (err.message === 'server-not-configured') {
      $('login-error').textContent = 'השרת עוד לא הוגדר (חסר DASHBOARD_TOKEN)';
    } else {
      $('login-error').textContent = 'הסיסמה שגויה';
    }
    $('login-error').classList.remove('hidden');
    return false;
  }
  saveToken(token);
  showApp();
  return true;
}

function logout() {
  saveToken(null);
  state.token = null;
  stopPolling();
  $('app').classList.add('hidden');
  $('logout').classList.add('hidden');
  $('login').classList.remove('hidden');
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('login-error').classList.add('hidden');
  await login($('token-input').value.trim());
});

$('logout').addEventListener('click', logout);
$('day').addEventListener('change', (ev) => {
  if (ev.target.value) showDay(ev.target.value).catch(() => {});
});
$('prev-day').addEventListener('click', () => {
  showDay(shiftDay(state.day || localDayString(), -1)).catch(() => {});
});
$('next-day').addEventListener('click', () => {
  showDay(shiftDay(state.day, 1)).catch(() => {});
});
$('today').addEventListener('click', () => {
  showLive().catch(() => {});
});
$('clear-day').addEventListener('click', () => {
  clearDayEvents().catch(() => {});
});

(async function init() {
  const saved = loadToken();
  if (saved && (await login(saved))) return;
  $('login').classList.remove('hidden');
})();
