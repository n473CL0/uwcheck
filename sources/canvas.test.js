'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseIcs, icsDate, parseFeed } = require('./canvas');

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

test('Canvas feed events become items', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-assignment-555',
    'DTSTART:20261013T065900Z',
    'SUMMARY:HW4\\, part 1 [CSE 351 A Au 26: The Hardware/Software Interface]',
    'URL:https://canvas.uw.edu/calendar?include_contexts=course_1234&month=10',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:event-calendar-event-9',
    'DTSTART;VALUE=DATE:20261014',
    'SUMMARY:Office hours [MATH/STAT 394 A]',
    'URL:https://canvas.uw.edu/calendar?include_contexts=course_42',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const feed = 'https://canvas.uw.edu/feeds/calendars/user_abc.ics';
  assert.deepStrictEqual(parseFeed(ics, feed, { 42: 'Probability' }), [
    {
      id: 'canvas:assignment-555', source: 'canvas', course: 'CSE 351', title: 'HW4, part 1', kind: 'Homework',
      due: '2026-10-13T06:59:00.000Z', url: 'https://canvas.uw.edu/courses/1234/assignments/555',
    },
    {
      id: 'canvas:calendar-event-9', source: 'canvas', course: 'Probability', title: 'Office hours', kind: 'Event',
      due: '2026-10-14T12:00:00.000Z', allDay: true, url: 'https://canvas.uw.edu/calendar?include_contexts=course_42',
    },
  ]);
});
