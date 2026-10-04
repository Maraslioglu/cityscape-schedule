// Runs every test suite, each against a fresh local copy of the app (sample data, no Guesty keys) and a stand-in
// KeyNest. `npm run build && npm test`. Uses ports 8799 (app), 8798 (stand-in KeyNest) and 8840 (bookings test).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = path.join(ROOT, 'tests');
const only = process.argv.slice(2);
const SUITES = ['safety', 'race', 'cleans-only', 'code-edit', 'jobtools', 'complaint', 'keydrop', 'start-role', 'audit-fixes', 'review-fixes', 'improvements']
  .filter((s) => !only.length || only.includes(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));

async function up(url) {
  for (let i = 0; i < 150; i++) { try { await fetch(url); return; } catch (_) { await sleep(100); } }
  throw new Error(`${url} didn't start`);
}
// Suites written for a fixed day run with the app and the test both thinking it's that day (fake-clock.mjs).
const FIXED_DAY = { 'review-fixes': '2026-10-03T10:00:00Z' };
function run(file, args, { env = {}, cwd = ROOT, logFile } = {}) {
  const out = logFile ? fs.openSync(logFile, 'a') : 'pipe';
  const flags = env.FAKE_NOW ? ['--import', path.join(T, 'fake-clock.mjs')] : [];
  const p = spawn(process.execPath, [...flags, file, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
  p.text = '';
  if (!logFile) { p.stdout.on('data', (d) => { p.text += d; }); p.stderr.on('data', (d) => { p.text += d; }); }
  p.done = new Promise((r) => p.once('exit', (code) => r(code)));
  return p;
}
async function stop(p) { if (p && p.exitCode === null) { p.kill(); await p.done; } }

// The app, on a fresh data folder. `dir` holds store.json and app.log.
async function startApp({ port = 8799, worker = ROOT, env = {} } = {}) {
  const dir = tmp();
  const app = run(path.join(worker, 'server.mjs'), [], {
    cwd: worker, logFile: path.join(dir, 'app.log'),
    env: { DATA_DIR: dir, PORT: String(port), APP_PASSWORD: 'test', PUBLIC_URL: `http://localhost:${port}`, KEYNEST_API_URL: 'http://127.0.0.1:8798', KEYNEST_API_KEY: 'x', ...env },
  });
  await up(`http://localhost:${port}/styles.css`);
  return { app, dir };
}

// Some suites expect these people to exist already (all buildings).
async function addPeople(base = 'http://localhost:8799') {
  const r = await fetch(base + '/login', { method: 'POST', headers: { 'x-forwarded-for': '10.250.0.1' }, body: new URLSearchParams({ username: 'owner', password: 'test' }), redirect: 'manual' });
  const owner = r.headers.get('set-cookie').split(';')[0];
  for (const [name, username, role, buildings] of [['Ada Admin', 'ada', 'admin', 'all'], ['Uma User', 'uma', 'user', 'all'], ['Sam Super', 'sam', 'supervisor', 'all'], ['Sid Super', 'sid', 'supervisor', ['74 Queensway']], ['Cleo Clean', 'cleo', 'cleaner', 'all'], ['Maria Santos', 'maria', 'cleaner', 'all']]) {
    await fetch(base + '/api/users', { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json', origin: base }, body: JSON.stringify({ name, username, password: 'testpass1', role, buildings, email: '' }) });
  }
}

// The bookings test changes "Guesty" between steps: a copy of the built app whose sample bookings also read a file.
function bookingsCopy() {
  const dir = tmp();
  const src = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  const from = "    stays: (from, to, statuses) => { all = all || build(); return all.filter((r) => r.checkInDateLocalized <= to && r.checkOutDateLocalized >= from && statuses.includes(r.status)); },";
  const to = "    stays: (from, to, statuses) => { all = all || build(); let P = { remove: [], add: [] }; try { P = JSON.parse(__fs.readFileSync(process.env.MOCK_OV, 'utf8')); } catch (_) {} const base = all.filter((r) => !P.remove.includes(r.listingId)).concat(P.add); return base.filter((r) => r.checkInDateLocalized <= to && r.checkOutDateLocalized >= from && statuses.includes(r.status)); },";
  if (!src.includes(from)) throw new Error('tests/run.mjs: the sample bookings code changed; update bookingsCopy()');
  fs.writeFileSync(path.join(dir, 'worker.js'), "import __fs from 'node:fs';\n" + src.replace(from, to));
  fs.copyFileSync(path.join(ROOT, 'server.mjs'), path.join(dir, 'server.mjs'));
  const ov = path.join(dir, 'ov.json');
  fs.writeFileSync(ov, JSON.stringify({ remove: [], add: [] }));
  return { dir, ov };
}

const kn = run(path.join(T, 'mock-keynest.mjs'), []);
await up('http://127.0.0.1:8798/set');
let failed = 0;
for (const name of SUITES) {
  await fetch('http://127.0.0.1:8798/set?status=In%20Store&delay=0');
  let app, dir, args = [];
  try {
    if (name === 'review-fixes') {
      const copy = bookingsCopy();
      ({ app, dir } = await startApp({ port: 8840, worker: copy.dir, env: { MOCK_OV: copy.ov, FAKE_NOW: FIXED_DAY[name] } }));
      args = [copy.ov];
    } else {
      ({ app, dir } = await startApp());
      if (name === 'cleans-only' || name === 'code-edit') await addPeople();
      if (name === 'code-edit') args = [path.join(dir, 'app.log')];
      if (name === 'complaint') args = [path.join(dir, 'store.json')];
    }
    const t = run(path.join(T, `${name}-test.mjs`), args, { env: FIXED_DAY[name] ? { FAKE_NOW: FIXED_DAY[name] } : {} });
    const code = await Promise.race([t.done, sleep(300e3).then(() => 'timeout')]);
    if (code === 'timeout') await stop(t);
    const out = t.text;
    const passes = (out.match(/^PASS/gm) || []).length;
    const bad = code !== 0 || /^FAIL/m.test(out) || /\b[1-9]\d* failed\b/.test(out) || /^LOST/m.test(out);
    console.log(`${bad ? '✗' : '✓'} ${name}${passes ? ` (${passes} checks)` : /^KEPT/m.test(out) ? ' (kept)' : ''}${code === 'timeout' ? ' — timed out' : ''}`);
    if (bad) {
      failed++;
      console.log(out.split('\n').map((l) => '    ' + l).join('\n'));
      console.log('    --- app log (last 30 lines) ---\n' + fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n').slice(-30).map((l) => '    ' + l).join('\n'));
    }
  } catch (e) {
    failed++;
    console.log(`✗ ${name} — ${e.message}`);
  } finally {
    await stop(app);
  }
}
await stop(kn);
console.log(failed ? `\n${failed} suite${failed === 1 ? '' : 's'} failed` : `\n${SUITES.length === 1 ? 'Passed' : `All ${SUITES.length} suites passed`}`);
process.exit(failed ? 1 : 0);
