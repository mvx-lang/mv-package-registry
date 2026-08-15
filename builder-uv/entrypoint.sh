#!/bin/bash
# Start UniVerse (shared-memory manager + daemons) if not already up, then hand
# off to the requested command (a shell, a build, ...).
export UVHOME=/usr/uv
if ! pgrep -x uvsmm >/dev/null 2>&1; then
    "$UVHOME/bin/uv.rc" start >/tmp/startuv.log 2>&1 || true
fi
exec "$@"
