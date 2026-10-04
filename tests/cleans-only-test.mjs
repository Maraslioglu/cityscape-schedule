// Supervisors and cleaners see only check-outs and same-day turnovers; Admin and User see everything.
const BASE = 'http://localhost:8799';
let n = 0; const ip = () => `10.9.0.${++n}`;
const ck = async (u, p) => (await fetch(BASE + '/login', { method: 'POST', headers: { 'x-forwarded-for': ip() }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const call = async (c, m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: BASE }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) { fails++; if (extra !== undefined) console.log('      ', JSON.stringify(extra).slice(0, 400)); } };
const owner = await ck('owner', 'test');
await call(owner, 'POST', '/api/users', { name: 'Uma User', username: 'uma', password: 'testpass1', role: 'user', buildings: 'all', email: '' });
const who = { admin: owner, user: await ck('uma', 'testpass1'), supervisor: await ck('sam', 'testpass1'), cleaner: await ck('cleo', 'testpass1') };
const weeks = {};
for (const [k, c] of Object.entries(who)) { const r = await call(c, 'GET', '/api/week'); ok(`${k} loads the week`, r.status === 200, r); weeks[k] = r.body; }
const arrOnly = (w) => w.days.reduce((s, d) => s + d.units.filter((u) => u.checkIn && !u.checkOut).length, 0);
const outs = (w) => w.days.reduce((s, d) => s + d.units.filter((u) => u.checkOut).length, 0);
const turns = (w) => w.days.reduce((s, d) => s + d.units.filter((u) => u.checkOut && u.checkIn).length, 0);
const boardArr = (w) => w.board.flatMap((b) => b.units).flatMap((u) => u.cells).filter((c) => (c.in && !c.out) || (c.occ && !c.out)).length;
const boardIdle = (w) => w.board.flatMap((b) => b.units).filter((u) => !u.cells.some((c) => c.out)).length;
console.log('arrival-only units  admin', arrOnly(weeks.admin), '· user', arrOnly(weeks.user), '· supervisor', arrOnly(weeks.supervisor), '· cleaner', arrOnly(weeks.cleaner));
ok('admin still sees arrivals', arrOnly(weeks.admin) > 0 && !weeks.admin.cleansOnly);
ok('user still sees arrivals', arrOnly(weeks.user) === arrOnly(weeks.admin) && !weeks.user.cleansOnly);
for (const k of ['supervisor', 'cleaner']) {
  const w = weeks[k];
  ok(`${k}: no arrival-only flats in the day lists`, arrOnly(w) === 0);
  ok(`${k}: flagged cleans-only`, w.cleansOnly === true);
  ok(`${k}: day counts match (in = same-day)`, w.days.every((d) => d.arrivals === d.turnovers && d.cleans === d.units.length));
  ok(`${k}: board has no arrivals or stays without a check-out`, boardArr(w) === 0, w.board);
  ok(`${k}: board has no flats without a check-out this week`, boardIdle(w) === 0);
  ok(`${k}: totals.checkIns = same-day`, w.totals.checkIns === w.totals.turnovers);
}
// the supervisor covers every building, so they keep every check-out and turnover the admin sees
ok('supervisor keeps every check-out', outs(weeks.supervisor) === outs(weeks.admin), [outs(weeks.supervisor), outs(weeks.admin)]);
ok('supervisor keeps every same-day turnover, with its arrival time', turns(weeks.supervisor) === turns(weeks.admin));
ok('supervisor board keeps turnover marks', weeks.supervisor.board.flatMap((b) => b.units).flatMap((u) => u.cells).some((c) => c.out && c.in));
ok('supervisor totals.checkOuts unchanged', weeks.supervisor.totals.checkOuts === weeks.admin.totals.checkOuts);
const next = await call(who.cleaner, 'GET', `/api/week?date=${weeks.admin.nextWeek}`);
ok('cleaner: next week filtered too', next.status === 200 && arrOnly(next.body) === 0 && next.body.cleansOnly === true);
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
