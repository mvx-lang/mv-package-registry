#!/bin/sh
# mv-package-registry — drive the udt-builder container to build one package's
# UniData binary release tar.  Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
#
# Native UniData binaries can only be built on a licensed UniData install, so
# this runs on a self-hosted runner that has Docker and the `udt-builder` image
# (built from a captured licence — see ../../../builder/README.md).  The action
# `udt-build` carries this script so a caller in another repo needn't check the
# registry out.
#
#   GITHUB_REF_NAME=<version>  sh build-release.sh <package-name>
#
# Contract: the package repo (the current directory) provides `build-udt.sh`,
# which — run INSIDE the container at the repo root — stages the release tree
# (contents at the root, no wrapping dir) into the directory given as $1.  This
# script wraps that with the parts every package shares: the image check, the
# artifact key, running the container, and the tar + checksum.
#
# It writes  <base>-<version>-udt-<os>-<arch>-<endian>.tar.gz  (+ .sha256) to
# the current directory — base = package name with '/'->'_', the key the
# registry's release webhook maps.  With $GITHUB_OUTPUT set it also emits
# `tarball=` / `checksum=` step outputs.
set -eu

PKG="${1:?usage: GITHUB_REF_NAME=<ver> build-release.sh <package-name>  (e.g. mvx-lang/git)}"
VER="${GITHUB_REF_NAME:?set GITHUB_REF_NAME to the version tag}"
IMAGE="${UDT_BUILDER_IMAGE:-udt-builder:8.3.2}"

command -v docker >/dev/null 2>&1 || { echo "::error::docker not found on this runner" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "::error::udt-builder image '$IMAGE' not on this runner (see mv-package-registry/builder/README.md)" >&2; exit 1; }
[ -f build-udt.sh ] || {
  echo "::error::$PKG has no build-udt.sh — it must stage the release tree into \$1" >&2; exit 1; }

# Artifact key: native code is os+arch+endian-locked.  os = uname -s (linux);
# arch = uname -m; endian from a two-byte dump (0201 little, 0102 big).
BASE_NAME="$(printf '%s' "$PKG" | tr '/' '_')"
ARCH="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; case "$OS" in *linux*) OS=linux ;; esac
case "$(printf '\1\2' | od -An -tx2 | tr -d ' \n')" in
  0201*) ENDIAN=le ;; 0102*) ENDIAN=be ;; *) ENDIAN=le ;;
esac
BASE="${BASE_NAME}-${VER}-udt-${OS}-${ARCH}-${ENDIAN}"

# Build + stage inside the container.  The container runs as root, so a
# root-owned dist/ left in the mounted workspace would block the runner's next
# checkout — chown it back to the runner user.  --hostname unidata matches the
# captured install (belt and braces against any host binding in the licence).
docker run --rm --hostname unidata \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e GITHUB_REF_NAME="$VER" \
  -v "$PWD":/pkg -w /pkg "$IMAGE" bash -lc '
    set -e
    rm -rf dist && mkdir -p dist
    sh build-udt.sh "$(pwd)/dist"
    chown -R "$HOST_UID:$HOST_GID" dist
  '
[ -d dist ] && [ -n "$(ls -A dist 2>/dev/null)" ] || {
  echo "::error::build-udt.sh produced no dist/ tree" >&2; exit 1; }

TARBALL="${BASE}.tar.gz"
tar czf "$TARBALL" -C dist .          # contents at the tar root (no wrapping dir)
sha256sum "$TARBALL" > "$TARBALL.sha256"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "tarball=$TARBALL"; echo "checksum=$TARBALL.sha256"; } >> "$GITHUB_OUTPUT"
fi
echo "$TARBALL"
