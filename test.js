// Run with `npm test`. Covers the parsing and date logic that decides which day a deadline lands on.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the real ~/.uwcheck out of it.
process.env.UWCHECK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'uwcheck-test-'));
const { parseIcs, icsDate, zoned, parseCourseSite, mergedItems, courseFromCode } = require('./server.js');

test('Canvas feed: Seattle times, UTC times, all-day dates and folded lines', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/Los_Angeles:20261012T235900',
    'SUMMARY:HW4\\, part 1 [CSE 351 A Au 26: The Hard',
    ' ware/Software Interface]',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART:20261013T170000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261014',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const [a, b, c] = parseIcs(ics);
  assert.strictEqual(a.SUMMARY.value, 'HW4\\, part 1 [CSE 351 A Au 26: The Hardware/Software Interface]');
  assert.deepStrictEqual(icsDate(a.DTSTART), { due: '2026-10-13T06:59:00.000Z' });
  assert.deepStrictEqual(icsDate(b.DTSTART), { due: '2026-10-13T17:00:00.000Z' });
  assert.deepStrictEqual(icsDate(c.DTSTART), { due: '2026-10-14T12:00:00.000Z', allDay: true });
});

test('Seattle wall-clock time across daylight saving changes', () => {
  assert.strictEqual(zoned(2026, 3, 7, 23, 59, 'America/Los_Angeles').toISOString(), '2026-03-08T07:59:00.000Z');
  assert.strictEqual(zoned(2026, 3, 9, 23, 59, 'America/Los_Angeles').toISOString(), '2026-03-10T06:59:00.000Z');
  assert.strictEqual(zoned(2026, 11, 2, 23, 59, 'America/Los_Angeles').toISOString(), '2026-11-03T07:59:00.000Z');
});

test('course website rows', () => {
  const page = 'https://courses.cs.washington.edu/courses/cse351/26au/assignments.html';
  const html = `
    <tr><td>Mon, Oct 12<td><a href="hw4.html">HW4 Due</a> <a href="https://canvas.uw.edu/x">Quiz 2</a></tr>
    <tr><td>Tue, Oct 13</td><td><a class="disabled">RD5: Caches &amp; memory</a></tr>`;
  assert.deepStrictEqual(parseCourseSite(html, page, 'CSE 351'), [
    {
      id: 'site:CSE 351:HW4', source: 'site', course: 'CSE 351', title: 'HW4', kind: 'Homework',
      due: '2026-10-13T06:59:00.000Z', url: 'https://courses.cs.washington.edu/courses/cse351/26au/hw4.html', tentative: false,
    },
    {
      id: 'site:CSE 351:RD5', source: 'site', course: 'CSE 351', title: 'RD5: Caches & memory', kind: 'Reading',
      due: '2026-10-13T18:00:00.000Z', url: page, tentative: true,
    },
  ]);
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
