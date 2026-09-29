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
  const VIEW_PERM = { day: 'view_day', board: 'view_board', props: 'view_properties', cleaning: 'view_cleaning', damage: 'view_cleaning', users: 'manage_users', settings: null, account: null, forum: null, maintenance: null };
  // Admin and User roles run the operation: Settings/integrations and assigning cleanings (checked again on the server).
  const isManager = () => Boolean(me && (me.role === 'admin' || me.role === 'user'));
  const allowed = (v) => v in VIEW_PERM && (v === 'settings' ? isManager() : v === 'users' ? can('manage_users') || Boolean(me && me.role === 'supervisor') // supervisors manage the people they add
    : (!VIEW_PERM[v] || can(VIEW_PERM[v]) || ((v === 'cleaning' || v === 'damage') && can('manage_damage'))));
  // Sidebar: Schedule holds the Day and Week views; each other entry is one view.
  const NAV_OF = { day: 'schedule', board: 'schedule', cleaning: 'cleaning', damage: 'damage', props: 'props', users: 'users', settings: 'settings', forum: 'forum', maintenance: 'maintenance' };
  const navAllowed = (n) => (n === 'schedule' ? allowed('day') || allowed('board') : allowed(n));
  const TITLES = { day: 'Schedule', board: 'Schedule', cleaning: 'Cleaning log', damage: 'Damage reports', props: 'Properties', users: 'Users', settings: 'Settings', account: 'My account', forum: 'Forum', maintenance: 'Maintenance' };
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
    const { weekStart, weekEnd, today, totals, warnings, mock } = data;
    const isThisWeek = data.dates.includes(today);
    $('week-title').textContent = `${shortDate(weekStart)} – ${shortDate(weekEnd)}`;
    $('when').textContent = isThisWeek ? 'This week' : weekStart > today ? 'Upcoming' : 'Past week';
    $('this').classList.toggle('hidden', isThisWeek);
    $('newpill').innerHTML = totals.newBookings ? `<span class="newpill">${totals.newBookings} new booking${totals.newBookings > 1 ? 's' : ''}</span>` : '';

    const banners = [];
    if (mock) banners.push('<div class="banner">Showing <b>sample data</b>. Add your Guesty keys in Railway to see live bookings.</div>');
    for (const w of warnings || []) banners.push(`<div class="banner">${esc(w)}</div>`);
    $('banners').innerHTML = banners.join('');

    renderStrip();
    renderDay();
    if (view === 'board') renderBoard();
    setPageHead();
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
        <span class="dtop"><span class="dn">${WD_SHORT.format(D(d.date))}</span>${d.date === data.today ? '<span class="dtoday">Today</span>' : d.hasNew ? '<i class="newdot" title="New booking"></i>' : ''}</span>
        <span class="dd">${D(d.date).getUTCDate()}</span>
        <span class="dc"><b class="o">${d.cleans}</b><span class="lbl"> out</span><span class="sep"> · </span><b class="i">${d.arrivals}</b><span class="lbl"> in</span></span>
      </button>`;
    }).join('');
  }
  $('strip').addEventListener('click', (e) => {
    const b = e.target.closest('.dbtn');
    if (!b || b.dataset.date === selected) return;
    selected = b.dataset.date;
    $('strip').querySelectorAll('.dbtn').forEach((x) => x.setAttribute('aria-selected', x === b));
    renderDay();
    setPageHead();
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
  const KEY_ICON = { keynest: '<svg class="r-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-label="KeyNest" role="img"><title>KeyNest</title><circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2"/></svg>',
    lockbox: '<svg class="r-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-label="Lockbox" role="img"><title>Lockbox</title><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>' };
  // Where a time sits on the day's line, which runs from 07:00 to 21:00.
  const linePos = (hm) => { const m = /^(\d{1,2}):(\d\d)/.exec(hm || ''); return m ? Math.min(100, Math.max(0, ((Number(m[1]) + Number(m[2]) / 60 - 7) / 14) * 100)) : null; };
  const TICKS = ['07', '09', '11', '13', '15', '17', '19', '21'];
  function timeline(u) {
    const o = u.checkOut ? linePos(u.checkOut.timeRaw) : null, n = u.checkIn ? linePos(u.checkIn.timeRaw) : null;
    const from = o === null ? (n === null ? 0 : n) : o, to = n === null ? (o === null ? 0 : 100) : n;
    const mark = (cls, pos, e) => (pos === null ? '' : `<span class="r-m ${cls}" style="left:${pos}%"><em>${esc(e.time || '')}${e.planned ? '*' : ''}</em><i></i></span>`);
    return `<span class="r-line" aria-hidden="true"><i class="r-track"></i>${o !== null ? `<i class="r-win${n !== null ? ' turn' : ''}" style="left:${from}%;width:${Math.max(0, to - from)}%"></i>` : ''}${mark('o', o, u.checkOut || {})}${mark('n', n, u.checkIn || {})}</span>`;
  }
  function section(kind, title, hint, units) {
    if (!units.length) return '';
    const groups = groupByBuilding(units).map((g) => `
      <div class="bldg card">
        <div class="bldg-name">${esc(g.name)}<span>${esc(g.postcode)}</span><em>${g.units.length === 1 ? '1 flat' : `${g.units.length} flats`}</em></div>
        ${g.units.map((u) => {
          const isNew = (u.checkIn && u.checkIn.isNew) || (u.checkOut && u.checkOut.isNew);
          const guests = u.checkIn && u.checkIn.guests ? `${u.checkIn.guests} guest${u.checkIn.guests > 1 ? 's' : ''}` : '';
          const said = [u.label, u.checkOut && `out ${u.checkOut.time}`, u.checkIn && `in ${u.checkIn.time}`].filter(Boolean).join(', ');
          return `<div class="row tap" data-listing="${esc(u.listingId)}" role="button" tabindex="0" aria-label="Open ${esc(said)}">
            <span class="r-flat"><span class="r-l"><span class="u">${esc(u.label)}</span>${KEY_ICON[u.keyMode] || ''}${isNew ? '<span class="new">New</span>' : ''}</span>
              <span class="t">${esc(shortType(u.unitType))}${guests ? ` · ${guests}` : ''}</span></span>
            ${timeline(u)}
            <span class="r-who" data-achip="${esc(u.listingId)}" data-needs="${u.checkOut ? '1' : ''}"></span>
            <span class="r-st" data-cbadge="${esc(u.listingId)}" data-kind="${kind}"></span>
          </div>`;
        }).join('')}
      </div>`).join('');
    return `<section class="section s-${kind}">
      <div class="shead"><h2>${title}</h2><span class="hint">${hint} · ${units.length === 1 ? '1 flat' : `${units.length} flats`}</span></div>
      <div class="axis" aria-hidden="true"><span></span><span class="ax">${TICKS.map((t, i) => `<i style="left:${(i / 7) * 100}%">${t}</i>`).join('')}</span><span></span><span></span></div>
      ${groups}
    </section>`;
  }
  function renderDay() {
    const day = data.days.find((d) => d.date === selected);
    if (!day) return;
    const turn = day.units.filter((u) => u.checkOut && u.checkIn);
    const outs = day.units.filter((u) => u.checkOut && !u.checkIn);
    const ins = day.units.filter((u) => !u.checkOut && u.checkIn);
    const linenBits = can('view_linen') ? Object.entries(day.linen).map(([t, n]) => `${esc(shortType(t))} <b>${n}</b>`).join(' · ') : '';
    $('daypanel').innerHTML = `
      ${linenBits ? `<div class="dlinen">Linen for this day: ${linenBits}</div>` : ''}
      ${day.units.length ? '' : '<div class="card empty"><b>Nothing scheduled</b>No check-ins or check-outs on this day.</div>'}
      ${section('turn', 'Same-day turnovers', 'Guests leave and arrive the same day', turn)}
      ${section('out', 'Check-outs', 'Clean once the guest leaves', outs)}
      ${section('in', 'Arrivals', 'Make sure the flat is ready', ins)}`;
    decorateDay();
  }

  function renderBoard() {
    boardDirty = false;
    const { dates, days, board, today } = data;
    const head = `<colgroup><col class="first">${dates.map(() => '<col>').join('')}</colgroup>
      <thead><tr><th class="first-col"></th>${days.map((d) => `<th class="${d.date === today ? 'today' : ''}"><button data-date="${d.date}" title="Open ${esc(longDate(d.date))}">
        <div class="dn">${WD_SHORT.format(D(d.date))}</div><div class="dd">${D(d.date).getUTCDate()}</div><div class="dc"><b class="o">${d.cleans}</b> out · <b class="i">${d.arrivals}</b> in</div></button></th>`).join('')}</tr></thead>`;
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
    renderStrip(); renderDay(); setPageHead();
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
        ${b.units.map((u) => `<div class="prow${u.hidden ? ' off' : ''}" title="${esc(u.address)}"><span class="u">${esc(u.label)}</span><span>${esc(shortType(u.unitType))}</span><span class="t">Out ${esc(u.checkOut)} · In ${esc(u.checkIn)}</span>${p.canManage ? `<button class="btn pedit" data-edit="${esc(u.id)}" aria-label="Edit ${esc(u.label)}">Edit</button>` : ''}</div>
          ${u.hidden || u.edited ? `<div class="ptags">${u.hidden ? '<span class="ptag off">Hidden from the schedule</span>' : ''}${u.edited ? `<span class="ptag" title="${u.editedBy ? `Changed by ${esc(u.editedBy)}${u.editedAt ? `, ${esc(fmtWhen(u.editedAt))}` : ''}` : ''}">Edited in the app</span>` : ''}</div>` : ''}
          ${u.keyMode === 'lockbox' ? (u.lockboxNoCode ? noCodeBlock(u.keyInstruction) : lockboxBlock(u.lockbox)) : u.keyMode === 'keynest' ? '<div class="pnote"><span class="kbadge kn">KeyNest</span><span>Key must be back in KeyNest after each clean</span></div>' : ''}`).join('')}
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

  // The lockbox code, big: cleaners check it every time they arrive.
  const noCodeBlock = (instr) => (instr ? `<div class="lbx none"><span class="lbx-k">Key</span><span class="lbx-by lbx-i" title="${esc(instr)}">${esc(instr)}</span></div>`
    : '<div class="lbx none"><span class="lbx-k">Lockbox</span><span class="lbx-by">No code needed</span></div>');
  const lockboxBlock = (lb) => (lb
    ? `<div class="lbx" title="Set by ${esc(lb.by)}, ${esc(fmtWhen(lb.at))}"><span class="lbx-k">Lockbox code</span><b class="lbx-code">${esc(lb.code)}</b><span class="lbx-by">set by ${esc(lb.by)}, ${esc(fmtWhen(lb.at))}</span></div>`
    : '<div class="lbx none"><span class="lbx-k">Lockbox</span><span class="lbx-by">No code recorded yet</span></div>');
  $('props').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (!b || !props) return;
    for (const g of props.buildings) { const u = g.units.find((x) => x.id === b.dataset.edit); if (u) return openPropEditor(u); }
  });

  // ---------- editing a flat's details (Admin and User): on top of Guesty, blank = use Guesty's ----------
  const KEY_WORDS = { keynest: 'KeyNest', lockbox: 'Lockbox', none: 'No key step' };
  function openPropEditor(u) {
    detailId = null;
    const g = u.guesty || {};
    const own = (k) => (u[k] !== g[k] ? u[k] || '' : '');
    const keyOwn = u.keyMode === g.keyMode ? '' : u.keyMode || 'none';
    const bl = [...new Set(props.buildings.map((b) => b.name))];
    const field = (id, label, input, guesty) => `<div class="pe-f"><label for="${id}">${label}</label>${input}<span class="pe-g">Guesty: ${esc(guesty || '—')}</span></div>`;
    $('detail').classList.remove('hidden');
    document.body.classList.add('noscroll');
    $('detail-body').innerHTML = `
      <div class="sh-head"><div class="sh-title"><span class="eyebrow">Edit property</span><h2>${esc(u.label)}</h2><div class="sh-sub">Leave a box empty to use Guesty’s details. Changes show for everyone straight away.</div></div>
        <div class="sh-right"><button class="btn sq" data-close-detail aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></div>
      <form class="pe-form" id="pe-form" autocomplete="off">
        ${field('pe-label', 'Flat name', `<input id="pe-label" maxlength="40" value="${esc(own('label'))}" placeholder="${esc(g.label)}">`, g.label)}
        ${field('pe-building', 'Building (flats with the same building are grouped together)', `<input id="pe-building" maxlength="80" list="pe-bl" value="${esc(own('building'))}" placeholder="${esc(g.building)}"><datalist id="pe-bl">${bl.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`, g.building)}
        ${field('pe-address', 'Address', `<input id="pe-address" maxlength="200" value="${esc(own('address'))}" placeholder="${esc(g.address)}">`, g.address)}
        <div class="pe-row">
          ${field('pe-postcode', 'Postcode', `<input id="pe-postcode" maxlength="9" value="${esc(own('postcode'))}" placeholder="${esc(g.postcode)}">`, g.postcode)}
          ${field('pe-type', 'Bedrooms', `<select id="pe-type"><option value="">Use Guesty’s (${esc(shortType(g.unitType))})</option>${(props.unitTypes || []).map((t) => `<option value="${esc(t)}" ${own('unitType') === t ? 'selected' : ''}>${esc(shortType(t))}</option>`).join('')}</select>`, shortType(g.unitType))}
        </div>
        <div class="pe-row">
          ${field('pe-out', 'Check-out time', `<input id="pe-out" type="time" value="${esc(own('checkOutTime'))}">`, g.checkOutTime)}
          ${field('pe-in', 'Check-in time', `<input id="pe-in" type="time" value="${esc(own('checkInTime'))}">`, g.checkInTime)}
        </div>
        ${field('pe-key', 'Key returned by', `<select id="pe-key"><option value="">Use Guesty’s tag (${esc(KEY_WORDS[g.keyMode || 'none'])})</option>${Object.entries(KEY_WORDS).map(([k, w]) => `<option value="${k}" ${keyOwn === k ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>`, KEY_WORDS[g.keyMode || 'none'])}
        <label class="pe-check" id="pe-code-row"><input type="checkbox" id="pe-code" ${u.lockboxNoCode ? '' : 'checked'}> Ask for a new lockbox code after each clean</label>
        <div class="pe-f" id="pe-instr-row"><label for="pe-instr">What should the cleaner do with the key? <span class="muted">(optional)</span></label><input id="pe-instr" maxlength="300" value="${esc(u.keyInstruction || '')}" placeholder="Put the key back in the lockbox and close it."><span class="pe-g">Shown as the cleaner’s last step instead of a new code.</span></div>
        <label class="pe-check"><input type="checkbox" id="pe-show" ${u.hidden ? '' : 'checked'}> Show this flat on the schedule</label>
        <div id="pe-review"></div>
        <div class="form-actions">${u.edited ? '<button type="button" class="btn" id="pe-reset">Reset to Guesty</button>' : ''}<span class="spacer"></span><button type="button" class="btn" data-close-detail>Cancel</button><button type="submit" class="btn primary" id="pe-go">Review changes</button></div>
      </form>`;
    const val = (id) => $(id).value.trim();
    const fields = () => ({ label: val('pe-label'), building: val('pe-building'), address: val('pe-address'), postcode: val('pe-postcode').toUpperCase(),
      unitType: $('pe-type').value, checkOutTime: $('pe-out').value, checkInTime: $('pe-in').value, keyMode: $('pe-key').value, hidden: !$('pe-show').checked,
      lockboxNoCode: isLockbox($('pe-key').value) && !$('pe-code').checked,
      keyInstruction: isLockbox($('pe-key').value) && !$('pe-code').checked ? val('pe-instr') : '' });
    // Only lockbox flats have the "new code" question.
    const isLockbox = (k) => (k || g.keyMode) === 'lockbox';
    const codeRow = () => {
      $('pe-code-row').classList.toggle('hidden', !isLockbox($('pe-key').value));
      $('pe-instr-row').classList.toggle('hidden', !isLockbox($('pe-key').value) || $('pe-code').checked);
    };
    $('pe-key').onchange = codeRow; $('pe-code').onchange = codeRow; codeRow();
    const now = (f) => ({ label: f.label || g.label, building: f.building || g.building, address: f.address || g.address, postcode: f.postcode || g.postcode,
      unitType: shortType(f.unitType || g.unitType), checkOutTime: f.checkOutTime || g.checkOutTime, checkInTime: f.checkInTime || g.checkInTime,
      keyMode: KEY_WORDS[f.keyMode || g.keyMode || 'none'], shown: f.hidden ? 'Hidden' : 'Shown',
      code: (f.keyMode || g.keyMode) === 'lockbox' ? (f.lockboxNoCode ? 'Not needed' : 'Asked after each clean') : '—',
      instr: (f.keyMode || g.keyMode) === 'lockbox' && f.lockboxNoCode ? f.keyInstruction || 'Standard (lockbox)' : '—' });
    const WORD = { label: 'Flat name', building: 'Building', address: 'Address', postcode: 'Postcode', unitType: 'Bedrooms', checkOutTime: 'Check-out time', checkInTime: 'Check-in time', keyMode: 'Key returned by', code: 'New lockbox code', instr: 'Key instruction', shown: 'On the schedule' };
    const save = async (body, done) => {
      try {
        await send('PUT', `/api/properties/${encodeURIComponent(u.id)}`, { confirmed: true, ...body });
        toast(done); closeDetail(); props = null; loadProps();
        if (data) { weeks.clear(); showWeek(data.weekStart, { quiet: true }); }
      } catch (e) { toast(e.message); }
    };
    $('pe-form').onsubmit = (e) => {
      e.preventDefault();
      const before = now({ ...Object.fromEntries(['label', 'building', 'address', 'postcode', 'unitType', 'checkOutTime', 'checkInTime'].map((k) => [k, own(k)])), keyMode: keyOwn, hidden: u.hidden, lockboxNoCode: Boolean(u.lockboxNoCode), keyInstruction: u.keyInstruction || '' });
      const f = fields(), after = now(f);
      const diff = Object.keys(WORD).filter((k) => before[k] !== after[k]);
      if (!diff.length) { $('pe-review').innerHTML = '<p class="muted">Nothing has changed yet.</p>'; return; }
      $('pe-review').innerHTML = `<div class="confirm-box"><b>Save these changes to ${esc(u.label)}?</b><ul>${diff.map((k) => `<li>${esc(WORD[k])}: ${esc(before[k] || '—')} → <b>${esc(after[k] || '—')}</b></li>`).join('')}</ul><p class="muted">Everyone sees the change on the schedule straight away. Guesty itself isn’t changed.</p>
        <div class="form-actions"><button type="button" class="btn" id="pe-back">Back</button><button type="button" class="btn primary" id="pe-save">Save changes</button></div></div>`;
      $('pe-go').disabled = true;
      $('pe-back').onclick = () => { $('pe-review').innerHTML = ''; $('pe-go').disabled = false; };
      $('pe-save').onclick = () => save({ fields: f }, `${u.label} updated`);
    };
    if ($('pe-reset')) $('pe-reset').onclick = () => confirm(`Use Guesty’s details for ${u.label} again? Your changes to this flat are removed.`) && save({ reset: true }, `${u.label} is back to Guesty’s details`);
  }

  function fmtWhen(iso) { return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }

  // ---------- Maintenance: issues at flats, triaged by Admins/Users, done by a team member or a contractor ----------
  let mtCache = null, mtFilter = 'open', mtMine = false, taskId = null;
  const PRIO = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
  const MT_ST = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled' };
  const MT_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
  const everyText = (r) => (r ? `Every ${r.every === 1 ? '' : r.every + ' '}${r.every === 1 ? r.unit.replace(/s$/, '') : r.unit}` : '');
  const todayStr = () => (data && data.today) || londonDay(new Date().toISOString());
  function dueText(t) {
    if (!t.due) return '';
    const days = Math.round((D(t.due) - D(todayStr())) / 864e5);
    if (['done', 'cancelled'].includes(t.status) || days > 6) return `Due ${WD_SHORT.format(D(t.due))} ${shortDate(t.due)}`;
    return days < 0 ? `Overdue by ${-days} day${days === -1 ? '' : 's'}` : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due ${WD_LONG.format(D(t.due))}`;
  }
  const whoHtml = (a) => (!a ? '<span class="mt-who none">Not assigned</span>'
    : a.type === 'contractor' ? `<span class="mt-who"><span class="avatar sm ct" aria-hidden="true">${ICONS.tool}</span>${esc(a.name)}${a.trade ? ` <em>· ${esc(a.trade)}</em>` : ''}</span>`
    : `<span class="mt-who"><span class="avatar sm">${esc(initials(a.name))}</span>${a.id === me.id ? 'You' : esc(a.name)}</span>`);
  const mtCard = (t) => `<button class="card mtask${t.overdue ? ' late' : ''}" data-task="${esc(t.id)}">
      <span class="mt-top"><span class="prio ${esc(t.priority)}">${esc(PRIO[t.priority])}</span><span class="mst ${esc(t.status)}">${esc(MT_ST[t.status])}</span>${t.repeat ? `<span class="mt-rep" title="${esc(everyText(t.repeat))}">${ICONS.repeat}${esc(everyText(t.repeat))}</span>` : ''}<span class="mt-flat">${esc(t.label)} · ${esc(t.building)}</span></span>
      <span class="mt-title">${esc(t.title)}</span>
      <span class="mt-bot">${whoHtml(t.assignee)}${t.due ? `<span class="mt-due${t.overdue ? ' late' : ''}">${esc(dueText(t))}</span>` : ''}${(t.media || []).length ? `<span class="mt-n">${(t.media || []).length} photo${(t.media || []).length === 1 ? '' : 's'}</span>` : ''}</span>
    </button>`;
  async function loadMaintenance() {
    if (!mtCache) $('mt-list').innerHTML = '<div class="card"><div class="loading">Loading…</div></div>';
    try { mtCache = await getJSON('/api/maintenance?status=' + mtFilter); renderMaintenance(); }
    catch (e) { if (e.message !== 'signed out') $('mt-list').innerHTML = `<div class="banner error">${esc(e.message)}</div>`; }
  }
  function renderMaintenance() {
    if (!mtCache) return;
    const list = mtCache.tasks.filter((t) => !mtMine || (t.assignee && t.assignee.type === 'user' && t.assignee.id === me.id) || t.reporterId === me.id)
      .sort((a, b) => (mtFilter === 'done' ? (b.doneAt || '').localeCompare(a.doneAt || '') : (b.overdue - a.overdue) || (MT_ORDER[a.priority] - MT_ORDER[b.priority]) || (a.due || '9999').localeCompare(b.due || '9999') || b.createdAt.localeCompare(a.createdAt)));
    const c = mtCache.counts;
    $('mt-sum').innerHTML = mtFilter === 'open' ? [c.mine && `<span class="mt-chip"><b>${c.mine}</b> for you</span>`, mtCache.canManage && c.unassigned && `<span class="mt-chip warn"><b>${c.unassigned}</b> not assigned</span>`, c.overdue && `<span class="mt-chip bad"><b>${c.overdue}</b> overdue</span>`].filter(Boolean).join('') : '';
    $('mt-list').innerHTML = list.length ? list.map(mtCard).join('') : `<div class="card empty"><b>${mtFilter === 'done' ? 'Nothing done yet' : 'Nothing to do'}</b>${mtFilter === 'open' ? 'Report an issue with New task, or from a flat’s panel.' : ''}</div>`;
  }
  document.querySelectorAll('[data-mtf]').forEach((b) => b.onclick = () => { mtFilter = b.dataset.mtf; document.querySelectorAll('[data-mtf]').forEach((x) => x.setAttribute('aria-selected', x === b)); mtCache = null; loadMaintenance(); });
  $('mt-mine').onclick = () => { mtMine = !mtMine; $('mt-mine').setAttribute('aria-pressed', mtMine); renderMaintenance(); };
  $('mt-new').onclick = () => taskForm({});
  $('mt-list').addEventListener('click', (e) => { const b = e.target.closest('[data-task]'); if (b) openTask(b.dataset.task); });
  async function loadSheetMaint(listingId) {
    const box = $('sheet-maint');
    if (!box) return;
    try {
      const r = await getJSON('/api/maintenance?status=open&listingId=' + encodeURIComponent(listingId));
      if ($('sheet-maint') !== box || sheetListing !== listingId) return;
      box.innerHTML = r.tasks.length ? `<h3 class="sh-h3">Maintenance · ${r.tasks.length} to do</h3><div class="mt-mini">${r.tasks.map(mtCard).join('')}</div>` : '';
      box.querySelectorAll('[data-task]').forEach((b) => b.onclick = () => openTask(b.dataset.task));
    } catch (_) {}
  }
  // Photos and videos for a task: uploaded as soon as they're picked (same resumable uploads as cleanings).
  function mediaPicker(listingId, onChange) {
    const keys = [];
    const html = `<div class="ev-btns"><label class="btn file"><input type="file" accept="image/*" capture="environment" data-mp="cam">Take photo</label><label class="btn file"><input type="file" accept="video/*,image/*" multiple data-mp="pick">Choose photos/videos</label></div><div class="mp-list"></div>`;
    const busy = () => keys.some((k) => { const x = uploads.get(k); return x && !x.done && !x.error; });
    const ids = () => keys.map((k) => uploads.get(k)).filter((x) => x && x.done).map((x) => x.id);
    const wire = (root) => {
      const draw = () => {
        const l = root.querySelector('.mp-list');
        if (l) l.innerHTML = keys.map((k) => { const x = uploads.get(k); return `<div class="up ${x.error ? 'err' : x.done ? 'ok' : ''}"><span class="up-k">${x.kind === 'video' ? 'Video' : 'Photo'}</span><span class="up-n">${esc(x.file.name || x.kind)}</span><span class="up-s">${x.error ? esc(x.error) : x.done ? 'Uploaded ✓' : Math.floor(x.progress * 100) + '%'}</span><span class="up-bar"><i style="transform:scaleX(${x.done ? 1 : x.progress})"></i></span></div>`; }).join('');
        onChange && onChange(busy());
      };
      root.querySelectorAll('[data-mp]').forEach((inp) => inp.onchange = (e) => {
        for (const f of e.target.files) { const key = Math.random().toString(36).slice(2); uploads.set(key, { file: f, kind: (f.type || '').startsWith('image') ? 'photo' : 'video', progress: 0, done: false, error: null, purpose: 'maintenance', listingId: listingId() }); keys.push(key); runUpload(key, draw); }
        e.target.value = ''; draw();
      });
    };
    return { html, wire, busy, ids, clear: () => keys.forEach((k) => uploads.delete(k)) };
  }
  let mtFlats = null;
  async function flatsForForm() {
    if (mtFlats) return mtFlats;
    try { const p = props || (await getJSON('/api/properties')); mtFlats = p.buildings.flatMap((b) => b.units.filter((u) => !u.hidden).map((u) => ({ id: u.id, label: u.label, building: b.name }))); }
    catch (_) { mtFlats = data ? [...new Map(data.board.flatMap((b) => b.units.map((u) => [u.listingId, { id: u.listingId, label: u.label, building: b.name }]))).values()] : []; }
    return mtFlats;
  }
  const UNITS = [['days', 'days'], ['weeks', 'weeks'], ['months', 'months'], ['years', 'years']];
  // New task (anyone) or editing one (Admin/User). Triage fields — who, due, repeat, cost — are for Admins and Users.
  async function taskForm(pre) {
    const t = pre.id ? pre : null, mgr = isManager();
    const flats = pre.listingId ? null : await flatsForForm();
    openDrawer(`<div class="sh-head"><div class="sh-title"><span class="eyebrow">Maintenance</span><h2>${t ? 'Edit task' : mgr ? 'New task' : 'Report an issue'}</h2><div class="sh-sub">${pre.listingId ? `${esc(pre.label || '')} · ${esc(pre.building || '')}` : 'Pick the flat, then say what needs doing.'}</div></div><div class="sh-right">${CLOSE_BTN}</div></div>
      <form class="pe-form" id="mt-form" autocomplete="off">
        ${flats ? `<div class="pe-f"><label for="mt-flat">Flat</label><select id="mt-flat" required><option value="">Pick a flat…</option>${flats.map((f) => `<option value="${esc(f.id)}">${esc(f.label)} · ${esc(f.building)}</option>`).join('')}</select></div>` : ''}
        <div class="pe-f"><label for="mt-title">What needs doing?</label><input id="mt-title" maxlength="140" required value="${esc(pre.title || '')}" placeholder="e.g. Shower is leaking, replace bathroom light bulb"></div>
        <div class="pe-f"><label for="mt-details">Details <span class="muted">(optional)</span></label><textarea id="mt-details" rows="4" maxlength="4000" placeholder="Where exactly, what you’ve noticed, anything that would help">${esc(pre.details || '')}</textarea></div>
        <div class="pe-f"><span class="pe-l">Priority</span><div class="range fkinds" role="radiogroup" aria-label="Priority">${Object.entries(PRIO).map(([k, w]) => `<button type="button" role="radio" data-p="${k}" aria-checked="${(pre.priority || 'normal') === k}" aria-selected="${(pre.priority || 'normal') === k}">${w}</button>`).join('')}</div></div>
        ${mgr ? `
        <div class="pe-f"><label for="mt-who">Who’s doing it?</label><select id="mt-who"><option value="">Not assigned yet</option><option value="c" ${t && t.assignee && t.assignee.type === 'contractor' ? 'selected' : ''}>A contractor…</option></select></div>
        <div class="mt-ct ${t && t.assignee && t.assignee.type === 'contractor' ? '' : 'hidden'}" id="mt-ct">
          <div class="pe-row"><div class="pe-f"><label for="mt-cname">Contractor’s name</label><input id="mt-cname" maxlength="80" list="mt-cbook" value="${esc(t && t.assignee && t.assignee.type === 'contractor' ? t.assignee.name : '')}"><datalist id="mt-cbook">${((mtCache && mtCache.contractors) || []).map((c) => `<option value="${esc(c.name)}">${esc(c.trade || c.phone)}</option>`).join('')}</datalist></div>
          <div class="pe-f"><label for="mt-cphone">Phone</label><input id="mt-cphone" type="tel" maxlength="30" value="${esc(t && t.assignee && t.assignee.type === 'contractor' ? t.assignee.phone : '')}"></div></div>
          <div class="pe-f"><label for="mt-ctrade">Trade <span class="muted">(optional)</span></label><input id="mt-ctrade" maxlength="60" placeholder="e.g. Plumber, electrician" value="${esc(t && t.assignee && t.assignee.type === 'contractor' ? t.assignee.trade || '' : '')}"></div>
        </div>
        <div class="pe-row"><div class="pe-f"><label for="mt-due">Due date <span class="muted">(optional)</span></label><input id="mt-due" type="date" value="${esc((t && t.due) || '')}"></div>
          <div class="pe-f"><label for="mt-cost">Cost £ <span class="muted">(optional)</span></label><input id="mt-cost" type="number" min="0" step="0.01" inputmode="decimal" value="${t && t.cost !== null && t.cost !== undefined ? esc(t.cost) : ''}"></div></div>
        <label class="pe-check"><input type="checkbox" id="mt-rep" ${t && t.repeat ? 'checked' : ''}> Repeats (e.g. gas safety every 12 months)</label>
        <div class="pe-row mt-repbox ${t && t.repeat ? '' : 'hidden'}" id="mt-repbox"><div class="pe-f"><label for="mt-every">Every</label><input id="mt-every" type="number" min="1" max="60" value="${esc((t && t.repeat && t.repeat.every) || 12)}"></div>
          <div class="pe-f"><label for="mt-unit">&nbsp;</label><select id="mt-unit">${UNITS.map(([k, w]) => `<option value="${k}" ${((t && t.repeat && t.repeat.unit) || 'months') === k ? 'selected' : ''}>${w}</option>`).join('')}</select></div></div>` : ''}
        ${t ? '' : `<div class="pe-f"><span class="pe-l">Photos or videos <span class="muted">(optional)</span></span><div id="mt-media"></div></div>`}
        <div class="form-msg" id="mt-msg"></div>
        <div class="form-actions"><span class="spacer"></span><button type="button" class="btn" data-close-detail>Cancel</button><button type="submit" class="btn primary" id="mt-go">${t ? 'Save' : mgr ? 'Create task' : 'Send report'}</button></div>
      </form>`);
    let prio = pre.priority || 'normal';
    $('mt-form').querySelectorAll('[data-p]').forEach((b) => b.onclick = () => { prio = b.dataset.p; $('mt-form').querySelectorAll('[data-p]').forEach((x) => { x.setAttribute('aria-checked', x === b); x.setAttribute('aria-selected', x === b); }); });
    const flatId = () => pre.listingId || ($('mt-flat') && $('mt-flat').value) || '';
    let picker = null;
    if (!t) {
      picker = mediaPicker(flatId, (busy) => { $('mt-go').disabled = busy; $('mt-go').textContent = busy ? 'Uploading…' : mgr ? 'Create task' : 'Send report'; });
      $('mt-media').innerHTML = picker.html;
      picker.wire($('mt-media'));
    }
    if (mgr) {
      const sel = $('mt-who');
      const cur = t && t.assignee && t.assignee.type === 'user' ? t.assignee : null;
      const loadPeople = async () => {
        const id = flatId();
        const keep = sel.value;
        [...sel.querySelectorAll('option[data-u]')].forEach((o) => o.remove());
        if (!id) return;
        try {
          const r = await getJSON('/api/maintenance/people?listingId=' + encodeURIComponent(id));
          sel.querySelector('option[value="c"]').insertAdjacentHTML('beforebegin', r.people.map((p) => `<option data-u value="u:${esc(p.id)}">${esc(p.name)} (${esc(p.role)})</option>`).join(''));
          sel.value = cur ? `u:${cur.id}` : keep;
        } catch (_) {}
      };
      loadPeople();
      if ($('mt-flat')) $('mt-flat').onchange = loadPeople;
      sel.onchange = () => $('mt-ct').classList.toggle('hidden', sel.value !== 'c');
      $('mt-cname').oninput = () => { const c = ((mtCache && mtCache.contractors) || []).find((x) => x.name === $('mt-cname').value); if (c) { $('mt-cphone').value = c.phone; if (!$('mt-ctrade').value) $('mt-ctrade').value = c.trade || ''; } };
      $('mt-rep').onchange = () => $('mt-repbox').classList.toggle('hidden', !$('mt-rep').checked);
    }
    $('mt-form').onsubmit = async (e) => {
      e.preventDefault();
      if (picker && picker.busy()) return toast('Wait for the upload to finish');
      const b = { title: $('mt-title').value, details: $('mt-details').value, priority: prio };
      if (!t) Object.assign(b, { listingId: flatId(), mediaIds: [...(pre.mediaIds || []), ...(picker ? picker.ids() : [])], damageId: pre.damageId || null });
      if (mgr) {
        const w = $('mt-who').value;
        b.assignee = !w ? null : w === 'c' ? { type: 'contractor', name: $('mt-cname').value, phone: $('mt-cphone').value, trade: $('mt-ctrade').value } : { type: 'user', id: w.slice(2) };
        b.due = $('mt-due').value || '';
        b.cost = $('mt-cost').value;
        b.repeat = $('mt-rep').checked ? { every: Number($('mt-every').value), unit: $('mt-unit').value } : null;
      }
      $('mt-go').disabled = true;
      try {
        const r = t ? await send('PUT', `/api/maintenance/${encodeURIComponent(t.id)}`, b) : await send('POST', '/api/maintenance', b);
        if (picker) picker.clear();
        toast(t ? 'Saved' : mgr ? 'Task created' : 'Reported — thank you');
        mtCache = null; if (view === 'maintenance') loadMaintenance(); refreshBadges();
        if (sheetListing && !$('sheet').classList.contains('hidden')) loadSheetMaint(sheetListing);
        openTask(r.task.id);
      } catch (err) { $('mt-msg').className = 'form-msg err'; $('mt-msg').textContent = err.message; $('mt-go').disabled = false; }
    };
  }
  async function openTask(id) {
    try {
      const { task: t } = await getJSON(`/api/maintenance/${encodeURIComponent(id)}`);
      const done = ['done', 'cancelled'].includes(t.status);
      const moves = !t.canMove ? [] : done ? [['open', 'Reopen']] : [
        ...(t.status !== 'in_progress' ? [['in_progress', 'Start']] : []), ...(t.status !== 'waiting' ? [['waiting', 'Waiting (parts, access…)']] : []), ['done', 'Mark done'],
      ];
      const note = mediaPicker(() => t.listingId, (busy) => { if ($('mn-go')) $('mn-go').disabled = busy; });
      openDrawer(`<div class="sh-head"><div class="sh-title"><span class="eyebrow">Maintenance · ${esc(t.label)} · ${esc(t.building)}</span><h2 class="fp-h">${esc(t.title)}</h2>
          <div class="sh-sub">Added by ${esc(t.reporterName)} · ${esc(fmtWhen(t.createdAt))}</div></div><div class="sh-right"><span class="mst ${esc(t.status)}">${esc(MT_ST[t.status])}</span>${CLOSE_BTN}</div></div>
        ${moves.length ? `<div class="mt-moves">${moves.map(([s, w]) => `<button class="btn ${s === 'done' ? 'primary' : ''}" data-move="${s}">${esc(w)}</button>`).join('')}</div>` : ''}
        <dl class="mt-facts">
          <div><dt>Priority</dt><dd><span class="prio ${esc(t.priority)}">${esc(PRIO[t.priority])}</span></dd></div>
          <div><dt>Due</dt><dd class="${t.overdue ? 'late' : ''}">${t.due ? esc(dueText(t)) : '—'}</dd></div>
          <div><dt>Who</dt><dd>${whoHtml(t.assignee)}${t.assignee && t.assignee.type === 'contractor' && t.assignee.phone ? ` <a class="mt-tel" href="tel:${esc(t.assignee.phone.replace(/[^\d+]/g, ''))}">${esc(t.assignee.phone)}</a>` : ''}</dd></div>
          <div><dt>Repeats</dt><dd>${t.repeat ? esc(everyText(t.repeat)) : 'No'}</dd></div>
          ${t.cost !== null && t.cost !== undefined ? `<div><dt>Cost</dt><dd>£${esc(Number(t.cost).toFixed(2))}</dd></div>` : ''}
          ${t.doneAt ? `<div><dt>Done</dt><dd>${esc(fmtWhen(t.doneAt))} by ${esc(t.doneBy || '')}</dd></div>` : ''}
        </dl>
        ${t.details ? `<div class="fp-body">${esc(t.details)}</div>` : ''}
        ${(t.media || []).length ? `<h3 class="sh-h3">Photos & videos</h3>${mediaTiles(t.media)}` : ''}
        <h3 class="sh-h3">Updates</h3>
        <ol class="mt-log">${(t.log || []).slice().reverse().map((l) => `<li class="${esc(l.kind)}"><span class="mt-lt">${l.kind === 'note' ? `<b>${esc(l.byName)}</b> ${esc(l.text)}` : `${esc(l.text)} <span class="muted">· ${esc(l.byName)}</span>`}</span><em>${esc(ago(l.at))}</em></li>`).join('')}</ol>
        ${t.canMove || t.reporterId === me.id ? `<form class="fc-form" id="mn-form"><label for="mn-text" class="pe-l">Add an update</label><textarea id="mn-text" rows="2" maxlength="2000" placeholder="e.g. Plumber booked for Thursday 10am"></textarea>${note.html}<div class="form-actions"><span class="spacer"></span><button type="submit" class="btn primary" id="mn-go">Add</button></div></form>` : ''}
        ${t.canManage ? `<div class="mt-admin"><button class="btn" id="mt-edit">Edit task</button>${!done ? '<button class="linkbtn" data-move="cancelled">Cancel task</button>' : ''}<button class="linkbtn fp-del" id="mt-del">Delete</button></div>` : ''}`);
      taskId = id;
      if ($('mn-form')) note.wire($('mn-form'));
      $('detail-body').querySelectorAll('[data-move]').forEach((b) => b.onclick = async () => {
        if (b.dataset.move === 'cancelled' && !confirm('Cancel this task?')) return;
        try {
          const r = await send('POST', `/api/maintenance/${encodeURIComponent(id)}/status`, { status: b.dataset.move });
          toast(r.next ? `Done — next one due ${shortDate(r.next.due)}` : `Marked ${MT_ST[b.dataset.move].toLowerCase()}`);
          mtCache = null; if (view === 'maintenance') loadMaintenance(); refreshBadges(); openTask(id);
        } catch (e) { toast(e.message); }
      });
      if ($('mn-form')) $('mn-form').onsubmit = async (e) => {
        e.preventDefault();
        if (note.busy()) return toast('Wait for the upload to finish');
        try { await send('POST', `/api/maintenance/${encodeURIComponent(id)}/notes`, { text: $('mn-text').value, mediaIds: note.ids() }); note.clear(); openTask(id); mtCache = null; if (view === 'maintenance') loadMaintenance(); }
        catch (err) { toast(err.message); }
      };
      if ($('mt-edit')) $('mt-edit').onclick = () => taskForm(t);
      if ($('mt-del')) $('mt-del').onclick = async () => {
        if (!confirm('Delete this task and its updates? This can’t be undone.')) return;
        try { await send('DELETE', `/api/maintenance/${encodeURIComponent(id)}`); toast('Task deleted'); closeDetail(); mtCache = null; if (view === 'maintenance') loadMaintenance(); refreshBadges(); } catch (e) { toast(e.message); }
      };
    } catch (e) { if (e.message !== 'signed out') toast(e.message); }
  }

  // ---------- Forum: bugs, ideas and questions from the team, with likes, dislikes and comments ----------
  let forumCache = null, fKind = '', fSort = 'new', postId = null;
  const KIND = { bug: 'Bug', idea: 'Idea', question: 'Question', other: 'Other' };
  const THUMB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10.5V20H4.5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1H7zm0 0 3.6-6.3a1.9 1.9 0 0 1 3.5 1V9h4.7a2 2 0 0 1 2 2.3l-1.1 6.9A2.2 2.2 0 0 1 17.5 20H7"/></svg>';
  const BUBBLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 19.5 6 15.8A7.5 7.5 0 1 1 9 18.6z"/></svg>';
  const statusPill = (p) => (p.status === 'fixed' ? '<span class="fstat fixed">Fixed</span>' : p.status === 'closed' ? '<span class="fstat closed">Closed</span>' : '');
  const votes = (p) => `<button class="vote up${p.myVote === 1 ? ' on' : ''}" data-vote="1" data-id="${esc(p.id)}" aria-pressed="${p.myVote === 1}" aria-label="Like (${p.likes})">${THUMB}<b>${p.likes}</b></button>
    <button class="vote down${p.myVote === -1 ? ' on' : ''}" data-vote="-1" data-id="${esc(p.id)}" aria-pressed="${p.myVote === -1}" aria-label="Dislike (${p.dislikes})">${THUMB}<b>${p.dislikes}</b></button>`;
  async function loadForum() {
    store.set('cs_forum_seen', new Date().toISOString());
    $('nd-forum').classList.add('hidden');
    if (!forumCache) $('forum-list').innerHTML = '<div class="card"><div class="loading">Loading…</div></div>';
    try { forumCache = await getJSON('/api/forum'); renderForum(); }
    catch (e) { if (e.message !== 'signed out') $('forum-list').innerHTML = `<div class="banner error">${esc(e.message)}</div>`; }
  }
  function renderForum() {
    if (!forumCache) return;
    const score = (p) => p.likes - p.dislikes;
    const list = forumCache.posts.filter((p) => !fKind || p.kind === fKind).sort((a, b) => (fSort === 'top' ? score(b) - score(a) || b.likes - a.likes : 0) || b.at.localeCompare(a.at));
    $('forum-list').innerHTML = list.length ? list.map((p) => `<article class="card fpost">
        <button class="fp-main" data-open="${esc(p.id)}">
          <span class="fp-top"><span class="fk ${esc(p.kind)}">${esc(KIND[p.kind] || 'Other')}</span>${statusPill(p)}<span class="fp-by">${esc(p.authorName)} · ${esc(ago(p.at))}</span></span>
          <span class="fp-title">${esc(p.title)}</span>
          ${p.excerpt ? `<span class="fp-ex">${esc(p.excerpt)}${p.excerpt.length >= 240 ? '…' : ''}</span>` : ''}
        </button>
        <div class="fp-foot">${votes(p)}<button class="fp-c" data-open="${esc(p.id)}">${BUBBLE}<b>${p.comments}</b> comment${p.comments === 1 ? '' : 's'}</button></div>
      </article>`).join('')
      : `<div class="card empty"><b>${fKind ? `No ${esc(KIND[fKind].toLowerCase())}s yet` : 'Nothing posted yet'}</b>Be the first: tap New post.</div>`;
  }
  async function vote(id, value) {
    const p = (forumCache && forumCache.posts.find((x) => x.id === id)) || null;
    const v = p && p.myVote === value ? 0 : value; // tapping your vote again takes it back
    try {
      const r = await send('POST', `/api/forum/${encodeURIComponent(id)}/vote`, { value: v });
      if (forumCache) forumCache.posts = forumCache.posts.map((x) => (x.id === id ? r.post : x));
      renderForum();
      if (postId === id) openPost(id);
    } catch (e) { toast(e.message); }
  }
  document.querySelectorAll('[data-fkind]').forEach((b) => b.onclick = () => { fKind = b.dataset.fkind; document.querySelectorAll('[data-fkind]').forEach((x) => x.setAttribute('aria-selected', x === b)); renderForum(); });
  document.querySelectorAll('[data-fsort]').forEach((b) => b.onclick = () => { fSort = b.dataset.fsort; document.querySelectorAll('[data-fsort]').forEach((x) => x.setAttribute('aria-selected', x === b)); renderForum(); });
  $('forum-list').addEventListener('click', (e) => {
    const v = e.target.closest('[data-vote]');
    if (v) return vote(v.dataset.id, Number(v.dataset.vote));
    const o = e.target.closest('[data-open]');
    if (o) openPost(o.dataset.open);
  });
  $('f-new').onclick = () => newPost();
  const openDrawer = (html) => { detailId = null; postId = null; $('detail').classList.remove('hidden'); document.body.classList.add('noscroll'); $('detail-body').innerHTML = html; };
  const CLOSE_BTN = '<button class="btn sq" data-close-detail aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
  function newPost() {
    openDrawer(`<div class="sh-head"><div class="sh-title"><span class="eyebrow">Forum</span><h2>New post</h2><div class="sh-sub">Everyone on the team can see it. Admins are told straight away.</div></div><div class="sh-right">${CLOSE_BTN}</div></div>
      <form class="pe-form" id="fp-form" autocomplete="off">
        <div class="pe-f"><span class="pe-l">What is it?</span><div class="range fkinds" role="radiogroup" aria-label="What is it">${Object.entries(KIND).map(([k, w], i) => `<button type="button" role="radio" data-k="${k}" aria-checked="${i === 0}" aria-selected="${i === 0}">${w}</button>`).join('')}</div></div>
        <div class="pe-f"><label for="fp-title">Title</label><input id="fp-title" maxlength="120" required placeholder="e.g. The video upload stops at 90%"></div>
        <div class="pe-f"><label for="fp-body">Details</label><textarea id="fp-body" maxlength="4000" rows="7" placeholder="What happened? What did you expect? Which flat or page?"></textarea></div>
        <div class="form-actions"><span class="spacer"></span><button type="button" class="btn" data-close-detail>Cancel</button><button type="submit" class="btn primary" id="fp-go">Post</button></div>
      </form>`);
    let kind = 'bug';
    $('fp-form').querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { kind = b.dataset.k; $('fp-form').querySelectorAll('[data-k]').forEach((x) => { x.setAttribute('aria-checked', x === b); x.setAttribute('aria-selected', x === b); }); });
    $('fp-title').focus();
    $('fp-form').onsubmit = async (e) => {
      e.preventDefault();
      $('fp-go').disabled = true;
      try {
        const r = await send('POST', '/api/forum', { kind, title: $('fp-title').value, body: $('fp-body').value });
        toast('Posted'); closeDetail(); await loadForum(); openPost(r.post.id);
      } catch (err) { toast(err.message); $('fp-go').disabled = false; }
    };
  }
  async function openPost(id) {
    const keep = postId === id && $('fc-body') ? $('fc-body').value : '';
    try {
      const r = await getJSON(`/api/forum/${encodeURIComponent(id)}`);
      const p = r.post, canDel = p.mine || r.canModerate;
      openDrawer(`<div class="sh-head"><div class="sh-title"><span class="eyebrow">${esc(KIND[p.kind] || 'Post')}${p.status !== 'open' ? ` · ${esc(p.status)}` : ''}</span><h2 class="fp-h">${esc(p.title)}</h2>
          <div class="sh-sub">${esc(p.authorName)} · ${esc(fmtWhen(p.at))}${p.statusBy && p.status !== 'open' ? ` · marked ${esc(p.status)} by ${esc(p.statusBy)}` : ''}</div></div><div class="sh-right">${CLOSE_BTN}</div></div>
        ${p.body ? `<div class="fp-body">${esc(p.body)}</div>` : ''}
        <div class="fp-foot big">${votes(p)}${r.canModerate ? `<label class="fp-st"><span>Status</span><select id="fp-status">${['open', 'fixed', 'closed'].map((x) => `<option value="${x}" ${p.status === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></label>` : ''}</div>
        <h3 class="sh-h3">Comments · ${p.comments.length}</h3>
        <div class="fc-list">${p.comments.length ? p.comments.map((c) => `<div class="fc"><span class="avatar">${esc(initials(c.authorName))}</span><div class="fc-t"><div class="fc-h"><b>${esc(c.authorName)}</b><span>${esc(ago(c.at))}</span>${c.mine || r.canModerate ? `<button class="linkbtn inline fc-del" data-cdel="${esc(c.id)}">Delete</button>` : ''}</div><div class="fc-b">${esc(c.body)}</div></div></div>`).join('') : '<p class="muted">No comments yet.</p>'}</div>
        <form class="fc-form" id="fc-form"><label for="fc-body" class="pe-l">Add a comment</label><textarea id="fc-body" rows="3" maxlength="2000" placeholder="Write a comment…">${esc(keep)}</textarea><div class="form-actions"><span class="spacer"></span><button type="submit" class="btn primary" id="fc-go">Comment</button></div></form>
        ${canDel ? '<button class="linkbtn fp-del" id="fp-del">Delete this post</button>' : ''}`);
      postId = id;
      $('detail-body').querySelectorAll('[data-vote]').forEach((b) => b.onclick = () => vote(id, Number(b.dataset.vote)));
      if ($('fp-status')) $('fp-status').onchange = async () => {
        try { await send('PUT', `/api/forum/${encodeURIComponent(id)}/status`, { status: $('fp-status').value }); toast('Status updated'); forumCache = null; loadForum(); openPost(id); } catch (e) { toast(e.message); }
      };
      $('fc-form').onsubmit = async (e) => {
        e.preventDefault();
        if (!$('fc-body').value.trim()) return;
        $('fc-go').disabled = true;
        try { await send('POST', `/api/forum/${encodeURIComponent(id)}/comments`, { body: $('fc-body').value }); $('fc-body').value = ''; await openPost(id); loadForum(); }
        catch (err) { toast(err.message); $('fc-go').disabled = false; }
      };
      $('detail-body').querySelectorAll('[data-cdel]').forEach((b) => b.onclick = async () => {
        if (!confirm('Delete this comment?')) return;
        try { await send('DELETE', `/api/forum/${encodeURIComponent(id)}/comments/${encodeURIComponent(b.dataset.cdel)}`); openPost(id); loadForum(); } catch (e) { toast(e.message); }
      });
      if ($('fp-del')) $('fp-del').onclick = async () => {
        if (!confirm('Delete this post and its comments?')) return;
        try { await send('DELETE', `/api/forum/${encodeURIComponent(id)}`); toast('Post deleted'); closeDetail(); loadForum(); } catch (e) { toast(e.message); }
      };
    } catch (e) { if (e.message !== 'signed out') toast(e.message); }
  }

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
  const isoWeek = (s) => {
    const d = D(s); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // that week's Thursday
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  };
  const weekNo = () => isoWeek(data.dates.find((x) => D(x).getUTCDay() === 1) || data.weekStart);
  const GROUP = { cleaning: 'Day to day', damage: 'Day to day', props: 'Portfolio', users: 'Admin', settings: 'Admin', account: 'Your account', forum: 'Team', maintenance: 'Day to day' };
  function setPageHead() {
    const eb = $('page-eyebrow'), h = $('page-title');
    if ((view === 'day' || view === 'board') && data) {
      const when = data.dates.includes(data.today) ? 'This week' : data.weekStart > data.today ? 'Upcoming week' : 'Past week';
      eb.textContent = `Schedule · Week ${weekNo()} · ${when}`;
      if (view === 'day') h.innerHTML = `${esc(WD_LONG.format(D(selected)))}, <span>${D(selected).getUTCDate()} ${esc(MON.format(D(selected)))}</span>`;
      else h.innerHTML = `The week, <span>${esc(shortDate(data.weekStart))} – ${esc(shortDate(data.weekEnd))}</span>`;
    } else {
      eb.textContent = view === 'day' || view === 'board' ? 'Schedule' : GROUP[view] || '';
      h.textContent = TITLES[view] || '';
    }
  }
  function setView(v) {
    if (!allowed(v)) v = ['day', 'board', 'props', 'account'].find(allowed);
    view = v;
    store.set('cs_view', v);
    if (v === 'day' || v === 'board') { lastSched = v; store.set('cs_sched', v); }
    document.querySelectorAll('.snav [data-nav]').forEach((b) => { if (b.dataset.nav === NAV_OF[v]) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    document.querySelectorAll('.range [data-range]').forEach((b) => b.setAttribute('aria-selected', b.dataset.range === v));
    $('me-btn').setAttribute('aria-current', v === 'account' ? 'page' : 'false');
    $('me-btn2').setAttribute('aria-selected', v === 'account');
    setPageHead();
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
    $('view-forum').classList.toggle('hidden', v !== 'forum');
    $('view-maintenance').classList.toggle('hidden', v !== 'maintenance');
    $('foot').classList.toggle('hidden', !(v === 'day' || v === 'board'));
    if (v === 'board' && data && boardDirty) renderBoard();
    if (v === 'props') loadProps();
    if (v === 'users') loadUsers();
    if (v === 'cleaning') loadCleaningView();
    if (v === 'account') renderAccount();
    if (v === 'settings') loadSettings();
    if (v === 'damage') loadDamageView();
    if (v === 'forum') loadForum();
    if (v === 'maintenance') loadMaintenance();
  }

  // ---------- who's signed in ----------
  const initials = (n) => (n || '?').split(/\s+/).filter((w) => /^[a-z]/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  function applyPermissions() {
    document.querySelectorAll('.snav [data-nav]').forEach((b) => b.classList.toggle('hidden', !navAllowed(b.dataset.nav)));
    document.querySelectorAll('.snav .nlbl').forEach((l) => l.classList.toggle('hidden', !document.querySelector(`.snav [data-nav][data-group="${l.dataset.group}"]:not(.hidden)`)));
    document.querySelector('.range [data-range="day"]').classList.toggle('hidden', !allowed('day'));
    document.querySelector('.range [data-range="board"]').classList.toggle('hidden', !allowed('board'));
    document.querySelector('.copy-wrap').classList.toggle('hidden', !can('copy_print'));
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
    // On phones Users and Settings live here rather than in the tab bar.
    $('acct-users').classList.toggle('hidden', !navAllowed('users'));
    $('acct-settings').classList.toggle('hidden', !navAllowed('settings'));
    $('acct-admin').classList.toggle('hidden', !navAllowed('users') && !navAllowed('settings'));
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
    $('users-sub').textContent = U.limited ? `People you’ve added · ${active} active · you can add supervisors and cleaners` : `${active} active · owner recovery login not listed`;
    $('users-list').innerHTML = U.users.length ? U.users.map((u) => `
      <tr class="${u.id === editing ? 'sel' : ''} ${u.active ? '' : 'off'}">
        <td class="who"><b>${esc(u.name)}</b><span>${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}${u.active ? '' : ' · deactivated'}</span></td>
        <td><span class="role ${u.role}">${ROLE_LABEL[u.role] || esc(u.role)}</span></td>
        <td class="hide-sm">${u.buildings === 'all' ? 'All' : u.buildings.length ? esc(u.buildings.length + ' building' + (u.buildings.length > 1 ? 's' : '')) : '<span style="color:var(--out)">None yet</span>'}</td>
        <td class="hide-sm">${when(u.lastLoginAt)}</td>
        <td><button class="btn" data-edit="${u.id}">Edit</button></td>
      </tr>`).join('') : `<tr><td colspan="5" class="empty"><b>${U.limited ? 'You haven’t added anyone yet' : 'No users yet'}</b>Click “Add user” to ${U.limited ? 'add a supervisor or cleaner' : 'create the first account'}.</td></tr>`;
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
    const r0 = U.roles.includes('user') ? 'user' : 'cleaner';
    const u = isNew ? { name: '', username: '', email: '', role: r0, active: true, ...U.defaults[r0] } : U.users.find((x) => x.id === editing);
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
        <div class="radio"><label class="${U.canAllBuildings === false ? 'hidden' : ''}"><input type="radio" name="uf-bmode" value="all" ${allB ? 'checked' : ''}>All buildings</label><label><input type="radio" name="uf-bmode" value="some" ${allB ? '' : 'checked'}>Only these</label></div>
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
    document.querySelectorAll('.live').forEach((el) => {
      el.classList.toggle('on', state === 'on');
      const side = el.classList.contains('side-live');
      el.querySelector('.lbl').textContent = state === 'on' ? (side ? 'Live from Guesty' : 'Live') : state === 'preview' ? 'Preview' : (side ? 'Checking Guesty' : 'Auto');
      el.title = title;
    });
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
  $('acct-users').onclick = () => setView('users');
  $('acct-settings').onclick = () => setView('settings');
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

  // Each row's status ("Cleaning · 12:04" live, "Cleaned · 49 min", "To clean") and its cleaner.
  const cleanState = (listingId) => {
    const list = forListing(listingId, selected);
    return { active: list.find((c) => ACTIVE.includes(c.status)), done: list.filter((c) => c.status === 'completed').pop() };
  };
  function decorateDay() {
    if (data && me && cRange !== cleaningRange()) { cRange = 'loading'; refreshCleanings(); }
    document.querySelectorAll('[data-cbadge]').forEach((el) => {
      const { active, done } = cleanState(el.dataset.cbadge);
      if (active) el.innerHTML = `<span class="cb running"><i></i>${active.status === 'in_progress' ? 'Cleaning' : esc(STEP_WORD[active.status] || 'Cleaning')}${active.status === 'in_progress' ? ` · <b data-since="${esc(active.startedAt)}" data-until="${esc(active.endedAt || '')}">${fmtDur((active.endedAt ? Date.parse(active.endedAt) : Date.now()) - Date.parse(active.startedAt))}</b>` : ''}</span>`;
      else if (done) el.innerHTML = `<span class="cb done">✓ Cleaned · ${durWords(Date.parse(done.endedAt) - Date.parse(done.startedAt))}</span>`;
      else el.innerHTML = el.dataset.kind === 'in' ? '<span class="cb arr">Arriving</span>' : '<span class="cb todo">To clean</span>';
    });
    // Who's assigned to each flat that day.
    document.querySelectorAll('[data-achip]').forEach((el) => {
      const a = assignments[`${selected}|${el.dataset.achip}`];
      el.innerHTML = a ? `<span class="achip${a.cleanerId === me.id ? ' mine' : ''}" title="Assigned to ${esc(a.cleanerName)}"><span class="avatar sm">${esc(initials(a.cleanerName))}</span>${a.cleanerId === me.id ? 'You' : esc(a.cleanerName.split(' ')[0])}</span>`
        : el.dataset.needs && isManager() ? '<span class="achip none"><span class="avatar sm dash" aria-hidden="true">+</span>Assign</span>' : '';
    });
    renderSummary();
    renderRail();
  }

  // ---- the selected day at a glance: summary band and the right-hand column ----
  let openDamage = null, knUnlinked = [];
  function dayStats() {
    const day = data && data.days.find((d) => d.date === selected);
    const units = day ? day.units : [];
    const cleans = units.filter((u) => u.checkOut);
    const st = cleans.map((u) => ({ u, ...cleanState(u.listingId), a: assignments[`${selected}|${u.listingId}`] }));
    return { day, units, cleans, st, done: st.filter((x) => x.done && !x.active).length, running: st.filter((x) => x.active).length,
      unassigned: st.filter((x) => !x.a), arrivals: units.filter((u) => u.checkIn) };
  }
  const seesCleaning = () => isManager() || can('view_cleaning');
  function renderSummary() {
    if (!data) return;
    const s = dayStats();
    const firstIn = s.arrivals.map((u) => u.checkIn.timeRaw || '').filter(Boolean).sort()[0];
    const turns = s.cleans.filter((u) => u.checkIn).length;
    $('m-clean').textContent = s.cleans.length;
    $('m-clean-s').textContent = s.cleans.length ? `${turns} same-day · ${s.cleans.length - turns} check-out${s.cleans.length - turns === 1 ? '' : 's'}` : 'Nothing to clean';
    $('m-in').textContent = s.arrivals.length;
    $('m-in-s').textContent = firstIn ? `First guests from ${s.arrivals.find((u) => u.checkIn.timeRaw === firstIn).checkIn.time}` : 'No arrivals';
    if (isManager()) {
      $('m-third-k').textContent = 'Not assigned';
      $('m-third').textContent = s.unassigned.length;
      $('m-third').classList.toggle('warnv', s.unassigned.length > 0);
      $('m-third-s').textContent = s.unassigned.length ? s.unassigned.map((x) => x.u.label).slice(0, 4).join(' · ') + (s.unassigned.length > 4 ? ' …' : '') : 'Everyone has a cleaner';
    } else {
      const mine = s.st.filter((x) => x.a && x.a.cleanerId === me.id);
      $('m-third-k').textContent = 'Assigned to you';
      $('m-third').textContent = mine.length;
      $('m-third').classList.remove('warnv');
      $('m-third-s').textContent = mine.length ? mine.map((x) => x.u.label).slice(0, 4).join(' · ') : 'Nothing assigned yet';
    }
    $('m-done-box').classList.toggle('hidden', !seesCleaning());
    $('m-done').textContent = s.done;
    $('m-done-of').textContent = ` / ${s.cleans.length}`;
    const pct = (n) => (s.cleans.length ? (n / s.cleans.length) * 100 : 0);
    $('m-bar').querySelector('.d').style.width = pct(s.done) + '%';
    $('m-bar').querySelector('.p').style.width = pct(s.running) + '%';
  }
  function renderRail() {
    const rail = $('rail');
    if (!data || !rail) return;
    const s = dayStats();
    const cards = [];
    const dayWord = selected === data.today ? 'today' : WD_LONG.format(D(selected));
    if (seesCleaning() && s.cleans.length) {
      const n = s.cleans.length, C = 2 * Math.PI * 34, seg = (k) => (k / n) * C;
      cards.push(`<div class="card rcard"><div class="rc-h"><h3>Progress</h3><span>${esc(dayWord)}</span></div>
        <div class="ring-row"><svg class="ring" viewBox="0 0 84 84" role="img" aria-label="${s.done} of ${n} cleaned, ${s.running} being cleaned">
          <circle cx="42" cy="42" r="34" class="rt"/>
          ${s.done ? `<circle cx="42" cy="42" r="34" class="rd" stroke-dasharray="${seg(s.done)} ${C}" transform="rotate(-90 42 42)"/>` : ''}
          ${s.running ? `<circle cx="42" cy="42" r="34" class="rp" stroke-dasharray="${seg(s.running)} ${C}" stroke-dashoffset="${-seg(s.done)}" transform="rotate(-90 42 42)"/>` : ''}
          <text x="42" y="48" text-anchor="middle">${s.done}/${n}</text></svg>
          <ul class="legend-l"><li><i class="d"></i>${s.done} cleaned</li><li><i class="p"></i>${s.running} being cleaned</li><li><i class="t"></i>${n - s.done - s.running} to clean</li></ul></div></div>`);
    }
    if (seesCleaning() && s.cleans.length) {
      const by = new Map();
      for (const x of s.st) { const k = x.a ? x.a.cleanerId : ''; if (!by.has(k)) by.set(k, { name: x.a ? x.a.cleanerName : '', items: [] }); by.get(k).items.push(x); }
      const line = (x) => x.active ? `${x.u.label} cleaning since ${fmtClock(x.active.startedAt)}` : x.done ? `${x.u.label} done ${fmtClock(x.done.endedAt)}` : `${x.u.label} to clean`;
      const rows = [...by.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0)).map(([id, g]) => id
        ? `<div class="rrow"><span class="avatar">${esc(initials(g.name))}</span><span class="rtxt"><b>${id === me.id ? 'You' : esc(g.name)}</b><span>${esc(g.items.map(line).join(' · '))}</span></span><em>${g.items.filter((x) => x.done).length}/${g.items.length}</em></div>`
        : `<div class="rrow"><span class="avatar dash" aria-hidden="true"></span><span class="rtxt"><b>Not assigned</b><span>${esc(g.items.map((x) => x.u.label).join(' · '))}</span></span></div>`).join('');
      cards.push(`<div class="card rcard"><div class="rc-h"><h3>Team ${esc(dayWord)}</h3></div>${rows}</div>`);
    }
    const att = [];
    if (openDamage) att.push(`<button class="rrow link" data-go="damage"><span class="ric bad">${ICONS.damage}</span><span class="rtxt"><b>${openDamage} open damage report${openDamage === 1 ? '' : 's'}</b><span>Review and resolve</span></span>${CHEV}</button>`);
    if (knUnlinked.length) att.push(`<button class="rrow link" data-go="${isManager() ? 'settings' : 'props'}"><span class="ric warn">${ICONS.key}</span><span class="rtxt"><b>${knUnlinked.length} KeyNest flat${knUnlinked.length === 1 ? '' : 's'} not linked</b><span>${esc(knUnlinked.map((f) => f.label).join(' · '))}</span></span>${CHEV}</button>`);
    for (const u of s.units.filter((x) => x.checkIn && x.checkIn.isNew)) att.push(`<button class="rrow link" data-flat="${esc(u.listingId)}"><span class="ric new">${ICONS.star}</span><span class="rtxt"><b>${esc(u.label)} is a new booking</b><span>Arrives ${esc(u.checkIn.time)}${u.checkIn.guests ? ` · ${u.checkIn.guests} guest${u.checkIn.guests > 1 ? 's' : ''}` : ''}</span></span>${CHEV}</button>`);
    cards.push(`<div class="card rcard"><div class="rc-h"><h3>Needs attention</h3></div>${att.join('') || '<p class="muted rnone">Nothing right now.</p>'}</div>`);
    const t = data.totals;
    cards.push(`<div class="card rcard"><div class="rc-h"><h3>This week</h3></div>
      <div class="wk"><div><b>${t.checkOuts}</b><span>cleans</span></div><div><b>${t.checkIns}</b><span>arrivals</span></div><div><b>${t.turnovers}</b><span>same-day</span></div></div>
      ${can('view_linen') && t.linenSets !== null ? `<div class="wk-linen"><span class="lh">Linen sets <em>1 per check-out</em></span>${data.linen.map((r) => `<span class="li"><b>${r.sets}</b>${esc(shortType(r.type))}</span>`).join('')}<span class="li total"><b>${t.linenSets}</b>total</span></div>` : ''}</div>`);
    rail.innerHTML = cards.join('');
  }
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
  const ICONS = {
    tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4.2 4.2 0 0 0-5.5 5.4L3.8 17.1a1.9 1.9 0 0 0 2.7 2.7l5.4-5.4a4.2 4.2 0 0 0 5.4-5.5l-2.5 2.5-2.3-.4-.4-2.3z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5M7 21.5 3.5 18 7 14.5"/><path d="M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5"/></svg>',
    damage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 3 19.5h18z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 13.8 10.2 20.5 12 13.8 13.8 12 20.5 10.2 13.8 3.5 12 10.2 10.2z"/></svg>',
  };
  $('rail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-go], [data-flat]');
    if (!b) return;
    if (b.dataset.flat) openSheet(b.dataset.flat); else setView(b.dataset.go);
  });
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

    // This flat on the selected day: check-out, check-in and the window between them.
    const du = (data && unitOn(sheetListing, selected)) || u;
    const o = du.checkOut, n = du.checkIn;
    const hrs = (a, b) => { const m = (x) => { const r = /^(\d{1,2}):(\d\d)/.exec(x || ''); return r ? Number(r[1]) * 60 + Number(r[2]) : null; }; const d = m(b) - m(a); return m(a) === null || m(b) === null || d <= 0 ? null : d; };
    const win = o && n ? hrs(o.timeRaw, n.timeRaw) : null;
    const stay = (e) => (e ? [e.nights && `${e.nights} night${e.nights > 1 ? 's' : ''}`, e.guests && `${e.guests} guest${e.guests > 1 ? 's' : ''}`, e.planned && 'planned time', e.isNew && 'new booking'].filter(Boolean).join(' · ') : '');
    const times = (o || n) ? `<div class="sh-times">
        <div><span>Check-out</span><b class="o">${o ? esc(o.time) : '—'}</b><em>${esc(stay(o))}</em></div>
        <div><span>Check-in</span><b class="n">${n ? esc(n.time) : '—'}</b><em>${esc(stay(n))}</em></div>
        <div class="w"><span>Cleaning window</span><b>${win ? (win % 60 ? `${Math.floor(win / 60)} h ${win % 60} min` : `${win / 60} h`) : o ? 'Open' : '—'}</b><em>${o && !n ? 'No arrival this day' : n && !o ? 'Arrival only' : ''}</em></div>
      </div>` : '';
    const pill = active ? `<span class="cb running"><i></i>${esc(STEP_WORD[active.status] || 'Cleaning')}</span>` : done.length ? '<span class="cb done">✓ Cleaned</span>' : o ? '<span class="cb todo">To clean</span>' : '';
    $('sheet-body').innerHTML = `
      <div class="sh-head"><div class="sh-title"><span class="eyebrow">${esc(u.building || '')}${u.postcode ? ` · ${esc(u.postcode)}` : ''}</span><h2>${esc(u.label)}</h2><div class="sh-sub">${esc(shortType(u.unitType || ''))}</div></div>
        <div class="sh-right">${pill}<button class="btn sq" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></div>
      ${times}
      ${(du.keyMode || u.keyMode) === 'lockbox' && can('view_cleaning') ? '<div id="sh-lbx"></div>' : ''}
      ${assignBlock()}
      ${active ? milestones(active) : ''}
      ${body}
      ${history ? `<h3 class="sh-h3">${done.some((c) => c.date !== selected) ? 'Cleaned' : `Cleaned ${selected === (data && data.today) ? 'today' : esc(longDate(selected))}`}</h3>${history}` : ''}
      <div id="sheet-damages"></div>
      <div id="sheet-maint"></div>
      ${can('report_damage') ? '<button class="btn wide" id="report-damage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>Report damage</button>' : ''}
      <button class="btn wide" id="report-maint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4.2 4.2 0 0 0-5.5 5.4L3.8 17.1a1.9 1.9 0 0 0 2.7 2.7l5.4-5.4a4.2 4.2 0 0 0 5.4-5.5l-2.5 2.5-2.3-.4-.4-2.3z"/></svg>Report a maintenance issue</button>`;

    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    if ($('sh-lbx')) {
      const box = $('sh-lbx'), id = sheetListing;
      getJSON(`/api/lockbox/${encodeURIComponent(id)}`).then((r) => { if ($('sh-lbx') === box && sheetListing === id) box.innerHTML = r.noCode ? noCodeBlock(r.instruction) : lockboxBlock(r.lockbox); }).catch(() => {});
    }
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
    on('report-maint', () => taskForm({ listingId: sheetListing, label: u.label, building: u.building }));
    loadSheetMaint(sheetListing);
    if (active && mine && active.status === 'awaiting_video') wireEvidence(active);
    if (active && mine && active.status === 'awaiting_key') wireKey(active);
    loadSheetDamages(sheetListing);
  }

  // A cleaning's milestones: started → cleaned → checklist → video → key back, each ticked with its time.
  const STEP_WORD = { in_progress: 'Cleaning', checklist: 'Final checks', awaiting_video: 'Video to upload', awaiting_key: 'Key to return' };
  function milestones(c) {
    const at = ['in_progress', 'checklist', 'awaiting_video', 'awaiting_key', 'completed'].indexOf(c.status);
    const st = (i) => (at > i ? 'done' : at === i ? 'now' : 'next');
    const keyAt = c.key && (c.key.returnedAt || c.key.confirmedAt);
    const rows = [
      ['Started', `by ${c.cleanerId === me.id ? 'you' : c.cleanerName.split(' ')[0]}`, c.startedAt, 'done'],
      ['Cleaning', c.endedAt ? durWords(Date.parse(c.endedAt) - Date.parse(c.startedAt)) : 'in progress', c.endedAt, st(0)],
      ['Final checks', `${(c.checklist || []).length} of ${checklistDef.length || 5} confirmed`, c.checksConfirmedAt, st(1)],
      ['Video walkthrough', (c.media || []).some((m) => m.kind === 'video') ? 'uploaded' : 'full quality, from Files', c.videoAt, st(2)],
      ...(c.keyMode ? [[c.keyMode === 'lockbox' ? (c.keyInstruction || (c.key && c.key.note) ? 'Key returned' : 'Key back in the lockbox') : 'Key back in KeyNest', c.keyMode === 'lockbox' ? (c.keyInstruction || (c.key && c.key.note) || (c.keyNoCode || (c.key && c.key.noCode) ? 'no new code needed' : 'with a new 4-digit code')) : '', keyAt, st(3)]] : []),
    ];
    return `<ol class="miles">${rows.map(([label, detail, time, state]) => `<li class="${state}"><span class="mdot" aria-hidden="true"></span><span class="mtxt"><b>${esc(label)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</span><em>${time && state === 'done' ? fmtClock(time) : state === 'now' ? 'Now' : ''}</em></li>`).join('')}</ol>`;
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
    if (c.key.mode === 'lockbox') return c.key.code && can('view_cleaning') ? ` · key in lockbox, new code <b>${esc(c.key.code)}</b>` : c.key.note ? ' · key returned' : ' · key back in the lockbox';
    return ' · key back in KeyNest';
  }
  let keyPoll = null;
  function keyStep(a) {
    if (a.keyMode === 'lockbox' && a.keyNoCode) {
      return `<div class="evidence keystep">
        <div class="ev-head"><b>Last step: the key.</b> <span class="req">Required</span></div>
        <p class="ks-one">${a.keyInstruction ? `<b>${esc(a.keyInstruction)}</b>` : 'Put the key back in the lockbox and close it.'}<br><span class="muted">No new code is needed for this flat.</span></p>
        <label class="ks-check"><input type="checkbox" id="ks-back"> ${a.keyInstruction ? 'Done: the key is where it should be' : 'The key is back in the lockbox'}</label>
        <button class="btn big primary" id="ks-done" disabled>Complete cleaning</button>
      </div>`;
    }
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
    if (a.keyMode === 'lockbox' && !$('ks-code')) { // no new code for this flat: just confirm the key is back
      const back = $('ks-back');
      back.onchange = () => { done.disabled = !back.checked; };
      done.onclick = () => finish({ keyReturned: back.checked });
      return;
    }
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
    dmgSeen.set(d.id, d);
    return `<div class="dmg ${d.status}">
      <div class="hist-h"><b>${esc(d.label)} · ${esc(d.location || 'Damage')}</b><span>${new Date(d.reportedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} · ${esc(d.reporterName)}</span></div>
      <p class="dmg-desc">${esc(d.description)}</p>
      ${mediaTiles(d.media)}
      ${d.status === 'resolved' ? `<div class="hist-s">Resolved by ${esc(d.resolvedBy || '')}${d.note ? ' — ' + esc(d.note) : ''}</div>` : ''}
      ${can('manage_damage') || isManager() ? `<div class="form-actions">${can('manage_damage') ? `<button class="btn" data-dmg="${d.id}" data-to="${d.status === 'resolved' ? 'open' : 'resolved'}">${d.status === 'resolved' ? 'Reopen' : 'Mark resolved'}</button>` : ''}${isManager() ? `<button class="btn" data-dmg-mt="${esc(d.id)}">Create maintenance task</button>` : ''}</div>` : ''}
    </div>`;
  }
  const dmgSeen = new Map(); // damage reports on screen, for "Create maintenance task"
  function wireDamageCards(root, after) {
    root.querySelectorAll('[data-dmg-mt]').forEach((b) => b.onclick = () => {
      const d = dmgSeen.get(b.dataset.dmgMt);
      if (d) taskForm({ listingId: d.listingId, label: d.label, building: d.building, damageId: d.id, title: `Fix: ${d.description.split('\n')[0].slice(0, 90)}`, details: `${d.location ? d.location + ': ' : ''}${d.description}\n\nFrom a damage report by ${d.reporterName}.`, mediaIds: (d.media || []).map((m) => m.id) });
    });
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
        : c.key && c.key.mode === 'lockbox' ? (c.key.code ? `<p>Key back in the lockbox with a new code <b class="dt-code">${esc(c.key.code)}</b> · ${t(c.key.returnedAt)}</p>` : `<p>${c.key.note ? `Key returned: ${esc(c.key.note)}` : 'Key back in the lockbox (no new code needed)'} · ${t(c.key.returnedAt)}</p>`)
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
  function closeDetail() { detailId = null; postId = null; $('detail').classList.add('hidden'); if ($('sheet').classList.contains('hidden')) document.body.classList.remove('noscroll'); }
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
        openDamage = n;
      } catch (_) {}
    }
    try {
      const m = await getJSON('/api/maintenance?status=open');
      const n = m.counts.badge;
      $('nb-maint').textContent = n > 9 ? '9+' : String(n);
      $('nb-maint').classList.toggle('hidden', !n);
    } catch (_) {}
    try {
      const f = await getJSON('/api/forum');
      forumCache = f;
      const seen = store.get('cs_forum_seen') || '';
      $('nd-forum').classList.toggle('hidden', view === 'forum' || !f.posts.some((p) => p.lastAt > seen && !(p.mine && p.comments === 0)));
    } catch (_) {}
    if (allowed('props')) {
      try { const p = await getJSON('/api/properties'); knUnlinked = (p.keynest && p.keynest.unlinked) || []; $('nd-props').classList.toggle('hidden', !knUnlinked.length); } catch (_) {}
    }
    renderRail();
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
  const NICON = { cleaned: '✓', damage: '!', assigned: '→', unassigned: '×', forum: '“', maintenance: '⚒' };
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
    if (v === 'forum') { if (view !== 'forum') setView('forum'); if (q.get('post')) openPost(q.get('post')); return; }
    if (v === 'maintenance') { if (view !== 'maintenance') setView('maintenance'); if (q.get('task')) openTask(q.get('task')); return; }
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
