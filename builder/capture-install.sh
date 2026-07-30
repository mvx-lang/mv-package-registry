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
echo "capturing $UDT (+ any from-source /usr/local/lib64/libgit2) from $TARGET ..."
# shellcheck disable=SC2029
ssh "$TARGET" "sudo tar czf - -C / '$REL' \$(cd / && ls usr/local/lib64/libgit2.so.*.* 2>/dev/null | tr '\n' ' ')" > ud83.tar.gz
echo "wrote ud83.tar.gz ($(du -h ud83.tar.gz | cut -f1))"
