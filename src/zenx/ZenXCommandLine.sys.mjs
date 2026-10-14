/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ZenX: `--zenx-space <uuid>` brings this profile's window to the front on a
 * space. Other profiles send it when one of this profile's spaces is clicked
 * in their switcher, with `--zenx-frame x,y,w,h --zenx-from <profile id>` so
 * this window takes the place of theirs and they hide it (`--zenx-hide`).
 * With `--zenx-slide right|left` the space slides in from that side,
 * finishing the slide the other window started.
 * `--zenx-show` brings back a hidden window when the one in front restarts,
 * and `--zenx-quit` quits a profile in the background when the one in front
 * quits. `--zenx-preload <profile id>` starts a profile in the background,
 * with its window hidden, and `--zenx-ping` tells whether one is running.
 *
 * It runs before Firefox's and Zen's handlers so that the whole command line
 * is used up. When the profile wasn't reachable directly, the request comes
 * through a relaunch with `-foreground --profile <path>`, and any argument
 * left over would make Firefox open a new window.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ZenXProfileSpaces: "resource:///modules/zenx/ZenXProfileSpaces.sys.mjs",
});

export const ZENX_SPACE_FLAG = "zenx-space";
// Zen picks this up when the first window restores its spaces.
const INITIAL_SPACE_PREF = "zen.workspaces.cmdline-initial-workspace";

export class ZenXCommandLineHandler {
  QueryInterface = ChromeUtils.generateQI(["nsICommandLineHandler"]);

  handle(cmdLine) {
    if (cmdLine.handleFlag("zenx-ping", false)) {
      cmdLine.preventDefault = true;
      return;
    }
    let preloadedBy = null;
    try {
      preloadedBy = cmdLine.handleFlagWithParam("zenx-preload", false);
    } catch (e) {}
    if (
      preloadedBy &&
      cmdLine.state === Ci.nsICommandLine.STATE_INITIAL_LAUNCH
    ) {
      // The window still opens (and restores the session), hidden.
      lazy.ZenXProfileSpaces.startInBackground(parseInt(preloadedBy));
      return;
    }
    if (cmdLine.handleFlag("zenx-quit", false)) {
      cmdLine.preventDefault = true;
      lazy.ZenXProfileSpaces.quitIfInBackground();
      return;
    }
    if (cmdLine.handleFlag("zenx-hide", false)) {
      cmdLine.preventDefault = true;
      lazy.ZenXProfileSpaces.hideWindows();
      return;
    }
    let uuid, frame, from, slide;
    try {
      uuid = cmdLine.handleFlagWithParam(ZENX_SPACE_FLAG, false);
      frame = cmdLine.handleFlagWithParam("zenx-frame", false);
      from = cmdLine.handleFlagWithParam("zenx-from", false);
      slide =
        { left: -1, right: 1 }[
          cmdLine.handleFlagWithParam("zenx-slide", false)
        ] ?? 0;
    } catch (e) {
      return;
    }
    const show = cmdLine.handleFlag("zenx-show", false);
    if (!uuid && !show) {
      return;
    }
    const fromProfileId = from ? parseInt(from) : null;
    // Leftovers of a relaunch that was handed over to this running instance.
    cmdLine.handleFlagWithParam("profile", false);
    cmdLine.handleFlag("foreground", false);
    cmdLine.handleFlag("profiles-activate", false);

    const later = () => {
      if (uuid) {
        Services.prefs.setStringPref(INITIAL_SPACE_PREF, uuid);
      }
      if (frame) {
        lazy.ZenXProfileSpaces.setPendingWindowPlace(frame, fromProfileId);
      }
    };
    if (cmdLine.state === Ci.nsICommandLine.STATE_INITIAL_LAUNCH) {
      later();
      return;
    }
    const win = lazy.BrowserWindowTracker.getTopWindow({
      private: false,
      allowPopups: false,
    });
    if (!win?.gZenWorkspaces || win.gZenWorkspaces.privateWindowOrDisabled) {
      // No window to switch: let the default handling open one, on that space.
      later();
      return;
    }
    cmdLine.preventDefault = true;
    if (uuid && !slide) {
      win.gZenWorkspaces
        .changeWorkspaceFromCommandLine(uuid)
        .catch(console.error);
    }
    lazy.ZenXProfileSpaces.takeWindowPlace(win, frame, fromProfileId, {
      spaceUuid: slide ? uuid : null,
      slide,
    }).catch(console.error);
  }

  get helpInfo() {
    return "";
  }
}
