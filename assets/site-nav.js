/* Site nav: left module rail, auth gate, light/dark theme, collapsible sidebars. */
(function () {
  var THEME_KEY = 'gb-theme';
  var NAV_RAIL_KEY = 'gb-nav-rail';
  var SIDE_RAIL_KEY = 'gb-side-rail';

  function icon(paths) {
    return (
      '<svg class="site-nav-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      paths +
      '</svg>'
    );
  }

  var MODULES = [
    { key: 'board', href: 'index.html', label: 'Growth Board', ico: icon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>') },
    { key: 'report', href: 'report.html', label: 'Intelligence Report', ico: icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>') },
    { key: 'tasks', href: 'tasks.html', label: 'Team Tasks', ico: icon('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>') },
    { key: 'psi', href: 'psi.html', label: 'Page Speed', ico: icon('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>') },
    { key: 'platform', href: 'platform.html', label: 'Internal Platform', ico: icon('<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>') },
    { key: 'seo-work', href: 'seo-work.html', label: 'SEO Work', ico: icon('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>') },
    { key: 'ops', href: 'ops.html', label: 'SEO Ops', ico: icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>') },
    { key: 'ask', href: 'ask.html', label: 'Ask', ico: icon('<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>') },
  ];

  function pageLeaf() {
    var raw = (location.pathname || '/').replace(/\/+$/, '');
    var leaf = (raw.split('/').pop() || '').toLowerCase();
    if (!leaf || leaf === 'index') return 'index.html';
    return leaf.indexOf('.html') >= 0 ? leaf : leaf + '.html';
  }

  function isLoginPage() {
    return pageLeaf() === 'login.html';
  }

  function sessionExpired() {
    if (window.GbLive && typeof window.GbLive.sessionAlive === 'function') {
      return !window.GbLive.sessionAlive();
    }
    try {
      var exp = Number(localStorage.getItem('gb-session-expires') || 0);
      if (exp && Date.now() >= exp) return true;
      var tok = localStorage.getItem('gb-access-token') || '';
      if (tok.indexOf('gb.') === 0) {
        var part = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        while (part.length % 4) part += '=';
        var payload = JSON.parse(atob(part));
        if (payload.exp && Date.now() >= payload.exp) return true;
      }
    } catch (e) {}
    return !(tok || localStorage.getItem('gb-refresh-token'));
  }

  function signedIn() {
    if (sessionExpired()) return false;
    try {
      return !!(localStorage.getItem('gb-access-token') || localStorage.getItem('gb-refresh-token'));
    } catch (e) {
      return false;
    }
  }

  function requireAuth() {
    if (isLoginPage()) return true;
    if (signedIn()) return true;
    try {
      localStorage.removeItem('gb-access-token');
      localStorage.removeItem('gb-refresh-token');
      localStorage.removeItem('gb-session-expires');
    } catch (e) {}
    var next = pageLeaf() + location.search;
    location.replace('login.html?next=' + encodeURIComponent(next));
    return false;
  }

  function readTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      if (t === 'dark' || t === 'light') return t;
    } catch (e) {}
    return 'light';
  }

  function applyTheme(theme) {
    var t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t;
    try {
      localStorage.setItem(THEME_KEY, t);
      localStorage.setItem('tt-theme', t);
      localStorage.setItem('rts-theme', t);
    } catch (e) {}
    var btn = document.getElementById('gb-theme-btn');
    if (btn) {
      btn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
      btn.title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      btn.setAttribute('aria-label', btn.title);
      btn.textContent = t === 'dark' ? '☀' : '◐';
    }
    return t;
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || readTheme();
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  function currentKey() {
    var leaf = pageLeaf().replace(/\.html$/, '');
    if (!leaf || leaf === 'index') return 'board';
    if (leaf === 'admin') return 'admin';
    return leaf;
  }

  function signOut() {
    try {
      localStorage.removeItem('gb-access-token');
      localStorage.removeItem('gb-refresh-token');
      localStorage.removeItem('gb-session-expires');
    } catch (e) {}
    location.href = 'login.html';
  }

  function readFlag(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
  }

  function writeFlag(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) {}
  }

  function isMobile() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function ensureNav() {
    var nav = document.querySelector('.site-nav');
    if (nav) return nav;
    nav = document.createElement('nav');
    nav.className = 'site-nav';
    nav.setAttribute('aria-label', 'Site');
    nav.innerHTML =
      '<div class="site-nav-inner">' +
        '<div class="site-nav-top">' +
          '<a class="site-nav-brand" href="index.html"><span class="site-nav-mark">RT</span><span class="site-nav-name">Rytsense</span></a>' +
          '<button type="button" class="site-nav-collapse" id="gb-nav-collapse" aria-label="Minimize site navigation" title="Minimize"></button>' +
        '</div>' +
        '<div class="site-nav-links"></div>' +
        '<div class="site-nav-meta"></div>' +
      '</div>';
    document.body.insertBefore(nav, document.body.firstChild);
    return nav;
  }

  function ensureNavCollapseBtn(nav) {
    var inner = nav.querySelector('.site-nav-inner') || nav;
    var brand = nav.querySelector('.site-nav-brand');
    var top = nav.querySelector('.site-nav-top');
    if (!top && brand) {
      top = document.createElement('div');
      top.className = 'site-nav-top';
      brand.parentNode.insertBefore(top, brand);
      top.appendChild(brand);
    }
    if (!top) {
      top = document.createElement('div');
      top.className = 'site-nav-top';
      inner.insertBefore(top, inner.firstChild);
    }
    var btn = document.getElementById('gb-nav-collapse') || top.querySelector('.site-nav-collapse');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'gb-nav-collapse';
      btn.className = 'site-nav-collapse';
      top.appendChild(btn);
    }
    btn.onclick = function () {
      applyNavRail(!document.documentElement.classList.contains('gb-nav-rail'));
    };
    syncNavCollapseBtn(btn);
    return btn;
  }

  function syncNavCollapseBtn(btn) {
    if (!btn) btn = document.getElementById('gb-nav-collapse');
    if (!btn) return;
    var rail = document.documentElement.classList.contains('gb-nav-rail');
    btn.setAttribute('aria-pressed', rail ? 'true' : 'false');
    btn.setAttribute('aria-label', rail ? 'Expand site navigation' : 'Minimize site navigation');
    btn.title = rail ? 'Expand' : 'Minimize';
    btn.innerHTML = rail
      ? icon('<path d="M9 18l6-6-6-6"/>')
      : icon('<path d="M15 18l-6-6 6-6"/>');
  }

  function applyNavRail(on) {
    if (isMobile()) on = false;
    document.documentElement.classList.toggle('gb-nav-rail', !!on);
    var nav = document.querySelector('.site-nav');
    if (nav) nav.classList.toggle('is-rail', !!on);
    writeFlag(NAV_RAIL_KEY, !!on);
    syncNavCollapseBtn();
    measureNav();
  }

  function fillModules(nav) {
    var links = nav.querySelector('.site-nav-links');
    if (!links) return;
    var key = currentKey();
    links.innerHTML = MODULES.map(function (m) {
      var current = m.key === key ? ' aria-current="page"' : '';
      return (
        '<a href="' + m.href + '" data-nav="' + m.key + '" title="' + m.label + '"' + current + '>' +
        m.ico +
        '<span class="site-nav-label">' + m.label + '</span>' +
        '</a>'
      );
    }).join('');
  }

  function ensureFooter(nav) {
    var inner = nav.querySelector('.site-nav-inner') || nav;
    var footer = nav.querySelector('.site-nav-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'site-nav-footer';
      inner.appendChild(footer);
    }
    var meta = nav.querySelector('.site-nav-meta');
    if (meta && meta.parentNode !== footer) footer.insertBefore(meta, footer.firstChild);
    var userRow = footer.querySelector('.site-nav-user');
    if (!userRow) {
      userRow = document.createElement('div');
      userRow.className = 'site-nav-user';
      var name = document.createElement('span');
      name.className = 'site-nav-user-name';
      try { name.textContent = localStorage.getItem('gb-email') || 'rytsensetech'; } catch (e) { name.textContent = 'rytsensetech'; }
      var theme = document.createElement('button');
      theme.type = 'button';
      theme.id = 'gb-theme-btn';
      theme.className = 'site-nav-theme';
      theme.onclick = toggleTheme;
      userRow.appendChild(name);
      userRow.appendChild(theme);
      footer.appendChild(userRow);
    }
    var connect = footer.querySelector('.site-nav-connect');
    if (!connect) {
      connect = document.createElement('button');
      connect.type = 'button';
      connect.className = 'site-nav-connect site-nav-signout';
      connect.id = 'gb-connect-google';
      connect.title = 'Connect Google Search Console + GA4 for live Addressed verify';
      connect.innerHTML = icon('<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>') +
        '<span class="site-nav-label">Connect Google</span>';
      connect.hidden = true;
      connect.addEventListener('click', startGoogleConnect);
      footer.appendChild(connect);
      refreshConnectLink(connect);
    }
    var out = footer.querySelector('.site-nav-signout');
    if (!out) {
      out = document.createElement('button');
      out.type = 'button';
      out.className = 'site-nav-signout';
      out.innerHTML = icon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>') + '<span class="site-nav-label">Sign out</span>';
      out.addEventListener('click', signOut);
      footer.appendChild(out);
    }
    return footer;
  }

  function startGoogleConnect() {
    if (!window.GbLive || typeof window.GbLive.request !== 'function') {
      alert('API not ready. Sign in again, then retry Connect Google.');
      return;
    }
    window.GbLive.request('/api/oauth/google/start?format=json', { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
      .then(function (pack) {
        if (!pack.res.ok) {
          var msg = (pack.body && (pack.body.detail || pack.body.error)) || ('HTTP ' + pack.res.status);
          alert('Connect Google failed: ' + msg);
          return;
        }
        if (pack.body && pack.body.url) location.href = pack.body.url;
        else alert('Connect Google failed: no auth URL returned');
      })
      .catch(function (err) {
        alert('Connect Google failed: ' + (err && err.message ? err.message : err));
      });
  }

  function refreshConnectLink(el) {
    var link = el || document.getElementById('gb-connect-google');
    if (!link || !window.GbLive) return;
    var load = typeof window.GbLive.sync === 'function'
      ? window.GbLive.sync()
      : Promise.reject(new Error('no sync'));
    load.then(function (res) {
      var rows = (res && res.connections) || [];
      var hasGoogle = rows.some(function (c) {
        return (c.provider === 'gsc' || c.provider === 'ga4') && c.status === 'connected';
      });
      link.hidden = !!hasGoogle;
    }).catch(function () {
      link.hidden = false;
    });
  }

  function showConnectedToast() {
    try {
      var params = new URLSearchParams(location.search || '');
      if (params.get('connected') !== '1') return;
      var toast = document.createElement('div');
      toast.className = 'gb-connected-toast';
      toast.setAttribute('role', 'status');
      toast.textContent = 'Google Search Console + GA4 connected.';
      document.body.appendChild(toast);
      requestAnimationFrame(function () { toast.classList.add('is-on'); });
      setTimeout(function () {
        toast.classList.remove('is-on');
        setTimeout(function () { toast.remove(); }, 320);
      }, 4200);
      params.delete('connected');
      var next = location.pathname + (params.toString() ? '?' + params.toString() : '') + (location.hash || '');
      if (window.history && history.replaceState) history.replaceState({}, '', next);
      refreshConnectLink();
    } catch (e) { /* non-fatal */ }
  }

  function ensureMenuButton() {
    var existing = document.getElementById('gb-menu-btn');
    if (existing) return existing;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'gb-menu-btn';
    btn.className = 'gb-menu-btn';
    btn.setAttribute('aria-label', 'Open modules');
    btn.textContent = '☰';
    btn.addEventListener('click', function () {
      document.documentElement.classList.toggle('gb-nav-open');
    });
    document.body.appendChild(btn);
    document.addEventListener('click', function (ev) {
      if (!document.documentElement.classList.contains('gb-nav-open')) return;
      if (ev.target.closest('.site-nav, #gb-menu-btn')) return;
      document.documentElement.classList.remove('gb-nav-open');
    });
    return btn;
  }

  function measureNav() {
    var mobile = isMobile();
    var rail = !mobile && document.documentElement.classList.contains('gb-nav-rail');
    document.documentElement.style.setProperty('--site-nav-h', mobile ? '52px' : '0px');
    document.documentElement.style.setProperty('--site-nav-w', mobile ? '0px' : (rail ? '68px' : '240px'));
    if (mobile) {
      document.documentElement.classList.remove('gb-nav-rail');
      var nav = document.querySelector('.site-nav');
      if (nav) nav.classList.remove('is-rail');
    }
  }

  function initials(text) {
    var clean = String(text || '')
      .replace(/^[0-9]+\s*/, '')
      .replace(/[^A-Za-z0-9\s]/g, ' ')
      .trim();
    if (!clean) return '•';
    var parts = clean.split(/\s+/).filter(Boolean);
    if (/^\d+$/.test(parts[0] || '')) return parts[0].slice(0, 2);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function wrapSideLink(el) {
    if (el.dataset.gbIco === '1') return;
    el.dataset.gbIco = '1';
    el.classList.add('gb-side-link');
    var title = (el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!el.getAttribute('title') && title) el.setAttribute('title', title);

    if (el.classList.contains('navbtn')) {
      var labelBits = [];
      Array.prototype.slice.call(el.childNodes).forEach(function (node) {
        if (node.nodeType === 3) {
          var t = node.textContent.replace(/\s+/g, ' ').trim();
          if (t) labelBits.push(t);
          el.removeChild(node);
        } else if (node.nodeType === 1 && !node.classList.contains('dot') && !node.classList.contains('gb-side-ico')) {
          labelBits.push(node.textContent.replace(/\s+/g, ' ').trim());
          node.classList.add('gb-side-label');
        }
      });
      if (!el.querySelector('.gb-side-ico')) {
        var ico = document.createElement('span');
        ico.className = 'gb-side-ico';
        ico.setAttribute('aria-hidden', 'true');
        ico.textContent = initials(labelBits.join(' ') || title);
        var dot = el.querySelector('.dot');
        if (dot && dot.nextSibling) el.insertBefore(ico, dot.nextSibling);
        else el.appendChild(ico);
      }
      if (labelBits.length && !el.querySelector('.gb-side-label')) {
        var span = document.createElement('span');
        span.className = 'gb-side-label';
        span.textContent = labelBits.join(' ');
        el.appendChild(span);
      }
      return;
    }

    if (el.querySelector('.gb-side-ico')) return;
    var ico2 = document.createElement('span');
    ico2.className = 'gb-side-ico';
    ico2.setAttribute('aria-hidden', 'true');
    var view = el.getAttribute('data-view');
    if (view) {
      ico2.textContent = ({ issues: 'IS', links: 'IL', ideas: 'CI', trends: 'TT' }[view]) || initials(title);
    } else {
      var num = title.match(/^(\d+)\b/);
      ico2.textContent = num ? num[1] : initials(title);
    }
    el.insertBefore(ico2, el.firstChild);
    var labelWrap = document.createElement('span');
    labelWrap.className = 'gb-side-label';
    while (ico2.nextSibling) labelWrap.appendChild(ico2.nextSibling);
    el.appendChild(labelWrap);
  }

  function applySideRail(on) {
    if (isMobile()) on = false;
    document.documentElement.classList.toggle('gb-side-rail', !!on);
    document.querySelectorAll('.gb-mod-side').forEach(function (side) {
      side.classList.toggle('is-rail', !!on);
      var shell = side.closest('.shell');
      if (shell) shell.classList.toggle('gb-side-rail', !!on);
      var btn = side.querySelector('.gb-side-collapse');
      if (btn) {
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', on ? 'Expand module navigation' : 'Minimize module navigation');
        btn.title = on ? 'Expand' : 'Minimize';
        btn.innerHTML = on
          ? icon('<path d="M9 18l6-6-6-6"/>')
          : icon('<path d="M15 18l-6-6 6-6"/>');
      }
    });
    writeFlag(SIDE_RAIL_KEY, !!on);
  }

  function enhanceSidebars() {
    var sides = document.querySelectorAll('.shell > aside.side, .shell > aside.sidebar');
    if (!sides.length) return;
    sides.forEach(function (side) {
      if (side.dataset.gbCollapseReady === '1') return;
      side.dataset.gbCollapseReady = '1';
      side.classList.add('gb-mod-side');

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'gb-side-collapse';
      toggle.addEventListener('click', function () {
        applySideRail(!document.documentElement.classList.contains('gb-side-rail'));
      });
      side.insertBefore(toggle, side.firstChild);

      side.querySelectorAll('nav a, .nav a, .sw-nav a, button.navbtn').forEach(wrapSideLink);
    });
    applySideRail(readFlag(SIDE_RAIL_KEY));
  }

  function syncSideHash() {
    var links = document.querySelectorAll('.shell .nav a[href^="#"], .rts-report .navbtn[data-tab]');
    if (!links.length) return;
    var hash = (location.hash || '').replace(/^#/, '');
    if (!hash) return;
    links.forEach(function (el) {
      var id = el.getAttribute('data-tab') || (el.getAttribute('href') || '').replace(/^#/, '');
      if (el.classList) {
        if (el.classList.contains('navbtn')) {
          el.setAttribute('aria-current', id === hash ? 'true' : 'false');
        } else {
          el.classList.toggle('active', id === hash);
        }
      }
    });
  }

  applyTheme(readTheme());

  function boot() {
    if (isLoginPage()) {
      applyTheme(readTheme());
      return;
    }
    if (!requireAuth()) return;
    document.documentElement.classList.add('gb-app');
    var nav = ensureNav();
    ensureNavCollapseBtn(nav);
    fillModules(nav);
    ensureFooter(nav);
    ensureMenuButton();
    applyTheme(readTheme());
    applyNavRail(readFlag(NAV_RAIL_KEY));
    enhanceSidebars();
    measureNav();
    syncSideHash();
    window.addEventListener('resize', function () {
      measureNav();
      if (isMobile()) {
        document.documentElement.classList.remove('gb-side-rail');
        document.querySelectorAll('.gb-mod-side.is-rail').forEach(function (s) { s.classList.remove('is-rail'); });
        document.querySelectorAll('.shell.gb-side-rail').forEach(function (s) { s.classList.remove('gb-side-rail'); });
      } else {
        applySideRail(readFlag(SIDE_RAIL_KEY));
        applyNavRail(readFlag(NAV_RAIL_KEY));
      }
    });
    window.addEventListener('hashchange', syncSideHash);
    ['theme-btn', 'btn-theme'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    showConnectedToast();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.GbTheme = { apply: applyTheme, toggle: toggleTheme, read: readTheme };
})();
