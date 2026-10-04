// Stand-in for the KeyNest API (local testing only). /set?id=K100&status=…&delay=ms changes a key / slows answers.
import http from 'node:http';
const keys = [{ KeyId: 'K100', KeyName: 'Test key 100', StatusType: 'In Store', LastMovement: '2026-09-27T16:08:19' }];
let delay = 0;
http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/set') { const k = keys[0]; if (u.searchParams.get('status')) k.StatusType = u.searchParams.get('status'); if (u.searchParams.has('delay')) delay = Number(u.searchParams.get('delay')); return res.end(JSON.stringify(k)); }
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (u.pathname === '/Keys') return res.end(JSON.stringify({ Status: 'Success', ResponsePacket: { KeyList: keys } }));
  const m = /^\/Keys\/(\w+)$/.exec(u.pathname);
  if (m) return res.end(JSON.stringify({ Status: 'Success', ResponsePacket: { KeyList: keys.filter((k) => k.KeyId === m[1]) } }));
  res.statusCode = 404; res.end('{}');
}).listen(8798, () => console.log('mock KeyNest on 8798'));
