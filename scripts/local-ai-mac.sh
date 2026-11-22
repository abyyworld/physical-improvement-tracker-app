#!/usr/bin/env bash
# Arise moved to github.com/abyyworld/arise. This runs the local AI setup from there.
set -eu
curl -fsSL https://raw.githubusercontent.com/abyyworld/arise/main/scripts/local-ai-mac.sh | bash -s -- "$@"
