#!/usr/bin/env bash
# Tries out the signed helper on a Mac. .github/workflows/mac-helper.yml runs it on each kind of Mac
# (Apple silicon and Intel) right after signing:
#
#   bash mac-helper/test/program.sh <program> <arm64 | x64>
#
# It checks that the program is signed the way macOS ties Full Disk Access to (ad hoc, hardened
# runtime, only the JIT entitlement, a designated requirement that is its own hash), that nothing
# it's started with can make it run other code (arguments, NODE_OPTIONS, the compile cache, DYLD_*,
# OPENSSL_CONF, SIGUSR1), that it serves Arise and answers its own status command, and that a link
# put in its folder never makes it write where the link points.
# It starts the program as this user, so it uses this user's ~/.arise-helper: run it on a CI Mac.

set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

prog=${1:?the program}
want_arch=${2:?arm64 or x64}
fail() {
  printf '::error::%s\n' "$*"
  exit 1
}
ok() { printf 'ok: %s\n' "$*"; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/arise-program.XXXXXX")
pid=
cleanup() {
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

# ---------- 1. Signed the way macOS ties Full Disk Access to

codesign --verify --strict --verbose=2 "$prog" || fail "The signature doesn't check out."
info=$(codesign -dvvv "$prog" 2>&1)
printf '%s\n' "$info"
printf '%s\n' "$info" | grep -q '^Identifier=io.github.abyyworld.arise-helper$' || fail "Wrong identifier."
printf '%s\n' "$info" | grep -q '^Signature=adhoc$' || fail "Not signed ad hoc."
printf '%s\n' "$info" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' || fail "No hardened runtime."
ok "signed ad hoc, with the hardened runtime"

ents=$(codesign -d --entitlements - --xml "$prog" 2>/dev/null || codesign -d --entitlements - "$prog" 2>/dev/null)
printf '%s\n' "$ents" | grep -q 'com.apple.security.cs.allow-jit' || fail "No JIT entitlement."
for bad in get-task-allow allow-dyld-environment-variables disable-library-validation allow-unsigned-executable-memory disable-executable-page-protection debugger; do
  case "$ents" in *"$bad"*) fail "It must not have the $bad entitlement." ;; esac
done
ok "only the JIT entitlement"

req=$(codesign -d -r- "$prog" 2>&1)
printf '%s\n' "$req"
printf '%s\n' "$req" | grep -Eq 'designated => cdhash H"[0-9a-f]{40}"' || fail "Its designated requirement isn't its own hash."
ok "macOS knows it by its hash (cdhash)"

case "$want_arch" in
  arm64) mach=arm64 ;;
  x64) mach=x86_64 ;;
  *) fail "Unknown processor $want_arch." ;;
esac
file "$prog" | grep -q "$mach" || fail "Not built for $mach: $(file "$prog")"
[ "$(uname -m)" = "$mach" ] || fail "This Mac is $(uname -m), not $mach."
ok "built for $mach"

# ---------- 2. Nothing it's started with makes it run other code

# Code that leaves a mark if it ever runs.
mark="$tmp/ran"
printf 'require("node:fs").writeFileSync(%s, "x");\n' "\"$mark\"" >"$tmp/evil.js"
printf 'import fs from "node:fs"; fs.writeFileSync(%s, "x");\n' "\"$mark\"" >"$tmp/evil.mjs"
# An OpenSSL settings file that loads a library: Node.js itself stops at the start when it reads it,
# since that library isn't there.
printf 'openssl_conf = boom\nnodejs_conf = boom\n[boom]\nproviders = nope\n[nope]\nevil = evil_sect\n[evil_sect]\nmodule = %s/evil.dylib\nactivate = 1\n' "$tmp" >"$tmp/evil.cnf"

out=$(
  NODE_OPTIONS="--require $tmp/evil.js --import $tmp/evil.mjs --inspect=9231" \
    NODE_COMPILE_CACHE="$tmp/cache" \
    NODE_ICU_DATA="$tmp" \
    OPENSSL_CONF="$tmp/evil.cnf" \
    "$prog" version --require "$tmp/evil.js" --node-options="--require $tmp/evil.js" -e 'require("fs")' 2>&1
) || fail "It stopped when started with options from outside: $out"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -q '^Arise helper 1, build ' || fail "version didn't answer."
# (A rejected code cache would mean it compiled its script again, with options it wasn't made with.)
case "$out" in *"cache data rejected"* | *ExperimentalWarning* | *Debugger* | *"configuration error"*) fail "It said more than its version: $out" ;; esac
[ ! -e "$mark" ] || fail "It ran code from outside."
if [ -d "$tmp/cache" ] && [ -n "$(find "$tmp/cache" -type f)" ]; then fail "It used the compile cache."; fi
ok "ignores NODE_OPTIONS, NODE_COMPILE_CACHE, NODE_ICU_DATA, OPENSSL_CONF and extra arguments"

# A library put in with DYLD_INSERT_LIBRARIES must never run inside it. A real one, signed ad hoc
# like the program, that leaves a mark if it runs. macOS may ignore the variable (and the program
# answers as usual) or refuse the library and stop the program: either way nothing of it runs.
cat >"$tmp/evil.c" <<C
#include <stdio.h>
__attribute__((constructor)) static void evil(void) { FILE *f = fopen("$tmp/dylib-ran", "w"); if (f) fclose(f); }
C
if command -v clang >/dev/null 2>&1; then
  clang -dynamiclib -o "$tmp/evil.dylib" "$tmp/evil.c" || fail "Couldn't build the test library."
  codesign --force --sign - "$tmp/evil.dylib" || fail "Couldn't sign the test library."
  if out=$(DYLD_INSERT_LIBRARIES="$tmp/evil.dylib" "$prog" version 2>&1); then how="ignored it"; else how="refused it and stopped"; fi
  if [ ! -e "$tmp/dylib-ran" ]; then
    ok "runs no library put in with DYLD_INSERT_LIBRARIES (macOS $how)"
  elif [ -n "${ARISE_DEVELOPER_ID:-}" ]; then
    fail "A library put in with DYLD_INSERT_LIBRARIES ran inside the Developer ID-signed program."
  else
    # Known, and said in the README, LAUNCH and the privacy page: macOS doesn't apply the hardened
    # runtime's library rules to an ad-hoc signature. Only a Developer ID signature stops this.
    echo "::warning::A library put in with DYLD_INSERT_LIBRARIES ran inside the ad-hoc-signed program (a known limit without a Developer ID)."
    echo "note: a library put in with DYLD_INSERT_LIBRARIES runs in it (ad-hoc signature)"
  fi
else
  fail "No clang on this Mac to build the test library."
fi

for first in --require -e --eval --inspect --node-options="--require $tmp/evil.js" "$tmp/evil.js"; do
  if "$prog" "$first" "$tmp/evil.js" >/dev/null 2>&1; then fail "It accepted $first as a command."; fi
done
[ ! -e "$mark" ] || fail "It ran code from outside."
ok "only its own commands"

# What Node.js itself reads from the environment can't make it write anywhere: no warnings
# (NODE_REDIRECT_WARNINGS would name a file to add them to), no coverage files at exit.
NODE_REDIRECT_WARNINGS="$tmp/warnings" NODE_PENDING_DEPRECATION=1 NODE_V8_COVERAGE="$tmp/coverage" \
  "$prog" version >/dev/null 2>&1 || fail "It stopped when started with NODE_REDIRECT_WARNINGS or NODE_V8_COVERAGE."
[ ! -e "$tmp/warnings" ] || fail "It wrote warnings where NODE_REDIRECT_WARNINGS said."
[ ! -e "$tmp/coverage" ] || fail "It wrote coverage files where NODE_V8_COVERAGE said."
ok "writes no warnings or coverage files where its environment says"

# Nor set it up as a cluster worker, or with a channel to whoever started it.
if NODE_UNIQUE_ID=1 "$prog" version >/dev/null 2>&1; then fail "It ran as a cluster worker set up from outside."; fi
if command -v python3 >/dev/null 2>&1; then
  python3 - "$prog" <<'PY' || fail "It ran with a channel to the program that started it."
import os, socket, subprocess, sys
a, b = socket.socketpair()
env = dict(os.environ, NODE_CHANNEL_FD=str(b.fileno()))
r = subprocess.run([sys.argv[1], "version"], pass_fds=(b.fileno(),), env=env, capture_output=True, timeout=30)
print(r.returncode, r.stdout.decode(), r.stderr.decode())
sys.exit(0 if r.returncode != 0 and b"Arise helper" not in r.stdout and b"a channel to the program" in r.stderr else 1)
PY
fi
ok "won't run as a cluster worker, or with a channel to whoever started it"

# ---------- 3. It serves, answers its status command, and SIGUSR1 opens no debugger

# Uses this user's ~/.arise-helper (where its things always are): a CI Mac's.
"$prog" serve >"$tmp/serve.log" 2>&1 &
pid=$!
up=no
tries=0
while [ "$tries" -lt 20 ]; do
  tries=$((tries + 1))
  if "$prog" status >/dev/null 2>&1; then
    up=yes
    break
  fi
  sleep 1
done
[ "$up" = yes ] || fail "It didn't start: $(cat "$tmp/serve.log")"
"$prog" status
ok "serves on 127.0.0.1:47613"

hello=$(curl -fsS http://127.0.0.1:47613/v1/hello)
printf '%s\n' "$hello" | grep -Eq '"nonce":"[0-9a-f]{32}"' || fail "No hello: $hello"
# Enough requests and status checks (fetch, with its WebAssembly) for V8 to compile code, which
# needs the JIT entitlement under the hardened runtime.
n=0
while [ "$n" -lt 300 ]; do
  n=$((n + 1))
  curl -fsS -o /dev/null http://127.0.0.1:47613/v1/hello
  curl -s -o /dev/null -H 'Authorization: Arise 00000000000000000000000000000000.00000000000000000000000000000000.0000000000000000000000000000000000000000000000000000000000000000' http://127.0.0.1:47613/v1/status || true
done
n=0
while [ "$n" -lt 10 ]; do
  n=$((n + 1))
  "$prog" status >/dev/null || fail "status failed after $n tries."
done
ok "keeps working once V8 compiles"

kill -USR1 "$pid"
sleep 2
kill -0 "$pid" 2>/dev/null || fail "SIGUSR1 stopped it."
if curl -fsS -m 3 http://127.0.0.1:9229/json/version >/dev/null 2>&1; then fail "SIGUSR1 opened a debugger."; fi
ok "SIGUSR1 opens no debugger"

kill "$pid"
wait "$pid" 2>/dev/null || true
pid=
cat "$tmp/serve.log"
grep -q 'listening on 127.0.0.1:47613' "$tmp/serve.log" || fail "It didn't say it was listening."
case "$(cat "$tmp/serve.log")" in *"cache data rejected"* | *ExperimentalWarning* | *Debugger*) fail "Its log has something it shouldn't." ;; esac

# ---------- 4. A link in its folder never makes it write where the link points

base="$HOME/.arise-helper"
elsewhere="$tmp/elsewhere"
mkdir "$elsewhere"
mv "$base/data" "$tmp/data.saved"
ln -s "$elsewhere" "$base/data"
if "$prog" new-code >/dev/null 2>&1; then fail "It made a new code in a data folder that is a link."; fi
[ -z "$(ls -A "$elsewhere")" ] || fail "It wrote where a linked data folder points: $(ls -A "$elsewhere")"
rm "$base/data"
mv "$tmp/data.saved" "$base/data"
ok "won't use a data folder that is a link"

head -c 2000000 /dev/zero >"$elsewhere/big"
rm -f "$base/logs/helper.log"
ln -s "$elsewhere/big" "$base/logs/helper.log"
"$prog" serve >"$tmp/serve2.log" 2>&1 &
pid=$!
tries=0
while [ "$tries" -lt 20 ] && ! "$prog" status >/dev/null 2>&1; do
  tries=$((tries + 1))
  sleep 1
done
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
pid=
[ "$(wc -c <"$elsewhere/big" | tr -d ' ')" = 2000000 ] || fail "It trimmed the file its log's link points to."
rm "$base/logs/helper.log"
ok "won't trim a log that is a link"
ok "all good"
