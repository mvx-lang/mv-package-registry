#!/bin/sh
# mv-package-registry — end-to-end install-loop test.
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
#
#   MVX_HOME=/path/to/mvx-lang MV_PACKAGE_DIR=/path/to/mv_package ./test/run.sh
#
# or against an INSTALLED mvx rather than a built checkout -- which is how CI
# runs it, and what a user actually has:
#
#   MVX=.../mvx-lang/bin/mvx MVX_DRIVERS=.../mvx-lang/lib \
#   MVXSYSTEM=.../mvx-lang/share/mvx/system \
#   MV_PACKAGE_DIR=/path/to/mv_package ./test/run.sh
#
# Proves the whole loop across all three repos against the *index-only* registry
# (it hosts nothing; a package's tarball is an external URL).  We stand up a
# local static file server for the fixture tarballs, seed the registry index to
# point at them, build the MVPKG client, then `MVPKG install` and assert:
# install + build + link, a missing package, dependencies (deps-first), an
# optional dependency that is skipped when absent, a `provides` rename resolving
# to its provider, and idempotency.  Needs node + a built mvx toolchain.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"                       # this registry repo
: "${MV_PACKAGE_DIR:?set MV_PACKAGE_DIR to your mv_package (client) checkout}"

# A BUILT CHECKOUT OR AN INSTALLED RELEASE, and the three paths differ:
#
#   build       $MVX_HOME/build/{bin/mvx,lib,system}
#   release     <root>/mvx-lang/{bin/mvx,lib,share/mvx/system}
#
# So each is overridable and MVX_HOME is only the default -- which is exactly
# what mv_package's own build.sh does (MVX / MVX_DRIVERS / MVXSYSTEM), and the
# point of matching it is that one invocation can drive both.
#
# IT MATTERS WHICH ONE IS TESTED.  Ports consume the PUBLISHED release, so the
# install loop should be provable against that and not only against a developer's
# build tree -- which was the only thing it could run against before (#69).
MVX="${MVX:-${MVX_HOME:+$MVX_HOME/build/bin/mvx}}"
MVX_DRIVERS="${MVX_DRIVERS:-${MVX_HOME:+$MVX_HOME/build/lib}}"
MVXSYSTEM="${MVXSYSTEM:-${MVX_HOME:+$MVX_HOME/build/system}}"
export MVX_DRIVERS MVXSYSTEM
CLIENT="$MV_PACKAGE_DIR"

[ -n "$MVX" ] || { echo "set \$MVX (or MVX_HOME) to an mvx binary" >&2; exit 1; }
[ -x "$MVX" ] || { echo "no mvx at '$MVX'" >&2; exit 1; }
[ -d "$MVX_DRIVERS" ] || { echo "no driver directory at '$MVX_DRIVERS'" >&2; exit 1; }
[ -d "$MVXSYSTEM" ] || { echo "no system account at '$MVXSYSTEM'" >&2; exit 1; }
[ -x "$CLIENT/build.sh" ] || { echo "mv_package client not found at $CLIENT" >&2; exit 1; }

# NODE IS REQUIRED, AND A MISSING ONE IS A FAILURE.  This used to `exit 0` --
# "node not found; skipping" -- which in CI is a green job that tested nothing,
# and by hand is an answer that looks like a pass.  Nothing here can run without
# node: it serves the fixtures, it is the registry, and it writes the index.
command -v node >/dev/null 2>&1 || { echo "node not found; it is required" >&2; exit 1; }

WORK="$(mktemp -d)"
REGDIR="$WORK/index"; mkdir -p "$REGDIR"             # the registry's package index
FILES="$WORK/files"; mkdir -p "$FILES"               # tarballs the file server hosts
export MVPKG_STORE="$WORK/store"                     # isolate the global store
cleanup() {
  { kill "$REGPID"; wait "$REGPID"; } 2>/dev/null
  { kill "$FSPID"; wait "$FSPID"; } 2>/dev/null
  rm -rf "$WORK" "$CLIENT/mvpkg.installed"
}
trap cleanup EXIT

# --- a static file server for the fixture tarballs (registry hosts nothing) ---
FSPORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
node -e '
  const http=require("http"),fs=require("fs"),path=require("path"),dir=process.argv[1],port=+process.argv[2];
  http.createServer((q,r)=>{const f=path.join(dir,path.basename(q.url));
    fs.readFile(f,(e,d)=>e?(r.writeHead(404),r.end()):(r.writeHead(200),r.end(d)));}).listen(port);
' "$FILES" "$FSPORT" &
FSPID=$!
BASE="http://127.0.0.1:$FSPORT"

# mkfixture <name> <version> <deps-space-separated|""> <provides|""> [extra-file]
# Builds an account-shaped tarball (PKG + BP/<NAME> + MARKER), serves it, and
# writes the registry index entry pointing at that tarball URL.
mkfixture() {
  nm="$1"; ver="$2"; deps="$3"; provs="$4"
  fx="$WORK/fx_$nm"; mkdir -p "$fx/BP"
  printf '%s\n%s\na throwaway fixture package\nmvx\n%s\n' "$nm" "$ver" "$deps" > "$fx/PKG"
  printf 'CRT "hello from %s"\n' "$nm" > "$fx/BP/$(echo "$nm" | tr a-z A-Z)"
  printf '%s-marker\n' "$nm" > "$fx/MARKER"
  ( cd "$fx" && tar -czf "$FILES/$nm.tar.gz" . )
  mkdir -p "$REGDIR/$nm"
  node -e '
    const fs=require("fs"),[dir,nm,ver,url,deps,provs]=process.argv.slice(1);
    fs.writeFileSync(dir+"/meta.json", JSON.stringify({
      name:nm, owner:"test", source:"http://example/"+nm, version:ver, tarball:url,
      dependencies:deps, provides:provs,
      artifacts:[{kind:"source",tarball:url,external:true}],
      versions:[{version:ver,tag:ver}], systems:["mvx"] }, null, 2));
  ' "$REGDIR/$nm" "$nm" "$ver" "$BASE/$nm.tar.gz" "$deps" "$provs"
}

# --- fixtures --------------------------------------------------------------
mkfixture demo    1.0 ""     ""            # a leaf package
mkfixture depdemo 1.0 "demo" ""            # depends on demo
mkfixture optdemo 1.0 "?ghost" ""          # optional dep on a package we never publish
mkfixture cursors 2.0 ""     "oldcurses"   # provides a virtual (renamed) name
mkfixture usescur 1.0 "oldcurses" ""       # depends on the virtual name

# --- registry + client -----------------------------------------------------
REGPORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
MVPKG_REGISTRY_DIR="$REGDIR" node "$ROOT/server.js" "$REGPORT" >"$WORK/reg.log" 2>&1 &
REGPID=$!
sleep 1
export MVPKG_REGISTRY="http://127.0.0.1:$REGPORT"
# Hand the client the SAME toolchain this script resolved, rather than
# MVX_HOME alone -- otherwise a release-based run builds the client against
# whatever `mvx` happens to be on PATH, or nothing.
MVX="$MVX" MVX_DRIVERS="$MVX_DRIVERS" MVXSYSTEM="$MVXSYSTEM" \
  "$CLIENT/build.sh" >/dev/null

# each install starts fresh (empty store + account manifest) so every package is
# genuinely downloaded/built/linked and prints "installed <name> <ver>".
inst() { rm -rf "$MVPKG_STORE"; rm -f "$CLIENT/mvpkg.installed"; MVXPRIV=unrestricted "$MVX" -a "$CLIENT" -c "MVPKG install $1" 2>&1; }
fail=0
say() { echo "FAIL: $1"; fail=1; }

# 1. install a leaf: downloaded, built, linked; recorded in the store + account
OUT="$(inst demo)"; echo "$OUT" | sed 's/^/  demo> /'
echo "$OUT" | grep -q "installed demo 1.0"      || say "leaf not installed"
[ -f "$MVPKG_STORE/demo/MARKER" ]                || say "leaf not unpacked to the store"
grep -qx demo "$CLIENT/mvpkg.installed" 2>/dev/null || say "leaf not recorded in the account"

# 2. a missing package reports cleanly and records nothing
OUT="$(inst nosuch)"
echo "$OUT" | grep -q "not found in registry"   || say "missing package not reported"

# 3. dependencies: depdemo pulls demo first, then itself
OUT="$(inst depdemo)"; echo "$OUT" | sed 's/^/  dep> /'
DL=$(echo "$OUT" | grep -n "installed demo 1.0"    | head -1 | cut -d: -f1)
PL=$(echo "$OUT" | grep -n "installed depdemo 1.0" | head -1 | cut -d: -f1)
{ [ -n "$DL" ] && [ -n "$PL" ] && [ "$DL" -lt "$PL" ]; } || say "dependency not installed before dependent"

# 4. an optional dependency that is not published is skipped, not fatal
OUT="$(inst optdemo)"; echo "$OUT" | sed 's/^/  opt> /'
echo "$OUT" | grep -qi "optional dependency .*ghost.* skipping" || say "optional dep not skipped"
echo "$OUT" | grep -q "installed optdemo 1.0"    || say "consumer of an optional dep not installed"

# 5. provides: depending on the old virtual name installs the provider (cursors)
OUT="$(inst usescur)"; echo "$OUT" | sed 's/^/  prov> /'
echo "$OUT" | grep -q "installed cursors 2.0"    || say "virtual name did not resolve to its provider"
echo "$OUT" | grep -q "installed usescur 1.0"    || say "consumer of a virtual dep not installed"

# 6. idempotent: re-installing with the manifest present fetches nothing
inst demo >/dev/null
OUT="$(MVXPRIV=unrestricted "$MVX" -a "$CLIENT" -c "MVPKG install demo" 2>&1)"
echo "$OUT" | grep -qi "fetching"                && say "re-fetched an already-installed package"

if [ "$fail" = 0 ]; then echo "PASS: end-to-end install loop"; else exit 1; fi
