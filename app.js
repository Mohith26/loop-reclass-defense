import {
  profileStats, decideBatch, predictiveDensities, quantileSorted, hashSeed, classForDensity, classRank,
  densityBand, NMFC_SCALE, reclassRisk, cubeFt3, round2,
} from './src/core.js';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const layer = $('#layer');
const LS = 'loop-reclass-defense:v1';
const fmt$ = (x) => (x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = (x, d = 1) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 1) => fmtN(100 * x, d) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icons = () => window.lucide && window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });

const S = {
  ds: null, results: null, stats: null, q: 0.1, filter: 'all', sort: 'evidence', search: '',
  selected: null, statuses: {}, focus: 0, decided: {}, ranges: {}, profile: null, dh: 0, error: null,
};

// ------------------------------------------------------------------ persistence
function load() {
  try { const s = JSON.parse(localStorage.getItem(LS) || '{}'); S.statuses = s.statuses || {}; S.q = s.q || 0.1; } catch { /* ignore */ }
}
function save() { localStorage.setItem(LS, JSON.stringify({ statuses: S.statuses, q: S.q })); }

// ------------------------------------------------------------------ routing
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/inspections';
  const [path, qs] = h.split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  return { page: parts[0] || 'inspections', arg: parts[1] || null, params };
}
function setHash(page, arg, params, replace = false) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString();
  const h = '#/' + page + (arg ? '/' + arg : '') + (qs ? '?' + qs : '');
  if (replace) history.replaceState(null, '', h); else if (location.hash !== h) location.hash = h;
  if (replace) route();
}
function inspHash(extra = {}) {
  return { f: S.filter === 'all' ? null : S.filter, q: S.q === 0.1 ? null : S.q, s: S.sort === 'evidence' ? null : S.sort, id: S.selected, ...extra };
}

// ------------------------------------------------------------------ data
async function boot() {
  load();
  view.innerHTML = skeleton();
  try {
    const [ds, results] = await Promise.all([
      fetch('data/dataset.json').then((r) => { if (!r.ok) throw new Error('dataset.json ' + r.status); return r.json(); }),
      fetch('data/results.json').then((r) => { if (!r.ok) throw new Error('results.json ' + r.status); return r.json(); }),
    ]);
    S.ds = ds; S.results = results;
    S.stats = Object.fromEntries(Object.entries(ds.scans).map(([k, v]) => [k, profileStats(v)]));
    S.profiles = Object.fromEntries(ds.profiles.map((p) => [p.id, p]));
    for (const a of ds.open) {
      const pd = predictiveDensities(a.units, ds.scans, 400, hashSeed(a.invoice));
      S.ranges[a.invoice] = { pd, lo: quantileSorted(pd, 0.05), hi: quantileSorted(pd, 0.95) };
    }
  } catch (e) { S.error = e; }
  window.addEventListener('hashchange', route);
  route();
}

function decisions() {
  if (!S.decided[S.q]) S.decided[S.q] = decideBatch({ batch: S.ds.open, stats: S.stats, calScores: S.ds.calibration, lanes: S.ds.lanes, q: S.q });
  return S.decided[S.q];
}

function route() {
  closePanel(false);
  if (S.error) { view.innerHTML = errorState(S.error); icons(); return; }
  const { page, arg, params } = parseHash();
  if (page === 'profiles') { S.profile = arg || null; S.dh = Number(params.get('dh') || 0); renderProfiles(); }
  else if (page === 'backtest') { S.btq = params.get('q') || '0.1'; renderBacktest(); }
  else {
    S.filter = params.get('f') || 'all'; S.q = Number(params.get('q') || S.q || 0.1);
    if (![0.05, 0.1, 0.2].includes(S.q)) S.q = 0.1;
    S.sort = params.get('s') || 'evidence'; S.selected = params.get('id');
    save(); renderInspections();
    if (S.selected) openPanel(S.selected);
  }
  icons();
}

// ------------------------------------------------------------------ shared chrome
function header({ crumb, title, count, actions = '' }) {
  return `<div class="page-head">
    <div><div class="crumb">${crumb}</div>
      <div class="title-row"><h1>${title}</h1>
        <button class="view-switch" id="viewSwitch" aria-label="Switch view" aria-haspopup="listbox"><i data-lucide="chevron-down"></i></button>
        ${count != null ? `<span class="count">${count}</span>` : ''}</div></div>
    <div class="head-actions">${actions}</div></div>`;
}
function viewTabs(active) {
  const t = [['inspections', 'Adjustments'], ['profiles', 'Pallet profiles'], ['backtest', 'Backtest']];
  return `<div class="seg" role="tablist" aria-label="LTL inspection views">${t.map(([k, l]) => `<button role="tab" aria-selected="${k === active}" class="${k === active ? 'on' : ''}" data-go="${k}">${l}</button>`).join('')}</div>`;
}
function bindTabs() {
  view.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.go;
    if (k === 'inspections') setHash('inspections', null, inspHash({ id: null }));
    else if (k === 'profiles') setHash('profiles', S.profile, {});
    else setHash('backtest', null, {});
  }));
  const vs = $('#viewSwitch'); if (vs) vs.addEventListener('click', () => toast('Other Payables views: All invoices, Review incomplete, On hold'));
}

// ------------------------------------------------------------------ inspections list
function statusOf(r) { return S.statuses[r.invoice]?.status || 'open'; }
function rowsFiltered(res) {
  let rows = res.rows.slice();
  if (S.filter === 'dispute') rows = rows.filter((r) => r.decision === 'dispute');
  if (S.filter === 'accept') rows = rows.filter((r) => r.decision === 'accept');
  if (S.filter === 'done') rows = rows.filter((r) => statusOf(r) !== 'open');
  const q = S.search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => [r.invoice, r.id, r.carrierName, r.kind, r.pro].join(' ').toLowerCase().includes(q));
  const by = {
    evidence: (a, b) => a.p - b.p || b.rerate.delta - a.rerate.delta,
    amount: (a, b) => b.rerate.delta - a.rerate.delta,
    carrier: (a, b) => a.carrierName.localeCompare(b.carrierName) || a.p - b.p,
  }[S.sort] || ((a, b) => a.p - b.p);
  return rows.sort(by);
}

function evidenceCell(r, n) {
  const strength = Math.min(1, -Math.log10(r.p) / Math.log10(n + 1));
  const color = r.decision === 'dispute' ? 'var(--red)' : strength > 0.4 ? 'var(--orange)' : 'var(--muted-3)';
  return `<span class="ev" title="Conformal p-value ${r.p.toFixed(4)}"><span class="bar"><i style="width:${Math.max(6, strength * 100)}%;background:${color}"></i></span><span class="sub">p ${r.p < 0.001 ? '<0.001' : r.p.toFixed(3)}</span></span>`;
}
function adjCell(r) {
  const w = r.carrier.weight - r.bol.weight;
  const cls = r.carrier.cls !== r.bol.cls ? `<span class="cls">${r.bol.cls}</span><i data-lucide="arrow-right"></i><span class="cls"><b>${r.carrier.cls}</b></span>` : '';
  const wt = w > 0 ? `<span class="sub">+${w.toLocaleString()} lb</span>` : '';
  return `<span class="adj"><span>${r.kind === 'Reweigh + reclass' ? 'Reweigh + reclass' : r.kind}</span>${cls}${wt}</span>`;
}
function statusBadge(r) {
  const s = statusOf(r);
  return s === 'disputed' ? '<span class="badge blue">Dispute sent</span>' : s === 'accepted' ? '<span class="badge green">Accepted</span>' : '<span class="badge gray">Open</span>';
}
function recBadge(r) {
  return r.decision === 'dispute' ? '<span class="badge red">Dispute</span>' : '<span class="badge green">Accept</span>';
}

function renderInspections() {
  const res = decisions();
  const rows = rowsFiltered(res);
  const n = S.ds.calibration.length;
  const disputes = res.rows.filter((r) => r.decision === 'dispute');
  const openDisputes = disputes.filter((r) => statusOf(r) === 'open');
  const counts = { all: res.rows.length, dispute: disputes.length, accept: res.rows.length - disputes.length };
  const lane = (r) => S.ds.lanes[r.lane];
  view.innerHTML = `
  ${header({ crumb: 'Payables', title: 'LTL inspections', count: `${res.rows.length} items`, actions: `
    <label class="search"><span class="sr">Search adjustments</span><input id="q" placeholder="" value="${esc(S.search)}" aria-label="Search by invoice, shipment, PRO or carrier"><span><i data-lucide="search"></i></span></label>
    <button class="btn" id="exportCsv"><i data-lucide="download"></i>Export CSV</button>
    <button class="icon-plain" aria-label="Help" id="help"><i data-lucide="circle-help"></i></button>` })}
  <div class="toolbar">
    <div class="left">${viewTabs('inspections')}
      <div class="seg" role="tablist" aria-label="Filter by recommendation">
        ${[['all', 'All'], ['dispute', 'Dispute'], ['accept', 'Accept']].map(([k, l]) => `<button class="${S.filter === k ? 'on' : ''}" data-f="${k}" aria-pressed="${S.filter === k}">${l} (${counts[k]})</button>`).join('')}
      </div></div>
    <div class="right">
      <label class="sr" for="qsel">Target false-dispute rate</label>
      <select class="select" id="qsel" title="Target share of filed disputes the carrier got right">
        ${[0.05, 0.1, 0.2].map((q) => `<option value="${q}" ${q === S.q ? 'selected' : ''}>Target: ≤ ${q * 100}% wrong disputes</option>`).join('')}
      </select>
      <label class="sr" for="ssel">Sort</label>
      <select class="select" id="ssel">${[['evidence', 'Sort by: Evidence strength'], ['amount', 'Sort by: Billed change'], ['carrier', 'Sort by: Carrier']].map(([k, l]) => `<option value="${k}" ${k === S.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn icon" id="exportJson" aria-label="Download decisions as JSON" title="Download decisions (JSON)"><i data-lucide="cloud-download"></i></button>
    </div>
  </div>
  <div class="banner" role="region" aria-label="Reclass Defense summary">
    <div class="cell"><div class="lbl">Open inspection adjustments</div><div class="val">${res.rows.length}</div><div class="sub">${fmt$(res.totalAmount)} billed above BOL · ${S.ds.month}</div></div>
    <div class="cell"><div class="lbl">Recommended disputes</div><div class="val">${res.k}</div><div class="sub">${fmt$(res.disputeAmount)} recoverable if upheld</div></div>
    <div class="cell"><div class="lbl">Expected wrong disputes <span class="tip" tabindex="0" aria-label="How this bound works"><i data-lucide="info"></i><span class="bubble">Benjamini-Hochberg on conformal p-values keeps the expected share of filed disputes where the carrier was actually right at or below the target, assuming verified inspections are exchangeable with new correct ones (Bates et al., 2023).</span></span></div><div class="val">≤ ${fmtN(S.q * res.k, 1)}</div><div class="sub">of ${res.k} filed (target ≤ ${S.q * 100}%)</div></div>
    <div class="cell"><div class="lbl">Calibrated on</div><div class="val">${n}</div><div class="sub">carrier-upheld inspections, last 12 months</div></div>
    <div class="act"><button class="btn primary" id="sendAll" ${openDisputes.length ? '' : 'disabled'}><i data-lucide="sparkles"></i>${openDisputes.length ? `Send ${openDisputes.length} to Exception Agent` : 'All disputes sent'}</button></div>
  </div>
  <div class="chips">
    <span class="chip">Mode <b>is</b> <b>LTL</b> <span class="sub">·</span> Charge <b>is</b> <b>Reweigh / Reclass</b> <button aria-label="Remove filter" disabled>×</button></span>
    <span><button class="clear" id="reset">Reset decisions</button></span>
  </div>
  <div class="table-wrap">
  ${rows.length ? `<table class="grid" aria-label="LTL inspection adjustments">
    <thead><tr><th><input type="checkbox" aria-label="Select all" id="selAll"></th><th>Invoice #</th><th>Carrier</th><th class="hide-lg">Shipment</th><th>Adjustment</th><th class="num">Billed change</th><th class="num hide-lg">Carrier pcf</th><th class="num hide-sm">Your scans, pcf</th><th>Evidence</th><th>Recommended</th><th>Status</th></tr></thead>
    <tbody>${rows.map((r, i) => {
      const rg = S.ranges[r.invoice];
      return `<tr data-id="${r.invoice}" tabindex="0" class="${i === S.focus ? 'sel' : ''}" aria-label="Invoice ${r.invoice}">
      <td><input type="checkbox" aria-label="Select ${r.invoice}" data-cb></td>
      <td><span class="mono">${r.invoice}</span></td>
      <td>${esc(r.carrierName)}</td>
      <td class="hide-lg" title="${lane(r).origin} → ${lane(r).dest}">${r.id}</td>
      <td>${adjCell(r)}</td>
      <td class="num">${r.rerate.delta > 0 ? '+' : ''}${fmt$(r.rerate.delta)}</td>
      <td class="num hide-lg">${fmtN(r.carrier.density)}</td>
      <td class="num hide-sm">${fmtN(rg.lo)}–${fmtN(rg.hi)}</td>
      <td>${evidenceCell(r, n)}</td>
      <td>${recBadge(r)}</td>
      <td>${statusBadge(r)}</td></tr>`;
    }).join('')}</tbody></table>` : `<div class="empty"><i data-lucide="search-x"></i><p>No adjustments match “${esc(S.search)}”.</p><button class="btn ghost" id="clearSearch">Clear search</button></div>`}
  </div>`;
  bindTabs();
  view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { S.focus = 0; setHash('inspections', null, inspHash({ f: b.dataset.f === 'all' ? null : b.dataset.f, id: null })); }));
  $('#qsel').addEventListener('change', (e) => { S.q = Number(e.target.value); save(); setHash('inspections', null, inspHash({ q: S.q === 0.1 ? null : S.q })); });
  $('#ssel').addEventListener('change', (e) => setHash('inspections', null, inspHash({ s: e.target.value === 'evidence' ? null : e.target.value })));
  const qi = $('#q');
  qi.addEventListener('input', (e) => { S.search = e.target.value; const pos = e.target.selectionStart; renderInspections(); icons(); const n2 = $('#q'); n2.focus(); n2.setSelectionRange(pos, pos); });
  $('#exportCsv').addEventListener('click', () => exportCsv(res));
  $('#exportJson').addEventListener('click', () => download(`reclass-decisions-q${S.q}.json`, JSON.stringify(exportRows(res), null, 2), 'application/json'));
  $('#help').addEventListener('click', toggleKeys);
  $('#reset').addEventListener('click', () => { S.statuses = {}; save(); renderInspections(); icons(); toast('Decisions reset'); });
  $('#sendAll').addEventListener('click', () => {
    const now = new Date().toISOString();
    openDisputes.forEach((r) => { S.statuses[r.invoice] = { status: 'disputed', at: now }; });
    save(); renderInspections(); icons(); toast(`${openDisputes.length} disputes queued for the Exception Agent with evidence attached`);
  });
  const cs = $('#clearSearch'); if (cs) cs.addEventListener('click', () => { S.search = ''; renderInspections(); icons(); });
  view.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.addEventListener('click', (e) => { if (e.target.matches('[data-cb]')) return; S.focus = i; setHash('inspections', null, inspHash({ id: tr.dataset.id })); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') tr.click(); });
  });
  S.visible = rows;
}

function exportRows(res) {
  return res.rows.map((r) => ({
    invoice: r.invoice, shipment: r.id, pro: r.pro, carrier: r.carrierName, adjustment: r.kind,
    bol_class: r.bol.cls, billed_class: r.carrier.cls, bol_weight_lb: r.bol.weight, billed_weight_lb: r.carrier.weight,
    carrier_density_pcf: r.carrier.density, scan_density_p05: round2(S.ranges[r.invoice].lo), scan_density_p95: round2(S.ranges[r.invoice].hi),
    score: round2(r.score), driver: r.driver, conformal_p: Number(r.p.toFixed(5)), recommendation: r.decision,
    billed_change_usd: r.rerate.delta, status: statusOf(r), target_q: S.q,
  }));
}
function exportCsv(res) {
  const rows = exportRows(res);
  const head = Object.keys(rows[0]);
  const csv = [head.join(','), ...rows.map((r) => head.map((h) => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
  download(`reclass-decisions-q${S.q}.csv`, csv, 'text/csv');
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  toast('Downloaded ' + name);
}

// ------------------------------------------------------------------ detail panel
function openPanel(id) {
  const res = decisions();
  const r = res.rows.find((x) => x.invoice === id);
  if (!r) { layer.innerHTML = ''; toast('Invoice ' + id + ' not found'); return; }
  const L = S.ds.lanes[r.lane];
  const rg = S.ranges[r.invoice];
  const order = res.rows.map((x) => x.p).sort((a, b) => a - b);
  const rank = order.indexOf(r.p) + 1;
  const m = res.rows.length;
  const st = S.statuses[r.invoice];
  const status = statusOf(r);
  const units = r.units.map((pid, i) => {
    const s = S.stats[pid], meas = r.carrier_measured.units[r.perm ? r.perm[i] : i];
    const zH = meas ? (meas.h - 0.5 - s.mh) / Math.hypot(s.sh, 0.35) : null;
    const fp = meas ? `${meas.l}×${meas.w}` : '—';
    return { pid, name: S.profiles[pid].name, s, meas, zH, fp, fpOk: meas && meas.l - s.l <= 1 && meas.w - s.w <= 1 };
  });
  const extra = r.carrier_measured.units.length - r.units.length;
  const stale = classRank(r.expectedCls) > classRank(r.bol.cls);
  const verdict = verdictText(r, units, extra, rg, stale);
  const issue = new Date(2026, 9, 3 + (Number(r.invoice) % 25));
  const due = new Date(issue.getTime() + 30 * 864e5);
  const d = (x) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lineRow = (label, icon, inv, exp) => `<tr><td><span class="adj"><i data-lucide="${icon}"></i>${label}</span></td><td>${fmt$(inv)}</td><td>${Math.abs(inv - exp) > 0.005 ? '<span class="dot"></span>' : ''}${fmt$(exp)}</td><td>${fmt$(0)}</td><td>${fmt$(r.decision === 'dispute' && status !== 'accepted' ? exp : inv)}</td></tr>`;
  layer.innerHTML = `<div class="scrim" id="scrim"></div>
  <section class="panel" role="dialog" aria-modal="true" aria-label="AP Invoice ${r.invoice}">
    <div class="panel-head"><h2>AP Invoice <span class="mono">${r.invoice}</span><i data-lucide="copy"></i></h2>
      <div class="acts"><button class="btn icon" aria-label="More actions"><i data-lucide="ellipsis"></i></button><button class="btn ghost" id="fullPage">Go to full page</button><button class="icon-plain" id="closeP" aria-label="Close panel"><i data-lucide="x"></i></button></div></div>
    <div class="panel-body">
      <div class="tags">
        <span class="tag green"><span>Audit</span><span>Published</span></span>
        <span class="tag ${status === 'open' ? 'gray' : status === 'disputed' ? 'blue' : 'green'}"><span>Review</span><span>${status === 'open' ? 'Review incomplete' : status === 'disputed' ? 'In dispute' : 'Fully approved'}</span></span>
        <span class="tag gray"><span>Balance</span><span>Open</span></span>
        <span class="tag ${r.decision === 'dispute' ? 'red' : 'green'}"><span>Inspection</span><span>${r.kind}</span></span>
      </div>
      <div class="card"><div class="row activity"><b>Latest activity</b>&nbsp; ${st ? (st.status === 'disputed' ? 'Exception Agent sent an inspection dispute to ' + esc(r.carrierName) : 'Inspection adjustment accepted') + ` <span class="sub">· ${timeAgo(st.at)}</span>` : `Loop linked inspection certificate <span class="mono" style="font-weight:500">${r.cert}</span> to the invoice <span class="sub">· 2 hours ago</span>`}</div></div>
      <div class="card"><div class="inv">
        <div><div class="sub" style="font-size:13px">Invoiced</div><div class="big">${fmtN(r.rerate.billed.total, 2)} <small>USD</small></div>
          <dl class="kv" style="margin-top:10px"><dt>Vendor</dt><dd>${esc(r.carrierName)}</dd><dt>Shipment</dt><dd>${r.id} · LTL · PRO ${r.pro}</dd><dt>Lane</dt><dd>${L.origin} → ${L.dest}</dd><dt>Issue date</dt><dd>${d(issue)}</dd></dl></div>
        <div class="pay"><div class="sub" style="font-size:13px">Send payment to</div><div style="font-weight:600">${esc(r.carrierName)}</div>
          <dl class="kv" style="margin-top:10px"><dt>Payment due</dt><dd>${d(due)}</dd><dt>Payment method</dt><dd>Electronic transfer</dd><dt>BOL</dt><dd>Class ${r.bol.cls} · ${r.bol.weight.toLocaleString()} lb</dd><dt>Billed</dt><dd>Class ${r.carrier.cls} · ${r.carrier.weight.toLocaleString()} lb</dd></dl></div>
      </div><div class="updated"><span>Updated with <a href="#" onclick="return false">Inspection certificate</a> received on ${d(issue)}, 9:39 AM from <a href="#" onclick="return false">Email</a></span><button class="linkbtn" type="button"><i data-lucide="upload"></i>Upload invoice</button></div></div>
      <div class="tabs" role="tablist"><button class="on">Line items</button><button>Payments</button><button>Accounting</button><button>Invoice artifacts</button></div>
      <table class="lines" style="margin:10px 0 16px"><thead><tr><th>Line item</th><th>Invoiced</th><th>Expected</th><th>Paid</th><th>To approve</th></tr></thead><tbody>
        ${lineRow(`Linehaul · class ${r.carrier.cls}`, 'route', r.rerate.billed.linehaul, r.rerate.expected.linehaul)}
        ${lineRow('Fuel surcharge', 'fuel', r.rerate.billed.fuel, r.rerate.expected.fuel)}
        <tr class="total"><td>Subtotal</td><td>${fmt$(r.rerate.billed.total)}</td><td>${r.rerate.delta ? '<span class="dot"></span>' : ''}${fmt$(r.rerate.expected.total)}</td><td>${fmt$(0)}</td><td>${fmt$(r.decision === 'dispute' && status !== 'accepted' ? r.rerate.expected.total : r.rerate.billed.total)}</td></tr>
      </tbody></table>
      <div class="card evidence">
        <div class="row" style="justify-content:space-between"><h3><i data-lucide="sparkles"></i>Inspection evidence</h3><span>${recBadge(r)}</span></div>
        <div class="verdict"><p>${verdict}</p></div>
        <div class="stats">
          <div><div class="l">Conformal p-value</div><div class="v">${r.p < 0.001 ? '< 0.001' : r.p.toFixed(3)}</div></div>
          <div><div class="l">Rank in batch</div><div class="v">${rank} of ${m}</div><div class="s">BH cut-off p ≤ ${res.k ? res.threshold.toFixed(3) : '—'}</div></div>
          <div><div class="l">Strongest signal</div><div class="v">${driverLabel(r)}</div></div>
          <div><div class="l">${r.decision === 'dispute' ? 'Recoverable' : 'Billed change'}</div><div class="v">${fmt$(r.rerate.delta)}</div></div>
        </div>
        <div class="chart">${densityChart(r, rg)}</div>
        <table class="units"><thead><tr><th>Handling unit (BOL)</th><th>Your scans: height</th><th>Carrier height</th><th>Footprint</th><th>z</th></tr></thead><tbody>
          ${units.map((u, i) => `<tr><td>${i + 1}. ${esc(u.name)} <span class="sub">${u.pid}</span></td><td>${fmtN(u.s.mh)} in ± ${fmtN(u.s.sh)}</td><td class="${u.zH > 3 ? 'flag' : ''}">${u.meas ? u.meas.h + ' in' : '—'}</td><td class="${u.fpOk ? '' : 'flag'}">${u.fp}</td><td class="${u.zH > 3 ? 'flag' : ''}">${u.zH == null ? '—' : fmtN(u.zH)}</td></tr>`).join('')}
          ${extra > 0 ? r.carrier_measured.units.slice(r.units.length).map((u) => `<tr><td class="flag">Extra unit on certificate (not on BOL)</td><td>—</td><td class="flag">${u.h} in</td><td class="flag">${u.l}×${u.w}</td><td class="flag">count</td></tr>`).join('') : ''}
        </tbody></table>
        <div class="row" style="border-top:1px solid var(--border-2);font-size:13px;gap:24px;flex-wrap:wrap">
          <span><span class="sub">Carrier weight</span> ${r.carrier_measured ? (r.carrier.measuredWeight || r.carrier.weight).toLocaleString() : ''} lb</span>
          <span><span class="sub">Expected from scans</span> ${Math.round(r.expected.weight).toLocaleString()} lb ± ${pct(r.expected.sdLogW)}</span>
          <span><span class="sub">Carrier density</span> ${fmtN(r.carrier.density)} pcf → class ${classForDensity(r.carrier.density)}</span>
          <span><span class="sub">Scan density (90%)</span> ${fmtN(rg.lo)}–${fmtN(rg.hi)} pcf</span>
        </div>
        ${status === 'disputed' ? `<div style="padding:0 0 2px"><div class="row"><h3 style="font-size:13px">Dispute sent by Exception Agent</h3></div><pre class="note">${esc(disputeNote(r, units, extra, rg))}</pre></div>` : ''}
        <div class="decision-bar">
          <span class="grow">${status === 'open' ? 'Shortcuts: <kbd>D</kbd> dispute · <kbd>A</kbd> accept · <kbd>J</kbd>/<kbd>K</kbd> next/previous · <kbd>Esc</kbd> close' : status === 'disputed' ? 'Dispute open with the carrier. Payment of the disputed amount is held.' : 'Adjustment accepted; invoice approved at the billed amount.'}</span>
          <button class="btn ghost" id="dlEvidence"><i data-lucide="file-down"></i>Evidence (JSON)</button>
          ${status === 'open' ? `<button class="btn ghost" id="accept">Accept adjustment</button><button class="btn primary" id="dispute"><i data-lucide="send"></i>Dispute with evidence</button>` : `<button class="btn ghost" id="undo"><i data-lucide="undo-2"></i>Reopen</button>`}
        </div>
      </div>
      ${stale ? `<div class="card"><div class="row" style="gap:10px"><i data-lucide="triangle-alert" style="width:16px;height:16px;color:var(--orange-ink)"></i><span style="font-size:13px">Your own scans put this shipment at class ${r.expectedCls}, worse than the BOL's class ${r.bol.cls}. The carrier is likely right and the master data is stale. <a href="#/profiles/${staleProfile(r)}">Review pallet profile ${staleProfile(r)}</a></span></div></div>` : ''}
    </div>
  </section>`;
  icons();
  $('#scrim').addEventListener('click', () => closePanel());
  $('#closeP').addEventListener('click', () => closePanel());
  $('#fullPage').addEventListener('click', () => toast('Full invoice page is outside this demo'));
  $('#dlEvidence').addEventListener('click', () => download(`evidence-${r.invoice}.json`, JSON.stringify(evidencePacket(r, units, rg), null, 2), 'application/json'));
  const act = (s) => { S.statuses[r.invoice] = { status: s, at: new Date().toISOString() }; save(); renderInspections(); openPanel(r.invoice); icons(); toast(s === 'disputed' ? 'Dispute sent to ' + r.carrierName : 'Adjustment accepted'); };
  const dB = $('#dispute'); if (dB) dB.addEventListener('click', () => act('disputed'));
  const aB = $('#accept'); if (aB) aB.addEventListener('click', () => act('accepted'));
  const uB = $('#undo'); if (uB) uB.addEventListener('click', () => { delete S.statuses[r.invoice]; save(); renderInspections(); openPanel(r.invoice); icons(); });
  S.panelRow = r;
}
function closePanel(updateHash = true) {
  if (!layer.innerHTML) return;
  layer.innerHTML = ''; S.panelRow = null;
  if (updateHash && parseHash().params.get('id')) { S.selected = null; history.replaceState(null, '', '#/inspections' + qsFrom(inspHash({ id: null }))); }
}
function qsFrom(o) { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString(); return s ? '?' + s : ''; }
function timeAgo(iso) { const s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' hours ago' : Math.floor(s / 86400) + ' days ago'; }
function staleProfile(r) {
  return r.units.map((pid) => ({ pid, gap: S.stats[pid].mh - S.profiles[pid].h })).sort((a, b) => b.gap - a.gap)[0].pid;
}
function driverLabel(r) { return { count: 'Unit count', height: 'Unit height', footprint: 'Footprint', weight: 'Weight', density: 'Density' }[r.driver]; }

function verdictText(r, units, extra, rg, stale) {
  if (r.decision === 'accept') {
    if (stale) return `The carrier's measurement is consistent with your own dimensioner scans (p = ${r.p.toFixed(2)}). The class change comes from your BOL: scans of these pallets put the shipment at class ${r.expectedCls}, not the declared ${r.bol.cls}. Accept, and fix the master data so the next BOL is right.`;
    return `The carrier's measurement is consistent with ${units.reduce((a, u) => a + u.s.n, 0)} recent scans of these pallet profiles (p = ${r.p.toFixed(2)}). A dispute would likely be denied; accept the ${fmt$(r.rerate.delta)} change.`;
  }
  if (r.driver === 'count') return `The inspection certificate ${r.cert} lists ${r.carrier_measured.units.length} handling units; the BOL, the packing list and your DC scans have ${r.units.length}. The extra unit's cube moved the shipment to class ${r.carrier.cls}. Dispute with the certificate and the BOL attached.`;
  if (r.driver === 'height') {
    const u = units.reduce((a, b) => (b.zH > a.zH ? b : a));
    return `Unit “${esc(u.name)}” was measured at ${u.meas.h} in. Your last ${u.s.n} scans of that pallet profile have a median of ${fmtN(u.s.mh)} in (spread ±${fmtN(u.s.sh)} in), so ${u.meas.h} in is ${fmtN(u.zH)} standard deviations out. Typical cause: measured to the highest point or a topper. Rerated at the BOL class this invoice is ${fmt$(r.rerate.delta)} lower.`;
  }
  if (r.driver === 'footprint') {
    const u = units.find((x) => !x.fpOk) || units[0];
    return `The certificate records a ${u.fp} in footprint; every scan of “${esc(u.name)}” ships on ${u.s.l}×${u.s.w} in. Overhang measurement inflated the cube to ${fmtN(r.carrier.density)} pcf (class ${r.carrier.cls}); your scans put this shipment at ${fmtN(rg.lo)}–${fmtN(rg.hi)} pcf.`;
  }
  if (r.driver === 'weight') return `The carrier billed ${r.carrier.weight.toLocaleString()} lb against ${Math.round(r.expected.weight).toLocaleString()} lb expected from your scale history (spread ±${pct(r.expected.sdLogW)}), ${pct(r.carrier.weight / r.expected.weight - 1)} heavier. That is well outside normal scale error; the reweigh likely included other freight.`;
  return `The carrier's ${fmtN(r.carrier.density)} pcf is below the range your scans predict for these pallets (${fmtN(rg.lo)}–${fmtN(rg.hi)} pcf), which moved the shipment from class ${r.bol.cls} to ${r.carrier.cls}.`;
}

function carrierReason(r, units, rg) {
  if (r.driver === 'count') return `Inspection certificate ${r.cert} lists ${r.carrier_measured.units.length} handling units. The bill of lading and our packing list show ${r.units.length}, and our dock dimensioner recorded ${r.units.length} pallets for this shipment.`;
  if (r.driver === 'height') {
    const u = units.reduce((a, b) => (b.zH > a.zH ? b : a));
    return `The certificate records a ${u.meas.h} in height for a ${u.name} pallet. Our dimensioner has measured this build ${u.s.n} times with a median of ${fmtN(u.s.mh)} in (spread ±${fmtN(u.s.sh)} in); a ${u.meas.h} in reading suggests it was measured to the highest point or with adjacent freight.`;
  }
  if (r.driver === 'footprint') {
    const u = units.find((x) => !x.fpOk) || units[0];
    return `The certificate records a ${u.fp} in footprint. This pallet ships on a ${u.s.l}×${u.s.w} in base in all ${u.s.n} of our dimensioner scans, so the cube appears to include overhang.`;
  }
  if (r.driver === 'weight') return `The reweigh bills ${r.carrier.weight.toLocaleString()} lb. Our certified dock scale history for these pallets gives ${Math.round(r.expected.weight).toLocaleString()} lb ± ${pct(r.expected.sdLogW)}, and the BOL declares ${r.bol.weight.toLocaleString()} lb.`;
  return `The inspected density of ${fmtN(r.carrier.density)} pcf is below the ${fmtN(rg.lo)}–${fmtN(rg.hi)} pcf our dimensioner records for these pallets.`;
}

function disputeNote(r, units, extra, rg) {
  return `To: ${r.carrierName} billing\nRe: Inspection adjustment on PRO ${r.pro} (invoice ${r.invoice}, cert ${r.cert})\n\n` +
    `We dispute the ${r.kind.toLowerCase()} on this shipment. ${carrierReason(r, units, rg)}\n\n` +
    `Requested correction: rerate at class ${r.bol.cls}, ${r.bol.weight.toLocaleString()} lb (${fmt$(r.rerate.expected.total)} vs ${fmt$(r.rerate.billed.total)} billed). ` +
    `Attached: BOL, packing list, dimensioner and scale records for ${units.map((u) => u.pid).filter((v, i, a) => a.indexOf(v) === i).join(', ')}, inspection certificate ${r.cert}.`;
}
function evidencePacket(r, units, rg) {
  return {
    invoice: r.invoice, shipment: r.id, pro: r.pro, carrier: r.carrierName, certificate: r.cert, adjustment: r.kind,
    bol: r.bol, billed: { class: r.carrier.cls, weight_lb: r.carrier.weight, density_pcf: r.carrier.density },
    carrier_units: r.carrier_measured.units,
    scan_profiles: units.map((u) => ({ profile: u.pid, name: u.name, scans: u.s.n, median_height_in: round2(u.s.mh), height_sd_in: round2(u.s.sh), footprint_in: [u.s.l, u.s.w] })),
    scan_density_90pct_pcf: [round2(rg.lo), round2(rg.hi)],
    test: { score: round2(r.score), driver: r.driver, conformal_p: Number(r.p.toFixed(5)), calibration_n: S.ds.calibration.length, bh_target_q: S.q, recommendation: r.decision },
    rerate: r.rerate,
  };
}

// SVG: predictive density histogram with NMFC class bands, BOL and carrier marks
function densityChart(r, rg) {
  const W = 700, H = 150, P = { l: 34, r: 12, t: 22, b: 26 };
  const xs = [rg.pd[0], rg.pd[rg.pd.length - 1], r.carrier.density, r.bol.density];
  let lo = Math.min(...xs) * 0.9, hi = Math.max(...xs) * 1.08;
  const X = (d) => P.l + ((d - lo) / (hi - lo)) * (W - P.l - P.r);
  const bins = 40, counts = new Array(bins).fill(0);
  for (const d of rg.pd) counts[Math.min(bins - 1, Math.max(0, Math.floor(((d - lo) / (hi - lo)) * bins)))]++;
  const maxC = Math.max(...counts);
  const bw = (W - P.l - P.r) / bins;
  const bands = NMFC_SCALE.map(([a], i) => ({ cls: NMFC_SCALE[i][1], a, b: i === 0 ? Infinity : NMFC_SCALE[i - 1][0] }))
    .filter((b) => b.b > lo && b.a < hi);
  const bandSvg = bands.map((b, i) => {
    const x1 = X(Math.max(lo, b.a)), x2 = X(Math.min(hi, b.b));
    return `<rect x="${x1}" y="${P.t}" width="${Math.max(0, x2 - x1)}" height="${H - P.t - P.b}" fill="${i % 2 ? '#fafafa' : '#f2f2f2'}"/>` +
      (x2 - x1 > 34 ? `<text x="${(x1 + x2) / 2}" y="${P.t - 8}" text-anchor="middle" font-size="11" fill="#6f6f6f">Class ${b.cls}</text>` : '') +
      (b.a > lo ? `<line x1="${X(b.a)}" x2="${X(b.a)}" y1="${P.t}" y2="${H - P.b}" stroke="#d9d9d9"/>` : '');
  }).join('');
  const bars = counts.map((c, i) => c ? `<rect x="${P.l + i * bw + 1}" y="${H - P.b - (c / maxC) * (H - P.t - P.b - 8)}" width="${bw - 2}" height="${(c / maxC) * (H - P.t - P.b - 8)}" rx="1.5" fill="#8c8c8c" opacity=".55"/>` : '').join('');
  const ticks = [];
  const step = (hi - lo) > 20 ? 5 : (hi - lo) > 8 ? 2 : 1;
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(`<text x="${X(t)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#8c8c8c">${t}</text>`);
  const mark = (d, color, dash, label, anchor) => `<line x1="${X(d)}" x2="${X(d)}" y1="${P.t}" y2="${H - P.b}" stroke="${color}" stroke-width="2" ${dash ? 'stroke-dasharray="4 3"' : ''}/>`;
  return `<div class="legend"><span><i style="background:#8c8c8c;opacity:.55"></i>Density predicted from your scans (400 resamples)</span><span><i style="background:#292929"></i>BOL declared ${fmtN(r.bol.density)} pcf</span><span><i style="background:#e4413e"></i>Carrier measured ${fmtN(r.carrier.density)} pcf</span></div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Density distribution with class bands; carrier measured ${fmtN(r.carrier.density)} pcf, scans predict ${fmtN(rg.lo)} to ${fmtN(rg.hi)} pcf">
    ${bandSvg}${bars}
    <rect x="${X(rg.lo)}" y="${H - P.b + 2}" width="${X(rg.hi) - X(rg.lo)}" height="3" fill="#585858" rx="1.5"/>
    ${mark(r.bol.density, '#292929', true)}${mark(r.carrier.density, '#e4413e', false)}
    <line x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}" stroke="#d9d9d9"/>
    ${ticks.join('')}<text x="${W - P.r}" y="${H - 8}" text-anchor="end" font-size="11" fill="#8c8c8c" dx="0" dy="0"></text>
    <text x="${P.l - 6}" y="${H - P.b + 4}" text-anchor="end" font-size="11" fill="#8c8c8c">pcf</text>
  </svg>`;
}

// ------------------------------------------------------------------ profiles
function profileRows() {
  return S.ds.profiles.map((p) => {
    const s = S.stats[p.id], scans = S.ds.scans[p.id];
    const masterD = p.wt / cubeFt3(p.l, p.w, p.h);
    const declared = classForDensity(masterD);
    const scanD = Math.exp(s.md);
    const risk = reclassRisk(s, scans, declared, 0);
    const [blo] = densityBand(classForDensity(scanD));
    const margin = (scanD - blo) / scanD;
    const units = S.ds.open.reduce((a, o) => a + o.units.filter((u) => u === p.id).length, 0);
    return { p, s, scans, masterD, declared, scanD, scanCls: classForDensity(scanD), risk, margin, stale: s.mh - p.h > 1.5, units };
  });
}
function renderProfiles() {
  const rows = profileRows();
  const sel = rows.find((x) => x.p.id === S.profile) || rows.slice().sort((a, b) => b.risk - a.risk)[0];
  S.profile = sel.p.id;
  view.innerHTML = `${header({ crumb: 'Payables', title: 'LTL inspections', count: `${rows.length} pallet profiles`, actions: `<button class="btn" id="expP"><i data-lucide="download"></i>Export CSV</button><button class="icon-plain" aria-label="Help" id="help"><i data-lucide="circle-help"></i></button>` })}
  <div class="toolbar"><div class="left">${viewTabs('profiles')}<span class="sub" style="font-size:13px">Reclass risk = share of your own scans that an accurate carrier inspection would put in a worse class than the BOL declares.</span></div></div>
  <div class="split"><div class="table-wrap"><table class="grid" aria-label="Pallet profiles">
    <thead><tr><th>Profile</th><th class="num">BOL height</th><th class="num">Scan height</th><th class="num">Scan pcf</th><th class="num">BOL class</th><th class="num">Scan class</th><th>Reclass risk</th><th class="num hide-sm">Room above break</th></tr></thead>
    <tbody>${rows.map((x) => `<tr data-p="${x.p.id}" tabindex="0" class="${x.p.id === sel.p.id ? 'sel' : ''}">
      <td title="${esc(x.p.name)}"><span class="mono">${x.p.id}</span> ${esc(x.p.name)} ${x.stale ? '<span class="badge yellow">Height drift</span>' : ''}</td>
      <td class="num">${x.p.h} in</td><td class="num ${x.stale ? 'flagc' : ''}">${fmtN(x.s.mh)} in</td><td class="num">${fmtN(x.scanD)}</td><td class="num">${x.declared}</td><td class="num">${x.scanCls === x.declared ? x.scanCls : `<b style="color:var(--red)">${x.scanCls}</b>`}</td>
      <td>${riskCell(x.risk)}</td><td class="num hide-sm">${pct(x.margin, 0)}</td></tr>`).join('')}</tbody></table></div>
    <aside class="side" aria-label="Profile what-if">${profileSide(sel)}</aside></div>`;
  bindTabs();
  view.querySelectorAll('tbody tr').forEach((tr) => { tr.addEventListener('click', (e) => { if (e.target.matches('input')) return; setHash('profiles', tr.dataset.p, {}); }); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') tr.click(); }); });
  $('#help').addEventListener('click', toggleKeys);
  $('#expP').addEventListener('click', () => {
    const head = ['profile', 'name', 'master_height_in', 'scan_median_height_in', 'scan_density_pcf', 'bol_class', 'scan_class', 'reclass_risk', 'stale_master_data'];
    const csv = [head.join(','), ...rows.map((x) => [x.p.id, x.p.name, x.p.h, round2(x.s.mh), round2(x.scanD), x.declared, x.scanCls, round2(x.risk), x.stale].map((v) => JSON.stringify(v)).join(','))].join('\n');
    download('pallet-profiles.csv', csv, 'text/csv');
  });
  const rg = $('#dh');
  if (rg) rg.addEventListener('input', (e) => { S.dh = Number(e.target.value); $('.side').innerHTML = profileSide(sel); icons(); bindSide(sel); history.replaceState(null, '', `#/profiles/${sel.p.id}${S.dh ? '?dh=' + S.dh : ''}`); });
  bindSide(sel);
}
function bindSide(sel) {
  const rg = $('#dh');
  if (rg) rg.oninput = (e) => { S.dh = Number(e.target.value); $('.side').innerHTML = profileSide(sel); icons(); bindSide(sel); $('#dh').focus(); history.replaceState(null, '', `#/profiles/${sel.p.id}${S.dh ? '?dh=' + S.dh : ''}`); };
  const ap = $('#applyMaster');
  if (ap) ap.onclick = () => toast(`Master data for ${sel.p.id} queued: height ${Math.round(sel.s.mh + S.dh)} in`);
}
function riskCell(r) {
  const c = r > 0.25 ? 'var(--red)' : r > 0.05 ? 'var(--orange)' : 'var(--green)';
  return `<span class="risk"><span class="bar"><i style="width:${Math.max(3, r * 100)}%;background:${c}"></i></span>${pct(r, 0)}</span>`;
}
function profileSide(x) {
  const dh = S.dh || 0;
  const d0 = x.scanD, h1 = x.s.mh + dh;
  const d1 = Math.exp(x.s.mw) / cubeFt3(x.s.l, x.s.w, h1);
  const r1 = reclassRisk(x.s, x.scans, x.declared, dh);
  const c1 = classForDensity(d1);
  return `<h3>${x.p.id} · ${esc(x.p.name)}</h3>
  <div class="sub" style="font-size:13px">${x.s.n} dimensioner scans · ${x.s.l}×${x.s.w} in footprint · median ${Math.round(Math.exp(x.s.mw)).toLocaleString()} lb</div>
  ${x.stale ? `<p style="font-size:13px;line-height:20px;margin:12px 0 0"><span class="badge yellow">Height drift</span> BOLs use ${x.p.h} in, but your scans median ${fmtN(x.s.mh)} in. ${x.risk > 0.05 ? `An accurate carrier inspection will reclass this pallet ${pct(x.risk, 0)} of the time, and those reclasses are correct, so fix the master data instead of disputing.` : `The drift has not crossed a class break yet (${pct(x.margin, 0)} density headroom), but BOL weights and cubes are off.`}</p>` : `<p style="font-size:13px;line-height:20px;margin:12px 0 0;color:var(--muted)">Master data matches your scans. ${x.risk > 0.05 ? `This pallet sits ${pct(x.margin, 0)} above a class break, so ${pct(x.risk, 0)} of builds would class worse on an accurate inspection.` : `Accurate inspections should not reclass it.`}</p>`}
  <div style="margin-top:16px"><label for="dh" style="font-size:13px;font-weight:600">What-if: change pallet height</label>
  <div style="display:flex;align-items:center;gap:10px"><input type="range" class="range" id="dh" min="-8" max="4" step="1" value="${dh}" aria-valuetext="${dh} inches"><span class="mono" style="width:52px;text-align:right">${dh > 0 ? '+' : ''}${dh} in</span></div></div>
  <div class="whatif">
    <div class="box"><div class="l">Density</div><div class="v">${fmtN(d1)} pcf</div><div class="d ${d1 >= d0 ? 'down' : 'up'}">${dh ? (d1 >= d0 ? '+' : '') + fmtN(d1 - d0) + ' vs today' : 'today'}</div></div>
    <div class="box"><div class="l">Class at median</div><div class="v">${c1}</div><div class="d ${classRank(c1) <= classRank(x.scanCls) ? 'down' : 'up'}">${c1 === x.scanCls ? 'no change' : 'from ' + x.scanCls}</div></div>
    <div class="box"><div class="l">Reclass risk vs BOL ${x.declared}</div><div class="v">${pct(r1, 0)}</div><div class="d ${r1 <= x.risk ? 'down' : 'up'}">${dh ? (r1 <= x.risk ? '' : '+') + fmtN(100 * (r1 - x.risk), 0) + ' pts' : 'today'}</div></div>
    <div class="box"><div class="l">Units this month</div><div class="v">${x.units}</div><div class="d sub">in open adjustments</div></div>
  </div>
  <div class="card" style="margin-top:4px"><div class="chart" style="border-top:0">${profileChart(x, dh)}</div></div>
  <button class="btn ${x.stale ? 'primary' : 'ghost'}" id="applyMaster" style="margin-top:6px"><i data-lucide="pencil"></i>Update master data to ${Math.round(x.s.mh + dh)} in</button>`;
}
function profileChart(x, dh) {
  const W = 330, H = 120, P = { l: 8, r: 8, t: 18, b: 22 };
  const ds = x.scans.map((s) => s.weight / cubeFt3(s.l, s.w, Math.max(1, s.h + dh))).sort((a, b) => a - b);
  const lo = Math.min(ds[0], x.masterD) * 0.92, hi = Math.max(ds[ds.length - 1], x.masterD) * 1.06;
  const X = (d) => P.l + ((d - lo) / (hi - lo)) * (W - P.l - P.r);
  const bins = 28, c = new Array(bins).fill(0);
  ds.forEach((d) => c[Math.min(bins - 1, Math.floor(((d - lo) / (hi - lo)) * bins))]++);
  const m = Math.max(...c), bw = (W - P.l - P.r) / bins;
  const breaks = NMFC_SCALE.map(([a, cls]) => ({ a, cls })).filter((b) => b.a > lo && b.a < hi);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scan density histogram with class breaks">
    ${breaks.map((b) => `<line x1="${X(b.a)}" x2="${X(b.a)}" y1="${P.t}" y2="${H - P.b}" stroke="#b9b9b9" stroke-dasharray="3 3"/><text x="${X(b.a) + 3}" y="${P.t - 5}" font-size="10" fill="#6f6f6f">${b.cls} | ${b.a}</text>`).join('')}
    ${c.map((v, i) => v ? `<rect x="${P.l + i * bw + 1}" y="${H - P.b - (v / m) * (H - P.t - P.b - 4)}" width="${bw - 2}" height="${(v / m) * (H - P.t - P.b - 4)}" rx="1.5" fill="#8c8c8c" opacity=".6"/>` : '').join('')}
    <line x1="${X(x.masterD)}" x2="${X(x.masterD)}" y1="${P.t}" y2="${H - P.b}" stroke="#292929" stroke-width="2" stroke-dasharray="4 3"/>
    <line x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}" stroke="#d9d9d9"/>
    <text x="${P.l}" y="${H - 6}" font-size="10" fill="#8c8c8c">${fmtN(lo)} pcf</text><text x="${W - P.r}" y="${H - 6}" font-size="10" fill="#8c8c8c" text-anchor="end">${fmtN(hi)} pcf</text>
    <text x="${X(x.masterD)}" y="${H - 6}" font-size="10" fill="#292929" text-anchor="middle">BOL</text>
  </svg>`;
}

// ------------------------------------------------------------------ backtest
function renderBacktest() {
  const R = S.results, q = S.btq in R.by_q ? S.btq : '0.1';
  const b = R.by_q[q];
  const rows = [['reclass_defense', `Reclass Defense (BH on conformal p, target ${Number(q) * 100}%)`], ['rule_5pct', 'Fixed rule: dispute if density 5% off BOL'], ['rule_10pct', 'Fixed rule: dispute if density 10% off BOL'], ['rule_20pct', 'Fixed rule: dispute if density 20% off BOL'], ['dispute_everything', 'Dispute every adjustment']];
  view.innerHTML = `${header({ crumb: 'Payables', title: 'LTL inspections', count: `${R.seeds} simulated shippers`, actions: `<button class="btn" id="dlRes"><i data-lucide="download"></i>results.json</button>` })}
  <div class="toolbar"><div class="left">${viewTabs('backtest')}</div><div class="right"><select class="select" id="btq" aria-label="Target">${Object.keys(R.by_q).map((k) => `<option value="${k}" ${k === q ? 'selected' : ''}>Target: ≤ ${Number(k) * 100}% wrong disputes</option>`).join('')}</select></div></div>
  <div class="bt"><p>Each simulated shipper gets ${R.months_history} months of inspection history (the carrier-upheld adjustments become the calibration set) and one open month to decide, with its own master-data staleness, carrier error rates and pallet-build variability. Ground truth is known only in simulation: a dispute is “wrong” when the carrier's inspection was actually accurate. Numbers below are computed by <span class="mono" style="font-weight:500">data/generate.mjs</span> and re-checked in the test suite.</p>
  <table class="grid"><thead><tr><th>Decision rule</th><th class="num">Avg wrong-dispute rate</th><th class="num">Worst-decile shipper</th><th class="num">Shippers over 20%</th><th class="num">Overbilled $ recovered</th><th class="num">Disputes / month</th><th class="num">Wrong disputes / month</th></tr></thead>
  <tbody>${rows.map(([k, l]) => { const x = b[k]; return `<tr class="${k === 'reclass_defense' ? 'us' : ''}"><td>${l}</td><td class="num">${pct(x.fdr)}</td><td class="num">${pct(x.fdp_p90_across_shippers)}</td><td class="num">${pct(x.share_of_shippers_fdp_over_20pct, 0)}</td><td class="num">${pct(x.dollar_power)}</td><td class="num">${fmtN(x.disputes_per_month)}</td><td class="num">${fmtN(x.wrong_disputes_per_month, 2)}</td></tr>`; }).join('')}</tbody></table>
  <p style="margin-top:14px">A fixed threshold has no idea how noisy a given shipper's pallets are or how stale its master data is, so the same rule is too timid for one shipper and floods carriers with wrong disputes for another. Calibrating on each shipper's own upheld inspections keeps the false-dispute rate near the target everywhere, while still recovering ${pct(b.reclass_defense.dollar_power, 0)} of overbilled dollars.</p></div>`;
  bindTabs();
  $('#btq').addEventListener('change', (e) => setHash('backtest', null, { q: e.target.value }));
  $('#dlRes').addEventListener('click', () => download('results.json', JSON.stringify(R, null, 2), 'application/json'));
}

// ------------------------------------------------------------------ misc UI
function skeleton() {
  return `<div class="page-head"><div><div class="skel" style="width:70px;margin-bottom:8px"></div><div class="skel" style="width:220px;height:26px"></div></div></div>
  <div style="padding:24px 32px">${Array.from({ length: 9 }, () => '<div class="skel" style="margin:16px 0"></div>').join('')}</div>`;
}
function errorState(e) {
  return `<div class="error"><i data-lucide="cloud-off"></i><p>Couldn't load inspection data (${esc(e.message)}).</p><button class="btn ghost" onclick="location.reload()">Retry</button></div>`;
}
let toastT;
function toast(msg) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 2600);
}
function toggleKeys() {
  const k = $('.keys'); if (k) { k.remove(); return; }
  const d = document.createElement('div'); d.className = 'keys'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Keyboard shortcuts');
  d.innerHTML = '<b style="display:block;margin-bottom:6px">Keyboard shortcuts</b>' + [['/', 'Search'], ['J / K', 'Next / previous adjustment'], ['Enter', 'Open adjustment'], ['D', 'Dispute with evidence'], ['A', 'Accept adjustment'], ['Esc', 'Close panel'], ['?', 'Toggle this list']].map(([a, b]) => `<div><span>${b}</span><kbd>${a}</kbd></div>`).join('');
  document.body.appendChild(d);
}
document.addEventListener('keydown', (e) => {
  if (!S.ds || e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target.matches('input:not([type=checkbox]):not([type=range]), textarea, select');
  if (e.key === 'Escape') { if ($('.keys')) $('.keys').remove(); else closePanel(); return; }
  if (typing) return;
  if (e.key === '?') { toggleKeys(); return; }
  if (parseHash().page !== 'inspections') return;
  if (e.key === '/') { e.preventDefault(); $('#q')?.focus(); return; }
  const rows = S.visible || [];
  if (e.key === 'j' || e.key === 'k') {
    if (!rows.length) return;
    S.focus = Math.max(0, Math.min(rows.length - 1, S.focus + (e.key === 'j' ? 1 : -1)));
    if (S.panelRow) setHash('inspections', null, inspHash({ id: rows[S.focus].invoice }));
    else { view.querySelectorAll('tbody tr').forEach((tr, i) => tr.classList.toggle('sel', i === S.focus)); view.querySelectorAll('tbody tr')[S.focus]?.focus(); }
  }
  if (e.key === 'Enter' && !S.panelRow && rows[S.focus]) setHash('inspections', null, inspHash({ id: rows[S.focus].invoice }));
  if ((e.key === 'd' || e.key === 'a') && S.panelRow) { const b = $(e.key === 'd' ? '#dispute' : '#accept'); if (b) b.click(); }
});

boot();
