/*! Shared GSC-style date range + day/week/month grain for Growth Board */
(function (global) {
  var KEY = 'gb-date-range';

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }
  function toYMD(d) {
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function parseYMD(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var p = s.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  }
  function startOfWeek(d) {
    var x = new Date(d.getTime());
    var day = x.getUTCDay(); // 0 Sun
    var diff = day === 0 ? -6 : 1 - day; // Monday start
    return addDays(x, diff);
  }
  function startOfMonth(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
  function defaultRange() {
    var end = new Date();
    end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    return {
      preset: '28d',
      grain: 'day',
      start: toYMD(addDays(end, -27)),
      end: toYMD(end),
    };
  }
  function readState() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var j = JSON.parse(raw);
        if (j && j.start && j.end) return j;
      }
    } catch (e) {}
    return defaultRange();
  }
  function writeState(s) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) {}
  }
  function applyPreset(preset, customStart, customEnd) {
    var end = new Date();
    end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    var start = end;
    if (preset === '7d') start = addDays(end, -6);
    else if (preset === '28d') start = addDays(end, -27);
    else if (preset === '3m') start = addDays(end, -89);
    else if (preset === '6m') start = addDays(end, -179);
    else if (preset === '12m') start = addDays(end, -364);
    else if (preset === '16m') start = addDays(end, -486);
    else if (preset === 'custom') {
      var s = parseYMD(customStart) || addDays(end, -27);
      var e = parseYMD(customEnd) || end;
      if (s > e) {
        var t = s;
        s = e;
        e = t;
      }
      return { preset: 'custom', grain: readState().grain || 'day', start: toYMD(s), end: toYMD(e) };
    }
    return {
      preset: preset,
      grain: readState().grain || 'day',
      start: toYMD(start),
      end: toYMD(end),
    };
  }
  function label(state) {
    var map = {
      '7d': '7 days',
      '28d': '28 days',
      '3m': '3 months',
      '6m': '6 months',
      '12m': '12 months',
      '16m': '16 months',
      custom: 'Custom',
    };
    return (map[state.preset] || 'Custom') + ' · ' + state.start + ' → ' + state.end;
  }
  function inRange(ymd, state) {
    if (!ymd) return false;
    return ymd >= state.start && ymd <= state.end;
  }
  function bucketKey(ymd, grain) {
    var d = parseYMD(ymd);
    if (!d) return ymd;
    if (grain === 'week') return toYMD(startOfWeek(d));
    if (grain === 'month') return toYMD(startOfMonth(d));
    return ymd;
  }
  function bucketLabel(key, grain) {
    if (grain === 'week') return 'Week of ' + key;
    if (grain === 'month') return key.slice(0, 7);
    return key;
  }
  /**
   * History rows are trailing-window snapshots — never SUM metrics across days.
   * Day: one row per snapshot. Week/Month: last snapshot in bucket (end-of-period).
   */
  function rollupHistory(rows, state, mapRow) {
    var filtered = (rows || [])
      .map(function (r) {
        return mapRow ? mapRow(r) : r;
      })
      .filter(function (r) {
        return r && r.date && inRange(r.date, state);
      })
      .sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date));
      });
    if ((state.grain || 'day') === 'day') return filtered;
    var buckets = {};
    filtered.forEach(function (r) {
      var k = bucketKey(r.date, state.grain);
      buckets[k] = r; // last wins
    });
    return Object.keys(buckets)
      .sort()
      .map(function (k) {
        var r = Object.assign({}, buckets[k]);
        r.bucket = k;
        r.bucketLabel = bucketLabel(k, state.grain);
        return r;
      });
  }

  function mount(opts) {
    opts = opts || {};
    var host = typeof opts.host === 'string' ? document.querySelector(opts.host) : opts.host;
    if (!host) return null;
    var state = readState();
    if (opts.grain) state.grain = opts.grain;
    writeState(state);

    host.innerHTML =
      '<div class="gb-dr" data-gb-date-range>' +
      '<div class="gb-dr-bar" role="group" aria-label="Date range">' +
      ['7d', '28d', '3m'].map(function (p) {
        return (
          '<button type="button" class="gb-dr-chip' +
          (state.preset === p ? ' on' : '') +
          '" data-preset="' +
          p +
          '">' +
          (p === '7d' ? '7 days' : p === '28d' ? '28 days' : '3 months') +
          '</button>'
        );
      }).join('') +
      '<button type="button" class="gb-dr-chip' +
      (['6m', '12m', '16m', 'custom'].indexOf(state.preset) >= 0 ? ' on' : '') +
      '" data-open-more>More ▾</button>' +
      '<span class="gb-dr-sep"></span>' +
      '<button type="button" class="gb-dr-chip' +
      (state.grain === 'day' ? ' on' : '') +
      '" data-grain="day">Day</button>' +
      '<button type="button" class="gb-dr-chip' +
      (state.grain === 'week' ? ' on' : '') +
      '" data-grain="week">Week</button>' +
      '<button type="button" class="gb-dr-chip' +
      (state.grain === 'month' ? ' on' : '') +
      '" data-grain="month">Month</button>' +
      '<span class="gb-dr-label mono" data-dr-label>' +
      label(state) +
      '</span>' +
      '</div>' +
      '<p class="gb-dr-note">' +
      (opts.note ||
        'Trends use daily snapshots in range (day / week / month). Page & keyword tables still use the latest GSC window until multi-period pulls are added.') +
      '</p>' +
      '<div class="gb-dr-modal" hidden>' +
      '<div class="gb-dr-panel" role="dialog" aria-label="Date range">' +
      '<div class="gb-dr-head"><strong>Date range</strong><button type="button" class="gb-dr-x" data-close>×</button></div>' +
      '<div class="gb-dr-presets">' +
      [
        ['7d', 'Last 7 days'],
        ['28d', 'Last 28 days'],
        ['3m', 'Last 3 months'],
        ['6m', 'Last 6 months'],
        ['12m', 'Last 12 months'],
        ['16m', 'Last 16 months'],
        ['custom', 'Custom'],
      ]
        .map(function (pair) {
          return (
            '<label class="gb-dr-radio"><input type="radio" name="gb-dr-preset" value="' +
            pair[0] +
            '"' +
            (state.preset === pair[0] ? ' checked' : '') +
            '> ' +
            pair[1] +
            '</label>'
          );
        })
        .join('') +
      '</div>' +
      '<div class="gb-dr-custom">' +
      '<label>Start date<input type="date" data-start value="' +
      state.start +
      '"></label>' +
      '<label>End date<input type="date" data-end value="' +
      state.end +
      '"></label>' +
      '</div>' +
      '<div class="gb-dr-actions"><button type="button" class="gb-dr-cancel" data-close>Cancel</button>' +
      '<button type="button" class="gb-dr-apply" data-apply>Apply</button></div>' +
      '</div></div></div>';

    var modal = host.querySelector('.gb-dr-modal');
    function refreshChrome() {
      host.querySelectorAll('.gb-dr-chip[data-preset]').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-preset') === state.preset);
      });
      var more = host.querySelector('[data-open-more]');
      if (more)
        more.classList.toggle(
          'on',
          ['6m', '12m', '16m', 'custom'].indexOf(state.preset) >= 0
        );
      host.querySelectorAll('.gb-dr-chip[data-grain]').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-grain') === state.grain);
      });
      var lab = host.querySelector('[data-dr-label]');
      if (lab) lab.textContent = label(state);
    }
    function emit() {
      writeState(state);
      refreshChrome();
      if (typeof opts.onChange === 'function') opts.onChange(state);
      try {
        document.dispatchEvent(new CustomEvent('gb-date-range', { detail: state }));
      } catch (e) {}
    }
    host.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t.closest('[data-open-more]')) {
        modal.hidden = false;
        var rad = host.querySelector('input[name="gb-dr-preset"][value="' + state.preset + '"]');
        if (rad) rad.checked = true;
        host.querySelector('[data-start]').value = state.start;
        host.querySelector('[data-end]').value = state.end;
        return;
      }
      if (t.closest('[data-close]')) {
        modal.hidden = true;
        return;
      }
      if (t.closest('[data-apply]')) {
        var picked = host.querySelector('input[name="gb-dr-preset"]:checked');
        var preset = picked ? picked.value : 'custom';
        var s = host.querySelector('[data-start]').value;
        var e = host.querySelector('[data-end]').value;
        var grain = state.grain;
        state = applyPreset(preset, s, e);
        state.grain = grain;
        if (preset === 'custom') {
          state.start = s || state.start;
          state.end = e || state.end;
        }
        modal.hidden = true;
        emit();
        return;
      }
      var presetBtn = t.closest('[data-preset]');
      if (presetBtn) {
        var grain2 = state.grain;
        state = applyPreset(presetBtn.getAttribute('data-preset'));
        state.grain = grain2;
        emit();
        return;
      }
      var grainBtn = t.closest('[data-grain]');
      if (grainBtn) {
        state.grain = grainBtn.getAttribute('data-grain');
        emit();
      }
    });
    modal.addEventListener('click', function (ev) {
      if (ev.target === modal) modal.hidden = true;
    });
    refreshChrome();
    return {
      getState: function () {
        return Object.assign({}, state);
      },
      setState: function (next) {
        state = Object.assign({}, state, next);
        emit();
      },
    };
  }

  global.GbDateRange = {
    mount: mount,
    read: readState,
    write: writeState,
    applyPreset: applyPreset,
    label: label,
    inRange: inRange,
    rollupHistory: rollupHistory,
    bucketKey: bucketKey,
    toYMD: toYMD,
  };
})(typeof window !== 'undefined' ? window : globalThis);
