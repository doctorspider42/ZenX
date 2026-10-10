# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# ZenX: spaces bound to Firefox profiles.

# Variables:
#   $space (String) - Name of a space in another profile
#   $profile (String) - Name of the profile that space belongs to
zenx-remote-space-button =
    .tooltiptext = { $space } — { $profile }

zenx-move-space-to-profile =
    .label = Move to Profile
zenx-move-space-new-profile =
    .label = New Profile…
zenx-move-space-cancel =
    .label = Cancel Move

zenx-move-space-confirm-title = Move space to another profile?
# Variables:
#   $space (String) - Name of the space being moved
#   $profile (String) - Name of the target profile
#   $skipped (Number) - Tabs that cannot be moved (extension and blank pages)
zenx-move-space-confirm-body =
    “{ $space }” and its tabs will open in profile “{ $profile }” and close here once they do. Extensions, history, cookies and logins stay with each profile. { $skipped ->
        [0] { "" }
        [one] One tab can’t be moved and will be closed.
       *[other] { $skipped } tabs can’t be moved and will be closed.
    }
# Variables:
#   $space (String) - Name of the space being moved
#   $skipped (Number) - Tabs that cannot be moved (extension and blank pages)
zenx-move-space-confirm-body-new-profile =
    A new profile will be created and “{ $space }” and its tabs will open there, then close here. The new profile starts with its own extensions, history, cookies and logins. { $skipped ->
        [0] { "" }
        [one] One tab can’t be moved and will be closed.
       *[other] { $skipped } tabs can’t be moved and will be closed.
    }
