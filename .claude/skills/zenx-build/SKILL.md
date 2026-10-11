---
name: zenx-build
description: How to set up, build, run, test and lint ZenX/Zen locally on macOS (surfer, mach, Firefox source download, Rust toolchain quirks, fast incremental builds, mochitests and xpcshell tests). Use this whenever you need to build or run the browser, verify a change actually works, run tests, recover from build/configure errors, or when engine/ is missing or stale - even if the user only says "check that it works" or "run it".
---

# Building, running and testing ZenX

Run everything from the repo root unless noted. `engine/` is generated (see `zenx-codebase`).

## Which build do I need?

| You changed | Command | Time (M3 Pro) |
|---|---|---|
| JS/MJS/CSS/FTL/SVG files in `src/zen`, `src/zenx` (already symlinked into engine) | `cd engine && ./mach build faster` | ~1 min |
| a `.yaml` pref | `npm run ffprefs`, then `./mach build faster` | ~1 min |
| a `.patch` | `npm run import`, then `npm run build` (incremental) | 2-10 min |
| a new or changed `.ftl` | `python3 scripts/update_en_US_packs.py`, then `./mach build faster` | ~1 min |
| `moz.build`, `jar.mn`, C++, Rust | `npm run build` (incremental) | 3-15 min |
| added a **new file** under `src/` | `npm run import` first (engine files are per-file symlinks, a new file has none yet), then build | +1 min |
| fresh checkout / Firefox version bump | full setup below | 40-70 min |

If a newly added module is "missing" at runtime or in tests after `npm run build`, also run `./mach build faster` - it refreshes the `dist/*.app` bundle.

Don't start a full build to check a JS change - `./mach build faster` is enough. Long full builds are normal: one `rustc` process at 100% for 15+ minutes is `gkrust` (LTO), not a hang.

## Full setup from scratch

```bash
brew install gnu-tar rustup     # surfer needs gtar on macOS
rustup default stable
npm ci
npm run download                 # Firefox source → engine/ (version from surfer.json)
npm run import                   # prefs (cargo), apply src/ patches + files
python3 scripts/update_en_US_packs.py   # copy Zen/ZenX en-US strings into engine
npm run bootstrap                # mach toolchains (clang, sdk...) into ~/.mozbuild
npm run build
```

Set these before `npm run build` - Homebrew's rustup proxies break configure (`rustup which rustc` fails with "multiple input filenames"):

```bash
T=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin
export PATH="$T:/opt/homebrew/opt/rustup/bin:$PATH" RUSTC=$T/rustc CARGO=$T/cargo RUSTDOC=$T/rustdoc
```

`cargo` must be on PATH for `npm run import` (it runs `tools/ffprefs`).

## Running

```bash
npm start                         # = cd engine && ./mach run --noprofile (temporary profile)
cd engine && ./mach run -P zenx-dev   # a persistent named profile
```

The build output is `engine/obj-aarch64-apple-darwin/dist/Zen.app` (name from brand). Testing cross-profile features (ZenX profile spaces) needs a profile group: in the app menu → Profiles → New profile; each profile opens its own process/window.

## Tests

```bash
cd engine
./mach test zenx/tests                       # ZenX mochitests (browser.toml)
./mach test zenx/tests/unit                  # ZenX xpcshell (parsers, pure logic)
./mach test zen/tests/spaces                 # a Zen suite
npm test -- spaces                           # same via scripts/run_tests.py (Zen suites only)
./mach test zenx/tests/browser_zenx_arc_import.js --headless
```

xpcshell manifests that import `resource:///modules/...` (browser modules) need `firefox-appdir = "browser"` under `[DEFAULT]`, otherwise the module is "missing" and xpcshell crashes. New test folders must be listed in a `moz.build` (`BROWSER_CHROME_MANIFESTS` / `XPCSHELL_TESTS_MANIFESTS`) and need `npm run build` once before mach finds them. Pure logic → xpcshell (fast). Anything needing `gBrowser`/`gZenWorkspaces` → mochitest. Use sinon (`resource://testing-common/Sinon.sys.mjs`) to fake Firefox services such as `SelectableProfileService`.

## Lint / format

```bash
cd engine && ./mach lint zen zenx            # eslint + prettier + license (npm run lint covers only zen)
cd engine && ./mach lint --fix zenx
npx prettier --config engine/.prettierrc.js --write src/zenx/**/*.mjs   # quick format
npm run lc                                    # MPL license headers in src/
```

Mozilla style: 2 spaces, double quotes, `arrowParens: "avoid"`, `trailingComma: "es5"`. Every new source file starts with the MPL-2.0 header (tests: public domain header).

## Troubleshooting

- **configure: `configure.py` not found / missing files in engine** → the Firefox tarball download was truncated. `rm -rf engine .surfer/engine/*.tar.xz && npm run download && npm run import`.
- **`rustup which rustc` failed** → export `RUSTC`/`CARGO` as above.
- **`cargo: command not found` in import** → add rustup to PATH.
- **Warnings about `rust-objcopy` / `libLLVM.dylib`** → harmless.
- **`Missing chrome or resource URLs: resource:///modules/zenx/...` crash** → new file not imported (`npm run import`), app bundle stale (`./mach build faster`), or xpcshell manifest lacks `firefox-appdir = "browser"`.
- **Counting tabs in tests**: `gBrowser.tabs` only has the *active* space's pinned tabs; use `gZenWorkspaces.allStoredTabs` for every tab.
- **Strings show as ids / missing** → `python3 scripts/update_en_US_packs.py` then `./mach build faster`.
- **A Firefox file edit vanished** → it was made in `engine/` and not exported; edit again and `npx surfer export <path>`.
- **Slow machine during build** → Spotlight indexing `engine/`; the user can exclude it in System Settings → Spotlight → Privacy.
