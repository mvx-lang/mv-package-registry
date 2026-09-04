#!/bin/sh
# mv-package-registry — build one package's jBASE binary release tar.
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
#
# Runs on a self-hosted runner that has the licensed `jbase-builder` image and the
# `jbase-run` wrapper on PATH (from the setup-jbase action).  The jbase-build action
# carries this script so a caller in another repo needn't check the registry out.
#
#   GITHUB_REF_NAME=<version>  sh build-release.sh <package-name>
#
# Contract: the package repo (the current directory) provides `build-jbase.sh`,
# which — run INSIDE the container at the repo root — stages its release tree
# (contents at the root, no wrapping dir) into the directory given as $1.  This
# script wraps that with the parts every package shares: the artifact key, the
# staged build (via jbase-run), and the tar + checksum.
#
# It writes  <base>-<version>-jbase-<os>-<arch>-<endian>.tar.gz  (+ .sha256) to
# the current directory — base = package name with '/'->'_', the key the
# registry's release webhook maps.  With $GITHUB_OUTPUT set it also emits
# `tarball=` / `checksum=` step outputs.
set -eu

PKG="${1:?usage: GITHUB_REF_NAME=<ver> build-release.sh <package-name>  (e.g. mvx-lang/git)}"
VER="${GITHUB_REF_NAME:?set GITHUB_REF_NAME to the version tag}"

command -v jbase-run >/dev/null 2>&1 || {
  echo "::error::jbase-run not on PATH — run the setup-jbase action first" >&2; exit 1; }
[ -f build-jbase.sh ] || {
  echo "::error::$PKG has no build-jbase.sh — it must stage the release tree into \$1" >&2; exit 1; }

# Artifact key: native code is os+arch+endian-locked.  os = uname -s (linux);
# arch = uname -m; endian from a two-byte dump (0201 little, 0102 big).
# $ARTIFACT names the FILE when it should not be named after the package:
# mv_git ships as `mv_git-<ver>-…` while its package identity stays
# `mvx-lang/git`, which is what MVPKG installs by and what names callc.d
# (mv_git#101).  Unset — every other package — keeps the derivation.
BASE_NAME="${ARTIFACT:-$(printf '%s' "$PKG" | tr '/' '_')}"
ARCH="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; case "$OS" in *linux*) OS=linux ;; esac
case "$(printf '\1\2' | od -An -tx2 | tr -d ' \n')" in
  0201*) ENDIAN=le ;; 0102*) ENDIAN=be ;; *) ENDIAN=le ;;
esac
BASE="${BASE_NAME}-${VER}-jbase-${OS}-${ARCH}-${ENDIAN}"

# Build dependencies: what this package needs PRESENT to be packaged at all --
# declared once in its own manifest ("devDependencies"; '+name' in PKG) rather
# than hardcoded into the shared builder.  mvpkg is the usual one: it provisions
# the account a build runs in.  It is reported and the build carries on: a
# package whose jBASE build genuinely needs one fails in its own build-jbase.sh
# with a clear error, which names the package rather than the builder.
# Read with sed rather than jq, which the runner is not guaranteed to have.
DEVDEPS=""
if [ -f mvpkg.json ]; then
  DEVDEPS="$(tr -d '\n' < mvpkg.json \
    | sed -n 's/.*"devDependencies"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' \
    | tr ',' '\n' | sed -n 's/.*"\([^"]*\)".*/\1/p' | tr '\n' ' ')"
fi
[ -n "$DEVDEPS" ] && echo "build-release: build dependencies: $DEVDEPS"
export DEVDEPS

# Build + stage inside the licensed container (jbase-run mounts . at /pkg and
# chowns anything root created back to the runner user).  The build deps are
# satisfied in the SAME container: jbase-run starts a fresh `docker run --rm`
# per invocation, so anything installed in a separate one would be thrown away.
jbase-run '
for d in '"$DEVDEPS"'; do
  echo "build-release: build dependency $d declared; build-jbase.sh must provide it"
done
rm -rf dist && mkdir -p dist && sh build-jbase.sh /pkg/dist'
[ -d dist ] && [ -n "$(ls -A dist 2>/dev/null)" ] || {
  echo "::error::build-jbase.sh produced no dist/ tree" >&2; exit 1; }

TARBALL="${BASE}.tar.gz"
# If build-jbase.sh staged a SINGLE top-level directory (an account-shaped package,
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
