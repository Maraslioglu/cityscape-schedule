// Runs the Cityscape Schedule app (worker.js) on Railway with Node 20+.
// Everything is stored on the Railway volume at /data:
//   /data/store.json      logins, users, cleanings, damage reports, Guesty token, pre-loaded bookings
//   /data/media/          cleaning videos and photos: the untouched original, plus a copy for quick playback
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
const FREE_MARGIN = 3 * 1024 ** 3;        // refuse new uploads when the disk would get within 3 GB of full
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const HAS_FFPROBE = spawnSync('ffprobe', ['-version']).status === 0;
// HDR videos (iPhone default) need tone mapping, or the playback copy looks washed out.
const HAS_ZSCALE = HAS_FFMPEG && /\bzscale\b/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '');
// Full-quality originals of cleaning videos/photos are deleted after this many days (0 = keep forever).
// Damage-report media is never deleted. The playback copy is kept.
const KEEP_ORIGINAL_DAYS = Number(process.env.KEEP_ORIGINAL_DAYS ?? 30);

// ---------------- key-value storage saved to disk (store.json) ----------------
// Every save writes a temp file, flushes it to disk and swaps it in; the previous version is kept as store.json.bak
// and a copy is kept per day in backups/ (the last 14). If store.json can't be read at start-up, the newest good copy
// is used instead — and if none can be read, the app stops rather than starting empty and overwriting real data.
const BACKUPS = path.join(DIR, 'backups');
fs.mkdirSync(BACKUPS, { recursive: true });
if (process.env.RAILWAY_ENVIRONMENT && !process.env.DATA_DIR && DIR !== '/data') { console.log('[store] FATAL: the /data volume isn’t mounted. Not starting.'); process.exit(1); }
const backupFiles = () => fs.readdirSync(BACKUPS).filter((n) => /^store-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
let restoredFrom = null;
function loadStore() {
  const candidates = [FILE, FILE + '.bak', ...backupFiles().reverse().map((n) => path.join(BACKUPS, n))].filter((f) => fs.existsSync(f));
  if (!candidates.length) return {}; // first run
  for (const f of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not a store');
      if (f !== FILE) { restoredFrom = f; console.log(`[store] WARNING: ${FILE} couldn’t be read, so the app is using ${f}`); }
      return d;
    } catch (e) {
      console.log(`[store] ${f} can’t be read: ${e.message}`);
      if (f === FILE) try { fs.copyFileSync(FILE, `${FILE}.unreadable-${Date.now()}`); } catch (_) {}
    }
  }
  console.log('[store] FATAL: store.json and all its backups are unreadable. Not starting, so nothing gets overwritten.');
  process.exit(1);
}
let data = loadStore();
let saveTimer = null, firstPending = 0, lastSaveError = null, lastSavedAt = 0;
function dailyBackup() {
  const f = path.join(BACKUPS, `store-${new Date().toISOString().slice(0, 10)}.json`);
  if (fs.existsSync(f) || !fs.existsSync(FILE)) return;
  try {
    fs.copyFileSync(FILE, f);
    for (const old of backupFiles().slice(0, -14)) fs.rmSync(path.join(BACKUPS, old), { force: true });
    console.log(`[backup] saved ${path.basename(f)}`);
  } catch (e) { console.log('[backup] failed', e.message); }
}
function writeNow() {
  clearTimeout(saveTimer); saveTimer = null; firstPending = 0;
  try {
    const tmp = FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.bak'); // keep the last good copy, and never leave a moment with no store.json
    fs.renameSync(tmp, FILE); // atomic swap
    lastSaveError = null; lastSavedAt = Date.now();
    dailyBackup();
  } catch (e) { lastSaveError = e.message; console.log('[store] could not save', e.message); } // e.g. disk full: keep running, retry on next change
}
const save = () => {
  if (!firstPending) firstPending = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, Date.now() - firstPending > 2000 ? 0 : 200); // group quick changes, but never wait over 2 s
};
// Railway stops the old copy on every deploy: save anything pending first.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (saveTimer) writeNow(); process.exit(0); });
dailyBackup();
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
// Only plain video/image types are ever stored or sent back (never SVG/XML/HTML, which a browser could run as a page).
const safeMediaType = (t) => { t = String(t || '').toLowerCase().slice(0, 60); return /^(video|image)\/[\w.+-]+$/.test(t) && !/svg|xml|html/.test(t) ? t : ''; };
const fileFor = (m, variant) => path.join(MEDIA, variant === 'thumb' ? `${m.id}.thumb.jpg` : variant === 'orig' ? `${m.id}.orig` : m.file || `${m.id}.orig`);

// ---------------- compression queue (one job at a time) ----------------
const queue = [];
let working = false;
function enqueue(id, first = false) { if (first) queue.unshift(id); else queue.push(id); pump(); } // photos go first: they take seconds
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
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(p.pid, 15); } catch (_) {} // low priority, so the app stays quick while a video converts
    let err = '';
    const timer = setTimeout(() => { err += ' [stopped: took over 3 hours]'; try { p.kill('SIGKILL'); } catch (_) {} }, 3 * 3600e3);
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
}
// What was actually uploaded: resolution (as shown, i.e. after the phone's rotation), frame rate, codec, HDR.
function probe(file) {
  if (!HAS_FFPROBE) return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 120e3);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      let j; try { j = JSON.parse(out); } catch (_) { return resolve(null); }
      const v = (j.streams || []).find((s) => s.codec_type === 'video');
      if (!v || !v.width) return resolve(null);
      let rot = Number(v.tags && v.tags.rotate) || 0;
      for (const sd of v.side_data_list || []) if (sd.rotation != null) rot = Number(sd.rotation);
      const turned = Math.abs(rot) % 180 === 90;
      const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
      const duration = Number(j.format && j.format.duration);
      resolve({
        width: turned ? v.height : v.width, height: turned ? v.width : v.height,
        fps: d && n ? Math.round((n / d) * 100) / 100 : null, codec: v.codec_name || null,
        bitrate: Number(v.bit_rate || (j.format && j.format.bit_rate)) || null,
        hdr: ['arib-std-b67', 'smpte2084'].includes(v.color_transfer),
        duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      });
    });
  });
}
async function processMedia(id) {
  const m = await getMeta(id);
  if (!m) return;
  const orig = fileFor(m, 'orig');
  if (!m.origType) m.origType = m.type || '';
  if (!m.info) m.info = await probe(orig);
  if (m.info && m.info.duration) m.duration = m.info.duration;
  m.hasOrig = true; // the original is never replaced; only the retention sweep removes it, after KEEP_ORIGINAL_DAYS
  if (!HAS_FFMPEG) { Object.assign(m, { status: 'ready', file: `${m.id}.orig` }); await putMeta(m); return; }
  m.status = 'processing'; await putMeta(m);
  const started = Date.now();
  if (m.kind === 'video') {
    // Playback copy: 1080p H.264 at high quality, a keyframe every second so pausing and scrubbing are precise,
    // and it starts playing before it has fully loaded. Managers can still open the untouched original.
    const out = path.join(MEDIA, `${m.id}.mp4`);
    const hdr = Boolean(m.info && m.info.hdr);
    const vf = ["scale=w='if(gt(iw,ih),-2,min(1080,iw))':h='if(gt(iw,ih),min(1080,ih),-2)':flags=lanczos"];
    if (hdr && HAS_ZSCALE) vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
    vf.push('format=yuv420p');
    const args = (audio) => ['-y', '-i', orig, '-map', '0:v:0', ...(audio ? ['-map', '0:a:0?'] : []), '-vf', vf.join(','),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-force_key_frames', 'expr:gte(t,n_forced*1)',
      ...(hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
      ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']), '-movflags', '+faststart', '-f', 'mp4', out + '.part'];
    let r = await run(args(true));
    if (r.code !== 0) r = await run(args(false)); // e.g. an audio format ffmpeg can't read: keep the picture at least
    if (r.code === 0) {
      await fsp.rename(out + '.part', out);
      const thumb = path.join(MEDIA, `${m.id}.thumb.jpg`);
      await run(['-y', '-ss', '1', '-i', out, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', thumb]);
      if (!fs.existsSync(thumb)) await run(['-y', '-i', out, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', thumb]); // under 1 second long
      m.file = `${m.id}.mp4`; m.type = 'video/mp4'; m.status = 'ready';
      m.compressedSize = fs.statSync(out).size;
    } else {
      await fsp.rm(out + '.part', { force: true });
      console.log('[media] video conversion failed, keeping original', r.err.slice(-300));
      m.file = `${m.id}.orig`; m.status = 'ready';
    }
  } else {
    const out = path.join(MEDIA, `${m.id}.jpg`);
    const r = await run(['-y', '-i', orig, '-vf', "scale='min(2560,iw)':-2", '-q:v', '2', out]);
    await run(['-y', '-i', orig, '-vf', "scale='min(640,iw)':-2", '-q:v', '4', path.join(MEDIA, `${m.id}.thumb.jpg`)]);
    if (r.code === 0) { m.file = `${m.id}.jpg`; m.type = 'image/jpeg'; m.status = 'ready'; m.compressedSize = fs.statSync(out).size; }
    else { m.file = `${m.id}.orig`; m.status = 'ready'; }
  }
  await putMeta(m);
  const i = m.info;
  console.log(`[media] ${m.kind} ${m.id} ready in ${Math.round((Date.now() - started) / 1000)}s: original ${Math.round(m.size / 1e6)} MB` +
    (i ? ` ${i.width}x${i.height} ${i.codec || ''}${i.fps ? ' ' + i.fps + 'fps' : ''}${i.hdr ? ' HDR' : ''}${i.bitrate ? ' ' + Math.round(i.bitrate / 1e5) / 10 + ' Mb/s' : ''}` : '') +
    ` → copy ${Math.round((m.compressedSize || m.size) / 1e6)} MB`);
}

// An original can be deleted once it's safe to: fully uploaded and converted, not damage evidence, and its
// playback copy exists (so the cleaning still has a video).
const freeBytes = () => { try { const s = fs.statfsSync(MEDIA); return s.bavail * s.bsize; } catch (_) { return Infinity; } };
function originalDeletable(m) {
  return m && m.uploaded && m.status === 'ready' && m.purpose !== 'damage' && m.purpose !== 'maintenance' && m.purpose !== 'complaint' && m.file && m.file !== `${m.id}.orig`
    && fs.existsSync(path.join(MEDIA, m.file)) && fs.existsSync(path.join(MEDIA, `${m.id}.orig`));
}
async function dropOriginal(m, why) {
  await fsp.rm(path.join(MEDIA, `${m.id}.orig`), { force: true });
  const live = await getMeta(m.id);
  if (live) { live.hasOrig = false; live.origDeletedAt = new Date().toISOString(); await putMeta(live); }
  console.log(`[media] original of ${m.kind} ${m.id} deleted: ${why}`);
}
// When the disk runs low, delete the oldest deletable originals early rather than refusing cleaners' uploads.
const LOW_WATER = FREE_MARGIN + 5 * 1024 ** 3;
let warnedLow = 0;
async function freeSpace(need = LOW_WATER) {
  if (freeBytes() >= need) return;
  const oldest = Object.keys(data).filter((k) => k.startsWith('media:'))
    .map((k) => { try { return JSON.parse(data[k].v); } catch (_) { return null; } })
    .filter(originalDeletable).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const m of oldest) {
    if (freeBytes() >= need) break;
    await dropOriginal(m, 'disk nearly full');
  }
  if (Date.now() - warnedLow > 3600e3) { warnedLow = Date.now(); console.log(`[media] WARNING: disk nearly full (${Math.round(freeBytes() / 1e9)} GB free); originals are being deleted early. Grow the volume or lower KEEP_ORIGINAL_DAYS.`); }
}

// Delete full-quality originals of cleaning media after KEEP_ORIGINAL_DAYS, and uploads idle for 3 days.
// Never touches damage-report or maintenance media, or an original that is the only copy.
async function sweepMedia() {
  const now = Date.now();
  for (const k of Object.keys(data)) {
    if (!k.startsWith('media:')) continue;
    let m; try { m = JSON.parse(data[k].v); } catch (_) { continue; }
    const age = now - Date.parse(m.createdAt || 0);
    if (!m.uploaded) {
      if (now - Date.parse(m.lastChunkAt || m.createdAt || 0) > 3 * 864e5 && !(await getMeta(m.id) || {}).busy) {
        await fsp.rm(path.join(MEDIA, `${m.id}.orig`), { force: true });
        metaCache.delete(m.id); await STORE.delete(k);
        console.log(`[media] removed abandoned upload ${m.id}`);
      }
      continue;
    }
    if (!(KEEP_ORIGINAL_DAYS > 0) || age < KEEP_ORIGINAL_DAYS * 864e5 || !originalDeletable(m)) continue;
    await dropOriginal(m, `older than ${KEEP_ORIGINAL_DAYS} days`);
  }
  await freeSpace();
}

// Up to 40 GB a day per person (about ten long 4K walkthroughs), so one account can't fill the disk.
const DAILY_UPLOAD = Number(process.env.DAILY_UPLOAD_GB || 40) * 1024 ** 3;
const uploads = new Map();
function uploadedToday(userId) {
  const day = new Date().toISOString().slice(0, 10);
  let q = uploads.get(userId);
  if (!q || q.day !== day) { q = { day, bytes: 0 }; uploads.set(userId, q); }
  return q;
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
    // Space is freed as the file actually arrives (see PUT); starting an upload can't make the server delete anything.
    if (freeBytes() < Math.min(size, 2 * 1024 ** 3) + FREE_MARGIN) {
      console.log(`[media] refused ${Math.round(size / 1e6)} MB upload: only ${Math.round(freeBytes() / 1e9)} GB free`);
      return sendJson(res, 507, { error: 'The server is out of space for videos. Please tell an admin.' });
    }
    const m = {
      id: crypto.randomBytes(12).toString('hex'), kind, purpose: body.purpose, ownerId: body.ownerId || null, listingId: body.listingId || null,
      building: c.building || null, name: String(body.name || kind).slice(0, 120), type: safeMediaType(body.type), size,
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

    if (req.method === 'GET' && !parts[3]) return sendJson(res, 200, { id: m.id, received: m.received, size: m.size, uploaded: m.uploaded, status: m.status, byMe: me.userId === m.byId, info: m.info || null });

    // Resumable upload: PUT /api/media/:id?offset=N with the next piece of the file as the body.
    if (req.method === 'PUT' && !parts[3]) {
      if (me.userId !== m.byId) { req.resume(); return sendJson(res, 403, { error: 'Only the person uploading can send this file.' }); }
      if (m.uploaded) { req.resume(); return sendJson(res, 200, { received: m.received, uploaded: true, info: m.info || null }); }
      const offset = Number(url.searchParams.get('offset'));
      if (offset !== m.received || m.busy) { req.resume(); return sendJson(res, 409, { received: m.received }); } // tells the phone where to carry on from
      m.busy = true;
      try {
      const f = fileFor(m, 'orig');
      // The file must end exactly where the phone continues. A restart mid-piece can leave extra bytes (drop them;
      // the phone re-sends that piece) or a lost save can leave fewer (tell the phone where to carry on from).
      const onDisk = fs.statSync(f).size;
      if (onDisk < offset) { req.resume(); m.received = onDisk; await putMeta(m); return sendJson(res, 409, { received: onDisk }); }
      if (onDisk > offset) await fsp.truncate(f, offset);
      const quota = uploadedToday(m.byId);
      if (quota.bytes > DAILY_UPLOAD) { req.resume(); return sendJson(res, 429, { received: offset, error: 'You’ve uploaded a lot today. Please ask an admin if you need to upload more.' }); }
      if (freeBytes() < MAX_CHUNK + 512 * 1024 ** 2) await freeSpace(MAX_CHUNK + FREE_MARGIN);
      if (freeBytes() < MAX_CHUNK + 512 * 1024 ** 2) { req.resume(); return sendJson(res, 507, { received: offset, error: 'The server is out of space for videos. Please tell an admin.' }); }
      const out = fs.createWriteStream(f, { flags: 'a' });
      let n = 0, tooBig = false, writeErr = null;
      out.on('error', (e) => { writeErr = e; });
      await new Promise((resolve) => {
        req.on('data', (c) => { n += c.length; if (n > MAX_CHUNK || m.received + n > m.size) { tooBig = true; req.destroy(); } else if (!writeErr) out.write(c); });
        req.on('end', resolve); req.on('close', resolve); req.on('error', resolve);
      });
      await new Promise((r) => { if (writeErr) return r(); out.once('error', r); out.end(r); });
      if (writeErr) {
        console.log('[media] could not write upload', m.id, writeErr.message);
        await fsp.truncate(f, offset).catch(() => {}); m.received = offset; await putMeta(m);
        return sendJson(res, 507, { received: offset, error: 'The server couldn’t save the video. Please tell an admin.' });
      }
      const actual = fs.statSync(f).size;
      quota.bytes += Math.max(0, actual - offset);
      m.received = actual;
      m.lastChunkAt = new Date().toISOString();
      if (tooBig) { await fsp.truncate(f, offset); m.received = offset; await putMeta(m); return sendJson(res, 413, { received: offset }); }
      if (m.received >= m.size) {
        m.uploaded = true; m.status = 'queued';
        m.origType = m.type || '';
        m.info = await probe(fileFor(m, 'orig')); // so the phone can warn straight away if the video is low quality
      }
      await putMeta(m);
      if (m.uploaded) enqueue(m.id, m.kind === 'photo');
      return sendJson(res, 200, { received: m.received, uploaded: m.uploaded, info: m.info || null });
      } finally { m.busy = false; }
    }
  }

  // Playback: GET /media/:id, /media/:id/thumb and /media/:id/orig (the untouched full-quality upload); all support seeking
  if (req.method === 'GET' && parts[0] === 'media' && parts[1]) {
    const m = await getMeta(parts[1]);
    if (!m) { res.writeHead(404); return res.end('Not found'); }
    const c = await check(req, { mode: 'view', id: m.id });
    if (!c.ok) { res.writeHead(c.status === 401 ? 401 : 403); return res.end('Not allowed'); }
    const variant = parts[2] === 'thumb' ? 'thumb' : parts[2] === 'orig' ? 'orig' : 'main';
    if (variant === 'orig' && !m.uploaded) { res.writeHead(404); return res.end('Not found'); }
    let file = fileFor(m, variant);
    if (variant !== 'main' && !fs.existsSync(file)) { res.writeHead(404); return res.end(variant === 'orig' ? 'The full-quality original is no longer kept' : ''); }
    if (!fs.existsSync(file)) file = fileFor(m, 'orig');
    const stat = fs.statSync(file);
    const isOrig = file === fileFor(m, 'orig');
    const origType = safeMediaType(m.origType || (m.file && m.file !== `${m.id}.orig` ? '' : m.type));
    const type = variant === 'thumb' ? 'image/jpeg'
      : isOrig ? (origType || (m.kind === 'video' ? 'video/mp4' : 'image/jpeg'))
      : (safeMediaType(m.type) || (m.kind === 'video' ? 'video/mp4' : 'image/jpeg'));
    const etag = `"${m.id}-${variant}-${stat.size}-${Math.round(stat.mtimeMs)}"`;
    // Only whitelisted video/image types are sent (safeMediaType), so a file can't run as a page. (A CSP sandbox
    // here would also stop the browser's own player loading the video when "Full quality" opens it in a tab.)
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', ETag: etag, 'Last-Modified': stat.mtime.toUTCString() };
    const ext = isOrig ? (path.extname(m.name || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || (m.kind === 'video' ? '.mov' : '.jpg')) : path.extname(file);
    if (url.searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${m.kind}-${m.id}${isOrig ? '-original' : ''}${ext}"`;
    if (req.headers['if-none-match'] === etag && !req.headers.range) { res.writeHead(304, headers); return res.end(); }
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
  return false;
}

// ---------------- status (for an uptime monitor) and backups (Admins) ----------------
const MAX_BODY = 1024 * 1024;
const bootAt = Date.now();
// /status: 200 when all is well, 503 when something needs attention. No private data.
function sendStatus(res) {
  let snap = null; try { snap = data.snapshot ? JSON.parse(data.snapshot.v) : null; } catch (_) {}
  const freeGb = Math.round(freeBytes() / 1e8) / 10;
  const snapMins = snap && snap.at ? Math.round((Date.now() - snap.at) / 60000) : null;
  const problems = [];
  if (lastSaveError) problems.push(`Saving data failed: ${lastSaveError}`);
  if (restoredFrom) problems.push(`store.json couldn’t be read at start-up; running from ${path.basename(restoredFrom)}`);
  if (freeGb < 10) problems.push(`Only ${freeGb} GB of disk left`);
  if (snapMins === null || snapMins > 30) problems.push(snapMins === null ? 'No bookings loaded from Guesty yet' : `Bookings last loaded from Guesty ${snapMins} min ago`);
  if (queue.length > 20) problems.push(`${queue.length} videos waiting to be processed`);
  sendJson(res, problems.length ? 503 : 200, {
    ok: !problems.length, problems, bookingsLoadedMinutesAgo: snapMins, diskFreeGb: freeGb, lastSavedSecondsAgo: lastSavedAt ? Math.round((Date.now() - lastSavedAt) / 1000) : null,
    backups: backupFiles().length, videoQueue: queue.length, upSinceMinutes: Math.round((Date.now() - bootAt) / 60000),
  });
}
// Admins can download the app's data: today's live copy or one of the daily backups. (Videos and photos aren't
// included — they stay on the volume.) The file holds everything, including password hashes: keep it safe.
async function backupsRoute(req, res, url) {
  const c = await check(req, { mode: 'admin' });
  if (c.status === 401) return sendJson(res, 401, { error: 'Not signed in' });
  if (!c.ok) return sendJson(res, 403, { error: 'Only Admins can download backups.' });
  const name = url.pathname.split('/')[4] || '';
  if (req.method === 'GET' && !name) {
    return sendJson(res, 200, { backups: backupFiles().reverse().map((n) => ({ name: n, day: n.slice(6, 16), size: fs.statSync(path.join(BACKUPS, n)).size })) });
  }
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Not supported' });
  let file;
  if (name === 'now') { if (saveTimer) writeNow(); file = FILE; }
  else if (/^store-\d{4}-\d{2}-\d{2}\.json$/.test(name) && fs.existsSync(path.join(BACKUPS, name))) file = path.join(BACKUPS, name);
  else return sendJson(res, 404, { error: 'That backup wasn’t found.' });
  console.log(`[backup] ${c.user.name} downloaded ${name === 'now' ? 'the live data' : name}`);
  const stamp = name === 'now' ? new Date().toISOString().slice(0, 16).replace(':', '') : name.slice(6, 16);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="cityscape-schedule-data-${stamp}.json"`, 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
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

    if (url.pathname === '/status') return sendStatus(res);
    if (url.pathname.startsWith('/api/admin/backups')) return backupsRoute(req, res, url);

    // Everything except video/photo uploads is small: refuse bodies over 1 MB before reading them into memory.
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) { req.resume(); return sendJson(res, 413, { error: 'That request is too large.' }); }
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(c); }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    // Railway's proxy adds the real address at the end of X-Forwarded-For; anything before it came from the browser.
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const ip = fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress || '';
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
  console.log(`[media] ffmpeg ${HAS_FFMPEG ? 'yes' : 'no'}, ffprobe ${HAS_FFPROBE ? 'yes' : 'no'}, HDR tone mapping ${HAS_ZSCALE ? 'yes' : 'no'}, originals kept ${KEEP_ORIGINAL_DAYS > 0 ? KEEP_ORIGINAL_DAYS + ' days' : 'forever'}`);
  // Finish any uploads that were being compressed when the server last restarted, and note which originals still exist.
  for (const k of Object.keys(data)) {
    if (!k.startsWith('media:')) continue;
    const m = await getMeta(k.slice(6));
    if (!m) continue;
    if (m.uploaded && m.status !== 'ready') enqueue(m.id, m.kind === 'photo');
    const has = Boolean(m.uploaded) && fs.existsSync(fileFor(m, 'orig'));
    if (m.hasOrig !== has) { m.hasOrig = has; await putMeta(m); }
  }
  setTimeout(() => sweepMedia().catch((e) => console.log('[media] sweep failed', e.message)), 60e3);
  setInterval(() => sweepMedia().catch((e) => console.log('[media] sweep failed', e.message)), 6 * 3600e3);
  const tick = () => worker.scheduled({}, env, ctx).catch((e) => console.log('[refresh]', e.message));
  setTimeout(tick, 1000);
  setInterval(tick, 5 * 60e3);
});
