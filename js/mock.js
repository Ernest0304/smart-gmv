/* Demo-mode helpers for the Smart GMV prototype.
   Real catalog data (sites / merchants / customers) lives in data.js, generated
   from the actual Google Sheet. This file only mocks what the backend will do:
   the staff roster (production reads the Staff tab) and the AI reading engine
   (production calls Claude vision via /api/extract).

   The mock reading is DETERMINISTIC PER PHOTO: different photos give different
   numbers, the same photo always gives the same numbers. */

const MOCK = {
  /* Production: Staff tab of the sheet (Name / Staff ID / PIN / Home Site / Part-timer / Active) */
  staff: [
    { id: 'st-yusof', name: 'Yusof', pin: '1234', home: 'S3' },
    { id: 'st-shaz', name: 'Shazhiya', pin: '1234', home: 'S3' },
    { id: 'st-mark', name: 'Mark Edward', pin: '1234', home: 'S6' },
    { id: 'st-pavaa', name: 'Pavaa', pin: '1234', home: 'S1' },
    { id: 'st-haziq', name: 'Haziq', pin: '1234', home: 'S9' },
    { id: 'st-zs', name: 'Zheng Shun', pin: '1234', home: 'S12' },
    { id: 'st-mik', name: 'Mikhail Yusoff', pin: '1234', home: null, partTimer: true },
  ],
};

/* Cheap deterministic hash of a dataURL — used to vary the mock reading per photo. */
function photoHash(dataUrl) {
  let h = 0;
  const step = Math.max(1, Math.floor(dataUrl.length / 512));
  for (let i = 0; i < dataUrl.length; i += step) h = (h * 31 + dataUrl.charCodeAt(i)) >>> 0;
  return h;
}

/* Mock "AI extraction". channel: grab|fp|others|catering|dinein; mode: closing|baseline.
   merchant lets us keep the story-telling cases (Nenek 24H, Wingstop AIGENS). */
function mockExtract(channel, mode, merchant, dataUrl) {
  const h = photoHash(dataUrl);
  const pick = (n) => h % n;

  if (mode === 'baseline') {
    const orders = 3 + pick(30);
    const gmv = +(orders * (14 + pick(12)) + pick(90) / 100).toFixed(2);
    return { orders, gmv, conf: 'high',
      screen: channel === 'fp' ? `All ${orders} − Cancelled 0 → ${orders} orders` : `Net sales S$${gmv.toFixed(2)} · Completed ${orders}` };
  }

  if (channel === 'others' && merchant.aigens) {
    const orders = 3 + pick(9);
    const gmv = +(orders * (26 + pick(9)) + pick(80) / 100).toFixed(2);
    const total = +(gmv + 1800 + pick(2200)).toFixed(2);
    return { orders, gmv, conf: 'high',
      screen: `X-Reading · AIGENS (${orders}) ${gmv.toFixed(2)} — POS TOTAL ${total.toFixed(2)} ignored per rule`,
      candidates: [
        { label: 'AIGENS amount', value: gmv, kind: 'gmv' },
        { label: 'AIGENS count', value: orders, kind: 'orders' },
        { label: 'POS TOTAL (all channels)', value: total, kind: 'gmv' },
      ] };
  }

  const overnightBoost = merchant.overnight ? 25 : 0;
  const orders = 1 + overnightBoost + pick(38);
  const gmv = +(orders * (17 + pick(18)) + pick(95) / 100).toFixed(2);

  if (channel === 'fp') {
    const cancelled = pick(4) === 0 ? 1 + pick(2) : 0;
    const all = orders + cancelled;
    const cancelledAmt = cancelled ? +(cancelled * (12 + pick(15))).toFixed(2) : 0;
    const allAmt = +(gmv + cancelledAmt).toFixed(2);
    return { orders, gmv, conf: cancelled ? 'medium' : 'high',
      screen: `All ${all} · SGD ${allAmt.toFixed(2)} − Cancelled ${cancelled} → ${orders} orders · SGD ${gmv.toFixed(2)}`,
      mismatch: cancelled ? `Screen shows All ${all} incl. ${cancelled} cancelled — recorded ${orders} / $${gmv.toFixed(2)} per rule` : undefined,
      candidates: [
        { label: 'All (incl. cancelled)', value: allAmt, kind: 'gmv' },
        { label: 'After cancelled (record this)', value: gmv, kind: 'gmv' },
        { label: 'All orders', value: all, kind: 'orders' },
        { label: 'Orders after cancelled', value: orders, kind: 'orders' },
      ] };
  }

  // grab / catering / dinein / plain others
  const cancelled = pick(5) === 0 ? 1 : 0;
  return { orders, gmv, conf: 'high',
    screen: `Net sales S$${gmv.toFixed(2)} · Completed ${orders} · Cancelled ${cancelled}`,
    candidates: [
      { label: 'Net sales', value: gmv, kind: 'gmv' },
      { label: 'Gross (before promo)', value: +(gmv * 1.08).toFixed(2), kind: 'gmv' },
      { label: 'Completed orders', value: orders, kind: 'orders' },
    ] };
}
