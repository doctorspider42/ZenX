/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ZenX: creates Arc spaces, pinned tabs, folders and favorites in a Zen
 * browser window. The Arc file is read by ZenXArcSidebar.sys.mjs.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { parseArcSidebar } from "resource:///modules/zenx/arc/ZenXArcSidebar.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

/** Path of Arc's sidebar file, next to its Chromium "User Data" folder. */
export function getArcSidebarPath() {
  // End-to-end tests point the importer at a synthetic Arc folder.
  const override = Services.env.get("ZENX_ARC_DATA_DIR");
  if (override) {
    return PathUtils.join(override, "StorableSidebar.json");
  }
  if (AppConstants.platform !== "macosx") {
    return null;
  }
  return PathUtils.join(
    Services.dirsvc.get("ULibDir", Ci.nsIFile).path,
    "Application Support",
    "Arc",
    "StorableSidebar.json"
  );
}

/** Chromium user data folder of Arc (profiles, history, logins…). */
export function getArcUserDataPath() {
  const sidebar = getArcSidebarPath();
  return sidebar
    ? PathUtils.join(PathUtils.parent(sidebar), "User Data")
    : null;
}

export async function readArcSidebar(
  profileDirectory = "Default",
  path = getArcSidebarPath()
) {
  if (!path || !(await IOUtils.exists(path))) {
    return null;
  }
  return parseArcSidebar(await IOUtils.readJSON(path), { profileDirectory });
}

function getSpacesWindow() {
  const win = lazy.BrowserWindowTracker.getTopWindow({ private: false });
  if (!win?.gZenWorkspaces || win.gZenWorkspaces.privateWindowOrDisabled) {
    throw new Error("No browser window with spaces to import Arc into");
  }
  return win;
}

/**
 * Creates the parsed Arc data in a browser window. Spaces imported before
 * (same Arc space id) are skipped so the import can be repeated.
 *
 * @param {object} aParsed result of parseArcSidebar()
 * @param {Window} [aWindow] defaults to the most recent browser window
 * @returns {Promise<{spaces: number, tabs: number, essentials: number}>}
 */
export async function importArcIntoWindow(
  aParsed,
  aWindow = getSpacesWindow()
) {
  const { gZenWorkspaces, gZenShareManager, gZenPinnedTabManager, gBrowser } =
    aWindow;
  await gZenWorkspaces.promiseInitialized;

  const result = { spaces: 0, tabs: 0, essentials: 0 };
  const previousSpace = gZenWorkspaces.activeWorkspace;
  const alreadyImported = new Set(
    gZenWorkspaces
      .getWorkspaces()
      .map(space => space.zenxArcId)
      .filter(Boolean)
  );

  for (const space of aParsed.spaces) {
    if (alreadyImported.has(space.arcId)) {
      continue;
    }
    const workspace = await gZenShareManager.importSpace({
      type: "space",
      name: space.name,
      items: space.items,
      theme: space.theme,
    });
    if (!workspace) {
      continue;
    }
    workspace.zenxArcId = space.arcId;
    if (space.icon) {
      workspace.icon = space.icon;
    }
    gZenWorkspaces.saveWorkspace(workspace);
    result.spaces++;
    result.tabs += countTabs(space.items);
  }

  const existingEssentials = new Set(
    gBrowser.tabs
      .filter(tab => tab.hasAttribute("zen-essential"))
      .map(tab => tab.linkedBrowser?.currentURI?.spec)
  );
  for (const essential of aParsed.essentials) {
    if (existingEssentials.has(essential.url)) {
      continue;
    }
    const tab = gBrowser.addTrustedTab(essential.url, {
      createLazyBrowser: true,
      inBackground: true,
      skipAnimation: true,
      skipBackgroundNotify: true,
      lazyTabTitle: essential.label || undefined,
      skipRoute: true,
    });
    if (gZenPinnedTabManager.addToEssentials(tab)) {
      result.essentials++;
    } else {
      // Essentials are full, keep the tab instead of losing it.
      gBrowser.pinTab(tab);
    }
  }

  // Land on the first imported space so the user sees the result.
  const firstImported = gZenWorkspaces
    .getWorkspaces()
    .find(
      space => space.zenxArcId && space.zenxArcId === aParsed.spaces[0]?.arcId
    );
  await gZenWorkspaces.changeWorkspaceWithID(
    firstImported?.uuid ?? previousSpace
  );
  return result;
}

function countTabs(items) {
  return items.reduce(
    (n, item) =>
      n + (item.type === "tab" ? 1 : countTabs(item.items ?? item.tabs ?? [])),
    0
  );
}
