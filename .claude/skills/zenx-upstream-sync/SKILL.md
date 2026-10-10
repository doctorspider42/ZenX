---
name: zenx-upstream-sync
description: How ZenX stays in sync with upstream Zen Browser and how to resolve a failed daily merge - the zenx-sync-upstream workflow, the upstream-sync PR and conflict issue, resolving conflicts in .patch files, Firefox version bumps, and upstream workflow changes. Use this whenever the user mentions upstream, merging Zen, the sync PR or "upstream-sync-conflict" issue, a red sync job, updating to a new Zen/Firefox version, or rebasing ZenX changes.
---

# Keeping ZenX in sync with Zen

## How it works

- `.github/workflows/zenx-sync-upstream.yml` runs daily (04:17 UTC) and on demand (`gh workflow run zenx-sync-upstream.yml -R doctorspider42/ZenX`).
- It merges `zen-browser/desktop@dev` into branch `zenx/upstream-sync` (made from our `dev`) and opens/updates a PR into `dev`. Zen's `pr-test.yml` runs on the PR: download Firefox, apply all patches, lint.
- On conflicts the job fails and opens/comments an issue labelled `upstream-sync-conflict` listing the files.
- Needs secret `SYNC_PAT` (fine-grained PAT: contents, pull requests, issues, workflows = write). Without it the job fails immediately with a clear error.
- Zen's own scheduled/internal workflows are disabled in the repo's Actions settings (not in files), so merges don't conflict on them. When upstream **adds** a new workflow it arrives enabled: check new `.github/workflows/*.yml` in the sync PR and `gh workflow disable <file> -R doctorspider42/ZenX` if it's Zen-internal (releases, Discord, metrics, cron jobs, anything using `DEPLOY_KEY` or Zen's runners).

## Resolving a conflicting merge

```bash
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/zen-browser/desktop.git
git fetch upstream
git checkout dev && git pull
git checkout -b zenx/upstream-sync-manual
git merge upstream/dev
```

Then per conflicting file:

- **ZenX hook in a Zen file** (listed in `docs/zenx.md`): take upstream's version, re-apply our marked `ZenX` lines. If upstream restructured the code, find the equivalent spot or a better hook; keep the hook minimal.
- **`.patch` file** (diff of a diff - don't merge by hand). A conflict here means ZenX changed a Zen patch (see `git log dev -- <patch>` and `docs/zenx.md`). First ask whether that change can move out of the patch into `src/zenx` or a separate small patch - that ends the conflicts for good. Otherwise: take **upstream's** patch (`git checkout --theirs <patch>`), then regenerate ours on top of it:
  1. `npm run download` if `surfer.json`'s Firefox version changed (otherwise skip), then `npm run import` - fix any patch that fails to apply.
  2. Re-make the ZenX change in the real file under `engine/`.
  3. `npx surfer export <engine-relative path>` to write the combined patch.
- **Our own files** (`src/zenx/**`, `prefs/zenx/**`, `zenx-*.ftl`) never conflict; but upstream API changes can still break them - that's what the build and tests catch.

Finish with a build and the ZenX tests (`zenx-build` skill), `git commit`, push and open a PR into `dev`. The workflow closes the `upstream-sync-conflict` issue by itself on the next clean daily merge; linking it in the PR ("Closes #N") just closes it sooner.

## Firefox version bumps

When upstream bumps `surfer.json` (`version.version`), the next local build needs a fresh engine: `rm -rf engine && npm run download && npm run import && npm run build`. Firefox APIs we use (`SelectableProfileService`, `ChromeProfileMigrator`, `MigrationUtils` registry - see `src/browser/components/migration/*.patch`) may change; run `./mach test zenx/tests zenx/tests/unit` and fix.

## Don'ts

- Don't rebase `dev` onto upstream or force-push `dev` - always merge, so history and the sync PR keep working.
- Don't resolve a `.patch` conflict by editing diff hunks by hand.
- Don't re-enable upstream workflows that publish releases or talk to Zen's infrastructure.
