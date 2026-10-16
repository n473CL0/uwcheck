# Contributing to UWCheck

Thanks for helping. UWCheck is for **UW students** for now, so new data sources should be tools UW courses actually use.

The most useful contribution is a **new data source**: another place UW courses post deadlines. Check the [`new source`](https://github.com/n473CL0/uwcheck/labels/new%20source) issues first, or open one to say what you're building.

## Run it from source

You need Node.js 18 or newer. There's nothing to install.

```sh
git clone https://github.com/n473CL0/uwcheck.git
cd uwcheck
npm test
```

To try your changes, run on a spare port with a separate data folder, so you don't touch your real settings or an installed copy:

```sh
# macOS / Linux
UWCHECK_DATA=~/.uwcheck-dev node server.js --port 7352
```

```powershell
# Windows PowerShell
$env:UWCHECK_DATA = "$HOME\.uwcheck-dev"; node server.js --port 7352
```

- **Changed `public/index.html`?** Refresh the browser. There's no build step. Then run `npm run smoke`, which clicks through the page in headless Chrome (it needs Chrome and Node 22+).
- **Changed `server.js` or a source?** Stop the server with Ctrl+C and start it again.

## Ground rules

- **No dependencies.** `npx uwcheck` has to start instantly and leave nothing to audit. Use Node's built-ins (`fetch`, `node:test`, `Intl`).
- **Your data goes only to the service it came from.** The Canvas feed URL goes only to Canvas, the Ed token only to Ed. Nothing goes to us or anyone else.
- **Logins:** API tokens, calendar feeds and public pages are fine. **Never ask for a UW NetID password or browser cookies.** A source that needs them won't be merged.
- **Match the code around you:** two-space indent, single quotes, semicolons, and comments that explain *why*, not *what*.
- **Keep pull requests focused:** one source or one fix per pull request.

## Add a data source

A source is one file in `sources/` plus one test file next to it. Copy [`sources/site.js`](sources/site.js) (a public page) or [`sources/ed.js`](sources/ed.js) (an API with a token) as a starting point.

### 1. `sources/<name>.js`

```js
'use strict';
const { FETCH_TIMEOUT_MS, kindOf, courseFromCode } = require('./common');

// Pure: turns what the service returned into items. This is what your test covers.
function parseThing(body) {
  return body.assignments.map((a) => ({
    id: `thing:${a.id}`, // stable across syncs: ticks are saved against it
    source: 'thing',
    course: courseFromCode(a.courseName), // "CSE 351 A Au 26" -> "CSE 351"
    title: a.name,
    kind: kindOf(a.name),
    due: new Date(a.dueAt).toISOString(),
    url: a.link,
  }));
}

async function fetchThing(config, prev) {
  if (!config.thingToken) return null; // null = not set up, so the dashboard shows "Not connected"
  const res = await fetch('https://api.thing.example/assignments', {
    headers: { Authorization: `Bearer ${config.thingToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // always set a timeout
  });
  if (!res.ok) throw new Error(`Thing returned HTTP ${res.status}`); // users see this message
  return parseThing(await res.json());
}

module.exports = {
  name: 'thing', // same as the file name and every item's `source`
  label: 'Thing', // shown on the status pill and the "Thing ↗" links
  config: { thingToken: '' }, // your settings and their defaults, saved in ~/.uwcheck/config.json
  secrets: ['thingToken'], // never sent to the page; it sees hasThingToken instead
  fetch: fetchThing,
  parseThing,
};
```

**Items** have these fields:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `<name>:<id from the service>`. Must stay the same across syncs. |
| `source` | yes | Your source's `name`. |
| `course` | yes | Short code such as `CSE 351`. Use `courseFromCode`. |
| `title` | yes | As the course shows it. |
| `kind` | yes | `kindOf(title)` picks Homework, Lab, Reading, Quiz, Exam and so on. |
| `due` | yes | ISO string in UTC. For a Seattle wall-clock time, use `zoned(y, mo, d, h, mi, SEATTLE)`. |
| `allDay` | no | `true` for date-only items. Use `allDayIso(y, mo, d)` for `due`. |
| `url` | no | Link to the item itself. |
| `completed` | no | `true` if the service knows it's done. The user can still untick it. |
| `tentative` | no | `true` if the date may still change (not released yet). |

`sources/common.js` has the helpers. If you fetch one page or course at a time, wrap the loop in `fetchEach(prev, parts, fetchPart)`, so a failing course keeps its last good items and the others still update.

### 2. Register it

Add `require('./sources/<name>')` to `SOURCES` near the top of `server.js`. The order there is the order of the status pills.

### 3. `sources/<name>.test.js`

Test your parse function on a **small, real sample** of what the service returns, with names, IDs and tokens replaced. See [`sources/canvas.test.js`](sources/canvas.test.js). `npm test` picks it up automatically and also checks that your module follows the shape above.

### 4. Options

Add a field for each setting to **Options → Your courses** in `public/index.html` (`#pane-courses`, under a heading for your source): the input, the line that fills it in `openOptions()`, and the line that sends it in the form's `submit` handler. For a secret, follow how `edToken` works: leave the input blank to keep the saved value, and use `clearEdToken` to remove it. The server only saves settings your source lists in `config`, and only when the type matches the default.

### 5. README

Add a short "how to connect" note under **Install** or **Optional**.

## Before you open a pull request

- `npm test` passes, and `npm run smoke` too if you changed the page.
- You ran it with real data (in your dev folder) and the items land on the right days.
- No tokens, feed URLs or classmates' names in the code, tests or screenshots.

If you add a file under `public/`, also add it to `files` in `package.json` and to `STATIC` in `server.js`.

## Releases

Only the maintainer publishes. Pushing a `v*` tag runs `.github/workflows/publish.yml`, which publishes to npm. Pull requests can't trigger it.
