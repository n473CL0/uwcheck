#!/usr/bin/env node
// UWCheck: merges Canvas, Ed and course-website deadlines.
// Zero dependencies: run `npx uwcheck` or `node server.js` (Node 18+), then open http://localhost:7351
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const pkg = require('./package.json');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(argValue('--port') || process.env.PORT) || 7351;
const ROOT = __dirname;
// Lives outside the install folder so npm updates never wipe your token and ticks.
const DATA_DIR = process.env.UWCHECK_DATA || path.join(os.homedir(), '.uwcheck');
const SEATTLE = 'America/Los_Angeles';

const FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  state: path.join(DATA_DIR, 'state.json'),
  cache: path.join(DATA_DIR, 'cache.json'),
};

// Earlier versions kept data in ./data next to the code; carry it over once.
const LEGACY_DATA_DIR = path.join(ROOT, 'data');
if (!fs.existsSync(DATA_DIR) && fs.existsSync(LEGACY_DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of Object.values(FILES)) {
    const old = path.join(LEGACY_DATA_DIR, path.basename(file));
    if (fs.existsSync(old)) fs.copyFileSync(old, file);
  }
}

const DEFAULT_CONFIG = {
  canvasIcsUrl: '',
  edToken: '',
  edRegion: 'us',
  edCourses: [], // empty = every active course on your Ed account
  courseSites: [], // optional UW CSE "assignments.html" pages: { url, course }
  canvasCourses: {}, // optional rename: { canvasCourseId: 'Short name' }
  autoSyncMinutes: 30,
};

const DEFAULT_STATE = { done: {}, colors: {}, custom: [] };

// ---------- storage ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let config = { ...DEFAULT_CONFIG, ...readJson(FILES.config, {}) };
let state = { ...DEFAULT_STATE, ...readJson(FILES.state, {}) };
// cache = last good result per source, so the dashboard still works offline.
let cache = readJson(FILES.cache, { sources: {} });

// ---------- time helpers ----------

function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

// Wall-clock time in a named zone -> Date.
function zoned(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let ts = wall - tzOffsetMs(wall, tz);
  ts = wall - tzOffsetMs(ts, tz);
  return new Date(ts);
}

// All-day items are pinned to noon UTC so they land on the same date in every US zone.
function allDayIso(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d, 12)).toISOString();
}

// ---------- classification ----------

function kindOf(title, fallback = 'Assignment') {
  const t = title.trim();
  if (/^RD\s*\d/i.test(t) || /reading/i.test(t)) return 'Reading';
  if (/^LC\s*\d/i.test(t) || /lecture/i.test(t)) return 'Lecture';
  if (/^(LB|Lab)\s*\d/i.test(t) || /\blab\b/i.test(t)) return 'Lab';
  if (/^HW\s*\d/i.test(t) || /homework|problem set|pset/i.test(t)) return 'Homework';
  if (/quiz/i.test(t)) return 'Quiz';
  if (/midterm|final exam|\bexam\b/i.test(t)) return 'Exam';
  if (/survey|feedback/i.test(t)) return 'Survey';
  return fallback;
}

// "HW04: …", "HW4 Due", "LB1a", "Lab1a" -> "HW4" / "LAB1a"; used to dedupe Ed vs the course site.
function codeKey(title) {
  const m = title.match(/^(RD|LC|HW|LB|Lab|SC)\s*(\d+)([a-z]?)\b/i);
  if (!m) return '';
  let prefix = m[1].toUpperCase();
  if (prefix === 'LB') prefix = 'LAB';
  return prefix + parseInt(m[2], 10) + m[3].toLowerCase();
}

function courseFromCode(raw) {
  const m = raw.match(/\b([A-Z]{1,6}(?:[ /][A-Z]{1,6})*)\s?(\d{3})\b/);
  if (!m) return raw.trim();
  const dept = m[1].replace(/^([A-Z]) ([A-Z])$/, '$1$2').replace(/^MATH\/STAT$/, 'MATH');
  return `${dept} ${m[2]}`;
}

// ---------- source: Canvas calendar feed (.ics) ----------

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(';');
      cur[name.toUpperCase()] = {
        value: line.slice(i + 1),
        params: Object.fromEntries(params.map((p) => {
          const [k, v = ''] = p.split('=');
          return [k.toUpperCase(), v.replace(/^"|"$/g, '')];
        })),
      };
    }
  }
  return events;
}

function icsText(v) {
  return (v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function icsDate(prop) {
  if (!prop) return null;
  const v = prop.value;
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return { due: allDayIso(+m[1], +m[2], +m[3]), allDay: true };
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (m[7]) return { due: new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString() };
  return { due: zoned(y, mo, d, h, mi, prop.params.TZID || SEATTLE).toISOString() };
}

async function fetchCanvas() {
  const url = config.canvasIcsUrl.trim();
  if (!url) return null;
  const res = await fetch(url, { headers: { Accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`Canvas feed returned HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That URL is not a calendar feed');
  const canvasOrigin = new URL(url).origin;
  const items = [];
  for (const ev of parseIcs(text)) {
    const when = icsDate(ev.DTSTART);
    if (!when) continue;
    const uid = (ev.UID?.value || '').replace(/^event-/, '');
    const rawSummary = icsText(ev.SUMMARY?.value);
    const bracket = rawSummary.match(/\s*\[([^\]]+)\]\s*$/);
    const title = bracket ? rawSummary.slice(0, bracket.index) : rawSummary;
    const link = ev.URL?.value || '';
    const courseId = (link.match(/course_(\d+)/) || link.match(/courses\/(\d+)/) || [])[1];
    const course = config.canvasCourses[courseId] || (bracket ? courseFromCode(bracket[1]) : 'Canvas');
    const isAssignment = /assignment/.test(uid);
    let url2 = link;
    const a = uid.match(/assignment-(\d+)$/);
    if (a && courseId) url2 = `${canvasOrigin}/courses/${courseId}/assignments/${a[1]}`;
    items.push({
      id: 'canvas:' + uid,
      source: 'canvas',
      course,
      title,
      kind: isAssignment ? kindOf(title) : 'Event',
      ...when,
      url: url2,
    });
  }
  return items;
}

// ---------- source: Ed lessons API ----------

// With no courses configured, use every active course on the account ("CSE 351 - 26au" -> "CSE 351").
async function edCourseList(region, headers) {
  if (config.edCourses.length) return config.edCourses;
  const res = await fetch(`https://${region}.edstem.org/api/user`, { headers });
  if (res.status === 401 || res.status === 403) throw new Error('Ed rejected the API token');
  if (!res.ok) throw new Error(`Ed returned HTTP ${res.status}`);
  const body = await res.json();
  return (body.courses || [])
    .filter((c) => c.course?.status === 'active')
    .map((c) => ({ id: c.course.id, course: courseFromCode(c.course.code || c.course.name || String(c.course.id)) }));
}

async function fetchEd() {
  const token = config.edToken.trim();
  if (!token) return null;
  const region = config.edRegion || 'us';
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const items = [];
  for (const { id: courseId, course } of await edCourseList(region, headers)) {
    const res = await fetch(`https://${region}.edstem.org/api/courses/${courseId}/lessons`, { headers });
    if (res.status === 401 || res.status === 403) throw new Error('Ed rejected the API token');
    if (!res.ok) throw new Error(`Ed course ${courseId} returned HTTP ${res.status}`);
    const body = await res.json();
    const modules = Object.fromEntries((body.modules || []).map((m) => [m.id, m.name || '']));
    for (const l of body.lessons || []) {
      if (!l.due_at) continue;
      const status = String(l.status || l.attempt_status || '').toLowerCase();
      const mod = modules[l.module_id] || '';
      const fallback = /lab/i.test(mod) ? 'Lab' : /read/i.test(mod) ? 'Reading'
        : /lecture/i.test(mod) ? 'Lecture' : /homework/i.test(mod) ? 'Homework' : 'Assignment';
      items.push({
        id: `ed:${l.id}`,
        source: 'ed',
        course,
        title: l.title,
        kind: kindOf(l.title, fallback),
        due: new Date(l.due_at).toISOString(),
        url: `https://edstem.org/${region}/courses/${courseId}/lessons/${l.id}`,
        completed: status === 'completed',
      });
    }
  }
  return items;
}

// ---------- source: UW CSE course website (assignments.html template) ----------

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

async function fetchSites() {
  if (!config.courseSites.length) return null;
  const items = [];
  for (const { url, course } of config.courseSites) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const found = parseCourseSite(await res.text(), url, course);
    if (!found.length) throw new Error(`No deadlines found on ${url}`);
    items.push(...found);
  }
  return items;
}

// ---------- sync + merge ----------

const SOURCES = { canvas: fetchCanvas, ed: fetchEd, site: fetchSites };
let syncing = null;

async function syncAll() {
  if (syncing) return syncing;
  syncing = (async () => {
    cache.sources ||= {};
    await Promise.all(Object.entries(SOURCES).map(async ([name, fn]) => {
      const prev = cache.sources[name] || { items: [] };
      try {
        const items = await fn();
        if (items === null) {
          cache.sources[name] = { ...prev, status: 'not-configured', error: null };
        } else {
          cache.sources[name] = { items, status: 'ok', error: null, syncedAt: new Date().toISOString() };
        }
      } catch (err) {
        cache.sources[name] = { ...prev, status: 'error', error: err.message };
      }
    }));
    cache.lastSync = new Date().toISOString();
    writeJson(FILES.cache, cache);
  })();
  try {
    await syncing;
  } finally {
    syncing = null;
  }
}

function mergedItems() {
  const src = cache.sources || {};
  const ed = src.ed?.items || [];
  const edKeys = new Set(ed.map((i) => `${i.course}|${codeKey(i.title)}`));
  const site = (src.site?.items || []).filter((i) => {
    const k = codeKey(i.title);
    return !k || !edKeys.has(`${i.course}|${k}`);
  });
  return [...(src.canvas?.items || []), ...ed, ...site, ...state.custom];
}

function publicPayload() {
  const sources = {};
  for (const [name, s] of Object.entries(cache.sources || {})) {
    sources[name] = { status: s.status, error: s.error, syncedAt: s.syncedAt, count: s.items?.length || 0 };
  }
  return {
    items: mergedItems(),
    state,
    sources,
    lastSync: cache.lastSync || null,
    config: publicConfig(),
  };
}

function publicConfig() {
  const { edToken, ...rest } = config;
  return { ...rest, hasEdToken: Boolean(edToken) };
}

// ---------- HTTP ----------

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function applyStateAction(a) {
  switch (a.type) {
    case 'done':
      if (a.value === null) delete state.done[a.id];
      else state.done[a.id] = Boolean(a.value);
      break;
    case 'doneMany':
      for (const id of a.ids || []) state.done[id] = Boolean(a.value);
      break;
    case 'color':
      state.colors[a.course] = String(a.color);
      break;
    case 'addCustom': {
      const it = a.item || {};
      if (!it.title || !it.due) throw new Error('Title and date are required');
      state.custom.push({
        id: `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        source: 'custom',
        course: String(it.course || 'Personal').trim() || 'Personal',
        title: String(it.title).trim(),
        kind: String(it.kind || 'Task'),
        due: new Date(it.due).toISOString(),
        allDay: Boolean(it.allDay),
        url: String(it.url || ''),
      });
      break;
    }
    case 'deleteCustom':
      state.custom = state.custom.filter((i) => i.id !== a.id);
      delete state.done[a.id];
      break;
    default:
      throw new Error('Unknown action');
  }
  writeJson(FILES.state, state);
}

function applyConfig(body) {
  const next = { ...config };
  if (typeof body.canvasIcsUrl === 'string') next.canvasIcsUrl = body.canvasIcsUrl.trim();
  if (typeof body.edToken === 'string' && body.edToken.trim()) next.edToken = body.edToken.trim();
  if (body.clearEdToken) next.edToken = '';
  if (Array.isArray(body.edCourses)) next.edCourses = body.edCourses;
  if (Array.isArray(body.courseSites)) next.courseSites = body.courseSites;
  if (body.canvasCourses && typeof body.canvasCourses === 'object') next.canvasCourses = body.canvasCourses;
  config = next;
  writeJson(FILES.config, config);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const asset = req.method === 'GET' && STATIC[url.pathname];
    if (asset) return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', asset[0])), asset[1]);
    if (req.method === 'GET' && url.pathname === '/api/data') return send(res, 200, publicPayload());
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      await syncAll();
      return send(res, 200, publicPayload());
    }
    if (req.method === 'POST' && url.pathname === '/api/state') {
      applyStateAction(await readBody(req));
      return send(res, 200, publicPayload());
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      applyConfig(await readBody(req));
      await syncAll();
      return send(res, 200, publicPayload());
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

const HELP = `UWCheck ${pkg.version}: one calendar for Canvas, Ed and UW course websites

Usage: uwcheck [options]

  --port <n>   Port to listen on (default 7351, or $PORT)
  --no-open    Don't open the browser
  --version    Print the version
  --help       Show this help

Your settings and ticks are stored in ${DATA_DIR}
(set UWCHECK_DATA to use another folder).`;

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(pkg.version);
    process.exit(0);
  }
  const url = `http://localhost:${PORT}`;
  const shouldOpen = !process.argv.includes('--no-open');
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`UWCheck is already running at ${url}`);
      if (shouldOpen) openBrowser(url);
      setTimeout(() => process.exit(0), 500);
    } else {
      throw err;
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`UWCheck running at ${url}  (Ctrl+C to stop)`);
    console.log(`Data folder: ${DATA_DIR}`);
    if (shouldOpen) openBrowser(url);
    syncAll().catch((e) => console.error('Sync failed:', e.message));
    const every = Math.max(5, Number(config.autoSyncMinutes) || 30) * 60 * 1000;
    setInterval(() => syncAll().catch(() => {}), every);
  });
}

module.exports = { parseCourseSite, parseIcs, zoned, kindOf, codeKey, courseFromCode };
