// Runs the Cityscape Schedule app (worker.js) on Railway with Node 20+.
// Everything is stored on the Railway volume at /data:
//   /data/store.json      logins, users, cleanings, damage reports, Guesty token, pre-loaded bookings
//   /data/media/          cleaning videos and photos (original upload, then a smaller copy for playback)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import worker from './worker.js';

const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : '.');
const FILE = `${DIR}/store.json`;
const MEDIA = `${DIR}/media`;
fs.mkdirSync(MEDIA, { recursive: true });
const MAX_FILE = 20 * 1024 ** 3;          // 20 GB per file — no practical limit on video length
const MAX_CHUNK = 16 * 1024 ** 2;         // browser sends 8 MB pieces; this is the hard cap per request
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

// ---------------- simple key-value storage saved to disk ----------------
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
// One live object per upload, so the uploader and the compressor never overwrite each other's changes.
const metaCache = new Map();
async function getMeta(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  if (metaCache.has(id)) return metaCache.get(id);
  const m = await STORE.get('media:' + id, 'json');
  if (m) metaCache.set(id, m);
  if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value);
  return m;
}
const putMeta = (m) => { metaCache.set(m.id, m); const { busy, ...save } = m; return STORE.put('media:' + m.id, JSON.stringify(save)); };

// Short-lived response cache (used for weeks far in the past/future).
const cacheMap = new Map();
globalThis.caches = {
  default: {
    async match(req) { const e = cacheMap.get(req.url); return e && e.exp > Date.now() ? new Response(e.body) : undefined; },
    async put(req, res) { cacheMap.set(req.url, { body: await res.text(), exp: Date.now() + 600e3 }); if (cacheMap.size > 200) cacheMap.delete(cacheMap.keys().next().value); },
  },
};

const INTERNAL_KEY = crypto.randomBytes(24).toString('hex');
const env = { ...process.env, STORE, __INTERNAL_KEY: INTERNAL_KEY };
const ctx = { waitUntil: (p) => Promise.resolve(p).catch((e) => console.log('[background]', e.message)) };

// ---------------- helpers ----------------
function origin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readJson(req, limit = 64 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return {}; }
}
// Ask the app (worker.js) whether this signed-in person may upload or view.
async function check(req, body) {
  const r = await worker.fetch(new Request(origin(req) + '/api/internal/media-check', {
    method: 'POST',
    headers: { cookie: req.headers.cookie || '', 'content-type': 'application/json', 'x-internal': INTERNAL_KEY, origin: origin(req) },
    body: JSON.stringify(body),
  }), env, ctx);
  if (r.status === 401) return { status: 401 };
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const fileFor = (m, variant) => path.join(MEDIA, variant === 'thumb' ? `${m.id}.thumb.jpg` : variant === 'orig' ? `${m.id}.orig` : m.file || `${m.id}.orig`);

// ---------------- compression queue (one job at a time) ----------------
const queue = [];
let working = false;
function enqueue(id) { queue.push(id); pump(); }
async function pump() {
  if (working) return;
  const id = queue.shift();
  if (!id) return;
  working = true;
  try { await processMedia(id); } catch (e) { console.log('[media] processing failed', id, e.message); }
  working = false;
  pump();
}
function run(args) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('close', (code) => resolve({ code, err }));
  });
}
function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = parseFloat(r.stdout);
  return Number.isFinite(d) ? Math.round(d) : null;
}
async function processMedia(id) {
  const m = await getMeta(id);
  if (!m) return;
  const orig = fileFor(m, 'orig');
  if (!HAS_FFMPEG) { Object.assign(m, { status: 'ready', file: `${m.id}.orig` }); await putMeta(m); return; }
  m.status = 'processing'; await putMeta(m);
  if (m.kind === 'video') {
    // A smaller copy for quick playback: 720p, H.264, starts playing before it has fully loaded.
    const out = path.join(MEDIA, `${m.id}.mp4`);
    const r = await run(['-y', '-i', orig, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
    await run(['-y', '-ss', '1', '-i', orig, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", path.join(MEDIA, `${m.id}.thumb.jpg`)]);
    if (r.code === 0) {
      m.duration = probeDuration(out);
      m.file = `${m.id}.mp4`; m.type = 'video/mp4'; m.status = 'ready';
      m.compressedSize = fs.statSync(out).size;
      if (process.env.KEEP_ORIGINALS !== '1') await fsp.rm(orig, { force: true });
    } else {
      console.log('[media] video conversion failed, keeping original', r.err.slice(-300));
      m.file = `${m.id}.orig`; m.status = 'ready';
    }
  } else {
    const out = path.join(MEDIA, `${m.id}.jpg`);
    const r = await run(['-y', '-i', orig, '-vf', "scale='min(2000,iw)':-2", '-q:v', '4', out]);
    await run(['-y', '-i', orig, '-vf', "scale='min(640,iw)':-2", '-q:v', '5', path.join(MEDIA, `${m.id}.thumb.jpg`)]);
    if (r.code === 0) {
      m.file = `${m.id}.jpg`; m.type = 'image/jpeg'; m.status = 'ready';
      if (process.env.KEEP_ORIGINALS !== '1') await fsp.rm(orig, { force: true });
    } else { m.file = `${m.id}.orig`; m.status = 'ready'; }
  }
  await putMeta(m);
  console.log(`[media] ${m.kind} ${m.id} ready (${Math.round(m.size / 1e6)} MB → ${Math.round((m.compressedSize || m.size) / 1e6)} MB)`);
}

// ---------------- media routes ----------------
async function mediaRoute(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, media, :id, :action  |  media, :id[, thumb]

  // Start an upload: POST /api/media  {kind, purpose, ownerId|listingId, name, size, type}
  if (req.method === 'POST' && url.pathname === '/api/media') {
    const body = await readJson(req);
    const kind = body.kind === 'photo' ? 'photo' : body.kind === 'video' ? 'video' : null;
    const size = Number(body.size);
    if (!kind || !(size > 0) || size > MAX_FILE) return sendJson(res, 400, { error: 'That file can’t be uploaded (too large or unknown type).' });
    const c = await check(req, { mode: 'upload', purpose: body.purpose, ownerId: body.ownerId, listingId: body.listingId });
    if (c.status === 401) return sendJson(res, 401, { error: 'Not signed in' });
    if (!c.ok) return sendJson(res, 403, { error: 'You can’t upload for this right now.' });
    const m = {
      id: crypto.randomBytes(12).toString('hex'), kind, purpose: body.purpose, ownerId: body.ownerId || null, listingId: body.listingId || null,
      building: c.building || null, name: String(body.name || kind).slice(0, 120), type: String(body.type || '').slice(0, 60), size,
      received: 0, uploaded: false, status: 'uploading', byId: c.user.id, byName: c.user.name, createdAt: new Date().toISOString(),
    };
    await fsp.writeFile(fileFor(m, 'orig'), '');
    await putMeta(m);
    return sendJson(res, 200, { id: m.id, received: 0, chunk: 8 * 1024 ** 2 });
  }

  if (parts[0] === 'api' && parts[1] === 'media' && parts[2]) {
    const m = await getMeta(parts[2]);
    if (!m) return sendJson(res, 404, { error: 'Upload not found' });
    // Only the uploader can continue their upload.
    const me = await check(req, { mode: 'view', id: m.id });
    if (me.status === 401) return sendJson(res, 401, { error: 'Not signed in' });
    if (!me.ok) return sendJson(res, 403, { error: 'Not allowed' });

    if (req.method === 'GET' && !parts[3]) return sendJson(res, 200, { id: m.id, received: m.received, uploaded: m.uploaded, status: m.status });

    // Resumable upload: PUT /api/media/:id?offset=N with the next piece of the file as the body.
    if (req.method === 'PUT' && !parts[3]) {
      if (me.userId !== m.byId) { req.resume(); return sendJson(res, 403, { error: 'Only the person uploading can send this file.' }); }
      if (m.uploaded) return sendJson(res, 200, { received: m.received, uploaded: true });
      const offset = Number(url.searchParams.get('offset'));
      if (offset !== m.received || m.busy) { req.resume(); return sendJson(res, 409, { received: m.received }); } // tells the phone where to carry on from
      m.busy = true;
      try {
      const out = fs.createWriteStream(fileFor(m, 'orig'), { flags: 'a' });
      let n = 0, tooBig = false;
      await new Promise((resolve) => {
        req.on('data', (c) => { n += c.length; if (n > MAX_CHUNK || m.received + n > m.size) { tooBig = true; req.destroy(); } else out.write(c); });
        req.on('end', resolve); req.on('close', resolve); req.on('error', resolve);
      });
      await new Promise((r) => out.end(r));
      const actual = fs.statSync(fileFor(m, 'orig')).size;
      m.received = actual;
      if (tooBig) { await fsp.truncate(fileFor(m, 'orig'), offset); m.received = offset; await putMeta(m); return sendJson(res, 413, { received: offset }); }
      if (m.received >= m.size) { m.uploaded = true; m.status = 'queued'; }
      await putMeta(m);
      if (m.uploaded) enqueue(m.id);
      return sendJson(res, 200, { received: m.received, uploaded: m.uploaded });
      } finally { m.busy = false; }
    }
  }

  // Playback: GET /media/:id  and  /media/:id/thumb  (supports seeking)
  if (req.method === 'GET' && parts[0] === 'media' && parts[1]) {
    const m = await getMeta(parts[1]);
    if (!m) { res.writeHead(404); return res.end('Not found'); }
    const c = await check(req, { mode: 'view', id: m.id });
    if (!c.ok) { res.writeHead(c.status === 401 ? 401 : 403); return res.end('Not allowed'); }
    const variant = parts[2] === 'thumb' ? 'thumb' : 'main';
    let file = fileFor(m, variant);
    if (variant === 'thumb' && !fs.existsSync(file)) { res.writeHead(404); return res.end(''); }
    if (!fs.existsSync(file)) file = fileFor(m, 'orig');
    const stat = fs.statSync(file);
    const type = variant === 'thumb' ? 'image/jpeg' : (m.type || (m.kind === 'video' ? 'video/mp4' : 'image/jpeg'));
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
    if (url.searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${m.kind}-${m.id}${path.extname(file) || ''}"`;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    return fs.createReadStream(file).pipe(res);
  }
  return false;
}

// ---------------- HTTP server ----------------
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/media' || url.pathname.startsWith('/api/media/') || url.pathname.startsWith('/media/')) {
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== origin(req)) return sendJson(res, 403, { error: 'Blocked' });
      const handled = await mediaRoute(req, res, url);
      if (handled !== false) return;
    }
    if (url.pathname.startsWith('/api/internal/')) return sendJson(res, 404, { error: 'Not found' });

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    headers.set('CF-Connecting-IP', ip);
    headers.delete('x-internal');
    const request = new Request(`${origin(req)}${req.url}`, {
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
}).listen(PORT, async () => {
  console.log(`Cityscape Schedule running on port ${PORT}${!process.env.GUESTY_CLIENT_ID ? ' (sample data)' : ''}${HAS_FFMPEG ? '' : ' — ffmpeg not installed, videos kept at full size'}`);
  // Finish any uploads that were being compressed when the server last restarted.
  for (const k of Object.keys(data)) if (k.startsWith('media:')) { const m = JSON.parse(data[k].v); if (m.uploaded && m.status !== 'ready') enqueue(m.id); }
  const tick = () => worker.scheduled({}, env, ctx).catch((e) => console.log('[refresh]', e.message));
  setTimeout(tick, 1000);
  setInterval(tick, 5 * 60e3);
});
