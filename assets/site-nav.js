/* Site nav: left module rail, auth gate, light/dark theme. */
(function () {
  var THEME_KEY = 'gb-theme';
  var MODULES = [
    { key: 'board', href: 'index.html', label: 'Growth Board' },
    { key: 'report', href: 'report.html', label: 'Intelligence Report' },
    { key: 'tasks', href: 'tasks.html', label: 'Team Tasks' },
    { key: 'psi', href: 'psi.html', label: 'Page Speed' },
    { key: 'platform', href: 'platform.html', label: 'Internal Platform' },
    { key: 'seo-work', href: 'seo-work.html', label: 'SEO Work' },
    { key: 'ops', href: 'ops.html', label: 'SEO Ops' },
    { key: 'ask', href: 'ask.html', label: 'Ask' },
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
      return !(tok || localStorage.getItem('gb-refresh-token'));
    } catch (e) {
      return true;
    }
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

  function ensureNav() {
    var nav = document.querySelector('.site-nav');
    if (nav) return nav;
    nav = document.createElement('nav');
    nav.className = 'site-nav';
    nav.setAttribute('aria-label', 'Site');
    nav.innerHTML =
      '<div class="site-nav-inner">' +
        '<a class="site-nav-brand" href="index.html"><span class="site-nav-mark">RT</span><span class="site-nav-name">Rytsense</span></a>' +
        '<div class="site-nav-links"></div>' +
        '<div class="site-nav-meta"></div>' +
      '</div>';
    document.body.insertBefore(nav, document.body.firstChild);
    return nav;
  }

  function fillModules(nav) {
    var links = nav.querySelector('.site-nav-links');
    if (!links) return;
    var key = currentKey();
    links.innerHTML = MODULES.map(function (m) {
      var current = m.key === key ? ' aria-current="page"' : '';
      return '<a href="' + m.href + '" data-nav="' + m.key + '"' + current + '>' + m.label + '</a>';
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
    var out = footer.querySelector('.site-nav-signout');
    if (!out) {
      out = document.createElement('button');
      out.type = 'button';
      out.className = 'site-nav-signout';
      out.textContent = 'Sign out';
      out.addEventListener('click', signOut);
      footer.appendChild(out);
    }
    return footer;
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
    var mobile = window.matchMedia('(max-width: 900px)').matches;
    document.documentElement.style.setProperty('--site-nav-h', mobile ? '52px' : '0px');
    document.documentElement.style.setProperty('--site-nav-w', mobile ? '0px' : '240px');
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
    fillModules(nav);
    ensureFooter(nav);
    ensureMenuButton();
    applyTheme(readTheme());
    measureNav();
    syncSideHash();
    window.addEventListener('resize', measureNav);
    window.addEventListener('hashchange', syncSideHash);
    ['theme-btn', 'btn-theme'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = true;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.GbTheme = { apply: applyTheme, toggle: toggleTheme, read: readTheme };
})();
