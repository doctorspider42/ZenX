# ZenX

ZenX is a fork of Zen Browser (itself built on Firefox) that merges upstream Zen every day. Our features are in `src/zenx/` and documented in `docs/zenx.md`.

Use the project skills in `.claude/skills/`:

- `zenx-codebase`: where things live, and how `src/` becomes `engine/`.
- `zenx-build`: setup, builds, running, tests, lint and troubleshooting.
- `zenx-new-feature`: how to add features without creating merge conflicts.
- `zenx-upstream-sync`: the daily upstream merge, and how to resolve conflicts.

Rules that matter most:

- `engine/` is generated, and the Firefox source is not in git. Work in `src/`. If you edit a Firefox file in `engine/`, run `npx surfer export <path>` afterwards.
- Change Zen and Firefox files only to add small hooks marked `ZenX`, and list every such change in `docs/zenx.md`.
- Never put the user's real browsing data (URLs, tab titles) into fixtures, logs or chat.
