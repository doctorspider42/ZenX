# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# ZenX: przestrzenie przypisane do profili Firefoksa.

zenx-remote-space-button =
    .tooltiptext = { $space } — { $profile }

zenx-move-space-to-profile =
    .label = Ustaw profil
zenx-move-space-new-profile =
    .label = Nowy profil…
zenx-move-space-cancel =
    .label = Anuluj przenoszenie

zenx-move-space-confirm-title = Przenieść przestrzeń do innego profilu?
zenx-move-space-confirm-body =
    Przestrzeń „{ $space }” i jej karty otworzą się w profilu „{ $profile }”, a tutaj zostaną zamknięte, gdy tylko to nastąpi. Rozszerzenia, historia, ciasteczka i hasła są osobne dla każdego profilu. { $skipped ->
        [0] { "" }
        [one] Jednej karty nie da się przenieść i zostanie zamknięta.
        [few] { $skipped } karty nie da się przenieść i zostaną zamknięte.
       *[many] { $skipped } kart nie da się przenieść i zostaną zamknięte.
    }
zenx-move-space-confirm-body-new-profile =
    Zostanie utworzony nowy profil, w którym otworzy się przestrzeń „{ $space }” wraz z kartami, a tutaj zostanie zamknięta. Nowy profil ma własne rozszerzenia, historię, ciasteczka i hasła. { $skipped ->
        [0] { "" }
        [one] Jednej karty nie da się przenieść i zostanie zamknięta.
        [few] { $skipped } karty nie da się przenieść i zostaną zamknięte.
       *[many] { $skipped } kart nie da się przenieść i zostaną zamknięte.
    }
