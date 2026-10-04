// Job tools: forDate on start, reset, finish without video, count for a check-out, mark cleaned on a date, move a clean.
const B = 'http://localhost:8799'; let n = 0;
const ck = async (u, p) => (await fetch(B + '/login', { method: 'POST', headers: { 'x-forwarded-for': `10.6.${Math.floor(n / 200)}.${(n++ % 200) + 1}` }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const call = async (c, m, u, b) => { const r = await fetch(B + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: B }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (t, c, x) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) { fails++; console.log('      ', String(JSON.stringify(x)).slice(0, 500)); } };
const owner = await ck('owner', 'test');
for (const [name, u, role, b] of [['Sam Super', 'sam', 'supervisor', 'all'], ['Cleo Clean', 'cleo', 'cleaner', 'all'], ['Maria Clean', 'maria', 'cleaner', 'all'], ['Uma User', 'uma', 'user', 'all']])
  await call(owner, 'POST', '/api/users', { name, username: u, password: 'testpass1', role, buildings: b, email: '' });
const W = {}; for (const u of ['sam', 'cleo', 'maria', 'uma']) W[u] = await ck(u, 'testpass1');
const users = (await call(owner, 'GET', '/api/users')).body.users, uid = (x) => users.find((u) => u.username === x).id;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const add = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const wk = (await call(owner, 'GET', '/api/week')).body, wkPrev = (await call(owner, 'GET', `/api/week?date=${wk.prevWeek}`)).body, wkNext = (await call(owner, 'GET', `/api/week?date=${wk.nextWeek}`)).body;
const days = [...wkPrev.days, ...wk.days, ...wkNext.days];
const unitsOn = (d) => (days.find((x) => x.date === d) || { units: [] }).units;
const noKey = (u) => !u.keyMode;
// a flat with a same-day turnover yesterday (the FL1 situation) and no key step
const yest = add(today, -1);
const T = unitsOn(yest).find((u) => u.checkOut && u.checkIn && noKey(u)) || unitsOn(yest).find((u) => u.checkOut && noKey(u));
ok(`found a flat checked out yesterday (${T && T.label})`, Boolean(T), unitsOn(yest).map((u) => [u.label, u.keyMode, !!u.checkOut, !!u.checkIn]));
const buf = Buffer.alloc(100000, 7);
const steps = async (who, id, upto = 'complete') => {
  await call(W[who], 'POST', `/api/cleanings/${id}/end`);
  for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(W[who], 'POST', `/api/cleanings/${id}/confirm`, { key: k });
  await call(W[who], 'POST', `/api/cleanings/${id}/checks-done`, { heldMs: 3100 });
  if (upto === 'video') return;
  const s = (await call(W[who], 'POST', '/api/media', { kind: 'video', purpose: 'cleaning', ownerId: id, name: 'v.mov', size: buf.length, type: 'video/quicktime' })).body;
  await fetch(`${B}/api/media/${s.id}?offset=0`, { method: 'PUT', headers: { cookie: W[who], 'content-type': 'application/octet-stream', origin: B }, body: buf });
  return (await call(W[who], 'POST', `/api/cleanings/${id}/complete`, { videoIds: [s.id] })).body.cleaning;
};
// 1. forDate: starting from yesterday's panel counts for yesterday's check-out, even though it's started today
let r = await call(W.cleo, 'POST', '/api/cleanings/start', { listingId: T.listingId, forDate: yest });
ok('start with forDate = yesterday’s check-out', r.status === 200 && r.body.cleaning.forDate === yest && r.body.cleaning.date === today, r);
const c1 = r.body.cleaning.id;
const done1 = await steps('cleo', c1);
ok('…and it completes', done1 && done1.status === 'completed', done1);
r = await call(owner, 'GET', `/api/cleanings?from=${yest}&to=${yest}`);
ok('fetching yesterday includes it (counted for yesterday, done today)', r.body.cleanings.some((c) => c.id === c1), r.body.cleanings.map((c) => [c.label, c.date, c.forDate]));
r = await call(W.maria, 'POST', '/api/cleanings/start', { listingId: T.listingId, forDate: yest });
ok('a second cleaning for the same check-out is refused', r.status === 409 && /already cleaned/.test(r.body.error), r);
r = await call(W.maria, 'POST', '/api/cleanings/start', { listingId: T.listingId, forDate: add(today, -40) });
ok('a forDate with no check-out is ignored (old cleanings unaffected)', r.status === 200 && r.body.cleaning.forDate === null, r);
await call(W.maria, 'POST', `/api/cleanings/${r.body.cleaning.id}/cancel`);
// 2. reset
ok('the cleaner can’t reset her finished cleaning', (await call(W.cleo, 'POST', `/api/cleanings/${c1}/reset`, {})).status === 403);
r = await call(W.sam, 'GET', `/api/cleanings/${c1}`);
ok('supervisor sees what a reset affects', r.body.resetInfo && r.body.resetInfo.linkedComplaints === 0 && r.body.resetInfo.guestyEligible === false, r.body.resetInfo);
r = await call(W.sam, 'POST', `/api/cleanings/${c1}/reset`, { reason: 'Hair left in the shower', guesty: true });
ok('supervisor resets it, with a reason', r.status === 200 && r.body.cleaning.status === 'cancelled' && r.body.cleaning.reset.byName === 'Sam Super' && r.body.cleaning.reset.from === 'completed' && r.body.cleaning.reset.reason === 'Hair left in the shower', r);
ok('reset twice is harmless', (await call(W.sam, 'POST', `/api/cleanings/${c1}/reset`, {})).status === 200);
const nl = async (u, type) => ((await call(W[u], 'GET', '/api/notifications')).body.items || []).filter((x) => x.type === type);
ok('Cleo is told her cleaning was reset', (await nl('cleo', 'reset')).some((x) => x.body.includes('Hair left in the shower')), await nl('cleo', 'reset'));
ok('Admins/Users are told when a supervisor resets a finished cleaning', (await nl('uma', 'reset')).length === 1);
r = await call(W.maria, 'POST', '/api/cleanings/start', { listingId: T.listingId, forDate: yest });
ok('after a reset, the check-out can be cleaned again', r.status === 200 && r.body.cleaning.forDate === yest, r);
const c2 = r.body.cleaning.id;
r = await call(W.uma, 'POST', `/api/cleanings/${c2}/cancel`, { reason: 'Wrong flat' });
ok('a User can stop someone else’s cleaning (recorded as a reset)', r.status === 200 && r.body.cleaning.reset && r.body.cleaning.reset.from === 'in_progress', r);
r = await call(W.maria, 'POST', `/api/cleanings/${c2}/end`);
ok('the cleaner’s next step after a reset says who reset it', r.status === 409 && /Uma User reset this cleaning/.test(r.body.error), r);
// 3. finish without the video
r = await call(W.maria, 'POST', '/api/cleanings/start', { listingId: T.listingId, forDate: yest });
const c3 = r.body.cleaning.id; await steps('maria', c3, 'video');
ok('the cleaner can’t skip her own video', (await call(W.maria, 'POST', `/api/cleanings/${c3}/no-video`, {})).status === 403);
r = await call(W.sam, 'POST', `/api/cleanings/${c3}/no-video`, { reason: 'Phone won’t upload' });
ok('supervisor finishes it without the video (no key step → completed)', r.status === 200 && r.body.cleaning.status === 'completed' && r.body.cleaning.videoSkipped.byName === 'Sam Super' && r.body.cleaning.completedBy === 'Sam Super', r);
ok('Maria is told', (await nl('maria', 'cleaned')).some((x) => x.title.includes('skipped the video')));
await call(W.sam, 'POST', `/api/cleanings/${c3}/reset`, { reason: 'test' });
// 4. count an existing cleaning for a check-out (the FL1 fix): a cleaning logged today with no forDate
r = await call(W.cleo, 'POST', '/api/cleanings/start', { listingId: T.listingId });
const c4 = r.body.cleaning.id; await steps('cleo', c4);
r = await call(W.sam, 'GET', `/api/cleanings/candidates?listingId=${T.listingId}&forDate=${yest}`);
ok('candidates for yesterday’s check-out include today’s un-dated cleaning', r.status === 200 && !r.body.counted && r.body.candidates.some((c) => c.id === c4), r.body);
ok('cleaner can’t ask for candidates', (await call(W.cleo, 'GET', `/api/cleanings/candidates?listingId=${T.listingId}&forDate=${yest}`)).status === 403);
r = await call(W.sam, 'POST', `/api/cleanings/${c4}/for`, { forDate: yest });
ok('supervisor counts it for yesterday', r.status === 200 && r.body.cleaning.forDate === yest && r.body.cleaning.forBy.byName === 'Sam Super', r);
r = await call(W.sam, 'GET', `/api/cleanings/candidates?listingId=${T.listingId}&forDate=${yest}`);
ok('…now it shows as counted', r.body.counted && r.body.counted.id === c4, r.body);
r = await call(W.sam, 'POST', `/api/cleanings/${c4}/for`, { forDate: add(today, -40) });
ok('counting for a day with no check-out is refused', r.status === 400, r);
// 5. mark cleaned on a date (no video)
const two = add(today, -2), three = add(today, -3), four = add(today, -4);
const M = [two, three, four].map((d) => [d, unitsOn(d).find((u) => u.checkOut && u.listingId !== T.listingId && !u.checkIn)]).find(([, u]) => u)
  || [two, three, four].map((d) => [d, unitsOn(d).find((u) => u.checkOut && u.listingId !== T.listingId)]).find(([, u]) => u);
const [mDay, MU] = M;
ok(`found a check-out a few days ago (${MU.label} on ${mDay})`, Boolean(MU));
const mc = await call(W.sam, 'GET', `/api/cleanings/candidates?listingId=${MU.listingId}&forDate=${mDay}`);
const nxt = mc.body.job.nextIn;
ok('cleaner can’t mark cleaned', (await call(W.cleo, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: mDay, date: mDay })).status === 403);
ok('a future day is refused', (await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: mDay, date: add(today, 1) })).status === 400);
ok('a day before the guests left is refused', (await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: mDay, date: add(mDay, -1) })).status === 400);
if (nxt && nxt.date < today) ok('a day after the next guests arrived is refused', (await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: mDay, date: add(nxt.date, 1) })).status === 400);
ok('a finish before the start is refused', (await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: mDay, date: mDay, start: '14:00', end: '13:00' })).status === 400);
ok('no check-out that day is refused', (await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: add(today, -40), date: add(today, -40) })).status === 400);
r = await call(W.sam, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: mDay, date: mDay, start: '12:00', end: '13:30', cleanerId: uid('cleo'), note: 'Done from the paper sheet', guesty: true });
ok('supervisor marks it cleaned that day, by Cleo, 12:00–13:30', r.status === 200 && r.body.cleaning.status === 'completed' && r.body.cleaning.manual.byName === 'Sam Super' && r.body.cleaning.cleanerName === 'Cleo Clean' && r.body.cleaning.forDate === mDay && r.body.cleaning.manual.durationKnown, r);
const m1 = r.body.cleaning;
ok('times stored in London time', new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(m1.startedAt)) === '12:00', m1.startedAt);
ok('Guesty not touched for sample data', m1.guesty === 'skipped');
ok('Cleo is told it was recorded', (await nl('cleo', 'cleaned')).some((x) => x.title.includes('recorded your clean')));
ok('a second mark for the same check-out is refused', (await call(W.uma, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: mDay, date: mDay })).status === 409);
r = await call(W.uma, 'POST', `/api/cleanings/${m1.id}/reset`, { reason: 'wrong flat' });
ok('a User can reset a marked-cleaned record', r.status === 200 && r.body.cleaning.reset.from === 'completed', r);
r = await call(W.uma, 'POST', '/api/cleanings/manual', { listingId: MU.listingId, forDate: mDay, date: mDay, cleanerId: null });
ok('…then mark it again, time and cleaner not recorded', r.status === 200 && r.body.cleaning.cleanerName === 'Not recorded' && r.body.cleaning.manual.timeKnown === false, r);
// 6. move a clean to another day
const wkDays = days.map((d) => d.date);
const future = days.filter((d) => d.date > today && d.date <= add(today, 10));
let MV = null;
for (const d of future) { const u = d.units.find((x) => x.checkOut && !x.checkIn && noKey(x)); if (u) { const nd = add(d.date, 1); if (!unitsOn(nd).some((x) => x.listingId === u.listingId && x.checkOut)) { MV = { u, from: d.date, to: nd }; break; } } }
ok(`found a future check-out to move (${MV && MV.u.label} ${MV && MV.from} → ${MV && MV.to})`, Boolean(MV));
ok('cleaner can’t move a clean', (await call(W.cleo, 'PUT', '/api/job-moves', { listingId: MV.u.listingId, from: MV.from, to: MV.to })).status === 403);
await call(owner, 'PUT', '/api/assignments', { date: MV.from, listingId: MV.u.listingId, cleanerId: uid('maria') });
const job = (await call(W.sam, 'GET', `/api/cleanings/candidates?listingId=${MV.u.listingId}&forDate=${MV.from}`)).body.job;
r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: MV.u.listingId, from: MV.from, to: MV.to, note: 'Guest asked for a late check-out' });
const needsForce = job.nextIn && MV.to > job.nextIn.date;
if (needsForce) { ok('moving after the next arrival asks first', r.status === 409 && r.body.needsForce, r); r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: MV.u.listingId, from: MV.from, to: MV.to, note: 'Guest asked for a late check-out', force: true }); }
ok('supervisor moves it a day later', r.status === 200 && r.body.move && r.body.move.to === MV.to, r);
const weekOf = async (c, d) => (await call(c, 'GET', `/api/week?date=${d}`));
for (const [who, c] of [['owner', owner], ['supervisor', W.sam], ['cleaner', W.cleo]]) {
  const a = await weekOf(c, MV.from), b = await weekOf(c, MV.to);
  ok(`${who}: /api/week works for both weeks`, a.status === 200 && b.status === 200, [a.status, b.status, a.body.error, b.body.error]);
  const onTo = (b.body.days.find((d) => d.date === MV.to) || { units: [] }).units.find((x) => x.listingId === MV.u.listingId);
  const onFrom = (a.body.days.find((d) => d.date === MV.from) || { units: [] }).units.find((x) => x.listingId === MV.u.listingId);
  ok(`${who}: the clean shows on the new day, marked moved`, onTo && onTo.checkOut && onTo.checkOut.movedFrom === MV.from, onTo);
  ok(`${who}: the original day says where it went`, onFrom && !onFrom.checkOut && onFrom.movedOut && onFrom.movedOut.to === MV.to, onFrom);
}
const asg = (await call(owner, 'GET', `/api/assignments?from=${MV.from}&to=${MV.to}`)).body.assignments.filter((a) => a.listingId === MV.u.listingId);
ok('Maria’s assignment moved with it', asg.length === 1 && asg[0].date === MV.to && asg[0].cleanerName === 'Maria Clean', asg);
ok('Maria is told it moved', (await nl('maria', 'moved')).some((x) => x.title.includes('moved to')));
r = await call(W.sam, 'GET', `/api/cleanings/candidates?listingId=${MV.u.listingId}&forDate=${MV.from}`);
ok('the job knows it’s shown on the new day', r.body.job.displayDay === MV.to, r.body.job);
const back = await call(W.sam, 'DELETE', '/api/job-moves', { listingId: MV.u.listingId, from: MV.from });
const a2 = (await weekOf(owner, MV.from)).body.days.find((d) => d.date === MV.from).units.find((x) => x.listingId === MV.u.listingId);
ok('moving it back restores the original day', back.status === 200 && a2 && a2.checkOut && !a2.checkOut.movedFrom, [back, a2]);
const asg2 = (await call(owner, 'GET', `/api/assignments?from=${MV.from}&to=${MV.to}`)).body.assignments.filter((a) => a.listingId === MV.u.listingId);
ok('…and the assignment came back too', asg2.length === 1 && asg2[0].date === MV.from, asg2);
const clash = days.find((d) => d.date > MV.from && d.units.some((x) => x.listingId === MV.u.listingId && x.checkOut));
if (clash) ok('moving onto a day with its own check-out is refused', (await call(W.sam, 'PUT', '/api/job-moves', { listingId: MV.u.listingId, from: MV.from, to: clash.date, force: true })).status === (clash.date <= add(MV.from, 14) ? 409 : 400));
ok('more than 2 weeks away is refused', (await call(W.sam, 'PUT', '/api/job-moves', { listingId: MV.u.listingId, from: MV.from, to: add(MV.from, 20), force: true })).status === 400);
// across a week boundary: last day of this week → first of next
const last = wk.weekEnd, first = wk.nextWeek;
const X = unitsOn(last).find((u) => u.checkOut && !unitsOn(first).some((y) => y.listingId === u.listingId && y.checkOut));
if (X) {
  r = await call(W.sam, 'PUT', '/api/job-moves', { listingId: X.listingId, from: last, to: first, force: true });
  const a = await weekOf(W.cleo, last), b = await weekOf(W.cleo, first), ao = await weekOf(owner, last);
  ok('a move across a week boundary works (no errors for anyone)', r.status === 200 && a.status === 200 && b.status === 200 && ao.status === 200, [r, a.status, b.status]);
  ok('…shows on next week’s first day', b.body.days[0].units.some((u) => u.listingId === X.listingId && u.checkOut && u.checkOut.movedFrom === last));
  await call(W.sam, 'DELETE', '/api/job-moves', { listingId: X.listingId, from: last });
}
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
