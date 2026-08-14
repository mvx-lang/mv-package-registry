#!/bin/sh
# mv-package-registry — build one package's UniData binary release tar.
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
#
# Runs on a self-hosted runner that has the licensed `udt-builder` image and the
# `udt-run` wrapper on PATH (from the setup-udt action).  The udt-build action
# carries this script so a caller in another repo needn't check the registry out.
#
#   GITHUB_REF_NAME=<version>  sh build-release.sh <package-name>
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

PKG="${1:?usage: GITHUB_REF_NAME=<ver> build-release.sh <package-name>  (e.g. mvx-lang/git)}"
VER="${GITHUB_REF_NAME:?set GITHUB_REF_NAME to the version tag}"

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

# Build dependencies: what this package needs PRESENT to be packaged at all —
# declared once in its own manifest ("devDependencies"; '+name' in PKG) rather
# than hardcoded into the shared builder.  mvpkg is the usual one: it provisions
# the account a build runs in (the shared PLATFORM.H, the Q-pointers), and the
# image pre-bakes it, so that entry is satisfied already and only reported.
# Anything else is installed into the container first.  Read with sed rather than
# jq, which the runner is not guaranteed to have: take the bracketed list after
# the key and pull out the quoted names.
DEVDEPS=""
if [ -f mvpkg.json ]; then
  DEVDEPS="$(tr -d '\n' < mvpkg.json \
    | sed -n 's/.*"devDependencies"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' \
    | tr ',' '\n' | sed -n 's/.*"\([^"]*\)".*/\1/p' | tr '\n' ' ')"
fi
[ -n "$DEVDEPS" ] && echo "build-release: build dependencies: $DEVDEPS"
export DEVDEPS

# Build + stage inside the licensed container (udt-run mounts . at /pkg and
# chowns anything root created back to the runner user).  The build deps are
# satisfied in the SAME container: udt-run starts a fresh `docker run --rm` per
# invocation, so anything installed in a separate one would be thrown away.
udt-run '
for d in '"$DEVDEPS"'; do
  case "$d" in
    */mvpkg|mvpkg) echo "build-release: build dep $d is pre-installed in the builder image" ;;
    *) echo "build-release: installing build dependency $d"
       ( cd /opt/mvpkg && printf "MVPKG install %s\nQUIT\n" "$d" | udt ) ;;
  esac
done
rm -rf dist && mkdir -p dist && sh build-udt.sh /pkg/dist'
[ -d dist ] && [ -n "$(ls -A dist 2>/dev/null)" ] || {
  echo "::error::build-udt.sh produced no dist/ tree" >&2; exit 1; }

TARBALL="${BASE}.tar.gz"
# If build-udt.sh staged a SINGLE top-level directory (an account-shaped package,
# e.g. git/), tar it BY NAME so entries are "<dir>/..." with no "./" prefix — the
# release unpacks to that named account dir, and MVPKG strips the one leading
# component on install.  Otherwise tar the contents at the root (legacy layout,
# "./..." entries, which MVPKG leaves unstripped).
n_top="$(ls -A dist | wc -l)"; one_top="$(ls -A dist | head -1)"
if [ "$n_top" -eq 1 ] && [ -d "dist/$one_top" ]; then
  tar czf "$TARBALL" -C dist "$one_top"
else
  tar czf "$TARBALL" -C dist .
fi
sha256sum "$TARBALL" > "$TARBALL.sha256"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "tarball=$TARBALL"; echo "checksum=$TARBALL.sha256"; } >> "$GITHUB_OUTPUT"
fi
echo "$TARBALL"
