# Cityscape Schedule

Weekly check-ins, check-outs and linen for Cityscape, live from Guesty.

- `worker.js` + `wrangler.jsonc`: the Cloudflare Worker (deploys automatically on every push to main).
- Secrets (GUESTY_CLIENT_ID, GUESTY_CLIENT_SECRET, APP_PASSWORD) live in Cloudflare, never in this repo.
- `cityscape-schedule/`: the older Node version (Railway).
