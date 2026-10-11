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
| `src/zen/moz.build` | builds `../zenx` |
| `src/zen/common/ZenPreloadedScripts.js` | loads `ZenXProfileSpacesUI.mjs` in browser windows |
| `src/zen/zen.globals.mjs` | lint global `gZenXProfileSpaces` |
| `src/zen/share/ZenShareManager.mjs` | public `importSpace(item)`, which returns the new space |
| `prefs/firefox/browser.yaml` | `browser.profiles.enabled = true` |
| `src/browser/components/migration/MigrationUtils-sys-mjs.patch` (new Firefox patch) | registers the Arc migrator |
| `src/browser/locales/en-US/browser/migrationWizard-ftl.patch` (new Firefox patch) | the "Arc" name in the import wizard |

## Spaces bound to profiles

As in Arc, every space belongs to a profile. Extensions, history, cookies, logins and bookmarks are shared by the spaces of one profile and by nothing else.

A Firefox profile is a separate process: Firefox cannot run two profiles in one process the way Chromium can. ZenX therefore builds on Firefox's own profile groups (`SelectableProfileService`):

- **One switcher for every profile.** Each running profile publishes a summary of its spaces (uuid, name, icon) to the profile group as the shared pref `zenx.profile-spaces.registry.<profileId>`. The sidebar switcher shows this profile's spaces, then a divider, then the spaces of each other profile with that profile's avatar on them.
- **Switching to another profile's space** brings that profile's window to the front on that space (`--space <uuid>`). If the profile isn't running, it is started.
- **Space menu → Set Profile → profile / New Profile…** (as in Arc: every profile is listed, with the space's own one checked) sends the space to the chosen profile through `zenx.profile-spaces.handoff.<targetProfileId>`. The space's name, icon, theme, pinned and normal tabs, folders and split views all go with it. The target imports the space and publishes it with `movedFrom`. Only when this profile sees that does it close its own copy. Until then the space is shown faded, and the same menu has "Cancel Move".
- Zen's own per-space "Set Profile" picker, which actually sets a **container**, is hidden from the space menu and the space creation form while profiles are on. Containers still work for tabs.
- Profiles themselves (creating, renaming, avatars, deleting) are managed in Firefox's profile menu in the app menu and at `about:profilemanager`.

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

- Only the spaces and favorites of the Arc profile picked in the wizard are imported. To match Arc profiles to ZenX profiles, run the import once in each ZenX profile.
- Importing again skips spaces that were already imported (`workspace.zenxArcId`) and favorites that are already essentials.
- Not imported: easels, notes and other Arc-only items, `arc://` pages, Arc's SF Symbol space icons, and Arc's Chromium bookmarks if Arc has none (this is the usual case).

The wizard lists Arc because `prefs/zenx/arc.yaml` sets `browser.migrate.arc.enabled`. The code is in `src/zenx/arc/`. `ZenXArcSidebar.sys.mjs` is a pure parser of `~/Library/Application Support/Arc/StorableSidebar.json`. `ZenXArcImporter.sys.mjs` creates the result in a window, reusing `gZenShareManager.importSpace`. `ZenXArcProfileMigrator.sys.mjs` is the wizard entry and subclasses `ChromeProfileMigrator`. Tests: `src/zenx/tests/unit/test_zenx_arc_sidebar.js` and `src/zenx/tests/browser_zenx_arc_import.js`, which use a synthetic fixture.
