// Guesty Open API client with token caching.
// Guesty only allows 5 access tokens per 24h per Client ID, so the token is cached
// in memory AND on disk (mount a Railway volume at /data so it survives redeploys).

const fs = require('fs');
const path = require('path');
const mock = require('./mock');

const BASE = process.env.GUESTY_BASE_URL || 'https://open-api.guesty.com';
const CLIENT_ID = process.env.GUESTY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GUESTY_CLIENT_SECRET || '';
const MOCK = process.env.MOCK === '1' || !CLIENT_ID || !CLIENT_SECRET;
const TOKEN_PATH = process.env.TOKEN_CACHE_PATH || (fs.existsSync('/data') ? '/data/guesty-token.json' : path.join(__dirname, '..', '.guesty-token.json'));

let token = null; // { access_token, expires_at }
let tokenPromise = null;

function isMock() { return MOCK; }

function publicError(message, status = 502) {
  const e = new Error(message);
  e.publicMessage = message;
  e.status = status;
  return e;
}

function loadTokenFromDisk() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    if (t.client_id === CLIENT_ID && t.expires_at > Date.now() + 5 * 60e3) return t;
  } catch (_) { /* no cache yet */ }
  return null;
}

async function requestNewToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'open-api', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  const r = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (r.status === 429) throw publicError('Guesty token limit reached (max 5 per day). The app will work again once the limit resets — check that a Railway volume is mounted at /data so tokens are reused.', 503);
  if (!r.ok) throw publicError(`Guesty rejected the API credentials (HTTP ${r.status}). Check GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET in Railway.`, 502);
  const data = await r.json();
  const t = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 86400) * 1000, client_id: CLIENT_ID };
  try { fs.writeFileSync(TOKEN_PATH, JSON.stringify(t), { mode: 0o600 }); } catch (e) { console.warn('[warn] could not cache token to', TOKEN_PATH, e.message); }
  console.log('[guesty] new access token issued, valid until', new Date(t.expires_at).toISOString());
  return t;
}

async function getToken() {
  if (token && token.expires_at > Date.now() + 5 * 60e3) return token.access_token;
  token = loadTokenFromDisk();
  if (token) return token.access_token;
  if (!tokenPromise) tokenPromise = requestNewToken().finally(() => { tokenPromise = null; });
  token = await tokenPromise;
  return token.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, params = {}, attempt = 0) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const r = await fetch(`${BASE}${pathname}?${qs}`, {
    headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' },
  });
  if (r.status === 401 && attempt === 0) {
    // Token revoked or expired early — drop it and try once more.
    token = null;
    try { fs.unlinkSync(TOKEN_PATH); } catch (_) {}
    return api(pathname, params, attempt + 1);
  }
  if (r.status === 429 && attempt < 4) {
    const wait = Number(r.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
    await sleep(Math.min(wait, 10000));
    return api(pathname, params, attempt + 1);
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error('[guesty]', r.status, pathname, text.slice(0, 500));
    throw publicError(`Guesty returned an error (HTTP ${r.status}). Try Refresh in a minute.`);
  }
  return r.json();
}

async function paginate(pathname, params) {
  const limit = 100;
  let skip = 0;
  const all = [];
  for (let page = 0; page < 50; page++) {
    const data = await api(pathname, { ...params, limit: String(limit), skip: String(skip) });
    const results = data.results || data.data || [];
    all.push(...results);
    if (results.length < limit) break;
    skip += limit;
  }
  return all;
}

// ---------- public API ----------

async function listListings() {
  if (MOCK) return mock.listings();
  return paginate('/v1/listings', {
    fields: '_id nickname title bedrooms address.full address.street address.zipcode address.city active defaultCheckInTime defaultCheckOutTime propertyType',
    sort: '_id',
  });
}

// Every stay that touches the week: arrives on/before the last day and leaves on/after the first day.
// One query gives check-ins, check-outs AND the nights in between (used for the week board).
async function listStays(from, to, statuses) {
  if (MOCK) return mock.stays(from, to, statuses);
  return paginate('/v1/reservations', {
    fields: '_id listingId status confirmationCode checkInDateLocalized checkOutDateLocalized plannedArrival plannedDeparture guestsCount nightsCount source createdAt guest.fullName',
    filters: [
      { field: 'checkInDateLocalized', operator: '$lte', value: to },
      { field: 'checkOutDateLocalized', operator: '$gte', value: from },
      { field: 'status', operator: '$in', value: statuses },
    ],
    sort: '_id',
  });
}

// ---------- webhooks (instant updates) ----------

async function apiSend(method, pathname, body) {
  const r = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch (_) { return text; }
}

const WEBHOOK_EVENTS = ['reservation.created.v2', 'reservation.updated.v2'];

// Makes sure Guesty will call `url` whenever a booking is created, changed or cancelled.
async function ensureWebhook(url) {
  if (MOCK) return { mock: true };
  const existing = await api('/v1/webhooks').catch(() => null);
  const list = Array.isArray(existing) ? existing : (existing && (existing.results || existing.data)) || [];
  const base = url.split('?')[0];
  const mine = list.filter((w) => (w.url || '').split('?')[0] === base);
  if (mine.some((w) => w.url === url)) return { status: 'already registered' };
  // Old subscriptions to this app with a different key are replaced.
  for (const w of mine) { try { await apiSend('DELETE', `/v1/webhooks/${w._id || w.id}`); } catch (_) {} }
  await apiSend('POST', '/v1/webhooks', { url, events: WEBHOOK_EVENTS });
  return { status: 'registered' };
}

// Guesty signs webhooks with Svix; this fetches the signing secret (whsec_…).
async function webhookSecret() {
  if (MOCK) return null;
  const data = await api('/v1/webhooks-v2/secret');
  const find = (o) => {
    if (typeof o === 'string') return o.startsWith('whsec_') ? o : null;
    if (o && typeof o === 'object') for (const v of Object.values(o)) { const f = find(v); if (f) return f; }
    return null;
  };
  return find(data);
}

module.exports = { isMock, listListings, listStays, ensureWebhook, webhookSecret };
