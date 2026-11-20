#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

src="$(cd "$(dirname "$0")" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT

"$src/pack.sh" "$stage"
bundles=("$stage"/*.shell-extension.zip)
gnome-extensions install --force "${bundles[0]}"
echo 'Installed, Log out and back in then enable App Uninstaller in Extensions'
