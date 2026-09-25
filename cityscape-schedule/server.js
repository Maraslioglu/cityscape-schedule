// Cityscape Schedule — weekly check-ins, check-outs and linen, pulled from Guesty.
// Zero dependencies: needs Node 18+ (uses built-in fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const guesty = require('./lib/guesty');
const { buildWeek, buildProperties, weekStartFor, todayInLondon, clearCaches } = require('./lib/schedule');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('cs:' + APP_PASSWORD).digest('hex');
const SESSION_DAYS = 30;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!APP_PASSWORD) console.warn('[warn] APP_PASSWORD is not set — the app will refuse all logins until it is.');

// ---------- sessions (signed cookie, no storage needed) ----------
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function makeSession() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return exp + '.' + sign(exp);
}
function validSession(token) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
}

// ---------- simple login throttle ----------
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}
function recordAttempt(ip) {
  attempts.get(ip).push(Date.now());
}

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function serveFile(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
}
function readBody(req, max = 1e4) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > max) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

// ---------- live updates ----------
// Guesty calls /webhooks/guesty/<key> the moment a booking is created, changed or cancelled.
// We drop the cache and tell every open screen (Server-Sent Events) to reload.
const WEBHOOK_KEY = process.env.WEBHOOK_KEY || crypto.createHash('sha256').update('wh:' + SESSION_SECRET).digest('hex').slice(0, 32);
const PUBLIC_URL = (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, '');
let svixSecret = process.env.GUESTY_WEBHOOK_SECRET || null;
const live = { clients: new Set(), lastEventAt: null, webhook: 'not set up' };

function broadcast(payload) {
  const msg = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of live.clients) res.write(msg);
}
let pending = null;
function bookingChanged(info) {
  live.lastEventAt = new Date().toISOString();
  clearCaches();
  // Guesty often sends several events for one booking — bundle them into one refresh.
  clearTimeout(pending);
  pending = setTimeout(() => broadcast({ at: live.lastEventAt, ...info }), 1500);
}

function verifySvix(req, raw) {
  if (!svixSecret) return true; // the secret key in the URL is still required
  const id = req.headers['svix-id'], ts = req.headers['svix-timestamp'], sigs = req.headers['svix-signature'];
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) return false;
  const key = Buffer.from(svixSecret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return sigs.split(' ').some((s) => {
    const v = s.split(',')[1] || '';
    return v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected));
  });
}

async function setUpWebhook() {
  if (guesty.isMock()) { live.webhook = 'sample data (no webhook)'; return; }
  if (!PUBLIC_URL) { live.webhook = 'PUBLIC_URL not set — updates every 5 minutes instead'; console.warn('[webhook] ' + live.webhook); return; }
  try {
    if (!svixSecret) svixSecret = await guesty.webhookSecret().catch(() => null);
    const r = await guesty.ensureWebhook(`${PUBLIC_URL}/webhooks/guesty/${WEBHOOK_KEY}`);
    live.webhook = `${r.status}${svixSecret ? ' (signed)' : ''}`;
    console.log('[webhook]', live.webhook, PUBLIC_URL);
  } catch (e) {
    live.webhook = 'could not register — updates every 5 minutes instead';
    console.error('[webhook] registration failed:', e.message);
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  try {
    if (p === '/health') return json(res, 200, { ok: true, mock: guesty.isMock() });

    if (p.startsWith('/webhooks/guesty/') && req.method === 'POST') {
      const key = p.split('/')[3] || '';
      const raw = await readBody(req, 1e6);
      if (key.length !== WEBHOOK_KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(WEBHOOK_KEY)) || !verifySvix(req, raw)) {
        return send(res, 401, 'unauthorised');
      }
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      const r = body.reservation || (body.data && body.data.reservation) || body.data || {};
      console.log('[webhook]', body.event || body.type || 'event', r._id || '', r.status || '');
      bookingChanged({ event: body.event || body.type || 'update' });
      return send(res, 200, 'ok');
    }

    // Public assets needed by the login page
    if (p === '/login' && req.method === 'GET') return serveFile(res, 'login.html');
    if (['/styles.css', '/favicon.svg', '/manifest.webmanifest'].includes(p)) return serveFile(res, p.slice(1));

    if (p === '/login' && req.method === 'POST') {
      if (tooManyAttempts(ip)) return send(res, 302, '', { Location: '/login?e=locked' });
      const body = new URLSearchParams(await readBody(req));
      const pw = body.get('password') || '';
      const ok = APP_PASSWORD && pw.length === APP_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(APP_PASSWORD));
      if (!ok) { recordAttempt(ip); return send(res, 302, '', { Location: '/login?e=1' }); }
      const flags = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isSecure(req) ? '; Secure' : ''}`;
      return send(res, 302, '', { Location: '/', 'Set-Cookie': `cs_session=${makeSession()}; ${flags}` });
    }
    if (p === '/logout') {
      return send(res, 302, '', { Location: '/login', 'Set-Cookie': 'cs_session=; HttpOnly; Path=/; Max-Age=0' });
    }

    // Everything below needs a valid session
    if (!validSession(cookies(req).cs_session)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'Not signed in' });
      return send(res, 302, '', { Location: '/login' });
    }

    if (p === '/api/week') {
      const start = weekStartFor(url.searchParams.get('date') || todayInLondon());
      const fresh = url.searchParams.get('refresh') === '1';
      return json(res, 200, await buildWeek(start, { fresh }));
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ webhook: live.webhook })}\n\n`);
      live.clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); live.clients.delete(res); });
      return;
    }
    if (p === '/api/simulate-booking' && guesty.isMock() && req.method === 'POST') {
      bookingChanged({ event: 'simulated' });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/status') {
      return json(res, 200, { webhook: live.webhook, lastEventAt: live.lastEventAt, openScreens: live.clients.size, mock: guesty.isMock() });
    }
    if (p === '/api/properties') {
      return json(res, 200, await buildProperties({ fresh: url.searchParams.get('refresh') === '1' }));
    }

    if (p === '/' || p === '/index.html') return serveFile(res, 'index.html');
    if (p === '/app.js') return serveFile(res, 'app.js');
    return send(res, 404, 'Not found');
  } catch (err) {
    console.error('[error]', err);
    if (p.startsWith('/api/')) return json(res, err.status || 500, { error: err.publicMessage || 'Something went wrong talking to Guesty. Try Refresh in a minute.' });
    return send(res, 500, 'Server error');
  }
});

server.listen(PORT, () => {
  setUpWebhook();
  console.log(`Cityscape Schedule running on port ${PORT}${guesty.isMock() ? ' (MOCK DATA — set GUESTY_CLIENT_ID/SECRET for live data)' : ''}`);
});
