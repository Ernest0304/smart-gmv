/* Smart GMV — flow logic.
   Catalog (sites/merchants/customers) = DATA from data.js, generated from the real Sheet.
   Saves go to POST /api/records (43+8-col GMV Raw Data row + photos on Drive);
   readings come from POST /api/extract. CONFIG.apiBase '' = demo mode (simulated).
   All dynamic strings pass through esc(). */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Live catalog (sites / merchants / staff / customers), loaded from
   /api/catalog at boot. The sheet is the single source of truth — the app
   ships with no roster or merchant data. */
let DATA = null;

async function loadCatalog() {
  $('site-grid').innerHTML = '<p class="ab-note"><span class="spinner sm"></span> Loading sites…</p>';
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/catalog`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    DATA = {
      sites: raw.sites,
      staff: raw.staff,
      customers: raw.customers,
      merchants: raw.merchants.map((m) => ({
        site: m.facility, kitchen: m.kitchen, brand: m.brand, sfdcId: m.sfdcId,
        overnight: m.overnight || undefined, disabled: m.disabled || undefined,
        aigens: m.aigens || undefined,
        type: m.kitchen === 'CR' ? 'Cloud Retail' : 'Kitchen',
      })),
    };
    renderSites();
  } catch (e) {
    $('site-grid').innerHTML = `<p class="ab-note">⚠ Could not load the site list (${esc(e.message)}).</p>
      <button class="btn-primary" id="btn-catalog-retry" style="margin-top:10px">Try again</button>`;
    $('btn-catalog-retry').onclick = loadCatalog;
  }
}

const state = {
  site: null, staff: null, pin: '',
  pinMode: 'verify',                // verify | create | confirm (first-login PIN claim)
  pinFirst: '',                     // first entry while confirming a new PIN
  salesDate: null,                  // business date, frozen at login (before 06:00 = yesterday)
  merchants: [],                    // merchants of the selected site
  records: {},                      // merchantId -> record (today)
  history: {},                      // dayOffset -> { merchantId -> record } (past days, editable)
  baselines: {},                    // `${mid}:${ch}` -> baseline reading
  baselineMeta: {},                 // merchantId -> { recordId, confirmedAt, saved, inFlight, error }
  hydrateError: null,               // set when today's saved records could not be loaded
  current: null,                    // { m, mode, offset, from }
  viewer: null,                     // { ch, candidate }
};

/* ---------- record identity ----------
   The record id is a pure function of merchant + business date, NOT a random
   UUID: after a phone reload (or on a second device) the same merchant-day
   maps to the same id, so a re-save becomes an in-place update on the server
   instead of a duplicate billing row. */
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}
function recordIdFor(m, type, dateStr) {
  const slug = (m.brand.toLowerCase().replace(/[^a-z0-9]/g, '') || 'x').slice(0, 12);
  const hash = djb2(`${m.sfdcId}|${m.brand}|${m.kitchen}`).toString(36).padStart(4, '0').slice(0, 4);
  const ymd = (dateStr || state.salesDate).replace(/-/g, '');
  return `${m.site}-${m.kitchen}-${slug}-${hash}-${ymd}-${type === 'baseline' ? 'B' : 'C'}`;
}
function businessDate() {
  // Before 06:00 a round still belongs to yesterday (post-midnight closings).
  const d = new Date(Date.now() - 6 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowStamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* Record store for a given day. Today = live session records; past days are
   hydrated from the GMV Raw Data tab by loadHistory() and stay editable —
   edits POST back to the same Record ID with a server-side audit trail. */
function recordsFor(offset) {
  if (!offset) return state.records;
  return state.history[offset] || (state.history[offset] = {});
}
function curRec() { return recordsFor(state.current.offset)[state.current.m.id]; }
/* All day math anchors on the BUSINESS date (state.salesDate), so at 00:30 the
   "Today" chip and the server rows still agree on which day this round is. */
function dateForOffset(offset) {
  const [y, mo, d] = state.salesDate.split('-').map(Number);
  const dt = new Date(y, mo - 1, d - offset);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function offsetForDate(dateStr) {
  const p = (s) => { const [y, mo, d] = s.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
  return Math.round((p(state.salesDate) - p(dateStr)) / 86400000);
}
function dayLabel(offset) {
  if (!offset) return 'Today';
  const [y, mo, d] = dateForOffset(offset).split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' });
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
const AI_CHANNELS = ['grab', 'fp'];               // only these call the AI engine (cost control)

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
  reader.onload = () => downscale(reader.result, 1600, 0.85).then((jpeg) => runExtraction(ch, jpeg));
  reader.readAsDataURL(file);
};
function openPicker(ch) { pendingChannel = ch; fileInput.click(); }

/* Pending-pickup orders: multi-select picker so staff can burst-shoot all the
   locker orders in the native camera, then add them in one go. */
const extrasInput = document.createElement('input');
extrasInput.type = 'file';
extrasInput.accept = 'image/*';
extrasInput.multiple = true;
extrasInput.style.display = 'none';
document.body.appendChild(extrasInput);
let pendingExtrasChannel = null;
extrasInput.onchange = () => {
  const files = [...(extrasInput.files || [])];
  const ch = pendingExtrasChannel;
  extrasInput.value = '';
  if (!files.length || !ch) return;
  const val = channelValue(ch) || {};
  if (!channelValue(ch)) setChannelValue(ch, val);
  val.extras = val.extras || [];
  const room = 12 - val.extras.length;
  if (room <= 0) { toast('Limit reached — up to 12 pending orders per channel'); return; }
  if (files.length > room) toast(`Only ${room} more can be added (12 max) — first ${room} taken`);
  files.slice(0, room).forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => downscale(reader.result, 1280, 0.8).then((jpeg) => {
      // order-detail pages are large-font text: 1280px keeps digits crisp at half the bytes
      const entry = { photoUrl: jpeg, photoDirty: true, pendingAI: true, gen: val.gen || 0 };
      val.extras.push(entry);
      if (viewingCtx(state.current)) { renderChannelCards(); updateSaveBtn(); }
      runExtraExtraction({ ...state.current }, ch, entry);
    });
    reader.readAsDataURL(file);
  });
};
function openExtrasPicker(ch) { pendingExtrasChannel = ch; extrasInput.click(); }

/* Re-encode to JPEG ≤maxPx long edge: fixes iPhone HEIC uploads and cuts
   upload size + AI token cost without losing digit legibility. */
function downscale(dataUrl, maxPx = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
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
  const home = DATA.staff.filter((p) => p.home === state.site.id);
  const others = DATA.staff.filter((p) => p.home !== state.site.id);
  const btn = (p) => `<button class="staff-btn" data-id="${esc(p.id)}"><span class="avatar">${esc(p.name[0])}</span>${esc(p.name)}
      ${p.partTimer ? '<span class="tag pt" style="margin-left:auto">PART-TIMER</span>' : (p.home && p.home !== state.site.id ? `<span class="tag pt" style="margin-left:auto">${esc(p.home)}</span>` : '')}</button>`;
  $('staff-list').innerHTML =
    (home.length ? `<div class="roster-group">${esc(state.site.name)} team</div>` + home.map(btn).join('') : '') +
    `<div class="roster-group">Helping out today / part-timers</div>` + others.map(btn).join('') +
    `<button class="staff-btn" id="btn-register"><span class="avatar">➕</span>I'm not on the list</button>`;
  $('staff-list').querySelectorAll('.staff-btn[data-id]').forEach((b) => b.onclick = () => {
    proceedToPin(DATA.staff.find((p) => p.id === b.dataset.id));
  });
  $('btn-register').onclick = openRegister;
}

/* Route a chosen roster member to the right PIN screen: people whose Staff-tab
   PIN cell is still blank create their own on first login (no shared default,
   no PINs handed around) — everyone else just enters theirs. */
function proceedToPin(staff) {
  state.staff = staff;
  state.pin = '';
  state.pinFirst = '';
  state.pinMode = staff.needsPin ? 'create' : 'verify';
  paintPin();
  paintPinTitle();
  $('pin-error').classList.add('hidden');
  loginStep('pin');
}
function paintPinTitle() {
  const name = state.staff ? state.staff.name : '';
  const t = $('pin-title'), s = $('pin-sub');
  if (state.pinMode === 'create') {
    t.textContent = `Hi ${name} — create your 4-digit PIN`;
    s.textContent = "It logs you in every day from now on. Don't share it.";
    s.classList.remove('hidden');
  } else if (state.pinMode === 'confirm') {
    t.textContent = 'Type it again to confirm';
    s.classList.add('hidden');
  } else {
    t.textContent = `Hi ${name}, enter your PIN`;
    s.classList.add('hidden');
  }
}
function loginStep(step) {
  ['site', 'staff', 'register', 'pin'].forEach((s) => $('login-step-' + s).classList.toggle('hidden', s !== step));
}

/* ---------- self-registration (cross-site helpers / new part-timers) ---------- */
function openRegister() {
  $('reg-name').value = '';
  $('reg-pin').value = '';
  $('reg-pin2').value = '';
  $('reg-error').classList.add('hidden');
  $('reg-pin-note').classList.add('hidden');
  $('reg-home').innerHTML = `<option value="${esc(state.site.id)}">${esc(state.site.name)} (this site)</option>`
    + DATA.sites.filter((s) => s.id !== state.site.id)
        .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')
    + '<option value="">No fixed site</option>';
  updateRegBtn();
  loginStep('register');
}
$('reg-name').oninput = updateRegBtn;
$('reg-pin').oninput = updateRegBtn;
$('reg-pin2').oninput = updateRegBtn;
function updateRegBtn() {
  const p1 = $('reg-pin').value, p2 = $('reg-pin2').value;
  const pinOk = /^\d{4}$/.test(p1) && p1 === p2;
  // only nag about a mismatch once both fields are complete
  $('reg-pin-note').classList.toggle('hidden', !(p1.length === 4 && p2.length === 4 && p1 !== p2));
  $('reg-submit').disabled = $('reg-name').value.trim().length < 2 || !pinOk;
}
async function submitRegistration(allowDuplicate) {
  const name = $('reg-name').value.trim();
  $('reg-submit').disabled = true;
  $('reg-submit').textContent = 'Registering…';
  $('reg-error').classList.add('hidden');
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/staff`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, homeSite: $('reg-home').value, pin: $('reg-pin').value,
        site: state.site.id, allowDuplicate: !!allowDuplicate }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409 && d.existing) {
      $('dup-detail').textContent = `“${d.existing.name}” is already on the staff list`
        + (d.existing.home ? ` (home site ${d.existing.home})` : '') + '.';
      $('dup-me-label').textContent = `That's me — continue as ${d.existing.name}`;
      $('dup-new-label').textContent = `I'm a different ${name} — register anyway`;
      $('dup-overlay').classList.remove('hidden');
      $('dup-me').onclick = () => {
        $('dup-overlay').classList.add('hidden');
        proceedToPin(DATA.staff.find((p) => p.id === d.existing.id)
          || { id: d.existing.id, name: d.existing.name, home: d.existing.home,
               needsPin: !!d.existing.needsPin });
      };
      $('dup-new').onclick = () => { $('dup-overlay').classList.add('hidden'); submitRegistration(true); };
      $('dup-cancel').onclick = () => $('dup-overlay').classList.add('hidden');
      return;
    }
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    // PIN was chosen in the form and is already on the server — straight in.
    DATA.staff.push(d.staff);
    state.staff = d.staff;
    toast(`Welcome, ${d.staff.name} — you're on the list now`);
    enterApp();
  } catch (e) {
    $('reg-error').textContent = `Registration failed: ${e.message}`;
    $('reg-error').classList.remove('hidden');
  } finally {
    $('reg-submit').disabled = false;
    $('reg-submit').textContent = 'Register & continue';
  }
}
$('reg-submit').onclick = () => submitRegistration(false);
function paintPin() {
  [...$('pin-dots').children].forEach((d, i) => d.classList.toggle('filled', i < state.pin.length));
}
let pinChecking = false;
function renderPinPad() {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  $('pin-pad').innerHTML = keys.map((k) => k === '' ? '<span></span>' : `<button class="pin-key" data-k="${k}">${k}</button>`).join('');
  $('pin-pad').querySelectorAll('.pin-key').forEach((b) => b.onclick = () => {
    if (pinChecking) return;
    const k = b.dataset.k;
    $('pin-error').classList.add('hidden');
    if (k === '⌫') state.pin = state.pin.slice(0, -1);
    else if (state.pin.length < 4) state.pin += k;
    paintPin();
    if (state.pin.length !== 4) return;
    if (state.pinMode === 'create') {
      state.pinFirst = state.pin;
      state.pin = '';
      state.pinMode = 'confirm';
      setTimeout(() => { paintPin(); paintPinTitle(); }, 180);
    } else if (state.pinMode === 'confirm') {
      if (state.pin === state.pinFirst) claimPin();
      else {
        state.pin = '';
        state.pinFirst = '';
        state.pinMode = 'create';
        setTimeout(() => {
          paintPin();
          paintPinTitle();
          $('pin-error').textContent = "The PINs didn't match — start again";
          $('pin-error').classList.remove('hidden');
        }, 180);
      }
    } else {
      verifyPin();
    }
  });
}
const pinFail = (msg) => {
  state.pin = '';
  setTimeout(() => {
    paintPin();
    $('pin-error').textContent = msg;
    $('pin-error').classList.remove('hidden');
  }, 180);
};
/* First-login claim: writes the chosen PIN to this person's blank Staff-tab
   cell. First claim wins — a second device gets a clear 409. */
async function claimPin() {
  pinChecking = true;
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/staff/pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId: state.staff.id, pin: state.pin }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409) {
      state.pinMode = 'verify';
      state.staff.needsPin = false;
      paintPinTitle();
      pinFail('A PIN was already set for this name — enter it, or ask the supervisor to reset it');
      return;
    }
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    state.staff = { ...d.staff, needsPin: false };
    const src = DATA.staff.find((p) => p.id === d.staff.id);
    if (src) src.needsPin = false;
    toast('PIN set ✓ — use it to log in from now on');
    enterApp();
  } catch (e) {
    state.pinMode = 'create';
    state.pinFirst = '';
    paintPinTitle();
    pinFail(`Could not save the PIN (${e.message}) — try again`);
  } finally {
    pinChecking = false;
  }
}
/* PINs are checked by the server against the Staff tab. The app never sees
   anyone's stored PIN; a blank cell routes to the create-PIN flow instead. */
async function verifyPin() {
  pinChecking = true;
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/staff/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId: state.staff.id, pin: state.pin }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 403 && d.detail === 'pin_not_set') {
      // roster refreshed on another device since our catalog load
      state.staff.needsPin = true;
      state.pin = '';
      state.pinFirst = '';
      state.pinMode = 'create';
      paintPin();
      paintPinTitle();
      toast('No PIN yet for this name — create yours now');
      return;
    }
    if (r.status === 403) { pinFail('Wrong PIN — try again'); return; }
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    state.staff = d.staff;
    enterApp();
  } catch (e) {
    pinFail(`Could not verify (${e.message}) — try again`);
  } finally {
    pinChecking = false;
  }
}
document.querySelectorAll('.back-link').forEach((b) => b.onclick = () => loginStep(b.dataset.back));

/* ---------- checklist ---------- */
function enterApp() {
  state.merchants = siteMerchants(state.site.id);
  state.records = {};
  state.baselines = {};
  state.baselineMeta = {};
  state.history = {};
  rv.loaded = false;
  rv.unmatched = {};
  state.hydrateError = null;
  state.salesDate = businessDate();
  $('hdr-site').textContent = `${state.site.name} · ${state.site.id}`;
  $('hdr-date').textContent = new Date().toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' });
  $('hdr-staff').textContent = state.staff.name;
  renderChecklist();
  show('view-checklist');
  hydrateToday();
}

const numOrU = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
const photoIdOf = (link) => (String(link || '').match(/\/d\/([A-Za-z0-9_-]{20,})/) || [])[1];

/* One server row (GET /api/records[…]) -> the local editable record shape.
   photoId feeds the /api/photo proxy so Drive evidence renders on phones. */
function serverRecToLocal(sr) {
  const rec = { status: sr.status || 'Operated', saved: true, serverSaved: true,
    recordId: sr.recordId, staffName: (sr.staff || '').replace(/\s*\([^)]*\)$/, ''),
    auditEdited: !!sr.edited, billingFlag: sr.billingFlag || '',
    salesDate: sr.salesDate, channels: {}, expanded: {} };
  Object.entries(sr.channels).forEach(([ch, c]) => {
    rec.channels[ch] = {
      aiOrders: numOrU(c.aiOrders), aiGmv: numOrU(c.aiGmv),
      finalOrders: numOrU(c.summaryOrders), finalGmv: numOrU(c.summaryGmv),
      photoLink: c.photoLink || undefined,
      photoId: c.photoId || photoIdOf(c.photoLink),
      extras: (c.extras || []).map((e) => ({ gmv: e.gmv, aiGmv: e.aiGmv ?? undefined,
        conf: e.conf ?? undefined, orderRef: e.orderRef || '', photoLink: e.photo,
        photoId: e.photoId || photoIdOf(e.photo) })),
    };
  });
  return rec;
}

/* Pull today's already-saved rows from the sheet so a reloaded phone (or a
   second device) sees ✓ instead of re-capturing — re-captures would still be
   in-place updates (deterministic ids), but staff shouldn't redo the round. */
async function hydrateToday() {
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/records/today?site=${state.site.id}&date=${state.salesDate}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { records } = await r.json();
    records.forEach((sr) => {
      const m = state.merchants.find((x) => x.kitchen === sr.kitchen && x.brand === sr.brand);
      if (!m) return;
      if (sr.recordType === 'baseline') {
        state.baselineMeta[m.id] = { recordId: sr.recordId, saved: true };
        Object.entries(sr.channels).forEach(([ch, c]) => {
          state.baselines[`${m.id}:${ch}`] = {
            finalOrders: numOrU(c.orders), finalGmv: numOrU(c.gmv),
            photoLink: c.photoLink, photoId: c.photoId || photoIdOf(c.photoLink) };
        });
      } else {
        state.records[m.id] = serverRecToLocal(sr);
      }
    });
    renderChecklist();
  } catch (e) {
    state.hydrateError = e.message;
    renderChecklist();
    toast(`⚠ Could not check the server for today's saved records (${e.message})`);
  }
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
/* "Baseline done" = the SERVER acknowledged the row, nothing less. A shot
   sitting in phone memory is not evidence yet. */
function baselineDone(m) { return !!state.baselineMeta[m.id]?.saved; }
function baselineReading(m) {
  return CORE.some((ch) => state.baselines[`${m.id}:${ch}`]?.pendingAI);
}
function baselineHasShots(m) {
  return CORE.some((ch) => channelHasData(state.baselines[`${m.id}:${ch}`]));
}
/* Confirmed by staff but not (yet) on the server — the record a licensee would
   never get billed for. These must stay loudly visible until saved. */
function saveFailed(rec) { return !!(rec && rec.saveError && !rec.inFlight); }
function unsavedRecords() {
  const list = [];
  state.merchants.filter((m) => !m.disabled).forEach((m) => {
    const r = state.records[m.id];
    if (r && (saveFailed(r) || r.inFlight)) list.push({ m, kind: 'record' });
    const bm = state.baselineMeta[m.id];
    if (bm && !bm.saved && (bm.error || bm.inFlight)) list.push({ m, kind: 'baseline' });
  });
  return list;
}
function renderChecklist() {
  /* Disabled brands are hidden from capture but stay in state.merchants,
     so Review (history) and Manage brands still see them. */
  const all = state.merchants.filter((m) => !m.disabled);
  const overnight = all.filter((m) => m.overnight);
  const doneCount = all.filter(merchantDone).length;

  const failed = all.filter((m) => saveFailed(state.records[m.id])
    || state.baselineMeta[m.id]?.error).length;
  $('prog-done').textContent = doneCount;
  $('prog-total').textContent = all.length;
  const frac = all.length ? doneCount / all.length : 0;
  $('ring-fg').style.strokeDashoffset = 194.8 * (1 - frac);
  $('prog-sub').textContent =
    failed ? `❗ ${failed} record${failed > 1 ? 's' : ''} not saved — tap the red card to retry`
    : state.hydrateError ? '⚠ Could not check the server for saved records — reload before capturing'
    : all.length === 0 ? 'No delivery merchants at this site yet'
    : doneCount === all.length ? 'All done — great round! 🎉'
    : `${all.length - doneCount} merchants left · tap to capture`;

  $('sec-morning-label').classList.toggle('hidden', overnight.length === 0);
  $('list-morning').innerHTML = overnight.map((m) => {
    const bm = state.baselineMeta[m.id] || {};
    const reading = baselineReading(m);
    const st = bm.saved ? ['done', '✓ baseline saved']
      : bm.inFlight ? ['pending', '⬆ saving…']
      : bm.error ? ['flagred', '❗ not saved — tap to retry']
      : reading ? ['pending', '⏳ AI reading…']
      : baselineHasShots(m) ? ['flag', '🟡 confirm baseline']
      : ['flag', '⚠ shoot baseline'];
    return `<div class="merchant-card ${bm.error ? 'failed' : ''}" data-id="${esc(m.id)}" data-mode="baseline">
      <div class="m-kitchen">${esc(m.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
        <div class="m-tags"><span class="tag h24">24 HR</span></div></div>
      <div class="m-status ${st[0]}">${st[1]}</div>
    </div>`;
  }).join('');

  $('list-evening').innerHTML = all.map((m) => {
    const r = state.records[m.id];
    const done = merchantDone(m);
    let status = '<span class="m-status pending">○ pending</span>';
    if (r && r.inFlight) {
      status = '<span class="m-status pending">⬆ saving…</span>';
    } else if (r && saveFailed(r)) {
      status = '<span class="m-status flagred">❗ not saved — tap to retry</span>';
    } else if (done && r.status === 'Operated') {
      const tot = Object.values(r.channels).reduce((s, c) =>
        s + Number(c.finalGmv ?? c.gmv ?? 0) + (c.extras || []).reduce((t, e) => t + Number(e.gmv || 0), 0), 0);
      status = `<div style="text-align:right"><div class="m-status done">✓ saved</div><div class="m-total">${money(tot)}</div></div>`;
    } else if (done) {
      status = `<span class="m-status done">✓ ${esc(r.status)}</span>`;
    } else if (r && r.draft) {
      status = (r.pending || 0) > 0
        ? '<span class="m-status pending">⏳ AI reading…</span>'
        : '<span class="m-status flag">🟡 confirm readings</span>';
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
$('btn-logout').onclick = () => attemptLogout();
function logout() {
  state.pin = '';
  state.pinFirst = '';
  state.history = {};
  rv.loaded = false;
  rv.unmatched = {};
  paintPin();
  loginStep('site');
  show('view-login');
}

/* ---------- menu ---------- */
$('btn-menu').onclick = () => $('menu-overlay').classList.remove('hidden');
$('menu-cancel').onclick = () => $('menu-overlay').classList.add('hidden');
$('menu-overlay').onclick = (e) => { if (e.target === $('menu-overlay')) $('menu-overlay').classList.add('hidden'); };
$('menu-logout').onclick = () => { $('menu-overlay').classList.add('hidden'); attemptLogout(); };
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
      <div class="mb-btns">
        <button class="mb-moon ${m.overnight ? 'on' : ''}" data-id="${esc(m.id)}" title="Operates outside 10 am – 10 pm — needs a morning GMV shot daily">🌙</button>
        <button class="mb-toggle ${m.disabled ? 'enable' : ''}" data-id="${esc(m.id)}">${m.disabled ? 'Enable' : 'Disable'}</button>
      </div>
    </div>`).join('') : '<p class="ab-note">No brands at this site yet.</p>';

  /* Both toggles write the SFDC ID Map for real (col I Overnight / col J
     Disabled): optimistic flip, revert loudly if the server says no. */
  const patchFlag = async (m, body, revert) => {
    try {
      const r = await fetch(`${CONFIG.apiBase}/api/merchants`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facility: m.site, kitchen: m.kitchen, brand: m.brand, ...body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    } catch (e) {
      revert();
      toast(`❗ Change NOT saved — ${e.message}`);
    }
    renderBrands();
    renderChecklist();
  };
  $('mb-list').querySelectorAll('.mb-moon').forEach((b) => b.onclick = () => {
    const m = findMerchant(b.dataset.id);
    const src = DATA.merchants.find((x) => x.site === m.site && x.kitchen === m.kitchen && x.brand === m.brand);
    const next = !m.overnight;
    m.overnight = src.overnight = next || undefined;
    renderBrands();
    toast(next ? `${m.brand} marked outside-hours 🌙 — morning GMV shot needed daily`
               : `${m.brand} back to normal hours`);
    patchFlag(m, { overnight: next }, () => { m.overnight = src.overnight = !next || undefined; });
  });
  $('mb-list').querySelectorAll('.mb-toggle').forEach((b) => b.onclick = () => {
    const m = findMerchant(b.dataset.id);
    const src = DATA.merchants.find((x) => x.site === m.site && x.kitchen === m.kitchen && x.brand === m.brand);
    const next = !m.disabled;
    m.disabled = src.disabled = next || undefined;
    renderBrands();
    toast(next ? `${m.brand} disabled — hidden from new capture, history kept` : `${m.brand} re-enabled ✓`);
    patchFlag(m, { disabled: next }, () => { m.disabled = src.disabled = !next || undefined; });
  });
}

/* ---------- review previous days (real GMV Raw Data rows) ---------- */
const rv = { offset: 0, loading: false, loaded: false, error: null, unmatched: {} };
function openReview() {
  rv.offset = 0;
  renderReview();
  show('view-review');
  loadHistory(true);   // fresh read on every open — another phone may have saved since
}
$('btn-review-back').onclick = () => { renderChecklist(); show('view-checklist'); };

/* Pull the last 6 business days for this site in ONE call and bucket them by
   offset. Baseline rows are kept separately for display; rows whose brand no
   longer matches the catalog (renamed in the sheet) surface as read-only. */
async function loadHistory(force) {
  if (rv.loading || (rv.loaded && !force)) return;
  rv.loading = true;
  rv.error = null;
  renderReview();
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/records?site=${state.site.id}`
      + `&from=${dateForOffset(6)}&to=${dateForOffset(1)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    for (let o = 1; o <= 6; o++) state.history[o] = {};
    rv.unmatched = {};
    (d.records || []).forEach((sr) => {
      const off = offsetForDate(sr.salesDate);
      if (off < 1 || off > 6) return;
      const m = state.merchants.find((x) => x.kitchen === sr.kitchen && x.brand === sr.brand);
      if (!m) { (rv.unmatched[off] = rv.unmatched[off] || []).push(sr); return; }
      if (sr.recordType === 'baseline') {
        // store alongside the day's records; '_baselines' can never collide
        // with a merchant id, and only the review renderer reads it
        (state.history[off]._baselines = state.history[off]._baselines || {})[m.id] = sr;
      } else {
        state.history[off][m.id] = serverRecToLocal(sr);
      }
    });
    rv.loaded = true;
  } catch (e) {
    rv.error = e.message;
  }
  rv.loading = false;
  renderReview();
}

function renderReview() {
  $('rv-sub').textContent = `${state.site.name} · ${state.site.id}`;
  const days = [...Array(7)].map((_, i) => ({ offset: i, label: dayLabel(i) }));
  $('rv-dates').innerHTML = days.map((d) =>
    `<button class="chip ${rv.offset === d.offset ? 'active' : ''}" data-o="${d.offset}">${esc(d.label)}</button>`).join('');
  $('rv-dates').querySelectorAll('.chip').forEach((b) => b.onclick = () => { rv.offset = +b.dataset.o; renderReview(); });

  if (rv.offset && rv.loading) {
    $('rv-list').innerHTML = '<p class="ab-note" style="margin-top:14px"><span class="spinner sm"></span> Loading saved records…</p>';
    return;
  }
  if (rv.offset && rv.error) {
    $('rv-list').innerHTML = `<p class="ab-note" style="margin-top:14px">⚠ Could not load history (${esc(rv.error)}).</p>
      <button class="btn-primary" id="rv-retry" style="margin-top:10px">Try again</button>`;
    $('rv-retry').onclick = () => loadHistory(true);
    return;
  }

  /* Saved rows — tap to open and change (server logs every cell change). */
  const store = recordsFor(rv.offset);
  const rows = state.merchants.filter((m) => store[m.id] && store[m.id].saved).map((m) => ({ m, r: store[m.id] }));
  const cards = rows.map(({ m, r }) => {
    const badges =
      (r.amendedBy ? `<span class="tag amend">✏️ amended by ${esc(r.amendedBy)}</span>`
        : r.auditEdited ? '<span class="tag amend">✏️ amended</span>' : '')
      + (r.billingFlag && r.billingFlag !== 'OK' ? `<span class="tag flagwarn">⚠ ${esc(r.billingFlag)}</span>` : '');
    const by = `<span class="customer-meta">by ${esc(r.staffName || state.staff.name)}</span>`;
    if (r.status !== 'Operated') {
      return `<div class="merchant-card done" data-mid="${esc(m.id)}"><div class="m-kitchen">${esc(m.kitchen)}</div>
        <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
          <div class="m-tags">${by}${badges}</div></div>
        <span class="m-status done">✓ ${esc(r.status)}</span><span class="rv-chev">›</span></div>`;
    }
    const tot = Object.values(r.channels).reduce((s, c) =>
      s + Number(c.finalGmv ?? c.gmv ?? 0) + (c.extras || []).reduce((t, e) => t + Number(e.gmv || 0), 0), 0);
    const ords = Object.values(r.channels).reduce((s, c) =>
      s + Number(c.finalOrders ?? c.orders ?? 0) + (c.extras || []).length, 0);
    return `<div class="merchant-card" data-mid="${esc(m.id)}"><div class="m-kitchen">${esc(m.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
        <div class="m-tags">${by}${badges}</div></div>
      <div style="text-align:right"><div class="m-status done">${ords} orders</div><div class="m-total">${money(tot)}</div></div>
      <span class="rv-chev">›</span>
    </div>`;
  }).join('');

  /* Morning baselines of that day — context for the deducted closings.
     View-only: a past baseline edit would re-open a billed comparison. */
  const baselines = rv.offset ? (store._baselines || {}) : {};
  const baseCards = Object.entries(baselines).map(([mid, sr]) => {
    const m = findMerchant(mid);
    if (!m) return '';
    const parts = Object.entries(sr.channels)
      .map(([ch, c]) => `${CH_META[ch].name} ${c.orders || 0} · ${money(Number(c.gmv || 0))}`).join(' · ');
    return `<div class="merchant-card rv-base"><div class="m-kitchen">☀️</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)} — morning baseline</div>
        <div class="m-tags"><span class="customer-meta">${esc(parts)} · deducted that night · view only</span></div></div></div>`;
  }).join('');

  /* Rows whose brand no longer matches the catalog (renamed in the sheet). */
  const ghostCards = (rv.offset ? (rv.unmatched[rv.offset] || []) : []).map((sr) =>
    `<div class="merchant-card rv-base"><div class="m-kitchen">${esc(sr.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(sr.brand)}</div>
        <div class="m-tags"><span class="customer-meta">not in the current brand list — view in the sheet</span></div></div></div>`).join('');

  /* Merchants with NO record that day — one tap starts a back-fill. */
  const missing = rv.offset ? state.merchants.filter((m) => !m.disabled && !store[m.id]) : [];
  const missingHTML = missing.length
    ? `<div class="roster-group" style="margin-top:16px">No record for ${esc(dayLabel(rv.offset))}</div>`
      + missing.map((m) => `<div class="merchant-card rv-add" data-mid="${esc(m.id)}">
          <div class="m-kitchen">${esc(m.kitchen)}</div>
          <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
            <div class="m-tags"><span class="customer-meta">nothing saved that day</span></div></div>
          <span class="m-status flag">＋ add record</span></div>`).join('')
    : '';

  $('rv-list').innerHTML = (cards + baseCards + ghostCards || (rv.offset
      ? '<p class="ab-note" style="margin-top:14px">No records saved for this day.</p>'
      : '<p class="ab-note" style="margin-top:14px">Nothing saved yet today — records appear here as you save them.</p>'))
    + missingHTML;
  $('rv-list').querySelectorAll('.merchant-card[data-mid]').forEach((c) =>
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

function extrasTotals(val) {
  const list = val.extras || [];
  return { n: list.length,
           gmv: +list.reduce((s, e) => s + Number(e.gmv || 0), 0).toFixed(2) };
}

/* Pending rider pickup: orders done but not on the summary screen yet — one
   photo per order, one order per photo (that is the evidence contract). */
function extrasHTML(ch, val, rec) {
  const list = val.extras || [];
  const collapsed = list.length > 3 && !rec.expandedExtras?.[ch];
  const rowHTML = (e, i) => {
    const thumb = e.thumbUrl || e.photoUrl
      || (e.photoId ? `${CONFIG.apiBase}/api/photo/${esc(e.photoId)}` : null);
    const stateIcon = e.pendingAI ? '<span class="spinner sm"></span>'
      : e.dup ? '⚠' : e.conf === 'high' && !e.edited ? '✓' : e.edited ? '✎' : '⚠';
    return `<div class="extra-row ${e.edited ? 'edited' : ''} ${e.dup ? 'dup' : ''}">
      ${thumb ? `<img class="x-thumb" src="${thumb}" alt="order ${i + 1}">` : '<span class="x-thumb file">📎</span>'}
      <span class="x-meta">#${i + 1}${e.orderRef ? ' · ' + esc(e.orderRef) : ''}<em>1 order</em></span>
      <span class="x-state">${stateIcon}</span>
      <input class="x-amt" inputmode="decimal" placeholder="0.00" data-x="${i}"
        value="${e.gmv !== undefined && e.gmv !== null ? Number(e.gmv).toFixed(2) : ''}">
      <button class="x-del" data-xdel="${i}" title="Remove this order">✕</button>
    </div>`;
  };
  const done = list.filter((e) => !e.pendingAI && e.gmv !== undefined && e.gmv !== null);
  const open = list.map((e, i) => [e, i]).filter(([e]) => !done.includes(e));
  const body = collapsed
    ? `<button class="extras-expand" data-xexpand="1">${done.length} order${done.length > 1 ? 's' : ''} added · ${money(extrasTotals(val).gmv)} — view all ›</button>`
      + open.map(([e, i]) => rowHTML(e, i)).join('')
    : list.map((e, i) => rowHTML(e, i)).join('');
  return `<div class="extras-sec">
    <div class="extras-head">⏳ Pending rider pickup
      <span class="extras-hint">Order done but not in the summary yet? Shoot its order-details page — one photo per order. Shoot the summary first, then the locker.</span></div>
    ${body}
    <button class="extras-add" data-xadd="1">＋ Add pending order photos</button>
  </div>`;
}

function totalStripHTML(ch, val) {
  const x = extrasTotals(val);
  if (!x.n) return '';
  const so = Number(val.finalOrders || 0), sg = Number(val.finalGmv || 0);
  return `<div class="total-strip">Recorded total: <b>${so + x.n} orders · ${money(sg + x.gmv)}</b>
    <small>Summary ${so} · ${money(sg)} ＋ ${x.n} pending · ${money(x.gmv)}</small></div>`;
}

function channelBodyHTML(ch, val, base, mode) {
  const o = val.finalOrders ?? val.orders;
  const g = val.finalGmv ?? val.gmv;
  const fields = `<div class="reading-fields full">
      <div class="rf ${val.editedOrders ? 'edited' : ''} ${val.invalidOrders ? 'bad' : ''}"><label>Orders</label><input inputmode="numeric" placeholder="0" value="${o !== undefined ? Number(o) : ''}" data-f="orders"></div>
      <div class="rf ${val.editedGmv ? 'edited' : ''} ${val.invalidGmv ? 'bad' : ''}"><label>Sales (S$)</label><input inputmode="decimal" placeholder="0.00" value="${g !== undefined ? Number(g).toFixed(2) : ''}" data-f="gmv"></div>
    </div>`;
  const aiChannel = AI_CHANNELS.includes(ch);
  const statusLine = !aiChannel
    ? '<span class="screen-note">📎 Evidence photo attached — numbers entered manually</span>'
    : val.pendingAI ? '<span class="screen-note"><span class="spinner sm"></span> AI reading in background — you can move on and confirm later</span>'
    : val.conf === 'high' ? '<span class="ok">✓ AI read · high confidence</span>'
    : '<span class="warn">⚠ AI read · please double-check</span>';
  const photo = val.photoUrl
    ? `<div class="photo-row"><img class="thumb tap" src="${val.photoUrl}" alt="evidence" title="Tap to mark the correct number on the photo">
        <div class="ai-note-col">
          ${statusLine}
          ${aiChannel ? `<span class="screen-note">${esc(val.screen || '')}</span>` : ''}
          <span class="tap-hint">👆 Tap photo to mark the correct number</span>
        </div>
        <div class="photo-btns"><button class="retake">Retake</button><button class="ch-remove" title="Remove photo and readings">✕ Remove</button></div></div>`
    : val.photoLink && val.photoId
    ? `<div class="photo-row"><img class="thumb tap" src="${CONFIG.apiBase}/api/photo/${esc(val.photoId)}" alt="evidence" title="Tap to view or mark the correct number">
        <div class="ai-note-col">
          <span class="screen-note">🗂️ Photo on record — saved to Drive earlier.</span>
          <span class="tap-hint">👆 Tap to view or mark the correct number</span>
        </div>
        <div class="photo-btns"><button class="retake">Retake</button><button class="ch-remove" title="Remove photo and readings">✕ Remove</button></div></div>`
    : val.photoLink
    ? `<div class="photo-row"><span class="photo-chip">🗂️ Photo on record</span>
        <div class="ai-note-col"><span class="screen-note">Saved to Drive earlier — retake only if it was wrong.</span></div>
        <div class="photo-btns"><button class="retake">Retake</button><button class="ch-remove" title="Remove photo and readings">✕ Remove</button></div></div>`
    : `<div class="photo-slot"><span class="cam">📷</span> Snap or upload ${esc(CH_META[ch].name)} screen</div>
       <div class="no-photo-note">${aiChannel
         ? 'You can type the numbers first — but a photo is required as evidence before saving.'
         : 'This channel is manual — type the numbers, and attach a photo as evidence.'}</div>`;
  let extra = '';
  if (mode === 'baseline' && channelHasData(val)) {
    extra = `<div class="deduct-box">☀️ Stored as today's baseline — deducted tonight. Not billed.</div>`;
  } else if (base && channelHasData(val)) {
    const x = extrasTotals(val);
    const bOrders = Number(base.finalOrders ?? base.orders ?? 0);
    const bGmv = Number(base.finalGmv ?? base.gmv ?? 0);
    const bo = (o ?? 0) + x.n - bOrders;
    const bg = (g ?? 0) + x.gmv - bGmv;
    extra = `<div class="deduct-box">☀️ Baseline this morning: ${bOrders} orders · ${money(bGmv)}<br>
      🧾 <b>Billable 10 am–10 pm: ${bo} orders · ${money(bg)}</b></div>`;
  }
  const mism = val.mismatch ? `<div class="mismatch">⚠ ${esc(val.mismatch)}</div>` : '';
  const extras = mode === 'evening' && !state.current.offset && AI_CHANNELS.includes(ch)
    ? extrasHTML(ch, val, curRec()) + totalStripHTML(ch, val) : '';
  return fields + mism + extra + photo + extras;
}

function wireChannel(card, ch) {
  card.querySelectorAll('.reading-fields input').forEach((inp) => inp.oninput = () => {
    let val = channelValue(ch);
    if (!val) { val = {}; setChannelValue(ch, val); }
    const raw = inp.value.trim();
    const n = Number(raw);
    const invalid = raw !== '' && (!isFinite(n) || n < 0);
    if (inp.dataset.f === 'orders') {
      val.invalidOrders = invalid;
      if (!invalid) { val.finalOrders = raw === '' ? undefined : Math.round(n); val.editedOrders = true; }
    } else {
      val.invalidGmv = invalid;
      if (!invalid) { val.finalGmv = raw === '' ? undefined : n; val.editedGmv = true; }
    }
    val.edited = true;
    val._dirty = true;                 // baseline "update & save" tracking
    inp.closest('.rf').classList.toggle('bad', invalid);
    if (!invalid) inp.closest('.rf').classList.add('edited');
    updateSaveBtn();
  });
  const slot = card.querySelector('.photo-slot');
  if (slot) slot.onclick = () => openPicker(ch);
  const rt = card.querySelector('.retake');
  if (rt) rt.onclick = () => openPicker(ch);
  const img = card.querySelector('img.thumb');
  if (img) img.onclick = () => openViewer(ch);

  /* ✕ Remove: wipe this channel's photo + readings + marks + extras. The
     generation bump makes any in-flight AI read settle into the void instead
     of resurrecting deleted data. */
  const rm = card.querySelector('.ch-remove');
  if (rm) rm.onclick = () => {
    const m = state.current.m;
    askConfirm(`Remove ${CH_META[ch].name} data?`,
      `The photo and the numbers entered for ${CH_META[ch].name} at ${m.brand} will be cleared here. `
      + `If this was already saved, the row is updated when you save again — earlier values stay in the audit log.`,
      'Yes, clear it', () => {
        const prev = channelValue(ch) || {};
        setChannelValue(ch, { gen: (prev.gen || 0) + 1 });
        const rec = state.current.mode === 'baseline' ? null : curRec();
        if (rec) rec.expanded[ch] = false;
        renderChannelCards();
        updateSaveBtn();
        toast(`${CH_META[ch].name} cleared`);
      });
  };

  /* Pending-pickup extras wiring */
  const xadd = card.querySelector('[data-xadd]');
  if (xadd) xadd.onclick = () => openExtrasPicker(ch);
  const xexpand = card.querySelector('[data-xexpand]');
  if (xexpand) xexpand.onclick = () => {
    const rec = curRec();
    (rec.expandedExtras = rec.expandedExtras || {})[ch] = true;
    renderChannelCards();
  };
  card.querySelectorAll('.x-amt').forEach((inp) => inp.oninput = () => {
    const val = channelValue(ch);
    const e = val.extras?.[Number(inp.dataset.x)];
    if (!e) return;
    const raw = inp.value.trim();
    const n = Number(raw);
    const invalid = raw !== '' && (!isFinite(n) || n <= 0);
    inp.closest('.extra-row').classList.toggle('bad', invalid);
    e.invalid = invalid;
    if (!invalid) { e.gmv = raw === '' ? undefined : n; e.edited = true; }
    const strip = card.querySelector('.total-strip');
    if (strip) strip.outerHTML = totalStripHTML(ch, val);
    updateSaveBtn();
  });
  card.querySelectorAll('[data-xdel]').forEach((b) => b.onclick = () => {
    const val = channelValue(ch);
    const i = Number(b.dataset.xdel);
    const e = val.extras?.[i];
    if (!e) return;
    askConfirm('Remove this pending order?',
      `Order photo #${i + 1}${e.orderRef ? ' (' + e.orderRef + ')' : ''} and its amount will be removed from tonight's total.`,
      'Yes, remove it', () => {
        val.extras.splice(i, 1);
        markDupRefs(val);
        renderChannelCards();
        updateSaveBtn();
        toast('Pending order removed');
      });
  });
}

/* Flag extras whose order number was already added (same order shot twice). */
function markDupRefs(val) {
  const seen = {};
  (val.extras || []).forEach((e) => {
    const ref = (e.orderRef || '').trim();
    e.dup = !!(ref && seen[ref]);
    if (ref) seen[ref] = true;
  });
}

/* ---------- async extraction ("snap & go") ----------
   Staff never wait for the AI: the photo attaches instantly, the read runs in
   the background, and results land on the right merchant even if the user has
   moved on. Context is FROZEN at call time — resolving into state.current
   would write numbers onto whichever kitchen happens to be open. On backend
   failure the fields stay manual: a billing tool never invents numbers. */
function readVal(ctx, ch) {
  return ctx.mode === 'baseline' ? state.baselines[`${ctx.m.id}:${ch}`]
    : recordsFor(ctx.offset)[ctx.m.id].channels[ch];
}
function writeVal(ctx, ch, val) {
  if (ctx.mode === 'baseline') state.baselines[`${ctx.m.id}:${ch}`] = val;
  else recordsFor(ctx.offset)[ctx.m.id].channels[ch] = val;
}
function viewingCtx(ctx) {
  return state.current && state.current.m.id === ctx.m.id
    && state.current.mode === ctx.mode && state.current.offset === ctx.offset
    && !$('view-capture').classList.contains('hidden');
}

function runExtraction(ch, photoUrl) {
  const ctx = { ...state.current };

  // Non-AI channels: photo = evidence only, numbers stay manual.
  if (!AI_CHANNELS.includes(ch)) {
    const prev = readVal(ctx, ch) || {};
    writeVal(ctx, ch, { ...prev, photoUrl, photoDirty: true, photoLink: undefined,
      screen: 'Photo saved as evidence — enter the numbers manually for this channel.' });
    renderChannelCards();
    updateSaveBtn();
    return;
  }

  const rec = ctx.mode === 'baseline' ? null : recordsFor(ctx.offset)[ctx.m.id];
  if (rec) rec.pending = (rec.pending || 0) + 1;
  writeVal(ctx, ch, { ...(readVal(ctx, ch) || {}), photoUrl, photoDirty: true,
    photoLink: undefined, pendingAI: true });
  const gen = (readVal(ctx, ch) || {}).gen || 0;   // ✕ Remove bumps this
  if (viewingCtx(ctx)) { renderChannelCards(); updateSaveBtn(); }

  const settle = (patch) => {
    const prev = readVal(ctx, ch) || {};
    if ((prev.gen || 0) !== gen) {                 // channel was cleared mid-read
      if (rec) rec.pending = Math.max(0, (rec.pending || 1) - 1);
      return;
    }
    const val = { ...prev, ...patch, photoUrl, pendingAI: false };
    // Respect anything the staff member typed while the read was in flight.
    if (prev.editedOrders) val.finalOrders = prev.finalOrders;
    else { val.finalOrders = patch.orders; val.editedOrders = false; }
    if (prev.editedGmv) val.finalGmv = prev.finalGmv;
    else { val.finalGmv = patch.gmv; val.editedGmv = false; }
    val.aiOrders = patch.orders; val.aiGmv = patch.gmv;
    writeVal(ctx, ch, val);
    if (rec) rec.pending = Math.max(0, (rec.pending || 1) - 1);
    if (viewingCtx(ctx)) { renderChannelCards(); updateSaveBtn(); }
    else if (!$('view-checklist').classList.contains('hidden')) renderChecklist();
    if (rec && rec.draft && !rec.pending) toast(`${ctx.m.brand} readings ready — tap to confirm 🟡`);
    if (ctx.mode === 'baseline' && !viewingCtx(ctx) && !$('view-checklist').classList.contains('hidden')) renderChecklist();
  };

  fetch(`${CONFIG.apiBase}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: photoUrl, channel: ch,
      mode: ctx.mode === 'baseline' ? 'baseline' : 'closing',
      brand: ctx.m.brand, aigens: !!ctx.m.aigens }),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      return r.json();
    })
    .then((d) => {
      const notes = [];
      if (d.wrong_channel) notes.push(`⚠ This looks like a ${d.platform} screen, not ${CH_META[ch].name} — check the photo`);
      if (d.confidence !== 'high' && d.notes) notes.push(d.notes);
      settle({
        orders: d.orders ?? undefined, gmv: d.gmv ?? undefined,
        conf: d.confidence, screen: d.screen_summary,
        mismatch: notes.join(' · ') || undefined,
        zero: d.zero_sales,
      });
    })
    .catch((e) => settle({ orders: undefined, gmv: undefined, conf: 'low', screen: '',
      mismatch: `AI reading failed (${e.message}) — type the numbers manually, the photo is kept as evidence.` }));
}

/* Pending-pickup order: read ONE order-details page. One photo = one order —
   the AI only fills the amount; a failed read leaves it for manual typing. */
function runExtraExtraction(ctx, ch, entry) {
  const apply = (patch) => {
    const val = readVal(ctx, ch);
    if (!val || !val.extras || !val.extras.includes(entry)) return;   // removed meanwhile
    if ((val.gen || 0) !== (entry.gen || 0)) return;                  // channel cleared
    Object.assign(entry, patch, { pendingAI: false });
    if (!entry.edited && patch.aiGmv !== undefined && patch.aiGmv !== null) entry.gmv = patch.aiGmv;
    markDupRefs(val);
    if (viewingCtx(ctx)) { renderChannelCards(); updateSaveBtn(); }
  };

  fetch(`${CONFIG.apiBase}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: entry.photoUrl, channel: ch, mode: 'closing',
      shot: 'single_order', brand: ctx.m.brand }),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      return r.json();
    })
    .then((d) => apply({ aiGmv: d.gmv ?? null, conf: d.confidence,
      orderRef: (d.order_ref || '').trim(),
      aiNote: d.wrong_channel ? `looks like ${d.platform}, not ${CH_META[ch].name}` : '' }))
    .catch((e) => apply({ aiGmv: null, conf: 'low', aiFail: true,
      aiNote: `AI reading failed (${e.message}) — type the amount from the photo` }));
}

/* ---------- photo viewer: tap-to-correct ---------- */
/* Candidate numbers are overlaid on the photo; tapping one assigns it to a field
   and logs the correction — this is the data the AI learns from over time. */
function openViewer(ch) {
  const val = channelValue(ch);
  const src = val && (val.photoUrl
    || (val.photoId ? `${CONFIG.apiBase}/api/photo/${val.photoId}` : null));
  if (!src) return;
  state.viewer = { ch, pendingBox: null };
  const img = $('viewer-img');
  img.onload = placeViewerBoxes;
  img.src = src;
  $('viewer-choice').classList.add('hidden');
  $('viewer-overlay').classList.remove('hidden');
  if (img.complete) placeViewerBoxes();
}

/* Geometry of the letterboxed image (object-fit: contain) inside the stage. */
function imageRect() {
  const img = $('viewer-img');
  const stage = $('viewer-stage');
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const scale = Math.min(sw / img.naturalWidth, sh / img.naturalHeight) || 1;
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  return { ox: (sw - dw) / 2, oy: (sh - dh) / 2, dw, dh };
}

/* Show the marks the staff member has drawn on this photo (stored in image-%). */
function placeViewerBoxes() {
  const val = channelValue(state.viewer.ch) || {};
  const { ox, oy, dw, dh } = imageRect();
  $('viewer-boxes').innerHTML = (val.marks || []).map((mk) =>
    `<div class="vbox mark" style="left:${(ox + mk.box.x / 100 * dw).toFixed(0)}px;top:${(oy + mk.box.y / 100 * dh).toFixed(0)}px;width:${(mk.box.w / 100 * dw).toFixed(0)}px;height:${(mk.box.h / 100 * dh).toFixed(0)}px">
      <small>${mk.kind === 'gmv' ? 'SALES' : 'ORDERS'}</small>${mk.kind === 'gmv' ? money(mk.value) : esc(String(mk.value))}</div>`).join('');
}
window.addEventListener('resize', () => {
  if (!$('viewer-overlay').classList.contains('hidden')) placeViewerBoxes();
});

/* Drag-to-mark: staff box the correct number themselves, then type it.
   Marks (box in image-% + value + field) are stored in the corrections log —
   this is the ground-truth data the AI learns from over time. */
(() => {
  const stage = $('viewer-stage');
  const band = $('rubber-band');
  let start = null;
  stage.addEventListener('pointerdown', (e) => {
    if ($('viewer-overlay').classList.contains('hidden')) return;
    if (!$('viewer-choice').classList.contains('hidden')) return;
    const r = stage.getBoundingClientRect();
    start = { x: e.clientX - r.left, y: e.clientY - r.top };
    band.style.left = `${start.x}px`;
    band.style.top = `${start.y}px`;
    band.style.width = '0px';
    band.style.height = '0px';
    band.classList.remove('hidden');
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!start) return;
    const r = stage.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    band.style.left = `${Math.min(start.x, x)}px`;
    band.style.top = `${Math.min(start.y, y)}px`;
    band.style.width = `${Math.abs(x - start.x)}px`;
    band.style.height = `${Math.abs(y - start.y)}px`;
  });
  stage.addEventListener('pointerup', (e) => {
    if (!start) return;
    const r = stage.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const box = { left: Math.min(start.x, x), top: Math.min(start.y, y),
                  w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
    start = null;
    if (box.w < 14 || box.h < 10) { band.classList.add('hidden'); return; }
    const { ox, oy, dw, dh } = imageRect();
    state.viewer.pendingBox = {
      x: Math.max(0, (box.left - ox) / dw * 100),
      y: Math.max(0, (box.top - oy) / dh * 100),
      w: Math.min(100, box.w / dw * 100),
      h: Math.min(100, box.h / dh * 100),
    };
    $('vc-input').value = '';
    $('viewer-choice').classList.remove('hidden');
    setTimeout(() => $('vc-input').focus(), 50);
  });
})();
function applyMark(kind) {
  const { ch, pendingBox } = state.viewer || {};
  const raw = $('vc-input').value.trim().replace(/[^0-9.]/g, '');
  const value = Number(raw);
  if (!pendingBox || raw === '' || Number.isNaN(value)) { $('vc-input').focus(); return; }
  const val = channelValue(ch);
  if (kind === 'orders') { val.finalOrders = Math.round(value); val.editedOrders = true; }
  else { val.finalGmv = value; val.editedGmv = true; }
  val.edited = true;
  (val.marks = val.marks || []).push({ box: pendingBox, value, kind });
  (val.corrections = val.corrections || []).push({ type: 'manual_mark', box: pendingBox, value, as: kind });
  state.viewer.pendingBox = null;
  $('rubber-band').classList.add('hidden');
  $('viewer-choice').classList.add('hidden');
  placeViewerBoxes();
  renderChannelCards();
  updateSaveBtn();
  toast('Marked ✓ — value updated, AI will learn from this');
}
$('vc-orders').onclick = () => applyMark('orders');
$('vc-gmv').onclick = () => applyMark('gmv');
$('vc-cancel').onclick = () => {
  state.viewer.pendingBox = null;
  $('rubber-band').classList.add('hidden');
  $('viewer-choice').classList.add('hidden');
};
$('viewer-close').onclick = closeViewer;
function closeViewer() {
  $('rubber-band').classList.add('hidden');
  $('viewer-overlay').classList.add('hidden');
  state.viewer = null;
}

/* ---------- save ---------- */
function recHasChannelData(rec) {
  return Object.values(rec.channels || {}).some((v) => channelHasData(v) || (v.extras || []).length);
}
function extrasBlockers(rec) {
  const out = [];
  Object.entries(rec.channels || {}).forEach(([ch, v]) => {
    const n = (v.extras || []).filter((e) => e.pendingAI || e.invalid || !(Number(e.gmv) > 0)).length;
    if (n) out.push(`${CH_META[ch].name}: ${n} pending order${n > 1 ? 's need amounts' : ' needs an amount'}`);
  });
  return out;
}
function invalidFields(rec) {
  return Object.values(rec.channels || {}).some((v) => v.invalidOrders || v.invalidGmv);
}
function coreReady() {
  const { mode } = state.current;
  const rec = curRec();
  if (mode === 'baseline') return false;   // baselines use their own flow below
  if (rec.status !== 'Operated') return true;
  if (invalidFields(rec) || extrasBlockers(rec).length) return false;
  return CORE.every((ch) => {
    const v = rec.channels[ch];
    return v && v.finalOrders !== undefined && v.finalGmv !== undefined;
  });
}
function missingPhotos() {
  const rec = curRec();
  return CORE.filter((ch) => rec.channels[ch] && !rec.channels[ch].photoUrl && !rec.channels[ch].photoLink);
}
function photosCaptured() {
  /* All CORE screens photographed (reads may still be in flight). */
  const rec = curRec();
  return rec.status === 'Operated' && CORE.every((ch) => rec.channels[ch]?.photoUrl || rec.channels[ch]?.photoLink);
}
function baselineShots(mid) {
  return CORE.map((ch) => state.baselines[`${mid}:${ch}`]).filter(Boolean);
}
function baselineSettled(mid) {
  return baselineShots(mid).filter((b) => !b.pendingAI
    && b.finalOrders !== undefined && b.finalGmv !== undefined);
}
function baselineDirty(mid) {
  return baselineShots(mid).some((b) => b._dirty || b.photoDirty);
}

function updateSaveBtn() {
  const { m, mode, offset } = state.current;
  const btn = $('btn-save');
  if (mode === 'baseline') {
    const meta = state.baselineMeta[m.id] || {};
    const settled = baselineSettled(m.id);
    const reading = baselineReading(m);
    if (meta.inFlight) { btn.disabled = true; btn.textContent = '⬆ Saving baseline…'; }
    else if (meta.error) { btn.disabled = false; btn.textContent = '❗ Retry baseline save'; }
    else if (meta.saved && !baselineDirty(m.id)) { btn.disabled = false; btn.textContent = 'Baseline saved ✓ — back to list'; }
    else if (settled.length) {
      btn.disabled = false;
      btn.textContent = meta.saved ? 'Update baseline & save'
        : `Confirm baseline & save${settled.length < CORE.length ? ' (partial)' : ''}`;
    }
    else if (reading) { btn.disabled = true; btn.textContent = 'Reading… hang on a moment'; }
    else { btn.disabled = true; btn.textContent = 'Shoot the screens to start'; }
    return;
  }
  const rec = curRec();
  if (rec.inFlight) { btn.disabled = true; btn.textContent = '⬆ Saving…'; return; }
  const blockers = rec.status === 'Operated' ? extrasBlockers(rec) : [];
  if (!offset && blockers.length) { btn.disabled = true; btn.textContent = blockers[0]; return; }
  if (rec.status === 'Operated' && invalidFields(rec)) {
    btn.disabled = true; btn.textContent = 'Fix the highlighted numbers'; return;
  }
  if (coreReady()) {
    btn.disabled = false;
    btn.textContent = offset ? (rec.saveError ? '❗ Retry save' : `Save changes for ${dayLabel(offset)}`)
      : rec.saveError ? '❗ Retry save'
      : rec.status !== 'Operated' ? `Save as “${rec.status}”`
      : rec.serverSaved ? 'Save changes' : 'Confirm & save';
  } else if (!offset && photosCaptured()) {
    btn.disabled = false;
    btn.textContent = 'Photos captured — next kitchen ➜';
  } else {
    btn.disabled = true;
    btn.textContent = rec.status === 'Operated' ? 'Confirm & save' : `Save as “${rec.status}”`;
  }
}

function channelSummaryText(rec) {
  return Object.entries(rec.channels)
    .filter(([, v]) => channelHasData(v) || (v.extras || []).length)
    .map(([ch, v]) => {
      const x = extrasTotals(v);
      return `${CH_META[ch].name} ${Number(v.finalOrders || 0) + x.n} · ${money(Number(v.finalGmv || 0) + x.gmv)}`;
    }).join(', ');
}

/* Build the /api/records payload for one record. salesDate is the record's own
   business date — today's round or a Review day within the edit window; the
   server validates the window and logs every changed cell to Corrections. */
function buildPayload(m, rec, salesDate) {
  const channels = {};
  rec._sent = {};
  if (rec.status === 'Operated') {
    Object.entries(rec.channels).forEach(([ch, v]) => {
      const hasExtras = (v.extras || []).length > 0;
      if (!channelHasData(v) && !hasExtras) return;
      const c = {
        aiOrders: v.aiOrders ?? null, aiGmv: v.aiGmv ?? null,
        finalOrders: v.finalOrders ?? null, finalGmv: v.finalGmv ?? null,
        edited: !!(v.editedOrders || v.editedGmv || (v.marks || []).length),
        conf: v.conf ?? null, screen: (v.screen || '').slice(0, 400),
        zero: !!v.zero, marks: v.marks || [],
      };
      if (v.photoDirty && v.photoUrl) c.photo = v.photoUrl;
      else if (v.photoLink) c.photoLink = v.photoLink;
      if (hasExtras) {
        c.extras = v.extras.map((e) => {
          const x = { gmv: Number(e.gmv), aiGmv: e.aiGmv ?? null,
                      conf: e.conf ?? null, orderRef: e.orderRef || '' };
          if (e.photoDirty && e.photoUrl) x.photo = e.photoUrl;
          else if (e.photoLink) x.photoLink = e.photoLink;
          return x;
        });
      }
      channels[ch] = c;
      rec._sent[ch] = { val: v, extras: v.extras || [] };
    });
  }
  return { recordId: rec.recordId, recordType: 'closing', salesDate,
    confirmedAt: rec.confirmedAt, staffName: state.staff.name, staffId: state.staff.id || '',
    site: m.site, siteName: state.site.name, kitchen: m.kitchen, brand: m.brand,
    sfdcId: m.sfdcId, merchantType: m.type || '', kitchenStatus: rec.status,
    channels, notes: '' };
}

/* After a confirmed save, swap uploaded photos to their Drive links and drop
   the base64 copies — 25 kitchens of full-size dataURLs is exactly what gets
   a mobile Safari tab evicted mid-round. */
function adoptLinks(rec, resp) {
  Object.entries(resp.photoLinks || {}).forEach(([ch, link]) => {
    const v = (rec._sent[ch] && rec._sent[ch].val) || rec.channels[ch];
    if (v && link) { v.photoLink = link; v.photoId = photoIdOf(link); v.photoDirty = false; v.photoUrl = undefined; }
  });
  Object.entries(resp.extrasLinks || {}).forEach(([ch, links]) => {
    const sent = rec._sent[ch] ? rec._sent[ch].extras : [];
    links.forEach((link, i) => {
      const e = sent[i];
      if (e && link) { e.photoLink = link; e.photoId = photoIdOf(link); e.photoDirty = false; e.photoUrl = undefined; }
    });
  });
}

function refreshAfterSave(mid) {
  if (state.current && state.current.m.id === mid && !$('view-capture').classList.contains('hidden')) {
    renderChannelCards();
    updateSaveBtn();
  }
  if (!$('view-checklist').classList.contains('hidden')) renderChecklist();
}

async function postRecord(payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/records`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    return d;
  } finally { clearTimeout(t); }
}

async function saveRecord(mid) {
  const m = findMerchant(mid);
  const rec = state.records[mid];
  if (!rec || rec.inFlight) return;
  if (!rec.recordId) rec.recordId = recordIdFor(m, 'closing');
  if (!rec.confirmedAt) rec.confirmedAt = nowStamp();   // frozen across retries
  rec.staffName = rec.staffName || state.staff.name;
  rec.inFlight = true;
  rec.saveError = null;
  refreshAfterSave(mid);

  const finish = (err, resp) => {
    rec.inFlight = false;
    if (err) {
      rec.saveError = err;
      toast(`❗ ${m.brand} NOT saved — ${err}. It stays on your list; tap the red card to retry.`);
    } else {
      rec.saved = true; rec.serverSaved = true; rec.draft = false; rec.saveError = null;
      adoptLinks(rec, resp || {});
      if (rec.status !== 'Operated') rec.channels = {};
      if (resp && resp.billing === 'NO_BASELINE') {
        const why = (resp.billingNotes || []).find((n) => n.toLowerCase().includes('baseline'));
        toast(`${m.brand} saved — ⚠ ${why || 'no morning baseline'} · flagged for supervisor`);
      }
      else if (resp && resp.warnings && resp.warnings.length) toast(`${m.brand} saved — ⚠ ${resp.warnings[0]}`);
      else toast(`${m.brand} saved ✓`);
    }
    refreshAfterSave(mid);
  };

  try {
    finish(null, await postRecord(buildPayload(m, rec, state.salesDate)));
  } catch (e) {
    finish(e.name === 'AbortError' ? 'timed out after 90s' : e.message, null);
  }
}

/* Review write-back: same POST, the record's own past date. The server matches
   the deterministic Record ID, updates the row in place and logs every changed
   cell (who/when/old/new) — or appends a fresh row when back-filling a missed
   day. On failure we stay on the capture screen so the retry is one tap. */
async function saveAmend(mid, offset, from) {
  const m = findMerchant(mid);
  const rec = recordsFor(offset)[mid];
  if (!rec || rec.inFlight) return;
  const date = dateForOffset(offset);
  if (!rec.recordId) rec.recordId = recordIdFor(m, 'closing', date);
  if (!rec.confirmedAt) rec.confirmedAt = nowStamp();
  rec.staffName = rec.staffName || state.staff.name;
  rec.inFlight = true;
  rec.saveError = null;
  updateSaveBtn();
  try {
    const resp = await postRecord(buildPayload(m, rec, date));
    rec.inFlight = false;
    rec.saved = true;
    rec.serverSaved = true;
    rec.saveError = null;
    rec.amendedBy = state.staff.name;
    rec.auditEdited = rec.auditEdited || !!resp.edited;
    rec.billingFlag = resp.billing || '';
    adoptLinks(rec, resp || {});
    if (rec.status !== 'Operated') rec.channels = {};
    toast(`${m.brand} — ${dayLabel(offset)} saved ✓, audit logged`
      + (resp.billing === 'NO_BASELINE' ? ' · ⚠ no morning baseline that day' : ''));
    if (from === 'review') { renderReview(); show('view-review'); }
    else { renderChecklist(); show('view-checklist'); }
  } catch (e) {
    rec.inFlight = false;
    rec.saveError = e.name === 'AbortError' ? 'timed out after 90s' : e.message;
    toast(`❗ ${m.brand} NOT saved — ${rec.saveError}`);
    updateSaveBtn();
  }
}

async function saveBaseline(mid) {
  const m = findMerchant(mid);
  const meta = state.baselineMeta[mid] = state.baselineMeta[mid] || {};
  if (meta.inFlight) return;
  if (!meta.recordId) meta.recordId = recordIdFor(m, 'baseline');
  if (!meta.confirmedAt) meta.confirmedAt = nowStamp();
  const channels = {};
  const sent = {};
  CORE.forEach((ch) => {
    const b = state.baselines[`${mid}:${ch}`];
    if (!b || b.pendingAI || b.finalOrders === undefined || b.finalGmv === undefined) return;
    const c = { aiOrders: b.aiOrders ?? null, aiGmv: b.aiGmv ?? null,
      finalOrders: b.finalOrders, finalGmv: b.finalGmv,
      edited: !!(b.editedOrders || b.editedGmv), conf: b.conf ?? null,
      screen: (b.screen || '').slice(0, 400), zero: !!b.zero, marks: b.marks || [] };
    if (b.photoDirty && b.photoUrl) c.photo = b.photoUrl;
    else if (b.photoLink) c.photoLink = b.photoLink;
    channels[ch] = c;
    sent[ch] = b;
  });
  if (!Object.keys(channels).length) { toast('Shoot at least one screen first'); return; }
  meta.inFlight = true;
  meta.error = null;
  updateSaveBtn();

  const finish = (err, resp) => {
    meta.inFlight = false;
    if (err) {
      meta.error = err;
      toast(`❗ ${m.brand} baseline NOT saved — ${err}. Tap the red card to retry.`);
      if (!$('view-checklist').classList.contains('hidden')) renderChecklist();
      updateSaveBtn();
    } else {
      meta.saved = true; meta.error = null;
      Object.entries(resp.photoLinks || {}).forEach(([ch, link]) => {
        const b = sent[ch];
        if (b && link) { b.photoLink = link; b.photoDirty = false; b.photoUrl = undefined; b._dirty = false; }
      });
      Object.values(sent).forEach((b) => { b._dirty = false; });
      toast(`${m.brand} baseline saved ✓ — deducted automatically tonight`);
      renderChecklist();
      show('view-checklist');
    }
  };

  const payload = { recordId: meta.recordId, recordType: 'baseline', salesDate: state.salesDate,
    confirmedAt: meta.confirmedAt, staffName: state.staff.name, staffId: state.staff.id || '',
    site: m.site, siteName: state.site.name, kitchen: m.kitchen, brand: m.brand,
    sfdcId: m.sfdcId, merchantType: m.type || '', kitchenStatus: 'Operated',
    channels, notes: '' };
  try {
    finish(null, await postRecord(payload));
  } catch (e) {
    finish(e.name === 'AbortError' ? 'timed out after 90s' : e.message, null);
  }
}

$('btn-save').onclick = () => {
  const { m, mode, offset, from } = state.current;
  if (mode === 'baseline') {
    const meta = state.baselineMeta[m.id] || {};
    if (meta.saved && !baselineDirty(m.id) && !meta.error) { renderChecklist(); show('view-checklist'); return; }
    saveBaseline(m.id);
    return;
  }
  const rec = curRec();
  if (offset) {
    if (!coreReady()) return;
    const doAmend = () => saveAmend(m.id, offset, from);
    if (rec.status !== 'Operated' && recHasChannelData(rec)) {
      askConfirm(`Save as “${rec.status}”?`,
        `The readings recorded for ${m.brand} on ${dayLabel(offset)} (${channelSummaryText(rec)}) will be cleared. `
        + 'Previous values stay in the audit log, and replaced photos go to the Drive trash.',
        `Yes, save as ${rec.status}`, doAmend);
      return;
    }
    doAmend();
    return;
  }
  if (!coreReady() && photosCaptured()) {
    // Snap & go: photos in, reads still running — park as draft and move on.
    rec.draft = true;
    toast(`${m.brand} parked ⏳ — confirm when readings are ready`);
    renderChecklist();
    show('view-checklist');
    return;
  }
  if (!coreReady()) return;
  const noPhoto = rec.status === 'Operated' ? missingPhotos() : [];
  const doSave = () => {
    saveRecord(m.id);
    if (noPhoto.length) toast(`Saving — flagged: no photo for ${noPhoto.map((c) => CH_META[c].name).join(', ')}`);
    renderChecklist();
    show('view-checklist');
  };
  if (rec.status !== 'Operated' && recHasChannelData(rec)) {
    askConfirm(`Save as “${rec.status}”?`,
      `Tonight's readings (${channelSummaryText(rec)}) will be cleared from ${m.brand}'s record. `
      + 'Previous values stay in the audit log, and replaced photos go to the Drive trash.',
      `Yes, save as ${rec.status}`, doSave);
    return;
  }
  doSave();
};

/* ---------- confirm sheet + logout guard ---------- */
function askConfirm(title, detail, yesLabel, onYes) {
  $('convert-title').textContent = title;
  $('convert-detail').textContent = detail;
  $('convert-yes-label').textContent = yesLabel;
  $('convert-overlay').classList.remove('hidden');
  $('convert-yes').onclick = () => { $('convert-overlay').classList.add('hidden'); onYes(); };
  $('convert-cancel').onclick = () => $('convert-overlay').classList.add('hidden');
}

function logoutRisks() {
  const list = unsavedRecords();
  state.merchants.filter((m) => !m.disabled).forEach((m) => {
    const r = state.records[m.id];
    if (r && r.draft && !r.saved && !r.inFlight && !saveFailed(r)) list.push({ m, kind: 'draft' });
  });
  return list;
}
function attemptLogout() {
  const risks = logoutRisks();
  if (!risks.length) { logout(); return; }
  $('guard-list').textContent = risks.map((u) =>
    `${u.m.kitchen} ${u.m.brand}${u.kind === 'baseline' ? ' (baseline)' : u.kind === 'draft' ? ' (not confirmed yet — open it and confirm)' : ''}`
  ).join('  ·  ');
  $('guard-overlay').classList.remove('hidden');
}
$('guard-cancel').onclick = () => $('guard-overlay').classList.add('hidden');
$('guard-retry').onclick = () => {
  $('guard-overlay').classList.add('hidden');
  unsavedRecords().forEach((u) => (u.kind === 'baseline' ? saveBaseline(u.m.id) : saveRecord(u.m.id)));
};
$('guard-logout').onclick = () => { $('guard-overlay').classList.add('hidden'); logout(); };

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
$('ab-create').onclick = async () => {
  const brand = $('ab-brand').value.trim();
  const overnight = $('ab-overnight').checked;
  const btn = $('ab-create');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  /* Appends a real SFDC ID Map row: B–E values, F–H formulas copied from the
     row above, I = the outside-hours checkbox. Same row the sheet-side flow uses. */
  try {
    const r = await fetch(`${CONFIG.apiBase}/api/merchants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility: state.site.id, kitchen: ab.customer.kitchen,
        brand, sfdcId: ab.customer.oppId, overnight }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    DATA.merchants.push({
      site: d.merchant.facility, kitchen: d.merchant.kitchen, brand: d.merchant.brand,
      sfdcId: d.merchant.sfdcId, overnight: d.merchant.overnight || undefined,
      aigens: d.merchant.aigens || undefined,
      type: d.merchant.kitchen === 'CR' ? 'Cloud Retail' : 'Kitchen',
    });
    state.merchants = siteMerchants(state.site.id);
    toast(`${brand} added ✓ — row ${d.row} in SFDC ID Map${overnight ? ' · 🌙 morning GMV required' : ''}`);
    renderChecklist();
    show('view-checklist');
  } catch (e) {
    toast(`❗ Brand NOT created — ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create brand record';
  }
};

/* ---------- boot ---------- */
{
  const b = $('mode-badge');
  b.textContent = 'LIVE · AI readings + saves to the GMV sheet — always double-check against the device screen';
  b.style.background = 'var(--green-bg)';
  b.style.color = 'var(--green)';
}
renderPinPad();
show('view-login');
loadCatalog();
