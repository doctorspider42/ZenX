#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# ZenX: build, sign, notarize and publish a macOS (Apple Silicon) release on
# this Mac. Same result as .github/workflows/zenx-release.yml, much faster:
# the build is native and incremental.
#
#   scripts/zenx-release-local.sh               # build + publish origin/dev
#   scripts/zenx-release-local.sh --no-publish  # build, sign, notarize only
#
# It works in a separate checkout (default ~/Projects/ZenX-release, a git
# worktree of this repo at origin/dev), so release builds never mix with
# your development build.
#
# Needs, once:
#   brew install gh gnu-tar nss
#   Developer ID Application certificate (with its key) in the login keychain
#   xcrun notarytool store-credentials zenx-notary \
#     --key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer uuid>
#   The MAR signing key in the keychain (items "ZenX MAR private key" and
#   "ZenX MAR certificate", account "zenx", base64 PEM).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TREE="${ZENX_RELEASE_TREE:-$HOME/Projects/ZenX-release}"
GH_REPO="doctorspider42/ZenX"
NOTARY_PROFILE="${ZENX_NOTARY_PROFILE:-zenx-notary}"
PUBLISH=1
[ "${1:-}" = "--no-publish" ] && PUBLISH=0

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Mark: prerequisites

for tool in gh gtar certutil pk12util xcrun python3; do
  command -v "$tool" >/dev/null || die "$tool not found (brew install gh gnu-tar nss)"
done
IDENTITY="$(security find-identity -v -p codesigning | sed -nE 's/.*"(Developer ID Application: .*)"/\1/p' | head -1)"
[ -n "$IDENTITY" ] || die "No Developer ID Application certificate with its private key in the keychain"
APPLE_TEAM_ID="$(sed -E 's/.*\(([A-Z0-9]+)\)$/\1/' <<<"$IDENTITY")"
export APPLE_TEAM_ID
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 ||
  die "No notarytool credentials '$NOTARY_PROFILE', see the header of this script"
security find-generic-password -a zenx -s "ZenX MAR private key" >/dev/null 2>&1 ||
  die "MAR signing key not in the keychain"
[ "$PUBLISH" = 0 ] || gh auth status >/dev/null 2>&1 || die "gh is not logged in"

# Homebrew's rustup proxies break configure; use the toolchain directly.
RUST_BIN="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin"
if [ -x "$RUST_BIN/rustc" ]; then
  export PATH="$RUST_BIN:/opt/homebrew/opt/rustup/bin:$PATH" RUSTC="$RUST_BIN/rustc" CARGO="$RUST_BIN/cargo" RUSTDOC="$RUST_BIN/rustdoc"
fi

# Mark: source

step "Release checkout $TREE at origin/dev"
git -C "$REPO" fetch -q origin dev
if [ ! -d "$TREE" ]; then
  git -C "$REPO" worktree add --detach "$TREE" origin/dev
else
  git -C "$TREE" checkout -q --detach origin/dev
fi
cd "$TREE"
COMMIT="$(git rev-parse --short HEAD)"
json() { python3 -c "import json,sys; d=json.load(open('surfer.json')); print($1)"; }
VERSION="$(json "d['brands']['release']['release']['displayVersion']")"
FF_VERSION="$(json "d['version']['version']")"
echo "ZenX $VERSION (Firefox $FF_VERSION), commit $COMMIT, signing as $IDENTITY"

step "Dependencies"
npm ci --no-audit --no-fund --loglevel=error

# The Firefox version the source tree was downloaded for (Zen rewrites
# browser/config/version.txt, so that file can't tell).
STAMP=.surfer/zenx-engine-firefox-version
if [ -d engine ] && { [ ! -d engine/.git ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$FF_VERSION" ]; }; then
  step "No complete Firefox $FF_VERSION source tree, starting from a fresh one"
  rm -rf engine
fi
if [ ! -d engine/.git ]; then
  rm -f "$STAMP"
  step "Firefox $FF_VERSION source"
  mkdir -p .surfer/engine
  CACHED="$REPO/.surfer/engine/firefox-$FF_VERSION.source.tar.xz"
  [ -f "$CACHED" ] && cp "$CACHED" .surfer/engine/
  npm run download
  [ -d engine/.git ] || die "Downloading Firefox $FF_VERSION failed"
  echo "$FF_VERSION" >"$STAMP"
fi

step "Patches"
# Undo zenx-ci-prepare.sh from a previous release so Zen's patches re-apply.
git -C engine checkout -q HEAD -- \
  build/moz.configure/update-programs.configure \
  security/mac/hardenedruntime/production/firefox.browser.xml \
  tools/signing/macos/mach_commands.py
npm run surfer -- ci --brand release --display-version "$VERSION"
npm run import
bash scripts/zenx-ci-prepare.sh
bash scripts/mar_sign.sh -i
python3 scripts/update_en_US_packs.py >/dev/null
npm run bootstrap

# Mark: build

step "Build"
export ZEN_RELEASE=1 ZEN_GA_DISABLE_PGO=1 ZEN_DISABLE_LTO=1
npm run build </dev/null

step "Package"
OBJ="$TREE/engine/obj-aarch64-apple-darwin"
(cd engine && ./mach package)
STAGE="$OBJ/dist/zenx-release"
rm -rf "$STAGE" "$STAGE.work"
mkdir -p "$STAGE"
UNSIGNED_DMG="$(ls -t "$OBJ"/dist/*.dmg | head -1)"
(cd engine && ./mach python -m mozbuild.action.unpack_dmg "$UNSIGNED_DMG" "$STAGE")
APP="$(ls -d "$STAGE"/*.app | head -1)"
bash scripts/zenx-check-package.sh "$APP"

# Mark: sign and notarize

step "Sign the app"
(cd engine && ./mach macos-sign -v -c release -e production -s "$IDENTITY" -a "$APP")
codesign --verify --deep --strict --verbose=2 "$APP"

OUT="$TREE/release-out"
rm -rf "$OUT"
mkdir -p "$OUT"
DMG="$OUT/ZenX-$VERSION-macos-arm64.dmg"

step "DMG"
BRANDING="$TREE/engine/browser/branding/release"
(cd engine && ./mach python -m mozbuild.action.make_dmg \
  --volume-name "ZenX" \
  --background "$TREE/build/zenx-dmg/background.png" \
  --icon "$BRANDING/firefox.icns" \
  --dsstore "$TREE/build/zenx-dmg/dsstore" \
  "$STAGE" "$OUT/temp.dmg")
hdiutil convert "$OUT/temp.dmg" -quiet -format UDZO -imagekey zlib-level=9 -o "$DMG"
rm -f "$OUT/temp.dmg"
codesign -s "$IDENTITY" --timestamp "$DMG"

step "Notarize (Apple's queue usually takes a few minutes)"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$DMG"

# Mark: update

step "Update (MAR)"
MAR_TOOL="$OBJ/dist/host/bin/mar"
(cd engine && MAR="$MAR_TOOL" MOZ_PRODUCT_VERSION="$VERSION" MAR_CHANNEL_ID=release \
  ACCEPTED_MAR_CHANNEL_IDS=release ./tools/update-packaging/make_full_update.sh "$OUT/unsigned.mar" "$APP")
rm -rf "$APP.work"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/nss"
security find-generic-password -a zenx -s "ZenX MAR private key" -w | base64 -d >"$WORK/key.pem"
security find-generic-password -a zenx -s "ZenX MAR certificate" -w | base64 -d >"$WORK/cert.pem"
P12_PASSWORD="$(openssl rand -hex 16)"
certutil -N -d "$WORK/nss" --empty-password
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name mar_sig \
  -passout pass:"$P12_PASSWORD" -out "$WORK/key.p12"
pk12util -i "$WORK/key.p12" -d "$WORK/nss" -W "$P12_PASSWORD" -K "" >/dev/null
rm -f "$WORK/key.pem" "$WORK/key.p12"
DYLD_LIBRARY_PATH="$APP/Contents/MacOS" "$OBJ/dist/bin/signmar" -d "$WORK/nss" -n mar_sig -s "$OUT/unsigned.mar" "$OUT/macos.mar"
# macOS signmar verifies with the Security framework, from a DER file: the
# certificate embedded in the app's updater.
DYLD_LIBRARY_PATH="$APP/Contents/MacOS" "$OBJ/dist/bin/signmar" -D build/zenx-signing/public_key.der -v "$OUT/macos.mar"
rm -f "$OUT/unsigned.mar"

step "Update manifest"
BUILD_ID="$(sed -n 's/^BuildID=//p' "$APP/Contents/Resources/platform.ini")"
python3 - "$OUT" "$VERSION" "$FF_VERSION" "$BUILD_ID" <<'EOF'
import hashlib, os, sys
out, version, ff_version, build_id = sys.argv[1:]
mar = os.path.join(out, "macos.mar")
data = open(mar, "rb").read()
url = f"https://github.com/doctorspider42/ZenX/releases/download/zenx-{version}/macos.mar"
xml = f"""<?xml version="1.0"?>
<updates>
  <update type="minor" displayVersion="{version}" appVersion="{version}" platformVersion="{ff_version}" buildID="{build_id}">
    <patch type="complete" URL="{url}" hashFunction="sha512" hashValue="{hashlib.sha512(data).hexdigest()}" size="{len(data)}"/>
  </update>
</updates>
"""
open(os.path.join(out, "update.xml"), "w").write(xml)
print(xml)
EOF

if [ "$PUBLISH" = 0 ]; then
  step "Done, not published: $OUT"
  exit 0
fi

# Mark: publish

step "Publish GitHub Release zenx-$VERSION"
TAG="zenx-$VERSION"
FULL_COMMIT="$(git rev-parse HEAD)"
if gh release view "$TAG" -R "$GH_REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DMG" "$OUT/macos.mar" "$OUT/update.xml" --clobber -R "$GH_REPO"
else
  gh release create "$TAG" "$DMG" "$OUT/macos.mar" "$OUT/update.xml" -R "$GH_REPO" \
    --target "$FULL_COMMIT" --title "ZenX $VERSION" \
    --notes "ZenX $VERSION for macOS (Apple Silicon), based on Zen $VERSION. Signed and notarized; installed copies update automatically."
fi

step "Publish the update manifest (GitHub Pages)"
gh workflow run zenx-publish-manifest.yml -R "$GH_REPO" --ref dev -f tag="$TAG"
echo "Release: https://github.com/$GH_REPO/releases/tag/$TAG"
echo "Manifest deploy: https://github.com/$GH_REPO/actions/workflows/zenx-publish-manifest.yml"
