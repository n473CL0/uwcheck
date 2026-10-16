#!/usr/bin/env node
// Clicks through the page in headless Chrome: what `npm test` can't see. First-run setup, Enter to
// save, ticking with Undo, the Overdue groups, closing Settings. Uses made-up Canvas and course-site
// pages served from here, and a throwaway data folder. Needs Chrome and Node 22+ (for WebSocket).
// Run: npm run smoke   (set CHROME=/path/to/chrome if it isn't found)
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('node:assert');

const CHROME = process.env.CHROME || [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
].find((p) => fs.existsSync(p));
const DAY = 86400000;
const YY = String(new Date().getFullYear()).slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uwcheck-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One course on Canvas (one item over a week late, one recently late, one coming up) and one CSE page.
function fixtures(req, res) {
  const now = Date.now();
  if (req.url === '/feed.ics') {
    const stamp = (t) => new Date(t).toISOString().replace(/[-:]|\.\d+/g, '');
    const ev = (n, title, t) => ['BEGIN:VEVENT', `UID:event-assignment-${n}`, `DTSTART:${stamp(t)}`,
      `SUMMARY:${title} [MATH 327 A Au ${YY}]`, 'END:VEVENT'];
    const lines = ['BEGIN:VCALENDAR', ...ev(1, 'Homework 1', now - 20 * DAY), ...ev(2, 'Homework 2', now - 2 * DAY),
      ...ev(3, 'Quiz 4', now + 2 * DAY), 'END:VCALENDAR'];
    return res.end(lines.join('\r\n'));
  }
  const day = new Date(now + 3 * DAY).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' });
  res.end(`<table><tr><td>${day}<td><a href="hw6.html">HW6</a></tr></table>`);
}

const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

async function until(check, what, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    try { if (await check()) return; } catch {}
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Just enough of the Chrome DevTools Protocol: run JS in the page, click, type, press keys.
async function browser(profile) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').includes('\n'), 'Chrome to start', 30000);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) pending.get(d.id)(d);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, (d) => (d.error ? reject(new Error(d.error.message)) : resolve(d.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    send, ev, close: () => ws.close(),
    async click(selector) {
      const at = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return b && b.width ? [b.x + b.width / 2, b.y + b.height / 2] : null; })()`);
      assert.ok(at, `nothing to click at ${selector}`);
      const [x, y] = at;
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(200);
    },
    type: (text) => send('Input.insertText', { text }),
    async enter() {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
    },
  };
}

async function main() {
  assert.ok(typeof WebSocket === 'function', 'Needs Node 22 or newer');
  assert.ok(CHROME, 'Chrome not found; set CHROME to its path');
  const fix = http.createServer(fixtures).listen(0, '127.0.0.1');
  await new Promise((r) => fix.on('listening', r));
  const site = `http://127.0.0.1:${fix.address().port}`;
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', String(port), '--no-open'], {
    env: { ...process.env, UWCHECK_DATA: path.join(tmp, 'data'), UWCHECK_NO_UPDATE_CHECK: '1' }, stdio: 'ignore',
  });
  const profile = path.join(tmp, 'chrome');
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = '';
  chrome.stderr.on('data', (d) => { chromeLog = (chromeLog + d).slice(-4000); });
  chrome.on('exit', (code) => { if (code) chromeLog += `\nChrome exited with code ${code}`; });
  let b;
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port}/api/data`)).ok, 'UWCheck to start');
    b = await browser(profile);
    // UTC-11: an all-day deadline (stored as noon UTC, 1 AM here) is past its moment for almost all of its day.
    await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Pago_Pago' });
    await b.send('Page.navigate', { url: `http://localhost:${port}/` });
    await until(() => b.ev(`$('setDlg').open`), 'Settings to open on first run');

    await b.click('#setDlg details.adv summary');
    await b.click('#sSites');
    await b.type(`${site}/courses/cse351/${YY}au/assignments.html?v=1`);
    await b.click('#sEdCourses');
    await b.type('https://edstem.org/us/courses/107500/lessons');
    await b.click('#sCanvas');
    await b.type(`${site}/feed.ics`);
    await b.enter(); // saves; it used to press Cancel
    await until(() => b.ev(`!$('setDlg').open`), 'Enter to save and close Settings');
    assert.strictEqual(await b.ev(`$('toastMsg').textContent`), 'Synced. Canvas: 3 deadlines in 1 course · Course site: 1 deadline in 1 course');
    const config = await b.ev(`data.config`);
    assert.deepStrictEqual(config.courseSites, [{ url: `${site}/courses/cse351/${YY}au/assignments.html?v=1`, course: '' }]);
    assert.deepStrictEqual(config.edCourses, [{ id: 107500, course: '' }], 'a pasted Ed link keeps its course id');
    assert.ok(await b.ev(`[...document.querySelectorAll('#legend .tag')].some((t) => t.textContent === 'CSE 351')`), 'course site named from its URL');
    await until(() => b.ev(`courses().every((c) => data.state.colors[c])`), 'course colours to be saved');

    const groups = await b.ev(`[...document.querySelectorAll('#todo .group-h .caret')].map((g) => g.textContent + ' ' + g.getAttribute('aria-expanded'))`);
    assert.deepStrictEqual([groups[0], groups.at(-1)], ['Overdue1 true', 'Overdue over a week1 false']);

    const first = await b.ev(`document.querySelector('#todo .row').dataset.id`);
    await b.click('#todo .row input');
    await until(() => b.ev(`document.querySelector('#todo .row')?.dataset.id !== ${JSON.stringify(first)}`), 'the ticked row to leave');
    await b.click('#toastUndo');
    await until(() => b.ev(`document.querySelector('#todo .row').dataset.id === ${JSON.stringify(first)}`), 'Undo to bring it back');
    assert.deepStrictEqual(await b.ev(`fetch('/api/data').then((r) => r.json()).then((d) => d.state.done)`), {}, 'Undo leaves no tick behind');

    await b.ev(`act({ type: 'addCustom', item: { title: 'Read ch. 4', due: todayKey() + 'T12:00:00.000Z', allDay: true } })`);
    await until(() => b.ev(`[...document.querySelectorAll('#todo .row .title')].some((t) => t.textContent === 'Read ch. 4')`), 'the new deadline');
    assert.ok(await b.ev(`![...document.querySelectorAll('#todo .row')].find((r) => r.textContent.includes('Read ch. 4')).querySelector('.when').classList.contains('late')`),
      'an all-day deadline is not late on its own day');

    await b.click('#settingsBtn');
    await b.click('#setDlg .dlg-head [data-close]');
    assert.ok(!await b.ev(`$('setDlg').open`), 'the X closes Settings');
    console.log('Smoke test passed.');
  } catch (e) {
    if (chromeLog) console.error(`Chrome said:\n${chromeLog}`);
    throw e;
  } finally {
    b?.close();
    chrome.kill();
    app.kill();
    fix.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} // Chrome may still hold files on Windows
}, 500));
