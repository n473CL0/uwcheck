// Source: Canvas calendar feed (.ics). Works with any Canvas course; no API token needed.
'use strict';

const { SEATTLE, FETCH_TIMEOUT_MS, zoned, allDayIso, kindOf, courseFromCode } = require('./common');

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(';');
      cur[name.toUpperCase()] = {
        value: line.slice(i + 1),
        params: Object.fromEntries(params.map((p) => {
          const [k, v = ''] = p.split('=');
          return [k.toUpperCase(), v.replace(/^"|"$/g, '')];
        })),
      };
    }
  }
  return events;
}

function icsText(v) {
  return (v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function icsDate(prop) {
  if (!prop) return null;
  const v = prop.value;
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return { due: allDayIso(+m[1], +m[2], +m[3]), allDay: true };
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (m[7]) return { due: new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString() };
  return { due: zoned(y, mo, d, h, mi, prop.params.TZID || SEATTLE).toISOString() };
}

// canvasCourses: optional rename, { canvasCourseId: 'Short name' }
function parseFeed(text, feedUrl, canvasCourses = {}) {
  const canvasOrigin = new URL(feedUrl).origin;
  const items = [];
  for (const ev of parseIcs(text)) {
    const when = icsDate(ev.DTSTART);
    if (!when) continue;
    const uid = (ev.UID?.value || '').replace(/^event-/, '');
    const rawSummary = icsText(ev.SUMMARY?.value);
    const bracket = rawSummary.match(/\s*\[([^\]]+)\]\s*$/);
    const title = bracket ? rawSummary.slice(0, bracket.index) : rawSummary;
    const link = ev.URL?.value || '';
    const courseId = (link.match(/course_(\d+)/) || link.match(/courses\/(\d+)/) || [])[1];
    const course = canvasCourses[courseId] || (bracket ? courseFromCode(bracket[1]) : 'Canvas');
    const isAssignment = /assignment/.test(uid);
    let url = link;
    const a = uid.match(/assignment-(\d+)$/);
    if (a && courseId) url = `${canvasOrigin}/courses/${courseId}/assignments/${a[1]}`;
    items.push({
      id: 'canvas:' + uid,
      source: 'canvas',
      course,
      title,
      kind: isAssignment ? kindOf(title) : 'Event',
      ...when,
      url,
    });
  }
  return items;
}

async function fetchCanvas(config) {
  // A copied "subscribe" link starts with webcal://, which is the same feed over HTTPS.
  const url = config.canvasIcsUrl.trim().replace(/^webcals?:\/\//i, 'https://');
  if (!url) return null;
  const res = await fetch(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Canvas feed returned HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That URL is not a calendar feed');
  return parseFeed(text, url, config.canvasCourses);
}

module.exports = {
  name: 'canvas',
  label: 'Canvas',
  config: { canvasIcsUrl: '', canvasCourses: {} },
  secrets: [],
  fetch: fetchCanvas,
  parseIcs,
  icsDate,
  parseFeed,
};
