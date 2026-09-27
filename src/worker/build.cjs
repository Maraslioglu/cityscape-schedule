// Bundles the Worker and the web page into one file: dist/worker.js
// Run: node worker/build.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pub = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

const css = pub('styles.css'), js = pub('app.js');
const v = { css: fnv(css), js: fnv(js) };
const html = (f) => pub(f).replace('href="/styles.css"', `href="/styles.css?v=${v.css}"`).replace('src="/app.js"', `src="/app.js?v=${v.js}"`);
const files = {
  'index.html': ['text/html; charset=utf-8', html('index.html')],
  'login.html': ['text/html; charset=utf-8', html('login.html')],
  'styles.css': ['text/css; charset=utf-8', css],
  'app.js': ['text/javascript; charset=utf-8', js],
  'favicon.svg': ['image/svg+xml', pub('favicon.svg')],
  'manifest.webmanifest': ['application/manifest+json', pub('manifest.webmanifest')],
};
const assets = 'const ASSETS = {\n' + Object.entries(files).map(([name, [type, body]]) =>
  `  ${JSON.stringify(name)}: { type: ${JSON.stringify(type)}, hash: ${JSON.stringify(fnv(body))}, body: ${JSON.stringify(body)} },`).join('\n') + '\n};';

let src = fs.readFileSync(path.join(__dirname, 'src.js'), 'utf8');
src = src.replace('/* __ASSETS__ */', assets).replace('/* __MOCK__ */', fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'worker.js'), src);
console.log('dist/worker.js', (src.length / 1024).toFixed(1) + ' KB');
fs.copyFileSync(path.join(__dirname, 'server.mjs'), path.join(root, 'dist', 'server.mjs')); console.log('dist/server.mjs');
