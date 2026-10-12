#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# ZenX: adapts Zen's release build to ZenX's signing, in CI only, after
# `npm run import`. Doing it here instead of in Zen's patches keeps upstream
# merges conflict free. Every step fails loudly when Zen changes what it
# relies on, so a broken assumption shows up as a red build, not a broken app.
#
# Needs APPLE_TEAM_ID.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="$ROOT/engine"

if [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo "APPLE_TEAM_ID is not set" >&2
  exit 1
fi

# 1. The updater only installs updates signed by the same Apple team as the
#    running app. Zen hardcodes its own team id.
CONFIGURE="$ENGINE/build/moz.configure/update-programs.configure"
ZEN_TEAM_ID="9V5K9TP787"
grep -q "$ZEN_TEAM_ID" "$CONFIGURE" || {
  echo "Zen's team id not found in $CONFIGURE, check the requirement string" >&2
  exit 1
}
sed -i.bak "s/$ZEN_TEAM_ID/$APPLE_TEAM_ID/g" "$CONFIGURE" && rm "$CONFIGURE.bak"
echo "Team id set to $APPLE_TEAM_ID in update-programs.configure"

# 2. ZenX ships without a provisioning profile, so it can't use entitlements
#    that need one: the application identifier and platform passkeys.
python3 - "$ENGINE/security/mac/hardenedruntime/production/firefox.browser.xml" <<'EOF'
import re
import sys

path = sys.argv[1]
text = open(path).read()
patterns = [
    r"\s*<!--[^>]*public-key-credential[^>]*-->",
    r"\s*<key>com\.apple\.application-identifier</key>\s*<string>[^<]*</string>",
    r"\s*<!--[^>]*passkey[^>]*-->",
    r"\s*<key>com\.apple\.developer\.web-browser\.public-key-credential</key>\s*<true/>",
]
for pattern in patterns[1::2]:
    if not re.search(pattern, text):
        sys.exit(f"Expected entitlement not found in {path}: {pattern}")
for pattern in patterns:
    text = re.sub(pattern, "", text)
open(path, "w").write(text)
print(f"Removed provisioning-profile entitlements from {path}")
EOF

# 3. Zen's macos-sign always embeds a provisioning profile; make it optional.
SIGN="$ENGINE/tools/signing/macos/mach_commands.py"
python3 - "$SIGN" <<'EOF'
import sys

path = sys.argv[1]
text = open(path).read()
old = "    os.rename(originProfile, endProfile)\n"
new = "    if os.path.exists(originProfile):\n        os.rename(originProfile, endProfile)\n"
if old not in text:
    sys.exit(f"Provisioning profile handling changed in {path}")
open(path, "w").write(text.replace(old, new, 1))
print(f"Made the provisioning profile optional in {path}")
EOF

# 4. Updates must be signed with ZenX's MAR key, not Zen's. Zen's
#    scripts/mar_sign.sh -i (run by release-build.sh) embeds this file.
cp "$ROOT/build/zenx-signing/public_key.der" "$ROOT/build/signing/public_key.der"
echo "Using ZenX's MAR signing certificate"
