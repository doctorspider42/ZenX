---
name: zenx-new-feature
description: The workflow and rules for adding or changing a feature in ZenX (our fork of Zen Browser) so it stays easy to merge with upstream Zen every day - where to put code, how to hook into Zen, how to change Firefox files, prefs, strings, tests, docs and the PR. Use this whenever the user asks to add, build, implement, change or fix a feature/behavior in the browser (UI, spaces, tabs, profiles, importers, settings), even for small tweaks.
---

# Adding a feature to ZenX

ZenX merges `zen-browser/desktop` into `dev` every day (`zenx-upstream-sync` skill). Every line we change in a Zen or Firefox file is a future merge conflict, so the design goal is: **our code lives in our files; Zen/Firefox files only get small, marked hooks.** Read `zenx-codebase` first if you don't know the layout yet.

## 1. Understand before writing

- Find the Zen feature you're extending in `src/zen/<feature>/` and read its manager class; Zen already has most building blocks (space import/export in `src/zen/share`, essentials, folders, split view, session store, command line `--space`).
- Check whether Firefox already does the hard part (`engine/browser/components/...`) - e.g. profiles (`SelectableProfileService`), migration (`ChromeProfileMigrator`). Subclassing/reusing Firefox code beats patching it.
- Prefer composition: listen to events (`ZenWorkspaceDataChanged`, `ZenWorkspacesUIUpdate`, `popupshowing`), add DOM at runtime, call public methods. Only if a needed method is private (`#foo`), add a tiny public wrapper in the Zen file.

## 2. Where code goes

| What | Where |
|---|---|
| Feature code | `src/zenx/<feature>/` or `src/zenx/ZenX<Feature>.sys.mjs` (process-wide) / `ZenX<Feature>UI.mjs` (per window) |
| Registration | `src/zenx/moz.build` (`EXTRA_JS_MODULES.zenx[.<sub>]`), `src/zenx/jar.mn` (CSS/SVG → `chrome://browser/content/zenx/`) |
| Loading a window module | one line in the `scripts` array of `src/zen/common/ZenPreloadedScripts.js` (marked `// ZenX`) |
| Prefs | `prefs/zenx/<feature>.yaml`, names `zenx.<feature>.*`, include an `enabled` kill switch. Firefox features often have their own gate pref too (e.g. a migrator is only listed when `browser.migrate.<key>.enabled` is true) - test through the real entry point, not just the module |
| Strings | `locales/en-US/browser/browser/zenx-<feature>.ftl` (+ `locales/pl/...`), ids `zenx-*`, load with `document.l10n.addResourceIds`; after adding a file run `python3 scripts/update_en_US_packs.py` |
| Settings UI | Zen's settings live in `src/browser/components/preferences/zen-settings.js` + `*.inc.xhtml`: register the pref like the existing `zen.workspaces.*` ones and add a `<checkbox preference=...>` - both are Zen files, so keep it to a marked hook and list it in `docs/zenx.md`; strings for settings go in an ftl the preferences page loads |
| Styles | `src/zenx/zenx-<feature>.css`, loaded with `windowUtils.loadSheetUsingURIString(url, AUTHOR_SHEET)` |
| Firefox file change | edit in `engine/`, then `npx surfer export <path>` → new `src/<path>-<ext>.patch`; keep it a few lines and point it at a module in `src/zenx` |
| Tests | `src/zenx/tests/` (mochitest `browser.toml`), `src/zenx/tests/unit/` (xpcshell) |

Hooks into Zen files carry a `ZenX` comment and are listed in the table in `docs/zenx.md`. Avoid editing Zen's existing `.patch` files: a ZenX change inside a Zen patch conflicts on almost every upstream update. If you must change a Firefox file Zen already patches, prefer a hook elsewhere (a Zen/ZenX module, an event); if it's really impossible, keep the change tiny, list it in `docs/zenx.md`, and mention it prominently in the PR.

## 3. Implementation habits that matter here

- Wait for `gZenWorkspaces.promiseInitialized`; bail out on `gZenWorkspaces.privateWindowOrDisabled`.
- Data you add to a space object (`workspace.zenxFoo`) persists via the session store; name it `zenx*`.
- Never lose user data: when moving/deleting things across profiles or imports, keep the source until the destination confirms (see the handoff pattern in `ZenXProfileSpaces.sys.mjs`), and make imports idempotent (remember source ids).
- Don't put personal data (URLs, names) from the user's real browser profiles into tests, fixtures, logs or chat; use synthetic fixtures.
- Write the code like Zen's: MPL header, Mozilla prettier config, JSDoc on public methods, comments explaining *why*.

## 4. Verify

1. `cd engine && ./mach build faster` (or `npm run build` if you touched moz.build/jar.mn/patches - see `zenx-build`).
2. Write/extend tests and run them: `./mach test zenx/tests`. Fake Firefox services with sinon instead of needing real profiles.
   For user flows (profiles, import, restart, first run), also add a scenario to `zenx/tests/e2e/zenx_e2e.py` and run it. Most real bugs so far only showed up there: a fresh install without a profile group, sessions after a Cmd+Q restart, folders in inactive spaces.
3. `./mach lint zenx` (and `zen` if you touched it).
4. If possible run the browser (`npm start`) and click through the feature; for UI changes take a screenshot.

## 5. Ship

- Update `docs/zenx.md`: feature description + the "Zen files ZenX changes" table.
- Branch `zenx/<feature>` from `dev`, commit, open a PR into `dev` on `doctorspider42/ZenX` describing what changed, which Zen/Firefox files are touched, and how it was tested. Zen's `pr-test.yml` will check that all patches still apply.
