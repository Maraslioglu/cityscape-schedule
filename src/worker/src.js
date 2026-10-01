// Cityscape Schedule — Cloudflare Worker.
// Serves the web app, the team login, and the week/linen data built from Guesty.
//
// Bindings (Cloudflare dashboard → Worker → Settings):
//   KV namespace  STORE                  – Guesty token + pre-loaded bookings
//   Secrets       GUESTY_CLIENT_ID, GUESTY_CLIENT_SECRET, APP_PASSWORD
//   Cron trigger  */5 * * * *            – keeps bookings fresh in the background
//   Optional vars PUBLIC_URL, WEEK_START_DAY, RESERVATION_STATUSES, DEFAULT_CHECKIN_TIME,
//                 DEFAULT_CHECKOUT_TIME, UNIT_TYPE_OVERRIDES, BUILDING_OVERRIDES,
//                 HIDDEN_LISTINGS, NEW_BOOKING_HOURS, KEYNEST_API_KEY,
//                 ASSISTANT_API_KEY (lets the guest assistant report maintenance)
//
// Without Guesty keys it runs on sample data so it can be previewed.

/* __ASSETS__ */

/* __MOCK__ */

const GUESTY = 'https://open-api.guesty.com';
const SESSION_DAYS = 30;
const WINDOW_BEFORE = 14;   // days of bookings kept before the current week
const WINDOW_AFTER = 84;    // …and after (12 weeks ahead)
const MEM_TTL = 10e3;       // how long one Worker instance trusts its in-memory copy

// ---------------------------------------------------------------- config
function config(env) {
  const json = (v) => { try { return JSON.parse(v || '{}'); } catch (_) { return {}; } };
  return {
    mock: !env.GUESTY_CLIENT_ID || !env.GUESTY_CLIENT_SECRET || env.MOCK === '1',
    weekStartDay: Number(env.WEEK_START_DAY ?? 6),
    statuses: (env.RESERVATION_STATUSES || 'confirmed').split(',').map((s) => s.trim()).filter(Boolean),
    defaultIn: env.DEFAULT_CHECKIN_TIME || '15:00',
    defaultOut: env.DEFAULT_CHECKOUT_TIME || '10:00',
    typeOverrides: json(env.UNIT_TYPE_OVERRIDES),
    buildingOverrides: json(env.BUILDING_OVERRIDES),
    hidden: (env.HIDDEN_LISTINGS || '').split(',').map((s) => s.trim()).filter(Boolean),
    newHours: Number(env.NEW_BOOKING_HOURS || 24),
  };
}

// ---------------------------------------------------------------- small helpers
const enc = new TextEncoder();
function hex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmac(keyHex, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const secretKey = (env) => sha256(`cs:${env.APP_PASSWORD || ''}:${env.GUESTY_CLIENT_SECRET || 'preview'}`);

function todayInLondon() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()); }
function addDays(d, n) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function weekStartFor(d, startDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) d = todayInLondon();
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  return addDays(d, -((dow - startDay + 7) % 7));
}
function fmtTime(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}/.test(hhmm)) return null;
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}.${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`;
}

// ---------------------------------------------------------------- responses
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...extra } });
}
function redirect(loc, extra = {}) { return new Response(null, { status: 302, headers: { Location: loc, 'Cache-Control': 'no-store', ...extra } }); }
function asset(req, name) {
  const a = ASSETS[name];
  if (!a) return new Response('Not found', { status: 404 });
  const etag = `"${a.hash}"`;
  const versioned = new URL(req.url).searchParams.has('v');
  const headers = {
    'Content-Type': a.type, ETag: etag, ...SEC,
    'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : a.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
  };
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  if (a.b64 && !a.bytes) a.bytes = Uint8Array.from(atob(a.body), (c) => c.charCodeAt(0)); // images: decoded once
  return new Response(a.b64 ? a.bytes : a.body, { headers });
}

// ---------------------------------------------------------------- users, roles & permissions
// Each person has their own username + password. Permissions are ticked per person on the Users page.
// "owner" + the APP_PASSWORD secret is a recovery login that always has full access.
// [key, label, group, roles that have it by default]. A permission added later falls back to these
// defaults for existing accounts (effectivePerms), so each new one matches what that role could already do.
const ALL4 = ['admin', 'user', 'supervisor', 'cleaner'], RUNS = ['admin', 'user'], LEADS = ['admin', 'user', 'supervisor'];
const PERM_DEFS = [
  ['view_day', 'Day view', 'Schedule', ALL4],
  ['view_board', 'Board (whole week)', 'Schedule', ALL4],
  ['view_linen', 'Linen totals', 'Schedule', ALL4],
  ['view_guests', 'Guest numbers', 'Schedule', ALL4],
  ['copy_print', 'Copy for WhatsApp & Print', 'Schedule', LEADS],
  ['refresh', 'Refresh from Guesty', 'Schedule', LEADS],
  ['do_cleaning', 'Begin & end cleanings', 'Cleaning', ['admin', 'supervisor', 'cleaner']],
  ['view_cleaning', 'See cleaning times, videos & lockbox codes', 'Cleaning', ALL4],
  ['assign_cleanings', 'Assign cleanings to people', 'Cleaning', RUNS],
  ['step_in', 'Finish others’ cleanings & override KeyNest', 'Cleaning', LEADS],
  ['view_properties', 'Properties list', 'Properties', ALL4],
  ['edit_properties', 'Edit property details', 'Properties', LEADS],
  ['edit_lockbox', 'Change lockbox codes', 'Properties', ALL4],
  ['report_damage', 'Report damage', 'Damage & maintenance', ALL4],
  ['manage_damage', 'Resolve damage reports', 'Damage & maintenance', LEADS],
  ['report_maintenance', 'Report maintenance issues', 'Damage & maintenance', ALL4],
  ['manage_maintenance', 'Assign & manage maintenance tasks', 'Damage & maintenance', RUNS],
  ['moderate_forum', 'Moderate the forum (status, delete posts)', 'Team', RUNS],
  ['manage_users', 'Manage users', 'Team', ['admin']],
  ['manage_settings', 'Settings & integrations (KeyNest)', 'Admin', RUNS],
  ['download_backups', 'Download data backups', 'Admin', ['admin']],
];
const PERMS = PERM_DEFS.map(([k, label, group]) => [k, label, group]);
const ROLES = ['admin', 'supervisor', 'user', 'cleaner'];
function roleDefaults(role) {
  const perms = Object.fromEntries(PERM_DEFS.map(([k, , , roles]) => [k, roles.includes(role)]));
  return { perms, buildings: role === 'cleaner' ? [] : 'all' };
}
const PBKDF2_ITER = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers' ? 100000 : 600000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hashPassword(pw, saltB64, iter = PBKDF2_ITER) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return { salt: b64(salt), hash: b64(bits), iter };
}
async function checkPassword(pw, rec) {
  if (!rec || !rec.salt) return false;
  const h = await hashPassword(pw, rec.salt, rec.iter || PBKDF2_ITER);
  return safeEqual(h.hash, rec.hash);
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Passwords need at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

let memUsers = null; // { list, readAt }
async function loadUsers(env, fresh) {
  if (!fresh && memUsers && Date.now() - memUsers.readAt < MEM_TTL) return memUsers.list;
  const list = (await env.STORE.get('users', 'json')) || [];
  memUsers = { list, readAt: Date.now() };
  return list;
}
async function saveUsers(env, list) {
  await env.STORE.put('users', JSON.stringify(list));
  memUsers = { list, readAt: Date.now() };
}
async function ownerUser(env) {
  return {
    id: 'owner', username: 'owner', name: 'Owner (recovery login)', email: '', role: 'admin', isOwner: true, active: true,
    perms: Object.fromEntries(PERMS.map(([k]) => [k, true])), buildings: 'all',
    epoch: (await sha256('owner:' + (env.APP_PASSWORD || ''))).slice(0, 8),
  };
}
// Permissions added later fall back to the role's defaults until an admin changes them.
function effectivePerms(u) {
  const d = roleDefaults(u.role).perms;
  return Object.fromEntries(PERMS.map(([k]) => [k, u.perms && k in u.perms ? Boolean(u.perms[k]) : d[k]]));
}
function publicUser(u) {
  const { pw, ...rest } = u;
  return { ...rest, perms: effectivePerms(u) };
}
const can = (u, perm) => Boolean(u && effectivePerms(u)[perm]);

// Session cookie: userId.epoch.expiry.signature — changing a password or deactivating bumps the epoch and signs the person out.
async function makeSession(env, user) {
  const body = `${user.id}.${user.epoch}.${Date.now() + SESSION_DAYS * 864e5}`;
  return body + '.' + (await hmac(await secretKey(env), 'session:' + body));
}
async function sessionUser(env, token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [id, epoch, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  if (!safeEqual(sig, await hmac(await secretKey(env), 'session:' + `${id}.${epoch}.${exp}`))) return null;
  const u = id === 'owner' ? await ownerUser(env) : (await loadUsers(env)).find((x) => x.id === id);
  if (!u || !u.active || String(u.epoch) !== epoch) return null;
  return u;
}
function cookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
const attempts = new Map(); // per-instance login throttle: by address, by address+account, and by account
function throttled(key, max = 10) {
  const now = Date.now();
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.length || now - v[v.length - 1] > 10 * 60e3) attempts.delete(k);
  const list = (attempts.get(key) || []).filter((t) => now - t < 10 * 60e3);
  if (list.length) attempts.set(key, list); else attempts.delete(key);
  return list.length >= max;
}
function recordFail(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }

async function login(env, username, password) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  if (username === 'owner') return env.APP_PASSWORD && safeEqual(password, env.APP_PASSWORD) ? ownerUser(env) : null;
  const users = await loadUsers(env, true);
  const u = users.find((x) => x.username === username && x.active);
  if (!u) { await hashPassword(password); return null; } // same work either way, so timing doesn't reveal usernames
  if (!(await checkPassword(password, u.pw))) return null;
  const pw = (u.pw.iter || 0) < PBKDF2_ITER ? await hashPassword(password) : null; // stronger hash from now on
  // Re-read inside the lock, so an admin's change made while this sign-in was being checked isn't undone.
  return withLock('users', async () => {
    const fresh = await loadUsers(env, true);
    const x = fresh.find((y) => y.id === u.id);
    if (!x || !x.active) return null;
    x.lastLoginAt = new Date().toISOString();
    if (pw && x.pw && x.pw.salt === u.pw.salt) x.pw = pw;
    await saveUsers(env, fresh);
    return x;
  });
}

// ---- Users API (manage_users) ----
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
function cleanUserInput(body, existing) {
  const out = {};
  if ('name' in body || !existing) out.name = String(body.name || '').trim().slice(0, 80);
  if ('username' in body || !existing) out.username = String(body.username || '').trim().toLowerCase();
  if ('email' in body || !existing) out.email = String(body.email || '').trim().slice(0, 120);
  if ('role' in body || !existing) out.role = ROLES.includes(body.role) ? body.role : 'user';
  if ('perms' in body) out.perms = Object.fromEntries(PERMS.map(([k]) => [k, Boolean(body.perms && body.perms[k])]));
  if ('buildings' in body) out.buildings = body.buildings === 'all' ? 'all' : Array.isArray(body.buildings) ? body.buildings.map(String).slice(0, 200) : [];
  if ('active' in body) out.active = Boolean(body.active);
  if (out.name !== undefined && !out.name) return { error: 'Add the person’s name.' };
  if (out.username !== undefined && (!USERNAME_RE.test(out.username) || out.username === 'owner')) return { error: 'Usernames use 2–32 lowercase letters, numbers, dots, dashes or underscores (and can’t be “owner”).' };
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: 'That email address doesn’t look right.' };
  return { out };
}
// Supervisors manage only the people they add themselves — as supervisors or cleaners, within their own buildings,
// never with more access than they have. They don't see Admins, Users or anyone someone else added.
// Admins (and anyone given "Manage users") manage everyone, as before.
const SUP_ROLES = ['supervisor', 'cleaner'];
const limitedManager = (me) => me.role === 'supervisor';
const addedBy = (u, me) => u.createdById === me.id;
// Someone a supervisor may manage must not reach beyond them (e.g. after an admin narrowed the supervisor's buildings).
const withinReach = (me, u) => (u.buildings === 'all' ? me.buildings === 'all' || me.buildings == null : (u.buildings || []).every((b) => coversBuilding(me, b)))
  && Object.entries(effectivePerms(u)).every(([k, v]) => !v || effectivePerms(me)[k]);
function limitForSupervisor(me, out, existing) {
  if (out.role !== undefined && !SUP_ROLES.includes(out.role)) return 'Supervisors can add supervisors and cleaners only.';
  const role = out.role || (existing && existing.role);
  const mine = effectivePerms(me);
  // Access: never more than the supervisor has, and never managing users.
  const base = out.perms || (existing ? existing.perms : null) || roleDefaults(role).perms;
  out.perms = Object.fromEntries(PERMS.map(([k]) => [k, k !== 'manage_users' && Boolean(base[k]) && Boolean(mine[k])]));
  // Buildings: only ones the supervisor covers.
  if (out.buildings !== undefined || !existing) {
    let b = out.buildings !== undefined ? out.buildings : roleDefaults(role).buildings;
    if (b === 'all' && me.buildings !== 'all') b = [...(me.buildings || [])];
    if (Array.isArray(b)) b = b.filter((x) => coversBuilding(me, x));
    out.buildings = b;
  }
  return null;
}
async function usersApi(req, env, ctx, me, id) {
  const all = await loadUsers(env, true);
  // Accounts made before "added by" was recorded as an id: match their creator's username once, now, and keep the id.
  if (all.some((u) => !u.createdById && u.createdBy)) {
    for (const u of all) if (!u.createdById && u.createdBy) u.createdById = u.createdBy === 'owner' ? 'owner' : (all.find((x) => x.username === u.createdBy) || {}).id || 'unknown';
    await saveUsers(env, all);
  }
  const limited = limitedManager(me);
  const users = limited ? all.filter((u) => addedBy(u, me) && SUP_ROLES.includes(u.role)) : all;
  if (req.method === 'GET' && !id) {
    const snap = await getSnapshot(env, ctx);
    const buildings = [...new Set([...listingMap(snap.listings, config(env)).values()].map((l) => l.building))].sort(byBuilding).filter((b) => !limited || coversBuilding(me, b));
    const roles = limited ? SUP_ROLES : ROLES, mine = effectivePerms(me);
    return json({
      users: users.map(publicUser).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name)),
      perms: limited ? PERMS.filter(([k]) => k !== 'manage_users' && mine[k]) : PERMS, roles,
      defaults: Object.fromEntries(roles.map((r) => { const d = roleDefaults(r); if (!limited) return [r, d]; const o = { role: r }; limitForSupervisor(me, o); return [r, { perms: o.perms, buildings: o.buildings }]; })),
      buildings, limited, canAllBuildings: !limited || me.buildings === 'all',
    });
  }
  const body = req.method === 'DELETE' ? {} : await req.json().catch(() => ({}));
  if (req.method === 'POST' && !id) {
    const { out, error } = cleanUserInput(body);
    if (error) return json({ error }, 400);
    if (limited) { const bad = limitForSupervisor(me, out); if (bad) return json({ error: bad }, 403); }
    if (all.some((u) => u.username === out.username)) return json({ error: `The username “${out.username}” is already taken.` }, 400);
    const problem = passwordProblem(body.password);
    if (problem) return json({ error: problem }, 400);
    const d = roleDefaults(out.role);
    const user = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), active: true, perms: d.perms, buildings: d.buildings, ...out,
      pw: await hashPassword(body.password), epoch: 1, createdAt: new Date().toISOString(), createdBy: me.username, createdById: me.id,
    };
    all.push(user);
    await saveUsers(env, all);
    return json({ user: publicUser(user) });
  }
  const u = users.find((x) => x.id === id);
  if (!u) return json({ error: limited && all.some((x) => x.id === id) ? 'You can only manage people you added.' : 'That person no longer exists.' }, limited && all.some((x) => x.id === id) ? 403 : 404);
  if (limited && !withinReach(me, u)) return json({ error: `${u.name} has buildings or access you don’t. Ask an admin to change their account.` }, 403);
  if (req.method === 'DELETE') {
    if (u.id === me.id) return json({ error: 'You can’t delete your own account.' }, 400);
    await saveUsers(env, all.filter((x) => x.id !== id));
    return json({ ok: true });
  }
  if (req.method === 'PUT') {
    const { out, error } = cleanUserInput(body, u);
    if (error) return json({ error }, 400);
    if (limited) { const bad = limitForSupervisor(me, out, u); if (bad) return json({ error: bad }, 403); }
    if (out.username && out.username !== u.username && all.some((x) => x.username === out.username)) return json({ error: `The username “${out.username}” is already taken.` }, 400);
    if (u.id === me.id && (out.active === false || (out.perms && !out.perms.manage_users))) return json({ error: 'You can’t remove your own access to manage users or deactivate yourself.' }, 400);
    let signOut = out.active === false && u.active;
    if (body.password) {
      const problem = passwordProblem(body.password);
      if (problem) return json({ error: problem }, 400);
      u.pw = await hashPassword(body.password);
      signOut = true;
    }
    Object.assign(u, out, { updatedAt: new Date().toISOString() });
    if (signOut) u.epoch = (u.epoch || 1) + 1;
    await saveUsers(env, all);
    return json({ user: publicUser(u) });
  }
  return json({ error: 'Not supported' }, 405);
}

// What each person may see: their buildings, and fields they have permission for. Building names are compared
// loosely ("Old Gloucester Street 25" = "25 Old Gloucester Street"), so tidying a name never locks anyone out.
const bkey = (b) => tidyStreet(b).toLowerCase().replace(/[^a-z0-9]/g, '');
function allowBuildingFor(u) {
  if (!u || u.buildings === 'all' || u.buildings == null) return null;
  const set = new Set(u.buildings.map(bkey));
  return (b) => set.has(bkey(b));
}
const coversBuilding = (u, b) => !u || u.buildings === 'all' || u.buildings == null || (Array.isArray(u.buildings) && u.buildings.some((x) => bkey(x) === bkey(b)));
function shapeWeek(data, u) {
  if (!can(u, 'view_board')) data.board = [];
  if (!can(u, 'view_guests')) {
    for (const d of data.days) for (const x of d.units) { if (x.checkIn) x.checkIn.guests = null; if (x.checkOut) x.checkOut.guests = null; }
  }
  if (!can(u, 'view_linen')) { data.linen = []; data.totals.linenSets = null; for (const d of data.days) d.linen = {}; }
  // Supervisors and cleaners only see flats that need cleaning that day: check-outs and same-day turnovers.
  // Arrival-only flats were cleaned on an earlier day, so they're left out (and so is who's staying mid-week).
  if (u.role === 'supervisor' || u.role === 'cleaner') {
    let fresh = 0;
    for (const d of data.days) {
      d.units = d.units.filter((x) => x.checkOut);
      d.arrivals = d.turnovers;
      d.hasNew = d.units.some((x) => (x.checkIn && x.checkIn.isNew) || x.checkOut.isNew);
      fresh += d.units.filter((x) => x.checkIn && x.checkIn.isNew).length;
    }
    const empty = { occ: false, out: null, in: null };
    data.board = data.board.map((b) => ({ ...b, units: b.units
      .map((x) => ({ ...x, cells: x.cells.map((c) => (c.out ? { occ: Boolean(c.in), out: c.out, in: c.in } : empty)) }))
      .filter((x) => x.cells.some((c) => c.out)) })).filter((b) => b.units.length);
    data.totals.checkIns = data.totals.turnovers;
    data.totals.newBookings = fresh;
    data.cleansOnly = true;
  }
  if (u.buildings !== 'all') data.warnings = [];
  if (Array.isArray(u.buildings) && !u.buildings.length) data.warnings = ['No buildings are assigned to you yet. Ask an admin to add your buildings.'];
  return data;
}

// ---------------------------------------------------------------- Guesty client
// Guesty allows only 5 access tokens per 24 h, so the token is kept in KV and shared by every instance.
let memToken = null;
let tokenPromise = null; // one token request at a time, even when several Guesty calls start together
function getToken(env) {
  if (memToken && memToken.expires_at > Date.now() + 5 * 60e3) return Promise.resolve(memToken.access_token);
  if (!tokenPromise) tokenPromise = fetchToken(env).finally(() => { tokenPromise = null; });
  return tokenPromise;
}
async function fetchToken(env) {
  if (memToken && memToken.expires_at > Date.now() + 5 * 60e3) return memToken.access_token;
  const stored = await env.STORE.get('guesty_token', 'json');
  if (stored && stored.client_id === env.GUESTY_CLIENT_ID && stored.expires_at > Date.now() + 5 * 60e3) { memToken = stored; return stored.access_token; }
  // Guesty allows 5 tokens a day: keep one spare, so a burst of errors can't lock the schedule out for a day.
  const issued = ((await env.STORE.get('guesty_token_log', 'json')) || []).filter((t) => Date.now() - t < 864e5);
  if (issued.length >= 4) throw userError('The app has asked Guesty for access 4 times today, so it’s waiting before trying again. The schedule will refresh on its own.');
  let r;
  try {
    r = await fetch(`${GUESTY}/oauth2/token`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'open-api', client_id: env.GUESTY_CLIENT_ID, client_secret: env.GUESTY_CLIENT_SECRET }),
    });
  } catch (e) { throw userError('Guesty isn’t answering right now. The schedule will refresh on its own.'); }
  await env.STORE.put('guesty_token_log', JSON.stringify([...issued, Date.now()]));
  if (r.status === 429) throw userError('Guesty’s daily login limit has been reached (5 per day). The schedule will load again once it resets.');
  if (!r.ok) throw userError(`Guesty didn’t accept the API keys (error ${r.status}). Check GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET in Railway.`);
  const d = await r.json();
  memToken = { access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 86400) * 1000, client_id: env.GUESTY_CLIENT_ID };
  await env.STORE.put('guesty_token', JSON.stringify(memToken), { expirationTtl: Math.max(120, (d.expires_in || 86400) - 60) });
  console.log('[guesty] new access token issued');
  return memToken.access_token;
}
function userError(msg, status = 502) { const e = new Error(msg); e.userMessage = msg; e.status = status; return e; }

async function gapi(env, method, path, { params, body } = {}, attempt = 0) {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) : '';
  const token = await getToken(env);
  let r;
  try {
    r = await fetch(`${GUESTY}${path}${qs}`, {
      method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { console.log('[guesty]', e.name, path); throw userError('Guesty isn’t answering right now. Try again in a minute.'); }
  if (r.status === 401 && attempt === 0) { memToken = null; await env.STORE.delete('guesty_token'); return gapi(env, method, path, { params, body }, 1); }
  if (r.status === 429 && attempt < 3) { await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1))); return gapi(env, method, path, { params, body }, attempt + 1); }
  const text = await r.text();
  if (!r.ok) { console.log('[guesty]', r.status, path, text.slice(0, 300)); throw userError(`Guesty returned an error (${r.status}). Try Refresh in a minute.`); }
  try { return JSON.parse(text); } catch (_) { return text; }
}
async function paginate(env, path, params) {
  const out = [];
  for (let skip = 0; skip < 5000; skip += 100) {
    const d = await gapi(env, 'GET', path, { params: { ...params, limit: '100', skip: String(skip) } });
    const res = d.results || d.data || [];
    out.push(...res);
    if (res.length < 100) break;
  }
  return out;
}
const LISTING_FIELDS = '_id nickname title bedrooms address.full address.street address.zipcode address.lat address.lng active defaultCheckInTime defaultCheckOutTime tags';
const STAY_FIELDS = '_id listingId status confirmationCode checkInDateLocalized checkOutDateLocalized plannedArrival plannedDeparture guestsCount nightsCount createdAt';

async function fetchListings(env, cfg) {
  if (cfg.mock) return MOCK.listings();
  return paginate(env, '/v1/listings', { fields: LISTING_FIELDS, sort: '_id' });
}
async function fetchStays(env, cfg, from, to) {
  if (cfg.mock) return MOCK.stays(from, to, cfg.statuses);
  return paginate(env, '/v1/reservations', {
    fields: STAY_FIELDS,
    filters: [
      { field: 'checkInDateLocalized', operator: '$lte', value: to },
      { field: 'checkOutDateLocalized', operator: '$gte', value: from },
      { field: 'status', operator: '$in', value: cfg.statuses },
    ],
    sort: '_id',
  });
}

// ---------------------------------------------------------------- bookings snapshot (pre-loaded)
let memSnap = null; // { snap, readAt }

function slimListing(l) {
  return { _id: l._id, nickname: l.nickname, title: l.title, bedrooms: l.bedrooms, active: l.active, address: { full: l.address?.full, street: l.address?.street, zipcode: l.address?.zipcode }, defaultCheckInTime: l.defaultCheckInTime, defaultCheckOutTime: l.defaultCheckOutTime, tags: Array.isArray(l.tags) ? l.tags : [] };
}
function slimStay(r) {
  return { _id: r._id, listingId: r.listingId, status: r.status, confirmationCode: r.confirmationCode, checkInDateLocalized: r.checkInDateLocalized, checkOutDateLocalized: r.checkOutDateLocalized, plannedArrival: r.plannedArrival, plannedDeparture: r.plannedDeparture, guestsCount: r.guestsCount, nightsCount: r.nightsCount, createdAt: r.createdAt };
}

let refreshing = null; // one refresh at a time per instance; bursts of Guesty events share it
function refreshSnapshot(env, why = 'refresh') {
  if (!refreshing) refreshing = doRefresh(env, why).finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefresh(env, why) {
  const cfg = config(env);
  const thisWeek = weekStartFor(todayInLondon(), cfg.weekStartDay);
  const from = addDays(thisWeek, -WINDOW_BEFORE), to = addDays(thisWeek, WINDOW_AFTER);
  const [listings, stays] = await Promise.all([fetchListings(env, cfg), fetchStays(env, cfg, from, to)]);
  const body = { listings: listings.map(slimListing), stays: stays.map(slimStay).sort((a, b) => (a._id < b._id ? -1 : 1)) };
  const hash = fnv(JSON.stringify(body) + cfg.statuses.join());
  const snap = { at: Date.now(), from, to, hash, mock: cfg.mock, ...body };
  const prev = memSnap?.snap || (await env.STORE.get('snapshot', 'json'));
  // Only write when something changed, or to mark it fresh every 5 min (keeps KV writes low).
  if (!prev || prev.hash !== hash || prev.from !== from || why === 'cron') await env.STORE.put('snapshot', JSON.stringify(snap));
  memSnap = { snap, readAt: Date.now() };
  if (!prev || prev.hash !== hash) console.log(`[snapshot] ${why}: ${stays.length} stays, ${listings.length} listings, version ${hash}`);
  return snap;
}

async function getSnapshot(env, ctx) {
  if (memSnap && Date.now() - memSnap.readAt < MEM_TTL) return memSnap.snap;
  let snap = await env.STORE.get('snapshot', 'json');
  const cfg = config(env);
  const thisWeek = weekStartFor(todayInLondon(), cfg.weekStartDay);
  const covers = snap && snap.from <= addDays(thisWeek, -7) && snap.to >= addDays(thisWeek, 13) && snap.mock === cfg.mock;
  if (!snap || !covers) snap = await refreshSnapshot(env, 'first load');
  else {
    memSnap = { snap, readAt: Date.now() };
    // Safety net if the 5-minute schedule isn't running: refresh in the background, never make the viewer wait.
    if (Date.now() - snap.at > 10 * 60e3 && ctx) ctx.waitUntil(refreshSnapshot(env, 'stale').catch((e) => console.log('[snapshot] refresh failed', e.message)));
  }
  return snap;
}

// ---------------------------------------------------------------- building the week
const FLAT_PART = /^(flat|apt\.?|apartment|unit|fl-?|room|studio|\d+(st|nd|rd|th)\s+floor|ground floor|basement)\b[^,]*$/i;
// Guesty sometimes has the number after the street ("Old Gloucester Street 25"): put it first, like the rest.
function tidyStreet(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  const m = /^([^\d,]*[a-z][^\d,]*?) (\d+[a-z]?)$/i.exec(t);
  return m ? `${m[2]} ${m[1]}` : t;
}
const cleanStreet = (s) => tidyStreet((s || '').split(',').map((x) => x.trim()).filter((x) => x && !FLAT_PART.test(x))[0] || '');
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
const streetKey = (n) => n.replace(/^\d+[a-z]?\s+/i, '');
const byBuilding = (a, b) => natural(streetKey(a), streetKey(b)) || natural(a, b);
const typeOrder = (t) => (t === 'Studio' ? 0 : Number.isFinite(parseInt(t, 10)) ? parseInt(t, 10) : 99);

const coord = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// A flat's details can be changed in the app (Properties › Edit) on top of Guesty: { listingId: { label, building,
// address, postcode, unitType, checkInTime, checkOutTime, keyMode, hidden, at, by } }. Kept in memory for a few seconds.
const EDITABLE = ['label', 'building', 'address', 'postcode', 'unitType', 'checkInTime', 'checkOutTime', 'keyMode'];
let propOv = { at: 0, map: {}, ver: '' };
async function loadPropOverrides(env, fresh) {
  if (!fresh && Date.now() - propOv.at < MEM_TTL) return propOv.map;
  const map = (env.STORE && (await env.STORE.get('propertyOverrides', 'json'))) || {};
  propOv = { at: Date.now(), map, ver: Object.keys(map).length ? fnv(JSON.stringify(map)) : '' };
  return map;
}
// What the page compares to know the schedule changed: Guesty's bookings plus any details edited in the app.
const dataVersion = (snap) => snap.hash + (propOv.ver ? '.' + propOv.ver : '');
function listingMap(raw, cfg, allow, { all = false } = {}) {
  const map = new Map();
  for (const l of raw) {
    if (l.active === false) continue;
    const o = propOv.map[l._id] || {};
    const hiddenByEnv = cfg.hidden.includes(l._id) || cfg.hidden.includes(l.nickname);
    const hidden = o.hidden === true || (hiddenByEnv && o.hidden !== false);
    if (hidden && !all) continue;
    const ov = (m) => m[l._id] || (l.nickname && m[l.nickname]);
    const b = l.bedrooms;
    // Guesty tags decide how the key is returned after a cleaning.
    const tags = (Array.isArray(l.tags) ? l.tags : []).map((t) => String(t).trim().toUpperCase().replace(/[\s_-]+/g, ''));
    const a = l.address || {};
    const n = l.nickname || l.title || 'Unit';
    const guesty = {
      label: n.includes(',') ? n.split(',')[0].trim() : n,
      building: ov(cfg.buildingOverrides) || cleanStreet(a.street) || cleanStreet(a.full) || n,
      address: a.full || '',
      postcode: a.zipcode || ((a.full || '').match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i) || [''])[0].toUpperCase(),
      unitType: ov(cfg.typeOverrides) || (b === 0 ? 'Studio' : typeof b === 'number' && b > 0 ? `${b} Bedroom` : 'Unknown'),
      keyMode: tags.includes('KEYNEST') ? 'keynest' : tags.includes('LOCKBOX') ? 'lockbox' : null,
      checkInTime: l.defaultCheckInTime || cfg.defaultIn, checkOutTime: l.defaultCheckOutTime || cfg.defaultOut,
    };
    const v = { ...guesty };
    for (const k of EDITABLE) if (o[k] !== undefined && o[k] !== '') v[k] = o[k] === 'none' ? null : o[k];
    if (v.building && o.building === undefined) v.building = tidyStreet(v.building);
    if (allow && !allow(v.building)) continue;
    const moved = Boolean(o.address || o.postcode); // Guesty's map position is for Guesty's address
    map.set(l._id, {
      id: l._id, name: o.label || o.building ? `${v.label}, ${v.building}` : n, ...v,
      lat: moved ? null : coord(a.lat), lng: moved ? null : coord(a.lng),
      hidden, hiddenByEnv, guesty, lockboxNoCode: o.lockboxNoCode === true, // lockbox flats where cleaners don't set a new code…
      keyInstruction: o.lockboxNoCode === true ? o.keyInstruction || '' : '', // …and, optionally, what they do with the key instead
      edited: EDITABLE.some((k) => o[k] !== undefined) || o.hidden !== undefined || o.lockboxNoCode !== undefined, editedAt: o.at || null, editedBy: o.by || null,
    });
  }
  return map;
}

const UNIT_TYPES = ['Studio', '1 Bedroom', '2 Bedroom', '3 Bedroom', '4 Bedroom', '5 Bedroom'];
// Admins, Users and supervisors edit flats' details; cleaners only change lockbox codes (lockboxCodeApi).
const editsProps = (u) => can(u, 'edit_properties');
async function propertyEditApi(req, env, ctx, me, id) {
  if (!editsProps(me)) return json({ error: 'You don’t have permission to edit properties. Ask an admin.' }, 403);
  const snap = await getSnapshot(env, ctx);
  await loadPropOverrides(env, true);
  const l = listingMap(snap.listings, config(env), null, { all: true }).get(id);
  if (!l || !inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, l ? 403 : 404);
  const body = await req.json().catch(() => ({}));
  if (body.confirmed !== true) return json({ error: 'Review the changes and confirm them first.' }, 400);
  const all = (await env.STORE.get('propertyOverrides', 'json')) || {};
  let cur = { ...(all[id] || {}) };
  if (body.reset === true) cur = {};
  else {
    const f = body.fields || {}, bad = (msg) => { throw userError(msg, 400); };
    const text = (k, max, label) => { if (f[k] === undefined) return; const v = String(f[k] ?? '').trim().replace(/\s+/g, ' '); if (v.length > max) bad(`${label} is too long (${max} characters at most).`); cur[k] = v; };
    text('label', 40, 'The flat’s name'); text('building', 80, 'The building'); text('address', 200, 'The address');
    if (f.postcode !== undefined) {
      const v = String(f.postcode || '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (v && !/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/.test(v)) bad('That doesn’t look like a UK postcode.');
      cur.postcode = v;
    }
    if (f.unitType !== undefined) { if (f.unitType && !UNIT_TYPES.includes(f.unitType)) bad('Pick the number of bedrooms from the list.'); cur.unitType = f.unitType || ''; }
    for (const k of ['checkInTime', 'checkOutTime']) if (f[k] !== undefined) { const v = String(f[k] || ''); if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) bad('Times look like 15:00.'); cur[k] = v; }
    if (f.keyMode !== undefined) { if (!['', 'keynest', 'lockbox', 'none'].includes(f.keyMode)) bad('Pick how the key is returned from the list.'); cur.keyMode = f.keyMode; }
    if (f.hidden !== undefined) cur.hidden = f.hidden === true;
    if (f.lockboxNoCode !== undefined) cur.lockboxNoCode = f.lockboxNoCode === true;
    text('keyInstruction', 300, 'The key instruction');
    if (cur.building && !coversBuilding(me, cur.building)) return json({ error: 'You can only move flats into buildings you look after.' }, 403);
    // Blank means "use Guesty's"; a value the same as Guesty's isn't a change either.
    for (const k of EDITABLE) if (cur[k] === '' || cur[k] === (l.guesty[k] === null ? 'none' : l.guesty[k])) delete cur[k];
    if (cur.hidden === (l.hiddenByEnv ? true : false)) delete cur.hidden;
    if (!cur.lockboxNoCode) { delete cur.lockboxNoCode; delete cur.keyInstruction; }
    if (!cur.keyInstruction) delete cur.keyInstruction;
  }
  delete cur.at; delete cur.by;
  if (Object.keys(cur).length) all[id] = { ...cur, at: nowIso(), by: me.name }; else delete all[id];
  await env.STORE.put('propertyOverrides', JSON.stringify(all));
  await loadPropOverrides(env, true);
  console.log(`[properties] ${me.name} ${body.reset ? 'reset' : 'edited'} ${l.label} (${Object.keys(cur).join(', ') || 'back to Guesty'})`);
  return json({ ok: true });
}

function buildWeek(start, rawListings, stays, cfg, meta, allow) {
  const listings = listingMap(rawListings, cfg, allow);
  const end = addDays(start, 6);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const isNew = (r) => Boolean(r.createdAt) && Date.now() - new Date(r.createdAt).getTime() < cfg.newHours * 3600e3;
  const ev = (r, l, kind) => {
    const planned = kind === 'in' ? r.plannedArrival : r.plannedDeparture;
    const t = planned || (kind === 'in' ? l.checkInTime : l.checkOutTime);
    return { code: r.confirmationCode || '', time: fmtTime(t), timeRaw: t, planned: Boolean(planned), guests: r.guestsCount || null, nights: r.nightsCount || null, isNew: isNew(r) };
  };

  const grid = new Map();
  const cell = (id, d) => {
    if (!grid.has(id)) grid.set(id, Object.fromEntries(dates.map((x) => [x, { occ: false, out: null, in: null }])));
    return grid.get(id)[d];
  };
  let hiddenBookings = 0;
  for (const r of stays) {
    const ci = r.checkInDateLocalized, co = r.checkOutDateLocalized;
    if (!(ci <= end && co >= start) || !cfg.statuses.includes(r.status)) continue;
    const l = listings.get(r.listingId);
    if (!l) { if (!allow) hiddenBookings++; continue; }
    for (const d of dates) if (d >= ci && d < co) cell(r.listingId, d).occ = true;
    if (ci >= start && ci <= end) cell(r.listingId, ci).in = ev(r, l, 'in');
    if (co >= start && co <= end) cell(r.listingId, co).out = ev(r, l, 'out');
  }

  const linen = {};
  let checkOuts = 0, checkIns = 0, turnovers = 0, newBookings = 0;
  const days = dates.map((date) => {
    const units = [], dayLinen = {};
    for (const [id, cells] of grid) {
      const c = cells[date];
      if (!c.out && !c.in) continue;
      const l = listings.get(id);
      units.push({ listingId: id, name: l.name, label: l.label, building: l.building, postcode: l.postcode, address: l.address, unitType: l.unitType, keyMode: l.keyMode, checkOut: c.out, checkIn: c.in });
      if (c.out) { checkOuts++; linen[l.unitType] = (linen[l.unitType] || 0) + 1; dayLinen[l.unitType] = (dayLinen[l.unitType] || 0) + 1; }
      if (c.in) { checkIns++; if (c.in.isNew) newBookings++; }
      if (c.in && c.out) turnovers++;
    }
    units.sort((a, b) => byBuilding(a.building, b.building) || natural(a.label, b.label));
    return {
      date, units, linen: dayLinen,
      cleans: units.filter((u) => u.checkOut).length,
      arrivals: units.filter((u) => u.checkIn).length,
      turnovers: units.filter((u) => u.checkIn && u.checkOut).length,
      hasNew: units.some((u) => (u.checkIn && u.checkIn.isNew) || (u.checkOut && u.checkOut.isNew)),
    };
  });

  const buildings = new Map();
  for (const l of listings.values()) {
    if (!buildings.has(l.building)) buildings.set(l.building, { name: l.building, postcode: l.postcode, units: [] });
    const cells = grid.get(l.id) || {};
    buildings.get(l.building).units.push({ listingId: l.id, label: l.label, name: l.name, unitType: l.unitType, cells: dates.map((d) => cells[d] || { occ: false, out: null, in: null }) });
  }
  const board = [...buildings.values()].sort((a, b) => byBuilding(a.name, b.name));
  for (const b of board) b.units.sort((x, y) => natural(x.label, y.label));

  const linenRows = ['2 Bedroom', '1 Bedroom', 'Studio', ...Object.keys(linen)]
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .map((type) => ({ type, sets: linen[type] || 0 }))
    .sort((a, b) => typeOrder(b.type) - typeOrder(a.type));

  return {
    weekStart: start, weekEnd: end, dates,
    prevWeek: addDays(start, -7), nextWeek: addDays(start, 7),
    today: todayInLondon(), generatedAt: new Date(meta.at).toISOString(),
    version: meta.version, mock: cfg.mock, statuses: cfg.statuses,
    totals: { checkOuts, checkIns, turnovers, linenSets: checkOuts, newBookings },
    linen: linenRows, days, board,
    warnings: [
      ...[...listings.values()].filter((l) => l.unitType === 'Unknown').map((l) => `“${l.name}” has no bedroom count in Guesty, so its linen is counted as “Unknown”.`),
      ...(hiddenBookings ? [`${hiddenBookings} booking(s) belong to inactive or hidden listings and are not shown.`] : []),
    ],
  };
}

async function weekData(env, ctx, dateParam, fresh, user) {
  return shapeWeek(await weekDataRaw(env, ctx, dateParam, fresh, allowBuildingFor(user), user), user);
}
async function weekDataRaw(env, ctx, dateParam, fresh, allow, user) {
  const cfg = config(env);
  const start = weekStartFor(dateParam, cfg.weekStartDay);
  const end = addDays(start, 6);
  let snap = fresh ? await refreshSnapshot(env, 'manual refresh') : await getSnapshot(env, ctx);
  if (start >= snap.from && end <= snap.to) return buildWeek(start, snap.listings, snap.stays, cfg, { at: snap.at, version: dataVersion(snap) }, allow);
  // Outside the pre-loaded window (far past / far future): ask Guesty directly and cache at the edge.
  const cache = caches.default;
  const scope = allow ? fnv(JSON.stringify(user.buildings)) : 'all';
  const key = new Request(`https://cache.local/week/${start}/${dataVersion(snap)}/${scope}`);
  const hit = !fresh && (await cache.match(key));
  if (hit) return hit.json();
  const stays = (await fetchStays(env, cfg, start, end)).map(slimStay);
  const data = buildWeek(start, snap.listings, stays, cfg, { at: Date.now(), version: dataVersion(snap) }, allow);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { 'Cache-Control': 'max-age=600' } })));
  return data;
}

async function propertiesData(env, ctx, user) {
  const cfg = config(env);
  const snap = await getSnapshot(env, ctx);
  const manage = can(user, 'manage_settings'), edit = editsProps(user);
  const every = listingMap(snap.listings, cfg, allowBuildingFor(user), { all: edit });
  const listings = new Map([...every].filter(([, l]) => !l.hidden));
  const codes = can(user, 'view_cleaning') ? ((await env.STORE.get('lockboxCodes', 'json')) || {}) : {};
  const groups = new Map();
  for (const l of every.values()) {
    if (!groups.has(l.building)) groups.set(l.building, { name: l.building, postcode: l.postcode, units: [] });
    groups.get(l.building).units.push({ id: l.id, name: l.name, label: l.label, address: l.address, unitType: l.unitType, checkIn: fmtTime(l.checkInTime), checkOut: fmtTime(l.checkOutTime), keyMode: l.keyMode, lockbox: codes[l.id] || null,
      hidden: l.hidden, edited: l.edited, lockboxNoCode: l.keyMode === 'lockbox' && l.lockboxNoCode, keyInstruction: l.keyMode === 'lockbox' ? l.keyInstruction : '',
      ...(edit ? { postcode: l.postcode, checkInTime: l.checkInTime, checkOutTime: l.checkOutTime, building: l.building, guesty: l.guesty, hiddenByEnv: l.hiddenByEnv, editedAt: l.editedAt, editedBy: l.editedBy } : {}) });
  }
  const buildings = [...groups.values()].sort((a, b) => byBuilding(a.name, b.name));
  for (const b of buildings) b.units.sort((x, y) => natural(x.label, y.label));
  const counts = {};
  for (const l of listings.values()) counts[l.unitType] = (counts[l.unitType] || 0) + 1;
  return { buildings, total: listings.size, counts, mock: cfg.mock, keynest: await keynestStatus(env, listings), canManage: manage, canEdit: edit, canEditCode: can(user, 'view_cleaning') && can(user, 'edit_lockbox'), unitTypes: UNIT_TYPES };
}

// ---------------------------------------------------------------- Guesty webhook (instant updates)
async function webhookUrl(env, origin) {
  const base = (env.PUBLIC_URL || origin || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/webhooks/guesty/${(await hmac(await secretKey(env), 'webhook')).slice(0, 32)}`;
}
async function ensureWebhook(env, origin) {
  const cfg = config(env);
  if (cfg.mock) return 'preview';
  const url = await webhookUrl(env, origin);
  if (!url) return 'no address yet';
  if ((await env.STORE.get('webhook_url')) === url) return 'registered';
  const existing = await gapi(env, 'GET', '/v1/webhooks').catch(() => []);
  const list = Array.isArray(existing) ? existing : existing.results || existing.data || [];
  // Remove older Cityscape Schedule subscriptions (e.g. a previous address) so Guesty only calls this one.
  for (const w of list) {
    if ((w.url || '').includes('/webhooks/guesty/') && w.url !== url) {
      await gapi(env, 'DELETE', `/v1/webhooks/${w._id || w.id}`).catch(() => {});
    }
  }
  if (!list.some((w) => w.url === url)) {
    await gapi(env, 'POST', '/v1/webhooks', { body: { url, events: ['reservation.created.v2', 'reservation.updated.v2'] } });
  }
  await env.STORE.put('webhook_url', url);
  if (origin) await env.STORE.put('origin', origin);
  console.log('[webhook] registered', url.replace(/[a-f0-9]{32}$/, '…'));
  return 'registered';
}

// ---------------------------------------------------------------- cleanings & damage reports
// Stored alongside everything else (Railway volume). Media files themselves are handled by server.mjs;
// here we only keep their ids and check they were uploaded.
const CHECKLIST = [
  { key: 'bins', title: 'Bins', text: 'Have you emptied and changed all the bins?' },
  { key: 'fridge', title: 'Fridge', text: 'Have you checked the fridge is completely empty?' },
  { key: 'oven', title: 'Oven', text: 'Have you checked the oven is empty and clean?' },
  { key: 'microwave', title: 'Microwave', text: 'Have you checked the microwave is empty and clean?' },
  { key: 'hairs', title: 'Shower & toilet', text: 'Have you checked there are no hairs in the shower or around the toilet?' },
];
const HOLD_MS = 3000; // hold time for the final "all checks done" button
const nowIso = () => new Date().toISOString();
const londonDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(iso ? new Date(iso) : new Date());
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

async function loadList(env, key) { return (await env.STORE.get(key, 'json')) || []; }
// One change at a time per list. Everything is saved in one shared data file; a change that reads a list, waits for
// something (KeyNest, a password check…) and then saves it could otherwise undo a change saved in between.
// The app runs as one process on Railway, so an in-memory queue per list is enough.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}
async function saveList(env, key, list) { await env.STORE.put(key, JSON.stringify(list)); }

async function listingInfo(env, ctx, listingId) {
  const snap = await getSnapshot(env, ctx);
  return listingMap(snap.listings, config(env)).get(listingId) || null;
}
// Changing a flat's lockbox code by hand (from Properties): anyone who can see codes, cleaners included, in their buildings.
async function lockboxCodeApi(req, env, ctx, me, id) {
  const l = await listingInfo(env, ctx, id);
  if (!l || !inScope(me, l.building) || !can(me, 'edit_lockbox')) return json({ error: 'You don’t have permission for that. Ask an admin.' }, 403);
  if (l.keyMode !== 'lockbox' || l.lockboxNoCode) return json({ error: `${l.label} doesn’t use a lockbox code.` }, 400);
  const body = await req.json().catch(() => ({}));
  const code = String(body.code || '').trim();
  if (!/^\d{4}$/.test(code)) return json({ error: 'The lockbox code is exactly 4 numbers.' }, 400);
  const codes = (await env.STORE.get('lockboxCodes', 'json')) || {};
  codes[l.id] = { code, at: nowIso(), by: me.name, byId: me.id, edited: true };
  await env.STORE.put('lockboxCodes', JSON.stringify(codes));
  console.log(`[lockbox] ${me.name} changed ${l.label}'s code`); // never the code itself
  return json({ ok: true, lockbox: codes[l.id] });
}
function inScope(u, building) {
  const allow = allowBuildingFor(u);
  return !allow || allow(building);
}
async function mediaReady(env, ids, kindWanted, accept) {
  const out = [];
  for (const id of ids || []) {
    const m = await env.STORE.get('media:' + id, 'json');
    if (!m || !m.uploaded) continue;
    if (kindWanted && m.kind !== kindWanted) continue;
    if (accept && !accept(m)) continue;
    out.push(m);
  }
  return out;
}
function publicMedia(m) {
  const i = m.info || {};
  return {
    id: m.id, kind: m.kind, status: m.status, name: m.name, size: m.size, duration: m.duration || null, createdAt: m.createdAt, by: m.byName,
    // What was actually uploaded, and whether the untouched original can still be opened at /media/:id/orig.
    width: i.width || null, height: i.height || null, fps: i.fps || null, codec: i.codec || null, hdr: Boolean(i.hdr), hasOrig: Boolean(m.hasOrig),
  };
}
async function withMedia(env, rec) {
  const media = [];
  for (const id of rec.media || []) { const m = await env.STORE.get('media:' + id, 'json'); if (m) media.push(publicMedia(m)); }
  return { ...rec, media };
}

// Mark the flat clean in Guesty. Never blocks the cleaner: failures are recorded and shown to admins.
async function markCleanInGuesty(env, listingId) {
  if (config(env).mock) return 'preview';
  if (env.GUESTY_MARK_CLEAN === '0') return 'off';
  try {
    await gapi(env, 'PUT', `/v1/listings/${listingId}`, { body: { cleaningStatus: { value: 'clean' } } });
    const l = await gapi(env, 'GET', `/v1/listings/${listingId}`, { params: { fields: 'cleaningStatus' } });
    const v = l && l.cleaningStatus && (l.cleaningStatus.value || l.cleaningStatus);
    console.log('[guesty] cleaning status now', JSON.stringify(v));
    return v === 'clean' ? 'updated' : 'sent';
  } catch (e) {
    console.log('[guesty] mark clean failed', e.message);
    return 'failed';
  }
}

// ---------------------------------------------------------------- KeyNest
// Flats tagged KEYNEST in Guesty can only be completed once KeyNest reports the key back in a store.
// Needs KEYNEST_API_KEY in Railway. Each flat is linked to a KeyNest key in Settings › Integrations › KeyNest
// (or matched automatically when the KeyNest key name equals the flat's Guesty nickname).
const KEYNEST_DEFAULT = 'https://api.keynest.com/api/v3';
const KEYNEST_IN = /^(in store|in locker|in office)/i;
let knCache = null; // { at, keys }
async function keynestGet(env, path, { base, body } = {}) {
  if (!env.KEYNEST_API_KEY) throw userError('KeyNest isn’t connected yet. An admin needs to add KEYNEST_API_KEY in Railway.', 400);
  let r;
  try {
    r = await fetch((base || env.KEYNEST_API_URL || KEYNEST_DEFAULT) + path, {
      method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
      headers: { ApiKey: env.KEYNEST_API_KEY, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch (e) {
    console.log('[keynest]', path.split('/')[1], e.name, e.message);
    throw userError(e.name === 'TimeoutError' ? 'KeyNest took too long to answer. Try again in a minute.' : 'KeyNest isn’t answering right now. Try again in a minute.', 502);
  }
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!r.ok || !j || (j.Status && j.Status !== 'Success')) {
    console.log('[keynest]', path.split('/')[1], r.status, (j && j.ResponseMessage) || text.slice(0, 200));
    throw userError(r.status === 401 || r.status === 403 ? 'KeyNest didn’t accept the API key. Check KEYNEST_API_KEY in Railway.' : `KeyNest didn’t answer properly (error ${r.status}). Try again in a minute.`, 502);
  }
  return j;
}
const knKey = (k) => ({ id: k.KeyId, name: k.KeyName || '', status: k.StatusType || k.CurrentStatus || '', lastMovement: k.LastMovement || null, postcode: k.PropertyPostcode || '', address: k.Address || '' });
let knFail = null; // { at, err }: KeyNest just failed, so don't keep every page waiting on it for the next minute
async function keynestKeys(env, fresh) {
  if (!fresh && knCache && Date.now() - knCache.at < 60e3) return knCache.keys;
  if (!fresh && knFail && Date.now() - knFail.at < 60e3) throw knFail.err;
  let j;
  try { j = await keynestGet(env, '/Keys'); } catch (e) { knFail = { at: Date.now(), err: e }; throw e; }
  knFail = null;
  const keys = ((j.ResponsePacket && j.ResponsePacket.KeyList) || []).map(knKey);
  knCache = { at: Date.now(), keys };
  return keys;
}
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function keynestLink(env, l) {
  const links = (await env.STORE.get('keynestLinks', 'json')) || {};
  if (links[l.id]) return { keyId: links[l.id], how: 'linked' };
  if (!env.KEYNEST_API_KEY) return null;
  const want = new Set([normName(l.name), normName(l.label + l.building)]);
  const m = (await keynestKeys(env)).filter((k) => want.has(normName(k.name)));
  return m.length === 1 ? { keyId: m[0].id, how: 'auto' } : null;
}
// The key only has to be back in KeyNest. It needn't have moved during the cleaning: cleaners sometimes use a spare
// key and never touch the one in KeyNest.
async function keynestCheck(env, keyId) {
  const j = await keynestGet(env, '/Keys/' + encodeURIComponent(keyId));
  const p = j.ResponsePacket || {};
  const k = knKey((p.KeyList && p.KeyList[0]) || p);
  return { ok: KEYNEST_IN.test(k.status), status: k.status || 'Unknown', lastMovement: k.lastMovement, keyName: k.name };
}

// ---- KeyNest stores: a cleaner who still has the key sees the nearest KeyNest to the flat and the nearest one open
// 24 hours, with directions. The store list (addresses, map positions, opening hours) is loaded twice a day.
let knStores = null, knStoresFail = null; // { at, stores } / { at, err }
function knStore(s) {
  const num = (...v) => { for (const x of v) if (x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x))) return Number(x); return NaN; };
  // Opening times: DayOfWeek 0 = Monday … 6 = Sunday (or a day name); minutes from midnight (1439.98 = until
  // midnight) or "HH:MM". A closing time of 00:00 means midnight.
  const dayOf = (v) => (typeof v === 'string' && /^[a-z]/i.test(v) ? ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(v.slice(0, 3).toLowerCase()) : num(v));
  const minOf = (v) => { const m = /^(\d{1,2}):(\d\d)/.exec(String(v ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : Math.round(num(v)); };
  const times = s.StoreOpeningTimingsDetails || s.OpeningTimingsDetails || s.OpeningTimes || s.OpeningHours || [];
  let hours = (Array.isArray(times) ? times : []).map((t) => {
    const from = minOf(t.StartMinuteOfDay ?? t.startMinuteOfDay ?? t.StartTime ?? t.OpenTime ?? t.Open);
    let to = minOf(t.EndMinuteOfDay ?? t.endMinuteOfDay ?? t.EndTime ?? t.CloseTime ?? t.Close);
    if (to === 0 && from > 0) to = 1440;
    return { day: dayOf(t.DayOfWeek ?? t.dayOfWeek ?? t.Day), from, to };
  }).filter((h) => h.day >= 0 && h.day <= 6 && h.from >= 0 && h.to > h.from);
  const time = String(s.StoreTime || s.Storetime || '').trim();
  // No usable times: read KeyNest's own summary when it's "Every day:08:00 - 00:00".
  const every = /^every ?day\s*:?\s*(\d{1,2}:\d\d)\s*[-–]\s*(\d{1,2}:\d\d)/i.exec(time);
  if (!hours.length && every) {
    const from = minOf(every[1]), to = minOf(every[2]) || 1440;
    if (to > from) hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from, to }));
  }
  const allDay = [0, 1, 2, 3, 4, 5, 6].every((d) => hours.some((h) => h.day === d && h.from <= 0 && h.to >= 1439));
  return {
    id: String(s.StoreId ?? s.Id ?? s.LocationCode ?? ''), name: String(s.StoreName || s.Name || '').trim(),
    address: String(s.StoreStreetAddress || s.Address || s.StreetAddress || '').trim(),
    lat: num(s.Latitude, s.latitude, s.Lat), lng: num(s.Longtiude, s.Longitude, s.longitude, s.Lng), // "Longtiude" is KeyNest's spelling
    time, hours, is24: allDay || /open 24 hours|24\s*\/\s*7|\b24 ?hrs?\b/i.test(time),
  };
}
async function keynestStores(env) {
  if (knStores && Date.now() - knStores.at < 12 * 3600e3) return knStores.stores;
  if (knStoresFail && Date.now() - knStoresFail.at < 5 * 60e3) throw knStoresFail.err;
  const list = (j) => (Array.isArray(j) ? j : Object.values((j && j.ResponsePacket) || j || {}).find(Array.isArray) || []);
  let raw = [];
  try { raw = list(await keynestGet(env, '/KeyNests')); } catch (e) { console.log('[keynest] store list (v3) failed:', e.message); }
  if (!raw.length) { // the older API's version of the same list
    const v2 = (env.KEYNEST_API_URL || KEYNEST_DEFAULT).replace(/\/v3\/?$/, '/v2');
    try { raw = list(await keynestGet(env, '/KeyStore/StoreListByCountry', { base: v2, body: { Country: 'United Kingdom' } })); } catch (e) { console.log('[keynest] store list (v2) failed:', e.message); }
  }
  const stores = raw.map(knStore).filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lng) && (x.lat || x.lng));
  const timed = raw.find((r) => Array.isArray(r.StoreOpeningTimingsDetails) && r.StoreOpeningTimingsDetails.length);
  console.log('[keynest] stores:', stores.length, 'usable of', raw.length, '·', stores.filter((x) => x.is24).length, 'open 24 hours ·', stores.filter((x) => x.hours.length).length, 'with opening times · fields:', Object.keys(raw[0] || {}).join(','),
    '· times look like:', timed ? JSON.stringify(timed.StoreOpeningTimingsDetails[0]).slice(0, 200) : 'none', '· e.g.', JSON.stringify(raw[0] && raw[0].StoreTime));
  if (!stores.length) { const err = userError('Couldn’t load the KeyNest store list. Try again in a minute.'); knStoresFail = { at: Date.now(), err }; throw err; }
  knStores = { at: Date.now(), stores }; knStoresFail = null;
  return stores;
}
// Where a flat is: its Guesty map position, or else its postcode's centre from postcodes.io (free, UK only).
const postcodeGeo = new Map();
async function flatLatLng(l) {
  if (l.lat !== null && l.lng !== null && (l.lat || l.lng)) return { lat: l.lat, lng: l.lng };
  const pc = String(l.postcode || '').replace(/\s+/g, '').toUpperCase();
  if (!pc) return null;
  if (postcodeGeo.has(pc)) return postcodeGeo.get(pc);
  try {
    const j = await (await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`, { signal: AbortSignal.timeout(5000) })).json();
    const g = j && j.result && Number.isFinite(j.result.latitude) ? { lat: j.result.latitude, lng: j.result.longitude } : null;
    if (g) postcodeGeo.set(pc, g);
    return g;
  } catch (_) { return null; }
}
// The store this key is dropped off at most (from the webhook record, the last 120 days): needs at least 2 drop-offs.
function mostUsedStore(moves) {
  const drops = (moves || []).filter((m) => m.event === 'DROPPED' && (m.storeId || m.store));
  const by = new Map();
  for (const m of drops) {
    const k = m.storeId ? 'id:' + m.storeId : 'name:' + normName(m.store);
    const e = by.get(k) || { storeId: m.storeId || '', name: m.store || '', count: 0, last: '' };
    e.count += 1; if (m.at > e.last) { e.last = m.at; e.name = m.store || e.name; }
    by.set(k, e);
  }
  const top = [...by.values()].sort((x, y) => y.count - x.count || y.last.localeCompare(x.last))[0];
  return top && top.count >= 2 ? { ...top, total: drops.length } : null;
}
// Walking time from the straight-line distance: streets add about a quarter, at 3 mph.
const walkMinutes = (miles) => Math.max(1, Math.round(((miles * 1.25) / 3) * 60));
const milesBetween = (a, b) => {
  const r = (d) => (d * Math.PI) / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
};
function londonNow() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (k) => p.find((x) => x.type === k).value;
  return { day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(g('weekday')), min: Number(g('hour')) * 60 + Number(g('minute')) };
}
function storeToday(st, now) {
  const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  if (st.is24) return { today: 'Open 24 hours', openNow: true };
  if (!st.hours.length) return { today: st.time, openNow: null };
  const t = st.hours.filter((h) => h.day === now.day).sort((x, y) => x.from - y.from);
  if (!t.length) return { today: 'Closed today', openNow: false };
  return { today: 'Today ' + t.map((h) => `${hhmm(h.from)}–${h.to >= 1439 ? 'midnight' : hhmm(h.to)}`).join(', '), openNow: t.some((h) => h.from <= now.min && now.min < h.to) };
}

// KeyNest webhook: every key movement (COLLECTED, DROPPED, HANDOVER…) is kept as a record, shown in each cleaning's details.
// It doesn't decide anything: completing only needs the key to be in the store.
const webhookKeyFor = async (env, name) => (await hmac(await secretKey(env), name)).slice(0, 32);
const KN_KEEP_DAYS = 120;
const londonOffsetMs = (t) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
  const g = (k) => Number(p.find((x) => x.type === k).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(t / 60e3) * 60e3;
};
// KeyNest times have no time zone ("2026-09-27T16:08:19.89" or "27/09/2026 16:08:19"). Read them as London time or
// UTC, whichever is nearer to when the message arrived; if the time can't be read, use the arrival time.
function knTime(s, received) {
  s = String(s || '');
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s) && Date.parse(s)) return Date.parse(s);
  const iso = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(s), uk = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)(?::(\d\d))?/.exec(s);
  const utc = iso ? Date.UTC(+iso[1], iso[2] - 1, +iso[3], +iso[4], +iso[5], +(iso[6] || 0))
    : uk ? Date.UTC(+uk[3], uk[2] - 1, +uk[1], +uk[4], +uk[5], +(uk[6] || 0)) : NaN;
  if (!Number.isFinite(utc)) return received;
  const london = utc - londonOffsetMs(utc);
  return Math.abs(london - received) < Math.abs(utc - received) ? london : utc;
}
async function keynestRecord(env, b) {
  const now = Date.now();
  const event = String(b.EventName || '').toUpperCase().replace(/[^A-Z_]/g, '').slice(0, 30);
  await env.STORE.put('keynestHook', JSON.stringify({ at: new Date(now).toISOString(), event: event || null })); // shown in Settings
  if (!event || !b.KeyId) return;
  const s = (v) => String(v ?? '').trim().slice(0, 120);
  const holder = (st) => (/^In Use\s*\((.+)\)$/i.exec(s(st)) || [])[1] || '';
  // Who: the person now holding the key; for a drop-off, the person who had it.
  const who = event === 'DROPPED' ? holder(b.PreviousStatus) : s(b.CurrentUserName) || holder(b.CurrentStatus);
  const move = { event, at: new Date(knTime(b.WhenHappened, now)).toISOString(), who, store: s(b.StoreName), storeId: s(b.StoreId), status: s(b.CurrentStatus) };
  const id = s(b.KeyId);
  const moves = (await env.STORE.get('keynestMoves', 'json')) || {};
  moves[id] = [...(moves[id] || []).filter((m) => now - Date.parse(m.at) < KN_KEEP_DAYS * 864e5), move]
    .sort((x, y) => x.at.localeCompare(y.at)).slice(-100);
  await env.STORE.put('keynestMoves', JSON.stringify(moves));
  console.log('[keynest]', event.toLowerCase(), s(b.KeyName) || id);
}
// The KeyNest movements of this flat's key from 6 hours before the cleaning started to 3 hours after it finished.
async function keyMovesFor(env, ctx, rec) {
  if (rec.keyMode !== 'keynest') return null;
  let keyId = rec.key && rec.key.keyId;
  if (!keyId) { try { const l = await listingInfo(env, ctx, rec.listingId); keyId = l && (await keynestLink(env, l) || {}).keyId; } catch (_) { /* KeyNest down: no record */ } }
  if (!keyId) return [];
  const from = Date.parse(rec.startedAt) - 6 * 3600e3, to = Date.parse(rec.completedAt || rec.cancelledAt || nowIso()) + 3 * 3600e3;
  return (((await env.STORE.get('keynestMoves', 'json')) || {})[keyId] || []).filter((m) => { const t = Date.parse(m.at); return t >= from && t <= to; });
}

// Admin and User roles run the operation: settings & integrations, assigning cleanings. Supervisors and cleaners don't.
const isManager = (u) => Boolean(u && (u.role === 'admin' || u.role === 'user'));

// Which KeyNest-tagged flats have no KeyNest key linked (so cleaners can't complete them). Shown on the Properties page.
async function keynestStatus(env, listings) {
  const flats = [...listings.values()].filter((l) => l.keyMode === 'keynest');
  const out = { connected: Boolean(env.KEYNEST_API_KEY), flats: flats.length, unlinked: [] };
  if (!flats.length) return out;
  const links = (await env.STORE.get('keynestLinks', 'json')) || {};
  let keys = null; // fetched once (cached), and a slow or failing KeyNest never holds up the page
  if (out.connected && flats.some((l) => !links[l.id])) { try { keys = await keynestKeys(env); } catch (_) { keys = null; } }
  for (const l of flats) {
    const want = new Set([normName(l.name), normName(l.label + l.building)]);
    const linked = links[l.id] || (out.connected && keys && keys.filter((k) => want.has(normName(k.name))).length === 1);
    if (!linked) out.unlinked.push({ id: l.id, label: l.label, building: l.building });
  }
  return out;
}

async function keynestAdminApi(req, env, ctx, me, parts) {
  if (!can(me, 'manage_settings')) return json({ error: 'You don’t have permission to change Settings. Ask an admin.' }, 403);
  const links = (await env.STORE.get('keynestLinks', 'json')) || {};
  if (req.method === 'GET') {
    const base = (env.PUBLIC_URL || '').replace(/\/$/, '');
    const snap = await getSnapshot(env, ctx);
    const flats = [...listingMap(snap.listings, config(env), allowBuildingFor(me)).values()].filter((l) => l.keyMode === 'keynest');
    const out = { connected: Boolean(env.KEYNEST_API_KEY), webhookUrl: base ? `${base}/webhooks/keynest/${await webhookKeyFor(env, 'keynest')}` : null,
      lastHook: await env.STORE.get('keynestHook', 'json'), keys: [], flats: [], error: null };
    if (out.connected) { try { out.keys = await keynestKeys(env, true); } catch (e) { out.error = e.userMessage || e.message; } }
    for (const l of flats) {
      let link = null; try { link = await keynestLink(env, l); } catch (_) { /* shown via out.error */ }
      out.flats.push({ id: l.id, label: l.label, name: l.name, building: l.building, keyId: link ? link.keyId : null, how: link ? link.how : null });
    }
    return json(out);
  }
  // All edits are saved together, only after the person reviews and confirms them in Settings.
  if (req.method === 'PUT' && parts[3] === 'links') {
    const body = await req.json().catch(() => ({}));
    if (body.confirmed !== true) return json({ error: 'Review and confirm the changes first.' }, 400);
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, 200) : [];
    if (!changes.length) return json({ error: 'Nothing to save.' }, 400);
    const snap = await getSnapshot(env, ctx);
    const mine = listingMap(snap.listings, config(env), allowBuildingFor(me));
    for (const c of changes) {
      const listingId = String((c && c.listingId) || '');
      const l = mine.get(listingId);
      if (!l || l.keyMode !== 'keynest') return json({ error: 'One of those flats isn’t a KeyNest flat in your buildings.' }, 400);
      if (c.keyId) links[listingId] = String(c.keyId).slice(0, 64); else delete links[listingId];
    }
    await env.STORE.put('keynestLinks', JSON.stringify(links));
    console.log(`[keynest] ${me.name} saved ${changes.length} link change(s)`);
    return json({ ok: true });
  }
  return json({ error: 'Not supported' }, 405);
}

// ---------------------------------------------------------------- notifications (in-app bell + phone push)
// Stored as one list: { id, to, type, title, body, url, at, read }. Kept 60 days, newest 2000.
async function recipients(env, roles, building, except) {
  const users = (await loadUsers(env)).filter((u) => u.active !== false && roles.includes(u.role)
    && coversBuilding(u, building));
  const ids = users.map((u) => u.id);
  if (roles.includes('admin')) ids.push('owner'); // the recovery login counts as an admin
  return [...new Set(ids)].filter((id) => id && id !== except);
}
async function notify(env, ctx, to, n) {
  if (!to.length) return;
  const at = nowIso();
  const list = (await env.STORE.get('notifications', 'json')) || [];
  const cutoff = Date.now() - 60 * 864e5;
  const items = to.map((id) => ({ id: newId(), to: id, type: n.type, title: n.title, body: n.body || '', url: n.url || '/', at, read: false }));
  const kept = list.filter((x) => Date.parse(x.at) > cutoff).concat(items).slice(-2000);
  await env.STORE.put('notifications', JSON.stringify(kept));
  ctx.waitUntil(pushTo(env, to, { title: n.title, body: n.body || '', url: n.url || '/', tag: n.tag || n.type }).catch((e) => console.log('[push] failed', e.message)));
}
// ---------------------------------------------------------------- team forum
// Anyone signed in can post (bugs, ideas, questions), like or dislike a post and comment. Admins and Users are told
// about new posts and can mark a post fixed or closed; people can delete their own posts and comments, Admins and
// Users anything. Kept as one list of the newest 500 posts.
const FORUM_KINDS = ['bug', 'idea', 'question', 'other'];
const FORUM_STATUS = ['open', 'fixed', 'closed'];
function forumSummary(p, me) {
  const votes = Object.values(p.votes || {});
  return {
    id: p.id, kind: p.kind, title: p.title, excerpt: p.body.slice(0, 240), authorId: p.authorId, authorName: p.authorName, at: p.at,
    status: p.status, statusBy: p.statusBy || null, likes: votes.filter((v) => v === 1).length, dislikes: votes.filter((v) => v === -1).length,
    myVote: (p.votes || {})[me.id] || 0, comments: (p.comments || []).length, lastAt: p.lastAt || p.at, mine: p.authorId === me.id,
  };
}
async function managerIds(env, except) {
  const ids = (await loadUsers(env)).filter((u) => u.active !== false && isManager(u)).map((u) => u.id);
  return [...new Set([...ids, 'owner'])].filter((id) => id !== except); // the recovery login counts as an admin
}
async function forumApi(req, env, ctx, me, parts) {
  const [, , , id, sub, subId] = parts; // /api/forum/:id/:sub/:subId
  const posts = (await env.STORE.get('forum', 'json')) || [];
  const save = () => env.STORE.put('forum', JSON.stringify(posts.slice(-500)));
  const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await req.json().catch(() => ({}));
  const mod = can(me, 'moderate_forum');
  const link = (pid) => `/?view=forum&post=${pid}`;
  if (!id) {
    if (req.method === 'GET') return json({ posts: posts.map((p) => forumSummary(p, me)).reverse(), canModerate: mod });
    if (req.method !== 'POST') return json({ error: 'Not supported' }, 405);
    const title = text(body.title, 120), details = text(body.body, 4000), kind = FORUM_KINDS.includes(body.kind) ? body.kind : 'other';
    if (title.length < 3) return json({ error: 'Give your post a short title.' }, 400);
    if (posts.filter((p) => p.authorId === me.id && Date.now() - Date.parse(p.at) < 864e5).length >= 20) return json({ error: 'That’s a lot of posts today. Try again tomorrow.' }, 429);
    const p = { id: newId(), kind, title, body: details, authorId: me.id, authorName: me.name, at: nowIso(), status: 'open', votes: {}, comments: [] };
    posts.push(p);
    await save();
    const what = { bug: 'reported a bug', idea: 'shared an idea', question: 'asked a question', other: 'posted on the forum' }[kind];
    await notify(env, ctx, await managerIds(env, me.id), { type: 'forum', title: `${me.name} ${what}`, body: title, url: link(p.id), tag: `forum-${p.id}` });
    return json({ post: forumSummary(p, me) });
  }
  const p = posts.find((x) => x.id === id);
  if (!p) return json({ error: 'That post wasn’t found. It may have been deleted.' }, 404);
  if (req.method === 'GET' && !sub) {
    return json({ post: { ...forumSummary(p, me), body: p.body, statusAt: p.statusAt || null, comments: (p.comments || []).map((c) => ({ ...c, mine: c.authorId === me.id })) }, canModerate: mod });
  }
  if (req.method === 'POST' && sub === 'vote') {
    const v = Number(body.value);
    if (![1, -1, 0].includes(v)) return json({ error: 'Like or dislike.' }, 400);
    p.votes = p.votes || {};
    if (v) p.votes[me.id] = v; else delete p.votes[me.id];
    await save();
    return json({ post: forumSummary(p, me) });
  }
  if (req.method === 'POST' && sub === 'comments') {
    const b = text(body.body, 2000);
    if (!b) return json({ error: 'Write a comment first.' }, 400);
    const c = { id: newId(), authorId: me.id, authorName: me.name, body: b, at: nowIso() };
    p.comments = [...(p.comments || []), c].slice(-300);
    p.lastAt = c.at;
    await save();
    // The post's author and everyone else in the conversation hear about it.
    const to = [...new Set([p.authorId, ...p.comments.map((x) => x.authorId)])].filter((x) => x && x !== me.id);
    await notify(env, ctx, to, { type: 'forum', title: `${me.name} commented on “${p.title.slice(0, 60)}”`, body: b.slice(0, 140), url: link(p.id), tag: `forum-${p.id}` });
    return json({ comment: { ...c, mine: true } });
  }
  if (req.method === 'PUT' && sub === 'status') {
    if (!mod) return json({ error: 'Only Admins and Users can change a post’s status.' }, 403);
    if (!FORUM_STATUS.includes(body.status)) return json({ error: 'Pick open, fixed or closed.' }, 400);
    p.status = body.status; p.statusBy = me.name; p.statusAt = nowIso();
    await save();
    if (p.authorId !== me.id && p.status !== 'open') await notify(env, ctx, [p.authorId], { type: 'forum', title: `${me.name} marked your post ${p.status}`, body: p.title, url: link(p.id), tag: `forum-${p.id}` });
    return json({ post: forumSummary(p, me) });
  }
  if (req.method === 'DELETE' && !sub) {
    if (p.authorId !== me.id && !mod) return json({ error: 'You can only delete your own posts.' }, 403);
    posts.splice(posts.indexOf(p), 1);
    await save();
    return json({ ok: true });
  }
  if (req.method === 'DELETE' && sub === 'comments') {
    const c = (p.comments || []).find((x) => x.id === subId);
    if (!c) return json({ error: 'That comment wasn’t found.' }, 404);
    if (c.authorId !== me.id && !mod) return json({ error: 'You can only delete your own comments.' }, 403);
    p.comments = p.comments.filter((x) => x !== c);
    await save();
    return json({ ok: true });
  }
  return json({ error: 'Not supported' }, 405);
}

async function notificationsApi(req, env, me, parts) {
  const list = (await env.STORE.get('notifications', 'json')) || [];
  if (req.method === 'GET') {
    const mine = list.filter((x) => x.to === me.id);
    return json({ items: mine.slice(-50).reverse(), unread: mine.filter((x) => !x.read).length });
  }
  if (req.method === 'POST' && parts[3] === 'read') {
    const body = await req.json().catch(() => ({}));
    const ids = body.all ? null : new Set((body.ids || []).map(String));
    let n = 0;
    for (const x of list) if (x.to === me.id && !x.read && (!ids || ids.has(x.id))) { x.read = true; n++; }
    if (n) await env.STORE.put('notifications', JSON.stringify(list));
    return json({ ok: true, marked: n });
  }
  return json({ error: 'Not supported' }, 405);
}

// Web Push (RFC 8291 payload encryption + RFC 8292 VAPID), with the WebCrypto built into Node and Workers.
const b64u = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); return unb64(s + '='.repeat((4 - (s.length % 4)) % 4)); };
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function vapidKeys(env) {
  let v = await env.STORE.get('vapidKeys', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await env.STORE.put('vapidKeys', JSON.stringify(v));
  }
  return v;
}
// Encrypts one push message for a subscription (aes128gcm). `test` fixes the random parts for known-answer tests.
async function encryptPush(sub, payload, test) {
  const enc = new TextEncoder();
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const as = test ? test.asKeys : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = test ? test.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = typeof payload === 'string' ? enc.encode(payload) : payload;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(data, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}
async function vapidAuth(env, endpoint) {
  const v = await vapidKeys(env);
  const enc = new TextEncoder();
  const aud = new URL(endpoint).origin;
  const sub = (env.PUBLIC_URL || 'https://schedule.yourcityscape.com').replace(/\/$/, '');
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })));
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}
// Only the browsers' own push services are ever contacted (Chrome/Android, Apple, Firefox, Edge/Windows).
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*notify\.windows\.com)$/i;
const pushEndpointOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.test(x.hostname); } catch (_) { return false; } };
async function pushTo(env, userIds, msg) {
  const subs = (await env.STORE.get('pushSubs', 'json')) || {};
  const body = JSON.stringify(msg).slice(0, 3000);
  const targets = userIds.flatMap((id) => (subs[id] || []).filter((s) => pushEndpointOk(s.endpoint)));
  const dead = new Set();
  await Promise.allSettled(targets.map(async (s) => {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', body: await encryptPush(s, body), redirect: 'manual', signal: AbortSignal.timeout(10000), headers: {
        Authorization: await vapidAuth(env, s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' } });
      if (r.status === 404 || r.status === 410) dead.add(s.endpoint); // phone unsubscribed
      else if (!r.ok) console.log('[push]', r.status, (await r.text().catch(() => '')).slice(0, 200));
    } catch (e) { console.log('[push] send failed', e.message); }
  }));
  if (!dead.size) return;
  const now = (await env.STORE.get('pushSubs', 'json')) || {}; // re-read: someone may have (un)subscribed meanwhile
  for (const id of Object.keys(now)) now[id] = now[id].filter((x) => !dead.has(x.endpoint));
  await env.STORE.put('pushSubs', JSON.stringify(now));
}
async function pushApi(req, env, me, parts) {
  if (req.method === 'GET' && parts[3] === 'key') return json({ publicKey: (await vapidKeys(env)).publicKey });
  const body = await req.json().catch(() => ({}));
  const subs = (await env.STORE.get('pushSubs', 'json')) || {};
  const s = body.subscription || {};
  if (req.method === 'POST' && parts[3] === 'subscribe') {
    if (!pushEndpointOk(String(s.endpoint || '')) || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: 'That subscription isn’t valid.' }, 400);
    const entry = { endpoint: String(s.endpoint).slice(0, 1000), keys: { p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 100) }, at: nowIso(), ua: String(req.headers.get('user-agent') || '').slice(0, 160) };
    for (const id of Object.keys(subs)) subs[id] = subs[id].filter((x) => x.endpoint !== entry.endpoint); // a phone belongs to whoever signed in last
    subs[me.id] = (subs[me.id] || []).concat(entry).slice(-10);
    await env.STORE.put('pushSubs', JSON.stringify(subs));
    return json({ ok: true });
  }
  if (req.method === 'POST' && parts[3] === 'unsubscribe') {
    subs[me.id] = (subs[me.id] || []).filter((x) => x.endpoint !== s.endpoint && x.endpoint !== body.endpoint);
    await env.STORE.put('pushSubs', JSON.stringify(subs));
    return json({ ok: true });
  }
  if (req.method === 'POST' && parts[3] === 'test') {
    await pushTo(env, [me.id], { title: 'Phone notifications are on', body: 'You’ll get alerts from Cityscape Schedule here.', url: '/', tag: 'test' });
    return json({ ok: true });
  }
  return json({ error: 'Not supported' }, 405);
}

// ---------------------------------------------------------------- assigning cleanings
// One cleaner per flat per day: { "date|listingId": { listingId, date, building, label, cleanerId, cleanerName, byId, byName, at } }.
const dayLabel = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d + 'T00:00:00Z'));
const ASSIGNABLE = ['cleaner', 'supervisor']; // Admins and Users run the operation; they aren't given cleanings
async function assignmentsApi(req, env, ctx, me, url) {
  const all = (await env.STORE.get('assignments', 'json')) || {};
  if (req.method === 'GET' && url.pathname === '/api/assignees') {
    if (!can(me, 'assign_cleanings')) return json({ error: 'You don’t have permission to assign cleanings. Ask an admin.' }, 403);
    const l = await listingInfo(env, ctx, String(url.searchParams.get('listingId') || ''));
    if (!l) return json({ error: 'That property wasn’t found.' }, 404);
    if (!inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, 403);
    const people = (await loadUsers(env)).filter((u) => u.active !== false && ASSIGNABLE.includes(u.role) && can(u, 'do_cleaning') && coversBuilding(u, l.building));
    return json({ people: people.map((u) => ({ id: u.id, name: u.name, role: u.role })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (req.method === 'GET') {
    const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '9999';
    return json({ assignments: Object.values(all).filter((a) => a.date >= from && a.date <= to && inScope(me, a.building)) });
  }
  if (req.method === 'PUT') {
    if (!can(me, 'assign_cleanings')) return json({ error: 'You don’t have permission to assign cleanings. Ask an admin.' }, 403);
    const body = await req.json().catch(() => ({}));
    const date = String(body.date || '');
    const realDay = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
    if (!realDay) return json({ error: 'Pick a day.' }, 400);
    const l = await listingInfo(env, ctx, String(body.listingId || ''));
    if (!l) return json({ error: 'That property wasn’t found.' }, 404);
    if (!inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, 403);
    const key = `${date}|${l.id}`, before = all[key] || null;
    let cleaner = null;
    if (body.cleanerId) {
      cleaner = (await loadUsers(env)).find((u) => u.id === String(body.cleanerId) && u.active !== false);
      if (!cleaner || !can(cleaner, 'do_cleaning')) return json({ error: 'That person can’t do cleanings.' }, 400);
      if (!ASSIGNABLE.includes(cleaner.role)) return json({ error: 'Only cleaners and supervisors can be assigned a cleaning.' }, 400);
      if (!coversBuilding(cleaner, l.building)) return json({ error: `${cleaner.name} doesn’t cover ${l.building}. Add the building to their account first.` }, 400);
    }
    if (before && cleaner && before.cleanerId === cleaner.id) return json({ assignment: before });
    if (cleaner) all[key] = { listingId: l.id, date, building: l.building, label: l.label, cleanerId: cleaner.id, cleanerName: cleaner.name, byId: me.id, byName: me.name, at: nowIso() };
    else delete all[key];
    for (const k of Object.keys(all)) if (all[k].date < londonDate(Date.now() - 90 * 864e5)) delete all[k]; // keep 90 days
    await env.STORE.put('assignments', JSON.stringify(all));
    const where = `${dayLabel(date)} · ${l.building}`;
    const link = `/?view=day&date=${date}&flat=${encodeURIComponent(l.id)}`;
    if (cleaner) {
      await notify(env, ctx, [cleaner.id].filter((id) => id !== me.id), { type: 'assigned', title: `You’re cleaning ${l.label}`, body: `${where} · assigned by ${me.name}`, url: link, tag: `assign-${key}` });
      await notify(env, ctx, (await recipients(env, ['supervisor'], l.building, me.id)).filter((id) => id !== cleaner.id), { type: 'assigned', title: `${cleaner.name} assigned to ${l.label}`, body: `${where} · by ${me.name}`, url: link, tag: `assign-${key}` });
    }
    if (before && (!cleaner || before.cleanerId !== cleaner.id) && before.cleanerId !== me.id) {
      await notify(env, ctx, [before.cleanerId], { type: 'unassigned', title: `${l.label} is no longer yours`, body: `${where} · changed by ${me.name}`, url: link, tag: `assign-${key}` });
    }
    return json({ assignment: all[key] || null });
  }
  return json({ error: 'Not supported' }, 405);
}

// Before a cleaning's key step is saved: ask KeyNest where the key is (outside the one-at-a-time queue, as it can take
// seconds). Not for overrides, which don't need KeyNest to answer.
async function keyPrecheck(req, env, ctx, parts) {
  const [, , , id, action] = parts;
  if (req.method !== 'POST' || action !== 'key' || !env.KEYNEST_API_KEY) return null;
  const body = await req.json().catch(() => ({}));
  if (body.override === true) return null;
  const rec = (await loadList(env, 'cleanings')).find((c) => c.id === id);
  if (!rec || rec.keyMode !== 'keynest' || rec.status !== 'awaiting_key') return null;
  const l = await listingInfo(env, ctx, rec.listingId);
  let link = null;
  try { link = l && await keynestLink(env, l); } catch (e) { return { error: e.userMessage || 'KeyNest isn’t answering right now. Try again in a minute.' }; }
  if (!link) return { link: null };
  try { return { link, chk: await keynestCheck(env, link.keyId) }; } catch (e) { return { link, error: e.userMessage || 'KeyNest isn’t answering right now. Try again in a minute.' }; }
}
// Admin, User and supervisor roles can finish someone else's cleaning at the key step, and override the KeyNest check.
const canStepIn = (me, rec) => can(me, 'step_in') && inScope(me, rec.building);
async function cleaningsApi(req, env, ctx, me, parts, url, pre) {
  const [, , , id, action] = parts; // /api/cleanings/:id/:action
  const list = await loadList(env, 'cleanings');
  const deny = (msg) => json({ error: msg || 'You don’t have permission for that. Ask an admin.' }, 403);

  if (req.method === 'GET' && !id) {
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from') || date;
    const to = url.searchParams.get('to') || date;
    const mine = list.filter((c) => c.cleanerId === me.id && c.status !== 'completed' && c.status !== 'cancelled');
    const visible = list.filter((c) => {
      if (c.cleanerId === me.id) return true;
      if (!can(me, 'view_cleaning')) return false;
      return inScope(me, c.building);
    }).filter((c) => (!from || c.date >= from) && (!to || c.date <= to));
    const out = [];
    for (const c of [...new Set([...visible, ...mine])]) {
      const x = await withMedia(env, c);
      if (c.keyMode === 'lockbox' && c.status !== 'completed' && c.status !== 'cancelled') { const l = await listingInfo(env, ctx, c.listingId); x.keyNoCode = Boolean(l && l.lockboxNoCode); x.keyInstruction = (l && l.keyInstruction) || ''; }
      out.push(x);
    }
    out.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return json({ cleanings: out, checklist: CHECKLIST, holdMs: HOLD_MS });
  }

  if (req.method === 'POST' && id === 'start') {
    if (me.role === 'user') return deny('Users can’t start cleanings. Assign it to a cleaner instead.');
    if (!can(me, 'do_cleaning')) return deny();
    const body = await req.json().catch(() => ({}));
    // Admins can, but only after confirming they really mean to (they're not a cleaner).
    if (me.role === 'admin' && body.notCleanerConfirmed !== true) return json({ error: 'You’re not a cleaner. Confirm you want to start this cleaning yourself.' }, 400);
    const l = await listingInfo(env, ctx, String(body.listingId || ''));
    if (!l) return json({ error: 'That property wasn’t found.' }, 404);
    if (!inScope(me, l.building)) return deny('That property isn’t one of your buildings.');
    const active = list.find((c) => c.listingId === l.id && ['in_progress', 'checklist', 'awaiting_video', 'awaiting_key'].includes(c.status));
    if (active) {
      const at = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit' }).format(new Date(active.startedAt));
      return json({ error: `${active.cleanerName} already started cleaning ${l.label} at ${at}.`, cleaning: active }, 409);
    }
    const rec = {
      id: newId(), listingId: l.id, listingName: l.name, label: l.label, building: l.building, unitType: l.unitType,
      cleanerId: me.id, cleanerName: me.name, startedAt: nowIso(), endedAt: null, completedAt: null,
      date: londonDate(), status: 'in_progress', checklist: [], media: [], guesty: null, keyMode: l.keyMode || null, key: null,
    };
    list.push(rec);
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }

  const rec = list.find((c) => c.id === id);
  if (!rec) return json({ error: 'That cleaning wasn’t found.' }, 404);
  const isMine = rec.cleanerId === me.id;
  const isAdmin = can(me, 'manage_users') && inScope(me, rec.building);
  const stepIn = canStepIn(me, rec);

  if (req.method === 'POST' && action === 'end') {
    if (!isMine) return deny('Only the person who started this cleaning can end it.');
    if (rec.status !== 'in_progress') return json({ cleaning: rec });
    rec.endedAt = nowIso();
    rec.status = 'checklist';
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }
  if (req.method === 'POST' && action === 'confirm') {
    // One checklist item, confirmed with a single tap, in order.
    if (!isMine) return deny();
    if (rec.status !== 'checklist') return json({ error: 'This checklist is already done.' }, 400);
    const body = await req.json().catch(() => ({}));
    const next = CHECKLIST[rec.checklist.length];
    if (!next) return json({ cleaning: rec });
    if (body.key !== next.key) return json({ error: 'Please go through the checks in order.', cleaning: rec }, 400);
    rec.checklist.push({ key: next.key, confirmedAt: nowIso() });
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }
  if (req.method === 'POST' && action === 'checks-done') {
    // After all items are ticked, the summary is confirmed by holding the button for HOLD_MS.
    if (!isMine) return deny();
    if (rec.status !== 'checklist') return json({ cleaning: rec });
    const body = await req.json().catch(() => ({}));
    if (rec.checklist.length < CHECKLIST.length) return json({ error: 'Please answer every check first.', cleaning: rec }, 400);
    if (!(Number(body.heldMs) >= HOLD_MS - 50)) return json({ error: 'Hold the button until the bar fills.' }, 400);
    rec.checksConfirmedAt = nowIso();
    rec.checksHeldMs = Math.round(Number(body.heldMs));
    rec.status = 'awaiting_video';
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }
  // Final step: mark completed and tell Guesty the flat is clean (in the background).
  const finish = async () => {
    rec.completedAt = nowIso();
    rec.status = 'completed';
    if (rec.cleanerId !== me.id) { rec.completedBy = me.name; rec.completedById = me.id; }
    await saveList(env, 'cleanings', list);
    if (rec.cleanerId !== me.id) await notify(env, ctx, [rec.cleanerId], { type: 'cleaned', title: `${me.name} finished your cleaning · ${rec.label}`,
      body: rec.key && rec.key.overridden ? 'The KeyNest check was overridden.' : 'The key step was completed for you.', url: `/?view=cleaning&date=${rec.date}`, tag: `cleaned-${rec.id}` }).catch(() => {});
    const mins = Math.max(1, Math.round((Date.parse(rec.endedAt || rec.completedAt) - Date.parse(rec.startedAt)) / 60000));
    await notify(env, ctx, await recipients(env, ['admin', 'user'], rec.building, rec.cleanerId), {
      type: 'cleaned', title: `${rec.label} cleaned`, body: `${rec.cleanerName} · ${rec.building} · ${mins} min`,
      url: `/?view=cleaning&date=${rec.date}`, tag: `cleaned-${rec.id}` }).catch((e) => console.log('[notify] failed', e.message));
    ctx.waitUntil((async () => {
      const g = await markCleanInGuesty(env, rec.listingId);
      await withLock('cleanings', async () => {
        const l2 = await loadList(env, 'cleanings');
        const r2 = l2.find((c) => c.id === rec.id);
        if (r2) { r2.guesty = g; await saveList(env, 'cleanings', l2); }
      });
    })());
    return json({ cleaning: await withMedia(env, rec) });
  };
  if (req.method === 'POST' && action === 'complete') {
    if (!isMine) return deny();
    if (rec.status !== 'awaiting_video') return json({ error: 'Finish the checklist first.' }, 400);
    const body = await req.json().catch(() => ({}));
    const ids = [...new Set([...(body.videoIds || []), ...(body.photoIds || [])].map(String))];
    const own = (m) => m.purpose === 'cleaning' && m.ownerId === rec.id && m.byId === me.id; // filmed for this cleaning
    const videos = await mediaReady(env, ids, 'video', own);
    if (!videos.length) return json({ error: 'A video of the flat is required before you can finish.' }, 400);
    const all = await mediaReady(env, ids, null, own);
    rec.media = all.map((m) => m.id);
    rec.videoAt = nowIso();
    // Flats tagged LOCKBOX or KEYNEST in Guesty have one more step: returning the key.
    const l = await listingInfo(env, ctx, rec.listingId);
    const mode = (l && l.keyMode) || null;
    if (mode) {
      rec.keyMode = mode;
      rec.status = 'awaiting_key';
      await saveList(env, 'cleanings', list);
      return json({ cleaning: await withMedia(env, rec) });
    }
    return finish();
  }
  if (req.method === 'GET' && action === 'key-status') {
    // Live KeyNest status for the cleaner's "key back in KeyNest" screen.
    if (!isMine && !stepIn) return deny();
    if (rec.keyMode !== 'keynest') return json({ ok: false, status: null });
    if (!env.KEYNEST_API_KEY) return json({ ok: false, status: null, error: 'KeyNest isn’t connected yet. Ask an admin.' });
    const l = await listingInfo(env, ctx, rec.listingId);
    const link = l && await keynestLink(env, l);
    if (!link) return json({ ok: false, status: null, error: 'This flat isn’t linked to a KeyNest key yet. Ask an admin to link it in Settings › Integrations › KeyNest.' });
    return json(await keynestCheck(env, link.keyId));
  }
  if (req.method === 'GET' && action === 'key-stores') {
    // Where to drop the key off: the nearest KeyNest to the flat, and the nearest one open 24 hours.
    if (!isMine && !stepIn) return deny();
    if (rec.keyMode !== 'keynest') return json({ nearest: null, nearest24: null });
    const l = await listingInfo(env, ctx, rec.listingId);
    const at = l && await flatLatLng(l);
    if (!at) return json({ error: 'Couldn’t find this flat on the map, so there are no KeyNest stores to suggest.' });
    let stores;
    try { stores = await keynestStores(env); } catch (e) { return json({ error: e.userMessage || 'Couldn’t load the KeyNest stores. Try again in a minute.' }); }
    const now = londonNow();
    const ranked = stores.map((st) => ({ st, miles: milesBetween(at, st) })).sort((x, y) => x.miles - y.miles);
    // Where this flat's key is usually dropped off (KeyNest webhook record).
    let keyId = rec.key && rec.key.keyId;
    if (!keyId) { try { keyId = (await keynestLink(env, l) || {}).keyId; } catch (_) { /* no record then */ } }
    const top = keyId ? mostUsedStore(((await env.STORE.get('keynestMoves', 'json')) || {})[keyId]) : null;
    const isTop = (st) => Boolean(top && (top.storeId ? String(st.id) === top.storeId : normName(st.name) === normName(top.name)));
    const view = (x) => x && {
      id: x.st.id, name: x.st.name, address: x.st.address, lat: x.st.lat, lng: x.st.lng, miles: Math.round(x.miles * 10) / 10,
      walkMin: walkMinutes(x.miles), is24: x.st.is24, ...storeToday(x.st, now), mostUsed: isTop(x.st) ? { count: top.count, total: top.total } : null,
    };
    const nearest = view(ranked[0]), nearest24 = view(ranked.find((x) => x.st.is24));
    const usual = top && !(nearest && nearest.mostUsed) && !(nearest24 && nearest24.mostUsed) ? view(ranked.find((x) => isTop(x.st))) : null;
    return json({ nearest, nearest24, usual });
  }
  if (req.method === 'POST' && action === 'key') {
    if (!isMine && !stepIn) return deny('Only the cleaner, or an Admin, User or supervisor, can finish this cleaning.');
    if (rec.status !== 'awaiting_key') return json({ error: rec.status === 'completed' ? 'This cleaning is already complete.' : 'Upload the video first.' }, 400);
    const body = await req.json().catch(() => ({}));
    if (rec.keyMode === 'lockbox') {
      const lb = await listingInfo(env, ctx, rec.listingId);
      if (lb && lb.lockboxNoCode) { // this flat's lockbox keeps its code: just confirm the key is back
        if (body.keyReturned !== true) return json({ error: 'Confirm the key is back in the lockbox.' }, 400);
        rec.key = { mode: 'lockbox', code: null, noCode: true, note: lb.keyInstruction || null, returnedAt: nowIso() };
        return finish();
      }
      const code = String(body.code || '').trim();
      if (!/^\d{4}$/.test(code)) return json({ error: 'Enter the new lockbox code: exactly 4 numbers.' }, 400);
      if (body.confirmCode !== undefined && String(body.confirmCode).trim() !== code) return json({ error: 'The two codes don’t match. Check the lockbox and enter it again.' }, 400);
      if (body.keyReturned !== true) return json({ error: 'Confirm the key is back in the lockbox.' }, 400);
      rec.key = { mode: 'lockbox', code, returnedAt: nowIso() };
      const codes = (await env.STORE.get('lockboxCodes', 'json')) || {};
      codes[rec.listingId] = { code, at: rec.key.returnedAt, by: me.name, cleaningId: rec.id };
      await env.STORE.put('lockboxCodes', JSON.stringify(codes));
      return finish();
    }
    if (rec.keyMode === 'keynest' && body.override === true) {
      // Finishing without KeyNest confirming the key is back: Admin, User or supervisor only, and recorded.
      if (!stepIn) return json({ error: 'You don’t have permission to override the KeyNest check.' }, 403);
      const l = await listingInfo(env, ctx, rec.listingId);
      let keyId = null; try { keyId = l ? ((await keynestLink(env, l)) || {}).keyId || null : null; } catch (_) { /* KeyNest down: that's often why */ }
      rec.key = { mode: 'keynest', keyId, status: 'not checked', overridden: true, overriddenBy: me.name, overriddenById: me.id, confirmedAt: nowIso(),
        note: String(body.note || '').trim().slice(0, 300) || null };
      console.log(`[keynest] ${me.name} overrode the KeyNest check for ${rec.label} (cleaning ${rec.id} by ${rec.cleanerName})`);
      return finish();
    }
    if (rec.keyMode === 'keynest') {
      if (!env.KEYNEST_API_KEY) return json({ error: 'KeyNest isn’t connected yet. Ask an admin.' }, 400);
      const l = await listingInfo(env, ctx, rec.listingId);
      const link = l && await keynestLink(env, l);
      if (!link) return json({ error: 'This flat isn’t linked to a KeyNest key yet. Ask an admin to link it in Settings › Integrations › KeyNest.' }, 400);
      if (pre && pre.error) return json({ error: pre.error }, 502);
      const chk = pre && pre.chk && pre.link && pre.link.keyId === link.keyId ? pre.chk : await keynestCheck(env, link.keyId);
      if (!chk.ok) return json({ error: `KeyNest doesn’t show the key in the store yet (status: ${chk.status}). Hand it in at the KeyNest store, then check again.`, keynest: chk }, 409);
      rec.key = { mode: 'keynest', keyId: link.keyId, status: chk.status, lastMovement: chk.lastMovement, confirmedAt: nowIso() };
      return finish();
    }
    return finish();
  }
  if (req.method === 'POST' && action === 'cancel') {
    if (!isMine && !isAdmin) return deny();
    if (rec.status === 'completed') return json({ error: 'Completed cleanings can’t be cancelled.' }, 400);
    rec.status = 'cancelled';
    rec.cancelledAt = nowIso();
    rec.cancelledBy = me.name;
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }
  if (req.method === 'GET') {
    if (!isMine && !(can(me, 'view_cleaning') && inScope(me, rec.building))) return deny();
    return json({ cleaning: await withMedia(env, rec), keyMoves: await keyMovesFor(env, ctx, rec), checklist: CHECKLIST, holdMs: HOLD_MS });
  }
  return json({ error: 'Not supported' }, 405);
}

async function damagesApi(req, env, ctx, me, parts, url) {
  const [, , , id] = parts;
  const list = await loadList(env, 'damages');
  const canSee = (d) => d.reporterId === me.id || ((can(me, 'view_cleaning') || can(me, 'manage_damage')) && inScope(me, d.building));
  if (req.method === 'GET' && !id) {
    const listingId = url.searchParams.get('listingId');
    const status = url.searchParams.get('status');
    const out = [];
    for (const d of list) {
      if (!canSee(d)) continue;
      if (listingId && d.listingId !== listingId) continue;
      if (status && d.status !== status) continue;
      out.push(await withMedia(env, d));
    }
    out.sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
    return json({ damages: out });
  }
  if (req.method === 'POST' && !id) {
    if (!can(me, 'report_damage')) return json({ error: 'You don’t have permission to report damage.' }, 403);
    const body = await req.json().catch(() => ({}));
    const l = await listingInfo(env, ctx, String(body.listingId || ''));
    if (!l) return json({ error: 'That property wasn’t found.' }, 404);
    if (!inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, 403);
    const description = String(body.description || '').trim().slice(0, 2000);
    if (description.length < 3) return json({ error: 'Describe what’s damaged.' }, 400);
    const media = await mediaReady(env, (body.mediaIds || []).map(String), null, (m) => m.purpose === 'damage' && m.listingId === l.id && m.byId === me.id);
    if (!media.length) return json({ error: 'Add a video or photo of the damage.' }, 400);
    const rec = {
      id: newId(), listingId: l.id, listingName: l.name, label: l.label, building: l.building,
      description, location: String(body.location || '').trim().slice(0, 120),
      reporterId: me.id, reporterName: me.name, reportedAt: nowIso(), date: londonDate(),
      cleaningId: body.cleaningId ? String(body.cleaningId) : null,
      media: media.map((m) => m.id), status: 'open', resolvedAt: null, resolvedBy: null, note: '',
    };
    list.push(rec);
    await saveList(env, 'damages', list);
    await notify(env, ctx, await recipients(env, ['admin', 'user'], rec.building, me.id), {
      type: 'damage', title: `Damage reported · ${rec.label}`, body: `${rec.location ? rec.location + ': ' : ''}${description.slice(0, 120)} — ${me.name}`,
      url: `/?view=day&date=${rec.date}&flat=${encodeURIComponent(rec.listingId)}`, tag: `damage-${rec.id}` }).catch((e) => console.log('[notify] failed', e.message));
    return json({ damage: await withMedia(env, rec) });
  }
  const rec = list.find((d) => d.id === id);
  if (!rec || !canSee(rec)) return json({ error: 'That report wasn’t found.' }, 404);
  if (req.method === 'PUT') {
    if (!can(me, 'manage_damage')) return json({ error: 'You don’t have permission to resolve damage reports.' }, 403);
    const body = await req.json().catch(() => ({}));
    if (body.status === 'resolved' || body.status === 'open') {
      rec.status = body.status;
      rec.resolvedAt = body.status === 'resolved' ? nowIso() : null;
      rec.resolvedBy = body.status === 'resolved' ? me.name : null;
    }
    if ('note' in body) rec.note = String(body.note || '').slice(0, 2000);
    await saveList(env, 'damages', list);
    return json({ damage: await withMedia(env, rec) });
  }
  return json({ damage: await withMedia(env, rec) });
}

// ---------------------------------------------------------------- maintenance tasks
// Anyone can report an issue at a flat (with photos/videos). Admins and Users triage: priority, due date, repeating
// schedule, cost, and who does it: a team member (any role) or a contractor (name + phone, no login). The person it's
// assigned to, and supervisors of the building, move it along (In progress, Waiting, Done) and add notes. Marking a
// repeating task done creates the next one. One list, the newest 2000 tasks.
const MT_PRIORITY = ['urgent', 'high', 'normal', 'low'];
const MT_STATUS = ['open', 'in_progress', 'waiting', 'done', 'cancelled'];
const MT_UNITS = ['days', 'weeks', 'months', 'years'];
const MT_WORD = { open: 'open', in_progress: 'in progress', waiting: 'waiting', done: 'done', cancelled: 'cancelled' };
function addInterval(date, r) {
  const d = new Date(date + 'T00:00:00Z');
  if (r.unit === 'days' || r.unit === 'weeks') { d.setUTCDate(d.getUTCDate() + r.every * (r.unit === 'weeks' ? 7 : 1)); return d.toISOString().slice(0, 10); }
  const months = r.every * (r.unit === 'years' ? 12 : 1);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // 31 Jan + 1 month = 28/29 Feb, not 3 Mar
  return new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10);
}
const realDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
async function maintenanceApi(req, env, ctx, me, parts, url) {
  const [, , , id, action] = parts; // /api/maintenance/:id/:action
  const tasks = await loadList(env, 'maintenance');
  const save = () => saveList(env, 'maintenance', tasks.slice(-2000));
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await req.json().catch(() => ({}));
  const mm = can(me, 'manage_maintenance'); // Admins and Users by default
  const manage = (t) => mm && inScope(me, t.building);
  const mine = (t) => t.assignee && t.assignee.type === 'user' && t.assignee.id === me.id;
  const canSee = (t) => (inScope(me, t.building) && (mm || me.role === 'supervisor')) || t.reporterId === me.id || mine(t);
  const canMove = (t) => manage(t) || mine(t) || (me.role === 'supervisor' && inScope(me, t.building));
  const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  const link = (t) => `/?view=maintenance&task=${t.id}`;
  const log = (t, txt, kind = 'event') => { t.log = [...(t.log || []), { id: newId(), at: nowIso(), byId: me.id, byName: me.name, kind, text: txt }].slice(-200); t.updatedAt = nowIso(); };
  const shape = async (t) => ({ ...(await withMedia(env, t)), canManage: manage(t), canMove: canMove(t), overdue: Boolean(t.due && t.due < londonDate() && !['done', 'cancelled'].includes(t.status)) });
  const who = (a) => (!a ? 'nobody' : a.type === 'contractor' ? `${a.name} (contractor)` : a.name);
  // Who a task is for: a team member (any role, covering the building) or a contractor, remembered for next time.
  async function readAssignee(a, t) {
    if (!a || !a.type) return null;
    if (a.type === 'user') {
      const u = (await loadUsers(env)).find((x) => x.id === String(a.id) && x.active !== false);
      if (!u || !coversBuilding(u, t.building)) throw userError('Pick someone who covers this building.', 400);
      return { type: 'user', id: u.id, name: u.name };
    }
    const name = text(a.name, 80), phone = text(a.phone, 30).replace(/[^\d+ ()-]/g, ''), trade = text(a.trade, 60);
    if (name.length < 2) throw userError('Give the contractor’s name.', 400);
    if (phone.replace(/\D/g, '').length < 7) throw userError('Give the contractor’s phone number.', 400);
    const book = (await env.STORE.get('contractors', 'json')) || [];
    const k = normName(name);
    const i = book.findIndex((c) => normName(c.name) === k);
    const c = { name, phone, trade: trade || (i >= 0 ? book[i].trade : '') };
    if (i >= 0) book[i] = { ...book[i], ...c }; else book.push({ id: newId(), ...c });
    await env.STORE.put('contractors', JSON.stringify(book.slice(-300)));
    return { type: 'contractor', ...c };
  }
  const readRepeat = (r) => {
    if (!r || !r.every) return null;
    const every = Math.round(Number(r.every));
    if (!(every >= 1 && every <= 60) || !MT_UNITS.includes(r.unit)) throw userError('Repeats every 1–60 days, weeks, months or years.', 400);
    return { every, unit: r.unit };
  };
  const tellAssignee = async (t) => { if (t.assignee && t.assignee.type === 'user' && t.assignee.id !== me.id) await notify(env, ctx, [t.assignee.id], { type: 'maintenance', title: `Maintenance for you · ${t.label}`, body: t.title, url: link(t), tag: `mt-${t.id}` }); };

  if (!id && req.method === 'GET') {
    const status = url.searchParams.get('status') || 'open', listingId = url.searchParams.get('listingId');
    const out = [];
    for (const t of tasks) {
      if (!canSee(t) || (listingId && t.listingId !== listingId)) continue;
      const done = ['done', 'cancelled'].includes(t.status);
      if ((status === 'open' && done) || (status === 'done' && !done)) continue;
      out.push(await shape(t));
    }
    const open = tasks.filter((t) => canSee(t) && !['done', 'cancelled'].includes(t.status));
    const late = (t) => Boolean(t.due && t.due < londonDate());
    // The sidebar badge: yours to do, plus (for Admins/Users) tasks nobody has yet and anything overdue.
    const counts = { mine: open.filter(mine).length, unassigned: mm ? open.filter((t) => !t.assignee).length : 0, overdue: open.filter(late).length,
      badge: open.filter((t) => mine(t) || (mm && (!t.assignee || late(t)))).length };
    return json({ tasks: out.reverse(), counts, canManage: mm, contractors: mm ? ((await env.STORE.get('contractors', 'json')) || []) : [] });
  }
  if (id === 'people' && req.method === 'GET') {
    if (!mm) return json({ error: 'You don’t have permission to assign maintenance. Ask an admin.' }, 403);
    const l = await listingInfo(env, ctx, String(url.searchParams.get('listingId') || ''));
    if (!l || !inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, 403);
    const people = (await loadUsers(env)).filter((u) => u.active !== false && coversBuilding(u, l.building));
    return json({ people: people.map((u) => ({ id: u.id, name: u.name, role: u.role })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (!id && req.method === 'POST') {
    if (!mm && !can(me, 'report_maintenance')) return json({ error: 'You don’t have permission to report maintenance. Ask an admin.' }, 403);
    const l = await listingInfo(env, ctx, String(body.listingId || ''));
    if (!l) return json({ error: 'Pick the flat.' }, 400);
    if (!inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, 403);
    const title = text(body.title, 140);
    if (title.length < 3) return json({ error: 'Say what needs fixing.' }, 400);
    const t = {
      id: newId(), title, details: text(body.details, 4000), listingId: l.id, label: l.label, building: l.building,
      priority: MT_PRIORITY.includes(body.priority) ? body.priority : 'normal', status: 'open', assignee: null, due: null, repeat: null, cost: null,
      reporterId: me.id, reporterName: me.name, createdAt: nowIso(), updatedAt: nowIso(), doneAt: null, doneBy: null,
      media: (await mediaReady(env, (body.mediaIds || []).map(String), null, (m) => ['maintenance', 'damage'].includes(m.purpose) && m.listingId === l.id && (m.byId === me.id || mm))).map((m) => m.id), log: [], damageId: body.damageId ? String(body.damageId) : null,
    };
    t.seriesId = t.id;
    if (mm) { // triage details come from Admins and Users
      t.assignee = await readAssignee(body.assignee, t);
      if (body.due) { if (!realDate(body.due)) return json({ error: 'Pick a due date.' }, 400); t.due = body.due; }
      t.repeat = readRepeat(body.repeat);
      if (t.repeat && !t.due) t.due = londonDate();
      if (body.cost !== undefined && body.cost !== null && body.cost !== '') t.cost = Math.max(0, Math.round(Number(body.cost) * 100) / 100) || null;
    }
    log(t, mm ? 'Created' : 'Reported');
    if (t.assignee) log(t, `Assigned to ${who(t.assignee)}`);
    tasks.push(t);
    await save();
    if (!mm) await notify(env, ctx, await recipients(env, ['admin', 'user'], t.building, me.id), { type: 'maintenance', title: `Maintenance reported · ${t.label}`, body: `${t.title} — ${me.name}`, url: link(t), tag: `mt-${t.id}` });
    await tellAssignee(t);
    console.log(`[maintenance] ${me.name} ${mm ? 'created' : 'reported'} "${t.title}" at ${t.label}`);
    return json({ task: await shape(t) });
  }
  const t = tasks.find((x) => x.id === id);
  if (!t || !canSee(t)) return json({ error: 'That task wasn’t found.' }, 404);
  if (req.method === 'GET') return json({ task: await shape(t) });
  if (req.method === 'PUT' && !action) {
    if (!manage(t)) return json({ error: 'Only Admins and Users can change a task’s details.' }, 403);
    const was = { assignee: who(t.assignee), due: t.due, priority: t.priority };
    if (body.title !== undefined) { const v = text(body.title, 140); if (v.length < 3) return json({ error: 'Say what needs fixing.' }, 400); t.title = v; }
    if (body.details !== undefined) t.details = text(body.details, 4000);
    if (body.priority !== undefined && MT_PRIORITY.includes(body.priority)) t.priority = body.priority;
    if (body.due !== undefined) { if (body.due && !realDate(body.due)) return json({ error: 'Pick a due date.' }, 400); t.due = body.due || null; }
    if (body.repeat !== undefined) { t.repeat = readRepeat(body.repeat); if (t.repeat && !t.due) t.due = londonDate(); }
    if (body.cost !== undefined) t.cost = body.cost === null || body.cost === '' ? null : Math.max(0, Math.round(Number(body.cost) * 100) / 100) || null;
    const before = t.assignee;
    if (body.assignee !== undefined) t.assignee = await readAssignee(body.assignee, t);
    if (who(t.assignee) !== was.assignee) log(t, t.assignee ? `Assigned to ${who(t.assignee)}` : 'Unassigned');
    if (t.due !== was.due) log(t, t.due ? `Due ${t.due}` : 'No due date');
    if (t.priority !== was.priority) log(t, `Priority ${t.priority}`);
    t.updatedAt = nowIso();
    await save();
    if (who(t.assignee) !== who(before)) await tellAssignee(t);
    return json({ task: await shape(t) });
  }
  if (req.method === 'POST' && action === 'status') {
    if (!canMove(t)) return json({ error: 'Only the person it’s assigned to, a supervisor of the building, or an Admin/User can change this.' }, 403);
    const s = body.status;
    if (!MT_STATUS.includes(s)) return json({ error: 'Pick a status.' }, 400);
    if (s === 'cancelled' && !manage(t)) return json({ error: 'Only Admins and Users can cancel a task.' }, 403);
    if (s === t.status) return json({ task: await shape(t) });
    t.status = s;
    t.doneAt = s === 'done' ? nowIso() : null; t.doneBy = s === 'done' ? me.name : null;
    log(t, `Marked ${MT_WORD[s]}`);
    let next = null;
    if (s === 'done' && t.repeat && !tasks.some((x) => x.seriesId === t.seriesId && x.createdAt > t.createdAt)) {
      // Repeating: the next one is due one interval after this one was due (or after today if it had no date).
      next = { ...t, id: newId(), status: 'open', due: addInterval(t.due || londonDate(), t.repeat), doneAt: null, doneBy: null, media: [], cost: null,
        createdAt: nowIso(), updatedAt: nowIso(), reporterId: me.id, reporterName: me.name, log: [], damageId: null };
      log(next, `Repeats every ${t.repeat.every} ${t.repeat.every === 1 ? t.repeat.unit.replace(/s$/, '') : t.repeat.unit}: created when the last one was done`);
      tasks.push(next);
      log(t, `Next one due ${next.due}`);
    }
    await save();
    if (s === 'done') {
      const to = [...new Set([t.reporterId, ...(mm ? [] : await recipients(env, ['admin', 'user'], t.building, me.id))])].filter((x) => x && x !== me.id);
      await notify(env, ctx, to, { type: 'maintenance', title: `Maintenance done · ${t.label}`, body: `${t.title} — ${me.name}`, url: link(t), tag: `mt-${t.id}` });
    }
    return json({ task: await shape(t), next: next ? await shape(next) : null });
  }
  if (req.method === 'POST' && action === 'notes') {
    if (!canMove(t) && t.reporterId !== me.id) return json({ error: 'You can’t add notes to this task.' }, 403);
    const txt = text(body.text, 2000), media = (await mediaReady(env, (body.mediaIds || []).map(String), null, (m) => m.purpose === 'maintenance' && m.listingId === t.listingId && m.byId === me.id)).map((m) => m.id);
    if (!txt && !media.length) return json({ error: 'Write a note or add a photo.' }, 400);
    log(t, txt || `Added ${media.length} photo${media.length === 1 ? '' : 's'}/video${media.length === 1 ? '' : 's'}`, 'note');
    t.media = [...new Set([...(t.media || []), ...media])];
    await save();
    const to = [t.reporterId, t.assignee && t.assignee.type === 'user' ? t.assignee.id : null].filter((x) => x && x !== me.id);
    await notify(env, ctx, [...new Set(to)], { type: 'maintenance', title: `${me.name} added a note · ${t.label}`, body: (txt || t.title).slice(0, 140), url: link(t), tag: `mt-${t.id}` });
    return json({ task: await shape(t) });
  }
  if (req.method === 'DELETE' && !action) {
    if (!manage(t)) return json({ error: 'Only Admins and Users can delete tasks.' }, 403);
    tasks.splice(tasks.indexOf(t), 1);
    await save();
    return json({ ok: true });
  }
  return json({ error: 'Not supported' }, 405);
}

// The Cityscape guest assistant reports problems guests mention in messages ("no hot water"). It can only report:
// the task arrives open and unassigned, exactly like a cleaner's report, and Admins/Users of the building are told.
// If the same guest reports the same thing again while it's still open, it's added as a note instead of a new task.
// Off unless the ASSISTANT_API_KEY secret is set; the assistant sends it as "Authorization: Bearer <key>".
async function assistantMaintenanceApi(req, env, ctx) {
  const key = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ASSISTANT_API_KEY || !safeEqual(key, env.ASSISTANT_API_KEY)) return json({ error: 'unauthorised' }, 401);
  const body = await req.json().catch(() => ({}));
  const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
  const l = await listingInfo(env, ctx, String(body.listingId || ''));
  if (!l) return json({ error: 'Unknown or hidden listing.' }, 404);
  const title = text(body.title, 140);
  if (title.length < 3) return json({ error: 'Say what needs doing.' }, 400);
  const reservationId = text(body.reservationId, 40) || null;
  // Something a guest asked for (early luggage drop-off, a cot) rather than something broken.
  const guestRequest = body.kind === 'guest_request';
  const due = realDate(body.due) ? body.due : null;
  // Asked for by a team member in Slack rather than spotted in a guest message.
  const fromSlack = body.source === 'slack';
  const origin = fromSlack ? 'from Slack' : 'from a guest message';
  const bot = { id: 'assistant', name: 'Guest assistant (AI)' };
  const tasks = await loadList(env, 'maintenance');
  const link = (t) => `/?view=maintenance&task=${t.id}`;
  const same = reservationId && tasks.find((t) => t.reporterId === bot.id && t.reservationId === reservationId && t.listingId === l.id
    && !['done', 'cancelled'].includes(t.status) && normName(t.title) === normName(title) && (t.kind === 'guest_request') === guestRequest);
  if (same) {
    same.log = [...(same.log || []), { id: newId(), at: nowIso(), byId: bot.id, byName: bot.name, kind: 'note', text: text(body.details, 2000) || 'The guest mentioned this again.' }];
    // The guest changed the day: the task moves to it.
    const dueChanged = Boolean(due && due !== same.due);
    if (dueChanged) {
      same.log.push({ id: newId(), at: nowIso(), byId: bot.id, byName: bot.name, kind: 'event', text: `Due ${due} (was ${same.due || 'not set'})` });
      same.due = due;
    }
    same.log = same.log.slice(-200);
    same.updatedAt = nowIso();
    await saveList(env, 'maintenance', tasks.slice(-2000));
    return json({ task: { id: same.id, url: link(same), duplicate: true, due: same.due, dueChanged } });
  }
  const t = {
    id: newId(), title, details: text(body.details, 4000), listingId: l.id, label: l.label, building: l.building,
    priority: MT_PRIORITY.includes(body.priority) ? body.priority : 'normal', status: 'open', assignee: null, due, repeat: null, cost: null,
    reporterId: bot.id, reporterName: bot.name, createdAt: nowIso(), updatedAt: nowIso(), doneAt: null, doneBy: null,
    media: [], log: [{ id: newId(), at: nowIso(), byId: bot.id, byName: bot.name, kind: 'event', text: `${guestRequest ? 'Guest request' : 'Reported'} ${origin}` }],
    damageId: null, reservationId, ...(guestRequest ? { kind: 'guest_request' } : {}),
  };
  t.seriesId = t.id;
  tasks.push(t);
  await saveList(env, 'maintenance', tasks.slice(-2000));
  const urgent = t.priority === 'urgent' ? 'Urgent: ' : '';
  const heading = guestRequest ? `Guest request · ${t.label}` : `${urgent}Maintenance reported · ${t.label}`;
  await notify(env, ctx, await recipients(env, ['admin', 'user'], t.building, null), { type: 'maintenance', title: heading, body: `${t.title} — ${origin}`, url: link(t), tag: `mt-${t.id}` });
  console.log(`[maintenance] guest assistant ${guestRequest ? 'added guest request' : 'reported'} "${t.title}" at ${t.label}`);
  return json({ task: { id: t.id, url: link(t), duplicate: false, due: t.due, dueChanged: false } });
}

// Used by server.mjs before accepting or serving media files.
async function mediaAccess(env, ctx, me, body) {
  if (body.purpose === 'damage') return can(me, 'report_damage');
  if (body.purpose === 'maintenance') return true; // anyone can report an issue at a flat in their buildings (checked below)
  if (body.purpose === 'cleaning') {
    const list = await loadList(env, 'cleanings');
    const c = list.find((x) => x.id === body.ownerId);
    return Boolean(c && c.cleanerId === me.id && c.status === 'awaiting_video');
  }
  return false;
}
async function mediaViewAllowed(env, me, m) {
  if (m.byId === me.id) return true;
  if (!(can(me, 'view_cleaning') || can(me, 'manage_damage'))) return false;
  if (!m.building) return true;
  return inScope(me, m.building);
}

// ---------------------------------------------------------------- router
async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname;
  const ip = req.headers.get('CF-Connecting-IP') || 'x';

  if (p === '/health') return json({ ok: true, mock: config(env).mock });
  if (env.STORE) await loadPropOverrides(env);

  if (p.startsWith('/webhooks/keynest/') && req.method === 'POST') {
    if (!safeEqual(p.split('/')[3] || '', await webhookKeyFor(env, 'keynest'))) return new Response('unauthorised', { status: 401 });
    await keynestRecord(env, await req.json().catch(() => ({})));
    return new Response('ok');
  }

  if (p === '/api/integrations/maintenance' && req.method === 'POST') return assistantMaintenanceApi(req, env, ctx);

  if (p.startsWith('/webhooks/guesty/') && req.method === 'POST') {
    const expectedKey = (await hmac(await secretKey(env), 'webhook')).slice(0, 32);
    if (!safeEqual(p.split('/')[3] || '', expectedKey)) return new Response('unauthorised', { status: 401 });
    const body = await req.json().catch(() => ({}));
    const r = body.reservation || body.data?.reservation || body.data || {};
    const snap = memSnap?.snap || (await env.STORE.get('snapshot', 'json'));
    const outside = snap && r.checkOutDateLocalized && r.checkInDateLocalized && (r.checkOutDateLocalized < snap.from || r.checkInDateLocalized > snap.to);
    // KV is only written when bookings actually changed, so refreshing on every relevant event is cheap.
    if (!outside) ctx.waitUntil(refreshSnapshot(env, 'guesty ' + (body.event || 'update')).catch((e) => console.log('[webhook] refresh failed', e.message)));
    return new Response('ok');
  }

  if (p === '/login' && req.method === 'GET') return asset(req, 'login.html');
  if (['/styles.css', '/favicon.svg', '/favicon.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'].includes(p)) return asset(req, p.slice(1));
  if (p === '/favicon.ico') return asset(req, 'favicon.png');
  if (p === '/sw.js') { const r = asset(req, 'sw.js'); r.headers.set('Service-Worker-Allowed', '/'); r.headers.set('Cache-Control', 'no-cache'); return r; }

  if (p === '/login' && req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    const username = String((form && form.get('username')) || '').trim().toLowerCase();
    const tkey = ip + '|' + username, akey = 'acct|' + username;
    if (throttled(tkey) || throttled(ip) || throttled(akey, 20)) return redirect('/login?e=locked');
    const user = await login(env, username, (form && form.get('password')) || '');
    if (!user) { recordFail(tkey); recordFail(ip); recordFail(akey); console.log(`[login] failed for "${username.slice(0, 40)}"`); return redirect('/login?e=1&u=' + encodeURIComponent(username)); }
    return redirect('/', { 'Set-Cookie': `cs_session=${await makeSession(env, user)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
  }
  if (p === '/logout') return redirect('/login', { 'Set-Cookie': 'cs_session=; HttpOnly; Secure; Path=/; Max-Age=0' });

  const me = await sessionUser(env, cookie(req, 'cs_session'));
  if (!me) return p.startsWith('/api/') ? json({ error: 'Not signed in' }, 401) : redirect('/login');

  // Changes must come from this site (stops other websites acting with someone's session).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Blocked' }, 403);
  }
  const deny = () => json({ error: 'You don’t have permission for that. Ask an admin.' }, 403);

  if (p === '/' || p === '/index.html') {
    // Register with Guesty for instant updates the first time the app is opened on a new address.
    ctx.waitUntil(ensureWebhook(env, url.origin).catch((e) => console.log('[webhook] failed', e.message)));
    return asset(req, 'index.html');
  }
  if (p === '/app.js') return asset(req, 'app.js');
  if (p === '/api/me' && req.method === 'GET') return json({ user: publicUser(me), perms: PERMS });
  if (p === '/api/me/password' && req.method === 'POST') {
    if (me.isOwner) return json({ error: 'The owner login uses the APP_PASSWORD variable in Railway. Change it there.' }, 400);
    const body = await req.json().catch(() => ({}));
    const users = await loadUsers(env, true);
    const u = users.find((x) => x.id === me.id);
    if (!(await checkPassword(String(body.current || ''), u.pw))) return json({ error: 'Your current password isn’t right.' }, 400);
    const problem = passwordProblem(body.password);
    if (problem) return json({ error: problem }, 400);
    u.pw = await hashPassword(body.password);
    u.epoch = (u.epoch || 1) + 1;
    await saveUsers(env, users);
    return json({ ok: true }, 200, { 'Set-Cookie': `cs_session=${await makeSession(env, u)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
  }
  if (p === '/api/week') {
    if (!can(me, 'view_day') && !can(me, 'view_board')) return deny();
    const fresh = url.searchParams.get('refresh') === '1' && can(me, 'refresh');
    return json(await weekData(env, ctx, url.searchParams.get('date'), fresh, me));
  }
  if (p === '/api/properties') return can(me, 'view_properties') ? json(await propertiesData(env, ctx, me)) : deny();
  if (p.startsWith('/api/properties/') && req.method === 'PUT') return withLock('propertyOverrides', () => propertyEditApi(req, env, ctx, me, decodeURIComponent(p.split('/')[3] || '')));
  if (p.startsWith('/api/lockbox/') && req.method === 'PUT') return withLock('cleanings', () => lockboxCodeApi(req, env, ctx, me, decodeURIComponent(p.split('/')[3] || ''))); // cleanings also write codes
  if (p.startsWith('/api/lockbox/') && req.method === 'GET') {
    // The flat's current lockbox code, for its panel: cleaners check it every time they arrive.
    const l = await listingInfo(env, ctx, decodeURIComponent(p.split('/')[3] || ''));
    if (!l || !inScope(me, l.building) || !can(me, 'view_cleaning')) return deny();
    return json({ keyMode: l.keyMode, noCode: l.keyMode === 'lockbox' && l.lockboxNoCode, instruction: l.keyMode === 'lockbox' ? l.keyInstruction : '', lockbox: l.keyMode === 'lockbox' ? ((await env.STORE.get('lockboxCodes', 'json')) || {})[l.id] || null : null });
  }
  if (p === '/api/version') {
    const snap = await getSnapshot(env, ctx);
    const hook = config(env).mock ? 'preview' : (await env.STORE.get('webhook_url')) ? 'registered' : 'pending';
    return json({ version: dataVersion(snap), at: snap.at, webhook: hook });
  }
  const locked = (key, fn) => (req.method === 'GET' ? fn() : withLock(key, fn)); // reads never wait
  if (p === '/api/cleanings' || p.startsWith('/api/cleanings/')) {
    if (req.method === 'GET') return cleaningsApi(req, env, ctx, me, p.split('/'), url);
    const pre = await keyPrecheck(req.clone(), env, ctx, p.split('/')); // KeyNest can take seconds: ask it before queuing
    return withLock('cleanings', () => cleaningsApi(req, env, ctx, me, p.split('/'), url, pre));
  }
  if (p === '/api/keynest' || p.startsWith('/api/keynest/')) return locked('keynestLinks', () => keynestAdminApi(req, env, ctx, me, p.split('/')));
  if (p === '/api/damages' || p.startsWith('/api/damages/')) return locked('damages', () => damagesApi(req, env, ctx, me, p.split('/'), url));
  if (p === '/api/notifications' || p.startsWith('/api/notifications/')) return locked('notifications', () => notificationsApi(req, env, me, p.split('/')));
  if (p.startsWith('/api/push/')) return locked('pushSubs', () => pushApi(req, env, me, p.split('/')));
  if (p === '/api/assignments' || p === '/api/assignees') return locked('assignments', () => assignmentsApi(req, env, ctx, me, url));
  if (p === '/api/forum' || p.startsWith('/api/forum/')) return locked('forum', () => forumApi(req, env, ctx, me, p.split('/')));
  if (p === '/api/maintenance' || p.startsWith('/api/maintenance/')) return locked('maintenance', () => maintenanceApi(req, env, ctx, me, p.split('/'), url));
  // Internal checks used by server.mjs for uploads and playback (same-process only; not reachable from outside).
  if (p === '/api/internal/media-check' && req.headers.get('x-internal') === env.__INTERNAL_KEY) {
    const body = await req.json().catch(() => ({}));
    if (body.mode === 'upload') {
      if (!(await mediaAccess(env, ctx, me, body))) return json({ ok: false }, 403);
      let building = null;
      if (body.purpose === 'damage' || body.purpose === 'maintenance') { const l = await listingInfo(env, ctx, String(body.listingId || '')); if (!l || !inScope(me, l.building)) return json({ ok: false }, 403); building = l.building; }
      if (body.purpose === 'cleaning') { const c = (await loadList(env, 'cleanings')).find((x) => x.id === body.ownerId); building = c && c.building; }
      return json({ ok: true, user: { id: me.id, name: me.name }, building });
    }
    if (body.mode === 'admin') return json({ ok: can(me, 'download_backups'), user: { id: me.id, name: me.name } }); // backups
    if (body.mode === 'view') {
      const m = await env.STORE.get('media:' + body.id, 'json');
      return json({ ok: Boolean(m && (await mediaViewAllowed(env, me, m))), userId: me.id });
    }
    return json({ ok: false }, 400);
  }
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (!can(me, 'manage_users') && !limitedManager(me)) return deny();
    return (req.method === 'GET' ? usersApi : (...a) => withLock('users', () => usersApi(...a)))(req, env, ctx, me, p.split('/')[3] || null);
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(req, env, ctx) {
    try {
      if (!env.STORE) return new Response('Setup needed: add a KV namespace binding called STORE to this Worker.', { status: 500 });
      return await handle(req, env, ctx);
    } catch (err) {
      console.log('[error]', err.stack || err.message);
      if (new URL(req.url).pathname.startsWith('/api/')) return json({ error: err.userMessage || 'Something went wrong talking to Guesty. Try Refresh in a minute.' }, err.status || 500);
      return new Response('Server error', { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    if (!env.STORE) return;
    ctx.waitUntil((async () => {
      await refreshSnapshot(env, 'cron');
      await ensureWebhook(env, await env.STORE.get('origin')).catch(() => {});
    })());
  },
};
