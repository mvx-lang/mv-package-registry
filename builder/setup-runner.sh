#!/bin/sh
# setup-runner.sh — install + register a GitHub Actions self-hosted runner for
# the mvx-lang org on THIS RedHat/Rocky host (the UniData binary builder).
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
#
# This runner runs the udt-builder *container*, so the host only needs Docker +
# the udt-builder image already present (it does not build the image).  Run as a
# user that can `sudo` (the runner installs a systemd service) and is in the
# `docker` group.
#
# Get a short-lived registration token from the org first, either:
#   - github.com/organizations/mvx-lang/settings/actions/runners/new, or
#   - gh api -X POST orgs/mvx-lang/actions/runners/registration-token --jq .token
# (needs org-admin / the runners fine-grained permission).  Then:
#
#   ./setup-runner.sh <registration-token> [labels] [runner-name]
#
# Labels default to "udt,linux" so `runs-on: [self-hosted, linux, udt]` lands
# here.  The runner self-updates after registration, so the pinned version only
# needs to be recent.
set -e

TOKEN="${1:?usage: setup-runner.sh <registration-token> [labels] [name]}"
LABELS="${2:-udt,linux}"
NAME="${3:-$(hostname -s)-udt}"
ORG_URL="https://github.com/mvx-lang"

# Pinned runner (self-updates later); sha256 verifies the initial download.
VER="2.336.0"
case "$(uname -m)" in
  x86_64)        RARCH=x64;   SHA="04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d" ;;
  aarch64|arm64) RARCH=arm64; SHA="" ;;   # set the arm64 sha from the release if you use ARM
  *) echo "setup-runner: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
TARBALL="actions-runner-linux-$RARCH-$VER.tar.gz"

command -v docker >/dev/null 2>&1 || {
  echo "setup-runner: docker not found — this runner runs the udt-builder container." >&2; exit 1; }

DIR="${RUNNER_DIR:-$HOME/actions-runner-mvx}"
mkdir -p "$DIR"; cd "$DIR"

if [ ! -f "$TARBALL" ]; then
  echo ">> downloading runner $VER ($RARCH)"
  curl -fsSL -o "$TARBALL" "https://github.com/actions/runner/releases/download/v$VER/$TARBALL"
fi
if [ -n "$SHA" ]; then
  echo "$SHA  $TARBALL" | sha256sum -c -
else
  echo ">> WARNING: no pinned sha for $RARCH — skipping checksum verification" >&2
fi
tar xzf "$TARBALL"

# RedHat/Rocky runtime deps for the runner host (.NET); harmless if present.
sudo ./bin/installdependencies.sh || true

# Register (org-level).  --replace lets a rerun re-register the same name.
./config.sh --unattended --replace \
  --url "$ORG_URL" --token "$TOKEN" \
  --name "$NAME" --labels "$LABELS" --work _work

# Run as a systemd service so it survives reboots.
sudo ./svc.sh install
sudo ./svc.sh start

echo ">> runner '$NAME' registered to $ORG_URL  labels: $LABELS"
echo ">> confirm: github.com/organizations/mvx-lang/settings/actions/runners"
echo ">> the runner user must be in the 'docker' group to run the builder container."
