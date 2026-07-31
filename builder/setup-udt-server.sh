#!/bin/sh
# setup-udt-server.sh — turn a udt-builder container into a UniData *server*
# (UniObjects / UniRPC) so udt-git and other UniObjects clients can connect.
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
#
# The udt-builder image is built for *compiling* packages (it runs `udt`
# locally), so it ships without the UniObjects server layer: no Unishared, no
# unirpcservices, and unirpcd will not listen.  This script adds that layer —
# the UniRPC service map, a PAM service for the login, a login user, the
# libgit2 ownership guard — and starts unirpcd.  Idempotent; run as root inside
# the container.  Run the container with `docker run --init …` so unirpcd's
# children are reaped (otherwise the daemon will not stay up).
#
#   UDT_LOGIN_USER      login the client authenticates as (default: root)
#   UDT_LOGIN_PASSWORD  its password (required)
#
# Then connect with:
#   UDT_HOST=127.0.0.1 UDT_SERVICE=udcs UDT_USER=<user> UDT_PASSWORD=<pass>
set -e

: "${UDTHOME:=/usr/ud83}"
UDTBIN="$UDTHOME/bin"
US="$UDTHOME/unishared"
LOGIN_USER="${UDT_LOGIN_USER:-root}"
: "${UDT_LOGIN_PASSWORD:?set UDT_LOGIN_PASSWORD to the UniObjects login password}"

# 1) Unishared UniRPC config — the service map (udcs -> udapi_server).  The line
#    format is the one udtsetup writes: "<service> <exe> * TCP/IP 0 3600".
mkdir -p "$US/unirpc"
cp -f "$UDTBIN/unirpcd" "$US/unirpc/unirpcd"
cat > "$US/unirpc/unirpcservices" <<EOF
udcs     $UDTBIN/udapi_server * TCP/IP 0 3600
defcs    $UDTBIN/udapi_server * TCP/IP 0 3600
udserver $UDTBIN/udsrvd       * TCP/IP 0 3600
EOF
chmod 600 "$US/unirpc/unirpcservices"
echo "$US" > /.unishared
grep -q "[[:space:]]uvrpc" /etc/services 2>/dev/null || echo "uvrpc 31438/tcp" >> /etc/services

# 2) PAM service for the UniObjects login.  udapi_server authenticates via PAM
#    service "udcs"; without this file it falls through to /etc/pam.d/other,
#    which is pam_deny — the cause of session error 80011 (IE_BAD_LOGINNAME).
cat > /etc/pam.d/udcs <<'PAM'
#%PAM-1.0
auth     required pam_unix.so nullok
account  required pam_unix.so
password required pam_unix.so
session  required pam_unix.so
PAM

# 3) the login the client authenticates as
if [ "$LOGIN_USER" != root ]; then
  id "$LOGIN_USER" >/dev/null 2>&1 || useradd -m "$LOGIN_USER"
fi
printf '%s:%s\n' "$LOGIN_USER" "$UDT_LOGIN_PASSWORD" | chpasswd

# 4) libgit2 ownership guard — UniData accounts are often owned by the install
#    user, and libgit2 refuses a repo dir not owned by the caller.
printf '[safe]\n\tdirectory = *\n' > /etc/gitconfig

# 5) start SMM (if not already up) and unirpcd
if ! pgrep -x smm >/dev/null 2>&1; then
  yes | "$UDTBIN/startud" >/tmp/startud.log 2>&1 || true
  sleep 2
fi
pkill -9 unirpcd 2>/dev/null || true
sleep 1
setsid "$US/unirpc/unirpcd" >/tmp/unirpcd.log 2>&1 </dev/null
sleep 2

if pgrep -x unirpcd >/dev/null 2>&1; then
  echo "udt-server ready: unirpcd up, service udcs, login '$LOGIN_USER'"
  echo "connect: UDT_HOST=127.0.0.1 UDT_SERVICE=udcs UDT_USER=$LOGIN_USER UDT_PASSWORD=***"
else
  echo "setup-udt-server: unirpcd did not start — see /tmp/unirpcd.log" >&2
  exit 1
fi
