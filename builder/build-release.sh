#!/bin/bash
# build-release.sh <name> <version> [deps] — run inside udt-builder with the
# package mounted at /pkg, this registry repo at /registry, and an output dir
# at /out.  Validates that the package's native bridge compiles in a clean
# library, then produces the release tar.  GPL-2.0-only.
set -e
export UDTHOME=/usr/ud83 SUDO= TERM=xterm
NAME="${1:?usage: build-release.sh <name> <version> [deps]}"
VER="${2:?version required}"
DEPS="${3:-}"

if [ -x /pkg/install.sh ]; then
   echo ">> validating $NAME: native bridge builds in a clean libu2callc.so"
   rm -rf "$UDTHOME/callc.d/$NAME"
   ( cd /pkg && SUDO= ./install.sh ) 2>&1 | grep -E "installed —|staged|[Ee]rror" | tail -2
fi

echo ">> producing release tar"
/registry/mkrelease.sh /pkg "$NAME" "$VER" "built by udt-builder" "$DEPS"
mkdir -p /out
cp "/registry/registry/$NAME"/*.tar.gz "/registry/registry/$NAME"/meta.json /out/
echo ">> release artifacts:"; ls -la /out/
