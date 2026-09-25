import { chromium, BASE, API, report, assert, eq, makeContext, test, jpegBuffer, text, sleep, PNG1x1 } from './harness.mjs';

const browser = await chromium.launch();
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS' };
const ctx = await makeContext(browser); const page = await ctx.newPage();
let todayDelay = 0;
await page.route(API + '/**', async (route) => {
  const req = route.request(); const p = new URL(req.url()).pathname; const m = req.method();
  const json = (obj, status = 200) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (p === '/api/catalog') return json({ sites: [{ id: 'S1', name: 'Alpha', merchantCount: 1 }], staff: [{ id: 'st-1', name: 'Ada', homeSites: ['S1'], needsPin: false }], customers: [],
    merchants: req.headers()['authorization'] ? [{ facility: 'S1', site: 'Alpha', kitchen: 'K1', brand: 'Alpha Burgers', sfdcId: 'A1' }] : [] });
  if (p === '/api/staff/verify') return json({ ok: true, token: 't', staff: { id: 'st-1', name: 'Ada' } });
  if (p === '/api/records/today') { await sleep(todayDelay); return json({ records: [], version: 1 }); }
  if (p === '/api/amendments') return json({ amendments: [] });
  if (p === '/api/extract') { await sleep(300); return json({ orders: 7, gmv: 210.25, confidence: 'high', screen_summary: 's' }); }
  if (p.startsWith('/api/photo/')) return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'image/png' }, body: PNG1x1 });
  return json({}, 404);
});

await test('PROBE "Checking the server…" state is never painted during hydration', page, async (note) => {
  todayDelay = 1500;
  await page.goto(BASE);
  await page.click('#site-grid .site-btn'); await page.click('#staff-list .staff-btn[data-id="st-1"]');
  for (const k of '1234') await page.click(`#pin-pad .pin-key[data-k="${k}"]`);
  await page.waitForSelector('#view-checklist:not(.hidden)');
  await sleep(500);
  const during = await text(page, '#prog-sub');
  const hydrating = await page.evaluate(() => state.hydrating);
  note(`while /api/records/today is pending: state.hydrating=${hydrating}, prog-sub="${during}"`);
  await page.waitForFunction(() => !state.hydrating);
  assert(/Checking/.test(during), 'hydrating message never shown');
});

await test('PROBE a cleared field swallows the AI reading: value displayed, Save stays locked', page, async (note) => {
  todayDelay = 0;
  await page.click('#list-evening .merchant-card');
  await page.waitForSelector('#view-capture:not(.hidden)');
  await page.fill('#rf-grab-o', '5');          // staff starts typing, then clears it
  await page.fill('#rf-grab-o', '');
  const buf = await jpegBuffer(page, 'g');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#card-grab .up-btn')]);
  await fc.setFiles({ name: 'g.jpg', mimeType: 'image/jpeg', buffer: buf });
  await page.waitForFunction(() => !state.records[state.current.m.id].channels.grab.pendingAI);
  await page.fill('#rf-fp-o', '1'); await page.fill('#rf-fp-g', '1');
  const v = await page.evaluate(() => { const c = state.records[state.current.m.id].channels.grab; return { shownOrders: document.getElementById('rf-grab-o').value, shownGmv: document.getElementById('rf-grab-g').value, finalOrders: c.finalOrders, finalGmv: c.finalGmv, aiOrders: c.aiOrders, editedOrders: c.editedOrders }; });
  note('grab after AI read: ' + JSON.stringify(v) + ' | save button: "' + await text(page, '#btn-save') + '" disabled=' + await page.locator('#btn-save').isDisabled() + ' ring=' + await text(page, '#cap-ring-label'));
  eq(v.finalOrders, 7, 'AI orders should be adopted when the field was empty');
});

await browser.close();
report('PROBE 3');
