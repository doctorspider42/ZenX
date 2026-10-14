#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# ZenX: runs a copy of the local build with its own profile root
# (~/Library/Application Support/zenx-demo), next to an installed ZenX and
# without touching its profiles. For trying out a change by hand.
#
#   scripts/zenx-demo.sh          # copy the current build and start it
#   scripts/zenx-demo.sh --reset  # same, from a fresh profile root (first run)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(ls -d "$REPO"/engine/obj-*/dist/*.app | head -1)"
DEMO_DIR="$HOME/Projects/ZenX-demo"
APP="$DEMO_DIR/ZenX Demo.app"
ROOT="$HOME/Library/Application Support/zenx-demo"

if pgrep -f "$APP/Contents/MacOS/" >/dev/null; then
  echo "ZenX Demo is running, quit it first." >&2
  exit 1
fi

if [ "${1:-}" = "--reset" ]; then
  rm -rf "$ROOT" "$HOME/Library/Caches/zenx-demo"
fi

# A full copy: the build's bundle links into the build directory.
mkdir -p "$DEMO_DIR"
rm -rf "$APP"
cp -RL "$BUILD" "$APP"

# The build's own application.ini, with a separate profile root and remoting
# name. Firefox only reads it when given with -app, from the browser folder.
INI="$APP/Contents/Resources/browser/zenx-demo.ini"
sed -e 's/^Profile=.*/Profile=zenx-demo/' -e 's/^RemotingName=.*/RemotingName=zenx-demo/' \
  "$APP/Contents/Resources/application.ini" >"$INI"

BINARY="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable)"
ZENX_APP_INI="$INI" nohup "$BINARY" -app "$INI" >/dev/null 2>&1 &
echo "Started ZenX Demo (profiles in $ROOT)"
