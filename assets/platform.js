/*! Rytsense Internal Platform — sections 1–22 */
(function () {
  var fmt = new Intl.NumberFormat('en-US');
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function num(n) {
    if (n == null || n === '' || isNaN(n)) return '–';
    return fmt.format(Math.round(+n));
  }
  function pct(n) {
    if (n == null || isNaN(n)) return '–';
    return (+n).toFixed(1) + '%';
  }
  function head(t, s, b) {
    return (
      '<div class="card-head"><h2>' +
      t +
      '</h2><span class="sub">' +
      (b || '') +
      ' ' +
      (s || '') +
      '</span></div>'
    );
  }
  function badge(k, label) {
    return '<span class="badge ' + k + '">' + (label || k) + '</span>';
  }
  function pending(m) {
    return (
      '<div class="empty">' +
      badge('pending', 'pending') +
      '<p style="margin:8px 0 0">' +
      esc(m) +
      '</p></div>'
    );
  }
  function blocked(m) {
    return (
      '<div class="empty" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">' +
      badge('pending', 'Phase 4') +
      '<p style="margin:8px 0 0;color:var(--ink-soft)">' +
      esc(m) +
      '</p></div>'
    );
  }
  function delta(p) {
    if (p == null || isNaN(p)) return '';
    var f = Math.abs(p) < 0.1;
    return (
      '<div class="hint delta ' +
      (f ? 'flat' : p > 0 ? 'up' : 'down') +
      '">' +
      (f ? '→' : p > 0 ? '↑' : '↓') +
      ' ' +
      Math.abs(p).toFixed(1) +
      '%</div>'
    );
  }
  function pageType(path) {
    var p = String(path || '').toLowerCase();
    if (p === '/' || p === '') return 'Homepage';
    if (/\/about|\/company\//.test(p)) return 'About';
    if (/career|job|hiring/.test(p)) return 'Careers';
    if (/\/blog\//.test(p)) return 'Blog';
    if (/case-stud/.test(p)) return 'Case Studies';
    if (/whitepaper|resource|download/.test(p)) return 'Whitepapers';
    if (/\/us\//.test(p) && /service|development|ai-|devops|machine|generative|software|mobile|web-|data-|ui-ux/.test(p))
      return 'Services';
    if (/industr/.test(p)) return 'Industries';
    if (/solution/.test(p)) return 'Solutions';
    if (/contact|enquiry|inquiry/.test(p)) return 'Contact';
    if (/landing|campaign|lp\//.test(p)) return 'Landing';
    if (/\/us\//.test(p)) return 'US page';
    if (/service|development|ai-/.test(p)) return 'Services';
    return 'Other';
  }
  function bucketPos(pos) {
    if (pos <= 1) return '1';
    if (pos <= 3) return '2-3';
    if (pos <= 5) return '4-5';
    if (pos <= 10) return '6-10';
    if (pos <= 20) return '11-20';
    if (pos <= 50) return '21-50';
    return '51-100';
  }
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return o == null ? null : o[k];
    }, obj);
  }
  function channelSessions(name) {
    var ch = (state.live.ga4 && state.live.ga4.channels) || [];
    var x = ch.find(function (c) {
      return (c.channel || '').toLowerCase() === name.toLowerCase();
    });
    return x ? x.sessions : null;
  }
  function findChannel(re) {
    var ch = (state.live.ga4 && state.live.ga4.channels) || [];
    var sum = 0;
    var hit = false;
    ch.forEach(function (c) {
      if (re.test(c.channel || '')) {
        hit = true;
        sum += c.sessions || 0;
      }
    });
    return hit ? sum : null;
  }

  var state = {
    live: null,
    audit: null,
    goals: null,
    activity: null,
    fixes: null,
    history: [],
    engagements: null,
    filters: {},
    dateRange: null,
    sort: {
      page: { key: 'impressions', dir: -1 },
      kw: { key: 'impressions', dir: -1 },
      opp: { key: 'impressions', dir: -1 },
      cann: { key: 'impressionSum', dir: -1 },
      tech: { key: 'id', dir: 1 },
      money: { key: 'url', dir: 1 },
      indexSeg: { key: 'urls', dir: -1 },
      channels: { key: 'sessions', dir: -1 },
      ai: { key: 'sessions', dir: -1 },
      content: { key: 'impressions', dir: -1 },
      activity: { key: 'date', dir: -1 },
      reports: { key: 'date', dir: -1 },
      sources: { key: 'name', dir: 1 },
    },
  };

  function emptyFilters() {
    return {
      q: '',
      type: '',
      bucket: '',
      geo: '',
      minImpr: '',
      minClicks: '',
      maxPos: '',
      minSessions: '',
      status: '',
    };
  }
  function filtersFor(board) {
    if (!state.filters[board]) state.filters[board] = emptyFilters();
    return state.filters[board];
  }

  function T() {
    return window.GbTable || null;
  }
  function th(label, key, sortId, num) {
    var g = T();
    if (!g) {
      return (
        '<th class="' +
        (num ? 'num' : '') +
        '">' +
        label +
        '</th>'
      );
    }
    return g.th(label, key, state.sort[sortId], { num: !!num });
  }
  function applySort(rows, sortId, getVal) {
    var g = T();
    var s = state.sort[sortId] || { key: 'impressions', dir: -1 };
    if (!g) return rows;
    return g.sortRows(rows, s.key, s.dir, getVal);
  }
  function metricOk(board, impr, clicks, pos) {
    var f = filtersFor(board);
    var mi = f.minImpr === '' ? null : +f.minImpr;
    var mc = f.minClicks === '' ? null : +f.minClicks;
    var mp = f.maxPos === '' ? null : +f.maxPos;
    if (mi != null && !isNaN(mi) && (impr || 0) < mi) return false;
    if (mc != null && !isNaN(mc) && (clicks || 0) < mc) return false;
    if (mp != null && !isNaN(mp) && (pos == null || pos > mp)) return false;
    return true;
  }
  function sessionsOk(board, sessions) {
    var f = filtersFor(board);
    var ms = f.minSessions === '' ? null : +f.minSessions;
    if (ms != null && !isNaN(ms) && (sessions || 0) < ms) return false;
    return true;
  }
  function matchGeo(board, path) {
    var f = filtersFor(board);
    var p = String(path || '');
    if (f.geo === 'us') return /^\/us\//i.test(p);
    if (f.geo === 'global') return !/^\/us\//i.test(p);
    return true;
  }
  function matchQ(board, text) {
    var f = filtersFor(board);
    if (!f.q) return true;
    return String(text || '')
      .toLowerCase()
      .indexOf(f.q.toLowerCase()) !== -1;
  }
  function matchType(board, pathOrType) {
    var f = filtersFor(board);
    if (!f.type) return true;
    var t = pathOrType.indexOf('/') >= 0 || pathOrType === '' ? pageType(pathOrType) : pathOrType;
    return t === f.type;
  }
  function matchBucket(board, pos) {
    var f = filtersFor(board);
    if (!f.bucket) return true;
    return bucketPos(pos == null ? 99 : pos) === f.bucket;
  }
  function matchStatus(board, status) {
    var f = filtersFor(board);
    if (!f.status) return true;
    return String(status || '') === f.status;
  }

  /** opts: type, bucket, geo, metrics, sessions, status, qPlaceholder */
  function filterBar(board, opts) {
    opts = opts || {};
    var f = filtersFor(board);
    var html =
      '<div class="filters" data-filter-board="' +
      esc(board) +
      '">' +
      '<input type="search" data-f="q" placeholder="' +
      esc(opts.qPlaceholder || 'Filter…') +
      '" value="' +
      esc(f.q) +
      '">';
    if (opts.type) {
      html +=
        '<select data-f="type"><option value="">All page types</option>' +
        [
          'Homepage',
          'About',
          'Careers',
          'Services',
          'Industries',
          'Solutions',
          'Case Studies',
          'Whitepapers',
          'Blog',
          'Landing',
          'Contact',
          'US page',
          'Other',
        ]
          .map(function (t) {
            return (
              '<option value="' +
              t +
              '"' +
              (f.type === t ? ' selected' : '') +
              '>' +
              t +
              '</option>'
            );
          })
          .join('') +
        '</select>';
    }
    if (opts.bucket) {
      html +=
        '<select data-f="bucket"><option value="">All positions</option>' +
        ['1', '2-3', '4-5', '6-10', '11-20', '21-50', '51-100']
          .map(function (b) {
            return (
              '<option value="' +
              b +
              '"' +
              (f.bucket === b ? ' selected' : '') +
              '>Pos ' +
              b +
              '</option>'
            );
          })
          .join('') +
        '</select>';
    }
    if (opts.geo) {
      html +=
        '<select data-f="geo"><option value="">Global + US</option><option value="us"' +
        (f.geo === 'us' ? ' selected' : '') +
        '>US only (/us/)</option><option value="global"' +
        (f.geo === 'global' ? ' selected' : '') +
        '>Global (non-/us/)</option></select>';
    }
    if (opts.metrics) {
      html +=
        '<input class="metric" type="number" data-f="minImpr" placeholder="Min impr" value="' +
        esc(f.minImpr) +
        '" title="Minimum impressions">' +
        '<input class="metric" type="number" data-f="minClicks" placeholder="Min clicks" value="' +
        esc(f.minClicks) +
        '" title="Minimum clicks">' +
        '<input class="metric" type="number" data-f="maxPos" placeholder="Max pos" value="' +
        esc(f.maxPos) +
        '" title="Maximum average position">';
    }
    if (opts.sessions) {
      html +=
        '<input class="metric" type="number" data-f="minSessions" placeholder="Min sessions" value="' +
        esc(f.minSessions) +
        '" title="Minimum sessions">';
    }
    if (opts.status) {
      html +=
        '<select data-f="status"><option value="">All statuses</option>' +
        (opts.statusOptions || ['pass', 'fail', 'warn', 'pending', 'live', 'not_connected'])
          .map(function (s) {
            return (
              '<option value="' +
              s +
              '"' +
              (f.status === s ? ' selected' : '') +
              '>' +
              s +
              '</option>'
            );
          })
          .join('') +
        '</select>';
    }
    html += '<span class="sub">This board only · click headers to sort</span></div>';
    return html;
  }

  function renderExec() {
    var el = document.querySelector('[data-mod=exec]');
    var g = state.live.gsc,
      a = state.live.ga4;
    if (!g || !g.current) {
      el.innerHTML = head('1 · Executive Dashboard') + pending('No GSC totals yet');
      return;
    }
    var ai = findChannel(/ai|chatgpt|assistant/i);
    var paid = findChannel(/paid|cpc|display|ads/i);
    var organic = channelSessions('Organic Search');
    var direct = channelSessions('Direct');
    var social = channelSessions('Organic Social');
    var referral = channelSessions('Referral');
    el.innerHTML =
      head('1 · Executive Dashboard', 'Organic + channels · vs prior 28d', badge('live')) +
      '<div class="tiles">' +
      '<div class="tile"><div class="label">Total sessions</div><div class="value mono">' +
      num(a && a.totals && a.totals.sessions) +
      '</div>' +
      delta(null) +
      '</div>' +
      '<div class="tile"><div class="label">Organic sessions</div><div class="value mono">' +
      num(organic) +
      '</div></div>' +
      '<div class="tile"><div class="label">AI traffic</div><div class="value mono">' +
      num(ai) +
      '</div></div>' +
      '<div class="tile"><div class="label">Referral</div><div class="value mono">' +
      num(referral) +
      '</div></div>' +
      '<div class="tile"><div class="label">Direct</div><div class="value mono">' +
      num(direct) +
      '</div></div>' +
      '<div class="tile"><div class="label">Social</div><div class="value mono">' +
      num(social) +
      '</div><div class="hint">GA4 Organic Social</div></div>' +
      '<div class="tile"><div class="label">Paid</div><div class="value mono">' +
      num(paid) +
      '</div><div class="hint">' +
      (paid == null ? 'no paid channel in GA4' : 'GA4 paid / ads') +
      '</div></div>' +
      '<div class="tile"><div class="label">Organic clicks</div><div class="value mono">' +
      num(g.current.clicks) +
      '</div>' +
      delta(g.change && g.change.clicksPercent) +
      '</div>' +
      '<div class="tile"><div class="label">Impressions</div><div class="value mono">' +
      num(g.current.impressions) +
      '</div>' +
      delta(g.change && g.change.impressionsPercent) +
      '</div>' +
      '<div class="tile"><div class="label">CTR</div><div class="value mono">' +
      pct(g.current.ctr) +
      '</div></div>' +
      '<div class="tile"><div class="label">Avg position</div><div class="value mono">' +
      (g.current.position != null ? Number(g.current.position).toFixed(1) : '–') +
      '</div></div>' +
      '<div class="tile"><div class="label">Users</div><div class="value mono">' +
      num(a && a.totals && a.totals.activeUsers) +
      '</div></div>' +
      '<div class="tile"><div class="label">Engagement rate</div><div class="value mono">' +
      pct((a && a.totals && a.totals.engagementRate) * 100) +
      '</div></div>' +
      '</div>' +
      blocked(
        'Leads · qualified leads · conversion · backlinks · DA need CRM / Ahrefs (Phase 4). See Alerts for automated drops.'
      );
  }

  function renderGeo() {
    var el = document.querySelector('[data-mod=geo]');
    var g = state.live.gscByCountry,
      a = state.live.ga4ByCountry;
    if ((!g || g.status !== 'ok') && (!a || a.status !== 'ok')) {
      el.innerHTML =
        head('2 · Global & US Performance') +
        pending('Awaiting gscByCountry / ga4ByCountry from daily refresh');
      return;
    }
    var html = head('2 · Global & US Performance', 'Country rollups', badge('live'));
    if (g && g.status === 'ok') {
      html +=
        '<div class="grid2"><div><div class="sub">GSC United States</div><div class="tiles"><div class="tile"><div class="label">Clicks</div><div class="value mono">' +
        num(g.us && g.us.clicks) +
        '</div></div><div class="tile"><div class="label">Impr</div><div class="value mono">' +
        num(g.us && g.us.impressions) +
        '</div></div><div class="tile"><div class="label">CTR</div><div class="value mono">' +
        pct(g.us && g.us.ctr) +
        '</div></div><div class="tile"><div class="label">Pos</div><div class="value mono">' +
        (g.us && g.us.position != null ? Number(g.us.position).toFixed(1) : '–') +
        '</div></div></div></div>' +
        '<div><div class="sub">GSC Rest of world</div><div class="tiles"><div class="tile"><div class="label">Clicks</div><div class="value mono">' +
        num(g.global && g.global.clicks) +
        '</div></div><div class="tile"><div class="label">Impr</div><div class="value mono">' +
        num(g.global && g.global.impressions) +
        '</div></div><div class="tile"><div class="label">CTR</div><div class="value mono">' +
        pct(g.global && g.global.ctr) +
        '</div></div><div class="tile"><div class="label">Pos</div><div class="value mono">' +
        (g.global && g.global.position != null ? Number(g.global.position).toFixed(1) : '–') +
        '</div></div></div></div></div>';
    }
    if (a && a.status === 'ok')
      html +=
        '<div class="tiles" style="margin-top:12px"><div class="tile"><div class="label">GA4 US sessions</div><div class="value mono">' +
        num(a.us && a.us.sessions) +
        '</div></div><div class="tile"><div class="label">GA4 rest sessions</div><div class="value mono">' +
        num(a.rest && a.rest.sessions) +
        '</div></div><div class="tile"><div class="label">GA4 US users</div><div class="value mono">' +
        num(a.us && a.us.activeUsers) +
        '</div></div><div class="tile"><div class="label">GA4 rest users</div><div class="value mono">' +
        num(a.rest && a.rest.activeUsers) +
        '</div></div></div>';
    html += blocked('Leads / qualified leads by country need CRM integration.');
    el.innerHTML = html;
  }

  function pageRows() {
    var pages =
      state.live.gscByPage && state.live.gscByPage.status === 'ok'
        ? state.live.gscByPage.rows || []
        : [];
    var ga = {};
    if (state.live.ga4ByPage && state.live.ga4ByPage.status === 'ok')
      (state.live.ga4ByPage.rows || []).forEach(function (r) {
        ga[r.pagePath] = r;
      });
    return pages
      .filter(function (r) {
        if (!matchGeo('page', r.page)) return false;
        if (!matchType('page', r.page)) return false;
        if (!matchBucket('page', r.position)) return false;
        if (!matchQ('page', r.page)) return false;
        if (!metricOk('page', r.impressions, r.clicks, r.position)) return false;
        return true;
      })
      .map(function (r) {
        var g = ga[r.page] || {};
        return {
          page: r.page,
          type: pageType(r.page),
          impressions: r.impressions,
          clicks: r.clicks,
          ctr: r.ctr,
          position: r.position,
          sessions: g.sessions,
          engagementRate: g.engagementRate,
        };
      });
  }

  function renderPage() {
    var el = document.querySelector('[data-mod=page]');
    if (!(state.live.gscByPage && state.live.gscByPage.status === 'ok')) {
      el.innerHTML =
        head('3 · Website Page Performance') + pending('Needs gscByPage from scheduler');
      return;
    }
    var rows = applySort(pageRows(), 'page');
    var total = (state.live.gscByPage.rows || []).length;
    var inv = state.audit && state.audit.pageInventory;
    el.innerHTML =
      head(
        '3 · Website Page Performance',
        'Showing ' +
          rows.length +
          ' of ' +
          total +
          ' GSC URLs' +
          (inv ? ' · inventory ' + inv.totalUrls : '') +
          ' · sort: ' +
          state.sort.page.key,
        badge('live')
      ) +
      filterBar('page', {
        type: true,
        bucket: true,
        geo: true,
        metrics: true,
        qPlaceholder: 'Filter URL…',
      }) +
      '<p class="sub">Filters apply to this board only.</p>' +
      '<div class="table-wrap"><table data-sort-id="page"><thead><tr>' +
      th('URL', 'page', 'page') +
      th('Type', 'type', 'page') +
      th('Impr', 'impressions', 'page', true) +
      th('Clicks', 'clicks', 'page', true) +
      th('CTR', 'ctr', 'page', true) +
      th('Pos', 'position', 'page', true) +
      th('Sessions', 'sessions', 'page', true) +
      th('Eng %', 'engagementRate', 'page', true) +
      '</tr></thead><tbody>' +
      rows
        .map(function (r) {
          return (
            '<tr><td class="mono">' +
            esc(r.page) +
            '</td><td>' +
            esc(r.type) +
            '</td><td class="num mono">' +
            num(r.impressions) +
            '</td><td class="num mono">' +
            num(r.clicks) +
            '</td><td class="num mono">' +
            pct(r.ctr) +
            '</td><td class="num mono">' +
            (r.position != null ? Number(r.position).toFixed(1) : '–') +
            '</td><td class="num mono">' +
            num(r.sessions) +
            '</td><td class="num mono">' +
            (r.engagementRate != null ? pct(r.engagementRate * 100) : '–') +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
  }

  function kwRows() {
    var full = state.live.gscByQuery && state.live.gscByQuery.status === 'ok';
    var rows = full
      ? state.live.gscByQuery.rows || []
      : (state.live.gsc && state.live.gsc.quickWins) || [];
    return rows.filter(function (r) {
      if (!matchBucket('kw', r.position)) return false;
      if (!matchQ('kw', r.query)) return false;
      if (!metricOk('kw', r.impressions, r.clicks, r.position)) return false;
      return true;
    });
  }

  function renderKw() {
    var el = document.querySelector('[data-mod=kw]');
    var full = state.live.gscByQuery && state.live.gscByQuery.status === 'ok';
    var all = full ? state.live.gscByQuery.rows || [] : (state.live.gsc && state.live.gsc.quickWins) || [];
    var buckets =
      full && state.live.gscByQuery.buckets
        ? state.live.gscByQuery.buckets
        : { '1': 0, '2-3': 0, '4-5': 0, '6-10': 0, '11-20': 0, '21-50': 0, '51-100': 0 };
    if (!(full && state.live.gscByQuery.buckets))
      all.forEach(function (r) {
        var b = bucketPos(r.position || 99);
        buckets[b] = (buckets[b] || 0) + 1;
      });
    var rows = applySort(
      kwRows().map(function (r) {
        return Object.assign({}, r, { bucket: bucketPos(r.position || 99) });
      }),
      'kw'
    );
    var order = ['1', '2-3', '4-5', '6-10', '11-20', '21-50', '51-100'];
    el.innerHTML =
      head(
        '4 · Keyword Performance',
        'Showing ' +
          rows.length +
          ' of ' +
          all.length +
          (full ? '' : ' · partial') +
          ' · sort: ' +
          state.sort.kw.key,
        full ? badge('live') : badge('pending', 'partial')
      ) +
      '<div class="tiles">' +
      order
        .map(function (k) {
          return (
            '<div class="tile"><div class="label">Pos ' +
            k +
            '</div><div class="value mono" style="font-size:17px">' +
            num(buckets[k]) +
            '</div></div>'
          );
        })
        .join('') +
      '</div>' +
      filterBar('kw', {
        bucket: true,
        metrics: true,
        qPlaceholder: 'Filter keyword…',
      }) +
      '<p class="sub">Filters apply to this board only. Volume / KD / device need Ahrefs (Phase 4).</p>' +
      '<div class="table-wrap"><table data-sort-id="kw"><thead><tr>' +
      th('Keyword', 'query', 'kw') +
      th('Impr', 'impressions', 'kw', true) +
      th('Clicks', 'clicks', 'kw', true) +
      th('CTR', 'ctr', 'kw', true) +
      th('Pos', 'position', 'kw', true) +
      th('Bucket', 'bucket', 'kw') +
      '</tr></thead><tbody>' +
      rows
        .map(function (r) {
          return (
            '<tr><td>' +
            esc(r.query || '') +
            '</td><td class="num mono">' +
            num(r.impressions) +
            '</td><td class="num mono">' +
            num(r.clicks) +
            '</td><td class="num mono">' +
            pct(r.ctr) +
            '</td><td class="num mono">' +
            (r.position != null ? Number(r.position).toFixed(1) : '–') +
            '</td><td>' +
            esc(r.bucket) +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
  }

  function renderOpp() {
    var el = document.querySelector('[data-mod=opp]');
    var qw = (state.live.gsc && state.live.gsc.quickWins) || [];
    var queries =
      state.live.gscByQuery && state.live.gscByQuery.status === 'ok'
        ? state.live.gscByQuery.rows || []
        : qw;
    var derived = [];
    queries.forEach(function (r) {
      var pos = r.position || 99;
      var impr = r.impressions || 0;
      var clicks = r.clicks || 0;
      var ctr = r.ctr || 0;
      if (impr >= 100 && clicks === 0)
        derived.push({ type: 'zero_click', query: r.query, impressions: impr, clicks: clicks, ctr: ctr, position: pos });
      else if (impr >= 100 && ctr < 1 && pos >= 4 && pos <= 15)
        derived.push({ type: 'high_impr_low_ctr', query: r.query, impressions: impr, clicks: clicks, ctr: ctr, position: pos });
      else if (pos >= 4 && pos <= 10 && impr >= 50)
        derived.push({ type: 'pos_4_10', query: r.query, impressions: impr, clicks: clicks, ctr: ctr, position: pos });
      else if (pos > 10 && pos <= 20 && impr >= 80)
        derived.push({ type: 'pos_11_20', query: r.query, impressions: impr, clicks: clicks, ctr: ctr, position: pos });
    });
    derived = applySort(
      derived.filter(function (r) {
        if (!matchBucket('opp', r.position)) return false;
        return matchQ('opp', r.query) && metricOk('opp', r.impressions, r.clicks, r.position);
      }),
      'opp'
    );
    el.innerHTML =
      head('5 · SEO Opportunities', derived.length + ' auto flags · sort: ' + state.sort.opp.key, badge('live')) +
      filterBar('opp', {
        bucket: true,
        metrics: true,
        qPlaceholder: 'Filter query…',
      }) +
      '<div class="table-wrap"><table data-sort-id="opp"><thead><tr>' +
      th('Type', 'type', 'opp') +
      th('Query', 'query', 'opp') +
      th('Impr', 'impressions', 'opp', true) +
      th('Clicks', 'clicks', 'opp', true) +
      th('CTR', 'ctr', 'opp', true) +
      th('Pos', 'position', 'opp', true) +
      '</tr></thead><tbody>' +
      (derived.length
        ? derived
            .map(function (r) {
              return (
                '<tr><td><span class="badge pending">' +
                esc(r.type) +
                '</span></td><td>' +
                esc(r.query) +
                '</td><td class="num mono">' +
                num(r.impressions) +
                '</td><td class="num mono">' +
                num(r.clicks) +
                '</td><td class="num mono">' +
                pct(r.ctr) +
                '</td><td class="num mono">' +
                Number(r.position).toFixed(1) +
                '</td></tr>'
              );
            })
            .join('')
        : '<tr><td colspan="6" class="sub">No opportunity rows in current slice.</td></tr>') +
      '</tbody></table></div>' +
      (qw.length
        ? '<p class="sub" style="margin-top:10px">Classic quickWins (pos 4–15): ' +
          qw.length +
          '</p>'
        : '');
  }

  function renderCann() {
    var el = document.querySelector('[data-mod=cann]');
    var warn =
      (state.live.gscCannibalization && state.live.gscCannibalization.warning) ||
      'Global and /us/ trees both target the same English commercial intent.';
    var rows =
      state.live.gscCannibalization && state.live.gscCannibalization.status === 'ok'
        ? state.live.gscCannibalization.rows
        : null;
    var html =
      head('6 · Keyword Cannibalization', '', rows ? badge('live') : badge('pending')) +
      '<div class="warn-card"><strong>Standing warning</strong><p style="margin:6px 0 0;font-size:12.5px">' +
      esc(warn) +
      '</p></div>';
    if (!rows) html += pending('Needs GSC query×page → gscCannibalization');
    else {
      var filtered = applySort(
        rows
          .filter(function (r) {
            return (
              matchQ('cann', r.query) ||
              matchQ('cann', (r.pages || []).join(' '))
            );
          })
          .filter(function (r) {
            return metricOk('cann', r.impressionSum, null, null);
          })
          .map(function (r) {
            var pages = r.pages || [];
            return {
              query: r.query,
              pages: pages,
              pageCount: pages.length,
              impressionSum: r.impressionSum,
              positionVariance: r.positionVariance,
              primary: pages[0] || '',
            };
          }),
        'cann'
      );
      html +=
        filterBar('cann', {
          metrics: true,
          qPlaceholder: 'Filter keyword / URL…',
        }) +
        '<div class="table-wrap"><table data-sort-id="cann"><thead><tr>' +
        th('Keyword', 'query', 'cann') +
        th('URLs', 'pageCount', 'cann', true) +
        th('#', 'pageCount', 'cann', true) +
        th('Impr', 'impressionSum', 'cann', true) +
        th('σ pos', 'positionVariance', 'cann', true) +
        th('Primary', 'primary', 'cann') +
        '</tr></thead><tbody>' +
        filtered
          .map(function (r) {
            return (
              '<tr><td>' +
              esc(r.query) +
              '</td><td class="mono" style="font-size:11px">' +
              esc((r.pages || []).join(', ')) +
              '</td><td class="num mono">' +
              num(r.pageCount) +
              '</td><td class="num mono">' +
              num(r.impressionSum) +
              '</td><td class="num mono">' +
              (r.positionVariance != null ? Number(r.positionVariance).toFixed(2) : '–') +
              '</td><td class="mono">' +
              esc(r.primary || '–') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
    }
    el.innerHTML = html;
  }

  function renderTech() {
    var el = document.querySelector('[data-mod=tech]');
    var tech = state.audit && state.audit.technicalHealth;
    var money = (state.audit && state.audit.moneyPages) || [];
    if (!tech) {
      el.innerHTML =
        head('7 · Technical SEO') +
        pending('audit.json technicalHealth missing') +
        blocked('Full 404/5xx/redirect crawl needs Screaming Frog (Phase 4).');
      return;
    }
    var checks = applySort(
      (tech.checks || []).filter(function (c) {
        if (!matchStatus('tech', c.status)) return false;
        return (
          matchQ('tech', c.id) ||
          matchQ('tech', c.name) ||
          matchQ('tech', c.note) ||
          matchQ('tech', c.status)
        );
      }),
      'tech'
    );
    var moneyRows = applySort(
      money
        .map(function (m) {
          return {
            url: m.url,
            defects: (m.defects || []).join(', '),
            note: m.note || '',
          };
        })
        .filter(function (m) {
          return (
            matchQ('money', m.url) ||
            matchQ('money', m.defects) ||
            matchQ('money', m.note)
          );
        }),
      'money'
    );
    el.innerHTML =
      head(
        '7 · Technical SEO',
        tech.passing + '/' + tech.totalChecks + ' passing',
        badge('live')
      ) +
      '<div class="tiles"><div class="tile"><div class="label">Passing</div><div class="value mono">' +
      num(tech.passing) +
      '</div></div><div class="tile"><div class="label">Failing</div><div class="value mono">' +
      num(tech.failing) +
      '</div></div><div class="tile"><div class="label">Money pages flagged</div><div class="value mono">' +
      num(money.length) +
      '</div></div></div>' +
      filterBar('tech', {
        status: true,
        statusOptions: ['pass', 'fail', 'warn', 'pending'],
        qPlaceholder: 'Filter checks…',
      }) +
      '<div class="table-wrap" style="margin-top:12px"><table data-sort-id="tech"><thead><tr>' +
      th('ID', 'id', 'tech') +
      th('Check', 'name', 'tech') +
      th('Status', 'status', 'tech') +
      th('Note', 'note', 'tech') +
      '</tr></thead><tbody>' +
      checks
        .map(function (c) {
          var b =
            c.status === 'pass' ? 'live' : c.status === 'fail' ? 'blocked' : 'pending';
          return (
            '<tr><td class="mono">' +
            esc(c.id) +
            '</td><td>' +
            esc(c.name) +
            '</td><td>' +
            badge(b, c.status) +
            '</td><td class="sub">' +
            esc(c.note || '') +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>' +
      '<div class="card-head" style="margin-top:14px"><h2 style="font-size:14px">Money-page defects</h2></div>' +
      filterBar('money', { qPlaceholder: 'Filter money URLs…' }) +
      '<div class="table-wrap"><table data-sort-id="money"><thead><tr>' +
      th('URL', 'url', 'money') +
      th('Defects', 'defects', 'money') +
      th('Note', 'note', 'money') +
      '</tr></thead><tbody>' +
      moneyRows
        .map(function (m) {
          return (
            '<tr><td class="mono">' +
            esc(m.url) +
            '</td><td>' +
            esc(m.defects) +
            '</td><td class="sub">' +
            esc(m.note) +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>' +
      blocked(
        'Continuous 404/5xx/redirect chains/duplicates from Screaming Frog or Sitebulb — not connected.'
      );
  }

  function renderIndexation() {
    var el = document.querySelector('[data-mod=indexation]');
    var inv = state.audit && state.audit.pageInventory;
    var html =
      head('8 · Indexation', '', inv ? badge('live') : badge('pending')) +
      (inv
        ? '<div class="tiles"><div class="tile"><div class="label">Inventory URLs</div><div class="value mono">' +
          num(inv.totalUrls) +
          '</div></div><div class="tile"><div class="label">Global</div><div class="value mono">' +
          num(inv.globalUrls) +
          '</div></div><div class="tile"><div class="label">US tree</div><div class="value mono">' +
          num(inv.usUrls) +
          '</div></div><div class="tile"><div class="label">Blog posts</div><div class="value mono">' +
          num(inv.blogPostCount) +
          '</div></div></div>' +
          '<p class="sub">' +
          esc(inv.note || '') +
          '</p>' +
          '<div class="table-wrap"><table><thead><tr><th>Segment</th><th class="num">URLs</th></tr></thead><tbody>' +
          (inv.segments || [])
            .map(function (s) {
              return (
                '<tr><td>' +
                esc(s.name) +
                '</td><td class="num mono">' +
                num(s.urls) +
                '</td></tr>'
              );
            })
            .join('') +
          '</tbody></table></div>'
        : pending('No pageInventory in audit')) +
      blocked(
        'Submitted vs indexed vs excluded-by-reason needs GSC Page Indexing export API or Search Console UI scrape — wire next.'
      );
    el.innerHTML = html;
  }

  function renderCwv() {
    document.querySelector('[data-mod=cwv]').innerHTML =
      head('9 · Core Web Vitals / Performance', '', badge('blocked', 'gated')) +
      blocked(
        'LCP / INP / CLS (mobile & desktop) need CrUX API or PageSpeed / CWV field data integration — Phase 4.'
      );
  }

  function renderLinks() {
    var el = document.querySelector('[data-mod=links]');
    var inv = state.audit && state.audit.pageInventory;
    el.innerHTML =
      head('10 · Internal Linking', '', badge('live')) +
      '<div class="tiles"><div class="tile"><div class="label">Unlinked blogs → money</div><div class="value mono">' +
      num(inv && inv.unlinkedBlogToMoney) +
      '</div><div class="hint">From audit</div></div><div class="tile"><div class="label">Blog corpus</div><div class="value mono">' +
      num(inv && inv.blogPostCount) +
      '</div></div></div>' +
      blocked(
        'Per-URL inlink counts, orphan graph, anchor text map need site crawl (Screaming Frog) — not connected.'
      );
  }

  function renderBacklinks() {
    document.querySelector('[data-mod=backlinks]').innerHTML =
      head('11 · Backlinks & Authority', '', badge('blocked', 'gated')) +
      blocked(
        'DA, backlinks, referring domains, new/lost links need Ahrefs / Semrush / Moz — choose vendor to unlock.'
      );
  }

  function renderAcquisition() {
    var el = document.querySelector('[data-mod=acquisition]');
    var a = state.live.ga4;
    var ch = (a && a.channels) || [];
    if (!a || !a.totals) {
      el.innerHTML = head('12 · Traffic & Acquisition') + pending('No GA4 totals');
      return;
    }
    var chSorted = applySort(
      ch.filter(function (c) {
        if (!matchQ('channels', c.channel)) return false;
        if (!sessionsOk('channels', c.sessions)) return false;
        return true;
      }),
      'channels'
    );
    el.innerHTML =
      head('12 · Traffic & Acquisition', 'GA4 channels · this board only', badge('live')) +
      '<div class="tiles"><div class="tile"><div class="label">Users</div><div class="value mono">' +
      num(a.totals.activeUsers) +
      '</div></div><div class="tile"><div class="label">Sessions</div><div class="value mono">' +
      num(a.totals.sessions) +
      '</div></div><div class="tile"><div class="label">Page views</div><div class="value mono">' +
      num(a.totals.pageViews) +
      '</div></div><div class="tile"><div class="label">Engagement rate</div><div class="value mono">' +
      pct(a.totals.engagementRate * 100) +
      '</div></div></div>' +
      filterBar('channels', {
        sessions: true,
        qPlaceholder: 'Filter channel…',
      }) +
      '<div class="table-wrap" style="margin-top:12px"><table data-sort-id="channels"><thead><tr>' +
      th('Channel', 'channel', 'channels') +
      th('Sessions', 'sessions', 'channels', true) +
      th('Users', 'activeUsers', 'channels', true) +
      th('Conv', 'conversions', 'channels', true) +
      '</tr></thead><tbody>' +
      chSorted
        .map(function (c) {
          return (
            '<tr><td>' +
            esc(c.channel) +
            '</td><td class="num mono">' +
            num(c.sessions) +
            '</td><td class="num mono">' +
            num(c.activeUsers) +
            '</td><td class="num mono">' +
            num(c.conversions) +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>' +
      blocked('Campaign / medium / device splits beyond channel group need expanded GA4 dimensions in daily refresh.');
  }

  function renderAi() {
    var el = document.querySelector('[data-mod=ai]');
    var ai = state.live.ga4AiTraffic;
    var base = state.audit && state.audit.baselines;
    var html =
      head(
        '13 · AI / GEO Performance',
        'Referrers + audit baselines',
        ai && ai.status === 'ok' ? badge('live') : badge('pending')
      );
    if (base)
      html +=
        '<div class="tiles"><div class="tile"><div class="label">Non-brand cite rate</div><div class="value mono">' +
        (base.aiCitationRateNonBranded * 100).toFixed(1) +
        '%</div></div><div class="tile"><div class="label">Branded cite</div><div class="value mono">' +
        esc(base.aiCitationRateBranded) +
        '</div></div><div class="tile"><div class="label">SoV vs LeewayHertz</div><div class="value mono" style="font-size:16px">' +
        esc(base.aiShareOfVoiceVsLeewayHertz) +
        '</div></div><div class="tile"><div class="label">AI sessions (GA4 ch)</div><div class="value mono">' +
        num(findChannel(/ai|chatgpt|assistant/i)) +
        '</div></div></div>';
    if (!ai || ai.status !== 'ok')
      html += pending('Scheduler adds ga4AiTraffic by referrer (ChatGPT, Perplexity, Gemini, Claude, Copilot).');
    else {
      var aiRows = applySort(
        (ai.rows || []).filter(function (r) {
          if (!matchQ('ai', r.referrer)) return false;
          if (!sessionsOk('ai', r.sessions)) return false;
          return true;
        }),
        'ai'
      );
      html +=
        filterBar('ai', {
          sessions: true,
          qPlaceholder: 'Filter AI referrer…',
        }) +
        '<div class="table-wrap" style="margin-top:12px"><table data-sort-id="ai"><thead><tr>' +
        th('AI referrer', 'referrer', 'ai') +
        th('Sessions', 'sessions', 'ai', true) +
        th('Users', 'activeUsers', 'ai', true) +
        '</tr></thead><tbody>' +
        aiRows
          .map(function (r) {
            return (
              '<tr><td>' +
              esc(r.referrer) +
              '</td><td class="num mono">' +
              num(r.sessions) +
              '</td><td class="num mono">' +
              num(r.activeUsers) +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
    }
    if (state.audit && state.audit.aiAccuracyErrors) {
      html +=
        '<div class="card-head" style="margin-top:14px"><h2 style="font-size:14px">AI factual errors (audit)</h2></div>';
      html += (state.audit.aiAccuracyErrors || [])
        .filter(function (e) {
          return e.live !== false;
        })
        .slice(0, 8)
        .map(function (e) {
          return (
            '<div class="empty" style="padding:6px 0;border-bottom:1px solid var(--line)"><strong class="mono">' +
            esc(e.id) +
            '</strong> ' +
            esc(e.error) +
            '</div>'
          );
        })
        .join('');
    }
    html += blocked('AI leads / citations / prompt coverage need CRM + AI visibility tool.');
    el.innerHTML = html;
  }

  function renderContent() {
    var el = document.querySelector('[data-mod=content]');
    var inv = state.audit && state.audit.pageInventory;
    var pages =
      state.live.gscByPage && state.live.gscByPage.status === 'ok'
        ? state.live.gscByPage.rows || []
        : [];
    var content = pages.filter(function (r) {
      return /\/(blog|case-stud|resource|whitepaper)/i.test(r.page || '');
    });
    content = content.filter(function (r) {
      if (!matchGeo('content', r.page)) return false;
      if (!matchType('content', r.page)) return false;
      if (!matchBucket('content', r.position)) return false;
      if (!matchQ('content', r.page)) return false;
      if (!metricOk('content', r.impressions, r.clicks, r.position)) return false;
      return true;
    });
    content = applySort(
      content.map(function (r) {
        return Object.assign({}, r, { type: pageType(r.page) });
      }),
      'content'
    );
    el.innerHTML =
      head(
        '14 · Content Performance',
        content.length + ' content URLs · sort: ' + state.sort.content.key,
        badge('live')
      ) +
      '<div class="tiles"><div class="tile"><div class="label">Content shown</div><div class="value mono">' +
      num(content.length) +
      '</div></div><div class="tile"><div class="label">Audit blogs</div><div class="value mono">' +
      num(inv && inv.blogPostCount) +
      '</div></div><div class="tile"><div class="label">Unlinked to money</div><div class="value mono">' +
      num(inv && inv.unlinkedBlogToMoney) +
      '</div></div></div>' +
      filterBar('content', {
        type: true,
        bucket: true,
        geo: true,
        metrics: true,
        qPlaceholder: 'Filter content URL…',
      }) +
      '<div class="table-wrap"><table data-sort-id="content"><thead><tr>' +
      th('URL', 'page', 'content') +
      th('Type', 'type', 'content') +
      th('Impr', 'impressions', 'content', true) +
      th('Clicks', 'clicks', 'content', true) +
      th('CTR', 'ctr', 'content', true) +
      th('Pos', 'position', 'content', true) +
      '</tr></thead><tbody>' +
      content
        .map(function (r) {
          return (
            '<tr><td class="mono">' +
            esc(r.page) +
            '</td><td>' +
            esc(r.type) +
            '</td><td class="num mono">' +
            num(r.impressions) +
            '</td><td class="num mono">' +
            num(r.clicks) +
            '</td><td class="num mono">' +
            pct(r.ctr) +
            '</td><td class="num mono">' +
            (r.position != null ? Number(r.position).toFixed(1) : '–') +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
  }

  function historyMapped() {
    return (state.history || []).map(function (h) {
      var c = h.gsc && (h.gsc.current || h.gsc);
      var t = h.ga4 && (h.ga4.totals || h.ga4);
      return {
        date: h.date,
        clicks: c && c.clicks,
        impressions: c && c.impressions,
        ctr: c && c.ctr,
        position: c && c.position,
        sessions: t && (t.sessions != null ? t.sessions : t),
      };
    });
  }
  function rangedHistory() {
    var dr = state.dateRange || (window.GbDateRange && window.GbDateRange.read());
    if (!window.GbDateRange || !dr) return historyMapped();
    return window.GbDateRange.rollupHistory(historyMapped(), dr);
  }

  function renderDecay() {
    var el = document.querySelector('[data-mod=decay]');
    var hist = rangedHistory().slice().sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date));
    });
    var dr = state.dateRange || (window.GbDateRange && window.GbDateRange.read());
    var grain = (dr && dr.grain) || 'day';
    if (hist.length < 2) {
      el.innerHTML =
        head('15 · Content Decay', 'Needs ≥2 snapshots in selected range', badge('pending')) +
        pending(
          'Selected range has ' +
            hist.length +
            ' snapshot(s). Daily refresh writes data/history — as more days accumulate, day/week/month trends fill in.'
        );
      return;
    }
    var newest = hist[hist.length - 1],
      oldest = hist[0];
    function chg(a, b) {
      if (a == null || b == null || !b) return null;
      return ((a - b) / b) * 100;
    }
    el.innerHTML =
      head(
        '15 · Content Decay',
        (oldest.bucketLabel || oldest.date) +
          ' → ' +
          (newest.bucketLabel || newest.date) +
          ' · ' +
          grain,
        badge('live')
      ) +
      '<div class="tiles">' +
      '<div class="tile"><div class="label">Clicks Δ</div><div class="value mono">' +
      pct(chg(newest.clicks, oldest.clicks)) +
      '</div><div class="hint">' +
      num(oldest.clicks) +
      ' → ' +
      num(newest.clicks) +
      '</div></div>' +
      '<div class="tile"><div class="label">Impr Δ</div><div class="value mono">' +
      pct(chg(newest.impressions, oldest.impressions)) +
      '</div></div>' +
      '<div class="tile"><div class="label">Sessions Δ</div><div class="value mono">' +
      pct(chg(newest.sessions, oldest.sessions)) +
      '</div></div>' +
      '<div class="tile"><div class="label">Points in range</div><div class="value mono">' +
      num(hist.length) +
      '</div></div></div>' +
      '<p class="sub" style="margin-top:10px">Uses trailing-window snapshots (not calendar-day GSC sums). Per-URL decay needs page-level history series next.</p>';
  }

  function renderLeads() {
    document.querySelector('[data-mod=leads]').innerHTML =
      head('16 · Leads & Conversion', '', badge('blocked', 'gated')) +
      blocked(
        'Total / qualified / MQL / SQL / opportunity funnel needs CRM (HubSpot / Zoho / Pipedrive). Connect vendor to unlock.'
      );
  }

  function renderActivity() {
    var el = document.querySelector('[data-mod=activity]');
    var entries = ((state.activity && state.activity.entries) || []).filter(function (e) {
      return (
        matchQ('activity', e.who) ||
        matchQ('activity', e.activityType) ||
        matchQ('activity', e.note) ||
        matchQ('activity', e.url)
      );
    });
    entries = applySort(entries, 'activity');
    el.innerHTML =
      head('17 · Marketing Activity Tracker', 'Append-only log · this board only', badge('live')) +
      '<form class="row" id="activity-form">' +
      '<input name="who" placeholder="Who" required>' +
      '<select name="activityType"><option value="fix">Fix</option><option value="content">Content</option><option value="tech">Tech</option><option value="outreach">Outreach</option><option value="note">Note</option></select>' +
      '<input name="url" placeholder="URL (optional)">' +
      '<button type="submit">Add</button></form>' +
      '<input name="note" id="activity-note" placeholder="What happened?" style="width:100%;margin-top:8px">' +
      filterBar('activity', { qPlaceholder: 'Filter activity…' }) +
      '<div class="table-wrap" style="margin-top:12px"><table data-sort-id="activity"><thead><tr>' +
      th('When', 'date', 'activity') +
      th('Who', 'who', 'activity') +
      th('Type', 'activityType', 'activity') +
      th('Note', 'note', 'activity') +
      '</tr></thead><tbody>' +
      (entries.length
        ? entries
            .slice(0, 60)
            .map(function (e) {
              return (
                '<tr><td class="mono">' +
                esc((e.date || '').slice(0, 16)) +
                '</td><td>' +
                esc(e.who) +
                '</td><td>' +
                esc(e.activityType) +
                '</td><td>' +
                esc(e.note) +
                (e.url
                  ? ' · <a href="' + esc(e.url) + '" target="_blank">link</a>'
                  : '') +
                '</td></tr>'
              );
            })
            .join('')
        : '<tr><td colspan="4" class="sub">No activity yet.</td></tr>') +
      '</tbody></table></div>';
  }

  function currentValueForGoal(t) {
    if (t.source === 'fixes.done') {
      var items = (state.fixes && state.fixes.items) || [];
      return items.filter(function (i) {
        return i.done;
      }).length;
    }
    if (t.source === 'audit.baselines') return t.baseline;
    if (t.source === 'audit.baselines.aiCitationRateNonBranded')
      return (
        state.audit &&
        state.audit.baselines &&
        state.audit.baselines.aiCitationRateNonBranded
      );
    return getPath(state.live, t.source);
  }

  function renderGoals() {
    var el = document.querySelector('[data-mod=goals]');
    var targets = (state.goals && state.goals.targets) || [];
    el.innerHTML =
      head('18 · Goals & Targets', 'Editable · KV when API live', badge('live')) +
      '<div class="table-wrap"><table><thead><tr><th>KPI</th><th>Cadence</th><th class="num">Current</th><th class="num">Previous</th><th class="num">Target</th><th></th></tr></thead><tbody>' +
      targets
        .map(function (t) {
          var cur = currentValueForGoal(t);
          var prev =
            t.id === 'organic_clicks'
              ? state.live.gsc && state.live.gsc.prior && state.live.gsc.prior.clicks
              : t.id === 'sessions'
                ? null
                : t.baseline;
          var curDisp =
            t.unit === 'pct'
              ? pct(cur)
              : t.unit === 'pct_fraction'
                ? pct((cur || 0) * 100)
                : t.unit === 'text'
                  ? esc(cur)
                  : num(cur);
          var prevDisp =
            prev == null
              ? '—'
              : t.unit === 'pct_fraction'
                ? pct((+prev) * 100)
                : t.unit === 'text'
                  ? esc(prev)
                  : num(prev);
          var tgt = t.target;
          var tgtDisp =
            tgt == null
              ? '—'
              : t.unit === 'pct_fraction'
                ? pct((+tgt) * 100)
                : t.unit === 'pct'
                  ? pct(tgt)
                  : t.unit === 'text'
                    ? esc(tgt)
                    : num(tgt);
          return (
            '<tr><td>' +
            esc(t.label) +
            '</td><td>' +
            esc(t.cadence) +
            '</td><td class="num mono">' +
            curDisp +
            '</td><td class="num mono">' +
            prevDisp +
            '</td><td class="num"><input data-goal="' +
            esc(t.id) +
            '" value="' +
            (tgt == null ? '' : esc(tgt)) +
            '" style="width:110px;text-align:right"></td><td><button class="secondary" data-save-goal="' +
            esc(t.id) +
            '">Save</button></td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
  }

  function renderAlerts() {
    var el = document.querySelector('[data-mod=alerts]');
    var alerts = [];
    var g = state.live.gsc;
    if (g && g.change && g.change.clicksPercent != null && g.change.clicksPercent <= -15)
      alerts.push({
        sev: 'bad',
        title: 'Organic clicks down ' + g.change.clicksPercent.toFixed(1) + '% vs prior 28d',
      });
    if (
      g &&
      g.change &&
      g.change.impressionsPercent != null &&
      g.change.impressionsPercent <= -15
    )
      alerts.push({
        sev: 'warn',
        title: 'Impressions down ' + g.change.impressionsPercent.toFixed(1) + '% vs prior',
      });
    if (g && g.change && g.change.ctr != null && g.change.ctr <= -0.3)
      alerts.push({ sev: 'warn', title: 'CTR declined ' + g.change.ctr.toFixed(2) + ' pts vs prior' });
    var hist = state.history;
    if (hist.length >= 2) {
      var n = hist[hist.length - 1],
        o = hist[hist.length - 2];
      var nc = n.gsc && n.gsc.current && n.gsc.current.clicks,
        oc = o.gsc && o.gsc.current && o.gsc.current.clicks;
      if (nc != null && oc) {
        var d = ((nc - oc) / oc) * 100;
        if (d <= -10)
          alerts.push({
            sev: 'bad',
            title: 'Day-over-day clicks drop ' + d.toFixed(1) + '% (' + o.date + '→' + n.date + ')',
          });
        if (d >= 15)
          alerts.push({
            sev: 'good',
            title: 'Day-over-day clicks up ' + d.toFixed(1) + '%',
          });
      }
    }
    if (state.audit && state.audit.criticalIssues)
      alerts.push({
        sev: 'bad',
        title:
          state.audit.criticalIssues.length +
          ' critical audit issues — create/assign on Team Tasks',
      });
    if (state.live.clarity && state.live.clarity.status !== 'ok')
      alerts.push({ sev: 'warn', title: 'Clarity not reporting' });
    var th = state.audit && state.audit.technicalHealth;
    if (th && th.failing)
      alerts.push({ sev: 'warn', title: th.failing + ' technical checks failing in audit' });
    if (!alerts.length)
      alerts.push({ sev: 'good', title: 'No threshold alerts on current data' });
    el.innerHTML =
      head('19 · Automated Alerts', 'Rules on latest + history + audit', badge('live')) +
      alerts
        .map(function (a) {
          return (
            '<div class="empty" style="border-bottom:1px solid var(--line);padding:8px 0">' +
            badge(
              a.sev === 'bad' ? 'blocked' : a.sev === 'warn' ? 'pending' : 'live',
              a.sev
            ) +
            ' <strong style="margin-left:6px">' +
            esc(a.title) +
            '</strong></div>'
          );
        })
        .join('');
  }

  function renderReports() {
    var el = document.querySelector('[data-mod=reports]');
    var dr = state.dateRange || (window.GbDateRange && window.GbDateRange.read());
    var grain = (dr && dr.grain) || 'day';
    var hist = rangedHistory().filter(function (h) {
      if (!matchQ('reports', h.date + ' ' + (h.bucketLabel || ''))) return false;
      if (!metricOk('reports', h.impressions, h.clicks, h.position)) return false;
      if (!sessionsOk('reports', h.sessions)) return false;
      return true;
    });
    hist = applySort(hist, 'reports');
    el.innerHTML =
      head(
        '20 · Weekly & Monthly Reporting',
        hist.length +
          ' ' +
          grain +
          ' point(s) · ' +
          (dr ? dr.start + ' → ' + dr.end : 'all history'),
        badge('live')
      ) +
      (state.history.length
        ? filterBar('reports', {
            metrics: true,
            sessions: true,
            qPlaceholder: 'Filter date…',
          }) +
          '<div class="table-wrap"><table data-sort-id="reports"><thead><tr>' +
          th(grain === 'day' ? 'Date' : grain === 'week' ? 'Week' : 'Month', 'date', 'reports') +
          th('Clicks', 'clicks', 'reports', true) +
          th('Impr', 'impressions', 'reports', true) +
          th('CTR', 'ctr', 'reports', true) +
          th('Pos', 'position', 'reports', true) +
          th('Sessions', 'sessions', 'reports', true) +
          '</tr></thead><tbody>' +
          (hist.length
            ? hist
                .map(function (h) {
                  return (
                    '<tr><td class="mono">' +
                    esc(h.bucketLabel || h.date) +
                    '</td><td class="num mono">' +
                    num(h.clicks) +
                    '</td><td class="num mono">' +
                    num(h.impressions) +
                    '</td><td class="num mono">' +
                    pct(h.ctr) +
                    '</td><td class="num mono">' +
                    (h.position != null ? Number(h.position).toFixed(1) : '–') +
                    '</td><td class="num mono">' +
                    num(h.sessions) +
                    '</td></tr>'
                  );
                })
                .join('')
            : '<tr><td colspan="6" class="sub">No snapshots in this date range yet. Keep daily refresh running.</td></tr>') +
          '</tbody></table></div>'
        : pending('No history yet')) +
      '<p class="sub" style="margin-top:10px">Date range + Day/Week/Month controls sit above all modules. Snapshot values are trailing GSC/GA4 totals as of each day (not summed calendar days).</p>';
  }

  function renderFiltersHelp() {
    document.querySelector('[data-mod=filters]').innerHTML =
      head('21 · Dashboard Filters & Sorting', 'Date range + per-board metric filters', badge('live')) +
      '<p class="sub"><strong>Date range (GSC-style):</strong> 7 days / 28 days / 3 months / More (6–16 months or custom) + <strong>Day · Week · Month</strong> grain. Powers Reporting &amp; Content Decay accurately from <span class="mono">data/history</span>.<br><strong>Per-board filters:</strong> search, page type, position, geo, min impr/clicks/sessions — apply only to that module.<br><strong>Accuracy:</strong> page/keyword detail tables still use the latest GSC window in <span class="mono">latest.json</span> until multi-period GSC pulls ship.</p>';
  }

  function renderSources() {
    var el = document.querySelector('[data-mod=sources]');
    var rows = applySort(
      ((state.audit && state.audit.sourceStatus) || []).filter(function (s) {
        if (!matchStatus('sources', s.status)) return false;
        return matchQ('sources', s.name) || matchQ('sources', s.note) || matchQ('sources', s.status);
      }),
      'sources'
    );
    el.innerHTML =
      head('22 · Data Sources / Integrations', 'This board only', badge('live')) +
      filterBar('sources', {
        status: true,
        statusOptions: ['live', 'pending', 'not_connected', 'partial'],
        qPlaceholder: 'Filter source…',
      }) +
      '<div class="table-wrap"><table data-sort-id="sources"><thead><tr>' +
      th('Source', 'name', 'sources') +
      th('Status', 'status', 'sources') +
      th('Note', 'note', 'sources') +
      '</tr></thead><tbody>' +
      rows
        .map(function (s) {
          var b =
            s.status === 'live' ? 'live' : s.status === 'not_connected' ? 'off' : 'pending';
          return (
            '<tr><td>' +
            esc(s.name) +
            '</td><td>' +
            badge(b, s.status) +
            '</td><td class="sub">' +
            esc(s.note || '') +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>';
  }

  function renderBlocked() {
    var el = document.querySelector('[data-mod=blocked]');
    var items = [
      { name: 'CRM (HubSpot / Zoho / Pipedrive)', unlocks: '§1 §3 §16 leads & conversion' },
      { name: 'Ahrefs / Semrush / Moz', unlocks: '§4 KD/volume · §11 backlinks/DA' },
      { name: 'Screaming Frog / Sitebulb', unlocks: '§7 full tech · §8 indexation detail · §10 link graph' },
      { name: 'CrUX / PageSpeed', unlocks: '§9 Core Web Vitals' },
      { name: 'Google Ads / Bing Ads', unlocks: 'Paid tiles & CAC' },
      { name: 'Google Business Profile', unlocks: 'Local pack / reviews' },
      { name: 'Social / Marketing automation', unlocks: 'Campaign attribution beyond GA4' },
    ];
    el.innerHTML =
      head('Phase 4 — gated integrations', 'UI ready · connect vendor to unlock JSON fields', badge('blocked', 'gated')) +
      items
        .map(function (i) {
          return (
            '<div class="empty" style="border-bottom:1px solid var(--line);padding:10px 0"><strong>' +
            esc(i.name) +
            '</strong><p style="margin:4px 0 0" class="sub">Unlocks: ' +
            esc(i.unlocks) +
            '</p></div>'
          );
        })
        .join('');
  }

  function renderFixes() {
    var el = document.querySelector('[data-mod=fixes]');
    var items = (state.fixes && state.fixes.items) || [];
    var done = items.filter(function (i) {
      return i.done;
    }).length;
    el.innerHTML =
      head('Fixes Tracker', done + ' / ' + items.length + ' done', '<a href="report.html#fixes">Report →</a>') +
      '<div class="tiles"><div class="tile"><div class="label">Open</div><div class="value mono">' +
      num(items.length - done) +
      '</div></div><div class="tile"><div class="label">Done</div><div class="value mono">' +
      num(done) +
      '</div></div><div class="tile"><div class="label">Critical open</div><div class="value mono">' +
      num(
        items.filter(function (i) {
          return i.type === 'critical' && !i.done;
        }).length
      ) +
      '</div></div></div>' +
      '<p class="sub" style="margin-top:10px"><a href="tasks.html">Team Tasks</a> — weekly audit creates Unassigned criticals for Rama/Srivishwa to claim.</p>';
  }

  function renderAgents() {
    var el = document.querySelector('[data-mod=agents]');
    var list = (state.engagements && state.engagements.engagements) || [];
    var latest =
      state.engagements && state.engagements.latest
        ? state.engagements.latest
        : list[0];
    if (!latest) {
      el.innerHTML =
        head('Agent Engagements', '52-agent SEO team', badge('pending')) +
        pending('No engagements yet. Weekly schedule publishes via /api/engagements.');
      return;
    }
    var v = latest.verdict || {};
    var findings = latest.findings || [];
    var agents = (latest.agentsUsed || []).slice(0, 16);
    el.innerHTML =
      head(
        'Agent Engagements',
        (latest.command || '') + ' · ' + (latest.finishedAt || '').slice(0, 10),
        badge('live')
      ) +
      '<p style="margin:0 0 12px;color:var(--ink-soft);max-width:72ch">' +
      esc(latest.summary) +
      '</p>' +
      '<div class="tiles"><div class="tile"><div class="label">Critical</div><div class="value mono">' +
      num(v.criticalCount) +
      '</div></div><div class="tile"><div class="label">Findings</div><div class="value mono">' +
      num(findings.length) +
      '</div></div><div class="tile"><div class="label">Agents used</div><div class="value mono">' +
      num((latest.agentsUsed || []).length) +
      '</div></div></div>' +
      (agents.length
        ? '<p class="sub" style="margin-top:12px">' +
          agents
            .map(function (a) {
              return '<span class="badge off" style="margin:0 4px 4px 0">' + esc(a) + '</span>';
            })
            .join('') +
          '</p>'
        : '');
  }

  function renderAudit() {
    var el = document.querySelector('[data-mod=audit]');
    var a = state.audit;
    if (!a) {
      el.innerHTML = head('Audit Snapshot') + pending('audit.json missing');
      return;
    }
    el.innerHTML =
      head('Audit Snapshot', a.auditedRange, badge('live')) +
      '<p style="margin:0 0 10px;color:var(--ink-soft);max-width:70ch">' +
      esc(a.verdict && a.verdict.summary) +
      '</p>' +
      '<div class="tiles"><div class="tile"><div class="label">Critical</div><div class="value mono">' +
      num(a.verdict && a.verdict.criticalCount) +
      '</div></div><div class="tile"><div class="label">High</div><div class="value mono">' +
      num(a.verdict && a.verdict.highCount) +
      '</div></div><div class="tile"><div class="label">URLs</div><div class="value mono">' +
      num(a.pageInventory && a.pageInventory.totalUrls) +
      '</div></div><div class="tile"><div class="label">Easy wins</div><div class="value mono">' +
      num((a.easyWins || []).length) +
      '</div></div></div>' +
      '<p class="sub" style="margin-top:10px"><a href="report.html">Intelligence Report</a> · <a href="tasks.html">Team Tasks</a></p>';
  }

  var FILTER_RENDERERS = {
    page: function () {
      renderPage();
    },
    kw: function () {
      renderKw();
    },
    opp: function () {
      renderOpp();
    },
    cann: function () {
      renderCann();
    },
    content: function () {
      renderContent();
    },
    tech: function () {
      renderTech();
    },
    money: function () {
      renderTech();
    },
    channels: function () {
      renderAcquisition();
    },
    ai: function () {
      renderAi();
    },
    reports: function () {
      renderReports();
    },
    sources: function () {
      renderSources();
    },
    activity: function () {
      renderActivity();
    },
  };

  function bindFilters() {
    var root = document.querySelector('.main') || document.body;
    if (root._gbFilterBound) return;
    root._gbFilterBound = true;
    root.addEventListener('input', onFilter);
    root.addEventListener('change', onFilter);
  }
  function onFilter(ev) {
    var node = ev && ev.target;
    if (!node || !node.getAttribute) return;
    var k = node.getAttribute('data-f');
    if (!k) return;
    var bar = node.closest('[data-filter-board]');
    if (!bar) return;
    var board = bar.getAttribute('data-filter-board');
    if (!board) return;
    filtersFor(board)[k] = node.value;
    var fn = FILTER_RENDERERS[board];
    if (fn) fn();
  }

  function bindSortClicks() {
    var g = T();
    if (!g) return;
    g.bindDelegated(document.querySelector('.main') || document.body, function (sortId, key) {
      if (!state.sort[sortId]) state.sort[sortId] = { key: key, dir: -1 };
      state.sort[sortId] = g.toggle(state.sort[sortId], key, -1);
      var map = {
        page: renderPage,
        kw: renderKw,
        opp: renderOpp,
        cann: renderCann,
        tech: renderTech,
        money: renderTech,
        indexSeg: renderIndexation,
        channels: renderAcquisition,
        ai: renderAi,
        content: renderContent,
        activity: renderActivity,
        reports: renderReports,
        sources: renderSources,
      };
      if (map[sortId]) map[sortId]();
    });
  }

  function renderAll() {
    renderExec();
    renderGeo();
    renderPage();
    renderKw();
    renderOpp();
    renderCann();
    renderTech();
    renderIndexation();
    renderCwv();
    renderLinks();
    renderBacklinks();
    renderAcquisition();
    renderAi();
    renderContent();
    renderDecay();
    renderLeads();
    renderActivity();
    renderGoals();
    renderAlerts();
    renderReports();
    renderFiltersHelp();
    renderSources();
    renderBlocked();
    renderFixes();
    renderAgents();
    renderAudit();
    bindSortClicks();
    bindFilters();
    mountDateRange();
  }

  function mountDateRange() {
    if (!window.GbDateRange) return;
    if (document.documentElement._gbDateMounted) {
      state.dateRange = window.GbDateRange.read();
      return;
    }
    document.documentElement._gbDateMounted = true;
    state.dateRange = window.GbDateRange.read();
    window.GbDateRange.mount({
      host: '#date-range-host',
      onChange: function (s) {
        state.dateRange = s;
        renderDecay();
        renderReports();
        renderFiltersHelp();
      },
    });
  }

  async function loadJson(url, fallback) {
    try {
      var r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return r.json();
    } catch (e) {}
    return fallback;
  }
  async function loadHistory() {
    var dates = [];
    try {
      var m = await fetch('data/history/index.json', { cache: 'no-store' });
      if (m.ok) {
        var j = await m.json();
        dates = j.dates || [];
      }
    } catch (e) {}
    var out = [];
    for (var i = 0; i < dates.length; i++) {
      try {
        var r = await fetch('data/history/' + dates[i] + '.json', { cache: 'no-store' });
        if (r.ok) out.push(await r.json());
      } catch (e) {}
    }
    return out;
  }
  async function loadFixes() {
    try {
      var r = await fetch('/api/fixes', { cache: 'no-store' });
      if (r.ok) return r.json();
    } catch (e) {}
    return loadJson('data/fixes.json', { items: [] });
  }

  document.body.addEventListener('click', async function (ev) {
    var btn = ev.target.closest('[data-save-goal]');
    if (!btn) return;
    var id = btn.getAttribute('data-save-goal');
    var input = document.querySelector('input[data-goal="' + id + '"]');
    var target = input ? input.value : null;
    try {
      var res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, target: target }),
      });
      if (res.ok) {
        state.goals = await (await fetch('/api/goals')).json();
        renderGoals();
      } else alert('Goals API unavailable — set FIXES KV binding.');
    } catch (e) {
      alert('Could not save goal: ' + e.message);
    }
  });

  document.body.addEventListener('submit', async function (ev) {
    if (ev.target.id !== 'activity-form') return;
    ev.preventDefault();
    var fd = new FormData(ev.target);
    var note = (document.getElementById('activity-note') || {}).value || '';
    var payload = {
      who: fd.get('who'),
      activityType: fd.get('activityType'),
      url: fd.get('url') || null,
      note: note,
      date: new Date().toISOString(),
    };
    try {
      var res = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        state.activity = await (await fetch('/api/activity')).json();
        renderActivity();
        ev.target.reset();
        if (document.getElementById('activity-note'))
          document.getElementById('activity-note').value = '';
      } else {
        state.activity = state.activity || { entries: [] };
        payload.id = 'local-' + Date.now();
        state.activity.entries.unshift(payload);
        renderActivity();
      }
    } catch (e) {
      state.activity = state.activity || { entries: [] };
      payload.id = 'local-' + Date.now();
      state.activity.entries.unshift(payload);
      renderActivity();
    }
  });

  // sticky nav highlight
  document.querySelectorAll('.nav a').forEach(function (a) {
    a.addEventListener('click', function () {
      document.querySelectorAll('.nav a').forEach(function (x) {
        x.classList.remove('active');
      });
      a.classList.add('active');
    });
  });

  Promise.all([
    (window.GbLive && window.GbLive.base()
      ? window.GbLive.overview().catch(function () { return null; })
      : Promise.resolve(null)
    ).then(function (live) { return live || loadJson('data/latest.json', {}); }),
    loadJson('data/audit.json', null),
    loadJson('/api/goals', null).then(function (g) {
      return g || loadJson('data/goals.json', { targets: [] });
    }),
    loadJson('/api/activity', null).then(function (a) {
      return a || loadJson('data/activity.json', { entries: [] });
    }),
    loadFixes(),
    loadHistory(),
    loadJson('/api/engagements', null).then(function (e) {
      return (
        e ||
        loadJson('data/engagements.json', { engagements: [] }).then(function (s) {
          return {
            engagements: s.engagements || [],
            latest: (s.engagements || [])[0] || null,
            source: 'seed',
          };
        })
      );
    }),
  ]).then(function (pair) {
    state.live = pair[0];
    state.audit = pair[1];
    state.goals = pair[2];
    state.activity = pair[3];
    state.fixes = pair[4];
    state.history = pair[5];
    state.engagements = pair[6];
    var engN =
      (state.engagements &&
        state.engagements.engagements &&
        state.engagements.engagements.length) ||
      0;
    var pageN =
      (state.live.gscByPage && state.live.gscByPage.rows && state.live.gscByPage.rows.length) ||
      0;
    var kwN =
      (state.live.gscByQuery && state.live.gscByQuery.rows && state.live.gscByQuery.rows.length) ||
      0;
    document.getElementById('sync').textContent =
      'Live ' +
      (state.live.updatedAt ? new Date(state.live.updatedAt).toLocaleString() : '—') +
      ' · Pages ' +
      pageN +
      ' · Keywords ' +
      kwN +
      ' · History ' +
      state.history.length +
      ' · Engagements ' +
      engN;
    document.getElementById('pills').innerHTML =
      badge('live', 'GSC/GA4') +
      ' ' +
      badge(state.live.clarity && state.live.clarity.status === 'ok' ? 'live' : 'pending', 'Clarity') +
      ' ' +
      badge(engN ? 'live' : 'pending', 'Agents') +
      ' ' +
      badge('live', 'Platform');
    renderAll();
  });
})();
