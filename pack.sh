#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

src="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$src/dist}"
mkdir -p "$out"

for catalog in "$src"/po/*.po; do
    msgfmt --check -o /dev/null "$catalog"
done
glib-compile-schemas --strict --dry-run "$src/schemas"

gnome-extensions pack --force --out-dir="$out" \
    --podir=po --extra-source=confirmation.js --extra-source=sources.js \
    --extra-source=utils.js --extra-source=launcher.js --extra-source=LICENSE "$src"
