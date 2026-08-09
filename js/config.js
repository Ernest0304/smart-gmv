/* Smart GMV frontend config.
   apiBase: the extraction/records backend. A `?api=http://localhost:<port>`
   URL parameter overrides it for local development ONLY (non-localhost
   overrides are ignored so a crafted link cannot redirect staff data). */
const CONFIG = (() => {
  const params = new URLSearchParams(location.search);
  const qp = params.get('api');
  const local = qp && /^https?:\/\/localhost(:\d+)?$/.test(qp) ? qp : null;
  /* PREVIEW BRANCH: demo is ON by default — every network call is answered by
     js/demo.js with canned data. No backend, no sheet, nothing leaves the
     phone, no PIN. `?demo=0` reaches the real backend (don't, on this branch). */
  return { apiBase: local || 'https://smart-gmv-server-production.up.railway.app',
           demo: params.get('demo') !== '0' };
})();
