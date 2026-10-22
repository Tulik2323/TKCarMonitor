'use strict';

const TYPE_LABELS = {
  hard_brake: 'בלימה פתאומית',
  hard_accel: 'האצה חזקה',
  sharp_turn: 'פנייה חדה / החלקה',
  speeding: 'מהירות מעל הגבול',
  crash: 'תאונה / פגיעה',
};

const TOKEN_KEY = 'tkcarmonitor.token';
const $ = (id) => document.getElementById(id);

const state = { events: [], token: null, map: null, marker: null, track: null, stream: null };

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
    // Private browsing can block storage; the user just logs in again next visit.
  }
}

async function api(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
  if (res.status === 401) {
    logout();
    throw new Error('unauthorized');
  }
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
    else if (e.type === 'crash') parts.push(`${(e.value / 9.81).toFixed(1)}g`);
    else parts.push(`${(e.value / 9.81).toFixed(2)}g`);
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
  renderMarkers();
}

function renderMarkers() {
  if (!state.map) return;
  const last = state.events.find((e) => e.lat !== null && e.lon !== null);
  if (last) {
    state.map.setView([last.lat, last.lon], 15);
  }
}

function setMarker(lat, lon) {
  if (!state.map) return;
  if (!state.marker) {
    state.marker = L.marker([lat, lon]).addTo(state.map);
  } else {
    state.marker.setLatLng([lat, lon]);
  }
  state.map.panTo([lat, lon]);
}

function renderStatus(status) {
  if (!status) return;
  $('last-seen').textContent = formatTime(status.receivedAt);
  $('battery').textContent = status.battery === null ? '—' : `${status.battery}%`;
  $('last-fix').textContent = status.lastFixAt ? formatTime(status.lastFixAt) : '—';
  const online = Date.now() - status.receivedAt < 3 * 60 * 1000;
  $('connection').textContent = online ? 'מחובר' : 'לא מחובר';
  $('connection').classList.toggle('online', online);
}

async function loadAll() {
  const [{ events }, { positions }, { status }] = await Promise.all([
    api('/api/events?limit=500'),
    api('/api/positions'),
    api('/api/status'),
  ]);
  state.events = events;
  renderEvents();
  renderStatus(status);
  if (positions.length) {
    const last = positions[positions.length - 1];
    setMarker(last.lat, last.lon);
    if (state.track) state.track.setLatLngs(positions.map((p) => [p.lat, p.lon]));
  }
}

function connectStream() {
  if (state.stream) state.stream.close();
  const source = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    state.events.unshift(e);
    renderEvents();
    if (e.lat !== null && e.lon !== null) setMarker(e.lat, e.lon);
  };
  source.onerror = () => {
    $('connection').textContent = 'מתחבר מחדש…';
  };
  state.stream = source;
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

async function login(token) {
  state.token = token;
  try {
    await loadAll();
  } catch {
    state.token = null;
    return false;
  }
  saveToken(token);
  showApp();
  connectStream();
  return true;
}

function logout() {
  saveToken(null);
  state.token = null;
  if (state.stream) state.stream.close();
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ok = await login($('token-input').value.trim());
  $('login-error').classList.toggle('hidden', ok);
});

$('logout').addEventListener('click', logout);
$('filter').addEventListener('change', renderEvents);

(async function init() {
  const saved = loadToken();
  if (saved && (await login(saved))) return;
  $('login').classList.remove('hidden');
})();
