#!/usr/bin/env bash
# Sets up Arise's two Cloudflare Workers in one go:
#   - the private AI proxy (worker/ai-proxy), with the Tinfoil API key as its secret,
#   - the reminders server for the web app (worker/reminders), which needs no keys at all.
#
# Run it from a copy of the repo. A downloaded .zip or .tar.gz works too: git isn't needed.
#
#   bash scripts/setup-workers.sh        (or: zsh scripts/setup-workers.sh)
#
# You need a free Cloudflare account and a Tinfoil API key (https://tinfoil.sh, with billing and a
# spending limit set up). Node.js 20 or newer is used if it's there; otherwise a recent one is
# fetched from nodejs.org for this run only. It logs in to Cloudflare (once: a browser window
# opens), deploys both Workers, and puts their addresses into src/ai-config.ts and
# src/reminders-config.ts on GitHub (with gh, if it's logged in) or prints them. Run it again any
# time to update both; press Return when it asks for the key to keep the one that's already there.

set -eu
# (bash and zsh both have pipefail; plain sh may not.)
(set -o pipefail) 2>/dev/null && set -o pipefail

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}
wrangler() { npx -y wrangler@4 "$@"; }

root=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)
ai="$root/worker/ai-proxy"
reminders="$root/worker/reminders"
if [ ! -f "$ai/wrangler.toml" ] || [ ! -f "$reminders/wrangler.toml" ]; then
  fail "Run this from a copy of the Arise repo: it needs worker/ai-proxy and worker/reminders."
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/arise-setup.XXXXXX")
# Whatever happens, typing shows again and the logs go.
trap 'stty echo 2>/dev/null || true; rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

# Node.js 20 or newer is needed. With an older one (or none), a recent Node.js 22 is downloaded from
# nodejs.org into the temporary folder for this run only: nothing is installed, and it's gone after.
node_ok() { command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }
if ! node_ok; then
  say "Getting Node.js 22 for this setup only (nothing is installed)"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) plat=darwin-arm64 ;;
    Darwin-x86_64) plat=darwin-x64 ;;
    Linux-x86_64) plat=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) plat=linux-arm64 ;;
    *) fail "This needs Node.js 20 or newer. Get it from https://nodejs.org, then run this again." ;;
  esac
  dist=https://nodejs.org/dist/latest-v22.x
  sums=$(curl -fsSL "$dist/SHASUMS256.txt") || fail "Couldn't reach nodejs.org. Check the connection, or install Node.js 20 or newer from https://nodejs.org."
  line=$(printf '%s\n' "$sums" | grep -E "  node-v22\.[0-9.]+-$plat\.tar\.gz\$" | head -n 1)
  [ -n "$line" ] || fail "Couldn't find Node.js 22 for this computer. Install Node.js 20 or newer from https://nodejs.org."
  file=${line##* }
  curl -fsSL "$dist/$file" -o "$tmp/$file" || fail "Couldn't download Node.js. Check the connection and run this again."
  if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$tmp/$file"); else got=$(sha256sum "$tmp/$file"); fi
  [ "${got%% *}" = "${line%% *}" ] || fail "The Node.js download didn't match its checksum. Run this again."
  tar -xzf "$tmp/$file" -C "$tmp"
  PATH="$tmp/${file%.tar.gz}/bin:$PATH"
  export PATH
  node_ok || fail "Couldn't start the downloaded Node.js. Install Node.js 20 or newer from https://nodejs.org."
  echo "Using Node.js $(node -v) for now."
fi

# Deploys the Worker in folder $1 and sets $url to its address. wrangler keeps the terminal, so
# it can ask questions (which account to use, or a workers.dev name on a new account); `script`
# keeps a copy of what it prints to find the address in.
url=''
deploy() {
  local log
  log="$tmp/$(basename "$1").log"
  : >"$log"
  if [ -t 0 ] && [ -t 1 ] && command -v script >/dev/null 2>&1; then
    case "$(uname -s)" in
      Darwin | *BSD) (cd "$1" && script -q "$log" npx -y wrangler@4 deploy) || true ;;
      *) (cd "$1" && script -qec "npx -y wrangler@4 deploy" "$log") || true ;;
    esac
  else
    (cd "$1" && npx -y wrangler@4 deploy 2>&1) | tee "$log" || true
  fi
  url=$(tr -d '\r' <"$log" | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | tail -n 1 || true)
  [ -n "$url" ] || fail "$(basename "$1") didn't deploy (see above). Fix that, then run this again."
}

say "1 of 4. Logging in to Cloudflare"
if wrangler whoami 2>&1 | grep -q 'You are logged in'; then
  echo "Already logged in."
else
  wrangler login
fi

say "2 of 4. Deploying the private AI proxy"
deploy "$ai"
ai_url=$url

say "3 of 4. The Tinfoil API key"
secrets=$(cd "$ai" && wrangler secret list 2>/dev/null || true)
case "$secrets" in
  *'"TINFOIL_API_KEY"'*) has_key=yes ;;
  *) has_key=no ;;
esac
if [ "$has_key" = yes ]; then
  echo "The proxy already has a key. Paste a new one to replace it, or just press Return to keep it."
else
  echo "Paste your Tinfoil API key (from https://tinfoil.sh). It won't show as you paste."
fi
printf 'Tinfoil API key: '
stty -echo 2>/dev/null || true
key=''
IFS= read -r key || true
stty echo 2>/dev/null || true
printf '\n'
if [ -n "$key" ]; then
  # Sent to wrangler on its input, so it's never on a command line or in a file.
  printf '%s' "$key" | (cd "$ai" && npx -y wrangler@4 secret put TINFOIL_API_KEY) || fail "Couldn't save the key (see above). Run this again to try once more."
  key=''
elif [ "$has_key" = no ]; then
  echo "No key given, so the private AI won't work yet. Run this again with the key when you have it."
fi

say "4 of 4. Deploying the reminders server"
deploy "$reminders"
reminders_url=$url

say "Done. Both Workers are live."
cat <<EOF

  Private AI proxy:   $ai_url
  Reminders server:   $reminders_url
EOF

# (Not `path`: zsh ties that name to PATH.)
# Puts an address into one of the config files on GitHub's main branch, keeping everything else in
# the file as it is there. A file main doesn't have yet starts from this copy's.
publish() {
  local file=$1 key=$2 value=$3 json body
  json=$(gh api "repos/$repo/contents/$file?ref=main" 2>/dev/null || true)
  body=$(JSON="$json" LOCAL="$root/$file" KEY="$key" VALUE="$value" node -e '
    const fs = require("fs");
    const remote = process.env.JSON ? JSON.parse(process.env.JSON) : null;
    const text = remote && remote.content ? Buffer.from(remote.content, "base64").toString("utf8") : fs.readFileSync(process.env.LOCAL, "utf8");
    const re = new RegExp("(\\b" + process.env.KEY + ": )\x27[^\x27]*\x27");
    if (!re.test(text)) { console.error("No " + process.env.KEY + " in " + process.env.LOCAL); process.exit(1); }
    const out = { message: "Turn on " + (process.env.KEY === "proxy" ? "the private AI" : "web reminders"), branch: "main", content: Buffer.from(text.replace(re, (m, start) => start + "\x27" + process.env.VALUE + "\x27")).toString("base64") };
    if (remote && remote.sha) out.sha = remote.sha;
    process.stdout.write(JSON.stringify(out));
  ') || return 1
  printf '%s' "$body" | gh api -X PUT "repos/$repo/contents/$file" --input - >/dev/null
}

repo=${ARISE_REPO:-abyyworld/physical-improvement-tracker-app}
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  say "Putting the addresses into the app"
  printf 'Add them to github.com/%s now, so every installed app picks them up by itself? [Y/n] ' "$repo"
  answer=''
  IFS= read -r answer || true
  case "$answer" in
    [Nn]*) ;;
    *)
      publish src/ai-config.ts proxy "$ai_url/v1/" || fail "Couldn't update src/ai-config.ts on GitHub (see above)."
      publish src/reminders-config.ts server "$reminders_url" || fail "Couldn't update src/reminders-config.ts on GitHub (see above)."
      echo "Done. The site updates in a few minutes, and every installed app follows by itself."
      exit 0
      ;;
  esac
fi
cat <<EOF

Now put the addresses in the app, then push to main (every installed app picks them up by itself):

  src/ai-config.ts           proxy: '$ai_url/v1/',
  src/reminders-config.ts    server: '$reminders_url',

EOF
