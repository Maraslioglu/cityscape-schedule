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

  let data = null;
  let view = ['day', 'board', 'props'].includes(store.get('cs_view')) ? store.get('cs_view') : 'day';
  let selected = null; // selected date in day view

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Could not load data');
    return body;
  }

  // ---------- loading ----------
  async function loadWeek(date, { fresh = false, quiet = false } = {}) {
    $('refresh').disabled = true;
    try {
      const q = new URLSearchParams();
      if (date) q.set('date', date);
      if (fresh) q.set('refresh', '1');
      const next = await getJSON('/api/week?' + q);
      const changedWeek = !data || data.weekStart !== next.weekStart;
      data = next;
      if (changedWeek || !data.dates.includes(selected)) {
        selected = data.dates.includes(data.today) ? data.today : data.dates[0];
      }
      render();
      const isThisWeek = data.dates.includes(data.today);
      history.replaceState(null, '', isThisWeek ? location.pathname : `?week=${data.weekStart}`);
      if (fresh && !quiet) toast('Up to date with Guesty');
    } catch (e) {
      if (e.message !== 'signed out') $('banners').innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
    } finally {
      $('refresh').disabled = false;
    }
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
    if (mock) banners.push('<div class="banner">Showing <b>sample data</b>. Add your Guesty Client ID and Secret in Railway to see live bookings.</div>');
    for (const w of warnings || []) banners.push(`<div class="banner">${esc(w)}</div>`);
    $('banners').innerHTML = banners.join('');

    $('m-out').textContent = totals.checkOuts;
    $('m-in').textContent = totals.checkIns;
    $('m-turn').textContent = totals.turnovers;
    $('m-linen').innerHTML = linen.map((r) => `<div class="item"><div class="v">${r.sets}</div><div class="t">${esc(r.type)}</div></div>`).join('') +
      `<div class="item total"><div class="v">${totals.linenSets}</div><div class="t">Total sets</div></div>`;

    renderStrip();
    renderDay();
    renderBoard();

    const at = new Date(data.generatedAt);
    $('foot').textContent = `Last updated ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${data.statuses.join(' + ')} bookings only`;
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
    $('strip').querySelectorAll('.dbtn').forEach((b) => b.onclick = () => { selected = b.dataset.date; renderStrip(); renderDay(); });
  }

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
          return `<div class="row">
            <span class="u">${esc(u.label)}</span>
            <span class="t">${esc(shortType(u.unitType))}</span>
            ${guests ? `<span class="g">· ${guests}</span>` : ''}
            ${isNew ? '<span class="new">New</span>' : ''}
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
    const firstIn = turn.map((u) => u.checkIn.timeRaw).sort()[0];
    $('daypanel').innerHTML = `
      <div class="dayhead"><h2>${esc(longDate(day.date))}</h2>${linenBits ? `<span class="dlinen">Linen: ${linenBits}</span>` : ''}</div>
      ${day.units.length ? '' : '<div class="empty"><b>Nothing scheduled</b>No check-ins or check-outs on this day.</div>'}
      ${section('turn', 'Same-day turnovers', firstIn ? `Clean between check-out and check-in` : '', turn)}
      ${section('out', 'Check-outs', 'Clean — nobody arriving today', outs)}
      ${section('in', 'Arrivals', 'Make sure the flat is ready', ins)}`;
  }

  function renderBoard() {
    const { dates, days, board, today } = data;
    const head = `<colgroup><col class="first">${dates.map(() => '<col>').join('')}</colgroup>
      <thead><tr><th class="first-col"></th>${days.map((d) => `<th class="${d.date === today ? 'today' : ''}"><button data-date="${d.date}" title="Open ${esc(longDate(d.date))}">
        <div class="dn">${WD_SHORT.format(D(d.date))}</div><div class="dd">${D(d.date).getUTCDate()}</div><div class="dc">${d.cleans} out · ${d.arrivals} in</div></button></th>`).join('')}</tr></thead>`;
    const body = board.map((b) => `
      <tr class="b-row"><td colspan="${dates.length + 1}"><div class="b-name">${esc(b.name)}<span>${esc(b.postcode)}</span></div></td></tr>
      ${b.units.map((u) => `<tr>
        <td class="first-col unit"><span class="u">${esc(u.label)}</span><span class="t">${esc(shortType(u.unitType))}</span></td>
        ${u.cells.map((c, i) => {
          const morning = Boolean(c.out) || (c.occ && !c.in); // guest there in the morning
          const night = c.occ;                                // guest there tonight
          const newStay = c.in && c.in.isNew;
          let h = '';
          if (morning) h += `<div class="half l${c.out ? ' end' : ''}"></div>`;
          if (night) h += `<div class="half r${c.in ? ' start' : ''}${newStay ? ' isnew' : ''}"></div>`;
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
    $('board').querySelectorAll('thead button').forEach((b) => b.onclick = () => { selected = b.dataset.date; setView('day'); renderStrip(); renderDay(); });
  }

  async function loadProps() {
    try {
      const p = await getJSON('/api/properties');
      const counts = Object.entries(p.counts).map(([t, n]) => `${n} × ${shortType(t)}`).join(' · ');
      $('props-sub').textContent = `${p.total} flats · ${counts}`;
      $('props').innerHTML = p.buildings.map((b) => `<div class="card pcard">
        <h3>${esc(b.name)}</h3><div class="pc">${esc(b.postcode)}</div>
        ${b.units.map((u) => `<div class="prow" title="${esc(u.address)}"><span class="u">${esc(u.label)}</span><span>${esc(shortType(u.unitType))}</span><span class="t">Out ${esc(u.checkOut)} · In ${esc(u.checkIn)}</span></div>`).join('')}
      </div>`).join('');
    } catch (e) {
      if (e.message !== 'signed out') $('props').innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
    }
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
    view = v;
    store.set('cs_view', v);
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === v));
    $('week-area').classList.toggle('hidden', v === 'props');
    $('view-day').classList.toggle('hidden', v !== 'day');
    $('view-board').classList.toggle('hidden', v !== 'board');
    $('view-props').classList.toggle('hidden', v !== 'props');
    $('copy-label').textContent = v === 'board' ? 'Copy week' : 'Copy day';
    if (v === 'props') loadProps();
  }

  // ---------- live updates ----------
  function connectLive() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events');
    const set = (on, label, title) => {
      $('live').className = 'live' + (on ? ' on' : '');
      $('live').querySelector('.lbl').textContent = label;
      $('live').title = title;
    };
    es.addEventListener('hello', (e) => {
      const info = JSON.parse(e.data || '{}');
      const instant = /registered/.test(info.webhook || '');
      set(true, instant ? 'Live' : 'Auto', instant ? 'Instant updates from Guesty are on' : `Updates every 5 minutes (${info.webhook})`);
    });
    es.addEventListener('update', async () => {
      if (!data) return;
      const before = data.totals.newBookings;
      await loadWeek(data.weekStart, { quiet: true });
      toast(data.totals.newBookings > before ? 'New booking — schedule updated' : 'Bookings changed — schedule updated');
    });
    es.onerror = () => set(false, 'Reconnecting', 'Lost connection — reconnecting…');
  }

  // ---------- wiring ----------
  document.querySelectorAll('.seg button').forEach((b) => b.onclick = () => setView(b.dataset.view));
  $('prev').onclick = () => data && loadWeek(data.prevWeek);
  $('next').onclick = () => data && loadWeek(data.nextWeek);
  $('this').onclick = () => loadWeek('');
  $('refresh').onclick = () => loadWeek(data ? data.weekStart : '', { fresh: true });
  $('print').onclick = () => window.print();
  $('copy').onclick = async () => {
    if (!data) return;
    const text = view === 'board' ? weekText() : dayText(data.days.find((d) => d.date === selected)).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Copied — paste into WhatsApp'); }
    catch (_) { toast('This browser blocked copying'); }
  };

  setView(view);
  const w = new URLSearchParams(location.search).get('week');
  loadWeek(/^\d{4}-\d{2}-\d{2}$/.test(w || '') ? w : '');
  connectLive();
  // Safety net: check again every 5 minutes, and when the phone/tab wakes up.
  setInterval(() => { if (!document.hidden && data) loadWeek(data.weekStart, { quiet: true }); }, 5 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data) loadWeek(data.weekStart, { quiet: true }); });
})();
