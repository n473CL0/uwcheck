#!/usr/bin/env node
// UWCheck: merges Canvas, Ed and course-website deadlines.
// Zero dependencies: run `npx uwcheck` or `node server.js` (Node 18+), then open http://localhost:7351
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execFileSync, spawn } = require('child_process');

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
// Without this, a source that stops answering holds up every sync for minutes.
const FETCH_TIMEOUT_MS = 20 * 1000;

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

// A missing file means a first run. A broken one (say, a hand edit with a typo) is moved aside
// rather than overwritten by the next save; if it can't be moved, fail instead.
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fs.renameSync(file, file + '.bad');
      console.error(`Could not read ${file} (${err.message}). Moved it to ${file}.bad and started fresh.`);
    }
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
  const res = await fetch(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
  const res = await fetch(`https://${region}.edstem.org/api/user`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
  return fetchEach('ed', await edCourseList(region, headers), async ({ id: courseId, course }) => {
    const res = await fetch(`https://${region}.edstem.org/api/courses/${courseId}/lessons`, {
      headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('Ed rejected the API token');
    if (!res.ok) throw new Error(`Ed course ${courseId} returned HTTP ${res.status}`);
    const body = await res.json();
    const items = [];
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
    return items;
  });
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
  return fetchEach('site', config.courseSites, async ({ url, course }) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const found = parseCourseSite(await res.text(), url, course);
    if (!found.length) throw new Error(`No deadlines found on ${url}`);
    return found;
  });
}

// ---------- sync + merge ----------

// Fetches each Ed course or course site on its own, so one bad one doesn't freeze the rest.
// A failed one keeps its last good items; the error carries the combined items to syncAll.
async function fetchEach(source, parts, fetchPart) {
  const prev = cache.sources?.[source]?.items || [];
  const items = [];
  const errors = new Set();
  await Promise.all(parts.map(async (part) => {
    try {
      items.push(...await fetchPart(part));
    } catch (err) {
      errors.add(err.message);
      items.push(...prev.filter((i) => i.course === part.course));
    }
  }));
  if (errors.size) throw Object.assign(new Error([...errors].join('; ')), { items });
  return items;
}

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
          cache.sources[name] = { items: [], status: 'not-configured', error: null };
        } else {
          cache.sources[name] = { items, status: 'ok', error: null, syncedAt: new Date().toISOString() };
        }
      } catch (err) {
        cache.sources[name] = { ...prev, items: err.items || prev.items, status: 'error', error: err.message };
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

function mergedItems(src = cache.sources || {}, custom = state.custom) {
  // Compare cleaned-up course codes, so a site named "CSE351" still matches "CSE 351" from Ed.
  const key = (i) => `${courseFromCode(i.course.toUpperCase())}|${codeKey(i.title)}`;
  const ed = src.ed?.items || [];
  const edKeys = new Set(ed.map(key));
  const site = (src.site?.items || []).filter((i) => !codeKey(i.title) || !edKeys.has(key(i)));
  return [...(src.canvas?.items || []), ...ed, ...site, ...custom];
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
    version: pkg.version,
    update: updateInfo(),
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
  '/fonts/open-sans.woff2': ['fonts/open-sans.woff2', 'font/woff2'],
  '/fonts/encode-sans.woff2': ['fonts/encode-sans.woff2', 'font/woff2'],
};

const server = http.createServer(async (req, res) => {
  try {
    // Only answer this computer's browser: blocks DNS rebinding, and requiring JSON on POST
    // forces a CORS preflight, so other websites can't change your settings.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'Forbidden' });
    if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) {
      return send(res, 415, { error: 'Expected JSON' });
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const asset = req.method === 'GET' && STATIC[url.pathname];
    if (asset) return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', asset[0])), asset[1]);
    if (req.method === 'GET' && url.pathname === '/api/data') return send(res, 200, publicPayload());
    if (req.method === 'POST' && url.pathname === '/api/quit') {
      send(res, 200, { ok: true });
      return setTimeout(() => process.exit(0), 100);
    }
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
      // A sync already running uses the old settings; wait for it, then sync again.
      if (syncing) await syncing.catch(() => {});
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

// ---------- desktop app ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ICON_PNG = path.join(ROOT, 'public', 'icon-512.png');

// A Chromium browser can show the dashboard as its own app window, without tabs or an address bar.
function appBrowser() {
  const { ProgramFiles = '', LOCALAPPDATA = '' } = process.env;
  const x86 = process.env['ProgramFiles(x86)'] || '';
  const candidates = {
    win32: [
      path.join(ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
      path.join(LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
      path.join(x86, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/snap/bin/chromium', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser'],
  }[process.platform] || [];
  return candidates.find((p) => fs.existsSync(p));
}

function openAppWindow(url) {
  const browser = appBrowser();
  if (!browser) return openBrowser(url);
  spawn(browser, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
}

async function isRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/data`, { signal: AbortSignal.timeout(1500) });
    return res.ok && Array.isArray((await res.json()).items);
  } catch {
    return false;
  }
}

function spawnBackground(args) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  spawn(process.execPath, [__filename, ...args], {
    detached: true, stdio: ['ignore', log, log], windowsHide: true,
  }).unref();
}

// What the app icon runs: start the server in the background if needed, then open the window.
async function launchApp() {
  if (!(await isRunning())) {
    spawnBackground(['--no-open', '--background', '--port', String(PORT)]);
    for (let i = 0; i < 40 && !(await isRunning()); i++) await sleep(250);
  }
  openAppWindow(`http://localhost:${PORT}`);
}

async function stopServer() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/quit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(1500),
    });
    return true;
  } catch {
    return false;
  }
}

function shortcutPaths() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const ps = "[Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('Desktop')";
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).map((dir) => path.join(dir, 'UWCheck.lnk'));
  }
  if (process.platform === 'darwin') return [path.join(home, 'Applications', 'UWCheck.app')];
  return [path.join(home, '.local', 'share', 'applications', 'uwcheck.desktop')];
}

function installApp() {
  if (/[\\/]_npx[\\/]/.test(ROOT)) {
    console.log('npx runs UWCheck from a temporary folder, so a shortcut to it would break.\n'
      + 'Install it first, then add the app:\n\n  npm install -g uwcheck\n  uwcheck --install');
    process.exit(1);
  }
  const args = [__filename, '--app', ...(argValue('--port') ? ['--port', argValue('--port')] : [])];
  const paths = shortcutPaths();
  if (process.platform === 'win32') {
    // Minimised window style keeps the launcher's console out of sight for the second it runs.
    const ps = `$ws = New-Object -ComObject WScript.Shell
foreach ($p in $env:UWC_PATHS.Split('|')) {
  $s = $ws.CreateShortcut($p)
  $s.TargetPath = $env:UWC_NODE
  $s.Arguments = $env:UWC_ARGS
  $s.IconLocation = $env:UWC_ICON
  $s.WindowStyle = 7
  $s.Description = 'UWCheck'
  $s.Save()
}`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'inherit',
      env: {
        ...process.env,
        UWC_PATHS: paths.join('|'),
        UWC_NODE: process.execPath,
        UWC_ARGS: args.map((a) => `"${a}"`).join(' '),
        UWC_ICON: path.join(ROOT, 'public', 'icon.ico'),
      },
    });
  } else if (process.platform === 'darwin') {
    const contents = path.join(paths[0], 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>UWCheck</string>
  <key>CFBundleIdentifier</key><string>io.github.n473cl0.uwcheck</string>
  <key>CFBundleExecutable</key><string>UWCheck</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
</dict></plist>
`);
    const quoted = [process.execPath, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    fs.writeFileSync(path.join(contents, 'MacOS', 'UWCheck'), `#!/bin/sh\nexec ${quoted}\n`, { mode: 0o755 });
    // Build the Dock icon with tools built into macOS; the app still works without it.
    try {
      const set = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uwcheck-')), 'icon.iconset');
      fs.mkdirSync(set);
      for (const s of [16, 32, 128, 256, 512]) {
        execFileSync('sips', ['-z', String(s), String(s), ICON_PNG, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
      }
      execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(contents, 'Resources', 'icon.icns')], { stdio: 'ignore' });
    } catch {}
  } else {
    fs.mkdirSync(path.dirname(paths[0]), { recursive: true });
    fs.writeFileSync(paths[0], `[Desktop Entry]
Type=Application
Name=UWCheck
Comment=One calendar for Canvas, Ed and UW course websites
Exec=${[process.execPath, ...args].map((a) => `"${a}"`).join(' ')}
Icon=${ICON_PNG}
Terminal=false
Categories=Office;Calendar;
`);
  }
  console.log('Added the UWCheck app:');
  for (const p of paths) console.log(`  ${p}`);
  console.log('\nOpen it like any other app. It starts UWCheck in the background when needed.');
}

async function uninstallApp() {
  for (const p of shortcutPaths()) fs.rmSync(p, { recursive: true, force: true });
  await stopServer();
  console.log(`Removed the UWCheck app. Your settings are still in ${DATA_DIR}`);
}

// ---------- updates ----------

const BACKGROUND = process.argv.includes('--background');
// How this copy was installed decides how to update it.
const UPDATE_COMMAND = /[\\/]_npx[\\/]/.test(ROOT) ? 'npx uwcheck@latest'
  : /[\\/]node_modules[\\/]/.test(ROOT) ? 'npm install -g uwcheck@latest' : 'git pull';
let latestVersion = null;

function isNewer(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function checkForUpdate() {
  if (process.env.UWCHECK_NO_UPDATE_CHECK) return;
  try {
    const res = await fetch('https://registry.npmjs.org/uwcheck/latest', { signal: AbortSignal.timeout(5000) });
    if (res.ok) latestVersion = (await res.json()).version;
  } catch {}
}

function updateInfo() {
  if (!latestVersion || !isNewer(latestVersion, pkg.version)) return null;
  return { latest: latestVersion, command: UPDATE_COMMAND, autoRestart: BACKGROUND };
}

// Once an update replaces these files, a background server restarts onto the new code;
// one started from a terminal just says so.
function watchForInstall() {
  const timer = setInterval(() => {
    let version;
    try {
      version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    } catch {
      return;
    }
    if (version === pkg.version) return;
    clearInterval(timer);
    if (!BACKGROUND) return console.log(`UWCheck ${version} is installed. Restart it to use the new version.`);
    // Give npm a moment to finish writing the rest of the files.
    setTimeout(() => {
      server.close(() => {
        spawnBackground(process.argv.slice(2));
        process.exit(0);
      });
      server.closeAllConnections();
    }, 10 * 1000);
  }, 60 * 1000);
}

const HELP = `UWCheck ${pkg.version}: one calendar for Canvas, Ed and UW course websites

Usage: uwcheck [options]

  (no options)  Start UWCheck and open it in your browser
  --install     Add a UWCheck app to your Start menu / Applications and desktop
  --uninstall   Remove that app and stop UWCheck
  --stop        Stop UWCheck if it's running in the background
  --port <n>    Port to listen on (default 7351, or $PORT)
  --no-open     Don't open the browser
  --version     Print the version
  --help        Show this help

Your settings and ticks are stored in ${DATA_DIR}
(set UWCHECK_DATA to use another folder). UWCheck checks npm once a day for
a newer version; set UWCHECK_NO_UPDATE_CHECK=1 to turn that off.`;

function startServer() {
  const url = `http://localhost:${PORT}`;
  const shouldOpen = !process.argv.includes('--no-open');
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    isRunning().then((ours) => {
      if (ours) {
        console.log(`UWCheck is already running at ${url}`);
        if (shouldOpen) openBrowser(url);
      } else {
        console.log(`Another program is using port ${PORT}. Try another one: uwcheck --port ${PORT + 1}`);
      }
      setTimeout(() => process.exit(ours ? 0 : 1), 500);
    });
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`UWCheck running at ${url}  (Ctrl+C to stop)`);
    console.log(`Data folder: ${DATA_DIR}`);
    console.log('Tip: run `uwcheck --install` to add a UWCheck app icon that starts everything for you.');
    if (shouldOpen) openBrowser(url);
    syncAll().catch((e) => console.error('Sync failed:', e.message));
    const every = Math.max(5, Number(config.autoSyncMinutes) || 30) * 60 * 1000;
    setInterval(() => syncAll().catch(() => {}), every);
    checkForUpdate();
    setInterval(checkForUpdate, 24 * 60 * 60 * 1000);
    watchForInstall();
  });
}

if (require.main === module) {
  const flag = (...names) => names.some((n) => process.argv.includes(n));
  if (flag('--help', '-h')) console.log(HELP);
  else if (flag('--version', '-v')) console.log(pkg.version);
  else if (flag('--install')) installApp();
  else if (flag('--uninstall')) uninstallApp();
  else if (flag('--stop')) stopServer().then((ok) => console.log(ok ? 'Stopped UWCheck.' : 'UWCheck is not running.'));
  else if (flag('--app')) launchApp().then(() => process.exit(0));
  else startServer();
}

module.exports = { parseCourseSite, parseIcs, icsDate, zoned, kindOf, codeKey, courseFromCode, mergedItems };
