# ZenX

ZenX is a fork of [Zen Browser](https://github.com/zen-browser/desktop) that tracks upstream daily.

## Keeping up with Zen

`.github/workflows/zenx-sync-upstream.yml` runs every day at 04:17 UTC and can also be started by hand.

1. It merges `zen-browser/desktop@dev` into a fresh `zenx/upstream-sync` branch made from our `dev`.
2. It opens a PR into `dev`, or updates the one that is already open. Zen's `pr-test.yml` then runs on that PR: it downloads Firefox, applies every patch and lints.
3. If the merge has conflicts, the job fails and opens an issue labelled `upstream-sync-conflict` that lists the conflicting files. If such an issue is already open, it adds a comment instead.

The workflow needs a `SYNC_PAT` repository secret. Use a fine-grained token for this repository with read and write access to Contents, Pull requests, Issues and Workflows.

Zen's own scheduled and internal workflows (Twilight releases, Discord pings, issue metrics and labelling, Firefox and external patch syncs) are switched off in the GitHub Actions settings. Their files are unchanged so that merges stay clean.

### Keeping merges painless

- Put ZenX code in `src/zenx/`, `prefs/zenx/` and `locales/*/browser/browser/zenx-*.ftl`.
- Change Zen files only to add a hook, and mark the hook with a `ZenX` comment.
- Don't edit Zen's `.patch` files. When a Firefox file needs changing, write a new patch.

Zen files that ZenX changes today:

| File | Change |
| --- | --- |
| `README.md` | ZenX section at the top, above Zen's README (kept there so upstream edits to Zen's text merge cleanly) |
| `src/zen/moz.build` | builds `../zenx` |
| `src/zen/common/ZenPreloadedScripts.js` | loads `ZenXProfileSpacesUI.mjs` in browser windows |
| `src/zen/zen.globals.mjs` | lint global `gZenXProfileSpaces` |
| `src/zen/share/ZenShareManager.mjs` | public `importSpace(item)`, which returns the new space |
| `src/zen/common/modules/ZenUpdates.mjs` | bug fix: `playWindowSweepAnimation` runs one sweep at a time, animates its own elements (not by id), always removes them and never takes clicks. Importing several spaces at once used to leave full-window overlays that swallowed every click ("frozen" browser). Worth sending upstream. |
| `src/zen/folders/ZenFolders.mjs` | bug fix: a folder's empty tab belongs to the folder's space. Without it, a folder created in a space that isn't active came back in the active space after a restart. Worth sending upstream. |
| `prefs/firefox/browser.yaml` | `browser.profiles.enabled = true` |
| `surfer.json` | ZenX name, vendor, app id, binary name `zenx`, release brand names, GitHub repo, update host (see Identity) |
| `/mozconfig` (new, tracked with `git add -f` because Zen ignores it) | app name, bundle id, source repo (see Identity) |
| `src/testing/xpcshell/runxpcshelltests-py.patch` (Zen's patch, one line) | also map `zenx-appdir` to `firefox-appdir`, so xpcshell tests find the browser modules under the app name zenx |
| `src/browser/moz-configure.patch` (new Firefox patch) | profile root `zenx` (`MOZ_APP_PROFILE` can only be implied, not set in a mozconfig), and a `MOZ_APPUPDATE_HOST` option so surfer.json's update host reaches the build |
| `src/browser/components/migration/MigrationUtils-sys-mjs.patch` (new Firefox patch) | registers the Arc migrator |
| `src/browser/locales/en-US/browser/migrationWizard-ftl.patch` (new Firefox patch) | the "Arc" name in the import wizard |

## Identity

ZenX installs and runs next to Zen. Each has its own profiles and its own updates.

| | Zen | ZenX |
| --- | --- | --- |
| App (release build) | Zen.app | ZenX.app (local builds: Nightly.app) |
| Binary | `zen` | `zenx` |
| Profiles | `~/Library/Application Support/zen` | `~/Library/Application Support/zenx` |
| Bundle id | `app.zen-browser.zen` | `com.doctorspider42.zenx` |
| Remoting name | `zen…` | `zenx…` (ZenX and Zen never forward command lines to each other) |
| Updates | updates.zen-browser.app | `https://doctorspider42.github.io/ZenX/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml` |

Where each setting comes from:

- **Surfer appends `/mozconfig` after Zen's mozconfigs**, so its settings win: app name and basename, `--with-distribution-id=com.doctorspider42`, `MOZ_MACBUNDLE_ID=zenx`, and the source repo.
- **`surfer.json`** provides the brand names of release builds and the update host. Only a few lines change there, and upstream rarely touches them.
- **The profile root** is set by `imply_option("MOZ_APP_PROFILE", "zenx")` in `src/browser/moz-configure.patch`.

Icons are still Zen's for now (`configs/branding`).

## Spaces bound to profiles

As in Arc, every space belongs to a profile. Extensions, history, cookies, logins and bookmarks are shared by the spaces of one profile and by nothing else.

A Firefox profile is a separate process: Firefox cannot run two profiles in one process the way Chromium can. ZenX therefore builds on Firefox's own profile groups (`SelectableProfileService`):

- **One switcher for every profile.** Each running profile publishes a summary of its spaces (uuid, name, icon) to the profile group as the shared pref `zenx.profile-spaces.registry.<profileId>`. The sidebar switcher shows the spaces of all profiles in **one shared order** (`zenx.profile-spaces.order`), so it looks the same in every profile's window. Spaces of other profiles are marked with a bar in that profile's color. Dragging a space reorders it for every profile, and a moved space keeps its place.
- **Switching to another profile's space** brings that profile's window to the front on that space. ZenX sends `--zenx-space <uuid>` (`src/zenx/ZenXCommandLine.sys.mjs`). That handler runs before Firefox's and Zen's and uses up the whole command line, including the `--profile` leftovers of a relaunch, so no extra window opens. If the profile isn't running, it is started on that space.
- **Space menu → Set Profile → profile / New Profile…** (as in Arc: every profile is listed, with the space's own one checked) sends the space to the chosen profile through `zenx.profile-spaces.handoff.<targetProfileId>`. The space's name, icon, theme, pinned and normal tabs, folders and split views all go with it. The target imports the space and publishes it with `movedFrom`. Only when this profile sees that does it close its own copy. Until then the space is shown faded, and the same menu has "Cancel Move".
- Zen's own per-space "Set Profile" picker, which actually sets a **container**, is hidden (with the `hidden` attribute, because macOS context menus are native and ignore CSS) from the space menu and the space creation form while profiles are on. Containers still work for tabs.
- **New Profile…** creates the profile before it first starts. It ends up holding only the moved space: Zen's empty starter space is removed once the moved space arrives. Zen's welcome screen and "updated" popup are skipped there, and the profile editor (`about:editprofile`: name, avatar, theme) opens on its first start.
- Firefox's startup profile picker is turned off: ZenX starts in the last used profile, and new profiles are made from a space.
- Values shared between profiles are ASCII-only JSON (`toSharedJSON`). Firefox copies shared prefs as bytes, which breaks emoji and non-English text.
- Firefox's own profile UI is hidden: the Profiles button in the app menu, the Profiles menu in the macOS menu bar (native, so it is kept `hidden` with a MutationObserver - CSS doesn't reach it), and the profile section of the account panel. The space menu's **Set Profile → Edit This Profile…** opens `about:editprofile` (name, avatar, theme, delete).

What does not move: essentials (they belong to the profile and container, not the space), and tabs of extension pages, `about:blank`, `blob:` and `data:` URLs. The confirmation dialog says how many tabs will be dropped.

Code: `src/zenx/ZenXProfileSpaces.sys.mjs` (the per-process service) and `src/zenx/ZenXProfileSpacesUI.mjs` (the per-window UI). Tests are in `src/zenx/tests/`; run them with `cd engine && ./mach test zenx/tests`.

Turn the feature off with `zenx.profile-spaces.enabled = false`.

## Import from Arc

In the spirit of Zen's own importers, **Arc** appears in the import wizard on macOS: in Zen's welcome screen, and in Settings → Import Browser Data. It works like the importers for other Chromium browsers, so history and form data come over the usual way. Logins too, after macOS asks permission to read "Arc Safe Storage" from the Keychain. On top of that, Arc's sidebar becomes Zen:

| Arc | ZenX |
| --- | --- |
| space (name, emoji, color) | space (name, icon, gradient theme) |
| pinned tab | **pinned tab** of that space, not a bookmark |
| folder, nested folders | folder |
| split view | split view |
| unpinned ("Today") tab | normal tab |
| favorite (top app) | essential |

- Arc profiles map to ZenX profiles. The Arc profile picked in the wizard goes into the ZenX profile with the same name. If there is none, Arc's default profile goes into the current profile, and any other Arc profile (e.g. "Work") gets a new ZenX profile with its name. Everything picked in the wizard (spaces, history, logins…) is imported inside that profile, so one Arc profile's history never lands in another's. The wizard sends the import through a handoff (`import` instead of `space`), the target profile runs the same migrator, and it reports the counts back in `zenx.profile-spaces.import-result.<handoffId>`.
- Arc keeps several sidebar containers with spaces (newer versions put Little Arc's in one of its own). All of them are read. Little Arc's untitled space with no pinned tabs is left out.
- Importing again skips spaces that were already imported (`workspace.zenxArcId`) and favorites that are already essentials.
- Not imported: easels, notes and other Arc-only items, `arc://` pages, Arc's SF Symbol space icons, and Arc's Chromium bookmarks if Arc has none (this is the usual case).

The wizard lists Arc because `prefs/zenx/arc.yaml` sets `browser.migrate.arc.enabled`. The code is in `src/zenx/arc/`. `ZenXArcSidebar.sys.mjs` is a pure parser of `~/Library/Application Support/Arc/StorableSidebar.json`. `ZenXArcImporter.sys.mjs` creates the result in a window, reusing `gZenShareManager.importSpace`. `ZenXArcProfileMigrator.sys.mjs` is the wizard entry and subclasses `ChromeProfileMigrator`. Tests: `src/zenx/tests/unit/test_zenx_arc_sidebar.js` and `src/zenx/tests/browser_zenx_arc_import.js`, which use a synthetic fixture.

## End-to-end tests

`src/zenx/tests/e2e/zenx_e2e.py` drives the real built app over Marionette, the way a user runs it:

- Normal start, without `--profile`. Each scenario gets its own profile root and remoting name through a test `application.ini` passed with `-app`, so it never touches or talks to your own ZenX.
- Zen's production startup and animations, not the mochitest testing mode.
- Quits like Cmd+Q, and restarts.
- Controls several profile processes at once.
- Uses synthetic Arc data (`ZENX_ARC_DATA_DIR`), generated in the shape of a real sidebar: several spaces, nested folders, a split view, unpinned tabs, favorites, a Little Arc container, and a second Arc profile that is imported into a ZenX profile of its own.
- Fails if anything covers the window after an import (`ui_responsive`).

Scenarios:

- first run
- import into an empty profile, then two restarts
- import with existing data, and importing twice
- New Profile from a space, switching between profiles, and moving a space to an existing profile
- deleting a profile
- restarting with two profiles, with Polish characters and emoji

Run them after a build:

```bash
cd engine && ./mach python zenx/tests/e2e/zenx_e2e.py
```

Add `-k <name>` to run one scenario and `--headed` to watch the windows.

## Releases and updates (macOS)

`.github/workflows/zenx-release.yml` builds, signs, notarizes and publishes ZenX for Apple Silicon. Start it from Actions (workflow_dispatch on `dev`) or by pushing a tag `zenx-build-<n>`. It has three jobs:

1. **build** (Linux) cross-compiles ZenX for macOS the way Zen's CI does, without LTO or PGO so it fits a free runner. It ships English only for now.
2. **sign** (macOS) signs the app with the Developer ID certificate (`mach macos-sign`), makes the DMG, notarizes and staples it, builds the update MAR from the signed app, and signs the MAR with ZenX's key.
3. **publish** creates the GitHub Release `zenx-<version>` (DMG and `macos.mar`) and puts the update manifest on GitHub Pages at `https://doctorspider42.github.io/ZenX/updates/browser/Darwin_aarch64-gcc3/release/update.xml`.

`<version>` is Zen's display version from `surfer.json`. A new build for the same version replaces the release files, and installed copies update because the build id is newer.

`scripts/zenx-ci-prepare.sh` runs only in CI, after `npm run import`, and adapts Zen's release build. Each step fails loudly if Zen changes what it relies on:

- puts our Apple Team ID where Zen hardcodes its own;
- drops the entitlements that need a provisioning profile (application identifier and platform passkeys);
- makes `macos-sign` work without a provisioning profile;
- uses ZenX's MAR certificate (`build/zenx-signing/public_key.der`) instead of Zen's.

Secrets:

- Apple: `APPLE_TEAM_ID`, `APPLE_DEVELOPER_ID_P12_BASE64`, `APPLE_DEVELOPER_ID_P12_PASSWORD`, `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`.
- MAR signing: `ZENX_MAR_CERT_PEM_BASE64`, `ZENX_MAR_PRIVATE_KEY_PEM_BASE64`, `ZENX_MAR_PASSWORD`.

**The MAR private key cannot be replaced.** Installed copies only accept updates signed with it. If it is lost, every user has to reinstall by hand.

### Releasing from a Mac (faster)

`scripts/zenx-release-local.sh` produces the same release on this Mac: a native, incremental build, then signing, notarization, the MAR and the manifest. It takes about 40 minutes the first time and a few minutes after that; CI needs about 2.5 hours.

- It works in a separate git worktree, `~/Projects/ZenX-release` at `origin/dev`, so release builds never touch the development build.
- It publishes the GitHub Release, including `update.xml`, and then starts `.github/workflows/zenx-publish-manifest.yml`. That workflow puts the manifest on GitHub Pages, which can only be deployed from Actions.
- `--no-publish` stops after notarization.

One-time setup:

- `brew install gh gnu-tar nss`.
- The Developer ID certificate, with its private key, in the login keychain.
- Notarization credentials: `xcrun notarytool store-credentials zenx-notary --key AuthKey_….p8 --key-id … --issuer …`.
- The MAR key in the keychain, as the items "ZenX MAR private key" and "ZenX MAR certificate" (account `zenx`, base64 PEM).

`scripts/zenx-check-package.sh` checks a packaged app before it is signed: Zen's and ZenX's strings, ZenX modules, profile root and update URL. CI and the local script both run it.
