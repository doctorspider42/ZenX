#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# ZenX: restart the local build after `./mach build faster`.
# Quits every running profile (each one is its own process), clears the
# startup caches that would otherwise keep serving the old JS modules, and
# opens the app again.

set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)/engine/obj-aarch64-apple-darwin/dist/Nightly.app"
BIN="$APP/Contents/MacOS/zen"

if pgrep -f "$BIN" >/dev/null; then
  echo "Quitting running ZenX profiles..."
  pkill -TERM -f "$BIN" || true
  for _ in $(seq 1 50); do
    pgrep -f "$BIN" >/dev/null || break
    sleep 0.2
  done
  if pgrep -f "$BIN" >/dev/null; then
    echo "ZenX is still running, close it with Cmd+Q and try again." >&2
    exit 1
  fi
fi

rm -rf "$HOME/Library/Caches/zen/Profiles/"*/startupCache
echo "Startup caches cleared."

open "$APP"
