/* Smart GMV demo layer — answers every api() call locally when CONFIG.demo.
   Invented facility, invented brands, invented figures. Nothing here touches
   the network, the backend or the sheet; "saving" mutates this page only. */

const DEMO = (() => {
  const MERCHANTS = [
    { facility: 'S1', kitchen: 'K4',  brand: 'Kaya Toast Club',        sfdcId: 'DEMO-004' },
    { facility: 'S1', kitchen: 'K7',  brand: 'Bao Department',         sfdcId: 'DEMO-007' },
    { facility: 'S1', kitchen: 'K11', brand: 'Green Curry Lab',        sfdcId: 'DEMO-011', overnight: true },
    { facility: 'S1', kitchen: 'K13', brand: 'Wok & Ladle',            sfdcId: 'DEMO-013' },
    { facility: 'S1', kitchen: 'K19', brand: 'Satay After Dark',       sfdcId: 'DEMO-019' },
    { facility: 'S1', kitchen: 'K21', brand: 'Pandan Bakehouse',       sfdcId: 'DEMO-021' },
    { facility: 'S1', kitchen: 'CR',  brand: 'Cloud Bakehouse',        sfdcId: 'DEMO-901' },
    { facility: 'S1', kitchen: 'CR',  brand: 'Midnight Mochi',         sfdcId: 'DEMO-902' },
  ].map((m) => ({ site: 'Tampines (demo)', grabOn: true, fpOn: true, catering: false,
                  overnight: false, disabled: false, aigens: false, ...m }));

  /* deterministic per-brand "AI readings" so retakes look stable */
  const READS = {
    'Kaya Toast Club':  { grab: [31, 742.50],  fp: [12, 268.40] },
    'Bao Department':   { grab: [47, 1284.60], fp: [23, 612.40] },
    'Green Curry Lab':  { grab: [18, 466.20],  fp: [4, 88.90] },
    'Wok & Ladle':      { grab: [26, 703.10],  fp: [9, 201.10] },
    'Satay After Dark': { grab: [40, 958.00],  fp: [15, 344.25] },
    'Pandan Bakehouse': { grab: [12, 288.90],  fp: [6, 132.60] },
    'Cloud Bakehouse':  { grab: [9, 214.00],   fp: [6, 143.75] },
    'Midnight Mochi':   { grab: [7, 168.40],   fp: [3, 71.20] },
  };

  const today = (() => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const stamp = (hhmm) => `${today} ${hhmm}:00`;

  const ch = (orders, gmv) => ({ aiOrders: orders, aiGmv: gmv, orders, gmv,
    summaryOrders: orders, summaryGmv: gmv, photoLink: '', photoId: '',
    extras: [], noSales: false });

  /* two closings already in (one flagged), plus this morning's opening for the
     24-hour brand — so the list shows every state the redesign cares about */
  const TODAY_RECORDS = [
    { recordId: 'S1-K4-kayatoastclub-demo-C', recordType: 'closing', salesDate: today,
      timestamp: stamp('20:41'), kitchen: 'K4', brand: 'Kaya Toast Club', sfdcId: 'DEMO-004',
      status: 'Operated', staff: 'Demo User (st-demo)',
      channels: { grab: ch(31, 742.50), fp: ch(12, 268.40) },
      edited: false, baselineRef: '', billables: { grab: { orders: 31, gmv: 742.50 },
      fp: { orders: 12, gmv: 268.40 } }, billingFlag: 'OK', notes: '' },
    { recordId: 'S1-K7-baodepartment-demo-C', recordType: 'closing', salesDate: today,
      timestamp: stamp('21:04'), kitchen: 'K7', brand: 'Bao Department', sfdcId: 'DEMO-007',
      status: 'Operated', staff: 'Demo User (st-demo)',
      channels: { grab: ch(47, 1284.60), fp: ch(23, 612.40) },
      edited: true, baselineRef: '', billables: { grab: { orders: 47, gmv: 1284.60 },
      fp: { orders: 23, gmv: 612.40 } }, billingFlag: 'CHECK', notes: 'demo: flagged for review' },
    { recordId: 'S1-K11-greencurrylab-demo-B', recordType: 'baseline', salesDate: today,
      timestamp: stamp('10:12'), kitchen: 'K11', brand: 'Green Curry Lab', sfdcId: 'DEMO-011',
      status: 'Operated', staff: 'Demo User (st-demo)',
      channels: { grab: ch(5, 121.30), fp: ch(2, 44.10) },
      edited: false, baselineRef: '', billables: {}, billingFlag: '', notes: '' },
  ];

  /* A month of invented billing, so the billing page can be walked through in
     the preview. Built from the demo readings x the days elapsed this month
     (opened on the 3rd it never claims 20 days recorded), and it covers every
     row shape: both platforms, Grab only, foodpanda only, hand-typed, and one
     record waiting for review. Only ever served under ?demo=1. */
  function demoBilling(query) {
    const dom = Number(today.slice(8, 10));
    const r2 = (x) => Math.round(x * 100) / 100;
    const SPEC = [            // brand, days behind today, Grab?, foodpanda?, hand-typed per day
      ['Kaya Toast Club', 0, 1, 1, null],
      ['Bao Department', 0, 1, 1, null],
      ['Green Curry Lab', 1, 1, 1, null],
      ['Wok & Ladle', 2, 1, 0, null],
      ['Satay After Dark', 0, 1, 1, null],
      ['Pandan Bakehouse', 5, 0, 1, null],
      ['Cloud Bakehouse', 3, 1, 1, [2, 96.50]],
      ['Midnight Mochi', 8, 1, 0, [1, 58.00]],
    ];
    const totals = { totalOrders: 0, totalGmv: 0, billableGrabOrders: 0, billableGrabGmv: 0,
      billableFpOrders: 0, billableFpGmv: 0, othersOrders: 0, othersGmv: 0,
      cateringOrders: 0, cateringGmv: 0, dineinOrders: 0, dineinGmv: 0,
      promoDineinOrders: 0, promoDineinGmv: 0 };
    const merchants = SPEC.map(([brand, behind, g, f, hand]) => {
      const m = MERCHANTS.find((x) => x.brand === brand);
      const days = Math.max(1, dom - behind);
      const go = g ? READS[brand].grab[0] * days : 0, gg = g ? r2(READS[brand].grab[1] * days) : 0;
      const fo = f ? READS[brand].fp[0] * days : 0, fg = f ? r2(READS[brand].fp[1] * days) : 0;
      const ho = hand ? hand[0] * days : 0, hg = hand ? r2(hand[1] * days) : 0;
      totals.billableGrabOrders += go; totals.billableGrabGmv = r2(totals.billableGrabGmv + gg);
      totals.billableFpOrders += fo; totals.billableFpGmv = r2(totals.billableFpGmv + fg);
      totals.othersOrders += ho; totals.othersGmv = r2(totals.othersGmv + hg);
      totals.totalOrders += go + fo + ho; totals.totalGmv = r2(totals.totalGmv + gg + fg + hg);
      return { kitchen: m.kitchen, brand, days, totalOrders: go + fo + ho, totalGmv: r2(gg + fg + hg),
        billableGrabOrders: go, billableGrabGmv: gg, billableFpOrders: fo, billableFpGmv: fg,
        othersGmv: hg, cateringGmv: 0, dineinGmv: 0, promoDineinGmv: 0 };
    });
    const from = query.get('from'), to = query.get('to');
    return { month: from ? undefined : today.slice(0, 7), label: from ? `${from} → ${to}` : undefined,
      merchants, totals,
      flags: [{ date: today, kitchen: 'K7', brand: 'Bao Department', flag: 'CHECK', edited: true }] };
  }

  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const reply = (body, status = 200) =>
    ({ ok: status < 400, status, json: async () => body });

  async function fetch_(path, opts) {
    const method = (opts && opts.method) || 'GET';
    const p = path.split('?')[0];

    if (p === '/api/catalog') {
      return reply({ sites: [{ id: 'S1', name: 'Tampines (demo)' }],
        staff: [{ id: 'st-demo', name: 'Demo User', homeSites: ['S1'],
                  needsPin: false, partTimer: false, reports: true }],
        customers: [], merchants: MERCHANTS });
    }
    /* Every staff endpoint must be answered here, not only the ones the happy
       path uses: "I'm not on the list" is one tap away on the demo login screen,
       and before this it wrote a real row to the live Staff sheet. */
    if (p === '/api/staff/verify' || p === '/api/staff/pin') {
      await wait(350);
      return reply({ ok: true, token: 'demo-session',
        staff: { id: 'st-demo', name: 'Demo User', reports: true } });
    }
    if (p === '/api/staff' && method === 'POST') {
      await wait(400);
      let name = 'Demo User';
      try { name = JSON.parse(opts.body || '{}').name || name; } catch (e) { /* keep */ }
      return reply({ ok: true, token: 'demo-session',
        staff: { id: 'st-demo-new', name, home: 'S1', homeSites: ['S1'],
                 partTimer: false, needsPin: false, reports: true } });
    }
    if (p === '/api/records/today') {
      await wait(400);
      return reply({ records: TODAY_RECORDS });
    }
    if (p === '/api/records' && method === 'GET') {
      return reply({ records: [] });          // Review: keep the demo shallow
    }
    if (p === '/api/extract') {
      await wait(1200);                       // feel of the real read
      let body = {};
      try { body = JSON.parse(opts.body || '{}'); } catch (e) { /* keep {} */ }
      const read = (READS[body.brand] || { grab: [11, 264.80], fp: [5, 118.20] })[body.channel]
        || [11, 264.80];
      return reply({ orders: read[0], gmv: read[1], confidence: 'high',
        screen_summary: 'demo read — invented figures', zero_sales: false,
        wrong_channel: false, notes: '', photoLink: '', photoId: '' });
    }
    if (p === '/api/records' && method === 'POST') {
      await wait(550);
      return reply({ ok: true, replay: false, photoLinks: {}, extrasLinks: {},
        billing: 'OK', warnings: [] });
    }
    if (p === '/api/billing') {
      return reply(demoBilling(new URLSearchParams(path.split('?')[1] || '')));
    }
    // staff registration, pin change, merchants … — not part of the preview
    return reply({ error: 'not in the demo' }, 404);
  }

  return { fetch: fetch_ };
})();
