/* Live API. Production Pages talks to the Render service unless a local override is set. */
(function () {
  var PROD_API = 'https://rytsensetech-growth-board.onrender.com';
  var refreshing = null;

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
  function refreshToken() {
    try { return localStorage.getItem('gb-refresh-token') || ''; } catch (e) { return ''; }
  }
  function parseTeamPayload(tok) {
    if (!tok || String(tok).indexOf('gb.') !== 0) return null;
    try {
      var part = String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      return JSON.parse(atob(part));
    } catch (e) { return null; }
  }
  function sessionExpiresAt() {
    var p = parseTeamPayload(token());
    if (p && p.exp) return Number(p.exp) || 0;
    try { return Number(localStorage.getItem('gb-session-expires') || 0); } catch (e) { return 0; }
  }
  function sessionAlive() {
    var exp = sessionExpiresAt();
    if (exp && Date.now() >= exp) return false;
    return !!token();
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
  function clearSession() {
    try {
      localStorage.removeItem('gb-access-token');
      localStorage.removeItem('gb-refresh-token');
      localStorage.removeItem('gb-session-expires');
    } catch (e) {}
  }
  function saveSession(data) {
    try {
      if (data.access_token) localStorage.setItem('gb-access-token', data.access_token);
      if (data.refresh_token) localStorage.setItem('gb-refresh-token', data.refresh_token);
      var p = parseTeamPayload(data.access_token || token());
      var exp = (p && p.exp) || (data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0);
      if (exp) localStorage.setItem('gb-session-expires', String(exp));
    } catch (e) {}
    armAutoLogout();
  }
  var logoutTimer = null;
  function expireToLogin() {
    clearSession();
    var leaf = ((location.pathname || '/').split('/').pop() || 'index.html');
    if (!leaf || leaf === 'login.html' || leaf === 'login') return;
    location.replace('login.html?next=' + encodeURIComponent(leaf + location.search));
  }
  function armAutoLogout() {
    if (logoutTimer) { clearTimeout(logoutTimer); logoutTimer = null; }
    var exp = sessionExpiresAt();
    if (!exp) return;
    var wait = exp - Date.now();
    if (wait <= 0) { expireToLogin(); return; }
    logoutTimer = setTimeout(expireToLogin, wait);
  }
  async function refreshAccess() {
    if (parseTeamPayload(token() || refreshToken())) return false;
    if (refreshing) return refreshing;
    var refresh = refreshToken();
    var api = base();
    if (!refresh || !api) return false;
    refreshing = (async function () {
      var res = await fetch(api + '/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok || !data.access_token) return false;
      saveSession(data);
      return true;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }
  async function send(path, options) {
    options = options || {};
    var attempt = function () {
      return fetch((base() || '') + path, {
        method: options.method || 'GET',
        headers: headers(options.headers),
        body: options.body,
        cache: 'no-store',
      });
    };
    var res = await attempt();
    if (res.status === 401 && await refreshAccess()) res = await attempt();
    if (res.status === 401) {
      clearSession();
      expireToLogin();
    }
    return res;
  }
  async function get(path) {
    var b = base();
    if (!b) return null;
    var res = await send(path, {});
    if (!res.ok) throw fail(path, res);
    return res.json();
  }
  armAutoLogout();
  window.GbLive = {
    base: base,
    token: token,
    saveSession: saveSession,
    clearSession: clearSession,
    sessionAlive: sessionAlive,
    sessionExpiresAt: sessionExpiresAt,
    overview: function () { return get('/api/sites/current/overview'); },
    issues: function () { return get('/api/sites/current/issues'); },
    tasks: function () { return get('/api/tasks'); },
    sync: function () { return get('/api/sites/current/sync'); },
    request: function (path, options) { return send(path, options); },
  };
})();
