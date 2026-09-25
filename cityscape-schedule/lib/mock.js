// Sample data so the app can be previewed before Guesty credentials are added.
// Used automatically when GUESTY_CLIENT_ID / GUESTY_CLIENT_SECRET are missing, or MOCK=1.

const UNITS = [
  ['m1', 'FL-7, 177 Gloucester', '177 Gloucester Place, Marylebone, NW1 6DX', 1],
  ['m2', 'FL-8, 177 Gloucester', '177 Gloucester Place, Marylebone, NW1 6DX', 1],
  ['m3', 'FL-9, 177 Gloucester', '177 Gloucester Place, Marylebone, NW1 6DX', 2],
  ['m4', 'FL-1, 25 Old Gloucester', '25 Old Gloucester Street, London, WC1N 3AX', 1],
  ['m5', 'FL-2, 25 Old Gloucester', '25 Old Gloucester Street, London, WC1N 3AX', 1],
  ['m6', 'FL-3, 25 Old Gloucester', '25 Old Gloucester Street, London, WC1N 3AX', 0],
  ['m7', 'FL-A, 74 Queensway', '74 Queensway, London, W2 3RL', 1],
  ['m8', 'FL-B, 74 Queensway', '74 Queensway, London, W2 3RL', 2],
  ['m9', '1st Floor, 2 Rossmore Road', '1st Floor Flat, 2 Rossmore Road, Marylebone, NW1 6NJ', 1],
  ['m10', 'FL-1, 42 Bell Street', 'Flat 1, 42 Bell Street, Marylebone, NW1 5AW', 1],
  ['m11', '50A, Chalk Farm', '50A Chalk Farm Road, Camden Town, NW1 8AN', 2],
  ['m12', 'FL-1, 79 Great Titchfield', 'Flat 1, 79 Great Titchfield St, Fitzrovia, W1W 6RG', 1],
  ['m13', 'FL-18, Sheridan Buildings', 'Flat 18, Sheridan Buildings, Martlett Court, Holborn, WC2B 5SD', 0],
  ['m14', 'FL-2, 40 Balcombe Street', '40 Balcombe Street, Marylebone, NW1 6ND', 1],
];

function listings() {
  return UNITS.map(([id, nickname, full, bedrooms]) => {
    const parts = full.split(', ');
    const street = parts.find((p) => /^\d/.test(p) && !/^1st/.test(p)) || parts[0];
    return {
      _id: id, nickname, title: nickname, bedrooms, active: true,
      address: { full, street, zipcode: parts[parts.length - 1] },
      defaultCheckInTime: '15:00', defaultCheckOutTime: '10:00',
    };
  });
}

// Deterministic pseudo-random so the same week always looks the same.
function rand(seed) {
  let x = 0;
  for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
  return (x % 10000) / 10000;
}
function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// Build back-to-back stays for each unit from a fixed anchor date.
let all = null;
function buildAll() {
  const out = [];
  const anchor = '2026-08-01';
  for (const [id, , , bedrooms] of UNITS) {
    let d = addDays(anchor, Math.floor(rand(id) * 3));
    let n = 0;
    while (d < '2027-03-01') {
      const seed = id + n;
      const nights = 1 + Math.floor(rand(seed + 'n') * 5);
      const outD = addDays(d, nights);
      const outT = rand(seed + 'o') < 0.2 ? (rand(seed + 'x') < 0.5 ? '10:30' : '11:00') : null;
      const inT = rand(seed + 'i') < 0.25 ? (rand(seed + 'y') < 0.5 ? '16:00' : '18:30') : null;
      out.push({
        _id: `${id}-r${n}`, listingId: id, status: 'confirmed', confirmationCode: 'HM' + Math.floor(rand(seed + 'c') * 1e8),
        checkInDateLocalized: d, checkOutDateLocalized: outD, plannedArrival: inT, plannedDeparture: outT,
        guestsCount: 1 + Math.floor(rand(seed + 'g') * (bedrooms * 2 || 2)), nightsCount: nights,
        source: rand(seed + 's') < 0.6 ? 'Airbnb' : 'Booking.com', guest: { fullName: 'Guest ' + n },
        // Roughly 1 in 12 bookings shows as "just booked" so the New badge can be previewed.
        createdAt: new Date(Date.now() - (rand(seed + 'new') < 0.08 ? 3 : 24 * 20) * 3600e3).toISOString(),
      });
      // Sometimes a vacant night between stays
      d = rand(seed + 'gap') < 0.3 ? addDays(outD, 1) : outD;
      n++;
    }
  }
  return out;
}

function stays(from, to, statuses) {
  all = all || buildAll();
  return all.filter((r) => r.checkInDateLocalized <= to && r.checkOutDateLocalized >= from && statuses.includes(r.status));
}

module.exports = { listings, stays };
