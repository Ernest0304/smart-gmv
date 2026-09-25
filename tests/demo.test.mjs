// Demo-mode walkthrough (?demo=1): every screen, every flow the canned backend supports.
import { chromium, BASE, results, report, assert, eq, makeContext, test, jpegBuffer, text, sleep, lastToast, overflow } from './harness.mjs';

const browser = await chromium.launch();
const ctx = await makeContext(browser);
const page = await ctx.newPage();
const shots = new URL('./shots/', import.meta.url).pathname;
await import('node:fs').then((fs) => fs.mkdirSync(shots, { recursive: true }));

const pickFile = async (trigger, buf, name = 'shot.jpg') => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), trigger()]);
  await fc.setFiles({ name, mimeType: 'image/jpeg', buffer: buf });
};

await test('boot: login view, site list from demo catalog, no errors', page, async (note) => {
  await page.goto(BASE + '?demo=1');
  await page.waitForSelector('#site-grid .site-btn');
  eq(await text(page, '#site-grid .site-btn'), 'Tampines (demo)S1 · 8 merchants', 'site button text');
  assert(await page.locator('#view-login').isVisible(), 'login visible');
  eq(await text(page, '#hero-live'), 'PREVIEW', 'hero badge');
  note('title=' + await page.title());
});

await test('login: site -> staff list -> search filter -> register step and back', page, async () => {
  await page.click('#site-grid .site-btn');
  await page.waitForSelector('#login-step-staff:not(.hidden)');
  eq(await page.locator('#staff-list .staff-btn[data-id]').count(), 1, 'one demo staff');
  await page.fill('#staff-search', 'zzz');
  assert((await text(page, '#staff-list')).includes('No name matches'), 'no-match note');
  await page.fill('#staff-search', '');
  await page.click('#btn-register');
  await page.waitForSelector('#login-step-register:not(.hidden)');
  assert(await page.locator('#reg-submit').isDisabled(), 'register disabled initially');
  await page.fill('#reg-name', 'Test Person');
  await page.fill('#reg-pin', '1234'); await page.fill('#reg-pin2', '1235');
  assert(await page.locator('#reg-pin-note').isVisible(), 'mismatch note shown');
  assert(await page.locator('#reg-submit').isDisabled(), 'register disabled on mismatch');
  await page.fill('#reg-pin2', '1234');
  assert(!(await page.locator('#reg-submit').isDisabled()), 'register enabled when valid');
  await page.click('#login-step-register .back-link');
  await page.waitForSelector('#login-step-staff:not(.hidden)');
});

await test('demo login lands on the checklist with server-hydrated state', page, async (note) => {
  await page.click('#staff-list .staff-btn[data-id]');
  await page.waitForSelector('#view-checklist:not(.hidden)');
  await page.waitForFunction(() => /^2 of 8/.test(document.getElementById('prog-sub').textContent));
  eq(await text(page, '#prog-sub'), '2 of 8 captured · tap to continue', 'progress line');
  eq(await text(page, '#prog-left'), '6', 'left count');
  eq(await text(page, '#prog-flag'), '⚑ 1 to check', 'flag count');
  eq(await page.locator('#list-evening .merchant-card').count(), 8, 'eight evening cards');
  eq(await page.locator('#list-morning .merchant-card').count(), 1, 'one overnight card');
  assert((await text(page, '#list-morning .merchant-card .m-status')).startsWith('✓ 10:12'), 'baseline saved at 10:12');
  note('hdr=' + await text(page, '#hdr-site') + ' / ' + await text(page, '#hdr-staff'));
  await page.screenshot({ path: shots + '/checklist-mobile.png', fullPage: true });
});

await test('capture: manual numbers -> save -> auto-next opens next waiting kitchen', page, async (note) => {
  await page.click('#list-evening .merchant-card[data-id="S1-K13-3"]');
  await page.waitForSelector('#view-capture:not(.hidden)');
  eq(await text(page, '#cap-merchant'), 'Wok & Ladle', 'merchant title');
  assert(await page.locator('#btn-save').isDisabled(), 'save disabled');
  eq(await page.locator('#status-chips .chip').count(), 4, 'four status chips');
  await page.fill('#rf-grab-o', '12'); await page.fill('#rf-grab-g', '300.5');
  await page.fill('#rf-fp-o', '3'); await page.fill('#rf-fp-g', '80');
  eq(await text(page, '#cap-ring-label'), '2/2', 'ring 2/2');
  assert(!(await page.locator('#btn-save').isDisabled()), 'save enabled after typing');
  eq(await text(page, '#btn-save'), 'Confirm & save', 'button label');
  await page.click('#btn-save');
  await page.waitForFunction(() => document.getElementById('cap-merchant').textContent === 'Satay After Dark');
  note('toast=' + await lastToast(page));
  await page.waitForFunction(() => /saved ✓/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  await page.click('#btn-capture-back');
  await page.waitForSelector('#view-checklist:not(.hidden)');
  const st = await text(page, '#list-evening .merchant-card[data-id="S1-K13-3"] .m-status');
  assert(st.startsWith('✓'), 'K13 shows saved: ' + st);
  assert((await text(page, '#list-evening .merchant-card[data-id="S1-K13-3"] .m-total')) === '$380.50', 'K13 total');
  eq(await text(page, '#prog-sub'), '3 of 8 captured · tap to continue', 'progress after save');
});

await test('input validation: negative / non-numeric blocks save, clearing restores', page, async () => {
  await page.click('#list-evening .merchant-card[data-id="S1-K19-4"]');
  await page.waitForSelector('#view-capture:not(.hidden)');
  await page.fill('#rf-grab-o', '-4');
  assert(await page.locator('#rf-grab-o').evaluate((e) => e.closest('.rf').classList.contains('bad')), 'bad class on negative');
  await page.fill('#rf-grab-g', 'abc');
  eq(await text(page, '#btn-save'), 'Fix the highlighted numbers', 'invalid label');
  await page.fill('#rf-grab-o', ''); await page.fill('#rf-grab-g', '');
  assert(await page.locator('#btn-save').isDisabled(), 'save disabled after clearing');
});

await test('photo upload -> background AI read fills the fields (demo engine)', page, async (note) => {
  const buf = await jpegBuffer(page, 'GRAB 40');
  await pickFile(() => page.click('#card-grab .up-btn'), buf);
  await page.waitForSelector('#card-grab img.thumb');
  assert((await text(page, '#card-grab .ch-body')).includes('AI reading in background'), 'pending note');
  await page.waitForFunction(() => document.getElementById('rf-grab-o').value === '40', null, { timeout: 8000 });
  eq(await page.inputValue('#rf-grab-g'), '958.00', 'gmv filled by AI');
  assert((await text(page, '#card-grab .ch-body')).includes('high confidence'), 'confidence line');
  note('ring=' + await text(page, '#cap-ring-label'));
});

await test('photo viewer: drag a box, type value, save as Orders -> field updated & mark drawn', page, async () => {
  await page.click('#card-grab img.thumb');
  await page.waitForSelector('#viewer-overlay:not(.hidden)');
  await page.waitForFunction(() => document.getElementById('viewer-img').complete && document.getElementById('viewer-img').naturalWidth > 0);
  const box = await page.locator('#viewer-stage').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 170, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('#viewer-choice:not(.hidden)');
  await page.fill('#vc-input', '41');
  await page.click('#vc-orders');
  eq(await page.locator('#viewer-boxes .vbox').count(), 1, 'one mark drawn');
  await page.click('#viewer-close');
  await page.waitForSelector('#viewer-overlay.hidden', { state: 'attached' });
  eq(await page.inputValue('#rf-grab-o'), '41', 'orders updated from mark');
});

await test('no-sales declaration on foodpanda -> confirm sheet -> 0/0 recorded; undo restores', page, async () => {
  await page.click('#card-fp .ns-btn');
  await page.waitForSelector('#convert-overlay:not(.hidden)');
  await page.click('#convert-cancel');
  await page.waitForSelector('#convert-overlay.hidden', { state: 'attached' });
  assert(await page.locator('#card-fp .ns-btn').isVisible(), 'cancel keeps the button');
  await page.click('#card-fp .ns-btn');
  await page.click('#convert-yes');
  assert((await text(page, '#card-fp .ch-body')).includes('No sales today'), 'no-sales box');
  eq(await text(page, '#cap-ring-label'), '2/2', 'ring full');
  await page.click('#card-fp .ns-undo');
  assert(await page.locator('#card-fp .ns-btn').isVisible(), 'undo restores the button');
  await page.click('#card-fp .ns-btn'); await page.click('#convert-yes');
});

await test('pending-pickup extras: add 2 from gallery, AI fills amounts, total strip, dup/removal', page, async (note) => {
  const b1 = await jpegBuffer(page, 'ORDER 1'), b2 = await jpegBuffer(page, 'ORDER 2');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#card-grab [data-xadd="lib"]')]);
  assert(fc.isMultiple(), 'gallery input is multiple');
  await fc.setFiles([{ name: 'o1.jpg', mimeType: 'image/jpeg', buffer: b1 }, { name: 'o2.jpg', mimeType: 'image/jpeg', buffer: b2 }]);
  await page.waitForFunction(() => document.querySelectorAll('#card-grab .extra-row').length === 2);
  eq(await text(page, '#btn-save'), 'GrabFood: 2 pending orders need amounts', 'save blocked while AI reads');
  await page.waitForFunction(() => [...document.querySelectorAll('#card-grab .x-amt')].every((i) => i.value !== ''), null, { timeout: 8000 });
  note('extras amounts=' + JSON.stringify(await page.$$eval('#card-grab .x-amt', (l) => l.map((i) => i.value))));
  assert((await text(page, '#card-grab .total-strip')).includes('Recorded total: 43 orders'), 'total strip counts extras: ' + await text(page, '#card-grab .total-strip'));
  await page.fill('#card-grab .x-amt[data-x="1"]', '0');
  eq(await text(page, '#btn-save'), 'GrabFood: 1 pending order needs an amount', 'zero amount blocks');
  await page.fill('#card-grab .x-amt[data-x="1"]', '12.5');
  await page.click('#card-grab [data-xdel="1"]');
  await page.click('#convert-yes');
  eq(await page.locator('#card-grab .extra-row').count(), 1, 'one extra left');
  eq(await text(page, '#btn-save'), 'Confirm & save', 'save ready');
});

await test('status change with data asks to clear; "Not operated" saves without channel data', page, async (note) => {
  await page.click('#status-chips .chip[data-s="Not operated"]');
  assert((await text(page, '#channel-cards')).includes('No sales fields needed'), 'no-fields banner');
  eq(await text(page, '#btn-save'), 'Save as “Not operated”', 'label');
  await page.click('#btn-save');
  await page.waitForSelector('#convert-overlay:not(.hidden)');
  note('confirm detail=' + await text(page, '#convert-detail'));
  await page.click('#convert-cancel');
  await page.click('#status-chips .chip[data-s="Operated"]');
  await page.waitForSelector('#card-grab');
  eq(await page.inputValue('#rf-grab-o'), '41', 'data kept after cancel');
});

await test('snap & go: photos in, AI still reading -> "next kitchen" parks a draft; checklist shows it', page, async (note) => {
  // slow the demo read so the draft path is reachable
  await page.evaluate(() => { const orig = DEMO.fetch; window.__origFetch = orig;
    DEMO.fetch = async (p, o) => { if (p === '/api/extract') await new Promise((r) => setTimeout(r, 4000)); return orig(p, o); }; });
  await page.click('#btn-capture-back');
  await page.click('#list-evening .merchant-card[data-id="S1-K21-5"]');
  await page.waitForSelector('#view-capture:not(.hidden)');
  const buf = await jpegBuffer(page, 'x');
  await pickFile(() => page.click('#card-grab .up-btn'), buf);
  await pickFile(() => page.click('#card-fp .up-btn'), buf);
  await page.waitForFunction(() => document.getElementById('btn-save').textContent.includes('next kitchen'));
  await page.click('#btn-save');
  await page.waitForFunction(() => !document.getElementById('view-capture').classList.contains('hidden') && document.getElementById('cap-merchant').textContent !== 'Pandan Bakehouse');
  note('auto-next went to: ' + await text(page, '#cap-merchant') + ' toast=' + await lastToast(page));
  await page.click('#btn-capture-back');
  const st = await text(page, '#list-evening .merchant-card[data-id="S1-K21-5"] .m-status');
  assert(/reading/.test(st), 'card shows reading: ' + st);
  await page.waitForFunction(() => /confirm readings/.test(document.querySelector('#list-evening .merchant-card[data-id="S1-K21-5"] .m-status').textContent), null, { timeout: 10000 });
  await page.evaluate(() => { DEMO.fetch = window.__origFetch; });
});

await test('logout guard lists the unconfirmed draft; cancel keeps the session', page, async (note) => {
  await page.click('#btn-logout');
  await page.waitForSelector('#guard-overlay:not(.hidden)');
  note('guard=' + await text(page, '#guard-list'));
  assert((await text(page, '#guard-list')).includes('Pandan Bakehouse'), 'draft listed');
  await page.click('#guard-cancel');
  await page.waitForSelector('#guard-overlay.hidden', { state: 'attached' });
});

await test('OS back gesture closes the top layer instead of leaving the app', page, async () => {
  await page.click('#btn-menu');
  await page.waitForSelector('#menu-overlay:not(.hidden)');
  await page.goBack();
  await page.waitForSelector('#menu-overlay.hidden', { state: 'attached' });
  assert(page.url().startsWith(BASE), 'still on the app');
  await page.click('#list-evening .merchant-card[data-id="S1-K21-5"]');
  await page.waitForSelector('#view-capture:not(.hidden)');
  await page.goBack();
  await page.waitForSelector('#view-checklist:not(.hidden)');
  await page.goBack();  // on the root: stays
  await sleep(200);
  assert(await page.locator('#view-checklist').isVisible(), 'root stays put');
});

await test('morning opening GMV: saved baseline opens read-back; status save asks to clear shots', page, async (note) => {
  await page.click('#list-morning .merchant-card');
  await page.waitForSelector('#view-capture:not(.hidden)');
  eq(await text(page, '#btn-save'), 'Opening GMV recorded ✓ — back to list', 'saved baseline label');
  eq(await page.locator('#status-chips .chip').count(), 3, 'three baseline statuses');
  await page.click('#status-chips .chip[data-s="No Sales"]');
  eq(await text(page, '#btn-save'), 'Save opening as “No Sales”', 'label');
  await page.click('#btn-save');
  await page.waitForSelector('#convert-overlay:not(.hidden)');
  await page.click('#convert-yes');
  await page.waitForFunction(() => /no overnight sales recorded/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  note('toast=' + await lastToast(page));
  if (!(await page.locator('#view-checklist').isVisible())) await page.click('#btn-capture-back');
  await page.waitForSelector('#view-checklist:not(.hidden)');
  eq(await text(page, '#list-morning .merchant-card .m-status'), '✓ no sales', 'morning card');
});

await test('review: chips, today rows, empty past day, out-of-range date guard', page, async (note) => {
  await page.click('#btn-menu'); await page.click('#menu-review');
  await page.waitForSelector('#view-review:not(.hidden)');
  eq(await page.locator('#rv-dates .chip').count(), 7, 'seven chips');
  await page.waitForFunction(() => !/Loading/.test(document.getElementById('rv-list').textContent));
  const todayCards = await page.locator('#rv-list .merchant-card[data-mid]').count();
  note('today cards=' + todayCards);
  assert(todayCards >= 3, 'today shows saved rows');
  await page.click('#rv-dates .chip[data-o="1"]');
  await page.waitForFunction(() => /No records saved/.test(document.getElementById('rv-list').textContent));
  assert((await text(page, '#rv-list')).includes('add record'), 'missing rows offer back-fill');
  await page.fill('#rv-date', '2020-01-01');
  await page.dispatchEvent('#rv-date', 'change');
  assert((await lastToast(page)).includes('within the last 30 days'), 'range guard toast');
  await page.click('#rv-list .merchant-card.rv-add');
  await page.waitForSelector('#view-capture:not(.hidden)');
  assert((await text(page, '#cap-sub')).includes('editing'), 'editing label: ' + await text(page, '#cap-sub'));
  await page.click('#btn-capture-back');
  await page.waitForSelector('#view-review:not(.hidden)');
  await page.click('#btn-review-back');
});

await test('monthly billing: totals, filter, custom range', page, async (note) => {
  await page.click('#btn-menu');
  assert(await page.locator('#menu-billing').isVisible(), 'billing entry for reports=true');
  await page.click('#menu-billing');
  await page.waitForSelector('#view-billing:not(.hidden)');
  await page.waitForSelector('#bl-body .merchant-card');
  eq(await page.locator('#bl-body .merchant-card').count(), 8, 'eight billing rows');
  note('big=' + await text(page, '.bl-big'));
  await page.fill('#bl-search', 'mochi');
  eq(await page.locator('#bl-body .merchant-card').count(), 1, 'filter narrows');
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'bl-search'), 'focus kept while typing');
  await page.click('#bl-months .chip[data-m="custom"]');
  await page.waitForSelector('#bl-range:not(.hidden)');
  await page.fill('#bl-from', '2026-09-10'); await page.fill('#bl-to', '2026-09-01');
  await page.click('#bl-apply');
  assert((await lastToast(page)).includes('valid range'), 'range validation');
  await page.fill('#bl-to', '2026-09-20');
  await page.click('#bl-apply');
  await page.waitForFunction(() => /→/.test(document.querySelector('#bl-body .bl-cap')?.textContent || ''));
  await page.screenshot({ path: shots + '/billing-mobile.png', fullPage: true });
  await page.click('#btn-billing-back');
});

await test('manage brands: failed PATCH reverts the optimistic flip and says so', page, async (note) => {
  await page.click('#btn-menu'); await page.click('#menu-brands');
  await page.waitForSelector('#view-brands:not(.hidden)');
  eq(await page.locator('#mb-list .mb-card').count(), 8, 'eight brand cards');
  const first = page.locator('#mb-list .mb-card').first();
  await first.locator('.mb-moon').click();
  await page.waitForFunction(() => /NOT saved/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  assert(!(await first.locator('.mb-moon').evaluate((e) => e.classList.contains('on'))), 'moon reverted');
  await first.locator('.mb-ch[data-ch="grab"]').click();
  await page.waitForFunction(() => /Could not update/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  assert(await first.locator('.mb-ch[data-ch="grab"]').evaluate((e) => e.classList.contains('on')), 'grab reverted');
  await first.locator('.mb-state').click();
  await page.waitForFunction(() => /NOT saved/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
  eq(await first.locator('.mb-state').textContent(), 'Active', 'disable reverted');
  note('brands ok');
  await page.click('#btn-brands-back');
});

await test('add new brand: page 1 lists contracted customers (none in demo), page 2 gated', page, async () => {
  await page.click('#btn-menu'); await page.click('#menu-addbrand');
  await page.waitForSelector('#view-addbrand:not(.hidden)');
  assert((await text(page, '#ab-customers')).includes('No contracted customers'), 'empty customers note');
  await page.click('#btn-addbrand-back');
});

await test('change PIN: validation messages and server failure surfaced', page, async () => {
  await page.click('#btn-menu'); await page.click('#menu-pin');
  await page.waitForSelector('#pinchange-overlay:not(.hidden)');
  await page.fill('#pc-old', '1111'); await page.fill('#pc-new', '2222'); await page.fill('#pc-new2', '2223');
  eq(await text(page, '#pc-note'), "The two new PINs don't match", 'mismatch');
  await page.fill('#pc-new', '1111'); await page.fill('#pc-new2', '1111');
  eq(await text(page, '#pc-note'), 'The new PIN is the same as the current one', 'same as old');
  await page.fill('#pc-new', '2222'); await page.fill('#pc-new2', '2222');
  assert(!(await page.locator('#pc-submit').isDisabled()), 'submit enabled');
  await page.click('#pc-submit');
  await page.waitForFunction(() => !document.getElementById('pc-note').classList.contains('hidden') && /not in the demo|HTTP 404/.test(document.getElementById('pc-note').textContent));
  await page.click('#pc-cancel');
});

await test('site switch sheet marks the current site and is cancellable', page, async () => {
  await page.click('#btn-menu'); await page.click('#menu-site');
  if (await page.locator('#guard-overlay').isVisible()) { await page.click('#guard-logout'); }
  await page.waitForSelector('#site-overlay:not(.hidden)');
  assert((await text(page, '#site-switch-grid .site-btn')).includes('you are here'), 'current site marked');
  await page.click('#site-switch-cancel');
});

await test('logout (discarding the draft) -> resume card -> forget', page, async () => {
  await page.click('#btn-logout');
  await page.waitForSelector('#guard-overlay:not(.hidden)');
  await page.click('#guard-logout');
  await page.waitForSelector('#view-login:not(.hidden)');
  await page.waitForSelector('#resume-wrap .staff-btn.resume');
  assert((await text(page, '#resume-wrap')).includes('Demo User'), 'resume card');
  assert((await text(page, '#resume-wrap')).includes('just now'), 'last-used label');
  await page.click('#resume-wrap [data-forget]');
  eq(await page.locator('#resume-wrap .staff-btn.resume').count(), 0, 'forgotten');
});

await test('self-registration in demo mode logs straight in', page, async () => {
  await page.click('#site-grid .site-btn');
  await page.click('#btn-register');
  await page.fill('#reg-name', 'New Helper');
  await page.fill('#reg-pin', '4321'); await page.fill('#reg-pin2', '4321');
  await page.click('#reg-emp .chip[data-emp="full"]');
  await page.click('#reg-submit');
  await page.waitForSelector('#view-checklist:not(.hidden)');
  eq(await text(page, '#hdr-staff'), 'New Helper', 'header shows the new name');
});

await test('responsive: no horizontal overflow at 360 / 390 / 768 / 1440 on main screens', page, async (note) => {
  const sizes = [[360, 740], [390, 844], [768, 1024], [1440, 900]];
  const screens = [['checklist', async () => {}],
    ['capture', async () => { await page.click('#list-evening .merchant-card[data-id="S1-K4-0"]'); await page.waitForSelector('#view-capture:not(.hidden)'); }],
    ['billing', async () => { await page.click('#btn-capture-back'); await page.click('#btn-menu'); await page.click('#menu-billing'); await page.waitForSelector('#bl-body .merchant-card'); }],
    ['review', async () => { await page.click('#btn-billing-back'); await page.click('#btn-menu'); await page.click('#menu-review'); await page.waitForFunction(() => !/Loading/.test(document.getElementById('rv-list').textContent)); await page.click('#btn-review-back'); }]];
  const bad = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, go] of screens) {
      await go();
      await sleep(100);
      const o = await overflow(page);
      if (o.sw > o.iw + 1) bad.push(`${name}@${w}: scrollWidth ${o.sw} > ${o.iw}`);
      if (w === 1440 || w === 360) await page.screenshot({ path: `${shots}/${name}-${w}.png`, fullPage: false });
    }
  }
  note(bad.length ? bad.join('; ') : 'no overflow');
  assert(!bad.length, 'overflow found: ' + bad.join('; '));
});

await test('accessibility basics: icon buttons named, inputs labelled, images alt, lang, viewport zoom', page, async (note) => {
  await page.setViewportSize({ width: 393, height: 851 });
  const a = await page.evaluate(() => {
    const out = { unnamedButtons: [], unlabelledInputs: [], imgNoAlt: [], lang: document.documentElement.lang,
      viewport: document.querySelector('meta[name=viewport]')?.content, tiny: [] };
    document.querySelectorAll('button').forEach((b) => {
      const name = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim();
      if (!name) out.unnamedButtons.push(b.id || b.className);
    });
    document.querySelectorAll('input:not([type=file]),select').forEach((i) => {
      const lab = i.id && document.querySelector(`label[for="${i.id}"]`);
      const wrapped = i.closest('label');
      if (!lab && !wrapped && !i.getAttribute('aria-label') && !i.placeholder) out.unlabelledInputs.push(i.id || i.className);
    });
    document.querySelectorAll('img').forEach((im) => { if (im.getAttribute('alt') === null) out.imgNoAlt.push(im.src.slice(-40)); });
    document.querySelectorAll('button, .merchant-card, .chip').forEach((el) => {
      const r = el.getBoundingClientRect(); if (r.width && r.height && (r.height < 32)) out.tiny.push(`${el.id || el.className}:${Math.round(r.height)}px`);
    });
    return out;
  });
  note(JSON.stringify(a).slice(0, 900));
});

await browser.close();
report('DEMO MODE');
