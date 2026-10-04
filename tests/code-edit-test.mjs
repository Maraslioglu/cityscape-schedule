// Edit code on Properties: Admin/User/supervisor/cleaner (in their buildings); property editing: Admin/User/supervisor only.
import { readFileSync } from 'node:fs';
const BASE = 'http://localhost:8799', LOG = process.argv[2];
let n = 0; const ip = () => `10.8.0.${++n}`;
const ck = async (u, p) => (await fetch(BASE + '/login', { method: 'POST', headers: { 'x-forwarded-for': ip() }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const call = async (c, m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: BASE }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) { fails++; if (extra !== undefined) console.log('      ', JSON.stringify(extra).slice(0, 300)); } };
const owner = await ck('owner', 'test');
await call(owner, 'POST', '/api/users', { name: 'Nia Clean', username: 'nia', password: 'testpass1', role: 'cleaner', buildings: ['42 Bell Street'], email: '' });
await call(owner, 'POST', '/api/users', { name: 'Sid Super', username: 'sid', password: 'testpass1', role: 'supervisor', buildings: ['74 Queensway'], email: '' });
const who = { admin: owner, user: await ck('uma', 'testpass1'), supervisor: await ck('sam', 'testpass1'), cleaner: await ck('cleo', 'testpass1') };
const nia = await ck('nia', 'testpass1'), sid = await ck('sid', 'testpass1');
const LB = 'm4', KN = 'm5';
for (const [k, c] of Object.entries(who)) {
  const p = (await call(c, 'GET', '/api/properties')).body;
  ok(`${k}: Properties says canEdit=${k !== 'cleaner'}, canEditCode=true`, p.canEdit === (k !== 'cleaner') && p.canEditCode === true, { canEdit: p.canEdit, canEditCode: p.canEditCode });
}
const code = (c) => call(c, 'GET', `/api/lockbox/${LB}`);
let i = 0;
for (const [k, c] of Object.entries(who)) {
  const nc = String(4000 + ++i * 111);
  const r = await call(c, 'PUT', `/api/lockbox/${LB}`, { code: nc });
  const now = (await code(owner)).body.lockbox || {};
  ok(`${k} can edit the code (→ ${nc})`, r.status === 200 && now.code === nc && now.edited === true, [r, now]);
}
const cleoName = (await code(owner)).body.lockbox.by;
ok('the code shows who changed it', cleoName === 'Cleo Clean', cleoName);
ok('cleaner sees the new code in the flat panel too', (await code(who.cleaner)).body.lockbox.code === '4444');
ok('3 numbers refused', (await call(who.cleaner, 'PUT', `/api/lockbox/${LB}`, { code: '123' })).status === 400);
ok('letters refused', (await call(who.cleaner, 'PUT', `/api/lockbox/${LB}`, { code: '12a4' })).status === 400);
ok('5 numbers refused', (await call(who.cleaner, 'PUT', `/api/lockbox/${LB}`, { code: '12345' })).status === 400);
ok('a KeyNest flat has no code to edit', (await call(owner, 'PUT', `/api/lockbox/${KN}`, { code: '1234' })).status === 400);
ok('cleaner outside that building can’t', (await call(nia, 'PUT', `/api/lockbox/${LB}`, { code: '9999' })).status === 403);
ok('supervisor outside that building can’t', (await call(sid, 'PUT', `/api/lockbox/${LB}`, { code: '9999' })).status === 403);
ok('…and the code is unchanged', (await code(owner)).body.lockbox.code === '4444');
// property editing
const edit = (c, fields) => call(c, 'PUT', `/api/properties/${LB}`, { confirmed: true, fields });
ok('cleaner can’t edit the property', (await edit(who.cleaner, { label: 'Nope' })).status === 403);
ok('cleaner can’t reset the property', (await call(who.cleaner, 'PUT', `/api/properties/${LB}`, { confirmed: true, reset: true })).status === 403);
let r = await edit(who.supervisor, { label: 'FL-1 Sup' });
const lbl = (await call(owner, 'GET', '/api/properties')).body.buildings.flatMap((b) => b.units).find((u) => u.id === LB);
ok('supervisor can edit the property', r.status === 200 && lbl.label === 'FL-1 Sup' && lbl.editedBy === 'Sam Super', [r, lbl && lbl.label]);
ok('supervisor sees Guesty’s details in the editor', Boolean((await call(who.supervisor, 'GET', '/api/properties')).body.buildings.flatMap((b) => b.units).find((u) => u.id === LB).guesty));
ok('supervisor outside that building can’t edit it', (await edit(sid, { label: 'Nope' })).status === 403);
ok('supervisor can reset it to Guesty', (await call(who.supervisor, 'PUT', `/api/properties/${LB}`, { confirmed: true, reset: true })).status === 200);
ok('user can still edit', (await edit(who.user, { address: '25 Old Gloucester Street, London' })).status === 200);
await call(owner, 'PUT', `/api/properties/${LB}`, { confirmed: true, reset: true });
const log = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('[lockbox]'));
ok('code changes are logged, without the code itself', log.length >= 4 && !log.some((l) => /\d{4}/.test(l.replace(/\d{4}-\d\d-\d\d/g, ''))), log.slice(-2));
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
