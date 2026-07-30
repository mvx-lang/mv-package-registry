#!/bin/sh
# publish.sh <url> <tarball> <name> <version> [description] [deps] [systems] [artifact]
# Push a release tar to a running mv_package registry.  Metadata travels as
# X-Pkg-* headers (no URL-encoding).  <artifact> is "source" (default) or
# "binary:<system>:<os>:<arch>:<endian>" — os ("linux"/"windows"/"aix") and
# arch ("x86_64", ...) for native objects, or both "any" when the binary ships
# no native code; endian ("le"/"be") for the compiled BASIC objects + data
# files.  Set MVPKG_PUBLISH_TOKEN if the registry requires a token, and
# MVPKG_LICENSE for the SPDX licence (e.g. "GPL-2.0-only").  GPL-2.0-only.
#
# <tar> may be a local file (uploaded, registry-hosted) OR an http(s):// URL —
# in which case the registry only INDEXES that external location (a vendor
# site, a GitHub release asset) and no bytes are uploaded.  This is how a
# binary-only / commercial package is served without giving the registry its
# bytes.
set -e
URL="${1:?usage: publish.sh <url> <tar|http-url> <name> <version> [desc] [deps] [systems] [artifact]}"
TAR="${2:?tarball (file or http-url) required}"; NAME="${3:?name required}"; VER="${4:?version required}"
DESC="${5:-}"; DEPS="${6:-}"; SYS="${7:-}"; ART="${8:-}"
COMMON="-sf -X POST $URL/publish"
set -- \
  ${MVPKG_PUBLISH_TOKEN:+-H "X-Auth-Token: $MVPKG_PUBLISH_TOKEN"} \
  -H "X-Pkg-Name: $NAME" -H "X-Pkg-Version: $VER" \
  -H "X-Pkg-Description: $DESC" -H "X-Pkg-Dependencies: $DEPS" -H "X-Pkg-Systems: $SYS" \
  ${MVPKG_LICENSE:+-H "X-Pkg-License: $MVPKG_LICENSE"} \
  ${ART:+-H "X-Pkg-Artifact: $ART"}
case "$TAR" in
  http://*|https://*) curl $COMMON "$@" -H "X-Pkg-Url: $TAR" --data-binary '' ;;
  *)                  curl $COMMON "$@" --data-binary @"$TAR" ;;
esac
echo
