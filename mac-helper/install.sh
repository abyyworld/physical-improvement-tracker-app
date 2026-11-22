#!/usr/bin/env bash
# Arise moved to github.com/abyyworld/arise. This runs the Mac helper's installer from there, with
# the same options (install, uninstall, code, new-code, status, restart).
set -eu
cd "$(mktemp -d)"
curl -fsSL https://github.com/abyyworld/arise/archive/refs/heads/main.tar.gz | tar xz
exec bash arise-main/mac-helper/install.sh "$@"
