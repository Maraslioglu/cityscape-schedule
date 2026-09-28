(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const D = (s) => new Date(s + 'T00:00:00Z');
  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts });
  const WD_SHORT = fmt({ weekday: 'short' }), WD_LONG = fmt({ weekday: 'long' }), MON = fmt({ month: 'long' }), MON_S = fmt({ month: 'short' });
  const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
  const longDate = (s) => `${WD_LONG.format(D(s))}, ${ordinal(D(s).getUTCDate())} ${MON.format(D(s))}`;
  const shortDate = (s) => `${D(s).getUTCDate()} ${MON_S.format(D(s))}`;
  const compact = (t) => (t || '').replace(' ', '');
  const shortType = (t) => ({ 'Studio': 'Studio', '1 Bedroom': '1 bed', '2 Bedroom': '2 bed', '3 Bedroom': '3 bed' }[t] || t);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} } };
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));

  let data = null;          // week on screen
  let view = store.get('cs_view') || 'day';
  let me = null;            // signed-in person and their permissions
  const can = (perm) => Boolean(me && me.perms && me.perms[perm]);
  const VIEW_PERM = { day: 'view_day', board: 'view_board', props: 'view_properties', cleaning: 'view_cleaning', damage: 'view_cleaning', users: 'manage_users', settings: null, account: null };
  // Admin and User roles run the operation: Settings/integrations and assigning cleanings (checked again on the server).
  const isManager = () => Boolean(me && (me.role === 'admin' || me.role === 'user'));
  const allowed = (v) => v in VIEW_PERM && (v === 'settings' ? isManager() : (!VIEW_PERM[v] || can(VIEW_PERM[v]) || ((v === 'cleaning' || v === 'damage') && can('manage_damage'))));
  // Sidebar: Schedule holds the Day and Week views; each other entry is one view.
  const NAV_OF = { day: 'schedule', board: 'schedule', cleaning: 'cleaning', damage: 'damage', props: 'props', users: 'users', settings: 'settings' };
  const navAllowed = (n) => (n === 'schedule' ? allowed('day') || allowed('board') : allowed(n));
  const TITLES = { day: 'Schedule', board: 'Schedule', cleaning: 'Cleaning log', damage: 'Damage reports', props: 'Properties', users: 'Users', settings: 'Settings', account: 'My account' };
  let lastSched = store.get('cs_sched') || 'day';
  let selected = null;      // selected date in day view
  let version = null;       // bookings version from the server
  let boardDirty = true;    // board is rebuilt only when it's actually shown
  let props = null;
  const weeks = new Map();  // weekStart → data (instant back/forward)
  const inflight = new Map();

  function toast(msg) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Could not load the schedule');
    return body;
  }

  // Weeks are keyed by their start date; "" means "the week containing today".
  function fetchWeek(date, fresh = false) {
    const key = (date || 'now') + (fresh ? ':fresh' : '');
    if (inflight.has(key)) return inflight.get(key);
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    if (fresh) q.set('refresh', '1');
    const p = getJSON('/api/week?' + q).then((w) => { weeks.set(w.weekStart, w); version = w.version; return w; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  function prefetchAround(w) {
    idle(() => { for (const d of [w.nextWeek, w.prevWeek]) if (!weeks.has(d)) fetchWeek(d).catch(() => {}); });
  }

  const signature = (w) => w && JSON.stringify([w.version, w.weekStart, w.today, w.totals, w.days.map((d) => [d.cleans, d.arrivals, d.hasNew])]);

  let navToken = 0;
  async function showWeek(date, { fresh = false, quiet = false } = {}) {
    const my = ++navToken;
    const cached = !fresh && date && weeks.get(date);
    if (cached) apply(cached);                        // instant from memory
    else document.body.classList.add('is-loading');   // keep old week visible, just dimmed
    try {
      const w = await fetchWeek(date, fresh);
      if (my === navToken) apply(w); // ignore answers for weeks the user has already moved past
      prefetchAround(w);
      if (fresh && !quiet) toast('Up to date with Guesty');
    } catch (e) {
      if (e.message !== 'signed out') $('banners').innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
    } finally {
      document.body.classList.remove('is-loading');
    }
  }

  function apply(w) {
    const same = data && signature(data) === signature(w);
    const weekChanged = !data || data.weekStart !== w.weekStart;
    data = w;
    if (weekChanged || !data.dates.includes(selected)) selected = data.dates.includes(data.today) ? data.today : data.dates[0];
    history.replaceState(null, '', data.dates.includes(data.today) ? location.pathname : `?week=${data.weekStart}`);
    if (same && !weekChanged) { renderFoot(); return; } // nothing changed: don't touch the screen
    boardDirty = true;
    render();
  }

  // ---------- rendering ----------
  function render() {
    const { weekStart, weekEnd, today, totals, linen, warnings, mock } = data;
    const isThisWeek = data.dates.includes(today);
    $('week-title').textContent = `${shortDate(weekStart)} – ${shortDate(weekEnd)}`;
    $('when').textContent = isThisWeek ? 'This week' : weekStart > today ? 'Upcoming' : 'Past week';
    $('this').classList.toggle('hidden', isThisWeek);
    $('newpill').innerHTML = totals.newBookings ? `<span class="newpill">${totals.newBookings} new booking${totals.newBookings > 1 ? 's' : ''}</span>` : '';

    const banners = [];
    if (mock) banners.push('<div class="banner">Showing <b>sample data</b>. Add your Guesty keys in Railway to see live bookings.</div>');
    for (const w of warnings || []) banners.push(`<div class="banner">${esc(w)}</div>`);
    $('banners').innerHTML = banners.join('');

    $('m-out').textContent = totals.checkOuts;
    $('m-in').textContent = totals.checkIns;
    $('m-turn').textContent = totals.turnovers;
    if (totals.linenSets !== null) $('m-linen').innerHTML = linen.map((r) => `<div class="item"><div class="v">${r.sets}</div><div class="t">${esc(r.type)}</div></div>`).join('') +
      `<div class="item total"><div class="v">${totals.linenSets}</div><div class="t">Total sets</div></div>`;

    renderStrip();
    renderDay();
    if (view === 'board') renderBoard();
    renderFoot();
  }

  function renderFoot() {
    const at = new Date(data.generatedAt);
    $('foot').textContent = `Bookings last checked with Guesty at ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${data.statuses.join(' + ')} bookings only`;
  }

  function renderStrip() {
    $('strip').innerHTML = data.days.map((d) => {
      const cls = ['dbtn', d.date === data.today ? 'today' : '', d.date < data.today ? 'past' : ''].join(' ');
      return `<button class="${cls}" role="tab" aria-selected="${d.date === selected}" data-date="${d.date}">
        ${d.hasNew ? '<i class="newdot" title="New booking"></i>' : ''}
        <div class="dn">${WD_SHORT.format(D(d.date))}</div>
        <div class="dd">${D(d.date).getUTCDate()}</div>
        <div class="dc"><b>${d.cleans}</b><span class="lbl"> out</span><span class="sep"> · </span><em>${d.arrivals}</em><span class="lbl"> in</span></div>
      </button>`;
    }).join('');
  }
  $('strip').addEventListener('click', (e) => {
    const b = e.target.closest('.dbtn');
    if (!b || b.dataset.date === selected) return;
    selected = b.dataset.date;
    $('strip').querySelectorAll('.dbtn').forEach((x) => x.setAttribute('aria-selected', x === b));
    renderDay();
  });

  function chip(kind, e) {
    if (!e) return '';
    return `<span class="chip ${kind}">${kind === 'out' ? 'Out' : 'In'} ${esc(e.time || '—')}${e.planned ? ' <small>planned</small>' : ''}</span>`;
  }
  function groupByBuilding(units) {
    const map = new Map();
    for (const u of units) {
      if (!map.has(u.building)) map.set(u.building, { name: u.building, postcode: u.postcode, units: [] });
      map.get(u.building).units.push(u);
    }
    return [...map.values()];
  }
  function section(kind, title, hint, units) {
    if (!units.length) return '';
    const groups = groupByBuilding(units).map((g) => `
      <div class="bldg">
        <div class="bldg-name">${esc(g.name)}<span>${esc(g.postcode)}</span></div>
        ${g.units.map((u) => {
          const isNew = (u.checkIn && u.checkIn.isNew) || (u.checkOut && u.checkOut.isNew);
          const guests = u.checkIn && u.checkIn.guests ? `${u.checkIn.guests} guest${u.checkIn.guests > 1 ? 's' : ''}` : '';
          return `<div class="row tap" data-listing="${esc(u.listingId)}" role="button" tabindex="0" aria-label="Open ${esc(u.label)}">
            <span class="u">${esc(u.label)}</span>
            <span class="t">${esc(shortType(u.unitType))}</span>
            ${guests ? `<span class="g">· ${guests}</span>` : ''}
            ${isNew ? '<span class="new">New</span>' : ''}
            <span class="cbadge" data-cbadge="${esc(u.listingId)}"></span><span data-achip="${esc(u.listingId)}"></span>
            <span class="times">${chip('out', u.checkOut)}${u.checkOut && u.checkIn ? '<span class="arrow">→</span>' : ''}${chip('in', u.checkIn)}</span>
          </div>`;
        }).join('')}
      </div>`).join('');
    return `<div class="section s-${kind}">
      <div class="shead"><span class="bar"></span><h3>${title}</h3><span class="count">${units.length}</span><span class="hint">${hint}</span></div>
      ${groups}
    </div>`;
  }
  function renderDay() {
    const day = data.days.find((d) => d.date === selected);
    if (!day) return;
    const turn = day.units.filter((u) => u.checkOut && u.checkIn);
    const outs = day.units.filter((u) => u.checkOut && !u.checkIn);
    const ins = day.units.filter((u) => !u.checkOut && u.checkIn);
    const linenBits = Object.entries(day.linen).map(([t, n]) => `${esc(shortType(t))} <b>${n}</b>`).join(' · ');
    $('daypanel').innerHTML = `
      <div class="dayhead"><h2>${esc(longDate(day.date))}</h2>${linenBits ? `<span class="dlinen">Linen: ${linenBits}</span>` : ''}</div>
      ${day.units.length ? '' : '<div class="empty"><b>Nothing scheduled</b>No check-ins or check-outs on this day.</div>'}
      ${section('turn', 'Same-day turnovers', 'Clean between check-out and check-in', turn)}
      ${section('out', 'Check-outs', 'Clean — nobody arriving today', outs)}
      ${section('in', 'Arrivals', 'Make sure the flat is ready', ins)}`;
    decorateDay();
  }

  function renderBoard() {
    boardDirty = false;
    const { dates, days, board, today } = data;
    const head = `<colgroup><col class="first">${dates.map(() => '<col>').join('')}</colgroup>
      <thead><tr><th class="first-col"></th>${days.map((d) => `<th class="${d.date === today ? 'today' : ''}"><button data-date="${d.date}" title="Open ${esc(longDate(d.date))}">
        <div class="dn">${WD_SHORT.format(D(d.date))}</div><div class="dd">${D(d.date).getUTCDate()}</div><div class="dc">${d.cleans} out · ${d.arrivals} in</div></button></th>`).join('')}</tr></thead>`;
    const body = board.map((b) => `
      <tr class="b-row"><td colspan="${dates.length + 1}"><div class="b-name">${esc(b.name)}<span>${esc(b.postcode)}</span></div></td></tr>
      ${b.units.map((u) => `<tr>
        <td class="first-col unit"><span class="u">${esc(u.label)}</span><span class="t">${esc(shortType(u.unitType))}</span></td>
        ${u.cells.map((c, i) => {
          const morning = Boolean(c.out) || (c.occ && !c.in);
          const night = c.occ;
          let h = '';
          if (morning) h += `<div class="half l${c.out ? ' end' : ''}"></div>`;
          if (night) h += `<div class="half r${c.in ? ' start' : ''}${c.in && c.in.isNew ? ' isnew' : ''}"></div>`;
          if (c.out && c.in) h += `<span class="mark turn" title="Out ${esc(c.out.time)} → In ${esc(c.in.time)}">${esc(compact(c.out.time).replace(/am|pm/, ''))}→${esc(compact(c.in.time).replace(/am|pm/, ''))}</span>`;
          else if (c.out) h += `<span class="mark out" title="Check-out ${esc(c.out.time)}">${esc(compact(c.out.time))}</span>`;
          else if (c.in) h += `<span class="mark in" title="Check-in ${esc(c.in.time)}">${esc(compact(c.in.time))}</span>`;
          return `<td class="cell${dates[i] === today ? ' today' : ''}">${h}</td>`;
        }).join('')}
      </tr>`).join('')}`).join('');
    const foot = `<tfoot>
      <tr><td class="first-col">Cleans</td>${days.map((d) => `<td class="o">${d.cleans || '–'}</td>`).join('')}</tr>
      <tr><td class="first-col">Arrivals</td>${days.map((d) => `<td class="i">${d.arrivals || '–'}</td>`).join('')}</tr>
    </tfoot>`;
    $('board').innerHTML = head + `<tbody>${body}</tbody>` + foot;
  }
  $('board').addEventListener('click', (e) => {
    const b = e.target.closest('thead button');
    if (!b) return;
    selected = b.dataset.date;
    setView('day');
    renderStrip(); renderDay();
  });

  async function loadProps() {
    try {
      if (!props) $('props').innerHTML = '<div class="loading">Loading…</div>';
      const p = await getJSON('/api/properties');
      if (props && JSON.stringify(p) === JSON.stringify(props)) return;
      props = p;
      const counts = Object.entries(p.counts).map(([t, n]) => `${n} × ${shortType(t)}`).join(' · ');
      $('props-sub').textContent = `${p.total} flats · ${counts}`;
      $('props').innerHTML = p.buildings.map((b) => `<div class="card pcard">
        <h3>${esc(b.name)}</h3><div class="pc">${esc(b.postcode)}</div>
        ${b.units.map((u) => `<div class="prow" title="${esc(u.address)}"><span class="u">${esc(u.label)}</span><span>${esc(shortType(u.unitType))}</span><span class="t">Out ${esc(u.checkOut)} · In ${esc(u.checkIn)}</span></div>${u.keyMode === 'lockbox' ? `<div class="pnote"><span class="kbadge">Lockbox</span><span>${u.lockbox ? `Code <b>${esc(u.lockbox.code)}</b> · set by ${esc(u.lockbox.by)}, ${esc(fmtWhen(u.lockbox.at))}` : 'No code recorded yet'}</span></div>` : u.keyMode === 'keynest' ? '<div class="pnote"><span class="kbadge kn">KeyNest</span><span>Key must be back in KeyNest after each clean</span></div>' : ''}`).join('')}
      </div>`).join('');
      // KeyNest flats that aren't linked to a KeyNest key can't be completed by cleaners: say so at the top.
      const kn = p.keynest || { unlinked: [] };
      const many = kn.unlinked.length > 1;
      const fix = p.canManage ? `<button class="linkbtn inline" id="kn-fix">${kn.connected ? `Link ${many ? 'them' : 'it'}` : 'Set it up'} in Settings › Integrations › KeyNest</button>` : `Ask an Admin to ${kn.connected ? `link ${many ? 'them' : 'it'}` : 'connect KeyNest'}.`;
      $('props-banner').innerHTML = !kn.unlinked.length ? '' : `<div class="banner warn-banner"><b>${kn.connected ? `${kn.unlinked.length} KeyNest flat${kn.unlinked.length > 1 ? 's aren’t' : ' isn’t'} linked to a KeyNest key` : 'KeyNest isn’t connected yet'}.</b>
        Cleaners can’t complete ${many ? 'these flats' : 'this flat'} until ${kn.connected ? (many ? 'they’re linked' : 'it’s linked') : 'KeyNest is connected'}:
        ${kn.unlinked.map((f) => `<span class="flat-chip">${esc(f.label)} <span>· ${esc(f.building)}</span></span>`).join(' ')} ${fix}</div>`;
      $('nd-props').classList.toggle('hidden', !kn.unlinked.length);
      if ($('kn-fix')) $('kn-fix').onclick = () => { setView('settings'); setTimeout(() => { const el = $('settings-keynest'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300); };
    } catch (e) {
      if (e.message !== 'signed out') $('props').innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
    }
  }

  function fmtWhen(iso) { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }

  // ---------- Settings › Integrations › KeyNest (Admin and User roles) ----------
  // Locked by default: "Edit links" unlocks the rows, and nothing is saved until the changes are reviewed and confirmed.
  let kn = null, knEdit = false, knDraft = {};
  async function loadSettings() {
    const box = $('settings-keynest');
    try {
      kn = await getJSON('/api/keynest');
      knEdit = false; knDraft = {};
      renderKeynest();
    } catch (e) { if (e.message !== 'signed out') box.innerHTML = `<h3>KeyNest</h3><div class="banner error">${esc(e.message)}</div>`; }
  }
  const keyName = (id) => { const k = kn && kn.keys.find((x) => x.id === id); return k ? (k.name || k.id) : id ? `Key ${id}` : 'Not linked'; };
  function renderKeynest() {
    const box = $('settings-keynest');
    const k = kn;
    const live = k.connected && !k.error;
    const changes = Object.entries(knDraft).filter(([id, keyId]) => (k.flats.find((f) => f.id === id) || {}).keyId !== keyId);
    const opts = (sel) => `<option value="">Not linked</option>${k.keys.map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name || x.id)}${x.status ? ' · ' + esc(x.status) : ''}</option>`).join('')}`;
    const rows = k.flats.map((f) => {
      const cur = f.id in knDraft ? knDraft[f.id] : f.keyId;
      const changed = f.id in knDraft && knDraft[f.id] !== f.keyId;
      return `<tr class="${changed ? 'changed' : ''}"><td><b>${esc(f.label)}</b><span class="muted"> · ${esc(f.building)}</span></td>
        <td>${knEdit && live ? `<select data-kn="${esc(f.id)}">${opts(cur)}</select>` : cur ? `${esc(keyName(cur))}${f.how === 'auto' ? ' <span class="muted">· matched by name</span>' : ''}` : '<span class="warn">Not linked</span>'}</td></tr>`;
    }).join('');
    box.innerHTML = `<div class="set-head"><div><h3>KeyNest</h3>
        <p class="muted">Flats tagged <b>KEYNEST</b> in Guesty are linked to their KeyNest key here. A cleaner can only complete a KeyNest flat once KeyNest shows its key in the store (it doesn’t have to have moved, so spare keys are fine).</p></div>
        <span class="pill ${live ? 'ok' : 'off'}">${live ? 'Connected' : k.connected ? 'Error' : 'Not connected'}</span></div>
      ${!k.connected ? '<div class="banner">Not connected yet. Add <b>KEYNEST_API_KEY</b> in Railway (Variables) and the app connects automatically. Until then, KeyNest flats can’t be completed.</div>' : k.error ? `<div class="banner error">${esc(k.error)}</div>` : ''}
      ${k.flats.length ? `<table class="kn-table"><thead><tr><th>Flat</th><th>KeyNest key</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No flats have the KEYNEST tag in Guesty.</p>'}
      <div class="set-actions" id="kn-actions">${!live || !k.flats.length ? '' : !knEdit
        ? '<button class="btn" id="kn-edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>Edit links</button><span class="muted">Locked to prevent accidental changes.</span>'
        : `<span class="edit-note">Editing — changes aren’t saved until you confirm.</span><span class="spacer"></span><button class="btn" id="kn-cancel">Cancel</button><button class="btn primary" id="kn-review" ${changes.length ? '' : 'disabled'}>Review ${changes.length || ''} change${changes.length === 1 ? '' : 's'}</button>`}</div>
      <div id="kn-confirm"></div>
      ${k.webhookUrl ? `<details class="muted kn-hook"><summary>Key movement record ${k.lastHook ? `· last message from KeyNest ${esc(fmtWhen(k.lastHook.at))}` : '· no messages from KeyNest yet'}</summary>To record when keys are collected and dropped off (shown in each cleaning’s details), add this webhook address in KeyNest: <code>${esc(k.webhookUrl)}</code></details>` : ''}`;
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('kn-edit', () => { knEdit = true; knDraft = {}; renderKeynest(); });
    on('kn-cancel', () => { knEdit = false; knDraft = {}; renderKeynest(); });
    box.querySelectorAll('select[data-kn]').forEach((s) => { s.onchange = () => { knDraft[s.dataset.kn] = s.value || null; renderKeynest(); }; });
    on('kn-review', () => {
      $('kn-confirm').innerHTML = `<div class="confirm-box"><b>Save ${changes.length} KeyNest change${changes.length === 1 ? '' : 's'}?</b>
        <ul>${changes.map(([id, keyId]) => { const f = k.flats.find((x) => x.id === id); return `<li><b>${esc(f.label)}</b> <span class="muted">· ${esc(f.building)}</span>: ${esc(keyName(f.keyId))} → <b>${esc(keyName(keyId))}</b></li>`; }).join('')}</ul>
        <p class="muted">Cleaners use these links to finish KeyNest flats. A wrong link means the wrong key is checked.</p>
        <div class="form-actions"><button class="btn primary" id="kn-save">Yes, save changes</button><button class="btn" id="kn-back">Go back</button></div></div>`;
      $('kn-back').onclick = () => { $('kn-confirm').innerHTML = ''; };
      $('kn-save').onclick = async () => {
        $('kn-save').disabled = true;
        try {
          await send('PUT', '/api/keynest/links', { confirmed: true, changes: changes.map(([listingId, keyId]) => ({ listingId, keyId })) });
          toast('KeyNest links saved ✓'); props = null; await loadSettings(); refreshBadges();
        } catch (e) { toast(e.message); $('kn-save').disabled = false; }
      };
    });
  }

  // ---------- text for WhatsApp ----------
  function dayText(day) {
    const lines = [`_${longDate(day.date)}_`];
    if (!day.units.length) { lines.push('- Nothing scheduled'); return lines; }
    for (const g of groupByBuilding(day.units)) {
      for (const u of g.units) {
        const parts = [];
        if (u.checkOut) parts.push(`Check-out at ${u.checkOut.time}`);
        if (u.checkIn) parts.push(`Check-in at ${u.checkIn.time}`);
        lines.push(`- *${u.name}* - ${parts.join(' | ')}${(u.checkIn && u.checkIn.isNew) ? ' (NEW)' : ''}`);
      }
    }
    const linen = Object.entries(day.linen).map(([t, n]) => `${t}: ${n}`).join(', ');
    if (linen) lines.push(`Linen: ${linen}`);
    return lines;
  }
  function weekText() {
    const lines = [`*Cityscape Schedule* — ${longDate(data.weekStart)} to ${longDate(data.weekEnd)}`, '', '*Laundry*'];
    for (const r of data.linen) lines.push(`${r.type}: ${r.sets}`);
    lines.push(`Total: ${data.totals.linenSets}`, '', '*Cleaning*');
    for (const d of data.days) lines.push('', ...dayText(d));
    return lines.join('\n');
  }

  // ---------- views ----------
  function setView(v) {
    if (!allowed(v)) v = ['day', 'board', 'props', 'account'].find(allowed);
    view = v;
    store.set('cs_view', v);
    if (v === 'day' || v === 'board') { lastSched = v; store.set('cs_sched', v); }
    document.querySelectorAll('.snav [data-nav]').forEach((b) => { if (b.dataset.nav === NAV_OF[v]) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    document.querySelectorAll('.range [data-range]').forEach((b) => b.setAttribute('aria-selected', b.dataset.range === v));
    $('me-btn').setAttribute('aria-current', v === 'account' ? 'page' : 'false');
    $('me-btn2').setAttribute('aria-selected', v === 'account');
    $('page-title').textContent = TITLES[v] || '';
    closeCopyMenu();
    $('week-area').classList.toggle('hidden', !(v === 'day' || v === 'board'));
    $('view-day').classList.toggle('hidden', v !== 'day');
    $('view-board').classList.toggle('hidden', v !== 'board');
    $('view-props').classList.toggle('hidden', v !== 'props');
    $('view-users').classList.toggle('hidden', v !== 'users');
    $('view-cleaning').classList.toggle('hidden', v !== 'cleaning');
    $('view-account').classList.toggle('hidden', v !== 'account');
    $('view-settings').classList.toggle('hidden', v !== 'settings');
    $('view-damage').classList.toggle('hidden', v !== 'damage');
    $('foot').classList.toggle('hidden', !(v === 'day' || v === 'board'));
    if (v === 'board' && data && boardDirty) renderBoard();
    if (v === 'props') loadProps();
    if (v === 'users') loadUsers();
    if (v === 'cleaning') loadCleaningView();
    if (v === 'account') renderAccount();
    if (v === 'settings') loadSettings();
    if (v === 'damage') loadDamageView();
  }

  // ---------- who's signed in ----------
  const initials = (n) => (n || '?').split(/\s+/).filter((w) => /^[a-z]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  function applyPermissions() {
    document.querySelectorAll('.snav [data-nav]').forEach((b) => b.classList.toggle('hidden', !navAllowed(b.dataset.nav)));
    document.querySelectorAll('.snav .nlbl').forEach((l) => l.classList.toggle('hidden', !document.querySelector(`.snav [data-nav][data-group="${l.dataset.group}"]:not(.hidden)`)));
    document.querySelector('.range [data-range="day"]').classList.toggle('hidden', !allowed('day'));
    document.querySelector('.range [data-range="board"]').classList.toggle('hidden', !allowed('board'));
    document.querySelector('.copy-wrap').classList.toggle('hidden', !can('copy_print'));
    document.querySelector('.metric.linen').classList.toggle('hidden', !can('view_linen'));
    document.querySelector('.summary').classList.toggle('no-linen', !can('view_linen'));
    $('me-avatar').textContent = initials(me.name);
    $('me-avatar2').textContent = initials(me.name);
    $('me-name').textContent = me.name;
    $('me-role').textContent = `${(me.role || '').replace(/^./, (c) => c.toUpperCase())} · ${me.buildings === 'all' ? 'All buildings' : (me.buildings || []).length === 1 ? me.buildings[0] : `${(me.buildings || []).length} buildings`}`;
  }
  function renderAccount() {
    const b = me.buildings === 'all' ? 'All buildings' : (me.buildings.length ? me.buildings.map(esc).join(', ') : 'None assigned yet');
    const perms = (window.__permsList || []).filter(([k]) => can(k)).map(([, label]) => esc(label)).join(', ');
    $('acct-info').innerHTML = `<h3>${esc(me.name)}</h3><dl>
      <dt>Username</dt><dd>${esc(me.username)}</dd>
      <dt>Role</dt><dd style="text-transform:capitalize">${esc(me.role)}</dd>
      <dt>Email</dt><dd>${esc(me.email || '—')}</dd>
      <dt>Buildings</dt><dd>${b}</dd>
      <dt>Can use</dt><dd>${perms || '—'}</dd></dl>`;
    $('pw-form').classList.toggle('hidden', !!me.isOwner);
  }
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('pw-msg');
    if ($('pw-new').value !== $('pw-new2').value) { msg.className = 'form-msg err'; msg.textContent = 'The two new passwords don’t match.'; return; }
    try {
      await send('POST', '/api/me/password', { current: $('pw-cur').value, password: $('pw-new').value });
      e.target.reset(); msg.className = 'form-msg ok'; msg.textContent = 'Password changed. Other devices have been signed out.';
    } catch (err) { msg.className = 'form-msg err'; msg.textContent = err.message; }
  });

  async function send(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'Something went wrong');
    return out;
  }

  // ---------- users (admins) ----------
  let U = null;          // { users, perms, roles, defaults, buildings }
  let editing = null;    // user id being edited, 'new', or null
  const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', user: 'User', cleaner: 'Cleaner' };
  const when = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never';
  async function loadUsers() {
    try { U = await getJSON('/api/users'); renderUsers(); }
    catch (e) { if (e.message !== 'signed out') $('users-msg').innerHTML = `<div class="banner error">${esc(e.message)}</div>`; }
  }
  function renderUsers() {
    const active = U.users.filter((u) => u.active).length;
    $('users-sub').textContent = `${active} active · owner recovery login not listed`;
    $('users-list').innerHTML = U.users.length ? U.users.map((u) => `
      <tr class="${u.id === editing ? 'sel' : ''} ${u.active ? '' : 'off'}">
        <td class="who"><b>${esc(u.name)}</b><span>${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}${u.active ? '' : ' · deactivated'}</span></td>
        <td><span class="role ${u.role}">${ROLE_LABEL[u.role] || esc(u.role)}</span></td>
        <td class="hide-sm">${u.buildings === 'all' ? 'All' : u.buildings.length ? esc(u.buildings.length + ' building' + (u.buildings.length > 1 ? 's' : '')) : '<span style="color:var(--out)">None yet</span>'}</td>
        <td class="hide-sm">${when(u.lastLoginAt)}</td>
        <td><button class="btn" data-edit="${u.id}">Edit</button></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty"><b>No users yet</b>Click “Add user” to create the first account.</td></tr>';
    if (editing) renderForm(); else { $('user-form').classList.add('hidden'); document.querySelector('.users-layout').classList.remove('editing'); }
  }
  $('users-list').addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) { editing = b.dataset.edit; renderUsers(); } });
  $('add-user').onclick = () => { editing = 'new'; renderUsers(); $('uf-name').focus(); };

  function genPassword() {
    const words = ['maple', 'harbour', 'linen', 'cobalt', 'willow', 'amber', 'granite', 'orchid', 'copper', 'saffron', 'meadow', 'pebble'];
    const r = crypto.getRandomValues(new Uint32Array(3));
    return words[r[0] % words.length][0].toUpperCase() + words[r[0] % words.length].slice(1) + '-' + words[r[1] % words.length] + '-' + (100 + (r[2] % 900));
  }
  function renderForm() {
    const isNew = editing === 'new';
    const u = isNew ? { name: '', username: '', email: '', role: 'user', active: true, ...U.defaults.user } : U.users.find((x) => x.id === editing);
    if (!u) { editing = null; return renderUsers(); }
    const allB = u.buildings === 'all';
    const f = $('user-form');
    f.innerHTML = `
      <h3>${isNew ? 'Add user' : 'Edit ' + esc(u.name)}</h3>
      <label for="uf-name">Full name</label><input id="uf-name" type="text" value="${esc(u.name)}" required>
      <label for="uf-username">Username</label><input id="uf-username" type="text" value="${esc(u.username)}" autocapitalize="none" spellcheck="false" required>
      <div class="hint">Used to sign in. Lowercase, e.g. maria or j.smith</div>
      <label for="uf-email">Email</label><input id="uf-email" type="email" value="${esc(u.email || '')}" placeholder="name@example.com">
      <div class="hint">Saved for notifications later.</div>
      <label for="uf-role">Role</label>
      <select id="uf-role">${U.roles.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
      <label for="uf-pw">${isNew ? 'Password' : 'Reset password'}</label>
      <div class="pwrow"><input id="uf-pw" type="text" autocomplete="new-password" placeholder="${isNew ? 'At least 8 characters' : 'Leave blank to keep their password'}" ${isNew ? 'required' : ''}><button class="btn" type="button" id="uf-gen">Generate</button></div>
      <div class="hint">${isNew ? 'Share it with them privately. They can change it under My account.' : 'Setting a new password signs them out everywhere.'}</div>
      <fieldset><legend>Permissions</legend><div class="checks">
        ${U.perms.map(([k, label]) => `<label><input type="checkbox" data-perm="${k}" ${u.perms && u.perms[k] ? 'checked' : ''}>${esc(label)}</label>`).join('')}
      </div></fieldset>
      <fieldset><legend>Buildings they can see</legend>
        <div class="radio"><label><input type="radio" name="uf-bmode" value="all" ${allB ? 'checked' : ''}>All buildings</label><label><input type="radio" name="uf-bmode" value="some" ${allB ? '' : 'checked'}>Only these</label></div>
        <div class="checks ${allB ? 'hidden' : ''}" id="uf-blist">${U.buildings.map((b) => `<label><input type="checkbox" data-b="${esc(b)}" ${!allB && u.buildings.includes(b) ? 'checked' : ''}>${esc(b)}</label>`).join('')}</div>
      </fieldset>
      ${isNew ? '' : `<fieldset><legend>Status</legend><div class="radio"><label><input type="radio" name="uf-active" value="1" ${u.active ? 'checked' : ''}>Active</label><label><input type="radio" name="uf-active" value="0" ${u.active ? '' : 'checked'}>Deactivated</label></div></fieldset>`}
      <div class="form-msg" id="uf-msg"></div>
      <div id="uf-confirm"></div>
      <div class="form-actions">
        <button class="btn primary" type="submit">${isNew ? 'Create user' : 'Save changes'}</button>
        <button class="btn" type="button" id="uf-cancel">Cancel</button>
        <span class="spacer"></span>
        ${isNew || u.id === me.id ? '' : '<button class="btn danger" type="button" id="uf-del">Delete</button>'}
      </div>`;
    f.classList.remove('hidden');
    document.querySelector('.users-layout').classList.add('editing');
    $('uf-gen').onclick = () => { $('uf-pw').value = genPassword(); };
    $('uf-cancel').onclick = () => { editing = null; renderUsers(); };
    f.querySelectorAll('[name=uf-bmode]').forEach((r) => r.onchange = () => $('uf-blist').classList.toggle('hidden', f.querySelector('[name=uf-bmode]:checked').value === 'all'));
    // Picking a role fills in that role's usual settings; everything stays editable.
    $('uf-role').onchange = () => {
      const d = U.defaults[$('uf-role').value];
      f.querySelectorAll('[data-perm]').forEach((c) => { c.checked = !!d.perms[c.dataset.perm]; });
      const all = d.buildings === 'all';
      f.querySelector(`[name=uf-bmode][value=${all ? 'all' : 'some'}]`).checked = true;
      $('uf-blist').classList.toggle('hidden', all);
    };
    if ($('uf-del')) $('uf-del').onclick = () => {
      $('uf-confirm').innerHTML = `<div class="confirm-del">Delete ${esc(u.name)}? They won’t be able to sign in and this can’t be undone. <button class="btn danger" type="button" id="uf-del-yes">Yes, delete</button> <button class="btn" type="button" id="uf-del-no">Keep</button></div>`;
      $('uf-del-no').onclick = () => { $('uf-confirm').innerHTML = ''; };
      $('uf-del-yes').onclick = async () => {
        try { await send('DELETE', '/api/users/' + u.id); editing = null; toast(`${u.name} deleted`); loadUsers(); }
        catch (err) { $('uf-msg').className = 'form-msg err'; $('uf-msg').textContent = err.message; }
      };
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const some = f.querySelector('[name=uf-bmode]:checked').value === 'some';
      const body = {
        name: $('uf-name').value, username: $('uf-username').value, email: $('uf-email').value, role: $('uf-role').value,
        perms: Object.fromEntries([...f.querySelectorAll('[data-perm]')].map((c) => [c.dataset.perm, c.checked])),
        buildings: some ? [...f.querySelectorAll('[data-b]:checked')].map((c) => c.dataset.b) : 'all',
      };
      if ($('uf-pw').value) body.password = $('uf-pw').value;
      if (!isNew) body.active = f.querySelector('[name=uf-active]:checked').value === '1';
      try {
        const out = await send(isNew ? 'POST' : 'PUT', isNew ? '/api/users' : '/api/users/' + u.id, body);
        toast(isNew ? `${out.user.name} can now sign in as “${out.user.username}”` : 'Saved');
        editing = null; loadUsers();
        if (out.user.id === me.id) { me = { ...me, ...out.user }; applyPermissions(); }
      } catch (err) { $('uf-msg').className = 'form-msg err'; $('uf-msg').textContent = err.message; }
    };
  }

  // ---------- live updates ----------
  // Guesty tells the server about every booking change; the page checks a tiny "version" every 15 seconds.
  function setLive(state, title) {
    const el = $('live');
    el.className = 'live' + (state === 'on' ? ' on' : '');
    el.querySelector('.lbl').textContent = state === 'on' ? 'Live' : state === 'preview' ? 'Preview' : 'Auto';
    el.title = title;
  }
  let polling = false;
  async function checkVersion() {
    if (polling || document.hidden || !data) return;
    polling = true;
    try {
      const v = await getJSON('/api/version');
      setLive(v.webhook === 'registered' ? 'on' : v.webhook === 'preview' ? 'preview' : 'auto',
        v.webhook === 'registered' ? 'Instant updates from Guesty are on' : 'Checking Guesty every few minutes');
      if (version && v.version !== version) {
        const before = data.totals.newBookings;
        weeks.clear();
        await showWeek(data.weekStart, { quiet: true });
        toast(data.totals.newBookings > before ? 'New booking — schedule updated' : 'Bookings changed — schedule updated');
      }
      version = v.version;
    } catch (_) { /* offline for a moment: try again next tick */ }
    finally { polling = false; }
  }

  // ---------- wiring ----------
  document.querySelectorAll('.snav [data-nav]').forEach((b) => b.onclick = () => {
    const n = b.dataset.nav;
    setView(n === 'schedule' ? (allowed(lastSched) ? lastSched : allowed('day') ? 'day' : 'board') : n);
  });
  document.querySelectorAll('.range [data-range]').forEach((b) => b.onclick = () => setView(b.dataset.range));
  $('prev').onclick = () => data && showWeek(data.prevWeek);
  $('next').onclick = () => data && showWeek(data.nextWeek);
  $('this').onclick = () => showWeek('');
  // Copy for WhatsApp: the selected day or the whole week
  function closeCopyMenu() { $('copy-menu').classList.add('hidden'); $('copy').setAttribute('aria-expanded', 'false'); }
  $('copy').onclick = (e) => {
    e.stopPropagation();
    const open = $('copy-menu').classList.contains('hidden');
    if (open && data) $('copy-day').textContent = `Copy ${selected === data.today ? 'today' : WD_LONG.format(D(selected))}`;
    $('copy-menu').classList.toggle('hidden', !open);
    $('copy').setAttribute('aria-expanded', String(open));
  };
  $('copy-menu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b || !data) return;
    closeCopyMenu();
    const text = b.dataset.copy === 'week' ? weekText() : dayText(data.days.find((d) => d.date === selected)).join('\n');
    try { await navigator.clipboard.writeText(text); toast(b.dataset.copy === 'week' ? 'Week copied — paste into WhatsApp' : 'Day copied — paste into WhatsApp'); }
    catch (_) { toast('This browser blocked copying'); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.copy-wrap')) closeCopyMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || !data || !(view === 'day' || view === 'board')) return;
    if (e.key === 'ArrowLeft') showWeek(data.prevWeek);
    if (e.key === 'ArrowRight') showWeek(data.nextWeek);
  });

  $('me-btn').onclick = () => setView('account');
  $('me-btn2').onclick = () => setView('account');
  (async () => {
    const q0 = new URLSearchParams(location.search);
    const deep = q0.get('view') ? location.href : null; // opened from a notification: ?view=…&date=…&flat=…
    try { const r = await getJSON('/api/me'); me = r.user; window.__permsList = r.perms; }
    catch (_) { return; }
    applyPermissions();
    setView(deep && allowed(q0.get('view')) ? q0.get('view') : view);
    if (can('view_day') || can('view_board')) {
      const w = q0.get('week') || (deep && q0.get('date'));
      showWeek(/^\d{4}-\d{2}-\d{2}$/.test(w || '') ? w : '').then(() => { checkVersion(); if (deep) openLink(deep); });
    } else if (deep) openLink(deep);
    loadNotifs();
    initPush();
    refreshBadges();
  })();
  setInterval(() => { if (!document.hidden) refreshBadges(); }, 60000);
  setInterval(checkVersion, 15000);
  setInterval(() => { if (!document.hidden && me) refreshCleanings(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });

  // =====================================================================
  // Cleaning: begin → timer → end → hold-to-confirm checklist → video
  // Damage reports with video/photo evidence
  // =====================================================================
  let cleanings = [];           // cleanings visible to me (selected day + my active one)
  let checklistDef = [];
  let holdMs = 3000;
  const ACTIVE = ['in_progress', 'checklist', 'awaiting_video', 'awaiting_key'];
  const fmtClock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const londonDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const durWords = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'under 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const myActive = () => cleanings.find((c) => c.cleanerId === me.id && ACTIVE.includes(c.status));
  // A cleaning counts towards the check-out it follows, not just the day it happened: e.g. a flat checked out
  // Sunday and cleaned Monday morning shows as cleaned on Sunday. It belongs to the latest check-out at or
  // before the time it started (up to 2 hours early, in case the guest left early), unless a new guest has
  // arrived since. It also still shows on the day it happened, unless that day's own check-out is still to clean.
  const londonHM = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const minus2h = (hm) => { const [h, m] = hm.split(':').map(Number); const t = Math.max(0, h * 60 + m - 120); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const nextDay = (d) => { const x = D(d); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  // Cleanings are fetched up to the day after the week, so a Friday check-out cleaned on Saturday morning is found.
  const cleaningRange = () => `from=${data.dates[0]}&to=${nextDay(data.dates[data.dates.length - 1])}`;
  const unitOn = (listingId, date) => { const day = data.days.find((d) => d.date === date); return day && day.units.find((u) => u.listingId === listingId); };
  function cleanFor(c) {
    if (!data || !c.startedAt) return c.date;
    // Left over from another week while the new one loads: it can't belong to a check-out on screen.
    if (c.date < data.dates[0] || c.date > nextDay(data.dates[data.dates.length - 1])) return c.date;
    const hm = londonHM(c.startedAt);
    let best = null;
    for (const d of data.dates) {
      if (d > c.date) break;
      const u = unitOn(c.listingId, d);
      const o = u && u.checkOut;
      if (o && (d < c.date || !o.timeRaw || hm >= minus2h(o.timeRaw))) best = d;
      if (u && u.checkIn && d < c.date) best = null; // a new guest arrived since, so that check-out was cleaned already
    }
    return best || c.date;
  }
  function cleaningShowsOn(c, date) {
    if (cleanFor(c) === date) return true;
    const u = c.date === date && unitOn(c.listingId, date);
    return c.date === date && !(u && u.checkOut);
  }
  const forListing = (id, date) => cleanings.filter((c) => c.listingId === id && c.status !== 'cancelled' && (!date || ACTIVE.includes(c.status) || cleaningShowsOn(c, date)));
  let cRange = '';

  async function refreshCleanings() {
    if (!me) return;
    try {
      const range = data ? cleaningRange() : '';
      const [r, a] = await Promise.all([getJSON('/api/cleanings?' + range), getJSON('/api/assignments?' + range).catch(() => null)]);
      cRange = range;
      cleanings = r.cleanings; checklistDef = r.checklist; holdMs = r.holdMs;
      if (a) assignments = Object.fromEntries(a.assignments.map((x) => [`${x.date}|${x.listingId}`, x]));
      decorateDay();
      renderActiveBar();
      // Only redraw the open panel if something in it changed: redrawing wipes what's being typed (lockbox code,
      // damage description) and the damage form's upload list.
      if (sheetListing && sheetMode === 'main' && sheetSig() !== lastSheetSig) renderSheet();
    } catch (_) { /* try again on the next tick */ }
  }

  // Badges on Day view rows: "Cleaning · 12:04" (live) or "Cleaned · 49 min"
  function decorateDay() {
    if (data && me && cRange !== cleaningRange()) { cRange = 'loading'; refreshCleanings(); }
    document.querySelectorAll('[data-cbadge]').forEach((el) => {
      const list = forListing(el.dataset.cbadge, selected);
      const active = list.find((c) => ACTIVE.includes(c.status));
      const done = list.filter((c) => c.status === 'completed').pop();
      if (active) el.innerHTML = `<span class="cb running"><i></i>${esc(active.cleanerName.split(' ')[0])} · <b data-since="${esc(active.startedAt)}" data-until="${esc(active.endedAt || '')}">${fmtDur((active.endedAt ? Date.parse(active.endedAt) : Date.now()) - Date.parse(active.startedAt))}</b></span>`;
      else if (done) el.innerHTML = `<span class="cb done">✓ Cleaned · ${durWords(Date.parse(done.endedAt) - Date.parse(done.startedAt))}</span>`;
      else el.innerHTML = '';
    });
    // Who's assigned to each flat that day.
    document.querySelectorAll('[data-achip]').forEach((el) => {
      const a = assignments[`${selected}|${el.dataset.achip}`];
      el.innerHTML = a ? `<span class="achip${a.cleanerId === me.id ? ' mine' : ''}" title="Assigned to ${esc(a.cleanerName)}">${PERSON_ICON}${a.cleanerId === me.id ? 'You' : esc(a.cleanerName.split(' ')[0])}</span>` : '';
    });
  }
  let assignments = {}; // "date|listingId" → { cleanerId, cleanerName, … }
  const PERSON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
  // One clock for every running timer on the page.
  setInterval(() => {
    document.querySelectorAll('[data-since]').forEach((el) => {
      if (el.dataset.until) return;
      el.textContent = fmtDur(Date.now() - Date.parse(el.dataset.since));
    });
  }, 1000);

  // Sticky bar so a cleaner can always get back to the flat they're cleaning.
  function renderActiveBar() {
    const a = myActive();
    const bar = $('active-bar');
    if (!a) { bar.classList.add('hidden'); return; }
    const step = a.status === 'in_progress' ? `<b data-since="${esc(a.startedAt)}">${fmtDur(Date.now() - Date.parse(a.startedAt))}</b>` : a.status === 'checklist' ? 'Checklist to finish' : a.status === 'awaiting_key' ? 'Key to return' : 'Video needed';
    bar.innerHTML = `<div class="wrap"><span class="ab-dot"></span><span>Cleaning <b>${esc(a.label)}</b> · ${step}</span><button class="btn primary" id="ab-open">Open</button></div>`;
    bar.classList.remove('hidden');
    $('ab-open').onclick = () => openSheet(a.listingId);
  }

  // Tapping a flat in the Day view opens its panel.
  $('daypanel').addEventListener('click', (e) => { const r = e.target.closest('.row.tap'); if (r) openSheet(r.dataset.listing); });
  $('daypanel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const r = e.target.closest('.row.tap'); if (r) openSheet(r.dataset.listing); } });

  // ---------------- property panel ----------------
  let sheetListing = null;
  let sheetMode = 'main';      // main | damage
  function unitFor(listingId) {
    for (const d of (data ? data.days : [])) { const u = d.units.find((x) => x.listingId === listingId); if (u) return u; }
    for (const b of (data ? data.board : [])) { const u = b.units.find((x) => x.listingId === listingId); if (u) return { ...u, building: b.name }; }
    const c = cleanings.find((x) => x.listingId === listingId);
    return c ? { listingId, label: c.label, name: c.listingName, building: c.building, unitType: c.unitType } : null;
  }
  function openSheet(listingId) {
    sheetListing = listingId; sheetMode = 'main';
    $('sheet').classList.remove('hidden');
    document.body.classList.add('noscroll');
    renderSheet();
  }
  function closeSheet() {
    if (uploadsBusy()) { toast('An upload is still running — keep this open until it finishes'); return; }
    sheetListing = null;
    $('sheet').classList.add('hidden');
    document.body.classList.remove('noscroll');
  }
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet' || e.target.closest('[data-close]')) closeSheet(); });

  // "4K", "1080p"… from the uploaded video's shorter side (works for upright and sideways videos).
  const qualityName = (m) => { const s = Math.min(m.width, m.height); return s >= 2160 ? '4K' : s >= 1080 ? '1080p' : s >= 720 ? '720p' : `${m.width}×${m.height}`; };
  function videoBar(m) {
    const bits = [];
    if (m.width && m.height) bits.push(isLowQuality(m) ? `<span class="warn">Low quality · ${m.width}×${m.height}</span>` : `<span class="mt-q">${qualityName(m)}${m.hdr ? ' HDR' : ''}</span>`);
    if (m.hasOrig) bits.push(`<a href="/media/${esc(m.id)}/orig" target="_blank" rel="noopener">Full quality</a>`, `<a href="/media/${esc(m.id)}/orig?download=1">Download original</a>`);
    return bits.length ? `<div class="mt-bar">${bits.join('')}</div>` : '';
  }
  function mediaTiles(media) {
    if (!media || !media.length) return '';
    return `<div class="media-grid">${media.map((m) => m.kind === 'video'
      ? `<div class="mt video">${m.status === 'ready' ? `<video controls preload="none" playsinline poster="/media/${m.id}/thumb" src="/media/${m.id}"></video>` : `<div class="mt-wait">Processing video…</div>`}${m.duration ? `<span class="mt-d">${fmtDur(m.duration * 1000)}</span>` : ''}</div>${videoBar(m)}`
      : `<a class="mt photo" href="/media/${m.id}${m.hasOrig ? '/orig' : ''}" target="_blank" rel="noopener"><img loading="lazy" src="/media/${m.id}/thumb" onerror="this.src='/media/${m.id}'" alt="Photo"></a>`).join('')}</div>`;
  }

  // A cleaner can back out of their own cleaning at any step until it's complete.
  const CANCEL_MINE = '<button class="linkbtn" id="cancel-clean">Changed your mind? Cancel this cleaning</button>';
  let lastSheetSig = null;
  const typingStep = () => { const a = me && myActive(); return Boolean(a && a.listingId === sheetListing && (a.status === 'awaiting_video' || a.status === 'awaiting_key')); };
  const sheetSig = () => JSON.stringify([sheetListing, selected, typingStep() ? null : (assignments[`${selected}|${sheetListing}`] || {}).cleanerId || null, forListing(sheetListing, selected).map((c) =>
    [c.id, c.status, c.endedAt, c.guesty, c.checklist && c.checklist.length, c.key && c.key.mode, (c.media || []).map((m) => [m.id, m.status, m.hasOrig])])]);

  // ---- assigning a cleaner to this flat on the selected day (Admin/User); everyone else just sees who it is ----
  const assignees = new Map(); // listingId → [{ id, name, role }]
  function assignBlock() {
    const a = assignments[`${selected}|${sheetListing}`];
    const day = selected === (data && data.today) ? 'today' : esc(longDate(selected));
    if (!isManager()) return a ? `<div class="assign-row ro">${PERSON_ICON}<span>${a.cleanerId === me.id ? '<b>Assigned to you</b>' : `Assigned to <b>${esc(a.cleanerName)}</b>`} ${day}</span></div>` : '';
    return `<div class="assign-row">${PERSON_ICON}<label for="as-sel">Cleaner ${day}</label>
      <select id="as-sel" data-cur="${esc(a ? a.cleanerId : '')}"><option value="">${a ? esc(a.cleanerName) : 'Not assigned'}</option></select></div>`;
  }
  async function wireAssign() {
    const sel = $('as-sel');
    if (!sel) return;
    const listingId = sheetListing, date = selected;
    let cur = sel.dataset.cur;
    try {
      if (!assignees.has(listingId)) assignees.set(listingId, (await getJSON('/api/assignees?listingId=' + encodeURIComponent(listingId))).people);
    } catch (e) { return; }
    if ($('as-sel') !== sel) return; // panel was redrawn meanwhile
    const people = assignees.get(listingId);
    sel.innerHTML = `<option value="">Not assigned</option>${people.map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}${p.role !== 'cleaner' ? ` (${esc(p.role)})` : ''}</option>`).join('')}`;
    sel.onchange = async () => {
      sel.disabled = true;
      try {
        const r = await send('PUT', '/api/assignments', { listingId, date, cleanerId: sel.value || null });
        const k = `${date}|${listingId}`;
        if (r.assignment) assignments[k] = r.assignment; else delete assignments[k];
        cur = sel.value; lastSheetSig = sheetSig();
        toast(r.assignment ? `Assigned to ${r.assignment.cleanerName} — they’ve been notified` : 'Assignment removed');
        decorateDay();
      } catch (e) { toast(e.message); sel.value = cur; }
      sel.disabled = false;
    };
  }
  async function renderSheet() {
    const u = unitFor(sheetListing);
    if (!u) return;
    if (sheetMode !== 'damage') lastSheetSig = sheetSig();
    const list = forListing(sheetListing, selected);
    const active = list.find((c) => ACTIVE.includes(c.status));
    const done = list.filter((c) => c.status === 'completed');
    const mine = active && active.cleanerId === me.id;
    let body = '';

    if (sheetMode === 'damage') return renderDamageForm(u);

    if (active && mine && active.status === 'in_progress') {
      body = `<div class="timer-card">
          <div class="tc-label">Cleaning since ${fmtClock(active.startedAt)}</div>
          <div class="tc-time" data-since="${esc(active.startedAt)}">${fmtDur(Date.now() - Date.parse(active.startedAt))}</div>
          <button class="btn big danger-solid" id="end-clean">End cleaning</button>
          <button class="linkbtn" id="cancel-clean">Started by mistake? Cancel</button>
        </div>`;
    } else if (active && mine && active.status === 'checklist') {
      body = `<div class="timer-card"><div class="tc-label">Cleaning ended at ${fmtClock(active.endedAt)} · ${durWords(Date.parse(active.endedAt) - Date.parse(active.startedAt))}</div>
        <p>Go through the final checks to finish.</p><button class="btn big primary" id="open-checklist">Continue checklist</button>${CANCEL_MINE}</div>`;
    } else if (active && mine && active.status === 'awaiting_video') {
      body = evidenceStep(active) + `<div class="cancel-row">${CANCEL_MINE}</div>`;
    } else if (active && mine && active.status === 'awaiting_key') {
      body = keyStep(active) + `<div class="cancel-row">${CANCEL_MINE}</div>`;
    } else if (active) {
      body = `<div class="timer-card other"><div class="tc-label">${esc(active.cleanerName)} started at ${fmtClock(active.startedAt)}</div>
        <div class="tc-time" ${active.endedAt ? '' : `data-since="${esc(active.startedAt)}"`}>${fmtDur((active.endedAt ? Date.parse(active.endedAt) : Date.now()) - Date.parse(active.startedAt))}</div>
        <div class="tc-step">${active.status === 'in_progress' ? 'Cleaning now' : active.status === 'checklist' ? 'Doing final checks' : active.status === 'awaiting_key' ? 'Returning the key' : 'Uploading video'}</div>
        ${can('manage_users') ? '<button class="linkbtn" id="cancel-clean">Cancel this cleaning</button>' : ''}</div>`;
    } else if (can('do_cleaning')) {
      body = `<button class="btn big primary" id="begin-clean"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 5v14l11-7z"/></svg>Begin cleaning</button>`;
    }

    const history = done.map((c) => `<div class="hist">
        <div class="hist-h"><b>✓ Cleaned by ${esc(c.cleanerName)}</b><span>${c.date !== selected ? esc(`${WD_SHORT.format(D(c.date))} ${shortDate(c.date)}`) + ', ' : ''}${fmtClock(c.startedAt)}–${fmtClock(c.endedAt)} · ${durWords(Date.parse(c.endedAt) - Date.parse(c.startedAt))}</span></div>
        <div class="hist-s">Checklist confirmed ${c.checklist.length}/${checklistDef.length || 5}${keyNote(c)}${c.guesty === 'updated' ? ' · marked clean in Guesty' : c.guesty === 'failed' ? ' · <span class="warn">Guesty not updated</span>' : ''}</div>
        ${(can('view_cleaning') || c.cleanerId === me.id) ? mediaTiles(c.media) : ''}
      </div>`).join('');

    const t = [u.checkOut && `Out ${u.checkOut.time}`, u.checkIn && `In ${u.checkIn.time}`].filter(Boolean).join(' · ');
    $('sheet-body').innerHTML = `
      <div class="sh-head"><div><h2>${esc(u.label)}</h2><div class="sh-sub">${esc(u.building || '')}${t ? ' · ' + esc(t) : ''}</div></div><button class="btn sq" data-close aria-label="Close">✕</button></div>
      ${assignBlock()}
      ${body}
      ${history ? `<h3 class="sh-h3">${done.some((c) => c.date !== selected) ? 'Cleaned' : `Cleaned ${selected === (data && data.today) ? 'today' : esc(longDate(selected))}`}</h3>${history}` : ''}
      <div id="sheet-damages"></div>
      ${can('report_damage') ? '<button class="btn wide" id="report-damage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>Report damage</button>' : ''}`;

    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    wireAssign();
    on('begin-clean', async () => {
      try { await send('POST', '/api/cleanings/start', { listingId: sheetListing }); toast('Cleaning started'); await refreshCleanings(); }
      catch (e) { toast(e.message); refreshCleanings(); }
    });
    on('end-clean', async () => {
      try { await send('POST', `/api/cleanings/${active.id}/end`); await refreshCleanings(); openChecklist(); }
      catch (e) { toast(e.message); }
    });
    on('cancel-clean', () => confirmInline(active.status === 'in_progress' ? 'Cancel this cleaning? The timer will be discarded.' : 'Cancel this cleaning? Nothing from it will be recorded.', async () => {
      try {
        await send('POST', `/api/cleanings/${active.id}/cancel`);
        // Stop anything still running for it: video uploads and the KeyNest check.
        for (const [k, x] of uploads) if (x.ownerId === active.id) { x.cancelled = true; uploads.delete(k); }
        releaseWake(); clearInterval(keyPoll); keyPoll = null;
        toast('Cleaning cancelled'); await refreshCleanings();
      } catch (e) { toast(e.message); }
    }));
    on('open-checklist', openChecklist);
    on('report-damage', () => { sheetMode = 'damage'; renderSheet(); });
    if (active && mine && active.status === 'awaiting_video') wireEvidence(active);
    if (active && mine && active.status === 'awaiting_key') wireKey(active);
    loadSheetDamages(sheetListing);
  }

  function confirmInline(text, yes) {
    const box = document.createElement('div');
    box.className = 'confirm-del';
    box.innerHTML = `${esc(text)} <button class="btn danger">Yes</button> <button class="btn">No</button>`;
    $('sheet-body').prepend(box);
    const [y, n] = box.querySelectorAll('button');
    y.onclick = () => { box.remove(); yes(); };
    n.onclick = () => box.remove();
  }

  // ---------------- checklist: tap each item, then hold to confirm the summary ----------------
  function openChecklist() {
    const a = myActive();
    if (!a || a.status !== 'checklist') return;
    const ov = $('checklist');
    ov.classList.remove('hidden');
    const step = () => {
      const cur = myActive();
      const i = cur ? cur.checklist.length : checklistDef.length;
      if (!cur || cur.status !== 'checklist') { ov.classList.add('hidden'); renderSheet(); return; }
      const later = `<button class="linkbtn" id="cl-later">Not done yet — go back and check</button>`;
      const dots = checklistDef.map((_, k) => `<i class="${k < i ? 'done' : k === i ? 'cur' : ''}"></i>`).join('');
      if (i >= checklistDef.length) {
        // All items ticked: show the summary, confirmed by one press-and-hold.
        const secs = Math.round(holdMs / 1000);
        ov.innerHTML = `<div class="cl-card" role="dialog" aria-modal="true" aria-labelledby="cl-t">
          <div class="cl-top"><span class="cl-count">All checks</span><div class="cl-dots">${dots}</div></div>
          <h2 id="cl-t">Final checks</h2>
          <ul class="cl-sum">${checklistDef.map((it) => `<li><span class="cl-tick" aria-hidden="true">✓</span><span>${esc(it.text)}</span></li>`).join('')}</ul>
          <p class="cl-help">Hold the button for ${secs} seconds to confirm everything above is done.</p>
          <button class="hold" id="hold-btn"><span class="hold-fill"></span><span class="hold-label">Hold: All checks done</span></button>
          ${later}
        </div>`;
        $('cl-later').onclick = () => { ov.classList.add('hidden'); };
        wireHold($('hold-btn'), async (held) => {
          try {
            const r = await send('POST', `/api/cleanings/${cur.id}/checks-done`, { heldMs: held });
            const idx = cleanings.findIndex((c) => c.id === cur.id); cleanings[idx] = { ...cleanings[idx], ...r.cleaning };
            if (navigator.vibrate) navigator.vibrate(40);
            step();
          } catch (e) { toast(e.message); step(); }
        });
        return;
      }
      const item = checklistDef[i];
      ov.innerHTML = `<div class="cl-card" role="dialog" aria-modal="true" aria-labelledby="cl-t">
        <div class="cl-top"><span class="cl-count">Check ${i + 1} of ${checklistDef.length}</span><div class="cl-dots">${dots}</div></div>
        <div class="cl-icon">${CL_ICONS[item.key] || ''}</div>
        <h2 id="cl-t">${esc(item.title)}</h2>
        <p class="cl-q">${esc(item.text)}</p>
        <p class="cl-help">Read carefully, then tap the button.</p>
        <button class="tapbtn" id="tap-btn">Yes, I have checked</button>
        ${later}
      </div>`;
      $('cl-later').onclick = () => { ov.classList.add('hidden'); };
      const tap = $('tap-btn');
      tap.onclick = async () => {
        if (tap.disabled) return;
        tap.disabled = true;
        try {
          const r = await send('POST', `/api/cleanings/${cur.id}/confirm`, { key: item.key });
          const idx = cleanings.findIndex((c) => c.id === cur.id); cleanings[idx] = { ...cleanings[idx], ...r.cleaning };
          if (navigator.vibrate) navigator.vibrate(20);
          step();
        } catch (e) { toast(e.message); step(); }
      };
    };
    step();
  }
  // Press-and-hold: the bar fills over holdMs; letting go early resets it.
  function wireHold(btn, onDone) {
    const fill = btn.querySelector('.hold-fill');
    let start = 0, raf = 0, fired = false;
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / holdMs);
      fill.style.transform = `scaleX(${p})`;
      if (p >= 1 && !fired) { fired = true; btn.classList.add('ok'); btn.querySelector('.hold-label').textContent = 'Confirmed'; onDone(Math.round(performance.now() - start)); return; }
      raf = requestAnimationFrame(tick);
    };
    const down = (e) => { if (fired) return; e.preventDefault(); start = performance.now(); btn.classList.add('holding'); raf = requestAnimationFrame(tick); try { btn.setPointerCapture(e.pointerId); } catch (_) {} };
    const up = () => { if (fired) return; cancelAnimationFrame(raf); btn.classList.remove('holding'); fill.style.transition = 'transform .25s'; fill.style.transform = 'scaleX(0)'; setTimeout(() => { fill.style.transition = ''; }, 260); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keyboard: hold Space/Enter
    btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e); });
    btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(); });
  }
  const svg = (d) => `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const CL_ICONS = {
    bins: svg('<path d="M10 14h28M18 14V9h12v5M13 14l2 26h18l2-26M21 21v12M27 21v12"/>'),
    fridge: svg('<rect x="13" y="5" width="22" height="38" rx="3"/><path d="M13 19h22M18 10v4M18 24v6"/>'),
    oven: svg('<rect x="7" y="8" width="34" height="32" rx="3"/><path d="M7 16h34M13 12h.01M19 12h.01"/><rect x="13" y="22" width="22" height="12" rx="2"/>'),
    microwave: svg('<rect x="5" y="11" width="38" height="26" rx="3"/><rect x="10" y="16" width="22" height="16" rx="2"/><path d="M37 17v.01M37 23v.01M37 29v.01"/>'),
    hairs: svg('<path d="M12 40V14a8 8 0 0 1 16 0"/><path d="M28 14h6M31 20l-1 4M35 20l1 4M33 20v4"/><path d="M8 40h32"/>'),
  };

  // ---------------- video (required) + photos (optional) ----------------
  const uploads = new Map(); // key -> {file, kind, progress, id, done, error}
  const uploadsBusy = () => [...uploads.values()].some((u) => !u.done && !u.error);
  // ---------------- returning the key (Guesty tag LOCKBOX or KEYNEST) ----------------
  function keyNote(c) {
    if (!c.key) return '';
    if (c.key.mode === 'lockbox') return can('view_cleaning') ? ` · key in lockbox, new code <b>${esc(c.key.code)}</b>` : ' · key returned to lockbox';
    return ' · key back in KeyNest';
  }
  let keyPoll = null;
  function keyStep(a) {
    if (a.keyMode === 'lockbox') {
      return `<div class="evidence keystep">
        <div class="ev-head"><b>Last step: the key.</b> <span class="req">Required</span></div>
        <ol class="ks-steps"><li>Put the key back in the lockbox.</li><li>Set a <b>new 4-digit code</b> on the lockbox and close it.</li><li>Enter the new code below.</li></ol>
        <label class="ks-l" for="ks-code">New lockbox code</label>
        <input class="ks-code" id="ks-code" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="••••">
        <label class="ks-l" for="ks-code2">Enter it again</label>
        <input class="ks-code" id="ks-code2" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="••••">
        <label class="ks-check"><input type="checkbox" id="ks-back"> The key is in the lockbox and the new code is set</label>
        <p class="ks-msg" id="ks-msg"></p>
        <button class="btn big primary" id="ks-done" disabled>Complete cleaning</button>
      </div>`;
    }
    return `<div class="evidence keystep">
      <div class="ev-head"><b>Last step: the key must be in KeyNest.</b> <span class="req">Required</span></div>
      <p class="ev-note">If you collected the key from KeyNest, hand it back in at the store. As soon as KeyNest shows it in the store, you can complete the cleaning.</p>
      <div class="kn-status" id="kn-status"><span class="kn-dot"></span><span class="kn-body"><span id="kn-text">Checking KeyNest…</span><small id="kn-when"></small></span></div>
      <div class="kn-stores" id="kn-stores"></div>
      <button class="btn wide" id="kn-check">Check again</button>
      <button class="btn big primary" id="ks-done" disabled>Complete cleaning</button>
    </div>`;
  }
  function wireKey(a) {
    clearInterval(keyPoll); keyPoll = null;
    const done = $('ks-done');
    const finish = async (payload) => {
      done.disabled = true;
      try {
        await send('POST', `/api/cleanings/${a.id}/key`, payload);
        clearInterval(keyPoll); keyPoll = null;
        if (navigator.vibrate) navigator.vibrate(40);
        toast('Cleaning complete ✓');
        await refreshCleanings();
        if (sheetListing === a.listingId && sheetMode === 'main') closeSheet(); // not if they've since opened another flat
      } catch (e) { toast(e.message); done.disabled = false; if (a.keyMode === 'keynest') check(); }
    };
    if (a.keyMode === 'lockbox') {
      const c1 = $('ks-code'), c2 = $('ks-code2'), back = $('ks-back'), msg = $('ks-msg');
      const update = () => {
        for (const el of [c1, c2]) el.value = el.value.replace(/\D/g, '').slice(0, 4);
        const ok4 = /^\d{4}$/.test(c1.value), same = c1.value === c2.value;
        msg.textContent = c2.value.length === 4 && !same ? 'The two codes don’t match.' : '';
        done.disabled = !(ok4 && same && back.checked);
      };
      c1.oninput = () => { update(); if (c1.value.length === 4) c2.focus(); };
      c2.oninput = update; back.onchange = update;
      done.onclick = () => finish({ code: c1.value, confirmCode: c2.value, keyReturned: back.checked });
      return;
    }
    const box = $('kn-status'), text = $('kn-text'), when = $('kn-when'), again = $('kn-check');
    // While KeyNest shows the key out, suggest where to drop it off: nearest KeyNest to the flat and nearest 24-hour one.
    let stores = null; // loaded once
    // One button: the phone's own maps. Android hands a geo: link to its default maps app; iPhones, iPads and Macs
    // open Apple Maps (the built-in maps); anything else gets Google Maps in the browser. Walking directions where it can.
    const directions = (st) => {
      const ll = `${Number(st.lat)},${Number(st.lng)}`, ua = navigator.userAgent;
      const href = /Android/i.test(ua) ? `geo:${ll}?q=${ll}(${encodeURIComponent(st.name)})`
        : /iPhone|iPad|iPod|Macintosh/.test(ua) ? `https://maps.apple.com/?daddr=${ll}&dirflg=w`
        : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=walking`;
      return `<a class="btn kn-go" href="${esc(href)}"${href.startsWith('geo:') ? '' : ' target="_blank" rel="noopener"'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>Get directions</a>`;
    };
    const walk = (m) => (m < 60 ? `${m} min walk` : `${Math.floor(m / 60)} h ${m % 60} min walk`);
    const storeCard = (title, st) => `<div class="kn-store${st.mostUsed ? ' top' : ''}"><div class="kn-store-h"><span>${esc(title)}</span><b>${esc(st.miles)} mi · ${esc(walk(st.walkMin))}</b></div>
      <div class="kn-store-name">${esc(st.name)}${st.mostUsed ? '<span class="kn-badge">Most used</span>' : ''}</div>${st.address ? `<div class="muted">${esc(st.address)}</div>` : ''}
      ${st.today ? `<div class="kn-open ${st.openNow === true ? 'on' : st.openNow === false ? 'off' : ''}">${st.is24 ? '' : st.openNow === true ? 'Open now · ' : st.openNow === false ? 'Closed now · ' : ''}${esc(st.today)}</div>` : ''}
      ${st.mostUsed ? `<div class="muted kn-used">This key was dropped off here ${esc(st.mostUsed.count)} of the last ${esc(st.mostUsed.total)} times.</div>` : ''}${directions(st)}</div>`;
    const showStores = async (show) => {
      const el = $('kn-stores');
      if (!el) return;
      if (!show) { el.innerHTML = ''; return; }
      if (!stores) { try { stores = await getJSON(`/api/cleanings/${a.id}/key-stores`); } catch (e) { stores = { error: e.message }; } }
      const n = stores.nearest, n24 = stores.nearest24;
      el.innerHTML = stores.error ? `<p class="muted">${esc(stores.error)}</p>` : !n ? '' : `<h4>Where to drop the key off</h4>${
        n24 && n24.id === n.id ? storeCard('Nearest KeyNest · open 24 hours', n) : storeCard('Nearest KeyNest to the flat', n) + (n24 ? storeCard('Nearest open 24 hours', n24) : '')}${
        stores.usual ? storeCard('Where this key usually goes', stores.usual) : ''}`;
    };
    let checking = false;
    const check = async () => {
      if (!$('kn-status')) { clearInterval(keyPoll); keyPoll = null; return; }
      if (checking) return;
      checking = true; again.disabled = true; again.textContent = 'Checking…';
      try {
        const r = await getJSON(`/api/cleanings/${a.id}/key-status`);
        box.className = 'kn-status ' + (r.ok ? 'ok' : r.error ? 'err' : 'wait');
        text.textContent = r.error ? r.error : r.ok ? `Key is in KeyNest ✓ (${r.status})` : `Waiting for the key · KeyNest shows: ${r.status}`;
        done.disabled = !r.ok;
        showStores(!r.ok && !r.error);
      } catch (e) { box.className = 'kn-status err'; text.textContent = e.message; done.disabled = true; }
      checking = false; again.disabled = false; again.textContent = 'Check again';
      when.textContent = `Checked at ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })}`;
    };
    again.onclick = check;
    done.onclick = () => finish({});
    check();
    keyPoll = setInterval(check, 20000);
  }

  // Safari's own camera ("Take Video") records at about 480×360, whatever the iPhone's settings, and the
  // Photo Library may re-encode. Filming in the Camera app and choosing the file from Files keeps full 4K.
  const videoTip = (button) => `<details class="ev-tip"><summary>How to upload in full 4K quality</summary><ol>
      <li>Film in the <b>Camera</b> app (Settings › Camera › Record Video: 4K at 30 fps).</li>
      <li>In <b>Photos</b>, open the video, tap <b>Share</b> › <b>Save to Files</b>.</li>
      <li>Here, tap <b>${button}</b> › <b>Choose File</b> and pick it.</li>
    </ol><p>Avoid <b>Take Video</b> (very low quality) and <b>Photo Library</b> (may lower the quality).</p></details>`;
  const isLowQuality = (i) => Boolean(i && i.width && i.height && Math.max(i.width, i.height) < 1920);
  const lowQualityNote = (i) => `<span class="up-warn">Low quality (${i.width}×${i.height}). Please upload the original from Files for full quality.</span>`;
  function evidenceStep(a) {
    return `<div class="evidence">
      <div class="ev-head"><b>Almost done.</b> Record a video walking through the flat. <span class="req">Video required</span></div>
      <div class="ev-btns">
        <label class="btn big primary file"><input type="file" accept="video/*" id="ev-pick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>Upload walkthrough video</label>
        <label class="btn file"><input type="file" accept="image/*" multiple id="ev-photos">Add photos (optional)</label>
      </div>
      ${videoTip('Upload walkthrough video')}
      <p class="ev-note">A video is needed to finish. Keep this screen open until uploads finish.</p>
      <div id="ev-list"></div>
      <button class="btn big primary" id="ev-finish" disabled>Finish cleaning</button>
    </div>`;
  }
  function wireEvidence(a) {
    const add = (files, kindHint) => {
      for (const f of files) {
        const kind = (f.type || '').startsWith('video') || kindHint === 'video' && !(f.type || '').startsWith('image') ? 'video' : 'photo';
        const key = Math.random().toString(36).slice(2);
        uploads.set(key, { file: f, kind, progress: 0, id: null, done: false, error: null, ownerId: a.id, purpose: 'cleaning' });
        runUpload(key);
      }
      drawUploads(a);
    };
    $('ev-pick').onchange = (e) => add(e.target.files, 'video');
    $('ev-photos').onchange = (e) => add(e.target.files, 'photo');
    $('ev-finish').onclick = async () => {
      const mineUp = [...uploads.values()].filter((u) => u.ownerId === a.id && u.done);
      try {
        const r = await send('POST', `/api/cleanings/${a.id}/complete`, { videoIds: mineUp.filter((u) => u.kind === 'video').map((u) => u.id), photoIds: mineUp.filter((u) => u.kind === 'photo').map((u) => u.id) });
        for (const [k, u] of uploads) if (u.ownerId === a.id) uploads.delete(k);
        releaseWake();
        const finished = !(r.cleaning && r.cleaning.status === 'awaiting_key');
        toast(finished ? 'Cleaning complete ✓' : 'Video saved ✓ Now return the key');
        await refreshCleanings();
        if (finished && sheetListing === a.listingId && sheetMode === 'main') closeSheet();
      } catch (e) { toast(e.message); }
    };
    drawUploads(a);
  }
  function drawUploads(a) {
    const list = $('ev-list');
    if (!list) return;
    const mine = [...uploads.entries()].filter(([, u]) => u.ownerId === a.id);
    list.innerHTML = mine.map(([k, u]) => `<div class="up ${u.error ? 'err' : u.done ? 'ok' : ''}" data-up="${k}">
      <span class="up-k">${u.kind === 'video' ? 'Video' : 'Photo'}</span><span class="up-n">${esc(u.file.name || u.kind)} · ${(u.file.size / 1e6).toFixed(u.file.size > 1e7 ? 0 : 1)} MB</span>
      <span class="up-s">${u.error ? esc(u.error) : u.done ? 'Uploaded ✓' : u.waiting ? 'Waiting for signal…' : Math.floor(u.progress * 100) + '%'}</span>
      <span class="up-bar"><i style="transform:scaleX(${u.done ? 1 : u.progress})"></i></span>
      ${u.kind === 'video' && isLowQuality(u.info) ? lowQualityNote(u.info) : ''}</div>`).join('');
    const hasVideo = mine.some(([, u]) => u.kind === 'video' && u.done);
    const busy = mine.some(([, u]) => !u.done && !u.error);
    const btn = $('ev-finish');
    btn.disabled = !hasVideo || busy;
    const next = a.keyMode ? 'Next: return the key' : 'Finish cleaning';
    btn.textContent = busy ? 'Uploading…' : hasVideo ? next : `${next} (video needed)`;
  }

  let wakeLock = null;
  async function holdWake() { try { if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {} }
  function releaseWake() { if (!uploadsBusy() && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

  // Uploads in progress, remembered on this phone so picking the same file again after the page reloads
  // carries on where it stopped instead of starting a large video from zero. The server drops them after 3 days.
  const savedUploads = () => { let s = {}; try { s = JSON.parse(store.get('cs_uploads') || '{}') || {}; } catch (_) {} for (const k of Object.keys(s)) if (!(Date.now() - s[k].at < 3 * 864e5)) delete s[k]; return s; };
  const rememberUpload = (k, id) => { const s = savedUploads(); if (id) s[k] = { id, at: Date.now() }; else delete s[k]; store.set('cs_uploads', JSON.stringify(s)); };

  // Resumable upload in 8 MB pieces; carries on after signal drops.
  async function runUpload(key, redraw) {
    const u = uploads.get(key);
    const draw = () => { if (redraw) redraw(); else { const a = myActive(); if (a) drawUploads(a); } };
    const rkey = [u.purpose, u.ownerId || u.listingId, u.file.name, u.file.size, u.file.lastModified || 0].join('|');
    holdWake();
    try {
      let CH = 8 * 1024 * 1024, received = 0, fails = 0;
      const saved = savedUploads()[rkey];
      if (saved && ![...uploads.values()].some((x) => x !== u && x.id === saved.id)) {
        // Only start again from zero if the server says the earlier upload is gone; a bad signal just means retry.
        for (let t = 0; ; t++) {
          let r = null;
          try { r = await fetch('/api/media/' + saved.id, { credentials: 'same-origin' }); } catch (_) {}
          if (r && r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
          if (r && (r.status === 404 || r.status === 403)) break;
          const s = r && r.ok ? await r.json().catch(() => null) : null;
          if (s) { if (s.byMe && s.size === u.file.size) { u.id = s.id; received = s.uploaded ? u.file.size : s.received; u.info = s.info; } break; }
          u.waiting = true; draw();
          await new Promise((ok) => setTimeout(ok, Math.min(30000, 1000 * 2 ** Math.min(t + 1, 5))));
        }
        u.waiting = false;
      }
      if (!u.id) {
        const start = await send('POST', '/api/media', { kind: u.kind, purpose: u.purpose, ownerId: u.ownerId, listingId: u.listingId, name: u.file.name, size: u.file.size, type: u.file.type });
        u.id = start.id; CH = start.chunk || CH; received = start.received || 0;
        rememberUpload(rkey, u.id);
      }
      u.progress = received / u.file.size; draw();
      while (received < u.file.size) {
        if (u.cancelled) throw new Error('Cancelled');
        const end = Math.min(u.file.size, received + CH);
        const r = await putChunk(u.id, received, u.file.slice(received, end), (loaded) => { u.progress = (received + loaded) / u.file.size; draw(); });
        if (r.ok) { received = r.received; if (r.info) u.info = r.info; fails = 0; u.waiting = false; u.progress = received / u.file.size; draw(); continue; }
        if (r.status === 409 && typeof r.received === 'number') {
          if (r.received === received) await new Promise((ok) => setTimeout(ok, 1000)); // previous piece still being written
          received = r.received; continue;
        }
        if (r.status === 401 || r.status === 403) throw new Error('Upload not allowed — sign in again');
        if (r.status === 404) { rememberUpload(rkey, null); throw new Error('Upload expired — please choose the video again'); }
        if (r.status === 507) throw new Error('The server is out of space — please tell an admin');
        fails++; u.waiting = true; draw();
        await new Promise((ok) => setTimeout(ok, Math.min(30000, 1000 * 2 ** Math.min(fails, 5))));
        try { const s = await getJSON('/api/media/' + u.id); received = s.uploaded ? u.file.size : s.received; if (s.info) u.info = s.info; } catch (_) {}
      }
      u.done = true; u.progress = 1;
      rememberUpload(rkey, null);
    } catch (e) { u.error = e.message || 'Upload failed'; }
    draw();
    releaseWake();
  }
  function putChunk(id, offset, blob, onProgress) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `/api/media/${id}?offset=${offset}`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      x.onload = () => { let b = {}; try { b = JSON.parse(x.responseText); } catch (_) {} resolve({ ok: x.status === 200, status: x.status, received: b.received, info: b.info }); };
      x.onerror = () => resolve({ ok: false, status: 0 });
      x.ontimeout = () => resolve({ ok: false, status: 0 });
      x.timeout = 280000; // slow mobile signal; the server allows up to 5 minutes per piece
      x.send(blob);
    });
  }
  window.addEventListener('beforeunload', (e) => { if (uploadsBusy()) { e.preventDefault(); e.returnValue = ''; } });

  // ---------------- damage reports ----------------
  function renderDamageForm(u) {
    $('sheet-body').innerHTML = `
      <div class="sh-head"><div><h2>Report damage</h2><div class="sh-sub">${esc(u.label)} · ${esc(u.building || '')}</div></div><button class="btn sq" id="dmg-back" aria-label="Back">←</button></div>
      <form id="dmg-form" class="dmg-form">
        <label for="dmg-what">What is damaged?</label>
        <textarea id="dmg-what" rows="3" required placeholder="e.g. Crack in the bathroom mirror, stain on the sofa"></textarea>
        <label for="dmg-where">Where in the flat? <span class="muted">(optional)</span></label>
        <input id="dmg-where" type="text" placeholder="e.g. Bathroom, living room">
        <label>Evidence <span class="req">Video or photo required</span></label>
        <div class="ev-btns">
          <label class="btn primary file"><input type="file" accept="video/*" id="dmg-rec">Upload video</label>
          <label class="btn file"><input type="file" accept="image/*" capture="environment" id="dmg-cam">Take photo</label>
          <label class="btn file"><input type="file" accept="video/*,image/*" multiple id="dmg-pick">Choose files</label>
        </div>
        ${videoTip('Upload video')}
        <div id="dmg-list"></div>
        <div class="form-msg" id="dmg-msg"></div>
        <button class="btn big primary" type="submit" id="dmg-send" disabled>Send report</button>
      </form>`;
    const listingId = sheetListing;
    const keys = [];
    const draw = () => {
      $('dmg-list') && ($('dmg-list').innerHTML = keys.map((k) => { const x = uploads.get(k); return `<div class="up ${x.error ? 'err' : x.done ? 'ok' : ''}"><span class="up-k">${x.kind === 'video' ? 'Video' : 'Photo'}</span><span class="up-n">${esc(x.file.name || x.kind)}</span><span class="up-s">${x.error ? esc(x.error) : x.done ? 'Uploaded ✓' : x.waiting ? 'Waiting for signal…' : Math.floor(x.progress * 100) + '%'}</span><span class="up-bar"><i style="transform:scaleX(${x.done ? 1 : x.progress})"></i></span>${x.kind === 'video' && isLowQuality(x.info) ? lowQualityNote(x.info) : ''}</div>`; }).join(''));
      const ok = keys.some((k) => uploads.get(k).done), busy = keys.some((k) => { const x = uploads.get(k); return !x.done && !x.error; });
      if ($('dmg-send')) { $('dmg-send').disabled = !ok || busy; $('dmg-send').textContent = busy ? 'Uploading…' : 'Send report'; }
    };
    const add = (files) => { for (const f of files) { const key = Math.random().toString(36).slice(2); uploads.set(key, { file: f, kind: (f.type || '').startsWith('image') ? 'photo' : 'video', progress: 0, done: false, error: null, purpose: 'damage', listingId }); keys.push(key); runUpload(key, draw); } draw(); };
    $('dmg-rec').onchange = (e) => add(e.target.files);
    $('dmg-cam').onchange = (e) => add(e.target.files);
    $('dmg-pick').onchange = (e) => add(e.target.files);
    $('dmg-back').onclick = () => { if (keys.some((k) => !uploads.get(k).done && !uploads.get(k).error)) return toast('Wait for the upload to finish'); sheetMode = 'main'; renderSheet(); };
    $('dmg-form').onsubmit = async (e) => {
      e.preventDefault();
      const a = myActive();
      try {
        await send('POST', '/api/damages', { listingId, description: $('dmg-what').value, location: $('dmg-where').value, mediaIds: keys.map((k) => uploads.get(k)).filter((x) => x.done).map((x) => x.id), cleaningId: a && a.listingId === listingId ? a.id : null });
        keys.forEach((k) => uploads.delete(k));
        toast('Damage reported — thank you'); refreshBadges();
        sheetMode = 'main'; renderSheet();
      } catch (err) { $('dmg-msg').className = 'form-msg err'; $('dmg-msg').textContent = err.message; }
    };
  }
  async function loadSheetDamages(listingId) {
    if (!(can('view_cleaning') || can('manage_damage') || can('report_damage'))) return;
    try {
      const r = await getJSON('/api/damages?status=open&listingId=' + encodeURIComponent(listingId));
      const box = $('sheet-damages');
      if (!box || sheetListing !== listingId) return;
      box.innerHTML = r.damages.length ? `<h3 class="sh-h3">Open damage reports</h3>${r.damages.map(damageCard).join('')}` : '';
      wireDamageCards(box, () => loadSheetDamages(listingId));
    } catch (_) {}
  }
  function damageCard(d) {
    return `<div class="dmg ${d.status}">
      <div class="hist-h"><b>${esc(d.label)} · ${esc(d.location || 'Damage')}</b><span>${new Date(d.reportedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} · ${esc(d.reporterName)}</span></div>
      <p class="dmg-desc">${esc(d.description)}</p>
      ${mediaTiles(d.media)}
      ${d.status === 'resolved' ? `<div class="hist-s">Resolved by ${esc(d.resolvedBy || '')}${d.note ? ' — ' + esc(d.note) : ''}</div>` : ''}
      ${can('manage_damage') ? `<div class="form-actions"><button class="btn" data-dmg="${d.id}" data-to="${d.status === 'resolved' ? 'open' : 'resolved'}">${d.status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button></div>` : ''}
    </div>`;
  }
  function wireDamageCards(root, after) {
    root.querySelectorAll('[data-dmg]').forEach((b) => b.onclick = async () => {
      try { await send('PUT', '/api/damages/' + b.dataset.dmg, { status: b.dataset.to }); toast(b.dataset.to === 'resolved' ? 'Marked resolved' : 'Reopened'); after(); refreshBadges(); } catch (e) { toast(e.message); }
    });
  }

  // ---------------- Cleaning tab (admins, supervisors, users) ----------------
  let cvDate = null;
  const STEP = { in_progress: 'Cleaning', checklist: 'Final checks', awaiting_video: 'Uploading video', awaiting_key: 'Returning key' };
  async function loadCleaningView() {
    cvDate = cvDate || (data && data.today) || new Date().toISOString().slice(0, 10);
    $('cv-date').value = cvDate;
    try {
      const [c, d] = await Promise.all([getJSON('/api/cleanings?date=' + cvDate), getJSON('/api/damages?status=open').catch(() => ({ damages: [] }))]);
      checklistDef = c.checklist || checklistDef;
      const cls = c.cleanings.filter((x) => x.status !== 'cancelled' && x.date === cvDate);
      const active = cls.filter((x) => ACTIVE.includes(x.status));
      const done = cls.filter((x) => x.status === 'completed');
      const totalMin = done.reduce((s, x) => s + (Date.parse(x.endedAt) - Date.parse(x.startedAt)), 0);
      const openDmg = d.damages.length;
      $('cv-summary').innerHTML = `<div class="metric"><div class="k">In progress</div><div class="v">${active.length}</div></div>
        <div class="metric"><div class="k">Completed</div><div class="v">${done.length}</div></div>
        <div class="metric"><div class="k">Average time</div><div class="v">${done.length ? durWords(totalMin / done.length) : '–'}</div></div>
        <button class="metric metric-link" id="cv-dmg" ${allowed('damage') ? '' : 'disabled'}><div class="k">Open damage</div><div class="v">${openDmg}</div></button>`;
      if ($('cv-dmg')) $('cv-dmg').onclick = () => setView('damage');
      // One line per cleaning; tap it to see everything (checklist, key, videos and photos, damage).
      $('cv-list').innerHTML = cls.length ? cls.map((x) => `<button class="card cv-item cv-open" data-cid="${esc(x.id)}">
          <div class="hist-h"><b>${esc(x.label)} <span class="muted">· ${esc(x.building)}</span></b>
            <span class="${ACTIVE.includes(x.status) ? 'cb running' : 'cb done'}">${ACTIVE.includes(x.status) ? `<i></i>${STEP[x.status]}` : '✓ Completed'}</span></div>
          <div class="cv-meta"><span>${esc(x.cleanerName)}</span><span>Start ${fmtClock(x.startedAt)}</span><span>End ${x.endedAt ? fmtClock(x.endedAt) : '—'}</span>
            <span>Time <b ${x.endedAt ? '' : `data-since="${esc(x.startedAt)}"`}>${fmtDur((x.endedAt ? Date.parse(x.endedAt) : Date.now()) - Date.parse(x.startedAt))}</b></span>
            ${x.status === 'completed' ? `<span>Checks ${x.checklist.length}/${c.checklist.length}</span>` : ''}
            ${(x.media || []).length ? `<span>${x.media.filter((m) => m.kind === 'video').length} video${x.media.filter((m) => m.kind === 'video').length === 1 ? '' : 's'}${x.media.some((m) => m.kind === 'photo') ? ` · ${x.media.filter((m) => m.kind === 'photo').length} photos` : ''}</span>` : ''}
            ${x.key && x.key.mode === 'lockbox' ? `<span>Lockbox code <b>${esc(x.key.code)}</b></span>` : x.key && x.key.mode === 'keynest' ? '<span>Key at KeyNest ✓</span>' : ''}
            ${x.guesty === 'updated' ? '<span>Guesty ✓</span>' : x.guesty === 'failed' ? '<span class="warn">Guesty not updated</span>' : ''}</div>
          <span class="cv-more">View details</span>
        </button>`).join('') : '<div class="card empty"><b>No cleanings recorded</b>Nothing was started on this day.</div>';
      $('cv-list').querySelectorAll('[data-cid]').forEach((b) => b.onclick = () => openDetail(b.dataset.cid));
    } catch (e) { if (e.message !== 'signed out') $('cv-list').innerHTML = `<div class="banner error">${esc(e.message)}</div>`; }
  }

  // ---------- one cleaning, in full ----------
  let detailId = null;
  const fmtDay = (d) => (d ? `${WD_LONG.format(D(d))} ${D(d).getUTCDate()} ${MON.format(D(d))}` : '');
  async function openDetail(id) {
    detailId = id;
    $('detail').classList.remove('hidden');
    document.body.classList.add('noscroll');
    $('detail-body').innerHTML = '<div class="loading">Loading…</div>';
    try {
      const r = await getJSON('/api/cleanings/' + encodeURIComponent(id));
      const c = r.cleaning, defs = r.checklist || checklistDef;
      let dmg = [];
      try { dmg = (await getJSON('/api/damages?listingId=' + encodeURIComponent(c.listingId))).damages.filter((d) => d.cleaningId === c.id); } catch (_) {}
      if (detailId !== id) return;
      const t = (iso) => (iso ? fmtClock(iso) : '—');
      const took = c.endedAt ? durWords(Date.parse(c.endedAt) - Date.parse(c.startedAt)) : `${fmtDur(Date.now() - Date.parse(c.startedAt))} so far`;
      const state = c.status === 'completed' ? '<span class="pill ok">Completed</span>' : c.status === 'cancelled' ? '<span class="pill off">Cancelled</span>' : `<span class="pill">${esc(STEP[c.status] || c.status)}</span>`;
      const checks = defs.map((d) => { const got = (c.checklist || []).find((x) => x.key === d.key); return `<li class="${got ? 'ok' : 'no'}"><span class="dt-tick" aria-hidden="true">${got ? '✓' : '–'}</span><span><b>${esc(d.title)}</b> ${esc(d.text)}</span><em>${got ? t(got.confirmedAt) : 'Not confirmed'}</em></li>`; }).join('');
      const key = !c.keyMode && !c.key ? '<p class="muted">No key step for this flat.</p>'
        : c.key && c.key.mode === 'lockbox' ? `<p>Key back in the lockbox with a new code <b class="dt-code">${esc(c.key.code)}</b> · ${t(c.key.returnedAt)}</p>`
        : c.key && c.key.mode === 'keynest' ? `<p>Key in KeyNest ✓ (${esc(c.key.status || 'in store')}) · checked ${t(c.key.confirmedAt)}</p>`
        : `<p class="warn">Key not returned yet (${esc(c.keyMode === 'keynest' ? 'KeyNest' : 'lockbox')}).</p>`;
      // What KeyNest recorded for this flat's key around the cleaning (from its webhook): who collected it and when it came back.
      const KN_EV = { COLLECTED: 'Collected', DROPPED: 'Dropped off', HANDOVER: 'Handed over' };
      const moveWhen = (iso) => (londonDay(iso) === c.date ? '' : `${WD_SHORT.format(D(londonDay(iso)))} `) + fmtClock(iso);
      const moves = !r.keyMoves ? '' : r.keyMoves.length
        ? `<ul class="dt-moves">${r.keyMoves.map((m) => `<li><b>${esc(KN_EV[m.event] || m.event.charAt(0) + m.event.slice(1).toLowerCase())}</b><span>${esc(moveWhen(m.at))}</span><span class="muted">${esc([m.who, m.store].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>`
        : '<p class="muted">KeyNest recorded no movements of this key around the cleaning (perhaps a spare key was used).</p>';
      const guesty = c.guesty === 'updated' ? 'Marked clean ✓' : c.guesty === 'failed' ? '<span class="warn">Couldn’t update Guesty</span>' : c.guesty === 'preview' ? 'Sample data (not sent)' : c.guesty === 'off' ? 'Turned off' : c.status === 'completed' ? 'Sending…' : '—';
      $('detail-body').innerHTML = `
        <div class="sh-head"><div><h2>${esc(c.label)} <span class="muted dt-bld">· ${esc(c.building)}</span></h2><div class="sh-sub">${esc(fmtDay(c.date))} · ${esc(c.cleanerName)}</div></div><button class="btn sq" data-close-detail aria-label="Close">✕</button></div>
        <div class="dt-state">${state}</div>
        <dl class="dt-grid">
          <dt>Cleaner</dt><dd>${esc(c.cleanerName)}</dd>
          <dt>Started</dt><dd>${t(c.startedAt)}</dd>
          <dt>Ended</dt><dd>${t(c.endedAt)}</dd>
          <dt>Time taken</dt><dd>${esc(took)}</dd>
          <dt>Checks confirmed</dt><dd>${c.checksConfirmedAt ? `${t(c.checksConfirmedAt)} · held ${Math.round((c.checksHeldMs || 0) / 1000)} s` : '—'}</dd>
          <dt>Video uploaded</dt><dd>${t(c.videoAt)}</dd>
          <dt>Completed</dt><dd>${t(c.completedAt)}</dd>
          <dt>Guesty</dt><dd>${guesty}</dd>
          ${c.status === 'cancelled' ? `<dt>Cancelled</dt><dd>${t(c.cancelledAt)}${c.cancelledBy ? ' by ' + esc(c.cancelledBy) : ''}</dd>` : ''}
        </dl>
        <h3 class="sh-h3">Checklist · ${(c.checklist || []).length}/${defs.length}</h3>
        <ul class="dt-checks">${checks}</ul>
        <h3 class="sh-h3">Key</h3>
        ${key}${moves}
        <h3 class="sh-h3">Videos &amp; photos</h3>
        ${(c.media || []).length ? mediaTiles(c.media) : '<p class="muted">None uploaded.</p>'}
        <h3 class="sh-h3">Damage reported during this clean</h3>
        <div id="dt-dmg">${dmg.length ? dmg.map(damageCard).join('') : '<p class="muted">None.</p>'}</div>`;
      wireDamageCards($('dt-dmg'), () => openDetail(id));
    } catch (e) { if (e.message !== 'signed out') $('detail-body').innerHTML = `<div class="sh-head"><h2>Cleaning</h2><button class="btn sq" data-close-detail aria-label="Close">✕</button></div><div class="banner error">${esc(e.message)}</div>`; }
  }
  function closeDetail() { detailId = null; $('detail').classList.add('hidden'); if ($('sheet').classList.contains('hidden')) document.body.classList.remove('noscroll'); }
  $('detail').addEventListener('click', (e) => { if (e.target.id === 'detail' || e.target.closest('[data-close-detail]')) closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailId) closeDetail(); });

  // ---------- Damage reports (their own page) ----------
  let dmgFilter = 'open';
  async function loadDamageView() {
    const box = $('dmg-page');
    document.querySelectorAll('[data-dmg-filter]').forEach((b) => b.setAttribute('aria-selected', b.dataset.dmgFilter === dmgFilter));
    try {
      const d = await getJSON('/api/damages' + (dmgFilter === 'all' ? '' : '?status=' + dmgFilter));
      box.innerHTML = d.damages.length ? d.damages.map(damageCard).join('')
        : `<div class="card empty"><b>${dmgFilter === 'open' ? 'No open damage reports' : dmgFilter === 'resolved' ? 'Nothing resolved yet' : 'No damage reports'}</b>${dmgFilter === 'open' ? 'Everything reported has been dealt with.' : ''}</div>`;
      wireDamageCards(box, () => { loadDamageView(); refreshBadges(); });
    } catch (e) { if (e.message !== 'signed out') box.innerHTML = `<div class="banner error">${esc(e.message)}</div>`; }
  }
  document.querySelectorAll('[data-dmg-filter]').forEach((b) => b.onclick = () => { dmgFilter = b.dataset.dmgFilter; loadDamageView(); });

  // Sidebar badges: open damage reports, and a dot on Properties while a KeyNest flat isn't linked.
  async function refreshBadges() {
    if (!me) return;
    if (allowed('damage')) {
      try {
        const n = (await getJSON('/api/damages?status=open')).damages.length;
        $('nb-damage').textContent = n > 9 ? '9+' : String(n);
        $('nb-damage').classList.toggle('hidden', !n);
      } catch (_) {}
    }
    if (allowed('props')) {
      try { const p = await getJSON('/api/properties'); $('nd-props').classList.toggle('hidden', !(p.keynest && p.keynest.unlinked.length)); } catch (_) {}
    }
  }
  $('cv-date').onchange = (e) => { cvDate = e.target.value; loadCleaningView(); };
  $('cv-prev').onclick = () => { const d = new Date(cvDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); cvDate = d.toISOString().slice(0, 10); loadCleaningView(); };
  $('cv-next').onclick = () => { const d = new Date(cvDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); cvDate = d.toISOString().slice(0, 10); loadCleaningView(); };

  // =====================================================================
  // Notifications: bell with unread count + list, and phone notifications (Web Push)
  // =====================================================================
  let notifs = { items: [], unread: 0 };
  const ago = (iso) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const NICON = { cleaned: '✓', damage: '!', assigned: '→', unassigned: '×' };
  async function loadNotifs() {
    if (!me) return;
    try {
      notifs = await getJSON('/api/notifications');
      const n = $('bell-n');
      n.textContent = notifs.unread > 9 ? '9+' : String(notifs.unread);
      n.classList.toggle('hidden', !notifs.unread);
      $('bell').setAttribute('aria-label', notifs.unread ? `Notifications, ${notifs.unread} unread` : 'Notifications');
      try { if (navigator.setAppBadge) notifs.unread ? navigator.setAppBadge(notifs.unread) : navigator.clearAppBadge(); } catch (_) {}
      if (!$('notif').classList.contains('hidden')) renderNotifs();
    } catch (_) { /* try again next tick */ }
  }
  function renderNotifs() {
    const p = pushState();
    $('notif').innerHTML = `<div class="notif-card" role="dialog" aria-label="Notifications">
      <div class="notif-head"><h3>Notifications</h3>${notifs.unread ? '<button class="linkbtn inline" id="nf-all">Mark all as read</button>' : ''}<button class="btn sq" id="nf-close" aria-label="Close">✕</button></div>
      <div class="notif-push ${p.state}">${p.html}</div>
      <div class="notif-list">${notifs.items.length ? notifs.items.map((x) => `<button class="nitem ${x.read ? '' : 'unread'} t-${esc(x.type)}" data-nid="${esc(x.id)}" data-url="${esc(x.url)}">
          <span class="nico">${NICON[x.type] || '•'}</span><span class="ntext"><b>${esc(x.title)}</b><span>${esc(x.body)}</span><em>${esc(ago(x.at))}</em></span></button>`).join('')
        : '<div class="empty"><b>No notifications yet</b>You’ll see completed cleanings, damage reports and assignments here.</div>'}</div></div>`;
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('nf-close', closeNotifs);
    on('nf-all', async () => { try { await send('POST', '/api/notifications/read', { all: true }); } catch (_) {} loadNotifs(); });
    on('np-on', enablePush);
    on('np-off', disablePush);
    on('np-test', async () => { try { await send('POST', '/api/push/test'); toast('Test sent — check your phone'); } catch (e) { toast(e.message); } });
    $('notif').querySelectorAll('[data-nid]').forEach((b) => b.onclick = async () => {
      closeNotifs();
      send('POST', '/api/notifications/read', { ids: [b.dataset.nid] }).then(loadNotifs).catch(() => {});
      openLink(b.dataset.url);
    });
  }
  function openNotifs() { $('notif').classList.remove('hidden'); renderNotifs(); loadNotifs(); }
  function closeNotifs() { $('notif').classList.add('hidden'); }
  $('bell').onclick = () => ($('notif').classList.contains('hidden') ? openNotifs() : closeNotifs());
  $('notif').addEventListener('click', (e) => { if (e.target.id === 'notif') closeNotifs(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNotifs(); });
  setInterval(() => { if (!document.hidden) loadNotifs(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNotifs(); });

  // Opens the place a notification points to: ?view=day&date=…&flat=… or ?view=cleaning&date=…
  async function openLink(href) {
    let q; try { q = new URL(href, location.origin).searchParams; } catch (_) { return; }
    const v = q.get('view'), date = q.get('date'), flat = q.get('flat');
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '');
    if (v === 'cleaning' && allowed('cleaning')) { if (okDate) cvDate = date; if (view === 'cleaning') loadCleaningView(); else setView('cleaning'); return; }
    if (v === 'day' && allowed('day')) {
      if (view !== 'day') setView('day');
      if (okDate && (!data || !data.dates.includes(date))) await showWeek(date);
      if (okDate && data && data.dates.includes(date)) { selected = date; renderStrip(); renderDay(); }
      if (flat) { if (unitFor(flat)) openSheet(flat); else toast('That flat isn’t on the schedule for this day any more'); }
    }
  }

  // ---- phone notifications ----
  const b64uToBytes = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let pushOn = false;
  function pushState() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported && isIOS && !standalone) return { state: 'setup', html: `<b>Phone notifications</b><span>On iPhone, first add this app to your Home Screen: tap <b>Share</b> › <b>Add to Home Screen</b>, then open it from there and turn notifications on.</span>` };
    if (!supported) return { state: 'off', html: '<b>Phone notifications</b><span>This browser can’t show notifications.</span>' };
    if (Notification.permission === 'denied') return { state: 'off', html: '<b>Phone notifications are blocked</b><span>Allow notifications for this app in your phone’s Settings, then come back here.</span>' };
    if (pushOn) return { state: 'on', html: '<b>Phone notifications are on</b><span>You’ll get alerts even when the app is closed.</span><span class="np-btns"><button class="linkbtn inline" id="np-test">Send a test</button><button class="linkbtn inline" id="np-off">Turn off</button></span>' };
    return { state: 'offer', html: '<b>Get alerts on this phone</b><span>Even when the app is closed.</span><button class="btn primary" id="np-on">Turn on</button>' };
  }
  async function initPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') { openLink(e.data.url); loadNotifs(); } });
      const sub = await reg.pushManager.getSubscription();
      pushOn = Boolean(sub) && Notification.permission === 'granted';
      // Tell the server this phone belongs to whoever is signed in now (a shared phone may change hands).
      if (pushOn) await send('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
    } catch (_) { /* notifications stay off */ }
  }
  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications weren’t allowed'); renderNotifs(); return; }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const { publicKey } = await getJSON('/api/push/key');
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
      await send('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      pushOn = true; renderNotifs();
      send('POST', '/api/push/test').catch(() => {});
      toast('Phone notifications on ✓');
    } catch (e) { toast('Couldn’t turn on notifications: ' + (e.message || 'unknown error')); }
  }
  // Signing out: this phone stops getting the person's notifications (it may be a shared or borrowed phone).
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('a[href="/logout"]');
    if (!a || !('serviceWorker' in navigator)) return;
    e.preventDefault();
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await send('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    } catch (_) {}
    location.href = '/logout';
  });
  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await send('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    } catch (_) {}
    pushOn = false; renderNotifs(); toast('Phone notifications off');
  }

})();
