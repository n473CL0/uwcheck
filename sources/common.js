// Helpers shared by the sources in this folder (and by server.js). Not a source itself.
'use strict';

const SEATTLE = 'America/Los_Angeles';
// Without this, a source that stops answering holds up every sync for minutes.
const FETCH_TIMEOUT_MS = 20 * 1000;

// ---------- time ----------

function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

// Wall-clock time in a named zone -> Date.
function zoned(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let ts = wall - tzOffsetMs(wall, tz);
  ts = wall - tzOffsetMs(ts, tz);
  return new Date(ts);
}

// All-day items are pinned to noon UTC so they land on the same date in every US zone.
function allDayIso(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d, 12)).toISOString();
}

// ---------- classification ----------

function kindOf(title, fallback = 'Assignment') {
  const t = title.trim();
  if (/^RD\s*\d/i.test(t) || /reading/i.test(t)) return 'Reading';
  if (/^LC\s*\d/i.test(t) || /lecture/i.test(t)) return 'Lecture';
  if (/^(LB|Lab)\s*\d/i.test(t) || /\blab\b/i.test(t)) return 'Lab';
  if (/^HW\s*\d/i.test(t) || /homework|problem set|pset/i.test(t)) return 'Homework';
  if (/quiz/i.test(t)) return 'Quiz';
  if (/midterm|final exam|\bexam\b/i.test(t)) return 'Exam';
  if (/survey|feedback/i.test(t)) return 'Survey';
  return fallback;
}

// "HW04: …", "HW4 Due", "LB1a", "Lab1a" -> "HW4" / "LAB1a"; used to dedupe Ed vs the course site.
function codeKey(title) {
  const m = title.match(/^(RD|LC|HW|LB|Lab|SC)\s*(\d+)([a-z]?)\b/i);
  if (!m) return '';
  let prefix = m[1].toUpperCase();
  if (prefix === 'LB') prefix = 'LAB';
  return prefix + parseInt(m[2], 10) + m[3].toLowerCase();
}

function courseFromCode(raw) {
  const m = raw.match(/\b([A-Z]{1,6}(?:[ /][A-Z]{1,6})*)\s?(\d{3})\b/);
  if (!m) return raw.trim();
  const dept = m[1].replace(/^([A-Z]) ([A-Z])$/, '$1$2').replace(/^MATH\/STAT$/, 'MATH');
  return `${dept} ${m[2]}`;
}

// ---------- fetching ----------

// Fetches each course (or page) on its own, so one bad one doesn't freeze the rest.
// A failed one keeps its last good items (from prev); the error carries the combined items to syncAll.
async function fetchEach(prev, parts, fetchPart) {
  const items = [];
  const errors = new Set();
  await Promise.all(parts.map(async (part) => {
    try {
      items.push(...await fetchPart(part));
    } catch (err) {
      errors.add(err.message);
      items.push(...prev.filter((i) => i.course === part.course));
    }
  }));
  if (errors.size) throw Object.assign(new Error([...errors].join('; ')), { items });
  return items;
}

module.exports = { SEATTLE, FETCH_TIMEOUT_MS, zoned, allDayIso, kindOf, codeKey, courseFromCode, fetchEach };
