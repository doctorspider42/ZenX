/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { parseArcSidebar, summarizeArcImport, arcProfileDirectory } =
  ChromeUtils.importESModule(
    "resource:///modules/zenx/arc/ZenXArcSidebar.sys.mjs"
  );

let fixture;

add_setup(async function () {
  fixture = await IOUtils.readJSON(
    do_get_file("arc-sidebar-fixture.json").path
  );
});

add_task(function test_profile_directory() {
  Assert.equal(arcProfileDirectory({ default: true }), "Default");
  Assert.equal(
    arcProfileDirectory({ custom: { _0: { directoryBasename: "Profile 3" } } }),
    "Profile 3"
  );
  Assert.equal(arcProfileDirectory(undefined), "Default");
});

add_task(function test_default_profile_spaces() {
  const { spaces, essentials, skipped } = parseArcSidebar(fixture);
  Assert.deepEqual(
    spaces.map(space => space.name),
    ["Work"],
    "Only spaces of the selected Arc profile are imported"
  );
  const [work] = spaces;
  Assert.equal(work.arcId, "work");
  Assert.equal(work.icon, "💼");
  Assert.deepEqual(
    work.theme.gradientColors[0].c,
    [255, 128, 0],
    "The space color becomes the theme"
  );

  const [docs, folder, split, today] = work.items;
  Assert.deepEqual(
    docs,
    {
      type: "tab",
      url: "https://example.com/docs",
      label: "Docs",
      isPinned: true,
    },
    "Pinned tabs stay pinned tabs"
  );
  Assert.equal(folder.type, "folder");
  Assert.equal(folder.name, "Projects");
  Assert.equal(folder.items[1].type, "folder", "Folders can be nested");
  Assert.equal(folder.items[1].items.length, 1, "Easels are left out");
  Assert.equal(split.type, "splitView", "Split views are kept");
  Assert.deepEqual(
    split.tabs.map(tab => tab.url),
    ["https://example.com/left", "https://example.com/right"],
    "Split view tabs are found through their parent"
  );
  Assert.deepEqual(
    today,
    { type: "tab", url: "https://example.org/today", label: "Today" },
    "Unpinned tabs become normal tabs"
  );
  Assert.equal(work.items.length, 4, "arc:// pages are left out");

  Assert.deepEqual(
    essentials,
    [{ url: "https://example.com/mail", label: "Mail" }],
    "Favorites become essentials"
  );
  Assert.equal(skipped, 2, "The easel and the arc:// page are skipped");
});

add_task(function test_other_profile_spaces() {
  const parsed = parseArcSidebar(fixture, { profileDirectory: "Profile 1" });
  Assert.deepEqual(
    parsed.spaces.map(space => [space.name, space.icon]),
    [["Fun", "🎉"]],
    "Old container lists and codepoint emoji are read"
  );
  Assert.deepEqual(
    parsed.essentials.map(essential => essential.url),
    ["https://example.net/chat"]
  );
  Assert.deepEqual(summarizeArcImport(parsed), {
    spaces: 1,
    pinnedTabs: 1,
    tabs: 0,
    folders: 0,
    splitViews: 0,
    essentials: 1,
    skipped: 0,
  });
});

add_task(function test_not_an_arc_file() {
  Assert.throws(() => parseArcSidebar({}), /Not an Arc sidebar file/);
});
