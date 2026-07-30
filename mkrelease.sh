#!/bin/sh
# mv_package — build a release tar from an account and register it.
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see ../LICENSE).
#
#   mkrelease.sh <account-dir> <name> <version> [description] [dependencies]
#
# Produces registry/<name>/<name>-<version>.tar.gz and its meta.json, so the
# registry serves it.  Whatever is in <account-dir> is shipped verbatim — a
# built (binary-only) account ships without source; a source account ships
# with it.  The client neither knows nor cares which.  <dependencies> is a
# space-separated list of package names the client installs first.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ACCT="${1:?usage: mkrelease.sh <account-dir> <name> <version> [description] [dependencies]}"
NAME="${2:?package name required}"
VER="${3:?version required}"
DESC="${4:-}"
DEPS="${5:-}"

[ -d "$ACCT" ] || { echo "mkrelease: no such account dir: $ACCT" >&2; exit 1; }

OUT="$HERE/registry/$NAME"
mkdir -p "$OUT"
TAR="$NAME-$VER.tar.gz"

# Ship the account contents, excluding git and derived build artifacts.
tar czf "$OUT/$TAR" \
  --exclude='.git' --exclude='.gitmodules' --exclude='docs' \
  -C "$ACCT" .

# Escape the description for JSON (quotes and backslashes only — enough here).
ESC=$(printf '%s' "$DESC" | sed 's/\\/\\\\/g; s/"/\\"/g')
DEP=$(printf '%s' "$DEPS" | sed 's/\\/\\\\/g; s/"/\\"/g')
cat > "$OUT/meta.json" <<EOF
{
  "name": "$NAME",
  "version": "$VER",
  "description": "$ESC",
  "dependencies": "$DEP",
  "tarball": "/tarball/$NAME/$TAR"
}
EOF

echo "registered $NAME $VER -> registry/$NAME/$TAR (deps: ${DEPS:-none})"
