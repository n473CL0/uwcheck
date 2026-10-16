// Installing over an older UWCheck that's still running (say, an old `npm install -g` copy) must hand
// its port to the new one; otherwise the new app opens onto the old server. Its own file, because the
// server reads its port when loaded, and this one must not be 7351.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

test('an older running copy is replaced by this one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uwcheck-test-'));
  const port = await freePort();
  Object.assign(process.env, { PORT: String(port), UWCHECK_DATA: path.join(tmp, 'data'), UWCHECK_NO_UPDATE_CHECK: '1' });
  const url = `http://127.0.0.1:${port}`;
  const version = async () => {
    try { return (await (await fetch(`${url}/api/data`)).json()).version; } catch { return null; }
  };
  const until = async (check) => {
    for (let i = 0; i < 80 && !(await check()); i++) await sleep(250);
    assert.ok(await check());
  };

  // The "old" copy: this code with an older version number.
  const old = path.join(tmp, 'old');
  for (const f of ['server.js', 'package.json', 'sources']) fs.cpSync(path.join(__dirname, f), path.join(old, f), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(old, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ ...pkg, version: '0.0.1' }));
  spawn(process.execPath, [path.join(old, 'server.js'), '--no-open', '--port', String(port)], { stdio: 'ignore' });
  await until(async () => (await version()) === '0.0.1');

  const { takeOver } = require('./server.js');
  try {
    await takeOver('0.0.1');
    assert.strictEqual(await version(), require('./package.json').version);
  } finally {
    await fetch(`${url}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }
});
