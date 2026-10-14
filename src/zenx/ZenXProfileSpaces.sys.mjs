/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ZenX: spaces bound to Firefox profiles (like Arc's per-space profiles).
 *
 * Every Firefox profile is its own process with its own extensions, history,
 * cookies and logins, and its own list of spaces. This service connects the
 * profiles of one profile group so that they behave like one browser:
 *
 * - Registry: each running profile publishes a short summary of its spaces as
 *   a shared preference (`zenx.profile-spaces.registry.<profileId>`). Firefox's
 *   SelectableProfileService copies shared prefs through the profile group
 *   database to every other profile and pings running instances, so every
 *   profile knows the spaces of every other profile.
 * - Switching to a space of another profile hands off to that profile's
 *   process with Zen's `--space <uuid>` command line flag, starting the
 *   process if it is not running.
 * - Moving a space to another profile: the space (tabs, folders, split views,
 *   name, icon and theme) is written to a shared "handoff" pref addressed to
 *   the target profile. The target imports it and publishes the new space with
 *   `movedFrom` set to the original uuid. Only when the source sees that does
 *   it remove its copy, so a space is never lost when the target never runs.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
  SelectableProfileService:
    "resource:///modules/profiles/SelectableProfileService.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const PREF_BRANCH = "zenx.profile-spaces.";
export const REGISTRY_PREFIX = `${PREF_BRANCH}registry.`;
export const HANDOFF_PREFIX = `${PREF_BRANCH}handoff.`;
// Shared: one order of all spaces of all profiles, so every profile's
// switcher shows them the same way. JSON array of space uuids.
export const ORDER_PREF = `${PREF_BRANCH}order`;
// Local to this profile: spaces we sent away and still own until the target
// confirms it adopted them. { [spaceUuid]: { target, handoffId, at } }
const PENDING_MOVES_PREF = `${PREF_BRANCH}pending-moves`;
// Local to this profile: handoff ids already imported, so a handoff that is
// delivered twice is not imported twice.
const IMPORTED_HANDOFFS_PREF = `${PREF_BRANCH}imported-handoffs`;
const ENABLED_PREF = `${PREF_BRANCH}enabled`;
// Seeded into profiles ZenX creates: open the profile editor on first start.
export const OPEN_PROFILE_EDITOR_PREF = `${PREF_BRANCH}open-profile-editor`;
// Seeded into profiles ZenX creates for a space: drop the empty space Zen
// makes on first start once the moved space has arrived.
const FRESH_PROFILE_PREF = `${PREF_BRANCH}fresh-profile`;
// Local: the window of another profile the first window takes the place of.
const PENDING_WINDOW_PLACE_PREF = `${PREF_BRANCH}pending-window-place`;
// Shared: what an import run in another profile brought in, read by the
// profile that asked for it. `<prefix><handoffId>`.
const IMPORT_RESULT_PREFIX = `${PREF_BRANCH}import-result.`;
// The other profile may wait for the user, e.g. for keychain access.
const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;

const FORMAT_VERSION = 1;
// Fade-in of a profile's window over the one it replaces.
const WINDOW_FADE_MS = 160;
const PUBLISH_DELAY_MS = 500;
const MAX_IMPORTED_HANDOFFS = 50;
// Tabs whose URL cannot be reopened in another profile.
const NON_TRANSFERABLE_URL_RE = /^(about:blank|moz-extension:|blob:|data:)/;
// Space icons that mean the same thing in every profile.
const PORTABLE_ICON_RE = /^(chrome:|data:)/;

/**
 * JSON with every non-ASCII character escaped. SelectableProfileService copies
 * shared prefs between profiles with getCharPref/setCharPref, which mangles
 * UTF-8 (emoji icons, non-English tab titles), so shared values stay ASCII.
 *
 * @param {any} value
 * @returns {string}
 */
export function toSharedJSON(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

function readJSONPref(name, fallback) {
  try {
    const value = Services.prefs.getStringPref(name, "");
    return value ? JSON.parse(value) : fallback;
  } catch (e) {
    console.error(`ZenX: invalid JSON in ${name}`, e);
    return fallback;
  }
}

class nsZenXProfileSpaces {
  #initPromise = null;
  #profiles = [];
  #avatarURLs = new Map();
  #trackedPrefs = new Set();
  #listeners = new Set();
  #publishTask = null;
  #handoffQueue = Promise.resolve();

  get #sps() {
    return lazy.SelectableProfileService;
  }

  /**
   * Spaces can be bound to profiles: switched on by prefs and allowed by
   * policy. Firefox's own service only reports itself enabled once a profile
   * group exists, which ZenX creates on the first "New Profile", so it is not
   * required here.
   */
  get available() {
    return (
      Services.prefs.getBoolPref(ENABLED_PREF, true) &&
      Services.prefs.getBoolPref("browser.profiles.enabled", false) &&
      Services.policies.isAllowed("profileManagement")
    );
  }

  /** This instance runs in a profile that belongs to a profile group. */
  get active() {
    return this.available && this.#sps.initialized && !!this.currentProfileId;
  }

  get currentProfileId() {
    return this.#sps.currentProfile?.id ?? null;
  }

  init() {
    if (!this.#initPromise) {
      this.#initPromise = this.#init();
    }
    return this.#initPromise;
  }

  async #init() {
    Services.prefs.addObserver(PREF_BRANCH, this);
    Services.obs.addObserver(this, "sps-profiles-updated");
    Services.obs.addObserver(this, "quit-application-granted");
    Services.ww.registerNotification(this);
    this.#publishTask = new lazy.DeferredTask(
      () => this.#publishRegistry(),
      PUBLISH_DELAY_MS
    );
    this.#sps.on("enableChanged", () =>
      this.#refreshProfiles().then(() => this.#notifyListeners())
    );
    if (this.available && this.#sps.isEnabled && !this.#sps.initialized) {
      // The profile service finishes starting up in parallel with the first
      // window, wait for it so the current profile is known.
      await this.#sps.init();
    }
    await this.#refreshProfiles();
    if (this.active) {
      await this.disableStartupProfileSelector();
    }
    this.#notifyListeners();
  }

  // Mark: listeners

  /**
   * @param {Function} aListener called with no arguments whenever the profiles
   *   or the spaces of other profiles change.
   */
  addListener(aListener) {
    this.#listeners.add(aListener);
  }

  removeListener(aListener) {
    this.#listeners.delete(aListener);
  }

  #notifyListeners() {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (e) {
        console.error(e);
      }
    }
  }

  observe(aSubject, aTopic, aData) {
    switch (aTopic) {
      case "nsPref:changed":
        if (aData.startsWith(REGISTRY_PREFIX)) {
          this.#onRegistryChanged();
        } else if (aData === ORDER_PREF) {
          this.#notifyListeners();
        } else if (
          this.currentProfileId !== null &&
          aData === HANDOFF_PREFIX + this.currentProfileId
        ) {
          this.processIncomingHandoffs();
        }
        break;
      case "sps-profiles-updated":
        this.#refreshProfiles().then(() => {
          this.#onRegistryChanged();
          this.processIncomingHandoffs();
        });
        break;
      case "quit-application-granted":
        this.#publishTask?.finalize();
        this.#revealHiddenPeer();
        break;
      case "domwindowclosed":
        if (
          aSubject.document?.documentElement?.getAttribute("windowtype") ===
            "navigator:browser" &&
          !this.#visibleBrowserWindows().some(win => win !== aSubject)
        ) {
          this.#revealHiddenPeer();
        }
        break;
    }
  }

  async #refreshProfiles() {
    if (!this.available || !this.#sps.isEnabled || !this.#sps.initialized) {
      this.#profiles = [];
      return;
    }
    this.#profiles = await this.#sps.getAllProfiles();
    await Promise.all(
      this.#profiles.map(async profile => {
        try {
          this.#avatarURLs.set(profile.id, await profile.getAvatarURL(16));
        } catch (e) {
          this.#avatarURLs.delete(profile.id);
        }
      })
    );
  }

  // Mark: profiles

  /**
   * @returns {Array<{id: number, name: string, avatarURL: ?string,
   *   themeBg: ?string, themeFg: ?string, isCurrent: boolean}>}
   */
  getProfiles() {
    return this.#profiles.map(profile => ({
      id: profile.id,
      name: profile.name,
      avatarURL: this.#avatarURLs.get(profile.id) ?? null,
      themeBg: profile.theme?.themeBg ?? null,
      themeFg: profile.theme?.themeFg ?? null,
      isCurrent: profile.id === this.currentProfileId,
    }));
  }

  #getProfile(aProfileId) {
    return this.#profiles.find(profile => profile.id === aProfileId) ?? null;
  }

  // Mark: registry

  /**
   * Spaces published by the other profiles of the group, in profile order.
   *
   * @returns {Array<{profile: object, spaces: Array<{uuid, name, icon}>}>}
   */
  getRemoteSpaces() {
    if (!this.active) {
      return [];
    }
    const result = [];
    for (const profile of this.getProfiles()) {
      if (profile.isCurrent) {
        continue;
      }
      const entry = readJSONPref(REGISTRY_PREFIX + profile.id, null);
      if (entry?.v !== FORMAT_VERSION || !Array.isArray(entry.spaces)) {
        continue;
      }
      const spaces = entry.spaces.filter(
        space => typeof space?.uuid === "string"
      );
      if (spaces.length) {
        result.push({ profile, spaces });
      }
    }
    return result;
  }

  /** Publish this profile's spaces soon, coalescing bursts of changes. */
  schedulePublish() {
    if (this.active) {
      this.#publishTask?.arm();
    }
  }

  #getSpacesWindow() {
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (
        !win.closed &&
        win.gZenWorkspaces &&
        !win.gZenWorkspaces.privateWindowOrDisabled
      ) {
        return win;
      }
    }
    return null;
  }

  #publishRegistry() {
    if (!this.active) {
      return;
    }
    const win = this.#getSpacesWindow();
    if (!win) {
      return;
    }
    const spaces = win.gZenWorkspaces.getWorkspaces().map(space => {
      const summary = { uuid: space.uuid, name: space.name || "" };
      if (
        space.icon &&
        (!space.icon.includes(":") || PORTABLE_ICON_RE.test(space.icon))
      ) {
        summary.icon = space.icon;
      }
      if (space.zenxMovedFrom) {
        summary.movedFrom = space.zenxMovedFrom;
      }
      return summary;
    });
    this.#setSharedPref(
      REGISTRY_PREFIX + this.currentProfileId,
      toSharedJSON({ v: FORMAT_VERSION, spaces })
    );
  }

  /**
   * Writes a pref that SelectableProfileService copies to every profile of
   * the group. Unchanged values are skipped so we don't ping every running
   * instance for nothing.
   *
   * @param {string} aName
   * @param {?string} aValue the new value, or null to clear the pref
   */
  #setSharedPref(aName, aValue) {
    const current = Services.prefs.getStringPref(aName, "");
    if (current === aValue) {
      return;
    }
    if (aValue === null) {
      Services.prefs.clearUserPref(aName);
    } else {
      Services.prefs.setStringPref(aName, aValue);
    }
    if (!this.#trackedPrefs.has(aName)) {
      // Starts observing the pref, later changes are flushed automatically.
      this.#trackedPrefs.add(aName);
      this.#sps.trackPref(aName).catch(console.error);
    }
  }

  #onRegistryChanged() {
    this.#settlePendingMoves();
    this.#notifyListeners();
  }

  // Mark: order

  /**
   * The shared order applied to the spaces present now. Spaces it doesn't
   * know yet keep their place from `aFallbackOrder`, at the end.
   *
   * @param {Array<string>} aFallbackOrder uuids of every space shown
   * @returns {Array<string>}
   */
  orderSpaces(aFallbackOrder) {
    const present = new Set(aFallbackOrder);
    // A space moved to another profile has a new uuid there; it takes the
    // place of the original, whichever profile's update arrives first.
    const movedTo = new Map();
    for (const { spaces } of this.getRemoteSpaces()) {
      for (const space of spaces) {
        if (space.movedFrom && present.has(space.uuid)) {
          movedTo.set(space.movedFrom, space.uuid);
        }
      }
    }
    const ordered = [];
    const known = new Set();
    const add = uuid => {
      if (present.has(uuid) && !known.has(uuid)) {
        known.add(uuid);
        ordered.push(uuid);
      }
    };
    for (const uuid of readJSONPref(ORDER_PREF, [])) {
      if (movedTo.has(uuid)) {
        add(movedTo.get(uuid));
      }
      add(uuid);
    }
    for (const uuid of aFallbackOrder) {
      if (!known.has(uuid)) {
        ordered.push(uuid);
      }
    }
    return ordered;
  }

  /**
   * Stores the shared order. Spaces missing from `aOrder` (e.g. of a profile
   * whose spaces aren't known yet) keep their stored place after it.
   *
   * @param {Array<string>} aOrder
   */
  setSpaceOrder(aOrder) {
    if (!this.active) {
      return;
    }
    const listed = new Set(aOrder);
    const order = [
      ...aOrder,
      ...readJSONPref(ORDER_PREF, []).filter(uuid => !listed.has(uuid)),
    ];
    this.#setSharedPref(ORDER_PREF, toSharedJSON(order));
  }

  /**
   * A moved space gets a new uuid in its new profile, keep its place.
   *
   * @param {string} aOldUuid
   * @param {string} aNewUuid
   * @param {Array<string>} [aFallbackOrder] used when the shared order
   *   doesn't know the space (yet)
   */
  #replaceInOrder(aOldUuid, aNewUuid, aFallbackOrder = []) {
    let order = readJSONPref(ORDER_PREF, []);
    if (!order.includes(aOldUuid) && Array.isArray(aFallbackOrder)) {
      order = aFallbackOrder.slice();
    }
    const index = order.indexOf(aOldUuid);
    if (index === -1 || !this.active) {
      return;
    }
    order[index] = aNewUuid;
    this.#setSharedPref(ORDER_PREF, toSharedJSON(order));
  }

  // Mark: switching

  /** Profile whose windows this profile hid by taking their place. */
  #hiddenPeerId = null;

  /**
   * A window of another profile to take the place of, for the first window
   * of this profile (it is started for that).
   *
   * @param {string} aFrame see windowFrame()
   * @param {?number} aFromProfileId
   */
  setPendingWindowPlace(aFrame, aFromProfileId) {
    Services.prefs.setStringPref(
      PENDING_WINDOW_PLACE_PREF,
      JSON.stringify({ frame: aFrame, from: aFromProfileId })
    );
  }

  /** @param {Window} aWindow the first window of this profile */
  takePendingWindowPlace(aWindow) {
    const pending = readJSONPref(PENDING_WINDOW_PLACE_PREF, null);
    if (!pending) {
      return;
    }
    Services.prefs.clearUserPref(PENDING_WINDOW_PLACE_PREF);
    this.takeWindowPlace(aWindow, pending.frame, pending.from).catch(
      console.error
    );
  }

  /**
   * Position and size of a window as "x,y,width,height", or null for a full
   * screen window (it has a desktop of its own).
   *
   * @param {Window} aWindow
   */
  windowFrame(aWindow) {
    if (aWindow.windowState === aWindow.STATE_FULLSCREEN) {
      return null;
    }
    return [
      aWindow.screenX,
      aWindow.screenY,
      aWindow.outerWidth,
      aWindow.outerHeight,
    ]
      .map(Math.round)
      .join(",");
  }

  /** macOS Dock support with ZenX's hooks (nsIMacDockSupport patch). */
  get #dock() {
    if (AppConstants.platform !== "macosx") {
      return null;
    }
    const dock = Cc["@mozilla.org/widget/macdocksupport;1"]?.getService(
      Ci.nsIMacDockSupport
    );
    return typeof dock?.zenxSetWindowOpacity === "function" ? dock : null;
  }

  #setWindowOpacity(aWindow, aOpacity) {
    try {
      this.#dock?.zenxSetWindowOpacity(aWindow, aOpacity);
    } catch (e) {
      console.error(e);
    }
  }

  async #fadeIn(aWindow) {
    // Painted at least once before it becomes visible.
    await new Promise(resolve =>
      aWindow.requestAnimationFrame(() =>
        aWindow.requestAnimationFrame(resolve)
      )
    );
    const start = ChromeUtils.now();
    await new Promise(resolve => {
      const step = () => {
        const t = Math.min(1, (ChromeUtils.now() - start) / WINDOW_FADE_MS);
        this.#setWindowOpacity(aWindow, 1 - (1 - t) ** 3);
        if (t < 1 && !aWindow.closed) {
          aWindow.requestAnimationFrame(step);
        } else {
          resolve();
        }
      };
      aWindow.requestAnimationFrame(step);
    });
  }

  #setWindowVisible(aWindow, aVisible) {
    aWindow.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).visibility =
      aVisible;
    aWindow.document.documentElement.toggleAttribute("zenx-hidden", !aVisible);
  }

  #visibleBrowserWindows() {
    return lazy.BrowserWindowTracker.orderedWindows.filter(
      win =>
        !win.closed && !win.document.documentElement.hasAttribute("zenx-hidden")
    );
  }

  /**
   * Shows a window of this profile where another profile's window was, and
   * hides that one, so switching between profiles feels like one window.
   *
   * @param {Window} aWindow
   * @param {?string} aFrame see windowFrame()
   * @param {?number} aFromProfileId profile whose window to hide
   */
  async takeWindowPlace(aWindow, aFrame, aFromProfileId) {
    const fade = !!aFrame && !!this.#dock;
    if (fade) {
      this.#setWindowOpacity(aWindow, 0);
    }
    // Shown first: a hidden window ignores moves and resizes.
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (win.document.documentElement.hasAttribute("zenx-hidden")) {
        this.#setWindowVisible(win, true);
      }
    }
    const [x, y, width, height] = String(aFrame ?? "")
      .split(",")
      .map(Number);
    if (
      [x, y, width, height].every(Number.isFinite) &&
      width > 0 &&
      height > 0
    ) {
      if (aWindow.windowState === aWindow.STATE_FULLSCREEN) {
        aWindow.fullScreen = false;
      }
      aWindow.resizeTo(width, height);
      aWindow.moveTo(x, y);
    }
    aWindow.focus();
    if (fade) {
      try {
        await this.#fadeIn(aWindow);
      } catch (e) {
        console.error(e);
      }
      this.#setWindowOpacity(aWindow, 1);
    }

    const from = this.#getProfile(aFromProfileId);
    if (!aFrame || !from || from.id === this.currentProfileId) {
      return;
    }
    this.#hiddenPeerId = from.id;
    try {
      this.#sps.sendCommandLine(from.path, ["--zenx-hide"], false);
    } catch (e) {
      // That profile isn't running any more.
      this.#hiddenPeerId = null;
    }
  }

  /** Another profile's window took this profile's place: hide our windows. */
  hideWindows() {
    // Whoever we had hidden is shown again by the profile now in front.
    this.#hiddenPeerId = null;
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (!win.closed) {
        this.#setWindowVisible(win, false);
      }
    }
    // One ZenX in the Dock and the app switcher: the profile in front.
    try {
      this.#dock?.zenxHideFromDock();
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * This profile is going away (quit, or its last window closed): bring back
   * the window it hid, in its place.
   */
  #revealHiddenPeer() {
    const peer = this.#getProfile(this.#hiddenPeerId);
    this.#hiddenPeerId = null;
    if (!peer) {
      return;
    }
    const args = ["--zenx-show"];
    const win = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    const frame = win && !win.closed && this.windowFrame(win);
    if (frame) {
      args.push("--zenx-frame", frame);
    }
    try {
      this.#sps.sendCommandLine(peer.path, args, true);
    } catch (e) {
      // It quit too.
    }
  }

  /**
   * Brings up the given space of another profile, starting that profile's
   * process if needed.
   *
   * @param {number} aProfileId
   * @param {string} aSpaceUuid
   * @param {?Window} [aWindow] the window the switch is made from; the other
   *   profile's window takes its place and hides it
   */
  async openRemoteSpace(aProfileId, aSpaceUuid, aWindow = null) {
    const profile = this.#getProfile(aProfileId);
    if (!profile) {
      return;
    }
    // See ZenXCommandLine.sys.mjs, it also cleans up after a relaunch.
    const args = ["--zenx-space", aSpaceUuid];
    // Like Arc, one window: the other profile's window takes this one's place
    // and then hides it.
    const frame = aWindow && this.windowFrame(aWindow);
    if (frame && this.currentProfileId !== null) {
      args.push(
        "--zenx-frame",
        frame,
        "--zenx-from",
        `${this.currentProfileId}`
      );
    }
    try {
      this.#sps.sendCommandLine(profile.path, args, true);
      return;
    } catch (e) {
      // Expected when no instance is running with that profile.
    }
    args.unshift("--profile", profile.path);
    if (Services.appinfo.OS === "Darwin") {
      args.unshift("-foreground");
    }
    this.#sps.execProcess(args);
  }

  // Mark: moving spaces

  /**
   * Serializes a space in the format ZenShareManager imports. Unlike sharing,
   * tabs that are not loaded yet are kept, using the URL from the session
   * store.
   *
   * @param {Window} aWindow window that owns the space
   * @param {string} aSpaceUuid
   * @returns {{item: object, skipped: number}}
   */
  serializeSpace(aWindow, aSpaceUuid) {
    const { gZenWorkspaces, gBrowser } = aWindow;
    const space = gZenWorkspaces.getWorkspaceFromId(aSpaceUuid);
    const element = gZenWorkspaces.workspaceElement(aSpaceUuid);
    if (!space || !element) {
      return null;
    }
    const counter = { skipped: 0 };
    const serializeTab = (tab, pinned) => {
      const url = this.#tabURL(aWindow, tab);
      if (!url || NON_TRANSFERABLE_URL_RE.test(url)) {
        counter.skipped++;
        return null;
      }
      const item = { type: "tab", url };
      if (tab.label) {
        item.label = tab.label;
      }
      const image = tab.getAttribute("image") || "";
      if (PORTABLE_ICON_RE.test(image)) {
        item.image = image;
      }
      if (pinned) {
        item.isPinned = true;
      }
      return item;
    };
    const serializeItems = (children, pinned) => {
      const items = [];
      for (const child of children) {
        if (gBrowser.isTab(child)) {
          if (
            child.hasAttribute("zen-empty-tab") ||
            child.hasAttribute("zen-glance-tab") ||
            child.hasAttribute("zen-essential")
          ) {
            continue;
          }
          const tab = serializeTab(child, pinned);
          if (tab) {
            items.push(tab);
          }
        } else if (child.isZenFolder) {
          const folder = {
            type: "folder",
            name: child.label || "Folder",
            items: serializeItems(child.allItems, false),
          };
          if (child.iconURL) {
            folder.icon = child.iconURL;
          }
          items.push(folder);
        } else if (gBrowser.isTabGroup(child)) {
          const tabs = child.tabs
            .filter(tab => !tab.hasAttribute("zen-empty-tab"))
            .map(tab => serializeTab(tab, tab.pinned))
            .filter(Boolean);
          if (child.hasAttribute("split-view-group") && tabs.length >= 2) {
            items.push({ type: "splitView", tabs });
          } else {
            items.push(...tabs);
          }
        }
      }
      return items;
    };
    const item = {
      type: "space",
      name: space.name || "Space",
      items: [
        ...serializeItems(element.pinnedTabsContainer.children, true),
        ...serializeItems(element.tabsContainer.children, false),
      ],
      sourceUuid: space.uuid,
    };
    if (space.icon) {
      item.icon = space.icon;
    }
    if (space.theme) {
      item.theme = space.theme;
    }
    return { item, skipped: counter.skipped };
  }

  #tabURL(aWindow, aTab) {
    const uri = aTab.linkedBrowser?.currentURI?.spec;
    if (uri && uri !== "about:blank") {
      return uri;
    }
    // Tabs that were never loaded since the session was restored only have
    // their URL in the session store.
    try {
      const state = JSON.parse(lazy.SessionStore.getTabState(aTab));
      const entry = state.entries?.[(state.index || state.entries.length) - 1];
      return entry?.url || state.userTypedValue || uri;
    } catch (e) {
      return uri;
    }
  }

  /**
   * Sends a space to another profile. The space stays here until the target
   * confirms it adopted it.
   *
   * @param {Window} aWindow window that owns the space
   * @param {string} aSpaceUuid
   * @param {number|"new"} aTargetProfileId a profile id, or "new" to create a
   *   new profile first.
   */
  async moveSpaceToProfile(aWindow, aSpaceUuid, aTargetProfileId) {
    if (!this.available) {
      return false;
    }
    const serialized = this.serializeSpace(aWindow, aSpaceUuid);
    if (!serialized) {
      return false;
    }

    let profile;
    if (aTargetProfileId === "new") {
      profile = await this.createProfile();
    } else {
      profile = this.#getProfile(aTargetProfileId);
    }
    if (!profile || profile.id === this.currentProfileId) {
      return false;
    }

    // Remember where every space is before this one moves out, so it keeps
    // its place: until now there may have been no shared order at all.
    const order = this.orderSpaces([
      ...aWindow.gZenWorkspaces.getWorkspaces().map(space => space.uuid),
      ...this.getRemoteSpaces().flatMap(({ spaces }) =>
        spaces.map(space => space.uuid)
      ),
    ]);
    this.setSpaceOrder(order);

    const handoffId = Services.uuid.generateUUID().toString().slice(1, -1);
    const handoffPref = HANDOFF_PREFIX + profile.id;
    const handoffs = readJSONPref(handoffPref, {});
    handoffs[handoffId] = {
      v: FORMAT_VERSION,
      id: handoffId,
      from: this.currentProfileId,
      at: Date.now(),
      space: serialized.item,
      // The shared order reaches the database asynchronously, the target may
      // start before it does.
      order,
    };
    const pending = readJSONPref(PENDING_MOVES_PREF, {});
    pending[aSpaceUuid] = { target: profile.id, handoffId, at: Date.now() };
    Services.prefs.setStringPref(PENDING_MOVES_PREF, JSON.stringify(pending));
    this.#setSharedPref(handoffPref, toSharedJSON(handoffs));
    // The source window shows the space as moving until it is adopted.
    this.#notifyListeners();

    this.#sps.launchInstance(profile);
    return true;
  }

  /**
   * Creates a profile for spaces: no Zen welcome screen or "updated" popup on
   * its first start, and the profile editor (name, avatar, theme) opens
   * instead of Firefox's new profile page, which Zen's startup hides.
   *
   * @param {object} [aOptions]
   * @param {string} [aOptions.name] name the profile instead of letting the
   *   user pick one in the profile editor
   * @returns {Promise<SelectableProfile>}
   */
  async createProfile({ name } = {}) {
    // Also sets up the profile group on the first use.
    const profile = await this.#sps.createNewProfile(false);
    if (name) {
      await profile.setNameAsync(name);
    }
    const prefs = [
      ["zen.welcome-screen.seen", true],
      ["zen.updates.last-version", Services.appinfo.version],
      ["zen.updates.last-build-id", Services.appinfo.appBuildID],
      [OPEN_PROFILE_EDITOR_PREF, !name],
      [FRESH_PROFILE_PREF, true],
    ];
    await IOUtils.writeUTF8(
      PathUtils.join(profile.path, "prefs.js"),
      prefs
        .map(
          ([pref, value]) =>
            `user_pref(${JSON.stringify(pref)}, ${JSON.stringify(value)});\n`
        )
        .join(""),
      { mode: "appendOrCreate" }
    );
    await this.disableStartupProfileSelector();
    await this.#refreshProfiles();
    // The first new profile also makes this one part of a profile group,
    // which knows nothing about this profile's spaces yet.
    this.#publishRegistry();
    return profile;
  }

  // Mark: import

  /**
   * Where data imported from another browser's profile belongs, like Arc's
   * "Work" profile: the profile with the same name, else this profile for the
   * other browser's default profile, else a new profile named like it.
   *
   * @param {string} aName name of the other browser's profile
   * @param {boolean} aIsDefault it is the other browser's default profile
   * @returns {Promise<?SelectableProfile>} null to import into this profile
   */
  async getImportTargetProfile(aName, aIsDefault) {
    if (!this.available || !aName) {
      return null;
    }
    const sameName = this.#profiles.find(profile => profile.name === aName);
    if (sameName) {
      return sameName.id === this.currentProfileId ? null : sameName;
    }
    if (aIsDefault) {
      return null;
    }
    return this.createProfile({ name: aName });
  }

  /**
   * Runs a migration from the import wizard in another profile (starting it
   * if needed), so that the data lands in that profile only.
   *
   * @param {SelectableProfile} aProfile
   * @param {{migrator: string, profile: object, items: number}} aImport
   *   arguments of MigratorBase.migrate()
   * @returns {Promise<?{results: object, quantities: object}>} what the
   *   other profile imported, null if it didn't answer in time
   */
  async importInProfile(aProfile, aImport) {
    const handoffId = Services.uuid.generateUUID().toString().slice(1, -1);
    const resultPref = IMPORT_RESULT_PREFIX + handoffId;
    const result = new Promise(resolve => {
      let timer;
      const observer = () => {
        const value = readJSONPref(resultPref, null);
        if (value) {
          done(value);
        }
      };
      const done = value => {
        Services.prefs.removeObserver(resultPref, observer);
        lazy.clearTimeout(timer);
        resolve(value);
      };
      Services.prefs.addObserver(resultPref, observer);
      timer = lazy.setTimeout(() => done(null), IMPORT_TIMEOUT_MS);
    });

    const handoffPref = HANDOFF_PREFIX + aProfile.id;
    const handoffs = readJSONPref(handoffPref, {});
    handoffs[handoffId] = {
      v: FORMAT_VERSION,
      id: handoffId,
      from: this.currentProfileId,
      at: Date.now(),
      import: aImport,
    };
    this.#setSharedPref(handoffPref, toSharedJSON(handoffs));
    this.#sps.launchInstance(aProfile);

    const value = await result;
    this.#setSharedPref(resultPref, null);
    return value?.v === FORMAT_VERSION ? value : null;
  }

  async #runImport(aHandoffId, aImport) {
    const results = {};
    try {
      const migrator = await lazy.MigrationUtils.getMigrator(aImport.migrator);
      if (!migrator) {
        throw new Error(`No migrator ${aImport.migrator}`);
      }
      await migrator.migrate(
        aImport.items,
        false,
        aImport.profile,
        (type, success) => (results[type] = success)
      );
    } catch (e) {
      console.error("ZenX: import for another profile failed", e);
    }
    this.#setSharedPref(
      IMPORT_RESULT_PREFIX + aHandoffId,
      toSharedJSON({
        v: FORMAT_VERSION,
        results,
        quantities: { ...lazy.MigrationUtils._importQuantities },
      })
    );
  }

  /**
   * Firefox shows a profile picker at startup once a second profile exists.
   * In ZenX profiles belong to spaces, so the app always starts in the last
   * used profile and new profiles are made from a space's "Set Profile" menu.
   */
  async disableStartupProfileSelector() {
    try {
      if (this.#sps.groupToolkitProfile?.showProfileSelector) {
        await this.#sps.setShowProfileSelectorWindow(false);
      }
    } catch (e) {
      console.error("ZenX: could not turn off the startup profile picker", e);
    }
  }

  /** Spaces of this profile waiting to be adopted by another profile. */
  getPendingMoves() {
    return readJSONPref(PENDING_MOVES_PREF, {});
  }

  /**
   * Forget a pending move, the space stays in this profile.
   *
   * @param {string} aSpaceUuid
   */
  cancelPendingMove(aSpaceUuid) {
    const pending = readJSONPref(PENDING_MOVES_PREF, {});
    const move = pending[aSpaceUuid];
    if (!move) {
      return;
    }
    delete pending[aSpaceUuid];
    Services.prefs.setStringPref(PENDING_MOVES_PREF, JSON.stringify(pending));
    const handoffPref = HANDOFF_PREFIX + move.target;
    const handoffs = readJSONPref(handoffPref, {});
    if (handoffs[move.handoffId]) {
      delete handoffs[move.handoffId];
      this.#setSharedPref(
        handoffPref,
        Object.keys(handoffs).length ? toSharedJSON(handoffs) : null
      );
    }
    this.#notifyListeners();
  }

  /**
   * Removes the local copy of every pending space that another profile now
   * publishes as `movedFrom` it.
   */
  #settlePendingMoves() {
    const pending = readJSONPref(PENDING_MOVES_PREF, {});
    const uuids = Object.keys(pending);
    if (!uuids.length) {
      return;
    }
    const adopted = new Set();
    const knownProfiles = new Set(this.#profiles.map(profile => profile.id));
    for (const { spaces } of this.getRemoteSpaces()) {
      for (const space of spaces) {
        if (space.movedFrom && pending[space.movedFrom]) {
          adopted.add(space.movedFrom);
        }
      }
    }
    let changed = false;
    const win = this.#getSpacesWindow();
    for (const uuid of uuids) {
      if (adopted.has(uuid)) {
        if (!win) {
          continue;
        }
        if (win.gZenWorkspaces.getWorkspaceFromId(uuid)) {
          win.gZenWorkspaces.removeWorkspace(uuid);
        }
        delete pending[uuid];
        changed = true;
      } else if (
        this.#profiles.length &&
        !knownProfiles.has(pending[uuid].target)
      ) {
        // The target profile was deleted, keep the space here.
        delete pending[uuid];
        changed = true;
      }
    }
    if (changed) {
      Services.prefs.setStringPref(PENDING_MOVES_PREF, JSON.stringify(pending));
    }
  }

  /** Imports the spaces other profiles sent to this one. */
  processIncomingHandoffs() {
    this.#handoffQueue = this.#handoffQueue
      .then(() => this.#processIncomingHandoffs())
      .catch(console.error);
    return this.#handoffQueue;
  }

  async #processIncomingHandoffs() {
    if (!this.active) {
      return;
    }
    const handoffPref = HANDOFF_PREFIX + this.currentProfileId;
    const handoffs = readJSONPref(handoffPref, {});
    const ids = Object.keys(handoffs);
    if (!ids.length) {
      return;
    }
    const win = this.#getSpacesWindow();
    if (!win) {
      // Picked up again by the first window (see ZenXProfileSpacesUI).
      return;
    }
    await win.gZenWorkspaces.promiseInitialized;

    const imported = readJSONPref(IMPORTED_HANDOFFS_PREF, []);
    const done = [];
    for (const id of ids) {
      const handoff = handoffs[id];
      if (
        handoff?.v === FORMAT_VERSION &&
        handoff.import &&
        !imported.includes(id)
      ) {
        // Saved first: an import that takes the browser down must not run
        // again on every start.
        imported.push(id);
        Services.prefs.setStringPref(
          IMPORTED_HANDOFFS_PREF,
          JSON.stringify(imported.slice(-MAX_IMPORTED_HANDOFFS))
        );
        done.push(id);
        await this.#runImport(id, handoff.import);
        continue;
      } else if (
        handoff?.v === FORMAT_VERSION &&
        handoff.space?.type === "space" &&
        !imported.includes(id) &&
        !this.#hasSpaceMovedFrom(win, handoff.space.sourceUuid)
      ) {
        try {
          await this.#importSpace(win, handoff.space, handoff.order);
        } catch (e) {
          console.error("ZenX: could not import space from another profile", e);
          continue;
        }
      }
      imported.push(id);
      done.push(id);
    }
    Services.prefs.setStringPref(
      IMPORTED_HANDOFFS_PREF,
      JSON.stringify(imported.slice(-MAX_IMPORTED_HANDOFFS))
    );
    await this.#removeStarterSpaces(win);
    // Read again, other handoffs may have arrived during a long import.
    const remaining = readJSONPref(handoffPref, {});
    for (const id of done) {
      delete remaining[id];
    }
    this.#setSharedPref(
      handoffPref,
      Object.keys(remaining).length ? toSharedJSON(remaining) : null
    );
    // Publish right away, this is what lets the source drop its copy.
    this.#publishTask.disarm();
    this.#publishRegistry();
    win.focus();
  }

  /**
   * A profile made for a space should only hold that space, like in Arc, not
   * also the empty one Zen creates on first start.
   *
   * @param {Window} aWindow
   */
  async #removeStarterSpaces(aWindow) {
    if (!Services.prefs.getBoolPref(FRESH_PROFILE_PREF, false)) {
      return;
    }
    const { gZenWorkspaces } = aWindow;
    const spaces = gZenWorkspaces.getWorkspaces();
    const arrived = space => space.zenxMovedFrom || space.zenxArcId;
    if (!spaces.some(arrived)) {
      return;
    }
    Services.prefs.clearUserPref(FRESH_PROFILE_PREF);
    for (const space of spaces) {
      const hasTabs = gZenWorkspaces.allStoredTabs.some(
        tab =>
          tab.getAttribute("zen-workspace-id") === space.uuid &&
          !tab.hasAttribute("zen-empty-tab") &&
          !tab.linkedBrowser?.currentURI?.spec.startsWith("about:editprofile")
      );
      if (!arrived(space) && !hasTabs) {
        await gZenWorkspaces.removeWorkspace(space.uuid);
      }
    }
  }

  #hasSpaceMovedFrom(aWindow, aSourceUuid) {
    return aWindow.gZenWorkspaces
      .getWorkspaces()
      .some(space => space.zenxMovedFrom === aSourceUuid);
  }

  async #importSpace(aWindow, aItem, aOrder) {
    const { gZenWorkspaces, gZenShareManager, gZenThemePicker } = aWindow;
    const workspace = await gZenShareManager.importSpace({
      type: "space",
      name: aItem.name,
      items: aItem.items ?? [],
    });
    if (!workspace) {
      throw new Error("Spaces are disabled in this window");
    }
    workspace.zenxMovedFrom = aItem.sourceUuid;
    this.#replaceInOrder(aItem.sourceUuid, workspace.uuid, aOrder);
    if (aItem.icon) {
      workspace.icon = aItem.icon;
    }
    if (aItem.theme) {
      workspace.theme = aItem.theme;
    }
    gZenWorkspaces.saveWorkspace(workspace);
    gZenThemePicker.onWorkspaceChange(workspace);
    return workspace;
  }
}

export const ZenXProfileSpaces = new nsZenXProfileSpaces();
