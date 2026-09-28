/* Growth Board — shared formatters and data-provenance helpers.
 *
 * WHY THIS FILE EXISTS (duplication)
 *   esc() / num() / pct() were redefined in all five pages and had already
 *   drifted: report.html took an optional decimals argument while index,
 *   platform and ops were hardcoded to 1 decimal place. The same number
 *   rendered differently depending on which page you opened. One definition.
 *
 * WHY THE PROVENANCE HELPERS EXIST (the 2026-09-27 incident)
 *   The Cloudflare Analytics API was never called that run. The refresh wrote
 *   analytics zeros and left cloudflare.status = "ok". index.html gated only on
 *   status, so the board printed "Requests 0 · Unique visitors 0 · Threats 0 ·
 *   Cache 0.0%" under a green dot, and cloudflare.note — the one string that
 *   said the numbers were not measurements — was read only on the failure
 *   branch, so it never rendered. Four people make daily decisions from this
 *   board and it could not tell them the difference between a measured number,
 *   a stale number, and one that was never retrieved.
 *
 *   Rule enforced here: a value that was not retrieved renders as NOT_MEASURED,
 *   never as 0. 0 is reserved for a zero that was actually measured.
 *
 * No build step, no framework, no dependencies. ES5. Exposes window.GB.
 */
window.GB = (function () {
  'use strict';

  var fmt = new Intl.NumberFormat('en-US');

  /* The glyph for "we did not retrieve this". Distinct from a measured 0. */
  var NOT_MEASURED = '–';

  /* Search Console does not finalise data for the last 2-3 days. A window whose
     end date sits inside this many days of the sync is missing part of its tail
     and must not be compared against a fully-settled window. */
  var GSC_LAG_DAYS = 3;

  /* The daily refresh runs at 02:30 UTC. Past this the data is a day behind. */
  var STALE_HOURS = 30;

  /* ---------------------------------------------------------------- escaping */

  /* Every interpolated value goes through this. Do not regress it. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------- number fmt */

  /* null / undefined / '' / NaN => NOT_MEASURED. 0 => "0" (a measured zero).
     Callers MUST pass null for a figure they did not retrieve. */
  function num(n) {
    if (n === undefined || n === null || n === '' || isNaN(n)) return NOT_MEASURED;
    return fmt.format(Math.round(+n));
  }

  function pct(n, d) {
    if (n === undefined || n === null || n === '' || isNaN(n)) return NOT_MEASURED;
    return (+n).toFixed(d == null ? 1 : d) + '%';
  }

  /* Average position: one decimal, everywhere. */
  function pos(n) {
    if (n === undefined || n === null || n === '' || isNaN(n)) return NOT_MEASURED;
    return Number(n).toFixed(1);
  }

  /* Collapse a value to null unless it was actually measured. Use this at the
     call site so num()/pct() can keep treating 0 as a real zero. */
  function measured(value, wasMeasured) {
    return wasMeasured ? value : null;
  }

  /* ---------------------------------------------------------------- dates */

  function fmtDate(iso) {
    if (!iso) return NOT_MEASURED;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return NOT_MEASURED;
    return d.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      timeZone: 'Asia/Kolkata'
    }) + ' IST';
  }

  /* "2026-09-26" -> "Sep 26" */
  function shortDay(ymd) {
    if (!ymd) return NOT_MEASURED;
    var s = String(ymd);
    var d = /^\d{4}-\d{2}-\d{2}$/.test(s)
      ? new Date(s + 'T00:00:00Z')
      : new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function relativeTime(iso) {
    if (!iso) return NOT_MEASURED;
    var ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return NOT_MEASURED;
    var sec = Math.round(ms / 1000);
    if (sec < 45) return 'just now';
    var min = Math.round(sec / 60);
    if (min < 60) return min + 'm ago';
    var hr = Math.round(min / 60);
    if (hr < 48) return hr + 'h ago';
    var day = Math.round(hr / 24);
    if (day < 30) return day + 'd ago';
    var mo = Math.round(day / 30);
    if (mo < 12) return mo + 'mo ago';
    return Math.round(mo / 12) + 'y ago';
  }

  function dayMs(v) {
    if (!v) return NaN;
    var s = String(v);
    var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z') : new Date(s);
    return d.getTime();
  }

  function daysBetween(a, b) {
    var x = dayMs(a), y = dayMs(b);
    if (isNaN(x) || isNaN(y)) return null;
    return Math.round((y - x) / 86400000);
  }

  /* ---------------------------------------------------------- date ranges */

  /* gsc.period is in the data and was rendered in zero HTML files. Every GSC
     and GA4 figure on this board must carry the window it covers. */
  function periodLabel(period) {
    if (!period || !period.startDate || !period.endDate) return null;
    return shortDay(period.startDate) + ' – ' + shortDay(period.endDate);
  }

  function asOf(period) {
    if (!period || !period.endDate) return null;
    return 'through ' + shortDay(period.endDate);
  }

  /* Inclusive day count of a period, or null. */
  function periodDays(period) {
    if (!period || !period.startDate || !period.endDate) return null;
    var n = daysBetween(period.startDate, period.endDate);
    return n == null ? null : n + 1;
  }

  /* True when the window's tail falls inside the GSC reporting lag, i.e. the
     last 2-3 days are incomplete. Comparing such a window against a settled one
     manufactures a decline: that is where the -18.97% headline came from. */
  function isProvisional(period, referenceIso) {
    if (!period || !period.endDate) return false;
    var ref = referenceIso ? dayMs(referenceIso) : Date.now();
    if (isNaN(ref)) return false;
    var gap = Math.round((ref - dayMs(period.endDate)) / 86400000);
    if (isNaN(gap)) return false;
    return gap < GSC_LAG_DAYS;
  }

  /* One sentence explaining the caveat, or null when the window is settled. */
  function provisionalNote(period, referenceIso) {
    if (!isProvisional(period, referenceIso)) return null;
    return 'The last ' + GSC_LAG_DAYS + ' days of this window are still ' +
      'provisional — Search Console finalises data 2-3 days late, so the ' +
      'current period is structurally understated against a settled prior one.';
  }

  /* Two windows are comparable only if they are equal-length and disjoint. */
  function windowsOverlapDays(a, b) {
    if (!a || !b || !a.startDate || !a.endDate || !b.startDate || !b.endDate) return null;
    var s = Math.max(dayMs(a.startDate), dayMs(b.startDate));
    var e = Math.min(dayMs(a.endDate), dayMs(b.endDate));
    if (isNaN(s) || isNaN(e)) return null;
    if (e < s) return 0;
    return Math.round((e - s) / 86400000) + 1;
  }

  /* ------------------------------------------------------- source status */

  /* Four states a reader can act on. 'not-connected' is NOT a zero: it means
     nobody ever wired the source up (CRM, Ahrefs). */
  var STATE = {
    OK: 'ok',
    STALE: 'stale',
    FAILED: 'failed',
    NONE: 'not-connected'
  };

  var STATE_LABEL = {
    'ok': 'connected',
    'stale': 'stale',
    'failed': 'failed',
    'not-connected': 'not connected'
  };

  /* Derive a source's real state. `hasPayload` is the caller's check that the
     fields it actually renders are present — key presence alone is not health.
     A three-week-old latest.json used to turn the chip green. */
  function sectionState(section, hasPayload, updatedAt) {
    if (section == null) return STATE.NONE;
    var status = section.status;
    if (status === 'not_connected' || status === 'not-connected') return STATE.NONE;
    if (status != null && status !== 'ok') return STATE.FAILED;
    if (hasPayload === false) return STATE.FAILED;
    if (isStale(updatedAt)) return STATE.STALE;
    return STATE.OK;
  }

  function isStale(updatedAt) {
    if (!updatedAt) return false;
    var t = new Date(updatedAt).getTime();
    if (isNaN(t)) return false;
    return (Date.now() - t) / 36e5 > STALE_HOURS;
  }

  /* ------------------------------------------------------------- samples */

  /* gscByPage / gscByQuery / ga4ByPage publish 30 rows of 500+ with a note that
     no page rendered, and report.html counted "Content URLs w/ impressions"
     over those 30 rows and showed it as a corpus total — wrong by roughly an
     order of magnitude, under a "Verified" pill.
     Never compute a site-wide total from a truncated sample. */
  function sampleInfo(section) {
    var rows = (section && section.rows) || [];
    var info = {
      sampled: false,
      n: rows.length,
      total: null,
      note: (section && section.note) || null
    };
    if (!section) return info;

    /* Explicit fields win — the data side is adding truncated/rowsAvailable. */
    if (section.truncated === true) info.sampled = true;
    if (typeof section.rowsReturned === 'number') info.n = section.rowsReturned;
    if (typeof section.rowsAvailable === 'number') {
      info.total = section.rowsAvailable;
      if (info.total > info.n) info.sampled = true;
    }

    /* Fallback while those fields do not exist yet: a rows-bearing section that
       ships a note is a section someone had to explain. Treat it as a sample. */
    if (!info.sampled && info.note) {
      info.sampled = true;
      if (info.total == null) {
        var m = /\bof\s+([\d,]+)\s+rows\b/i.exec(info.note);
        if (m) info.total = +m[1].replace(/,/g, '');
      }
    }
    return info;
  }

  /* "sample · 30 of 500 rows" — the honest header for a truncated table. */
  function sampleLabel(info) {
    if (!info || !info.sampled) return null;
    return 'sample · ' + num(info.n) + ' of ' +
      (info.total == null ? 'an unknown number of' : num(info.total)) + ' rows';
  }

  /* ------------------------------------------------------------ fetching */

  /* Throws with a message a reader can act on. index/ops/report used to pipe a
     404 HTML error page straight into r.json(). */
  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' returned HTTP ' + r.status);
      return r.json().catch(function () {
        throw new Error(url + ' did not return valid JSON');
      });
    });
  }

  /* Never throws. Use only where a missing optional source is genuinely fine —
     and render the fallback as "not measured", not as zeros. */
  function loadJson(url, fallback) {
    return fetchJson(url).catch(function () { return fallback; });
  }

  return {
    NOT_MEASURED: NOT_MEASURED,
    GSC_LAG_DAYS: GSC_LAG_DAYS,
    STALE_HOURS: STALE_HOURS,
    STATE: STATE,
    STATE_LABEL: STATE_LABEL,
    esc: esc,
    num: num,
    pct: pct,
    pos: pos,
    measured: measured,
    fmtDate: fmtDate,
    shortDay: shortDay,
    relativeTime: relativeTime,
    daysBetween: daysBetween,
    periodLabel: periodLabel,
    asOf: asOf,
    periodDays: periodDays,
    isProvisional: isProvisional,
    provisionalNote: provisionalNote,
    windowsOverlapDays: windowsOverlapDays,
    sectionState: sectionState,
    isStale: isStale,
    sampleInfo: sampleInfo,
    sampleLabel: sampleLabel,
    fetchJson: fetchJson,
    loadJson: loadJson
  };
})();
