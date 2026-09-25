// Turns Guesty listings + reservations into the day view, week board and linen totals.

const guesty = require('./guesty');

const WEEK_START_DAY = Number(process.env.WEEK_START_DAY ?? 6); // 0=Sun … 6=Sat (Cityscape weeks run Sat→Fri)
const STATUSES = (process.env.RESERVATION_STATUSES || 'confirmed').split(',').map((s) => s.trim()).filter(Boolean);
const CACHE_MS = Number(process.env.CACHE_MINUTES || 5) * 60e3;
const LISTINGS_CACHE_MS = 60 * 60e3;
const NEW_HOURS = Number(process.env.NEW_BOOKING_HOURS || 24);
const DEFAULT_CHECKIN = process.env.DEFAULT_CHECKIN_TIME || '15:00';
const DEFAULT_CHECKOUT = process.env.DEFAULT_CHECKOUT_TIME || '10:00';

function jsonEnv(name) {
  try { return JSON.parse(process.env[name] || '{}'); } catch (_) { console.warn(`[warn] ${name} is not valid JSON — ignored`); return {}; }
}
// Optional: force a unit type, e.g. UNIT_TYPE_OVERRIDES={"FL-9, 177 Gloucester":"2 Bedroom"}
const TYPE_OVERRIDES = jsonEnv('UNIT_TYPE_OVERRIDES');
// Optional: force the building a listing is grouped under, e.g. BUILDING_OVERRIDES={"FL-18, Sheridan Buildings":"Sheridan Buildings"}
const BUILDING_OVERRIDES = jsonEnv('BUILDING_OVERRIDES');
// Optional: listings to leave out (nickname or id), comma separated
const HIDDEN = (process.env.HIDDEN_LISTINGS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- dates (plain YYYY-MM-DD strings, UTC arithmetic) ----------
function todayInLondon() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}
function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function weekStartFor(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = todayInLondon();
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  return addDays(d, -((dow - WEEK_START_DAY + 7) % 7));
}

// ---------- listing helpers ----------
const override = (map, l) => map[l._id] || (l.nickname && map[l.nickname]);

function unitType(l) {
  const o = override(TYPE_OVERRIDES, l);
  if (o) return o;
  const b = l.bedrooms;
  if (b === 0) return 'Studio';
  if (typeof b === 'number' && b > 0) return `${b} Bedroom`;
  return 'Unknown';
}
function typeOrder(t) {
  if (t === 'Studio') return 0;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 99;
}

// "Flat 1, 42 Bell Street, …" → "42 Bell Street"; "Flat 18, Sheridan Buildings, …" → "Sheridan Buildings"
const FLAT_PART = /^(flat|apt\.?|apartment|unit|fl-?|room|studio|\d+(st|nd|rd|th)\s+floor|ground floor|basement)\b[^,]*$/i;
function cleanStreet(s) {
  return (s || '').split(',').map((x) => x.trim()).filter((x) => x && !FLAT_PART.test(x))[0] || '';
}
function buildingOf(l) {
  const o = override(BUILDING_OVERRIDES, l);
  if (o) return o;
  const a = l.address || {};
  return cleanStreet(a.street) || cleanStreet(a.full) || l.nickname || 'Other';
}
function postcodeOf(l) {
  const a = l.address || {};
  if (a.zipcode) return a.zipcode;
  const m = (a.full || '').match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i);
  return m ? m[0].toUpperCase() : '';
}
// "FL-8, 177 Gloucester" → "FL-8"; "50A, Chalk Farm" → "50A"; "Sheridan 18" → "Sheridan 18"
function unitLabel(l) {
  const n = l.nickname || l.title || 'Unit';
  return n.includes(',') ? n.split(',')[0].trim() : n;
}
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
// Buildings sort by street name, ignoring the house number ("177 Gloucester Place" → "Gloucester Place")
const streetKey = (name) => name.replace(/^\d+[a-z]?\s+/i, '');
const byBuilding = (a, b) => natural(streetKey(a), streetKey(b)) || natural(a, b);

// ---------- time formatting ----------
function fmtTime(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}/.test(hhmm)) return null;
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}.${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`;
}

// ---------- caches ----------
let listingsCache = { at: 0, data: null };
const weekCache = new Map();
function clearCaches({ listings = false } = {}) {
  weekCache.clear();
  if (listings) listingsCache = { at: 0, data: null };
}

async function getListings(fresh) {
  if (!fresh && listingsCache.data && Date.now() - listingsCache.at < LISTINGS_CACHE_MS) return listingsCache.data;
  const raw = await guesty.listListings();
  const map = new Map();
  for (const l of raw) {
    if (l.active === false) continue;
    if (HIDDEN.includes(l._id) || HIDDEN.includes(l.nickname)) continue;
    map.set(l._id, {
      id: l._id,
      name: l.nickname || l.title || 'Unnamed listing',
      label: unitLabel(l),
      building: buildingOf(l),
      postcode: postcodeOf(l),
      address: (l.address && l.address.full) || '',
      unitType: unitType(l),
      checkInTime: l.defaultCheckInTime || DEFAULT_CHECKIN,
      checkOutTime: l.defaultCheckOutTime || DEFAULT_CHECKOUT,
    });
  }
  listingsCache = { at: Date.now(), data: map };
  return map;
}

function isNew(r) {
  return Boolean(r.createdAt) && Date.now() - new Date(r.createdAt).getTime() < NEW_HOURS * 3600e3;
}

function event(r, listing, kind) {
  const planned = kind === 'in' ? r.plannedArrival : r.plannedDeparture;
  const fallback = kind === 'in' ? listing.checkInTime : listing.checkOutTime;
  return {
    reservationId: r._id,
    code: r.confirmationCode || '',
    time: fmtTime(planned || fallback),
    timeRaw: planned || fallback,
    planned: Boolean(planned),
    guests: r.guestsCount || null,
    nights: r.nightsCount || null,
    source: r.source || '',
    isNew: isNew(r),
  };
}

async function buildWeek(start, { fresh = false } = {}) {
  const key = start + '|' + STATUSES.join(',');
  const cached = weekCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const end = addDays(start, 6);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const [listings, stays] = await Promise.all([getListings(fresh), guesty.listStays(start, end, STATUSES)]);

  // grid[listingId][date] = { occ, out, in }
  const grid = new Map();
  const cell = (id, date) => {
    if (!grid.has(id)) grid.set(id, Object.fromEntries(dates.map((d) => [d, { occ: false, out: null, in: null }])));
    return grid.get(id)[date];
  };

  const unknownListings = new Set();
  for (const r of stays) {
    const listing = listings.get(r.listingId);
    if (!listing) { unknownListings.add(r.listingId); continue; }
    const ci = r.checkInDateLocalized, co = r.checkOutDateLocalized;
    for (const d of dates) {
      if (d >= ci && d < co) cell(r.listingId, d).occ = true; // guest sleeps there that night
    }
    if (ci >= start && ci <= end) cell(r.listingId, ci).in = event(r, listing, 'in');
    if (co >= start && co <= end) cell(r.listingId, co).out = event(r, listing, 'out');
  }

  // ---- day view ----
  const linen = {};
  let checkOuts = 0, checkIns = 0, turnovers = 0, newBookings = 0;
  const days = dates.map((date) => {
    const units = [];
    const dayLinen = {};
    for (const [id, cells] of grid) {
      const c = cells[date];
      if (!c.out && !c.in) continue;
      const l = listings.get(id);
      units.push({ listingId: id, name: l.name, label: l.label, building: l.building, postcode: l.postcode, address: l.address, unitType: l.unitType, checkOut: c.out, checkIn: c.in });
      if (c.out) {
        checkOuts++;
        linen[l.unitType] = (linen[l.unitType] || 0) + 1; // Linen rule: 1 set per check-out
        dayLinen[l.unitType] = (dayLinen[l.unitType] || 0) + 1;
      }
      if (c.in) { checkIns++; if (c.in.isNew) newBookings++; }
      if (c.in && c.out) turnovers++;
    }
    units.sort((a, b) => byBuilding(a.building, b.building) || natural(a.label, b.label));
    return {
      date,
      units,
      linen: dayLinen,
      cleans: units.filter((u) => u.checkOut).length,
      arrivals: units.filter((u) => u.checkIn).length,
      turnovers: units.filter((u) => u.checkIn && u.checkOut).length,
      hasNew: units.some((u) => (u.checkIn && u.checkIn.isNew) || (u.checkOut && u.checkOut.isNew)),
    };
  });

  // ---- week board: every active listing, grouped by building ----
  const buildings = new Map();
  for (const l of listings.values()) {
    if (!buildings.has(l.building)) buildings.set(l.building, { name: l.building, postcode: l.postcode, units: [] });
    const cells = grid.get(l.id) || {};
    buildings.get(l.building).units.push({
      listingId: l.id, label: l.label, name: l.name, unitType: l.unitType,
      cells: dates.map((d) => cells[d] || { occ: false, out: null, in: null }),
    });
  }
  const board = [...buildings.values()].sort((a, b) => byBuilding(a.name, b.name));
  for (const b of board) b.units.sort((x, y) => natural(x.label, y.label));

  const linenRows = ['2 Bedroom', '1 Bedroom', 'Studio', ...Object.keys(linen)]
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .map((type) => ({ type, sets: linen[type] || 0 }))
    .sort((a, b) => typeOrder(b.type) - typeOrder(a.type));

  if (unknownListings.size) console.warn('[warn] reservations for listings not in the active list:', [...unknownListings].join(', '));

  const data = {
    weekStart: start,
    weekEnd: end,
    dates,
    prevWeek: addDays(start, -7),
    nextWeek: addDays(start, 7),
    today: todayInLondon(),
    generatedAt: new Date().toISOString(),
    mock: guesty.isMock(),
    statuses: STATUSES,
    newHours: NEW_HOURS,
    totals: { checkOuts, checkIns, turnovers, linenSets: checkOuts, newBookings },
    linen: linenRows,
    days,
    board,
    warnings: [
      ...[...listings.values()].filter((l) => l.unitType === 'Unknown').map((l) => `“${l.name}” has no bedroom count in Guesty, so its linen is counted as “Unknown”.`),
      ...(unknownListings.size ? [`${unknownListings.size} booking(s) belong to inactive or hidden listings and are not shown.`] : []),
    ],
  };
  weekCache.set(key, { at: Date.now(), data });
  if (weekCache.size > 30) weekCache.delete(weekCache.keys().next().value);
  return data;
}

async function buildProperties({ fresh = false } = {}) {
  const listings = await getListings(fresh);
  const groups = new Map();
  for (const l of listings.values()) {
    if (!groups.has(l.building)) groups.set(l.building, { name: l.building, postcode: l.postcode, units: [] });
    groups.get(l.building).units.push({ id: l.id, name: l.name, label: l.label, address: l.address, unitType: l.unitType, checkIn: fmtTime(l.checkInTime), checkOut: fmtTime(l.checkOutTime) });
  }
  const buildings = [...groups.values()].sort((a, b) => byBuilding(a.name, b.name));
  for (const b of buildings) b.units.sort((x, y) => natural(x.label, y.label));
  const counts = {};
  for (const l of listings.values()) counts[l.unitType] = (counts[l.unitType] || 0) + 1;
  return { buildings, total: listings.size, counts, mock: guesty.isMock() };
}

module.exports = { buildWeek, buildProperties, weekStartFor, todayInLondon, addDays, clearCaches, cleanStreet, unitLabel, fmtTime };
