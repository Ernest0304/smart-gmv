// Tiny test harness around Playwright: streams pass/fail, console errors and page errors per test.
// Playwright is resolved from the nearest node_modules, then from a global install (PW_GLOBAL or
// the claude.ai container's /opt/node22/lib/node_modules/).
let pw;
try { pw = await import('playwright'); }
catch (e1) {
  try {
    const { createRequire } = await import('node:module');
    pw = createRequire(process.env.PW_GLOBAL || '/opt/node22/lib/node_modules/')('playwright');
  } catch (e2) {
    throw new Error('playwright not found — run: npm i -D playwright && npx playwright install chromium');
  }
}
export const { chromium } = pw;

export const BASE = process.env.APP_URL || 'http://127.0.0.1:8080/';
export const API = 'https://smart-gmv-server-production.up.railway.app';
export const TEST_TIMEOUT = 45000;

export const results = [];
export function report(suite) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${suite}: ${pass}/${results.length} passed ===`);
  for (const r of results.filter((x) => !x.ok)) console.log(`FAIL  ${r.name}\n      -> ${r.err}`);
  process.exitCode = pass === results.length ? 0 : 1;
}

export function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }
export function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

export async function makeContext(browser, opts = {}) {
  return browser.newContext({
    viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: 'en-SG', timezoneId: 'Asia/Singapore', ...opts,
  });
}

export function watch(page) {
  const consoleErrors = [], pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) consoleErrors.push(`[requestfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText}`); });
  return { consoleErrors, pageErrors };
}

export async function test(name, page, fn) {
  page.setDefaultTimeout(12000);
  const w = watch(page);
  const r = { name, ok: true, err: '', notes: [], consoleErrors: w.consoleErrors, pageErrors: w.pageErrors };
  const note = (s) => r.notes.push(s);
  const t0 = Date.now();
  try {
    await Promise.race([fn(note), new Promise((_, rej) => setTimeout(() => rej(new Error('TEST TIMEOUT ' + TEST_TIMEOUT + 'ms')), TEST_TIMEOUT))]);
  } catch (e) { r.ok = false; r.err = (e && e.stack || String(e)).split('\n').slice(0, 3).join(' | '); }
  results.push(r);
  page.removeAllListeners('console'); page.removeAllListeners('pageerror'); page.removeAllListeners('requestfailed');
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${Date.now() - t0}ms)${r.ok ? '' : '\n      -> ' + r.err}`);
  for (const n of r.notes) console.log('      note: ' + n);
  for (const c of r.consoleErrors.filter((c) => !/Failed to load resource/.test(c))) console.log('      console: ' + c);
  for (const c of r.pageErrors) console.log('      PAGEERROR: ' + c);
  return r;
}

// A tiny JPEG produced inside the page (so it is a genuinely decodable image).
export async function jpegBuffer(page, text = '123') {
  const dataUrl = await page.evaluate((t) => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#000'; g.font = '48px sans-serif'; g.fillText(t, 40, 240);
    return c.toDataURL('image/jpeg', 0.8);
  }, text);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

export const PNG1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export const visible = async (page, sel) => page.locator(sel).isVisible();
export const text = async (page, sel) => (await page.locator(sel).first().textContent() || '').trim();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function lastToast(page) { return (await page.locator('#toast').textContent() || '').trim(); }
export async function overflow(page) {
  return page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    bw: document.body.scrollWidth }));
}
