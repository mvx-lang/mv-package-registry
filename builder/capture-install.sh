#!/bin/sh
# capture-install.sh <ssh-target> [UDTHOME] — capture a licensed UniData
# install into ud83.tar.gz for the builder image.  Run from this docker/
# directory before `docker build`.  The tar is git-ignored: it holds Rocket
# UniData binaries, which are licensed and must not be committed or shared.
# For private, internal build use of your own licensed install only.
set -e
TARGET="${1:?usage: capture-install.sh user@host [UDTHOME]}"
UDT="${2:-/usr/ud83}"
REL=$(printf '%s' "$UDT" | sed 's#^/##')
# Capture ONLY the UniData install ($UDTHOME) — its InterCall headers and
# libuvic.a are what build-udt.sh needs.  libgit2 is no longer captured: the
# image installs EPEL's libgit2_1.7-devel (see Dockerfile), so udt-git links
# libgit2.so.1.7 and end users get the runtime with `dnf install libgit2_1.7`.
echo "capturing $UDT from $TARGET ..."
# shellcheck disable=SC2029
ssh "$TARGET" "sudo tar czf - -C / '$REL'" > ud83.tar.gz
echo "wrote ud83.tar.gz ($(du -h ud83.tar.gz | cut -f1))"
