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

/* ---------- staff session (PIN sessionization, Ernest 3 Aug) ----------
   Login hands back a signed token; every write and data read carries it, so
   the server refuses requests that never passed a PIN. Kept in sessionStorage:
   survives a tab reload (the mid-round eviction case) but not a device handover.
   401 anywhere -> drop the token and send the user back to the PIN screen. */
const SESSION_KEY = 'smartgmv.session';
function setSession(tok, staffId) {
  try {
    if (tok) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ tok, staffId }));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch (e) { /* private mode: session lives in memory only */ }
  state.token = tok || '';
}
function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
async function api(path, opts) {
  const o = { ...(opts || {}) };
  o.headers = { ...(o.headers || {}) };
  if (state.token) o.headers.Authorization = `Bearer ${state.token}`;
  const r = await fetch(`${CONFIG.apiBase}${path}`, o);
  if (r.status === 401) {
    setSession('');
    if (state.staff) {
      toast('Session expired — enter your PIN again');
      loginStep('pin');
      show('view-login');
    }
    throw new Error('session expired');
  }
  return r;
}
/* Photo proxy is an <img src>, so it cannot send a header — the token rides
   as a query param there (same signature check server-side). */
function photoUrl(id) {
  return `${CONFIG.apiBase}/api/photo/${id}?t=${encodeURIComponent(state.token || '')}`;
}

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
        grabOn: m.grabOn !== false, fpOn: m.fpOn !== false,
        catering: !!m.catering,          // shows this brand in the Catering entry
        siteName: m.site,                // long facility name, for catering records
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

/* ---------- who used this device last (device-local) ----------
   Ernest 30 Jul: staff shouldn't hunt for their own name every night. We keep
   up to three recent sign-ins per device — enough to cover a shared site phone
   rotation, invisible on a personal one. The PIN is NEVER stored: identity
   still comes from the PIN, so a resume card on a shared phone saves the owner
   a scroll and gets a stranger exactly nowhere. */
const RECENT_KEY = 'smartgmv.recent';
const RECENT_MAX = 3;

function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((e) => e && e.id && e.site) : [];
  } catch (e) {
    return [];                       // private mode / storage blocked
  }
}
function writeRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch (e) { /* nothing to do — the feature is a convenience */ }
}
function rememberUser() {
  if (!state.staff || !state.site) return;
  const entry = { id: state.staff.id, name: state.staff.name,
    site: state.site.id, siteName: state.site.name, at: new Date().toISOString() };
  // one slot per person: their latest site wins, so a cross-site helper never
  // occupies two of the three cards
  writeRecent([entry, ...readRecent().filter((e) => e.id !== entry.id)]);
}
function forgetUser(id) {
  writeRecent(readRecent().filter((e) => e.id !== id));
}
function lastUsedLabel(iso) {
  const then = new Date(iso);
  if (isNaN(then)) return '';
  const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(new Date()) - day(then)) / 86400000);
  if (days <= 0) return Date.now() - then.getTime() < 2 * 3600e3 ? 'just now' : 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return 'a while ago';
}

const state = {
  token: (loadSession() || {}).tok || '',   // survives a tab reload mid-round
  site: null, staff: null, pin: '',
  pinMode: 'verify',                // verify | create | confirm (first-login PIN claim)
  pinFirst: '',                     // first entry while confirming a new PIN
  salesDate: null,                  // business date, frozen at login (before 06:00 = yesterday)
  merchants: [],                    // merchants of the selected site
  records: {},                      // merchantId -> record (today)
  history: {},                      // dayOffset -> { merchantId -> record } (past days, editable)
  baselines: {},                    // `${mid}:${ch}` -> baseline reading
  // `saved` means the SERVER acknowledged the row — a shot sitting in phone
  // memory is not evidence yet, so nothing keys off local state alone.
  baselineMeta: {},                 // merchantId -> { recordId, confirmedAt, saved, inFlight, error }
  hydrateError: null,               // set when today's saved records could not be loaded
  current: null,                    // { m, mode, offset, from }
  viewer: null,                     // { ch, pendingBox }
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
    .filter((m) => (siteId === CATERING_SITE ? m.catering : m.site === siteId))
    .map((m, i) => ({
      ...m,
      id: `${m.site}-${m.kitchen}-${i}`,
      channels: channelsFor(siteId),
    }))
    .sort((a, b) => (a.kitchen === 'CR') - (b.kitchen === 'CR') || a.kitchen.localeCompare(b.kitchen, undefined, { numeric: true }));
}
const CATERING_SITE = 'CATERING';   // pseudo-facility: catering has its own entry
function channelsFor(siteId) {
  if (siteId === CATERING_SITE) return ['catering'];   // one line, nothing else
  const ch = ['grab', 'fp', 'others', 'catering'];
  if (siteId === 'S12') ch.push('dinein', 'promodinein');
  return ch;
}
/* ---------- inline icon set (style pack A, 29 Jul): consistent line icons
   replace emoji in rendered UI. em-sized, inherits color — drop-in for HTML.
   Toast/button plain-text strings keep unicode marks (textContent paths). */
const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>',
  chevL: '<path d="M14 6l-6 6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tag: '<path d="M3 12l9-9h9v9l-9 9z"/><circle cx="16.5" cy="7.5" r="1.4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5l2 2M17.5 17.5l2 2M19.5 4.5l-2 2M6.5 17.5l-2 2"/>',
  moon: '<path d="M20.4 14.5A8.4 8.4 0 1 1 9.5 3.6a7 7 0 0 0 10.9 10.9z"/>',
  loader: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  alert: '<path d="M12 3L2 20h20z"/><path d="M12 10v4"/><path d="M12 17.2v.2"/>',
  bang: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5v.2"/>',
  dot: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
  hand: '<path d="M12 21c-4 0-6-2.5-6-6V9.5a1.5 1.5 0 0 1 3 0V6a1.5 1.5 0 0 1 3 0v5"/><path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V12"/><path d="M15 12a1.5 1.5 0 0 1 3 1v2c0 4-2 6-6 6"/>',
  receipt: '<path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z"/><path d="M9 8h6M9 12h6"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
};
function ic(name, cls) {
  return `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const CORE = ['grab', 'fp'];                      // always expanded, required
/* Per-merchant channel switches (ID Map cols K/L, Ernest 30 Jul): a brand that
   only sells on one platform shows only that card and only it is required. */
function coreFor(m) {
  return CORE.filter((ch) => (ch === 'grab' ? m.grabOn !== false : m.fpOn !== false));
}
const OPTIONAL = ['others', 'catering', 'dinein', 'promodinein']; // collapsed, default 0
const AI_CHANNELS = ['grab', 'fp'];               // only these call the AI engine (cost control)

/* ---------- native camera / photo picker ----------
   TWO explicit inputs, never one "the OS will offer both" input (Ernest's
   video, 30 Jul): on Android 13+ Chrome routes accept="image/*" straight to
   the system photo picker, which has NO camera entry — staff standing in
   front of the tablet could only browse old shots. `capture` opens the
   camera; the plain input keeps the burst-shoot-then-upload path that the
   29 Jul camera-only build broke. Each gets its own button. */
function makeInput(opts) {
  const el = document.createElement('input');
  el.type = 'file';
  el.accept = 'image/*';
  // setAttribute, NOT el.capture = … — the property assignment does not reach
  // the HTML attribute the browser actually reads (caught in QA, 30 Jul)
  if (opts.capture) el.setAttribute('capture', 'environment');
  if (opts.multiple) el.multiple = true;
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

const fileInput = makeInput({});                    // gallery / files
const cameraInput = makeInput({ capture: true });   // straight to the camera
let pendingChannel = null;
const takeSingle = (input) => input.onchange = () => {
  const file = input.files && input.files[0];
  const ch = pendingChannel;
  input.value = '';
  if (!file || !ch) return;
  const reader = new FileReader();
  reader.onload = () => downscale(reader.result, 1600, 0.85).then((jpeg) => runExtraction(ch, jpeg));
  reader.readAsDataURL(file);
};
takeSingle(fileInput);
takeSingle(cameraInput);
function openPicker(ch) { pendingChannel = ch; fileInput.click(); }
function openCamera(ch) { pendingChannel = ch; cameraInput.click(); }

/* Pending-pickup orders: burst-shoot all the locker orders in the native
   camera and add them in one go (gallery, multi-select), or shoot them one at
   a time from here (camera) — same two-path rule as the summary shot. */
const extrasInput = makeInput({ multiple: true });
const extrasCamera = makeInput({ capture: true });
let pendingExtrasChannel = null;
const takeExtras = (input) => input.onchange = () => {
  const files = [...(input.files || [])];
  const ch = pendingExtrasChannel;
  input.value = '';
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
takeExtras(extrasInput);
takeExtras(extrasCamera);
function openExtrasPicker(ch) { pendingExtrasChannel = ch; extrasInput.click(); }
function openExtrasCamera(ch) { pendingExtrasChannel = ch; extrasCamera.click(); }

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
  // Long failure messages need reading time (~55ms/char, 2.6–8s); tap to dismiss.
  t._h = setTimeout(() => t.classList.add('hidden'), Math.min(8000, Math.max(2600, msg.length * 55)));
  t.onclick = () => { clearTimeout(t._h); t.classList.add('hidden'); };
}

/* ---------- login ---------- */
/* Resume cards, newest first. Everything is re-validated against the live
   catalog at tap time — a deactivated, renamed or removed person must not be
   resurrected from a phone's memory. */
function renderResume() {
  const wrap = $('resume-wrap');
  if (!wrap || !DATA) return;
  const live = readRecent()
    .map((e) => ({ e, p: DATA.staff.find((x) => x.id === e.id),
                   s: DATA.sites.find((x) => x.id === e.site) }))
    .filter((r) => r.p && r.s);
  if (!live.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML =
    `<label class="field-label">${live.length > 1 ? 'Recent on this device' : 'Continue as'}</label>`
    + live.map(({ e, p, s }) => `<button class="staff-btn resume" data-id="${esc(e.id)}">
        <span class="avatar">${esc(p.name[0])}</span>
        <span class="resume-txt"><b>${esc(p.name)}</b>
          <small>${esc(s.name)} · ${esc(s.id)} · last used ${esc(lastUsedLabel(e.at))}</small></span>
        <span class="resume-x" data-forget="${esc(e.id)}" role="button" aria-label="Forget ${esc(p.name)}">✕</span>
      </button>`).join('')
    + '<div class="resume-sep"></div>';

  wrap.querySelectorAll('.staff-btn.resume').forEach((b) => b.onclick = (ev) => {
    const id = b.dataset.id;
    if (ev.target.closest('[data-forget]')) {      // ✕ never signs anyone in
      ev.stopPropagation();
      forgetUser(id);
      renderResume();
      toast('Removed from this device');
      return;
    }
    const row = live.find((r) => r.e.id === id);
    if (!row) { renderResume(); return; }
    state.site = row.s;
    state.staffQuery = '';
    $('staff-search').value = '';
    renderStaff();                                 // so "Not you?" lands on a built list
    proceedToPin(row.p);                           // fresh catalog record: name + needsPin
  });
}

function renderSites() {
  renderResume();
  $('site-grid').innerHTML = DATA.sites.map((s) => {
    const n = s.id === CATERING_SITE
      ? DATA.merchants.filter((m) => m.catering && !m.disabled).length
      : DATA.merchants.filter((m) => m.site === s.id).length;
    return `<button class="site-btn" data-site="${esc(s.id)}">${esc(s.name)}<small>${esc(s.id)} · ${n} merchants</small></button>`;
  }).join('');
  $('site-grid').querySelectorAll('.site-btn').forEach((b) => b.onclick = () => {
    state.site = DATA.sites.find((s) => s.id === b.dataset.site);
    renderStaff();
    loginStep('staff');
  });
}
/* Same "recent on this device" shortcut, but on the staff step: the site is
   already picked, so tapping a name goes straight to their PIN for THIS site —
   no scrolling a long roster when someone helps out at another facility
   (Ernest 3 Aug). */
function renderStaffResume() {
  const wrap = $('staff-resume');
  if (!wrap || !DATA) return;
  const live = readRecent()
    .map((e) => ({ e, p: DATA.staff.find((x) => x.id === e.id) }))
    .filter((r) => r.p);
  if (!live.length || state.staffQuery) { wrap.innerHTML = ''; return; }
  // Same shape as the roster rows below: the site is already chosen and named in
  // the header, so repeating it here would be noise (Ernest 3 Aug).
  wrap.innerHTML = `<label class="field-label">Continue as</label>`
    + live.map(({ e, p }) => `<button class="staff-btn" data-sr="${esc(e.id)}">
        <span class="avatar">${esc(p.name[0])}</span>${esc(p.name)}
      </button>`).join('')
    + '<div class="resume-sep"></div>';
  wrap.querySelectorAll('[data-sr]').forEach((b) => b.onclick = () => {
    const p = DATA.staff.find((x) => x.id === b.dataset.sr);
    if (p) proceedToPin(p);                   // site stays as chosen
  });
}
function renderStaff() {
  /* Home Site is a priority list (Ernest 29 Jul): first = main site, the rest
     = 2nd/3rd/… priority. Roster order at a site: its own team, then people
     who cover it (by priority), then everyone else. */
  const sid = state.site.id;
  const prio = (p) => {
    const list = (p.homeSites && p.homeSites.length) ? p.homeSites : (p.home ? [p.home] : []);
    const i = list.indexOf(sid);
    return i === -1 ? Infinity : i;
  };
  const q = (state.staffQuery || '').trim().toLowerCase();
  const hit = (p) => !q || p.name.toLowerCase().includes(q);
  // Facility priority decides the group; inside a group, A→Z so a name is
  // findable by eye without reading every row (Ernest 3 Aug).
  const az = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const main = DATA.staff.filter((p) => prio(p) === 0 && hit(p)).sort(az);
  const cover = DATA.staff.filter((p) => prio(p) > 0 && prio(p) !== Infinity && hit(p))
    .sort((a, b) => prio(a) - prio(b) || az(a, b));
  const others = DATA.staff.filter((p) => prio(p) === Infinity && hit(p)).sort(az);
  const none = q && !main.length && !cover.length && !others.length;
  const btn = (p) => `<button class="staff-btn" data-id="${esc(p.id)}"><span class="avatar">${esc(p.name[0])}</span>${esc(p.name)}
      ${p.partTimer ? '<span class="tag pt" style="margin-left:auto">PART-TIMER</span>' : (p.home && p.home !== sid ? `<span class="tag pt" style="margin-left:auto">${esc(p.home)}</span>` : '')}</button>`;
  renderStaffResume();
  $('staff-list').innerHTML =
    (none ? `<p class="ab-note">No name matches “${esc(state.staffQuery.trim())}” — new here? Register below.</p>` : '') +
    (main.length ? `<div class="roster-group">${esc(state.site.name)} team</div>` + main.map(btn).join('') : '') +
    (cover.length ? `<div class="roster-group">Also covers ${esc(state.site.name)}</div>` + cover.map(btn).join('') : '') +
    (others.length ? `<div class="roster-group">Other sites / part-timers</div>` + others.map(btn).join('') : '') +
    `<button class="staff-btn" id="btn-register"><span class="avatar">${ic('plus')}</span>I'm not on the list</button>`;
  $('staff-list').querySelectorAll('.staff-btn[data-id]').forEach((b) => b.onclick = () => {
    proceedToPin(DATA.staff.find((p) => p.id === b.dataset.id));
  });
  $('btn-register').onclick = openRegister;
}
$('staff-search').oninput = () => {
  state.staffQuery = $('staff-search').value;
  renderStaff();
};

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
  setRegEmp('part');
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
/* Employment choice (Ernest 30 Jul): part-timer or full-time, written to the
   Staff tab's Part-timer column. Defaults to part-timer (the common case). */
let regEmp = 'part';
function setRegEmp(v) {
  regEmp = v;
  $('reg-emp').querySelectorAll('.chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.emp === v));
}
$('reg-emp').querySelectorAll('.chip').forEach((c) => c.onclick = () => setRegEmp(c.dataset.emp));
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
        partTimer: regEmp !== 'full',
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
               homeSites: d.existing.homeSites || [], needsPin: !!d.existing.needsPin });
      };
      $('dup-new').onclick = () => { $('dup-overlay').classList.add('hidden'); submitRegistration(true); };
      $('dup-cancel').onclick = () => $('dup-overlay').classList.add('hidden');
      return;
    }
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    // PIN was chosen in the form and is already on the server — straight in.
    DATA.staff.push(d.staff);
    if (!d.token) throw new Error('The app was just updated — log in once more');
    setSession(d.token, d.staff && d.staff.id);
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
function setPinBusy(b) {
  // The pad swallows keys while checking — say so, or a slow network reads
  // as a dead keypad to a first-day part-timer.
  pinChecking = b;
  const el = $('pin-sub');
  if (b) {
    el.innerHTML = '<span class="spinner sm"></span> Checking…';
    el.classList.remove('hidden');
  } else if (el.textContent.includes('Checking')) {
    el.classList.add('hidden');
  }
}
function renderPinPad() {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  $('pin-pad').innerHTML = keys.map((k) => k === '' ? '<span></span>' : `<button class="pin-key" data-k="${k}">${k}</button>`).join('');
  $('pin-pad').querySelectorAll('.pin-key').forEach((b) => b.onclick = () => pinKey(b.dataset.k));
}
function pinKey(k) {
  {
    if (pinChecking) return;
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
  }
}
/* Hardware keyboard on the PIN screen (Ernest 30 Jul): digits + Backspace,
   desktop browsers and paired keyboards. */
document.addEventListener('keydown', (e) => {
  if ($('login-step-pin').classList.contains('hidden')) return;
  if (!$('view-login') || $('view-login').classList.contains('hidden')) return;
  if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pinKey(e.key); }
  else if (e.key === 'Backspace') { e.preventDefault(); pinKey('⌫'); }
});
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
  setPinBusy(true);
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
    if (!d.token) throw new Error('The app was just updated — log in once more');
    setSession(d.token, d.staff && d.staff.id);
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
    setPinBusy(false);
  }
}
/* PINs are checked by the server against the Staff tab. The app never sees
   anyone's stored PIN; a blank cell routes to the create-PIN flow instead. */
async function verifyPin() {
  setPinBusy(true);
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
    // Store the session BEFORE entering the app: enterApp() immediately reads
    // today's records, and without the token that read is refused (this line
    // was missing on 3 Aug — a fresh PIN login landed on "session expired").
    if (!d.token) throw new Error('no session returned');
    setSession(d.token, d.staff && d.staff.id);
    state.staff = d.staff;
    enterApp();
  } catch (e) {
    if (e.message === 'no session returned') {
      pinFail('The app was just updated — enter your PIN once more');
      return;
    }
    pinFail(`Could not verify (${e.message}) — try again`);
  } finally {
    setPinBusy(false);
  }
}
document.querySelectorAll('.back-link').forEach((b) => b.onclick = () => loginStep(b.dataset.back));

/* ---------- checklist ---------- */
function enterApp() {
  rememberUser();     // single funnel for PIN verify, PIN claim and registration
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
let hydrateSeq = 0;
async function hydrateToday() {
  const seq = ++hydrateSeq;   // logout/login during a slow fetch must not clear the new session's notice
  state.hydrating = true;
  try { await hydrateTodayInner(); }
  finally {
    if (seq === hydrateSeq) {
      state.hydrating = false;
      if (!$('view-checklist').classList.contains('hidden')) renderChecklist();
    }
  }
}
async function hydrateTodayInner() {
  // the catering entry is not a daily per-site round — nothing to rehydrate
  if (state.site && state.site.id === CATERING_SITE) return;
  try {
    const r = await api(`/api/records/today?site=${state.site.id}&date=${state.salesDate}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { records } = await r.json();
    records.forEach((sr) => {
      const m = state.merchants.find((x) => x.kitchen === sr.kitchen && x.brand === sr.brand);
      if (!m) return;
      if (sr.recordType === 'baseline') {
        state.baselineMeta[m.id] = { recordId: sr.recordId, saved: true,
          status: sr.status || 'Operated', savedStatus: sr.status || 'Operated' };
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
function merchantDone(m) {
  const r = state.records[m.id];
  if (!r || !r.saved) return false;
  return true;
}
function baselineReading(m) {
  return coreFor(m).some((ch) => state.baselines[`${m.id}:${ch}`]?.pendingAI);
}
function baselineHasShots(m) {
  return coreFor(m).some((ch) => channelHasData(state.baselines[`${m.id}:${ch}`]));
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
    state.hydrating ? '⏳ Checking the server for records already saved today…'
    : failed ? `❗ ${failed} record${failed > 1 ? 's' : ''} not saved — tap the red card to retry`
    : state.hydrateError ? '⚠ Could not check the server for saved records — reload before capturing'
    : all.length === 0 ? 'No delivery merchants at this site yet'
    : doneCount === all.length ? 'All done — great round! 🎉'
    : `${all.length - doneCount} merchants left · tap to capture`;

  // S12's dine-in arrives once a month as one sheet — its own entry, above the round
  const diWrap = $('dinein-entry');
  if (diWrap) {
    const show12 = state.site.id === 'S12';
    diWrap.classList.toggle('hidden', !show12);
    if (show12) diWrap.onclick = openDinein;
  }
  $('sec-morning-label').classList.toggle('hidden', overnight.length === 0);
  $('list-morning').innerHTML = overnight.map((m) => {
    const bm = state.baselineMeta[m.id] || {};
    const reading = baselineReading(m);
    const st = bm.saved ? ['done',
        bm.savedStatus === 'Not operated' ? '✓ Not operated'
        : bm.savedStatus === 'No Sales' ? '✓ No overnight sales'
        : '✓ Opening GMV recorded']
      : bm.inFlight ? ['pending', '⬆ saving…']
      : bm.error ? ['flagred', ic('bang') + ' not saved — tap to retry']
      : reading ? ['pending', ic('loader') + ' AI reading…']
      : baselineHasShots(m) ? ['flag', ic('dot') + ' confirm opening GMV']
      : ['flag', ic('alert') + ' Opening GMV missing'];
    return `<div class="merchant-card ${bm.error ? 'failed' : ''}" data-id="${esc(m.id)}" data-mode="baseline">
      <div class="m-kitchen">${esc(m.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
        <div class="m-tags"><span class="tag h24">24 HR</span></div></div>
      <div class="m-status ${st[0]}">${st[1]}</div>
    </div>`;
  }).join('');

  if (all.length === 0) {
    $('list-evening').innerHTML = state.merchants.length
      ? `<div class="empty-note">${ic('tag')} All brands at this site are disabled.<br>
        <small>Re-enable them via ${ic('menu')} → Manage brands — nothing needs to be re-created.</small></div>`
      : `<div class="empty-note">${ic('archive')} No merchants at this site yet.<br>
        <small>Add the first one via ${ic('menu')} → Add new brand — it appears here right away.</small></div>`;
    return;
  }
  $('list-evening').innerHTML = all.map((m) => {
    const r = state.records[m.id];
    const done = merchantDone(m);
    let status = '<span class="m-status pending">○ not captured</span>';
    if (r && r.inFlight) {
      status = '<span class="m-status pending">⬆ saving…</span>';
    } else if (r && saveFailed(r)) {
      status = '<span class="m-status flagred">' + ic('bang') + ' not saved — tap to retry</span>';
    } else if (done && r.status === 'Operated') {
      const tot = Object.values(r.channels).reduce((s, c) =>
        s + Number(c.finalGmv ?? c.gmv ?? 0) + (c.extras || []).reduce((t, e) => t + Number(e.gmv || 0), 0), 0);
      status = `<div style="text-align:right"><div class="m-status done">✓ saved</div><div class="m-total">${money(tot)}</div></div>`;
    } else if (done) {
      status = `<span class="m-status done">✓ ${esc(r.status)}</span>`;
    } else if (r && r.draft) {
      status = (r.pending || 0) > 0
        ? '<span class="m-status pending">' + ic('loader') + ' AI reading…</span>'
        : '<span class="m-status flag">' + ic('dot') + ' confirm readings</span>';
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
  setSession('');
  state.staff = null;   // else beforeunload guards a session the user discarded
  state.pin = '';
  state.pinFirst = '';
  state.history = {};
  rv.loaded = false;
  rv.unmatched = {};
  paintPin();
  renderResume();       // the person who just logged out is now the top card
  loginStep('site');
  show('view-login');
}

/* ---------- menu ---------- */
$('btn-menu').onclick = () => $('menu-overlay').classList.remove('hidden');
$('menu-cancel').onclick = () => $('menu-overlay').classList.add('hidden');
$('menu-overlay').onclick = (e) => { if (e.target === $('menu-overlay')) $('menu-overlay').classList.add('hidden'); };
$('menu-logout').onclick = () => { $('menu-overlay').classList.add('hidden'); attemptLogout(); };
$('menu-pin').onclick = () => { $('menu-overlay').classList.add('hidden'); openPinChange(); };

/* ---------- change my PIN (Ernest 30 Jul) ---------- */
function pcValid() {
  const o = $('pc-old').value, n = $('pc-new').value, n2 = $('pc-new2').value;
  const mismatch = n.length === 4 && n2.length === 4 && n !== n2;
  const sameAsOld = n.length === 4 && o.length === 4 && n === o;
  $('pc-note').textContent = mismatch ? "The two new PINs don't match"
    : sameAsOld ? 'The new PIN is the same as the current one' : '';
  $('pc-note').classList.toggle('hidden', !mismatch && !sameAsOld);
  return /^\d{4}$/.test(o) && /^\d{4}$/.test(n) && n === n2 && n !== o;
}
function openPinChange() {
  ['pc-old', 'pc-new', 'pc-new2'].forEach((id) => { $(id).value = ''; });
  $('pc-note').classList.add('hidden');
  $('pc-submit').disabled = true;
  $('pc-submit').textContent = 'Change PIN';
  $('pinchange-overlay').classList.remove('hidden');
}
['pc-old', 'pc-new', 'pc-new2'].forEach((id) => {
  $(id).oninput = () => { $('pc-submit').disabled = !pcValid(); };
});
$('pc-cancel').onclick = () => $('pinchange-overlay').classList.add('hidden');
$('pc-submit').onclick = async () => {
  if (!pcValid()) return;
  $('pc-submit').disabled = true;
  $('pc-submit').textContent = 'Changing…';
  try {
    const r = await api('/api/staff/pin/change', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId: state.staff.id, oldPin: $('pc-old').value,
        newPin: $('pc-new').value }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    $('pinchange-overlay').classList.add('hidden');
    toast('PIN changed ✓ — use the new PIN from your next login');
  } catch (e) {
    $('pc-note').textContent = e.message;
    $('pc-note').classList.remove('hidden');
    $('pc-submit').disabled = false;
    $('pc-submit').textContent = 'Change PIN';
  }
};
$('menu-addbrand').onclick = () => { $('menu-overlay').classList.add('hidden'); openAddBrand(); };
$('menu-review').onclick = () => { $('menu-overlay').classList.add('hidden'); openReview(); };
$('menu-brands').onclick = () => { $('menu-overlay').classList.add('hidden'); openBrands(); };

/* ---------- manage brands (disable / re-enable, never delete) ---------- */
function openBrands() {
  $('mb-sub').textContent = `${state.site.name} · ${state.site.id}`;
  renderBrands();
  show('view-brands');
}
$('btn-brands-back').onclick = () => { backToChecklist(); };
function renderBrands() {
  const list = state.merchants;   // full roster incl. disabled, kitchen order
  $('mb-list').innerHTML = list.length ? list.map((m) => `
    <div class="mb-card ${m.disabled ? 'off' : ''}">
      <div class="mb-top">
        <div class="m-kitchen">${esc(m.kitchen)}</div>
        <div class="mb-name">${esc(m.brand)}</div>
        <button class="mb-state ${m.disabled ? 'off' : 'on'}" data-id="${esc(m.id)}"
          title="${m.disabled ? 'Disabled — tap to bring it back into capture' : 'Active — tap to hide it from new capture'}">${m.disabled ? 'Disabled' : 'Active'}</button>
      </div>
      <div class="mb-ctl">
        <div class="mb-switches">
          <button class="mb-ch ${m.grabOn !== false ? 'on' : ''}" data-ch="grab" data-id="${esc(m.id)}">Grab</button>
          <button class="mb-ch ${m.fpOn !== false ? 'on' : ''}" data-ch="fp" data-id="${esc(m.id)}">foodpanda</button>
          <button class="mb-ch ${m.catering ? 'on' : ''}" data-ch="catering" data-id="${esc(m.id)}">Catering</button>
          <button class="mb-moon ${m.overnight ? 'on' : ''}" data-id="${esc(m.id)}" title="Operates outside 10 am – 10 pm — needs a daily opening GMV shot">${ic('moon')} 24 h</button>
        </div>
      </div>
    </div>`).join('') : `<p class="ab-note">No brands at ${esc(state.site.name)} (${esc(state.site.id)}) yet — this list fills up once the first brand is added via ☰ → Add new brand.</p>`;

  /* Both toggles write the SFDC ID Map for real (col I Overnight / col J
     Disabled): optimistic flip, revert loudly if the server says no. */
  const patchFlag = async (m, body, revert) => {
    try {
      const r = await api('/api/merchants', {
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
  $('mb-list').querySelectorAll('.mb-ch').forEach((b) => b.onclick = async () => {
    const m = findMerchant(b.dataset.id);
    const src2 = DATA.merchants.find((x) => x.site === m.site && x.kitchen === m.kitchen && x.brand === m.brand);
    const ch = b.dataset.ch;
    const key = ch === 'grab' ? 'grabOn' : ch === 'fp' ? 'fpOn' : 'catering';
    const next = ch === 'catering' ? !m.catering : !(m[key] !== false);
    if (ch !== 'catering') {
      const otherOn = ch === 'grab' ? m.fpOn !== false : m.grabOn !== false;
      if (!next && !otherOn) { toast('A brand needs at least one delivery channel — disable the brand instead'); return; }
    }
    m[key] = src2[key] = next;
    renderBrands();
    try {
      const r = await api('/api/merchants', { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facility: m.site, kitchen: m.kitchen, brand: m.brand, [ch]: next }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      toast(`${m.brand}: ${ch === 'grab' ? 'GrabFood' : ch === 'fp' ? 'foodpanda' : 'Catering'} ${next ? 'on' : 'off'} ✓`);
    } catch (e) {
      m[key] = src2[key] = !next;
      renderBrands();
      toast(`❗ Could not update ${m.brand} — ${e.message}`);
    }
  });
  $('mb-list').querySelectorAll('.mb-moon').forEach((b) => b.onclick = () => {
    const m = findMerchant(b.dataset.id);
    const src = DATA.merchants.find((x) => x.site === m.site && x.kitchen === m.kitchen && x.brand === m.brand);
    const next = !m.overnight;
    m.overnight = src.overnight = next || undefined;
    renderBrands();
    toast(next ? `${m.brand} marked outside-hours 🌙 — daily opening GMV shot needed`
               : `${m.brand} back to normal hours`);
    patchFlag(m, { overnight: next }, () => { m.overnight = src.overnight = !next || undefined; });
  });
  $('mb-list').querySelectorAll('.mb-state').forEach((b) => b.onclick = () => {
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
$('btn-review-back').onclick = () => { backToChecklist(); };

/* Pull the last 6 business days for this site in ONE call and bucket them by
   offset. Baseline rows are kept separately for display; rows whose brand no
   longer matches the catalog (renamed in the sheet) surface as read-only. */
async function loadHistory(force) {
  if (rv.loading || (rv.loaded && !force)) return;
  rv.loading = true;
  rv.error = null;
  renderReview();
  try {
    const r = await api(`/api/records?site=${state.site.id}`
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
      + (r.billingFlag && r.billingFlag !== 'OK' ? `<span class="tag flagwarn">${ic('alert')} ${esc(r.billingFlag)}</span>` : '');
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
    const chParts = Object.entries(sr.channels)
      .map(([ch, c]) => `${CH_META[ch].name} ${c.orders || 0} · ${money(Number(c.gmv || 0))}`).join(' · ');
    const parts = [sr.status, chParts].filter(Boolean).join(' — ');
    return `<div class="merchant-card rv-base"><div class="m-kitchen">${ic('sun')}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)} — opening GMV</div>
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
  promodinein: { name: '(Promo) Dine-in', cls: 'dinein', logo: 'P', hint: 'POS screenshot' },
};

function findMerchant(mid) { return state.merchants.find((x) => x.id === mid); }

function openCapture(mid, mode, offset = 0, from = 'checklist') {
  const m = findMerchant(mid);
  state.current = { m, mode, offset, from };
  const store = recordsFor(offset);
  if (!store[mid]) store[mid] = { status: 'Operated', channels: {}, expanded: {} };

  const cateringMode = state.site.id === CATERING_SITE;
  if (cateringMode && !store[mid].salesDate) store[mid].salesDate = state.salesDate;
  $('cap-merchant').textContent = m.brand;
  $('cap-sub').textContent = (cateringMode
      ? `Catering · ${m.site === CATERING_SITE ? 'third party' : m.site + ' ' + m.kitchen}`
      : `${state.site.id} · ${m.kitchen} · ${m.type}`)
    + (mode === 'baseline' ? ' · ☀️ opening GMV' : '')
    + (offset ? ` · ✏️ editing ${dayLabel(offset)}` : '');

  renderStatusChips();
  renderCateringDate(cateringMode);
  renderBaselineBanner();
  renderChannelCards();
  updateSaveBtn();
  show('view-capture');
}
$('btn-capture-back').onclick = () => {
  if (state.current && state.current.from === 'review') { renderReview(); show('view-review'); }
  else { backToChecklist(); }
};

function baseStatus(mid) { return state.baselineMeta[mid]?.status || 'Operated'; }

/* Catering is logged for a staff-chosen sales date — it may be recorded days
   later, or at month end (Ernest 3 Aug), so the date is an explicit field. */
function renderCateringDate(on) {
  const el = $('catering-date-row');
  if (!on) { el.classList.add('hidden'); return; }
  const rec = curRec();
  el.classList.remove('hidden');
  $('cat-date').value = rec.salesDate || state.salesDate;
  $('cat-date').max = state.salesDate;
  $('cat-date').onchange = () => {
    const v = $('cat-date').value;
    if (!v) return;
    rec.salesDate = v;
    delete rec.recordId;          // the id embeds the date
    updateSaveBtn();
  };
}
function renderStatusChips() {
  const { m, mode } = state.current;
  // Catering asks no kitchen-status question: it is one logged figure for a
  // chosen sales date, not a statement about how the kitchen traded that day.
  if (state.site && state.site.id === CATERING_SITE) {
    $('status-row').classList.add('hidden');
    return;
  }
  $('status-row').classList.remove('hidden');
  const isBase = mode === 'baseline';
  const meta = isBase ? (state.baselineMeta[m.id] = state.baselineMeta[m.id] || {}) : null;
  const cur = isBase ? (meta.status || 'Operated') : curRec().status;
  /* Opening statuses (Ernest 30 Jul): No Sales = zero overnight sales (0/0
     opening recorded); Not operated = closed today, tonight auto-closes too.
     A merely locked kitchen at 10 am = just skip the opening; tonight flags. */
  const opts = isBase ? ['Operated', 'No Sales', 'Not operated']
                      : ['Operated', 'No Sales', 'Not operated', 'Locked'];
  $('status-chips').innerHTML = opts.map((o) =>
    `<button class="chip ${cur === o ? 'active' + (o === 'Operated' ? ' good' : '') : ''}" data-s="${o}">${o}</button>`).join('');
  $('status-chips').querySelectorAll('.chip').forEach((b) => b.onclick = () => {
    if (isBase) meta.status = b.dataset.s;
    else curRec().status = b.dataset.s;
    renderStatusChips();
    renderBaselineBanner();
    renderChannelCards();
    updateSaveBtn();
  });
}

function renderBaselineBanner() {
  const { m, mode, offset } = state.current;
  const el = $('baseline-banner');
  if (offset) { el.classList.add('hidden'); return; }   // past-day edits: plain edit, no baseline logic
  if (mode === 'baseline') {
    if (baseStatus(m.id) !== 'Operated') { el.classList.add('hidden'); return; }
    el.innerHTML = `${ic('sun')} <b>${esc(m.brand)} runs 24 hours.</b> Shoot each screen now — stored as today's opening GMV and deducted automatically tonight. Nothing is billed from this shot.`;
    el.classList.remove('hidden');
  } else if (m.overnight) {
    const bm = state.baselineMeta[m.id] || {};
    el.innerHTML = bm.inFlight
      ? `${ic('loader')} <b>Opening GMV is saving right now.</b> Give it a moment — the save button unlocks as soon as it lands.`
      : bm.saved && bm.savedStatus === 'Not operated'
      ? `${ic('alert')} <b>This morning was saved as “Not operated”.</b> If the shop did open, tonight's reading cannot auto-deduct — it will be flagged for supervisor review.`
      : bm.saved
      ? `${ic('moon')} 24-hr merchant — tonight's reading auto-deducts this morning's opening GMV. Both photos are kept as evidence.`
      : `${ic('alert')} <b>No opening GMV today.</b> Tonight's reading cannot auto-deduct — it will be flagged for supervisor review. You can also go back and shoot the opening GMV first.`;
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
  if (mode === 'baseline' && baseStatus(m.id) !== 'Operated') {
    wrap.innerHTML = `<div class="baseline-banner" style="margin-top:16px">${
      baseStatus(m.id) === 'No Sales'
        ? 'No overnight sales — a 0/0 opening is recorded, so tonight’s reading is billed in full. Just confirm below.'
        : `Not operating today — tonight’s record for ${esc(m.brand)} is closed off as “Not operated” automatically. If the shop opens later, open tonight’s card and change its status.`
    }</div>`;
    return;
  }
  const off = (ch) => CORE.includes(ch) && !coreFor(m).includes(ch);
  const chans = (mode === 'baseline' ? coreFor(m) : m.channels.filter((ch) => !off(ch)));
  wrap.innerHTML = chans.map((ch) => {
    const meta = CH_META[ch];
    const val = channelValue(ch) || {};
    // In the catering entry the catering card IS the form — never collapsed.
    const optional = OPTIONAL.includes(ch) && mode !== 'baseline'
      && !(state.site && state.site.id === CATERING_SITE && ch === 'catering');
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
      || (e.photoId ? photoUrl(esc(e.photoId)) : null);
    const stateIcon = e.pendingAI ? '<span class="spinner sm"></span>'
      : e.dup ? ic('alert') : e.conf === 'high' && !e.edited ? '✓' : e.edited ? '✎' : ic('alert');
    return `<div class="extra-row ${e.edited ? 'edited' : ''} ${e.dup ? 'dup' : ''}">
      ${thumb ? `<img class="x-thumb" src="${thumb}" alt="order ${i + 1}">` : '<span class="x-thumb file">' + ic('file') + '</span>'}
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
  /* Platform asymmetry (Ernest 29 Jul): Grab's Net sales excludes BOTH
     locker orders and out-for-delivery orders; foodpanda's All already
     includes out-for-delivery — adding those would double-bill. */
  const head = ch === 'grab' ? ic('loader') + ' Not in the summary yet' : ic('loader') + ' Pending rider pickup';
  const hint = ch === 'grab'
    ? "In the locker or out for delivery? Grab's Net sales does not include those yet — shoot each order's details page, one photo per order. Shoot the summary first."
    : "Waiting for a rider? Shoot each order's details page — one photo per order. Orders already out for delivery ARE counted in foodpanda's All, so don't add them.";
  return `<div class="extras-sec">
    <div class="extras-head">${head}
      <span class="extras-hint">${hint}</span></div>
    ${body}
    <div class="extras-add-row">
      <button class="extras-add" data-xadd="cam">${ic('camera')} Shoot one</button>
      <button class="extras-add" data-xadd="lib">${ic('image')} Add from gallery</button>
    </div>
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
      <div class="rf ${val.editedOrders ? 'edited' : ''} ${val.invalidOrders ? 'bad' : ''}"><label for="rf-${ch}-o">Orders</label><input id="rf-${ch}-o" inputmode="numeric" placeholder="0" value="${o !== undefined ? Number(o) : ''}" data-f="orders"></div>
      <div class="rf ${val.editedGmv ? 'edited' : ''} ${val.invalidGmv ? 'bad' : ''}"><label for="rf-${ch}-g">Sales (S$)</label><input id="rf-${ch}-g" inputmode="decimal" placeholder="0.00" value="${g !== undefined ? Number(g).toFixed(2) : ''}" data-f="gmv"></div>
    </div>`;
  const aiChannel = AI_CHANNELS.includes(ch);
  const statusLine = !aiChannel
    ? '<span class="screen-note">' + ic('file') + ' Evidence photo attached — numbers entered manually</span>'
    : val.pendingAI ? '<span class="screen-note"><span class="spinner sm"></span> AI reading in background — you can move on and confirm later</span>'
    : val.conf === 'high' ? '<span class="ok">✓ AI read · high confidence</span>'
    : '<span class="warn">' + ic('alert') + ' AI read · please double-check</span>';
  const photo = val.photoUrl
    ? `<div class="photo-row"><img class="thumb tap" src="${val.photoUrl}" alt="evidence" title="Tap to mark the correct number on the photo">
        <div class="ai-note-col">
          ${statusLine}
          ${aiChannel ? `<span class="screen-note">${esc(val.screen || '')}</span>` : ''}
          <span class="tap-hint">${ic('hand')} Tap photo to mark the correct number</span>
        </div>
        <div class="photo-btns"><button class="retake">Retake</button><button class="ch-remove" title="Remove photo and readings">✕ Remove</button></div></div>`
    : val.photoLink && val.photoId
    ? `<div class="photo-row"><img class="thumb tap" src="${photoUrl(esc(val.photoId))}" alt="evidence" title="Tap to view or mark the correct number">
        <div class="ai-note-col">
          <span class="screen-note">${ic('archive')} Photo on record — saved to Drive earlier.</span>
          <span class="tap-hint">${ic('hand')} Tap to view or mark the correct number</span>
        </div>
        <div class="photo-btns"><button class="retake">Retake</button><button class="ch-remove" title="Remove photo and readings">✕ Remove</button></div></div>`
    : val.photoLink
    ? `<div class="photo-row"><span class="photo-chip">${ic('archive')} Photo on record</span>
        <div class="ai-note-col"><span class="screen-note">Saved to Drive earlier — retake only if it was wrong.</span></div>
        <div class="photo-btns"><button class="retake">Retake</button><button class="reupload">Upload</button><button class="ch-remove" title="Remove photo and readings">✕ Remove</button></div></div>`
    : `<div class="photo-choice">
         <button class="photo-slot cam-btn"><span class="cam">${ic('camera')}</span> Take photo</button>
         <button class="photo-slot up-btn"><span class="cam">${ic('image')}</span> Upload</button>
       </div>
       <div class="no-photo-note">${aiChannel
         ? 'You can type the numbers first — but a photo is required as evidence before saving.'
         : 'This channel is manual — type the numbers. A photo is optional here.'}</div>`;
  let extra = '';
  if (mode === 'baseline' && channelHasData(val)) {
    extra = `<div class="deduct-box">${ic('sun')} Stored as today's opening GMV — deducted tonight. Not billed.</div>`;
  } else if (base && channelHasData(val)) {
    const x = extrasTotals(val);
    const bOrders = Number(base.finalOrders ?? base.orders ?? 0);
    const bGmv = Number(base.finalGmv ?? base.gmv ?? 0);
    const bo = (o ?? 0) + x.n - bOrders;
    const bg = (g ?? 0) + x.gmv - bGmv;
    extra = `<div class="deduct-box">${ic('sun')} Opening GMV this morning: ${bOrders} orders · ${money(bGmv)}<br>
      ${ic('receipt')} <b>Billable 10 am–10 pm: ${bo} orders · ${money(bg)}</b></div>`;
  }
  const mism = val.mismatch ? `<div class="mismatch">${ic('alert')} ${esc(val.mismatch)}</div>` : '';
  /* Pending-pickup must stay addable AFTER saving and in Review edits too —
     field feedback 30 Jul: the section vanished once the day was submitted. */
  const extras = mode === 'evening' && AI_CHANNELS.includes(ch)
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
  const camBtn = card.querySelector('.photo-slot.cam-btn');
  if (camBtn) camBtn.onclick = () => openCamera(ch);
  const upBtn = card.querySelector('.photo-slot.up-btn');
  if (upBtn) upBtn.onclick = () => openPicker(ch);
  const rt = card.querySelector('.retake');
  if (rt) rt.onclick = () => openCamera(ch);       // retake = shoot it again
  const reup = card.querySelector('.reupload');
  if (reup) reup.onclick = () => openPicker(ch);   // ...or swap in a gallery shot
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
  card.querySelectorAll('[data-xadd]').forEach((b) => b.onclick = () =>
    (b.dataset.xadd === 'cam' ? openExtrasCamera(ch) : openExtrasPicker(ch)));
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
  const prevVal = readVal(ctx, ch) || {};
  // gen bump: a retake must invalidate any older in-flight read, or its stale
  // settle would resurrect the superseded photo/link/numbers (review 29 Jul).
  // _dirty: after a saved opening GMV, a retake must re-arm "Update & save" —
  // the piggyback's photoDirty:false alone no longer implies "nothing to post".
  writeVal(ctx, ch, { ...prevVal, photoUrl, photoDirty: true,
    photoLink: undefined, photoId: undefined, pendingAI: true,
    _dirty: true, gen: (prevVal.gen || 0) + 1 });
  const gen = (readVal(ctx, ch) || {}).gen || 0;   // ✕ Remove also bumps this
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

  /* Piggyback storage (30 Jul save-latency fix): the photo travels to the
     server for reading anyway — the server stores it to Drive in the same
     request and returns the link, so the save later is kilobytes, not MBs. */
  const isBaseline = ctx.mode === 'baseline';
  const sdate = isBaseline ? state.salesDate : dateForOffset(ctx.offset || 0);
  const kindBase = ch === 'grab' ? 'Grab Photo' : 'Foodpanda Photo';
  api('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: photoUrl, channel: ch,
      mode: isBaseline ? 'baseline' : 'closing',
      brand: ctx.m.brand, aigens: !!ctx.m.aigens,
      recordId: recordIdFor(ctx.m, isBaseline ? 'baseline' : 'closing', sdate),
      salesDate: sdate,
      photoKind: isBaseline ? kindBase.replace(' Photo', ' Baseline Photo') : kindBase }),
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
        ...(d.photoLink ? { photoLink: d.photoLink, photoId: d.photoId, photoDirty: false } : {}),
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

  api('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: entry.photoUrl, channel: ch, mode: 'closing',
      shot: 'single_order', brand: ctx.m.brand,
      recordId: recordIdFor(ctx.m, 'closing', dateForOffset(ctx.offset || 0)),
      salesDate: dateForOffset(ctx.offset || 0),
      photoKind: ch === 'grab' ? 'Grab Extra' : 'FP Extra' }),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      return r.json();
    })
    .then((d) => apply({ aiGmv: d.gmv ?? null, conf: d.confidence,
      orderRef: (d.order_ref || '').trim(),
      ...(d.photoLink ? { photoLink: d.photoLink, photoId: d.photoId, photoDirty: false } : {}),
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
    || (val.photoId ? photoUrl(val.photoId) : null));
  if (!src) return;
  state.viewer = { ch, pendingBox: null };
  const img = $('viewer-img');
  img.style.transform = '';
  img.dataset.zoom = '';
  $('viewer-boxes').style.display = '';
  $('viewer-hint').textContent = 'Drag on the photo to box the correct number, then type it in. Double-tap to zoom.';
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
    if ($('viewer-img').dataset.zoom === '1') return;   // zoomed = look mode, no drawing
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
/* Double-tap the photo to toggle a 2.5x zoom at the tap point — tablet digits
   are unreadable at fit-to-screen. While zoomed: look only (marks hidden,
   drawing off); double-tap again to zoom out and draw. */
(() => {
  const stage = $('viewer-stage');
  let down = null, last = { t: 0, x: 0, y: 0 };
  stage.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
  stage.addEventListener('pointerup', (e) => {
    if (!$('viewer-choice').classList.contains('hidden')) return;   // typing a value — no zoom
    const wasTap = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12;
    down = null;
    if (!wasTap) { last.t = 0; return; }
    const now = Date.now();
    const isDouble = now - last.t < 350 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 48;
    last = isDouble ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
    if (!isDouble) return;
    const img = $('viewer-img');
    if (img.dataset.zoom === '1') {
      img.style.transform = '';
      img.dataset.zoom = '';
      $('viewer-boxes').style.display = '';
      $('viewer-hint').textContent = 'Drag on the photo to box the correct number, then type it in. Double-tap to zoom.';
    } else {
      const r = img.getBoundingClientRect();
      img.style.transformOrigin =
        `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
      img.style.transform = 'scale(2.5)';
      img.dataset.zoom = '1';
      $('viewer-boxes').style.display = 'none';
      $('rubber-band').classList.add('hidden');
      $('viewer-hint').textContent = '🔍 Zoomed — double-tap to zoom out and draw a box.';
    }
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
  return coreFor(state.current.m).every((ch) => {
    const v = rec.channels[ch];
    return v && v.finalOrders !== undefined && v.finalGmv !== undefined;
  });
}
function missingPhotos() {
  const rec = curRec();
  return coreFor(state.current.m).filter((ch) => rec.channels[ch] && !rec.channels[ch].photoUrl && !rec.channels[ch].photoLink);
}
function photosCaptured() {
  /* All CORE screens photographed (reads may still be in flight). */
  const rec = curRec();
  return rec.status === 'Operated' && coreFor(state.current.m).every((ch) => rec.channels[ch]?.photoUrl || rec.channels[ch]?.photoLink);
}
function baselineShots(mid) {
  return coreFor(findMerchant(mid)).map((ch) => state.baselines[`${mid}:${ch}`]).filter(Boolean);
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
    const bs = meta.status || 'Operated';
    if (bs !== 'Operated') {
      if (meta.inFlight) { btn.disabled = true; btn.textContent = '⬆ Saving…'; }
      else if (meta.error) { btn.disabled = false; btn.textContent = '❗ Retry save'; }
      else if (meta.saved && meta.savedStatus === bs) { btn.disabled = false; btn.textContent = `Saved as “${bs}” ✓ — back to list`; }
      else { btn.disabled = false; btn.textContent = `Save opening as “${bs}”`; }
      return;
    }
    const settled = baselineSettled(m.id);
    const reading = baselineReading(m);
    if (meta.inFlight) { btn.disabled = true; btn.textContent = '⬆ Saving opening GMV…'; }
    else if (meta.error) { btn.disabled = false; btn.textContent = '❗ Retry opening GMV save'; }
    else if (meta.saved && !baselineDirty(m.id)
             && (meta.savedStatus || 'Operated') === 'Operated') { btn.disabled = false; btn.textContent = 'Opening GMV recorded ✓ — back to list'; }
    else if (settled.length) {
      btn.disabled = false;
      btn.textContent = meta.saved ? 'Update opening GMV & save'
        : `Confirm opening GMV & save${settled.length < coreFor(m).length ? ' (partial)' : ''}`;
    }
    else if (reading) { btn.disabled = true; btn.textContent = 'Reading… hang on a moment'; }
    else { btn.disabled = true; btn.textContent = 'Shoot the screens to start'; }
    return;
  }
  const rec = curRec();
  if (rec.inFlight) { btn.disabled = true; btn.textContent = '⬆ Saving…'; return; }
  if (state.site && state.site.id === CATERING_SITE) {
    const v = rec.channels.catering || {};
    const ready = Number.isFinite(Number(v.finalOrders)) && Number.isFinite(Number(v.finalGmv));
    btn.disabled = !ready;
    btn.textContent = rec.saveError ? '❗ Retry catering save'
      : !Number.isFinite(Number(v.finalGmv)) ? 'Enter the catering figures'
      : rec.serverSaved ? 'Save changes' : `Save catering for ${rec.salesDate || state.salesDate}`;
    return;
  }
  // Hold tonight's save while this merchant's opening GMV is mid-save: letting
  // it through would briefly write a false NO_BASELINE flag (review 29 Jul).
  if (!offset && m.overnight && state.baselineMeta[m.id]?.inFlight) {
    btn.disabled = true; btn.textContent = 'Opening GMV saving… one moment'; return;
  }
  const blockers = rec.status === 'Operated' ? extrasBlockers(rec) : [];
  if (blockers.length) { btn.disabled = true; btn.textContent = blockers[0]; return; }
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

/* Every record write goes through here: a 90s abort so a stalled upload can't
   leave the button spinning forever, and a single place that turns a non-2xx
   into a thrown message the callers surface verbatim. */
function backToChecklist() {          // the one way back to tonight's round
  renderChecklist();
  show('view-checklist');
}

async function postRecord(payload, path = '/api/records') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await api(path, {
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
        toast(`${m.brand} saved — ⚠ no opening GMV this morning · flagged for supervisor`);
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
      + (resp.billing === 'NO_BASELINE' ? ' · ⚠ no opening GMV that day' : ''));
    if (from === 'review') { renderReview(); show('view-review'); }
    else { backToChecklist(); }
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
  const bs = meta.status || 'Operated';
  if (!meta.recordId) meta.recordId = recordIdFor(m, 'baseline');
  if (!meta.confirmedAt) meta.confirmedAt = nowStamp();
  const channels = {};
  const sent = {};
  if (bs === 'Operated') {
    coreFor(m).forEach((ch) => {
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
  }
  meta.inFlight = true;
  meta.error = null;
  // Non-blocking (supervisor feedback 30 Jul): head back to the list right
  // away — the morning card shows ⬆ saving… and flips ✓/❗ when the server answers.
  const onBaselineView = !$('view-capture').classList.contains('hidden')
    && state.current && state.current.mode === 'baseline' && state.current.m.id === m.id;
  if (onBaselineView) { backToChecklist(); }
  else if (!$('view-checklist').classList.contains('hidden')) renderChecklist();

  const finish = (err, resp) => {
    meta.inFlight = false;
    if (err) {
      meta.error = err;
      toast(`❗ ${m.brand} opening GMV NOT saved — ${err}. Tap the red card to retry.`);
    } else {
      meta.saved = true; meta.error = null;
      meta.savedStatus = bs;
      if (bs !== 'Operated') {
        // any shots on the phone are superseded by the status save
        coreFor(m).forEach((ch) => { delete state.baselines[`${mid}:${ch}`]; });
        const autoSet = resp.autoClosing && resp.autoClosing.created;
        if (autoSet) {
          state.records[mid] = { status: 'Not operated', saved: true, serverSaved: true,
            recordId: resp.autoClosing.closingId, staffName: state.staff.name,
            channels: {}, expanded: {} };
        }
        toast(bs === 'No Sales'
          ? `${m.brand}: no overnight sales recorded ✓ — tonight is billed in full`
          : autoSet
          ? `${m.brand} closed for today ✓ — tonight's record set to “Not operated”`
          : `${m.brand} opening saved as “Not operated” ✓ — tonight's record already exists, please check it`);
      } else {
        Object.entries(resp.photoLinks || {}).forEach(([ch, link]) => {
          const b = sent[ch];
          if (b && link) { b.photoLink = link; b.photoDirty = false; b.photoUrl = undefined; b._dirty = false; }
        });
        Object.values(sent).forEach((b) => { b._dirty = false; });
        toast(`${m.brand} opening GMV recorded ✓ — deducted automatically tonight`);
      }
    }
    if (!$('view-checklist').classList.contains('hidden')) renderChecklist();
    else {
      updateSaveBtn();
      // If they're already inside tonight's capture for this merchant, refresh
      // the banner so "saving right now" flips to the deduct message.
      if (state.current && state.current.m.id === mid
          && !$('view-capture').classList.contains('hidden')) renderBaselineBanner();
    }
  };

  const payload = { recordId: meta.recordId, recordType: 'baseline', salesDate: state.salesDate,
    confirmedAt: meta.confirmedAt, staffName: state.staff.name, staffId: state.staff.id || '',
    site: m.site, siteName: state.site.name, kitchen: m.kitchen, brand: m.brand,
    sfdcId: m.sfdcId, merchantType: m.type || '', kitchenStatus: bs,
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
    const bs = meta.status || 'Operated';
    if (bs !== 'Operated') {
      if (meta.saved && meta.savedStatus === bs && !meta.error) { backToChecklist(); return; }
      const go = () => saveBaseline(m.id);
      if (baselineHasShots(m)) {
        askConfirm(`Save opening as “${bs}”?`,
          `The screens shot this morning for ${m.brand} will be cleared. Previous values stay in the audit log.`,
          `Yes, save as ${bs}`, go);
        return;
      }
      go();
      return;
    }
    if (meta.saved && !baselineDirty(m.id) && !meta.error
        && (meta.savedStatus || 'Operated') === 'Operated') { backToChecklist(); return; }
    saveBaseline(m.id);
    return;
  }
  const rec = curRec();
  if (state.site.id === CATERING_SITE) { saveCatering(m.id); return; }
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
    `${u.m.kitchen} ${u.m.brand}${u.kind === 'baseline' ? ' (opening GMV)' : u.kind === 'draft' ? ' (not confirmed yet — open it and confirm)' : ''}`
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
  ab.thirdParty = false;
  $('ab-search').value = '';
  $('ab-brand').value = '';
  $('ab-overnight').checked = false;
  abPage(1);
  if (state.site.id === CATERING_SITE) {
    $('ab-sub').textContent = 'Catering · add an existing brand, or a third-party partner';
    $('ab-search').placeholder = 'Search brand or kitchen…';
    renderCateringPicker('');
  } else {
    $('ab-sub').textContent = `${state.site.name} · creates a new SFDC ID Map record`;
    $('ab-search').placeholder = 'Search company name…';
    renderCustomers('');
  }
  show('view-addbrand');
}

/* Catering roster building (Ernest 3 Aug): our own tenants are ALREADY in the
   ID Map — adding them to catering is a tick, not a new row (any facility, so
   the list spans all sites). Third-party partners have no SFDC ID at all and do
   get their own row under the CATERING pseudo-facility. */
function renderCateringPicker(q) {
  const needle = q.trim().toLowerCase();
  const hit = (m) => !needle || m.brand.toLowerCase().includes(needle)
    || m.kitchen.toLowerCase().includes(needle) || String(m.site).toLowerCase().includes(needle);
  const rows = DATA.merchants
    .filter((m) => m.site !== CATERING_SITE && !m.disabled && hit(m))
    .sort((a, b) => kitchenOrder(a.kitchen) - kitchenOrder(b.kitchen)
      || a.brand.localeCompare(b.brand));
  const partners = DATA.merchants.filter((m) => m.site === CATERING_SITE && hit(m));
  // The avatar already carries the kitchen and the group heading the facility —
  // a subtitle would just repeat them (Ernest 3 Aug).
  const card = (m) => `<button class="staff-btn" data-cat-site="${esc(m.site)}"
      data-cat-kitchen="${esc(m.kitchen)}" data-cat-brand="${esc(m.brand)}" ${m.catering ? 'data-on="1"' : ''}>
      <span class="avatar kav">${esc(m.kitchen)}</span>
      <span class="cname">${esc(m.brand)}</span>
      ${m.catering ? '<span class="tag on" style="margin-left:auto">IN CATERING</span>' : ''}
    </button>`;
  // The partner option exists ONLY in the Catering entry: elsewhere every brand
  // must map to a contracted kitchen (Ernest 3 Aug).
  // Grouped by facility, kitchens in K1→Kxx order then CR (Ernest 3 Aug): a flat
  // 67-row list is a scroll; the heading tells you where you are at a glance.
  const byFacility = new Map();
  rows.forEach((m) => {
    if (!byFacility.has(m.site)) byFacility.set(m.site, []);
    byFacility.get(m.site).push(m);
  });
  const facilityOrder = [...byFacility.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }));
  const groups = facilityOrder.map((sid) => {
    const site = DATA.sites.find((s) => s.id === sid);
    return `<div class="roster-group">${esc(site ? site.name : sid)} · ${esc(sid)}</div>`
      + byFacility.get(sid).map(card).join('');
  }).join('');
  $('ab-customers').innerHTML =
    `<button class="staff-btn" id="ab-thirdparty">
       <span class="avatar kav">${ic('plus')}</span>
       <span class="cname">Third-party partner<div class="customer-meta">Outside company, no SFDC ID — catering only</div></span>
     </button>`
    + (partners.length ? `<div class="roster-group">Partners</div>`
        + partners.map(card).join('') : '')
    + (rows.length ? groups : `<p class="ab-note">No brand matches “${esc(q)}”.</p>`);

  $('ab-thirdparty').onclick = () => {
    ab.thirdParty = true;
    ab.customer = null;
    $('ab-picked').innerHTML = `<span class="avatar kav">${ic('plus')}</span>
      <span><div class="cname">Third-party catering partner</div>
      <div class="customer-meta">No SFDC ID — logged in the catering tab only, never billed as a licensee</div></span>`;
    $('ab-brand').value = '';
    abPage(2);
    updateCreateBtn();
  };
  $('ab-customers').querySelectorAll('[data-cat-brand]').forEach((b) => b.onclick = async () => {
    const m = DATA.merchants.find((x) => x.site === b.dataset.catSite
      && x.kitchen === b.dataset.catKitchen && x.brand === b.dataset.catBrand);
    if (!m) return;
    const next = !m.catering;
    b.disabled = true;
    try {
      const r = await api('/api/merchants', { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facility: m.site, kitchen: m.kitchen, brand: m.brand, catering: next }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      m.catering = next;
      state.merchants = siteMerchants(state.site.id);
      renderCateringPicker($('ab-search').value);
      toast(next ? `${m.brand} added to catering ✓` : `${m.brand} removed from catering`);
    } catch (e) {
      b.disabled = false;
      toast(`❗ Could not update ${m.brand} — ${e.message}`);
    }
  });
}
function abPage(n) {
  $('ab-step1').classList.toggle('hidden', n !== 1);
  $('ab-step2').classList.toggle('hidden', n !== 2);
  window.scrollTo(0, 0);
}
$('btn-addbrand-back').onclick = () => { backToChecklist(); };
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
$('ab-search').oninput = () => (state.site.id === CATERING_SITE
  ? renderCateringPicker($('ab-search').value)
  : renderCustomers($('ab-search').value));
$('ab-brand').oninput = updateCreateBtn;
function updateCreateBtn() {
  const named = $('ab-brand').value.trim().length >= 2;
  $('ab-create').disabled = !((ab.customer || ab.thirdParty) && named);
  $('ab-create').textContent = ab.thirdParty ? 'Add catering partner' : 'Create brand record';
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
    const r = await api('/api/merchants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: ab.thirdParty
        ? JSON.stringify({ facility: CATERING_SITE, kitchen: '3P', brand, sfdcId: '',
                           overnight: false, catering: true })
        : JSON.stringify({ facility: state.site.id, kitchen: ab.customer.kitchen,
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

/* ---------- OS back gesture: act like in-app back, never nuke the night ----------
   The app is a hidden-class SPA — without this, Android's back gesture leaves
   the site and destroys every unsaved capture in memory. Trap pattern: one
   sentinel history entry; each back pop closes the topmost layer and re-arms.
   Leaving is still possible via browser UI; beforeunload guards unsaved work. */
function closeTopLayer() {
  const overlays = [
    ['viewer-overlay', 'viewer-close'], ['pinchange-overlay', 'pc-cancel'],
    ['guard-overlay', 'guard-cancel'], ['convert-overlay', 'convert-cancel'],
    ['dup-overlay', 'dup-cancel'], ['menu-overlay', 'menu-cancel'],
  ];
  for (const [ov, btn] of overlays) {
    const el = $(ov);
    if (el && !el.classList.contains('hidden')) {
      // Inside the viewer, the number panel is its own layer: back should
      // cancel the panel, not throw away the drawn box with the whole viewer.
      if (ov === 'viewer-overlay' && !$('viewer-choice').classList.contains('hidden')) {
        $('vc-cancel').click();
        return true;
      }
      $(btn).click();
      return true;
    }
  }
  if (!$('view-capture').classList.contains('hidden')) { $('btn-capture-back').click(); return true; }
  if (!$('view-review').classList.contains('hidden')) { $('btn-review-back').click(); return true; }
  if (!$('view-billing').classList.contains('hidden')) { $('btn-billing-back').click(); return true; }
  if (!$('view-brands').classList.contains('hidden')) { $('btn-brands-back').click(); return true; }
  if (!$('view-addbrand').classList.contains('hidden')) { $('btn-addbrand-back').click(); return true; }
  if (!$('view-login').classList.contains('hidden')) {
    const step = [...document.querySelectorAll('#view-login .login-step')]
      .find((s) => !s.classList.contains('hidden'));
    const bl = step && step.querySelector('.back-link');
    if (bl) { bl.click(); return true; }
  }
  return false;   // checklist or site-picker root — stay put
}
history.replaceState({ smartgmv: 'root' }, '');
history.pushState({ smartgmv: 'trap' }, '');
window.addEventListener('popstate', () => {
  closeTopLayer();
  history.pushState({ smartgmv: 'trap' }, '');
});
window.addEventListener('beforeunload', (e) => {
  if (state.staff && typeof logoutRisks === 'function' && logoutRisks().length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ---------- monthly billing (menu-only view — capture stays the app's core) ---------- */
const bl = { month: null, custom: false, from: '', to: '', q: '', data: null };
function monthLabel(ym) {
  const [y, mo] = ym.split('-');
  return new Date(Number(y), Number(mo) - 1, 1)
    .toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
}
function billingMonths() {
  const now = new Date(Date.now() - 6 * 3600 * 1000);   // business day
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return [cur, `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`];
}
function openBilling() {
  bl.month = billingMonths()[0];
  bl.custom = false;
  bl.q = '';
  renderBillingShell();
  show('view-billing');
  loadBilling();
}
function renderBillingShell() {
  $('bl-sub').textContent = `${state.site.name} · ${state.site.id}`;
  $('bl-months').innerHTML = billingMonths().map((m) =>
    `<button class="chip ${!bl.custom && bl.month === m ? 'active' : ''}" data-m="${m}">${esc(monthLabel(m))}</button>`).join('')
    + `<button class="chip ${bl.custom ? 'active' : ''}" data-m="custom">Custom range</button>`;
  $('bl-months').querySelectorAll('.chip').forEach((c) => c.onclick = () => {
    if (c.dataset.m === 'custom') { bl.custom = true; renderBillingShell(); return; }
    bl.custom = false;
    bl.month = c.dataset.m;
    renderBillingShell();
    loadBilling();
  });
  $('bl-range').classList.toggle('hidden', !bl.custom);
  if (bl.custom && !$('bl-from').value) {
    $('bl-from').value = bl.from || `${bl.month}-01`;
    $('bl-to').value = bl.to || dateForOffset(0);
  }
}
$('bl-apply').onclick = () => {
  const f = $('bl-from').value, t = $('bl-to').value;
  if (!f || !t || f > t) { toast('Pick a valid range — from must be on or before to'); return; }
  bl.from = f; bl.to = t;
  loadBilling();
};
async function loadBilling() {
  $('bl-body').innerHTML = '<p class="ab-note"><span class="spinner sm"></span> Adding up the month…</p>';
  try {
    const qs = bl.custom ? `from=${bl.from || $('bl-from').value}&to=${bl.to || $('bl-to').value}`
                         : `month=${bl.month}`;
    const r = await api(`/api/billing?site=${state.site.id}&${qs}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    renderBilling(d);
  } catch (e) {
    $('bl-body').innerHTML = `<p class="ab-note">${ic('alert')} Could not load the summary (${esc(e.message)}).</p>
      <button class="chip" id="bl-retry">Try again</button>`;
    $('bl-retry').onclick = loadBilling;
  }
}
function renderBilling(d) {
  bl.data = d;
  const label = d.label && d.label.includes('→') ? d.label : monthLabel(d.month || d.label);
  if (!d.merchants.length) {
    $('bl-body').innerHTML = `<div class="empty-note">No closing records for ${esc(label)} yet.</div>`;
    return;
  }
  const q = bl.q.trim().toLowerCase();
  const shown = q ? d.merchants.filter((m) =>
    m.brand.toLowerCase().includes(q) || m.kitchen.toLowerCase().includes(q)) : d.merchants;
  const t = d.totals;
  const manual = (m) => m.othersGmv + m.cateringGmv + m.dineinGmv + m.promoDineinGmv;
  const rows = shown.map((m) => `<div class="merchant-card" style="cursor:default">
      <div class="m-kitchen">${esc(m.kitchen)}</div>
      <div class="m-info"><div class="m-name">${esc(m.brand)}</div>
        <div class="m-tags"><span class="bl-days">${m.days} day${m.days > 1 ? 's' : ''} recorded</span></div></div>
      <div style="text-align:right"><div class="bl-orders">${m.totalOrders} order${m.totalOrders === 1 ? '' : 's'}</div>
        <div class="m-total">${money(m.totalGmv)}</div>
        <div class="bl-mini">G ${m.billableGrabOrders} · ${money(m.billableGrabGmv)}&nbsp;&nbsp;F ${m.billableFpOrders} · ${money(m.billableFpGmv)}</div></div>
    </div>`).join('');
  const flags = d.flags.length
    ? `<div class="section-label" style="margin-top:22px">${ic('alert')} Needs review <span class="sec-hint">${d.flags.length} record${d.flags.length > 1 ? 's' : ''} — clear these before invoicing</span></div>
       ${d.flags.map((f) => `<div class="bl-flag">${esc(f.date.slice(5))} · ${esc(f.kitchen)} ${esc(f.brand)}${f.flag ? ` — <b>${esc(f.flag)}</b>` : ''}${f.edited ? `${f.flag ? ' ·' : ' —'} edited` : ''}</div>`).join('')}`
    : `<p class="ab-note" style="margin-top:18px">${ic('check')} No flags this month — every record is clean.</p>`;
  $('bl-body').innerHTML = `
    <div class="progress-card" style="display:block">
      <span class="bl-cap">Site total · ${esc(label)} · billable</span>
      <div class="bl-big">${t.totalOrders.toLocaleString()} orders · ${money(t.totalGmv)}</div>
      <div class="bl-mini">Grab ${t.billableGrabOrders.toLocaleString()} · ${money(t.billableGrabGmv)}&nbsp;&nbsp;foodpanda ${t.billableFpOrders.toLocaleString()} · ${money(t.billableFpGmv)}&nbsp;&nbsp;manual ${(t.othersOrders + t.cateringOrders + t.dineinOrders + t.promoDineinOrders).toLocaleString()} · ${money(t.othersGmv + t.cateringGmv + t.dineinGmv + t.promoDineinGmv)}</div>
    </div>
    <input class="search-input" id="bl-search" placeholder="Filter merchants…" value="${esc(bl.q)}" style="margin-top:14px">
    <div class="merchant-list" style="margin-top:10px">${rows}</div>
    ${q && !shown.length ? '<p class="ab-note">No merchant matches the filter.</p>' : ''}
    ${flags}`;
  $('bl-search').oninput = () => {
    bl.q = $('bl-search').value;
    const pos = $('bl-search').selectionStart;
    renderBilling(bl.data);
    const el = $('bl-search');
    el.focus();
    el.setSelectionRange(pos, pos);
  };
}
$('menu-billing').onclick = () => { $('menu-overlay').classList.add('hidden'); openBilling(); };
$('btn-billing-back').onclick = () => { backToChecklist(); };

/* ---------- catering save (own endpoint: log tab + scoped merge) ---------- */
async function saveCatering(mid) {
  const m = findMerchant(mid);
  const rec = state.records[mid];
  if (!rec || rec.inFlight) return;
  const v = rec.channels.catering || {};
  const orders = Number(v.finalOrders);
  const gmv = Number(v.finalGmv);
  if (!Number.isFinite(orders) || !Number.isFinite(gmv)) { toast('Enter the catering orders and sales first'); return; }
  const date = rec.salesDate || state.salesDate;
  if (!rec.recordId) rec.recordId = recordIdFor(m, 'closing', date);
  if (!rec.confirmedAt) rec.confirmedAt = nowStamp();
  rec.staffName = rec.staffName || state.staff.name;
  rec.inFlight = true;
  rec.saveError = null;
  renderChecklist();
  show('view-checklist');

  const payload = {
    recordId: rec.recordId, salesDate: date, confirmedAt: rec.confirmedAt,
    staffName: state.staff.name, staffId: state.staff.id || '',
    site: m.site, siteName: m.siteName || '', kitchen: m.kitchen,
    brand: m.brand, sfdcId: m.sfdcId || '',
    orders, gmv,
    aiOrders: v.aiOrders ?? null, aiGmv: v.aiGmv ?? null,
    notes: '',
  };
  if (v.photoDirty && v.photoUrl) payload.photo = v.photoUrl;
  else if (v.photoLink) payload.photoLink = v.photoLink;

  try {
    const d = await postRecord(payload, '/api/records/catering');
    rec.inFlight = false;
    rec.saved = true;
    rec.serverSaved = true;
    rec.saveError = null;
    if (d.photoLink) {
      v.photoLink = d.photoLink;
      v.photoId = photoIdOf(d.photoLink);
      v.photoDirty = false;
      v.photoUrl = undefined;
    }
    toast(d.thirdParty
      ? `${m.brand} catering saved ✓ — logged for ${date} (partner, no licensee row)`
      : `${m.brand} catering saved ✓ — ${date} row updated, other channels untouched`);
  } catch (e) {
    rec.inFlight = false;
    rec.saveError = e.name === 'AbortError' ? 'timed out after 90s' : e.message;
    toast(`❗ ${m.brand} catering NOT saved — ${rec.saveError}. Tap the red card to retry.`);
  }
  renderChecklist();
}

/* ---------- S12 monthly dine-in: one screenshot for the whole site ----------
   Ernest 3 Aug: the food-hall accounting sheet arrives once a month. Read it,
   confirm row by row, then merge each brand's figures into its 1st-of-month row
   without touching that row's delivery numbers. */
const di = { photo: null, read: null, rows: [], busy: false };

function openDinein() {
  di.photo = null; di.read = null; di.rows = []; di.busy = false;
  $('di-sub').textContent = `${state.site.name} · ${state.site.id}`;
  renderDinein();
  show('view-dinein');
}
$('btn-dinein-back').onclick = () => { backToChecklist(); };

function renderDinein() {
  if (di.busy) {
    $('di-body').innerHTML = `<p class="ab-note"><span class="spinner sm"></span> Reading the screenshot — one moment.</p>`;
    return;
  }
  if (!di.read) {
    $('di-body').innerHTML = `
      <p class="ab-note">Upload the monthly dine-in sheet for ${esc(state.site.name)}. The month in the
        heading decides the date — “July '26” is recorded as 1 July 2026, and every brand's figures go
        into that day's row. Nothing else on those rows is touched.</p>
      <div class="photo-slot" id="di-pick"><span class="cam">${ic('camera')}</span> Upload the monthly dine-in screenshot</div>`;
    $('di-pick').onclick = () => dineinInput.click();
    return;
  }
  const r = di.read;
  const cc = r.crossCheck || {};
  const money2 = (v) => (v === null || v === undefined || v === '' ? '—' : money(Number(v)));
  const num = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const rows = di.rows.map((x, i) => `
    <div class="di-row">
      <div class="di-head"><b>${esc(x.matchedBrand)}</b><span class="bl-mini">${esc(x.kitchen)}</span></div>
      <div class="di-grid">
        <label>Dine-in orders<input inputmode="numeric" data-di="${i}" data-f="dineinOrders" value="${x.dineinOrders ?? ''}" placeholder="—"></label>
        <label>Dine-in sales<input inputmode="decimal" data-di="${i}" data-f="dineinGmv" value="${x.dineinGmv ?? ''}" placeholder="—"></label>
        <label>Promo orders<input inputmode="numeric" data-di="${i}" data-f="promoOrders" value="${x.promoOrders ?? ''}" placeholder="—"></label>
        <label>Promo sales<input inputmode="decimal" data-di="${i}" data-f="promoGmv" value="${x.promoGmv ?? ''}" placeholder="—"></label>
      </div>
      ${x.totalOrders !== null && x.totalOrders !== undefined
        ? `<div class="bl-mini">sheet shows ${num(x.totalOrders)} total orders for the month</div>` : ''}
    </div>`).join('');
  $('di-body').innerHTML = `
    <div class="progress-card" style="display:block">
      <span class="bl-cap">${esc(r.monthLabel)} → recorded as ${esc(r.salesDate)}</span>
      <div class="bl-big">${di.rows.length} brand${di.rows.length === 1 ? '' : 's'}</div>
      <div class="bl-mini">Dine-in ${money2(cc.ourSum && cc.ourSum.dineinGmv)} · promo ${money2(cc.ourSum && cc.ourSum.promoGmv)} · ${num(cc.ourSum && cc.ourSum.totalOrders)} orders</div>
    </div>
    ${cc.matches
      ? `<p class="ab-note">${ic('check')} Our row-by-row total matches the TOTAL line on the sheet.</p>`
      : `<div class="bl-flag">${ic('alert')} Our total does not match the sheet's TOTAL line
          (sheet ${money2(cc.sheetTotal && cc.sheetTotal.dinein_gmv)} / ${num(cc.sheetTotal && cc.sheetTotal.total_orders)} orders).
          Check the rows below${(r.unmatched || []).length ? ' — some brands did not match the ID Map' : ''}.</div>`}
    ${(r.unmatched || []).length ? `<div class="bl-flag">${ic('alert')} Not in the ID Map, so not saved:
        ${r.unmatched.map((u) => esc(u.brand)).join(', ')}. Add the brand first, then upload again.</div>` : ''}
    ${r.notes ? `<p class="ab-note">${ic('alert')} ${esc(r.notes)}</p>` : ''}
    ${rows}
    <div class="save-bar" style="position:static;padding:16px 0 24px;background:none">
      <button class="btn-primary" id="di-save">Save ${di.rows.length} brand${di.rows.length === 1 ? '' : 's'} for ${esc(r.salesDate)}</button>
      <button class="chip" id="di-redo" style="margin-top:10px">Upload a different screenshot</button>
    </div>`;
  $('di-body').querySelectorAll('[data-di]').forEach((inp) => inp.oninput = () => {
    const row = di.rows[Number(inp.dataset.di)];
    const raw = inp.value.trim();
    const isMoney = inp.dataset.f.endsWith('Gmv');
    row[inp.dataset.f] = raw === '' ? null : (isMoney ? Number(raw) : parseInt(raw, 10));
    inp.classList.toggle('bad', raw !== '' && !Number.isFinite(Number(raw)));
  });
  $('di-redo').onclick = () => { di.read = null; di.rows = []; renderDinein(); };
  $('di-save').onclick = saveDinein;
}

const dineinInput = makeInput({});
dineinInput.onchange = () => {
  const file = dineinInput.files && dineinInput.files[0];
  dineinInput.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => readDinein(reader.result);
  reader.readAsDataURL(file);
};
async function readDinein(dataUrl) {
  di.busy = true; renderDinein();
  try {
    // a dense table: keep it big enough for the AI to read every column
    di.photo = await downscale(dataUrl, 1800, 0.9);
    const r = await api('/api/dinein/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: di.photo, site: state.site.id }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    di.read = d;
    di.rows = d.rows.map((x) => ({ ...x }));
    toast(`${d.monthLabel} read — ${d.rows.length} brands matched`);
  } catch (e) {
    di.read = null;
    toast(`❗ Could not read the screenshot — ${e.message}`);
  } finally {
    di.busy = false;
    renderDinein();
  }
}

async function saveDinein() {
  if (!di.read || !di.rows.length) return;
  const btn = $('di-save');
  btn.disabled = true;
  btn.textContent = '⬆ Saving…';
  try {
    const r = await api('/api/dinein/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site: state.site.id, siteName: state.site.name,
        salesDate: di.read.salesDate, monthLabel: di.read.monthLabel,
        confirmedAt: nowStamp(), staffName: state.staff.name, staffId: state.staff.id || '',
        photo: di.photo,
        rows: di.rows.map((x) => ({ kitchen: x.kitchen, brand: x.matchedBrand, sfdcId: x.sfdcId,
          dineinOrders: x.dineinOrders ?? null, dineinGmv: x.dineinGmv ?? null,
          promoOrders: x.promoOrders ?? null, promoGmv: x.promoGmv ?? null })),
      }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    const n = (d.written || []).length + (d.created || []).length;
    toast(`${n} brand${n === 1 ? '' : 's'} saved for ${d.salesDate} ✓`
      + ((d.skipped || []).length ? ` · ${d.skipped.length} skipped` : ''));
    renderChecklist();
    show('view-checklist');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Retry save';
    toast(`❗ Monthly dine-in NOT saved — ${e.message}`);
  }
}
