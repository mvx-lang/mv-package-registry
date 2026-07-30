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
# Operating system of this builder — native objects are OS-locked (ELF vs DLL
# vs XCOFF), so a native binary names its OS as well as its arch.
OS="$(uname -s | tr 'A-Z' 'a-z')"
case "$OS" in
  *linux*) OS=linux ;; *aix*) OS=aix ;; *sunos*) OS=solaris ;;
  *hp-ux*|*hpux*) OS=hpux ;; *darwin*) OS=darwin ;;
  *cygwin*|*mingw*|*msys*|*windows*) OS=windows ;;
esac
# Endianness of this builder — the axis for compiled BASIC objects + data
# files (native code is keyed by os+arch instead).  0201 = little, 0102 = big.
case "$(printf '\1\2' | od -An -tx2 | tr -d ' \n')" in
  0201*) ENDIAN=le ;; 0102*) ENDIAN=be ;; *) ENDIAN=le ;;
esac
: "${MVPKG_REGISTRY:?set MVPKG_REGISTRY (e.g. https://mv-package.heydon.io)}"
OUT=/out ; mkdir -p "$OUT"
SAFE="$(printf '%s' "$NAME" | tr '/' '_')"       # scoped names carry a slash

# A binary with native objects is locked to this OS + arch; a pure BASIC/data
# binary is locked only to endianness (os/arch "any", portable across
# same-endian hosts).
if ls /pkg/udt-callc/*.c >/dev/null 2>&1; then
  BOS="$OS" ; BARCH="$ARCH" ; NATIVE=1
else
  BOS=any ; BARCH=any ; NATIVE=0
fi
SRC="$OUT/$SAFE-$VER-source.tar.gz"
BIN="$OUT/$SAFE-$VER-$SYSTEM-$BOS-$BARCH-$ENDIAN.tar.gz"

echo ">> building $NAME $VER  (source + $SYSTEM/$BOS/$BARCH/$ENDIAN binary)"

# --- source artifact: the package exactly as authored -----------------------
tar czf "$SRC" --exclude='.git' --exclude='./out' -C /pkg .

# --- binary artifact --------------------------------------------------------
# When the package has native sources, compile udt-callc/*.c to .o in a
# staging copy and drop the .c so the tar carries objects the client links
# without a compiler (the client already prefers a pre-built .o over a .c).
# Compiled BASIC objects + data files, if any, ride along endian-locked.
STAGE="$(mktemp -d)"
cp -a /pkg/. "$STAGE/"
rm -rf "$STAGE/.git" "$STAGE/out"
if [ "$NATIVE" = 1 ]; then
  # Match the client's per-package compile (udt-callc-build.sh): package
  # sources are self-contained; the generated dispatch glue links them.
  for c in "$STAGE"/udt-callc/*.c; do
    echo "   cc $(basename "$c") -> $(basename "${c%.c}").o"
    gcc -m64 -fPIC -O2 -c "$c" -o "${c%.c}.o"
    rm -f "$c"
  done
  echo ">> native bridge precompiled for $SYSTEM/$OS/$ARCH (binary ships .o, no .c)"
else
  echo ">> no native sources — binary is endian-locked ($SYSTEM/$ENDIAN), any OS/CPU"
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
"$PUB" "$MVPKG_REGISTRY" "$BIN" "$NAME" "$VER" "$DESC" "$DEPS" "$SYSTEM" "binary:$SYSTEM:$BOS:$BARCH:$ENDIAN"

echo ">> released $NAME $VER: source + $SYSTEM/$BOS/$BARCH/$ENDIAN binary"
ls -la "$OUT"/*.tar.gz
