#!/bin/sh
# macOS / Linux launcher. Double-click (macOS: rename to start.command) or run ./start.sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get it from https://nodejs.org"; exit 1; }
echo "Keep this window open while you use the dashboard. Press Ctrl+C to stop."
exec node server.js --open
