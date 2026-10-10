/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Zen keeps its own tests out of ESLint (see the eslint-ignores patch); the
// mochitest and window globals used here are not configured for zenx/tests.
/* eslint-disable no-undef */

const { parseArcSidebar } = ChromeUtils.importESModule(
  "resource:///modules/zenx/arc/ZenXArcSidebar.sys.mjs"
);
const { importArcIntoWindow } = ChromeUtils.importESModule(
  "resource:///modules/zenx/arc/ZenXArcImporter.sys.mjs"
);

async function loadFixture() {
  const path = getTestFilePath("unit/arc-sidebar-fixture.json");
  return parseArcSidebar(await IOUtils.readJSON(path));
}

add_task(async function test_import_arc_spaces() {
  await gZenWorkspaces.promiseInitialized;
  const originalWorkspace = gZenWorkspaces.activeWorkspace;
  const parsed = await loadFixture();

  const result = await importArcIntoWindow(parsed, window);
  const work = gZenWorkspaces
    .getWorkspaces()
    .find(space => space.zenxArcId === "work");
  registerCleanupFunction(async () => {
    for (const tab of gBrowser.tabs.filter(
      t =>
        t.hasAttribute("zen-essential") &&
        t.linkedBrowser.currentURI.spec === "https://example.com/mail"
    )) {
      gBrowser.removeTab(tab);
    }
    await gZenWorkspaces.changeWorkspaceWithID(originalWorkspace);
    if (work && gZenWorkspaces.getWorkspaceFromId(work.uuid)) {
      await gZenWorkspaces.removeWorkspace(work.uuid);
    }
  });

  Assert.ok(work, "The Arc space should become a Zen space");
  Assert.equal(work.name, "Work");
  Assert.equal(work.icon, "💼");
  Assert.equal(result.spaces, 1);
  Assert.equal(result.essentials, 1, "Favorites become essentials");
  Assert.equal(
    gZenWorkspaces.activeWorkspace,
    work.uuid,
    "The imported space is shown"
  );

  const spaceTabs = gBrowser.tabs.filter(
    tab =>
      tab.getAttribute("zen-workspace-id") === work.uuid &&
      !tab.hasAttribute("zen-empty-tab")
  );
  const pinned = spaceTabs.filter(tab => tab.pinned);
  Assert.equal(pinned.length, 5, "Pinned tabs, folders and splits are pinned");
  Assert.ok(
    !pinned.some(tab => tab.hasAttribute("zen-essential")),
    "Pinned tabs are not essentials"
  );
  Assert.equal(
    spaceTabs.filter(tab => !tab.pinned).length,
    1,
    "The unpinned tab is a normal tab"
  );
  const folders = gZenWorkspaces
    .workspaceElement(work.uuid)
    .querySelectorAll("zen-folder");
  Assert.ok(
    [...folders].some(folder => folder.label === "Projects"),
    "Arc folders become Zen folders"
  );

  const again = await importArcIntoWindow(parsed, window);
  Assert.equal(again.spaces, 0, "Importing twice doesn't duplicate spaces");
  Assert.equal(again.essentials, 0, "...nor essentials");
});
