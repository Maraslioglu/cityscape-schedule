// Complaints: link to stay + cleaning, notify cleaner and assignee, visibility, notes, CSV, photos, permissions.
import { readFileSync } from 'node:fs';
const B = 'http://localhost:8799', STORE = process.argv[2]; let n = 0;
const ck = async (u, p) => (await fetch(B + '/login', { method: 'POST', headers: { 'x-forwarded-for': `10.3.0.${++n}` }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const call = async (c, m, u, b) => { const r = await fetch(B + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: B }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (t, c, x) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) { fails++; console.log('      ', String(JSON.stringify(x)).slice(0, 400)); } };
const owner = await ck('owner', 'test');
for (const [name, u, role, b] of [['Sam Super', 'sam', 'supervisor', 'all'], ['Cleo Clean', 'cleo', 'cleaner', 'all'], ['Maria Clean', 'maria', 'cleaner', 'all'], ['Uma User', 'uma', 'user', 'all'], ['Nia Clean', 'nia', 'cleaner', ['42 Bell Street']], ['Sid Super', 'sid', 'supervisor', ['Sheridan Buildings']]])
  await call(owner, 'POST', '/api/users', { name, username: u, password: 'testpass1', role, buildings: b, email: '' });
const W = {}; for (const u of ['sam', 'cleo', 'maria', 'uma', 'nia', 'sid']) W[u] = await ck(u, 'testpass1');
const users = (await call(owner, 'GET', '/api/users')).body.users, uid = (x) => users.find((u) => u.username === x).id;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const buf = Buffer.alloc(100000, 7);
const upload = async (c, meta) => { const s = (await call(c, 'POST', '/api/media', { size: buf.length, name: meta.kind === 'photo' ? 'p.jpg' : 'v.mov', type: meta.kind === 'photo' ? 'image/jpeg' : 'video/quicktime', ...meta })); if (s.status !== 200) return s; await fetch(`${B}/api/media/${s.body.id}?offset=0`, { method: 'PUT', headers: { cookie: c, 'content-type': 'application/octet-stream', origin: B }, body: buf }); return s; };
const clean = async (who, listingId) => {
  const c = (await call(W[who], 'POST', '/api/cleanings/start', { listingId })).body.cleaning.id;
  await call(W[who], 'POST', `/api/cleanings/${c}/end`);
  for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(W[who], 'POST', `/api/cleanings/${c}/confirm`, { key: k });
  await call(W[who], 'POST', `/api/cleanings/${c}/checks-done`, { heldMs: 3100 });
  const v = await upload(W[who], { kind: 'video', purpose: 'cleaning', ownerId: c });
  const r = await call(W[who], 'POST', `/api/cleanings/${c}/complete`, { videoIds: [v.body.id] });
  return { id: c, status: r.body.cleaning && r.body.cleaning.status, video: v.body.id };
};
// A flat where a guest arrives today: today's cleaning is the one that got it ready. Not the lockbox (m4) or KeyNest (m5)
// sample flats: their cleans end at the key step, so whether this test could finish one depended on the day.
let F = null;
for (let i = 1; i <= 14 && !F; i++) { if (i === 4 || i === 5) continue; const r = await call(owner, 'GET', `/api/complaints/lookup?listingId=m${i}&date=${today}`); if (r.body.stay && r.body.stay.checkIn === today) F = 'm' + i; }
ok('found a flat with a guest arriving today', Boolean(F), F);
const FL = (await call(owner, 'GET', '/api/properties')).body.buildings.flatMap((b) => b.units).find((u) => u.id === F);
ok('Maria is assigned to it today', (await call(owner, 'PUT', '/api/assignments', { date: today, listingId: F, cleanerId: uid('maria') })).status === 200);
const c1 = await clean('cleo', F);
ok('Cleo finishes a cleaning at FL-7 (with a video)', c1.status === 'completed', c1);
// lookup
let r = await call(W.sam, 'GET', `/api/complaints/lookup?listingId=${F}&date=${today}`);
ok('lookup suggests Cleo’s cleaning, and shows Maria as assigned', r.status === 200 && r.body.suggestedCleaningId === c1.id && r.body.cleanings[0].assignedName === 'Maria Clean', r.body);
ok('cleaner can’t use the lookup', (await call(W.cleo, 'GET', `/api/complaints/lookup?listingId=${F}&date=${today}`)).status === 403);
ok('cleaner can’t log a complaint', (await call(W.cleo, 'POST', '/api/complaints', { listingId: F, title: 'Hair in shower' })).status === 403);
ok('too-short title refused', (await call(W.sam, 'POST', '/api/complaints', { listingId: F, title: 'a' })).status === 400);
// photo upload
ok('cleaner can’t upload complaint photos', (await upload(W.cleo, { kind: 'photo', purpose: 'complaint', listingId: F })).status === 403);
const ph = await upload(W.sam, { kind: 'photo', purpose: 'complaint', listingId: F });
ok('supervisor uploads the guest’s photo', ph.status === 200, ph);
r = await call(W.sam, 'POST', '/api/complaints', { listingId: F, date: today, title: 'Hair in the shower', details: 'Guest sent a photo', categories: ['Hair', 'Bathroom', 'Bogus'], severity: 'high', source: 'airbnb_review', mediaIds: [ph.body.id] });
const cp = r.body.complaint;
ok('supervisor logs it; the cleaning is tagged automatically', r.status === 200 && cp.cleaning && cp.cleaning.id === c1.id && cp.cleaning.cleanerName === 'Cleo Clean' && cp.cleaning.assignedName === 'Maria Clean', r);
ok('unknown categories are dropped, known kept', cp && JSON.stringify(cp.categories) === '["Hair","Bathroom"]', cp && cp.categories);
ok('the guest’s photo is attached', cp && cp.media.length === 1);
const notes = async (u) => (await call(W[u], 'GET', '/api/notifications')).body;
const nl = (x) => (x.notifications || x.items || x || []).filter((y) => y.type === 'complaint');
ok('Cleo (did the clean) gets “Complaint detected”', nl(await notes('cleo')).some((x) => x.title === 'Complaint detected · ' + FL.label && x.url === '/?view=complaints&complaint=' + cp.id), await notes('cleo'));
ok('Maria (assigned) gets it too', nl(await notes('maria')).length === 1);
ok('Sam (logged it) doesn’t notify himself', nl(await notes('sam')).length === 0);
// visibility
const seen = async (u) => (await call(W[u], 'GET', '/api/complaints')).body;
ok('Cleo sees the complaint about her cleaning, without compensation', (await seen('cleo')).complaints.length === 1 && (await seen('cleo')).seesAll === false);
ok('Nia (not involved, other building) sees nothing', (await seen('nia')).complaints.length === 0);
ok('Sid (supervisor, other building) sees nothing', (await seen('sid')).complaints.length === 0);
ok('Uma (User) sees it', (await seen('uma')).complaints.length === 1);
r = await call(W.cleo, 'GET', `/api/complaints/${cp.id}`);
ok('Cleo opens it: cleaning record with her video, read-only', r.status === 200 && r.body.complaint.cleaningRecord && r.body.complaint.cleaningRecord.media.length === 1 && r.body.complaint.canManage === false, r.body.complaint && { rec: !!r.body.complaint.cleaningRecord });
ok('Nia can’t open it', (await call(W.nia, 'GET', `/api/complaints/${cp.id}`)).status === 404);
const media = async (u, id) => (await fetch(`${B}/media/${id}/thumb`, { headers: { cookie: W[u] } })).status;
ok('Maria (assigned) may watch the cleaning video', ![401, 403].includes(await media('maria', c1.video)), await media('maria', c1.video));
ok('Cleo may see the guest’s photo', ![401, 403].includes(await media('cleo', ph.body.id)), await media('cleo', ph.body.id));
ok('Nia may not see the guest’s photo', [403, 404].includes(await media('nia', ph.body.id)), await media('nia', ph.body.id));
// notes and changes
ok('Cleo adds her side', (await call(W.cleo, 'POST', `/api/complaints/${cp.id}/notes`, { text: 'Shower was clean when I left, see video' })).status === 200);
ok('Sam is told about her reply', nl(await notes('sam')).length === 1, await notes('sam'));
ok('Nia can’t add notes', (await call(W.nia, 'POST', `/api/complaints/${cp.id}/notes`, { text: 'x' })).status === 404);
ok('Cleo can’t change the complaint', (await call(W.cleo, 'PUT', `/api/complaints/${cp.id}`, { status: 'dismissed' })).status === 403);
ok('bad compensation refused', (await call(W.sam, 'PUT', `/api/complaints/${cp.id}`, { compensation: 'lots' })).status === 400);
r = await call(W.sam, 'PUT', `/api/complaints/${cp.id}`, { status: 'resolved', upheld: true, compensation: 25, resolution: 'Refunded cleaning fee' });
ok('Sam resolves it as upheld with £25', r.status === 200 && r.body.complaint.status === 'resolved' && r.body.complaint.upheld === true && r.body.complaint.compensation === 25 && r.body.complaint.resolvedBy === 'Sam Super', r.body);
ok('Cleo still can’t see the compensation amount', (await seen('cleo')).complaints[0].compensation === null);
// relink to another cleaning: Maria cleans FL-7 again; link to hers
const c2 = await clean('maria', F);
r = await call(W.sam, 'PUT', `/api/complaints/${cp.id}`, { cleaningId: c2.id });
ok('relinking to Maria’s cleaning works', r.status === 200 && r.body.complaint.cleaning.cleanerName === 'Maria Clean', r.body);
ok('…Maria isn’t notified twice (she was already assigned)', nl(await notes('maria')).filter((x) => x.title.startsWith('Complaint detected')).length === 1);
ok('a cleaning from another flat can’t be linked', (await call(W.sam, 'PUT', `/api/complaints/${cp.id}`, { cleaningId: 'nope' })).status === 400);
// maintenance from complaint
r = await call(W.uma, 'POST', '/api/maintenance', { listingId: F, title: 'Shower drain slow', complaintId: cp.id, mediaIds: [ph.body.id] });
ok('a maintenance task made from it is linked back', r.status === 200 && (await call(W.uma, 'GET', `/api/complaints/${cp.id}`)).body.complaint.tasks.length === 1, r);
// categories
ok('cleaner can’t change categories', (await call(W.cleo, 'PUT', '/api/complaints/categories', { categories: ['X'] })).status === 403);
r = await call(W.sam, 'PUT', '/api/complaints/categories', { categories: ['Cleanliness', 'Hair', 'Hair', ' ', 'Late check-in'] });
ok('supervisor edits categories (duplicates and blanks removed)', r.status === 200 && JSON.stringify(r.body.categories) === '["Cleanliness","Hair","Late check-in"]', r.body);
// CSV
let csv = await fetch(B + '/api/complaints/export.csv', { headers: { cookie: W.uma } });
const text = await csv.text();
ok('User exports CSV with the complaint', csv.status === 200 && csv.headers.get('content-type').startsWith('text/csv') && text.split('\r\n').length === 2 && text.includes('Maria Clean') && text.includes('"25"') && text.includes('Hair; Bathroom'), text.slice(0, 300));
ok('cleaner can’t export', (await fetch(B + '/api/complaints/export.csv', { headers: { cookie: W.cleo } })).status === 403);
// permissions
const u = users.find((x) => x.username === 'uma');
await call(owner, 'PUT', '/api/users/' + u.id, { perms: { ...u.perms, view_complaints: false, manage_complaints: false } });
const uma2 = await ck('uma', 'testpass1');
ok('User without "See all complaints" sees none', (await call(uma2, 'GET', '/api/complaints')).body.complaints.length === 0);
ok('User without "Log & manage" can’t log', (await call(uma2, 'POST', '/api/complaints', { listingId: F, title: 'Noise at night' })).status === 403);
// stored for good
await new Promise((res) => setTimeout(res, 2500));
const store2 = JSON.parse(readFileSync(STORE, 'utf8'));
const saved = JSON.parse((store2.complaints || {}).v || '[]');
ok('complaints are saved in the data store (and so in the daily backups)', saved.length === 1 && saved[0].log.length >= 4, saved.length);
ok('delete works for a manager', (await call(W.sam, 'DELETE', `/api/complaints/${cp.id}`)).status === 200 && (await seen('sam')).complaints.length === 0);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
