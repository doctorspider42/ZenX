/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ZenX: window side of spaces bound to Firefox profiles.
 *
 * - Shows the spaces of the other profiles after this profile's spaces in the
 *   sidebar space switcher (`#zen-workspaces-button`), badged with the
 *   profile's color. Clicking one switches to that profile's window.
 * - Adds "Move to Profile" to the space context menu.
 * - Feeds this window's space changes to the shared registry.
 *
 * See ZenXProfileSpaces.sys.mjs for how profiles talk to each other.
 */

/* global gBrowser, gZenWorkspaces, gZenXProfileSpaces */

const { ZenXProfileSpaces, OPEN_PROFILE_EDITOR_PREF } =
  ChromeUtils.importESModule(
    "resource:///modules/zenx/ZenXProfileSpaces.sys.mjs"
  );

const STYLESHEET = "chrome://browser/content/zenx/zenx-profile-spaces.css";
const ROOT_HAS_REMOTE_ATTR = "zenx-has-remote-spaces";
// Set while spaces are bound to Firefox profiles. Zen's per-space container
// picker (labelled "Profile" in Zen) is then hidden so the two don't mix up.
const ROOT_PROFILE_SPACES_ATTR = "zenx-profile-spaces";

class nsZenXProfileSpacesUI {
  #listener = () => this.#update();
  #moveMenu = null;

  async init() {
    await gZenWorkspaces.promiseInitialized;
    if (gZenWorkspaces.privateWindowOrDisabled) {
      return;
    }
    document.l10n.addResourceIds(["browser/zenx-profiles.ftl"]);
    window.windowUtils.loadSheetUsingURIString(
      STYLESHEET,
      Ci.nsIDOMWindowUtils.AUTHOR_SHEET
    );

    window.addEventListener("ZenWorkspaceDataChanged", this);
    window.addEventListener("ZenWorkspacesUIUpdate", this);
    window.addEventListener("unload", this, { once: true });
    document
      .getElementById("zenWorkspaceMoreActions")
      ?.addEventListener("popupshowing", this);
    // Dragging a space past ours can leave it after them when the drop
    // position is rejected, put ours back at the end.
    document
      .getElementById("zen-workspaces-button")
      ?.addEventListener("mousedown", () =>
        document.addEventListener("mouseup", () => setTimeout(this.#listener), {
          once: true,
        })
      );

    ZenXProfileSpaces.addListener(this.#listener);
    await ZenXProfileSpaces.init();
    this.#update();
    ZenXProfileSpaces.schedulePublish();
    // Spaces sent here while this profile was not running.
    await ZenXProfileSpaces.processIncomingHandoffs();
    this.#maybeOpenProfileEditor();
  }

  handleEvent(event) {
    switch (event.type) {
      case "ZenWorkspaceDataChanged":
        ZenXProfileSpaces.schedulePublish();
        break;
      case "ZenWorkspacesUIUpdate":
        // The switcher re-renders this profile's spaces, keep ours after them.
        this.#update();
        break;
      case "popupshowing":
        if (event.target.id === "zenWorkspaceMoreActions") {
          this.#onSpaceMenuShowing(event.target);
        } else if (event.target === this.#moveMenu?.menupopup) {
          this.#fillMoveMenu(event.target);
        }
        break;
      case "command":
        this.#onCommand(event);
        break;
      case "unload":
        ZenXProfileSpaces.removeListener(this.#listener);
        break;
    }
  }

  // Mark: space switcher

  #update() {
    document.documentElement.toggleAttribute(
      ROOT_PROFILE_SPACES_ATTR,
      ZenXProfileSpaces.available
    );
    this.#renderRemoteSpaces();
    this.#renderPendingMoves();
  }

  #renderRemoteSpaces() {
    const switcher = document.getElementById("zen-workspaces-button");
    if (!switcher) {
      return;
    }
    for (const node of switcher.querySelectorAll(
      ".zenx-remote-space, .zenx-remote-spaces-separator"
    )) {
      node.remove();
    }

    const groups = ZenXProfileSpaces.getRemoteSpaces();
    document.documentElement.toggleAttribute(
      ROOT_HAS_REMOTE_ATTR,
      !!groups.length
    );
    for (const { profile, spaces } of groups) {
      const separator = document.createXULElement("box");
      separator.className = "zenx-remote-spaces-separator";
      switcher.appendChild(separator);
      for (const space of spaces) {
        switcher.appendChild(this.#createRemoteSpaceButton(profile, space));
      }
    }
  }

  #createRemoteSpaceButton(profile, space) {
    const button = document.createXULElement("toolbarbutton");
    button.className = "subviewbutton toolbarbutton-1 zenx-remote-space";
    button.setAttribute("zenx-profile-id", profile.id);
    button.setAttribute("zenx-space-id", space.uuid);
    document.l10n.setAttributes(button, "zenx-remote-space-button", {
      space: space.name || "",
      profile: profile.name,
    });
    if (profile.themeBg) {
      button.style.setProperty("--zenx-profile-color", profile.themeBg);
    }

    if (space.icon?.endsWith(".svg") || space.icon?.startsWith("data:")) {
      const image = document.createElement("img");
      image.className = "zen-workspace-icon";
      image.src = space.icon;
      button.appendChild(image);
    } else {
      const label = document.createXULElement("label");
      label.className = "zen-workspace-icon no-squircles";
      if (space.icon) {
        label.textContent = space.icon;
      } else {
        label.setAttribute("no-icon", "true");
      }
      button.appendChild(label);
    }

    button.addEventListener("command", this);
    return button;
  }

  #renderPendingMoves() {
    const pending = ZenXProfileSpaces.getPendingMoves();
    for (const button of document.querySelectorAll(
      "#zen-workspaces-button toolbarbutton[zen-workspace-id]"
    )) {
      button.toggleAttribute(
        "zenx-moving",
        !!pending[button.getAttribute("zen-workspace-id")]
      );
    }
  }

  // Mark: context menu

  #spaceIdFromMenu(menu) {
    return (
      menu.triggerNode
        ?.closest?.("[zen-workspace-id]")
        ?.getAttribute("zen-workspace-id") || gZenWorkspaces.activeWorkspace
    );
  }

  /** First start of a profile ZenX created: let the user name it. */
  #maybeOpenProfileEditor() {
    if (!Services.prefs.getBoolPref(OPEN_PROFILE_EDITOR_PREF, false)) {
      return;
    }
    Services.prefs.clearUserPref(OPEN_PROFILE_EDITOR_PREF);
    gBrowser.selectedTab = gBrowser.addTrustedTab("about:editprofile");
  }

  #onSpaceMenuShowing(menu) {
    document.documentElement.toggleAttribute(
      ROOT_PROFILE_SPACES_ATTR,
      ZenXProfileSpaces.available
    );
    if (!this.#moveMenu) {
      this.#moveMenu = document.createXULElement("menu");
      this.#moveMenu.id = "zenx-context-move-space-to-profile";
      document.l10n.setAttributes(this.#moveMenu, "zenx-move-space-to-profile");
      const popup = document.createXULElement("menupopup");
      popup.addEventListener("popupshowing", this);
      this.#moveMenu.appendChild(popup);
      menu.insertBefore(
        this.#moveMenu,
        document.getElementById("context_zenWorkspacesSeparator")
      );
    }
    this.#moveMenu.hidden = !ZenXProfileSpaces.available;
    this.#moveMenu.setAttribute("zenx-space-id", this.#spaceIdFromMenu(menu));
  }

  #fillMoveMenu(popup) {
    popup.replaceChildren();
    const spaceId = this.#moveMenu.getAttribute("zenx-space-id");

    if (ZenXProfileSpaces.getPendingMoves()[spaceId]) {
      const cancel = document.createXULElement("menuitem");
      document.l10n.setAttributes(cancel, "zenx-move-space-cancel");
      cancel.setAttribute("zenx-action", "cancel-move");
      cancel.addEventListener("command", this);
      popup.appendChild(cancel);
      popup.appendChild(document.createXULElement("menuseparator"));
    }

    // Like Arc: every profile, the space's own one checked.
    for (const profile of ZenXProfileSpaces.getProfiles()) {
      const item = document.createXULElement("menuitem");
      item.setAttribute("label", profile.name);
      if (profile.isCurrent) {
        item.setAttribute("type", "checkbox");
        item.setAttribute("checked", "true");
      } else {
        item.className = "menuitem-iconic";
        item.setAttribute("zenx-action", "move");
        item.setAttribute("zenx-profile-id", profile.id);
        if (profile.avatarURL) {
          item.setAttribute("image", profile.avatarURL);
        }
        item.addEventListener("command", this);
      }
      popup.appendChild(item);
    }
    if (popup.childElementCount) {
      popup.appendChild(document.createXULElement("menuseparator"));
    }
    const newProfile = document.createXULElement("menuitem");
    document.l10n.setAttributes(newProfile, "zenx-move-space-new-profile");
    newProfile.setAttribute("zenx-action", "move");
    newProfile.setAttribute("zenx-profile-id", "new");
    newProfile.addEventListener("command", this);
    popup.appendChild(newProfile);
  }

  async #onCommand(event) {
    const target = event.currentTarget;
    if (target.classList.contains("zenx-remote-space")) {
      await ZenXProfileSpaces.openRemoteSpace(
        parseInt(target.getAttribute("zenx-profile-id")),
        target.getAttribute("zenx-space-id")
      );
      return;
    }

    const spaceId = this.#moveMenu.getAttribute("zenx-space-id");
    switch (target.getAttribute("zenx-action")) {
      case "cancel-move":
        ZenXProfileSpaces.cancelPendingMove(spaceId);
        break;
      case "move": {
        const rawProfileId = target.getAttribute("zenx-profile-id");
        const profileId =
          rawProfileId === "new" ? "new" : parseInt(rawProfileId);
        const profileName =
          profileId === "new"
            ? null
            : ZenXProfileSpaces.getProfiles().find(p => p.id === profileId)
                ?.name;
        if (await this.#confirmMove(spaceId, profileName)) {
          await ZenXProfileSpaces.moveSpaceToProfile(
            window,
            spaceId,
            profileId
          );
        }
        break;
      }
    }
  }

  async #confirmMove(spaceId, profileName) {
    const space = gZenWorkspaces.getWorkspaceFromId(spaceId);
    if (!space) {
      return false;
    }
    const skipped = ZenXProfileSpaces.serializeSpace(window, spaceId)?.skipped;
    const [title, body] = await document.l10n.formatValues([
      { id: "zenx-move-space-confirm-title" },
      {
        id: profileName
          ? "zenx-move-space-confirm-body"
          : "zenx-move-space-confirm-body-new-profile",
        args: { space: space.name || "", profile: profileName, skipped },
      },
    ]);
    return Services.prompt.confirm(window, title, body);
  }
}

window.gZenXProfileSpaces = new nsZenXProfileSpacesUI();
gZenXProfileSpaces.init().catch(console.error);
