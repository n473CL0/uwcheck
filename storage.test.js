// A data file that can't be read must be set aside, never overwritten: it holds every tick and
// deadline you added. Its own file, because the server reads the data folder once, when loaded.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('a broken state.json is moved to state.json.bad, and saving leaves that copy alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwcheck-test-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{"done": {"ed:1": true}, oops');
  process.env.UWCHECK_DATA = dir;
  const { applyStateAction } = require('./server.js');

  const bad = path.join(dir, 'state.json.bad');
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{"done": {"ed:1": true}, oops');
  applyStateAction({ type: 'done', done: { 'ed:2': true } });
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{"done": {"ed:1": true}, oops');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).done, { 'ed:2': true });
});
