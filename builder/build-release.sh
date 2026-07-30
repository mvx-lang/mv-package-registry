#!/bin/bash
# build-release.sh <name> <version> [deps] [description] — run inside udt-builder
# with the package mounted at /pkg, this registry repo at /registry, and an
# output dir at /out.  Produces and publishes TWO artifacts for the release:
#
#   source               the package as-is (portable; the client builds it)
#   binary:<sys>:<arch>  the package with its native bridge precompiled to .o
#                        for this builder's system + architecture
#
# System defaults to "udt" (override with MVPKG_SYSTEM); architecture is
# $(uname -m) — x86_64 on an Intel builder, aarch64 on an ARM builder.  Both
# artifacts are pushed to $MVPKG_REGISTRY (set MVPKG_PUBLISH_TOKEN if it is
# token-gated).  GPL-2.0-only.  Copyright (C) 2026 Gordon Heydon.
set -e
export UDTHOME=/usr/ud83 SUDO= TERM=xterm
NAME="${1:?usage: build-release.sh <name> <version> [deps] [description]}"
VER="${2:?version required}"
DEPS="${3:-}"
DESC="${4:-built by udt-builder}"
SYSTEM="${MVPKG_SYSTEM:-udt}"
ARCH="$(uname -m)"
: "${MVPKG_REGISTRY:?set MVPKG_REGISTRY (e.g. https://mv-package.heydon.io)}"
OUT=/out ; mkdir -p "$OUT"
SAFE="$(printf '%s' "$NAME" | tr '/' '_')"       # scoped names carry a slash
SRC="$OUT/$SAFE-$VER-source.tar.gz"
BIN="$OUT/$SAFE-$VER-$SYSTEM-$ARCH.tar.gz"

echo ">> building $NAME $VER  (source + $SYSTEM/$ARCH binary)"

# --- source artifact: the package exactly as authored -----------------------
tar czf "$SRC" --exclude='.git' --exclude='./out' -C /pkg .

# --- binary artifact: native bridge precompiled for this system/arch --------
# Compile udt-callc/*.c to .o in a staging copy, then drop the .c so the
# shipped tar carries objects the client links without a compiler.
STAGE="$(mktemp -d)"
cp -a /pkg/. "$STAGE/"
rm -rf "$STAGE/.git" "$STAGE/out"
if ls "$STAGE"/udt-callc/*.c >/dev/null 2>&1; then
  # Match the client's per-package compile (udt-callc-build.sh): package
  # sources are self-contained; the generated dispatch glue links them.  The
  # client already prefers a pre-built .o over a .c ("binary-only release").
  for c in "$STAGE"/udt-callc/*.c; do
    echo "   cc $(basename "$c") -> $(basename "${c%.c}").o"
    gcc -m64 -fPIC -O2 -c "$c" -o "${c%.c}.o"
    rm -f "$c"
  done
  echo ">> native bridge precompiled for $SYSTEM/$ARCH (binary ships .o, no .c)"
else
  echo ">> no udt-callc/*.c in this package — binary tar mirrors source"
fi
tar czf "$BIN" --exclude='.git' -C "$STAGE" .
rm -rf "$STAGE"

# --- validate the source build actually links a clean library ---------------
if [ -x /pkg/install.sh ]; then
  echo ">> validating: native bridge builds in a fresh libu2callc.so"
  ( cd /pkg && SUDO= ./install.sh ) 2>&1 | grep -E "installed —|staged|[Ee]rror" | tail -2 || true
fi

# --- publish both artifacts against the same version ------------------------
PUB=/registry/publish.sh
echo ">> publishing to $MVPKG_REGISTRY"
"$PUB" "$MVPKG_REGISTRY" "$SRC" "$NAME" "$VER" "$DESC" "$DEPS" "$SYSTEM" "source"
"$PUB" "$MVPKG_REGISTRY" "$BIN" "$NAME" "$VER" "$DESC" "$DEPS" "$SYSTEM" "binary:$SYSTEM:$ARCH"

echo ">> released $NAME $VER: source + $SYSTEM/$ARCH binary"
ls -la "$OUT"/*.tar.gz
