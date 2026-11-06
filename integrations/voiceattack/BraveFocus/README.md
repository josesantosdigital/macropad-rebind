# VoiceAttack: focus the latest Brave window

This VoiceAttack plugin tracks normal Brave browser-window activation while VoiceAttack is running. Its command restores and focuses the last tracked window, or launches Brave without command-line arguments if no browser window is open. It does not read keystrokes or browser content. It runs within VoiceAttack and has no separate resident process.

## Finish setup

1. In VoiceAttack options, enable **Plugin Support** if it is disabled, and restart VoiceAttack. Check that **Macropad: Focus latest Brave window** is enabled in the Plugin Manager.
2. Select the profile you normally use, choose **Edit**, then **Import Commands**. Import `Macropad Brave Focus.vap` from this folder and select its one command. This adds to the selected profile; it does not replace the profile.
3. Edit the imported command, enable **When I press keys**, and record **Ctrl+Alt+B** if it does not conflict with an existing shortcut. Save the command and profile. The import deliberately has no assigned keyboard or spoken trigger.
4. Test the shortcut on your keyboard. Then use the macropad configurator to assign the same combination to a key. Use a profile that contains the imported command whenever the shortcut is needed.

VoiceAttack must be running and the plugin loaded. If it starts after windows have already been minimized, Windows does not expose reliable earlier activation history, so focus the desired Brave window once to establish it. Windows may prevent focusing across security boundaries such as the secure desktop. Browser windows on another virtual desktop may not be activated; ordinary windows on multiple monitors are handled without moving them. Auxiliary windows and browser windows with nonstandard titles may be excluded.

## Files and maintenance

- `MacropadBraveFocus.dll`: built plugin, also installed in `%APPDATA%\VoiceAttack2\Apps\MacropadBraveFocus`.
- `Macropad Brave Focus.vap`: importable VoiceAttack command with no keyboard trigger assigned. Its import into your installed version still needs to be verified in VoiceAttack.
- `BraveFocus.cs` and `VoiceAttackPlugin.cs`: implementation. Rebuild using `build.ps1` from this folder; installing an updated DLL while VoiceAttack has loaded it requires exiting VoiceAttack first.
- `BraveFocus-Diagnostic.exe`: built diagnostic utility. Run it with `--diagnose` to list the Brave windows visible to that process; it does not launch or change Brave settings.

The plugin and real window-selection behavior were tested with temporary Brave windows, including a background window, alternating windows, a minimized window, an already focused window, and repeated invocation. The completely closed-browser launch and launch from an elevated VoiceAttack process have not been tested end-to-end. Only one monitor was connected during testing.

When invocation fails with error 1, the plugin includes the underlying exception type and message in VoiceAttack's log. That message can contain a local path; remove private path information before posting it publicly. This diagnostic detail was added after an error-1 report and still needs confirmation in the installed VoiceAttack instance.

Before replacing an installed plugin or changing a VoiceAttack profile, make a separate copy of `VoiceAttack.dat`. This repository does not include local profiles, database backups, compiled binaries, logs, or personal shortcut assignments.
