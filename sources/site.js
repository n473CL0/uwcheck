// Source: UW CSE course website (the "assignments.html" template), public pages only.
'use strict';

const { SEATTLE, FETCH_TIMEOUT_MS, zoned, kindOf, codeKey, fetchEach } = require('./common');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function parseCourseSite(html, pageUrl, course) {
  const q = pageUrl.match(/\/(\d{2})(wi|sp|su|au)\b/);
  const year = q ? 2000 + Number(q[1]) : new Date().getFullYear();
  const items = [];
  // The raw page omits </td> after the date, so match loosely up to </tr>.
  const rowRe = /<tr>\s*<td>\s*\w{3},\s*(\w{3})\s+(\d{1,2})\s*(?:<\/td>)?\s*<td>([\s\S]*?)<\/tr>/g;
  for (const row of html.matchAll(rowRe)) {
    const month = MONTHS[row[1].toLowerCase()];
    const day = Number(row[2]);
    if (!month) continue;
    for (const a of row[3].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const attrs = a[1];
      const title = decodeEntities(a[2].replace(/<[^>]+>/g, '')).replace(/\s+Due\s*$/i, '').trim();
      const href = (attrs.match(/href="([^"]*)"/) || [])[1] || '';
      if (/canvas\.uw\.edu/.test(href)) continue; // Canvas feed covers these
      const kind = kindOf(title);
      // Readings/lectures are due 11am Seattle; everything else 11:59pm.
      const [h, mi] = kind === 'Reading' || kind === 'Lecture' ? [11, 0] : [23, 59];
      items.push({
        id: `site:${course}:${codeKey(title) || title}`,
        source: 'site',
        course,
        title,
        kind,
        due: zoned(year, month, day, h, mi, SEATTLE).toISOString(),
        url: href ? new URL(decodeEntities(href), pageUrl).href : pageUrl,
        tentative: /\bdisabled\b/.test(attrs) || !href,
      });
    }
  }
  return items;
}

// For a site listed without a name: ".../courses/cse351/26au/assignments.html" -> "CSE 351".
function courseFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const m = pathname.match(/\/([a-z]{2,6})(\d{3})[a-z]?\//i);
    return m ? `${m[1].toUpperCase()} ${m[2]}` : hostname;
  } catch {
    return url;
  }
}

async function fetchSites(config, prev) {
  if (!config.courseSites.length) return null;
  // A name that's just the URL is how older versions saved a site listed without one.
  const sites = config.courseSites.map(({ url, course }) => ({ url, course: course && course !== url ? course : courseFromUrl(url) }));
  return fetchEach(prev, sites, async ({ url, course }) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const found = parseCourseSite(await res.text(), url, course);
    if (!found.length) throw new Error(`No deadlines found on ${url}`);
    return found;
  });
}

module.exports = {
  name: 'site',
  label: 'Course site',
  config: { courseSites: [] }, // [{ url, course }]
  secrets: [],
  fetch: fetchSites,
  parseCourseSite,
  courseFromUrl,
};
