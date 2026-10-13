'use strict';

/**
 * Availability engine.
 *
 * Provider interface: an object with
 *   async getBusy(dateStr, tz) -> [{ start: Date, end: Date }, ...]
 * returning busy intervals that overlap the requested local day.
 *
 * Providers:
 *  - GoogleCalendarProvider: Google Calendar free/busy via a service
 *    account (env-gated: GOOGLE_CALENDAR_ID + credentials).
 *  - DevBusyProvider: reads busy blocks from DEV_BUSY_JSON env (or an
 *    optional data/dev-busy.json file) so the app runs with zero
 *    credentials. Also layered UNDER the Google provider as a manual
 *    block list when both are present.
 *
 * Slot rules (locked): booking window 7:00 AM–7:00 PM local; a slot must
 * fit the package duration entirely inside the window; slots step every
 * 30 minutes; a minimum lead time applies; past slots are never offered.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { zonedTimeToUtc, minutesLabel } = require('./time');

/* ---------------- Dev provider ---------------- */

class DevBusyProvider {
  constructor() {
    this.name = 'dev-json';
  }

  async getBusy() {
    let raw = [];
    if (config.devBusyJson) {
      try {
        raw = JSON.parse(config.devBusyJson);
      } catch (e) {
        console.error('[availability] DEV_BUSY_JSON is not valid JSON:', e.message);
      }
    } else {
      const file = path.join(config.dataDir, 'dev-busy.json');
      try {
        if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        console.error('[availability] could not read dev-busy.json:', e.message);
      }
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
      .filter((b) => !isNaN(b.start) && !isNaN(b.end) && b.end > b.start);
  }
}

/* ---------------- Google Calendar provider ---------------- */

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function httpsJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch (_) {
            /* leave null */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`HTTP ${res.statusCode} from ${u.hostname}: ${data.slice(0, 300)}`));
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class GoogleCalendarProvider {
  constructor() {
    this.name = 'google-calendar';
    this.token = null;
    this.tokenExpiresAt = 0;
    let email = config.google.clientEmail;
    let key = config.google.privateKey;
    if (config.google.serviceAccountJson) {
      let raw = config.google.serviceAccountJson.trim();
      if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
      const parsed = JSON.parse(raw);
      email = parsed.client_email;
      key = parsed.private_key;
    }
    this.clientEmail = email;
    this.privateKey = key;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64url(
      JSON.stringify({
        iss: this.clientEmail,
        scope: 'https://www.googleapis.com/auth/calendar.freebusy',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      })
    );
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    const signature = signer
      .sign(this.privateKey)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const jwt = `${header}.${claim}.${signature}`;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString();
    const json = await httpsJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
    return this.token;
  }

  async getBusy(dateStr, tz) {
    const token = await this.accessToken();
    const timeMin = zonedTimeToUtc(dateStr, 0, tz).toISOString();
    const timeMax = zonedTimeToUtc(dateStr, 24 * 60, tz).toISOString();
    const json = await httpsJson('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        timeZone: tz,
        items: [{ id: config.google.calendarId }],
      }),
    });
    const cal = json && json.calendars && json.calendars[config.google.calendarId];
    if (cal && Array.isArray(cal.errors) && cal.errors.length) {
      throw new Error(`Google freeBusy error: ${JSON.stringify(cal.errors)}`);
    }
    const busy = (cal && cal.busy) || [];
    return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }
}

/* ---------------- Engine ---------------- */

let provider = null;
function getProvider() {
  if (!provider) {
    provider = config.googleEnabled ? new GoogleCalendarProvider() : new DevBusyProvider();
  }
  return provider;
}

const devProvider = new DevBusyProvider();

/**
 * Slots for a date + package duration.
 * Returns { date, provider, slots: [{ startMin, endMin, label, startISO, endISO, available }] }
 * Includes unavailable entries (flagged) so the UI can show the full day.
 */
async function getSlots(dateStr, durationMin) {
  const tz = config.timezone;
  const active = getProvider();
  let busy = [];
  let providerName = active.name;
  try {
    busy = await active.getBusy(dateStr, tz);
  } catch (e) {
    console.error(`[availability] provider ${active.name} failed, treating as no busy blocks:`, e.message);
    providerName = `${active.name} (error — treated as open)`;
  }
  // Manual dev blocks always apply on top (lets John block time without Google).
  if (active.name !== 'dev-json') {
    try {
      busy = busy.concat(await devProvider.getBusy(dateStr, tz));
    } catch (_) {
      /* optional */
    }
  }

  const openMin = config.openHour * 60;
  const closeMin = config.closeHour * 60;
  const now = Date.now();
  const minStart = now + config.minLeadMinutes * 60000;

  const slots = [];
  for (let startMin = openMin; startMin + durationMin <= closeMin; startMin += config.slotStepMin) {
    const start = zonedTimeToUtc(dateStr, startMin, tz);
    const end = zonedTimeToUtc(dateStr, startMin + durationMin, tz);
    const overlaps = busy.some((b) => start < b.end && end > b.start);
    const tooSoon = start.getTime() < minStart;
    slots.push({
      startMin,
      endMin: startMin + durationMin,
      label: minutesLabel(startMin),
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      available: !overlaps && !tooSoon,
    });
  }
  return { date: dateStr, provider: providerName, slots };
}

/** Is a specific [startISO, endISO] interval still free? (submit-time re-check) */
async function isFree(startISO, endISO) {
  const { dateStrInTz } = require('./time');
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (isNaN(start) || isNaN(end) || end <= start) return false;
  const dateStr = dateStrInTz(start, config.timezone);
  const active = getProvider();
  let busy = [];
  try {
    busy = await active.getBusy(dateStr, config.timezone);
  } catch (e) {
    console.error('[availability] isFree check failed:', e.message);
    return true; // never block a request on a calendar outage — John confirms manually
  }
  if (active.name !== 'dev-json') {
    try {
      busy = busy.concat(await devProvider.getBusy(dateStr, config.timezone));
    } catch (_) {
      /* optional */
    }
  }
  return !busy.some((b) => start < b.end && end > b.start);
}

module.exports = { getSlots, isFree, getProvider };
