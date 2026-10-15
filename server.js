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
const { codeKey, courseFromCode } = require('./sources/common');

// Each data source is one file in sources/. To add one, see CONTRIBUTING.md.
const SOURCES = [require('./sources/canvas'), require('./sources/ed'), require('./sources/site')];
const SOURCE_CONFIG = Object.assign({}, ...SOURCES.map((s) => s.config));
const SECRETS = new Set(SOURCES.flatMap((s) => s.secrets));

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(argValue('--port') || process.env.PORT) || 7351;
const ROOT = __dirname;
// Lives outside the install folder so npm updates never wipe your token and ticks.
const DATA_DIR = process.env.UWCHECK_DATA || path.join(os.homedir(), '.uwcheck');

const FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  state: path.join(DATA_DIR, 'state.json'),
  cache: path.join(DATA_DIR, 'cache.json'),
};

const DEFAULT_CONFIG = { ...SOURCE_CONFIG, autoSyncMinutes: 30 };

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
  // Only you can read it: config.json holds the Ed token. The tmp file is new each time, so the mode always applies.
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let config = { ...DEFAULT_CONFIG, ...readJson(FILES.config, {}) };
let state = { ...DEFAULT_STATE, ...readJson(FILES.state, {}) };
// cache = last good result per source, so the dashboard still works offline.
let cache = readJson(FILES.cache, { sources: {} });

// ---------- sync + merge ----------

let syncing = null;

async function syncAll() {
  if (syncing) return syncing;
  syncing = (async () => {
    cache.sources ||= {};
    await Promise.all(SOURCES.map(async (source) => {
      const { name } = source;
      const prev = cache.sources[name] || { items: [] };
      try {
        const items = await source.fetch(config, prev.items);
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
  const edKeys = new Set((src.ed?.items || []).map(key));
  // Course sites list work before Ed releases it; once Ed has it, show only Ed's copy.
  const items = SOURCES.flatMap(({ name }) => (src[name]?.items || [])
    .filter((i) => name !== 'site' || !codeKey(i.title) || !edKeys.has(key(i))));
  return [...items, ...custom];
}

function publicPayload() {
  const sources = {};
  for (const { name, label } of SOURCES) {
    const s = cache.sources?.[name] || {};
    sources[name] = { label, status: s.status, error: s.error, syncedAt: s.syncedAt, count: s.items?.length || 0 };
  }
  return {
    items: mergedItems(),
    state: { done: state.done, colors: state.colors }, // custom items are already in items
    sources,
    lastSync: cache.lastSync || null,
    config: publicConfig(),
    version: pkg.version,
    update: updateInfo(),
  };
}

const capitalized = (key) => key[0].toUpperCase() + key.slice(1);

// Secrets never reach the page; it only learns whether each is set (edToken -> hasEdToken).
function publicConfig() {
  const pub = { ...config };
  for (const key of SECRETS) {
    delete pub[key];
    pub['has' + capitalized(key)] = Boolean(config[key]);
  }
  return pub;
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
    // A request the browser cancels never ends; without these the handler would wait forever.
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new Error('Request cancelled')); });
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

// Takes only settings a source declares, and only with the same type as its default.
function applyConfig(body) {
  const next = { ...config };
  for (const [key, def] of Object.entries(SOURCE_CONFIG)) {
    const v = body[key];
    if (v == null || typeof v !== typeof def || Array.isArray(v) !== Array.isArray(def)) continue;
    const value = typeof v === 'string' ? v.trim() : v;
    // A blank secret means "keep the saved one"; removing it is the clear<Key> flag.
    if (!(SECRETS.has(key) && !value)) next[key] = value;
  }
  for (const key of SECRETS) if (body['clear' + capitalized(key)]) next[key] = '';
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
const APP_DIR = path.join(DATA_DIR, 'app');

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
  if (process.platform === 'win32') tagAppWindow();
}

// The window belongs to Chrome, so pinning it to the taskbar would pin `chrome --app=...`, which
// never starts the server. Retag it so the taskbar groups and pins it as this launcher instead.
function tagAppWindow() {
  const ps = `Add-Type @'
using System; using System.Runtime.InteropServices;
public static class UWCWindow {
  [StructLayout(LayoutKind.Sequential)] struct PKey { public Guid f; public uint p; }
  [StructLayout(LayoutKind.Sequential)] struct PropVar { public ushort vt, a, b, c; public IntPtr v, w; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { void GetCount(out uint n); void GetAt(uint i, out PKey k); void GetValue(ref PKey k, out PropVar v); void SetValue(ref PKey k, ref PropVar v); void Commit(); }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, out IPropertyStore s);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  static void Set(IPropertyStore s, uint pid, string val) {
    var k = new PKey { f = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), p = pid };
    var v = new PropVar { vt = 31, v = Marshal.StringToCoTaskMemUni(val) };
    s.SetValue(ref k, ref v);
    Marshal.FreeCoTaskMem(v.v);
  }
  // System.AppUserModel.RelaunchCommand (2), RelaunchIconResource (3), RelaunchDisplayNameResource (4), ID (5)
  public static void Tag(IntPtr h, string cmd, string icon) {
    var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPropertyStore s;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(h, ref iid, out s));
    Set(s, 2, cmd); Set(s, 3, icon); Set(s, 4, "UWCheck"); Set(s, 5, "N473CL0.UWCheck");
  }
}
'@
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $h = [UWCWindow]::FindWindow('Chrome_WidgetWin_1', 'UWCheck') }
if ($h -ne [IntPtr]::Zero) { [UWCWindow]::Tag($h, $env:UWC_CMD, $env:UWC_ICON) }`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore', timeout: 30000,
      env: {
        ...process.env,
        UWC_CMD: [process.execPath, ...launcherArgs()].map((a) => `"${a}"`).join(' '),
        UWC_ICON: path.join(ROOT, 'public', 'icon.ico'),
      },
    });
  } catch {} // the window still works untagged; only pinning it is affected
}

function launcherArgs() {
  return [__filename, '--app', ...(argValue('--port') ? ['--port', argValue('--port')] : [])];
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
    // UTF-8 output, or a folder like C:\Users\José comes back mangled.
    const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('Desktop')";
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).map((dir) => path.join(dir, 'UWCheck.lnk'));
  }
  if (process.platform === 'darwin') return [path.join(home, 'Applications', 'UWCheck.app')];
  return [path.join(home, '.local', 'share', 'applications', 'uwcheck.desktop')];
}

async function installApp() {
  if (/[\\/]_npx[\\/]/.test(ROOT)) {
    // npm can clear npx's cache folder at any time, so the shortcut runs a copy kept next to the data.
    // No global install, so no admin rights or PATH changes needed.
    fs.cpSync(ROOT, APP_DIR, { recursive: true });
    execFileSync(process.execPath, [path.join(APP_DIR, 'server.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
    return;
  }
  const args = launcherArgs();
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
  // Open it on a first install; an update leaves the window that's already open alone.
  if (!(await isRunning())) await launchApp();
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
  : ROOT === APP_DIR ? 'npx uwcheck@latest --install'
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
  --install     Add a UWCheck app to your Start menu / Applications and desktop, and open it
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
    console.log('Tip: run `npx uwcheck@latest --install` to add a UWCheck app icon that starts everything for you.');
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
  else if (flag('--install')) installApp().then(() => process.exit(0));
  else if (flag('--uninstall')) uninstallApp();
  else if (flag('--stop')) stopServer().then((ok) => console.log(ok ? 'Stopped UWCheck.' : 'UWCheck is not running.'));
  else if (flag('--app')) launchApp().then(() => process.exit(0));
  else startServer();
}

module.exports = { mergedItems, SOURCES, applyConfig, publicConfig, FILES };
