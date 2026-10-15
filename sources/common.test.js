'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fetchEach } = require('./common');

test('a course that fails to sync keeps its last good items; the others still update', async () => {
  const prev = [{ course: 'CSE 351', title: 'old HW' }, { course: 'MATH 394', title: 'old quiz' }];
  const parts = [{ course: 'CSE 351' }, { course: 'MATH 394' }];
  const err = await fetchEach(prev, parts, async ({ course }) => {
    if (course === 'MATH 394') throw new Error('HTTP 500');
    return [{ course, title: 'new HW' }];
  }).catch((e) => e);
  assert.strictEqual(err.message, 'HTTP 500');
  assert.deepStrictEqual(err.items.map((i) => i.title).sort(), ['new HW', 'old quiz']);
});
