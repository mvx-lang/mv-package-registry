#!/bin/sh
# mv-package-registry — end-to-end install-loop test.
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
#
#   MVX_HOME=/path/to/mvx-lang MV_PACKAGE_DIR=/path/to/mv_package ./test/run.sh
#
# Proves the whole loop across both repos: build the MVPKG client (from the
# mv_package checkout), register throwaway fixture packages, start this
# registry on a free port, then `MVPKG install` and assert what lands where —
# install, missing-package, dependencies (deps-first), and idempotency.
# Needs node and a built mvx-lang toolchain (http + json in its system account).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"                       # this registry repo
: "${MVX_HOME:?set MVX_HOME to your mvx-lang checkout (with a built toolchain)}"
: "${MV_PACKAGE_DIR:?set MV_PACKAGE_DIR to your mv_package (client) checkout}"
MVX="$MVX_HOME/build/bin/mvx"
CLIENT="$MV_PACKAGE_DIR"
[ -x "$MVX" ] || { echo "mvx not found under $MVX_HOME/build/bin" >&2; exit 1; }
[ -x "$CLIENT/build.sh" ] || { echo "mv_package client not found at $CLIENT" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node not found; skipping" >&2; exit 0; }
export MVX_DRIVERS="$MVX_HOME/build/lib"

WORK="$(mktemp -d)"
trap '{ kill "$REGPID" && wait "$REGPID"; } 2>/dev/null; rm -rf "$WORK" "$ROOT/registry/demo" "$ROOT/registry/depdemo" "$CLIENT/mvpkg.installed"' EXIT

# 1. build the client (in its own repo)
MVX_HOME="$MVX_HOME" "$CLIENT/build.sh" >/dev/null

# 2. a fixture "package": an account-shaped dir with a recognisable marker
FIX="$WORK/fixture"; mkdir -p "$FIX/BP"
printf 'CRT "hello from demo"\n' > "$FIX/BP/DEMO"
printf 'demo-marker\n' > "$FIX/MARKER"
"$ROOT/mkrelease.sh" "$FIX" demo 1.0 "a throwaway fixture package" >/dev/null

# 3. registry on an OS-chosen free port
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
node "$ROOT/server.js" "$PORT" >"$WORK/reg.log" 2>&1 &
REGPID=$!
sleep 1

export MVPKG_REGISTRY="http://127.0.0.1:$PORT"
DEST="$WORK/installed"

# 4. install and assert
MVXPRIV=unrestricted "$MVX" -a "$CLIENT" -c "MVPKG install demo $DEST" >"$WORK/out" 2>&1
cat "$WORK/out"

fail=0
grep -q "installed demo 1.0" "$WORK/out"   || { echo "FAIL: no install confirmation"; fail=1; }
[ -f "$DEST/MARKER" ]                       || { echo "FAIL: MARKER not installed"; fail=1; }
[ -f "$DEST/BP/DEMO" ]                       || { echo "FAIL: BP/DEMO not installed"; fail=1; }
grep -q demo-marker "$DEST/MARKER" 2>/dev/null || { echo "FAIL: MARKER content wrong"; fail=1; }

# 5. a missing package must report cleanly, not install anything
MISS="$WORK/miss"
MVXPRIV=unrestricted "$MVX" -a "$CLIENT" -c "MVPKG install nosuch $MISS" >"$WORK/miss.out" 2>&1
grep -q "not found in registry" "$WORK/miss.out" || { echo "FAIL: missing pkg not reported"; fail=1; }
[ -d "$MISS" ] && { echo "FAIL: missing pkg created a dest dir"; fail=1; }

# 6. dependencies: a package that depends on another installs both, deps first
FIX2="$WORK/fixture2"; mkdir -p "$FIX2/BP"
printf 'depdemo-marker\n' > "$FIX2/MARKER"
"$ROOT/mkrelease.sh" "$FIX2" depdemo 1.0 "depends on demo" "demo" >/dev/null
rm -f "$CLIENT/mvpkg.installed"          # fresh account: nothing installed yet
D2="$WORK/inst2"
( cd "$WORK" && MVXPRIV=unrestricted "$MVX" -a "$CLIENT" -c "MVPKG install depdemo $D2" ) >"$WORK/dep.out" 2>&1
cat "$WORK/dep.out"
grep -q "installed demo 1.0" "$WORK/dep.out"    || { echo "FAIL: dependency demo not installed"; fail=1; }
grep -q "installed depdemo 1.0" "$WORK/dep.out" || { echo "FAIL: depdemo not installed"; fail=1; }
[ -f "$D2/MARKER" ]                              || { echo "FAIL: depdemo not installed to dest"; fail=1; }
DL=$(grep -n "installed demo 1.0" "$WORK/dep.out" | head -1 | cut -d: -f1)
PL=$(grep -n "installed depdemo 1.0" "$WORK/dep.out" | head -1 | cut -d: -f1)
{ [ -n "$DL" ] && [ -n "$PL" ] && [ "$DL" -lt "$PL" ]; } || { echo "FAIL: dependency not installed before dependent"; fail=1; }
{ grep -qx demo "$CLIENT/mvpkg.installed" && grep -qx depdemo "$CLIENT/mvpkg.installed"; } 2>/dev/null || { echo "FAIL: manifest missing entries"; fail=1; }

# 7. idempotent: installing again with the manifest present is a no-op
( cd "$WORK" && MVXPRIV=unrestricted "$MVX" -a "$CLIENT" -c "MVPKG install depdemo $D2" ) >"$WORK/again.out" 2>&1
grep -q "fetching" "$WORK/again.out" && { echo "FAIL: reinstalled an already-installed package"; fail=1; }

if [ "$fail" = 0 ]; then echo "PASS: end-to-end install loop"; else exit 1; fi
