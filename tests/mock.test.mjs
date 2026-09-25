// Real code paths (non-demo) against a scripted backend: PIN flows, sessions, hydration, saves,
// amendments, catering, dine-in, billing — plus targeted probes for suspected defects.
import { chromium, BASE, API, results, report, assert, eq, makeContext, test, jpegBuffer, text, sleep, lastToast, PNG1x1 } from './harness.mjs';

const browser = await chromium.launch();
const today = (() => { const d = new Date(Date.now() - 6 * 3600e3 + 8 * 3600e3); return d.toISOString().slice(0, 10); })(); // SGT business date
const yday = (() => { const d = new Date(Date.now() - 6 * 3600e3 + 8 * 3600e3 - 86400e3); return d.toISOString().slice(0, 10); })();

// ---- scripted backend state ----------------------------------------------------------------
function freshMock() {
  return {
    log: [],
    token: 'tok-1',
    catalogPre: { sites: [{ id: 'S1', name: 'Alpha Kitchens', merchantCount: 3 }, { id: 'S12', name: 'Food Hall', merchantCount: 1 }, { id: 'CATERING', name: 'Catering', merchantCount: 2 }],
      staff: [{ id: 'st-1', name: 'Ada Lim', homeSites: ['S1'], needsPin: false, reports: true },
              { id: 'st-2', name: 'Ben Tan', homeSites: ['S12'], needsPin: true, reports: false, partTimer: true }] },
    merchants: [
      { facility: 'S1', site: 'Alpha Kitchens', kitchen: 'K1', brand: 'Alpha Burgers', sfdcId: 'A1', grabOn: true, fpOn: true, catering: false },
      { facility: 'S1', site: 'Alpha Kitchens', kitchen: 'K2', brand: 'Beta Bowls', sfdcId: 'B2', grabOn: true, fpOn: true, catering: true },
      { facility: 'S1', site: 'Alpha Kitchens', kitchen: 'K3', brand: 'Gamma Grill', sfdcId: 'G3', grabOn: true, fpOn: false, catering: true, overnight: true },
      { facility: 'S12', site: 'Food Hall', kitchen: 'K1', brand: 'Hall Noodles', sfdcId: 'H1', grabOn: true, fpOn: true },
    ],
    todayRecords: [], version: 1, amendments: [], history: [], pinFailFirst: true, catalogAuthStatus: 200,
    versionStatus: 200, saveStatus: 200, billing: null, dinein: null, extractDelay: 50,
  };
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS' };
async function install(page, mock) {
  await page.route(API + '/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname, m = req.method();
    const auth = req.headers()['authorization'] || '';
    let body = {}; try { body = req.postDataJSON() || {}; } catch (e) { /* none */ }
    mock.log.push({ m, p, q: url.search, auth, body });
    const json = (obj, status = 200) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const needAuth = () => auth !== `Bearer ${mock.token}`;
    if (p === '/api/catalog') {
      if (auth && auth !== `Bearer ${mock.token}`) return json({ detail: 'bad token' }, mock.catalogAuthStatus === 200 ? 401 : mock.catalogAuthStatus);
      if (auth === `Bearer ${mock.token}`) { if (mock.catalogPostStatus) return json({ detail: 'boom' }, mock.catalogPostStatus); return json({ ...mock.catalogPre, customers: [{ site: 'S1', kitchen: 'K9', company: 'Delta Pte Ltd', oppId: 'OPP-9', terms: [1, 2] }], merchants: mock.merchants }); }
      return json({ ...mock.catalogPre, customers: [], merchants: [] });
    }
    if (p === '/api/staff/verify') {
      if (body.pin === '0000') return json({ detail: 'pin_not_set' }, 403);
      if (body.pin !== '1234') return json({ detail: 'wrong' }, 403);
      const st = mock.catalogPre.staff.find((s) => s.id === body.staffId);
      return json({ ok: true, token: mock.token, staff: { id: st.id, name: st.name, reports: st.reports } });
    }
    if (p === '/api/staff/pin') {
      if (mock.pinClaimConflict) return json({ detail: 'already set' }, 409);
      const st = mock.catalogPre.staff.find((s) => s.id === body.staffId);
      return json({ ok: true, token: mock.token, staff: { id: st.id, name: st.name, reports: st.reports } });
    }
    if (p === '/api/staff/pin/change') return json({ ok: true });
    if (p === '/api/staff' && m === 'POST') return json({ ok: true, token: mock.token, staff: { id: 'st-new', name: body.name, homeSites: [body.homeSite], partTimer: body.partTimer, needsPin: false, reports: false } });
    if (needAuth()) return json({ detail: 'unauthorized' }, 401);
    if (p === '/api/records/today') return json({ records: mock.todayRecords, version: mock.version });
    if (p === '/api/amendments') return json({ amendments: mock.amendments });
    if (p.startsWith('/api/amendments/') && p.endsWith('/decide')) return json({ ok: true, save: { billing: 'OK' } });
    if (p === '/api/records/version') return mock.versionStatus === 200 ? json({ version: mock.version }) : json({ detail: 'expired' }, mock.versionStatus);
    if (p === '/api/records' && m === 'GET') return json({ records: mock.history });
    if (p === '/api/extract') { await sleep(mock.extractDelay); return json({ orders: body.shot === 'single_order' ? 1 : 7, gmv: body.shot === 'single_order' ? 15.5 : 210.25, confidence: 'high', screen_summary: 'mock screen', zero_sales: false, wrong_channel: false, notes: '', photoLink: 'https://drive.google.com/file/d/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345/view', photoId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }); }
    if (p === '/api/records' && m === 'POST') { if (mock.saveStatus !== 200) return json({ detail: 'sheet locked' }, mock.saveStatus); mock.version++; return json({ ok: true, photoLinks: {}, extrasLinks: {}, billing: 'OK', warnings: [], version: mock.version, edited: false, ...(body.recordType === 'baseline' && body.kitchenStatus === 'Not operated' ? { autoClosing: { created: true, closingId: 'auto-C' } } : {}) }); }
    if (p === '/api/records/catering') return json({ ok: true, thirdParty: false });
    if (p === '/api/merchants' && m === 'PATCH') { const mm = mock.merchants.find((x) => x.facility === body.facility && x.kitchen === body.kitchen && x.brand === body.brand); if (mm) Object.assign(mm, ['grab', 'fp'].includes(Object.keys(body).find((k) => ['grab', 'fp'].includes(k))) ? {} : {}, body.catering !== undefined ? { catering: body.catering } : {}, body.disabled !== undefined ? { disabled: body.disabled } : {}, body.overnight !== undefined ? { overnight: body.overnight } : {}); return json({ ok: true }); }
    if (p === '/api/merchants' && m === 'POST') return json({ ok: true, row: 42, merchant: { facility: body.facility, kitchen: body.kitchen, brand: body.brand, sfdcId: body.sfdcId, overnight: body.overnight } });
    if (p === '/api/billing') return json(mock.billing || { month: today.slice(0, 7), merchants: [], totals: {}, flags: [] });
    if (p === '/api/dinein/read') return json(mock.dinein);
    if (p === '/api/dinein/save') return json({ ok: true, written: ['a'], created: [], skipped: [], salesDate: body.salesDate });
    if (p.startsWith('/api/photo/')) return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'image/png' }, body: PNG1x1 });
    return json({ detail: 'unmocked ' + p }, 404);
  });
}
const rec = (kitchen, brand, extra = {}) => ({ recordId: `S1-${kitchen}-x-C`, recordType: 'closing', salesDate: today, timestamp: `${today} 21:00:00`,
  kitchen, brand, status: 'Operated', staff: 'Other Phone (st-9)', edited: false, billingFlag: 'OK',
  channels: { grab: { aiOrders: 5, aiGmv: 100, summaryOrders: 5, summaryGmv: 100, photoLink: '', photoId: '', extras: [], noSales: false },
              fp: { aiOrders: 2, aiGmv: 40, summaryOrders: 2, summaryGmv: 40, photoLink: '', photoId: '', extras: [], noSales: false } }, ...extra });

async function login(page, staffId = 'st-1', site = 0) {
  await page.goto(BASE);
  await page.waitForSelector('#site-grid .site-btn');
  await page.locator('#site-grid .site-btn').nth(site).click();
  await page.locator(`#staff-list .staff-btn[data-id="${staffId}"]`).click();
  await page.waitForSelector('#login-step-pin:not(.hidden)');
  for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
  await page.waitForSelector('#view-checklist:not(.hidden)');
  await page.waitForFunction(() => !/Checking/.test(document.getElementById('prog-sub').textContent));
}

// ===================================================================================================
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);

  await test('PIN: wrong PIN -> error; keypad busy state; correct PIN -> session token used on every call', page, async (note) => {
    await page.goto(BASE);
    await page.waitForSelector('#site-grid .site-btn');
    eq(await text(page, '#site-grid .site-btn'), 'Alpha KitchensS1 · 3 merchants', 'pre-login count comes from merchantCount');
    await page.click('#site-grid .site-btn');
    await page.click('#staff-list .staff-btn[data-id="st-1"]');
    eq(await text(page, '#pin-title'), 'Hi Ada Lim, enter your PIN', 'verify title');
    for (const k of '9999') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForFunction(() => !document.getElementById('pin-error').classList.contains('hidden'));
    eq(await text(page, '#pin-error'), 'Wrong PIN — try again', 'wrong pin');
    // hardware keyboard path
    await page.keyboard.type('12');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('234');
    await page.waitForSelector('#view-checklist:not(.hidden)');
    await page.waitForFunction(() => /captured|No delivery/.test(document.getElementById('prog-sub').textContent));
    const calls = mock.log.filter((l) => l.p !== '/api/catalog' || l.auth);
    assert(calls.every((l) => l.m === 'OPTIONS' || l.auth === 'Bearer tok-1' || l.p.startsWith('/api/staff')), 'all data calls carry the token');
    note('calls=' + mock.log.map((l) => l.m + ' ' + l.p).filter((s) => !s.startsWith('OPTIONS')).join(', '));
    eq(await page.evaluate(() => JSON.parse(sessionStorage.getItem('smartgmv.session')).tok), 'tok-1', 'token persisted in sessionStorage');
    eq(await text(page, '#prog-sub'), '0 of 3 captured · tap to continue', 'merchants loaded after login');
  });

  await test('first-login PIN claim: mismatch restarts, 409 falls back to verify, success enters', page, async () => {
    await page.click('#btn-logout');
    await page.waitForSelector('#view-login:not(.hidden)');
    await page.click('#login-step-site .site-grid .site-btn');
    await page.click('#staff-list .staff-btn[data-id="st-2"]');
    eq(await text(page, '#pin-title'), 'Hi Ben Tan — create your 4-digit PIN', 'create title');
    for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForFunction(() => document.getElementById('pin-title').textContent.includes('confirm'));
    for (const k of '1235') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForFunction(() => /didn't match/.test(document.getElementById('pin-error').textContent) && !document.getElementById('pin-error').classList.contains('hidden'));
    mock.pinClaimConflict = true;
    for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForFunction(() => document.getElementById('pin-title').textContent.includes('confirm'));
    for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForFunction(() => /already set/.test(document.getElementById('pin-error').textContent) && !document.getElementById('pin-error').classList.contains('hidden'));
    eq(await text(page, '#pin-title'), 'Hi Ben Tan, enter your PIN', 'fell back to verify');
    for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForSelector('#view-checklist:not(.hidden)');
    eq(await text(page, '#hdr-staff'), 'Ben Tan', 'logged in as Ben');
    await page.click('#btn-menu');
    assert(!(await page.locator('#menu-billing').isVisible()), 'billing hidden without reports permission');
    await page.click('#menu-cancel');
  });

  await test('session expiry mid-round (401 on the live poll) -> PIN screen; PROBE: PIN kept in memory, one key re-submits it; unsaved work wiped', page, async (note) => {
    // unsaved work on K1 before the session dies
    await page.click('#list-evening .merchant-card[data-id="S1-K1-0"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.fill('#rf-grab-o', '77'); await page.fill('#rf-grab-g', '7');
    await page.click('#btn-capture-back');
    const pinInMemory = await page.evaluate(() => state.pin);
    note('state.pin after a successful login = ' + JSON.stringify(pinInMemory));
    mock.versionStatus = 401;
    await page.evaluate(() => liveTick());
    await page.waitForSelector('#login-step-pin:not(.hidden)');
    eq(await lastToast(page), 'Session expired — enter your PIN again', 'toast');
    const dots = await page.locator('#pin-dots i.filled').count();
    note('filled PIN dots shown on the expiry screen = ' + dots);
    await sleep(300);
    await page.evaluate(() => liveTick()); // must not re-toast / re-navigate while on the PIN screen
    eq(await page.evaluate(() => sessionStorage.getItem('smartgmv.session')), null, 'token dropped');
    mock.versionStatus = 200;
    mock.token = 'tok-2';
    const before = mock.log.filter((l) => l.p === '/api/staff/verify').length;
    await page.click('#pin-pad .pin-key[data-k="9"]');       // a stranger presses ONE wrong key
    await sleep(800);
    const verifies = mock.log.filter((l) => l.p === '/api/staff/verify').slice(before);
    note('after pressing a single key "9": verify calls=' + verifies.length + ' pin sent=' + JSON.stringify(verifies.map((v) => v.body.pin)) + ' checklist visible=' + await page.locator('#view-checklist').isVisible());
    if (await page.locator('#view-checklist').isVisible()) {
      const k1 = await page.evaluate(() => state.records['S1-K1-0']?.channels?.grab?.finalOrders);
      note('K1 unsaved orders after re-login (typed 77): ' + k1);
      assert(false, 'a single keypress re-submitted the retained PIN and logged back in');
    }
    for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForSelector('#view-checklist:not(.hidden)');
    eq(await page.evaluate(() => JSON.parse(sessionStorage.getItem('smartgmv.session')).tok), 'tok-2', 'new token');
  });

  await ctx.close();
}

// ===================================================================================================
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  mock.todayRecords = [rec('K1', 'Alpha Burgers')];

  await test('capture round: photo -> piggyback link, extras, save payload shape, auto-next', page, async (note) => {
    await login(page);
    eq(await text(page, '#prog-sub'), '1 of 3 captured · tap to continue', 'hydrated one saved row');
    assert((await text(page, '#list-evening .merchant-card[data-id="S1-K1-0"] .m-status')).startsWith('✓ 21:00'), 'saved row shows time');
    await page.click('#list-evening .merchant-card[data-id="S1-K2-1"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    const buf = await jpegBuffer(page, 'g');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#card-grab .cam-btn')]);
    assert(await fc.element().evaluate((e) => e.getAttribute('capture') === 'environment'), 'camera input has capture attr');
    await fc.setFiles({ name: 'g.jpg', mimeType: 'image/jpeg', buffer: buf });
    await page.waitForFunction(() => document.getElementById('rf-grab-o').value === '7');
    const ex = mock.log.filter((l) => l.p === '/api/extract').pop();
    note('extract body keys=' + Object.keys(ex.body).join(',') + ' recordId=' + ex.body.recordId + ' photoKind=' + ex.body.photoKind);
    assert(ex.body.image.startsWith('data:image/jpeg;base64,'), 'image re-encoded as JPEG');
    await page.fill('#rf-fp-o', '1'); await page.fill('#rf-fp-g', '9.9');
    await page.click('#btn-save');
    await page.waitForFunction(() => /saved ✓/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    const save = mock.log.filter((l) => l.p === '/api/records' && l.m === 'POST').pop().body;
    eq(save.channels.grab.photoLink, 'https://drive.google.com/file/d/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345/view', 'save reuses the piggybacked link, not the base64 photo');
    assert(!save.channels.grab.photo, 'no base64 in save when link exists');
    eq(save.channels.grab.finalOrders, 7, 'AI orders become final');
    eq(save.channels.fp.finalGmv, 9.9, 'typed fp gmv');
    eq(save.channels.fp.edited, true, 'typed marks edited');
    eq(save.kitchenStatus, 'Operated', 'status');
    eq(save.salesDate, today, 'business date');
    note('recordId=' + save.recordId + ' staff=' + save.staffName);
    eq(await text(page, '#cap-merchant'), 'Gamma Grill', 'auto-next opened K3');
    const keep = await page.evaluate(() => { const r = state.records['S1-K2-1']; return { photoUrlBytes: (r.channels.grab.photoUrl || '').length, link: !!r.channels.grab.photoLink }; });
    note('after save, in-memory base64 kept for K2 grab: ' + keep.photoUrlBytes + ' bytes (link=' + keep.link + ')');
  });

  await test('save failure -> red card, guard lists it, "Retry saving all" succeeds', page, async (note) => {
    // Gamma Grill is Grab-only (fpOn false): only one card required
    eq(await page.locator('#channel-cards .channel-card').count(), 1, 'single-platform brand shows one core card');
    assert((await text(page, '#baseline-banner')).includes('No opening GMV today'), 'overnight brand warns about missing baseline');
    await page.fill('#rf-grab-o', '2'); await page.fill('#rf-grab-g', '20');
    mock.saveStatus = 500;
    await page.click('#btn-save');
    await page.waitForFunction(() => /NOT saved/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    if (!(await page.locator('#view-checklist').isVisible())) await page.click('#btn-capture-back');
    await page.waitForSelector('#view-checklist:not(.hidden)');
    assert((await text(page, '#prog-sub')).includes('1 record not saved'), 'progress says not saved');
    assert(await page.locator('#list-evening .merchant-card[data-id="S1-K3-2"].failed, #list-evening .merchant-card[data-id="S1-K3-2"] .flagred').first().isVisible(), 'red status');
    await page.click('#btn-logout');
    await page.waitForSelector('#guard-overlay:not(.hidden)');
    assert((await text(page, '#guard-list')).includes('Gamma Grill'), 'guard lists failed save');
    mock.saveStatus = 200;
    await page.click('#guard-retry');
    await page.waitForFunction(() => /Gamma Grill saved ✓/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    note('retry ok');
  });

  await test('live round: another phone\'s save appears; a merchant this phone is editing is not overwritten', page, async (note) => {
    await page.click('#list-evening .merchant-card[data-id="S1-K1-0"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.fill('#rf-grab-o', '99');           // local edit on K1, unsaved
    await page.click('#btn-capture-back');
    mock.todayRecords = [rec('K1', 'Alpha Burgers', { channels: { grab: { summaryOrders: 1, summaryGmv: 1 }, fp: { summaryOrders: 1, summaryGmv: 1 } } })];
    mock.version = 50;
    await page.evaluate(() => liveTick());
    await sleep(500);
    await page.evaluate(() => liveTick());
    await sleep(500);
    const local = await page.evaluate(() => state.records['S1-K1-0'].channels.grab.finalOrders);
    eq(local, 99, 'local unsaved edit survives the live refresh');
    note('ok');
  });

  await test('review: edit yesterday, payload carries the past date and the same deterministic id', page, async (note) => {
    mock.history = [{ ...rec('K1', 'Alpha Burgers'), salesDate: yday, recordId: 'S1-K1-x-C-Y' }];
    await page.click('#btn-menu'); await page.click('#menu-review');
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('rv-list').textContent));
    await page.click('#rv-dates .chip[data-o="1"]');
    await page.waitForSelector('#rv-list .merchant-card[data-mid="S1-K1-0"]');
    const q = mock.log.filter((l) => l.p === '/api/records' && l.m === 'GET').pop().q;
    note('history query=' + q);
    await page.click('#rv-list .merchant-card[data-mid="S1-K1-0"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.fill('#rf-grab-o', '6');
    eq(await text(page, '#btn-save'), 'Save changes for ' + await page.evaluate(() => dayLabel(1)), 'label');
    await page.click('#btn-save');
    await page.waitForSelector('#view-review:not(.hidden)');
    const save = mock.log.filter((l) => l.p === '/api/records' && l.m === 'POST').pop().body;
    eq(save.salesDate, yday, 'past date');
    eq(save.recordId, 'S1-K1-x-C-Y', 'server record id reused');
    assert((await text(page, '#rv-list')).includes('amended by Ada Lim'), 'amended badge');
    await page.click('#btn-review-back');
  });

  await test('amendment inbox: card, open, approve -> decide call; reject with reason prompt', page, async (note) => {
    mock.amendments = [{ id: 'am-1', kitchen: 'K1', brand: 'Alpha Burgers', salesDate: today, channel: 'grab', aiOrders: 11, aiGmv: 222.2, aiConfidence: 'high', tenantEmail: 'x@y.z', submittedAt: today + ' 09:00', photoLink: '', photoId: '' },
                       { id: 'am-2', kitchen: 'K1', brand: 'Alpha Burgers', salesDate: today, channel: 'fp', aiOrders: 3, aiGmv: 33, aiConfidence: 'low' }];
    mock.version = 60;
    await page.evaluate(() => liveTick()); await sleep(600);
    await page.waitForSelector('#amend-entry:not(.hidden)');
    eq(await text(page, '#amend-entry-title'), '2 amendment requests waiting', 'card title');
    await page.click('#amend-entry');
    await page.waitForSelector('#view-inbox:not(.hidden)');
    eq(await page.locator('#inbox-list .inbox-card').count(), 2, 'two inbox cards');
    await page.click('#inbox-list .inbox-card[data-id="am-1"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    eq(await page.inputValue('#rf-grab-o'), '11', 'licensee AI reading overlaid');
    assert(await page.locator('#btn-reject').isVisible(), 'reject button');
    eq(await text(page, '#btn-save'), `Approve — overwrite ${today}`, 'approve label');
    await page.click('#btn-save');
    await page.waitForSelector('#convert-overlay:not(.hidden)');
    await page.click('#convert-yes');
    await page.waitForFunction(() => /overwritten ✓/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    const dec = mock.log.filter((l) => l.p.endsWith('/decide')).pop();
    note('decide=' + dec.p + ' ' + JSON.stringify(dec.body));
    eq(dec.body.decision, 'approve', 'approve sent');
    eq(dec.body.finalOrders, 11, 'final orders');
    await page.waitForSelector('#view-inbox:not(.hidden)');
    page.once('dialog', (d) => d.accept('blurry photo'));
    await page.click('#inbox-list .inbox-card[data-id="am-2"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.click('#btn-reject');
    await page.waitForFunction(() => /request rejected/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    const rej = mock.log.filter((l) => l.p.endsWith('/decide')).pop();
    eq(rej.body.reason, 'blurry photo', 'reason sent');
    await page.waitForSelector('#view-checklist:not(.hidden)');
    const fpAfter = await page.evaluate(() => state.records['S1-K1-0'].channels.fp.finalOrders);
    note('fp final after reject (should be the server value 1, not the licensee 3): ' + fpAfter);
    eq(fpAfter, 1, 'reject restores the saved reading');
  });

  await test('opening GMV: "Not operated" auto-closes tonight\'s record', page, async () => {
    await page.click('#list-morning .merchant-card');
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.click('#status-chips .chip[data-s="Not operated"]');
    await page.click('#btn-save');
    await page.waitForFunction(() => /closed for today ✓/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    if (!(await page.locator('#view-checklist').isVisible())) await page.click('#btn-capture-back');
    eq(await text(page, '#list-evening .merchant-card[data-id="S1-K3-2"] .m-status'), '✓ Not operated', 'evening auto-closed');
  });

  await test('add brand from Salesforce customer list -> POST payload; merchant appears', page, async () => {
    await page.click('#btn-menu'); await page.click('#menu-addbrand');
    await page.waitForSelector('#ab-customers .staff-btn');
    await page.fill('#ab-search', 'delta');
    await page.click('#ab-customers .staff-btn');
    await page.waitForSelector('#ab-step2:not(.hidden)');
    await page.fill('#ab-brand', 'Delta Dumplings');
    await page.check('#ab-overnight');
    await page.click('#ab-create');
    await page.waitForFunction(() => /added ✓/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    const post = mock.log.filter((l) => l.p === '/api/merchants' && l.m === 'POST').pop().body;
    eq(post.sfdcId, 'OPP-9', 'opportunity id'); eq(post.overnight, true, 'overnight flag');
    await page.waitForSelector('#view-checklist:not(.hidden)');
    eq(await page.locator('#list-evening .merchant-card').count(), 4, 'new brand in the round');
    eq(await page.locator('#list-morning .merchant-card').count(), 2, 'new overnight brand in the morning list');
  });

  await test('beforeunload guard arms only with unsaved work', page, async () => {
    const armed0 = await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    eq(armed0, false, 'nothing unsaved -> no prompt');
    await page.click('#list-evening .merchant-card[data-id="S1-K2-1"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.evaluate(() => { state.records['S1-K2-1'].draft = true; state.records['S1-K2-1'].saved = false; });
    const armed1 = await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    eq(armed1, true, 'draft -> prompt');
    await page.evaluate(() => { state.records['S1-K2-1'].draft = false; state.records['S1-K2-1'].saved = true; });
    await page.click('#btn-capture-back');
  });

  await ctx.close();
}

// ===================================================================================================  PROBES
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);

  await test('PROBE stale token at boot: catalog 401 leaves the login screen stuck on Retry', page, async (note) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem('smartgmv.session')) sessionStorage.setItem('smartgmv.session', JSON.stringify({ tok: 'stale', staffId: 'st-1' })); });
    await page.goto(BASE);
    await page.waitForSelector('#btn-catalog-retry, #site-grid .site-btn');
    const stuck = await page.locator('#btn-catalog-retry').isVisible();
    note('boot with stale token -> ' + (stuck ? 'ERROR + Retry shown: ' + await text(page, '#site-grid') : 'sites loaded'));
    if (stuck) {
      await page.click('#btn-catalog-retry');
      await page.waitForSelector('#btn-catalog-retry, #site-grid .site-btn');
      const still = await page.locator('#btn-catalog-retry').isVisible();
      note('after Retry: ' + (still ? 'still stuck (same stale token re-sent)' : 'recovered'));
      const auths = mock.log.filter((l) => l.p === '/api/catalog' && l.m === 'GET').map((l) => l.auth);
      note('catalog auth headers sent: ' + JSON.stringify(auths));
      assert(!still, 'boot never recovers from a stale token');
    }
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE stale token is also sent to the PIN verify endpoint', page, async (note) => {
    await page.addInitScript(() => { sessionStorage.setItem('smartgmv.session', JSON.stringify({ tok: 'stale', staffId: 'st-1' })); });
    mock.catalogAuthStatus = 200; // this server tolerates a bad token on the public catalog
    await page.route(API + '/api/catalog', (route) => route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...mock.catalogPre, customers: [], merchants: [] }) }));
    await page.goto(BASE);
    await page.waitForSelector('#site-grid .site-btn');
    await page.click('#site-grid .site-btn');
    await page.click('#staff-list .staff-btn[data-id="st-1"]');
    for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForSelector('#view-checklist:not(.hidden)');
    const v = mock.log.filter((l) => l.p === '/api/staff/verify').pop();
    note('verify auth header = ' + JSON.stringify(v.auth));
    eq(v.auth, '', 'login endpoint should not carry a stale bearer token');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE post-login catalog failure shows "No merchants yet" instead of an error', page, async (note) => {
    mock.catalogPostStatus = 500;
    await page.goto(BASE);
    await page.waitForSelector('#site-grid .site-btn');
    await page.click('#site-grid .site-btn');
    await page.click('#staff-list .staff-btn[data-id="st-1"]');
    for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
    await page.waitForSelector('#view-checklist:not(.hidden)');
    await sleep(500);
    note('prog-sub=' + await text(page, '#prog-sub') + ' | list=' + (await text(page, '#list-evening')).slice(0, 80) + ' | toast=' + await lastToast(page));
    assert(!(await text(page, '#list-evening')).includes('No merchants at this site yet'), 'misleading empty-state after a failed catalog load');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE unknown channel key from the server crashes status change / review baseline card', page, async (note) => {
    mock.todayRecords = [rec('K1', 'Alpha Burgers', { channels: { grab: { summaryOrders: 1, summaryGmv: 1 }, fp: { summaryOrders: 1, summaryGmv: 1 }, deliveroo: { summaryOrders: 4, summaryGmv: 44 } } })];
    await login(page);
    await page.click('#list-evening .merchant-card[data-id="S1-K1-0"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.click('#status-chips .chip[data-s="Locked"]');
    await page.click('#btn-save');
    await sleep(300);
    note('pageerrors=' + JSON.stringify(errs) + ' confirm visible=' + await page.locator('#convert-overlay').isVisible());
    assert(!errs.length, 'Save with a status change threw: ' + errs[0]);
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE billing renders server numbers without escaping (days / totalOrders as strings)', page, async (note) => {
    mock.billing = { month: today.slice(0, 7), merchants: [{ kitchen: 'K1', brand: 'Alpha Burgers', days: '<b id="xss-days">X</b>', totalOrders: '<i id="xss-orders">Y</i>', totalGmv: 10, billableGrabOrders: 1, billableGrabGmv: 10, billableFpOrders: 0, billableFpGmv: 0, othersGmv: 0, cateringGmv: 0, dineinGmv: 0, promoDineinGmv: 0 }],
      totals: { totalOrders: 1, totalGmv: 10, billableGrabOrders: 1, billableGrabGmv: 10, billableFpOrders: 0, billableFpGmv: 0, othersOrders: 0, othersGmv: 0, cateringOrders: 0, cateringGmv: 0, dineinOrders: 0, dineinGmv: 0, promoDineinOrders: 0, promoDineinGmv: 0 }, flags: [] };
    await login(page);
    await page.click('#btn-menu'); await page.click('#menu-billing');
    await page.waitForSelector('#bl-body .merchant-card');
    const injected = await page.evaluate(() => ({ days: !!document.getElementById('xss-days'), orders: !!document.getElementById('xss-orders') }));
    note('markup injected via billing fields: ' + JSON.stringify(injected));
    assert(!injected.days && !injected.orders, 'billing row interpolates server fields raw');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE dine-in read values land in attributes unescaped (attribute injection)', page, async (note) => {
    mock.dinein = { monthLabel: "Sep '26", salesDate: today.slice(0, 7) + '-01', rows: [{ kitchen: 'K1', matchedBrand: 'Hall Noodles', sfdcId: 'H1',
      dineinOrders: '" autofocus onfocus="window.__inj=1', dineinGmv: 1, promoOrders: 0, promoGmv: 0, totalOrders: 1 }], crossCheck: { matches: true }, unmatched: [], notes: '' };
    await login(page, 'st-1', 1);   // S12
    await page.waitForSelector('#dinein-entry:not(.hidden)');
    await page.click('#dinein-entry');
    await page.waitForSelector('#di-pick');
    const buf = await jpegBuffer(page, 'sheet');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#di-pick')]);
    await fc.setFiles({ name: 's.jpg', mimeType: 'image/jpeg', buffer: buf });
    await page.waitForSelector('#di-save');
    const inj = await page.evaluate(() => window.__inj === 1);
    note('attribute injection executed: ' + inj);
    assert(!inj, 'dine-in AI values are inserted into value="" without esc()');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE catering: toggling a brand into catering re-indexes ids and orphans a saved record', page, async (note) => {
    await login(page, 'st-1', 2);   // CATERING pseudo-site: Beta Bowls, Gamma Grill
    eq(await page.locator('#list-evening .merchant-card').count(), 2, 'two catering brands');
    const idsBefore = await page.$$eval('#list-evening .merchant-card', (l) => l.map((c) => c.dataset.id));
    await page.click('#list-evening .merchant-card[data-id="' + idsBefore[1] + '"]');   // Gamma Grill
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.fill('#rf-catering-o', '3'); await page.fill('#rf-catering-g', '150');
    await page.click('#btn-save');
    await page.waitForFunction(() => /catering saved ✓/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    assert((await text(page, '#list-evening .merchant-card[data-id="' + idsBefore[1] + '"] .m-status')).startsWith('✓'), 'Gamma saved');
    await page.click('#btn-menu'); await page.click('#menu-addbrand');
    await page.waitForSelector('#ab-customers [data-cat-brand="Alpha Burgers"]');
    await page.click('#ab-customers [data-cat-brand="Alpha Burgers"]');
    await page.waitForFunction(() => /added to catering ✓/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    await page.click('#btn-addbrand-back');
    const idsAfter = await page.$$eval('#list-evening .merchant-card', (l) => l.map((c) => c.dataset.id + ':' + c.querySelector('.m-status').textContent.trim()));
    note('before=' + JSON.stringify(idsBefore) + ' after=' + JSON.stringify(idsAfter));
    const gamma = idsAfter.find((s) => s.includes('K3'));
    assert(gamma && gamma.split(':')[1].startsWith('✓'), 'Gamma Grill lost its saved state after the catering list re-indexed');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE photo picked for kitchen A lands on kitchen B when decode is slow and the user moves on', page, async (note) => {
    await login(page);
    await page.evaluate(() => { window.downscale = (d) => new Promise((r) => setTimeout(() => r(d), 1500)); });
    await page.click('#list-evening .merchant-card[data-id="S1-K1-0"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    const buf = await jpegBuffer(page, 'A');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#card-grab .up-btn')]);
    await fc.setFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: buf });
    await page.click('#btn-capture-back');
    await page.click('#list-evening .merchant-card[data-id="S1-K2-1"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    await sleep(2500);
    const where = await page.evaluate(() => ({ A: !!(state.records['S1-K1-0']?.channels.grab?.photoUrl), B: !!(state.records['S1-K2-1']?.channels.grab?.photoUrl) }));
    note('photo attached to: ' + JSON.stringify(where));
    assert(where.A && !where.B, 'photo attached to the wrong merchant');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE amendments from the previous site remain on the Catering entry', page, async (note) => {
    mock.todayRecords = [rec('K1', 'Alpha Burgers')];
    mock.amendments = [{ id: 'am-1', kitchen: 'K1', brand: 'Alpha Burgers', salesDate: today, channel: 'grab', aiOrders: 1, aiGmv: 1 }];
    await login(page);
    await page.waitForSelector('#amend-entry:not(.hidden)');
    await page.click('#btn-menu'); await page.click('#menu-site');
    await page.waitForSelector('#site-overlay:not(.hidden)');
    await page.click('#site-switch-grid .site-btn[data-site="CATERING"]');
    await page.waitForSelector('#view-checklist:not(.hidden)');
    await sleep(400);
    const shown = await page.locator('#amend-entry').isVisible();
    note('amendment card on Catering entry: ' + shown + ' hdr=' + await text(page, '#hdr-site'));
    assert(!shown, 'stale amendment card shown on a site that has none');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE Review "Today" chip -> save -> auto-next jumps to another kitchen instead of returning to Review', page, async (note) => {
    mock.todayRecords = [rec('K1', 'Alpha Burgers')];
    await login(page);
    await page.click('#btn-menu'); await page.click('#menu-review');
    await page.waitForFunction(() => !/Loading/.test(document.getElementById('rv-list').textContent));
    await page.click('#rv-list .merchant-card[data-mid="S1-K1-0"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.fill('#rf-grab-o', '8');
    await page.click('#btn-save');
    await sleep(800);
    const view = await page.evaluate(() => [...document.querySelectorAll('.view')].find((v) => !v.classList.contains('hidden')).id + ':' + document.getElementById('cap-merchant').textContent);
    note('after save from Review/Today -> ' + view);
    assert(view.startsWith('view-review'), 'did not return to Review');
  });
  await ctx.close();
}

{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE retake after a manual edit: old typed value and old marks survive onto the new photo', page, async (note) => {
    await login(page);
    await page.click('#list-evening .merchant-card[data-id="S1-K1-0"]');
    await page.waitForSelector('#view-capture:not(.hidden)');
    const buf = await jpegBuffer(page, 'first');
    let [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#card-grab .up-btn')]);
    await fc.setFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: buf });
    await page.waitForFunction(() => document.getElementById('rf-grab-o').value === '7');
    await page.fill('#rf-grab-o', '50');                       // staff "corrects" the wrong screen
    await page.evaluate(() => { const v = state.records['S1-K1-0'].channels.grab; v.marks = [{ box: { x: 1, y: 1, w: 10, h: 10 }, value: 50, kind: 'orders' }]; });
    [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#card-grab .retake')]);
    await fc.setFiles({ name: 'b.jpg', mimeType: 'image/jpeg', buffer: await jpegBuffer(page, 'second') });
    await page.waitForFunction(() => !state.records['S1-K1-0'].channels.grab.pendingAI);
    const v = await page.evaluate(() => { const c = state.records['S1-K1-0'].channels.grab; return { finalOrders: c.finalOrders, aiOrders: c.aiOrders, marks: (c.marks || []).length, editedOrders: c.editedOrders }; });
    note('after retake: ' + JSON.stringify(v));
    eq(v.marks, 0, 'marks from the previous photo should be dropped on retake');
    eq(v.finalOrders, 7, 'AI reading of the NEW photo should apply (old manual edit was for the old photo)');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE business date frozen at login: a phone left logged in overnight files the 10 am opening on yesterday', page, async (note) => {
    await page.clock.install({ time: new Date('2026-09-24T23:30:00+08:00') });
    await login(page);
    note('header date=' + await text(page, '#hdr-date') + ' salesDate=' + await page.evaluate(() => state.salesDate));
    await page.clock.setFixedTime(new Date('2026-09-25T10:05:00+08:00'));
    await page.click('#list-morning .merchant-card');            // Gamma Grill opening GMV
    await page.waitForSelector('#view-capture:not(.hidden)');
    await page.fill('#rf-grab-o', '1'); await page.fill('#rf-grab-g', '5');
    await page.click('#btn-save');
    await page.waitForFunction(() => /opening GMV recorded/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    const save = mock.log.filter((l) => l.p === '/api/records' && l.m === 'POST').pop().body;
    note('opening saved at 10:05 on 25 Sep carries salesDate=' + save.salesDate + ' recordId=' + save.recordId);
    eq(save.salesDate, '2026-09-25', 'business date should be re-evaluated for a new day');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('XSS sweep: hostile brand / site / staff / customer names across every screen', page, async (note) => {
    const evil = (s) => `${s} <img src=x onerror="window.__x=(window.__x||0)+1">`;
    mock.catalogPre.sites[0].name = evil('Alpha');
    mock.catalogPre.staff[0].name = evil('Ada');
    mock.merchants[0].brand = evil('Burgers'); mock.merchants[1].brand = evil('Bowls');
    mock.todayRecords = [rec('K1', mock.merchants[0].brand, { staff: evil('Other') + ' (st-9)', billingFlag: evil('CHECK') })];
    mock.amendments = [{ id: 'am-1', kitchen: 'K1', brand: mock.merchants[0].brand, salesDate: today, channel: 'grab', aiOrders: 1, aiGmv: 1, tenantEmail: evil('mail') }];
    mock.history = [{ ...rec('K1', mock.merchants[0].brand), salesDate: yday, recordId: 'Y' }];
    mock.billing = { month: today.slice(0, 7), merchants: [{ kitchen: 'K1', brand: evil('B'), days: 1, totalOrders: 1, totalGmv: 1, billableGrabOrders: 1, billableGrabGmv: 1, billableFpOrders: 0, billableFpGmv: 0, othersGmv: 0, cateringGmv: 0, dineinGmv: 0, promoDineinGmv: 0 }],
      totals: { totalOrders: 1, totalGmv: 1, billableGrabOrders: 1, billableGrabGmv: 1, billableFpOrders: 0, billableFpGmv: 0, othersOrders: 0, othersGmv: 0, cateringOrders: 0, cateringGmv: 0, dineinOrders: 0, dineinGmv: 0, promoDineinOrders: 0, promoDineinGmv: 0 },
      flags: [{ date: today, kitchen: 'K1', brand: evil('F'), flag: evil('FLAG'), edited: true }] };
    await login(page);
    await page.waitForSelector('#amend-entry:not(.hidden)');
    await page.click('#amend-entry'); await page.waitForSelector('#view-inbox:not(.hidden)'); await page.click('#btn-inbox-back');
    await page.click('#list-evening .merchant-card[data-id="S1-K1-0"]'); await page.waitForSelector('#view-capture:not(.hidden)');
    await page.click('#status-chips .chip[data-s="Locked"]'); await page.click('#btn-save'); await page.click('#convert-cancel'); await page.click('#btn-capture-back');
    await page.click('#btn-menu'); await page.click('#menu-review'); await page.waitForFunction(() => !/Loading/.test(document.getElementById('rv-list').textContent));
    await page.click('#rv-dates .chip[data-o="1"]'); await page.waitForSelector('#rv-list .merchant-card'); await page.click('#btn-review-back');
    await page.click('#btn-menu'); await page.click('#menu-billing'); await page.waitForSelector('#bl-body .merchant-card'); await page.click('#btn-billing-back');
    await page.click('#btn-menu'); await page.click('#menu-brands'); await page.waitForSelector('#mb-list .mb-card'); await page.click('#btn-brands-back');
    await page.click('#btn-menu'); await page.click('#menu-addbrand'); await page.waitForSelector('#ab-customers'); await page.click('#btn-addbrand-back');
    await page.click('#btn-menu'); await page.click('#menu-site'); await page.waitForSelector('#site-overlay:not(.hidden)');
    await page.click('#site-switch-grid .site-btn[data-site="CATERING"]'); await page.waitForSelector('#view-checklist:not(.hidden)');
    await page.click('#btn-menu'); await page.click('#menu-addbrand'); await page.waitForSelector('#ab-customers .staff-btn'); await page.click('#btn-addbrand-back');
    await page.click('#btn-logout'); if (await page.locator('#guard-overlay').isVisible()) await page.click('#guard-logout');
    await page.waitForSelector('#resume-wrap .staff-btn.resume');
    const fired = await page.evaluate(() => window.__x || 0);
    const imgs = await page.evaluate(() => document.querySelectorAll('img[src$="x"], img[src="x"]').length);
    note('onerror fired=' + fired + ' injected img elements=' + imgs);
    eq(fired, 0, 'hostile names executed script');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE photo proxy: session token travels in the image URL query string', page, async (note) => {
    mock.todayRecords = [rec('K1', 'Alpha Burgers', { channels: { grab: { summaryOrders: 1, summaryGmv: 1, photoLink: 'https://drive.google.com/file/d/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345/view', photoId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }, fp: { summaryOrders: 1, summaryGmv: 1 } } })];
    await login(page);
    await page.click('#list-evening .merchant-card[data-id="S1-K1-0"]');
    await page.waitForSelector('#card-grab img.thumb');
    await sleep(300);
    const ph = mock.log.find((l) => l.p.startsWith('/api/photo/'));
    note('photo request: ' + (ph ? ph.p + ph.q : 'none'));
    assert(ph && /t=tok-1/.test(ph.q), 'token in query string (documented trade-off; shows up in server/proxy logs)');
  });
  await ctx.close();
}
{
  const ctx = await makeContext(browser); const page = await ctx.newPage(); const mock = freshMock(); await install(page, mock);
  await test('PROBE dine-in: invalid typed values are not blocked; NaN becomes null in the save', page, async (note) => {
    mock.dinein = { monthLabel: "Sep '26", salesDate: today.slice(0, 7) + '-01', rows: [{ kitchen: 'K1', matchedBrand: 'Hall Noodles', sfdcId: 'H1', dineinOrders: 10, dineinGmv: 100, promoOrders: 0, promoGmv: 0, totalOrders: 10 }], crossCheck: { matches: true }, unmatched: [], notes: '' };
    await login(page, 'st-1', 1);
    await page.waitForSelector('#dinein-entry:not(.hidden)');
    await page.click('#dinein-entry');
    const buf = await jpegBuffer(page, 'sheet');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#di-pick')]);
    await fc.setFiles({ name: 's.jpg', mimeType: 'image/jpeg', buffer: buf });
    await page.waitForSelector('#di-save');
    await page.fill('[data-di="0"][data-f="dineinGmv"]', 'abc');
    const disabled = await page.locator('#di-save').isDisabled();
    await page.click('#di-save');
    await page.waitForFunction(() => /saved for/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    const save = mock.log.filter((l) => l.p === '/api/dinein/save').pop().body;
    note('save button disabled with invalid input: ' + disabled + '; saved dineinGmv=' + JSON.stringify(save.rows[0].dineinGmv));
    assert(disabled, 'invalid dine-in value was saved as ' + JSON.stringify(save.rows[0].dineinGmv));
  });
  await ctx.close();
}

await browser.close();
report('MOCKED BACKEND');
