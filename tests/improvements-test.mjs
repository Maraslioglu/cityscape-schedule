// October 2026 improvements: a finished upload survives a reload (GET /api/media?owner=), damage reports list the
// tasks made from them, no assigning on days that have passed. Fresh local copy on :8799 with sample data.
const B = 'http://localhost:8799'; let n = 0;
const ck = async (u, p) => { const r = await fetch(B + '/login', { method: 'POST', headers: { 'x-forwarded-for': `10.61.0.${++n}` }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' }); const c = r.headers.get('set-cookie'); if (!c) throw new Error('login failed ' + u); return c.split(';')[0]; };
const call = async (c, m, u, b) => { const r = await fetch(B + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: B }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (t, c, x) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) { fails++; console.log('      ', String(JSON.stringify(x)).slice(0, 300)); } };
const owner = await ck('owner', 'test');
for (const [name, username, role] of [['Cleo Clean', 'cleo', 'cleaner'], ['Sam Super', 'sam', 'supervisor']]) await call(owner, 'POST', '/api/users', { name, username, password: 'testpass1', role, buildings: 'all', email: '' });
const cleo = await ck('cleo', 'testpass1'), sam = await ck('sam', 'testpass1');
const users = (await call(owner, 'GET', '/api/users')).body.users, uid = (x) => users.find((u) => u.username === x).id;
const wk = (await call(owner, 'GET', '/api/week')).body;
const today = wk.today, day = wk.days.find((d) => d.date === today);
const flat = day.units.find((u) => u.checkOut && !u.keyMode);

// 1. A finished upload is found again after a reload, by the cleaner only, while the cleaning waits for its video.
let r = await call(cleo, 'POST', '/api/cleanings/start', { listingId: flat.listingId, forDate: today });
const id = r.body.cleaning && r.body.cleaning.id;
await call(cleo, 'POST', `/api/cleanings/${id}/end`);
for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(cleo, 'POST', `/api/cleanings/${id}/confirm`, { key: k });
await call(cleo, 'POST', `/api/cleanings/${id}/checks-done`, { heldMs: 3100 });
const bytes = Buffer.alloc(150000, 7);
const up = (await call(cleo, 'POST', '/api/media', { kind: 'video', purpose: 'cleaning', ownerId: id, name: 'walk.mov', size: bytes.length, type: 'video/quicktime' })).body;
await fetch(`${B}/api/media/${up.id}?offset=0`, { method: 'PUT', headers: { cookie: cleo, 'content-type': 'application/octet-stream', origin: B }, body: bytes });
r = await call(cleo, 'GET', `/api/media?owner=${id}`);
ok('the cleaner gets the uploaded video back for their cleaning', r.status === 200 && r.body.media.some((m) => m.id === up.id && m.kind === 'video' && m.size === bytes.length), r);
ok('someone else can’t list it', (await call(sam, 'GET', `/api/media?owner=${id}`)).status === 403);
ok('nobody signed in can’t list it', (await fetch(`${B}/api/media?owner=${id}`)).status === 401);
r = await call(cleo, 'POST', `/api/cleanings/${id}/complete`, { videoIds: [up.id] });
ok('the restored video finishes the cleaning', r.status === 200 && r.body.cleaning && r.body.cleaning.status === 'completed', r);
ok('once finished there’s nothing to restore', (await call(cleo, 'GET', `/api/media?owner=${id}`)).status === 403);

// 2. A damage report lists the tasks made from it.
const photo = (await call(cleo, 'POST', '/api/media', { kind: 'photo', purpose: 'damage', listingId: flat.listingId, name: 'p.jpg', size: 4000, type: 'image/jpeg' })).body;
await fetch(`${B}/api/media/${photo.id}?offset=0`, { method: 'PUT', headers: { cookie: cleo, 'content-type': 'application/octet-stream', origin: B }, body: Buffer.alloc(4000, 9) });
const dmg = (await call(cleo, 'POST', '/api/damages', { listingId: flat.listingId, description: 'Chipped sink', mediaIds: [photo.id] })).body.damage;
let list = (await call(owner, 'GET', `/api/damages?listingId=${flat.listingId}`)).body.damages;
ok('a new damage report has no tasks yet', list.find((d) => d.id === dmg.id).tasks.length === 0, list);
await call(owner, 'POST', '/api/maintenance', { listingId: flat.listingId, title: 'Fix: Chipped sink', damageId: dmg.id });
list = (await call(owner, 'GET', `/api/damages?listingId=${flat.listingId}`)).body.damages;
const tasks = list.find((d) => d.id === dmg.id).tasks;
ok('the task made from it shows on the report', tasks.length === 1 && tasks[0].title === 'Fix: Chipped sink' && tasks[0].status === 'open', tasks);
const cleoSees = (await call(cleo, 'GET', `/api/damages?listingId=${flat.listingId}`)).body.damages.find((d) => d.id === dmg.id);
ok('a cleaner who can’t see that task doesn’t see it on the report either', cleoSees && cleoSees.tasks.length === 0, cleoSees && cleoSees.tasks);

// 3. No assigning on a day that has passed (taking one off still works).
const past = wk.days.map((d) => d.date).concat((await call(owner, 'GET', `/api/week?date=${wk.prevWeek}`)).body.days.map((d) => d.date)).filter((d) => d < today).sort().pop();
r = await call(owner, 'PUT', '/api/assignments', { listingId: flat.listingId, date: past, cleanerId: uid('cleo') });
ok('assigning on a day that has passed is refused', r.status === 400, r);
ok('taking an assignment off a past day works', (await call(owner, 'PUT', '/api/assignments', { listingId: flat.listingId, date: past, cleanerId: null })).status === 200);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
