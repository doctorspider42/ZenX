/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Zen keeps its own tests out of ESLint (see the eslint-ignores patch); the
// mochitest and window globals used here are not configured for zenx/tests.
/* eslint-disable no-undef */

// A fresh install: one profile and no profile group yet, so Firefox's profile
// service still reports itself disabled. ZenX must already be in charge.

add_task(async function test_first_run_space_menu() {
  await gZenWorkspaces.promiseInitialized;
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("zenx-profile-spaces"),
    "Spaces are bound to profiles even before a profile group exists"
  );

  // The switcher is only shown with two or more spaces.
  await createSpace("ZenX First Run");
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
  Assert.deepEqual(
    [...setProfile.menupopup.querySelectorAll("menuitem")].map(item =>
      item.getAttribute("zenx-profile-id")
    ),
    ["new"],
    "With a single profile there is only New Profile"
  );

  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
});
