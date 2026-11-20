# App Uninstaller

App Uninstaller is a GNOME Shell extension that adds an **Uninstall** action to the right-click menu for apps. It detects how each app was installed and, by default, shows what will be removed in a confirmation dialog.

<a href="https://buymeacoffee.com/becabdev"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" width="180"></a>

## Installation

App Uninstaller is coming soon to [GNOME Shell Extensions](https://extensions.gnome.org/extension/11880/app-uninstaller/).

The extension is compatibility with **GNOME Shell 45 through 51** and will be compatible for future releases. Some system removals require administrator authentication through Polkit (`pkexec`).

Each GitHub release includes an installable ZIP. Open **Releases**, download `app-uninstaller@becabdev.shell-extension.zip` from the release's **Assets**, then run this command from the folder containing the ZIP.

```sh
gnome-extensions install app-uninstaller@becabdev.shell-extension.zip
```

Log out of GNOME and back in, then enable **App Uninstaller** in the **Extensions** app or run the following command.

```sh
gnome-extensions enable app-uninstaller@becabdev
```

## Usage

1. In the GNOME overview, right-click an app icon.
2. Choose **Uninstall**. The menu may include the installation source, as in **Uninstall (Flatpak)**.
3. Review the details and confirm. Depending on how the app was installed, the dialog may also let you remove its data and settings or clean up unused dependencies.

For APT and Pacman, the preview lists other packages scheduled for removal. For RPM packages, it lists packages that depend on the selected package.

## Supported installation sources

| Source | Action |
| --- | --- |
| Distribution packages | Uses APT, dpkg, DNF, YUM, Zypper, RPM, rpm-ostree, Pacman, APK, XBPS, or Portage, depending on the system. With rpm-ostree, reboot to apply the removal of packages layered on top of the base image. |
| Flatpak and Snap | Uses the appropriate package manager. For Flatpak, the extension selects the user or system installation. |
| AppImage | Removes the launcher and moves the AppImage file to the Trash by default. |
| Standalone apps and local launchers | Removes the launcher and lists any app files it can identify before moving them to the Trash. |
| Steam and Wine | Opens Steam's uninstall prompt or Wine's list of installed programs. Complete the uninstall in Steam or Wine. |
| Waydroid | Removes the Android app from Waydroid. |
| Nix and GNU Guix | Experimental support for profile packages. For apps managed by NixOS or Home Manager, update the corresponding configuration. |
| Distrobox and Toolbox | Removes the local launcher. The app stays installed in the container. |

If the extension detects a vendor-provided uninstaller, run it manually.

## Preferences

```sh
gnome-extensions prefs app-uninstaller@becabdev
```

You can choose where the action appears in the menu, show commands before they run, manage notifications, and add apps to the protected list. By default, the extension protects essential system components and hides the action when uninstalling is unavailable.

## Packaging and testing

To build the release ZIP from source, make sure `gnome-extensions`, `msgfmt` (GNU gettext), and `glib-compile-schemas` are available, then run the following command.

```sh
./pack.sh
```

The script writes `dist/app-uninstaller@becabdev.shell-extension.zip`.

Use GJS to run the tests for source detection and uninstall planning.

```sh
gjs -m tests/sources.js
```

## AI notice

This extension has been made using help of AI. Everything has been tested on confined OS and on real hardware, and I clearly understand the code that it made and corrected the eventual errors that it might have made. I would estimate the usage of AI on this project to appx. 40%, the rest is made using my own keyboard and my brain :D

## License

App Uninstaller is licensed under GPL-3.0-or-later. [License text](LICENSE)
