# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""
ZenX end-to-end tests: drive the real built app the way a user runs it.

Unlike the mochitests in zenx/tests, these:
- start the app normally (no --profile), so profiles.ini, profile groups and
  the default profile behave like on a real install. Each scenario gets its
  own profile root and remoting name through a test application.ini (-app),
  so it never touches or talks to the user's ZenX; Arc data is a synthetic
  fixture (ZENX_ARC_DATA_DIR);
- run with Zen's animations and startup code as in production (no
  zen.testing.enabled);
- quit like Cmd+Q and restart, and control several profile processes at
  once over Marionette.

Run (from the engine directory, after a build):

    ./mach python zenx/tests/e2e/zenx_e2e.py            # all scenarios
    ./mach python zenx/tests/e2e/zenx_e2e.py -k import  # name filter
    ./mach python zenx/tests/e2e/zenx_e2e.py --headed   # watch the windows
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

from marionette_driver.marionette import Marionette

HERE = Path(__file__).resolve().parent
# HERE is src/zenx/tests/e2e (engine/zenx is a symlink farm into src).
ENGINE = HERE.parents[3] / "engine"
APP = ENGINE / "obj-aarch64-apple-darwin" / "dist" / "Nightly.app"
BINARY = APP / "Contents" / "MacOS" / "zen"


def synthetic_arc():
    """
    A synthetic Arc sidebar shaped like a real one: several spaces in the
    default Arc profile (with folders, nested folders, a split view, unpinned
    tabs and favorites), plus a space in a second Arc profile that must not be
    imported. Returns (sidebar JSON, expected spaces by name).
    """
    items, spaces, expected = [], [], {}
    counter = [0]

    def new_id(prefix):
        counter[0] += 1
        return f"{prefix}-{counter[0]}"

    def add(obj):
        items.extend([obj["id"], obj])
        return obj["id"]

    def tab(parent, n):
        i = new_id("tab")
        return add({
            "id": i,
            "parentID": parent,
            "title": None,
            "childrenIds": [],
            "data": {
                "tab": {
                    "savedURL": f"https://example.com/{i}",
                    "savedTitle": f"Tab {n}",
                }
            },
        })

    def container(space_id, children):
        cid = new_id("container")
        add({
            "id": cid,
            "parentID": None,
            "title": None,
            "childrenIds": children,
            "data": {
                "itemContainer": {"containerType": {"spaceItems": {"_0": space_id}}}
            },
        })
        return cid

    def folder(parent, name, n_tabs, nested=None):
        fid = new_id("folder")
        children = [tab(fid, k) for k in range(n_tabs)]
        if nested:
            children.append(folder(fid, *nested))
        add({
            "id": fid,
            "parentID": parent,
            "title": name,
            "childrenIds": children,
            "data": {"list": {}},
        })
        return fid

    def split(parent):
        sid = new_id("split")
        tab(sid, 1)
        tab(sid, 2)  # children only linked by parentID, like real Arc files
        add({
            "id": sid,
            "parentID": parent,
            "title": None,
            "childrenIds": [],
            "data": {"splitView": {"layoutOrientation": "horizontal"}},
        })
        return sid

    # (title, emoji, pinned loose tabs, folders [(name, tabs, nested)], split?, unpinned tabs, arc profile)
    layout = [
        ("Work", "💼", 1, [("Projects", 1, ("Nested", 1))], True, 1, "Default"),
        ("Fun", "🎉", 3, [("Games", 2, None)], False, 0, "Default"),
        (
            "Money",
            "🤑",
            4,
            [("Bills", 2, None), ("Taxes", 2, None)],
            False,
            2,
            "Default",
        ),
        (
            None,
            None,
            2,
            [("A", 3, None), ("B", 3, None), ("C", 2, None)],
            False,
            0,
            "Default",
        ),
        ("Other profile", "🙈", 2, [], False, 0, "Profile 1"),
    ]
    for title, emoji, loose, folders, has_split, unpinned, arc_profile in layout:
        space_id = new_id("space")
        pinned_children_ids = []
        pinned_cid = container(space_id, pinned_children_ids)
        for k in range(loose):
            pinned_children_ids.append(tab(pinned_cid, k))
        for name, n, nested in folders:
            pinned_children_ids.append(folder(pinned_cid, name, n, nested))
        if has_split:
            pinned_children_ids.append(split(pinned_cid))
        unpinned_children = []
        unpinned_cid = container(space_id, unpinned_children)
        for k in range(unpinned):
            unpinned_children.append(tab(unpinned_cid, k))
        profile = (
            {"default": True}
            if arc_profile == "Default"
            else {"custom": {"_0": {"directoryBasename": arc_profile}}}
        )
        space = {
            "id": space_id,
            "profile": profile,
            "newContainerIDs": [
                {"unpinned": {"_0": {"shared": {}}}},
                unpinned_cid,
                {"pinned": {}},
                pinned_cid,
            ],
            "customInfo": {
                "iconType": {"emoji_v2": emoji} if emoji else {"icon": "planet"}
            },
        }
        if title:
            space["title"] = title
        spaces.extend([space_id, space])
        if arc_profile == "Default":
            n_folders = sum(1 + (1 if nested else 0) for _, _, nested in folders)
            n_pinned = (
                loose
                + sum(n + (nested[1] if nested else 0) for _, n, nested in folders)
                + (2 if has_split else 0)
            )
            expected[title or "Space"] = {
                "icon": emoji,
                "pinned": n_pinned,
                "normal": unpinned,
                "folders": n_folders,
            }
    fav_default = new_id("top")
    add({
        "id": fav_default,
        "parentID": None,
        "title": None,
        "childrenIds": [],
        "data": {
            "itemContainer": {"containerType": {"topApps": {"_0": {"default": True}}}}
        },
    })
    fav_tab = tab(fav_default, 0)
    items[items.index(fav_default) + 1]["childrenIds"] = [fav_tab]
    sidebar = {
        "sidebar": {
            "containers": [
                {"global": {}},
                {
                    "spaces": spaces,
                    "items": items,
                    "topAppsContainerIDs": [{"default": True}, fav_default],
                },
            ]
        },
        "version": 1,
    }
    return sidebar, expected


class Failure(AssertionError):
    pass


def check(condition, message):
    if not condition:
        raise Failure(message)
    print(f"    ok  {message}")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# Chrome-context helpers available to every script as `Z`.
JS_HELPERS = r"""
const Z = {
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async until(fn, what, timeout = 15000) {
    const start = Date.now();
    for (;;) {
      let value;
      try { value = await fn(); } catch (e) { value = undefined; }
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error("Timed out: " + what);
      await Z.sleep(100);
    }
  },
  win() { return Services.wm.getMostRecentWindow("navigator:browser"); },
  module(url) { return ChromeUtils.importESModule(url); },
  sps() { return Z.module("resource:///modules/profiles/SelectableProfileService.sys.mjs").SelectableProfileService; },
  zenx() { return Z.module("resource:///modules/zenx/ZenXProfileSpaces.sys.mjs").ZenXProfileSpaces; },
  async ready() {
    const win = await Z.until(() => { const w = Z.win(); return w?.gZenWorkspaces && w; }, "browser window");
    await win.gZenWorkspaces.promiseInitialized;
    await Z.until(() => win.gZenXProfileSpaces && win.document.documentElement.hasAttribute("zenx-profile-spaces") !== undefined, "ZenX UI");
    return win;
  },
  spaces(win = Z.win()) {
    const tabs = win.gZenWorkspaces.allStoredTabs;
    return win.gZenWorkspaces.getWorkspaces().map(s => {
      // The profile editor ZenX opens in a new profile is not part of the space.
      const own = tabs.filter(t => t.getAttribute("zen-workspace-id") === s.uuid && !t.hasAttribute("zen-empty-tab")
        && !t.linkedBrowser?.currentURI?.spec.startsWith("about:editprofile"));
      return {
        uuid: s.uuid, name: s.name, icon: s.icon || null, arc: s.zenxArcId || null,
        pinned: own.filter(t => t.pinned).length, normal: own.filter(t => !t.pinned).length,
        folders: win.gZenWorkspaces.workspaceElement(s.uuid)?.querySelectorAll("zen-folder").length ?? 0,
      };
    });
  },
  // The switcher as shown: names in order, this profile's and others'.
  switcher(win = Z.win()) {
    const names = new Map(win.gZenWorkspaces.getWorkspaces().map(s => [s.uuid, s.name]));
    for (const { spaces } of Z.zenx().getRemoteSpaces()) {
      for (const s of spaces) names.set(s.uuid, s.name);
    }
    return [...win.document.querySelectorAll("#zen-workspaces-button toolbarbutton")]
      .map(b => b.getAttribute("zen-workspace-id") || b.getAttribute("zenx-space-id"))
      .map(uuid => names.get(uuid) ?? "?");
  },
  essentials(win = Z.win()) {
    return win.gZenWorkspaces.allStoredTabs.filter(t => t.hasAttribute("zen-essential")).length;
  },
  // Opens the space context menu on a space's switcher button, like a right click.
  async openSpaceMenu(win, uuid) {
    const doc = win.document;
    const menu = doc.getElementById("zenWorkspaceMoreActions");
    const button = doc.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${uuid}"]`)
      ?? doc.querySelector(`zen-workspace[id="${uuid}"]`);
    const shown = new Promise(r => menu.addEventListener("popupshown", r, { once: true }));
    // Like a right click on that space: the menu must know which space it is
    // for (triggerNode), or actions apply to the active space instead.
    const rect = button.getBoundingClientRect();
    const event = new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: win,
      clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 2 });
    button.dispatchEvent(event);
    menu.openPopup(button, "after_start", 0, 0, true, false, event);
    await shown;
    if (menu.triggerNode?.closest?.("[zen-workspace-id]")?.getAttribute("zen-workspace-id") !== uuid) {
      throw new Error("space menu opened for the wrong space");
    }
    return menu;
  },
  async closeMenu(menu) {
    const hidden = new Promise(r => menu.addEventListener("popuphidden", r, { once: true }));
    menu.hidePopup();
    await hidden;
  },
  visible(el) { return !!el && el.checkVisibility(); },
  async openSetProfile(win, uuid) {
    const menu = await Z.openSpaceMenu(win, uuid);
    const doc = win.document;
    const zen = doc.getElementById("context_zenWorkspacesOpenInContainerTab");
    const ours = doc.getElementById("zenx-context-move-space-to-profile");
    // macOS context menus are native: only the hidden attribute hides an item there.
    const result = { menu, zenContainerVisible: Z.visible(zen) || !zen?.hidden, oursVisible: Z.visible(ours) && !ours.hidden, items: [] };
    if (result.oursVisible) {
      const shown = new Promise(r => ours.menupopup.addEventListener("popupshown", r, { once: true }));
      ours.openMenu(true);
      await shown;
      result.items = [...ours.menupopup.children].filter(c => c.localName === "menuitem").map(c => ({
        label: c.getAttribute("label"), id: c.getAttribute("zenx-profile-id"),
        action: c.getAttribute("zenx-action"), checked: c.getAttribute("checked") === "true", el: c,
      }));
    }
    return result;
  },
};
"""


class Instance:
    """One running ZenX process (one profile) with a Marionette session."""

    def __init__(self, port, process=None, profile_dir=None):
        self.port = port
        self.process = process
        self.profile_dir = profile_dir
        self.client = Marionette(host="127.0.0.1", port=port)
        self.client.DEFAULT_STARTUP_TIMEOUT = 60
        self.client.start_session()
        self.client.set_context("chrome")
        self.client.timeout.script = 120

    def js(self, body, *args):
        """Runs an async chrome script; `return` a JSON-able value."""
        script = (
            JS_HELPERS
            + "const [__args, __resolve] = [arguments[0], arguments[arguments.length - 1]];\n"
            + "(async (...args) => {"
            + body
            + "})(...__args)"
            + ".then(v => __resolve({ ok: v }), e => __resolve({ error: String(e) + '\\n' + (e?.stack || '') }));"
        )
        result = self.client.execute_async_script(
            script, script_args=[list(args)], new_sandbox=False
        )
        if "error" in result:
            raise Failure(f"script error: {result['error']}")
        return result.get("ok")

    def quit(self, timeout=60):
        """
        Quits like Cmd+Q. Marionette's own quit closes the windows first,
        which makes Zen save an empty session, so it isn't used.
        """
        try:
            self.js(
                """
                const t = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
                Services.__zenxE2EQuit = t;
                t.initWithCallback(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit), 200, Ci.nsITimer.TYPE_ONE_SHOT);
                """
            )
        except Exception:
            pass
        try:
            self.client.delete_session(send_request=False)
        except Exception:
            pass
        start = time.time()
        while time.time() - start < timeout:
            if self.process is not None:
                if self.process.poll() is not None:
                    return
            else:
                try:
                    with socket.create_connection(
                        ("127.0.0.1", self.port), timeout=0.5
                    ):
                        pass
                except OSError:
                    time.sleep(
                        1
                    )  # Marionette closes first, give the app a moment to exit
                    return
            time.sleep(0.3)
        if self.process is not None:
            self.process.kill()


class Env:
    """
    An isolated ZenX: its own profile root and remoting name (through a test
    application.ini passed with -app), synthetic Arc data, and the processes.

    macOS ignores $HOME for app data (FSFindFolder), so isolation comes from
    the application.ini Profile= entry; every instance is checked to run from
    the test profile root before a test touches it.
    """

    def __init__(self, headed=False):
        self.id = (
            f"{int(time.time())}-{os.getpid()}-{len(os.listdir(tempfile.gettempdir()))}"
        )
        self.headed = headed
        self.instances = []
        self.tmp = Path(tempfile.mkdtemp(prefix="zenx-e2e-"))
        self.arc_dir = self.tmp / "Arc"
        (self.arc_dir / "User Data" / "Default").mkdir(parents=True)
        (self.arc_dir / "User Data" / "Profile 1").mkdir(parents=True)
        sidebar, self.expected_arc = synthetic_arc()
        (self.arc_dir / "StorableSidebar.json").write_text(
            json.dumps(sidebar, ensure_ascii=False)
        )
        (self.arc_dir / "User Data" / "Local State").write_text(
            json.dumps({
                "profile": {
                    "info_cache": {
                        "Default": {"name": "Arc Home"},
                        "Profile 1": {"name": "Arc Fun"},
                    }
                }
            })
        )
        self.profile_name = f"zenx-e2e/{self.id}"
        self.app_ini = (
            APP / "Contents" / "Resources" / "browser" / f"zenx-e2e-{self.id}.ini"
        )
        # The build's own application.ini (BuildID etc.) with a test profile
        # root and remoting name, so tests never touch or talk to the user's ZenX.
        lines = []
        for line in (
            (APP / "Contents" / "Resources" / "application.ini")
            .read_text()
            .splitlines()
        ):
            if line.startswith("Profile="):
                line = f"Profile={self.profile_name}"
            elif line.startswith("RemotingName="):
                line = f"RemotingName=zenx-e2e-{self.id}"
            lines.append(line)
        self.app_ini.write_text("\n".join(lines) + "\n")

    @property
    def app_data(self):
        return Path.home() / "Library" / "Application Support" / self.profile_name

    @property
    def app_cache(self):
        return Path.home() / "Library" / "Caches" / self.profile_name

    def environ(self):
        env = dict(os.environ)
        env["ZENX_ARC_DATA_DIR"] = str(self.arc_dir)
        env["ZENX_E2E_APP_INI"] = str(self.app_ini)
        env["MOZ_CRASHREPORTER_DISABLE"] = "1"
        if not self.headed:
            env["MOZ_HEADLESS"] = "1"
        return env

    def _port_files(self):
        root = self.app_data / "Profiles"
        if not root.exists():
            return {}
        return {f: f.stat().st_mtime for f in root.glob("*/MarionetteActivePort")}

    def launch(self, timeout=90):
        """Starts the app like a user (no --profile), returns the instance."""
        before = self._port_files()
        process = subprocess.Popen(
            [
                str(BINARY),
                "-app",
                str(self.app_ini),
                "--marionette",
                "--remote-allow-system-access",
                "-foreground",
            ],
            env=self.environ(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Marionette writes its port into the profile it started with.
        start = time.time()
        while True:
            fresh = [f for f, m in self._port_files().items() if before.get(f) != m]
            if fresh:
                port = int(fresh[0].read_text().strip())
                return self._connect(port, process, fresh[0].parent)
            if process.poll() is not None:
                raise Failure(f"app exited with {process.returncode}")
            if time.time() - start > timeout:
                raise Failure("app did not start Marionette")
            time.sleep(0.3)

    def _connect(self, port, process=None, profile_dir=None, timeout=90):
        start = time.time()
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    break
            except OSError:
                if process and process.poll() is not None:
                    raise Failure(f"app exited with {process.returncode}")
                if time.time() - start > timeout:
                    raise Failure("app did not open Marionette")
                time.sleep(0.3)
        instance = Instance(port, process, profile_dir)
        self.instances.append(instance)
        actual = instance.js('return Services.dirsvc.get("ProfD", Ci.nsIFile).path;')
        if not str(actual).startswith(str(self.app_data)):
            instance.quit()
            raise Failure(
                f"SAFETY: instance runs from {actual}, not the test root {self.app_data}; aborted"
            )
        return instance

    def install_profile_launcher(self, instance):
        """
        Firefox launches other profiles through LaunchServices on macOS, which
        drops our test environment (HOME, headless, Marionette). Route it
        through nsIProcess with the same binary and environment instead, and
        give the new process its own Marionette port.
        """
        instance.js(
            """
            const sps = Z.sps();
            if (sps.__zenxE2E) return;
            sps.__zenxE2E = true;
            sps.execProcess = args => {
              const i = args.indexOf("--profile");
              const profile = args[i + 1];
              // A free Marionette port of its own, reported in MarionetteActivePort.
              IOUtils.remove(PathUtils.join(profile, "MarionetteActivePort"), { ignoreAbsent: true })
                .then(() => IOUtils.writeUTF8(PathUtils.join(profile, "user.js"), 'user_pref("marionette.port", 0);\\n', { mode: "appendOrCreate" }))
                .then(() => {
                  const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
                  proc.init(Services.dirsvc.get("XREExeF", Ci.nsIFile));
                  const fullArgs = ["-app", Services.env.get("ZENX_E2E_APP_INI"), "--marionette", "--remote-allow-system-access", ...args.filter(a => a !== "-foreground")];
                  proc.runw(false, fullArgs, fullArgs.length);
                  Services.prefs.setStringPref("zenx.e2e.last-launch", profile);
                });
            };
            """
        )

    def connect_launched(self, instance, timeout=90):
        """Connects to the profile process `instance` launched last."""
        profile = instance.js(
            """
            return await Z.until(() => Services.prefs.getStringPref("zenx.e2e.last-launch", ""), "a profile launch", 30000);
            """
        )
        instance.js('Services.prefs.clearUserPref("zenx.e2e.last-launch");')
        port_file = Path(profile) / "MarionetteActivePort"
        start = time.time()
        while not port_file.exists():
            if time.time() - start > timeout:
                raise Failure(f"launched profile did not start Marionette: {profile}")
            time.sleep(0.3)
        return self._connect(
            int(port_file.read_text().strip()), None, Path(profile), timeout
        )

    def close(self):
        for instance in reversed(self.instances):
            instance.quit()
        self.instances.clear()
        # Profiles launched by the app aren't our children; make sure they're gone.
        subprocess.run(["pkill", "-f", f"zenx-e2e-{self.id}.ini"], check=False)

    def cleanup(self):
        self.close()
        shutil.rmtree(self.tmp, ignore_errors=True)
        shutil.rmtree(self.app_data, ignore_errors=True)
        shutil.rmtree(self.app_cache, ignore_errors=True)
        self.app_ini.unlink(missing_ok=True)


# Mark: scenario steps


def import_arc(inst, arc_profile="Default"):
    """Imports Arc through the import wizard UI, spaces only."""
    return inst.js(
        """
        const [arcProfile] = args;
        const win = await Z.ready();
        const { MigrationUtils } = Z.module("resource:///modules/MigrationUtils.sys.mjs");
        const ready = new Promise(r => win.addEventListener("MigrationWizard:Ready", r, { once: true }));
        await MigrationUtils.showMigrationWizard(win, {});
        await ready;
        const prefsTab = win.gBrowser.selectedTab;
        const wizard = prefsTab.linkedBrowser.contentDocument.querySelector("migration-wizard");
        const shadow = wizard.openOrClosedShadowRoot;
        const items = [...shadow.querySelectorAll('panel-item[key="arc"]')];
        if (!items.length) throw new Error("Arc is not listed in the import wizard");
        const item = items.find(i => i.getAttribute("profile") === arcProfile || i.profile?.id === arcProfile || i.textContent.includes(arcProfile === "Default" ? "Arc Home" : "Arc Fun")) ?? items[0];
        item.click();
        const selector = shadow.querySelector("#browser-profile-selector");
        await Z.until(() => selector.selectedPanelItem === item, "Arc selected in the import wizard", 10000);
        await Z.sleep(300);
        // The wizard loads what Arc offers asynchronously; Import is ignored
        // until then.
        const importButton = shadow.querySelector("#import");
        await Z.until(
          () =>
            !importButton.disabled &&
            shadow.querySelector('#resource-type-list label[data-resource-type="BOOKMARKS"]')?.hidden === false,
          "the wizard ready to import from Arc", 40000);
        for (const label of shadow.querySelectorAll("#resource-type-list label[data-resource-type]")) {
          label.control.checked = label.dataset.resourceType === "BOOKMARKS";
        }
        const done = new Promise(r => wizard.addEventListener("MigrationWizard:DoneMigration", r, { once: true }));
        const t0 = Date.now();
        importButton.click();
        await Z.until(() => shadow.querySelector("named-deck, deck")?.getAttribute("selected-view") !== "page-selection", "the import to start", 10000);
        const finished = await Promise.race([done.then(() => true), Z.sleep(30000).then(() => false)]);
        if (!finished) {
          const ws = win.gZenWorkspaces;
          throw new Error("import did not finish in 30s: " + JSON.stringify({
            changing: ws.isChangingWorkspace, spaces: ws.getWorkspaces().map(s => [s.name, !!s.zenxArcId]),
            active: ws.getActiveWorkspaceFromCache()?.name, tabs: ws.allStoredTabs.length,
            wizardPage: shadow.querySelector("named-deck, deck")?.getAttribute("selected-view"),
            progress: [...shadow.querySelectorAll("[data-resource-type]")].map(e => e.dataset.resourceType + ":" + (e.querySelector(".message-text")?.textContent || "").slice(0, 40)),
          }));
        }
        const ms = Date.now() - t0;
        await Z.until(() => !win.gZenWorkspaces.isChangingWorkspace, "space switch to settle", 10000);
        win.gBrowser.removeTab(prefsTab);
        return { ms, listed: items.length };
        """,
        arc_profile,
    )


def ui_responsive(inst):
    """Switches spaces through the switcher like a click and checks it lands."""
    return inst.js(
        """
        const win = await Z.ready();
        // Nothing may sit over the window catching clicks (e.g. a sweep
        // animation overlay that was never removed).
        await Z.until(() => !win.document.querySelector("#zen-update-animation, #zen-update-animation-border"), "animation overlays gone", 5000);
        const sidebar = win.document.getElementById("zen-workspaces-button").getBoundingClientRect();
        const hit = win.document.elementFromPoint(sidebar.x + sidebar.width / 2, sidebar.y + sidebar.height / 2);
        if (!hit || !win.document.getElementById("zen-workspaces-button").contains(hit)) {
          throw new Error("something covers the space switcher: " + (hit && (hit.localName + "#" + hit.id)));
        }
        const ids = win.gZenWorkspaces.getWorkspaces().map(s => s.uuid);
        const target = ids.find(id => id !== win.gZenWorkspaces.activeWorkspace);
        if (!target) return true;
        const button = win.document.querySelector(`#zen-workspaces-button toolbarbutton[zen-workspace-id="${target}"]`);
        button.doCommand();
        await Z.until(() => win.gZenWorkspaces.activeWorkspace === target && !win.gZenWorkspaces.isChangingWorkspace, "switch via switcher", 5000);
        return true;
        """
    )


def check_arc_spaces(env, spaces, label):
    arc = {s["name"]: s for s in spaces if s["arc"]}
    expected = env.expected_arc
    check(
        sorted(arc) == sorted(expected),
        f"{label}: Arc spaces of the default Arc profile only: {sorted(arc)}",
    )
    for name, exp in expected.items():
        got = arc[name]
        check(
            (got["icon"], got["pinned"], got["normal"], got["folders"])
            == (exp["icon"], exp["pinned"], exp["normal"], exp["folders"]),
            f"{label}: '{name}' icon/pinned/normal/folders = {(got['icon'], got['pinned'], got['normal'], got['folders'])}, expected {(exp['icon'], exp['pinned'], exp['normal'], exp['folders'])}",
        )
    return arc


def check_space_menu(inst, label, expect_profiles):
    res = inst.js(
        """
        const [expect] = args;
        const win = await Z.ready();
        const uuid = win.gZenWorkspaces.activeWorkspace;
        const r = await Z.openSetProfile(win, uuid);
        const out = { zen: r.zenContainerVisible, ours: r.oursVisible, items: r.items.map(i => ({ label: i.label, id: i.id, action: i.action, checked: i.checked })) };
        await Z.closeMenu(r.menu);
        const doc = win.document;
        out.menubarProfiles = !doc.getElementById("profiles-menu")?.hidden;
        out.rootAttr = doc.documentElement.hasAttribute("zenx-profile-spaces");
        return out;
        """,
        expect_profiles,
    )
    check(res["rootAttr"], f"{label}: window knows spaces are bound to profiles")
    check(not res["zen"], f"{label}: Zen's container 'Set Profile' is hidden")
    check(res["ours"], f"{label}: ZenX 'Set Profile' is shown")
    check(not res["menubarProfiles"], f"{label}: menu bar Profiles menu is hidden")
    ids = [i["id"] for i in res["items"] if i["action"] == "move" or i["checked"]]
    check(
        ids[-1] == "new",
        f"{label}: 'New Profile…' is offered, items={[i['label'] for i in res['items']]}",
    )
    profile_items = [
        i for i in res["items"] if i["id"] != "new" and i["action"] != "edit-profile"
    ]
    check(
        len(profile_items) == expect_profiles,
        f"{label}: {expect_profiles} profiles listed, got {[i['label'] for i in profile_items]}",
    )
    if expect_profiles:
        check(
            sum(1 for i in profile_items if i["checked"]) == 1,
            f"{label}: exactly one profile checked",
        )
    return res


def profiles_ini(env):
    path = env.app_data / "profiles.ini"
    return path.read_text() if path.exists() else ""


def restart(env, inst):
    inst.quit()
    env.instances.remove(inst)
    return env.launch()


# Mark: scenarios


def scenario_first_run(env):
    inst = env.launch()
    inst.js("await Z.ready();")
    check_space_menu(inst, "first run", expect_profiles=0)
    state = inst.js(
        "const z = Z.zenx(); return { available: z.available, active: z.active };"
    )
    check(
        state["available"],
        "first run: ZenX profile spaces available without a profile group",
    )


def scenario_import_into_empty(env):
    inst = env.launch()
    inst.js("await Z.ready();")
    res = import_arc(inst)
    print(f"    import took {res['ms']} ms")
    check(res["ms"] < 15000, "import finishes quickly")
    check(ui_responsive(inst), "UI responds to a space switch right after import")
    check_arc_spaces(env, inst.js("return Z.spaces();"), "after import")
    check(inst.js("return Z.essentials();") == 1, "favorite became an essential")
    check_space_menu(inst, "after import", expect_profiles=0)
    for n in (1, 2):
        inst = restart(env, inst)
        inst.js("await Z.ready();")
        print(
            "    spaces after restart",
            n,
            [
                (s["name"], s["pinned"], s["normal"], s["folders"])
                for s in inst.js("return Z.spaces();")
            ],
        )
        check_arc_spaces(env, inst.js("return Z.spaces();"), f"after restart {n}")
        check(ui_responsive(inst), f"UI responds after restart {n}")


def scenario_import_with_existing_data(env):
    inst = env.launch()
    before = inst.js(
        """
        const win = await Z.ready();
        const space = await win.gZenWorkspaces.createAndSaveWorkspace("Mine");
        win.gBrowser.addTrustedTab("https://example.com/mine", { inBackground: true });
        await Z.sleep(500);
        return Z.spaces().map(s => [s.name, s.pinned, s.normal]);
        """
    )
    import_arc(inst)
    after = inst.js("return Z.spaces();")
    kept = [[s["name"], s["pinned"], s["normal"]] for s in after if not s["arc"]]
    check(kept == before, f"existing spaces untouched: {before} -> {kept}")
    check_arc_spaces(env, after, "with existing data")
    import_arc(inst)
    check_arc_spaces(env, inst.js("return Z.spaces();"), "after importing twice")
    check(inst.js("return Z.essentials();") == 1, "essential not duplicated")


def scenario_new_profile_and_switching(env):
    a = env.launch()
    a.js("await Z.ready();")
    import_arc(a)
    env.install_profile_launcher(a)
    work = [s for s in a.js("return Z.spaces();") if s["arc"]][0]
    order_before = a.js("return Z.switcher();")

    # Set Profile > New Profile… on the Work space.
    a.js(
        """
        const [uuid] = args;
        const win = await Z.ready();
        win.gZenXProfileSpaces.confirmMove = async () => true;
        const r = await Z.openSetProfile(win, uuid);
        const item = r.items.find(i => i.id === "new");
        item.el.doCommand();
        await Z.closeMenu(r.menu).catch(() => {});
        """,
        work["uuid"],
    )
    b = env.connect_launched(a)
    b.js("await Z.ready();")
    b_state = b.js(
        """
        const win = await Z.ready();
        await Z.until(() => Z.spaces().some(s => s.name === "Work"), "Work adopted in the new profile", 30000);
        await Z.sleep(1000);
        const doc = win.document;
        return {
          spaces: Z.spaces(),
          editorOpen: win.gBrowser.tabs.some(t => t.linkedBrowser.currentURI.spec.startsWith("about:editprofile")),
          welcome: !!doc.querySelector("#zen-welcome, .zen-welcome"),
          updatePopup: !!doc.querySelector("zen-sidebar-notification, .zen-sidebar-notification"),
          profileId: Z.zenx().currentProfileId,
        };
        """
    )
    moved = [s for s in b_state["spaces"] if s["name"] == "Work"][0]
    check(
        moved["pinned"] == work["pinned"]
        and moved["normal"] == work["normal"]
        and moved["folders"] == work["folders"],
        f"Work moved with its tabs and folders: {work} -> {moved}",
    )
    check(moved["icon"] == "💼", "emoji icon survives the move")
    check(b_state["editorOpen"], "the profile editor opens in the new profile")
    check(
        [sp["name"] for sp in b_state["spaces"]] == ["Work"],
        f"the new profile holds only the moved space: {[sp['name'] for sp in b_state['spaces']]}",
    )
    check(not b_state["welcome"], "no Zen welcome screen in the new profile")
    check(not b_state["updatePopup"], "no 'updated' popup in the new profile")

    a_state = a.js(
        """
        await Z.until(() => !Z.spaces().some(s => s.name === "Work"), "Work removed from the source", 20000);
        return { spaces: Z.spaces(), remote: Z.zenx().getRemoteSpaces() };
        """
    )
    check(
        not any(s["name"] == "Work" for s in a_state["spaces"]),
        "source closed its copy after adoption",
    )
    order_a = a.js(
        'await Z.until(() => !Z.switcher().includes("?") && Z.switcher().includes("Work"), "switcher settled", 15000); return Z.switcher();'
    )
    order_b = b.js(
        'await Z.until(() => !Z.switcher().includes("?") && Z.switcher().length > 1, "switcher settled", 15000); return Z.switcher();'
    )
    check(
        order_a == order_before,
        f"the moved space keeps its place: {order_before} -> {order_a}",
    )
    check(
        order_a == order_b,
        f"both profiles show spaces in the same order: A={order_a} B={order_b}",
    )

    # Drag A's first space to the end with the mouse; B follows.
    dragged = a.js(
        """
        const win = await Z.ready();
        const doc = win.document;
        const buttons = [...doc.querySelectorAll("#zen-workspaces-button toolbarbutton")];
        const from = buttons.find(b => b.hasAttribute("zen-workspace-id"));
        const to = buttons.at(-1);
        const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
        const y = a.y + a.height / 2;
        const mouse = (target, type, x, buttonsDown) =>
          target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win, clientX: x, clientY: y, button: 0, buttons: buttonsDown }));
        mouse(from, "mousedown", a.x + a.width / 2, 1);
        for (let x = a.x + a.width / 2; x <= b.x + b.width * 0.9; x += 4) {
          mouse(doc, "mousemove", x, 1);
          await Z.sleep(5);
        }
        mouse(doc, "mouseup", b.x + b.width * 0.9, 0);
        await Z.sleep(1500);
        return Z.switcher();
        """
    )
    check(
        dragged != order_a and dragged[-1] == order_a[0],
        f"dragging reorders the switcher: {order_a} -> {dragged}",
    )
    order_b = b.js(
        """
        const [want] = args;
        await Z.until(() => JSON.stringify(Z.switcher()) === JSON.stringify(want), "B follows the new order", 15000);
        return Z.switcher();
        """,
        dragged,
    )
    check(
        order_b == dragged, f"the other profile shows the dragged order too: {order_b}"
    )
    remote_names = [sp["name"] for g in a_state["remote"] for sp in g["spaces"]]
    check(
        "Work" in remote_names,
        f"source switcher lists the new profile's spaces: {remote_names}",
    )
    remote_icons = [
        sp.get("icon")
        for g in a_state["remote"]
        for sp in g["spaces"]
        if sp["name"] == "Work"
    ]
    check(remote_icons == ["💼"], f"emoji intact across profiles: {remote_icons}")
    check("ShowSelector=1" not in profiles_ini(env), "startup profile picker stays off")

    check_space_menu(a, "profile A with 2 profiles", expect_profiles=2)
    check_space_menu(b, "profile B with 2 profiles", expect_profiles=2)

    # Switching: click B's Work in A's switcher -> B switches to Work.
    b.js(
        """
        const win = await Z.ready();
        const other = win.gZenWorkspaces.getWorkspaces().find(s => s.name !== "Work") ?? (await win.gZenWorkspaces.createAndSaveWorkspace("Other"));
        await win.gZenWorkspaces.changeWorkspaceWithID(other.uuid);
        """
    )
    a.js(
        """
        const win = await Z.ready();
        const button = await Z.until(() => [...win.document.querySelectorAll("#zen-workspaces-button .zenx-remote-space")]
          .find(b => b.getAttribute("tooltiptext")?.startsWith("Work") || b.querySelector("label")?.textContent === "💼"), "remote Work button");
        const rect = button.getBoundingClientRect();
        if (rect.width < 8) throw new Error("remote button has no width: " + rect.width);
        button.doCommand();
        """
    )
    b_windows = b.js(
        """
        const win = await Z.ready();
        await Z.until(() => win.gZenWorkspaces.getActiveWorkspaceFromCache()?.name === "Work", "B switched to Work", 15000);
        await Z.sleep(1500);
        return [...Services.wm.getEnumerator("navigator:browser")].length;
        """
    )
    check(True, "clicking another profile's space switches that profile's window to it")
    check(
        b_windows == 1,
        f"...in the existing window, without opening a new one (windows: {b_windows})",
    )

    # The same request through a relaunch handed over to the running profile
    # (what happens when it can't be reached directly).
    b_profile = b.js('return Services.dirsvc.get("ProfD", Ci.nsIFile).path;')
    b.js(
        """
        const win = await Z.ready();
        const other = win.gZenWorkspaces.getWorkspaces().find(s => s.name !== "Work") ?? (await win.gZenWorkspaces.createAndSaveWorkspace("Other"));
        await win.gZenWorkspaces.changeWorkspaceWithID(other.uuid);
        """
    )
    work_uuid = b.js('return Z.spaces().find(s => s.name === "Work").uuid;')
    a.js(
        """
        const [path, uuid] = args;
        Z.sps().sendCommandLine(path, ["-foreground", "--profile", path, "--zenx-space", uuid], true);
        """,
        b_profile,
        work_uuid,
    )
    b_windows = b.js(
        """
        const win = await Z.ready();
        await Z.until(() => win.gZenWorkspaces.getActiveWorkspaceFromCache()?.name === "Work", "B switched to Work after a relaunch", 15000);
        await Z.sleep(1500);
        return [...Services.wm.getEnumerator("navigator:browser")].length;
        """
    )
    check(
        b_windows == 1,
        f"a relaunch handed to the running profile switches without a new window (windows: {b_windows})",
    )

    # Move another space to the existing profile B.
    target = [s for s in a.js("return Z.spaces();")][0]
    a.js(
        """
        const [uuid] = args;
        const win = await Z.ready();
        const r = await Z.openSetProfile(win, uuid);
        const item = r.items.find(i => i.action === "move" && i.id !== "new");
        item.el.doCommand();
        await Z.closeMenu(r.menu).catch(() => {});
        """,
        target["uuid"],
    )
    b.js(
        """
        const [name] = args;
        await Z.until(() => Z.spaces().some(s => s.name === name && s.uuid), "second space adopted", 20000);
        """,
        target["name"],
    )
    check(True, f"moving '{target['name']}' to an existing running profile works")


def scenario_delete_profile(env):
    a = env.launch()
    a.js("await Z.ready();")
    env.install_profile_launcher(a)
    a.js(
        """
        const win = await Z.ready();
        win.gZenXProfileSpaces.confirmMove = async () => true;
        await win.gZenWorkspaces.createAndSaveWorkspace("Temp");
        const uuid = win.gZenWorkspaces.getWorkspaces().find(s => s.name === "Temp").uuid;
        const r = await Z.openSetProfile(win, uuid);
        r.items.find(i => i.id === "new").el.doCommand();
        await Z.closeMenu(r.menu).catch(() => {});
        """
    )
    b = env.connect_launched(a)
    b.js(
        'await Z.until(() => Z.spaces().some(s => s.name === "Temp"), "Temp adopted", 30000);'
    )
    a.js(
        'await Z.until(() => Z.zenx().getRemoteSpaces().length === 1, "A sees B", 15000);'
    )
    # Delete B the way about:editprofile does.
    try:
        b.js("await Z.sps().deleteCurrentProfile();")
    except Exception:
        pass  # the process quits while answering
    env.instances.remove(b)
    remote = a.js(
        """
        await Z.until(async () => (await Z.sps().getAllProfiles()).length === 1, "B deleted from the group", 30000);
        Services.obs.notifyObservers(null, "sps-profiles-updated", "remote");
        await Z.until(() => Z.zenx().getRemoteSpaces().length === 0, "B's spaces gone from A", 15000);
        return Z.zenx().getRemoteSpaces();
        """
    )
    check(remote == [], "a deleted profile's spaces disappear from the switcher")
    check_space_menu(a, "after deleting the other profile", expect_profiles=1)


def scenario_restart_with_two_profiles(env):
    a = env.launch()
    a.js("await Z.ready();")
    env.install_profile_launcher(a)
    a.js(
        """
        const win = await Z.ready();
        win.gZenXProfileSpaces.confirmMove = async () => true;
        await win.gZenWorkspaces.createAndSaveWorkspace("Zażółć 🎉");
        const uuid = win.gZenWorkspaces.getWorkspaces().find(s => s.name.startsWith("Zażółć")).uuid;
        const r = await Z.openSetProfile(win, uuid);
        r.items.find(i => i.id === "new").el.doCommand();
        await Z.closeMenu(r.menu).catch(() => {});
        """
    )
    b = env.connect_launched(a)
    b.js(
        'await Z.until(() => Z.spaces().some(s => s.name === "Zażółć 🎉"), "adopted with Polish name", 30000);'
    )
    b.quit()
    env.instances.remove(b)
    a.quit()
    env.instances.remove(a)
    check(
        "ShowSelector=1" not in profiles_ini(env),
        "no startup profile picker after restart",
    )
    c = env.launch()
    names = c.js(
        """
        await Z.ready();
        await Z.until(() => Z.zenx().getRemoteSpaces().length, "other profile's spaces known after restart", 30000);
        return Z.zenx().getRemoteSpaces().flatMap(g => g.spaces.map(s => s.name)).concat(Z.spaces().map(s => s.name));
        """
    )
    check("Zażółć 🎉" in names, f"Polish/emoji names intact after restart: {names}")
    check_space_menu(c, "after restart with 2 profiles", expect_profiles=2)


SCENARIOS = [
    scenario_first_run,
    scenario_import_into_empty,
    scenario_import_with_existing_data,
    scenario_new_profile_and_switching,
    scenario_delete_profile,
    scenario_restart_with_two_profiles,
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-k", default="", help="only scenarios whose name contains this"
    )
    parser.add_argument("--headed", action="store_true", help="show the windows")
    parser.add_argument(
        "--keep", action="store_true", help="keep the test profile root"
    )
    opts = parser.parse_args()

    if not BINARY.exists():
        sys.exit(f"Build first: {BINARY} not found")

    failed = []
    for scenario in SCENARIOS:
        name = scenario.__name__.removeprefix("scenario_")
        if opts.k not in name:
            continue
        print(f"\n== {name}")
        env = Env(headed=opts.headed)
        try:
            scenario(env)
            print(f"PASS {name}")
        except Exception as e:
            failed.append(name)
            print(f"FAIL {name}: {e}")
            traceback.print_exc()
        finally:
            env.close()
            if opts.keep:
                print(f"    kept {env.app_data} and {env.tmp}")
            else:
                env.cleanup()

    print(f"\n{'FAILED: ' + ', '.join(failed) if failed else 'ALL PASSED'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
