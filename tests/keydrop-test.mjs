// Auto-finish when KeyNest reports the key handed in (webhook DROPPED).
const B = 'http://localhost:8799', KN = 'http://127.0.0.1:8798'; let n = 0;
const ck = async (u, p) => (await fetch(B + '/login', { method: 'POST', headers: { 'x-forwarded-for': `10.4.${Math.floor(n / 200)}.${(n++ % 200) + 1}` }, body: new URLSearchParams({ username: u, password: p }), redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
const call = async (c, m, u, b) => { const r = await fetch(B + u, { method: m, headers: { cookie: c, 'content-type': 'application/json', origin: B }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let fails = 0; const ok = (t, c, x) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) { fails++; console.log('      ', String(JSON.stringify(x)).slice(0, 400)); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const owner = await ck('owner', 'test');
for (const [name, u, role] of [['Cleo Clean', 'cleo', 'cleaner'], ['Uma User', 'uma', 'user']]) await call(owner, 'POST', '/api/users', { name, username: u, password: 'testpass1', role, buildings: 'all', email: '' });
const cleo = await ck('cleo', 'testpass1');
await call(owner, 'PUT', '/api/keynest/links', { confirmed: true, changes: [{ listingId: 'm5', keyId: 'K100' }] });
const hookUrl = (await call(owner, 'GET', '/api/keynest')).body.webhookUrl;
ok('the KeyNest webhook address is available', Boolean(hookUrl), hookUrl);
const hook = (b) => fetch(B + new URL(hookUrl).pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
await fetch(`${KN}/set?status=${encodeURIComponent('In Use (Cleo Clean)')}`); // the key is out: the live check says no
const buf = Buffer.alloc(100000, 7);
const toKeyStep = async (listingId, upto = 'key') => {
  const id = (await call(cleo, 'POST', '/api/cleanings/start', { listingId })).body.cleaning.id;
  await call(cleo, 'POST', `/api/cleanings/${id}/end`);
  for (const k of ['bins', 'fridge', 'oven', 'microwave', 'hairs']) await call(cleo, 'POST', `/api/cleanings/${id}/confirm`, { key: k });
  await call(cleo, 'POST', `/api/cleanings/${id}/checks-done`, { heldMs: 3100 });
  if (upto === 'video') return id;
  const s = (await call(cleo, 'POST', '/api/media', { kind: 'video', purpose: 'cleaning', ownerId: id, name: 'v.mov', size: buf.length, type: 'video/quicktime' })).body;
  await fetch(`${B}/api/media/${s.id}?offset=0`, { method: 'PUT', headers: { cookie: cleo, 'content-type': 'application/octet-stream', origin: B }, body: buf });
  const r = await call(cleo, 'POST', `/api/cleanings/${id}/complete`, { videoIds: [s.id] });
  return { id, status: r.body.cleaning && r.body.cleaning.status };
};
const get = async (id) => (await call(owner, 'GET', `/api/cleanings/${id}`)).body.cleaning;
const c1 = await toKeyStep('m5');
ok('the KeyNest flat waits at the key step (key out)', c1.status === 'awaiting_key', c1);
let r = await call(cleo, 'POST', `/api/cleanings/${c1.id}/key`, {});
ok('pressing complete is refused while KeyNest shows the key out', r.status === 409, r);
// a drop for another key: nothing happens
await hook({ EventName: 'DROPPED', KeyId: 'K999', KeyName: 'Some other flat', StoreName: 'Store X', PreviousStatus: 'In Use (Bob)', CurrentStatus: 'In Store', WhenHappened: new Date().toISOString() });
await wait(1200);
ok('a drop of another key doesn’t finish it', (await get(c1.id)).status === 'awaiting_key');
// a drop message while KeyNest itself still shows the key out: nothing happens
await hook({ EventName: 'DROPPED', KeyId: 'K100', KeyName: 'Test key 100', StoreName: 'Fake Store', PreviousStatus: 'In Use (Cleo Clean)', CurrentStatus: 'In Store', WhenHappened: new Date().toISOString() });
await wait(1200);
ok('a drop message isn’t trusted while KeyNest still shows the key out', (await get(c1.id)).status === 'awaiting_key');
// an old drop from before the cleaning started: nothing happens
await hook({ EventName: 'DROPPED', KeyId: 'K100', KeyName: 'Test key 100', StoreName: 'Old Store', PreviousStatus: 'In Use (Bob)', CurrentStatus: 'In Store', WhenHappened: new Date(Date.now() - 5 * 3600e3).toISOString() });
await wait(1200);
ok('a drop from before the cleaning started doesn’t finish it', (await get(c1.id)).status === 'awaiting_key');
// the real drop: KeyNest now shows the key in the store
await fetch(`${KN}/set?status=${encodeURIComponent('In Store')}`);
const hr = await hook({ EventName: 'DROPPED', KeyId: 'K100', KeyName: 'Test key 100', StoreName: 'KeyNest Store – Oxford St', StoreId: '42', PreviousStatus: 'In Use (Cleo Clean)', CurrentStatus: 'In Store', WhenHappened: new Date().toISOString() });
ok('the webhook is answered straight away', hr.status === 200);
await wait(1500);
const done = await get(c1.id);
ok('the cleaning finished by itself', done.status === 'completed' && done.key && done.key.viaWebhook && done.key.store === 'KeyNest Store – Oxford St' && done.key.droppedBy === 'Cleo Clean', done);
ok('…without an override', !done.key.overridden);
const notes = (await call(cleo, 'GET', '/api/notifications')).body.items || [];
ok('Cleo is told it’s complete', notes.some((x) => x.title === 'FL-2 cleaning complete' && x.body.includes('Oxford St')), notes.map((x) => x.title));
const un = (await call(await ck('uma', 'testpass1'), 'GET', '/api/notifications')).body.items || [];
ok('managers get the usual “cleaned” notice, saying how', un.some((x) => x.title === 'FL-2 cleaned' && x.body.includes('key handed in at KeyNest')), un.map((x) => x.body));
// a repeat of the same webhook changes nothing
await hook({ EventName: 'DROPPED', KeyId: 'K100', KeyName: 'Test key 100', StoreName: 'KeyNest Store – Oxford St', PreviousStatus: 'In Use (Cleo Clean)', CurrentStatus: 'In Store', WhenHappened: new Date().toISOString() });
await wait(1200);
const again = await get(c1.id);
ok('a repeated webhook changes nothing', again.status === 'completed' && again.completedAt === done.completedAt);
// a cleaning still at the video step isn't finished by a drop
await fetch(`${KN}/set?status=${encodeURIComponent('In Use (Cleo Clean)')}`);
const c2 = await toKeyStep('m5', 'video');
await hook({ EventName: 'DROPPED', KeyId: 'K100', KeyName: 'Test key 100', StoreName: 'Store Y', PreviousStatus: 'In Use (Cleo Clean)', CurrentStatus: 'In Store', WhenHappened: new Date().toISOString() });
await wait(1200);
ok('a cleaning still at the video step is not finished by a drop', (await get(c2)).status === 'awaiting_video');
// the key was handed in while the cleaning was still at the video step: sending the video finishes it straight away
await fetch(`${KN}/set?status=${encodeURIComponent('In Store')}`);
const s2 = (await call(cleo, 'POST', '/api/media', { kind: 'video', purpose: 'cleaning', ownerId: c2, name: 'v.mov', size: buf.length, type: 'video/quicktime' })).body;
await fetch(`${B}/api/media/${s2.id}?offset=0`, { method: 'PUT', headers: { cookie: cleo, 'content-type': 'application/octet-stream', origin: B }, body: buf });
r = await call(cleo, 'POST', `/api/cleanings/${c2}/complete`, { videoIds: [s2.id] });
ok('a key handed in before the video finishes the cleaning as soon as the video is sent', r.status === 200 && r.body.cleaning.status === 'completed' && r.body.cleaning.key.viaWebhook, r.body.cleaning && r.body.cleaning.status);
// the normal live check: the key is collected again, then the next cleaning finishes when KeyNest shows it back
await hook({ EventName: 'COLLECTED', KeyId: 'K100', KeyName: 'Test key 100', StoreName: 'Store Y', CurrentUserName: 'Cleo Clean', CurrentStatus: 'In Use (Cleo Clean)', WhenHappened: new Date().toISOString() });
const c3 = await toKeyStep('m5');
r = await call(cleo, 'POST', `/api/cleanings/${c3.id}/key`, {});
ok('the normal live KeyNest check still completes a cleaning', r.status === 200 && r.body.cleaning.status === 'completed' && !r.body.cleaning.key.viaWebhook, r);
const bad = await fetch(B + '/webhooks/keynest/wrongsecret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
ok('a webhook with the wrong address is refused', bad.status === 401);
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
