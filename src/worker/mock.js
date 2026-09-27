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
