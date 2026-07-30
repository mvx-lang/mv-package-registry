#!/bin/sh
# publish.sh <registry-url> <tarball> <name> <version> [description] [deps] [systems]
# Push a release tar to a running mv_package registry.  Metadata travels as
# X-Pkg-* headers (no URL-encoding).  Set MVPKG_PUBLISH_TOKEN if the registry
# requires a token.  GPL-2.0-only.
set -e
URL="${1:?usage: publish.sh <registry-url> <tarball> <name> <version> [description] [deps] [systems]}"
TAR="${2:?tarball required}"; NAME="${3:?name required}"; VER="${4:?version required}"
DESC="${5:-}"; DEPS="${6:-}"; SYS="${7:-}"
curl -sf -X POST "$URL/publish" \
  ${MVPKG_PUBLISH_TOKEN:+-H "X-Auth-Token: $MVPKG_PUBLISH_TOKEN"} \
  -H "X-Pkg-Name: $NAME" -H "X-Pkg-Version: $VER" \
  -H "X-Pkg-Description: $DESC" -H "X-Pkg-Dependencies: $DEPS" -H "X-Pkg-Systems: $SYS" \
  --data-binary @"$TAR"
echo
