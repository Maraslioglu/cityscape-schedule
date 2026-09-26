// Runs the Cityscape Schedule app (worker.js) on Railway with Node 20+.
// Storage lives in /data (a Railway volume) so logins, users and the Guesty token survive restarts.
import http from 'node:http';
import fs from 'node:fs';
import worker from './worker.js';

const PORT = process.env.PORT || 3000;
const DIR = fs.existsSync('/data') ? '/data' : '.';
const FILE = `${DIR}/store.json`;

// Simple key-value storage saved to disk.
let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}
let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 200);
};
const STORE = {
  async get(key, type) {
    const e = data[key];
    if (!e || (e.exp && e.exp < Date.now())) return null;
    return type === 'json' ? JSON.parse(e.v) : e.v;
  },
  async put(key, value, opts = {}) {
    data[key] = { v: String(value), exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 };
    save();
  },
  async delete(key) { delete data[key]; save(); },
};

// Short-lived response cache (used for weeks far in the past/future).
const cacheMap = new Map();
globalThis.caches = {
  default: {
    async match(req) { const e = cacheMap.get(req.url); return e && e.exp > Date.now() ? new Response(e.body) : undefined; },
    async put(req, res) { cacheMap.set(req.url, { body: await res.text(), exp: Date.now() + 600e3 }); if (cacheMap.size > 200) cacheMap.delete(cacheMap.keys().next().value); },
  },
};

const env = { ...process.env, STORE };
const ctx = { waitUntil: (p) => Promise.resolve(p).catch((e) => console.log('[background]', e.message)) };

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    // Rebuild the public address Railway received the request on (needed for secure cookies and Guesty updates).
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    headers.set('CF-Connecting-IP', ip);
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method, headers, redirect: 'manual',
      body: chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
    });
    const out = await worker.fetch(request, env, ctx);
    const h = {};
    out.headers.forEach((v, k) => { h[k] = v; });
    const setCookie = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
    if (setCookie.length) h['set-cookie'] = setCookie;
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.log('[error]', e.stack || e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  }
}).listen(PORT, () => {
  console.log(`Cityscape Schedule running on port ${PORT}${!process.env.GUESTY_CLIENT_ID ? ' (sample data)' : ''}`);
  // Keep bookings pre-loaded: refresh now and every 5 minutes.
  const tick = () => worker.scheduled({}, env, ctx).catch((e) => console.log('[refresh]', e.message));
  setTimeout(tick, 1000);
  setInterval(tick, 5 * 60e3);
});
