#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# ZenX: renders the DMG window background (build/zenx-dmg/background.html)
# to build/zenx-dmg/background.png at 2x, with a temporary profile.
#
#   scripts/zenx-dmg-art.sh [path/to/Firefox-or-ZenX.app]

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$REPO/build/zenx-dmg"
APP="${1:-$(ls -d "$REPO"/engine/obj-*/dist/*.app | head -1)}"
BINARY="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable)"

PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT
echo 'user_pref("browser.shell.checkDefaultBrowser", false);' >"$PROFILE/user.js"

"$BINARY" --headless --no-remote --profile "$PROFILE" \
  --window-size=1360,880 --screenshot "$DIR/background.png" "file://$DIR/background.html"
# 144 dpi: Finder shows the 1360x880 image at 680x440 points, sharp on Retina.
sips -s dpiWidth 144 -s dpiHeight 144 "$DIR/background.png" >/dev/null
sips -g pixelWidth -g pixelHeight "$DIR/background.png" | tail -2
