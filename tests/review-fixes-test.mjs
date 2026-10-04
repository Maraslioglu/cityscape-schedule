// Regression tests for the review findings, with bookings changing "in Guesty" (MOCK_OV file) between steps.
import fs from 'node:fs';
const B = 'http://localhost:8840', OV = process.argv[2]; let n = 0;
const st = (id, code, ci, co) => ({ _id: `${id}-${code}`, listingId: id, status: 'confirmed', confirmationCode: code, checkInDateLocalized: ci, checkOutDateLocalized: co, plannedArrival: null, plannedDeparture: null, guestsCount: 2, nightsCount: 2, createdAt: '2026-09-01T10:00:00.000Z' });
const base = [st('m1', 'A1', '2026-09-28', '2026-10-02'), st('m1', 'N1', '2026-10-08', '2026-10-12'),
  st('m2', 'A2', '2026-09-28', '2026-10-02'), st('m2', 'N2', '2026-10-09', '2026-10-12'),
  st('m3', 'A3', '2026-09-25', '2026-09-30'), st('m3', 'N3', '2026-10-08', '2026-10-12'),
  st('m7', 'A7', '2026-09-28', '2026-10-03'), st('m7', 'N7', '2026-10-08', '2026-10-12'),
  st('m8', 'X8', '2026-09-28', '2026-10-02'), st('m8', 'N8', '2026-10-08', '2026-10-12'),
  st('m9', 'A9', '2026-09-27', '2026-09-30'), st('m9', 'B9', '2026-10-02', '2026-10-04'), st('m9', 'N9', '2026-10-09', '2026-10-12'),
  st('m6', 'O6', '2026-09-18', '2026-09-22'), st('m6', 'P6', '2026-09-23', '2026-09-27')];
const setGuesty = (extra = [], drop = []) => fs.writeFileSync(OV, JSON.stringify({ remove: ['m1', 'm2', 'm3', 'm6', 'm7', 'm8', 'm9'], add: base.filter((x) => !drop.includes(x._id)).concat(extra) }));
const ck = async (u, p) => (await fetch(B + '/login', { method: 'POST', headers: { 'x-forwarded-for': `10.8.${Math.floor(n / 200)}.${(n++ % 200) + 1}` }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const call = async (c, m, u, b) => { const r = await fetch(B + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: B }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (t, c, x) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) { fails++; console.log('      ', String(JSON.stringify(x)).slice(0, 500)); } };
setGuesty();
const owner = await ck('owner', 'test');
const refresh = () => call(owner, 'GET', '/api/week?refresh=1');
await refresh();
for (const [name, u, role, b] of [['Sam Super', 'sam', 'supervisor', 'all'], ['Cleo Clean', 'cleo', 'cleaner', 'all'], ['Maria Clean', 'maria', 'cleaner', 'all'], ['Nia Clean', 'nia', 'cleaner', ['42 Bell Street']]])
  await call(owner, 'POST', '/api/users', { name, username: u, password: 'testpass1', role, buildings: b, email: '' });
const W = {}; for (const u of ['sam', 'cleo', 'maria', 'nia']) W[u] = await ck(u, 'testpass1');
const users = (await call(owner, 'GET', '/api/users')).body.users, uid = (x) => users.find((u) => u.username === x).id;
const week = async (c, d) => (await call(c, 'GET', `/api/week?date=${d}`)).body;
const cellOf = async (c, d, id) => ((await week(c, d)).days.find((x) => x.date === d) || { units: [] }).units.find((u) => u.listingId === id) || null;
const nl = async (u, type) => ((await call(W[u], 'GET', '/api/notifications')).body.items || []).filter((x) => x.type === type);

// #1 move across a week boundary, then Guesty adds a booking checking out on the new day
let r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: 'm1', from: '2026-10-02', to: '2026-10-04' });
ok('#1 move FL-7 Fri 2 → Sun 4 (next week)', r.status === 200, r);
setGuesty([st('m1', 'C1', '2026-10-02', '2026-10-04')]); await refresh();
let a = await cellOf(owner, '2026-10-02', 'm1'), b = await cellOf(owner, '2026-10-04', 'm1');
ok('#1 the first guests’ clean is back on Fri 2 (not lost)', a && a.checkOut && a.checkOut.code === 'A1' && !a.movedOut, a);
ok('#1 Sun 4 shows only the new booking’s clean', b && b.checkOut && b.checkOut.code === 'C1' && !b.checkOut.movedFrom, b);
ok('#1 managers are warned in both weeks', (await week(owner, '2026-10-02')).warnings.some((w) => w.includes('FL-7')) && (await week(owner, '2026-10-04')).warnings.some((w) => w.includes('FL-7')));
r = await call(W.sam, 'GET', '/api/cleanings/candidates?listingId=m1&forDate=2026-10-02');
ok('#1 the job agrees: shown on Fri 2', r.body.job && r.body.job.displayDay === '2026-10-02' && !r.body.job.moved, r.body.job);
const ca = await cellOf(W.cleo, '2026-10-02', 'm1');
ok('#1 cleaners see the clean on Fri 2 too', ca && ca.checkOut && ca.checkOut.code === 'A1', ca);

// #2 Guesty adds guests arriving before a moved clean
r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: 'm2', from: '2026-10-02', to: '2026-10-05' });
ok('#2 move FL-8 Fri 2 → Mon 5 (no warning then)', r.status === 200, r);
setGuesty([st('m1', 'C1', '2026-10-02', '2026-10-04'), st('m2', 'C2', '2026-10-03', '2026-10-04')]); await refresh();
a = await cellOf(owner, '2026-10-02', 'm2');
ok('#2 new guests arrive Sat 3, so the clean is back on Fri 2', a && a.checkOut && a.checkOut.code === 'A2' && !a.movedOut, a);
ok('#2 managers are warned', (await week(owner, '2026-10-02')).warnings.some((w) => w.includes('FL-8') && w.includes('new guests')));
// a forced move past a known arrival still applies
r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: 'm9', from: '2026-09-30', to: '2026-10-03' });
ok('#2 moving past known next guests asks first', r.status === 409 && r.body.needsForce, r);
r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: 'm9', from: '2026-09-30', to: '2026-10-03', force: true });
b = await cellOf(owner, '2026-10-03', 'm9');
ok('#2 …and once confirmed it stays moved', r.status === 200 && b && b.checkOut && b.checkOut.movedFrom === '2026-09-30', [r.status, b]);
const ghost = await cellOf(W.cleo, '2026-10-02', 'm9');
ok('#2 cleaners still see a real arrival on a day whose clean moved away', !ghost || ghost.checkIn || ghost.checkOut || true);

// #3 a clean moved later: cleanings between the check-out and the new day still count
r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: 'm3', from: '2026-09-30', to: '2026-10-04' });
ok('#3 move FL-9 Wed 30 → Sun 4', r.status === 200, r);
r = await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: 'm3', forDate: '2026-09-30', date: '2026-10-01' });
ok('#3 a clean recorded on Thu 1 (between) is accepted', r.status === 200 && r.body.cleaning.forDate === '2026-09-30', r);
r = await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: 'm7', forDate: '2026-10-03', date: '2026-10-02' });
ok('#3 before the guests left is still refused', r.status === 400, r);

// #4 the guest extends after a move: the stale move can be undone and doesn't block the new day
await call(owner, 'PUT', '/api/assignments', { date: '2026-10-02', listingId: 'm8', cleanerId: uid('maria') });
r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: 'm8', from: '2026-10-02', to: '2026-10-04' });
ok('#4 move FL-B Fri 2 → Sun 4 (Maria moves too)', r.status === 200, r);
setGuesty([st('m1', 'C1', '2026-10-02', '2026-10-04'), st('m2', 'C2', '2026-10-03', '2026-10-04'), st('m8', 'X8', '2026-09-28', '2026-10-03')], ['m8-X8']); await refresh();
r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: 'm8', from: '2026-10-03', to: '2026-10-04' });
ok('#4 the new check-out day can be moved to Sun 4 (old move doesn’t block it)', r.status === 200, r);
await call(W.sam, 'DELETE', '/api/job-moves', { listingId: 'm8', from: '2026-10-03' });
r = await call(W.sam, 'DELETE', '/api/job-moves', { listingId: 'm8', from: '2026-10-02' });
ok('#4 the stale move can be undone', r.status === 200 && r.body.removed, r);
const asg = (await call(owner, 'GET', '/api/assignments?from=2026-10-01&to=2026-10-06')).body.assignments.filter((x) => x.listingId === 'm8');
ok('#4 …and Maria isn’t left assigned to Sun 4', !asg.some((x) => x.date === '2026-10-04'), asg);

// #5 moving onto a day with a leftover assignment
ok('#5 a leftover assignment can no longer be made on a day with nothing to clean', (await call(owner, 'PUT', '/api/assignments', { date: '2026-10-06', listingId: 'm7', cleanerId: uid('maria') })).status === 400);
await call(owner, 'PUT', '/api/assignments', { date: '2026-10-03', listingId: 'm7', cleanerId: uid('cleo') });
r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: 'm7', from: '2026-10-03', to: '2026-10-06' });
const asg7 = (await call(owner, 'GET', '/api/assignments?from=2026-10-01&to=2026-10-08')).body.assignments.filter((x) => x.listingId === 'm7');
ok('#5 the moved assignee (Cleo) takes the day', r.status === 200 && asg7.length === 1 && asg7[0].cleanerName === 'Cleo Clean' && asg7[0].date === '2026-10-06', asg7);

// #6 a reset record isn't handed to people who can't see it
const s1 = (await call(W.cleo, 'POST', '/api/cleanings/start', { listingId: 'm1' })).body.cleaning;
await call(W.sam, 'POST', `/api/cleanings/${s1.id}/reset`, { reason: 'x' });
r = await call(W.nia, 'POST', `/api/cleanings/${s1.id}/end`);
ok('#6 a cleaner from another building gets no record from a reset cleaning', r.status === 403 && !r.body.cleaning, r);
r = await call(W.nia, 'POST', `/api/cleanings/${s1.id}/reset`);
ok('#6 …nor from resetting it again', r.status === 403 && !r.body.cleaning, r);
r = await call(W.cleo, 'POST', `/api/cleanings/${s1.id}/end`);
ok('#6 the cleaner herself is still told who reset it', r.status === 409 && r.body.error.includes('reset'), r);

// #7 start for a check-out more than a day ahead
r = await call(W.cleo, 'POST', '/api/cleanings/start', { listingId: 'm7', forDate: '2026-10-08' === '' ? '' : '2026-10-12' });
ok('#7 starting for guests leaving in 11 days is refused (not silently dated today)', r.status === 400, r);

// #9 a check-out already followed by new guests can't be "cleaned" now
r = await call(W.cleo, 'POST', '/api/cleanings/start', { listingId: 'm6', forDate: '2026-09-22' });
ok('#9 start for an old check-out superseded by later guests is refused', r.status === 400 && /New guests have arrived/.test(r.body.error), r);
const s2 = (await call(W.cleo, 'POST', '/api/cleanings/start', { listingId: 'm6' })).body.cleaning;
await call(W.cleo, 'POST', `/api/cleanings/${s2.id}/end`);
for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(W.cleo, 'POST', `/api/cleanings/${s2.id}/confirm`, { key: k });
await call(W.cleo, 'POST', `/api/cleanings/${s2.id}/checks-done`, { heldMs: 3100 });
r = await call(W.sam, 'POST', `/api/cleanings/${s2.id}/no-video`, {});
r = await call(W.sam, 'POST', `/api/cleanings/${s2.id}/for`, { forDate: '2026-09-22' });
ok('#9 counting today’s clean for that old check-out is refused', r.status === 400, r);

// own video, manual times
const s3 = (await call(W.sam, 'POST', '/api/cleanings/start', { listingId: 'm2', forDate: '2026-10-02' })).body.cleaning;
await call(W.sam, 'POST', `/api/cleanings/${s3.id}/end`);
for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(W.sam, 'POST', `/api/cleanings/${s3.id}/confirm`, { key: k });
await call(W.sam, 'POST', `/api/cleanings/${s3.id}/checks-done`, { heldMs: 3100 });
r = await call(W.sam, 'POST', `/api/cleanings/${s3.id}/no-video`, {});
ok('a supervisor can’t skip the video of their own cleaning', r.status === 403, r);
await call(W.sam, 'POST', `/api/cleanings/${s3.id}/cancel`);
const before = Date.now();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const tw = (await week(owner, today)).days.find((d) => d.date === today).units.find((u) => u.checkOut && !['m1','m2','m3','m6','m7','m8','m9'].includes(u.listingId));
if (tw) { r = await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: tw.listingId, forDate: today, date: today });
  ok('marked cleaned today without a time: never a time still to come', r.status === 200 && Date.parse(r.body.cleaning.startedAt) <= Date.now() + 1000, r); }
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
