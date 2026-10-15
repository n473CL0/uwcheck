'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseLessons } = require('./ed');

test('Ed lessons with a due date become items', () => {
  const body = {
    modules: [{ id: 1, name: 'Labs' }],
    lessons: [
      { id: 10, title: 'Pointers practice', module_id: 1, due_at: '2026-10-13T06:59:00Z', status: 'completed' },
      { id: 11, title: 'HW4: Caches', due_at: '2026-10-14T06:59:00.000Z' },
      { id: 12, title: 'Welcome', due_at: null },
    ],
  };
  assert.deepStrictEqual(parseLessons(body, 'us', 107500, 'CSE 351'), [
    {
      id: 'ed:10', source: 'ed', course: 'CSE 351', title: 'Pointers practice', kind: 'Lab',
      due: '2026-10-13T06:59:00.000Z', url: 'https://edstem.org/us/courses/107500/lessons/10', completed: true,
    },
    {
      id: 'ed:11', source: 'ed', course: 'CSE 351', title: 'HW4: Caches', kind: 'Homework',
      due: '2026-10-14T06:59:00.000Z', url: 'https://edstem.org/us/courses/107500/lessons/11', completed: false,
    },
  ]);
});
