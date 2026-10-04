# Tests

`npm run build && npm test` runs every suite, each against a fresh local copy of the app with sample data (no Guesty
keys) and a stand-in KeyNest (`mock-keynest.mjs`). `npm test -- keydrop complaint` runs just those. They need Node 20+
and ports 8799, 8798 and 8840 free. GitHub runs them on every push and pull request (`.github/workflows/test.yml`).

| Suite | What it checks |
|-------|----------------|
| safety | Safety fixes, account limits, KeyNest override permissions |
| race | A slow KeyNest step can't wipe another cleaner's change (prints KEPT) |
| cleans-only | Supervisors and cleaners see only check-outs and same-day turnovers |
| code-edit | Lockbox code and property editing by role and building |
| jobtools | Reset, move, mark cleaned, finish without the video |
| complaint | Complaints: links to stay and cleaning, notices, visibility, CSV, permissions |
| keydrop | KeyNest key step finishing by itself (webhook and checks) |
| start-role | Who can start a cleaning |
| audit-fixes | Fixes from the October 2026 audit |
| review-fixes | Moves and assignments while bookings change in Guesty |
