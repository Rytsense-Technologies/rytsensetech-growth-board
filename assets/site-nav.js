/* Mark active site-nav tab. Handles /tasks and /tasks.html (CF Pages pretty URLs). */
(function () {
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
      leaf === 'ops'
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

  function boot() {
    applyActive();
    measureNav();
    syncSideHash();
    window.addEventListener('resize', measureNav);
    window.addEventListener('hashchange', syncSideHash);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
