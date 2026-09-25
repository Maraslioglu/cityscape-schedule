# Cityscape Schedule

Weekly check-ins, check-outs and linen totals for Cityscape, pulled live from Guesty.
Replaces the weekly "Cityscape Schedule" Google Doc.

- **Day view** (for cleaners, works on phones): pick a day from the Sat→Fri strip. Jobs are split into *Same-day turnovers*, *Check-outs* and *Arrivals*, grouped by building, with the guest's planned time when they've given one.
- **Board view** (for the week at a glance): every flat down the side, grouped by building, days across the top. Shaded bars show who's staying; check-out, check-in and same-day turnovers are marked. Tap a day heading to jump to that day.
- **Laundry**: 1 linen set per check-out, totalled by unit type (2 Bedroom / 1 Bedroom / Studio) for the week and per day. Unit type comes from the listing's bedroom count in Guesty (0 bedrooms = Studio).
- **Live updates**: when a booking is made, changed or cancelled in Guesty, every open screen updates within seconds and shows a message. Bookings made in the last 24 hours get a **New** badge.
- **Properties**: all active Guesty listings, grouped by building.
- **Copy for WhatsApp** (copies the selected day, or the whole week from the Board) and **Print / Save as PDF**.
- Team password login.
- No dependencies — plain Node 18+.

---

## Deploy: GitHub → Railway → Cloudflare (about 15 minutes)

### 1. Put the code on GitHub
1. Go to github.com → **New repository** → name it `cityscape-schedule` → **Private** → Create.
2. On the empty repo page click **uploading an existing file**, drag in everything from this folder (including the `lib` and `public` folders), and **Commit**.

### 2. Deploy on Railway
1. railway.app → **New Project** → **Deploy from GitHub repo** → pick `cityscape-schedule`.
2. Open the service → **Variables** → add:

   | Variable | Value |
   |---|---|
   | `GUESTY_CLIENT_ID` | from Guesty → Integrations → Marketplace → API |
   | `GUESTY_CLIENT_SECRET` | same place |
   | `APP_PASSWORD` | the password your team will use |
   | `SESSION_SECRET` | any long random string (changing it signs everyone out) |
   | `NODE_ENV` | `production` |

3. **Add a volume** (right-click the service → *Attach volume*) mounted at **`/data`**.
   *This matters:* Guesty only allows **5 access tokens per 24 hours**. The app saves its token to `/data` so redeploys reuse it instead of burning a new one.
4. **Settings → Networking → Generate Domain** to get a `*.up.railway.app` link and test it.
5. Redeploy once after generating the domain. On start-up the app registers itself with Guesty for instant updates. The dot next to the view buttons says **Live** when this worked, or **Auto** if it fell back to checking every 5 minutes. The Railway logs show `[webhook] registered` or the reason it failed.

Every push to GitHub redeploys automatically.

### 3. Your own address via Cloudflare (e.g. `schedule.yourcityscape.com`)
1. Railway → service → **Settings → Networking → Custom Domain** → enter `schedule.yourcityscape.com`. Railway shows a CNAME target (and sometimes a TXT record).
2. Cloudflare → `yourcityscape.com` → **DNS → Add record**: type **CNAME**, name `schedule`, target = the Railway value. Add the TXT record too if Railway gave one.
3. Leave the cloud **orange (Proxied)** and set SSL/TLS mode to **Full**. Railway shows a green tick once verified (usually a few minutes).

---

## Optional settings (Railway variables)

| Variable | Default | What it does |
|---|---|---|
| `WEEK_START_DAY` | `6` | 0 = Sunday … 6 = Saturday |
| `RESERVATION_STATUSES` | `confirmed` | Add `,reserved` to include held/unpaid bookings |
| `DEFAULT_CHECKIN_TIME` / `DEFAULT_CHECKOUT_TIME` | `15:00` / `10:00` | Used only if a listing has no default time in Guesty |
| `UNIT_TYPE_OVERRIDES` | `{}` | Force a type, e.g. `{"FL-9, 177 Gloucester":"2 Bedroom"}` (by nickname or listing ID) |
| `HIDDEN_LISTINGS` | — | Comma-separated nicknames/IDs to leave out |
| `CACHE_MINUTES` | `5` | How long results are reused before asking Guesty again (instant updates clear this straight away) |
| `PUBLIC_URL` | Railway domain | The app's public address, used to register the Guesty webhook. Set it to `https://schedule.yourcityscape.com` once Cloudflare is set up |
| `NEW_BOOKING_HOURS` | `24` | How long a booking keeps its **New** badge |
| `BUILDING_OVERRIDES` | `{}` | Force the building a flat is grouped under, e.g. `{"FL-18, Sheridan Buildings":"Sheridan Buildings"}` |

## How instant updates work
Guesty sends a message (webhook) to `/webhooks/guesty/<secret key>` whenever a booking is created or updated, including cancellations. The app checks Guesty's signature, clears its cache and pushes the change to every open screen. If a webhook is ever missed, open screens still check every 5 minutes and whenever a phone is unlocked or the tab is reopened.

## Run locally with sample data
```
npm run dev      # http://localhost:3000, password: test
```
Without Guesty credentials the app shows sample data built from the Cityscape property list, with a yellow banner saying so.

## Files
- `server.js` — web server, login, API routes
- `lib/guesty.js` — Guesty Open API client (token caching, pagination, retry)
- `lib/schedule.js` — builds the week, turnovers and linen totals
- `lib/mock.js` — sample data
- `public/` — the web page
