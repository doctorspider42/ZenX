#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# ZenX: sanity checks on a packaged app before it is signed and shipped.
# Catches builds that compile fine but would be broken for users, like a
# release without Zen's English strings.
#
# Usage: scripts/zenx-check-package.sh path/to/ZenX.app

set -euo pipefail

APP="${1:?usage: $0 path/to/ZenX.app}"
OMNI="$APP/Contents/Resources/browser/omni.ja"
[ -f "$OMNI" ] || { echo "No browser/omni.ja in $APP" >&2; exit 1; }

LISTING="$(unzip -l "$OMNI" 2>/dev/null || true)"
missing=0
for entry in \
  "localization/en-US/browser/zen-workspaces.ftl" \
  "localization/en-US/browser/zenx-profiles.ftl" \
  "modules/zenx/ZenXProfileSpaces.sys.mjs" \
  "modules/zenx/arc/ZenXArcProfileMigrator.sys.mjs"; do
  if ! grep -q "$entry" <<<"$LISTING"; then
    echo "Missing from omni.ja: $entry" >&2
    missing=1
  fi
done

APPINI="$APP/Contents/Resources/application.ini"
grep -q "^Profile=zenx$" "$APPINI" || { echo "application.ini: profile root is not zenx" >&2; missing=1; }
grep -q "doctorspider42.github.io/ZenX" "$APPINI" || { echo "application.ini: update URL is not ZenX's" >&2; missing=1; }

[ "$missing" = 0 ] || exit 1
echo "Package looks complete: $APP"
