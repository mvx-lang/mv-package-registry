#!/bin/sh
# publish.sh <url> <tarball> <name> <version> [description] [deps] [systems] [artifact]
# Push a release tar to a running mv_package registry.  Metadata travels as
# X-Pkg-* headers (no URL-encoding).  <artifact> is "source" (default) or
# "binary:<system>:<os>:<arch>:<endian>" — os ("linux"/"windows"/"aix") and
# arch ("x86_64", ...) for native objects, or both "any" when the binary ships
# no native code; endian ("le"/"be") for the compiled BASIC objects + data
# files.  Set MVPKG_PUBLISH_TOKEN if the registry requires a token.
# GPL-2.0-only.
set -e
URL="${1:?usage: publish.sh <url> <tar> <name> <version> [desc] [deps] [systems] [artifact]}"
TAR="${2:?tarball required}"; NAME="${3:?name required}"; VER="${4:?version required}"
DESC="${5:-}"; DEPS="${6:-}"; SYS="${7:-}"; ART="${8:-}"
curl -sf -X POST "$URL/publish" \
  ${MVPKG_PUBLISH_TOKEN:+-H "X-Auth-Token: $MVPKG_PUBLISH_TOKEN"} \
  -H "X-Pkg-Name: $NAME" -H "X-Pkg-Version: $VER" \
  -H "X-Pkg-Description: $DESC" -H "X-Pkg-Dependencies: $DEPS" -H "X-Pkg-Systems: $SYS" \
  ${ART:+-H "X-Pkg-Artifact: $ART"} \
  --data-binary @"$TAR"
echo
