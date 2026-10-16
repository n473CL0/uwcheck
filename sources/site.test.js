'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCourseSite } = require('./site');

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

test('a course website listed without a name is named from its URL', () => {
  const { courseFromUrl } = require('./site');
  assert.strictEqual(courseFromUrl('https://courses.cs.washington.edu/courses/cse351/26au/assignments.html'), 'CSE 351');
  assert.strictEqual(courseFromUrl('https://courses.cs.washington.edu/courses/cse373h/26au/assignments.html'), 'CSE 373');
  assert.strictEqual(courseFromUrl('https://example.edu/assignments.html'), 'example.edu');
  assert.strictEqual(courseFromUrl('not a url'), 'not a url');
});
