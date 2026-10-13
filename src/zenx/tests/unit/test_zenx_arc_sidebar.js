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

add_task(function test_several_containers() {
  // Newer Arc versions keep Little Arc's space in a container of its own,
  // before the main one.
  const sidebar = structuredClone(fixture);
  const main = sidebar.sidebar.containers.pop();
  const profile1 = { custom: { _0: { directoryBasename: "Profile 1" } } };
  sidebar.sidebar.containers.push(
    { littleBrowser: {} },
    {
      spaces: [
        "little",
        {
          id: "little",
          profile: { default: true },
          newContainerIDs: [{ unpinned: {} }, "little-unpinned"],
        },
        "extra",
        {
          id: "extra",
          title: "Extra",
          profile: profile1,
          newContainerIDs: [{ pinned: {} }, "extra-pinned"],
        },
      ],
      items: [
        "little-unpinned",
        { id: "little-unpinned", childrenIds: ["t-little"], data: {} },
        "t-little",
        {
          id: "t-little",
          data: { tab: { savedURL: "https://example.com/little" } },
        },
        "extra-pinned",
        { id: "extra-pinned", childrenIds: ["t-extra"], data: {} },
        "t-extra",
        {
          id: "t-extra",
          data: { tab: { savedURL: "https://example.com/extra" } },
        },
        "top-extra",
        { id: "top-extra", childrenIds: ["t-top-extra"], data: {} },
        "t-top-extra",
        {
          id: "t-top-extra",
          data: { tab: { savedURL: "https://example.com/top" } },
        },
      ],
      topAppsContainerIDs: [profile1, "top-extra"],
    },
    main
  );

  const fromDefault = parseArcSidebar(sidebar);
  const expected = parseArcSidebar(fixture);
  Assert.deepEqual(
    fromDefault.spaces.map(space => space.arcId),
    expected.spaces.map(space => space.arcId),
    "The main container is read and Little Arc's untitled space is left out"
  );

  const fromProfile1 = parseArcSidebar(sidebar, {
    profileDirectory: "Profile 1",
  });
  Assert.deepEqual(
    fromProfile1.spaces.map(space => space.name),
    ["Extra", "Fun"],
    "Spaces of every container are read"
  );
  Assert.deepEqual(
    fromProfile1.essentials.map(essential => essential.url),
    ["https://example.com/top", "https://example.net/chat"],
    "Favorites of every container are read"
  );
});

add_task(function test_not_an_arc_file() {
  Assert.throws(() => parseArcSidebar({}), /Not an Arc sidebar file/);
});
