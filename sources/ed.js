// Source: Ed lessons API, with the student's own API token.
'use strict';

const { FETCH_TIMEOUT_MS, kindOf, courseFromCode, fetchEach } = require('./common');

// With no courses configured, use every active course on the account ("CSE 351 - 26au" -> "CSE 351").
async function edCourseList(config, region, headers) {
  if (config.edCourses.length) return config.edCourses;
  const res = await fetch(`https://${region}.edstem.org/api/user`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 401 || res.status === 403) throw new Error('Ed rejected the API token');
  if (!res.ok) throw new Error(`Ed returned HTTP ${res.status}`);
  const body = await res.json();
  return (body.courses || [])
    .filter((c) => c.course?.status === 'active')
    .map((c) => ({ id: c.course.id, course: courseFromCode(c.course.code || c.course.name || String(c.course.id)) }));
}

// body: the JSON from /api/courses/<id>/lessons
function parseLessons(body, region, courseId, course) {
  const items = [];
  const modules = Object.fromEntries((body.modules || []).map((m) => [m.id, m.name || '']));
  for (const l of body.lessons || []) {
    if (!l.due_at) continue;
    const status = String(l.status || l.attempt_status || '').toLowerCase();
    const mod = modules[l.module_id] || '';
    const fallback = /lab/i.test(mod) ? 'Lab' : /read/i.test(mod) ? 'Reading'
      : /lecture/i.test(mod) ? 'Lecture' : /homework/i.test(mod) ? 'Homework' : 'Assignment';
    items.push({
      id: `ed:${l.id}`,
      source: 'ed',
      course,
      title: l.title,
      kind: kindOf(l.title, fallback),
      due: new Date(l.due_at).toISOString(),
      url: `https://edstem.org/${region}/courses/${courseId}/lessons/${l.id}`,
      completed: status === 'completed',
    });
  }
  return items;
}

async function fetchEd(config, prev) {
  const token = config.edToken.trim();
  if (!token) return null;
  // The region becomes part of the hostname the token is sent to, so only allow a plain word.
  const region = /^[a-z]{2,4}$/.test(config.edRegion) ? config.edRegion : 'us';
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  return fetchEach(prev, await edCourseList(config, region, headers), async ({ id: courseId, course }) => {
    const res = await fetch(`https://${region}.edstem.org/api/courses/${courseId}/lessons`, {
      headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('Ed rejected the API token');
    if (!res.ok) throw new Error(`Ed course ${courseId} returned HTTP ${res.status}`);
    return parseLessons(await res.json(), region, courseId, course);
  });
}

module.exports = {
  name: 'ed',
  label: 'Ed',
  config: {
    edToken: '',
    edRegion: 'us',
    edCourses: [], // empty = every active course on your Ed account
  },
  secrets: ['edToken'],
  fetch: fetchEd,
  parseLessons,
};
