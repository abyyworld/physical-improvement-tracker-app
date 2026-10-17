#!/usr/bin/env bash
# The Arise Mac helper: lets Arise, open in Chrome or Edge on this Mac, add your calls, notifications,
# messages, Safari history and app use to your life log. It reads them on this Mac only, and
# nothing leaves the Mac except through Arise's own end-to-end encrypted sync.
#
#   bash install.sh             install it, or update it (the pairing code and switches stay)
#   bash install.sh uninstall   remove it and everything it kept
#   bash install.sh code        show the pairing code
#   bash install.sh new-code    make a new pairing code
#   bash install.sh status      is it running, and what does it read
#   bash install.sh restart     start it again
#
# Works in bash and zsh. Once it's installed, the same commands work with
# ~/.arise-helper/arise-helper.sh. It puts its own Node.js 22 in ~/.arise-helper (checked against
# nodejs.org's SHA-256 list): that one program is what gets Full Disk Access, and nothing else.

set -eu
# (bash and zsh both have pipefail; plain sh may not.)
(set -o pipefail) 2>/dev/null && set -o pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

# (Not `path`: zsh ties that name to PATH.)
dir=${ARISE_HELPER_HOME:-$HOME/.arise-helper}
label=io.github.abyyworld.arise-helper
agent="$HOME/Library/LaunchAgents/$label.plist"
node="$dir/node/bin/node"
repo=${ARISE_REPO:-abyyworld/physical-improvement-tracker-app}
here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
uid=$(id -u)
service="gui/$uid/$label"

case "$dir" in
  "" | / | "$HOME" | "$HOME/") fail "ARISE_HELPER_HOME can't be $dir." ;;
esac

helper() { ARISE_HELPER_HOME="$dir" "$node" "$dir/app/helper.mjs" "$@"; }

usage() {
  cat <<'EOF'
Usage: bash install.sh [install | uninstall | code | new-code | status | restart]
EOF
}

uninstall() {
  launchctl bootout "$service" 2>/dev/null || true
  rm -f "$agent"
  rm -rf "$dir"
  say "The Arise helper is removed, with everything it kept."
  echo "Two last steps:"
  echo "  1. In System Settings, Privacy & Security, Full Disk Access: select \"node\" and click the minus button."
  echo "  2. In Arise, Settings, Your life, Mac: click Unlink."
}

installed() { [ -x "$node" ] && [ -f "$dir/app/helper.mjs" ]; }

cmd=${1:-install}
case "$cmd" in
  install | update) ;;
  uninstall)
    uninstall
    exit 0
    ;;
  code | new-code | status)
    installed || fail "The Arise helper isn't installed."
    helper "$cmd"
    exit $?
    ;;
  restart)
    installed || fail "The Arise helper isn't installed."
    launchctl kickstart -k "$service" || fail "Couldn't start it again. Run the install command again."
    echo "Started again."
    exit 0
    ;;
  help | -h | --help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 1
    ;;
esac

[ "$(uname -s)" = Darwin ] || fail "The Arise helper is for Macs. Run this in Terminal on your Mac."

umask 077
mkdir -p "$dir"
chmod 700 "$dir"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/arise-helper.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

# 1. Node.js 22.13 or newer (the first with SQLite built in), in the helper's own folder. A Node.js
# the Mac already has isn't used: Full Disk Access goes to one exact program, and it should be one
# that only the helper runs.
node_ok() { [ -x "$node" ] && "$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
if node_ok; then
  say "1 of 4. Node.js"
  echo "Using the helper's Node.js $("$node" -v)."
else
  say "1 of 4. Getting Node.js 22 for the helper"
  case "$(uname -m)" in
    arm64) plat=darwin-arm64 ;;
    x86_64) plat=darwin-x64 ;;
    *) fail "This Mac's processor ($(uname -m)) isn't one Node.js is made for." ;;
  esac
  dist=https://nodejs.org/dist/latest-v22.x
  sums=$(curl -fsSL "$dist/SHASUMS256.txt") || fail "Couldn't reach nodejs.org. Check the connection and run this again."
  line=$(printf '%s\n' "$sums" | grep -E "  node-v22\.[0-9.]+-$plat\.tar\.gz\$" | head -n 1)
  [ -n "$line" ] || fail "Couldn't find Node.js 22 for this Mac on nodejs.org. Run this again later."
  file=${line##* }
  curl -fsSL "$dist/$file" -o "$tmp/$file" || fail "Couldn't download Node.js. Check the connection and run this again."
  got=$(shasum -a 256 "$tmp/$file")
  [ "${got%% *}" = "${line%% *}" ] || fail "The Node.js download didn't match its checksum, so it wasn't used. Run this again."
  tar -xzf "$tmp/$file" -C "$tmp"
  rm -rf "$dir/node"
  mv "$tmp/${file%.tar.gz}" "$dir/node"
  node_ok || fail "The downloaded Node.js didn't start. Run this again."
  echo "Got Node.js $("$node" -v)."
fi

# 2. The helper itself: from this copy of the repo, or else from GitHub.
say "2 of 4. Putting the helper in place"
if [ -f "$here/helper.mjs" ] && [ -d "$here/src" ]; then
  src=$here
else
  curl -fsSL "https://github.com/$repo/archive/refs/heads/main.tar.gz" -o "$tmp/repo.tar.gz" || fail "Couldn't download the helper from GitHub. Check the connection and run this again."
  mkdir "$tmp/repo"
  tar -xzf "$tmp/repo.tar.gz" -C "$tmp/repo"
  src=$(find "$tmp/repo" -maxdepth 2 -type d -name mac-helper | head -n 1)
  if [ -z "$src" ] || [ ! -f "$src/helper.mjs" ]; then fail "The download didn't have the helper in it."; fi
fi
rm -rf "$dir/app.new" "$dir/app.old"
mkdir -p "$dir/app.new/src"
cp "$src/helper.mjs" "$dir/app.new/"
for f in "$src"/src/*.mjs; do
  cp "$f" "$dir/app.new/src/"
done
if [ -d "$dir/app" ]; then mv "$dir/app" "$dir/app.old"; fi
mv "$dir/app.new" "$dir/app"
rm -rf "$dir/app.old"
# A new file, not the old one changed: this script may be that copy, running right now.
cp "$src/install.sh" "$dir/arise-helper.sh.new"
chmod 700 "$dir/arise-helper.sh.new"
mv -f "$dir/arise-helper.sh.new" "$dir/arise-helper.sh"
echo "In $dir"

# 3. A LaunchAgent starts it at login and starts it again if it ever stops.
say "3 of 4. Starting it, now and at every login"
mkdir -p "$HOME/Library/LaunchAgents"
helper plist >"$tmp/agent.plist"
plutil -lint "$tmp/agent.plist" >/dev/null || fail "The LaunchAgent file came out wrong. Run this again."
launchctl bootout "$service" 2>/dev/null || true
cp "$tmp/agent.plist" "$agent"
chmod 644 "$agent"
started=no
tries=0
while [ "$tries" -lt 5 ]; do
  tries=$((tries + 1))
  if launchctl bootstrap "gui/$uid" "$agent" 2>/dev/null; then
    started=yes
    break
  fi
  sleep 1
done
[ "$started" = yes ] || launchctl bootstrap "gui/$uid" "$agent" || fail "Couldn't start the helper (see above). Run this again."
running=no
tries=0
while [ "$tries" -lt 10 ]; do
  tries=$((tries + 1))
  if helper status >/dev/null 2>&1; then
    running=yes
    break
  fi
  sleep 1
done
[ "$running" = yes ] || fail "The helper didn't start. The end of its log:
$(tail -n 15 "$dir/logs/helper.log" 2>/dev/null || true)"
echo "Running."

# 4. Full Disk Access, for calls, messages, notifications, Safari and Screen Time's records.
say "4 of 4. Full Disk Access"
if helper status 2>/dev/null | grep -q 'Full Disk Access: yes'; then
  echo "It has Full Disk Access already."
else
  cat <<EOF
To read calls, messages, notifications and Safari, the helper needs Full Disk Access.
App use works without it.

  1. System Settings opens at Privacy & Security, Full Disk Access.
  2. Click +, press Command-Shift-G, paste this and press Return, then click Open:

       $node

     (Or drag "node" from the Finder window that opens into the list.)
  3. Make sure its switch is on. You may need your Mac's password.
EOF
  if [ -z "${ARISE_HELPER_NO_OPEN:-}" ]; then
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
    open -R "$node" 2>/dev/null || true
  fi
fi

code=$(helper code)
cat <<EOF

Done. The helper runs now and at every login.

  Pairing code:   $code

In Arise on this Mac (in Chrome or Edge), open Settings, Your life, Mac, and enter the code.
macOS may say a background item called "node" was added: that's the helper.

  See the code again:   bash $dir/arise-helper.sh code
  Check on it:          bash $dir/arise-helper.sh status
  Remove it:            bash $dir/arise-helper.sh uninstall
EOF
