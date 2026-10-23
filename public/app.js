'use strict';

const TYPE_LABELS = {
  hard_brake: 'בלימה פתאומית',
  hard_accel: 'האצה חזקה',
  sharp_turn: 'פנייה חדה / החלקה',
  speeding: 'מהירות מעל הגבול',
  crash: 'תאונה / פגיעה',
};

const TOKEN_KEY = 'tkcarmonitor.token';
const POLL_MS = 30_000;
const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  events: [],
  positions: [],
  status: null,
  map: null,
  marker: null,
  track: null,
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

function formatTime(ts) {
  return new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'medium' });
}

function describe(e) {
  const parts = [];
  if (e.speedKmh !== null) parts.push(`${Math.round(e.speedKmh)} קמ"ש`);
  if (e.value !== null) {
    if (e.type === 'speeding') parts.push(`מעל הגבול ב-${Math.round(e.value)} קמ"ש`);
    else parts.push(`${(e.value / 9.81).toFixed(e.type === 'crash' ? 1 : 2)}g`);
  }
  return parts.join(' · ');
}

function renderEvents() {
  const filter = $('filter').value;
  const list = $('events');
  list.innerHTML = '';
  const shown = state.events.filter((e) => !filter || e.type === filter);
  $('empty').classList.toggle('hidden', shown.length > 0);

  for (const e of shown) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const type = document.createElement('div');
    type.className = `event-type ${e.type}`;
    type.textContent = TYPE_LABELS[e.type] || e.type;
    const meta = document.createElement('div');
    meta.className = 'event-meta';
    meta.textContent = describe(e);
    info.append(type, meta);
    const time = document.createElement('div');
    time.className = 'event-time';
    time.textContent = formatTime(e.ts);
    li.append(info, time);
    list.append(li);
  }
}

function renderMap() {
  if (!state.map || state.positions.length === 0) return;
  const points = state.positions.map((p) => [p.lat, p.lon]);
  state.track.setLatLngs(points);
  const last = points[points.length - 1];
  if (!state.marker) {
    state.marker = L.marker(last).addTo(state.map);
  } else {
    state.marker.setLatLng(last);
  }
  state.map.setView(last, 15);
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  $('last-seen').textContent = formatTime(status.receivedAt);
  $('battery').textContent = status.battery === null ? '—' : `${status.battery}%`;
  $('last-fix').textContent = status.lastFixAt ? formatTime(status.lastFixAt) : '—';
  // The device uploads about every 10 seconds while driving; 3 minutes of silence means it is offline.
  const online = Date.now() - status.receivedAt < 3 * 60 * 1000;
  $('connection').textContent = online ? 'מחובר' : 'לא מחובר';
  $('connection').classList.toggle('online', online);
}

// Adds new rows, skipping ones already shown (the same event can come back in two polls).
function merge(current, incoming, keyOf) {
  const seen = new Set(current.map(keyOf));
  const fresh = incoming.filter((row) => !seen.has(keyOf(row)));
  return [...fresh, ...current];
}

function applySync(data) {
  state.events = merge(state.events, data.events, (e) => e.id).sort((a, b) => b.ts - a.ts);
  state.positions = merge(state.positions, data.positions, (p) => p.ts).sort((a, b) => a.ts - b.ts);
  if (data.status) state.status = data.status;
  renderEvents();
  renderStatus();
  renderMap();
}

async function poll() {
  const params = {};
  const newestEvent = state.events[0];
  const newestPosition = state.positions[state.positions.length - 1];
  if (newestEvent) params.eventsSince = newestEvent.ts + 1;
  if (newestPosition) params.positionsSince = newestPosition.ts + 1;
  applySync(await sync(params));
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

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  if (!state.map && window.L) {
    state.map = L.map('map').setView([32.08, 34.78], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(state.map);
    state.track = L.polyline([], { color: '#2563eb' }).addTo(state.map);
  }
}

// Returns true when the token is accepted. The first sync loads 14 days of events and 24 hours of track.
async function login(token) {
  state.token = token;
  try {
    applySync(await sync());
  } catch (err) {
    state.token = null;
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
  startPolling();
  return true;
}

function logout() {
  saveToken(null);
  state.token = null;
  stopPolling();
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('login-error').classList.add('hidden');
  await login($('token-input').value.trim());
});

$('logout').addEventListener('click', logout);
$('filter').addEventListener('change', renderEvents);

(async function init() {
  const saved = loadToken();
  if (saved && (await login(saved))) return;
  $('login').classList.remove('hidden');
})();
