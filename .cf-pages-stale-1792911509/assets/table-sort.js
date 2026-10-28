/*! Shared sortable table helpers for Growth Board dashboards */
(function (global) {
  function cmp(a, b, dir) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'number' && typeof b === 'number') {
      if (isNaN(a) && isNaN(b)) return 0;
      if (isNaN(a)) return 1;
      if (isNaN(b)) return -1;
      return (a - b) * dir;
    }
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true }) * dir;
  }

  function sortRows(rows, key, dir, getVal) {
    var d = dir < 0 ? -1 : 1;
    var getter =
      getVal ||
      function (row) {
        return row[key];
      };
    return rows.slice().sort(function (a, b) {
      return cmp(getter(a, key), getter(b, key), d);
    });
  }

  function th(label, key, sortState, opts) {
    opts = opts || {};
    var active = sortState && sortState.key === key;
    var arrow = active ? (sortState.dir > 0 ? ' ↑' : ' ↓') : '';
    var cls = (opts.num ? 'num ' : '') + 'sortable' + (active ? ' sorted' : '');
    return (
      '<th class="' +
      cls +
      '" role="columnheader" tabindex="0" data-sort-key="' +
      key +
      '" title="Sort by ' +
      label +
      '">' +
      label +
      arrow +
      '</th>'
    );
  }

  /** Toggle sort state; returns new {key, dir} */
  function toggle(sortState, key, defaultDir) {
    var def = defaultDir == null ? -1 : defaultDir;
    if (sortState && sortState.key === key) {
      return { key: key, dir: sortState.dir > 0 ? -1 : 1 };
    }
    var textKeys = {
      query: 1,
      page: 1,
      type: 1,
      title: 1,
      name: 1,
      channel: 1,
      referrer: 1,
      status: 1,
      who: 1,
      date: 1,
      label: 1,
      id: 1,
      bucket: 1,
      primary: 1,
    };
    return { key: key, dir: textKeys[key] ? 1 : def };
  }

  function bindDelegated(root, onSort) {
    if (!root || root._gbSortBound) return;
    root._gbSortBound = true;
    root.addEventListener('click', function (ev) {
      var th = ev.target.closest('th.sortable');
      if (!th || !root.contains(th)) return;
      var key = th.getAttribute('data-sort-key');
      var table = th.closest('table');
      var sortId = (table && table.getAttribute('data-sort-id')) || 'default';
      if (key) onSort(sortId, key, th);
    });
    root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var th = ev.target.closest('th.sortable');
      if (!th) return;
      ev.preventDefault();
      th.click();
    });
  }

  global.GbTable = { sortRows: sortRows, th: th, toggle: toggle, bindDelegated: bindDelegated, cmp: cmp };
})(typeof window !== 'undefined' ? window : globalThis);
