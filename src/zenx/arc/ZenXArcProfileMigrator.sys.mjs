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
 * folders and favorites become essentials.
 *
 * Arc profiles map to ZenX profiles: an Arc profile is imported into the ZenX
 * profile with the same name, a new one if there is none (Arc's default
 * profile goes to the current profile). Everything picked in the wizard is
 * then imported by that profile, so e.g. Arc's "Work" history doesn't end up
 * in the personal profile.
 */

import { ChromeProfileMigrator } from "resource:///modules/ChromeProfileMigrator.sys.mjs";
import { MigrationUtils } from "resource:///modules/MigrationUtils.sys.mjs";
import {
  getArcUserDataPath,
  importArcIntoWindow,
  readArcSidebar,
} from "resource:///modules/zenx/arc/ZenXArcImporter.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenXProfileSpaces: "resource:///modules/zenx/ZenXProfileSpaces.sys.mjs",
});

const DEFAULT_ARC_PROFILE = "Default";

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

  async migrate(aItems, aStartup, aProfile, aProgressCallback = () => {}) {
    const target =
      aProfile && !aProfile.zenxImportHere && !aStartup
        ? await lazy.ZenXProfileSpaces.getImportTargetProfile(
            aProfile.name,
            aProfile.id === DEFAULT_ARC_PROFILE
          )
        : null;
    if (!target) {
      return super.migrate(aItems, aStartup, aProfile, aProgressCallback);
    }

    const types = new Set(
      (await this.getResources(aProfile))
        .map(resource => resource.type)
        .filter(
          type => aItems == MigrationUtils.resourceTypes.ALL || aItems & type
        )
    );
    const result = await lazy.ZenXProfileSpaces.importInProfile(target, {
      migrator: this.constructor.key,
      profile: { ...aProfile, zenxImportHere: true },
      items: aItems,
    });
    for (const key of Object.keys(MigrationUtils._importQuantities)) {
      MigrationUtils._importQuantities[key] = result?.quantities?.[key] ?? 0;
    }
    for (const type of types) {
      aProgressCallback(type, result?.results?.[type] ?? false);
    }
    return undefined;
  }

  async getResources(aProfile) {
    const resources = await super.getResources(aProfile);
    const sidebar = await readArcSidebar(
      aProfile?.id ?? DEFAULT_ARC_PROFILE
    ).catch(e => {
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
