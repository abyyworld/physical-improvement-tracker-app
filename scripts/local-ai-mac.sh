#!/usr/bin/env bash
# Arise: AI on this Mac, with Ollama, so the coach can answer without anything leaving it.
# Settings, AI coach, Your computer's AI shows this command:
#
#   curl -fsSL https://raw.githubusercontent.com/abyyworld/physical-improvement-tracker-app/main/scripts/local-ai-mac.sh | bash
#
# 1. Installs Ollama with ollama.com's own installer, if it isn't here yet.
# 2. Lets Arise's website (and the Arise iPhone app, on a Mac that runs it) talk to Ollama: adds
#    them to OLLAMA_ORIGINS, now and at every login (a small LaunchAgent), keeping any addresses
#    already there.
# 3. Starts Ollama again so it takes that in.
# 4. Downloads a model that fits this Mac's memory, if it isn't here yet. ARISE_MODEL picks
#    another: curl ... | ARISE_MODEL=qwen2.5:14b bash
#
# Run it again any time: what's already right stays as it is. A copy of Arise at its own address
# adds that too: curl ... | bash -s -- https://example.com
#
# To undo step 2: rm ~/Library/LaunchAgents/io.github.abyyworld.arise-ollama.plist, then
# launchctl unsetenv OLLAMA_ORIGINS, then quit Ollama and open it again.
#
# Works in bash and zsh. Everything is inside main, so a download cut short runs nothing.

main() {
  set -eu
  (set -o pipefail) 2>/dev/null && set -o pipefail

  say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
  fail() {
    printf '\n%s\n' "$*" >&2
    exit 1
  }

  [ "$(uname -s)" = Darwin ] || fail "This is for a Mac. For Windows or Linux, see Settings, AI coach, Your computer's AI, in Arise."

  # Arise's website (src/lib/local-ai.ts, SITE_ORIGIN).
  site=https://abyyworld.github.io
  extra=${1:-}
  case "$extra" in
    "") ;;
    https://*)
      printf '%s' "$extra" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' || fail "That isn't a website's address: $extra"
      ;;
    *) fail "That isn't a website's address (it starts with https://): $extra" ;;
  esac
  # The iPhone app's own address. Ollama refuses to start with an address whose kind it doesn't
  # know (capacitor://), unless it ends in *, so it's written that way.
  app_origin='capacitor://localhost*'

  api=http://127.0.0.1:11434
  app=${ARISE_OLLAMA_APP:-/Applications/Ollama.app} # (another place only for its tests)
  label=io.github.abyyworld.arise-ollama
  agent="$HOME/Library/LaunchAgents/$label.plist"

  # 1. Ollama
  bin=$(command -v ollama 2>/dev/null || true)
  [ -z "$bin" ] && [ -x "$app/Contents/Resources/ollama" ] && bin="$app/Contents/Resources/ollama"
  if [ -z "$bin" ]; then
    say "1 of 4. Installing Ollama (from ollama.com)"
    # (It may ask for your Mac's password, to add the ollama command.)
    curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh || fail "Ollama didn't install (see above). Run this again, or get it from ollama.com/download."
    bin=$(command -v ollama 2>/dev/null || true)
    [ -z "$bin" ] && [ -x "$app/Contents/Resources/ollama" ] && bin="$app/Contents/Resources/ollama"
    [ -n "$bin" ] || fail "Ollama didn't install (see above). Run this again, or get it from ollama.com/download."
  else
    say "1 of 4. Ollama is already here"
  fi

  # 2. Let Arise in, keeping what's there.
  say "2 of 4. Letting Arise talk to Ollama"
  origins=$(launchctl getenv OLLAMA_ORIGINS 2>/dev/null || true)
  for o in "$site" "$extra" "$app_origin"; do
    [ -n "$o" ] || continue
    case ",$origins," in
      *",$o,"*) ;;
      *) origins="${origins:+$origins,}$o" ;;
    esac
  done
  launchctl setenv OLLAMA_ORIGINS "$origins"
  # At every login: set it again, and if Ollama started first without it, start Ollama again.
  # (The addresses go in as an argument, never into the script itself.)
  xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
  mkdir -p "$HOME/Library/LaunchAgents"
  tmp=$(mktemp)
  cat >"$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/bin/launchctl setenv OLLAMA_ORIGINS "\$1"; sleep 20; code=\$(/usr/bin/curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Origin: \$2" $api/api/version); if [ "\$code" = 403 ] &amp;&amp; /usr/bin/pgrep -x Ollama &gt;/dev/null; then /usr/bin/pkill -x Ollama; sleep 3; /usr/bin/pkill -f $app/Contents/Resources/ollama; sleep 2; /usr/bin/open -a Ollama --args hidden; fi</string>
    <string>arise-ollama</string>
    <string>$(xml "$origins")</string>
    <string>$site</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
  plutil -lint "$tmp" >/dev/null || fail "The LaunchAgent file came out wrong. Run this again."
  mv "$tmp" "$agent"
  chmod 644 "$agent"
  echo "OLLAMA_ORIGINS is $origins (now, and at every login)."

  # 3. Start Ollama again, so it takes that in.
  say "3 of 4. Starting Ollama again"
  if pgrep -x Ollama >/dev/null 2>&1; then
    pkill -x Ollama || true
    tries=0
    while pgrep -x Ollama >/dev/null 2>&1 && [ "$tries" -lt 15 ]; do
      tries=$((tries + 1))
      sleep 1
    done
    # The app's own server, if it's still there (not one started some other way).
    pkill -f "$app/Contents/Resources/ollama" 2>/dev/null || true
    sleep 1
  fi
  if [ -d "$app" ]; then
    open -a Ollama --args hidden
  elif command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -Eq '^ollama[[:space:]]+started'; then
    brew services restart ollama >/dev/null
  elif ! curl -fsS -m 2 "$api/api/version" >/dev/null 2>&1; then
    mkdir -p "$HOME/.ollama"
    OLLAMA_ORIGINS="$origins" nohup "$bin" serve >"$HOME/.ollama/arise-serve.log" 2>&1 &
  fi
  up=no
  tries=0
  while [ "$tries" -lt 30 ]; do
    tries=$((tries + 1))
    if curl -fsS -m 2 "$api/api/version" >/dev/null 2>&1; then
      up=yes
      break
    fi
    sleep 1
  done
  [ "$up" = yes ] || fail "Ollama didn't start. Open the Ollama app once, then run this again."
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Origin: $site" "$api/api/tags" || true)
  if [ "$code" != 200 ]; then
    fail "Ollama is running, but doesn't let Arise in yet. If you started it in Terminal with \"ollama serve\", stop it (Control-C) and start it again like this: OLLAMA_ORIGINS='$origins' ollama serve. Then run this again."
  fi
  echo "Ollama is running, and lets Arise in."

  # 4. A model that fits this Mac.
  gb=$(($(sysctl -n hw.memsize) / 1073741824))
  model=${ARISE_MODEL:-}
  note=""
  if [ -z "$model" ]; then
    if [ "$gb" -ge 96 ]; then
      model=qwen2.5:72b
      note="about 47 GB. It's big enough to write your memory too"
    elif [ "$gb" -ge 48 ]; then
      model=qwen2.5:32b
      note="about 20 GB"
    elif [ "$gb" -ge 24 ]; then
      model=qwen2.5:14b
      note="about 9 GB"
    else
      model=qwen2.5:7b
      note="about 5 GB"
    fi
  fi
  say "4 of 4. The model: $model"
  if "$bin" list 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -Fx "$model" >/dev/null; then
    echo "It's already here."
  else
    echo "This Mac has $gb GB of memory, so: $model${note:+ ($note)}. Downloading it, once."
    "$bin" pull "$model" || fail "The download didn't finish. Run this again: it carries on where it stopped."
  fi

  say "All set."
  echo "In Arise on this Mac: Settings, AI coach, Your computer's AI, then Check again."
  echo "Chrome or Edge may ask to let Arise reach apps on this device. Choose Allow."
}

main "$@"
