#!/usr/bin/env bash
# Arise moved to github.com/abyyworld/arise. This runs its Workers setup from there.
set -eu
cd "$(mktemp -d)"
curl -fsSL https://github.com/abyyworld/arise/archive/refs/heads/main.tar.gz | tar xz
cd arise-main
exec bash scripts/setup-workers.sh "$@"
