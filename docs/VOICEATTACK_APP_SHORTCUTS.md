# VoiceAttack application shortcut map

This guide records the Windows app-focus commands used alongside this
macropad. Macropad Rebind programs keys to send keyboard actions; VoiceAttack
listens for those shortcuts and invokes the matching command. VoiceAttack's
profile and key triggers are separate from the configuration saved on the pad.

## Application commands

| Target | VoiceAttack command | Shortcut shown in the current overlay map |
|---|---|---|
| Brave (focus latest window) | `Macropad focus latest Brave` | `Ctrl + Alt + B` |
| Steam | `Macropad Steam` | Not assigned in overlay map |
| Godot | `Macropad Godot` | Not assigned in overlay map |
| VS Code | `Macropad VS Code` | Not assigned in overlay map |
| Thunderbird | `Macropad Thunderbird` | Not assigned in overlay map |
| Slack | `Macropad Slack` | Not assigned in overlay map |
| Voicemeeter | `Macropad Voicemeeter` | Not assigned in overlay map |
| Deskflow | `Macropad Deskflow` | Not assigned in overlay map |
| Ableton Live | `Macropad Ableton Live` | Not assigned in overlay map |
| ChatGPT desktop app | `Macropad ChatGPT` | Not assigned in overlay map |

The shortcut column reflects the overlay labels last recorded locally. The
non-Brave entries are placeholders; they do **not** confirm whether a trigger
has since been assigned in VoiceAttack. No VoiceAttack profile or private
shortcut settings are included in this repository. Update the labels in the
local `AppFocus/shortcuts.txt` file after assigning or changing triggers.

## Hold-to-show shortcut overlay

The selected overlay trigger is **hold `Ctrl + Alt + Space`**; releasing the
combination dismisses the overlay. Assign this trigger to the VoiceAttack
command `Macropad Show shortcut overlay`. The overlay lists the ten application
commands above. Its labels come from `AppFocus/shortcuts.txt` on the local
computer and do not automatically read the VoiceAttack profile.

## Assigning a keypad key

1. In VoiceAttack, assign a unique keyboard trigger to the desired app command.
2. In Macropad Rebind, set the chosen key to emit the same key combination.
3. Save the VoiceAttack profile and write the keypad mapping, then test the
   command. Keep the overlay labels in sync manually if you want the overlay to
   show the assigned shortcuts.

The pad stores ordinary keyboard actions. It does not store application names,
installation paths, VoiceAttack commands, or the profile itself. Those remain
specific to the computer where VoiceAttack is configured.
