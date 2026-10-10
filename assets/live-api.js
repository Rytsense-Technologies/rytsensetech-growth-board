/* Optional live API. Leave GB_API_BASE empty to keep reading the deployed JSON files. */
(function () {
  function base() {
    return String(window.GB_API_BASE || (function () {
      try { return localStorage.getItem('gb-api-base') || ''; } catch (e) { return ''; }
    })()).replace(/\/$/, '');
  }
  function token() {
    try { return localStorage.getItem('gb-access-token') || ''; } catch (e) { return ''; }
  }
  function headers(extra) {
    var h = { Authorization: 'Bearer ' + token() };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }
  async function get(path) {
    var b = base();
    if (!b) return null;
    var res = await fetch(b + path, { headers: headers(), cache: 'no-store' });
    if (!res.ok) throw new Error(path + ' ' + res.status);
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
