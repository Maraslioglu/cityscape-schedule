// The guest assistant's read-only lookups: a flat's live status (who leaves or arrives on a day, the clean, keys) and
// open tasks with how they're going. Behind the assistant's key; never a code, a phone number or another guest's details.
const B = 'http://localhost:8799', KEY = 'test-assistant-key'; let n = 0;
const ck = async (u, p) => (await fetch(B + '/login', { method: 'POST', headers: { 'x-forwarded-for': `10.7.0.${++n}` }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const call = async (c, m, u, b) => { const r = await fetch(B + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: B }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const api = async (u, key = KEY) => { const r = await fetch(B + u, { headers: key ? { authorization: `Bearer ${key}` } : {} }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = async (u, b) => { const r = await fetch(B + u, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (t, c, x) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) { fails++; console.log('      ', String(JSON.stringify(x)).slice(0, 500)); } };
const day = (offset = 0) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + offset); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(t); };
const today = day(0), tomorrow = day(1);

// Who may ask
ok('no key: refused', (await api('/api/integrations/flat-status?listingId=m1', null)).status === 401);
ok('wrong key: refused', (await api('/api/integrations/flat-status?listingId=m1', 'nope')).status === 401);
ok('an unknown flat: 404', (await api('/api/integrations/flat-status?listingId=nope')).status === 404);

// A flat someone leaves today
let F = null, S = null;
for (let i = 1; i <= 14 && !F; i++) { const r = await api(`/api/integrations/flat-status?listingId=m${i}&dates=${today}`); if (r.body.days && r.body.days[0].departure) { F = 'm' + i; S = r.body; } }
ok('found a flat with a departure today', Boolean(F), S);
ok('the flat’s usual times and key arrangement', S && S.flat.checkInTime === '15:00' && S.flat.checkOutTime === '10:00' && 'keyMode' in S.flat, S && S.flat);
ok('the departure has a time', S && /^\d\d:\d\d$/.test(S.days[0].departure.time), S && S.days[0]);
ok('the clean after it: not started, nobody assigned yet', S && S.days[0].clean.afterCheckOut === today && S.days[0].clean.status === 'not_started' && S.days[0].clean.cleanerAssigned === false, S && S.days[0].clean);
const several = await api(`/api/integrations/flat-status?listingId=${F}&dates=${today},${tomorrow},nonsense,${today}`);
ok('several days at once (duplicates and nonsense dropped)', several.body.days.length === 2 && several.body.days[1].date === tomorrow, several.body.days && several.body.days.map((d) => d.date));
ok('no date: today', (await api(`/api/integrations/flat-status?listingId=${F}`)).body.days[0].date === today);
ok('nothing about the guests: no booking reference or names', !/HM\d|confirmationCode|guestsCount|"name"/.test(JSON.stringify(S)), S);

// The clean starts, then finishes
const owner = await ck('owner', 'test');
for (const [name, u] of [['Cleo Clean', 'cleo'], ['Maria Clean', 'maria']]) await call(owner, 'POST', '/api/users', { name, username: u, password: 'testpass1', role: 'cleaner', buildings: 'all', email: '' });
const users = (await call(owner, 'GET', '/api/users')).body.users, uid = (x) => users.find((u) => u.username === x).id;
const cleo = await ck('cleo', 'testpass1');
ok('Maria is assigned to it', (await call(owner, 'PUT', '/api/assignments', { date: today, listingId: F, cleanerId: uid('maria') })).status === 200);
ok('…and the assistant sees someone is assigned (not who)', (await api(`/api/integrations/flat-status?listingId=${F}&dates=${today}`)).body.days[0].clean.cleanerAssigned === true);
const c = (await call(cleo, 'POST', '/api/cleanings/start', { listingId: F })).body.cleaning;
let st = (await api(`/api/integrations/flat-status?listingId=${F}&dates=${today}`)).body.days[0].clean;
ok('Cleo starts: in progress, with the time it started', c && st.status === 'in_progress' && /^\d\d:\d\d$/.test(st.startedAt) && st.finishedAt === null, st);
const buf = Buffer.alloc(100000, 7);
await call(cleo, 'POST', `/api/cleanings/${c.id}/end`);
for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(cleo, 'POST', `/api/cleanings/${c.id}/confirm`, { key: k });
await call(cleo, 'POST', `/api/cleanings/${c.id}/checks-done`, { heldMs: 3100 });
const v = (await call(cleo, 'POST', '/api/media', { size: buf.length, name: 'v.mov', type: 'video/quicktime', kind: 'video', purpose: 'cleaning', ownerId: c.id })).body;
await fetch(`${B}/api/media/${v.id}?offset=0`, { method: 'PUT', headers: { cookie: cleo, 'content-type': 'application/octet-stream', origin: B }, body: buf });
const done = await call(cleo, 'POST', `/api/cleanings/${c.id}/complete`, { videoIds: [v.id] });
st = (await api(`/api/integrations/flat-status?listingId=${F}&dates=${today}`)).body.days[0].clean;
// A flat with a key step (KeyNest or lockbox) finishes at the key step; otherwise it's finished now.
if (done.body.cleaning && done.body.cleaning.status === 'completed') ok('Cleo finishes: finished, with the time and day', st.status === 'finished' && /^\d\d:\d\d$/.test(st.finishedAt) && st.finishedOn === today, st);
else ok('Cleo is at the key step: still in progress', st.status === 'in_progress', { st, done: done.body });

// A lockbox flat: the code is never passed on
ok('the owner sets FL-1’s lockbox code', (await call(owner, 'PUT', '/api/lockbox/m4', { code: '4821' })).status === 200);
const lb = await api('/api/integrations/flat-status?listingId=m4');
ok('the assistant is told it’s a lockbox flat, without the code', lb.body.flat.keyMode === 'lockbox' && !JSON.stringify(lb.body).includes('4821'), lb.body);

// This guest's own booking: its planned times (found by trying the sample bookings' ids)
let own = null;
for (let i = 0; i < 400 && !own; i++) { const r = await api(`/api/integrations/flat-status?listingId=m4&reservationId=m4-r${i}`); if (r.body.booking) own = r.body.booking; }
ok('the guest’s own booking: dates and planned times', own && /^\d{4}-\d\d-\d\d$/.test(own.checkIn) && 'plannedArrival' in own && 'plannedDeparture' in own, own);
ok('an id that isn’t a booking at this flat: none', (await api('/api/integrations/flat-status?listingId=m4&reservationId=m5-r10')).body.booking === null);

// Open tasks: due day, someone on it, and the team's latest note (codes and numbers taken out)
const t = (await post('/api/integrations/maintenance', { listingId: F, title: 'Shower drain blocked', reservationId: 'res-1', due: tomorrow, source: 'slack' })).body.task;
ok('the assistant reports a task', t && t.id, t);
ok('a manager adds a note with a time, a phone number and a code', (await call(owner, 'POST', `/api/maintenance/${t.id}/notes`, { text: 'Plumber booked 19:00-20:00, his number is 07700 900123, lockbox 4821, email bob@example.com' })).status === 200);
await post('/api/integrations/maintenance', { listingId: F, title: 'Shower drain blocked', reservationId: 'res-1', details: 'Guest says it is still blocked', source: 'slack' });
const open = (await api(`/api/integrations/maintenance?listingId=${F}`)).body.tasks.find((x) => x.id === t.id);
ok('due day, not assigned, and whose booking it is', open && open.due === tomorrow && open.assigned === false && open.reservationId === 'res-1', open);
ok('the latest note from the team, not the assistant’s own', open && open.latestNote && open.latestNote.text.startsWith('Plumber booked 19:00-20:00'), open && open.latestNote);
ok('…with the phone number, code and email taken out', open && !/07700|4821|bob@/.test(open.latestNote.text) && open.latestNote.text.includes('[phone]') && open.latestNote.text.includes('[number]') && open.latestNote.text.includes('[email]'), open && open.latestNote);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
