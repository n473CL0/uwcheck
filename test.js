// Run with `npm test`, which also runs each source's tests in sources/*.test.js.
// Covers the shared date and merge logic that decides which day a deadline lands on.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the real ~/.uwcheck out of it.
process.env.UWCHECK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'uwcheck-test-'));
const { mergedItems, SOURCES, applyConfig, publicConfig, applyStateAction, calendarFeed, FILES } = require('./server.js');
const { zoned, courseFromCode } = require('./sources/common');

test('Seattle wall-clock time across daylight saving changes', () => {
  assert.strictEqual(zoned(2026, 3, 7, 23, 59, 'America/Los_Angeles').toISOString(), '2026-03-08T07:59:00.000Z');
  assert.strictEqual(zoned(2026, 3, 9, 23, 59, 'America/Los_Angeles').toISOString(), '2026-03-10T06:59:00.000Z');
  assert.strictEqual(zoned(2026, 11, 2, 23, 59, 'America/Los_Angeles').toISOString(), '2026-11-03T07:59:00.000Z');
});

test('course codes', () => {
  assert.strictEqual(courseFromCode('MATH/STAT 394 A'), 'MATH 394');
  assert.strictEqual(courseFromCode('E E 201 A'), 'EE 201');
  assert.strictEqual(courseFromCode('CSE 351 - 26au'), 'CSE 351');
});

test('work listed on both Ed and the course website shows once', () => {
  const sources = {
    ed: { items: [{ course: 'CSE 351', title: 'HW4: Pointers' }] },
    site: { items: [{ course: 'cse351', title: 'HW4' }, { course: 'cse351', title: 'HW5' }, { course: 'cse351', title: 'Midterm' }] },
  };
  assert.deepStrictEqual(mergedItems(sources, []).map((i) => i.title), ['HW4: Pointers', 'HW5', 'Midterm']);
});

test('secrets stay on the server, and settings must match their declared type', () => {
  applyConfig({ edToken: '  tok-123 ', canvasCourses: ['not', 'an', 'object'], autoSyncMinutes: 1 });
  const saved = JSON.parse(fs.readFileSync(FILES.config, 'utf8'));
  assert.strictEqual(saved.edToken, 'tok-123');
  assert.deepStrictEqual(saved.canvasCourses, {});
  assert.strictEqual(saved.autoSyncMinutes, 30); // not a source setting, so the 1 isn't accepted
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(FILES.config).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(publicConfig()).includes('tok-123'));
  assert.strictEqual(publicConfig().hasEdToken, true);

  applyConfig({ edToken: '' }); // blank keeps the saved token
  assert.strictEqual(publicConfig().hasEdToken, true);
  applyConfig({ clearEdToken: true });
  assert.strictEqual(publicConfig().hasEdToken, false);
});

test('every source follows the contract in CONTRIBUTING.md', () => {
  const names = new Set();
  for (const file of fs.readdirSync(path.join(__dirname, 'sources'))) {
    if (file === 'common.js' || file.endsWith('.test.js')) continue;
    const s = require(`./sources/${file}`);
    assert.strictEqual(`${s.name}.js`, file, 'name must match the file name');
    assert.ok(!names.has(s.name));
    names.add(s.name);
    assert.strictEqual(typeof s.label, 'string', `${file}: label`);
    assert.strictEqual(typeof s.fetch, 'function', `${file}: fetch`);
    assert.ok(s.config && typeof s.config === 'object', `${file}: config`);
    assert.ok(Array.isArray(s.secrets), `${file}: secrets`);
    for (const key of s.secrets) assert.ok(key in s.config, `${file}: secret ${key} needs a default in config`);
  }
  assert.deepStrictEqual(SOURCES.map((s) => s.name).sort(), [...names].sort(), 'add every source to SOURCES in server.js');
});

test('ticks and your own deadlines', () => {
  applyStateAction({ type: 'done', done: { 'ed:1': true, 'ed:2': false } });
  applyStateAction({ type: 'done', done: { 'ed:1': null } }); // undo back to "never ticked"
  let saved = JSON.parse(fs.readFileSync(FILES.state, 'utf8'));
  assert.deepStrictEqual(saved.done, { 'ed:2': false });

  applyStateAction({ type: 'color', colors: { 'CSE 351': '#4a7fb0', 'MATH 327': '#c2643f' } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(FILES.state, 'utf8')).colors, { 'CSE 351': '#4a7fb0', 'MATH 327': '#c2643f' });

  applyStateAction({ type: 'addCustom', item: { title: ' Study ', due: '2026-10-20T12:00:00Z', allDay: true } });
  const [added] = JSON.parse(fs.readFileSync(FILES.state, 'utf8')).custom;
  assert.strictEqual(added.title, 'Study');
  assert.strictEqual(added.course, 'Personal');
  applyStateAction({ type: 'editCustom', id: added.id, item: { title: 'Study more', course: 'CSE 351', kind: added.kind, due: '2026-10-21T18:30:00Z' } });
  saved = JSON.parse(fs.readFileSync(FILES.state, 'utf8'));
  assert.deepStrictEqual(saved.custom, [{ ...added, title: 'Study more', course: 'CSE 351', due: '2026-10-21T18:30:00.000Z', allDay: false }]);
  assert.throws(() => applyStateAction({ type: 'editCustom', id: added.id, item: { title: '' } }), /required/);
  assert.throws(() => applyStateAction({ type: 'editCustom', id: 'custom:gone', item: { title: 'x', due: '2026-10-21' } }), /deleted/);

  applyStateAction({ type: 'done', done: { [added.id]: true } });
  applyStateAction({ type: 'deleteCustom', id: added.id });
  saved = JSON.parse(fs.readFileSync(FILES.state, 'utf8'));
  assert.deepStrictEqual([saved.custom, saved.done[added.id]], [[], undefined]);
});

test('the calendar feed reads back as the same deadlines', () => {
  const { parseIcs, icsDate } = require('./sources/canvas');
  const long = 'Lab 3: a very long title, with commas; semicolons and a backslash \\ to escape — ünïcödé too';
  const ics = calendarFeed([
    { id: 'ed:7', course: 'CSE 351', title: long, kind: 'Lab', due: '2026-10-13T06:59:00.000Z', url: 'https://edstem.org/x' },
    { id: 'custom:a', course: 'Personal', title: 'Study', kind: 'Task', due: '2026-10-20T12:00:00.000Z', allDay: true, url: 'javascript:alert(1)' },
    { id: 'site:CSE 351:HW9', course: 'CSE 351', title: 'HW9', kind: 'Homework', due: '2026-11-01T06:59:00.000Z', tentative: true },
    { id: 'canvas:event-1', course: 'MATH 327', title: 'Lecture', kind: 'Event', due: '2026-10-13T17:30:00.000Z' },
  ]);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  const events = parseIcs(ics);
  assert.strictEqual(events.length, 3, 'events are left out');
  assert.strictEqual(events[0].SUMMARY.value.replace(/\\([,;\\])/g, '$1'), `CSE 351: ${long}`);
  assert.strictEqual(icsDate(events[0].DTSTART).due, '2026-10-13T06:59:00.000Z');
  assert.strictEqual(events[0].URL.value, 'https://edstem.org/x');
  assert.deepStrictEqual(icsDate(events[1].DTSTART), { due: '2026-10-20T12:00:00.000Z', allDay: true });
  assert.strictEqual(events[1].URL, undefined, 'only web links');
  assert.strictEqual(events[2].STATUS.value, 'TENTATIVE');
});
