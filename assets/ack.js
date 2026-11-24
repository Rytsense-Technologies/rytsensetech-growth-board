/* Addressed / live checkbox helper. Requires GbLive. */
(function () {
  var cache = { loaded: false, byKey: {}, summary: null };

  function key(kind, id) {
    return String(kind || '') + '::' + String(id || '');
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function badge(ack) {
    if (!ack) return '';
    var s = ack.verifyStatus || 'pending';
    var label = s === 'confirmed' ? 'Verified' : s === 'failed' ? 'Verify failed' : 'Verifying…';
    var cls = s === 'confirmed' ? 'ack-ok' : s === 'failed' ? 'ack-bad' : 'ack-wait';
    var title = (ack.verifyDetail && ack.verifyDetail.reason) || '';
    return '<span class="ack-badge ' + cls + '" title="' + esc(title) + '">' + esc(label) + '</span>';
  }

  function checkboxHtml(kind, id, opts) {
    opts = opts || {};
    var ack = cache.byKey[key(kind, id)];
    var checked = !!(ack && ack.verifyStatus !== 'failed');
    var failed = !!(ack && ack.verifyStatus === 'failed');
    return (
      '<label class="ack-wrap' + (failed ? ' ack-failed' : '') + '" data-ack-kind="' + esc(kind) + '" data-ack-id="' + esc(id) + '">' +
      '<input type="checkbox" class="ack-box" data-kind="' + esc(kind) + '" data-id="' + esc(id) + '"' +
      (opts.title ? ' data-title="' + esc(opts.title) + '"' : '') +
      (opts.url ? ' data-url="' + esc(opts.url) + '"' : '') +
      (opts.note ? ' data-note="' + esc(opts.note) + '"' : '') +
      (checked ? ' checked' : '') +
      ' />' +
      '<span class="ack-label">' + esc(opts.label || 'Addressed') + '</span>' +
      badge(ack) +
      '</label>'
    );
  }

  async function ensureLoaded(force) {
    if (cache.loaded && !force) return cache;
    if (!window.GbLive || !window.GbLive.base || !window.GbLive.base()) {
      cache.loaded = true;
      return cache;
    }
    try {
      var res = await window.GbLive.request('/api/ack');
      if (!res.ok) throw new Error('ack ' + res.status);
      var data = await res.json();
      cache.byKey = {};
      (data.items || []).forEach(function (a) {
        cache.byKey[key(a.sourceKind, a.sourceId)] = a;
      });
      cache.loaded = true;
    } catch (e) {
      cache.loaded = true;
    }
    return cache;
  }

  async function loadToday() {
    if (!window.GbLive || !window.GbLive.base || !window.GbLive.base()) return null;
    var res = await window.GbLive.request('/api/ack?today=1');
    if (!res.ok) throw new Error('ack today ' + res.status);
    var data = await res.json();
    cache.summary = data.summary || null;
    (data.summary && data.summary.items || []).forEach(function (a) {
      cache.byKey[key(a.sourceKind, a.sourceId)] = a;
    });
    cache.loaded = true;
    return cache.summary;
  }

  async function toggle(el) {
    var kind = el.getAttribute('data-kind');
    var id = el.getAttribute('data-id');
    if (!kind || !id) return;
    if (!window.GbLive || !window.GbLive.request) throw new Error('Live API required');
    el.disabled = true;
    var wrap = el.closest('.ack-wrap');
    try {
      if (el.checked) {
        if (wrap) {
          var wait = wrap.querySelector('.ack-badge');
          if (wait) wait.textContent = 'Verifying…';
          else wrap.insertAdjacentHTML('beforeend', '<span class="ack-badge ack-wait">Verifying…</span>');
        }
        var res = await window.GbLive.request('/api/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceKind: kind,
            sourceId: id,
            title: el.getAttribute('data-title') || null,
            url: el.getAttribute('data-url') || null,
            note: el.getAttribute('data-note') || null,
          }),
        });
        var body = {};
        try { body = await res.json(); } catch (e) {}
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
        cache.byKey[key(kind, id)] = body.ack;
        if (body.ack && body.ack.verifyStatus === 'failed') el.checked = false;
      } else {
        var del = await window.GbLive.request(
          '/api/ack?sourceKind=' + encodeURIComponent(kind) + '&sourceId=' + encodeURIComponent(id),
          { method: 'DELETE' }
        );
        if (!del.ok) {
          var errBody = {};
          try { errBody = await del.json(); } catch (e) {}
          throw new Error(errBody.error || ('HTTP ' + del.status));
        }
        delete cache.byKey[key(kind, id)];
      }
      if (wrap) {
        var existing = wrap.querySelector('.ack-badge');
        if (existing) existing.remove();
        var ack = cache.byKey[key(kind, id)];
        if (ack) wrap.insertAdjacentHTML('beforeend', badge(ack));
        wrap.classList.toggle('ack-failed', !!(ack && ack.verifyStatus === 'failed'));
      }
      document.dispatchEvent(new CustomEvent('gb-ack-changed', { detail: { kind: kind, id: id, ack: cache.byKey[key(kind, id)] || null } }));
    } catch (err) {
      el.checked = !el.checked;
      alert('Could not update Addressed: ' + (err.message || err));
    } finally {
      el.disabled = false;
    }
  }

  function bind(root) {
    (root || document).addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.classList || !t.classList.contains('ack-box')) return;
      toggle(t);
    });
  }

  function injectStyles() {
    if (document.getElementById('gb-ack-style')) return;
    var s = document.createElement('style');
    s.id = 'gb-ack-style';
    s.textContent =
      '.ack-wrap{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--ink-soft,#4B5563);white-space:nowrap}' +
      '.ack-wrap input{accent-color:var(--accent,#0E7A82);width:15px;height:15px}' +
      '.ack-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;letter-spacing:.02em}' +
      '.ack-ok{background:var(--good-soft,#E4F5EC);color:var(--good,#1E8E5A)}' +
      '.ack-wait{background:var(--warn-soft,#FBF0DC);color:var(--warn,#B4740E)}' +
      '.ack-bad{background:var(--bad-soft,#FBE7E7);color:var(--bad,#C23B3B)}' +
      '.ack-failed{opacity:.95}' +
      '.ack-today{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px;padding:12px 14px;border:1px solid var(--line,#E2E5EA);border-radius:12px;background:var(--paper-raised,#fff)}' +
      '.ack-today .ack-pill{font-size:12px;font-weight:700}' +
      '.ack-today .ack-pill span{font-family:Manrope,system-ui,sans-serif;font-size:18px;display:block}';
    document.head.appendChild(s);
  }

  window.GbAck = {
    ensureLoaded: ensureLoaded,
    loadToday: loadToday,
    checkboxHtml: checkboxHtml,
    badge: badge,
    bind: bind,
    injectStyles: injectStyles,
    get: function (kind, id) { return cache.byKey[key(kind, id)] || null; },
    summary: function () { return cache.summary; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectStyles(); bind(document); });
  } else {
    injectStyles();
    bind(document);
  }
})();
