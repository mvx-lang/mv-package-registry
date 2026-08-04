#!/bin/sh
# mv-package-registry — build one package's UniData binary release tar.
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
#
# Runs on a self-hosted runner that has the licensed `udt-builder` image and the
# `udt-run` wrapper on PATH (from the setup-udt action).  The udt-build action
# carries this script so a caller in another repo needn't check the registry out.
#
#   VERSION=<version>  sh build-release.sh <package-name>   (else GITHUB_REF_NAME)
#
# Contract: the package repo (the current directory) provides `build-udt.sh`,
# which — run INSIDE the container at the repo root — stages its release tree
# (contents at the root, no wrapping dir) into the directory given as $1.  This
# script wraps that with the parts every package shares: the artifact key, the
# staged build (via udt-run), and the tar + checksum.
#
# It writes  <base>-<version>-udt-<os>-<arch>-<endian>.tar.gz  (+ .sha256) to
# the current directory — base = package name with '/'->'_', the key the
# registry's release webhook maps.  With $GITHUB_OUTPUT set it also emits
# `tarball=` / `checksum=` step outputs.
set -eu

PKG="${1:?usage: VERSION=<ver> build-release.sh <package-name>  (e.g. mvx-lang/git)}"
# The artifact version: VERSION when set (a cross-repo dispatch builds a tag that
# is NOT this run's ref), else the run's own tag.  GITHUB_* is a reserved env
# prefix an action step's `env:` cannot override, so the caller passes VERSION.
VER="${VERSION:-${GITHUB_REF_NAME:?set VERSION (or GITHUB_REF_NAME) to the version tag}}"

command -v udt-run >/dev/null 2>&1 || {
  echo "::error::udt-run not on PATH — run the setup-udt action first" >&2; exit 1; }
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

# Build + stage inside the licensed container (udt-run mounts . at /pkg and
# chowns anything root created back to the runner user).
udt-run 'rm -rf dist && mkdir -p dist && sh build-udt.sh /pkg/dist'
[ -d dist ] && [ -n "$(ls -A dist 2>/dev/null)" ] || {
  echo "::error::build-udt.sh produced no dist/ tree" >&2; exit 1; }

TARBALL="${BASE}.tar.gz"
tar czf "$TARBALL" -C dist .          # contents at the tar root (no wrapping dir)
sha256sum "$TARBALL" > "$TARBALL.sha256"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "tarball=$TARBALL"; echo "checksum=$TARBALL.sha256"; } >> "$GITHUB_OUTPUT"
fi
echo "$TARBALL"
