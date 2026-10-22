'use strict';

const EVENT_TYPES = ['hard_brake', 'hard_accel', 'sharp_turn', 'speeding', 'crash'];
const MAX_TEXT = 100;

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalNumber(value, name) {
  if (value === null || value === undefined) return null;
  if (!isNumber(value)) throw fail(`${name} must be a number or null`);
  return value;
}

function validateEvent(e) {
  if (!e || typeof e !== 'object') throw fail('event must be an object');
  if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > MAX_TEXT) {
    throw fail('event.id must be a non-empty string');
  }
  if (!EVENT_TYPES.includes(e.type)) throw fail(`event.type must be one of ${EVENT_TYPES.join(', ')}`);
  if (!isNumber(e.ts)) throw fail('event.ts must be a number (epoch ms)');
  return {
    id: e.id,
    type: e.type,
    ts: e.ts,
    lat: optionalNumber(e.lat, 'event.lat'),
    lon: optionalNumber(e.lon, 'event.lon'),
    speedKmh: optionalNumber(e.speedKmh, 'event.speedKmh'),
    value: optionalNumber(e.value, 'event.value'),
  };
}

function validatePosition(p) {
  if (!p || typeof p !== 'object') throw fail('position must be an object');
  if (!isNumber(p.ts)) throw fail('position.ts must be a number (epoch ms)');
  if (!isNumber(p.lat) || !isNumber(p.lon)) throw fail('position.lat and position.lon must be numbers');
  return {
    ts: p.ts,
    lat: p.lat,
    lon: p.lon,
    speedKmh: optionalNumber(p.speedKmh, 'position.speedKmh'),
  };
}

function validateStatus(s) {
  if (!s || typeof s !== 'object') return null;
  const battery = optionalNumber(s.battery, 'status.battery');
  if (battery !== null && (battery < 0 || battery > 100)) throw fail('status.battery must be 0-100');
  return { battery, lastFixAt: optionalNumber(s.lastFixAt, 'status.lastFixAt') };
}

function validateTelemetry(body) {
  if (!body || typeof body !== 'object') throw fail('body must be an object');
  const events = Array.isArray(body.events) ? body.events.map(validateEvent) : [];
  const positions = Array.isArray(body.positions) ? body.positions.map(validatePosition) : [];
  if (events.length > 500 || positions.length > 1000) throw fail('too many items in one request');
  return { status: validateStatus(body.status), events, positions };
}

module.exports = { EVENT_TYPES, validateTelemetry };
