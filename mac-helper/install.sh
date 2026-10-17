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
# ~/.arise-helper/arise-helper.sh.
#
# Full Disk Access goes to one program, ~/.arise-helper/bin/arise-helper: the helper built into a
# single signed program on GitHub (.github/workflows/mac-helper.yml). It runs only its own code,
# takes no options from outside, and nothing in the environment it's started with makes it run other
# code or write files where that says. macOS ties Full Disk Access to its signature, so if anything
# changes the program, it loses the permission. That's also why each new build needs Full Disk
# Access again. An older helper (its own Node.js in ~/.arise-helper/node) is replaced, keeping its
# pairing code and switches.

set -eu
# (bash and zsh both have pipefail; plain sh may not.)
(set -o pipefail) 2>/dev/null && set -o pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

# The build of the helper this installer puts in place, and the SHA-256 of its download for each
# kind of Mac. They change in a reviewed pull request after the workflow has published a new build
# (docs/LAUNCH.md, "Updating the Mac helper"), and that pull request's checks confirm the files and
# GitHub's record that the workflow built them from main.
#
# Why checksums written here: they come with this copy of the installer, from the repo, so a file
# swapped on the release page doesn't match. The release's own .sha256 files come from the same
# place as the downloads, so they'd change with them. The checksums can't be in the same commit as
# the helper's code: the program can't be rebuilt bit for bit (its code cache differs a little each
# time), so they're only known once it's built. When gh (GitHub's command-line tool) is installed and
# logged in, the installer also checks GitHub's record of where the download was built.
helper_build=
helper_sha_arm64=
helper_sha_x64=

# (Not `path`: zsh ties that name to PATH.)
dir=${ARISE_HELPER_HOME:-$HOME/.arise-helper}
label=io.github.abyyworld.arise-helper
agent="$HOME/Library/LaunchAgents/$label.plist"
bin="$dir/bin/arise-helper"
repo=${ARISE_REPO:-abyyworld/physical-improvement-tracker-app}
self="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/$(basename "${BASH_SOURCE[0]:-$0}")"
uid=$(id -u)
service="gui/$uid/$label"

case "$dir" in
  "" | / | "$HOME" | "$HOME/") fail "ARISE_HELPER_HOME can't be $dir." ;;
esac

helper() { "$bin" "$@"; }

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
  echo "  1. In System Settings, Privacy & Security, Full Disk Access: select \"arise-helper\" (or \"node\","
  echo "     from an older helper) and click the minus button. Removing the helper doesn't take that away."
  echo "  2. In Arise, Settings, Your life, Mac: click Unlink."
}

# Full Disk Access given to the older helper's Node.js stays until it's removed by hand, and macOS
# would give it to any Node.js put back at that path (it's tied to Node.js's own signature). Once
# the helper has Full Disk Access itself, it checks, and its status says so.
older_node() {
  case "$1" in
    *'"node", from the older helper, still has Full Disk Access'*) say "$(printf '%s\n' "$1" | grep -F '"node", from the older helper')" ;;
  esac
}

installed() { [ -x "$bin" ]; }
# The helper before it was one signed program: its own Node.js and its scripts.
older() { [ -e "$dir/node" ] || [ -e "$dir/app" ]; }
need_installed() {
  installed && return 0
  older && fail "This is the older Arise helper. Run the install command again to update it."
  fail "The Arise helper isn't installed."
}

# Until the install command replaces the older helper, its commands still work: this does them
# itself, without running its Node.js. Its pairing code is in data/code, and the helper reads that
# file again when it changes.
older_cmd() {
  file="$dir/data/code"
  case "$1" in
    code)
      c=$(cat "$file" 2>/dev/null || true)
      printf '%s\n' "$c" | grep -Eq '^[0-9A-HJKMNP-TV-Z]{20}$' || fail "The older helper has no pairing code. Run the install command again."
      printf '%s\n' "$c" | sed 's/^\(.....\)\(.....\)\(.....\)\(.....\)$/\1-\2-\3-\4/'
      ;;
    new-code)
      # 20 letters and digits, without I, L, O or U, as the helper makes them.
      c=$(LC_ALL=C tr -dc '0-9A-HJKMNP-TV-Z' </dev/urandom 2>/dev/null | head -c 20 || true)
      printf '%s\n' "$c" | grep -Eq '^[0-9A-HJKMNP-TV-Z]{20}$' || fail "Couldn't make a new pairing code."
      { (umask 077 && printf '%s' "$c" >"$file.new") && mv -f "$file.new" "$file"; } || fail "Couldn't save the new pairing code."
      older_cmd code
      ;;
    status)
      if launchctl print "$service" >/dev/null 2>&1; then echo "The helper is running."; else
        echo "The helper isn't running."
        return 1
      fi
      ;;
    restart)
      launchctl kickstart -k "$service" || fail "Couldn't start it again. Run the install command again."
      echo "Started again."
      ;;
  esac
}

cmd=${1:-install}
case "$cmd" in
  install | update | uninstall | code | new-code | status | restart) ;;
  help | -h | --help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 1
    ;;
esac

# The helper runs as you, from your home folder. As root (sudo), it would put things there that
# you then can't change.
[ "$uid" != 0 ] || fail "Run this as yourself, without sudo."

case "$cmd" in
  uninstall)
    uninstall
    exit 0
    ;;
  code | new-code | status | restart)
    if ! installed && older && [ -d "$dir/data" ]; then
      rc=0
      older_cmd "$cmd" || rc=$?
      printf '\n%s\n' "This is the older Arise helper. To update it, run the install command again (in Arise: Settings, Your life, Mac)." >&2
      exit "$rc"
    fi
    ;;
esac

case "$cmd" in
  code | new-code | status)
    need_installed
    helper "$cmd"
    exit $?
    ;;
  restart)
    need_installed
    launchctl kickstart -k "$service" || fail "Couldn't start it again. Run the install command again."
    echo "Started again."
    exit 0
    ;;
esac

[ "$(uname -s)" = Darwin ] || fail "The Arise helper is for Macs. Run this in Terminal on your Mac."
# The signed helper always keeps its things in ~/.arise-helper: it doesn't take a folder from outside.
[ "$dir" = "$HOME/.arise-helper" ] || fail "The Arise helper always lives in ~/.arise-helper, so ARISE_HELPER_HOME can't be $dir."
case "$(uname -m)" in
  arm64) arch=arm64 want=$helper_sha_arm64 ;;
  x86_64) arch=x64 want=$helper_sha_x64 ;;
  *) fail "This Mac's processor ($(uname -m)) isn't one the helper is made for." ;;
esac
# The Node.js inside the helper needs macOS 13.5 or newer.
mac=$(sw_vers -productVersion 2>/dev/null || echo 0)
case "$mac" in *.*) ;; *) mac="$mac.0" ;; esac
mac_major=${mac%%.*}
mac_minor=${mac#*.}
mac_minor=${mac_minor%%.*}
if [ "$mac_major" -lt 13 ] 2>/dev/null || { [ "$mac_major" -eq 13 ] && [ "$mac_minor" -lt 5 ]; } 2>/dev/null; then
  fail "The Arise helper needs macOS 13.5 or newer. This Mac has $mac."
fi
case "$helper_build" in
  "" | *[!0-9]*)
    if older; then fail "This copy of the installer doesn't name a build of the helper yet, so it can't update the older helper. That one keeps running as it is, and its commands still work (bash $dir/arise-helper.sh code, status or restart). Try again later, with the install command from Arise (Settings, Your life, Mac)."; fi
    fail "This copy of the installer doesn't name a build of the helper yet. Try again later, with the install command from Arise (Settings, Your life, Mac)."
    ;;
esac
case "$want" in
  [0-9a-f]*) [ "${#want}" = 64 ] || fail "This copy of the installer has a broken checksum. Get it again with the install command from Arise." ;;
  *) fail "This copy of the installer has no checksum for this Mac. Get it again with the install command from Arise." ;;
esac

umask 077
mkdir -p "$dir"
chmod 700 "$dir"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/arise-helper.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

# 1. The helper, checked before anything on this Mac changes.
say "1 of 4. Getting the helper (build $helper_build)"
file="arise-helper-macos-$arch-b$helper_build.zip"
curl -fsSL "https://github.com/$repo/releases/download/mac-helper-latest/$file" -o "$tmp/$file" ||
  fail "Couldn't download the helper. Check the connection and run this again. (If it keeps failing, get the newest installer with the install command from Arise.)"
got=$(shasum -a 256 "$tmp/$file")
[ "${got%% *}" = "$want" ] || fail "The download didn't match its checksum, so it wasn't used. Run this again."
# With gh: GitHub's record of where it was built too. Only a gh that knows both options checks it
# (older ones stop at an option they don't know), and what gh says goes with a failure.
gh_checks() {
  h=$(gh attestation verify --help 2>&1 || true)
  case "$h" in *--signer-workflow*) ;; *) return 1 ;; esac
  case "$h" in *--source-ref*) ;; *) return 1 ;; esac
}
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if ! gh_checks; then
    echo "(This gh is too old to check GitHub's record of where the helper was built. Its checksum matched.)"
  elif gh attestation verify "$tmp/$file" --repo "$repo" --signer-workflow "$repo/.github/workflows/mac-helper.yml" --source-ref refs/heads/main >"$tmp/gh.txt" 2>&1; then
    echo "GitHub's record says Arise's own workflow built it."
  else
    fail "GitHub's record of where the helper was built didn't check out, so it wasn't used. gh said:

$(tail -n 20 "$tmp/gh.txt")

If that's about gh itself (its version, its sign-in or the connection), update gh or log it out (gh auth logout), then run this again. The checksum check stays either way."
  fi
fi
mkdir "$tmp/unpacked"
ditto -x -k "$tmp/$file" "$tmp/unpacked" || fail "Couldn't unpack the helper. Run this again."
new="$tmp/unpacked/arise-helper"
if [ ! -f "$new" ] || [ -L "$new" ]; then fail "The download didn't have the helper in it."; fi
# Signed the way macOS ties Full Disk Access to it: as Arise's helper, with the hardened runtime.
codesign --verify --strict "$new" 2>/dev/null || fail "The helper's signature didn't check out, so it wasn't used."
sig=$(codesign -dv "$new" 2>&1)
case "$sig" in
  *"Identifier=$label"*) ;;
  *) fail "The download isn't the Arise helper, so it wasn't used." ;;
esac
case "$sig" in
  *"flags=0x"*"runtime)"*) ;;
  *) fail "The helper isn't signed with the hardened runtime, so it wasn't used." ;;
esac
"$new" version >/dev/null 2>&1 || fail "The helper didn't start on this Mac."
echo "Checked: $("$new" version)"
checked=$(shasum -a 256 "$new")
checked=${checked%% *}

# 2. In place of the one before. The pairing code and the switches (in data/) stay.
say "2 of 4. Putting it in place"
was=new
if older; then
  was=older
elif installed; then
  was=update
fi
launchctl bootout "$service" 2>/dev/null || true
mkdir -p "$dir/bin"
chmod 700 "$dir/bin"
cp "$new" "$dir/bin/arise-helper.new"
chmod 700 "$dir/bin/arise-helper.new"
mv -f "$dir/bin/arise-helper.new" "$bin"
# The older helper's Node.js and scripts: nothing runs them now.
rm -rf "$dir/node" "$dir/app" "$dir/app.new" "$dir/app.old" "$dir/tmp"
# A new file, not the old one changed: this script may be that copy, running right now.
cp "$self" "$dir/arise-helper.sh.new"
chmod 700 "$dir/arise-helper.sh.new"
mv -f "$dir/arise-helper.sh.new" "$dir/arise-helper.sh"
if [ "$was" = older ]; then echo "Replaced the older helper (its own Node.js) with the signed one. The pairing code and switches stay."; fi
echo "In $bin"

# 3. A LaunchAgent starts it at login and starts it again if it ever stops. It runs the program
# itself: no interpreter, no script.
say "3 of 4. Starting it, now and at every login"
mkdir -p "$HOME/Library/LaunchAgents"
helper plist >"$tmp/agent.plist"
plutil -lint "$tmp/agent.plist" >/dev/null || fail "The LaunchAgent file came out wrong. Run this again."
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
st=$(helper status 2>/dev/null || true)
if printf '%s\n' "$st" | grep -q 'Full Disk Access: yes'; then
  echo "It has Full Disk Access already."
  if [ "$was" = older ]; then echo "In that list, remove \"node\" (the older helper's) with the minus button: nothing needs it now."; fi
else
  echo "To read calls, messages, notifications and Safari, the helper needs Full Disk Access."
  echo "App use works without it."
  echo
  echo "  1. System Settings opens at Privacy & Security, Full Disk Access."
  case "$was" in
    older) echo "     Select \"node\" (the older helper's) and click the minus button: nothing needs it now." ;;
    update) echo "     If \"arise-helper\" is in the list, select it and click the minus button: macOS ties the permission to one exact build." ;;
  esac
  cat <<EOF
  2. Click +, press Command-Shift-G, paste this and press Return, then click Open:

       $bin

     (Or drag "arise-helper" from the Finder window that opens into the list.)
  3. Make sure its switch is on. You may need your Mac's password.
EOF
  if [ -z "${ARISE_HELPER_NO_OPEN:-}" ]; then
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
    open -R "$bin" 2>/dev/null || true
  fi
  # Any app running as you could put its own program at that path before you add it, and macOS
  # would give Full Disk Access to that one. So in Terminal, this waits while you do it, then
  # checks that the file is still the one checked above and that the helper itself has the
  # permission now. (ARISE_HELPER_WAIT=yes or no decides without a terminal, as in its tests.)
  wait_for=${ARISE_HELPER_WAIT:-}
  if [ -z "$wait_for" ]; then if [ -t 0 ]; then wait_for=yes; else wait_for=no; fi; fi
  if [ "$wait_for" = yes ]; then
    printf '\n%s ' "When its switch is on, press Return here. (Or press Control-C and do it later.)"
    read -r _ || true
    now=$(shasum -a 256 "$bin")
    [ "${now%% *}" = "$checked" ] || fail "Careful: $bin changed after it was checked. Something else on this Mac may have put its own program there, and macOS may have given that one Full Disk Access. In System Settings, Privacy & Security, Full Disk Access, select \"arise-helper\" and click the minus button. Then run the install command again."
    # Started again from that file, so it checks its permission at once.
    launchctl kickstart -k "$service" 2>/dev/null || true
    tries=0
    while [ "$tries" -lt 15 ]; do
      tries=$((tries + 1))
      st=$(helper status 2>/dev/null || true)
      if printf '%s\n' "$st" | grep -q 'Full Disk Access: yes'; then break; fi
      sleep 1
    done
    if printf '%s\n' "$st" | grep -q 'Full Disk Access: yes'; then
      echo "It has Full Disk Access now."
    else
      echo "The helper doesn't have Full Disk Access yet. If you did turn it on for \"arise-helper\", something else may have it instead: select \"arise-helper\" in that list, click the minus button, and run the install command again."
    fi
  else
    echo
    echo "Once it's on, check that the helper has it: bash $dir/arise-helper.sh status"
  fi
fi
older_node "$st"
cat <<'EOF'

Good to know: Full Disk Access belongs to this one signed program, which runs only the
helper's own code. If anything changes it, macOS takes the permission away. Other apps you
run can still read the pairing code (in your browser, or in ~/.arise-helper) and use it to
turn on anything the helper can read, messages and their words too, and get what it reads. The
switches in Arise show what's on. So use the helper on a Mac where you trust what you install.
EOF

code=$(helper code)
cat <<EOF

Done. The helper runs now and at every login.

  Pairing code:   $code

In Arise on this Mac (in Chrome or Edge), open Settings, Your life, Mac, and enter the code.
macOS may say a background item called "arise-helper" was added: that's the helper.

  See the code again:   bash $dir/arise-helper.sh code
  Check on it:          bash $dir/arise-helper.sh status
  Remove it:            bash $dir/arise-helper.sh uninstall
EOF
