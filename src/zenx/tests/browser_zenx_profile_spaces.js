/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Zen keeps its own tests out of ESLint (see the eslint-ignores patch); the
// mochitest and window globals used here are not configured for zenx/tests.
/* eslint-disable no-undef */

add_setup(async function () {
  await gZenWorkspaces.promiseInitialized;
  await setupFakeProfileGroup();
});

add_task(async function test_publishes_spaces_of_this_profile() {
  const { space } = await createSpace("ZenX Published");
  const registryPref = REGISTRY_PREFIX + CURRENT_PROFILE_ID;

  await TestUtils.waitForCondition(
    () => readPrefJSON(registryPref)?.spaces?.some(s => s.uuid === space.uuid),
    "This profile's spaces should be published to the shared registry"
  );
  const entry = readPrefJSON(registryPref);
  Assert.equal(entry.v, 1, "The registry entry should be versioned");
  Assert.equal(
    entry.spaces.find(s => s.uuid === space.uuid).name,
    "ZenX Published",
    "The space name should be published"
  );
  Assert.ok(
    SelectableProfileService.trackPref.calledWith(registryPref),
    "The registry pref should be shared with the profile group"
  );
});

add_task(async function test_shows_and_opens_spaces_of_other_profiles() {
  const updated = waitForRemoteSpacesUpdate();
  Services.prefs.setStringPref(
    REGISTRY_PREFIX + OTHER_PROFILE_ID,
    JSON.stringify({
      v: 1,
      spaces: [{ uuid: "remote-space-1", name: "Fun", icon: "🎉" }],
    })
  );
  await updated;

  const button = document.querySelector(
    "#zen-workspaces-button .zenx-remote-space[zenx-space-id='remote-space-1']"
  );
  Assert.ok(button, "The other profile's space should be in the switcher");
  Assert.equal(
    button.getAttribute("zenx-profile-id"),
    String(OTHER_PROFILE_ID),
    "The button should know which profile owns the space"
  );
  Assert.ok(
    document.documentElement.hasAttribute("zenx-has-remote-spaces"),
    "The switcher should stay visible"
  );
  Assert.ok(
    !document.querySelector(
      "#zen-workspaces-button .zenx-remote-spaces-separator"
    ),
    "No separator: all spaces share one order"
  );

  const buttons = [
    ...document.querySelectorAll("#zen-workspaces-button toolbarbutton"),
  ];
  const remoteIndex = buttons.indexOf(button);
  const rect = button.getBoundingClientRect();
  const previous = buttons[remoteIndex - 1].getBoundingClientRect();
  Assert.greater(rect.width, 8, "The remote space button has a real width");
  Assert.ok(
    rect.left >= previous.right - 1 || rect.top >= previous.bottom - 1,
    "The remote space button doesn't overlap the button before it"
  );

  button.doCommand();
  await TestUtils.waitForCondition(
    () => SelectableProfileService.sendCommandLine.called,
    "Clicking should hand off to the other profile"
  );
  Assert.deepEqual(
    SelectableProfileService.sendCommandLine.lastCall.args,
    ["/fake/profiles/Personal", ["--zenx-space", "remote-space-1"], true],
    "The running instance should be asked to switch to the space"
  );

  // When the other profile is not running, it is started on that space.
  SelectableProfileService.sendCommandLine.throws(new Error("not running"));
  button.doCommand();
  await TestUtils.waitForCondition(
    () => SelectableProfileService.execProcess.called,
    "The other profile should be started"
  );
  const args = SelectableProfileService.execProcess.lastCall.args[0];
  Assert.ok(
    args
      .join(" ")
      .endsWith(
        "--profile /fake/profiles/Personal --zenx-space remote-space-1"
      ),
    `The profile should start on the space (${args.join(" ")})`
  );
  SelectableProfileService.sendCommandLine.reset();

  const removed = waitForRemoteSpacesUpdate();
  Services.prefs.clearUserPref(REGISTRY_PREFIX + OTHER_PROFILE_ID);
  await removed;
  Assert.ok(
    !document.querySelector("#zen-workspaces-button .zenx-remote-space"),
    "Spaces should disappear with the registry entry"
  );
});

add_task(async function test_imports_space_sent_from_other_profile() {
  const handoffPref = HANDOFF_PREFIX + CURRENT_PROFILE_ID;
  const originalWorkspace = gZenWorkspaces.activeWorkspace;
  Services.prefs.setStringPref(
    handoffPref,
    JSON.stringify({
      "handoff-1": {
        v: 1,
        id: "handoff-1",
        from: OTHER_PROFILE_ID,
        at: Date.now(),
        space: {
          type: "space",
          name: "Moved Here",
          icon: "🚚",
          sourceUuid: "source-space-uuid",
          items: [
            { type: "tab", url: "https://example.com/", isPinned: true },
            { type: "tab", url: "https://example.org/" },
          ],
        },
      },
    })
  );

  let imported;
  await TestUtils.waitForCondition(() => {
    imported = gZenWorkspaces
      .getWorkspaces()
      .find(space => space.zenxMovedFrom === "source-space-uuid");
    return imported;
  }, "The space should be imported");
  registerCleanupFunction(async () => {
    if (gZenWorkspaces.getWorkspaceFromId(imported.uuid)) {
      await switchToExistingSpace(originalWorkspace);
      await gZenWorkspaces.removeWorkspace(imported.uuid);
    }
  });

  Assert.equal(imported.name, "Moved Here", "The name should be kept");
  Assert.equal(imported.icon, "🚚", "The icon should be kept");
  const tabs = gZenWorkspaces.allStoredTabs.filter(
    tab => tab.getAttribute("zen-workspace-id") === imported.uuid
  );
  Assert.ok(
    tabs.some(tab => tab.pinned),
    "Pinned tabs should stay pinned"
  );
  Assert.equal(
    tabs.filter(tab => !tab.hasAttribute("zen-empty-tab")).length,
    2,
    "Both tabs should be imported"
  );

  await TestUtils.waitForCondition(
    () => !Services.prefs.prefHasUserValue(handoffPref),
    "The handoff should be consumed"
  );
  await TestUtils.waitForCondition(
    () =>
      readPrefJSON(REGISTRY_PREFIX + CURRENT_PROFILE_ID)?.spaces?.some(
        s => s.movedFrom === "source-space-uuid"
      ),
    "The adoption should be published so the source drops its copy"
  );

  // Delivering the same handoff again must not duplicate the space.
  Services.prefs.setStringPref(
    handoffPref,
    JSON.stringify({
      "handoff-1": {
        v: 1,
        id: "handoff-1",
        from: OTHER_PROFILE_ID,
        at: Date.now(),
        space: {
          type: "space",
          name: "Moved Here",
          items: [],
          sourceUuid: "source-space-uuid",
        },
      },
    })
  );
  await TestUtils.waitForCondition(
    () => !Services.prefs.prefHasUserValue(handoffPref),
    "The repeated handoff should be consumed"
  );
  Assert.equal(
    gZenWorkspaces
      .getWorkspaces()
      .filter(space => space.zenxMovedFrom === "source-space-uuid").length,
    1,
    "The space should only be imported once"
  );
});

add_task(async function test_moves_space_to_other_profile() {
  const { space, originalWorkspace } = await createSpace("ZenX Outgoing");
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/zenx");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  gZenWorkspaces.moveTabToWorkspace(tab, space.uuid);

  Assert.ok(
    await ZenXProfileSpaces.moveSpaceToProfile(
      window,
      space.uuid,
      OTHER_PROFILE_ID
    ),
    "The move should start"
  );
  Assert.ok(
    SelectableProfileService.launchInstance.called,
    "The target profile should be brought up"
  );

  const handoffs = readPrefJSON(HANDOFF_PREFIX + OTHER_PROFILE_ID);
  const handoff = Object.values(handoffs)[0];
  Assert.equal(handoff.from, CURRENT_PROFILE_ID, "The sender is recorded");
  Assert.equal(handoff.space.sourceUuid, space.uuid, "The space is recorded");
  Assert.ok(
    handoff.space.items.some(item => item.url === "https://example.com/zenx"),
    "The space's tabs should be sent"
  );
  Assert.ok(
    ZenXProfileSpaces.getPendingMoves()[space.uuid],
    "The move should be pending"
  );
  Assert.ok(
    gZenWorkspaces.getWorkspaceFromId(space.uuid),
    "The space stays here until the target adopts it"
  );

  // The target profile adopts the space and publishes it.
  Services.prefs.setStringPref(
    REGISTRY_PREFIX + OTHER_PROFILE_ID,
    JSON.stringify({
      v: 1,
      spaces: [
        { uuid: "adopted-uuid", name: "ZenX Outgoing", movedFrom: space.uuid },
      ],
    })
  );
  await TestUtils.waitForCondition(
    () => !gZenWorkspaces.getWorkspaceFromId(space.uuid),
    "The space should be removed here once adopted"
  );
  Assert.ok(
    !ZenXProfileSpaces.getPendingMoves()[space.uuid],
    "The move should be settled"
  );
  Assert.notEqual(
    gZenWorkspaces.activeWorkspace,
    space.uuid,
    "We should have left the moved space"
  );
  await switchToExistingSpace(originalWorkspace);
  Services.prefs.clearUserPref(REGISTRY_PREFIX + OTHER_PROFILE_ID);
  Services.prefs.clearUserPref(HANDOFF_PREFIX + OTHER_PROFILE_ID);
});

add_task(async function test_cancel_pending_move() {
  const { space } = await createSpace("ZenX Cancelled");
  await ZenXProfileSpaces.moveSpaceToProfile(
    window,
    space.uuid,
    OTHER_PROFILE_ID
  );
  Assert.ok(
    ZenXProfileSpaces.getPendingMoves()[space.uuid],
    "The move should be pending"
  );

  ZenXProfileSpaces.cancelPendingMove(space.uuid);
  Assert.ok(
    !ZenXProfileSpaces.getPendingMoves()[space.uuid],
    "The move should be cancelled"
  );
  Assert.ok(
    !Services.prefs.prefHasUserValue(HANDOFF_PREFIX + OTHER_PROFILE_ID),
    "The handoff should be withdrawn"
  );
  Assert.ok(
    gZenWorkspaces.getWorkspaceFromId(space.uuid),
    "The space should stay here"
  );
});

add_task(async function test_space_menu_set_profile_like_arc() {
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("zenx-profile-spaces"),
    "The window knows spaces are bound to profiles"
  );
  const menu = document.getElementById("zenWorkspaceMoreActions");
  const spaceButton = document.querySelector(
    "#zen-workspaces-button toolbarbutton[zen-workspace-id]"
  );
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(spaceButton, { type: "contextmenu" });
  await shown;

  Assert.ok(
    !document
      .getElementById("context_zenWorkspacesOpenInContainerTab")
      .checkVisibility(),
    "Zen's container picker (labelled 'Profile') is hidden"
  );
  const setProfile = document.getElementById(
    "zenx-context-move-space-to-profile"
  );
  Assert.ok(setProfile.checkVisibility(), "Our Set Profile menu is shown");

  const subShown = BrowserTestUtils.waitForPopupEvent(
    setProfile.menupopup,
    "shown"
  );
  setProfile.openMenu(true);
  await subShown;
  const items = [...setProfile.menupopup.querySelectorAll("menuitem")];
  Assert.deepEqual(
    items.map(item => item.getAttribute("label")),
    ["Work", "Personal", "New Profile…", "Edit This Profile…"],
    "Every profile, then New Profile, then editing this profile"
  );
  Assert.equal(items[0].getAttribute("checked"), "true", "Own profile checked");
  Assert.equal(
    items[2].getAttribute("zenx-profile-id"),
    "new",
    "New Profile creates a new profile"
  );

  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
});

add_task(async function test_shared_prefs_are_ascii() {
  const { space } = await createSpace("Zażółć 🎉");
  space.icon = "🤡";
  gZenWorkspaces.saveWorkspace(space);
  const registryPref = REGISTRY_PREFIX + CURRENT_PROFILE_ID;
  await TestUtils.waitForCondition(
    () =>
      readPrefJSON(registryPref)?.spaces?.some(
        s => s.uuid === space.uuid && s.icon
      ),
    "The space and its icon are published"
  );
  const raw = Services.prefs.getStringPref(registryPref);
  Assert.ok(
    /^[ -~]*$/.test(raw),
    "Shared prefs stay ASCII, Firefox copies them between profiles as bytes"
  );
  const published = readPrefJSON(registryPref).spaces.find(
    s => s.uuid === space.uuid
  );
  Assert.equal(published.name, "Zażółć 🎉", "Names survive the escaping");
  Assert.equal(published.icon, "🤡", "Emoji icons survive the escaping");
});

add_task(async function test_new_profile_is_prepared() {
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "zenx-new-profile"
  );
  registerCleanupFunction(() => IOUtils.remove(dir, { recursive: true }));
  await IOUtils.writeUTF8(
    PathUtils.join(dir, "prefs.js"),
    'user_pref("browser.profiles.enabled", true);\n'
  );
  const sandbox = sinon.createSandbox();
  registerCleanupFunction(() => sandbox.restore());
  sandbox
    .stub(SelectableProfileService, "createNewProfile")
    .resolves({ ...fakeProfile(3, "New"), path: dir });
  sandbox
    .stub(SelectableProfileService, "groupToolkitProfile")
    .get(() => ({ showProfileSelector: true }));
  const selector = sandbox
    .stub(SelectableProfileService, "setShowProfileSelectorWindow")
    .resolves();

  const profile = await ZenXProfileSpaces.createProfile();
  Assert.equal(profile.path, dir);
  const prefs = await IOUtils.readUTF8(PathUtils.join(dir, "prefs.js"));
  Assert.ok(
    prefs.includes('user_pref("browser.profiles.enabled", true);'),
    "Firefox's own prefs are kept"
  );
  for (const expected of [
    'user_pref("zen.welcome-screen.seen", true);',
    `user_pref("zen.updates.last-version", ${JSON.stringify(Services.appinfo.version)});`,
    'user_pref("zenx.profile-spaces.open-profile-editor", true);',
  ]) {
    Assert.ok(prefs.includes(expected), `New profile gets ${expected}`);
  }
  Assert.ok(
    selector.calledWith(false),
    "The startup profile picker is turned off"
  );
});

add_task(async function test_firefox_profile_menus_hidden() {
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("zenx-profile-spaces"),
    "The window knows spaces are bound to profiles"
  );
  // The app menu is built from a template the first time it opens.
  await gCUITestUtils.openMainMenu();
  const button = PanelMultiView.getViewNode(
    document,
    "appMenu-profiles-button"
  );
  // Firefox only shows the button once profiles exist; force it so the test
  // checks our rule, not Firefox's.
  button.hidden = false;
  Assert.ok(
    !button.checkVisibility(),
    "Firefox's Profiles button is hidden in the app menu"
  );
  await gCUITestUtils.hideMainMenu();
});

add_task(async function test_menubar_profiles_menu_stays_hidden() {
  const menu = document.getElementById("profiles-menu");
  Assert.ok(menu.hidden, "The menu bar Profiles menu is hidden");
  // Firefox shows it again whenever profiles change.
  gProfiles.toggleProfileMenus(true);
  menu.hidden = false;
  await TestUtils.waitForCondition(
    () => menu.hidden,
    "ZenX hides it again (the native macOS menu bar ignores CSS)"
  );
});

add_task(async function test_one_order_for_all_profiles() {
  const { space } = await createSpace("ZenX Ordered");
  const local = gZenWorkspaces.getWorkspaces().map(s => s.uuid);
  const updated = waitForRemoteSpacesUpdate();
  Services.prefs.setStringPref(
    REGISTRY_PREFIX + OTHER_PROFILE_ID,
    JSON.stringify({
      v: 1,
      spaces: [{ uuid: "remote-ordered", name: "Remote", icon: "🛰" }],
    })
  );
  await updated;
  const shown = () =>
    [...document.querySelectorAll("#zen-workspaces-button toolbarbutton")].map(
      b => b.getAttribute("zen-workspace-id") || b.getAttribute("zenx-space-id")
    );

  // The shared order puts the other profile's space first, then ours.
  const wanted = ["remote-ordered", ...local.slice().reverse()];
  const reordered = waitForRemoteSpacesUpdate();
  Services.prefs.setStringPref(ORDER_PREF, JSON.stringify(wanted));
  await reordered;
  Assert.deepEqual(
    shown(),
    wanted,
    "The switcher follows the order shared by all profiles"
  );

  // A space moved to another profile keeps its place.
  const handoffPref = HANDOFF_PREFIX + CURRENT_PROFILE_ID;
  Services.prefs.setStringPref(
    handoffPref,
    JSON.stringify({
      "order-1": {
        v: 1,
        id: "order-1",
        from: OTHER_PROFILE_ID,
        at: Date.now(),
        space: {
          type: "space",
          name: "Arrived",
          items: [],
          sourceUuid: "remote-ordered",
        },
      },
    })
  );
  let arrived;
  await TestUtils.waitForCondition(() => {
    arrived = gZenWorkspaces
      .getWorkspaces()
      .find(s => s.zenxMovedFrom === "remote-ordered");
    return arrived;
  }, "The space arrives");
  registerCleanupFunction(async () => {
    if (gZenWorkspaces.getWorkspaceFromId(arrived.uuid)) {
      await switchToExistingSpace(space.uuid);
      await gZenWorkspaces.removeWorkspace(arrived.uuid);
    }
  });
  Assert.equal(
    JSON.parse(Services.prefs.getStringPref(ORDER_PREF))[0],
    arrived.uuid,
    "The moved space takes the place of its old uuid in the shared order"
  );
  Services.prefs.clearUserPref(REGISTRY_PREFIX + OTHER_PROFILE_ID);
  Services.prefs.clearUserPref(ORDER_PREF);
});
