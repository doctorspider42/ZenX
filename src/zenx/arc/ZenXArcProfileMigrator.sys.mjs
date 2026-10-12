/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ZenX: "Arc" in the import wizard (Settings → Import, and Zen's welcome
 * screen).
 *
 * Arc is Chromium, so history, logins, payment methods and form data come
 * from the regular Chromium migrator. On top of that Arc's sidebar is turned
 * into Zen spaces: pinned tabs stay pinned tabs (not bookmarks), folders stay
 * folders and favorites become essentials. Only the spaces of the Arc profile
 * picked in the wizard are imported, so each Arc profile can be imported into
 * its own ZenX profile.
 */

import { ChromeProfileMigrator } from "resource:///modules/ChromeProfileMigrator.sys.mjs";
import { MigrationUtils } from "resource:///modules/MigrationUtils.sys.mjs";
import {
  getArcUserDataPath,
  importArcIntoWindow,
  readArcSidebar,
} from "resource:///modules/zenx/arc/ZenXArcImporter.sys.mjs";

export class ArcProfileMigrator extends ChromeProfileMigrator {
  static get key() {
    return "arc";
  }

  static get displayNameL10nID() {
    return "migration-wizard-migrator-display-name-arc";
  }

  static get brandImage() {
    return "chrome://browser/content/zenx/arc-brand.svg";
  }

  _chromeUserDataPathSuffix = "Arc";
  _keychainServiceName = "Arc Safe Storage";
  _keychainAccountName = "Arc";

  // Arc keeps its Chromium data in "Arc/User Data", which the shared
  // Chromium path table doesn't know about.
  async _getChromeUserDataPathIfExists(noRemapping = false) {
    if (this._chromeUserDataPath === undefined) {
      const path = getArcUserDataPath();
      this._chromeUserDataPath =
        path && (await IOUtils.exists(path)) ? path : null;
    }
    return super._getChromeUserDataPathIfExists(noRemapping);
  }

  async getResources(aProfile) {
    const resources = await super.getResources(aProfile);
    const sidebar = await readArcSidebar(aProfile?.id ?? "Default").catch(e => {
      console.error("ZenX: could not read Arc's sidebar", e);
      return null;
    });
    if (sidebar && (sidebar.spaces.length || sidebar.essentials.length)) {
      resources.push({
        // Shown as "Bookmarks" in the wizard: Arc's pinned tabs are what
        // other browsers call bookmarks.
        type: MigrationUtils.resourceTypes.BOOKMARKS,
        async migrate(aCallback) {
          try {
            const { tabs, essentials } = await importArcIntoWindow(sidebar);
            MigrationUtils._importQuantities.bookmarks += tabs + essentials;
            aCallback(true);
          } catch (e) {
            console.error("ZenX: Arc spaces import failed", e);
            aCallback(false);
          }
        },
      });
    }
    return resources;
  }
}
