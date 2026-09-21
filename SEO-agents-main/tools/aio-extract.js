/**
 * aio-extract.js — read a Google AI Overview from a rendered SERP.
 *
 * Paste-and-run inside the browser pane (`javascript_tool`) after loading a
 * Google results page. Returns the AI Overview text and, importantly, the
 * publishers it cites.
 *
 * WHY THIS EXISTS
 * Serper does not return AI Overviews. SerpApi and DataForSEO do, but cost
 * money. This reads what a human sees, for free, and is the fallback when no
 * AI-Overview-capable API is configured.
 *
 * HOW IT FINDS THE CITATIONS
 * Google obfuscates AI Overview citation hrefs as `/goto?url=CAES…` redirects,
 * so the destination cannot be read from the link. The publisher names survive
 * in `aria-label`, in the form:
 *     "<Page title> - <Publisher>. Opens in new tab."
 * That attribute is the reliable extraction point. Verified against a live
 * SERP on 2026-09-17.
 *
 * LIMITS — read before relying on this
 * - Automated querying of Google Search is against Google's Terms of Service.
 *   This is built for low-volume assisted verification (a few dozen tracked
 *   queries), not bulk collection. For bulk, pay for an API.
 * - Rate-limit yourself. Several seconds between queries, and stop for the day
 *   if results degrade.
 * - If a CAPTCHA or "unusual traffic" page appears, STOP. Do not attempt to
 *   solve or evade it. Switch to an API provider instead.
 * - Google's markup changes without notice. If `found` comes back false on a
 *   SERP that visibly has an AI Overview, the selectors need updating — say so
 *   rather than recording "no AI Overview".
 * - AI Overviews are personalized and volatile. One reading is a snapshot, not
 *   a fact. Date every observation.
 */

(() => {
  const CAPTCHA_SIGNS = /unusual traffic|are you a robot|recaptcha|sorry\/index/i;
  if (CAPTCHA_SIGNS.test(document.body.innerText.slice(0, 2000)) ||
      /\/sorry\//.test(location.pathname)) {
    return { blocked: true, note: 'Bot check detected. STOP — do not attempt to solve it. Switch to a SERP API provider.' };
  }

  const query = new URLSearchParams(location.search).get('q');

  // The label element is the anchor point; walk up to the block that holds it.
  const label = [...document.querySelectorAll('div,span,h1,h2')]
    .find(e => e.textContent.trim() === 'AI Overview' && e.children.length === 0);

  if (!label) {
    return {
      query,
      found: false,
      checked: true,
      note: 'No AI Overview on this SERP. Confirm visually before recording — absence and a markup change look identical from here.',
      at: new Date().toISOString(),
    };
  }

  let box = label;
  for (let i = 0; i < 12 && box.parentElement; i++) {
    box = box.parentElement;
    if (box.innerText && box.innerText.length > 300) break;
  }

  // Publisher names live in aria-label: "<Title> - <Publisher>. Opens in new tab."
  // Not every label carries a publisher though — some are title-only, and
  // splitting those yields a sentence masquerading as a brand. A publisher is
  // short, has few words, and does not read like a headline.
  const looksLikePublisher = s =>
    s.length > 1 && s.length <= 40 &&
    s.split(/\s+/).length <= 5 &&
    !/[?!]$/.test(s) &&
    !/^(what|how|why|when|the best|top \d)/i.test(s);

  const cites = [];
  for (const a of box.querySelectorAll('a[aria-label]')) {
    const raw = a.getAttribute('aria-label') || '';
    if (!/opens in new tab/i.test(raw)) continue;
    const clean = raw.replace(/\.\s*Opens in new tab\.?\s*$/i, '').trim();
    const sep = Math.max(clean.lastIndexOf(' - '), clean.lastIndexOf(' | '));
    if (sep === -1) { cites.push({ publisher: null, title: clean }); continue; }
    const tail = clean.slice(sep + 3).trim();
    if (looksLikePublisher(tail)) cites.push({ publisher: tail, title: clean.slice(0, sep).trim() });
    else cites.push({ publisher: null, title: clean });   // title-only label
  }

  // Grouped chips ("Salesforce (+1)") show which publishers cluster on a claim.
  const chips = [...box.querySelectorAll('a[aria-label*="Related results"]')]
    .map(a => {
      const m = (a.getAttribute('aria-label') || '').match(/^(.+?)\s*\(\+(\d+)\)/);
      return m ? { publisher: m[1].trim(), alsoCited: Number(m[2]) } : null;
    })
    .filter(Boolean);

  const publishers = [...new Set(cites.map(c => c.publisher).filter(Boolean))];

  // Text, minus the "AI Overview" label and the Show more affordance.
  const text = box.innerText
    .replace(/^AI Overview\s*/i, '')
    .replace(/\s*Show more\s*$/i, '')
    .trim();

  return {
    query,
    found: true,
    checked: true,
    at: new Date().toISOString(),
    expanded: !box.innerText.includes('Show more'),
    text,
    textLength: text.length,
    publishers,
    publisherCount: publishers.length,
    citations: cites,
    groupedChips: chips,
    note: box.innerText.includes('Show more')
      ? 'COLLAPSED — click "Show more" and re-run to capture all citations. The collapsed view under-reports sources.'
      : null,
  };
})()
