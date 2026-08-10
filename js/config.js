/* Smart GMV frontend config.
   apiBase: the extraction/records backend. A `?api=http://localhost:<port>`
   URL parameter overrides it for local development ONLY (non-localhost
   overrides are ignored so a crafted link cannot redirect staff data). */
const CONFIG = (() => {
  const params = new URLSearchParams(location.search);
  const qp = params.get('api');
  const local = qp && /^https?:\/\/localhost(:\d+)?$/.test(qp) ? qp : null;
  /* demo=1: every network call is answered by js/demo.js with canned invented
     data and roster taps log straight in — no backend, no sheet, no PIN.
     Kept in production as a safe walkthrough mode for showing the app around. */
  return { apiBase: local || 'https://smart-gmv-server-production.up.railway.app',
           demo: params.get('demo') === '1' };
})();
