#!/bin/bash
# Start UniData (shared-memory manager + daemons) if not already up, then
# hand off to the requested command (a shell, a build, ...).
export UDTHOME=/usr/ud83
if ! pgrep -x smm >/dev/null 2>&1; then
    yes | "$UDTHOME/bin/startud" >/tmp/startud.log 2>&1 || true
fi
exec "$@"
