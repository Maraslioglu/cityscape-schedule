// Server fixes from the full audit (Oct 2026). Run against a fresh local copy on :8799 with sample data.
const B = 'http://localhost:8799'; let n = 0;
const ip = () => `10.77.${Math.floor(n / 200)}.${(n++ % 200) + 1}`;
const login = async (u, p, x) => fetch(B + '/login', { method: 'POST', headers: { 'x-forwarded-for': x || ip() }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' });
const ck = async (u, p) => { const c = (await login(u, p)).headers.get('set-cookie'); if (!c) throw new Error('login failed ' + u); return c.split(';')[0]; };
const call = async (c, m, u, b) => { const r = await fetch(B + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: B }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (t, c, x) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) { fails++; console.log('      ', String(JSON.stringify(x)).slice(0, 400)); } };
const owner = await ck('owner', 'test');
for (const [name, u, role, b] of [['Sam Super', 'sam', 'supervisor', 'all'], ['Sid Super', 'sid', 'supervisor', ['74 Queensway']], ['Cleo Clean', 'cleo', 'cleaner', 'all'], ['Maria Santos', 'maria', 'cleaner', 'all'], ['Uma User', 'uma', 'user', 'all'], ['Dave Doe', 'dave', 'cleaner', 'all']])
  await call(owner, 'POST', '/api/users', { name, username: u, password: 'testpass1', role, buildings: b, email: '' });
const W = {}; for (const u of ['sam', 'sid', 'cleo', 'maria', 'uma']) W[u] = await ck(u, 'testpass1');
const users = async () => (await call(owner, 'GET', '/api/users')).body.users, uid = async (x) => (await users()).find((u) => u.username === x).id;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const add = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
// users: no empty building list; password change doesn't lose an admin's change made at the same time
ok('a person can’t be given "only these buildings" with none ticked', (await call(owner, 'POST', '/api/users', { name: 'Tess', username: 'tess', password: 'testpass1', role: 'cleaner', buildings: [], email: '' })).status === 400);
const daveId = await uid('dave'), dave = await ck('dave', 'testpass1');
const [pw, deact] = await Promise.all([call(dave, 'POST', '/api/me/password', { current: 'testpass1', password: 'newpass123' }), (async () => { await new Promise((r) => setTimeout(r, 15)); return call(owner, 'PUT', `/api/users/${daveId}`, { active: false }); })()]);
const d2 = (await users()).find((u) => u.id === daveId);
ok('changing your own password while an admin deactivates you: the deactivation sticks', deact.status === 200 && d2.active === false, [pw.status, deact.status, d2.active]);
// sign-in: strangers can't lock the real person out; huge usernames are cut
for (let i = 0; i < 21; i++) await login('cleo', 'nope');
ok('after 21 wrong passwords from strangers, Cleo can still sign in from her own phone', (await login('cleo', 'testpass1')).headers.get('location') === '/');
const big = await login('x'.repeat(5000), 'nope');
ok('a 5000-character username is cut short in the redirect', (big.headers.get('location') || '').length < 300, (big.headers.get('location') || '').length);
// maintenance: reporters are rate-limited; open tasks are never pushed out
const boiler = (await call(W.uma, 'POST', '/api/maintenance', { listingId: 'm1', title: 'Boiler service', priority: 'high', due: add(today, 30), repeat: { every: 1, unit: 'years' } })).body.task;
let lastStatus = 0;
for (let i = 0; i < 31; i++) lastStatus = (await call(W.cleo, 'POST', '/api/maintenance', { listingId: 'm1', title: `spam ${i}` })).status;
ok('a cleaner reporting more than 30 issues in an hour is told to wait', lastStatus === 429, lastStatus);
ok('…and the open boiler task is still there', (await call(W.uma, 'GET', `/api/maintenance/${boiler.id}`)).status === 200);
// moves: only later, not into the past; a move cancelled by Guesty can be undone (checked with real stays in review-fixes-test)
const wk = (await call(owner, 'GET', '/api/week')).body, nx = (await call(owner, 'GET', `/api/week?date=${wk.nextWeek}`)).body;
const days = [...wk.days, ...nx.days];
const fut = days.find((d) => d.date > add(today, 1) && d.units.some((u) => u.checkOut && !u.keyMode));
const fu = fut.units.find((u) => u.checkOut && !u.keyMode);
ok('a clean can’t be moved to before the guests leave', (await call(W.sam, 'PUT', '/api/job-moves', { listingId: fu.listingId, from: fut.date, to: add(fut.date, -1), force: true })).status === 400);
ok('a clean can’t be moved into the past', (await call(W.sam, 'PUT', '/api/job-moves', { listingId: fu.listingId, from: fut.date, to: add(today, -1), force: true })).status === 400);
// assignments only on days with a clean
const empty = days.find((d) => d.date >= today && !d.units.some((u) => u.listingId === 'm9' && u.checkOut));
ok('a cleaner can’t be assigned to a flat on a day with nothing to clean', (await call(owner, 'PUT', '/api/assignments', { date: empty.date, listingId: 'm9', cleanerId: await uid('maria') })).status === 400);
// one cleaning on the go at a time
const outs = days.filter((d) => d.date === today)[0].units.filter((u) => u.checkOut && !u.keyMode);
const a1 = await call(W.maria, 'POST', '/api/cleanings/start', { listingId: outs[0].listingId, forDate: today });
const a2 = await call(W.maria, 'POST', '/api/cleanings/start', { listingId: 'm7' });
ok('a cleaner can’t start a second cleaning while one is in progress', a1.status === 200 && a2.status === 409 && /still cleaning/.test(a2.body.error), [a1.status, a2.status, a2.body.error]);
await call(W.maria, 'POST', `/api/cleanings/${a1.body.cleaning.id}/cancel`);
// lockbox: the "new" code must be new
await call(W.sam, 'PUT', '/api/lockbox/m4', { code: '4821' });
const lb = (await call(W.cleo, 'POST', '/api/cleanings/start', { listingId: 'm4' })).body.cleaning;
await call(W.cleo, 'POST', `/api/cleanings/${lb.id}/end`);
for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(W.cleo, 'POST', `/api/cleanings/${lb.id}/confirm`, { key: k });
await call(W.cleo, 'POST', `/api/cleanings/${lb.id}/checks-done`, { heldMs: 3100 });
const buf = Buffer.alloc(100000, 7), s = (await call(W.cleo, 'POST', '/api/media', { kind: 'video', purpose: 'cleaning', ownerId: lb.id, name: 'v.mov', size: buf.length, type: 'video/quicktime' })).body;
await fetch(`${B}/api/media/${s.id}?offset=0`, { method: 'PUT', headers: { cookie: W.cleo, 'content-type': 'application/octet-stream', origin: B }, body: buf });
await call(W.cleo, 'POST', `/api/cleanings/${lb.id}/complete`, { videoIds: [s.id] });
ok('re-entering the old lockbox code is refused', (await call(W.cleo, 'POST', `/api/cleanings/${lb.id}/key`, { code: '4821', confirmCode: '4821', keyReturned: true })).status === 400);
const done = await call(W.cleo, 'POST', `/api/cleanings/${lb.id}/key`, { code: '5937', confirmCode: '5937', keyReturned: true });
ok('…a new one is accepted', done.status === 200 && done.body.cleaning.status === 'completed', done);
// complaints: someone without cleaning access doesn't get the lockbox code; editing keeps the cleaning; CSV is formula-safe
const cp = (await call(W.sam, 'POST', '/api/complaints', { listingId: 'm4', date: today, title: '=HYPERLINK("http://x","click")', categories: [], severity: 'high', cleaningId: lb.id })).body.complaint;
ok('the complaint is tagged to Cleo’s cleaning', cp && cp.cleaning && cp.cleaning.id === lb.id, cp && cp.cleaning);
const ua = (await users()).find((u) => u.username === 'uma');
await call(owner, 'PUT', `/api/users/${ua.id}`, { perms: { ...ua.perms, view_cleaning: false } });
const uma2 = await ck('uma', 'testpass1');
const det = (await call(uma2, 'GET', `/api/complaints/${cp.id}`)).body.complaint;
ok('someone without "See cleaning times, videos & lockbox codes" gets no lockbox code in a complaint', det && det.cleaningRecord && !(det.cleaningRecord.key && det.cleaningRecord.key.code) && !(det.cleaningRecord.media || []).length, det && det.cleaningRecord);
await call(W.sam, 'POST', `/api/cleanings/${lb.id}/reset`, { reason: 'test' });
const ed = await call(W.sam, 'PUT', `/api/complaints/${cp.id}`, { upheld: true, cleaningId: lb.id });
ok('editing a complaint whose cleaning was since reset keeps the link', ed.status === 200 && ed.body.complaint.cleaning && ed.body.complaint.cleaning.id === lb.id, ed);
const csv = await (await fetch(B + '/api/complaints/export.csv', { headers: { cookie: W.sam } })).text();
ok('CSV export neutralises formulas from guest text', csv.includes('"\'=HYPERLINK') && !csv.includes('"=HYPERLINK'), csv.split('\r\n')[1]);
ok('a supervisor limited to some buildings can’t change the company-wide categories', (await call(W.sid, 'PUT', '/api/complaints/categories', { categories: ['X'] })).status === 403);
ok('…one covering every building can', (await call(W.sam, 'PUT', '/api/complaints/categories', { categories: ['Cleanliness', 'Hair'] })).status === 200);
// push: a deactivated person's phone stops getting notifications (subscription removed)
const r0 = await call(W.maria, 'POST', '/api/push/subscribe', { endpoint: 'https://example.invalid/push/1', keys: { p256dh: 'BOrA', auth: 'xyz' } });
const mid = await uid('maria');
await call(owner, 'PUT', `/api/users/${mid}`, { active: false });
const r1 = await call(W.maria, 'GET', '/api/me');
ok('a deactivated person is signed out', r1.status === 401, [r0.status, r1.status]);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
