// Cityscape Schedule — Cloudflare Worker.
// Serves the web app, the team login, and the week/linen data built from Guesty.
//
// Bindings (Cloudflare dashboard → Worker → Settings):
//   KV namespace  STORE                  – Guesty token + pre-loaded bookings
//   Secrets       GUESTY_CLIENT_ID, GUESTY_CLIENT_SECRET, APP_PASSWORD
//   Cron trigger  */5 * * * *            – keeps bookings fresh in the background
//   Optional vars PUBLIC_URL, WEEK_START_DAY, RESERVATION_STATUSES, DEFAULT_CHECKIN_TIME,
//                 DEFAULT_CHECKOUT_TIME, UNIT_TYPE_OVERRIDES, BUILDING_OVERRIDES,
//                 HIDDEN_LISTINGS, NEW_BOOKING_HOURS, KEYNEST_API_KEY
//
// Without Guesty keys it runs on sample data so it can be previewed.

const ASSETS = {
  "index.html": { type: "text/html; charset=utf-8", hash: "11hg2oo", body: "<!doctype html>\n<html lang=\"en-GB\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Cityscape\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n<link rel=\"apple-touch-icon\" href=\"/apple-touch-icon.png\">\n<title>Cityscape Schedule</title>\n<link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\">\n<link rel=\"icon\" href=\"/favicon.png\" type=\"image/png\">\n<link rel=\"manifest\" href=\"/manifest.webmanifest\">\n<meta name=\"theme-color\" content=\"#f8f9f8\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n<meta name=\"robots\" content=\"noindex\">\n<link rel=\"stylesheet\" href=\"/styles.css?v=3muv4l\">\n</head>\n<body>\n<header class=\"top\">\n  <div class=\"wrap\">\n    <div class=\"brand\">\n      <svg class=\"cs-mark\" viewBox=\"18.5 20 64.1 60\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M18.5 41.3 39.3 20H61v21.3H39.3V80H18.5zM61 41.3h21.6v14.5L61 80z\"/></svg>\n      <b class=\"name\">Cityscape</b><span class=\"tag\">SCHEDULE</span>\n    </div>\n    <span class=\"live\" id=\"live\" title=\"Connecting…\"><i></i><span class=\"lbl\">Connecting</span></span>\n    <nav class=\"seg\" role=\"tablist\" aria-label=\"View\">\n      <button role=\"tab\" data-view=\"day\" aria-selected=\"true\"><svg class=\"ti\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"17\" rx=\"2\"/><path d=\"M3 9h18M8 2v4M16 2v4\"/></svg><span>Day</span></button>\n      <button role=\"tab\" data-view=\"board\" aria-selected=\"false\"><svg class=\"ti\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M3 9h18M3 15h18M9 3v18\"/></svg><span>Board</span></button>\n      <button role=\"tab\" data-view=\"props\" aria-selected=\"false\"><svg class=\"ti\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6\"/></svg><span>Properties</span></button>\n      <button role=\"tab\" data-view=\"cleaning\" aria-selected=\"false\" class=\"hidden\"><svg class=\"ti\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M9 11l3 3L22 4\"/><path d=\"M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11\"/></svg><span>Cleaning</span></button>\n      <button role=\"tab\" data-view=\"users\" aria-selected=\"false\" class=\"hidden\"><svg class=\"ti\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8\"/></svg><span>Users</span></button>\n      <button role=\"tab\" data-view=\"settings\" aria-selected=\"false\" class=\"hidden\"><svg class=\"ti\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z\"/></svg>Settings</button>\n    </nav>\n    <button class=\"btn sq bell\" id=\"bell\" aria-label=\"Notifications\" aria-haspopup=\"dialog\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0\"/></svg><span class=\"bell-n hidden\" id=\"bell-n\"></span></button>\n    <button class=\"btn me\" id=\"me-btn\" data-view=\"account\" title=\"My account\"><span class=\"avatar\" id=\"me-avatar\"></span><span class=\"btn-label\" id=\"me-name\"></span></button>\n  </div>\n</header>\n\n<main class=\"wrap\">\n  <section id=\"week-area\">\n    <div class=\"weekbar\">\n      <button class=\"btn sq no-print\" id=\"prev\" aria-label=\"Previous week\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M15 18l-6-6 6-6\"/></svg></button>\n      <h1 id=\"week-title\">Loading…</h1>\n      <button class=\"btn sq no-print\" id=\"next\" aria-label=\"Next week\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M9 18l6-6-6-6\"/></svg></button>\n      <span class=\"when\" id=\"when\"></span>\n      <span id=\"newpill\"></span>\n      <span class=\"spacer\"></span>\n      <button class=\"btn no-print\" id=\"this\">This week</button>\n      <button class=\"btn act no-print\" id=\"refresh\" title=\"Pull the latest from Guesty\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5\"/></svg><span class=\"btn-label\">Refresh</span></button>\n      <button class=\"btn act no-print\" id=\"copy\" title=\"Copy as text for WhatsApp\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><rect x=\"9\" y=\"9\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1\"/></svg><span class=\"btn-label\" id=\"copy-label\">Copy day</span></button>\n      <button class=\"btn act no-print\" id=\"print\" title=\"Print or save as PDF\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z\"/></svg><span class=\"btn-label\">Print</span></button>\n    </div>\n\n    <div id=\"banners\"></div>\n\n    <div class=\"summary\" id=\"summary\">\n      <div class=\"metric\"><div class=\"k\"><i style=\"background:var(--out)\"></i>Cleans</div><div class=\"v\" id=\"m-out\">–</div></div>\n      <div class=\"metric\"><div class=\"k\"><i style=\"background:var(--in)\"></i>Arrivals</div><div class=\"v\" id=\"m-in\">–</div></div>\n      <div class=\"metric\"><div class=\"k\"><i style=\"background:var(--turn)\"></i>Same-day</div><div class=\"v\" id=\"m-turn\">–</div></div>\n      <div class=\"metric linen\"><div class=\"k\">Linen sets for the week <span class=\"muted\" style=\"font-weight:500\">· 1 per check-out</span></div><div class=\"linen-row\" id=\"m-linen\"></div></div>\n    </div>\n\n    <!-- DAY VIEW -->\n    <div id=\"view-day\">\n      <div class=\"strip\" id=\"strip\" role=\"tablist\" aria-label=\"Day\"></div>\n      <div class=\"card\" id=\"daypanel\"><div class=\"loading\">Loading from Guesty…</div></div>\n    </div>\n\n    <!-- BOARD VIEW -->\n    <div id=\"view-board\" class=\"hidden\">\n      <div class=\"card\">\n        <div class=\"board-wrap\"><table class=\"board\" id=\"board\"></table></div>\n        <div class=\"legend no-print\">\n          <span><i class=\"sw\"></i>Guest staying</span>\n          <span><b style=\"color:var(--out)\">10 am</b> check-out</span>\n          <span><b style=\"color:var(--in)\">3 pm</b> check-in</span>\n          <span><b class=\"mark turn\" style=\"position:static;transform:none\">10→3</b> same-day turnover</span>\n          <span><i class=\"sw n\"></i>Booked in the last 24 h</span>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- PROPERTIES VIEW -->\n  <section id=\"view-props\" class=\"hidden\">\n    <div class=\"weekbar\"><h1>Properties</h1><span class=\"when\" id=\"props-sub\"></span></div>\n    <div id=\"props-banner\"></div>\n    <div class=\"pgrid\" id=\"props\"></div>\n  </section>\n\n  <!-- CLEANING VIEW (admins, supervisors) -->\n  <section id=\"view-cleaning\" class=\"hidden\">\n    <div class=\"weekbar\"><h1>Cleaning</h1>\n      <button class=\"btn sq\" id=\"cv-prev\" aria-label=\"Previous day\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M15 18l-6-6 6-6\"/></svg></button>\n      <input type=\"date\" id=\"cv-date\" class=\"cv-date\" aria-label=\"Day\">\n      <button class=\"btn sq\" id=\"cv-next\" aria-label=\"Next day\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M9 18l6-6-6-6\"/></svg></button>\n    </div>\n    <div class=\"summary cv-summary\" id=\"cv-summary\"></div>\n    <div class=\"cv-grid\">\n      <div><h3 class=\"sh-h3\">Cleanings</h3><div id=\"cv-list\"></div></div>\n      <div><h3 class=\"sh-h3\">Damage reports</h3><div id=\"cv-damages\"></div></div>\n    </div>\n  </section>\n\n  <!-- USERS VIEW (admins) -->\n  <section id=\"view-users\" class=\"hidden\">\n    <div class=\"weekbar\"><h1>Users</h1><span class=\"when\" id=\"users-sub\"></span><span class=\"spacer\"></span>\n      <button class=\"btn primary\" id=\"add-user\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M12 5v14M5 12h14\"/></svg>Add user</button></div>\n    <div id=\"users-msg\"></div>\n    <div class=\"users-layout\">\n      <div class=\"card\"><table class=\"utable\"><thead><tr><th>Name</th><th>Role</th><th class=\"hide-sm\">Buildings</th><th class=\"hide-sm\">Last sign-in</th><th></th></tr></thead><tbody id=\"users-list\"></tbody></table></div>\n      <form class=\"card uform hidden\" id=\"user-form\" autocomplete=\"off\"></form>\n    </div>\n  </section>\n\n  <!-- SETTINGS (Admin and User roles) -->\n  <section id=\"view-settings\" class=\"hidden\">\n    <div class=\"weekbar\"><h1>Settings</h1></div>\n    <h2 class=\"set-group\">Integrations</h2>\n    <div class=\"card pad set-card\" id=\"settings-keynest\"><div class=\"loading\">Loading…</div></div>\n  </section>\n\n  <!-- MY ACCOUNT -->\n  <section id=\"view-account\" class=\"hidden\">\n    <div class=\"weekbar\"><h1>My account</h1></div>\n    <div class=\"acct-grid\">\n      <div class=\"card pad\" id=\"acct-info\"></div>\n      <form class=\"card pad\" id=\"pw-form\">\n        <h3>Change password</h3>\n        <label for=\"pw-cur\">Current password</label><input id=\"pw-cur\" type=\"password\" autocomplete=\"current-password\" required>\n        <label for=\"pw-new\">New password</label><input id=\"pw-new\" type=\"password\" autocomplete=\"new-password\" minlength=\"8\" required>\n        <label for=\"pw-new2\">New password again</label><input id=\"pw-new2\" type=\"password\" autocomplete=\"new-password\" minlength=\"8\" required>\n        <div class=\"form-msg\" id=\"pw-msg\"></div>\n        <button class=\"btn primary\" type=\"submit\">Change password</button>\n      </form>\n    </div>\n    <p style=\"margin-top:14px\"><a class=\"btn\" href=\"/logout\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9\"/></svg>Sign out</a></p>\n  </section>\n\n  <div class=\"foot\" id=\"foot\"></div>\n</main>\n\n<div class=\"active-bar hidden\" id=\"active-bar\"></div>\n<div class=\"notif hidden\" id=\"notif\"></div>\n<div class=\"sheet hidden\" id=\"sheet\"><div class=\"sheet-card\" id=\"sheet-body\" role=\"dialog\" aria-modal=\"true\"></div></div>\n<div class=\"cl-overlay hidden\" id=\"checklist\"></div>\n\n<script src=\"/app.js?v=1sx5crx\"></script>\n</body>\n</html>\n" },
  "login.html": { type: "text/html; charset=utf-8", hash: "12tdkdu", body: "<!doctype html>\n<html lang=\"en-GB\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Cityscape\">\n<title>Sign in · Cityscape Schedule</title>\n<link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\">\n<link rel=\"icon\" href=\"/favicon.png\" type=\"image/png\">\n<link rel=\"apple-touch-icon\" href=\"/apple-touch-icon.png\">\n<meta name=\"theme-color\" content=\"#f8f9f8\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n<link rel=\"stylesheet\" href=\"/styles.css?v=3muv4l\">\n<meta name=\"robots\" content=\"noindex\">\n</head>\n<body>\n<div class=\"login\">\n  <div class=\"login-brand\">\n    <svg class=\"cs-mark\" viewBox=\"18.5 20 64.1 60\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M18.5 41.3 39.3 20H61v21.3H39.3V80H18.5zM61 41.3h21.6v14.5L61 80z\"/></svg>\n    <b>Cityscape</b><span class=\"tag\">SCHEDULE</span>\n  </div>\n  <form method=\"post\" action=\"/login\">\n    <h1>Sign in</h1>\n    <p>Check-ins, check-outs, cleaning and linen for the week.</p>\n    <label for=\"un\">Username</label>\n    <input id=\"un\" name=\"username\" type=\"text\" autocomplete=\"username\" autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\" required autofocus>\n    <label for=\"pw\">Password</label>\n    <input id=\"pw\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required>\n    <button type=\"submit\">Sign in</button>\n    <div class=\"err\" id=\"err\" role=\"alert\"></div>\n  </form>\n  <div class=\"login-foot\">schedule.yourcityscape.com</div>\n</div>\n<script>\n  const q = new URLSearchParams(location.search), e = q.get('e');\n  if (q.get('u')) { document.getElementById('un').value = q.get('u'); document.getElementById('pw').focus(); }\n  if (e === '1') document.getElementById('err').textContent = 'That username or password isn’t right.';\n  if (e === 'locked') document.getElementById('err').textContent = 'Too many attempts — try again in 10 minutes.';\n</script>\n</body>\n</html>\n" },
  "styles.css": { type: "text/css; charset=utf-8", hash: "3muv4l", body: "/* Cityscape theme — same palette and type as the partner portal (partner.yourcityscape.com). */\n:root {\n  --bg: #f8f9f8;\n  --surface: #ffffff;\n  --surface-2: #f4f6f5;\n  --ink: #1d2b25;\n  --ink-2: #48544e;\n  --ink-3: #5c6660;\n  --line: #e6e9e7;\n  --line-2: #eef1ef;\n  --accent: #1c6b52;\n  --accent-strong: #123f30;\n  --accent-ink: #ffffff;\n  --accent-soft: #e9f3ee;\n  --mark: #06402a;\n  --stay: #d9ebe1;\n  --out: #b3453a;\n  --out-soft: #fbeeec;\n  --in: #2a6450;\n  --in-soft: #e3f0e9;\n  --turn: #6f4aa8;\n  --turn-soft: #efe8f8;\n  --new: #8a6d1f;\n  --new-soft: #fdf6e7;\n  --radius: 14px;\n  --shadow: 0 1px 2px rgba(18, 63, 48, .05), 0 4px 14px rgba(18, 63, 48, .06);\n  --font: Inter, system-ui, -apple-system, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\n  --font-head: Poppins, Inter, system-ui, sans-serif;\n  color-scheme: light;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #0f1311;\n    --surface: #161b19;\n    --surface-2: #1b211e;\n    --ink: #e8ece9;\n    --ink-2: #b4bdb8;\n    --ink-3: #85908a;\n    --line: #26302b;\n    --line-2: #1f2724;\n    --accent: #6cc4a0;\n    --accent-strong: #9fe0c4;\n    --accent-ink: #0d2019;\n    --accent-soft: #16302a;\n    --mark: #6cc4a0;\n    --stay: #1d3a30;\n    --out: #f0a47f;\n    --out-soft: #3a251b;\n    --in: #7fd1a0;\n    --in-soft: #1b3125;\n    --turn: #c4a5f1;\n    --turn-soft: #2c2340;\n    --new: #f2c65e;\n    --new-soft: #3a3019;\n    --shadow: none;\n    color-scheme: dark;\n  }\n}\n\n* { box-sizing: border-box; }\nhtml, body { margin: 0; }\nbody {\n  background: var(--bg);\n  color: var(--ink);\n  font: 15px/1.45 var(--font);\n  -webkit-font-smoothing: antialiased;\n}\nh1, h2, h3, .metric .v, .linen-row .v { font-family: var(--font-head); letter-spacing: -.01em; }\nbutton, input { font: inherit; color: inherit; }\nbutton, a { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }\nbutton:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\nbody { text-rendering: optimizeLegibility; }\n/* While a new week loads, keep the current one on screen and just dim it — no blank flashes. */\n#week-area .summary, #view-day, #view-board { transition: opacity .15s ease; }\nbody.is-loading #week-area .summary, body.is-loading #view-day, body.is-loading #view-board { opacity: .55; pointer-events: none; }\n#daypanel { min-height: 240px; }\n.btn, .seg button, .dbtn { transition: background-color .12s ease, border-color .12s ease, color .12s ease; }\n@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }\n.wrap { max-width: 1120px; margin: 0 auto; padding: 0 16px; }\n.hidden { display: none !important; }\n.muted { color: var(--ink-3); }\n\n/* ---------- header ---------- */\n.top { position: sticky; top: 0; z-index: 20; background: var(--surface); border-bottom: 1px solid var(--line); }\n.top .wrap { display: flex; align-items: center; gap: 12px; height: 60px; }\n.brand { display: flex; align-items: center; gap: 8px; margin-right: auto; white-space: nowrap; }\n.cs-mark { width: 24px; height: 22px; flex: none; color: var(--mark); }\n.brand .name { font-family: var(--font-head); font-size: 18px; font-weight: 600; color: var(--ink); letter-spacing: -.01em; }\n.tag { font-size: 9.5px; font-weight: 700; letter-spacing: .14em; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 3px 8px; line-height: 1.2; }\n.seg { display: flex; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 3px; gap: 2px; }\n.seg button { border: 0; background: none; padding: 6px 13px; border-radius: 9px; color: var(--ink-2); font-weight: 600; font-size: 13.5px; }\n.seg button:hover { color: var(--ink); background: var(--bg); }\n.seg button[aria-selected=\"true\"] { background: var(--accent-soft); color: var(--accent-strong); }\n.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--ink-3); white-space: nowrap; }\n.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); }\n.live.on { color: var(--in); }\n.live.on i { background: var(--in); }\n.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--line); background: var(--surface); border-radius: 10px; height: 36px; padding: 0 12px; font-weight: 560; font-size: 14px; color: var(--ink-2); text-decoration: none; white-space: nowrap; }\n.btn:hover { color: var(--ink); border-color: var(--ink-3); }\n.btn:disabled { opacity: .45; cursor: default; }\n.btn svg { width: 16px; height: 16px; flex: none; }\n.btn.sq { width: 36px; padding: 0; }\n\n/* ---------- week bar ---------- */\n.weekbar { display: flex; align-items: center; gap: 8px; margin: 22px 0 14px; flex-wrap: wrap; }\n.weekbar h1 { font-size: 22px; letter-spacing: -.02em; margin: 0 6px; font-weight: 700; white-space: nowrap; }\n.weekbar .when { font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); }\n.weekbar .spacer { flex: 1; }\n.newpill { display: inline-flex; align-items: center; gap: 6px; background: var(--new-soft); color: var(--new); font-weight: 650; font-size: 12.5px; padding: 5px 10px; border-radius: 99px; }\n.banner { border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; font-size: 14px; background: var(--new-soft); color: var(--new); }\n.banner.error { background: var(--out-soft); color: var(--out); }\n\n/* ---------- summary band ---------- */\n.summary { display: grid; grid-template-columns: repeat(3, 1fr) 2.1fr; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 18px; overflow: hidden; }\n.metric { padding: 14px 18px; border-left: 1px solid var(--line); }\n.metric:first-child { border-left: 0; }\n.metric .k { font-size: 12.5px; font-weight: 600; color: var(--ink-2); display: flex; align-items: center; gap: 7px; }\n.metric .k i { width: 8px; height: 8px; border-radius: 3px; }\n.metric .v { font-size: 28px; font-weight: 720; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 3px; }\n.metric.linen { background: var(--surface-2); }\n.linen-row { display: flex; align-items: flex-end; gap: 18px; margin-top: 3px; }\n.linen-row .item .v { font-size: 22px; }\n.linen-row .item .t { font-size: 12px; color: var(--ink-3); font-weight: 550; }\n.linen-row .total { margin-left: auto; text-align: right; }\n.linen-row .total .v { font-size: 28px; color: var(--accent); }\n\n/* ---------- day strip ---------- */\n.strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 14px; }\n.dbtn { position: relative; border: 1px solid var(--line); background: var(--surface); border-radius: 12px; padding: 9px 6px 10px; text-align: center; box-shadow: var(--shadow); }\n.dbtn .dn { font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); }\n.dbtn .dd { font-size: 22px; font-weight: 720; letter-spacing: -.02em; line-height: 1.15; }\n.dbtn .dc { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }\n.dbtn .dc b { color: var(--out); font-weight: 650; }\n.dbtn .dc em { color: var(--in); font-style: normal; font-weight: 650; }\n.dbtn.past { opacity: .55; }\n.dbtn.today .dn { color: var(--accent); }\n.dbtn.today::after { content: \"Today\"; position: absolute; top: -8px; left: 50%; transform: translateX(-50%); background: var(--accent); color: var(--accent-ink); font-size: 10px; font-weight: 750; padding: 1px 7px; border-radius: 99px; letter-spacing: .04em; text-transform: uppercase; }\n.dbtn[aria-selected=\"true\"] { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); opacity: 1; }\n.dbtn .newdot { position: absolute; top: 8px; right: 8px; width: 7px; height: 7px; border-radius: 50%; background: var(--new); }\n\n/* ---------- day panel ---------- */\n.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }\n.dayhead { display: flex; align-items: baseline; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }\n.dayhead h2 { margin: 0; font-size: 18px; letter-spacing: -.01em; }\n.dayhead .dlinen { margin-left: auto; font-size: 13px; color: var(--ink-2); }\n.dayhead .dlinen b { color: var(--ink); font-variant-numeric: tabular-nums; }\n\n.section { padding: 6px 0 10px; border-top: 1px solid var(--line); }\n.section:first-of-type { border-top: 0; }\n.shead { display: flex; align-items: center; gap: 10px; padding: 12px 20px 6px; }\n.shead .bar { width: 4px; height: 18px; border-radius: 2px; }\n.shead h3 { margin: 0; font-size: 14.5px; font-weight: 680; }\n.shead .count { font-size: 12.5px; font-weight: 650; border-radius: 99px; padding: 1px 8px; }\n.shead .hint { font-size: 13px; color: var(--ink-3); }\n.s-turn .bar { background: var(--turn); } .s-turn .count { background: var(--turn-soft); color: var(--turn); }\n.s-out .bar { background: var(--out); } .s-out .count { background: var(--out-soft); color: var(--out); }\n.s-in .bar { background: var(--in); } .s-in .count { background: var(--in-soft); color: var(--in); }\n\n.bldg { margin: 6px 20px 0 34px; }\n.bldg-name { font-size: 12px; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; padding: 6px 0 4px; }\n.bldg-name span { font-weight: 550; letter-spacing: .02em; margin-left: 6px; }\n.row { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 10px; background: var(--surface-2); margin-bottom: 6px; }\n.row .u { font-weight: 680; min-width: 64px; }\n.row .t { font-size: 12.5px; color: var(--ink-3); }\n.row .g { font-size: 12.5px; color: var(--ink-3); }\n.row .times { margin-left: auto; display: flex; align-items: center; gap: 6px; }\n.chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 7px; padding: 3px 9px; font-size: 13px; font-weight: 640; white-space: nowrap; font-variant-numeric: tabular-nums; }\n.chip.out { background: var(--out-soft); color: var(--out); }\n.chip.in { background: var(--in-soft); color: var(--in); }\n.chip small { font-weight: 500; opacity: .8; font-size: 11.5px; }\n.arrow { color: var(--ink-3); font-size: 13px; }\n.new { background: var(--new-soft); color: var(--new); font-size: 11px; font-weight: 750; letter-spacing: .04em; padding: 2px 7px; border-radius: 6px; text-transform: uppercase; }\n.empty { padding: 44px 20px; text-align: center; color: var(--ink-3); }\n.empty b { display: block; color: var(--ink-2); font-size: 16px; margin-bottom: 2px; }\n\n/* ---------- week board ---------- */\n.board-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }\ntable.board { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 760px; table-layout: fixed; }\ntable.board th, table.board td { padding: 0; border-bottom: 1px solid var(--line-2); }\ntable.board col.first { width: 170px; }\ntable.board thead th { position: sticky; top: 0; background: var(--surface); z-index: 3; padding: 10px 6px; border-bottom: 1px solid var(--line); text-align: center; font-weight: 600; }\ntable.board thead th button { border: 0; background: none; padding: 2px 6px; border-radius: 8px; width: 100%; }\ntable.board thead th button:hover { background: var(--surface-2); }\ntable.board thead .dn { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); font-weight: 650; }\ntable.board thead .dd { font-size: 17px; font-weight: 720; }\ntable.board thead .dc { font-size: 11.5px; color: var(--ink-3); font-weight: 550; }\ntable.board th.today .dn, table.board th.today .dd { color: var(--accent); }\ntable.board td.today, table.board th.today { background: color-mix(in srgb, var(--accent-soft) 45%, var(--surface)); }\n.first-col { position: sticky; left: 0; background: var(--surface); z-index: 2; text-align: left !important; padding: 0 14px !important; border-right: 1px solid var(--line); }\ntr.b-row td { background: var(--surface-2); padding: 7px 14px !important; font-size: 12px; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--line); }\ntr.b-row td span { font-weight: 550; margin-left: 6px; letter-spacing: .02em; }\ntr.b-row .b-name { position: sticky; left: 14px; display: inline-block; white-space: nowrap; }\ntd.unit { height: 46px; }\ntd.unit .u { font-weight: 680; font-size: 14px; }\ntd.unit .t { font-size: 11.5px; color: var(--ink-3); margin-left: 6px; font-weight: 500; }\ntd.cell { position: relative; height: 46px; }\n.half { position: absolute; top: 9px; bottom: 9px; background: var(--stay); }\n.half.l { left: 0; right: 50%; }\n.half.r { left: 50%; right: 0; }\n.half.l.end { right: calc(50% + 4px); border-radius: 0 8px 8px 0; }\n.half.r.start { left: calc(50% + 4px); border-radius: 8px 0 0 8px; }\n.half.r.isnew { background: var(--new-soft); }\n.mark { position: absolute; top: 50%; transform: translateY(-50%); font-size: 11.5px; font-weight: 700; white-space: nowrap; z-index: 1; font-variant-numeric: tabular-nums; }\n.mark.out { color: var(--out); right: calc(50% + 10px); }\n.mark.in { color: var(--in); left: calc(50% + 10px); }\n.mark.turn { left: 50%; transform: translate(-50%, -50%); background: var(--turn); color: #fff; padding: 2px 7px; border-radius: 99px; font-size: 11px; box-shadow: 0 0 0 2px var(--surface); }\n@media (prefers-color-scheme: dark) { .mark.turn { color: #1a1325; } }\ntfoot td { padding: 9px 6px !important; text-align: center; font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; border-bottom: 0 !important; border-top: 1px solid var(--line); background: var(--surface-2); }\ntfoot td.first-col { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); background: var(--surface-2); }\ntfoot .o { color: var(--out); } tfoot .i { color: var(--in); }\n.legend { display: flex; gap: 16px; flex-wrap: wrap; padding: 12px 16px; font-size: 12.5px; color: var(--ink-2); border-top: 1px solid var(--line); }\n.legend span { display: inline-flex; align-items: center; gap: 6px; }\n.legend .sw { width: 22px; height: 10px; border-radius: 4px; background: var(--stay); display: inline-block; }\n.legend .sw.n { background: var(--new-soft); }\n\n/* ---------- properties ---------- */\n.pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }\n.pcard h3 { margin: 0; font-size: 15px; padding: 14px 16px 2px; }\n.pcard .pc { color: var(--ink-3); font-size: 12.5px; padding: 0 16px 10px; }\n.prow { display: flex; gap: 10px; align-items: baseline; padding: 9px 16px; border-top: 1px solid var(--line-2); font-size: 14px; }\n.prow .u { font-weight: 650; min-width: 90px; }\n.prow .t { color: var(--ink-3); font-size: 12.5px; margin-left: auto; white-space: nowrap; }\n\n.foot { color: var(--ink-3); font-size: 12.5px; padding: 18px 0 40px; text-align: center; }\n.loading { padding: 70px 0; text-align: center; color: var(--ink-3); }\n.toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 10px 16px; border-radius: 10px; font-size: 14px; font-weight: 580; z-index: 50; box-shadow: 0 6px 24px rgba(0,0,0,.18); }\n\n/* ---------- responsive ---------- */\n@media (max-width: 820px) {\n  .summary { grid-template-columns: repeat(3, 1fr); }\n  .metric.linen { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); }\n  .live .lbl { display: none; }\n}\n@media (max-width: 600px) {\n  .top .wrap { gap: 8px; }\n  .brand .tag { display: none; }\n  .seg button { padding: 6px 10px; }\n  .btn-label { display: none; }\n  .btn.act { width: 36px; padding: 0; }\n  .weekbar h1 { font-size: 19px; margin: 0 2px; }\n  .weekbar .when { display: none; }\n  .metric { padding: 12px 12px; }\n  .metric .v { font-size: 24px; }\n  .metric .k { font-size: 12px; }\n  .strip { gap: 4px; }\n  .dbtn { padding: 8px 2px; border-radius: 10px; }\n  .dbtn .dd { font-size: 18px; }\n  .dbtn .dc { font-size: 11px; }\n  .dbtn .dc .lbl { display: none; }\n  #print { display: none; }\n  .dayhead, .shead { padding-left: 14px; padding-right: 14px; }\n  .bldg { margin: 4px 12px 0 12px; }\n  .row { flex-wrap: wrap; gap: 4px 10px; }\n  .row .times { margin-left: 0; width: 100%; }\n  .shead .hint { display: none; }\n  table.board col.first { width: 108px; }\n  td.unit .t { display: block; margin-left: 0; }\n}\n\n/* ---------- login ---------- */\n/* Sign-in page: same layout as the partner portal's (wordmark + tag above a white card). */\n.login { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 16px; }\n.login-brand { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; }\n.login-brand b { font-family: var(--font-head); font-size: 20px; font-weight: 600; color: var(--ink); letter-spacing: -.01em; }\n.login form { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 28px; box-shadow: var(--shadow); }\n.login h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; color: var(--ink); }\n.login p { color: var(--ink-2); margin: 0 0 16px; font-size: 13.5px; line-height: 1.55; }\n.login label { display: block; font-size: 12.5px; font-weight: 600; color: var(--ink); margin: 14px 0 5px; }\n.login input { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); font-size: 16px; color: var(--ink); }\n.login input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }\n.login button { width: 100%; margin-top: 18px; padding: 13px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-ink); font-weight: 600; font-size: 14px; cursor: pointer; }\n.login button:hover { background: var(--accent-strong); }\n.login .err { color: var(--out); font-size: 13.5px; margin-top: 10px; }\n.login-foot { margin-top: 16px; font-size: 12px; color: var(--ink-3); }\n\n/* ---------- print ---------- */\n@media print {\n  :root { --bg: #fff; --surface: #fff; --surface-2: #f6f6f6; --line: #bbb; --line-2: #ddd; --shadow: none; }\n  .top, .no-print, .foot, .strip { display: none !important; }\n  body { font-size: 11pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n  .summary { break-inside: avoid; }\n  .bldg, .row { break-inside: avoid; }\n  .board-wrap { overflow: visible; }\n  table.board { min-width: 0; font-size: 10pt; }\n  table.board thead th { position: static; }\n  .first-col { position: static; }\n}\n\n/* ---------- account button ---------- */\n.btn.me { padding: 0 10px 0 5px; gap: 8px; }\n.avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: inline-grid; place-items: center; font-size: 12px; font-weight: 700; letter-spacing: .02em; }\n.btn.me[aria-selected=\"true\"] { border-color: var(--accent); }\n.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }\n.btn.primary:hover { color: var(--accent-ink); background: var(--accent-strong); border-color: var(--accent-strong); }\n.btn.danger { color: var(--out); }\n\n/* ---------- users ---------- */\n.users-layout { display: grid; grid-template-columns: 1fr; gap: 14px; align-items: start; }\n.users-layout.editing { grid-template-columns: 1fr 420px; }\n.utable { width: 100%; border-collapse: collapse; }\n.utable th, .utable td { text-align: left; padding: 11px 16px; border-top: 1px solid var(--line-2); font-size: 14px; vertical-align: middle; }\n.utable th { font-size: 12px; font-weight: 650; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; border-top: 0; }\n.utable tr.sel td { background: var(--accent-soft); }\n.utable tr.off td { opacity: .5; }\n.utable .who b { display: block; font-weight: 650; }\n.utable .who span { color: var(--ink-3); font-size: 12.5px; }\n.utable td:last-child { text-align: right; }\n.role { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: 99px; background: var(--surface-2); border: 1px solid var(--line); text-transform: capitalize; white-space: nowrap; }\n.role.admin { background: var(--accent-soft); color: var(--accent); border-color: transparent; }\n.role.supervisor { background: var(--turn-soft); color: var(--turn); border-color: transparent; }\n.role.cleaner { background: var(--in-soft); color: var(--in); border-color: transparent; }\n.uform, .card.pad { padding: 18px 20px; }\n.uform h3, .card.pad h3 { margin: 0 0 12px; font-size: 16px; }\n.uform label, .card.pad label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 5px; }\n.uform input[type=text], .uform input[type=email], .uform input[type=password], .uform select, .card.pad input { width: 100%; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface-2); font-size: 15px; color: var(--ink); }\n.uform input:focus, .uform select:focus, .card.pad input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }\n.uform .hint { font-size: 12.5px; color: var(--ink-3); margin-top: 4px; }\n.uform fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px 10px; margin: 14px 0 0; }\n.uform legend { font-size: 13px; font-weight: 650; padding: 0 4px; }\n.checks { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }\n.checks label, .radio label { display: flex; align-items: center; gap: 8px; font-weight: 500; margin: 4px 0; font-size: 14px; cursor: pointer; }\n.checks input, .radio input { width: 16px; height: 16px; accent-color: var(--accent); }\n.radio { display: flex; gap: 16px; }\n.pwrow { display: flex; gap: 6px; }\n.pwrow input { flex: 1; }\n.form-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }\n.form-actions .spacer { flex: 1; }\n.form-msg { font-size: 13.5px; margin-top: 10px; min-height: 1em; }\n.form-msg.err { color: var(--out); }\n.form-msg.ok { color: var(--in); }\n.confirm-del { background: var(--out-soft); color: var(--out); border-radius: 9px; padding: 10px 12px; font-size: 13.5px; margin-top: 12px; }\n.acct-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }\n.acct-grid dl { margin: 0; display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; font-size: 14px; }\n.acct-grid dt { color: var(--ink-3); }\n.acct-grid dd { margin: 0; font-weight: 550; }\n.card.pad .btn { margin-top: 14px; }\n@media (max-width: 860px) {\n  .users-layout.editing, .acct-grid { grid-template-columns: 1fr; }\n  .users-layout.editing .card:first-child { order: 2; }\n}\n@media (max-width: 600px) { .checks { grid-template-columns: 1fr; } .utable .hide-sm { display: none; } }\n\n.summary.no-linen { grid-template-columns: repeat(3, 1fr); }\n\n/* ---------- cleaning ---------- */\n.row.tap { cursor: pointer; transition: background .12s; }\n.row.tap:hover { background: var(--line-2); }\n.row.tap:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }\n.cbadge:empty { display: none; }\n.cb { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }\n.cb b { font-variant-numeric: tabular-nums; }\n.cb.running { background: var(--new-soft); color: var(--new); }\n.cb.running i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: pulse 1.4s infinite; }\n.cb.done { background: var(--in-soft); color: var(--in); }\n@keyframes pulse { 50% { opacity: .3; } }\nbody.noscroll { overflow: hidden; }\n.sheet { position: fixed; inset: 0; z-index: 40; background: rgba(12, 14, 18, .45); display: flex; align-items: flex-end; justify-content: center; animation: fade .15s; }\n.sheet-card { background: var(--surface); width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto; border-radius: 20px 20px 0 0; padding: 18px 18px calc(22px + env(safe-area-inset-bottom)); animation: up .2s cubic-bezier(.2,.8,.2,1); }\n@media (min-width: 700px) { .sheet { align-items: center; } .sheet-card { border-radius: 20px; } }\n@keyframes up { from { transform: translateY(24px); opacity: .6; } }\n@keyframes fade { from { opacity: 0; } }\n.sh-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 14px; }\n.sh-head h2 { margin: 0; font-size: 21px; }\n.sh-head .btn { margin-left: auto; }\n.sh-sub { color: var(--ink-3); font-size: 13.5px; margin-top: 2px; }\n.sh-h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); margin: 18px 0 8px; }\n.btn.big { width: 100%; justify-content: center; padding: 15px 18px; font-size: 16.5px; font-weight: 700; border-radius: 14px; }\n.btn.big svg { width: 20px; height: 20px; }\n.btn.wide { width: 100%; justify-content: center; margin-top: 16px; }\n.btn.danger-solid { background: var(--out); border-color: var(--out); color: #fff; }\n.btn:disabled { opacity: .5; cursor: not-allowed; }\n.linkbtn { background: none; border: 0; color: var(--ink-3); font-size: 13.5px; text-decoration: underline; margin-top: 10px; cursor: pointer; padding: 6px; }\n.cancel-row { text-align: center; margin-top: 4px; }\n.timer-card { text-align: center; background: var(--surface-2); border-radius: 16px; padding: 18px 16px; display: flex; flex-direction: column; align-items: center; }\n.timer-card p { margin: 4px 0 14px; color: var(--ink-2); }\n.tc-label { color: var(--ink-2); font-size: 14px; font-weight: 600; }\n.tc-time { font-size: 52px; font-weight: 750; font-variant-numeric: tabular-nums; letter-spacing: -.02em; margin: 4px 0 14px; }\n.timer-card.other .tc-time { font-size: 38px; margin-bottom: 4px; }\n.tc-step { color: var(--new); font-weight: 650; font-size: 14px; }\n.hist, .dmg { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; background: var(--surface); }\n.hist-h { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; justify-content: space-between; }\n.hist-h span { color: var(--ink-3); font-size: 13px; }\n.hist-s { color: var(--ink-2); font-size: 13px; margin-top: 4px; }\n.warn { color: var(--out); font-weight: 600; }\n.dmg { border-left: 4px solid var(--out); }\n.dmg.resolved { border-left-color: var(--in); opacity: .8; }\n.dmg-desc { margin: 6px 0; white-space: pre-wrap; }\n.media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 10px; }\n.mt { position: relative; border-radius: 10px; overflow: hidden; background: #000; aspect-ratio: 16/10; display: block; }\n.mt video, .mt img { width: 100%; height: 100%; object-fit: cover; display: block; }\n.mt.video { grid-column: 1 / -1; aspect-ratio: auto; }\n.mt.video video { max-height: 60vh; object-fit: contain; }\n.mt-wait { color: #ddd; font-size: 13px; display: grid; place-items: center; height: 100%; min-height: 90px; }\n.mt-d { position: absolute; right: 6px; top: 6px; background: rgba(0,0,0,.6); color: #fff; font-size: 11.5px; padding: 2px 6px; border-radius: 6px; }\n.mt-bar { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; font-size: 13px; margin-top: -2px; }\n.mt-bar a { color: var(--accent); font-weight: 650; text-decoration: none; }\n.mt-q { color: var(--ink-3); font-weight: 650; }\n.ev-tip { font-size: 13px; color: var(--ink-2); background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; margin: 10px 0 0; }\n.ev-tip summary { cursor: pointer; font-weight: 650; color: var(--ink); }\n.ev-tip ol { margin: 8px 0 6px; padding-left: 20px; }\n.ev-tip li { margin: 3px 0; }\n.ev-tip p { margin: 4px 0 2px; }\n.up-warn { grid-column: 1 / -1; color: var(--out); font-size: 12.5px; font-weight: 600; margin-top: 2px; }\n.evidence { background: var(--surface-2); border-radius: 16px; padding: 16px; }\n.ev-head { font-size: 15px; margin-bottom: 12px; }\n.req { display: inline-block; font-size: 11.5px; font-weight: 700; color: var(--out); background: var(--out-soft); padding: 2px 7px; border-radius: 999px; margin-left: 4px; vertical-align: 1px; }\n.ev-btns { display: flex; flex-wrap: wrap; gap: 8px; }\n.ev-btns .btn.big { flex-basis: 100%; }\n.btn.file { position: relative; overflow: hidden; cursor: pointer; }\n.btn.file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; font-size: 0; }\n.ev-note { font-size: 13px; color: var(--ink-3); margin: 10px 0; }\n#ev-list, #dmg-list { margin: 8px 0 12px; }\n.up { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 10px; align-items: center; padding: 8px 10px; border-radius: 10px; background: var(--surface); border: 1px solid var(--line); margin-bottom: 6px; font-size: 13.5px; }\n.up-k { font-weight: 700; }\n.up-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }\n.up-s { font-variant-numeric: tabular-nums; font-weight: 600; }\n.up.ok .up-s { color: var(--in); }\n.up.err .up-s { color: var(--out); }\n.up-bar { grid-column: 1 / -1; height: 4px; border-radius: 4px; background: var(--line-2); overflow: hidden; }\n.up-bar i { display: block; height: 100%; background: var(--accent); transform-origin: left; transition: transform .2s; }\n.up.ok .up-bar i { background: var(--in); }\n.dmg-form label { display: block; font-size: 13.5px; font-weight: 650; margin: 12px 0 6px; }\n.dmg-form textarea, .dmg-form input[type=text] { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); font: inherit; color: var(--ink); }\n.dmg-form .btn.big { margin-top: 6px; }\n.confirm-del { background: var(--out-soft); color: var(--ink); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; font-size: 14px; }\n.active-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; background: var(--ink); color: var(--bg); padding: 10px 0 calc(10px + env(safe-area-inset-bottom)); box-shadow: 0 -4px 20px rgba(0,0,0,.15); }\n.active-bar .wrap { display: flex; align-items: center; gap: 10px; font-size: 14.5px; }\n.active-bar .btn { margin-left: auto; }\n.active-bar b { font-variant-numeric: tabular-nums; }\n.ab-dot { width: 9px; height: 9px; border-radius: 50%; background: #f5b83d; animation: pulse 1.4s infinite; flex: none; }\nbody:has(.active-bar:not(.hidden)) main { padding-bottom: 80px; }\n.cl-overlay { position: fixed; inset: 0; z-index: 50; background: var(--bg); display: flex; align-items: center; justify-content: center; padding: 20px; animation: fade .15s; }\n.cl-card { width: 100%; max-width: 460px; text-align: center; display: flex; flex-direction: column; align-items: center; }\n.cl-top { width: 100%; display: flex; justify-content: space-between; align-items: center; margin-bottom: 26px; }\n.cl-count { font-weight: 700; color: var(--ink-3); font-size: 13.5px; }\n.cl-dots { display: flex; gap: 6px; }\n.cl-dots i { width: 22px; height: 5px; border-radius: 4px; background: var(--line); }\n.cl-dots i.done { background: var(--in); }\n.cl-dots i.cur { background: var(--accent); }\n.cl-icon { width: 92px; height: 92px; border-radius: 26px; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; margin-bottom: 18px; }\n.cl-icon svg { width: 54px; height: 54px; }\n.cl-card h2 { font-size: 26px; margin: 0 0 10px; }\n.cl-q { font-size: 18px; line-height: 1.45; color: var(--ink); margin: 0 0 8px; }\n.cl-help { font-size: 13.5px; color: var(--ink-3); margin: 0 0 26px; }\n.tapbtn { width: 100%; height: 64px; border-radius: 16px; border: 2px solid var(--in); background: var(--in-soft); color: var(--in); font-size: 17px; font-weight: 750; cursor: pointer; }\n.tapbtn:active { transform: scale(.985); }\n.tapbtn:disabled { opacity: .6; }\n.cl-sum { list-style: none; padding: 0; margin: 4px 0 18px; width: 100%; text-align: left; display: flex; flex-direction: column; gap: 10px; }\n.cl-sum li { display: flex; gap: 12px; align-items: flex-start; font-size: 16px; line-height: 1.4; padding: 12px 14px; border-radius: 12px; background: var(--in-soft); }\n.cl-tick { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--in); color: #fff; display: grid; place-items: center; font-size: 14px; font-weight: 800; }\n.hold { position: relative; width: 100%; height: 64px; border-radius: 16px; border: 2px solid var(--in); background: var(--in-soft); color: var(--in); font-size: 17px; font-weight: 750; overflow: hidden; cursor: pointer; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: none; }\n.hold-fill { position: absolute; inset: 0; background: var(--in); opacity: .28; transform: scaleX(0); transform-origin: left; }\n.hold.ok .hold-fill { opacity: 1; }\n.hold-label { position: relative; mix-blend-mode: normal; }\n.hold.ok .hold-label { color: #fff; }\n@media (prefers-color-scheme: dark) { .hold.ok .hold-label { color: var(--accent-ink); } }\n.hold.holding { transform: scale(.985); }\n.hold.ok .hold-fill { transform: scaleX(1) !important; }\n.cv-date { padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: inherit; }\n.cv-summary { grid-template-columns: repeat(4, 1fr); }\n.cv-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; }\n.cv-item { padding: 12px 14px; margin-bottom: 8px; }\n.cv-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; color: var(--ink-2); margin-top: 6px; }\n@media (max-width: 800px) { .cv-grid { grid-template-columns: 1fr; } .cv-summary { grid-template-columns: repeat(2, 1fr); } }\n\n.seg { min-width: 0; overflow-x: auto; scrollbar-width: none; }\n.seg::-webkit-scrollbar { display: none; }\n.seg button { flex: none; }\n.btn.me { flex: none; }\n.cv-item .mt.video video, .hist .mt.video video { max-height: 340px; }\n@media (max-width: 460px) { .seg button { padding: 6px 8px; font-size: 13.5px; } .top .wrap { gap: 8px; } }\n\n/* ================= mobile first =================\n   Cleaners and supervisors use phones: bottom tab bar, big tap targets,\n   no zoom-on-focus, safe areas for notches and home bars. */\n.seg .ti { display: none; }\nhtml { -webkit-text-size-adjust: 100%; }\nbody { -webkit-tap-highlight-color: transparent; }\nbutton, .btn, .row.tap, .dbtn { touch-action: manipulation; }\n@media (hover: none) { .row.tap:hover { background: var(--surface-2); } .row.tap:active { background: var(--line-2); } }\n.row.tap::after { content: ''; flex: none; width: 8px; height: 8px; border-right: 2px solid var(--ink-3); border-top: 2px solid var(--ink-3); transform: rotate(45deg); margin: 0 4px 0 2px; opacity: .6; }\n\n@media (max-width: 760px) {\n  input, select, textarea { font-size: 16px !important; }   /* stops iPhone zooming in */\n  .top { padding-top: env(safe-area-inset-top); }\n  .top .wrap { height: 54px; }\n  .brand .name { display: inline; font-size: 16px; }\n  .top .live { margin-left: -4px; }\n  /* tabs move to a bar at the bottom of the screen */\n  .top .seg { position: fixed; left: 0; right: 0; bottom: 0; z-index: 35; border-radius: 0; border: 0; border-top: 1px solid var(--line);\n    background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: saturate(1.6) blur(14px); -webkit-backdrop-filter: saturate(1.6) blur(14px);\n    padding: 4px 4px calc(4px + env(safe-area-inset-bottom)); gap: 0; justify-content: space-around; overflow: visible; }\n  .top .seg button { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 2px 5px !important; font-size: 11px !important; font-weight: 620; border-radius: 10px; color: var(--ink-3); min-width: 0; }\n  .top .seg button .ti { display: block; width: 23px; height: 23px; }\n  .top .seg button[aria-selected=\"true\"] { background: none; color: var(--accent); }\n  .top .seg button[aria-selected=\"true\"] .ti { stroke-width: 2.4; }\n  .btn.me { margin-left: auto; }\n  .btn.me .btn-label { display: none; }\n  main.wrap { padding-bottom: calc(84px + env(safe-area-inset-bottom)); }\n  body:has(.active-bar:not(.hidden)) main { padding-bottom: calc(150px + env(safe-area-inset-bottom)); }\n  .active-bar { bottom: calc(62px + env(safe-area-inset-bottom)); padding: 10px 0; border-radius: 14px 14px 0 0; }\n  .toast { bottom: calc(80px + env(safe-area-inset-bottom)); }\n  body:has(.active-bar:not(.hidden)) .toast { bottom: calc(140px + env(safe-area-inset-bottom)); }\n  .foot { padding-bottom: 10px; }\n\n  /* week bar: arrows + title on one line, actions to the right */\n  .weekbar { gap: 6px; }\n  .weekbar h1 { font-size: 18px; }\n  .btn.sq, .btn.act { height: 40px; min-width: 40px; }\n  #newpill { order: 10; flex-basis: 100%; }\n\n  /* day rows: bigger targets */\n  .row { padding: 12px 12px; min-height: 56px; border-radius: 12px; }\n  .row .u { font-size: 16px; }\n  .row .times .pill, .row .times span { font-size: 13.5px; }\n\n  /* cleaning panel is a full-height sheet */\n  .sheet-card { max-height: calc(100vh - 24px - env(safe-area-inset-top)); max-height: calc(100dvh - 24px - env(safe-area-inset-top)); padding-bottom: calc(24px + env(safe-area-inset-bottom)); }\n  .sh-head .btn.sq { width: 44px; height: 44px; }\n  .btn.big { min-height: 56px; }\n  .ev-btns .btn { flex: 1 1 auto; justify-content: center; min-height: 46px; }\n  .hold, .tapbtn { height: 72px; }\n  .cl-overlay { padding: calc(20px + env(safe-area-inset-top)) 20px calc(20px + env(safe-area-inset-bottom)); }\n  .cl-card h2 { font-size: 24px; }\n\n  /* compact media on phones */\n  .mt.video video, .cv-item .mt.video video, .hist .mt.video video { max-height: 230px; }\n  .media-grid { grid-template-columns: repeat(3, 1fr); gap: 6px; }\n\n  /* cleaning tab */\n  #view-cleaning .weekbar h1 { flex-basis: 100%; }\n  .cv-date { flex: 1; min-height: 40px; }\n  .cv-meta { font-size: 13.5px; }\n  .hist-h { flex-direction: column; align-items: flex-start; }\n\n  /* users & account */\n  .users-layout { grid-template-columns: 1fr !important; }\n  .utable td, .utable th { padding-left: 12px !important; padding-right: 12px !important; }\n  .acct-grid { grid-template-columns: 1fr !important; }\n}\n@media (max-width: 380px) { .brand .name { display: none; } }\n@media (prefers-color-scheme: dark) and (max-width: 760px) { .top .seg { background: color-mix(in srgb, var(--surface) 90%, transparent); } }\n.row.tap { position: relative; padding-right: 32px; }\n.row.tap::after { position: absolute; right: 14px; top: 50%; margin: -4px 0 0; }\n@media (max-width: 760px) {\n  .hist .mt.video { grid-column: span 2; }\n  .hist .mt.video video { max-height: 160px; object-fit: cover; }\n}\n\n/* Returning the key */\n.ks-steps { margin: 4px 0 14px; padding-left: 22px; line-height: 1.55; font-size: 15.5px; }\n.ks-l { display: block; font-weight: 650; font-size: 14px; margin: 10px 0 6px; }\n.ks-code { width: 100%; font-size: 30px; letter-spacing: 14px; text-align: center; font-weight: 750; padding: 12px; border-radius: 14px; border: 2px solid var(--line); background: var(--surface); color: var(--ink); font-variant-numeric: tabular-nums; }\n.ks-code:focus { outline: none; border-color: var(--accent); }\n.ks-check { display: flex; gap: 10px; align-items: flex-start; margin: 16px 0 6px; font-size: 15.5px; line-height: 1.4; }\n.ks-check input { width: 22px; height: 22px; flex: none; margin-top: 1px; }\n.ks-msg { color: var(--out); min-height: 1.2em; margin: 4px 0 8px; font-size: 14px; }\n.kn-status { display: flex; gap: 10px; align-items: center; padding: 14px; border-radius: 12px; background: var(--bg); margin: 8px 0 10px; font-weight: 600; }\n.kn-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--ink-3); flex: none; }\n.kn-status.wait .kn-dot { background: #d99a00; animation: pulse 1.4s infinite; }\n.kn-status.ok .kn-dot { background: var(--in); }\n.kn-status.err .kn-dot { background: var(--out); }\n@keyframes pulse { 50% { opacity: .35; } }\n.keystep .btn.wide { margin-bottom: 10px; }\n.kbadge { font-size: 11.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); white-space: nowrap; }\n.kbadge.kn { background: var(--in-soft); color: var(--in); }\n.pnote { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--ink-2); padding: 0 16px 10px; margin-top: -3px; }\n.pnote b { color: var(--ink); font-variant-numeric: tabular-nums; letter-spacing: .5px; }\n.kn-panel { margin-bottom: 16px; grid-column: 1 / -1; padding: 16px 18px; }\n.kn-panel h3 { margin: 0 0 6px; }\n.kn-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line); }\n.kn-row select { flex: 1; min-width: 180px; padding: 8px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }\n.kn-panel code { word-break: break-all; }\n\n/* ---------- Notifications (bell + panel) ---------- */\n.bell { position: relative; flex: none; }\n.bell-n { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 99px; background: var(--out); color: #fff; font-size: 10.5px; font-weight: 700; display: grid; place-items: center; box-shadow: 0 0 0 2px var(--surface); }\n.notif { position: fixed; inset: 0; z-index: 60; background: rgba(18, 30, 25, .18); display: flex; justify-content: flex-end; align-items: flex-start; padding: 64px 16px 16px; }\n.notif-card { width: 100%; max-width: 400px; max-height: calc(100vh - 90px); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 14px 34px rgba(18, 63, 48, .18); overflow: hidden; }\n.notif-head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 10px 16px; border-bottom: 1px solid var(--line); }\n.notif-head h3 { margin: 0; font-size: 16px; flex: 1; }\n.linkbtn.inline { margin: 0; padding: 0; color: var(--accent); text-decoration: none; font-weight: 600; font-size: 13px; }\n.notif-push { display: flex; flex-direction: column; gap: 3px; padding: 12px 16px; background: var(--surface-2); border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink-2); }\n.notif-push b { color: var(--ink); font-size: 13.5px; }\n.notif-push.offer { flex-direction: row; flex-wrap: wrap; align-items: center; column-gap: 8px; }\n.notif-push.offer span { flex: 1; }\n.notif-push.offer b { flex-basis: 100%; }\n.notif-push.on b { color: var(--accent); }\n.np-btns { display: flex; gap: 16px; margin-top: 4px; }\n.notif-list { overflow-y: auto; }\n.nitem { display: flex; gap: 12px; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line-2); padding: 12px 16px; cursor: pointer; color: var(--ink-2); }\n.nitem:hover { background: var(--surface-2); }\n.nitem.unread { background: color-mix(in srgb, var(--accent-soft) 55%, var(--surface)); }\n.nico { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 13px; background: var(--accent-soft); color: var(--accent); }\n.t-damage .nico { background: var(--out-soft); color: var(--out); }\n.t-unassigned .nico { background: var(--line-2); color: var(--ink-3); }\n.ntext { display: flex; flex-direction: column; gap: 1px; min-width: 0; font-size: 13px; }\n.ntext b { color: var(--ink); font-size: 14px; }\n.ntext em { font-style: normal; color: var(--ink-3); font-size: 12px; margin-top: 2px; }\n.nitem.unread .ntext b::after { content: \"\"; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-left: 7px; vertical-align: 2px; }\n@media (max-width: 600px) { .notif { padding: 60px 8px 8px; } .notif-card { max-width: none; max-height: calc(100vh - 150px); } }\n\n/* ---------- Assignments ---------- */\n.achip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 650; color: var(--ink-2); background: var(--line-2); border-radius: 99px; padding: 2px 8px 2px 6px; white-space: nowrap; }\n.achip svg { width: 12px; height: 12px; }\n.achip.mine { background: var(--accent-soft); color: var(--accent-strong); }\n.assign-row { display: flex; align-items: center; gap: 10px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; margin: 0 0 14px; font-size: 14px; color: var(--ink-2); }\n.assign-row svg { width: 18px; height: 18px; flex: none; color: var(--accent); }\n.assign-row label { font-weight: 600; color: var(--ink); white-space: nowrap; }\n.assign-row select { flex: 1; min-width: 0; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font-size: 15px; }\n.assign-row.ro b { color: var(--ink); }\n\n/* ---------- Settings ---------- */\n.set-group { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); margin: 6px 0 10px; font-family: var(--font); font-weight: 700; }\n.set-card { padding: 20px; }\n.set-head { display: flex; align-items: flex-start; gap: 12px; }\n.set-head > div { flex: 1; }\n.set-head h3 { margin: 0 0 4px; font-size: 17px; }\n.set-head p { margin: 0 0 14px; font-size: 13.5px; line-height: 1.55; max-width: 70ch; }\n.pill { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 11.5px; font-weight: 700; white-space: nowrap; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink-2); }\n.pill.ok { background: var(--accent-soft); color: var(--accent-strong); border-color: transparent; }\n.pill.off { background: var(--out-soft); color: var(--out); border-color: transparent; }\n.kn-table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 6px; }\n.kn-table th { text-align: left; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); padding: 8px 10px; background: var(--surface-2); border-bottom: 1px solid var(--line); }\n.kn-table td { padding: 10px; border-top: 1px solid var(--line-2); vertical-align: middle; }\n.kn-table tr.changed td { background: var(--new-soft); }\n.kn-table select { width: 100%; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font-size: 14px; }\n.set-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; }\n.set-actions .btn { margin-top: 0; }\n.set-actions .spacer { flex: 1; }\n.set-actions .muted { font-size: 12.5px; }\n.edit-note { font-size: 13px; font-weight: 600; color: var(--new); }\n.confirm-box { margin-top: 14px; border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 12px; padding: 14px 16px; background: var(--surface-2); font-size: 14px; }\n.confirm-box ul { margin: 8px 0; padding-left: 18px; }\n.confirm-box li { margin: 3px 0; }\n.confirm-box p { margin: 6px 0 0; font-size: 13px; }\n.confirm-box .form-actions { margin-top: 12px; }\n.confirm-box .form-actions .btn { margin-top: 0; }\n.kn-hook { margin-top: 14px; font-size: 13px; }\n.kn-hook code { word-break: break-all; }\n\n/* Properties: KeyNest flats that aren't linked */\n.warn-banner { background: var(--out-soft); color: var(--ink); border: 1px solid color-mix(in srgb, var(--out) 25%, transparent); line-height: 1.7; }\n.warn-banner b { color: var(--out); }\n.flat-chip { display: inline-block; background: var(--surface); border: 1px solid var(--line); border-radius: 99px; padding: 0 9px; font-size: 12.5px; font-weight: 600; color: var(--ink); }\n.flat-chip span { color: var(--ink-3); font-weight: 500; }\n.warn-banner .linkbtn.inline { margin-left: 4px; }\n" },
  "app.js": { type: "text/javascript; charset=utf-8", hash: "1sx5crx", body: "(() => {\n  const $ = (id) => document.getElementById(id);\n  const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const D = (s) => new Date(s + 'T00:00:00Z');\n  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts });\n  const WD_SHORT = fmt({ weekday: 'short' }), WD_LONG = fmt({ weekday: 'long' }), MON = fmt({ month: 'long' }), MON_S = fmt({ month: 'short' });\n  const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));\n  const longDate = (s) => `${WD_LONG.format(D(s))}, ${ordinal(D(s).getUTCDate())} ${MON.format(D(s))}`;\n  const shortDate = (s) => `${D(s).getUTCDate()} ${MON_S.format(D(s))}`;\n  const compact = (t) => (t || '').replace(' ', '');\n  const shortType = (t) => ({ 'Studio': 'Studio', '1 Bedroom': '1 bed', '2 Bedroom': '2 bed', '3 Bedroom': '3 bed' }[t] || t);\n  const store = { get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} } };\n  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));\n\n  let data = null;          // week on screen\n  let view = store.get('cs_view') || 'day';\n  let me = null;            // signed-in person and their permissions\n  const can = (perm) => Boolean(me && me.perms && me.perms[perm]);\n  const VIEW_PERM = { day: 'view_day', board: 'view_board', props: 'view_properties', cleaning: 'view_cleaning', users: 'manage_users', settings: null, account: null };\n  // Admin and User roles run the operation: Settings/integrations and assigning cleanings (checked again on the server).\n  const isManager = () => Boolean(me && (me.role === 'admin' || me.role === 'user'));\n  const allowed = (v) => v in VIEW_PERM && (v === 'settings' ? isManager() : (!VIEW_PERM[v] || can(VIEW_PERM[v]) || (v === 'cleaning' && can('manage_damage'))));\n  let selected = null;      // selected date in day view\n  let version = null;       // bookings version from the server\n  let boardDirty = true;    // board is rebuilt only when it's actually shown\n  let props = null;\n  const weeks = new Map();  // weekStart → data (instant back/forward)\n  const inflight = new Map();\n\n  function toast(msg) {\n    document.querySelectorAll('.toast').forEach((t) => t.remove());\n    const t = document.createElement('div');\n    t.className = 'toast'; t.textContent = msg;\n    document.body.appendChild(t);\n    setTimeout(() => t.remove(), 2600);\n  }\n\n  async function getJSON(url) {\n    const r = await fetch(url, { credentials: 'same-origin' });\n    if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }\n    const body = await r.json().catch(() => ({}));\n    if (!r.ok) throw new Error(body.error || 'Could not load the schedule');\n    return body;\n  }\n\n  // Weeks are keyed by their start date; \"\" means \"the week containing today\".\n  function fetchWeek(date, fresh = false) {\n    const key = (date || 'now') + (fresh ? ':fresh' : '');\n    if (inflight.has(key)) return inflight.get(key);\n    const q = new URLSearchParams();\n    if (date) q.set('date', date);\n    if (fresh) q.set('refresh', '1');\n    const p = getJSON('/api/week?' + q).then((w) => { weeks.set(w.weekStart, w); version = w.version; return w; })\n      .finally(() => inflight.delete(key));\n    inflight.set(key, p);\n    return p;\n  }\n  function prefetchAround(w) {\n    idle(() => { for (const d of [w.nextWeek, w.prevWeek]) if (!weeks.has(d)) fetchWeek(d).catch(() => {}); });\n  }\n\n  const signature = (w) => w && JSON.stringify([w.version, w.weekStart, w.today, w.totals, w.days.map((d) => [d.cleans, d.arrivals, d.hasNew])]);\n\n  let navToken = 0;\n  async function showWeek(date, { fresh = false, quiet = false } = {}) {\n    const my = ++navToken;\n    const cached = !fresh && date && weeks.get(date);\n    if (cached) apply(cached);                        // instant from memory\n    else document.body.classList.add('is-loading');   // keep old week visible, just dimmed\n    $('refresh').disabled = true;\n    try {\n      const w = await fetchWeek(date, fresh);\n      if (my === navToken) apply(w); // ignore answers for weeks the user has already moved past\n      prefetchAround(w);\n      if (fresh && !quiet) toast('Up to date with Guesty');\n    } catch (e) {\n      if (e.message !== 'signed out') $('banners').innerHTML = `<div class=\"banner error\">${esc(e.message)}</div>`;\n    } finally {\n      document.body.classList.remove('is-loading');\n      $('refresh').disabled = false;\n    }\n  }\n\n  function apply(w) {\n    const same = data && signature(data) === signature(w);\n    const weekChanged = !data || data.weekStart !== w.weekStart;\n    data = w;\n    if (weekChanged || !data.dates.includes(selected)) selected = data.dates.includes(data.today) ? data.today : data.dates[0];\n    history.replaceState(null, '', data.dates.includes(data.today) ? location.pathname : `?week=${data.weekStart}`);\n    if (same && !weekChanged) { renderFoot(); return; } // nothing changed: don't touch the screen\n    boardDirty = true;\n    render();\n  }\n\n  // ---------- rendering ----------\n  function render() {\n    const { weekStart, weekEnd, today, totals, linen, warnings, mock } = data;\n    const isThisWeek = data.dates.includes(today);\n    $('week-title').textContent = `${shortDate(weekStart)} – ${shortDate(weekEnd)}`;\n    $('when').textContent = isThisWeek ? 'This week' : weekStart > today ? 'Upcoming' : 'Past week';\n    $('this').classList.toggle('hidden', isThisWeek);\n    $('newpill').innerHTML = totals.newBookings ? `<span class=\"newpill\">${totals.newBookings} new booking${totals.newBookings > 1 ? 's' : ''}</span>` : '';\n\n    const banners = [];\n    if (mock) banners.push('<div class=\"banner\">Showing <b>sample data</b>. Add your Guesty keys in Railway to see live bookings.</div>');\n    for (const w of warnings || []) banners.push(`<div class=\"banner\">${esc(w)}</div>`);\n    $('banners').innerHTML = banners.join('');\n\n    $('m-out').textContent = totals.checkOuts;\n    $('m-in').textContent = totals.checkIns;\n    $('m-turn').textContent = totals.turnovers;\n    if (totals.linenSets !== null) $('m-linen').innerHTML = linen.map((r) => `<div class=\"item\"><div class=\"v\">${r.sets}</div><div class=\"t\">${esc(r.type)}</div></div>`).join('') +\n      `<div class=\"item total\"><div class=\"v\">${totals.linenSets}</div><div class=\"t\">Total sets</div></div>`;\n\n    renderStrip();\n    renderDay();\n    if (view === 'board') renderBoard();\n    renderFoot();\n  }\n\n  function renderFoot() {\n    const at = new Date(data.generatedAt);\n    $('foot').textContent = `Bookings last checked with Guesty at ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${data.statuses.join(' + ')} bookings only`;\n  }\n\n  function renderStrip() {\n    $('strip').innerHTML = data.days.map((d) => {\n      const cls = ['dbtn', d.date === data.today ? 'today' : '', d.date < data.today ? 'past' : ''].join(' ');\n      return `<button class=\"${cls}\" role=\"tab\" aria-selected=\"${d.date === selected}\" data-date=\"${d.date}\">\n        ${d.hasNew ? '<i class=\"newdot\" title=\"New booking\"></i>' : ''}\n        <div class=\"dn\">${WD_SHORT.format(D(d.date))}</div>\n        <div class=\"dd\">${D(d.date).getUTCDate()}</div>\n        <div class=\"dc\"><b>${d.cleans}</b><span class=\"lbl\"> out</span><span class=\"sep\"> · </span><em>${d.arrivals}</em><span class=\"lbl\"> in</span></div>\n      </button>`;\n    }).join('');\n  }\n  $('strip').addEventListener('click', (e) => {\n    const b = e.target.closest('.dbtn');\n    if (!b || b.dataset.date === selected) return;\n    selected = b.dataset.date;\n    $('strip').querySelectorAll('.dbtn').forEach((x) => x.setAttribute('aria-selected', x === b));\n    renderDay();\n  });\n\n  function chip(kind, e) {\n    if (!e) return '';\n    return `<span class=\"chip ${kind}\">${kind === 'out' ? 'Out' : 'In'} ${esc(e.time || '—')}${e.planned ? ' <small>planned</small>' : ''}</span>`;\n  }\n  function groupByBuilding(units) {\n    const map = new Map();\n    for (const u of units) {\n      if (!map.has(u.building)) map.set(u.building, { name: u.building, postcode: u.postcode, units: [] });\n      map.get(u.building).units.push(u);\n    }\n    return [...map.values()];\n  }\n  function section(kind, title, hint, units) {\n    if (!units.length) return '';\n    const groups = groupByBuilding(units).map((g) => `\n      <div class=\"bldg\">\n        <div class=\"bldg-name\">${esc(g.name)}<span>${esc(g.postcode)}</span></div>\n        ${g.units.map((u) => {\n          const isNew = (u.checkIn && u.checkIn.isNew) || (u.checkOut && u.checkOut.isNew);\n          const guests = u.checkIn && u.checkIn.guests ? `${u.checkIn.guests} guest${u.checkIn.guests > 1 ? 's' : ''}` : '';\n          return `<div class=\"row tap\" data-listing=\"${esc(u.listingId)}\" role=\"button\" tabindex=\"0\" aria-label=\"Open ${esc(u.label)}\">\n            <span class=\"u\">${esc(u.label)}</span>\n            <span class=\"t\">${esc(shortType(u.unitType))}</span>\n            ${guests ? `<span class=\"g\">· ${guests}</span>` : ''}\n            ${isNew ? '<span class=\"new\">New</span>' : ''}\n            <span class=\"cbadge\" data-cbadge=\"${esc(u.listingId)}\"></span><span data-achip=\"${esc(u.listingId)}\"></span>\n            <span class=\"times\">${chip('out', u.checkOut)}${u.checkOut && u.checkIn ? '<span class=\"arrow\">→</span>' : ''}${chip('in', u.checkIn)}</span>\n          </div>`;\n        }).join('')}\n      </div>`).join('');\n    return `<div class=\"section s-${kind}\">\n      <div class=\"shead\"><span class=\"bar\"></span><h3>${title}</h3><span class=\"count\">${units.length}</span><span class=\"hint\">${hint}</span></div>\n      ${groups}\n    </div>`;\n  }\n  function renderDay() {\n    const day = data.days.find((d) => d.date === selected);\n    if (!day) return;\n    const turn = day.units.filter((u) => u.checkOut && u.checkIn);\n    const outs = day.units.filter((u) => u.checkOut && !u.checkIn);\n    const ins = day.units.filter((u) => !u.checkOut && u.checkIn);\n    const linenBits = Object.entries(day.linen).map(([t, n]) => `${esc(shortType(t))} <b>${n}</b>`).join(' · ');\n    $('daypanel').innerHTML = `\n      <div class=\"dayhead\"><h2>${esc(longDate(day.date))}</h2>${linenBits ? `<span class=\"dlinen\">Linen: ${linenBits}</span>` : ''}</div>\n      ${day.units.length ? '' : '<div class=\"empty\"><b>Nothing scheduled</b>No check-ins or check-outs on this day.</div>'}\n      ${section('turn', 'Same-day turnovers', 'Clean between check-out and check-in', turn)}\n      ${section('out', 'Check-outs', 'Clean — nobody arriving today', outs)}\n      ${section('in', 'Arrivals', 'Make sure the flat is ready', ins)}`;\n    decorateDay();\n  }\n\n  function renderBoard() {\n    boardDirty = false;\n    const { dates, days, board, today } = data;\n    const head = `<colgroup><col class=\"first\">${dates.map(() => '<col>').join('')}</colgroup>\n      <thead><tr><th class=\"first-col\"></th>${days.map((d) => `<th class=\"${d.date === today ? 'today' : ''}\"><button data-date=\"${d.date}\" title=\"Open ${esc(longDate(d.date))}\">\n        <div class=\"dn\">${WD_SHORT.format(D(d.date))}</div><div class=\"dd\">${D(d.date).getUTCDate()}</div><div class=\"dc\">${d.cleans} out · ${d.arrivals} in</div></button></th>`).join('')}</tr></thead>`;\n    const body = board.map((b) => `\n      <tr class=\"b-row\"><td colspan=\"${dates.length + 1}\"><div class=\"b-name\">${esc(b.name)}<span>${esc(b.postcode)}</span></div></td></tr>\n      ${b.units.map((u) => `<tr>\n        <td class=\"first-col unit\"><span class=\"u\">${esc(u.label)}</span><span class=\"t\">${esc(shortType(u.unitType))}</span></td>\n        ${u.cells.map((c, i) => {\n          const morning = Boolean(c.out) || (c.occ && !c.in);\n          const night = c.occ;\n          let h = '';\n          if (morning) h += `<div class=\"half l${c.out ? ' end' : ''}\"></div>`;\n          if (night) h += `<div class=\"half r${c.in ? ' start' : ''}${c.in && c.in.isNew ? ' isnew' : ''}\"></div>`;\n          if (c.out && c.in) h += `<span class=\"mark turn\" title=\"Out ${esc(c.out.time)} → In ${esc(c.in.time)}\">${esc(compact(c.out.time).replace(/am|pm/, ''))}→${esc(compact(c.in.time).replace(/am|pm/, ''))}</span>`;\n          else if (c.out) h += `<span class=\"mark out\" title=\"Check-out ${esc(c.out.time)}\">${esc(compact(c.out.time))}</span>`;\n          else if (c.in) h += `<span class=\"mark in\" title=\"Check-in ${esc(c.in.time)}\">${esc(compact(c.in.time))}</span>`;\n          return `<td class=\"cell${dates[i] === today ? ' today' : ''}\">${h}</td>`;\n        }).join('')}\n      </tr>`).join('')}`).join('');\n    const foot = `<tfoot>\n      <tr><td class=\"first-col\">Cleans</td>${days.map((d) => `<td class=\"o\">${d.cleans || '–'}</td>`).join('')}</tr>\n      <tr><td class=\"first-col\">Arrivals</td>${days.map((d) => `<td class=\"i\">${d.arrivals || '–'}</td>`).join('')}</tr>\n    </tfoot>`;\n    $('board').innerHTML = head + `<tbody>${body}</tbody>` + foot;\n  }\n  $('board').addEventListener('click', (e) => {\n    const b = e.target.closest('thead button');\n    if (!b) return;\n    selected = b.dataset.date;\n    setView('day');\n    renderStrip(); renderDay();\n  });\n\n  async function loadProps() {\n    try {\n      if (!props) $('props').innerHTML = '<div class=\"loading\">Loading…</div>';\n      const p = await getJSON('/api/properties');\n      if (props && JSON.stringify(p) === JSON.stringify(props)) return;\n      props = p;\n      const counts = Object.entries(p.counts).map(([t, n]) => `${n} × ${shortType(t)}`).join(' · ');\n      $('props-sub').textContent = `${p.total} flats · ${counts}`;\n      $('props').innerHTML = p.buildings.map((b) => `<div class=\"card pcard\">\n        <h3>${esc(b.name)}</h3><div class=\"pc\">${esc(b.postcode)}</div>\n        ${b.units.map((u) => `<div class=\"prow\" title=\"${esc(u.address)}\"><span class=\"u\">${esc(u.label)}</span><span>${esc(shortType(u.unitType))}</span><span class=\"t\">Out ${esc(u.checkOut)} · In ${esc(u.checkIn)}</span></div>${u.keyMode === 'lockbox' ? `<div class=\"pnote\"><span class=\"kbadge\">Lockbox</span><span>${u.lockbox ? `Code <b>${esc(u.lockbox.code)}</b> · set by ${esc(u.lockbox.by)}, ${esc(fmtWhen(u.lockbox.at))}` : 'No code recorded yet'}</span></div>` : u.keyMode === 'keynest' ? '<div class=\"pnote\"><span class=\"kbadge kn\">KeyNest</span><span>Key handed in at KeyNest after each clean</span></div>' : ''}`).join('')}\n      </div>`).join('');\n      // KeyNest flats that aren't linked to a KeyNest key can't be completed by cleaners: say so at the top.\n      const kn = p.keynest || { unlinked: [] };\n      const many = kn.unlinked.length > 1;\n      const fix = p.canManage ? `<button class=\"linkbtn inline\" id=\"kn-fix\">${kn.connected ? `Link ${many ? 'them' : 'it'}` : 'Set it up'} in Settings › Integrations › KeyNest</button>` : `Ask an Admin to ${kn.connected ? `link ${many ? 'them' : 'it'}` : 'connect KeyNest'}.`;\n      $('props-banner').innerHTML = !kn.unlinked.length ? '' : `<div class=\"banner warn-banner\"><b>${kn.connected ? `${kn.unlinked.length} KeyNest flat${kn.unlinked.length > 1 ? 's aren’t' : ' isn’t'} linked to a KeyNest key` : 'KeyNest isn’t connected yet'}.</b>\n        Cleaners can’t complete ${many ? 'these flats' : 'this flat'} until ${kn.connected ? (many ? 'they’re linked' : 'it’s linked') : 'KeyNest is connected'}:\n        ${kn.unlinked.map((f) => `<span class=\"flat-chip\">${esc(f.label)} <span>· ${esc(f.building)}</span></span>`).join(' ')} ${fix}</div>`;\n      if ($('kn-fix')) $('kn-fix').onclick = () => { setView('settings'); setTimeout(() => { const el = $('settings-keynest'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300); };\n    } catch (e) {\n      if (e.message !== 'signed out') $('props').innerHTML = `<div class=\"banner error\">${esc(e.message)}</div>`;\n    }\n  }\n\n  function fmtWhen(iso) { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }\n\n  // ---------- Settings › Integrations › KeyNest (Admin and User roles) ----------\n  // Locked by default: \"Edit links\" unlocks the rows, and nothing is saved until the changes are reviewed and confirmed.\n  let kn = null, knEdit = false, knDraft = {};\n  async function loadSettings() {\n    const box = $('settings-keynest');\n    try {\n      kn = await getJSON('/api/keynest');\n      knEdit = false; knDraft = {};\n      renderKeynest();\n    } catch (e) { if (e.message !== 'signed out') box.innerHTML = `<h3>KeyNest</h3><div class=\"banner error\">${esc(e.message)}</div>`; }\n  }\n  const keyName = (id) => { const k = kn && kn.keys.find((x) => x.id === id); return k ? (k.name || k.id) : id ? `Key ${id}` : 'Not linked'; };\n  function renderKeynest() {\n    const box = $('settings-keynest');\n    const k = kn;\n    const live = k.connected && !k.error;\n    const changes = Object.entries(knDraft).filter(([id, keyId]) => (k.flats.find((f) => f.id === id) || {}).keyId !== keyId);\n    const opts = (sel) => `<option value=\"\">Not linked</option>${k.keys.map((x) => `<option value=\"${esc(x.id)}\" ${x.id === sel ? 'selected' : ''}>${esc(x.name || x.id)}${x.status ? ' · ' + esc(x.status) : ''}</option>`).join('')}`;\n    const rows = k.flats.map((f) => {\n      const cur = f.id in knDraft ? knDraft[f.id] : f.keyId;\n      const changed = f.id in knDraft && knDraft[f.id] !== f.keyId;\n      return `<tr class=\"${changed ? 'changed' : ''}\"><td><b>${esc(f.label)}</b><span class=\"muted\"> · ${esc(f.building)}</span></td>\n        <td>${knEdit && live ? `<select data-kn=\"${esc(f.id)}\">${opts(cur)}</select>` : cur ? `${esc(keyName(cur))}${f.how === 'auto' ? ' <span class=\"muted\">· matched by name</span>' : ''}` : '<span class=\"warn\">Not linked</span>'}</td></tr>`;\n    }).join('');\n    box.innerHTML = `<div class=\"set-head\"><div><h3>KeyNest</h3>\n        <p class=\"muted\">Flats tagged <b>KEYNEST</b> in Guesty are linked to their KeyNest key here. A cleaner can only complete a KeyNest flat once KeyNest shows its key handed back in.</p></div>\n        <span class=\"pill ${live ? 'ok' : 'off'}\">${live ? 'Connected' : k.connected ? 'Error' : 'Not connected'}</span></div>\n      ${!k.connected ? '<div class=\"banner\">Not connected yet. Add <b>KEYNEST_API_KEY</b> in Railway (Variables) and the app connects automatically. Until then, KeyNest flats can’t be completed.</div>' : k.error ? `<div class=\"banner error\">${esc(k.error)}</div>` : ''}\n      ${k.flats.length ? `<table class=\"kn-table\"><thead><tr><th>Flat</th><th>KeyNest key</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class=\"muted\">No flats have the KEYNEST tag in Guesty.</p>'}\n      <div class=\"set-actions\" id=\"kn-actions\">${!live || !k.flats.length ? '' : !knEdit\n        ? '<button class=\"btn\" id=\"kn-edit\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"4\" y=\"11\" width=\"16\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 7.5-2\"/></svg>Edit links</button><span class=\"muted\">Locked to prevent accidental changes.</span>'\n        : `<span class=\"edit-note\">Editing — changes aren’t saved until you confirm.</span><span class=\"spacer\"></span><button class=\"btn\" id=\"kn-cancel\">Cancel</button><button class=\"btn primary\" id=\"kn-review\" ${changes.length ? '' : 'disabled'}>Review ${changes.length || ''} change${changes.length === 1 ? '' : 's'}</button>`}</div>\n      <div id=\"kn-confirm\"></div>\n      ${k.webhookUrl ? `<details class=\"muted kn-hook\"><summary>Instant updates (optional)</summary>Ask KeyNest to send webhooks to: <code>${esc(k.webhookUrl)}</code></details>` : ''}`;\n    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };\n    on('kn-edit', () => { knEdit = true; knDraft = {}; renderKeynest(); });\n    on('kn-cancel', () => { knEdit = false; knDraft = {}; renderKeynest(); });\n    box.querySelectorAll('select[data-kn]').forEach((s) => { s.onchange = () => { knDraft[s.dataset.kn] = s.value || null; renderKeynest(); }; });\n    on('kn-review', () => {\n      $('kn-confirm').innerHTML = `<div class=\"confirm-box\"><b>Save ${changes.length} KeyNest change${changes.length === 1 ? '' : 's'}?</b>\n        <ul>${changes.map(([id, keyId]) => { const f = k.flats.find((x) => x.id === id); return `<li><b>${esc(f.label)}</b> <span class=\"muted\">· ${esc(f.building)}</span>: ${esc(keyName(f.keyId))} → <b>${esc(keyName(keyId))}</b></li>`; }).join('')}</ul>\n        <p class=\"muted\">Cleaners use these links to finish KeyNest flats. A wrong link means the wrong key is checked.</p>\n        <div class=\"form-actions\"><button class=\"btn primary\" id=\"kn-save\">Yes, save changes</button><button class=\"btn\" id=\"kn-back\">Go back</button></div></div>`;\n      $('kn-back').onclick = () => { $('kn-confirm').innerHTML = ''; };\n      $('kn-save').onclick = async () => {\n        $('kn-save').disabled = true;\n        try {\n          await send('PUT', '/api/keynest/links', { confirmed: true, changes: changes.map(([listingId, keyId]) => ({ listingId, keyId })) });\n          toast('KeyNest links saved ✓'); props = null; await loadSettings();\n        } catch (e) { toast(e.message); $('kn-save').disabled = false; }\n      };\n    });\n  }\n\n  // ---------- text for WhatsApp ----------\n  function dayText(day) {\n    const lines = [`_${longDate(day.date)}_`];\n    if (!day.units.length) { lines.push('- Nothing scheduled'); return lines; }\n    for (const g of groupByBuilding(day.units)) {\n      for (const u of g.units) {\n        const parts = [];\n        if (u.checkOut) parts.push(`Check-out at ${u.checkOut.time}`);\n        if (u.checkIn) parts.push(`Check-in at ${u.checkIn.time}`);\n        lines.push(`- *${u.name}* - ${parts.join(' | ')}${(u.checkIn && u.checkIn.isNew) ? ' (NEW)' : ''}`);\n      }\n    }\n    const linen = Object.entries(day.linen).map(([t, n]) => `${t}: ${n}`).join(', ');\n    if (linen) lines.push(`Linen: ${linen}`);\n    return lines;\n  }\n  function weekText() {\n    const lines = [`*Cityscape Schedule* — ${longDate(data.weekStart)} to ${longDate(data.weekEnd)}`, '', '*Laundry*'];\n    for (const r of data.linen) lines.push(`${r.type}: ${r.sets}`);\n    lines.push(`Total: ${data.totals.linenSets}`, '', '*Cleaning*');\n    for (const d of data.days) lines.push('', ...dayText(d));\n    return lines.join('\\n');\n  }\n\n  // ---------- views ----------\n  function setView(v) {\n    if (!allowed(v)) v = ['day', 'board', 'props', 'account'].find(allowed);\n    view = v;\n    store.set('cs_view', v);\n    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === v));\n    $('me-btn').setAttribute('aria-selected', v === 'account');\n    $('week-area').classList.toggle('hidden', !(v === 'day' || v === 'board'));\n    $('view-day').classList.toggle('hidden', v !== 'day');\n    $('view-board').classList.toggle('hidden', v !== 'board');\n    $('view-props').classList.toggle('hidden', v !== 'props');\n    $('view-users').classList.toggle('hidden', v !== 'users');\n    $('view-cleaning').classList.toggle('hidden', v !== 'cleaning');\n    $('view-account').classList.toggle('hidden', v !== 'account');\n    $('view-settings').classList.toggle('hidden', v !== 'settings');\n    $('foot').classList.toggle('hidden', !(v === 'day' || v === 'board'));\n    $('copy-label').textContent = v === 'board' ? 'Copy week' : 'Copy day';\n    if (v === 'board' && data && boardDirty) renderBoard();\n    if (v === 'props') loadProps();\n    if (v === 'users') loadUsers();\n    if (v === 'cleaning') loadCleaningView();\n    if (v === 'account') renderAccount();\n    if (v === 'settings') loadSettings();\n  }\n\n  // ---------- who's signed in ----------\n  const initials = (n) => (n || '?').split(/\\s+/).filter((w) => /^[a-z]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');\n  function applyPermissions() {\n    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('hidden', !allowed(b.dataset.view)));\n    $('copy').classList.toggle('hidden', !can('copy_print'));\n    $('print').classList.toggle('hidden', !can('copy_print'));\n    $('refresh').classList.toggle('hidden', !can('refresh'));\n    document.querySelector('.metric.linen').classList.toggle('hidden', !can('view_linen'));\n    document.querySelector('.summary').classList.toggle('no-linen', !can('view_linen'));\n    $('me-avatar').textContent = initials(me.name);\n    $('me-name').textContent = me.name.split(' ')[0];\n  }\n  function renderAccount() {\n    const b = me.buildings === 'all' ? 'All buildings' : (me.buildings.length ? me.buildings.map(esc).join(', ') : 'None assigned yet');\n    const perms = (window.__permsList || []).filter(([k]) => can(k)).map(([, label]) => esc(label)).join(', ');\n    $('acct-info').innerHTML = `<h3>${esc(me.name)}</h3><dl>\n      <dt>Username</dt><dd>${esc(me.username)}</dd>\n      <dt>Role</dt><dd style=\"text-transform:capitalize\">${esc(me.role)}</dd>\n      <dt>Email</dt><dd>${esc(me.email || '—')}</dd>\n      <dt>Buildings</dt><dd>${b}</dd>\n      <dt>Can use</dt><dd>${perms || '—'}</dd></dl>`;\n    $('pw-form').classList.toggle('hidden', !!me.isOwner);\n  }\n  $('pw-form').addEventListener('submit', async (e) => {\n    e.preventDefault();\n    const msg = $('pw-msg');\n    if ($('pw-new').value !== $('pw-new2').value) { msg.className = 'form-msg err'; msg.textContent = 'The two new passwords don’t match.'; return; }\n    try {\n      await send('POST', '/api/me/password', { current: $('pw-cur').value, password: $('pw-new').value });\n      e.target.reset(); msg.className = 'form-msg ok'; msg.textContent = 'Password changed. Other devices have been signed out.';\n    } catch (err) { msg.className = 'form-msg err'; msg.textContent = err.message; }\n  });\n\n  async function send(method, url, body) {\n    const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });\n    if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }\n    const out = await r.json().catch(() => ({}));\n    if (!r.ok) throw new Error(out.error || 'Something went wrong');\n    return out;\n  }\n\n  // ---------- users (admins) ----------\n  let U = null;          // { users, perms, roles, defaults, buildings }\n  let editing = null;    // user id being edited, 'new', or null\n  const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', user: 'User', cleaner: 'Cleaner' };\n  const when = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never';\n  async function loadUsers() {\n    try { U = await getJSON('/api/users'); renderUsers(); }\n    catch (e) { if (e.message !== 'signed out') $('users-msg').innerHTML = `<div class=\"banner error\">${esc(e.message)}</div>`; }\n  }\n  function renderUsers() {\n    const active = U.users.filter((u) => u.active).length;\n    $('users-sub').textContent = `${active} active · owner recovery login not listed`;\n    $('users-list').innerHTML = U.users.length ? U.users.map((u) => `\n      <tr class=\"${u.id === editing ? 'sel' : ''} ${u.active ? '' : 'off'}\">\n        <td class=\"who\"><b>${esc(u.name)}</b><span>${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}${u.active ? '' : ' · deactivated'}</span></td>\n        <td><span class=\"role ${u.role}\">${ROLE_LABEL[u.role] || esc(u.role)}</span></td>\n        <td class=\"hide-sm\">${u.buildings === 'all' ? 'All' : u.buildings.length ? esc(u.buildings.length + ' building' + (u.buildings.length > 1 ? 's' : '')) : '<span style=\"color:var(--out)\">None yet</span>'}</td>\n        <td class=\"hide-sm\">${when(u.lastLoginAt)}</td>\n        <td><button class=\"btn\" data-edit=\"${u.id}\">Edit</button></td>\n      </tr>`).join('') : '<tr><td colspan=\"5\" class=\"empty\"><b>No users yet</b>Click “Add user” to create the first account.</td></tr>';\n    if (editing) renderForm(); else { $('user-form').classList.add('hidden'); document.querySelector('.users-layout').classList.remove('editing'); }\n  }\n  $('users-list').addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) { editing = b.dataset.edit; renderUsers(); } });\n  $('add-user').onclick = () => { editing = 'new'; renderUsers(); $('uf-name').focus(); };\n\n  function genPassword() {\n    const words = ['maple', 'harbour', 'linen', 'cobalt', 'willow', 'amber', 'granite', 'orchid', 'copper', 'saffron', 'meadow', 'pebble'];\n    const r = crypto.getRandomValues(new Uint32Array(3));\n    return words[r[0] % words.length][0].toUpperCase() + words[r[0] % words.length].slice(1) + '-' + words[r[1] % words.length] + '-' + (100 + (r[2] % 900));\n  }\n  function renderForm() {\n    const isNew = editing === 'new';\n    const u = isNew ? { name: '', username: '', email: '', role: 'user', active: true, ...U.defaults.user } : U.users.find((x) => x.id === editing);\n    if (!u) { editing = null; return renderUsers(); }\n    const allB = u.buildings === 'all';\n    const f = $('user-form');\n    f.innerHTML = `\n      <h3>${isNew ? 'Add user' : 'Edit ' + esc(u.name)}</h3>\n      <label for=\"uf-name\">Full name</label><input id=\"uf-name\" type=\"text\" value=\"${esc(u.name)}\" required>\n      <label for=\"uf-username\">Username</label><input id=\"uf-username\" type=\"text\" value=\"${esc(u.username)}\" autocapitalize=\"none\" spellcheck=\"false\" required>\n      <div class=\"hint\">Used to sign in. Lowercase, e.g. maria or j.smith</div>\n      <label for=\"uf-email\">Email</label><input id=\"uf-email\" type=\"email\" value=\"${esc(u.email || '')}\" placeholder=\"name@example.com\">\n      <div class=\"hint\">Saved for notifications later.</div>\n      <label for=\"uf-role\">Role</label>\n      <select id=\"uf-role\">${U.roles.map((r) => `<option value=\"${r}\" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>\n      <label for=\"uf-pw\">${isNew ? 'Password' : 'Reset password'}</label>\n      <div class=\"pwrow\"><input id=\"uf-pw\" type=\"text\" autocomplete=\"new-password\" placeholder=\"${isNew ? 'At least 8 characters' : 'Leave blank to keep their password'}\" ${isNew ? 'required' : ''}><button class=\"btn\" type=\"button\" id=\"uf-gen\">Generate</button></div>\n      <div class=\"hint\">${isNew ? 'Share it with them privately. They can change it under My account.' : 'Setting a new password signs them out everywhere.'}</div>\n      <fieldset><legend>Permissions</legend><div class=\"checks\">\n        ${U.perms.map(([k, label]) => `<label><input type=\"checkbox\" data-perm=\"${k}\" ${u.perms && u.perms[k] ? 'checked' : ''}>${esc(label)}</label>`).join('')}\n      </div></fieldset>\n      <fieldset><legend>Buildings they can see</legend>\n        <div class=\"radio\"><label><input type=\"radio\" name=\"uf-bmode\" value=\"all\" ${allB ? 'checked' : ''}>All buildings</label><label><input type=\"radio\" name=\"uf-bmode\" value=\"some\" ${allB ? '' : 'checked'}>Only these</label></div>\n        <div class=\"checks ${allB ? 'hidden' : ''}\" id=\"uf-blist\">${U.buildings.map((b) => `<label><input type=\"checkbox\" data-b=\"${esc(b)}\" ${!allB && u.buildings.includes(b) ? 'checked' : ''}>${esc(b)}</label>`).join('')}</div>\n      </fieldset>\n      ${isNew ? '' : `<fieldset><legend>Status</legend><div class=\"radio\"><label><input type=\"radio\" name=\"uf-active\" value=\"1\" ${u.active ? 'checked' : ''}>Active</label><label><input type=\"radio\" name=\"uf-active\" value=\"0\" ${u.active ? '' : 'checked'}>Deactivated</label></div></fieldset>`}\n      <div class=\"form-msg\" id=\"uf-msg\"></div>\n      <div id=\"uf-confirm\"></div>\n      <div class=\"form-actions\">\n        <button class=\"btn primary\" type=\"submit\">${isNew ? 'Create user' : 'Save changes'}</button>\n        <button class=\"btn\" type=\"button\" id=\"uf-cancel\">Cancel</button>\n        <span class=\"spacer\"></span>\n        ${isNew || u.id === me.id ? '' : '<button class=\"btn danger\" type=\"button\" id=\"uf-del\">Delete</button>'}\n      </div>`;\n    f.classList.remove('hidden');\n    document.querySelector('.users-layout').classList.add('editing');\n    $('uf-gen').onclick = () => { $('uf-pw').value = genPassword(); };\n    $('uf-cancel').onclick = () => { editing = null; renderUsers(); };\n    f.querySelectorAll('[name=uf-bmode]').forEach((r) => r.onchange = () => $('uf-blist').classList.toggle('hidden', f.querySelector('[name=uf-bmode]:checked').value === 'all'));\n    // Picking a role fills in that role's usual settings; everything stays editable.\n    $('uf-role').onchange = () => {\n      const d = U.defaults[$('uf-role').value];\n      f.querySelectorAll('[data-perm]').forEach((c) => { c.checked = !!d.perms[c.dataset.perm]; });\n      const all = d.buildings === 'all';\n      f.querySelector(`[name=uf-bmode][value=${all ? 'all' : 'some'}]`).checked = true;\n      $('uf-blist').classList.toggle('hidden', all);\n    };\n    if ($('uf-del')) $('uf-del').onclick = () => {\n      $('uf-confirm').innerHTML = `<div class=\"confirm-del\">Delete ${esc(u.name)}? They won’t be able to sign in and this can’t be undone. <button class=\"btn danger\" type=\"button\" id=\"uf-del-yes\">Yes, delete</button> <button class=\"btn\" type=\"button\" id=\"uf-del-no\">Keep</button></div>`;\n      $('uf-del-no').onclick = () => { $('uf-confirm').innerHTML = ''; };\n      $('uf-del-yes').onclick = async () => {\n        try { await send('DELETE', '/api/users/' + u.id); editing = null; toast(`${u.name} deleted`); loadUsers(); }\n        catch (err) { $('uf-msg').className = 'form-msg err'; $('uf-msg').textContent = err.message; }\n      };\n    };\n    f.onsubmit = async (e) => {\n      e.preventDefault();\n      const some = f.querySelector('[name=uf-bmode]:checked').value === 'some';\n      const body = {\n        name: $('uf-name').value, username: $('uf-username').value, email: $('uf-email').value, role: $('uf-role').value,\n        perms: Object.fromEntries([...f.querySelectorAll('[data-perm]')].map((c) => [c.dataset.perm, c.checked])),\n        buildings: some ? [...f.querySelectorAll('[data-b]:checked')].map((c) => c.dataset.b) : 'all',\n      };\n      if ($('uf-pw').value) body.password = $('uf-pw').value;\n      if (!isNew) body.active = f.querySelector('[name=uf-active]:checked').value === '1';\n      try {\n        const out = await send(isNew ? 'POST' : 'PUT', isNew ? '/api/users' : '/api/users/' + u.id, body);\n        toast(isNew ? `${out.user.name} can now sign in as “${out.user.username}”` : 'Saved');\n        editing = null; loadUsers();\n        if (out.user.id === me.id) { me = { ...me, ...out.user }; applyPermissions(); }\n      } catch (err) { $('uf-msg').className = 'form-msg err'; $('uf-msg').textContent = err.message; }\n    };\n  }\n\n  // ---------- live updates ----------\n  // Guesty tells the server about every booking change; the page checks a tiny \"version\" every 15 seconds.\n  function setLive(state, title) {\n    const el = $('live');\n    el.className = 'live' + (state === 'on' ? ' on' : '');\n    el.querySelector('.lbl').textContent = state === 'on' ? 'Live' : state === 'preview' ? 'Preview' : 'Auto';\n    el.title = title;\n  }\n  let polling = false;\n  async function checkVersion() {\n    if (polling || document.hidden || !data) return;\n    polling = true;\n    try {\n      const v = await getJSON('/api/version');\n      setLive(v.webhook === 'registered' ? 'on' : v.webhook === 'preview' ? 'preview' : 'auto',\n        v.webhook === 'registered' ? 'Instant updates from Guesty are on' : 'Checking Guesty every few minutes');\n      if (version && v.version !== version) {\n        const before = data.totals.newBookings;\n        weeks.clear();\n        await showWeek(data.weekStart, { quiet: true });\n        toast(data.totals.newBookings > before ? 'New booking — schedule updated' : 'Bookings changed — schedule updated');\n      }\n      version = v.version;\n    } catch (_) { /* offline for a moment: try again next tick */ }\n    finally { polling = false; }\n  }\n\n  // ---------- wiring ----------\n  document.querySelectorAll('.seg button').forEach((b) => b.onclick = () => setView(b.dataset.view));\n  $('prev').onclick = () => data && showWeek(data.prevWeek);\n  $('next').onclick = () => data && showWeek(data.nextWeek);\n  $('this').onclick = () => showWeek('');\n  $('refresh').onclick = () => { weeks.clear(); showWeek(data ? data.weekStart : '', { fresh: true }); };\n  $('print').onclick = () => window.print();\n  $('copy').onclick = async () => {\n    if (!data) return;\n    const text = view === 'board' ? weekText() : dayText(data.days.find((d) => d.date === selected)).join('\\n');\n    try { await navigator.clipboard.writeText(text); toast('Copied — paste into WhatsApp'); }\n    catch (_) { toast('This browser blocked copying'); }\n  };\n  document.addEventListener('keydown', (e) => {\n    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || !data || !(view === 'day' || view === 'board')) return;\n    if (e.key === 'ArrowLeft') showWeek(data.prevWeek);\n    if (e.key === 'ArrowRight') showWeek(data.nextWeek);\n  });\n\n  $('me-btn').onclick = () => setView('account');\n  (async () => {\n    const q0 = new URLSearchParams(location.search);\n    const deep = q0.get('view') ? location.href : null; // opened from a notification: ?view=…&date=…&flat=…\n    try { const r = await getJSON('/api/me'); me = r.user; window.__permsList = r.perms; }\n    catch (_) { return; }\n    applyPermissions();\n    setView(deep && allowed(q0.get('view')) ? q0.get('view') : view);\n    if (can('view_day') || can('view_board')) {\n      const w = q0.get('week') || (deep && q0.get('date'));\n      showWeek(/^\\d{4}-\\d{2}-\\d{2}$/.test(w || '') ? w : '').then(() => { checkVersion(); if (deep) openLink(deep); });\n    } else if (deep) openLink(deep);\n    loadNotifs();\n    initPush();\n  })();\n  setInterval(checkVersion, 15000);\n  setInterval(() => { if (!document.hidden && me) refreshCleanings(); }, 15000);\n  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });\n\n  // =====================================================================\n  // Cleaning: begin → timer → end → hold-to-confirm checklist → video\n  // Damage reports with video/photo evidence\n  // =====================================================================\n  let cleanings = [];           // cleanings visible to me (selected day + my active one)\n  let checklistDef = [];\n  let holdMs = 3000;\n  const ACTIVE = ['in_progress', 'checklist', 'awaiting_video', 'awaiting_key'];\n  const fmtClock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });\n  const fmtDur = (ms) => {\n    const s = Math.max(0, Math.floor(ms / 1000));\n    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;\n    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');\n  };\n  const durWords = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'under 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };\n  const myActive = () => cleanings.find((c) => c.cleanerId === me.id && ACTIVE.includes(c.status));\n  // A cleaning counts towards the check-out it follows, not just the day it happened: e.g. a flat checked out\n  // Sunday and cleaned Monday morning shows as cleaned on Sunday. It belongs to the latest check-out at or\n  // before the time it started (up to 2 hours early, in case the guest left early), unless a new guest has\n  // arrived since. It also still shows on the day it happened, unless that day's own check-out is still to clean.\n  const londonHM = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));\n  const minus2h = (hm) => { const [h, m] = hm.split(':').map(Number); const t = Math.max(0, h * 60 + m - 120); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };\n  const nextDay = (d) => { const x = D(d); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };\n  // Cleanings are fetched up to the day after the week, so a Friday check-out cleaned on Saturday morning is found.\n  const cleaningRange = () => `from=${data.dates[0]}&to=${nextDay(data.dates[data.dates.length - 1])}`;\n  const unitOn = (listingId, date) => { const day = data.days.find((d) => d.date === date); return day && day.units.find((u) => u.listingId === listingId); };\n  function cleanFor(c) {\n    if (!data || !c.startedAt) return c.date;\n    // Left over from another week while the new one loads: it can't belong to a check-out on screen.\n    if (c.date < data.dates[0] || c.date > nextDay(data.dates[data.dates.length - 1])) return c.date;\n    const hm = londonHM(c.startedAt);\n    let best = null;\n    for (const d of data.dates) {\n      if (d > c.date) break;\n      const u = unitOn(c.listingId, d);\n      const o = u && u.checkOut;\n      if (o && (d < c.date || !o.timeRaw || hm >= minus2h(o.timeRaw))) best = d;\n      if (u && u.checkIn && d < c.date) best = null; // a new guest arrived since, so that check-out was cleaned already\n    }\n    return best || c.date;\n  }\n  function cleaningShowsOn(c, date) {\n    if (cleanFor(c) === date) return true;\n    const u = c.date === date && unitOn(c.listingId, date);\n    return c.date === date && !(u && u.checkOut);\n  }\n  const forListing = (id, date) => cleanings.filter((c) => c.listingId === id && c.status !== 'cancelled' && (!date || ACTIVE.includes(c.status) || cleaningShowsOn(c, date)));\n  let cRange = '';\n\n  async function refreshCleanings() {\n    if (!me) return;\n    try {\n      const range = data ? cleaningRange() : '';\n      const [r, a] = await Promise.all([getJSON('/api/cleanings?' + range), getJSON('/api/assignments?' + range).catch(() => null)]);\n      cRange = range;\n      cleanings = r.cleanings; checklistDef = r.checklist; holdMs = r.holdMs;\n      if (a) assignments = Object.fromEntries(a.assignments.map((x) => [`${x.date}|${x.listingId}`, x]));\n      decorateDay();\n      renderActiveBar();\n      // Only redraw the open panel if something in it changed: redrawing wipes what's being typed (lockbox code,\n      // damage description) and the damage form's upload list.\n      if (sheetListing && sheetMode === 'main' && sheetSig() !== lastSheetSig) renderSheet();\n    } catch (_) { /* try again on the next tick */ }\n  }\n\n  // Badges on Day view rows: \"Cleaning · 12:04\" (live) or \"Cleaned · 49 min\"\n  function decorateDay() {\n    if (data && me && cRange !== cleaningRange()) { cRange = 'loading'; refreshCleanings(); }\n    document.querySelectorAll('[data-cbadge]').forEach((el) => {\n      const list = forListing(el.dataset.cbadge, selected);\n      const active = list.find((c) => ACTIVE.includes(c.status));\n      const done = list.filter((c) => c.status === 'completed').pop();\n      if (active) el.innerHTML = `<span class=\"cb running\"><i></i>${esc(active.cleanerName.split(' ')[0])} · <b data-since=\"${esc(active.startedAt)}\" data-until=\"${esc(active.endedAt || '')}\">${fmtDur((active.endedAt ? Date.parse(active.endedAt) : Date.now()) - Date.parse(active.startedAt))}</b></span>`;\n      else if (done) el.innerHTML = `<span class=\"cb done\">✓ Cleaned · ${durWords(Date.parse(done.endedAt) - Date.parse(done.startedAt))}</span>`;\n      else el.innerHTML = '';\n    });\n    // Who's assigned to each flat that day.\n    document.querySelectorAll('[data-achip]').forEach((el) => {\n      const a = assignments[`${selected}|${el.dataset.achip}`];\n      el.innerHTML = a ? `<span class=\"achip${a.cleanerId === me.id ? ' mine' : ''}\" title=\"Assigned to ${esc(a.cleanerName)}\">${PERSON_ICON}${a.cleanerId === me.id ? 'You' : esc(a.cleanerName.split(' ')[0])}</span>` : '';\n    });\n  }\n  let assignments = {}; // \"date|listingId\" → { cleanerId, cleanerName, … }\n  const PERSON_ICON = '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21a8 8 0 0 1 16 0\"/></svg>';\n  // One clock for every running timer on the page.\n  setInterval(() => {\n    document.querySelectorAll('[data-since]').forEach((el) => {\n      if (el.dataset.until) return;\n      el.textContent = fmtDur(Date.now() - Date.parse(el.dataset.since));\n    });\n  }, 1000);\n\n  // Sticky bar so a cleaner can always get back to the flat they're cleaning.\n  function renderActiveBar() {\n    const a = myActive();\n    const bar = $('active-bar');\n    if (!a) { bar.classList.add('hidden'); return; }\n    const step = a.status === 'in_progress' ? `<b data-since=\"${esc(a.startedAt)}\">${fmtDur(Date.now() - Date.parse(a.startedAt))}</b>` : a.status === 'checklist' ? 'Checklist to finish' : a.status === 'awaiting_key' ? 'Key to return' : 'Video needed';\n    bar.innerHTML = `<div class=\"wrap\"><span class=\"ab-dot\"></span><span>Cleaning <b>${esc(a.label)}</b> · ${step}</span><button class=\"btn primary\" id=\"ab-open\">Open</button></div>`;\n    bar.classList.remove('hidden');\n    $('ab-open').onclick = () => openSheet(a.listingId);\n  }\n\n  // Tapping a flat in the Day view opens its panel.\n  $('daypanel').addEventListener('click', (e) => { const r = e.target.closest('.row.tap'); if (r) openSheet(r.dataset.listing); });\n  $('daypanel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const r = e.target.closest('.row.tap'); if (r) openSheet(r.dataset.listing); } });\n\n  // ---------------- property panel ----------------\n  let sheetListing = null;\n  let sheetMode = 'main';      // main | damage\n  function unitFor(listingId) {\n    for (const d of (data ? data.days : [])) { const u = d.units.find((x) => x.listingId === listingId); if (u) return u; }\n    for (const b of (data ? data.board : [])) { const u = b.units.find((x) => x.listingId === listingId); if (u) return { ...u, building: b.name }; }\n    const c = cleanings.find((x) => x.listingId === listingId);\n    return c ? { listingId, label: c.label, name: c.listingName, building: c.building, unitType: c.unitType } : null;\n  }\n  function openSheet(listingId) {\n    sheetListing = listingId; sheetMode = 'main';\n    $('sheet').classList.remove('hidden');\n    document.body.classList.add('noscroll');\n    renderSheet();\n  }\n  function closeSheet() {\n    if (uploadsBusy()) { toast('An upload is still running — keep this open until it finishes'); return; }\n    sheetListing = null;\n    $('sheet').classList.add('hidden');\n    document.body.classList.remove('noscroll');\n  }\n  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet' || e.target.closest('[data-close]')) closeSheet(); });\n\n  // \"4K\", \"1080p\"… from the uploaded video's shorter side (works for upright and sideways videos).\n  const qualityName = (m) => { const s = Math.min(m.width, m.height); return s >= 2160 ? '4K' : s >= 1080 ? '1080p' : s >= 720 ? '720p' : `${m.width}×${m.height}`; };\n  function videoBar(m) {\n    const bits = [];\n    if (m.width && m.height) bits.push(isLowQuality(m) ? `<span class=\"warn\">Low quality · ${m.width}×${m.height}</span>` : `<span class=\"mt-q\">${qualityName(m)}${m.hdr ? ' HDR' : ''}</span>`);\n    if (m.hasOrig) bits.push(`<a href=\"/media/${esc(m.id)}/orig\" target=\"_blank\" rel=\"noopener\">Full quality</a>`, `<a href=\"/media/${esc(m.id)}/orig?download=1\">Download original</a>`);\n    return bits.length ? `<div class=\"mt-bar\">${bits.join('')}</div>` : '';\n  }\n  function mediaTiles(media) {\n    if (!media || !media.length) return '';\n    return `<div class=\"media-grid\">${media.map((m) => m.kind === 'video'\n      ? `<div class=\"mt video\">${m.status === 'ready' ? `<video controls preload=\"none\" playsinline poster=\"/media/${m.id}/thumb\" src=\"/media/${m.id}\"></video>` : `<div class=\"mt-wait\">Processing video…</div>`}${m.duration ? `<span class=\"mt-d\">${fmtDur(m.duration * 1000)}</span>` : ''}</div>${videoBar(m)}`\n      : `<a class=\"mt photo\" href=\"/media/${m.id}${m.hasOrig ? '/orig' : ''}\" target=\"_blank\" rel=\"noopener\"><img loading=\"lazy\" src=\"/media/${m.id}/thumb\" onerror=\"this.src='/media/${m.id}'\" alt=\"Photo\"></a>`).join('')}</div>`;\n  }\n\n  // A cleaner can back out of their own cleaning at any step until it's complete.\n  const CANCEL_MINE = '<button class=\"linkbtn\" id=\"cancel-clean\">Changed your mind? Cancel this cleaning</button>';\n  let lastSheetSig = null;\n  const typingStep = () => { const a = me && myActive(); return Boolean(a && a.listingId === sheetListing && (a.status === 'awaiting_video' || a.status === 'awaiting_key')); };\n  const sheetSig = () => JSON.stringify([sheetListing, selected, typingStep() ? null : (assignments[`${selected}|${sheetListing}`] || {}).cleanerId || null, forListing(sheetListing, selected).map((c) =>\n    [c.id, c.status, c.endedAt, c.guesty, c.checklist && c.checklist.length, c.key && c.key.mode, (c.media || []).map((m) => [m.id, m.status, m.hasOrig])])]);\n\n  // ---- assigning a cleaner to this flat on the selected day (Admin/User); everyone else just sees who it is ----\n  const assignees = new Map(); // listingId → [{ id, name, role }]\n  function assignBlock() {\n    const a = assignments[`${selected}|${sheetListing}`];\n    const day = selected === (data && data.today) ? 'today' : esc(longDate(selected));\n    if (!isManager()) return a ? `<div class=\"assign-row ro\">${PERSON_ICON}<span>${a.cleanerId === me.id ? '<b>Assigned to you</b>' : `Assigned to <b>${esc(a.cleanerName)}</b>`} ${day}</span></div>` : '';\n    return `<div class=\"assign-row\">${PERSON_ICON}<label for=\"as-sel\">Cleaner ${day}</label>\n      <select id=\"as-sel\" data-cur=\"${esc(a ? a.cleanerId : '')}\"><option value=\"\">${a ? esc(a.cleanerName) : 'Not assigned'}</option></select></div>`;\n  }\n  async function wireAssign() {\n    const sel = $('as-sel');\n    if (!sel) return;\n    const listingId = sheetListing, date = selected;\n    let cur = sel.dataset.cur;\n    try {\n      if (!assignees.has(listingId)) assignees.set(listingId, (await getJSON('/api/assignees?listingId=' + encodeURIComponent(listingId))).people);\n    } catch (e) { return; }\n    if ($('as-sel') !== sel) return; // panel was redrawn meanwhile\n    const people = assignees.get(listingId);\n    sel.innerHTML = `<option value=\"\">Not assigned</option>${people.map((p) => `<option value=\"${esc(p.id)}\" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}${p.role !== 'cleaner' ? ` (${esc(p.role)})` : ''}</option>`).join('')}`;\n    sel.onchange = async () => {\n      sel.disabled = true;\n      try {\n        const r = await send('PUT', '/api/assignments', { listingId, date, cleanerId: sel.value || null });\n        const k = `${date}|${listingId}`;\n        if (r.assignment) assignments[k] = r.assignment; else delete assignments[k];\n        cur = sel.value; lastSheetSig = sheetSig();\n        toast(r.assignment ? `Assigned to ${r.assignment.cleanerName} — they’ve been notified` : 'Assignment removed');\n        decorateDay();\n      } catch (e) { toast(e.message); sel.value = cur; }\n      sel.disabled = false;\n    };\n  }\n  async function renderSheet() {\n    const u = unitFor(sheetListing);\n    if (!u) return;\n    if (sheetMode !== 'damage') lastSheetSig = sheetSig();\n    const list = forListing(sheetListing, selected);\n    const active = list.find((c) => ACTIVE.includes(c.status));\n    const done = list.filter((c) => c.status === 'completed');\n    const mine = active && active.cleanerId === me.id;\n    let body = '';\n\n    if (sheetMode === 'damage') return renderDamageForm(u);\n\n    if (active && mine && active.status === 'in_progress') {\n      body = `<div class=\"timer-card\">\n          <div class=\"tc-label\">Cleaning since ${fmtClock(active.startedAt)}</div>\n          <div class=\"tc-time\" data-since=\"${esc(active.startedAt)}\">${fmtDur(Date.now() - Date.parse(active.startedAt))}</div>\n          <button class=\"btn big danger-solid\" id=\"end-clean\">End cleaning</button>\n          <button class=\"linkbtn\" id=\"cancel-clean\">Started by mistake? Cancel</button>\n        </div>`;\n    } else if (active && mine && active.status === 'checklist') {\n      body = `<div class=\"timer-card\"><div class=\"tc-label\">Cleaning ended at ${fmtClock(active.endedAt)} · ${durWords(Date.parse(active.endedAt) - Date.parse(active.startedAt))}</div>\n        <p>Go through the final checks to finish.</p><button class=\"btn big primary\" id=\"open-checklist\">Continue checklist</button>${CANCEL_MINE}</div>`;\n    } else if (active && mine && active.status === 'awaiting_video') {\n      body = evidenceStep(active) + `<div class=\"cancel-row\">${CANCEL_MINE}</div>`;\n    } else if (active && mine && active.status === 'awaiting_key') {\n      body = keyStep(active) + `<div class=\"cancel-row\">${CANCEL_MINE}</div>`;\n    } else if (active) {\n      body = `<div class=\"timer-card other\"><div class=\"tc-label\">${esc(active.cleanerName)} started at ${fmtClock(active.startedAt)}</div>\n        <div class=\"tc-time\" ${active.endedAt ? '' : `data-since=\"${esc(active.startedAt)}\"`}>${fmtDur((active.endedAt ? Date.parse(active.endedAt) : Date.now()) - Date.parse(active.startedAt))}</div>\n        <div class=\"tc-step\">${active.status === 'in_progress' ? 'Cleaning now' : active.status === 'checklist' ? 'Doing final checks' : active.status === 'awaiting_key' ? 'Returning the key' : 'Uploading video'}</div>\n        ${can('manage_users') ? '<button class=\"linkbtn\" id=\"cancel-clean\">Cancel this cleaning</button>' : ''}</div>`;\n    } else if (can('do_cleaning')) {\n      body = `<button class=\"btn big primary\" id=\"begin-clean\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M8 5v14l11-7z\"/></svg>Begin cleaning</button>`;\n    }\n\n    const history = done.map((c) => `<div class=\"hist\">\n        <div class=\"hist-h\"><b>✓ Cleaned by ${esc(c.cleanerName)}</b><span>${c.date !== selected ? esc(`${WD_SHORT.format(D(c.date))} ${shortDate(c.date)}`) + ', ' : ''}${fmtClock(c.startedAt)}–${fmtClock(c.endedAt)} · ${durWords(Date.parse(c.endedAt) - Date.parse(c.startedAt))}</span></div>\n        <div class=\"hist-s\">Checklist confirmed ${c.checklist.length}/${checklistDef.length || 5}${keyNote(c)}${c.guesty === 'updated' ? ' · marked clean in Guesty' : c.guesty === 'failed' ? ' · <span class=\"warn\">Guesty not updated</span>' : ''}</div>\n        ${(can('view_cleaning') || c.cleanerId === me.id) ? mediaTiles(c.media) : ''}\n      </div>`).join('');\n\n    const t = [u.checkOut && `Out ${u.checkOut.time}`, u.checkIn && `In ${u.checkIn.time}`].filter(Boolean).join(' · ');\n    $('sheet-body').innerHTML = `\n      <div class=\"sh-head\"><div><h2>${esc(u.label)}</h2><div class=\"sh-sub\">${esc(u.building || '')}${t ? ' · ' + esc(t) : ''}</div></div><button class=\"btn sq\" data-close aria-label=\"Close\">✕</button></div>\n      ${assignBlock()}\n      ${body}\n      ${history ? `<h3 class=\"sh-h3\">${done.some((c) => c.date !== selected) ? 'Cleaned' : `Cleaned ${selected === (data && data.today) ? 'today' : esc(longDate(selected))}`}</h3>${history}` : ''}\n      <div id=\"sheet-damages\"></div>\n      ${can('report_damage') ? '<button class=\"btn wide\" id=\"report-damage\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\"/></svg>Report damage</button>' : ''}`;\n\n    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };\n    wireAssign();\n    on('begin-clean', async () => {\n      try { await send('POST', '/api/cleanings/start', { listingId: sheetListing }); toast('Cleaning started'); await refreshCleanings(); }\n      catch (e) { toast(e.message); refreshCleanings(); }\n    });\n    on('end-clean', async () => {\n      try { await send('POST', `/api/cleanings/${active.id}/end`); await refreshCleanings(); openChecklist(); }\n      catch (e) { toast(e.message); }\n    });\n    on('cancel-clean', () => confirmInline(active.status === 'in_progress' ? 'Cancel this cleaning? The timer will be discarded.' : 'Cancel this cleaning? Nothing from it will be recorded.', async () => {\n      try {\n        await send('POST', `/api/cleanings/${active.id}/cancel`);\n        // Stop anything still running for it: video uploads and the KeyNest check.\n        for (const [k, x] of uploads) if (x.ownerId === active.id) { x.cancelled = true; uploads.delete(k); }\n        releaseWake(); clearInterval(keyPoll); keyPoll = null;\n        toast('Cleaning cancelled'); await refreshCleanings();\n      } catch (e) { toast(e.message); }\n    }));\n    on('open-checklist', openChecklist);\n    on('report-damage', () => { sheetMode = 'damage'; renderSheet(); });\n    if (active && mine && active.status === 'awaiting_video') wireEvidence(active);\n    if (active && mine && active.status === 'awaiting_key') wireKey(active);\n    loadSheetDamages(sheetListing);\n  }\n\n  function confirmInline(text, yes) {\n    const box = document.createElement('div');\n    box.className = 'confirm-del';\n    box.innerHTML = `${esc(text)} <button class=\"btn danger\">Yes</button> <button class=\"btn\">No</button>`;\n    $('sheet-body').prepend(box);\n    const [y, n] = box.querySelectorAll('button');\n    y.onclick = () => { box.remove(); yes(); };\n    n.onclick = () => box.remove();\n  }\n\n  // ---------------- checklist: tap each item, then hold to confirm the summary ----------------\n  function openChecklist() {\n    const a = myActive();\n    if (!a || a.status !== 'checklist') return;\n    const ov = $('checklist');\n    ov.classList.remove('hidden');\n    const step = () => {\n      const cur = myActive();\n      const i = cur ? cur.checklist.length : checklistDef.length;\n      if (!cur || cur.status !== 'checklist') { ov.classList.add('hidden'); renderSheet(); return; }\n      const later = `<button class=\"linkbtn\" id=\"cl-later\">Not done yet — go back and check</button>`;\n      const dots = checklistDef.map((_, k) => `<i class=\"${k < i ? 'done' : k === i ? 'cur' : ''}\"></i>`).join('');\n      if (i >= checklistDef.length) {\n        // All items ticked: show the summary, confirmed by one press-and-hold.\n        const secs = Math.round(holdMs / 1000);\n        ov.innerHTML = `<div class=\"cl-card\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"cl-t\">\n          <div class=\"cl-top\"><span class=\"cl-count\">All checks</span><div class=\"cl-dots\">${dots}</div></div>\n          <h2 id=\"cl-t\">Final checks</h2>\n          <ul class=\"cl-sum\">${checklistDef.map((it) => `<li><span class=\"cl-tick\" aria-hidden=\"true\">✓</span><span>${esc(it.text)}</span></li>`).join('')}</ul>\n          <p class=\"cl-help\">Hold the button for ${secs} seconds to confirm everything above is done.</p>\n          <button class=\"hold\" id=\"hold-btn\"><span class=\"hold-fill\"></span><span class=\"hold-label\">Hold: All checks done</span></button>\n          ${later}\n        </div>`;\n        $('cl-later').onclick = () => { ov.classList.add('hidden'); };\n        wireHold($('hold-btn'), async (held) => {\n          try {\n            const r = await send('POST', `/api/cleanings/${cur.id}/checks-done`, { heldMs: held });\n            const idx = cleanings.findIndex((c) => c.id === cur.id); cleanings[idx] = { ...cleanings[idx], ...r.cleaning };\n            if (navigator.vibrate) navigator.vibrate(40);\n            step();\n          } catch (e) { toast(e.message); step(); }\n        });\n        return;\n      }\n      const item = checklistDef[i];\n      ov.innerHTML = `<div class=\"cl-card\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"cl-t\">\n        <div class=\"cl-top\"><span class=\"cl-count\">Check ${i + 1} of ${checklistDef.length}</span><div class=\"cl-dots\">${dots}</div></div>\n        <div class=\"cl-icon\">${CL_ICONS[item.key] || ''}</div>\n        <h2 id=\"cl-t\">${esc(item.title)}</h2>\n        <p class=\"cl-q\">${esc(item.text)}</p>\n        <p class=\"cl-help\">Read carefully, then tap the button.</p>\n        <button class=\"tapbtn\" id=\"tap-btn\">Yes, I have checked</button>\n        ${later}\n      </div>`;\n      $('cl-later').onclick = () => { ov.classList.add('hidden'); };\n      const tap = $('tap-btn');\n      tap.onclick = async () => {\n        if (tap.disabled) return;\n        tap.disabled = true;\n        try {\n          const r = await send('POST', `/api/cleanings/${cur.id}/confirm`, { key: item.key });\n          const idx = cleanings.findIndex((c) => c.id === cur.id); cleanings[idx] = { ...cleanings[idx], ...r.cleaning };\n          if (navigator.vibrate) navigator.vibrate(20);\n          step();\n        } catch (e) { toast(e.message); step(); }\n      };\n    };\n    step();\n  }\n  // Press-and-hold: the bar fills over holdMs; letting go early resets it.\n  function wireHold(btn, onDone) {\n    const fill = btn.querySelector('.hold-fill');\n    let start = 0, raf = 0, fired = false;\n    const tick = () => {\n      const p = Math.min(1, (performance.now() - start) / holdMs);\n      fill.style.transform = `scaleX(${p})`;\n      if (p >= 1 && !fired) { fired = true; btn.classList.add('ok'); btn.querySelector('.hold-label').textContent = 'Confirmed'; onDone(Math.round(performance.now() - start)); return; }\n      raf = requestAnimationFrame(tick);\n    };\n    const down = (e) => { if (fired) return; e.preventDefault(); start = performance.now(); btn.classList.add('holding'); raf = requestAnimationFrame(tick); try { btn.setPointerCapture(e.pointerId); } catch (_) {} };\n    const up = () => { if (fired) return; cancelAnimationFrame(raf); btn.classList.remove('holding'); fill.style.transition = 'transform .25s'; fill.style.transform = 'scaleX(0)'; setTimeout(() => { fill.style.transition = ''; }, 260); };\n    btn.addEventListener('pointerdown', down);\n    btn.addEventListener('pointerup', up);\n    btn.addEventListener('pointercancel', up);\n    btn.addEventListener('pointerleave', up);\n    btn.addEventListener('contextmenu', (e) => e.preventDefault());\n    // Keyboard: hold Space/Enter\n    btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e); });\n    btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(); });\n  }\n  const svg = (d) => `<svg viewBox=\"0 0 48 48\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\">${d}</svg>`;\n  const CL_ICONS = {\n    bins: svg('<path d=\"M10 14h28M18 14V9h12v5M13 14l2 26h18l2-26M21 21v12M27 21v12\"/>'),\n    fridge: svg('<rect x=\"13\" y=\"5\" width=\"22\" height=\"38\" rx=\"3\"/><path d=\"M13 19h22M18 10v4M18 24v6\"/>'),\n    oven: svg('<rect x=\"7\" y=\"8\" width=\"34\" height=\"32\" rx=\"3\"/><path d=\"M7 16h34M13 12h.01M19 12h.01\"/><rect x=\"13\" y=\"22\" width=\"22\" height=\"12\" rx=\"2\"/>'),\n    microwave: svg('<rect x=\"5\" y=\"11\" width=\"38\" height=\"26\" rx=\"3\"/><rect x=\"10\" y=\"16\" width=\"22\" height=\"16\" rx=\"2\"/><path d=\"M37 17v.01M37 23v.01M37 29v.01\"/>'),\n    hairs: svg('<path d=\"M12 40V14a8 8 0 0 1 16 0\"/><path d=\"M28 14h6M31 20l-1 4M35 20l1 4M33 20v4\"/><path d=\"M8 40h32\"/>'),\n  };\n\n  // ---------------- video (required) + photos (optional) ----------------\n  const uploads = new Map(); // key -> {file, kind, progress, id, done, error}\n  const uploadsBusy = () => [...uploads.values()].some((u) => !u.done && !u.error);\n  // ---------------- returning the key (Guesty tag LOCKBOX or KEYNEST) ----------------\n  function keyNote(c) {\n    if (!c.key) return '';\n    if (c.key.mode === 'lockbox') return can('view_cleaning') ? ` · key in lockbox, new code <b>${esc(c.key.code)}</b>` : ' · key returned to lockbox';\n    return ' · key handed in at KeyNest';\n  }\n  let keyPoll = null;\n  function keyStep(a) {\n    if (a.keyMode === 'lockbox') {\n      return `<div class=\"evidence keystep\">\n        <div class=\"ev-head\"><b>Last step: the key.</b> <span class=\"req\">Required</span></div>\n        <ol class=\"ks-steps\"><li>Put the key back in the lockbox.</li><li>Set a <b>new 4-digit code</b> on the lockbox and close it.</li><li>Enter the new code below.</li></ol>\n        <label class=\"ks-l\" for=\"ks-code\">New lockbox code</label>\n        <input class=\"ks-code\" id=\"ks-code\" inputmode=\"numeric\" pattern=\"[0-9]*\" maxlength=\"4\" autocomplete=\"off\" placeholder=\"••••\">\n        <label class=\"ks-l\" for=\"ks-code2\">Enter it again</label>\n        <input class=\"ks-code\" id=\"ks-code2\" inputmode=\"numeric\" pattern=\"[0-9]*\" maxlength=\"4\" autocomplete=\"off\" placeholder=\"••••\">\n        <label class=\"ks-check\"><input type=\"checkbox\" id=\"ks-back\"> The key is in the lockbox and the new code is set</label>\n        <p class=\"ks-msg\" id=\"ks-msg\"></p>\n        <button class=\"btn big primary\" id=\"ks-done\" disabled>Complete cleaning</button>\n      </div>`;\n    }\n    return `<div class=\"evidence keystep\">\n      <div class=\"ev-head\"><b>Last step: hand the key in at KeyNest.</b> <span class=\"req\">Required</span></div>\n      <p class=\"ev-note\">Drop the key off at the KeyNest store. As soon as KeyNest records it, you can complete the cleaning.</p>\n      <div class=\"kn-status\" id=\"kn-status\"><span class=\"kn-dot\"></span><span id=\"kn-text\">Checking KeyNest…</span></div>\n      <button class=\"btn wide\" id=\"kn-check\">Check again</button>\n      <button class=\"btn big primary\" id=\"ks-done\" disabled>Complete cleaning</button>\n    </div>`;\n  }\n  function wireKey(a) {\n    clearInterval(keyPoll); keyPoll = null;\n    const done = $('ks-done');\n    const finish = async (payload) => {\n      done.disabled = true;\n      try {\n        await send('POST', `/api/cleanings/${a.id}/key`, payload);\n        clearInterval(keyPoll); keyPoll = null;\n        if (navigator.vibrate) navigator.vibrate(40);\n        toast('Cleaning complete ✓');\n        await refreshCleanings();\n        if (sheetListing === a.listingId && sheetMode === 'main') closeSheet(); // not if they've since opened another flat\n      } catch (e) { toast(e.message); done.disabled = false; if (a.keyMode === 'keynest') check(); }\n    };\n    if (a.keyMode === 'lockbox') {\n      const c1 = $('ks-code'), c2 = $('ks-code2'), back = $('ks-back'), msg = $('ks-msg');\n      const update = () => {\n        for (const el of [c1, c2]) el.value = el.value.replace(/\\D/g, '').slice(0, 4);\n        const ok4 = /^\\d{4}$/.test(c1.value), same = c1.value === c2.value;\n        msg.textContent = c2.value.length === 4 && !same ? 'The two codes don’t match.' : '';\n        done.disabled = !(ok4 && same && back.checked);\n      };\n      c1.oninput = () => { update(); if (c1.value.length === 4) c2.focus(); };\n      c2.oninput = update; back.onchange = update;\n      done.onclick = () => finish({ code: c1.value, confirmCode: c2.value, keyReturned: back.checked });\n      return;\n    }\n    const box = $('kn-status'), text = $('kn-text');\n    const check = async () => {\n      if (!$('kn-status')) { clearInterval(keyPoll); keyPoll = null; return; }\n      try {\n        const r = await getJSON(`/api/cleanings/${a.id}/key-status`);\n        box.className = 'kn-status ' + (r.ok ? 'ok' : r.error ? 'err' : 'wait');\n        text.textContent = r.error ? r.error : r.ok ? `Key handed in ✓ (${r.status})` : `Waiting for drop-off · KeyNest shows: ${r.status}`;\n        done.disabled = !r.ok;\n      } catch (e) { box.className = 'kn-status err'; text.textContent = e.message; done.disabled = true; }\n    };\n    $('kn-check').onclick = check;\n    done.onclick = () => finish({});\n    check();\n    keyPoll = setInterval(check, 20000);\n  }\n\n  // Safari's own camera (\"Take Video\") records at about 480×360, whatever the iPhone's settings, and the\n  // Photo Library may re-encode. Filming in the Camera app and choosing the file from Files keeps full 4K.\n  const videoTip = (button) => `<details class=\"ev-tip\"><summary>How to upload in full 4K quality</summary><ol>\n      <li>Film in the <b>Camera</b> app (Settings › Camera › Record Video: 4K at 30 fps).</li>\n      <li>In <b>Photos</b>, open the video, tap <b>Share</b> › <b>Save to Files</b>.</li>\n      <li>Here, tap <b>${button}</b> › <b>Choose File</b> and pick it.</li>\n    </ol><p>Avoid <b>Take Video</b> (very low quality) and <b>Photo Library</b> (may lower the quality).</p></details>`;\n  const isLowQuality = (i) => Boolean(i && i.width && i.height && Math.max(i.width, i.height) < 1920);\n  const lowQualityNote = (i) => `<span class=\"up-warn\">Low quality (${i.width}×${i.height}). Please upload the original from Files for full quality.</span>`;\n  function evidenceStep(a) {\n    return `<div class=\"evidence\">\n      <div class=\"ev-head\"><b>Almost done.</b> Record a video walking through the flat. <span class=\"req\">Video required</span></div>\n      <div class=\"ev-btns\">\n        <label class=\"btn big primary file\"><input type=\"file\" accept=\"video/*\" id=\"ev-pick\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M23 7l-7 5 7 5V7z\"/><rect x=\"1\" y=\"5\" width=\"15\" height=\"14\" rx=\"2\"/></svg>Upload walkthrough video</label>\n        <label class=\"btn file\"><input type=\"file\" accept=\"image/*\" multiple id=\"ev-photos\">Add photos (optional)</label>\n      </div>\n      ${videoTip('Upload walkthrough video')}\n      <p class=\"ev-note\">A video is needed to finish. Keep this screen open until uploads finish.</p>\n      <div id=\"ev-list\"></div>\n      <button class=\"btn big primary\" id=\"ev-finish\" disabled>Finish cleaning</button>\n    </div>`;\n  }\n  function wireEvidence(a) {\n    const add = (files, kindHint) => {\n      for (const f of files) {\n        const kind = (f.type || '').startsWith('video') || kindHint === 'video' && !(f.type || '').startsWith('image') ? 'video' : 'photo';\n        const key = Math.random().toString(36).slice(2);\n        uploads.set(key, { file: f, kind, progress: 0, id: null, done: false, error: null, ownerId: a.id, purpose: 'cleaning' });\n        runUpload(key);\n      }\n      drawUploads(a);\n    };\n    $('ev-pick').onchange = (e) => add(e.target.files, 'video');\n    $('ev-photos').onchange = (e) => add(e.target.files, 'photo');\n    $('ev-finish').onclick = async () => {\n      const mineUp = [...uploads.values()].filter((u) => u.ownerId === a.id && u.done);\n      try {\n        const r = await send('POST', `/api/cleanings/${a.id}/complete`, { videoIds: mineUp.filter((u) => u.kind === 'video').map((u) => u.id), photoIds: mineUp.filter((u) => u.kind === 'photo').map((u) => u.id) });\n        for (const [k, u] of uploads) if (u.ownerId === a.id) uploads.delete(k);\n        releaseWake();\n        const finished = !(r.cleaning && r.cleaning.status === 'awaiting_key');\n        toast(finished ? 'Cleaning complete ✓' : 'Video saved ✓ Now return the key');\n        await refreshCleanings();\n        if (finished && sheetListing === a.listingId && sheetMode === 'main') closeSheet();\n      } catch (e) { toast(e.message); }\n    };\n    drawUploads(a);\n  }\n  function drawUploads(a) {\n    const list = $('ev-list');\n    if (!list) return;\n    const mine = [...uploads.entries()].filter(([, u]) => u.ownerId === a.id);\n    list.innerHTML = mine.map(([k, u]) => `<div class=\"up ${u.error ? 'err' : u.done ? 'ok' : ''}\" data-up=\"${k}\">\n      <span class=\"up-k\">${u.kind === 'video' ? 'Video' : 'Photo'}</span><span class=\"up-n\">${esc(u.file.name || u.kind)} · ${(u.file.size / 1e6).toFixed(u.file.size > 1e7 ? 0 : 1)} MB</span>\n      <span class=\"up-s\">${u.error ? esc(u.error) : u.done ? 'Uploaded ✓' : u.waiting ? 'Waiting for signal…' : Math.floor(u.progress * 100) + '%'}</span>\n      <span class=\"up-bar\"><i style=\"transform:scaleX(${u.done ? 1 : u.progress})\"></i></span>\n      ${u.kind === 'video' && isLowQuality(u.info) ? lowQualityNote(u.info) : ''}</div>`).join('');\n    const hasVideo = mine.some(([, u]) => u.kind === 'video' && u.done);\n    const busy = mine.some(([, u]) => !u.done && !u.error);\n    const btn = $('ev-finish');\n    btn.disabled = !hasVideo || busy;\n    const next = a.keyMode ? 'Next: return the key' : 'Finish cleaning';\n    btn.textContent = busy ? 'Uploading…' : hasVideo ? next : `${next} (video needed)`;\n  }\n\n  let wakeLock = null;\n  async function holdWake() { try { if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {} }\n  function releaseWake() { if (!uploadsBusy() && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }\n\n  // Uploads in progress, remembered on this phone so picking the same file again after the page reloads\n  // carries on where it stopped instead of starting a large video from zero. The server drops them after 3 days.\n  const savedUploads = () => { let s = {}; try { s = JSON.parse(store.get('cs_uploads') || '{}') || {}; } catch (_) {} for (const k of Object.keys(s)) if (!(Date.now() - s[k].at < 3 * 864e5)) delete s[k]; return s; };\n  const rememberUpload = (k, id) => { const s = savedUploads(); if (id) s[k] = { id, at: Date.now() }; else delete s[k]; store.set('cs_uploads', JSON.stringify(s)); };\n\n  // Resumable upload in 8 MB pieces; carries on after signal drops.\n  async function runUpload(key, redraw) {\n    const u = uploads.get(key);\n    const draw = () => { if (redraw) redraw(); else { const a = myActive(); if (a) drawUploads(a); } };\n    const rkey = [u.purpose, u.ownerId || u.listingId, u.file.name, u.file.size, u.file.lastModified || 0].join('|');\n    holdWake();\n    try {\n      let CH = 8 * 1024 * 1024, received = 0, fails = 0;\n      const saved = savedUploads()[rkey];\n      if (saved && ![...uploads.values()].some((x) => x !== u && x.id === saved.id)) {\n        // Only start again from zero if the server says the earlier upload is gone; a bad signal just means retry.\n        for (let t = 0; ; t++) {\n          let r = null;\n          try { r = await fetch('/api/media/' + saved.id, { credentials: 'same-origin' }); } catch (_) {}\n          if (r && r.status === 401) { location.href = '/login'; throw new Error('signed out'); }\n          if (r && (r.status === 404 || r.status === 403)) break;\n          const s = r && r.ok ? await r.json().catch(() => null) : null;\n          if (s) { if (s.byMe && s.size === u.file.size) { u.id = s.id; received = s.uploaded ? u.file.size : s.received; u.info = s.info; } break; }\n          u.waiting = true; draw();\n          await new Promise((ok) => setTimeout(ok, Math.min(30000, 1000 * 2 ** Math.min(t + 1, 5))));\n        }\n        u.waiting = false;\n      }\n      if (!u.id) {\n        const start = await send('POST', '/api/media', { kind: u.kind, purpose: u.purpose, ownerId: u.ownerId, listingId: u.listingId, name: u.file.name, size: u.file.size, type: u.file.type });\n        u.id = start.id; CH = start.chunk || CH; received = start.received || 0;\n        rememberUpload(rkey, u.id);\n      }\n      u.progress = received / u.file.size; draw();\n      while (received < u.file.size) {\n        if (u.cancelled) throw new Error('Cancelled');\n        const end = Math.min(u.file.size, received + CH);\n        const r = await putChunk(u.id, received, u.file.slice(received, end), (loaded) => { u.progress = (received + loaded) / u.file.size; draw(); });\n        if (r.ok) { received = r.received; if (r.info) u.info = r.info; fails = 0; u.waiting = false; u.progress = received / u.file.size; draw(); continue; }\n        if (r.status === 409 && typeof r.received === 'number') {\n          if (r.received === received) await new Promise((ok) => setTimeout(ok, 1000)); // previous piece still being written\n          received = r.received; continue;\n        }\n        if (r.status === 401 || r.status === 403) throw new Error('Upload not allowed — sign in again');\n        if (r.status === 404) { rememberUpload(rkey, null); throw new Error('Upload expired — please choose the video again'); }\n        if (r.status === 507) throw new Error('The server is out of space — please tell an admin');\n        fails++; u.waiting = true; draw();\n        await new Promise((ok) => setTimeout(ok, Math.min(30000, 1000 * 2 ** Math.min(fails, 5))));\n        try { const s = await getJSON('/api/media/' + u.id); received = s.uploaded ? u.file.size : s.received; if (s.info) u.info = s.info; } catch (_) {}\n      }\n      u.done = true; u.progress = 1;\n      rememberUpload(rkey, null);\n    } catch (e) { u.error = e.message || 'Upload failed'; }\n    draw();\n    releaseWake();\n  }\n  function putChunk(id, offset, blob, onProgress) {\n    return new Promise((resolve) => {\n      const x = new XMLHttpRequest();\n      x.open('PUT', `/api/media/${id}?offset=${offset}`);\n      x.setRequestHeader('Content-Type', 'application/octet-stream');\n      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };\n      x.onload = () => { let b = {}; try { b = JSON.parse(x.responseText); } catch (_) {} resolve({ ok: x.status === 200, status: x.status, received: b.received, info: b.info }); };\n      x.onerror = () => resolve({ ok: false, status: 0 });\n      x.ontimeout = () => resolve({ ok: false, status: 0 });\n      x.timeout = 280000; // slow mobile signal; the server allows up to 5 minutes per piece\n      x.send(blob);\n    });\n  }\n  window.addEventListener('beforeunload', (e) => { if (uploadsBusy()) { e.preventDefault(); e.returnValue = ''; } });\n\n  // ---------------- damage reports ----------------\n  function renderDamageForm(u) {\n    $('sheet-body').innerHTML = `\n      <div class=\"sh-head\"><div><h2>Report damage</h2><div class=\"sh-sub\">${esc(u.label)} · ${esc(u.building || '')}</div></div><button class=\"btn sq\" id=\"dmg-back\" aria-label=\"Back\">←</button></div>\n      <form id=\"dmg-form\" class=\"dmg-form\">\n        <label for=\"dmg-what\">What is damaged?</label>\n        <textarea id=\"dmg-what\" rows=\"3\" required placeholder=\"e.g. Crack in the bathroom mirror, stain on the sofa\"></textarea>\n        <label for=\"dmg-where\">Where in the flat? <span class=\"muted\">(optional)</span></label>\n        <input id=\"dmg-where\" type=\"text\" placeholder=\"e.g. Bathroom, living room\">\n        <label>Evidence <span class=\"req\">Video or photo required</span></label>\n        <div class=\"ev-btns\">\n          <label class=\"btn primary file\"><input type=\"file\" accept=\"video/*\" id=\"dmg-rec\">Upload video</label>\n          <label class=\"btn file\"><input type=\"file\" accept=\"image/*\" capture=\"environment\" id=\"dmg-cam\">Take photo</label>\n          <label class=\"btn file\"><input type=\"file\" accept=\"video/*,image/*\" multiple id=\"dmg-pick\">Choose files</label>\n        </div>\n        ${videoTip('Upload video')}\n        <div id=\"dmg-list\"></div>\n        <div class=\"form-msg\" id=\"dmg-msg\"></div>\n        <button class=\"btn big primary\" type=\"submit\" id=\"dmg-send\" disabled>Send report</button>\n      </form>`;\n    const listingId = sheetListing;\n    const keys = [];\n    const draw = () => {\n      $('dmg-list') && ($('dmg-list').innerHTML = keys.map((k) => { const x = uploads.get(k); return `<div class=\"up ${x.error ? 'err' : x.done ? 'ok' : ''}\"><span class=\"up-k\">${x.kind === 'video' ? 'Video' : 'Photo'}</span><span class=\"up-n\">${esc(x.file.name || x.kind)}</span><span class=\"up-s\">${x.error ? esc(x.error) : x.done ? 'Uploaded ✓' : x.waiting ? 'Waiting for signal…' : Math.floor(x.progress * 100) + '%'}</span><span class=\"up-bar\"><i style=\"transform:scaleX(${x.done ? 1 : x.progress})\"></i></span>${x.kind === 'video' && isLowQuality(x.info) ? lowQualityNote(x.info) : ''}</div>`; }).join(''));\n      const ok = keys.some((k) => uploads.get(k).done), busy = keys.some((k) => { const x = uploads.get(k); return !x.done && !x.error; });\n      if ($('dmg-send')) { $('dmg-send').disabled = !ok || busy; $('dmg-send').textContent = busy ? 'Uploading…' : 'Send report'; }\n    };\n    const add = (files) => { for (const f of files) { const key = Math.random().toString(36).slice(2); uploads.set(key, { file: f, kind: (f.type || '').startsWith('image') ? 'photo' : 'video', progress: 0, done: false, error: null, purpose: 'damage', listingId }); keys.push(key); runUpload(key, draw); } draw(); };\n    $('dmg-rec').onchange = (e) => add(e.target.files);\n    $('dmg-cam').onchange = (e) => add(e.target.files);\n    $('dmg-pick').onchange = (e) => add(e.target.files);\n    $('dmg-back').onclick = () => { if (keys.some((k) => !uploads.get(k).done && !uploads.get(k).error)) return toast('Wait for the upload to finish'); sheetMode = 'main'; renderSheet(); };\n    $('dmg-form').onsubmit = async (e) => {\n      e.preventDefault();\n      const a = myActive();\n      try {\n        await send('POST', '/api/damages', { listingId, description: $('dmg-what').value, location: $('dmg-where').value, mediaIds: keys.map((k) => uploads.get(k)).filter((x) => x.done).map((x) => x.id), cleaningId: a && a.listingId === listingId ? a.id : null });\n        keys.forEach((k) => uploads.delete(k));\n        toast('Damage reported — thank you');\n        sheetMode = 'main'; renderSheet();\n      } catch (err) { $('dmg-msg').className = 'form-msg err'; $('dmg-msg').textContent = err.message; }\n    };\n  }\n  async function loadSheetDamages(listingId) {\n    if (!(can('view_cleaning') || can('manage_damage') || can('report_damage'))) return;\n    try {\n      const r = await getJSON('/api/damages?status=open&listingId=' + encodeURIComponent(listingId));\n      const box = $('sheet-damages');\n      if (!box || sheetListing !== listingId) return;\n      box.innerHTML = r.damages.length ? `<h3 class=\"sh-h3\">Open damage reports</h3>${r.damages.map(damageCard).join('')}` : '';\n      wireDamageCards(box, () => loadSheetDamages(listingId));\n    } catch (_) {}\n  }\n  function damageCard(d) {\n    return `<div class=\"dmg ${d.status}\">\n      <div class=\"hist-h\"><b>${esc(d.label)} · ${esc(d.location || 'Damage')}</b><span>${new Date(d.reportedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} · ${esc(d.reporterName)}</span></div>\n      <p class=\"dmg-desc\">${esc(d.description)}</p>\n      ${mediaTiles(d.media)}\n      ${d.status === 'resolved' ? `<div class=\"hist-s\">Resolved by ${esc(d.resolvedBy || '')}${d.note ? ' — ' + esc(d.note) : ''}</div>` : ''}\n      ${can('manage_damage') ? `<div class=\"form-actions\"><button class=\"btn\" data-dmg=\"${d.id}\" data-to=\"${d.status === 'resolved' ? 'open' : 'resolved'}\">${d.status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button></div>` : ''}\n    </div>`;\n  }\n  function wireDamageCards(root, after) {\n    root.querySelectorAll('[data-dmg]').forEach((b) => b.onclick = async () => {\n      try { await send('PUT', '/api/damages/' + b.dataset.dmg, { status: b.dataset.to }); toast(b.dataset.to === 'resolved' ? 'Marked resolved' : 'Reopened'); after(); } catch (e) { toast(e.message); }\n    });\n  }\n\n  // ---------------- Cleaning tab (admins, supervisors, users) ----------------\n  let cvDate = null;\n  async function loadCleaningView() {\n    cvDate = cvDate || (data && data.today) || new Date().toISOString().slice(0, 10);\n    $('cv-date').value = cvDate;\n    try {\n      const [c, d] = await Promise.all([getJSON('/api/cleanings?date=' + cvDate), getJSON('/api/damages')]);\n      const cls = c.cleanings.filter((x) => x.status !== 'cancelled' && x.date === cvDate);\n      const active = cls.filter((x) => ACTIVE.includes(x.status));\n      const done = cls.filter((x) => x.status === 'completed');\n      const totalMin = done.reduce((s, x) => s + (Date.parse(x.endedAt) - Date.parse(x.startedAt)), 0);\n      $('cv-summary').innerHTML = `<div class=\"metric\"><div class=\"k\">In progress</div><div class=\"v\">${active.length}</div></div>\n        <div class=\"metric\"><div class=\"k\">Completed</div><div class=\"v\">${done.length}</div></div>\n        <div class=\"metric\"><div class=\"k\">Average time</div><div class=\"v\">${done.length ? durWords(totalMin / done.length) : '–'}</div></div>\n        <div class=\"metric\"><div class=\"k\">Open damage</div><div class=\"v\">${d.damages.filter((x) => x.status === 'open').length}</div></div>`;\n      $('cv-list').innerHTML = cls.length ? cls.map((x) => `<div class=\"card cv-item\">\n          <div class=\"hist-h\"><b>${esc(x.label)} <span class=\"muted\">· ${esc(x.building)}</span></b>\n            <span class=\"${ACTIVE.includes(x.status) ? 'cb running' : 'cb done'}\">${ACTIVE.includes(x.status) ? `<i></i>${x.status === 'in_progress' ? 'Cleaning' : x.status === 'checklist' ? 'Final checks' : x.status === 'awaiting_key' ? 'Returning key' : 'Uploading video'}` : '✓ Completed'}</span></div>\n          <div class=\"cv-meta\"><span>${esc(x.cleanerName)}</span><span>Start ${fmtClock(x.startedAt)}</span><span>End ${x.endedAt ? fmtClock(x.endedAt) : '—'}</span>\n            <span>Time <b ${x.endedAt ? '' : `data-since=\"${esc(x.startedAt)}\"`}>${fmtDur((x.endedAt ? Date.parse(x.endedAt) : Date.now()) - Date.parse(x.startedAt))}</b></span>\n            ${x.status === 'completed' ? `<span>Checks ${x.checklist.length}/${c.checklist.length}</span>` : ''}\n            ${x.key && x.key.mode === 'lockbox' ? `<span>Lockbox code <b>${esc(x.key.code)}</b></span>` : x.key && x.key.mode === 'keynest' ? '<span>Key at KeyNest ✓</span>' : ''}\n            ${x.guesty === 'updated' ? '<span>Guesty ✓</span>' : x.guesty === 'failed' ? '<span class=\"warn\">Guesty not updated</span>' : ''}</div>\n          ${mediaTiles(x.media)}\n        </div>`).join('') : '<div class=\"card empty\"><b>No cleanings recorded</b>Nothing was started on this day.</div>';\n      const open = d.damages.filter((x) => x.status === 'open'), resolved = d.damages.filter((x) => x.status === 'resolved').slice(0, 10);\n      $('cv-damages').innerHTML = (open.length ? open.map(damageCard).join('') : '<div class=\"card empty\"><b>No open damage reports</b></div>') +\n        (resolved.length ? `<h3 class=\"sh-h3\">Recently resolved</h3>${resolved.map(damageCard).join('')}` : '');\n      wireDamageCards($('cv-damages'), loadCleaningView);\n    } catch (e) { if (e.message !== 'signed out') $('cv-list').innerHTML = `<div class=\"banner error\">${esc(e.message)}</div>`; }\n  }\n  $('cv-date').onchange = (e) => { cvDate = e.target.value; loadCleaningView(); };\n  $('cv-prev').onclick = () => { const d = new Date(cvDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); cvDate = d.toISOString().slice(0, 10); loadCleaningView(); };\n  $('cv-next').onclick = () => { const d = new Date(cvDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); cvDate = d.toISOString().slice(0, 10); loadCleaningView(); };\n\n  // =====================================================================\n  // Notifications: bell with unread count + list, and phone notifications (Web Push)\n  // =====================================================================\n  let notifs = { items: [], unread: 0 };\n  const ago = (iso) => {\n    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);\n    if (m < 1) return 'just now';\n    if (m < 60) return `${m} min ago`;\n    if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;\n    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });\n  };\n  const NICON = { cleaned: '✓', damage: '!', assigned: '→', unassigned: '×' };\n  async function loadNotifs() {\n    if (!me) return;\n    try {\n      notifs = await getJSON('/api/notifications');\n      const n = $('bell-n');\n      n.textContent = notifs.unread > 9 ? '9+' : String(notifs.unread);\n      n.classList.toggle('hidden', !notifs.unread);\n      $('bell').setAttribute('aria-label', notifs.unread ? `Notifications, ${notifs.unread} unread` : 'Notifications');\n      try { if (navigator.setAppBadge) notifs.unread ? navigator.setAppBadge(notifs.unread) : navigator.clearAppBadge(); } catch (_) {}\n      if (!$('notif').classList.contains('hidden')) renderNotifs();\n    } catch (_) { /* try again next tick */ }\n  }\n  function renderNotifs() {\n    const p = pushState();\n    $('notif').innerHTML = `<div class=\"notif-card\" role=\"dialog\" aria-label=\"Notifications\">\n      <div class=\"notif-head\"><h3>Notifications</h3>${notifs.unread ? '<button class=\"linkbtn inline\" id=\"nf-all\">Mark all as read</button>' : ''}<button class=\"btn sq\" id=\"nf-close\" aria-label=\"Close\">✕</button></div>\n      <div class=\"notif-push ${p.state}\">${p.html}</div>\n      <div class=\"notif-list\">${notifs.items.length ? notifs.items.map((x) => `<button class=\"nitem ${x.read ? '' : 'unread'} t-${esc(x.type)}\" data-nid=\"${esc(x.id)}\" data-url=\"${esc(x.url)}\">\n          <span class=\"nico\">${NICON[x.type] || '•'}</span><span class=\"ntext\"><b>${esc(x.title)}</b><span>${esc(x.body)}</span><em>${esc(ago(x.at))}</em></span></button>`).join('')\n        : '<div class=\"empty\"><b>No notifications yet</b>You’ll see completed cleanings, damage reports and assignments here.</div>'}</div></div>`;\n    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };\n    on('nf-close', closeNotifs);\n    on('nf-all', async () => { try { await send('POST', '/api/notifications/read', { all: true }); } catch (_) {} loadNotifs(); });\n    on('np-on', enablePush);\n    on('np-off', disablePush);\n    on('np-test', async () => { try { await send('POST', '/api/push/test'); toast('Test sent — check your phone'); } catch (e) { toast(e.message); } });\n    $('notif').querySelectorAll('[data-nid]').forEach((b) => b.onclick = async () => {\n      closeNotifs();\n      send('POST', '/api/notifications/read', { ids: [b.dataset.nid] }).then(loadNotifs).catch(() => {});\n      openLink(b.dataset.url);\n    });\n  }\n  function openNotifs() { $('notif').classList.remove('hidden'); renderNotifs(); loadNotifs(); }\n  function closeNotifs() { $('notif').classList.add('hidden'); }\n  $('bell').onclick = () => ($('notif').classList.contains('hidden') ? openNotifs() : closeNotifs());\n  $('notif').addEventListener('click', (e) => { if (e.target.id === 'notif') closeNotifs(); });\n  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNotifs(); });\n  setInterval(() => { if (!document.hidden) loadNotifs(); }, 30000);\n  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNotifs(); });\n\n  // Opens the place a notification points to: ?view=day&date=…&flat=… or ?view=cleaning&date=…\n  async function openLink(href) {\n    let q; try { q = new URL(href, location.origin).searchParams; } catch (_) { return; }\n    const v = q.get('view'), date = q.get('date'), flat = q.get('flat');\n    const okDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(date || '');\n    if (v === 'cleaning' && allowed('cleaning')) { if (okDate) cvDate = date; if (view === 'cleaning') loadCleaningView(); else setView('cleaning'); return; }\n    if (v === 'day' && allowed('day')) {\n      if (view !== 'day') setView('day');\n      if (okDate && (!data || !data.dates.includes(date))) await showWeek(date);\n      if (okDate && data && data.dates.includes(date)) { selected = date; renderStrip(); renderDay(); }\n      if (flat) { if (unitFor(flat)) openSheet(flat); else toast('That flat isn’t on the schedule for this day any more'); }\n    }\n  }\n\n  // ---- phone notifications ----\n  const b64uToBytes = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };\n  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);\n  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;\n  let pushOn = false;\n  function pushState() {\n    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;\n    if (!supported && isIOS && !standalone) return { state: 'setup', html: `<b>Phone notifications</b><span>On iPhone, first add this app to your Home Screen: tap <b>Share</b> › <b>Add to Home Screen</b>, then open it from there and turn notifications on.</span>` };\n    if (!supported) return { state: 'off', html: '<b>Phone notifications</b><span>This browser can’t show notifications.</span>' };\n    if (Notification.permission === 'denied') return { state: 'off', html: '<b>Phone notifications are blocked</b><span>Allow notifications for this app in your phone’s Settings, then come back here.</span>' };\n    if (pushOn) return { state: 'on', html: '<b>Phone notifications are on</b><span>You’ll get alerts even when the app is closed.</span><span class=\"np-btns\"><button class=\"linkbtn inline\" id=\"np-test\">Send a test</button><button class=\"linkbtn inline\" id=\"np-off\">Turn off</button></span>' };\n    return { state: 'offer', html: '<b>Get alerts on this phone</b><span>Even when the app is closed.</span><button class=\"btn primary\" id=\"np-on\">Turn on</button>' };\n  }\n  async function initPush() {\n    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;\n    try {\n      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });\n      navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') { openLink(e.data.url); loadNotifs(); } });\n      const sub = await reg.pushManager.getSubscription();\n      pushOn = Boolean(sub) && Notification.permission === 'granted';\n      // Tell the server this phone belongs to whoever is signed in now (a shared phone may change hands).\n      if (pushOn) await send('POST', '/api/push/subscribe', { subscription: sub.toJSON() });\n    } catch (_) { /* notifications stay off */ }\n  }\n  async function enablePush() {\n    try {\n      const perm = await Notification.requestPermission();\n      if (perm !== 'granted') { toast('Notifications weren’t allowed'); renderNotifs(); return; }\n      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });\n      await navigator.serviceWorker.ready;\n      const { publicKey } = await getJSON('/api/push/key');\n      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });\n      await send('POST', '/api/push/subscribe', { subscription: sub.toJSON() });\n      pushOn = true; renderNotifs();\n      send('POST', '/api/push/test').catch(() => {});\n      toast('Phone notifications on ✓');\n    } catch (e) { toast('Couldn’t turn on notifications: ' + (e.message || 'unknown error')); }\n  }\n  // Signing out: this phone stops getting the person's notifications (it may be a shared or borrowed phone).\n  document.addEventListener('click', async (e) => {\n    const a = e.target.closest('a[href=\"/logout\"]');\n    if (!a || !('serviceWorker' in navigator)) return;\n    e.preventDefault();\n    try {\n      const reg = await navigator.serviceWorker.getRegistration('/');\n      const sub = reg && await reg.pushManager.getSubscription();\n      if (sub) { await send('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }\n    } catch (_) {}\n    location.href = '/logout';\n  });\n  async function disablePush() {\n    try {\n      const reg = await navigator.serviceWorker.getRegistration('/');\n      const sub = reg && await reg.pushManager.getSubscription();\n      if (sub) { await send('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }\n    } catch (_) {}\n    pushOn = false; renderNotifs(); toast('Phone notifications off');\n  }\n\n})();\n" },
  "favicon.svg": { type: "image/svg+xml", hash: "1406uff", body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"18.5 20 64.1 60\"><path fill=\"#06402a\" d=\"M18.5 41.3 39.3 20H61v21.3H39.3V80H18.5zM61 41.3h21.6v14.5L61 80z\"/></svg>" },
  "sw.js": { type: "text/javascript; charset=utf-8", hash: "fvuwgy", body: "// Shows Cityscape Schedule notifications on the phone, and opens the app at the right place when one is tapped.\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\n\nself.addEventListener('push', (e) => {\n  let d = {};\n  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Cityscape', body: e.data ? e.data.text() : '' }; }\n  e.waitUntil(self.registration.showNotification(d.title || 'Cityscape Schedule', {\n    body: d.body || '', icon: '/icon-192.png', tag: d.tag || undefined, renotify: Boolean(d.tag), data: { url: d.url || '/' },\n  }));\n});\n\nself.addEventListener('notificationclick', (e) => {\n  e.notification.close();\n  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;\n  e.waitUntil((async () => {\n    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });\n    for (const w of wins) {\n      if (new URL(w.url).origin !== self.location.origin) continue;\n      await w.focus();\n      w.postMessage({ type: 'open', url });\n      return;\n    }\n    await self.clients.openWindow(url);\n  })());\n});\n" },
  "manifest.webmanifest": { type: "application/manifest+json", hash: "4yvdj7", body: "{ \"name\": \"Cityscape Schedule\", \"short_name\": \"Schedule\", \"start_url\": \"/\", \"display\": \"standalone\", \"background_color\": \"#f8f9f8\", \"theme_color\": \"#1c6b52\", \"icons\": [{ \"src\": \"/icon-192.png\", \"sizes\": \"192x192\", \"type\": \"image/png\" }, { \"src\": \"/icon-512.png\", \"sizes\": \"512x512\", \"type\": \"image/png\" }, { \"src\": \"/favicon.svg\", \"sizes\": \"any\", \"type\": \"image/svg+xml\" }] }\n" },
  "favicon.png": { type: "image/png", hash: "wm9f9x", body: "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", b64: true },
  "apple-touch-icon.png": { type: "image/png", hash: "nvyxmg", body: "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", b64: true },
  "icon-192.png": { type: "image/png", hash: "xwe0l2", body: "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", b64: true },
  "icon-512.png": { type: "image/png", hash: "6sw0e6", body: "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fPmVm97bnf6Rn/rSIwIwb/1xU2UvYbjFSVJclsZxfPKJJ61fu67s5YyC7vZO8eu5Z551Ue28czZu6j5evMDyg196QgDmPbVjX9lLGG7FnOq+If30DRs3vnFbAjvUi9Gd8sVz+N5Tz5oYH4865/omHWUvjREhAPM+tP/espcAh1dMf6e70A8CAEPAsY70gwDM88aVXjGqYFgIwDz7qkBoBAAgUAIAECgBAAiUAAAESgAAAiUAAIESAIBACQBAoAQAIFACABAoAQAIlAAABEoAAAIlAACBEgCAQAkAQKAEACBQAgAQKAEACJQAAARKAAACJQAAgRIAgEAJAECgBAAgUAIAECgBAAiUAAAESgAAAiUAAIESAIBACQBAoAQAIFACABAoAQAIlAAABEoAAAIlAACBEgCAQAkAQKAEACBQAgAQKAEACJQAAARKAAACJQAAgRIAgEAJAECgBAAgUAIAECgBAAiUAAAESgAAAiUAAIESAIBACQBAoAQAIFACABAoAQAIlAAABEoAAAIlAACBEgCAQAkAQKAEACBQAgAQKAEACJQAAARKAAACJQAAgRIAgEAJAECgBAAgUAIAECgBAAiUAAAESgAAAiUAAIESAIBACQBAoAQAIFACABAoAQAIlAAABEoAAAIlAACBEgCAQAkAQKAEACBQAgAQKAEACJQAAARKAAACJQAAgRIAgEAJAECgBAAgUAIAECgBAAiUAAAESgAAAiUAAIH6/99JkAOkr7gWAAAAAElFTkSuQmCC", b64: true },
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
    listings: () => UNITS.map(([_id, nickname, full, street, bedrooms]) => ({ _id, nickname, title: nickname, bedrooms, active: true, tags: _id === 'm4' ? ['LOCKBOX'] : _id === 'm5' ? ['KEYNEST'] : [], address: { full, street, zipcode: full.split(', ').pop() }, defaultCheckInTime: '15:00', defaultCheckOutTime: '10:00' })),
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
  if (a.b64 && !a.bytes) a.bytes = Uint8Array.from(atob(a.body), (c) => c.charCodeAt(0)); // images: decoded once
  return new Response(a.b64 ? a.bytes : a.body, { headers });
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
  ['do_cleaning', 'Begin & end cleanings'],
  ['view_cleaning', 'See cleaning times & videos'],
  ['report_damage', 'Report damage'],
  ['manage_damage', 'Resolve damage reports'],
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
// Permissions added later fall back to the role's defaults until an admin changes them.
function effectivePerms(u) {
  const d = roleDefaults(u.role).perms;
  return Object.fromEntries(PERMS.map(([k]) => [k, u.perms && k in u.perms ? Boolean(u.perms[k]) : d[k]]));
}
function publicUser(u) {
  const { pw, ...rest } = u;
  return { ...rest, perms: effectivePerms(u) };
}
const can = (u, perm) => Boolean(u && effectivePerms(u)[perm]);

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
let tokenPromise = null; // one token request at a time, even when several Guesty calls start together
function getToken(env) {
  if (memToken && memToken.expires_at > Date.now() + 5 * 60e3) return Promise.resolve(memToken.access_token);
  if (!tokenPromise) tokenPromise = fetchToken(env).finally(() => { tokenPromise = null; });
  return tokenPromise;
}
async function fetchToken(env) {
  if (memToken && memToken.expires_at > Date.now() + 5 * 60e3) return memToken.access_token;
  const stored = await env.STORE.get('guesty_token', 'json');
  if (stored && stored.client_id === env.GUESTY_CLIENT_ID && stored.expires_at > Date.now() + 5 * 60e3) { memToken = stored; return stored.access_token; }
  const r = await fetch(`${GUESTY}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'open-api', client_id: env.GUESTY_CLIENT_ID, client_secret: env.GUESTY_CLIENT_SECRET }),
  });
  if (r.status === 429) throw userError('Guesty’s daily login limit has been reached (5 per day). The schedule will load again once it resets.');
  if (!r.ok) throw userError(`Guesty didn’t accept the API keys (error ${r.status}). Check GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET in Railway.`);
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
const LISTING_FIELDS = '_id nickname title bedrooms address.full address.street address.zipcode active defaultCheckInTime defaultCheckOutTime tags';
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
  return { _id: l._id, nickname: l.nickname, title: l.title, bedrooms: l.bedrooms, active: l.active, address: { full: l.address?.full, street: l.address?.street, zipcode: l.address?.zipcode }, defaultCheckInTime: l.defaultCheckInTime, defaultCheckOutTime: l.defaultCheckOutTime, tags: Array.isArray(l.tags) ? l.tags : [] };
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
    // Guesty tags decide how the key is returned after a cleaning.
    const tags = (Array.isArray(l.tags) ? l.tags : []).map((t) => String(t).trim().toUpperCase().replace(/[\s_-]+/g, ''));
    const keyMode = tags.includes('KEYNEST') ? 'keynest' : tags.includes('LOCKBOX') ? 'lockbox' : null;
    const a = l.address || {};
    const pc = a.zipcode || ((a.full || '').match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i) || [''])[0].toUpperCase();
    const n = l.nickname || l.title || 'Unit';
    map.set(l._id, {
      id: l._id, name: n, label: n.includes(',') ? n.split(',')[0].trim() : n,
      building: ov(cfg.buildingOverrides) || cleanStreet(a.street) || cleanStreet(a.full) || n,
      postcode: pc, address: a.full || '', unitType, keyMode,
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
  const codes = can(user, 'view_cleaning') ? ((await env.STORE.get('lockboxCodes', 'json')) || {}) : {};
  const groups = new Map();
  for (const l of listings.values()) {
    if (!groups.has(l.building)) groups.set(l.building, { name: l.building, postcode: l.postcode, units: [] });
    groups.get(l.building).units.push({ id: l.id, name: l.name, label: l.label, address: l.address, unitType: l.unitType, checkIn: fmtTime(l.checkInTime), checkOut: fmtTime(l.checkOutTime), keyMode: l.keyMode, lockbox: codes[l.id] || null });
  }
  const buildings = [...groups.values()].sort((a, b) => byBuilding(a.name, b.name));
  for (const b of buildings) b.units.sort((x, y) => natural(x.label, y.label));
  const counts = {};
  for (const l of listings.values()) counts[l.unitType] = (counts[l.unitType] || 0) + 1;
  return { buildings, total: listings.size, counts, mock: cfg.mock, keynest: await keynestStatus(env, listings), canManage: isManager(user) };
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

// ---------------------------------------------------------------- cleanings & damage reports
// Stored alongside everything else (Railway volume). Media files themselves are handled by server.mjs;
// here we only keep their ids and check they were uploaded.
const CHECKLIST = [
  { key: 'bins', title: 'Bins', text: 'Have you emptied and changed all the bins?' },
  { key: 'fridge', title: 'Fridge', text: 'Have you checked the fridge is completely empty?' },
  { key: 'oven', title: 'Oven', text: 'Have you checked the oven is empty and clean?' },
  { key: 'microwave', title: 'Microwave', text: 'Have you checked the microwave is empty and clean?' },
  { key: 'hairs', title: 'Shower & toilet', text: 'Have you checked there are no hairs in the shower or around the toilet?' },
];
const HOLD_MS = 3000; // hold time for the final "all checks done" button
const nowIso = () => new Date().toISOString();
const londonDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(iso ? new Date(iso) : new Date());
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

async function loadList(env, key) { return (await env.STORE.get(key, 'json')) || []; }
async function saveList(env, key, list) { await env.STORE.put(key, JSON.stringify(list)); }

async function listingInfo(env, ctx, listingId) {
  const snap = await getSnapshot(env, ctx);
  return listingMap(snap.listings, config(env)).get(listingId) || null;
}
function inScope(u, building) {
  const allow = allowBuildingFor(u);
  return !allow || allow(building);
}
async function mediaReady(env, ids, kindWanted) {
  const out = [];
  for (const id of ids || []) {
    const m = await env.STORE.get('media:' + id, 'json');
    if (!m || !m.uploaded) continue;
    if (kindWanted && m.kind !== kindWanted) continue;
    out.push(m);
  }
  return out;
}
function publicMedia(m) {
  const i = m.info || {};
  return {
    id: m.id, kind: m.kind, status: m.status, name: m.name, size: m.size, duration: m.duration || null, createdAt: m.createdAt, by: m.byName,
    // What was actually uploaded, and whether the untouched original can still be opened at /media/:id/orig.
    width: i.width || null, height: i.height || null, fps: i.fps || null, codec: i.codec || null, hdr: Boolean(i.hdr), hasOrig: Boolean(m.hasOrig),
  };
}
async function withMedia(env, rec) {
  const media = [];
  for (const id of rec.media || []) { const m = await env.STORE.get('media:' + id, 'json'); if (m) media.push(publicMedia(m)); }
  return { ...rec, media };
}

// Mark the flat clean in Guesty. Never blocks the cleaner: failures are recorded and shown to admins.
async function markCleanInGuesty(env, listingId) {
  if (config(env).mock) return 'preview';
  if (env.GUESTY_MARK_CLEAN === '0') return 'off';
  try {
    await gapi(env, 'PUT', `/v1/listings/${listingId}`, { body: { cleaningStatus: { value: 'clean' } } });
    const l = await gapi(env, 'GET', `/v1/listings/${listingId}`, { params: { fields: 'cleaningStatus' } });
    const v = l && l.cleaningStatus && (l.cleaningStatus.value || l.cleaningStatus);
    console.log('[guesty] cleaning status now', JSON.stringify(v));
    return v === 'clean' ? 'updated' : 'sent';
  } catch (e) {
    console.log('[guesty] mark clean failed', e.message);
    return 'failed';
  }
}

// ---------------------------------------------------------------- KeyNest
// Flats tagged KEYNEST in Guesty can only be completed once KeyNest reports the key back in a store.
// Needs KEYNEST_API_KEY in Railway. Each flat is linked to a KeyNest key in Settings › Integrations › KeyNest
// (or matched automatically when the KeyNest key name equals the flat's Guesty nickname).
const KEYNEST_DEFAULT = 'https://api.keynest.com/api/v3';
const KEYNEST_IN = /^(in store|in locker|in office)/i;
let knCache = null; // { at, keys }
async function keynestGet(env, path) {
  if (!env.KEYNEST_API_KEY) throw userError('KeyNest isn’t connected yet. An admin needs to add KEYNEST_API_KEY in Railway.', 400);
  const r = await fetch((env.KEYNEST_API_URL || KEYNEST_DEFAULT) + path, { headers: { ApiKey: env.KEYNEST_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!r.ok || !j || (j.Status && j.Status !== 'Success')) {
    console.log('[keynest]', path.split('/')[1], r.status, (j && j.ResponseMessage) || text.slice(0, 200));
    throw userError(r.status === 401 || r.status === 403 ? 'KeyNest didn’t accept the API key. Check KEYNEST_API_KEY in Railway.' : `KeyNest didn’t answer properly (error ${r.status}). Try again in a minute.`, 502);
  }
  return j;
}
const knKey = (k) => ({ id: k.KeyId, name: k.KeyName || '', status: k.StatusType || k.CurrentStatus || '', lastMovement: k.LastMovement || null, postcode: k.PropertyPostcode || '', address: k.Address || '' });
let knFail = null; // { at, err }: KeyNest just failed, so don't keep every page waiting on it for the next minute
async function keynestKeys(env, fresh) {
  if (!fresh && knCache && Date.now() - knCache.at < 60e3) return knCache.keys;
  if (!fresh && knFail && Date.now() - knFail.at < 60e3) throw knFail.err;
  let j;
  try { j = await keynestGet(env, '/Keys'); } catch (e) { knFail = { at: Date.now(), err: e }; throw e; }
  knFail = null;
  const keys = ((j.ResponsePacket && j.ResponsePacket.KeyList) || []).map(knKey);
  knCache = { at: Date.now(), keys };
  return keys;
}
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function keynestLink(env, l) {
  const links = (await env.STORE.get('keynestLinks', 'json')) || {};
  if (links[l.id]) return { keyId: links[l.id], how: 'linked' };
  if (!env.KEYNEST_API_KEY) return null;
  const want = new Set([normName(l.name), normName(l.label + l.building)]);
  const m = (await keynestKeys(env)).filter((k) => want.has(normName(k.name)));
  return m.length === 1 ? { keyId: m[0].id, how: 'auto' } : null;
}
// KeyNest times have no time zone; reading them as UTC can only make them look later (London is UTC or UTC+1),
// so a drop-off is never missed. The key must be back in KeyNest and have moved since the cleaning started.
const knTime = (s) => (!s ? 0 : Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z') || 0);
async function keynestCheck(env, rec, keyId) {
  const j = await keynestGet(env, '/Keys/' + encodeURIComponent(keyId));
  const p = j.ResponsePacket || {};
  const k = knKey((p.KeyList && p.KeyList[0]) || p);
  const drops = (await env.STORE.get('keynestDrops', 'json')) || {};
  const moved = Math.max(knTime(k.lastMovement), Date.parse(drops[keyId] || '') || 0);
  const since = Date.parse(rec.startedAt) - 5 * 60e3;
  return { ok: KEYNEST_IN.test(k.status) && moved >= since, status: k.status || 'Unknown', lastMovement: k.lastMovement, keyName: k.name };
}
const webhookKeyFor = async (env, name) => (await hmac(await secretKey(env), name)).slice(0, 32);

// Admin and User roles run the operation: settings & integrations, assigning cleanings. Supervisors and cleaners don't.
const isManager = (u) => Boolean(u && (u.role === 'admin' || u.role === 'user'));

// Which KeyNest-tagged flats have no KeyNest key linked (so cleaners can't complete them). Shown on the Properties page.
async function keynestStatus(env, listings) {
  const flats = [...listings.values()].filter((l) => l.keyMode === 'keynest');
  const out = { connected: Boolean(env.KEYNEST_API_KEY), flats: flats.length, unlinked: [] };
  if (!flats.length) return out;
  const links = (await env.STORE.get('keynestLinks', 'json')) || {};
  let keys = null; // fetched once (cached), and a slow or failing KeyNest never holds up the page
  if (out.connected && flats.some((l) => !links[l.id])) { try { keys = await keynestKeys(env); } catch (_) { keys = null; } }
  for (const l of flats) {
    const want = new Set([normName(l.name), normName(l.label + l.building)]);
    const linked = links[l.id] || (out.connected && keys && keys.filter((k) => want.has(normName(k.name))).length === 1);
    if (!linked) out.unlinked.push({ id: l.id, label: l.label, building: l.building });
  }
  return out;
}

async function keynestAdminApi(req, env, ctx, me, parts) {
  if (!isManager(me)) return json({ error: 'Only Admins and Users can change KeyNest settings.' }, 403);
  const links = (await env.STORE.get('keynestLinks', 'json')) || {};
  if (req.method === 'GET') {
    const base = (env.PUBLIC_URL || '').replace(/\/$/, '');
    const snap = await getSnapshot(env, ctx);
    const flats = [...listingMap(snap.listings, config(env), allowBuildingFor(me)).values()].filter((l) => l.keyMode === 'keynest');
    const out = { connected: Boolean(env.KEYNEST_API_KEY), webhookUrl: base ? `${base}/webhooks/keynest/${await webhookKeyFor(env, 'keynest')}` : null, keys: [], flats: [], error: null };
    if (out.connected) { try { out.keys = await keynestKeys(env, true); } catch (e) { out.error = e.userMessage || e.message; } }
    for (const l of flats) {
      let link = null; try { link = await keynestLink(env, l); } catch (_) { /* shown via out.error */ }
      out.flats.push({ id: l.id, label: l.label, name: l.name, building: l.building, keyId: link ? link.keyId : null, how: link ? link.how : null });
    }
    return json(out);
  }
  // All edits are saved together, only after the person reviews and confirms them in Settings.
  if (req.method === 'PUT' && parts[3] === 'links') {
    const body = await req.json().catch(() => ({}));
    if (body.confirmed !== true) return json({ error: 'Review and confirm the changes first.' }, 400);
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, 200) : [];
    if (!changes.length) return json({ error: 'Nothing to save.' }, 400);
    const snap = await getSnapshot(env, ctx);
    const mine = listingMap(snap.listings, config(env), allowBuildingFor(me));
    for (const c of changes) {
      const listingId = String((c && c.listingId) || '');
      const l = mine.get(listingId);
      if (!l || l.keyMode !== 'keynest') return json({ error: 'One of those flats isn’t a KeyNest flat in your buildings.' }, 400);
      if (c.keyId) links[listingId] = String(c.keyId).slice(0, 64); else delete links[listingId];
    }
    await env.STORE.put('keynestLinks', JSON.stringify(links));
    console.log(`[keynest] ${me.name} saved ${changes.length} link change(s)`);
    return json({ ok: true });
  }
  return json({ error: 'Not supported' }, 405);
}

// ---------------------------------------------------------------- notifications (in-app bell + phone push)
// Stored as one list: { id, to, type, title, body, url, at, read }. Kept 60 days, newest 2000.
async function recipients(env, roles, building, except) {
  const users = (await loadUsers(env)).filter((u) => u.active !== false && roles.includes(u.role)
    && (u.buildings === 'all' || u.buildings == null || (Array.isArray(u.buildings) && u.buildings.includes(building))));
  const ids = users.map((u) => u.id);
  if (roles.includes('admin')) ids.push('owner'); // the recovery login counts as an admin
  return [...new Set(ids)].filter((id) => id && id !== except);
}
async function notify(env, ctx, to, n) {
  if (!to.length) return;
  const at = nowIso();
  const list = (await env.STORE.get('notifications', 'json')) || [];
  const cutoff = Date.now() - 60 * 864e5;
  const items = to.map((id) => ({ id: newId(), to: id, type: n.type, title: n.title, body: n.body || '', url: n.url || '/', at, read: false }));
  const kept = list.filter((x) => Date.parse(x.at) > cutoff).concat(items).slice(-2000);
  await env.STORE.put('notifications', JSON.stringify(kept));
  ctx.waitUntil(pushTo(env, to, { title: n.title, body: n.body || '', url: n.url || '/', tag: n.tag || n.type }).catch((e) => console.log('[push] failed', e.message)));
}
async function notificationsApi(req, env, me, parts) {
  const list = (await env.STORE.get('notifications', 'json')) || [];
  if (req.method === 'GET') {
    const mine = list.filter((x) => x.to === me.id);
    return json({ items: mine.slice(-50).reverse(), unread: mine.filter((x) => !x.read).length });
  }
  if (req.method === 'POST' && parts[3] === 'read') {
    const body = await req.json().catch(() => ({}));
    const ids = body.all ? null : new Set((body.ids || []).map(String));
    let n = 0;
    for (const x of list) if (x.to === me.id && !x.read && (!ids || ids.has(x.id))) { x.read = true; n++; }
    if (n) await env.STORE.put('notifications', JSON.stringify(list));
    return json({ ok: true, marked: n });
  }
  return json({ error: 'Not supported' }, 405);
}

// Web Push (RFC 8291 payload encryption + RFC 8292 VAPID), with the WebCrypto built into Node and Workers.
const b64u = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); return unb64(s + '='.repeat((4 - (s.length % 4)) % 4)); };
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function vapidKeys(env) {
  let v = await env.STORE.get('vapidKeys', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await env.STORE.put('vapidKeys', JSON.stringify(v));
  }
  return v;
}
// Encrypts one push message for a subscription (aes128gcm). `test` fixes the random parts for known-answer tests.
async function encryptPush(sub, payload, test) {
  const enc = new TextEncoder();
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const as = test ? test.asKeys : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = test ? test.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = typeof payload === 'string' ? enc.encode(payload) : payload;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(data, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}
async function vapidAuth(env, endpoint) {
  const v = await vapidKeys(env);
  const enc = new TextEncoder();
  const aud = new URL(endpoint).origin;
  const sub = (env.PUBLIC_URL || 'https://schedule.yourcityscape.com').replace(/\/$/, '');
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })));
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}
// Only the browsers' own push services are ever contacted (Chrome/Android, Apple, Firefox, Edge/Windows).
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*notify\.windows\.com)$/i;
const pushEndpointOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.test(x.hostname); } catch (_) { return false; } };
async function pushTo(env, userIds, msg) {
  const subs = (await env.STORE.get('pushSubs', 'json')) || {};
  const body = JSON.stringify(msg).slice(0, 3000);
  const targets = userIds.flatMap((id) => (subs[id] || []).filter((s) => pushEndpointOk(s.endpoint)));
  const dead = new Set();
  await Promise.allSettled(targets.map(async (s) => {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', body: await encryptPush(s, body), redirect: 'manual', signal: AbortSignal.timeout(10000), headers: {
        Authorization: await vapidAuth(env, s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' } });
      if (r.status === 404 || r.status === 410) dead.add(s.endpoint); // phone unsubscribed
      else if (!r.ok) console.log('[push]', r.status, (await r.text().catch(() => '')).slice(0, 200));
    } catch (e) { console.log('[push] send failed', e.message); }
  }));
  if (!dead.size) return;
  const now = (await env.STORE.get('pushSubs', 'json')) || {}; // re-read: someone may have (un)subscribed meanwhile
  for (const id of Object.keys(now)) now[id] = now[id].filter((x) => !dead.has(x.endpoint));
  await env.STORE.put('pushSubs', JSON.stringify(now));
}
async function pushApi(req, env, me, parts) {
  if (req.method === 'GET' && parts[3] === 'key') return json({ publicKey: (await vapidKeys(env)).publicKey });
  const body = await req.json().catch(() => ({}));
  const subs = (await env.STORE.get('pushSubs', 'json')) || {};
  const s = body.subscription || {};
  if (req.method === 'POST' && parts[3] === 'subscribe') {
    if (!pushEndpointOk(String(s.endpoint || '')) || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: 'That subscription isn’t valid.' }, 400);
    const entry = { endpoint: String(s.endpoint).slice(0, 1000), keys: { p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 100) }, at: nowIso(), ua: String(req.headers.get('user-agent') || '').slice(0, 160) };
    for (const id of Object.keys(subs)) subs[id] = subs[id].filter((x) => x.endpoint !== entry.endpoint); // a phone belongs to whoever signed in last
    subs[me.id] = (subs[me.id] || []).concat(entry).slice(-10);
    await env.STORE.put('pushSubs', JSON.stringify(subs));
    return json({ ok: true });
  }
  if (req.method === 'POST' && parts[3] === 'unsubscribe') {
    subs[me.id] = (subs[me.id] || []).filter((x) => x.endpoint !== s.endpoint && x.endpoint !== body.endpoint);
    await env.STORE.put('pushSubs', JSON.stringify(subs));
    return json({ ok: true });
  }
  if (req.method === 'POST' && parts[3] === 'test') {
    await pushTo(env, [me.id], { title: 'Phone notifications are on', body: 'You’ll get alerts from Cityscape Schedule here.', url: '/', tag: 'test' });
    return json({ ok: true });
  }
  return json({ error: 'Not supported' }, 405);
}

// ---------------------------------------------------------------- assigning cleanings
// One cleaner per flat per day: { "date|listingId": { listingId, date, building, label, cleanerId, cleanerName, byId, byName, at } }.
const dayLabel = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d + 'T00:00:00Z'));
async function assignmentsApi(req, env, ctx, me, url) {
  const all = (await env.STORE.get('assignments', 'json')) || {};
  if (req.method === 'GET' && url.pathname === '/api/assignees') {
    if (!isManager(me)) return json({ error: 'Only Admins and Users can assign cleanings.' }, 403);
    const l = await listingInfo(env, ctx, String(url.searchParams.get('listingId') || ''));
    if (!l) return json({ error: 'That property wasn’t found.' }, 404);
    if (!inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, 403);
    const people = (await loadUsers(env)).filter((u) => u.active !== false && can(u, 'do_cleaning')
      && (u.buildings === 'all' || u.buildings == null || (Array.isArray(u.buildings) && u.buildings.includes(l.building))));
    return json({ people: people.map((u) => ({ id: u.id, name: u.name, role: u.role })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (req.method === 'GET') {
    const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '9999';
    return json({ assignments: Object.values(all).filter((a) => a.date >= from && a.date <= to && inScope(me, a.building)) });
  }
  if (req.method === 'PUT') {
    if (!isManager(me)) return json({ error: 'Only Admins and Users can assign cleanings.' }, 403);
    const body = await req.json().catch(() => ({}));
    const date = String(body.date || '');
    const realDay = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
    if (!realDay) return json({ error: 'Pick a day.' }, 400);
    const l = await listingInfo(env, ctx, String(body.listingId || ''));
    if (!l) return json({ error: 'That property wasn’t found.' }, 404);
    if (!inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, 403);
    const key = `${date}|${l.id}`, before = all[key] || null;
    let cleaner = null;
    if (body.cleanerId) {
      cleaner = (await loadUsers(env)).find((u) => u.id === String(body.cleanerId) && u.active !== false);
      if (!cleaner || !can(cleaner, 'do_cleaning')) return json({ error: 'That person can’t do cleanings.' }, 400);
      if (Array.isArray(cleaner.buildings) && !cleaner.buildings.includes(l.building)) return json({ error: `${cleaner.name} doesn’t cover ${l.building}. Add the building to their account first.` }, 400);
    }
    if (before && cleaner && before.cleanerId === cleaner.id) return json({ assignment: before });
    if (cleaner) all[key] = { listingId: l.id, date, building: l.building, label: l.label, cleanerId: cleaner.id, cleanerName: cleaner.name, byId: me.id, byName: me.name, at: nowIso() };
    else delete all[key];
    for (const k of Object.keys(all)) if (all[k].date < londonDate(Date.now() - 90 * 864e5)) delete all[k]; // keep 90 days
    await env.STORE.put('assignments', JSON.stringify(all));
    const where = `${dayLabel(date)} · ${l.building}`;
    const link = `/?view=day&date=${date}&flat=${encodeURIComponent(l.id)}`;
    if (cleaner) {
      await notify(env, ctx, [cleaner.id].filter((id) => id !== me.id), { type: 'assigned', title: `You’re cleaning ${l.label}`, body: `${where} · assigned by ${me.name}`, url: link, tag: `assign-${key}` });
      await notify(env, ctx, (await recipients(env, ['supervisor'], l.building, me.id)).filter((id) => id !== cleaner.id), { type: 'assigned', title: `${cleaner.name} assigned to ${l.label}`, body: `${where} · by ${me.name}`, url: link, tag: `assign-${key}` });
    }
    if (before && (!cleaner || before.cleanerId !== cleaner.id) && before.cleanerId !== me.id) {
      await notify(env, ctx, [before.cleanerId], { type: 'unassigned', title: `${l.label} is no longer yours`, body: `${where} · changed by ${me.name}`, url: link, tag: `assign-${key}` });
    }
    return json({ assignment: all[key] || null });
  }
  return json({ error: 'Not supported' }, 405);
}

async function cleaningsApi(req, env, ctx, me, parts, url) {
  const [, , , id, action] = parts; // /api/cleanings/:id/:action
  const list = await loadList(env, 'cleanings');
  const deny = (msg) => json({ error: msg || 'You don’t have permission for that. Ask an admin.' }, 403);

  if (req.method === 'GET' && !id) {
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from') || date;
    const to = url.searchParams.get('to') || date;
    const mine = list.filter((c) => c.cleanerId === me.id && c.status !== 'completed' && c.status !== 'cancelled');
    const visible = list.filter((c) => {
      if (c.cleanerId === me.id) return true;
      if (!can(me, 'view_cleaning')) return false;
      return inScope(me, c.building);
    }).filter((c) => (!from || c.date >= from) && (!to || c.date <= to));
    const out = [];
    for (const c of [...new Set([...visible, ...mine])]) out.push(await withMedia(env, c));
    out.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return json({ cleanings: out, checklist: CHECKLIST, holdMs: HOLD_MS });
  }

  if (req.method === 'POST' && id === 'start') {
    if (!can(me, 'do_cleaning')) return deny();
    const body = await req.json().catch(() => ({}));
    const l = await listingInfo(env, ctx, String(body.listingId || ''));
    if (!l) return json({ error: 'That property wasn’t found.' }, 404);
    if (!inScope(me, l.building)) return deny('That property isn’t one of your buildings.');
    const active = list.find((c) => c.listingId === l.id && ['in_progress', 'checklist', 'awaiting_video', 'awaiting_key'].includes(c.status));
    if (active) {
      const at = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit' }).format(new Date(active.startedAt));
      return json({ error: `${active.cleanerName} already started cleaning ${l.label} at ${at}.`, cleaning: active }, 409);
    }
    const rec = {
      id: newId(), listingId: l.id, listingName: l.name, label: l.label, building: l.building, unitType: l.unitType,
      cleanerId: me.id, cleanerName: me.name, startedAt: nowIso(), endedAt: null, completedAt: null,
      date: londonDate(), status: 'in_progress', checklist: [], media: [], guesty: null, keyMode: l.keyMode || null, key: null,
    };
    list.push(rec);
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }

  const rec = list.find((c) => c.id === id);
  if (!rec) return json({ error: 'That cleaning wasn’t found.' }, 404);
  const isMine = rec.cleanerId === me.id;
  const isAdmin = can(me, 'manage_users');

  if (req.method === 'POST' && action === 'end') {
    if (!isMine) return deny('Only the person who started this cleaning can end it.');
    if (rec.status !== 'in_progress') return json({ cleaning: rec });
    rec.endedAt = nowIso();
    rec.status = 'checklist';
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }
  if (req.method === 'POST' && action === 'confirm') {
    // One checklist item, confirmed with a single tap, in order.
    if (!isMine) return deny();
    if (rec.status !== 'checklist') return json({ error: 'This checklist is already done.' }, 400);
    const body = await req.json().catch(() => ({}));
    const next = CHECKLIST[rec.checklist.length];
    if (!next) return json({ cleaning: rec });
    if (body.key !== next.key) return json({ error: 'Please go through the checks in order.', cleaning: rec }, 400);
    rec.checklist.push({ key: next.key, confirmedAt: nowIso() });
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }
  if (req.method === 'POST' && action === 'checks-done') {
    // After all items are ticked, the summary is confirmed by holding the button for HOLD_MS.
    if (!isMine) return deny();
    if (rec.status !== 'checklist') return json({ cleaning: rec });
    const body = await req.json().catch(() => ({}));
    if (rec.checklist.length < CHECKLIST.length) return json({ error: 'Please answer every check first.', cleaning: rec }, 400);
    if (!(Number(body.heldMs) >= HOLD_MS - 50)) return json({ error: 'Hold the button until the bar fills.' }, 400);
    rec.checksConfirmedAt = nowIso();
    rec.checksHeldMs = Math.round(Number(body.heldMs));
    rec.status = 'awaiting_video';
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }
  // Final step: mark completed and tell Guesty the flat is clean (in the background).
  const finish = async () => {
    rec.completedAt = nowIso();
    rec.status = 'completed';
    await saveList(env, 'cleanings', list);
    const mins = Math.max(1, Math.round((Date.parse(rec.endedAt || rec.completedAt) - Date.parse(rec.startedAt)) / 60000));
    await notify(env, ctx, await recipients(env, ['admin', 'user'], rec.building, rec.cleanerId), {
      type: 'cleaned', title: `${rec.label} cleaned`, body: `${rec.cleanerName} · ${rec.building} · ${mins} min`,
      url: `/?view=cleaning&date=${rec.date}`, tag: `cleaned-${rec.id}` }).catch((e) => console.log('[notify] failed', e.message));
    ctx.waitUntil((async () => {
      const g = await markCleanInGuesty(env, rec.listingId);
      const l2 = await loadList(env, 'cleanings');
      const r2 = l2.find((c) => c.id === rec.id);
      if (r2) { r2.guesty = g; await saveList(env, 'cleanings', l2); }
    })());
    return json({ cleaning: await withMedia(env, rec) });
  };
  if (req.method === 'POST' && action === 'complete') {
    if (!isMine) return deny();
    if (rec.status !== 'awaiting_video') return json({ error: 'Finish the checklist first.' }, 400);
    const body = await req.json().catch(() => ({}));
    const ids = [...new Set([...(body.videoIds || []), ...(body.photoIds || [])].map(String))];
    const videos = await mediaReady(env, ids, 'video');
    if (!videos.length) return json({ error: 'A video of the flat is required before you can finish.' }, 400);
    const all = await mediaReady(env, ids);
    rec.media = all.map((m) => m.id);
    rec.videoAt = nowIso();
    // Flats tagged LOCKBOX or KEYNEST in Guesty have one more step: returning the key.
    const l = await listingInfo(env, ctx, rec.listingId);
    const mode = (l && l.keyMode) || null;
    if (mode) {
      rec.keyMode = mode;
      rec.status = 'awaiting_key';
      await saveList(env, 'cleanings', list);
      return json({ cleaning: await withMedia(env, rec) });
    }
    return finish();
  }
  if (req.method === 'GET' && action === 'key-status') {
    // Live KeyNest status for the cleaner's "hand the key in" screen.
    if (!isMine && !isAdmin) return deny();
    if (rec.keyMode !== 'keynest') return json({ ok: false, status: null });
    if (!env.KEYNEST_API_KEY) return json({ ok: false, status: null, error: 'KeyNest isn’t connected yet. Ask an admin.' });
    const l = await listingInfo(env, ctx, rec.listingId);
    const link = l && await keynestLink(env, l);
    if (!link) return json({ ok: false, status: null, error: 'This flat isn’t linked to a KeyNest key yet. Ask an admin to link it in Settings › Integrations › KeyNest.' });
    return json(await keynestCheck(env, rec, link.keyId));
  }
  if (req.method === 'POST' && action === 'key') {
    if (!isMine) return deny();
    if (rec.status !== 'awaiting_key') return json({ error: rec.status === 'completed' ? 'This cleaning is already complete.' : 'Upload the video first.' }, 400);
    const body = await req.json().catch(() => ({}));
    if (rec.keyMode === 'lockbox') {
      const code = String(body.code || '').trim();
      if (!/^\d{4}$/.test(code)) return json({ error: 'Enter the new lockbox code: exactly 4 numbers.' }, 400);
      if (body.confirmCode !== undefined && String(body.confirmCode).trim() !== code) return json({ error: 'The two codes don’t match. Check the lockbox and enter it again.' }, 400);
      if (body.keyReturned !== true) return json({ error: 'Confirm the key is back in the lockbox.' }, 400);
      rec.key = { mode: 'lockbox', code, returnedAt: nowIso() };
      const codes = (await env.STORE.get('lockboxCodes', 'json')) || {};
      codes[rec.listingId] = { code, at: rec.key.returnedAt, by: me.name, cleaningId: rec.id };
      await env.STORE.put('lockboxCodes', JSON.stringify(codes));
      return finish();
    }
    if (rec.keyMode === 'keynest') {
      if (!env.KEYNEST_API_KEY) return json({ error: 'KeyNest isn’t connected yet. Ask an admin.' }, 400);
      const l = await listingInfo(env, ctx, rec.listingId);
      const link = l && await keynestLink(env, l);
      if (!link) return json({ error: 'This flat isn’t linked to a KeyNest key yet. Ask an admin to link it in Settings › Integrations › KeyNest.' }, 400);
      const chk = await keynestCheck(env, rec, link.keyId);
      if (!chk.ok) return json({ error: `KeyNest doesn’t show the key handed in yet (status: ${chk.status}). Hand it in at the KeyNest store, then check again.`, keynest: chk }, 409);
      rec.key = { mode: 'keynest', keyId: link.keyId, status: chk.status, lastMovement: chk.lastMovement, confirmedAt: nowIso() };
      return finish();
    }
    return finish();
  }
  if (req.method === 'POST' && action === 'cancel') {
    if (!isMine && !isAdmin) return deny();
    if (rec.status === 'completed') return json({ error: 'Completed cleanings can’t be cancelled.' }, 400);
    rec.status = 'cancelled';
    rec.cancelledAt = nowIso();
    rec.cancelledBy = me.name;
    await saveList(env, 'cleanings', list);
    return json({ cleaning: rec });
  }
  if (req.method === 'GET') {
    if (!isMine && !(can(me, 'view_cleaning') && inScope(me, rec.building))) return deny();
    return json({ cleaning: await withMedia(env, rec), checklist: CHECKLIST, holdMs: HOLD_MS });
  }
  return json({ error: 'Not supported' }, 405);
}

async function damagesApi(req, env, ctx, me, parts, url) {
  const [, , , id] = parts;
  const list = await loadList(env, 'damages');
  const canSee = (d) => d.reporterId === me.id || ((can(me, 'view_cleaning') || can(me, 'manage_damage')) && inScope(me, d.building));
  if (req.method === 'GET' && !id) {
    const listingId = url.searchParams.get('listingId');
    const status = url.searchParams.get('status');
    const out = [];
    for (const d of list) {
      if (!canSee(d)) continue;
      if (listingId && d.listingId !== listingId) continue;
      if (status && d.status !== status) continue;
      out.push(await withMedia(env, d));
    }
    out.sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
    return json({ damages: out });
  }
  if (req.method === 'POST' && !id) {
    if (!can(me, 'report_damage')) return json({ error: 'You don’t have permission to report damage.' }, 403);
    const body = await req.json().catch(() => ({}));
    const l = await listingInfo(env, ctx, String(body.listingId || ''));
    if (!l) return json({ error: 'That property wasn’t found.' }, 404);
    if (!inScope(me, l.building)) return json({ error: 'That property isn’t one of your buildings.' }, 403);
    const description = String(body.description || '').trim().slice(0, 2000);
    if (description.length < 3) return json({ error: 'Describe what’s damaged.' }, 400);
    const media = await mediaReady(env, (body.mediaIds || []).map(String));
    if (!media.length) return json({ error: 'Add a video or photo of the damage.' }, 400);
    const rec = {
      id: newId(), listingId: l.id, listingName: l.name, label: l.label, building: l.building,
      description, location: String(body.location || '').trim().slice(0, 120),
      reporterId: me.id, reporterName: me.name, reportedAt: nowIso(), date: londonDate(),
      cleaningId: body.cleaningId ? String(body.cleaningId) : null,
      media: media.map((m) => m.id), status: 'open', resolvedAt: null, resolvedBy: null, note: '',
    };
    list.push(rec);
    await saveList(env, 'damages', list);
    await notify(env, ctx, await recipients(env, ['admin', 'user'], rec.building, me.id), {
      type: 'damage', title: `Damage reported · ${rec.label}`, body: `${rec.location ? rec.location + ': ' : ''}${description.slice(0, 120)} — ${me.name}`,
      url: `/?view=day&date=${rec.date}&flat=${encodeURIComponent(rec.listingId)}`, tag: `damage-${rec.id}` }).catch((e) => console.log('[notify] failed', e.message));
    return json({ damage: await withMedia(env, rec) });
  }
  const rec = list.find((d) => d.id === id);
  if (!rec || !canSee(rec)) return json({ error: 'That report wasn’t found.' }, 404);
  if (req.method === 'PUT') {
    if (!can(me, 'manage_damage')) return json({ error: 'You don’t have permission to resolve damage reports.' }, 403);
    const body = await req.json().catch(() => ({}));
    if (body.status === 'resolved' || body.status === 'open') {
      rec.status = body.status;
      rec.resolvedAt = body.status === 'resolved' ? nowIso() : null;
      rec.resolvedBy = body.status === 'resolved' ? me.name : null;
    }
    if ('note' in body) rec.note = String(body.note || '').slice(0, 2000);
    await saveList(env, 'damages', list);
    return json({ damage: await withMedia(env, rec) });
  }
  return json({ damage: await withMedia(env, rec) });
}

// Used by server.mjs before accepting or serving media files.
async function mediaAccess(env, ctx, me, body) {
  if (body.purpose === 'damage') return can(me, 'report_damage');
  if (body.purpose === 'cleaning') {
    const list = await loadList(env, 'cleanings');
    const c = list.find((x) => x.id === body.ownerId);
    return Boolean(c && c.cleanerId === me.id && c.status === 'awaiting_video');
  }
  return false;
}
async function mediaViewAllowed(env, me, m) {
  if (m.byId === me.id) return true;
  if (!(can(me, 'view_cleaning') || can(me, 'manage_damage'))) return false;
  if (!m.building) return true;
  return inScope(me, m.building);
}

// ---------------------------------------------------------------- router
async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname;
  const ip = req.headers.get('CF-Connecting-IP') || 'x';

  if (p === '/health') return json({ ok: true, mock: config(env).mock });

  if (p.startsWith('/webhooks/keynest/') && req.method === 'POST') {
    // KeyNest DROPPED events: remember when each key was last handed in (backs up the status check).
    if (!safeEqual(p.split('/')[3] || '', await webhookKeyFor(env, 'keynest'))) return new Response('unauthorised', { status: 401 });
    const body = await req.json().catch(() => ({}));
    if (String(body.EventName || '').toUpperCase() === 'DROPPED' && body.KeyId) {
      const drops = (await env.STORE.get('keynestDrops', 'json')) || {};
      drops[String(body.KeyId)] = new Date(knTime(body.WhenHappened) || Date.now()).toISOString();
      await env.STORE.put('keynestDrops', JSON.stringify(drops));
      console.log('[keynest] dropped', body.KeyName || body.KeyId);
    }
    return new Response('ok');
  }

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
  if (['/styles.css', '/favicon.svg', '/favicon.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'].includes(p)) return asset(req, p.slice(1));
  if (p === '/favicon.ico') return asset(req, 'favicon.png');
  if (p === '/sw.js') { const r = asset(req, 'sw.js'); r.headers.set('Service-Worker-Allowed', '/'); r.headers.set('Cache-Control', 'no-cache'); return r; }

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
    if (me.isOwner) return json({ error: 'The owner login uses the APP_PASSWORD variable in Railway. Change it there.' }, 400);
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
  if (p === '/api/cleanings' || p.startsWith('/api/cleanings/')) return cleaningsApi(req, env, ctx, me, p.split('/'), url);
  if (p === '/api/keynest' || p.startsWith('/api/keynest/')) return keynestAdminApi(req, env, ctx, me, p.split('/'));
  if (p === '/api/damages' || p.startsWith('/api/damages/')) return damagesApi(req, env, ctx, me, p.split('/'), url);
  if (p === '/api/notifications' || p.startsWith('/api/notifications/')) return notificationsApi(req, env, me, p.split('/'));
  if (p.startsWith('/api/push/')) return pushApi(req, env, me, p.split('/'));
  if (p === '/api/assignments' || p === '/api/assignees') return assignmentsApi(req, env, ctx, me, url);
  // Internal checks used by server.mjs for uploads and playback (same-process only; not reachable from outside).
  if (p === '/api/internal/media-check' && req.headers.get('x-internal') === env.__INTERNAL_KEY) {
    const body = await req.json().catch(() => ({}));
    if (body.mode === 'upload') {
      if (!(await mediaAccess(env, ctx, me, body))) return json({ ok: false }, 403);
      let building = null;
      if (body.purpose === 'damage') { const l = await listingInfo(env, ctx, String(body.listingId || '')); if (!l || !inScope(me, l.building)) return json({ ok: false }, 403); building = l.building; }
      if (body.purpose === 'cleaning') { const c = (await loadList(env, 'cleanings')).find((x) => x.id === body.ownerId); building = c && c.building; }
      return json({ ok: true, user: { id: me.id, name: me.name }, building });
    }
    if (body.mode === 'view') {
      const m = await env.STORE.get('media:' + body.id, 'json');
      return json({ ok: Boolean(m && (await mediaViewAllowed(env, me, m))), userId: me.id });
    }
    return json({ ok: false }, 400);
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
