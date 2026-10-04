// Safety fixes + KeyNest override, against a local copy (sample data, stand-in KeyNest on :8798).
const BASE = 'http://localhost:8799', KN = 'http://127.0.0.1:8798';
let n = 0; const ip = () => `10.0.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
const login = async (u, p, xff) => (await fetch(BASE + '/login', { method: 'POST', headers: { 'x-forwarded-for': xff || ip() }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' }));
const ck = async (u, p) => (await login(u, p)).headers.get('set-cookie').split(';')[0];
const call = async (c, m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: BASE }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let pass = 0, fail = 0; const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra).slice(0, 300)); };
const setKey = (q) => fetch(`${KN}/set?${new URLSearchParams(q)}`);
const owner = await ck('owner', 'test');
const mk = (name, username, role, buildings) => call(owner, 'POST', '/api/users', { name, username, password: 'testpass1', role, buildings, email: '' });
await mk('Sam Super', 'sam', 'supervisor', 'all'); await mk('Sid Super', 'sid', 'supervisor', ['Sheridan Buildings']);
await mk('Uma User', 'uma', 'user', 'all'); await mk('Cleo Clean', 'cleo', 'cleaner', 'all'); await mk('Maria Clean', 'maria', 'cleaner', 'all');
const [sam, sid, uma, cleo, maria] = await Promise.all(['sam', 'sid', 'uma', 'cleo', 'maria'].map((u) => ck(u, 'testpass1')));
const users = (await call(owner, 'GET', '/api/users')).body.users, uid = (x) => users.find((u) => u.username === x).id;
await call(owner, 'PUT', '/api/keynest/links', { confirmed: true, changes: [{ listingId: 'm5', keyId: 'K100' }] });
async function upload(c, meta, bytes = 200000) {
  const buf = Buffer.alloc(bytes, 7);
  const s = (await call(c, 'POST', '/api/media', { kind: 'video', name: 'v.mov', size: buf.length, type: 'video/quicktime', ...meta })).body;
  if (!s.id) return { error: s };
  const r = await fetch(`${BASE}/api/media/${s.id}?offset=0`, { method: 'PUT', headers: { cookie: c, 'content-type': 'application/octet-stream', origin: BASE }, body: buf });
  return { id: s.id, status: r.status };
}
async function toVideo(c, listingId) {
  const r = await call(c, 'POST', '/api/cleanings/start', { listingId });
  const id = r.body.cleaning.id;
  await call(c, 'POST', `/api/cleanings/${id}/end`);
  for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(c, 'POST', `/api/cleanings/${id}/confirm`, { key: k });
  await call(c, 'POST', `/api/cleanings/${id}/checks-done`, { heldMs: 3100 });
  return id;
}
const getC = async (c, id) => (await call(c, 'GET', `/api/cleanings/${id}`)).body.cleaning;

// --- evidence must belong to the cleaning
const a = await toVideo(cleo, 'm1'), b = await toVideo(maria, 'm2');
const va = await upload(cleo, { purpose: 'cleaning', ownerId: a });
ok('cleaner uploads their walkthrough', va.status === 200, va);
let r = await call(maria, 'POST', `/api/cleanings/${b}/complete`, { videoIds: [va.id] });
ok('someone else’s video can’t finish a cleaning', r.status === 400, r);
const vb = await upload(maria, { purpose: 'cleaning', ownerId: b });
r = await call(maria, 'POST', `/api/cleanings/${b}/complete`, { videoIds: [vb.id] });
ok('their own video can', r.status === 200 && r.body.cleaning.status === 'completed', r.body);
r = await call(cleo, 'POST', `/api/cleanings/${a}/complete`, { videoIds: [va.id] });
ok('cleaning A completes with its own video', r.status === 200, r.body);
// --- damage / maintenance evidence
const dm = await upload(cleo, { purpose: 'damage', listingId: 'm1', kind: 'photo' });
ok('damage by someone else’s photo refused', (await call(maria, 'POST', '/api/damages', { listingId: 'm1', description: 'Broken lamp', mediaIds: [dm.id] })).status === 400);
ok('damage with own photo works', (await call(cleo, 'POST', '/api/damages', { listingId: 'm1', description: 'Broken lamp', mediaIds: [dm.id] })).status === 200);
// --- KeyNest: override only for Admin/User/supervisor, in their buildings; recorded; cleaner told
await setKey({ status: 'With customer' });
const k = await toVideo(cleo, 'm5');
const vk = await upload(cleo, { purpose: 'cleaning', ownerId: k });
r = await call(cleo, 'POST', `/api/cleanings/${k}/complete`, { videoIds: [vk.id] });
ok('KeyNest cleaning waits for the key', r.body.cleaning.status === 'awaiting_key', r.body);
ok('key not back: can’t complete normally', (await call(cleo, 'POST', `/api/cleanings/${k}/key`, {})).status === 409);
ok('the cleaner can’t override', (await call(cleo, 'POST', `/api/cleanings/${k}/key`, { override: true })).status === 403);
ok('a supervisor outside that building can’t', (await call(sid, 'POST', `/api/cleanings/${k}/key`, { override: true })).status === 403);
ok('another cleaner can’t touch it', (await call(maria, 'POST', `/api/cleanings/${k}/key`, { override: true })).status === 403);
ok('supervisor sees the live KeyNest status of that cleaning', (await call(sam, 'GET', `/api/cleanings/${k}/key-status`)).status === 200);
r = await call(sam, 'POST', `/api/cleanings/${k}/key`, { override: true, note: 'Key with concierge' });
ok('a supervisor overrides and completes', r.status === 200 && r.body.cleaning.status === 'completed' && r.body.cleaning.key.overridden && r.body.cleaning.key.overriddenBy === 'Sam Super' && r.body.cleaning.completedBy === 'Sam Super' && r.body.cleaning.key.note === 'Key with concierge', r.body.cleaning);
const cn = ((await call(cleo, 'GET', '/api/notifications')).body.items || []).find((x) => /Sam Super finished your cleaning/.test(x.title));
ok('the cleaner is told', cn && /overridden/.test(cn.body), cn);
// --- a User finishes someone's lockbox cleaning with the new code
const l = await toVideo(maria, 'm4');
const vl = await upload(maria, { purpose: 'cleaning', ownerId: l });
await call(maria, 'POST', `/api/cleanings/${l}/complete`, { videoIds: [vl.id] });
r = await call(uma, 'POST', `/api/cleanings/${l}/key`, { code: '4821', confirmCode: '4821', keyReturned: true });
ok('a User finishes a lockbox cleaning with the code', r.status === 200 && r.body.cleaning.completedBy === 'Uma User' && r.body.cleaning.key.code === '4821', r.body);
// --- no lost updates: a slow KeyNest check doesn't undo someone else's change saved meanwhile
await setKey({ status: 'In Store', delay: 2500 });
const k2 = await toVideo(cleo, 'm5');
const vk2 = await upload(cleo, { purpose: 'cleaning', ownerId: k2 });
await call(cleo, 'POST', `/api/cleanings/${k2}/complete`, { videoIds: [vk2.id] });
const slow = call(cleo, 'POST', `/api/cleanings/${k2}/key`, {});
await new Promise((res) => setTimeout(res, 400));
const other = await call(maria, 'POST', '/api/cleanings/start', { listingId: 'm7' });
const done = await slow;
await setKey({ delay: 0 });
const mc = await getC(maria, other.body.cleaning.id);
ok('slow KeyNest step completes', done.status === 200 && done.body.cleaning.status === 'completed', done.body);
ok('…and Maria’s cleaning started meanwhile is still there', mc && mc.status === 'in_progress', mc);
// --- login: after 20 wrong passwords on one account, the addresses that guessed are stopped, but not the real person
const guessers = []; for (let i = 0; i < 20; i++) { const x = ip(); guessers.push(x); await login('uma', 'wrong-password', x); }
r = await login('uma', 'wrong-password', guessers[3]);
ok('a guessing address is paused on that account', /e=locked/.test(r.headers.get('location') || ''), r.headers.get('location'));
r = await login('uma', 'testpass1');
ok('…while the real person signing in from their own phone still gets in', r.headers.get('location') === '/', r.headers.get('location'));
r = await login('cleo', 'testpass1');
ok('other accounts unaffected', r.headers.get('location') === '/', r.headers.get('location'));
// --- supervisors can't manage someone who reaches beyond them
r = await call(sam, 'POST', '/api/users', { name: 'Cal Clean', username: 'cal', password: 'testpass1', role: 'cleaner', buildings: ['25 Old Gloucester Street'], email: '' });
const cal = r.body.user.id;
await call(owner, 'PUT', `/api/users/${uid('sam')}`, { buildings: ['Sheridan Buildings'] });
const sam2 = await ck('sam', 'testpass1');
r = await call(sam2, 'PUT', `/api/users/${cal}`, { password: 'newpass12' });
ok('after an admin narrows a supervisor, they can’t reset someone with other buildings', r.status === 403 && /buildings or access/.test(r.body.error), r);
// --- request size limit
r = await fetch(BASE + '/api/forum', { method: 'POST', headers: { cookie: cleo, 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024) }) });
ok('2 MB request refused', r.status === 413, r.status);
// --- status and backups
r = await fetch(BASE + '/status'); const st = await r.json();
ok('/status is OK', r.status === 200 && st.ok && st.backups >= 1, st);
r = await call(owner, 'GET', '/api/admin/backups');
ok('Admin lists backups', r.status === 200 && r.body.backups.length >= 1, r);
const dl = await fetch(BASE + '/api/admin/backups/now', { headers: { cookie: owner } });
const bj = await dl.json().catch(() => null);
ok('Admin downloads today’s data (valid JSON with the users)', dl.status === 200 && bj && bj.users && /attachment/.test(dl.headers.get('content-disposition')), dl.status);
ok('a User can’t', (await call(uma, 'GET', '/api/admin/backups')).status >= 400);
console.log(`${pass} passed, ${fail} failed`);
