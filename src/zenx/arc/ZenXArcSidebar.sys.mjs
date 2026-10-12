/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ZenX: reads Arc's sidebar (`StorableSidebar.json`) into Zen terms.
 *
 * Pure data transformation without Gecko dependencies, so it can be unit
 * tested and run against a real Arc profile with plain Node.
 *
 * Arc concepts → Zen concepts:
 * - space            → space (name, emoji icon, primary color as theme)
 * - pinned tab       → pinned tab of that space (not a bookmark)
 * - folder ("list")  → folder (folders live with pinned tabs in Zen too)
 * - split view       → split view
 * - unpinned tab     → normal tab of that space
 * - favorite (top app) → essential
 *
 * Space and item lists in Arc's file alternate between an id and the object,
 * e.g. `["id1", {id: "id1", ...}, "id2", {...}]`.
 */

// Pages that only exist inside Arc or cannot be reopened elsewhere.
const NON_IMPORTABLE_URL_RE =
  /^(arc:|chrome:|chrome-extension:|about:blank|blob:|data:|file:)/i;

function objects(alternating) {
  return (alternating ?? []).filter(
    entry => entry && typeof entry === "object"
  );
}

/**
 * Arc stores which profile a space or favorites container belongs to as
 * `{ default: true }` or `{ custom: { _0: { directoryBasename: "Profile 1" } } }`.
 *
 * @param {?object} profile
 * @returns {string} the Chromium profile directory name, e.g. "Default"
 */
export function arcProfileDirectory(profile) {
  if (!profile || profile.default) {
    return "Default";
  }
  const custom = profile.custom?._0 ?? profile.custom;
  return custom?.directoryBasename || custom?.directoryName || "Default";
}

/**
 * Container ids of a space by role. Newer Arc versions use
 * `newContainerIDs: [{ pinned: {} }, "id", { unpinned: {...} }, "id"]`,
 * older ones `containerIDs: ["pinned", "id", "unpinned", "id"]`.
 *
 * @param {object} space
 */
function spaceContainers(space) {
  const result = { pinned: null, unpinned: null };
  const fromList = list => {
    for (let i = 0; i + 1 < (list?.length ?? 0); i += 2) {
      const role =
        typeof list[i] === "string" ? list[i] : Object.keys(list[i] ?? {})[0];
      if (role in result && typeof list[i + 1] === "string") {
        result[role] ??= list[i + 1];
      }
    }
  };
  fromList(space.newContainerIDs);
  fromList(space.containerIDs);
  return result;
}

function spaceIcon(space) {
  const iconType = space.customInfo?.iconType ?? {};
  if (typeof iconType.emoji_v2 === "string" && iconType.emoji_v2) {
    return iconType.emoji_v2;
  }
  if (Number.isInteger(iconType.emoji)) {
    try {
      return String.fromCodePoint(iconType.emoji);
    } catch (e) {
      return undefined;
    }
  }
  // Named Arc icons (SF Symbols) have no equivalent.
  return undefined;
}

function toByte(component) {
  return Math.max(0, Math.min(255, Math.round((component ?? 0) * 255)));
}

/**
 * The space's primary color as a Zen gradient theme with one color.
 *
 * @param {object} space
 */
function spaceTheme(space) {
  const palette = space.customInfo?.windowTheme?.primaryColorPalette;
  const color = palette?.midTone ?? palette?.shaded;
  if (!color || typeof color.red !== "number") {
    return undefined;
  }
  return {
    type: "gradient",
    gradientColors: [
      {
        c: [toByte(color.red), toByte(color.green), toByte(color.blue)],
        isCustom: false,
        isPrimary: true,
        algorithm: "",
        lightness: 50,
        type: "explicit-lightness",
      },
    ],
  };
}

/**
 * @param {object} sidebarJSON parsed StorableSidebar.json
 * @param {object} [options]
 * @param {string} [options.profileDirectory="Default"] only spaces and
 *   favorites of this Arc profile are returned
 * @returns {{
 *   spaces: Array<{arcId: string, name: string, icon?: string, theme?: object,
 *     items: Array<object>}>,
 *   essentials: Array<{url: string, label?: string}>,
 *   skipped: number,
 * }} spaces with items in the format ZenShareManager.importSpace() takes
 */
export function parseArcSidebar(
  sidebarJSON,
  { profileDirectory = "Default" } = {}
) {
  const containers = sidebarJSON?.sidebar?.containers ?? [];
  const data = containers.find(container => Array.isArray(container?.spaces));
  if (!data) {
    throw new Error("Not an Arc sidebar file");
  }

  const items = new Map();
  for (const item of objects(data.items)) {
    if (typeof item.id === "string") {
      items.set(item.id, item);
    }
  }
  const childrenOf = id => {
    const item = items.get(id);
    const ids = item?.childrenIds?.length
      ? item.childrenIds
      : // Some containers (e.g. split views) only link children to parents.
        [...items.values()]
          .filter(child => child.parentID === id)
          .map(child => child.id);
    return ids.map(childId => items.get(childId)).filter(Boolean);
  };

  let skipped = 0;
  const convertTab = (item, pinned) => {
    const url = item.data?.tab?.savedURL;
    if (!url || NON_IMPORTABLE_URL_RE.test(url)) {
      skipped++;
      return null;
    }
    const tab = { type: "tab", url };
    const label = item.title || item.data.tab.savedTitle;
    if (label) {
      tab.label = label;
    }
    if (pinned) {
      tab.isPinned = true;
    }
    return tab;
  };
  const convert = (item, pinned) => {
    const itemData = item.data ?? {};
    if (itemData.tab) {
      const tab = convertTab(item, pinned);
      return tab ? [tab] : [];
    }
    if (itemData.list) {
      const children = childrenOf(item.id).flatMap(child =>
        convert(child, pinned)
      );
      // Zen folders hold pinned tabs, unpinned "folders" are flattened.
      return pinned
        ? [{ type: "folder", name: item.title || "Folder", items: children }]
        : children;
    }
    if (itemData.splitView) {
      const tabs = childrenOf(item.id).flatMap(child => convert(child, pinned));
      return tabs.length >= 2 && tabs.every(tab => tab.type === "tab")
        ? [{ type: "splitView", tabs }]
        : tabs;
    }
    // Easels, notes, the welcome page and other Arc-only items.
    skipped++;
    return [];
  };
  const convertContainer = (id, pinned) =>
    id ? childrenOf(id).flatMap(child => convert(child, pinned)) : [];

  const spaces = [];
  for (const space of objects(data.spaces)) {
    if (arcProfileDirectory(space.profile) !== profileDirectory) {
      continue;
    }
    const { pinned, unpinned } = spaceContainers(space);
    const result = {
      arcId: space.id,
      name: space.title || "Space",
      items: [
        ...convertContainer(pinned, true),
        ...convertContainer(unpinned, false),
      ],
    };
    const icon = spaceIcon(space);
    if (icon) {
      result.icon = icon;
    }
    const theme = spaceTheme(space);
    if (theme) {
      result.theme = theme;
    }
    spaces.push(result);
  }

  const essentials = [];
  const topApps = data.topAppsContainerIDs ?? [];
  for (let i = 0; i + 1 < topApps.length; i += 2) {
    if (arcProfileDirectory(topApps[i]) !== profileDirectory) {
      continue;
    }
    for (const item of childrenOf(topApps[i + 1])) {
      const tab = item.data?.tab ? convertTab(item, false) : null;
      if (tab) {
        essentials.push({ url: tab.url, label: tab.label });
      } else if (!item.data?.tab) {
        skipped++;
      }
    }
  }

  return { spaces, essentials, skipped };
}

/**
 * Counts for showing what an import would bring in.
 *
 * @param {object} parsed result of parseArcSidebar()
 * @param {Array<object>} parsed.spaces
 * @param {Array<object>} parsed.essentials
 * @param {number} parsed.skipped
 */
export function summarizeArcImport({ spaces, essentials, skipped }) {
  const count = (list, pred) =>
    list.reduce(
      (n, item) =>
        n + (pred(item) ? 1 : 0) + count(item.items ?? item.tabs ?? [], pred),
      0
    );
  return {
    spaces: spaces.length,
    pinnedTabs: spaces.reduce(
      (n, s) => n + count(s.items, i => i.type === "tab" && i.isPinned),
      0
    ),
    tabs: spaces.reduce(
      (n, s) => n + count(s.items, i => i.type === "tab" && !i.isPinned),
      0
    ),
    folders: spaces.reduce(
      (n, s) => n + count(s.items, i => i.type === "folder"),
      0
    ),
    splitViews: spaces.reduce(
      (n, s) => n + count(s.items, i => i.type === "splitView"),
      0
    ),
    essentials: essentials.length,
    skipped,
  };
}
