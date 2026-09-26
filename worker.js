// Cityscape Schedule — Cloudflare Worker.
// Serves the web app, the team login, and the week/linen data built from Guesty.
//
// Bindings (Cloudflare dashboard → Worker → Settings):
//   KV namespace  STORE                  – Guesty token + pre-loaded bookings
//   Secrets       GUESTY_CLIENT_ID, GUESTY_CLIENT_SECRET, APP_PASSWORD
//   Cron trigger  */5 * * * *            – keeps bookings fresh in the background
//   Optional vars PUBLIC_URL, WEEK_START_DAY, RESERVATION_STATUSES, DEFAULT_CHECKIN_TIME,
//                 DEFAULT_CHECKOUT_TIME, UNIT_TYPE_OVERRIDES, BUILDING_OVERRIDES,
//                 HIDDEN_LISTINGS, NEW_BOOKING_HOURS
//
// Without Guesty keys it runs on sample data so it can be previewed.

const ASSETS = {
  "index.html": { type: "text/html; charset=utf-8", hash: "1w7877", body: "<!doctype html>\n<html lang=\"en-GB\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Cityscape Schedule</title>\n<link rel=\"icon\" href=\"/favicon.svg\">\n<link rel=\"manifest\" href=\"/manifest.webmanifest\">\n<meta name=\"theme-color\" content=\"#1f4e5f\">\n<meta name=\"robots\" content=\"noindex\">\n<link rel=\"stylesheet\" href=\"/styles.css?v=2n4lrp\">\n</head>\n<body>\n<header class=\"top\">\n  <div class=\"wrap\">\n    <div class=\"brand\">\n      <svg viewBox=\"0 0 32 32\" aria-hidden=\"true\"><rect width=\"32\" height=\"32\" rx=\"8\" fill=\"#1f4e5f\"/><path d=\"M7 24V14h5v10M13.5 24V8h5v16M20 24V12h5v12\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2\" stroke-linejoin=\"round\"/><path d=\"M5 24.5h22\" stroke=\"#fff\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>\n      <span class=\"name\">Cityscape Schedule</span>\n    </div>\n    <span class=\"live\" id=\"live\" title=\"Connecting…\"><i></i><span class=\"lbl\">Connecting</span></span>\n    <nav class=\"seg\" role=\"tablist\" aria-label=\"View\">\n      <button role=\"tab\" data-view=\"day\" aria-selected=\"true\">Day</button>\n      <button role=\"tab\" data-view=\"board\" aria-selected=\"false\">Board</button>\n      <button role=\"tab\" data-view=\"props\" aria-selected=\"false\">Properties</button>\n      <button role=\"tab\" data-view=\"users\" aria-selected=\"false\" class=\"hidden\">Users</button>\n    </nav>\n    <button class=\"btn me\" id=\"me-btn\" data-view=\"account\" title=\"My account\"><span class=\"avatar\" id=\"me-avatar\"></span><span class=\"btn-label\" id=\"me-name\"></span></button>\n  </div>\n</header>\n\n<main class=\"wrap\">\n  <section id=\"week-area\">\n    <div class=\"weekbar\">\n      <button class=\"btn sq no-print\" id=\"prev\" aria-label=\"Previous week\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M15 18l-6-6 6-6\"/></svg></button>\n      <h1 id=\"week-title\">Loading…</h1>\n      <button class=\"btn sq no-print\" id=\"next\" aria-label=\"Next week\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M9 18l6-6-6-6\"/></svg></button>\n      <span class=\"when\" id=\"when\"></span>\n      <span id=\"newpill\"></span>\n      <span class=\"spacer\"></span>\n      <button class=\"btn no-print\" id=\"this\">This week</button>\n      <button class=\"btn act no-print\" id=\"refresh\" title=\"Pull the latest from Guesty\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5\"/></svg><span class=\"btn-label\">Refresh</span></button>\n      <button class=\"btn act no-print\" id=\"copy\" title=\"Copy as text for WhatsApp\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><rect x=\"9\" y=\"9\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1\"/></svg><span class=\"btn-label\" id=\"copy-label\">Copy day</span></button>\n      <button class=\"btn act no-print\" id=\"print\" title=\"Print or save as PDF\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z\"/></svg><span class=\"btn-label\">Print</span></button>\n    </div>\n\n    <div id=\"banners\"></div>\n\n    <div class=\"summary\" id=\"summary\">\n      <div class=\"metric\"><div class=\"k\"><i style=\"background:var(--out)\"></i>Cleans</div><div class=\"v\" id=\"m-out\">–</div></div>\n      <div class=\"metric\"><div class=\"k\"><i style=\"background:var(--in)\"></i>Arrivals</div><div class=\"v\" id=\"m-in\">–</div></div>\n      <div class=\"metric\"><div class=\"k\"><i style=\"background:var(--turn)\"></i>Same-day</div><div class=\"v\" id=\"m-turn\">–</div></div>\n      <div class=\"metric linen\"><div class=\"k\">Linen sets for the week <span class=\"muted\" style=\"font-weight:500\">· 1 per check-out</span></div><div class=\"linen-row\" id=\"m-linen\"></div></div>\n    </div>\n\n    <!-- DAY VIEW -->\n    <div id=\"view-day\">\n      <div class=\"strip\" id=\"strip\" role=\"tablist\" aria-label=\"Day\"></div>\n      <div class=\"card\" id=\"daypanel\"><div class=\"loading\">Loading from Guesty…</div></div>\n    </div>\n\n    <!-- BOARD VIEW -->\n    <div id=\"view-board\" class=\"hidden\">\n      <div class=\"card\">\n        <div class=\"board-wrap\"><table class=\"board\" id=\"board\"></table></div>\n        <div class=\"legend no-print\">\n          <span><i class=\"sw\"></i>Guest staying</span>\n          <span><b style=\"color:var(--out)\">10 am</b> check-out</span>\n          <span><b style=\"color:var(--in)\">3 pm</b> check-in</span>\n          <span><b class=\"mark turn\" style=\"position:static;transform:none\">10→3</b> same-day turnover</span>\n          <span><i class=\"sw n\"></i>Booked in the last 24 h</span>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- PROPERTIES VIEW -->\n  <section id=\"view-props\" class=\"hidden\">\n    <div class=\"weekbar\"><h1>Properties</h1><span class=\"when\" id=\"props-sub\"></span></div>\n    <div class=\"pgrid\" id=\"props\"></div>\n  </section>\n\n  <!-- USERS VIEW (admins) -->\n  <section id=\"view-users\" class=\"hidden\">\n    <div class=\"weekbar\"><h1>Users</h1><span class=\"when\" id=\"users-sub\"></span><span class=\"spacer\"></span>\n      <button class=\"btn primary\" id=\"add-user\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M12 5v14M5 12h14\"/></svg>Add user</button></div>\n    <div id=\"users-msg\"></div>\n    <div class=\"users-layout\">\n      <div class=\"card\"><table class=\"utable\"><thead><tr><th>Name</th><th>Role</th><th class=\"hide-sm\">Buildings</th><th class=\"hide-sm\">Last sign-in</th><th></th></tr></thead><tbody id=\"users-list\"></tbody></table></div>\n      <form class=\"card uform hidden\" id=\"user-form\" autocomplete=\"off\"></form>\n    </div>\n  </section>\n\n  <!-- MY ACCOUNT -->\n  <section id=\"view-account\" class=\"hidden\">\n    <div class=\"weekbar\"><h1>My account</h1></div>\n    <div class=\"acct-grid\">\n      <div class=\"card pad\" id=\"acct-info\"></div>\n      <form class=\"card pad\" id=\"pw-form\">\n        <h3>Change password</h3>\n        <label for=\"pw-cur\">Current password</label><input id=\"pw-cur\" type=\"password\" autocomplete=\"current-password\" required>\n        <label for=\"pw-new\">New password</label><input id=\"pw-new\" type=\"password\" autocomplete=\"new-password\" minlength=\"8\" required>\n        <label for=\"pw-new2\">New password again</label><input id=\"pw-new2\" type=\"password\" autocomplete=\"new-password\" minlength=\"8\" required>\n        <div class=\"form-msg\" id=\"pw-msg\"></div>\n        <button class=\"btn primary\" type=\"submit\">Change password</button>\n      </form>\n    </div>\n    <p style=\"margin-top:14px\"><a class=\"btn\" href=\"/logout\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9\"/></svg>Sign out</a></p>\n  </section>\n\n  <div class=\"foot\" id=\"foot\"></div>\n</main>\n\n<script src=\"/app.js?v=j6hnfy\"></script>\n</body>\n</html>\n" },
  "login.html": { type: "text/html; charset=utf-8", hash: "39p4zu", body: "<!doctype html>\n<html lang=\"en-GB\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Sign in · Cityscape Schedule</title>\n<link rel=\"icon\" href=\"/favicon.svg\">\n<link rel=\"stylesheet\" href=\"/styles.css?v=2n4lrp\">\n<meta name=\"robots\" content=\"noindex\">\n</head>\n<body>\n<div class=\"login\">\n  <form method=\"post\" action=\"/login\">\n    <svg width=\"40\" height=\"40\" viewBox=\"0 0 32 32\"><rect width=\"32\" height=\"32\" rx=\"8\" fill=\"#1f4e5f\"/><path d=\"M7 24V14h5v10M13.5 24V8h5v16M20 24V12h5v12\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2\" stroke-linejoin=\"round\"/><path d=\"M5 24.5h22\" stroke=\"#fff\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>\n    <h1>Cityscape Schedule</h1>\n    <p>Check-ins, check-outs and linen for the week.</p>\n    <label for=\"un\">Username</label>\n    <input id=\"un\" name=\"username\" type=\"text\" autocomplete=\"username\" autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\" required autofocus>\n    <label for=\"pw\" style=\"margin-top:12px\">Password</label>\n    <input id=\"pw\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required>\n    <button type=\"submit\">Sign in</button>\n    <div class=\"err\" id=\"err\"></div>\n  </form>\n</div>\n<script>\n  const q = new URLSearchParams(location.search), e = q.get('e');\n  if (q.get('u')) { document.getElementById('un').value = q.get('u'); document.getElementById('pw').focus(); }\n  if (e === '1') document.getElementById('err').textContent = 'That username or password isn’t right.';\n  if (e === 'locked') document.getElementById('err').textContent = 'Too many attempts — try again in 10 minutes.';\n</script>\n</body>\n</html>\n" },
  "styles.css": { type: "text/css; charset=utf-8", hash: "2n4lrp", body: ":root {\n  --bg: #f4f3ef;\n  --surface: #ffffff;\n  --surface-2: #f9f8f5;\n  --ink: #1b1f27;\n  --ink-2: #545a65;\n  --ink-3: #8b9099;\n  --line: #e7e4dd;\n  --line-2: #f0eee9;\n  --accent: #1f4e5f;\n  --accent-ink: #ffffff;\n  --accent-soft: #e4eef1;\n  --stay: #dde9ee;\n  --out: #b8552b;\n  --out-soft: #fbece3;\n  --in: #2b7a4b;\n  --in-soft: #e3f2e8;\n  --turn: #6f4aa8;\n  --turn-soft: #efe8f8;\n  --new: #9a6a00;\n  --new-soft: #fdf1cf;\n  --radius: 14px;\n  --shadow: 0 1px 2px rgba(20, 24, 31, .04), 0 2px 8px rgba(20, 24, 31, .03);\n  color-scheme: light;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #111317;\n    --surface: #191c21;\n    --surface-2: #1e2127;\n    --ink: #eceae6;\n    --ink-2: #b3b6bc;\n    --ink-3: #7e838c;\n    --line: #2a2e35;\n    --line-2: #23262c;\n    --accent: #86c3d4;\n    --accent-ink: #0f1a1e;\n    --accent-soft: #1c2f36;\n    --stay: #1f343c;\n    --out: #f0a47f;\n    --out-soft: #3a251b;\n    --in: #7fd1a0;\n    --in-soft: #1b3125;\n    --turn: #c4a5f1;\n    --turn-soft: #2c2340;\n    --new: #f2c65e;\n    --new-soft: #3a3019;\n    --shadow: none;\n    color-scheme: dark;\n  }\n}\n\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody {\n  background: var(--bg);\n  color: var(--ink);\n  font: 15px/1.45 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Inter, Roboto, Helvetica, Arial, sans-serif;\n  -webkit-font-smoothing: antialiased;\n}\nbutton, input { font: inherit; color: inherit; }\nbutton, a { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }\nbutton:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\nbody { text-rendering: optimizeLegibility; }\n/* While a new week loads, keep the current one on screen and just dim it — no blank flashes. */\n#week-area .summary, #view-day, #view-board { transition: opacity .15s ease; }\nbody.is-loading #week-area .summary, body.is-loading #view-day, body.is-loading #view-board { opacity: .55; pointer-events: none; }\n#daypanel { min-height: 240px; }\n.btn, .seg button, .dbtn { transition: background-color .12s ease, border-color .12s ease, color .12s ease; }\n@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }\n.wrap { max-width: 1120px; margin: 0 auto; padding: 0 16px; }\n.hidden { display: none !important; }\n.muted { color: var(--ink-3); }\n\n/* ---------- header ---------- */\n.top { position: sticky; top: 0; z-index: 20; background: var(--bg); border-bottom: 1px solid var(--line); }\n.top .wrap { display: flex; align-items: center; gap: 12px; height: 60px; }\n.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; letter-spacing: -.01em; margin-right: auto; white-space: nowrap; }\n.brand svg { width: 28px; height: 28px; flex: none; }\n.seg { display: flex; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 3px; gap: 2px; }\n.seg button { border: 0; background: none; padding: 6px 13px; border-radius: 7px; color: var(--ink-2); font-weight: 580; font-size: 14px; }\n.seg button[aria-selected=\"true\"] { background: var(--accent); color: var(--accent-ink); }\n.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--ink-3); white-space: nowrap; }\n.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); }\n.live.on { color: var(--in); }\n.live.on i { background: var(--in); }\n.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--line); background: var(--surface); border-radius: 10px; height: 36px; padding: 0 12px; font-weight: 560; font-size: 14px; color: var(--ink-2); text-decoration: none; white-space: nowrap; }\n.btn:hover { color: var(--ink); border-color: var(--ink-3); }\n.btn:disabled { opacity: .45; cursor: default; }\n.btn svg { width: 16px; height: 16px; flex: none; }\n.btn.sq { width: 36px; padding: 0; }\n\n/* ---------- week bar ---------- */\n.weekbar { display: flex; align-items: center; gap: 8px; margin: 22px 0 14px; flex-wrap: wrap; }\n.weekbar h1 { font-size: 22px; letter-spacing: -.02em; margin: 0 6px; font-weight: 700; white-space: nowrap; }\n.weekbar .when { font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); }\n.weekbar .spacer { flex: 1; }\n.newpill { display: inline-flex; align-items: center; gap: 6px; background: var(--new-soft); color: var(--new); font-weight: 650; font-size: 12.5px; padding: 5px 10px; border-radius: 99px; }\n.banner { border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 14px; background: var(--new-soft); color: var(--new); }\n.banner.error { background: var(--out-soft); color: var(--out); }\n\n/* ---------- summary band ---------- */\n.summary { display: grid; grid-template-columns: repeat(3, 1fr) 2.1fr; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 18px; overflow: hidden; }\n.metric { padding: 14px 18px; border-left: 1px solid var(--line); }\n.metric:first-child { border-left: 0; }\n.metric .k { font-size: 12.5px; font-weight: 600; color: var(--ink-2); display: flex; align-items: center; gap: 7px; }\n.metric .k i { width: 8px; height: 8px; border-radius: 3px; }\n.metric .v { font-size: 28px; font-weight: 720; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 3px; }\n.metric.linen { background: var(--surface-2); }\n.linen-row { display: flex; align-items: flex-end; gap: 18px; margin-top: 3px; }\n.linen-row .item .v { font-size: 22px; }\n.linen-row .item .t { font-size: 12px; color: var(--ink-3); font-weight: 550; }\n.linen-row .total { margin-left: auto; text-align: right; }\n.linen-row .total .v { font-size: 28px; color: var(--accent); }\n\n/* ---------- day strip ---------- */\n.strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 14px; }\n.dbtn { position: relative; border: 1px solid var(--line); background: var(--surface); border-radius: 12px; padding: 9px 6px 10px; text-align: center; box-shadow: var(--shadow); }\n.dbtn .dn { font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); }\n.dbtn .dd { font-size: 22px; font-weight: 720; letter-spacing: -.02em; line-height: 1.15; }\n.dbtn .dc { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }\n.dbtn .dc b { color: var(--out); font-weight: 650; }\n.dbtn .dc em { color: var(--in); font-style: normal; font-weight: 650; }\n.dbtn.past { opacity: .55; }\n.dbtn.today .dn { color: var(--accent); }\n.dbtn.today::after { content: \"Today\"; position: absolute; top: -8px; left: 50%; transform: translateX(-50%); background: var(--accent); color: var(--accent-ink); font-size: 10px; font-weight: 750; padding: 1px 7px; border-radius: 99px; letter-spacing: .04em; text-transform: uppercase; }\n.dbtn[aria-selected=\"true\"] { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); opacity: 1; }\n.dbtn .newdot { position: absolute; top: 8px; right: 8px; width: 7px; height: 7px; border-radius: 50%; background: var(--new); }\n\n/* ---------- day panel ---------- */\n.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }\n.dayhead { display: flex; align-items: baseline; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }\n.dayhead h2 { margin: 0; font-size: 18px; letter-spacing: -.01em; }\n.dayhead .dlinen { margin-left: auto; font-size: 13px; color: var(--ink-2); }\n.dayhead .dlinen b { color: var(--ink); font-variant-numeric: tabular-nums; }\n\n.section { padding: 6px 0 10px; border-top: 1px solid var(--line); }\n.section:first-of-type { border-top: 0; }\n.shead { display: flex; align-items: center; gap: 10px; padding: 12px 20px 6px; }\n.shead .bar { width: 4px; height: 18px; border-radius: 2px; }\n.shead h3 { margin: 0; font-size: 14.5px; font-weight: 680; }\n.shead .count { font-size: 12.5px; font-weight: 650; border-radius: 99px; padding: 1px 8px; }\n.shead .hint { font-size: 13px; color: var(--ink-3); }\n.s-turn .bar { background: var(--turn); } .s-turn .count { background: var(--turn-soft); color: var(--turn); }\n.s-out .bar { background: var(--out); } .s-out .count { background: var(--out-soft); color: var(--out); }\n.s-in .bar { background: var(--in); } .s-in .count { background: var(--in-soft); color: var(--in); }\n\n.bldg { margin: 6px 20px 0 34px; }\n.bldg-name { font-size: 12px; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; padding: 6px 0 4px; }\n.bldg-name span { font-weight: 550; letter-spacing: .02em; margin-left: 6px; }\n.row { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 10px; background: var(--surface-2); margin-bottom: 6px; }\n.row .u { font-weight: 680; min-width: 64px; }\n.row .t { font-size: 12.5px; color: var(--ink-3); }\n.row .g { font-size: 12.5px; color: var(--ink-3); }\n.row .times { margin-left: auto; display: flex; align-items: center; gap: 6px; }\n.chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 7px; padding: 3px 9px; font-size: 13px; font-weight: 640; white-space: nowrap; font-variant-numeric: tabular-nums; }\n.chip.out { background: var(--out-soft); color: var(--out); }\n.chip.in { background: var(--in-soft); color: var(--in); }\n.chip small { font-weight: 500; opacity: .8; font-size: 11.5px; }\n.arrow { color: var(--ink-3); font-size: 13px; }\n.new { background: var(--new-soft); color: var(--new); font-size: 11px; font-weight: 750; letter-spacing: .04em; padding: 2px 7px; border-radius: 6px; text-transform: uppercase; }\n.empty { padding: 44px 20px; text-align: center; color: var(--ink-3); }\n.empty b { display: block; color: var(--ink-2); font-size: 16px; margin-bottom: 2px; }\n\n/* ---------- week board ---------- */\n.board-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }\ntable.board { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 760px; table-layout: fixed; }\ntable.board th, table.board td { padding: 0; border-bottom: 1px solid var(--line-2); }\ntable.board col.first { width: 170px; }\ntable.board thead th { position: sticky; top: 0; background: var(--surface); z-index: 3; padding: 10px 6px; border-bottom: 1px solid var(--line); text-align: center; font-weight: 600; }\ntable.board thead th button { border: 0; background: none; padding: 2px 6px; border-radius: 8px; width: 100%; }\ntable.board thead th button:hover { background: var(--surface-2); }\ntable.board thead .dn { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); font-weight: 650; }\ntable.board thead .dd { font-size: 17px; font-weight: 720; }\ntable.board thead .dc { font-size: 11.5px; color: var(--ink-3); font-weight: 550; }\ntable.board th.today .dn, table.board th.today .dd { color: var(--accent); }\ntable.board td.today, table.board th.today { background: color-mix(in srgb, var(--accent-soft) 45%, var(--surface)); }\n.first-col { position: sticky; left: 0; background: var(--surface); z-index: 2; text-align: left !important; padding: 0 14px !important; border-right: 1px solid var(--line); }\ntr.b-row td { background: var(--surface-2); padding: 7px 14px !important; font-size: 12px; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--line); }\ntr.b-row td span { font-weight: 550; margin-left: 6px; letter-spacing: .02em; }\ntr.b-row .b-name { position: sticky; left: 14px; display: inline-block; white-space: nowrap; }\ntd.unit { height: 46px; }\ntd.unit .u { font-weight: 680; font-size: 14px; }\ntd.unit .t { font-size: 11.5px; color: var(--ink-3); margin-left: 6px; font-weight: 500; }\ntd.cell { position: relative; height: 46px; }\n.half { position: absolute; top: 9px; bottom: 9px; background: var(--stay); }\n.half.l { left: 0; right: 50%; }\n.half.r { left: 50%; right: 0; }\n.half.l.end { right: calc(50% + 4px); border-radius: 0 8px 8px 0; }\n.half.r.start { left: calc(50% + 4px); border-radius: 8px 0 0 8px; }\n.half.r.isnew { background: var(--new-soft); }\n.mark { position: absolute; top: 50%; transform: translateY(-50%); font-size: 11.5px; font-weight: 700; white-space: nowrap; z-index: 1; font-variant-numeric: tabular-nums; }\n.mark.out { color: var(--out); right: calc(50% + 10px); }\n.mark.in { color: var(--in); left: calc(50% + 10px); }\n.mark.turn { left: 50%; transform: translate(-50%, -50%); background: var(--turn); color: #fff; padding: 2px 7px; border-radius: 99px; font-size: 11px; box-shadow: 0 0 0 2px var(--surface); }\n@media (prefers-color-scheme: dark) { .mark.turn { color: #1a1325; } }\ntfoot td { padding: 9px 6px !important; text-align: center; font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; border-bottom: 0 !important; border-top: 1px solid var(--line); background: var(--surface-2); }\ntfoot td.first-col { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); background: var(--surface-2); }\ntfoot .o { color: var(--out); } tfoot .i { color: var(--in); }\n.legend { display: flex; gap: 16px; flex-wrap: wrap; padding: 12px 16px; font-size: 12.5px; color: var(--ink-2); border-top: 1px solid var(--line); }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.legend .sw { width: 22px; height: 10px; border-radius: 4px; background: var(--stay); display: inline-block; }\n.legend .sw.n { background: var(--new-soft); }\n\n/* ---------- properties ---------- */\n.pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }\n.pcard h3 { margin: 0; font-size: 15px; padding: 14px 16px 2px; }\n.pcard .pc { color: var(--ink-3); font-size: 12.5px; padding: 0 16px 10px; }\n.prow { display: flex; gap: 10px; align-items: baseline; padding: 9px 16px; border-top: 1px solid var(--line-2); font-size: 14px; }\n.prow .u { font-weight: 650; min-width: 90px; }\n.prow .t { color: var(--ink-3); font-size: 12.5px; margin-left: auto; white-space: nowrap; }\n\n.foot { color: var(--ink-3); font-size: 12.5px; padding: 18px 0 40px; text-align: center; }\n.loading { padding: 70px 0; text-align: center; color: var(--ink-3); }\n.toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 10px 16px; border-radius: 10px; font-size: 14px; font-weight: 580; z-index: 50; box-shadow: 0 6px 24px rgba(0,0,0,.18); }\n\n/* ---------- responsive ---------- */\n@media (max-width: 820px) {\n  .summary { grid-template-columns: repeat(3, 1fr); }\n  .metric.linen { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); }\n  .live .lbl { display: none; }\n}\n@media (max-width: 600px) {\n  .top .wrap { gap: 8px; }\n  .brand .name { display: none; }\n  .seg button { padding: 6px 10px; }\n  .btn-label { display: none; }\n  .btn.act { width: 36px; padding: 0; }\n  .weekbar h1 { font-size: 19px; margin: 0 2px; }\n  .weekbar .when { display: none; }\n  .metric { padding: 12px 12px; }\n  .metric .v { font-size: 24px; }\n  .metric .k { font-size: 12px; }\n  .strip { gap: 4px; }\n  .dbtn { padding: 8px 2px; border-radius: 10px; }\n  .dbtn .dd { font-size: 18px; }\n  .dbtn .dc { font-size: 11px; }\n  .dbtn .dc .lbl { display: none; }\n  #print { display: none; }\n  .dayhead, .shead { padding-left: 14px; padding-right: 14px; }\n  .bldg { margin: 4px 12px 0 12px; }\n  .row { flex-wrap: wrap; gap: 4px 10px; }\n  .row .times { margin-left: 0; width: 100%; }\n  .shead .hint { display: none; }\n  table.board col.first { width: 108px; }\n  td.unit .t { display: block; margin-left: 0; }\n}\n\n/* ---------- login ---------- */\n.login { min-height: 100vh; display: grid; place-items: center; padding: 16px; }\n.login form { width: 100%; max-width: 360px; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 28px; box-shadow: var(--shadow); }\n.login h1 { font-size: 20px; margin: 14px 0 4px; }\n.login p { color: var(--ink-2); margin: 0 0 18px; font-size: 14px; }\n.login label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }\n.login input + label { margin-top: 12px; }\n.login input { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); font-size: 16px; }\n.login input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }\n.login button { width: 100%; margin-top: 14px; padding: 11px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-ink); font-weight: 650; font-size: 15px; }\n.login .err { color: var(--out); font-size: 13.5px; margin-top: 10px; }\n\n/* ---------- print ---------- */\n@media print {\n  :root { --bg: #fff; --surface: #fff; --surface-2: #f6f6f6; --line: #bbb; --line-2: #ddd; --shadow: none; }\n  .top, .no-print, .foot, .strip { display: none !important; }\n  body { font-size: 11pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n  .summary { break-inside: avoid; }\n  .bldg, .row { break-inside: avoid; }\n  .board-wrap { overflow: visible; }\n  table.board { min-width: 0; font-size: 10pt; }\n  table.board thead th { position: static; }\n  .first-col { position: static; }\n}\n\n/* ---------- account button ---------- */\n.btn.me { padding: 0 10px 0 5px; gap: 8px; }\n.avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: inline-grid; place-items: center; font-size: 12px; font-weight: 700; letter-spacing: .02em; }\n.btn.me[aria-selected=\"true\"] { border-color: var(--accent); }\n.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }\n.btn.primary:hover { color: var(--accent-ink); filter: brightness(1.08); }\n.btn.danger { color: var(--out); }\n\n/* ---------- users ---------- */\n.users-layout { display: grid; grid-template-columns: 1fr; gap: 14px; align-items: start; }\n.users-layout.editing { grid-template-columns: 1fr 420px; }\n.utable { width: 100%; border-collapse: collapse; }\n.utable th, .utable td { text-align: left; padding: 11px 16px; border-top: 1px solid var(--line-2); font-size: 14px; vertical-align: middle; }\n.utable th { font-size: 12px; font-weight: 650; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; border-top: 0; }\n.utable tr.sel td { background: var(--accent-soft); }\n.utable tr.off td { opacity: .5; }\n.utable .who b { display: block; font-weight: 650; }\n.utable .who span { color: var(--ink-3); font-size: 12.5px; }\n.utable td:last-child { text-align: right; }\n.role { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: 99px; background: var(--surface-2); border: 1px solid var(--line); text-transform: capitalize; white-space: nowrap; }\n.role.admin { background: var(--accent-soft); color: var(--accent); border-color: transparent; }\n.role.supervisor { background: var(--turn-soft); color: var(--turn); border-color: transparent; }\n.role.cleaner { background: var(--in-soft); color: var(--in); border-color: transparent; }\n.uform, .card.pad { padding: 18px 20px; }\n.uform h3, .card.pad h3 { margin: 0 0 12px; font-size: 16px; }\n.uform label, .card.pad label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 5px; }\n.uform input[type=text], .uform input[type=email], .uform input[type=password], .uform select, .card.pad input { width: 100%; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2); font-size: 15px; color: var(--ink); }\n.uform input:focus, .uform select:focus, .card.pad input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }\n.uform .hint { font-size: 12.5px; color: var(--ink-3); margin-top: 4px; }\n.uform fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px 10px; margin: 14px 0 0; }\n.uform legend { font-size: 13px; font-weight: 650; padding: 0 4px; }\n.checks { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }\n.checks label, .radio label { display: flex; align-items: center; gap: 8px; font-weight: 500; margin: 4px 0; font-size: 14px; cursor: pointer; }\n.checks input, .radio input { width: 16px; height: 16px; accent-color: var(--accent); }\n.radio { display: flex; gap: 16px; }\n.pwrow { display: flex; gap: 6px; }\n.pwrow input { flex: 1; }\n.form-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }\n.form-actions .spacer { flex: 1; }\n.form-msg { font-size: 13.5px; margin-top: 10px; min-height: 1em; }\n.form-msg.err { color: var(--out); }\n.form-msg.ok { color: var(--in); }\n.confirm-del { background: var(--out-soft); color: var(--out); border-radius: 9px; padding: 10px 12px; font-size: 13.5px; margin-top: 12px; }\n.acct-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }\n.acct-grid dl { margin: 0; display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; font-size: 14px; }\n.acct-grid dt { color: var(--ink-3); }\n.acct-grid dd { margin: 0; font-weight: 550; }\n.card.pad .btn { margin-top: 14px; }\n@media (max-width: 860px) {\n  .users-layout.editing, .acct-grid { grid-template-columns: 1fr; }\n  .users-layout.editing .card:first-child { order: 2; }\n}\n@media (max-width: 600px) { .checks { grid-template-columns: 1fr; } .utable .hide-sm { display: none; } }\n\n.summary.no-linen { grid-template-columns: repeat(3, 1fr); }\n" },
  "app.js": { type: "text/javascript; charset=utf-8", hash: "j6hnfy", body: "(() => {\n  const $ = (id) => document.getElementById(id);\n  const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const D = (s) => new Date(s + 'T00:00:00Z');\n  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts });\n  const WD_SHORT = fmt({ weekday: 'short' }), WD_LONG = fmt({ weekday: 'long' }), MON = fmt({ month: 'long' }), MON_S = fmt({ month: 'short' });\n  const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));\n  const longDate = (s) => `${WD_LONG.format(D(s))}, ${ordinal(D(s).getUTCDate())} ${MON.format(D(s))}`;\n  const shortDate = (s) => `${D(s).getUTCDate()} ${MON_S.format(D(s))}`;\n  const compact = (t) => (t || '').replace(' ', '');\n  const shortType = (t) => ({ 'Studio': 'Studio', '1 Bedroom': '1 bed', '2 Bedroom': '2 bed', '3 Bedroom': '3 bed' }[t] || t);\n  const store = { get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} } };\n  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));\n\n  let data = null;          // week on screen\n  let view = store.get('cs_view') || 'day';\n  let me = null;            // signed-in person and their permissions\n  const can = (perm) => Boolean(me && me.perms && me.perms[perm]);\n  const VIEW_PERM = { day: 'view_day', board: 'view_board', props: 'view_properties', users: 'manage_users', account: null };\n  const allowed = (v) => v in VIEW_PERM && (!VIEW_PERM[v] || can(VIEW_PERM[v]));\n  let selected = null;      // selected date in day view\n  let version = null;       // bookings version from the server\n  let boardDirty = true;    // board is rebuilt only when it's actually shown\n  let props = null;\n  const weeks = new Map();  // weekStart → data (instant back/forward)\n  const inflight = new Map();\n\n  function toast(msg) {\n    document.querySelectorAll('.toast').forEach((t) => t.remove());\n    const t = document.createElement('div');\n    t.className = 'toast'; t.textContent = msg;\n    document.body.appendChild(t);\n    setTimeout(() => t.remove(), 2600);\n  }\n\n  async function getJSON(url) {\n    const r = await fetch(url, { credentials: 'same-origin' });\n    if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }\n    const body = await r.json().catch(() => ({}));\n    if (!r.ok) throw new Error(body.error || 'Could not load the schedule');\n    return body;\n  }\n\n  // Weeks are keyed by their start date; \"\" means \"the week containing today\".\n  function fetchWeek(date, fresh = false) {\n    const key = (date || 'now') + (fresh ? ':fresh' : '');\n    if (inflight.has(key)) return inflight.get(key);\n    const q = new URLSearchParams();\n    if (date) q.set('date', date);\n    if (fresh) q.set('refresh', '1');\n    const p = getJSON('/api/week?' + q).then((w) => { weeks.set(w.weekStart, w); version = w.version; return w; })\n      .finally(() => inflight.delete(key));\n    inflight.set(key, p);\n    return p;\n  }\n  function prefetchAround(w) {\n    idle(() => { for (const d of [w.nextWeek, w.prevWeek]) if (!weeks.has(d)) fetchWeek(d).catch(() => {}); });\n  }\n\n  const signature = (w) => w && JSON.stringify([w.version, w.weekStart, w.today, w.totals, w.days.map((d) => [d.cleans, d.arrivals, d.hasNew])]);\n\n  let navToken = 0;\n  async function showWeek(date, { fresh = false, quiet = false } = {}) {\n    const my = ++navToken;\n    const cached = !fresh && date && weeks.get(date);\n    if (cached) apply(cached);                        // instant from memory\n    else document.body.classList.add('is-loading');   // keep old week visible, just dimmed\n    $('refresh').disabled = true;\n    try {\n      const w = await fetchWeek(date, fresh);\n      if (my === navToken) apply(w); // ignore answers for weeks the user has already moved past\n      prefetchAround(w);\n      if (fresh && !quiet) toast('Up to date with Guesty');\n    } catch (e) {\n      if (e.message !== 'signed out') $('banners').innerHTML = `<div class=\"banner error\">${esc(e.message)}</div>`;\n    } finally {\n      document.body.classList.remove('is-loading');\n      $('refresh').disabled = false;\n    }\n  }\n\n  function apply(w) {\n    const same = data && signature(data) === signature(w);\n    const weekChanged = !data || data.weekStart !== w.weekStart;\n    data = w;\n    if (weekChanged || !data.dates.includes(selected)) selected = data.dates.includes(data.today) ? data.today : data.dates[0];\n    history.replaceState(null, '', data.dates.includes(data.today) ? location.pathname : `?week=${data.weekStart}`);\n    if (same && !weekChanged) { renderFoot(); return; } // nothing changed: don't touch the screen\n    boardDirty = true;\n    render();\n  }\n\n  // ---------- rendering ----------\n  function render() {\n    const { weekStart, weekEnd, today, totals, linen, warnings, mock } = data;\n    const isThisWeek = data.dates.includes(today);\n    $('week-title').textContent = `${shortDate(weekStart)} – ${shortDate(weekEnd)}`;\n    $('when').textContent = isThisWeek ? 'This week' : weekStart > today ? 'Upcoming' : 'Past week';\n    $('this').classList.toggle('hidden', isThisWeek);\n    $('newpill').innerHTML = totals.newBookings ? `<span class=\"newpill\">${totals.newBookings} new booking${totals.newBookings > 1 ? 's' : ''}</span>` : '';\n\n    const banners = [];\n    if (mock) banners.push('<div class=\"banner\">Showing <b>sample data</b>. Add your Guesty keys in Cloudflare to see live bookings.</div>');\n    for (const w of warnings || []) banners.push(`<div class=\"banner\">${esc(w)}</div>`);\n    $('banners').innerHTML = banners.join('');\n\n    $('m-out').textContent = totals.checkOuts;\n    $('m-in').textContent = totals.checkIns;\n    $('m-turn').textContent = totals.turnovers;\n    if (totals.linenSets !== null) $('m-linen').innerHTML = linen.map((r) => `<div class=\"item\"><div class=\"v\">${r.sets}</div><div class=\"t\">${esc(r.type)}</div></div>`).join('') +\n      `<div class=\"item total\"><div class=\"v\">${totals.linenSets}</div><div class=\"t\">Total sets</div></div>`;\n\n    renderStrip();\n    renderDay();\n    if (view === 'board') renderBoard();\n    renderFoot();\n  }\n\n  function renderFoot() {\n    const at = new Date(data.generatedAt);\n    $('foot').textContent = `Bookings last checked with Guesty at ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${data.statuses.join(' + ')} bookings only`;\n  }\n\n  function renderStrip() {\n    $('strip').innerHTML = data.days.map((d) => {\n      const cls = ['dbtn', d.date === data.today ? 'today' : '', d.date < data.today ? 'past' : ''].join(' ');\n      return `<button class=\"${cls}\" role=\"tab\" aria-selected=\"${d.date === selected}\" data-date=\"${d.date}\">\n        ${d.hasNew ? '<i class=\"newdot\" title=\"New booking\"></i>' : ''}\n        <div class=\"dn\">${WD_SHORT.format(D(d.date))}</div>\n        <div class=\"dd\">${D(d.date).getUTCDate()}</div>\n        <div class=\"dc\"><b>${d.cleans}</b><span class=\"lbl\"> out</span><span class=\"sep\"> · </span><em>${d.arrivals}</em><span class=\"lbl\"> in</span></div>\n      </button>`;\n    }).join('');\n  }\n  $('strip').addEventListener('click', (e) => {\n    const b = e.target.closest('.dbtn');\n    if (!b || b.dataset.date === selected) return;\n    selected = b.dataset.date;\n    $('strip').querySelectorAll('.dbtn').forEach((x) => x.setAttribute('aria-selected', x === b));\n    renderDay();\n  });\n\n  function chip(kind, e) {\n    if (!e) return '';\n    return `<span class=\"chip ${kind}\">${kind === 'out' ? 'Out' : 'In'} ${esc(e.time || '—')}${e.planned ? ' <small>planned</small>' : ''}</span>`;\n  }\n  function groupByBuilding(units) {\n    const map = new Map();\n    for (const u of units) {\n      if (!map.has(u.building)) map.set(u.building, { name: u.building, postcode: u.postcode, units: [] });\n      map.get(u.building).units.push(u);\n    }\n    return [...map.values()];\n  }\n  function section(kind, title, hint, units) {\n    if (!units.length) return '';\n    const groups = groupByBuilding(units).map((g) => `\n      <div class=\"bldg\">\n        <div class=\"bldg-name\">${esc(g.name)}<span>${esc(g.postcode)}</span></div>\n        ${g.units.map((u) => {\n          const isNew = (u.checkIn && u.checkIn.isNew) || (u.checkOut && u.checkOut.isNew);\n          const guests = u.checkIn && u.checkIn.guests ? `${u.checkIn.guests} guest${u.checkIn.guests > 1 ? 's' : ''}` : '';\n          return `<div class=\"row\">\n            <span class=\"u\">${esc(u.label)}</span>\n            <span class=\"t\">${esc(shortType(u.unitType))}</span>\n            ${guests ? `<span class=\"g\">· ${guests}</span>` : ''}\n            ${isNew ? '<span class=\"new\">New</span>' : ''}\n            <span class=\"times\">${chip('out', u.checkOut)}${u.checkOut && u.checkIn ? '<span class=\"arrow\">→</span>' : ''}${chip('in', u.checkIn)}</span>\n          </div>`;\n        }).join('')}\n      </div>`).join('');\n    return `<div class=\"section s-${kind}\">\n      <div class=\"shead\"><span class=\"bar\"></span><h3>${title}</h3><span class=\"count\">${units.length}</span><span class=\"hint\">${hint}</span></div>\n      ${groups}\n    </div>`;\n  }\n  function renderDay() {\n    const day = data.days.find((d) => d.date === selected);\n    if (!day) return;\n    const turn = day.units.filter((u) => u.checkOut && u.checkIn);\n    const outs = day.units.filter((u) => u.checkOut && !u.checkIn);\n    const ins = day.units.filter((u) => !u.checkOut && u.checkIn);\n    const linenBits = Object.entries(day.linen).map(([t, n]) => `${esc(shortType(t))} <b>${n}</b>`).join(' · ');\n    $('daypanel').innerHTML = `\n      <div class=\"dayhead\"><h2>${esc(longDate(day.date))}</h2>${linenBits ? `<span class=\"dlinen\">Linen: ${linenBits}</span>` : ''}</div>\n      ${day.units.length ? '' : '<div class=\"empty\"><b>Nothing scheduled</b>No check-ins or check-outs on this day.</div>'}\n      ${section('turn', 'Same-day turnovers', 'Clean between check-out and check-in', turn)}\n      ${section('out', 'Check-outs', 'Clean — nobody arriving today', outs)}\n      ${section('in', 'Arrivals', 'Make sure the flat is ready', ins)}`;\n  }\n\n  function renderBoard() {\n    boardDirty = false;\n    const { dates, days, board, today } = data;\n    const head = `<colgroup><col class=\"first\">${dates.map(() => '<col>').join('')}</colgroup>\n      <thead><tr><th class=\"first-col\"></th>${days.map((d) => `<th class=\"${d.date === today ? 'today' : ''}\"><button data-date=\"${d.date}\" title=\"Open ${esc(longDate(d.date))}\">\n        <div class=\"dn\">${WD_SHORT.format(D(d.date))}</div><div class=\"dd\">${D(d.date).getUTCDate()}</div><div class=\"dc\">${d.cleans} out · ${d.arrivals} in</div></button></th>`).join('')}</tr></thead>`;\n    const body = board.map((b) => `\n      <tr class=\"b-row\"><td colspan=\"${dates.length + 1}\"><div class=\"b-name\">${esc(b.name)}<span>${esc(b.postcode)}</span></div></td></tr>\n      ${b.units.map((u) => `<tr>\n        <td class=\"first-col unit\"><span class=\"u\">${esc(u.label)}</span><span class=\"t\">${esc(shortType(u.unitType))}</span></td>\n        ${u.cells.map((c, i) => {\n          const morning = Boolean(c.out) || (c.occ && !c.in);\n          const night = c.occ;\n          let h = '';\n          if (morning) h += `<div class=\"half l${c.out ? ' end' : ''}\"></div>`;\n          if (night) h += `<div class=\"half r${c.in ? ' start' : ''}${c.in && c.in.isNew ? ' isnew' : ''}\"></div>`;\n          if (c.out && c.in) h += `<span class=\"mark turn\" title=\"Out ${esc(c.out.time)} → In ${esc(c.in.time)}\">${esc(compact(c.out.time).replace(/am|pm/, ''))}→${esc(compact(c.in.time).replace(/am|pm/, ''))}</span>`;\n          else if (c.out) h += `<span class=\"mark out\" title=\"Check-out ${esc(c.out.time)}\">${esc(compact(c.out.time))}</span>`;\n          else if (c.in) h += `<span class=\"mark in\" title=\"Check-in ${esc(c.in.time)}\">${esc(compact(c.in.time))}</span>`;\n          return `<td class=\"cell${dates[i] === today ? ' today' : ''}\">${h}</td>`;\n        }).join('')}\n      </tr>`).join('')}`).join('');\n    const foot = `<tfoot>\n      <tr><td class=\"first-col\">Cleans</td>${days.map((d) => `<td class=\"o\">${d.cleans || '–'}</td>`).join('')}</tr>\n      <tr><td class=\"first-col\">Arrivals</td>${days.map((d) => `<td class=\"i\">${d.arrivals || '–'}</td>`).join('')}</tr>\n    </tfoot>`;\n    $('board').innerHTML = head + `<tbody>${body}</tbody>` + foot;\n  }\n  $('board').addEventListener('click', (e) => {\n    const b = e.target.closest('thead button');\n    if (!b) return;\n    selected = b.dataset.date;\n    setView('day');\n    renderStrip(); renderDay();\n  });\n\n  async function loadProps() {\n    try {\n      if (!props) $('props').innerHTML = '<div class=\"loading\">Loading…</div>';\n      const p = await getJSON('/api/properties');\n      if (props && JSON.stringify(p) === JSON.stringify(props)) return;\n      props = p;\n      const counts = Object.entries(p.counts).map(([t, n]) => `${n} × ${shortType(t)}`).join(' · ');\n      $('props-sub').textContent = `${p.total} flats · ${counts}`;\n      $('props').innerHTML = p.buildings.map((b) => `<div class=\"card pcard\">\n        <h3>${esc(b.name)}</h3><div class=\"pc\">${esc(b.postcode)}</div>\n        ${b.units.map((u) => `<div class=\"prow\" title=\"${esc(u.address)}\"><span class=\"u\">${esc(u.label)}</span><span>${esc(shortType(u.unitType))}</span><span class=\"t\">Out ${esc(u.checkOut)} · In ${esc(u.checkIn)}</span></div>`).join('')}\n      </div>`).join('');\n    } catch (e) {\n      if (e.message !== 'signed out') $('props').innerHTML = `<div class=\"banner error\">${esc(e.message)}</div>`;\n    }\n  }\n\n  // ---------- text for WhatsApp ----------\n  function dayText(day) {\n    const lines = [`_${longDate(day.date)}_`];\n    if (!day.units.length) { lines.push('- Nothing scheduled'); return lines; }\n    for (const g of groupByBuilding(day.units)) {\n      for (const u of g.units) {\n        const parts = [];\n        if (u.checkOut) parts.push(`Check-out at ${u.checkOut.time}`);\n        if (u.checkIn) parts.push(`Check-in at ${u.checkIn.time}`);\n        lines.push(`- *${u.name}* - ${parts.join(' | ')}${(u.checkIn && u.checkIn.isNew) ? ' (NEW)' : ''}`);\n      }\n    }\n    const linen = Object.entries(day.linen).map(([t, n]) => `${t}: ${n}`).join(', ');\n    if (linen) lines.push(`Linen: ${linen}`);\n    return lines;\n  }\n  function weekText() {\n    const lines = [`*Cityscape Schedule* — ${longDate(data.weekStart)} to ${longDate(data.weekEnd)}`, '', '*Laundry*'];\n    for (const r of data.linen) lines.push(`${r.type}: ${r.sets}`);\n    lines.push(`Total: ${data.totals.linenSets}`, '', '*Cleaning*');\n    for (const d of data.days) lines.push('', ...dayText(d));\n    return lines.join('\\n');\n  }\n\n  // ---------- views ----------\n  function setView(v) {\n    if (!allowed(v)) v = ['day', 'board', 'props', 'account'].find(allowed);\n    view = v;\n    store.set('cs_view', v);\n    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === v));\n    $('me-btn').setAttribute('aria-selected', v === 'account');\n    $('week-area').classList.toggle('hidden', !(v === 'day' || v === 'board'));\n    $('view-day').classList.toggle('hidden', v !== 'day');\n    $('view-board').classList.toggle('hidden', v !== 'board');\n    $('view-props').classList.toggle('hidden', v !== 'props');\n    $('view-users').classList.toggle('hidden', v !== 'users');\n    $('view-account').classList.toggle('hidden', v !== 'account');\n    $('foot').classList.toggle('hidden', !(v === 'day' || v === 'board'));\n    $('copy-label').textContent = v === 'board' ? 'Copy week' : 'Copy day';\n    if (v === 'board' && data && boardDirty) renderBoard();\n    if (v === 'props') loadProps();\n    if (v === 'users') loadUsers();\n    if (v === 'account') renderAccount();\n  }\n\n  // ---------- who's signed in ----------\n  const initials = (n) => (n || '?').split(/\\s+/).filter((w) => /^[a-z]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');\n  function applyPermissions() {\n    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('hidden', !allowed(b.dataset.view)));\n    $('copy').classList.toggle('hidden', !can('copy_print'));\n    $('print').classList.toggle('hidden', !can('copy_print'));\n    $('refresh').classList.toggle('hidden', !can('refresh'));\n    document.querySelector('.metric.linen').classList.toggle('hidden', !can('view_linen'));\n    document.querySelector('.summary').classList.toggle('no-linen', !can('view_linen'));\n    $('me-avatar').textContent = initials(me.name);\n    $('me-name').textContent = me.name.split(' ')[0];\n  }\n  function renderAccount() {\n    const b = me.buildings === 'all' ? 'All buildings' : (me.buildings.length ? me.buildings.map(esc).join(', ') : 'None assigned yet');\n    const perms = (window.__permsList || []).filter(([k]) => can(k)).map(([, label]) => esc(label)).join(', ');\n    $('acct-info').innerHTML = `<h3>${esc(me.name)}</h3><dl>\n      <dt>Username</dt><dd>${esc(me.username)}</dd>\n      <dt>Role</dt><dd style=\"text-transform:capitalize\">${esc(me.role)}</dd>\n      <dt>Email</dt><dd>${esc(me.email || '—')}</dd>\n      <dt>Buildings</dt><dd>${b}</dd>\n      <dt>Can use</dt><dd>${perms || '—'}</dd></dl>`;\n    $('pw-form').classList.toggle('hidden', !!me.isOwner);\n  }\n  $('pw-form').addEventListener('submit', async (e) => {\n    e.preventDefault();\n    const msg = $('pw-msg');\n    if ($('pw-new').value !== $('pw-new2').value) { msg.className = 'form-msg err'; msg.textContent = 'The two new passwords don’t match.'; return; }\n    try {\n      await send('POST', '/api/me/password', { current: $('pw-cur').value, password: $('pw-new').value });\n      e.target.reset(); msg.className = 'form-msg ok'; msg.textContent = 'Password changed. Other devices have been signed out.';\n    } catch (err) { msg.className = 'form-msg err'; msg.textContent = err.message; }\n  });\n\n  async function send(method, url, body) {\n    const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });\n    if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }\n    const out = await r.json().catch(() => ({}));\n    if (!r.ok) throw new Error(out.error || 'Something went wrong');\n    return out;\n  }\n\n  // ---------- users (admins) ----------\n  let U = null;          // { users, perms, roles, defaults, buildings }\n  let editing = null;    // user id being edited, 'new', or null\n  const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', user: 'User', cleaner: 'Cleaner' };\n  const when = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never';\n  async function loadUsers() {\n    try { U = await getJSON('/api/users'); renderUsers(); }\n    catch (e) { if (e.message !== 'signed out') $('users-msg').innerHTML = `<div class=\"banner error\">${esc(e.message)}</div>`; }\n  }\n  function renderUsers() {\n    const active = U.users.filter((u) => u.active).length;\n    $('users-sub').textContent = `${active} active · owner recovery login not listed`;\n    $('users-list').innerHTML = U.users.length ? U.users.map((u) => `\n      <tr class=\"${u.id === editing ? 'sel' : ''} ${u.active ? '' : 'off'}\">\n        <td class=\"who\"><b>${esc(u.name)}</b><span>${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}${u.active ? '' : ' · deactivated'}</span></td>\n        <td><span class=\"role ${u.role}\">${ROLE_LABEL[u.role] || esc(u.role)}</span></td>\n        <td class=\"hide-sm\">${u.buildings === 'all' ? 'All' : u.buildings.length ? esc(u.buildings.length + ' building' + (u.buildings.length > 1 ? 's' : '')) : '<span style=\"color:var(--out)\">None yet</span>'}</td>\n        <td class=\"hide-sm\">${when(u.lastLoginAt)}</td>\n        <td><button class=\"btn\" data-edit=\"${u.id}\">Edit</button></td>\n      </tr>`).join('') : '<tr><td colspan=\"5\" class=\"empty\"><b>No users yet</b>Click “Add user” to create the first account.</td></tr>';\n    if (editing) renderForm(); else { $('user-form').classList.add('hidden'); document.querySelector('.users-layout').classList.remove('editing'); }\n  }\n  $('users-list').addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) { editing = b.dataset.edit; renderUsers(); } });\n  $('add-user').onclick = () => { editing = 'new'; renderUsers(); $('uf-name').focus(); };\n\n  function genPassword() {\n    const words = ['maple', 'harbour', 'linen', 'cobalt', 'willow', 'amber', 'granite', 'orchid', 'copper', 'saffron', 'meadow', 'pebble'];\n    const r = crypto.getRandomValues(new Uint32Array(3));\n    return words[r[0] % words.length][0].toUpperCase() + words[r[0] % words.length].slice(1) + '-' + words[r[1] % words.length] + '-' + (100 + (r[2] % 900));\n  }\n  function renderForm() {\n    const isNew = editing === 'new';\n    const u = isNew ? { name: '', username: '', email: '', role: 'user', active: true, ...U.defaults.user } : U.users.find((x) => x.id === editing);\n    if (!u) { editing = null; return renderUsers(); }\n    const allB = u.buildings === 'all';\n    const f = $('user-form');\n    f.innerHTML = `\n      <h3>${isNew ? 'Add user' : 'Edit ' + esc(u.name)}</h3>\n      <label for=\"uf-name\">Full name</label><input id=\"uf-name\" type=\"text\" value=\"${esc(u.name)}\" required>\n      <label for=\"uf-username\">Username</label><input id=\"uf-username\" type=\"text\" value=\"${esc(u.username)}\" autocapitalize=\"none\" spellcheck=\"false\" required>\n      <div class=\"hint\">Used to sign in. Lowercase, e.g. maria or j.smith</div>\n      <label for=\"uf-email\">Email</label><input id=\"uf-email\" type=\"email\" value=\"${esc(u.email || '')}\" placeholder=\"name@example.com\">\n      <div class=\"hint\">Saved for notifications later.</div>\n      <label for=\"uf-role\">Role</label>\n      <select id=\"uf-role\">${U.roles.map((r) => `<option value=\"${r}\" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>\n      <label for=\"uf-pw\">${isNew ? 'Password' : 'Reset password'}</label>\n      <div class=\"pwrow\"><input id=\"uf-pw\" type=\"text\" autocomplete=\"new-password\" placeholder=\"${isNew ? 'At least 8 characters' : 'Leave blank to keep their password'}\" ${isNew ? 'required' : ''}><button class=\"btn\" type=\"button\" id=\"uf-gen\">Generate</button></div>\n      <div class=\"hint\">${isNew ? 'Share it with them privately. They can change it under My account.' : 'Setting a new password signs them out everywhere.'}</div>\n      <fieldset><legend>Permissions</legend><div class=\"checks\">\n        ${U.perms.map(([k, label]) => `<label><input type=\"checkbox\" data-perm=\"${k}\" ${u.perms && u.perms[k] ? 'checked' : ''}>${esc(label)}</label>`).join('')}\n      </div></fieldset>\n      <fieldset><legend>Buildings they can see</legend>\n        <div class=\"radio\"><label><input type=\"radio\" name=\"uf-bmode\" value=\"all\" ${allB ? 'checked' : ''}>All buildings</label><label><input type=\"radio\" name=\"uf-bmode\" value=\"some\" ${allB ? '' : 'checked'}>Only these</label></div>\n        <div class=\"checks ${allB ? 'hidden' : ''}\" id=\"uf-blist\">${U.buildings.map((b) => `<label><input type=\"checkbox\" data-b=\"${esc(b)}\" ${!allB && u.buildings.includes(b) ? 'checked' : ''}>${esc(b)}</label>`).join('')}</div>\n      </fieldset>\n      ${isNew ? '' : `<fieldset><legend>Status</legend><div class=\"radio\"><label><input type=\"radio\" name=\"uf-active\" value=\"1\" ${u.active ? 'checked' : ''}>Active</label><label><input type=\"radio\" name=\"uf-active\" value=\"0\" ${u.active ? '' : 'checked'}>Deactivated</label></div></fieldset>`}\n      <div class=\"form-msg\" id=\"uf-msg\"></div>\n      <div id=\"uf-confirm\"></div>\n      <div class=\"form-actions\">\n        <button class=\"btn primary\" type=\"submit\">${isNew ? 'Create user' : 'Save changes'}</button>\n        <button class=\"btn\" type=\"button\" id=\"uf-cancel\">Cancel</button>\n        <span class=\"spacer\"></span>\n        ${isNew || u.id === me.id ? '' : '<button class=\"btn danger\" type=\"button\" id=\"uf-del\">Delete</button>'}\n      </div>`;\n    f.classList.remove('hidden');\n    document.querySelector('.users-layout').classList.add('editing');\n    $('uf-gen').onclick = () => { $('uf-pw').value = genPassword(); };\n    $('uf-cancel').onclick = () => { editing = null; renderUsers(); };\n    f.querySelectorAll('[name=uf-bmode]').forEach((r) => r.onchange = () => $('uf-blist').classList.toggle('hidden', f.querySelector('[name=uf-bmode]:checked').value === 'all'));\n    // Picking a role fills in that role's usual settings; everything stays editable.\n    $('uf-role').onchange = () => {\n      const d = U.defaults[$('uf-role').value];\n      f.querySelectorAll('[data-perm]').forEach((c) => { c.checked = !!d.perms[c.dataset.perm]; });\n      const all = d.buildings === 'all';\n      f.querySelector(`[name=uf-bmode][value=${all ? 'all' : 'some'}]`).checked = true;\n      $('uf-blist').classList.toggle('hidden', all);\n    };\n    if ($('uf-del')) $('uf-del').onclick = () => {\n      $('uf-confirm').innerHTML = `<div class=\"confirm-del\">Delete ${esc(u.name)}? They won’t be able to sign in and this can’t be undone. <button class=\"btn danger\" type=\"button\" id=\"uf-del-yes\">Yes, delete</button> <button class=\"btn\" type=\"button\" id=\"uf-del-no\">Keep</button></div>`;\n      $('uf-del-no').onclick = () => { $('uf-confirm').innerHTML = ''; };\n      $('uf-del-yes').onclick = async () => {\n        try { await send('DELETE', '/api/users/' + u.id); editing = null; toast(`${u.name} deleted`); loadUsers(); }\n        catch (err) { $('uf-msg').className = 'form-msg err'; $('uf-msg').textContent = err.message; }\n      };\n    };\n    f.onsubmit = async (e) => {\n      e.preventDefault();\n      const some = f.querySelector('[name=uf-bmode]:checked').value === 'some';\n      const body = {\n        name: $('uf-name').value, username: $('uf-username').value, email: $('uf-email').value, role: $('uf-role').value,\n        perms: Object.fromEntries([...f.querySelectorAll('[data-perm]')].map((c) => [c.dataset.perm, c.checked])),\n        buildings: some ? [...f.querySelectorAll('[data-b]:checked')].map((c) => c.dataset.b) : 'all',\n      };\n      if ($('uf-pw').value) body.password = $('uf-pw').value;\n      if (!isNew) body.active = f.querySelector('[name=uf-active]:checked').value === '1';\n      try {\n        const out = await send(isNew ? 'POST' : 'PUT', isNew ? '/api/users' : '/api/users/' + u.id, body);\n        toast(isNew ? `${out.user.name} can now sign in as “${out.user.username}”` : 'Saved');\n        editing = null; loadUsers();\n        if (out.user.id === me.id) { me = { ...me, ...out.user }; applyPermissions(); }\n      } catch (err) { $('uf-msg').className = 'form-msg err'; $('uf-msg').textContent = err.message; }\n    };\n  }\n\n  // ---------- live updates ----------\n  // Guesty tells the server about every booking change; the page checks a tiny \"version\" every 15 seconds.\n  function setLive(state, title) {\n    const el = $('live');\n    el.className = 'live' + (state === 'on' ? ' on' : '');\n    el.querySelector('.lbl').textContent = state === 'on' ? 'Live' : state === 'preview' ? 'Preview' : 'Auto';\n    el.title = title;\n  }\n  let polling = false;\n  async function checkVersion() {\n    if (polling || document.hidden || !data) return;\n    polling = true;\n    try {\n      const v = await getJSON('/api/version');\n      setLive(v.webhook === 'registered' ? 'on' : v.webhook === 'preview' ? 'preview' : 'auto',\n        v.webhook === 'registered' ? 'Instant updates from Guesty are on' : 'Checking Guesty every few minutes');\n      if (version && v.version !== version) {\n        const before = data.totals.newBookings;\n        weeks.clear();\n        await showWeek(data.weekStart, { quiet: true });\n        toast(data.totals.newBookings > before ? 'New booking — schedule updated' : 'Bookings changed — schedule updated');\n      }\n      version = v.version;\n    } catch (_) { /* offline for a moment: try again next tick */ }\n    finally { polling = false; }\n  }\n\n  // ---------- wiring ----------\n  document.querySelectorAll('.seg button').forEach((b) => b.onclick = () => setView(b.dataset.view));\n  $('prev').onclick = () => data && showWeek(data.prevWeek);\n  $('next').onclick = () => data && showWeek(data.nextWeek);\n  $('this').onclick = () => showWeek('');\n  $('refresh').onclick = () => { weeks.clear(); showWeek(data ? data.weekStart : '', { fresh: true }); };\n  $('print').onclick = () => window.print();\n  $('copy').onclick = async () => {\n    if (!data) return;\n    const text = view === 'board' ? weekText() : dayText(data.days.find((d) => d.date === selected)).join('\\n');\n    try { await navigator.clipboard.writeText(text); toast('Copied — paste into WhatsApp'); }\n    catch (_) { toast('This browser blocked copying'); }\n  };\n  document.addEventListener('keydown', (e) => {\n    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || !data || !(view === 'day' || view === 'board')) return;\n    if (e.key === 'ArrowLeft') showWeek(data.prevWeek);\n    if (e.key === 'ArrowRight') showWeek(data.nextWeek);\n  });\n\n  $('me-btn').onclick = () => setView('account');\n  (async () => {\n    try { const r = await getJSON('/api/me'); me = r.user; window.__permsList = r.perms; }\n    catch (_) { return; }\n    applyPermissions();\n    setView(view);\n    if (can('view_day') || can('view_board')) {\n      const w = new URLSearchParams(location.search).get('week');\n      showWeek(/^\\d{4}-\\d{2}-\\d{2}$/.test(w || '') ? w : '').then(() => checkVersion());\n    }\n  })();\n  setInterval(checkVersion, 15000);\n  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });\n})();\n" },
  "favicon.svg": { type: "image/svg+xml", hash: "j2x6t6", body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><rect width=\"32\" height=\"32\" rx=\"8\" fill=\"#1f4e5f\"/><path d=\"M7 24V14h5v10M13.5 24V8h5v16M20 24V12h5v12\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2\" stroke-linejoin=\"round\"/><path d=\"M5 24.5h22\" stroke=\"#fff\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>\n" },
  "manifest.webmanifest": { type: "application/manifest+json", hash: "12ddyq5", body: "{ \"name\": \"Cityscape Schedule\", \"short_name\": \"Schedule\", \"start_url\": \"/\", \"display\": \"standalone\", \"background_color\": \"#f5f4f0\", \"theme_color\": \"#1f4e5f\", \"icons\": [{ \"src\": \"/favicon.svg\", \"sizes\": \"any\", \"type\": \"image/svg+xml\" }] }\n" },
};

// Sample data used only when no Guesty keys are set (preview mode).
const MOCK = (() => {
  const UNITS = [
    ['m1', 'FL-7, 177 Gloucester', '177 Gloucester Place, Marylebone, NW1 6DX', '177 Gloucester Place', 1],
    ['m2', 'FL-8, 177 Gloucester', '177 Gloucester Place, Marylebone, NW1 6DX', '177 Gloucester Place', 1],
    ['m3', 'FL-9, 177 Gloucester', '177 Gloucester Place, Marylebone, NW1 6DX', '177 Gloucester Place', 2],
    ['m4', 'FL-1, 25 Old Gloucester', '25 Old Gloucester Street, London, WC1N 3AX', '25 Old Gloucester Street', 1],
    ['m5', 'FL-2, 25 Old Gloucester', '25 Old Gloucester Street, London, WC1N 3AX', '25 Old Gloucester Street', 1],
    ['m6', 'FL-3, 25 Old Gloucester', '25 Old Gloucester Street, London, WC1N 3AX', '25 Old Gloucester Street', 0],
    ['m7', 'FL-A, 74 Queensway', '74 Queensway, London, W2 3RL', '74 Queensway', 1],
    ['m8', 'FL-B, 74 Queensway', '74 Queensway, London, W2 3RL', '74 Queensway', 2],
    ['m9', '1st Floor, 2 Rossmore Road', '1st Floor Flat, 2 Rossmore Road, Marylebone, NW1 6NJ', '2 Rossmore Road', 1],
    ['m10', 'FL-1, 42 Bell Street', 'Flat 1, 42 Bell Street, Marylebone, NW1 5AW', '42 Bell Street', 1],
    ['m11', '50A, Chalk Farm', '50A Chalk Farm Road, Camden Town, NW1 8AN', '50A Chalk Farm Road', 2],
    ['m12', 'FL-1, 79 Great Titchfield', 'Flat 1, 79 Great Titchfield St, Fitzrovia, W1W 6RG', '79 Great Titchfield St', 1],
    ['m13', 'FL-18, Sheridan Buildings', 'Flat 18, Sheridan Buildings, Martlett Court, Holborn, WC2B 5SD', 'Sheridan Buildings', 0],
    ['m14', 'FL-2, 40 Balcombe Street', '40 Balcombe Street, Marylebone, NW1 6ND', '40 Balcombe Street', 1],
  ];
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  function rand(seed) { let x = 0; for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0; x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return (x % 10000) / 10000; }
  let all = null;
  function build() {
    const out = [];
    for (const [id, , , , bedrooms] of UNITS) {
      let d = addDays('2026-08-01', Math.floor(rand(id) * 3)), n = 0;
      while (d < '2027-06-01') {
        const s = id + n, nights = 1 + Math.floor(rand(s + 'n') * 5), outD = addDays(d, nights);
        out.push({
          _id: `${id}-r${n}`, listingId: id, status: 'confirmed', confirmationCode: 'HM' + Math.floor(rand(s + 'c') * 1e8),
          checkInDateLocalized: d, checkOutDateLocalized: outD,
          plannedArrival: rand(s + 'i') < 0.25 ? (rand(s + 'y') < 0.5 ? '16:00' : '18:30') : null,
          plannedDeparture: rand(s + 'o') < 0.2 ? (rand(s + 'x') < 0.5 ? '10:30' : '11:00') : null,
          guestsCount: 1 + Math.floor(rand(s + 'g') * (bedrooms * 2 || 2)), nightsCount: nights,
          createdAt: new Date(Date.now() - (rand(s + 'new') < 0.08 ? 3 : 480) * 3600e3).toISOString(),
        });
        d = rand(s + 'gap') < 0.3 ? addDays(outD, 1) : outD; n++;
      }
    }
    return out;
  }
  return {
    listings: () => UNITS.map(([_id, nickname, full, street, bedrooms]) => ({ _id, nickname, title: nickname, bedrooms, active: true, address: { full, street, zipcode: full.split(', ').pop() }, defaultCheckInTime: '15:00', defaultCheckOutTime: '10:00' })),
    stays: (from, to, statuses) => { all = all || build(); return all.filter((r) => r.checkInDateLocalized <= to && r.checkOutDateLocalized >= from && statuses.includes(r.status)); },
  };
})();


const GUESTY = 'https://open-api.guesty.com';
const SESSION_DAYS = 30;
const WINDOW_BEFORE = 14;   // days of bookings kept before the current week
const WINDOW_AFTER = 84;    // …and after (12 weeks ahead)
const MEM_TTL = 10e3;       // how long one Worker instance trusts its in-memory copy

// ---------------------------------------------------------------- config
function config(env) {
  const json = (v) => { try { return JSON.parse(v || '{}'); } catch (_) { return {}; } };
  return {
    mock: !env.GUESTY_CLIENT_ID || !env.GUESTY_CLIENT_SECRET || env.MOCK === '1',
    weekStartDay: Number(env.WEEK_START_DAY ?? 6),
    statuses: (env.RESERVATION_STATUSES || 'confirmed').split(',').map((s) => s.trim()).filter(Boolean),
    defaultIn: env.DEFAULT_CHECKIN_TIME || '15:00',
    defaultOut: env.DEFAULT_CHECKOUT_TIME || '10:00',
    typeOverrides: json(env.UNIT_TYPE_OVERRIDES),
    buildingOverrides: json(env.BUILDING_OVERRIDES),
    hidden: (env.HIDDEN_LISTINGS || '').split(',').map((s) => s.trim()).filter(Boolean),
    newHours: Number(env.NEW_BOOKING_HOURS || 24),
  };
}

// ---------------------------------------------------------------- small helpers
const enc = new TextEncoder();
function hex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmac(keyHex, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const secretKey = (env) => sha256(`cs:${env.APP_PASSWORD || ''}:${env.GUESTY_CLIENT_SECRET || 'preview'}`);

function todayInLondon() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()); }
function addDays(d, n) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function weekStartFor(d, startDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) d = todayInLondon();
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  return addDays(d, -((dow - startDay + 7) % 7));
}
function fmtTime(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}/.test(hhmm)) return null;
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}.${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`;
}

// ---------------------------------------------------------------- responses
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...extra } });
}
function redirect(loc, extra = {}) { return new Response(null, { status: 302, headers: { Location: loc, 'Cache-Control': 'no-store', ...extra } }); }
function asset(req, name) {
  const a = ASSETS[name];
  if (!a) return new Response('Not found', { status: 404 });
  const etag = `"${a.hash}"`;
  const versioned = new URL(req.url).searchParams.has('v');
  const headers = {
    'Content-Type': a.type, ETag: etag, ...SEC,
    'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : a.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
  };
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  return new Response(a.body, { headers });
}

// ---------------------------------------------------------------- users, roles & permissions
// Each person has their own username + password. Permissions are ticked per person on the Users page.
// "owner" + the APP_PASSWORD secret is a recovery login that always has full access.
const PERMS = [
  ['view_day', 'Day view'],
  ['view_board', 'Board (whole week)'],
  ['view_properties', 'Properties list'],
  ['view_linen', 'Linen totals'],
  ['view_guests', 'Guest numbers'],
  ['copy_print', 'Copy for WhatsApp & Print'],
  ['refresh', 'Refresh from Guesty'],
  ['manage_users', 'Manage users'],
];
const ROLES = ['admin', 'supervisor', 'user', 'cleaner'];
function roleDefaults(role) {
  // For now everyone gets everything; only admins manage users unless it's ticked for them.
  const perms = Object.fromEntries(PERMS.map(([k]) => [k, true]));
  perms.manage_users = role === 'admin';
  return { perms, buildings: role === 'cleaner' ? [] : 'all' };
}
const PBKDF2_ITER = 20000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function hashPassword(pw, saltB64, iter = PBKDF2_ITER) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return { salt: b64(salt), hash: b64(bits), iter };
}
async function checkPassword(pw, rec) {
  if (!rec || !rec.salt) return false;
  const h = await hashPassword(pw, rec.salt, rec.iter || PBKDF2_ITER);
  return safeEqual(h.hash, rec.hash);
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Passwords need at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

let memUsers = null; // { list, readAt }
async function loadUsers(env, fresh) {
  if (!fresh && memUsers && Date.now() - memUsers.readAt < MEM_TTL) return memUsers.list;
  const list = (await env.STORE.get('users', 'json')) || [];
  memUsers = { list, readAt: Date.now() };
  return list;
}
async function saveUsers(env, list) {
  await env.STORE.put('users', JSON.stringify(list));
  memUsers = { list, readAt: Date.now() };
}
async function ownerUser(env) {
  return {
    id: 'owner', username: 'owner', name: 'Owner (recovery login)', email: '', role: 'admin', isOwner: true, active: true,
    perms: Object.fromEntries(PERMS.map(([k]) => [k, true])), buildings: 'all',
    epoch: (await sha256('owner:' + (env.APP_PASSWORD || ''))).slice(0, 8),
  };
}
function publicUser(u) {
  const { pw, ...rest } = u;
  return rest;
}
const can = (u, perm) => Boolean(u && u.perms && u.perms[perm]);

// Session cookie: userId.epoch.expiry.signature — changing a password or deactivating bumps the epoch and signs the person out.
async function makeSession(env, user) {
  const body = `${user.id}.${user.epoch}.${Date.now() + SESSION_DAYS * 864e5}`;
  return body + '.' + (await hmac(await secretKey(env), 'session:' + body));
}
async function sessionUser(env, token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [id, epoch, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  if (!safeEqual(sig, await hmac(await secretKey(env), 'session:' + `${id}.${epoch}.${exp}`))) return null;
  const u = id === 'owner' ? await ownerUser(env) : (await loadUsers(env)).find((x) => x.id === id);
  if (!u || !u.active || String(u.epoch) !== epoch) return null;
  return u;
}
function cookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
const attempts = new Map(); // per-instance login throttle
function throttled(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 10 * 60e3);
  attempts.set(key, list);
  return list.length >= 10;
}
function recordFail(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }

async function login(env, username, password) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  if (username === 'owner') return env.APP_PASSWORD && safeEqual(password, env.APP_PASSWORD) ? ownerUser(env) : null;
  const users = await loadUsers(env, true);
  const u = users.find((x) => x.username === username && x.active);
  if (!u) { await hashPassword(password); return null; } // same work either way, so timing doesn't reveal usernames
  if (!(await checkPassword(password, u.pw))) return null;
  u.lastLoginAt = new Date().toISOString();
  await saveUsers(env, users);
  return u;
}

// ---- Users API (manage_users) ----
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
function cleanUserInput(body, existing) {
  const out = {};
  if ('name' in body || !existing) out.name = String(body.name || '').trim().slice(0, 80);
  if ('username' in body || !existing) out.username = String(body.username || '').trim().toLowerCase();
  if ('email' in body || !existing) out.email = String(body.email || '').trim().slice(0, 120);
  if ('role' in body || !existing) out.role = ROLES.includes(body.role) ? body.role : 'user';
  if ('perms' in body) out.perms = Object.fromEntries(PERMS.map(([k]) => [k, Boolean(body.perms && body.perms[k])]));
  if ('buildings' in body) out.buildings = body.buildings === 'all' ? 'all' : Array.isArray(body.buildings) ? body.buildings.map(String).slice(0, 200) : [];
  if ('active' in body) out.active = Boolean(body.active);
  if (out.name !== undefined && !out.name) return { error: 'Add the person’s name.' };
  if (out.username !== undefined && (!USERNAME_RE.test(out.username) || out.username === 'owner')) return { error: 'Usernames use 2–32 lowercase letters, numbers, dots, dashes or underscores (and can’t be “owner”).' };
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: 'That email address doesn’t look right.' };
  return { out };
}
async function usersApi(req, env, ctx, me, id) {
  const users = await loadUsers(env, true);
  if (req.method === 'GET' && !id) {
    const snap = await getSnapshot(env, ctx);
    const buildings = [...new Set([...listingMap(snap.listings, config(env)).values()].map((l) => l.building))].sort(byBuilding);
    return json({
      users: users.map(publicUser).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name)),
      perms: PERMS, roles: ROLES, defaults: Object.fromEntries(ROLES.map((r) => [r, roleDefaults(r)])), buildings,
    });
  }
  const body = req.method === 'DELETE' ? {} : await req.json().catch(() => ({}));
  if (req.method === 'POST' && !id) {
    const { out, error } = cleanUserInput(body);
    if (error) return json({ error }, 400);
    if (users.some((u) => u.username === out.username)) return json({ error: `The username “${out.username}” is already taken.` }, 400);
    const problem = passwordProblem(body.password);
    if (problem) return json({ error: problem }, 400);
    const d = roleDefaults(out.role);
    const user = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), active: true, perms: d.perms, buildings: d.buildings, ...out,
      pw: await hashPassword(body.password), epoch: 1, createdAt: new Date().toISOString(), createdBy: me.username,
    };
    users.push(user);
    await saveUsers(env, users);
    return json({ user: publicUser(user) });
  }
  const u = users.find((x) => x.id === id);
  if (!u) return json({ error: 'That person no longer exists.' }, 404);
  if (req.method === 'DELETE') {
    if (u.id === me.id) return json({ error: 'You can’t delete your own account.' }, 400);
    await saveUsers(env, users.filter((x) => x.id !== id));
    return json({ ok: true });
  }
  if (req.method === 'PUT') {
    const { out, error } = cleanUserInput(body, u);
    if (error) return json({ error }, 400);
    if (out.username && out.username !== u.username && users.some((x) => x.username === out.username)) return json({ error: `The username “${out.username}” is already taken.` }, 400);
    if (u.id === me.id && (out.active === false || (out.perms && !out.perms.manage_users))) return json({ error: 'You can’t remove your own access to manage users or deactivate yourself.' }, 400);
    let signOut = out.active === false && u.active;
    if (body.password) {
      const problem = passwordProblem(body.password);
      if (problem) return json({ error: problem }, 400);
      u.pw = await hashPassword(body.password);
      signOut = true;
    }
    Object.assign(u, out, { updatedAt: new Date().toISOString() });
    if (signOut) u.epoch = (u.epoch || 1) + 1;
    await saveUsers(env, users);
    return json({ user: publicUser(u) });
  }
  return json({ error: 'Not supported' }, 405);
}

// What each person may see: their buildings, and fields they have permission for.
function allowBuildingFor(u) {
  if (!u || u.buildings === 'all' || u.buildings == null) return null;
  const set = new Set(u.buildings);
  return (b) => set.has(b);
}
function shapeWeek(data, u) {
  if (!can(u, 'view_board')) data.board = [];
  if (!can(u, 'view_guests')) {
    for (const d of data.days) for (const x of d.units) { if (x.checkIn) x.checkIn.guests = null; if (x.checkOut) x.checkOut.guests = null; }
  }
  if (!can(u, 'view_linen')) { data.linen = []; data.totals.linenSets = null; for (const d of data.days) d.linen = {}; }
  if (u.buildings !== 'all') data.warnings = [];
  if (Array.isArray(u.buildings) && !u.buildings.length) data.warnings = ['No buildings are assigned to you yet. Ask an admin to add your buildings.'];
  return data;
}

// ---------------------------------------------------------------- Guesty client
// Guesty allows only 5 access tokens per 24 h, so the token is kept in KV and shared by every instance.
let memToken = null;
async function getToken(env) {
  if (memToken && memToken.expires_at > Date.now() + 5 * 60e3) return memToken.access_token;
  const stored = await env.STORE.get('guesty_token', 'json');
  if (stored && stored.client_id === env.GUESTY_CLIENT_ID && stored.expires_at > Date.now() + 5 * 60e3) { memToken = stored; return stored.access_token; }
  const r = await fetch(`${GUESTY}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'open-api', client_id: env.GUESTY_CLIENT_ID, client_secret: env.GUESTY_CLIENT_SECRET }),
  });
  if (r.status === 429) throw userError('Guesty’s daily login limit has been reached (5 per day). The schedule will load again once it resets.');
  if (!r.ok) throw userError(`Guesty didn’t accept the API keys (error ${r.status}). Check GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET in Cloudflare.`);
  const d = await r.json();
  memToken = { access_token: d.access_token, expires_at: Date.now() + (d.expires_in || 86400) * 1000, client_id: env.GUESTY_CLIENT_ID };
  await env.STORE.put('guesty_token', JSON.stringify(memToken), { expirationTtl: Math.max(120, (d.expires_in || 86400) - 60) });
  console.log('[guesty] new access token issued');
  return memToken.access_token;
}
function userError(msg, status = 502) { const e = new Error(msg); e.userMessage = msg; e.status = status; return e; }

async function gapi(env, method, path, { params, body } = {}, attempt = 0) {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) : '';
  const r = await fetch(`${GUESTY}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken(env)}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && attempt === 0) { memToken = null; await env.STORE.delete('guesty_token'); return gapi(env, method, path, { params, body }, 1); }
  if (r.status === 429 && attempt < 3) { await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1))); return gapi(env, method, path, { params, body }, attempt + 1); }
  const text = await r.text();
  if (!r.ok) { console.log('[guesty]', r.status, path, text.slice(0, 300)); throw userError(`Guesty returned an error (${r.status}). Try Refresh in a minute.`); }
  try { return JSON.parse(text); } catch (_) { return text; }
}
async function paginate(env, path, params) {
  const out = [];
  for (let skip = 0; skip < 5000; skip += 100) {
    const d = await gapi(env, 'GET', path, { params: { ...params, limit: '100', skip: String(skip) } });
    const res = d.results || d.data || [];
    out.push(...res);
    if (res.length < 100) break;
  }
  return out;
}
const LISTING_FIELDS = '_id nickname title bedrooms address.full address.street address.zipcode active defaultCheckInTime defaultCheckOutTime';
const STAY_FIELDS = '_id listingId status confirmationCode checkInDateLocalized checkOutDateLocalized plannedArrival plannedDeparture guestsCount nightsCount createdAt';

async function fetchListings(env, cfg) {
  if (cfg.mock) return MOCK.listings();
  return paginate(env, '/v1/listings', { fields: LISTING_FIELDS, sort: '_id' });
}
async function fetchStays(env, cfg, from, to) {
  if (cfg.mock) return MOCK.stays(from, to, cfg.statuses);
  return paginate(env, '/v1/reservations', {
    fields: STAY_FIELDS,
    filters: [
      { field: 'checkInDateLocalized', operator: '$lte', value: to },
      { field: 'checkOutDateLocalized', operator: '$gte', value: from },
      { field: 'status', operator: '$in', value: cfg.statuses },
    ],
    sort: '_id',
  });
}

// ---------------------------------------------------------------- bookings snapshot (pre-loaded)
let memSnap = null; // { snap, readAt }

function slimListing(l) {
  return { _id: l._id, nickname: l.nickname, title: l.title, bedrooms: l.bedrooms, active: l.active, address: { full: l.address?.full, street: l.address?.street, zipcode: l.address?.zipcode }, defaultCheckInTime: l.defaultCheckInTime, defaultCheckOutTime: l.defaultCheckOutTime };
}
function slimStay(r) {
  return { _id: r._id, listingId: r.listingId, status: r.status, confirmationCode: r.confirmationCode, checkInDateLocalized: r.checkInDateLocalized, checkOutDateLocalized: r.checkOutDateLocalized, plannedArrival: r.plannedArrival, plannedDeparture: r.plannedDeparture, guestsCount: r.guestsCount, nightsCount: r.nightsCount, createdAt: r.createdAt };
}

let refreshing = null; // one refresh at a time per instance; bursts of Guesty events share it
function refreshSnapshot(env, why = 'refresh') {
  if (!refreshing) refreshing = doRefresh(env, why).finally(() => { refreshing = null; });
  return refreshing;
}
async function doRefresh(env, why) {
  const cfg = config(env);
  const thisWeek = weekStartFor(todayInLondon(), cfg.weekStartDay);
  const from = addDays(thisWeek, -WINDOW_BEFORE), to = addDays(thisWeek, WINDOW_AFTER);
  const [listings, stays] = await Promise.all([fetchListings(env, cfg), fetchStays(env, cfg, from, to)]);
  const body = { listings: listings.map(slimListing), stays: stays.map(slimStay).sort((a, b) => (a._id < b._id ? -1 : 1)) };
  const hash = fnv(JSON.stringify(body) + cfg.statuses.join());
  const snap = { at: Date.now(), from, to, hash, mock: cfg.mock, ...body };
  const prev = memSnap?.snap || (await env.STORE.get('snapshot', 'json'));
  // Only write when something changed, or to mark it fresh every 5 min (keeps KV writes low).
  if (!prev || prev.hash !== hash || prev.from !== from || why === 'cron') await env.STORE.put('snapshot', JSON.stringify(snap));
  memSnap = { snap, readAt: Date.now() };
  if (!prev || prev.hash !== hash) console.log(`[snapshot] ${why}: ${stays.length} stays, ${listings.length} listings, version ${hash}`);
  return snap;
}

async function getSnapshot(env, ctx) {
  if (memSnap && Date.now() - memSnap.readAt < MEM_TTL) return memSnap.snap;
  let snap = await env.STORE.get('snapshot', 'json');
  const cfg = config(env);
  const thisWeek = weekStartFor(todayInLondon(), cfg.weekStartDay);
  const covers = snap && snap.from <= addDays(thisWeek, -7) && snap.to >= addDays(thisWeek, 13) && snap.mock === cfg.mock;
  if (!snap || !covers) snap = await refreshSnapshot(env, 'first load');
  else {
    memSnap = { snap, readAt: Date.now() };
    // Safety net if the 5-minute schedule isn't running: refresh in the background, never make the viewer wait.
    if (Date.now() - snap.at > 10 * 60e3 && ctx) ctx.waitUntil(refreshSnapshot(env, 'stale').catch((e) => console.log('[snapshot] refresh failed', e.message)));
  }
  return snap;
}

// ---------------------------------------------------------------- building the week
const FLAT_PART = /^(flat|apt\.?|apartment|unit|fl-?|room|studio|\d+(st|nd|rd|th)\s+floor|ground floor|basement)\b[^,]*$/i;
const cleanStreet = (s) => (s || '').split(',').map((x) => x.trim()).filter((x) => x && !FLAT_PART.test(x))[0] || '';
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
const streetKey = (n) => n.replace(/^\d+[a-z]?\s+/i, '');
const byBuilding = (a, b) => natural(streetKey(a), streetKey(b)) || natural(a, b);
const typeOrder = (t) => (t === 'Studio' ? 0 : Number.isFinite(parseInt(t, 10)) ? parseInt(t, 10) : 99);

function listingMap(raw, cfg, allow) {
  const map = new Map();
  for (const l of raw) {
    if (l.active === false || cfg.hidden.includes(l._id) || cfg.hidden.includes(l.nickname)) continue;
    const ov = (m) => m[l._id] || (l.nickname && m[l.nickname]);
    const b = l.bedrooms;
    const unitType = ov(cfg.typeOverrides) || (b === 0 ? 'Studio' : typeof b === 'number' && b > 0 ? `${b} Bedroom` : 'Unknown');
    const a = l.address || {};
    const pc = a.zipcode || ((a.full || '').match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i) || [''])[0].toUpperCase();
    const n = l.nickname || l.title || 'Unit';
    map.set(l._id, {
      id: l._id, name: n, label: n.includes(',') ? n.split(',')[0].trim() : n,
      building: ov(cfg.buildingOverrides) || cleanStreet(a.street) || cleanStreet(a.full) || n,
      postcode: pc, address: a.full || '', unitType,
      checkInTime: l.defaultCheckInTime || cfg.defaultIn, checkOutTime: l.defaultCheckOutTime || cfg.defaultOut,
    });
    if (allow && !allow(map.get(l._id).building)) map.delete(l._id);
  }
  return map;
}

function buildWeek(start, rawListings, stays, cfg, meta, allow) {
  const listings = listingMap(rawListings, cfg, allow);
  const end = addDays(start, 6);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const isNew = (r) => Boolean(r.createdAt) && Date.now() - new Date(r.createdAt).getTime() < cfg.newHours * 3600e3;
  const ev = (r, l, kind) => {
    const planned = kind === 'in' ? r.plannedArrival : r.plannedDeparture;
    const t = planned || (kind === 'in' ? l.checkInTime : l.checkOutTime);
    return { code: r.confirmationCode || '', time: fmtTime(t), timeRaw: t, planned: Boolean(planned), guests: r.guestsCount || null, nights: r.nightsCount || null, isNew: isNew(r) };
  };

  const grid = new Map();
  const cell = (id, d) => {
    if (!grid.has(id)) grid.set(id, Object.fromEntries(dates.map((x) => [x, { occ: false, out: null, in: null }])));
    return grid.get(id)[d];
  };
  let hiddenBookings = 0;
  for (const r of stays) {
    const ci = r.checkInDateLocalized, co = r.checkOutDateLocalized;
    if (!(ci <= end && co >= start) || !cfg.statuses.includes(r.status)) continue;
    const l = listings.get(r.listingId);
    if (!l) { if (!allow) hiddenBookings++; continue; }
    for (const d of dates) if (d >= ci && d < co) cell(r.listingId, d).occ = true;
    if (ci >= start && ci <= end) cell(r.listingId, ci).in = ev(r, l, 'in');
    if (co >= start && co <= end) cell(r.listingId, co).out = ev(r, l, 'out');
  }

  const linen = {};
  let checkOuts = 0, checkIns = 0, turnovers = 0, newBookings = 0;
  const days = dates.map((date) => {
    const units = [], dayLinen = {};
    for (const [id, cells] of grid) {
      const c = cells[date];
      if (!c.out && !c.in) continue;
      const l = listings.get(id);
      units.push({ listingId: id, name: l.name, label: l.label, building: l.building, postcode: l.postcode, address: l.address, unitType: l.unitType, checkOut: c.out, checkIn: c.in });
      if (c.out) { checkOuts++; linen[l.unitType] = (linen[l.unitType] || 0) + 1; dayLinen[l.unitType] = (dayLinen[l.unitType] || 0) + 1; }
      if (c.in) { checkIns++; if (c.in.isNew) newBookings++; }
      if (c.in && c.out) turnovers++;
    }
    units.sort((a, b) => byBuilding(a.building, b.building) || natural(a.label, b.label));
    return {
      date, units, linen: dayLinen,
      cleans: units.filter((u) => u.checkOut).length,
      arrivals: units.filter((u) => u.checkIn).length,
      turnovers: units.filter((u) => u.checkIn && u.checkOut).length,
      hasNew: units.some((u) => (u.checkIn && u.checkIn.isNew) || (u.checkOut && u.checkOut.isNew)),
    };
  });

  const buildings = new Map();
  for (const l of listings.values()) {
    if (!buildings.has(l.building)) buildings.set(l.building, { name: l.building, postcode: l.postcode, units: [] });
    const cells = grid.get(l.id) || {};
    buildings.get(l.building).units.push({ listingId: l.id, label: l.label, name: l.name, unitType: l.unitType, cells: dates.map((d) => cells[d] || { occ: false, out: null, in: null }) });
  }
  const board = [...buildings.values()].sort((a, b) => byBuilding(a.name, b.name));
  for (const b of board) b.units.sort((x, y) => natural(x.label, y.label));

  const linenRows = ['2 Bedroom', '1 Bedroom', 'Studio', ...Object.keys(linen)]
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .map((type) => ({ type, sets: linen[type] || 0 }))
    .sort((a, b) => typeOrder(b.type) - typeOrder(a.type));

  return {
    weekStart: start, weekEnd: end, dates,
    prevWeek: addDays(start, -7), nextWeek: addDays(start, 7),
    today: todayInLondon(), generatedAt: new Date(meta.at).toISOString(),
    version: meta.version, mock: cfg.mock, statuses: cfg.statuses,
    totals: { checkOuts, checkIns, turnovers, linenSets: checkOuts, newBookings },
    linen: linenRows, days, board,
    warnings: [
      ...[...listings.values()].filter((l) => l.unitType === 'Unknown').map((l) => `“${l.name}” has no bedroom count in Guesty, so its linen is counted as “Unknown”.`),
      ...(hiddenBookings ? [`${hiddenBookings} booking(s) belong to inactive or hidden listings and are not shown.`] : []),
    ],
  };
}

async function weekData(env, ctx, dateParam, fresh, user) {
  return shapeWeek(await weekDataRaw(env, ctx, dateParam, fresh, allowBuildingFor(user), user), user);
}
async function weekDataRaw(env, ctx, dateParam, fresh, allow, user) {
  const cfg = config(env);
  const start = weekStartFor(dateParam, cfg.weekStartDay);
  const end = addDays(start, 6);
  let snap = fresh ? await refreshSnapshot(env, 'manual refresh') : await getSnapshot(env, ctx);
  if (start >= snap.from && end <= snap.to) return buildWeek(start, snap.listings, snap.stays, cfg, { at: snap.at, version: snap.hash }, allow);
  // Outside the pre-loaded window (far past / far future): ask Guesty directly and cache at the edge.
  const cache = caches.default;
  const scope = allow ? fnv(JSON.stringify(user.buildings)) : 'all';
  const key = new Request(`https://cache.local/week/${start}/${snap.hash}/${scope}`);
  const hit = !fresh && (await cache.match(key));
  if (hit) return hit.json();
  const stays = (await fetchStays(env, cfg, start, end)).map(slimStay);
  const data = buildWeek(start, snap.listings, stays, cfg, { at: Date.now(), version: snap.hash }, allow);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { 'Cache-Control': 'max-age=600' } })));
  return data;
}

async function propertiesData(env, ctx, user) {
  const cfg = config(env);
  const snap = await getSnapshot(env, ctx);
  const listings = listingMap(snap.listings, cfg, allowBuildingFor(user));
  const groups = new Map();
  for (const l of listings.values()) {
    if (!groups.has(l.building)) groups.set(l.building, { name: l.building, postcode: l.postcode, units: [] });
    groups.get(l.building).units.push({ id: l.id, name: l.name, label: l.label, address: l.address, unitType: l.unitType, checkIn: fmtTime(l.checkInTime), checkOut: fmtTime(l.checkOutTime) });
  }
  const buildings = [...groups.values()].sort((a, b) => byBuilding(a.name, b.name));
  for (const b of buildings) b.units.sort((x, y) => natural(x.label, y.label));
  const counts = {};
  for (const l of listings.values()) counts[l.unitType] = (counts[l.unitType] || 0) + 1;
  return { buildings, total: listings.size, counts, mock: cfg.mock };
}

// ---------------------------------------------------------------- Guesty webhook (instant updates)
async function webhookUrl(env, origin) {
  const base = (env.PUBLIC_URL || origin || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/webhooks/guesty/${(await hmac(await secretKey(env), 'webhook')).slice(0, 32)}`;
}
async function ensureWebhook(env, origin) {
  const cfg = config(env);
  if (cfg.mock) return 'preview';
  const url = await webhookUrl(env, origin);
  if (!url) return 'no address yet';
  if ((await env.STORE.get('webhook_url')) === url) return 'registered';
  const existing = await gapi(env, 'GET', '/v1/webhooks').catch(() => []);
  const list = Array.isArray(existing) ? existing : existing.results || existing.data || [];
  // Remove older Cityscape Schedule subscriptions (e.g. a previous address) so Guesty only calls this one.
  for (const w of list) {
    if ((w.url || '').includes('/webhooks/guesty/') && w.url !== url) {
      await gapi(env, 'DELETE', `/v1/webhooks/${w._id || w.id}`).catch(() => {});
    }
  }
  if (!list.some((w) => w.url === url)) {
    await gapi(env, 'POST', '/v1/webhooks', { body: { url, events: ['reservation.created.v2', 'reservation.updated.v2'] } });
  }
  await env.STORE.put('webhook_url', url);
  if (origin) await env.STORE.put('origin', origin);
  console.log('[webhook] registered', url.replace(/[a-f0-9]{32}$/, '…'));
  return 'registered';
}

// ---------------------------------------------------------------- router
async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname;
  const ip = req.headers.get('CF-Connecting-IP') || 'x';

  if (p === '/health') return json({ ok: true, mock: config(env).mock });

  if (p.startsWith('/webhooks/guesty/') && req.method === 'POST') {
    const expectedKey = (await hmac(await secretKey(env), 'webhook')).slice(0, 32);
    if (!safeEqual(p.split('/')[3] || '', expectedKey)) return new Response('unauthorised', { status: 401 });
    const body = await req.json().catch(() => ({}));
    const r = body.reservation || body.data?.reservation || body.data || {};
    const snap = memSnap?.snap || (await env.STORE.get('snapshot', 'json'));
    const outside = snap && r.checkOutDateLocalized && r.checkInDateLocalized && (r.checkOutDateLocalized < snap.from || r.checkInDateLocalized > snap.to);
    // KV is only written when bookings actually changed, so refreshing on every relevant event is cheap.
    if (!outside) ctx.waitUntil(refreshSnapshot(env, 'guesty ' + (body.event || 'update')).catch((e) => console.log('[webhook] refresh failed', e.message)));
    return new Response('ok');
  }

  if (p === '/login' && req.method === 'GET') return asset(req, 'login.html');
  if (p === '/styles.css' || p === '/favicon.svg' || p === '/manifest.webmanifest') return asset(req, p.slice(1));

  if (p === '/login' && req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    const username = String((form && form.get('username')) || '').trim().toLowerCase();
    const tkey = ip + '|' + username;
    if (throttled(tkey) || throttled(ip)) return redirect('/login?e=locked');
    const user = await login(env, username, (form && form.get('password')) || '');
    if (!user) { recordFail(tkey); recordFail(ip); return redirect('/login?e=1&u=' + encodeURIComponent(username)); }
    return redirect('/', { 'Set-Cookie': `cs_session=${await makeSession(env, user)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
  }
  if (p === '/logout') return redirect('/login', { 'Set-Cookie': 'cs_session=; HttpOnly; Secure; Path=/; Max-Age=0' });

  const me = await sessionUser(env, cookie(req, 'cs_session'));
  if (!me) return p.startsWith('/api/') ? json({ error: 'Not signed in' }, 401) : redirect('/login');

  // Changes must come from this site (stops other websites acting with someone's session).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Blocked' }, 403);
  }
  const deny = () => json({ error: 'You don’t have permission for that. Ask an admin.' }, 403);

  if (p === '/' || p === '/index.html') {
    // Register with Guesty for instant updates the first time the app is opened on a new address.
    ctx.waitUntil(ensureWebhook(env, url.origin).catch((e) => console.log('[webhook] failed', e.message)));
    return asset(req, 'index.html');
  }
  if (p === '/app.js') return asset(req, 'app.js');
  if (p === '/api/me' && req.method === 'GET') return json({ user: publicUser(me), perms: PERMS });
  if (p === '/api/me/password' && req.method === 'POST') {
    if (me.isOwner) return json({ error: 'The owner login uses the APP_PASSWORD secret in Cloudflare. Change it there.' }, 400);
    const body = await req.json().catch(() => ({}));
    const users = await loadUsers(env, true);
    const u = users.find((x) => x.id === me.id);
    if (!(await checkPassword(String(body.current || ''), u.pw))) return json({ error: 'Your current password isn’t right.' }, 400);
    const problem = passwordProblem(body.password);
    if (problem) return json({ error: problem }, 400);
    u.pw = await hashPassword(body.password);
    u.epoch = (u.epoch || 1) + 1;
    await saveUsers(env, users);
    return json({ ok: true }, 200, { 'Set-Cookie': `cs_session=${await makeSession(env, u)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
  }
  if (p === '/api/week') {
    if (!can(me, 'view_day') && !can(me, 'view_board')) return deny();
    const fresh = url.searchParams.get('refresh') === '1' && can(me, 'refresh');
    return json(await weekData(env, ctx, url.searchParams.get('date'), fresh, me));
  }
  if (p === '/api/properties') return can(me, 'view_properties') ? json(await propertiesData(env, ctx, me)) : deny();
  if (p === '/api/version') {
    const snap = await getSnapshot(env, ctx);
    const hook = config(env).mock ? 'preview' : (await env.STORE.get('webhook_url')) ? 'registered' : 'pending';
    return json({ version: snap.hash, at: snap.at, webhook: hook });
  }
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (!can(me, 'manage_users')) return deny();
    return usersApi(req, env, ctx, me, p.split('/')[3] || null);
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(req, env, ctx) {
    try {
      if (!env.STORE) return new Response('Setup needed: add a KV namespace binding called STORE to this Worker.', { status: 500 });
      return await handle(req, env, ctx);
    } catch (err) {
      console.log('[error]', err.stack || err.message);
      if (new URL(req.url).pathname.startsWith('/api/')) return json({ error: err.userMessage || 'Something went wrong talking to Guesty. Try Refresh in a minute.' }, err.status || 500);
      return new Response('Server error', { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    if (!env.STORE) return;
    ctx.waitUntil((async () => {
      await refreshSnapshot(env, 'cron');
      await ensureWebhook(env, await env.STORE.get('origin')).catch(() => {});
    })());
  },
};
