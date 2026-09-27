# Cityscape Schedule — source

Edit these files, not the bundled worker.js at the repo root.

- worker/src.js      server logic (Guesty sync, users, cleanings, damages, webhooks)
- worker/mock.js     sample data used when Guesty keys are missing
- worker/server.mjs  Node server for Railway (storage, media uploads, ffmpeg, 5-min refresh)
- public/*           the web app (index.html, app.js, styles.css, login.html)

Build:   node worker/build.cjs      -> dist/worker.js + dist/server.mjs
Deploy:  copy dist/worker.js and dist/server.mjs to the repo root and commit; Railway redeploys.
Test locally: DATA_DIR=/tmp/csd PORT=8799 APP_PASSWORD=test node dist/server.mjs  (sample data)
