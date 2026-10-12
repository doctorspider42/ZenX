<!--
   - This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/.
   -->
<!-- ZenX: fork notice. Kept above Zen's README so upstream merges stay clean. -->

# ZenX

**ZenX is a fork of [Zen Browser](https://github.com/zen-browser/desktop)** that adds the Arc-style features we missed. It merges upstream Zen every day, so you get Zen's updates too. It is not affiliated with the Zen team.

[![Release](https://github.com/doctorspider42/ZenX/actions/workflows/zenx-release.yml/badge.svg)](https://github.com/doctorspider42/ZenX/actions/workflows/zenx-release.yml)
[![Sync with Zen](https://github.com/doctorspider42/ZenX/actions/workflows/zenx-sync-upstream.yml/badge.svg)](https://github.com/doctorspider42/ZenX/actions/workflows/zenx-sync-upstream.yml)

### What's different from Zen

- **Spaces in separate profiles, like Arc.** Every space belongs to a browser profile. Extensions, history, cookies and logins are shared only by the spaces of one profile.
  - Right-click a space → **Set Profile** to move it to another profile, or to a new one.
  - The space switcher shows the spaces of all profiles in one shared order. Clicking a space of another profile brings that profile's window to the front.
- **Import from Arc.** Arc appears in the import wizard. Your spaces come over with their names, emoji and colors. **Pinned tabs stay pinned tabs** (not bookmarks), folders and split views are kept, and favorites become essentials.
- **Installs next to Zen.** ZenX has its own app, profiles (`~/Library/Application Support/zenx`) and bundle id (`com.doctorspider42.zenx`).
- **Signed, notarized builds with automatic updates** from this repository's releases.
- Fixes found while building ZenX, worth sending to Zen as well:
  - folders created in a space that isn't active landed in the wrong space after a restart;
  - importing several spaces at once could leave invisible overlays that blocked every click.

### Download

macOS (Apple Silicon): [latest release](https://github.com/doctorspider42/ZenX/releases). ZenX updates itself after you install it.

### Development

[docs/zenx.md](docs/zenx.md) describes how ZenX is built on top of Zen and how it keeps up with upstream. It also lists every Zen file ZenX touches and how releases work. Guides for coding agents are in [`.claude/skills`](.claude/skills).

---

*The rest of this README is Zen's own.*

<!-- TODO: Get a job -->
<img src="./docs/assets/zen-dark.svg" width="100px" align="left">

### `Zen Browser`

[![Downloads](https://img.shields.io/github/downloads/zen-browser/desktop/total.svg)](https://github.com/zen-browser/desktop/releases)
[![Crowdin](https://badges.crowdin.net/zen-browser/localized.svg)](https://crowdin.com/project/zen-browser)
[![Zen Release builds](https://github.com/zen-browser/desktop/actions/workflows/build.yml/badge.svg?branch=stable)](https://github.com/zen-browser/desktop/actions/workflows/build.yml)

Zen is a firefox-based browser with the aim of pushing your productivity to a new level!

<div flex="true">
  <a href="https://zen-browser.app/download">
    Download
  </a>
  •
  <a href="https://zen-browser.app">
    Website
  </a>
  •
  <a href="https://docs.zen-browser.app">
    Documentation
  </a>
  •
  <a href="https://zen-browser.app/release-notes/latest">
    Release Notes
  </a>
</div>

### Firefox Versions

- [`Release`](https://zen-browser.app/download) - Is currently built using Firefox version `157.0.1`!
- [`Twilight`](https://zen-browser.app/download?twilight) - Is currently built using Firefox version `RC 157.0.1`!

### Contributing

If you'd like to report a bug, please do so on our [GitHub Issues page](https://github.com/zen-browser/desktop/issues/) and for feature requests, you can use [GitHub Discussions](https://github.com/zen-browser/desktop/discussions).

Zen is an open-source project, and we welcome contributions from the community! Please take a look at the [contribution guidelines](./docs/contribute.md) before getting started!

#### Partners

Thanks to all the partners of Zen for their support and contributions:

<a href="https://blacksmith.sh">
  <img src="./docs/assets/blacksmith-yellow.png" width="350px"/>
</a>
