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
# Also pull the from-source libgit2 the git bridge links against: the runtime
# .so (needed by udt_curses and udt-git at run time) AND its development
# headers (usr/local/include/git2*), which udt-git's build-udt.sh compiles
# against.  Headers-plus-.so lets the image build udt-git from source, not just
# run a prebuilt bridge.  ls-in-a-subshell so a missing path is just skipped.
echo "capturing $UDT (+ any from-source libgit2 .so and headers) from $TARGET ..."
# shellcheck disable=SC2029
ssh "$TARGET" "sudo tar czf - -C / '$REL' \$(cd / && ls -d \
    usr/local/lib64/libgit2.so.*.* \
    usr/local/include/git2.h usr/local/include/git2 \
    2>/dev/null | tr '\n' ' ')" > ud83.tar.gz
echo "wrote ud83.tar.gz ($(du -h ud83.tar.gz | cut -f1))"
