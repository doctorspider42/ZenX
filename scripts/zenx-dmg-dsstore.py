# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""
ZenX: writes build/zenx-dmg/dsstore, the Finder layout of the DMG window:
window size, icon size and positions, and the background picture.

The background is found through an alias to /.background/background.png on
a volume named "ZenX", so the DMG must keep that volume name. Icon positions
match build/zenx-dmg/background.html.

Needs the ds_store and mac_alias packages (the ones dmgbuild uses):
    python3 -m venv /tmp/dmgvenv && /tmp/dmgvenv/bin/pip install ds_store mac_alias
    /tmp/dmgvenv/bin/python scripts/zenx-dmg-dsstore.py
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

from ds_store import DSStore
from mac_alias import Alias

VOLUME = "ZenX"
APP = "ZenX.app"
WIDTH, HEIGHT = 680, 440
ICON_Y = 196
# make_dmg names the /Applications link " " so it needs no translation and
# shows no label; the background has the label.
APPLICATIONS = " "
POSITIONS = {APP: (190, ICON_Y), APPLICATIONS: (490, ICON_Y)}

DIR = Path(__file__).resolve().parent.parent / "build" / "zenx-dmg"


def main():
    # Resolved: /var is a symlink, and the alias needs the real mount path.
    tmp = Path(tempfile.mkdtemp()).resolve()
    try:
        image = tmp / "layout.dmg"
        mount = tmp / "mnt"
        subprocess.run(
            ["hdiutil", "create", "-quiet", "-size", "10m", "-fs", "HFS+",
             "-volname", VOLUME, str(image)],
            check=True,
        )
        mount.mkdir()
        subprocess.run(
            ["hdiutil", "attach", "-quiet", "-nobrowse", "-mountpoint", str(mount),
             str(image)],
            check=True,
        )
        try:
            (mount / ".background").mkdir()
            background = mount / ".background" / "background.png"
            shutil.copy(DIR / "background.png", background)
            (mount / APP).mkdir()
            (mount / APPLICATIONS).symlink_to("/Applications")

            with DSStore.open(str(mount / ".DS_Store"), "w+") as store:
                store["."]["bwsp"] = {
                    "ShowStatusBar": False,
                    "ShowToolbar": False,
                    "ShowTabView": False,
                    "ShowSidebar": False,
                    "ContainerShowSidebar": False,
                    "SidebarWidth": 0,
                    "WindowBounds": f"{{{{200, 120}}, {{{WIDTH}, {HEIGHT + 28}}}}}",
                }
                store["."]["icvp"] = {
                    "viewOptionsVersion": 1,
                    "backgroundType": 2,
                    "backgroundImageAlias": Alias.for_file(str(background)).to_bytes(),
                    "backgroundColorRed": 0.0,
                    "backgroundColorGreen": 0.0,
                    "backgroundColorBlue": 0.0,
                    "iconSize": 128.0,
                    "textSize": 13.0,
                    "gridSpacing": 100.0,
                    "gridOffsetX": 0.0,
                    "gridOffsetY": 0.0,
                    "arrangeBy": "none",
                    "labelOnBottom": True,
                    "showIconPreview": True,
                    "showItemInfo": False,
                }
                store["."]["vSrn"] = ("long", 1)
                for name, position in POSITIONS.items():
                    store[name]["Iloc"] = position
            shutil.copy(mount / ".DS_Store", DIR / "dsstore")
        finally:
            subprocess.run(["hdiutil", "detach", "-quiet", str(mount)], check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"Wrote {DIR / 'dsstore'}")


if __name__ == "__main__":
    main()
