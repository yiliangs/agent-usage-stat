#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

pause_on_error() {
  echo ""
  echo "Agent Usage Stat did not start. Review the message above."
  read -r -p "Press Enter to close..."
}
trap pause_on_error ERR

# Finder-launched shells can miss Homebrew's PATH entries.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install it from https://nodejs.org and try again."
  false
fi

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" || {
  echo "Your Node.js version is too old. Install Node.js 20 or newer and try again."
  false
}

if lsof -ti tcp:4179 >/dev/null 2>&1; then
  echo ""
  echo "Agent Usage Stat is already running at http://127.0.0.1:4179."
  open "http://127.0.0.1:4179"
  exit 0
fi

echo ""
echo "Starting Agent Usage Stat at http://127.0.0.1:4179..."
echo "Keep this window open while using the fallback server."
echo ""
trap - ERR
node "../bin/agent-usage-stat.js" portal --port 4179
