/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Zen keeps its own tests out of ESLint (see the eslint-ignores patch); the
// mochitest and window globals used here are not configured for zenx/tests.
/* eslint-disable no-undef */

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { SelectableProfileService } = ChromeUtils.importESModule(
  "resource:///modules/profiles/SelectableProfileService.sys.mjs"
);
const { ZenXProfileSpaces, REGISTRY_PREFIX, HANDOFF_PREFIX } =
  ChromeUtils.importESModule(
    "resource:///modules/zenx/ZenXProfileSpaces.sys.mjs"
  );

const CURRENT_PROFILE_ID = 1;
const OTHER_PROFILE_ID = 2;

function fakeProfile(id, name) {
  return {
    id,
    name,
    path: `/fake/profiles/${name}`,
    theme: { themeBg: "#123456", themeFg: "#ffffff" },
    getAvatarURL: async () =>
      "chrome://browser/content/profiles/assets/16_book.svg",
  };
}

/**
 * Pretends this test profile is part of a profile group with a second
 * profile, without touching the real profile group database.
 */
async function setupFakeProfileGroup() {
  const sandbox = sinon.createSandbox();
  const profiles = [
    fakeProfile(CURRENT_PROFILE_ID, "Work"),
    fakeProfile(OTHER_PROFILE_ID, "Personal"),
  ];
  sandbox.stub(SelectableProfileService, "isEnabled").get(() => true);
  sandbox.stub(SelectableProfileService, "initialized").get(() => true);
  sandbox
    .stub(SelectableProfileService, "currentProfile")
    .get(() => profiles[0]);
  sandbox.stub(SelectableProfileService, "getAllProfiles").resolves(profiles);
  sandbox.stub(SelectableProfileService, "trackPref").resolves();
  sandbox.stub(SelectableProfileService, "sendCommandLine");
  sandbox.stub(SelectableProfileService, "execProcess");
  sandbox.stub(SelectableProfileService, "launchInstance");

  // Let ZenXProfileSpaces pick up the fake profiles.
  const updated = waitForRemoteSpacesUpdate();
  Services.obs.notifyObservers(null, "sps-profiles-updated", "remote");
  await updated;

  registerCleanupFunction(() => {
    sandbox.restore();
    for (const name of Services.prefs.getChildList("zenx.profile-spaces.")) {
      if (name !== "zenx.profile-spaces.enabled") {
        Services.prefs.clearUserPref(name);
      }
    }
    Services.obs.notifyObservers(null, "sps-profiles-updated", "remote");
  });
  return { sandbox, profiles };
}

function waitForRemoteSpacesUpdate() {
  return new Promise(resolve => {
    const listener = () => {
      ZenXProfileSpaces.removeListener(listener);
      resolve();
    };
    ZenXProfileSpaces.addListener(listener);
  });
}

function readPrefJSON(name) {
  const value = Services.prefs.getStringPref(name, "");
  return value ? JSON.parse(value) : null;
}

async function createSpace(name) {
  const originalWorkspace = gZenWorkspaces.activeWorkspace;
  const space = await gZenWorkspaces.createAndSaveWorkspace(name);
  registerCleanupFunction(async () => {
    if (gZenWorkspaces.getWorkspaceFromId(space.uuid)) {
      await switchToExistingSpace(originalWorkspace);
      await gZenWorkspaces.removeWorkspace(space.uuid);
    }
  });
  return { space, originalWorkspace };
}

/**
 * Switches to a space, or to the first one if it was removed meanwhile.
 *
 * @param {string} uuid
 */
async function switchToExistingSpace(uuid) {
  const target =
    gZenWorkspaces.getWorkspaceFromId(uuid) ??
    gZenWorkspaces.getWorkspaces()[0];
  await gZenWorkspaces.changeWorkspaceWithID(target.uuid);
}
