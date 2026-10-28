/* Site nav: active tab + shared light/dark theme (default: light). */
(function () {
  var THEME_KEY = 'gb-theme';

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

  function ensureThemeButton() {
    var meta = document.querySelector('.site-nav-meta');
    if (!meta) return;
    var existing = document.getElementById('gb-theme-btn');
    if (existing) {
      existing.onclick = toggleTheme;
      return existing;
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'gb-theme-btn';
    btn.className = 'site-nav-theme';
    btn.onclick = toggleTheme;
    meta.insertBefore(btn, meta.firstChild);
    return btn;
  }

  function currentKey() {
    var raw = (location.pathname || '/').replace(/\/+$/, '');
    var leaf = raw.split('/').pop() || '';
    leaf = leaf.toLowerCase().replace(/\.html$/, '');
    if (!leaf || leaf === 'index') return 'board';
    if (
      leaf === 'board' ||
      leaf === 'report' ||
      leaf === 'tasks' ||
      leaf === 'platform' ||
      leaf === 'ops' ||
      leaf === 'seo-work' ||
      leaf === 'psi'
    ) {
      return leaf;
    }
    return 'board';
  }

  function applyActive() {
    var key = currentKey();
    document.querySelectorAll('.site-nav-links a[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === key) {
        a.setAttribute('aria-current', 'page');
      } else {
        a.removeAttribute('aria-current');
      }
    });
  }

  function measureNav() {
    var nav = document.querySelector('.site-nav');
    if (!nav) return;
    var h = Math.ceil(nav.getBoundingClientRect().height) || 56;
    document.documentElement.style.setProperty('--site-nav-h', h + 'px');
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

  // Apply as early as this script runs (also called from head boot on each page)
  applyTheme(readTheme());

  function boot() {
    ensureThemeButton();
    applyTheme(readTheme());
    applyActive();
    measureNav();
    syncSideHash();
    window.addEventListener('resize', measureNav);
    window.addEventListener('hashchange', syncSideHash);

    // Hide legacy page-local theme buttons (nav owns theme now)
    ['theme-btn', 'btn-theme'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = true;
    });

    document.querySelectorAll('.site-nav-links a[href="login.html"]').forEach(function (a) {
      var signedIn = false;
      try {
        signedIn = !!(localStorage.getItem('gb-access-token') || localStorage.getItem('gb-refresh-token'));
      } catch (e) {}
      if (!signedIn) return;
      a.textContent = 'Sign out';
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        try {
          localStorage.removeItem('gb-access-token');
          localStorage.removeItem('gb-refresh-token');
        } catch (e) {}
        location.href = 'login.html';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.GbTheme = { apply: applyTheme, toggle: toggleTheme, read: readTheme };
})();
