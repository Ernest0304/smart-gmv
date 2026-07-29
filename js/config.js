/* Smart GMV frontend config.
   apiBase: the extraction/records backend. A `?api=http://localhost:<port>`
   URL parameter overrides it for local development ONLY (non-localhost
   overrides are ignored so a crafted link cannot redirect staff data). */
const CONFIG = (() => {
  const qp = new URLSearchParams(location.search).get('api');
  const local = qp && /^https?:\/\/localhost(:\d+)?$/.test(qp) ? qp : null;
  return { apiBase: local || 'https://smart-gmv-server-production.up.railway.app' };
})();
