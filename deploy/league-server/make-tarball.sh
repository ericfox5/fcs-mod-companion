#!/usr/bin/env bash
# Run on your PC (Git Bash), from anywhere inside the repository. Makes the archive provision.sh installs.
#
#   bash deploy/league-server/make-tarball.sh            -> fcs-league.tar.gz in the repository's parent folder
#   bash deploy/league-server/make-tarball.sh --state    -> also fcs-league-state.tar.gz: the league data on this PC
#                                                           (dynasties, uploaded saves), for restore.sh on the server
#
# The app archive holds the committed code only (git archive HEAD): nothing from spike/blaze/private, no tokens.
# If spike/blaze/server/certs has the redirector certificate that already works with your consoles, it is added so the
# server presents the same one.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
OUT_DIR=$(dirname "$ROOT")
STATE=0
for a in "$@"; do case "$a" in --state) STATE=1 ;; --out) : ;; *) [ -d "$a" ] && OUT_DIR=$a ;; esac; done

if [ -n "$(git status --porcelain -- spike/blaze/server bridge packages deploy package.json package-lock.json)" ]; then
  echo "WARNING: there are uncommitted changes in the server code. The archive holds the last COMMIT only." >&2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git archive --format=tar HEAD | tar -xf - -C "$work"
rm -rf "$work/worker/public" "$work/archive" "$work/fixtures" "$work/installer" # not needed on the server
if [ -f spike/blaze/server/certs/gosredirector_mod.crt ] && [ -f spike/blaze/server/certs/gosredirector.key.pem ]; then
  mkdir -p "$work/deploy/league-server/certs"
  cp spike/blaze/server/certs/gosredirector_mod.crt spike/blaze/server/certs/gosredirector.key.pem "$work/deploy/league-server/certs/"
  echo "included the redirector certificate from this PC"
else
  echo "no redirector certificate on this PC: the server will generate its own"
fi
tar -czf "$OUT_DIR/fcs-league.tar.gz" -C "$work" .
echo "app archive:   $OUT_DIR/fcs-league.tar.gz ($(du -h "$OUT_DIR/fcs-league.tar.gz" | cut -f1), commit $(git rev-parse --short HEAD))"

if [ "$STATE" -eq 1 ]; then
  PRIV=spike/blaze/private
  [ -f "$PRIV/dynasties.json" ] || { echo "no league data in $PRIV" >&2; exit 1; }
  stage=$(mktemp -d); mkdir -p "$stage/private"
  for item in dynasties.json usersettings.json locker dynasty-tables dynasty-member-tables game-data web-edits xms; do
    [ -e "$PRIV/$item" ] && cp -r "$PRIV/$item" "$stage/private/"
  done
  rm -rf "$stage/private/locker/trash" "$stage/private/xms/raw"
  if [ -f "$HOME/.ncaa-bridge/od-state.json" ]; then mkdir -p "$stage/.ncaa-bridge"; cp "$HOME/.ncaa-bridge/od-state.json" "$stage/.ncaa-bridge/"; fi # sync state only, never config.json (the token)
  tar -czf "$OUT_DIR/fcs-league-state.tar.gz" -C "$stage" .
  rm -rf "$stage"
  echo "league data:   $OUT_DIR/fcs-league-state.tar.gz ($(du -h "$OUT_DIR/fcs-league-state.tar.gz" | cut -f1))"
  echo "Stop the league on this PC before you make this archive and keep it stopped, or the two copies drift apart."
fi
