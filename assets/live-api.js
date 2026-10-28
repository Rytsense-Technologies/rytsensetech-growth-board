/* Live API. Production Pages talks to the Render service unless a local override is set. */
(function () {
  var PROD_API = 'https://rytsensetech-growth-board.onrender.com';
  function defaultBase() {
    if (window.GB_CONFIG && window.GB_CONFIG.apiBase) return String(window.GB_CONFIG.apiBase);
    if (/^(localhost|127\.0\.0\.1)$/i.test(location.hostname)) return 'http://localhost:8787';
    return PROD_API;
  }
  function base() {
    var fromWindow = String(window.GB_API_BASE || '').replace(/\/$/, '');
    if (fromWindow) return fromWindow;
    try {
      var stored = (localStorage.getItem('gb-api-base') || '').replace(/\/$/, '');
      if (stored) return stored;
    } catch (e) {}
    var resolved = defaultBase().replace(/\/$/, '');
    try { if (resolved) localStorage.setItem('gb-api-base', resolved); } catch (e) {}
    return resolved;
  }
  function token() {
    try { return localStorage.getItem('gb-access-token') || ''; } catch (e) { return ''; }
  }
  function headers(extra) {
    var h = { Authorization: 'Bearer ' + token() };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }
  function fail(path, res) {
    var err = new Error(path + ' ' + res.status);
    err.code = res.status;
    err.status = res.status;
    return err;
  }
  async function get(path) {
    var b = base();
    if (!b) return null;
    var res = await fetch(b + path, { headers: headers(), cache: 'no-store' });
    if (!res.ok) throw fail(path, res);
    return res.json();
  }
  window.GbLive = {
    base: base,
    token: token,
    overview: function () { return get('/api/sites/current/overview'); },
    issues: function () { return get('/api/sites/current/issues'); },
    tasks: function () { return get('/api/tasks'); },
    sync: function () { return get('/api/sites/current/sync'); },
    request: function (path, options) {
      options = options || {};
      var b = base();
      return fetch((b || '') + path, {
        method: options.method || 'GET',
        headers: headers(options.headers),
        body: options.body,
        cache: 'no-store',
      });
    },
  };
})();
