/* Smart GMV prototype — flow logic.
   Catalog (sites/merchants/customers) = DATA from data.js, generated from the real Sheet.
   AI readings = mockExtract() in mock.js (deterministic per photo). Real build swaps
   mockExtract for POST /api/extract and localStorage for the GMV Raw Data tab.
   All dynamic strings pass through esc(). */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  site: null, staff: null, pin: '',
  merchants: [],                    // merchants of the selected site
  records: {},                      // merchantId -> record (today)
  history: {},                      // dayOffset -> { merchantId -> record } (past days, editable)
  baselines: {},                    // `${mid}:${ch}` -> baseline reading
  current: null,                    // { m, mode, offset, from }
  viewer: null,                     // { ch, candidate }
};

/* Record store for a given day. Today = live session records; past days are
   loaded once (demo: synthesized; production: read from the GMV Raw Data tab)
   and stay editable — edits write back with an audit trail. */
function recordsFor(offset) {
  if (!offset) return state.records;
  if (!state.history[offset]) {
    const store = {};
    state.merchants.slice(0, Math.min(4, state.merchants.length)).forEach((m, i) => {
      store[m.id] = { status: 'Operated', saved: true, staffName: 'Yusof', expanded: {},
        channels: { grab: { finalOrders: 5 + i * 3 + offset, finalGmv: +(120 + i * 85 + offset * 7).toFixed(2) },
                    fp: { finalOrders: 2 + i, finalGmv: +(45 + i * 30).toFixed(2) } } };
    });
    state.history[offset] = store;
  }
  return state.history[offset];
}
function curRec() { return recordsFor(state.current.offset)[state.current.m.id]; }
function dayLabel(offset) {
  if (!offset) return 'Today';
  const d = new Date(); d.setDate(d.getDate() - offset);
  return d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short' });
}

/* ---------- merchant helpers ---------- */
function siteMerchants(siteId) {
  return DATA.merchants
    .filter((m) => m.site === siteId)
    .map((m, i) => ({
      ...m,
      id: `${m.site}-${m.kitchen}-${i}`,
      channels: channelsFor(m, siteId),
    }))
    .sort((a, b) => (a.kitchen === 'CR') - (b.kitchen === 'CR') || a.kitchen.localeCompare(b.kitchen, undefined, { numeric: true }));
}
function channelsFor(m, siteId) {
  const ch = ['grab', 'fp', 'others', 'catering'];
  if (siteId === 'S12') ch.push('dinein');
  return ch;
}
const CORE = ['grab', 'fp'];                      // always expanded, required
const OPTIONAL = ['others', 'catering', 'dinein']; // collapsed, default 0

/* ---------- native camera / photo picker ---------- */
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'image/*';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);
let pendingChannel = null;
fileInput.onchange = () => {
  const file = fileInput.files && fileInput.files[0];
  const ch = pendingChannel;
  fileInput.value = '';
  if (!file || !ch) return;
  const reader = new FileReader();
  reader.onload = () => downscale(reader.result).then((jpeg) => runExtraction(ch, jpeg));
  reader.readAsDataURL(file);
};
function openPicker(ch) { pendingChannel = ch; fileInput.click(); }

/* Re-encode to JPEG ≤1600px long edge: fixes iPhone HEIC uploads and cuts
   upload size + AI token cost without losing digit legibility. */
function downscale(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/* ---------- generic helpers ---------- */
const money = (v) => '$' + Number(v).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function show(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(viewId).classList.remove('hidden');
  window.scrollTo(0, 0);
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 2400);
}

/* ---------- login ---------- */
function renderSites() {
  $('site-grid').innerHTML = DATA.sites.map((s) => {
    const n = DATA.merchants.filter((m) => m.site === s.id).length;
    return `<button class="site-btn" data-site="${esc(s.id)}">${esc(s.name)}<small>${esc(s.id)} · ${n} merchants</small></button>`;
  }).join('');
  $('site-grid').querySelectorAll('.site-btn').forEach((b) => b.onclick = () => {
    state.site = DATA.sites.find((s) => s.id === b.dataset.site);
    renderStaff();
    loginStep('staff');
  });
}
function renderStaff() {
  const home = MOCK.staff.filter((p) => p.home === state.site.id);
  const others = MOCK.staff.filter((p) => p.home !== state.site.id);
  const btn = (p) => `<button class="staff-btn" data-id="${esc(p.id)}"><span class="avatar">${esc(p.name[0])}</span>${esc(p.name)}
      ${p.partTimer ? '<span class="tag pt" style="margin-left:auto">PART-TIMER</span>' : (p.home && p.home !== state.site.id ? `<span class="tag pt" style="margin-left:auto">${esc(p.home)}</span>` : '')}</button>`;
  $('staff-list').innerHTML =
    (home.length ? `<div class="roster-group">${esc(state.site.name)} team</div>` + home.map(btn).join('') : '') +
    `<div class="roster-group">Helping out today / part-timers</div>` + others.map(btn).join('');
  $('staff-list').querySelectorAll('.staff-btn').forEach((b) => b.onclick = () => {
    state.staff = MOCK.staff.find((p) => p.id === b.dataset.id);
    $('pin-staff-name').textContent = state.staff.name;
    state.pin = '';
    paintPin();
    loginStep('pin');
  });
}
function loginStep(step) {
  ['site', 'staff', 'pin'].forEach((s) => $('login-step-' + s).classList.toggle('hidden', s !== step));
}
function paintPin() {
  [...$('pin-dots').children].forEach((d, i) => d.classList.toggle('filled', i < state.pin.length));
}
function renderPinPad() {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  $('pin-pad').innerHTML = keys.map((k) => k === '' ? '<span></span>' : `<button class="pin-key" data-k="${k}">${k}</button>`).join('');
  $('pin-pad').querySelectorAll('.pin-key').forEach((b) => b.onclick = () => {
    const k = b.dataset.k;
    $('pin-error').classList.add('hidden');
    if (k === '⌫') state.pin = state.pin.slice(0, -1);
    else if (state.pin.length < 4) state.pin += k;
    paintPin();
    if (state.pin.length === 4) {
      if (state.pin === state.staff.pin) { enterApp(); }
      else { state.pin = ''; setTimeout(() => { paintPin(); $('pin-error').classList.remove('hidden'); }, 180); }
    }
  });
}
document.querySelectorAll('.back-link').forEach((b) => b.onclick = () => loginStep(b.dataset.back));

/* ---------- checklist ---------- */
function enterApp() {
  state.merchants = siteMerchants(state.site.id);
  state.records = {};
  state.baselines = {};
  $('hdr-site').textContent = `${state.site.name} · ${state.site.id}`;
  $('hdr-date').textContent = new Date().toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' });
  $('hdr-staff').textContent = state.staff.name;
  renderChecklist();
  show('view-checklist');
}
function channelFilled(rec, ch) {
  const c = rec.channels[ch];
  return c && (c.photoUrl || c.finalOrders !== undefined || c.finalGmv !== undefined || c.orders !== undefined);
}
function merchantDone(m) {
  const r = state.records[m.id];
  if (!r || !r.saved) return false;
  return true;
}
function baselineDone(m) {
  return CORE.every((ch) => state.baselines[`${m.id}:${ch}`]);
}
function renderChecklist() {
  /* Disabled brands are hidden from capture but stay in state.merchants,
     so Review (history) and Manage brands still see them. */
  const all = state.merchants.filter((m) => !m.disabled);
  const overnight = all.filter((m) => m.overnight);
  const doneCount = all.filter(merchantDone).length;

  $('prog-done').textContent = doneCount;
  $('prog-total').textContent = all.length;
  const frac = all.length ? doneCount / all.length : 0;
  $('ring-fg').style.strokeDashoffset = 194.8 * (1 - frac);
  $('prog-sub').textContent = all.length === 0
    ? 'No delivery merchants at this site yet'
    : doneCount === all.length ? 'All done — great round! 🎉'
    : `${all.length - doneCount} merchants left · tap to capture`;

  $('sec-morning-label').classList.toggle('hidden', overnight.length === 0);
  $('list-morning').innerHTML = overnight.map((m) => {
    const hasBase = baselineDone(m);
    return `<div class="merchant-card" data-id="${esc(m.id)}" data-mode="baseline">
      <div class="m-kitchen">${esc(m.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
        <div class="m-tags"><span class="tag h24">24 HR</span></div></div>
      <div class="m-status ${hasBase ? 'done' : 'flag'}">${hasBase ? '✓ baseline saved' : '⚠ shoot baseline'}</div>
    </div>`;
  }).join('');

  $('list-evening').innerHTML = all.map((m) => {
    const r = state.records[m.id];
    const done = merchantDone(m);
    let status = '<span class="m-status pending">○ pending</span>';
    if (done && r.status === 'Operated') {
      const tot = Object.values(r.channels).reduce((s, c) => s + Number(c.finalGmv ?? c.gmv ?? 0), 0);
      status = `<div style="text-align:right"><div class="m-status done">✓ saved</div><div class="m-total">${money(tot)}</div></div>`;
    } else if (done) {
      status = `<span class="m-status done">✓ ${esc(r.status)}</span>`;
    }
    const tags = [
      m.overnight ? '<span class="tag h24">24 HR</span>' : '',
      m.type === 'Cloud Retail' ? '<span class="tag retail">CLOUD RETAIL</span>' : '',
      m.aigens ? '<span class="tag aigens">AIGENS</span>' : '',
    ].join('');
    return `<div class="merchant-card ${done ? 'done' : ''}" data-id="${esc(m.id)}" data-mode="evening">
      <div class="m-kitchen">${esc(m.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)}</div><div class="m-tags">${tags}</div></div>
      ${status}
    </div>`;
  }).join('');

  document.querySelectorAll('.merchant-card').forEach((c) => c.onclick = () => openCapture(c.dataset.id, c.dataset.mode));
}
$('btn-logout').onclick = logout;
function logout() { state.pin = ''; paintPin(); loginStep('site'); show('view-login'); }

/* ---------- menu ---------- */
$('btn-menu').onclick = () => $('menu-overlay').classList.remove('hidden');
$('menu-cancel').onclick = () => $('menu-overlay').classList.add('hidden');
$('menu-overlay').onclick = (e) => { if (e.target === $('menu-overlay')) $('menu-overlay').classList.add('hidden'); };
$('menu-logout').onclick = () => { $('menu-overlay').classList.add('hidden'); logout(); };
$('menu-addbrand').onclick = () => { $('menu-overlay').classList.add('hidden'); openAddBrand(); };
$('menu-review').onclick = () => { $('menu-overlay').classList.add('hidden'); openReview(); };
$('menu-brands').onclick = () => { $('menu-overlay').classList.add('hidden'); openBrands(); };

/* ---------- manage brands (disable / re-enable, never delete) ---------- */
function openBrands() {
  $('mb-sub').textContent = `${state.site.name} · ${state.site.id}`;
  renderBrands();
  show('view-brands');
}
$('btn-brands-back').onclick = () => { renderChecklist(); show('view-checklist'); };
function renderBrands() {
  const list = state.merchants;   // full roster incl. disabled, kitchen order
  $('mb-list').innerHTML = list.length ? list.map((m) => `
    <div class="merchant-card mb ${m.disabled ? 'off' : ''}">
      <div class="m-kitchen">${esc(m.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
        <div class="m-tags">${m.disabled ? '<span class="tag off">DISABLED</span>' : '<span class="tag on">ACTIVE</span>'}${m.overnight ? '<span class="tag h24">24 HR</span>' : ''}</div></div>
      <button class="mb-toggle ${m.disabled ? 'enable' : ''}" data-id="${esc(m.id)}">${m.disabled ? 'Enable' : 'Disable'}</button>
    </div>`).join('') : '<p class="ab-note">No brands at this site yet.</p>';
  $('mb-list').querySelectorAll('.mb-toggle').forEach((b) => b.onclick = () => {
    const m = findMerchant(b.dataset.id);
    /* production: PATCH /api/merchants → ticks/unticks Disabled (col J) in SFDC ID Map */
    const src = DATA.merchants.find((x) => x.site === m.site && x.kitchen === m.kitchen && x.brand === m.brand);
    m.disabled = src.disabled = !m.disabled ? true : undefined;
    toast(m.disabled ? `${m.brand} disabled — hidden from new capture, history kept` : `${m.brand} re-enabled ✓`);
    renderBrands();
  });
}

/* ---------- review previous days ---------- */
const rv = { offset: 0 };
function openReview() {
  rv.offset = 0;
  renderReview();
  show('view-review');
}
$('btn-review-back').onclick = () => { renderChecklist(); show('view-checklist'); };
function renderReview() {
  $('rv-sub').textContent = `${state.site.name} · ${state.site.id}`;
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    return { offset: i, label: i === 0 ? 'Today' : d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }) };
  });
  $('rv-dates').innerHTML = days.map((d) =>
    `<button class="chip ${rv.offset === d.offset ? 'active' : ''}" data-o="${d.offset}">${esc(d.label)}</button>`).join('');
  $('rv-dates').querySelectorAll('.chip').forEach((b) => b.onclick = () => { rv.offset = +b.dataset.o; renderReview(); });

  /* Rows come from the editable day store — tap any row to open and change it. */
  const store = recordsFor(rv.offset);
  const rows = state.merchants.filter((m) => store[m.id] && store[m.id].saved).map((m) => ({ m, r: store[m.id] }));
  $('rv-list').innerHTML = rows.length ? rows.map(({ m, r }) => {
    const by = r.amendedBy ? `by ${esc(r.staffName || '—')} · ✏️ amended by ${esc(r.amendedBy)}` : `by ${esc(r.staffName || state.staff.name)}`;
    if (r.status !== 'Operated') {
      return `<div class="merchant-card done" data-mid="${esc(m.id)}"><div class="m-kitchen">${esc(m.kitchen)}</div>
        <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
          <div class="m-tags"><span class="customer-meta">${by}</span></div></div>
        <span class="m-status done">✓ ${esc(r.status)}</span><span class="rv-chev">›</span></div>`;
    }
    const tot = Object.values(r.channels).reduce((s, c) => s + Number(c.finalGmv ?? c.gmv ?? 0), 0);
    const ords = Object.values(r.channels).reduce((s, c) => s + Number(c.finalOrders ?? c.orders ?? 0), 0);
    return `<div class="merchant-card" data-mid="${esc(m.id)}"><div class="m-kitchen">${esc(m.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
        <div class="m-tags"><span class="customer-meta">${by}</span></div></div>
      <div style="text-align:right"><div class="m-status done">${ords} orders</div><div class="m-total">${money(tot)}</div></div>
      <span class="rv-chev">›</span>
    </div>`;
  }).join('') : '<p class="ab-note" style="margin-top:14px">No records for this day.</p>';
  $('rv-list').querySelectorAll('.merchant-card').forEach((c) =>
    c.onclick = () => openCapture(c.dataset.mid, 'evening', rv.offset, 'review'));
}

/* ---------- capture ---------- */
const CH_META = {
  grab:     { name: 'GrabFood',  cls: 'grab',   logo: 'G', hint: 'Net sales + Completed' },
  fp:       { name: 'foodpanda', cls: 'fp',     logo: 'f', hint: 'All − Cancelled' },
  others:   { name: 'Others',    cls: 'other',  logo: 'O', hint: 'AIGENS / other platforms' },
  catering: { name: 'Catering',  cls: 'cater',  logo: 'C', hint: 'Catering orders' },
  dinein:   { name: 'Dine-in',   cls: 'dinein', logo: 'D', hint: 'POS screenshot' },
};

function findMerchant(mid) { return state.merchants.find((x) => x.id === mid); }

function openCapture(mid, mode, offset = 0, from = 'checklist') {
  const m = findMerchant(mid);
  state.current = { m, mode, offset, from };
  const store = recordsFor(offset);
  if (!store[mid]) store[mid] = { status: 'Operated', channels: {}, expanded: {} };

  $('cap-merchant').textContent = m.brand;
  $('cap-sub').textContent = `${state.site.id} · ${m.kitchen} · ${m.type}`
    + (mode === 'baseline' ? ' · ☀️ morning baseline' : '')
    + (offset ? ` · ✏️ editing ${dayLabel(offset)}` : '');

  renderStatusChips();
  renderBaselineBanner();
  renderChannelCards();
  updateSaveBtn();
  show('view-capture');
}
$('btn-capture-back').onclick = () => {
  if (state.current && state.current.from === 'review') { renderReview(); show('view-review'); }
  else { renderChecklist(); show('view-checklist'); }
};

function renderStatusChips() {
  const { m, mode } = state.current;
  const rec = curRec();
  if (mode === 'baseline') { $('status-row').classList.add('hidden'); return; }
  $('status-row').classList.remove('hidden');
  const opts = ['Operated', 'No Sales', 'Not operated', 'Locked'];
  $('status-chips').innerHTML = opts.map((o) =>
    `<button class="chip ${rec.status === o ? 'active' + (o === 'Operated' ? ' good' : '') : ''}" data-s="${o}">${o}</button>`).join('');
  $('status-chips').querySelectorAll('.chip').forEach((b) => b.onclick = () => {
    rec.status = b.dataset.s;
    renderStatusChips();
    renderChannelCards();
    updateSaveBtn();
  });
}

function renderBaselineBanner() {
  const { m, mode, offset } = state.current;
  const el = $('baseline-banner');
  if (offset) { el.classList.add('hidden'); return; }   // past-day edits: plain edit, no baseline logic
  if (mode === 'baseline') {
    el.innerHTML = `☀️ <b>${esc(m.brand)} runs 24 hours.</b> Shoot each screen now — stored as today's 10 am baseline and deducted automatically tonight. Nothing is billed from this shot.`;
    el.classList.remove('hidden');
  } else if (m.overnight) {
    const has = baselineDone(m);
    el.innerHTML = has
      ? `🌙 24-hr merchant — tonight's reading auto-deducts this morning's baseline. Both photos are kept as evidence.`
      : `⚠️ <b>No morning baseline today.</b> Tonight's reading cannot auto-deduct — this record will be flagged for supervisor review, or go back and add the baseline first.`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function channelValue(ch) {
  const { m, mode } = state.current;
  return mode === 'baseline' ? state.baselines[`${m.id}:${ch}`] : curRec().channels[ch];
}
function setChannelValue(ch, val) {
  const { m, mode } = state.current;
  if (mode === 'baseline') state.baselines[`${m.id}:${ch}`] = val;
  else curRec().channels[ch] = val;
}

function renderChannelCards() {
  const { m, mode } = state.current;
  const rec = curRec();
  const wrap = $('channel-cards');
  if (mode === 'evening' && rec.status !== 'Operated') {
    wrap.innerHTML = `<div class="baseline-banner" style="margin-top:16px">No sales fields needed for “${esc(rec.status)}”. Just confirm below — date, site, merchant and your name are recorded automatically.</div>`;
    return;
  }
  const chans = mode === 'baseline' ? CORE : m.channels;
  wrap.innerHTML = chans.map((ch) => {
    const meta = CH_META[ch];
    const val = channelValue(ch) || {};
    const optional = OPTIONAL.includes(ch) && mode !== 'baseline';
    const collapsed = optional && !rec.expanded[ch] && !channelHasData(val);
    if (collapsed) {
      return `<button class="channel-collapsed" data-expand="${ch}">
        <div class="ch-logo ${meta.cls}">${meta.logo}</div>
        <span>${meta.name} — none today</span><b>＋ Add</b>
      </button>`;
    }
    const base = mode === 'evening' && !state.current.offset && m.overnight && CORE.includes(ch) ? state.baselines[`${m.id}:${ch}`] : null;
    return `<div class="channel-card" id="card-${ch}">
      <div class="ch-head">
        <div class="ch-logo ${meta.cls}">${meta.logo}</div>
        <div class="ch-name">${meta.name}</div>
        <div class="ch-hint">${m.aigens && ch === 'others' ? 'AIGENS line on X-Reading' : meta.hint}</div>
      </div>
      <div class="ch-body">${channelBodyHTML(ch, val, base, mode)}</div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-expand]').forEach((b) => b.onclick = () => {
    rec.expanded[b.dataset.expand] = true;
    renderChannelCards();
    updateSaveBtn();
  });
  chans.forEach((ch) => { const card = document.getElementById(`card-${ch}`); if (card) wireChannel(card, ch); });
}

function channelHasData(val) {
  return val && (val.photoUrl || val.finalOrders !== undefined || val.finalGmv !== undefined || val.orders !== undefined);
}

function channelBodyHTML(ch, val, base, mode) {
  const o = val.finalOrders ?? val.orders;
  const g = val.finalGmv ?? val.gmv;
  const fields = `<div class="reading-fields full">
      <div class="rf ${val.editedOrders ? 'edited' : ''}"><label>Orders</label><input inputmode="numeric" placeholder="0" value="${o !== undefined ? Number(o) : ''}" data-f="orders"></div>
      <div class="rf ${val.editedGmv ? 'edited' : ''}"><label>Sales (S$)</label><input inputmode="decimal" placeholder="0.00" value="${g !== undefined ? Number(g).toFixed(2) : ''}" data-f="gmv"></div>
    </div>`;
  const photo = val.photoUrl
    ? `<div class="photo-row"><img class="thumb tap" src="${val.photoUrl}" alt="evidence" title="Tap to pick numbers from the photo">
        <div class="ai-note-col">
          ${val.conf === 'high' ? '<span class="ok">✓ AI read · high confidence</span>' : '<span class="warn">⚠ AI read · please double-check</span>'}
          <span class="screen-note">${esc(val.screen || '')}</span>
          <span class="tap-hint">👆 Tap photo to pick a different number</span>
        </div>
        <button class="retake">Retake</button></div>`
    : `<div class="photo-slot"><span class="cam">📷</span> Snap or upload ${esc(CH_META[ch].name)} screen</div>
       <div class="no-photo-note">You can type the numbers first — but a photo is required as evidence before saving.</div>`;
  let extra = '';
  if (mode === 'baseline' && channelHasData(val)) {
    extra = `<div class="deduct-box">☀️ Stored as today's baseline — deducted tonight. Not billed.</div>`;
  } else if (base && channelHasData(val)) {
    const bo = (o ?? 0) - base.orders;
    const bg = (g ?? 0) - base.gmv;
    extra = `<div class="deduct-box">☀️ Baseline this morning: ${base.orders} orders · ${money(base.gmv)}<br>
      🧾 <b>Billable 10 am–10 pm: ${bo} orders · ${money(bg)}</b></div>`;
  }
  const mism = val.mismatch ? `<div class="mismatch">⚠ ${esc(val.mismatch)}</div>` : '';
  return fields + mism + extra + photo;
}

function wireChannel(card, ch) {
  card.querySelectorAll('input').forEach((inp) => inp.oninput = () => {
    let val = channelValue(ch);
    if (!val) { val = {}; setChannelValue(ch, val); }
    if (inp.dataset.f === 'orders') { val.finalOrders = inp.value === '' ? undefined : Number(inp.value); val.editedOrders = true; }
    else { val.finalGmv = inp.value === '' ? undefined : Number(inp.value); val.editedGmv = true; }
    val.edited = true;
    inp.closest('.rf').classList.add('edited');
    updateSaveBtn();
  });
  const slot = card.querySelector('.photo-slot');
  if (slot) slot.onclick = () => openPicker(ch);
  const rt = card.querySelector('.retake');
  if (rt) rt.onclick = () => openPicker(ch);
  const img = card.querySelector('img.thumb');
  if (img) img.onclick = () => openViewer(ch);
}

/* Photo picked → AI extraction. With CONFIG.apiBase set this calls the real
   Claude engine; on ANY backend failure the fields stay manual — a billing tool
   must never silently fill in made-up numbers. Without apiBase: demo mock. */
function runExtraction(ch, photoUrl) {
  const { m, mode } = state.current;
  const card = document.getElementById(`card-${ch}`);
  const body = card.querySelector('.ch-body');
  body.innerHTML = `<div class="scanning"><div class="spinner"></div> Reading screen…</div>`;

  const finish = (ai) => {
    const prev = channelValue(ch) || {};
    const val = { ...prev, ...ai, photoUrl, aiOrders: ai.orders, aiGmv: ai.gmv,
      finalOrders: ai.orders, finalGmv: ai.gmv, editedOrders: false, editedGmv: false };
    setChannelValue(ch, val);
    if (mode === 'baseline' && ai.orders !== undefined) {
      toast(`${CH_META[ch].name} baseline — ${ai.orders} orders · ${money(ai.gmv)}`);
    }
    renderChannelCards();
    updateSaveBtn();
  };
  const fail = (msg) => {
    const prev = channelValue(ch) || {};
    setChannelValue(ch, { ...prev, photoUrl, conf: 'low',
      screen: '', mismatch: `${msg} — type the numbers manually, the photo is kept as evidence.` });
    renderChannelCards();
    updateSaveBtn();
  };

  if (!CONFIG.apiBase) {
    setTimeout(() => finish(mockExtract(ch, mode === 'baseline' ? 'baseline' : 'closing', m, photoUrl)), 1000);
    return;
  }

  fetch(`${CONFIG.apiBase}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: photoUrl, channel: ch,
      mode: mode === 'baseline' ? 'baseline' : 'closing',
      brand: m.brand, aigens: !!m.aigens }),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      return r.json();
    })
    .then((d) => {
      const notes = [];
      if (d.wrong_channel) notes.push(`⚠ This looks like a ${d.platform} screen, not ${CH_META[ch].name} — check the photo`);
      if (d.confidence !== 'high' && d.notes) notes.push(d.notes);
      finish({
        orders: d.orders ?? undefined, gmv: d.gmv ?? undefined,
        conf: d.confidence, screen: d.screen_summary,
        mismatch: notes.join(' · ') || undefined,
        candidates: (d.candidates || []).map((c) => ({ label: c.label, value: c.value, kind: c.kind, box: c.box })),
        zero: d.zero_sales,
      });
    })
    .catch((e) => fail(`AI reading failed (${e.message})`));
}

/* ---------- photo viewer: tap-to-correct ---------- */
/* Candidate numbers are overlaid on the photo; tapping one assigns it to a field
   and logs the correction — this is the data the AI learns from over time. */
function openViewer(ch) {
  const val = channelValue(ch);
  if (!val || !val.photoUrl) return;
  state.viewer = { ch, cands: (val.candidates || [
    { label: 'Sales', value: val.aiGmv, kind: 'gmv' },
    { label: 'Orders', value: val.aiOrders, kind: 'orders' },
  ]).filter((c) => c.value !== undefined && c.value !== null).slice(0, 8) };
  const img = $('viewer-img');
  img.onload = placeViewerBoxes;
  img.src = val.photoUrl;
  $('viewer-choice').classList.add('hidden');
  $('viewer-overlay').classList.remove('hidden');
  if (img.complete) placeViewerBoxes();
}

/* Position candidate boxes. Real backend candidates carry a bbox in % of the
   image; the image sits letterboxed (object-fit: contain) inside the stage, so
   convert image-% → stage pixels. Candidates without a box get preset spots. */
function placeViewerBoxes() {
  const img = $('viewer-img');
  const stage = $('viewer-stage');
  const cands = (state.viewer && state.viewer.cands) || [];
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const scale = Math.min(sw / img.naturalWidth, sh / img.naturalHeight) || 1;
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  const ox = (sw - dw) / 2, oy = (sh - dh) / 2;
  const PRESET = [[12, 18], [55, 30], [18, 46], [58, 60], [25, 72], [60, 80], [15, 86], [55, 12]];
  $('viewer-boxes').innerHTML = cands.map((c, i) => {
    let style;
    if (c.box) {
      const left = ox + (c.box.x / 100) * dw;
      const top = oy + (c.box.y / 100) * dh;
      style = `left:${left.toFixed(0)}px;top:${top.toFixed(0)}px`;
    } else {
      style = `left:${PRESET[i % PRESET.length][0]}%;top:${PRESET[i % PRESET.length][1]}%`;
    }
    return `<button class="vbox" style="${style}" data-i="${i}">
      <small>${esc(c.label)}</small>${c.kind === 'gmv' ? money(c.value) : esc(String(c.value))}</button>`;
  }).join('');
  $('viewer-boxes').querySelectorAll('.vbox').forEach((b) => b.onclick = () => {
    const c = state.viewer.cands[+b.dataset.i];
    state.viewer.candidate = c;
    $('vc-value').textContent = `${c.label}: ${c.kind === 'gmv' ? money(c.value) : c.value}`;
    $('viewer-choice').classList.remove('hidden');
  });
}
window.addEventListener('resize', () => {
  if (!$('viewer-overlay').classList.contains('hidden')) placeViewerBoxes();
});
function applyCandidate(kind) {
  const { ch, candidate } = state.viewer || {};
  if (!candidate) return;
  const val = channelValue(ch);
  if (kind === 'orders') { val.finalOrders = Math.round(candidate.value); val.editedOrders = true; }
  else { val.finalGmv = candidate.value; val.editedGmv = true; }
  val.edited = true;
  (val.corrections = val.corrections || []).push({ picked: candidate.label, value: candidate.value, as: kind });
  closeViewer();
  renderChannelCards();
  updateSaveBtn();
  toast('Updated from photo ✓ — AI will learn from this');
}
$('vc-orders').onclick = () => applyCandidate('orders');
$('vc-gmv').onclick = () => applyCandidate('gmv');
$('vc-cancel').onclick = () => $('viewer-choice').classList.add('hidden');
$('viewer-close').onclick = closeViewer;
function closeViewer() { $('viewer-overlay').classList.add('hidden'); state.viewer = null; }

/* ---------- save ---------- */
function coreReady() {
  const { m, mode } = state.current;
  if (mode === 'baseline') return baselineDone(m);
  const rec = curRec();
  if (rec.status !== 'Operated') return true;
  return CORE.every((ch) => {
    const v = rec.channels[ch];
    return v && v.finalOrders !== undefined && v.finalGmv !== undefined;
  });
}
function missingPhotos() {
  const rec = curRec();
  return CORE.filter((ch) => rec.channels[ch] && !rec.channels[ch].photoUrl);
}
function updateSaveBtn() {
  const { m, mode, offset } = state.current;
  const btn = $('btn-save');
  if (mode === 'baseline') {
    const done = baselineDone(m);
    btn.disabled = !done;
    btn.textContent = done ? 'Done — back to list' : 'Shoot all screens to finish';
    return;
  }
  const rec = curRec();
  btn.disabled = !coreReady();
  btn.textContent = offset ? `Save changes for ${dayLabel(offset)}`
    : rec.status === 'Operated' ? 'Confirm & save' : `Save as “${rec.status}”`;
}
$('btn-save').onclick = () => {
  const { m, mode, offset, from } = state.current;
  if (mode === 'baseline') {
    toast(`${m.brand} baseline done ✓`);
  } else {
    const rec = curRec();
    const noPhoto = rec.status === 'Operated' ? missingPhotos() : [];
    rec.saved = true;
    if (offset) {
      /* production: writes back to the GMV Raw Data row with an audit trail */
      rec.amendedBy = state.staff.name;
      toast(`${m.brand} updated for ${dayLabel(offset)} ✓ — audit logged`);
    } else {
      rec.staffName = state.staff.name;
      if (noPhoto.length) toast(`Saved — flagged: no photo for ${noPhoto.map((c) => CH_META[c].name).join(', ')}`);
      else toast(`${m.brand} saved ✓`);
    }
  }
  if (from === 'review') { renderReview(); show('view-review'); }
  else { renderChecklist(); show('view-checklist'); }
};

/* ---------- add new brand (two pages) ---------- */
const ab = { customer: null };
function openAddBrand() {
  ab.customer = null;
  $('ab-search').value = '';
  $('ab-brand').value = '';
  $('ab-overnight').checked = false;
  abPage(1);
  $('ab-sub').textContent = `${state.site.name} · creates a new SFDC ID Map record`;
  renderCustomers('');
  show('view-addbrand');
}
function abPage(n) {
  $('ab-step1').classList.toggle('hidden', n !== 1);
  $('ab-step2').classList.toggle('hidden', n !== 2);
  window.scrollTo(0, 0);
}
$('btn-addbrand-back').onclick = () => { renderChecklist(); show('view-checklist'); };
$('ab-back1').onclick = () => abPage(1);

/* Kitchen sort: K1…K99 in numeric order, CR last. */
function kitchenOrder(k) {
  if (k === 'CR') return 10000;
  const n = parseInt(k.slice(1), 10);
  return Number.isNaN(n) ? 9999 : n;
}
function renderCustomers(q) {
  /* Page 1: this site's contracted kitchens, sorted K1→K99 then CR. */
  const list = DATA.customers
    .filter((c) => c.site === state.site.id)
    .filter((c) => c.company.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => kitchenOrder(a.kitchen) - kitchenOrder(b.kitchen) || a.company.localeCompare(b.company));
  $('ab-customers').innerHTML = list.map((c) =>
    `<button class="staff-btn" data-opp="${esc(c.oppId)}">
      <span class="avatar kav">${esc(c.kitchen)}</span>
      <span class="cname">${esc(c.company)}</span>
    </button>`).join('') || '<p class="ab-note">No contracted customers found for this site.</p>';
  $('ab-customers').querySelectorAll('.staff-btn').forEach((b) => b.onclick = () => {
    ab.customer = DATA.customers.find((c) => c.oppId === b.dataset.opp);
    $('ab-picked').innerHTML = `<span class="avatar kav">${esc(ab.customer.kitchen)}</span>
      <span><div class="cname">${esc(ab.customer.company)}</div>
      <div class="customer-meta">${esc(state.site.name)} · SFDC ID will be copied to the new row</div></span>`;
    abPage(2);
    updateCreateBtn();
  });
}
$('ab-search').oninput = () => renderCustomers($('ab-search').value);
$('ab-brand').oninput = updateCreateBtn;
function updateCreateBtn() {
  $('ab-create').disabled = !(ab.customer && $('ab-brand').value.trim().length >= 2);
}
$('ab-create').onclick = () => {
  const brand = $('ab-brand').value.trim();
  const overnight = $('ab-overnight').checked;
  /* production: POST /api/merchants → appends SFDC ID Map row:
     B Facility / C Kitchen Number / D Brand / E SFDC ID (the picked Opportunity ID)
     auto-filled; F–H copy the formulas from the row above; I Overnight = checkbox. */
  DATA.merchants.push({
    site: state.site.id, kitchen: ab.customer.kitchen, brand,
    sfdcId: ab.customer.oppId,
    type: ab.customer.kitchen === 'CR' ? 'Cloud Retail' : 'Kitchen',
    overnight: overnight || undefined,
    aigens: brand.toLowerCase().includes('wingstop') || undefined,
  });
  state.merchants = siteMerchants(state.site.id);
  toast(`${brand} added ✓${overnight ? ' · marked outside-hours (morning baseline required)' : ''}`);
  renderChecklist();
  show('view-checklist');
};

/* ---------- boot ---------- */
if (CONFIG.apiBase) {
  const b = $('mode-badge');
  b.textContent = 'LIVE AI · readings by Claude — always double-check against the device screen';
  b.style.background = 'var(--green-bg)';
  b.style.color = 'var(--green)';
}
renderSites();
renderPinPad();
show('view-login');
