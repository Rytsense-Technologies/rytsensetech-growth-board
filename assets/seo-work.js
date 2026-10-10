/*! SEO Work hub — 4 separate views: GSC Issues · Internal Links · Content Ideas · Topic Trends */
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

  function shortUrl(u) {
    try {
      var p = new URL(u);
      return p.pathname + (p.search || '');
    } catch (e) {
      return String(u || '');
    }
  }

  function badge(kind, label) {
    return '<span class="sw-badge ' + kind + '">' + esc(label) + '</span>';
  }

  function pill(label, value) {
    return (
      '<div class="sw-pill"><span class="k">' +
      esc(label) +
      '</span><span class="v mono">' +
      esc(String(value)) +
      '</span></div>'
    );
  }

  var state = {
    view: 'issues',
    issues: null,
    links: null,
    ideas: null,
    trends: null,
    issueCat: 'all',
    issueMarket: 'all',
    issueReview: 'reviewed',
    issueQ: '',
    linkMarket: 'all',
    ideaFilter: 'safe',
    ideaMarket: 'all',
  };

  var VIEWS = {
    issues: {
      title: 'GSC Issues',
      blurb: 'SEO-team audit sheet — URLs to fix by category (404, indexation, canonical, 403…).',
      accent: 'issues',
    },
    links: {
      title: 'Internal Links',
      blurb: 'Blog & page → money-page recommendations for US and Global.',
      accent: 'links',
    },
    ideas: {
      title: 'Content Ideas',
      blurb: 'New keywords & titles scored against existing URLs to avoid cannibalization.',
      accent: 'ideas',
    },
    trends: {
      title: 'Topic Trends',
      blurb: 'Rising / watch queries tagged to focused business objectives.',
      accent: 'trends',
    },
  };

  function setView(id) {
    if (!VIEWS[id]) id = 'issues';
    state.view = id;
    try {
      history.replaceState(null, '', '#' + id);
    } catch (e) {}
    document.querySelectorAll('.sw-nav a[data-view]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-view') === id);
    });
    var meta = VIEWS[id];
    var shell = document.getElementById('sw-shell');
    if (shell) {
      shell.setAttribute('data-view', id);
      shell.classList.remove('accent-issues', 'accent-links', 'accent-ideas', 'accent-trends');
      shell.classList.add('accent-' + meta.accent);
    }
    var h = document.getElementById('sw-title');
    var p = document.getElementById('sw-blurb');
    if (h) h.textContent = meta.title;
    if (p) p.textContent = meta.blurb;
    render();
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  function renderEmpty(msg) {
    return '<div class="sw-empty">' + esc(msg) + '</div>';
  }

  /* ─── View 1: GSC Issues ─── */
  function renderIssues() {
    var data = state.issues;
    if (!data) return renderEmpty('Loading GSC issues…');
    var cats = data.categories || [];
    var reviewedTotal = (data.issues || []).filter(function (i) {
      return i.agentReview && (i.agentReview.why || i.agentReview.fix);
    }).length;
    var issues = (data.issues || []).filter(function (i) {
      if (state.issueCat !== 'all' && i.category !== state.issueCat) return false;
      if (state.issueMarket !== 'all' && i.market !== state.issueMarket) return false;
      if (state.issueReview === 'reviewed' && !(i.agentReview && (i.agentReview.why || i.agentReview.fix)))
        return false;
      if (state.issueReview === 'pending' && i.agentReview && (i.agentReview.why || i.agentReview.fix))
        return false;
      if (state.issueQ) {
        var q = state.issueQ.toLowerCase();
        var ar = i.agentReview || {};
        var hay = (
          (i.url || '') +
          ' ' +
          (i.action || '') +
          ' ' +
          (i.note || '') +
          ' ' +
          (ar.why || '') +
          ' ' +
          (ar.fix || '')
        ).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    var catOpts =
      '<option value="all">All categories</option>' +
      cats
        .map(function (c) {
          return (
            '<option value="' +
            esc(c.id) +
            '"' +
            (state.issueCat === c.id ? ' selected' : '') +
            '>' +
            esc(c.label) +
            ' (' +
            c.count +
            ')</option>'
          );
        })
        .join('');

    var rows = issues
      .slice(0, 400)
      .map(function (i) {
        var ar = i.agentReview || null;
        var why = ar && ar.why ? ar.why : '';
        var fix = ar && ar.fix ? ar.fix : '';
        var details = [
          i.action ? 'SEO sheet: ' + i.action : '',
          why ? 'Why: ' + why : '',
          fix ? 'Fix: ' + fix : '',
          i.url ? 'URL: ' + i.url : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        return (
          '<tr>' +
          '<td>' +
          badge(i.priority === 'critical' ? 'bad' : 'warn', i.priority || '—') +
          ' ' +
          badge('mute', i.categoryLabel || i.category) +
          (ar
            ? ' ' + badge('good', 'agent')
            : ' ' + badge('mute', 'pending')) +
          '</td>' +
          '<td class="mono"><a href="' +
          esc(i.url) +
          '" target="_blank" rel="noopener">' +
          esc(shortUrl(i.url)) +
          '</a></td>' +
          '<td>' +
          '<div class="sw-sheet">' +
          esc(i.action || '—') +
          (i.note ? '<div class="sw-note">' + esc(i.note) + '</div>' : '') +
          '</div></td>' +
          '<td class="sw-agent-cell">' +
          (ar
            ? '<div class="sw-why"><strong>Why</strong> ' +
              esc(why) +
              '</div><div class="sw-fix"><strong>Fix</strong> ' +
              esc(fix) +
              '</div>' +
              (ar.ownerTeam || ar.effort
                ? '<div class="sw-note">' +
                  esc([ar.ownerTeam, ar.effort].filter(Boolean).join(' · ')) +
                  '</div>'
                : '')
            : '<span class="sw-note">Awaiting agent review</span>') +
          '</td>' +
          '<td>' +
          badge(i.market === 'us' ? 'us' : 'global', i.market) +
          '</td>' +
          '<td><button type="button" class="sw-btn secondary sw-task" data-id="' +
          esc(i.id) +
          '" data-title="' +
          esc((i.categoryLabel || 'GSC') + ': ' + shortUrl(i.url)) +
          '" data-details="' +
          esc(details) +
          '" data-url="' +
          esc(i.url) +
          '" data-team="' +
          esc((ar && ar.ownerTeam) || 'SEO') +
          '">Create task</button></td>' +
          '</tr>'
        );
      })
      .join('');

    return (
      '<div class="sw-stats">' +
      pill('Total', data.totals && data.totals.all) +
      pill('Agent reviewed', reviewedTotal) +
      pill('Pending review', (data.totals && data.totals.all ? data.totals.all : 0) - reviewedTotal) +
      pill('US', data.totals && data.totals.byMarket && data.totals.byMarket.us) +
      pill('Global', data.totals && data.totals.byMarket && data.totals.byMarket.global) +
      '</div>' +
      '<p class="sw-source">Source: <a href="' +
      esc(data.sourceSheet || '#') +
      '" target="_blank" rel="noopener">SEO team Google Sheet</a> · imported ' +
      esc((data.updatedAt || '').slice(0, 10)) +
      (data.lastAgentReviewAt
        ? ' · last agent review ' + esc(String(data.lastAgentReviewAt).slice(0, 10))
        : '') +
      ' · showing ' +
      issues.length +
      (issues.length > 400 ? ' (capped 400)' : '') +
      '. Default filter: <strong>Agent reviewed</strong>. Weekly Claude job continues pending batches (~40–60/week).</p>' +
      '<div class="sw-filters">' +
      '<select id="sw-issue-cat">' +
      catOpts +
      '</select>' +
      '<select id="sw-issue-market">' +
      '<option value="all"' +
      (state.issueMarket === 'all' ? ' selected' : '') +
      '>All markets</option>' +
      '<option value="us"' +
      (state.issueMarket === 'us' ? ' selected' : '') +
      '>US</option>' +
      '<option value="global"' +
      (state.issueMarket === 'global' ? ' selected' : '') +
      '>Global</option>' +
      '</select>' +
      '<select id="sw-issue-review">' +
      '<option value="pending"' +
      (state.issueReview === 'pending' ? ' selected' : '') +
      '>Pending agent</option>' +
      '<option value="reviewed"' +
      (state.issueReview === 'reviewed' ? ' selected' : '') +
      '>Agent reviewed</option>' +
      '<option value="all"' +
      (state.issueReview === 'all' ? ' selected' : '') +
      '>All review states</option>' +
      '</select>' +
      '<input id="sw-issue-q" type="search" placeholder="Search URL, fix, why…" value="' +
      esc(state.issueQ) +
      '">' +
      '</div>' +
      '<div class="sw-table-wrap"><table><thead><tr>' +
      '<th>Type</th><th>URL</th><th>SEO sheet action</th><th>Agent: Why &amp; Fix</th><th>Market</th><th></th>' +
      '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="6">No issues match filters.</td></tr>') +
      '</tbody></table></div>'
    );
  }

  /* ─── View 2: Internal Links ─── */
  function renderLinks() {
    var data = state.links;
    if (!data) return renderEmpty('Loading internal link recommendations…');
    var list = (data.recommendations || []).filter(function (r) {
      return state.linkMarket === 'all' || r.market === state.linkMarket;
    });
    var rows = list
      .map(function (r) {
        return (
          '<tr>' +
          '<td>' +
          badge(r.priority === 'high' ? 'warn' : 'mute', r.priority || '—') +
          ' ' +
          badge(r.market === 'us' ? 'us' : 'global', r.market) +
          '</td>' +
          '<td class="mono"><a href="' +
          esc(r.sourceUrl) +
          '" target="_blank" rel="noopener">' +
          esc(shortUrl(r.sourceUrl)) +
          '</a>' +
          '<div class="sw-note">imp ' +
          num(r.impressions) +
          ' · clk ' +
          num(r.clicks) +
          '</div></td>' +
          '<td class="mono"><a href="' +
          esc(r.targetUrl) +
          '" target="_blank" rel="noopener">' +
          esc(shortUrl(r.targetUrl)) +
          '</a>' +
          '<div class="sw-note">anchor: “' +
          esc(r.anchorSuggestion || '') +
          '”</div></td>' +
          '<td>' +
          esc(r.reason || '') +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    return (
      '<div class="sw-stats">' +
      pill('Recs', data.totals && data.totals.all) +
      pill('US', data.totals && data.totals.us) +
      pill('Global', data.totals && data.totals.global) +
      '</div>' +
      '<p class="sw-source">' +
      esc(data.note || '') +
      ' · updated ' +
      esc((data.updatedAt || '').slice(0, 10)) +
      '</p>' +
      '<div class="sw-filters">' +
      '<select id="sw-link-market">' +
      '<option value="all"' +
      (state.linkMarket === 'all' ? ' selected' : '') +
      '>All markets</option>' +
      '<option value="us"' +
      (state.linkMarket === 'us' ? ' selected' : '') +
      '>US only</option>' +
      '<option value="global"' +
      (state.linkMarket === 'global' ? ' selected' : '') +
      '>Global only</option>' +
      '</select>' +
      '</div>' +
      '<div class="sw-table-wrap"><table><thead><tr>' +
      '<th>Priority</th><th>From (blog / page)</th><th>To (money page)</th><th>Why</th>' +
      '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="4">No recommendations yet.</td></tr>') +
      '</tbody></table></div>'
    );
  }

  /* ─── View 3: Content Ideas ─── */
  function renderIdeas() {
    var data = state.ideas;
    if (!data) return renderEmpty('Loading content ideas…');
    var list = (data.ideas || []).filter(function (x) {
      if (state.ideaFilter !== 'all' && x.cannibalization !== state.ideaFilter) return false;
      if (state.ideaMarket !== 'all' && x.market !== state.ideaMarket) return false;
      return true;
    });
    var rows = list
      .map(function (x) {
        var ck =
          x.cannibalization === 'safe'
            ? 'good'
            : x.cannibalization === 'risk'
              ? 'warn'
              : 'bad';
        return (
          '<tr>' +
          '<td>' +
          badge(ck, x.cannibalization) +
          ' ' +
          badge(x.market === 'us' ? 'us' : 'global', x.market) +
          '</td>' +
          '<td><strong>' +
          esc(x.keyword) +
          '</strong><div class="sw-note">' +
          esc(x.reason || '') +
          '</div></td>' +
          '<td>' +
          esc(x.proposedTitle || '') +
          '<div class="mono sw-note">' +
          esc(x.proposedSlug || '') +
          '</div></td>' +
          '<td class="num mono">' +
          num(x.impressions) +
          '<div class="sw-note">pos ' +
          (x.position != null ? Number(x.position).toFixed(1) : '–') +
          '</div></td>' +
          '</tr>'
        );
      })
      .join('');

    return (
      '<div class="sw-stats">' +
      pill('Ideas', data.totals && data.totals.all) +
      pill('Safe', data.totals && data.totals.safe) +
      pill('Risk', data.totals && data.totals.risk) +
      pill('Blocked', data.totals && data.totals.blocked) +
      '</div>' +
      '<p class="sw-source">' +
      esc(data.note || '') +
      ' · Default filter shows <strong>safe</strong> only.</p>' +
      '<div class="sw-filters">' +
      '<select id="sw-idea-filter">' +
      '<option value="safe"' +
      (state.ideaFilter === 'safe' ? ' selected' : '') +
      '>Safe only</option>' +
      '<option value="risk"' +
      (state.ideaFilter === 'risk' ? ' selected' : '') +
      '>Risk</option>' +
      '<option value="blocked"' +
      (state.ideaFilter === 'blocked' ? ' selected' : '') +
      '>Blocked</option>' +
      '<option value="all"' +
      (state.ideaFilter === 'all' ? ' selected' : '') +
      '>All</option>' +
      '</select>' +
      '<select id="sw-idea-market">' +
      '<option value="all"' +
      (state.ideaMarket === 'all' ? ' selected' : '') +
      '>All markets</option>' +
      '<option value="us"' +
      (state.ideaMarket === 'us' ? ' selected' : '') +
      '>US</option>' +
      '<option value="global"' +
      (state.ideaMarket === 'global' ? ' selected' : '') +
      '>Global</option>' +
      '</select>' +
      '</div>' +
      '<div class="sw-table-wrap"><table><thead><tr>' +
      '<th>Cannibalization</th><th>Keyword</th><th>Proposed title / slug</th><th class="num">Demand</th>' +
      '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="4">No ideas in this filter.</td></tr>') +
      '</tbody></table></div>'
    );
  }

  /* ─── View 4: Topic Trends ─── */
  function renderTrends() {
    var data = state.trends;
    if (!data) return renderEmpty('Loading topic trends…');
    var cards = (data.trends || [])
      .map(function (t) {
        var topics = (t.topics || [])
          .map(function (q) {
            return (
              '<tr>' +
              '<td>' +
              esc(q.query) +
              '</td>' +
              '<td class="num mono">' +
              num(q.impressions) +
              '</td>' +
              '<td class="num mono">' +
              num(q.clicks) +
              '</td>' +
              '<td class="num mono">' +
              (q.position != null ? Number(q.position).toFixed(1) : '–') +
              '</td>' +
              '<td>' +
              badge(q.signal === 'watch' ? 'warn' : 'mute', q.signal || 'steady') +
              '</td>' +
              '</tr>'
            );
          })
          .join('');
        return (
          '<article class="sw-obj-card">' +
          '<header><h3>' +
          esc(t.label) +
          '</h3>' +
          '<div class="sw-obj-meta mono">' +
          num(t.impressions) +
          ' imp · ' +
          num(t.clicks) +
          ' clk · ' +
          num(t.queryCount) +
          ' queries</div></header>' +
          '<div class="sw-table-wrap compact"><table><thead><tr>' +
          '<th>Query</th><th class="num">Imp</th><th class="num">Clk</th><th class="num">Pos</th><th>Signal</th>' +
          '</tr></thead><tbody>' +
          (topics || '<tr><td colspan="5">No tagged queries yet.</td></tr>') +
          '</tbody></table></div></article>'
        );
      })
      .join('');

    var period = data.period
      ? (data.period.startDate || '') + ' → ' + (data.period.endDate || '')
      : '';

    return (
      '<div class="sw-stats">' +
      pill('Objectives', data.totals && data.totals.objectives) +
      pill('Tagged queries', data.totals && data.totals.taggedQueries) +
      '</div>' +
      '<p class="sw-source">' +
      esc(data.grainNote || '') +
      (period ? ' · GSC window ' + esc(period) : '') +
      '</p>' +
      '<div class="sw-obj-grid">' +
      cards +
      '</div>'
    );
  }

  function render() {
    var host = document.getElementById('sw-view');
    if (!host) return;
    var html =
      state.view === 'links'
        ? renderLinks()
        : state.view === 'ideas'
          ? renderIdeas()
          : state.view === 'trends'
            ? renderTrends()
            : renderIssues();
    host.innerHTML = html;
    bindFilters();
  }

  function bindFilters() {
    var cat = document.getElementById('sw-issue-cat');
    if (cat)
      cat.onchange = function () {
        state.issueCat = cat.value;
        render();
      };
    var m = document.getElementById('sw-issue-market');
    if (m)
      m.onchange = function () {
        state.issueMarket = m.value;
        render();
      };
    var rev = document.getElementById('sw-issue-review');
    if (rev)
      rev.onchange = function () {
        state.issueReview = rev.value;
        render();
      };
    var q = document.getElementById('sw-issue-q');
    if (q) {
      q.oninput = function () {
        state.issueQ = q.value;
        clearTimeout(state._qTimer);
        state._qTimer = setTimeout(function () {
          state.issueQ = q.value.trim();
          var pos = q.selectionStart;
          render();
          var q2 = document.getElementById('sw-issue-q');
          if (q2) {
            q2.focus();
            try {
              q2.setSelectionRange(pos, pos);
            } catch (e) {}
          }
        }, 200);
      };
    }
    var lm = document.getElementById('sw-link-market');
    if (lm)
      lm.onchange = function () {
        state.linkMarket = lm.value;
        render();
      };
    var iflt = document.getElementById('sw-idea-filter');
    if (iflt)
      iflt.onchange = function () {
        state.ideaFilter = iflt.value;
        render();
      };
    var im = document.getElementById('sw-idea-market');
    if (im)
      im.onchange = function () {
        state.ideaMarket = im.value;
        render();
      };

    document.querySelectorAll('.sw-task').forEach(function (btn) {
      btn.onclick = function () {
        createTask(btn);
      };
    });
  }

  function createTask(btn) {
    var title = btn.getAttribute('data-title') || 'GSC issue';
    var details = btn.getAttribute('data-details') || '';
    var url = btn.getAttribute('data-url') || '';
    var team = btn.getAttribute('data-team') || 'SEO';
    btn.disabled = true;
    btn.textContent = '…';
    var req = (window.GbLive && window.GbLive.base())
      ? window.GbLive.request('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title,
            details: details,
            team: team,
            priority: 'high',
          }),
        })
      : fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title,
        details: details,
        location: url,
        team: team,
        owner: team,
        assignee: null,
        priority: 'high',
        status: 'todo',
        doneBy: 'gsc-issues-ui',
      }),
    });
    req
      .then(function (r) {
        if (!r.ok) throw new Error('task ' + r.status);
        btn.textContent = 'Created';
        btn.classList.add('done');
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Retry';
        alert('Could not create task. Is /api/tasks available on this deploy?');
      });
  }

  function boot() {
    document.querySelectorAll('.sw-nav a[data-view]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        setView(a.getAttribute('data-view'));
      });
    });

    var hash = (location.hash || '#issues').replace(/^#/, '');
    setView(hash);

    var issuePromise = (window.GbLive && window.GbLive.base())
      ? window.GbLive.issues().catch(function () { return null; })
      : Promise.resolve(null);
    Promise.all([
      issuePromise.then(function (live) {
        if (live && live.issues) {
          state.issues = live;
          return;
        }
        return fetchJson('data/gsc-issues.json').then(function (d) {
          state.issues = d;
        });
      }),
      fetchJson('data/internal-links.json').then(function (d) {
        state.links = d;
      }),
      fetchJson('data/content-ideas.json').then(function (d) {
        state.ideas = d;
      }),
      fetchJson('data/topic-trends.json').then(function (d) {
        state.trends = d;
      }),
    ])
      .then(function () {
        render();
        var sync = document.getElementById('sw-sync');
        if (sync && state.issues) {
          sync.textContent =
            (state.issues.totals && state.issues.totals.all) +
            ' GSC issues · ' +
            ((state.links && state.links.totals && state.links.totals.all) || 0) +
            ' link recs · updated ' +
            String(state.issues.updatedAt || '').slice(0, 10);
        }
      })
      .catch(function (err) {
        var host = document.getElementById('sw-view');
        if (host) host.innerHTML = renderEmpty('Failed to load SEO Work data: ' + err.message);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
