// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import createSidebarNotification from "chrome://browser/content/zen-components/ZenSidebarNotification.mjs";

const ZEN_UPDATE_PREF = "zen.updates.last-version";
const ZEN_BUILD_ID_PREF = "zen.updates.last-build-id";
const ZEN_UPDATE_SHOW = "zen.updates.show-update-notification";
const ZEN_UPDATE_NOTIFICATION_TIMEOUT_MS = 15000;

export default function checkForZenUpdates() {
  const version = Services.appinfo.version;
  const lastVersion = Services.prefs.getStringPref(ZEN_UPDATE_PREF, "");
  Services.prefs.setStringPref(ZEN_UPDATE_PREF, version);
  if (
    version === lastVersion ||
    gZenUIManager.testingEnabled ||
    !Services.prefs.getBoolPref(ZEN_UPDATE_SHOW, true)
  ) {
    return;
  }
  const updateUrl = Services.prefs.getStringPref(
    "app.releaseNotesURL.prompt",
    ""
  );
  createSidebarNotification({
    headingL10nId: "zen-sidebar-notification-updated-heading",
    autoHideMs: ZEN_UPDATE_NOTIFICATION_TIMEOUT_MS,
    links: [
      {
        url: Services.urlFormatter.formatURL(
          updateUrl.replace("%VERSION%", version)
        ),
        l10nId: "zen-sidebar-notification-updated",
        special: true,
        icon: "chrome://browser/skin/zen-icons/sparkles.svg",
      },
      {
        url: "https://www.zen-browser.app/donate",
        l10nId: "zen-sidebar-notification-donate",
        icon: "chrome://browser/skin/zen-icons/heart-circle-fill.svg",
      },
      {
        action: () => {
          Services.obs.notifyObservers(window, "restart-in-safe-mode");
        },
        l10nId: "zen-sidebar-notification-restart-safe-mode",
        icon: "chrome://browser/skin/zen-icons/security-broken.svg",
      },
    ],
  });
}

export async function createWindowUpdateAnimation() {
  const appID = Services.appinfo.appBuildID;
  if (
    Services.prefs.getStringPref(ZEN_BUILD_ID_PREF, "") === appID ||
    gZenUIManager.testingEnabled
  ) {
    return;
  }
  Services.prefs.setStringPref(ZEN_BUILD_ID_PREF, appID);
  await playWindowSweepAnimation();
}

/**
 * Plays the full-window sweep shown after updates. Also used the first
 * time incoming sync data is applied on this profile.
 */
export async function playWindowSweepAnimation() {
  await gZenWorkspaces.promiseInitialized;
  // ZenX: importing several spaces at once used to start overlapping sweeps.
  // They animated by id, so some overlays were never removed and covered the
  // window, swallowing every click. One sweep at a time, animate the
  // elements themselves, always clean up, never take clicks.
  if (document.getElementById("zen-update-animation")) {
    return;
  }
  const appWrapper = document.getElementById("zen-main-app-wrapper");
  const element = document.createElement("div");
  element.id = "zen-update-animation";
  const elementBorder = document.createElement("div");
  elementBorder.id = "zen-update-animation-border";
  for (const el of [element, elementBorder]) {
    el.style.pointerEvents = "none";
  }
  requestIdleCallback(() => {
    if (gReduceMotion || document.getElementById("zen-update-animation")) {
      return;
    }
    appWrapper.appendChild(element);
    appWrapper.appendChild(elementBorder);
    Promise.all([
      gZenUIManager.motion.animate(
        element,
        {
          top: ["100%", "-50%"],
          opacity: [0.5, 1],
        },
        {
          duration: 0.35,
        }
      ),
      gZenUIManager.motion.animate(
        elementBorder,
        {
          "--background-top": ["150%", "-50%"],
        },
        {
          duration: 0.35,
          delay: 0.08,
        }
      ),
    ]).finally(() => {
      element.remove();
      elementBorder.remove();
    });
  });
}
