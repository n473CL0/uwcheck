<p align="center">
  <img src="public/icon.svg" alt="UWCheck logo" width="96">
</p>

<h1 align="center">UWCheck</h1>

<p align="center">
  <b>One calendar and to-do list for every UW deadline: Canvas, Ed and CSE course websites.</b>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <img alt="UWCheck showing a month calendar of deadlines next to a to-do list" src="docs/screenshot-light.png">
</picture>

## Install

1. Install [Node.js](https://nodejs.org) (the LTS download).
2. Open a terminal and run:

   ```sh
   npx uwcheck
   ```

3. Your browser opens at <http://localhost:7351> with **Settings**. Fill in:
   - **Canvas calendar feed URL:** in Canvas, open **Calendar**, click **Calendar Feed** (bottom right), and copy the link.
   - **Ed API token** *(optional)*: create one at [edstem.org → Settings → API Tokens](https://edstem.org/us/settings/api-tokens).
4. Click **Save & sync**.

Keep the terminal open while you use it. <kbd>Ctrl</kbd>+<kbd>C</kbd> stops it.

### Or: install it as an app

Get a clickable UWCheck icon (Start menu / desktop on Windows, `~/Applications` on macOS, app launcher on Linux) that runs in the background, no terminal needed:

```sh
npm install -g uwcheck
uwcheck --install
```

| Command | What it does |
|---|---|
| `npm install -g uwcheck@latest` | Update. A running app switches to the new version within a minute. |
| `uwcheck --stop` | Stop the background server. |
| `uwcheck --uninstall` | Remove the app icon. Your settings are kept. |
| `uwcheck --help` | All options (`--port`, `--no-open`, ...). |

When an update is out, an **Update** button appears in the header.

## Optional: course websites

UW CSE courses often list work on their `assignments.html` page before it's released on Ed. Add them under **Settings → Advanced**, one per line:

```
https://courses.cs.washington.edu/courses/cse351/26au/assignments.html = CSE 351
```

The same panel lets you limit or rename Ed and Canvas courses (`course id = name`).

## Privacy

Everything runs on your computer and listens only on `127.0.0.1`. Your Canvas feed URL and Ed token are saved in `~/.uwcheck/config.json` and sent only to Canvas and Ed. Treat that folder like a password.

## Running from source

```sh
git clone https://github.com/n473CL0/uwcheck.git
cd uwcheck
npm start
```

## License

[MIT](LICENSE). Bundled fonts are under the [SIL Open Font License](public/fonts/OFL.txt). Not affiliated with the University of Washington, Instructure or Ed.
