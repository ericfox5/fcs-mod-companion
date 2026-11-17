#!/usr/bin/env bash
# Puts league data back from a backup made by backup.sh (or a state archive made by make-tarball.sh --state).
# Run as root:
#   sudo bash /opt/fcs-league/app/deploy/league-server/restore.sh /var/backups/fcs-league/fcs-league-20261115T091500Z.tar.gz
#
# It stops the services, moves the current data aside (kept as private.before-restore-<time>), unpacks the backup,
# and starts the services again. It does not touch the tokens or league.env.
set -euo pipefail

STATE_DIR=${FCS_STATE_DIR:-/var/lib/fcs-league}
# the users provision.sh creates: Blaze owns the data, the site sync owns the site-edits folder and its own home
U_BLAZE=${FCS_BLAZE_USER:-fcs-blaze}
U_SYNC=${FCS_SYNC_USER:-fcs-sync}
DATA_GROUP=${FCS_DATA_GROUP:-fcsleague}
ARCHIVE=${1:-}

[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo bash restore.sh BACKUP.tar.gz" >&2; exit 1; }
[ -n "$ARCHIVE" ] && [ -r "$ARCHIVE" ] || { echo "usage: sudo bash restore.sh BACKUP.tar.gz" >&2; exit 1; }
for u in "$U_BLAZE" "$U_SYNC"; do id "$u" >/dev/null 2>&1 || { echo "service user $u does not exist (run provision.sh first)" >&2; exit 1; }; done
gzip -t "$ARCHIVE"
# refuse anything that is not a plain league backup: only private/, .ncaa-bridge/ and league.env, no absolute or ../ paths
if tar -tzf "$ARCHIVE" | grep -Ev '^(\./)?$|^(\./)?(private(/|$)|\.ncaa-bridge(/|$)|league\.env$)' | grep -q .; then
  echo "that archive holds files that do not belong to a league backup; not restoring" >&2; exit 1
fi
if tar -tzf "$ARCHIVE" | grep -Eq '(^|/)\.\.(/|$)'; then echo "that archive has ../ paths; not restoring" >&2; exit 1; fi

echo "stopping the league services"
systemctl stop fcs-league.target fcs-league-redirector.service fcs-league-blaze.service fcs-league-qos.service fcs-league-sync.service 2>/dev/null || true

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "$STATE_DIR/restore.XXXXXX")
trap 'rm -rf "$work"' EXIT
tar -xzf "$ARCHIVE" -C "$work" --no-same-owner --no-same-permissions
[ -d "$work/private" ] || { echo "the archive has no private/ folder" >&2; exit 1; }

if [ -d "$STATE_DIR/private" ]; then mv "$STATE_DIR/private" "$STATE_DIR/private.before-restore-$stamp"; fi
mv "$work/private" "$STATE_DIR/private"
install -d -m 0700 -o "$U_SYNC" -g "$U_SYNC" "$STATE_DIR/sync"
if [ -d "$work/.ncaa-bridge" ]; then
  if [ -d "$STATE_DIR/sync/.ncaa-bridge" ]; then mv "$STATE_DIR/sync/.ncaa-bridge" "$STATE_DIR/sync/.ncaa-bridge.before-restore-$stamp"; fi
  mv "$work/.ncaa-bridge" "$STATE_DIR/sync/.ncaa-bridge"
  rm -f "$STATE_DIR/sync/.ncaa-bridge/config.json" # a PC's bridge config (it holds the token) has no place here
fi
# same owners and permissions as provision.sh sets: Blaze writes the data and the data group reads it; the site
# sync writes only web-edits and its own home; new files keep the data group (the setgid bit on folders)
mkdir -p "$STATE_DIR/private/web-edits"
chown -R "$U_BLAZE:$DATA_GROUP" "$STATE_DIR/private"
chown -R "$U_SYNC:$DATA_GROUP" "$STATE_DIR/private/web-edits"
chmod -R u=rwX,g=rX,o= "$STATE_DIR/private"
find "$STATE_DIR/private" -type d -exec chmod g+s {} +
if [ -f "$STATE_DIR/private/league-registry.json" ]; then chmod 0600 "$STATE_DIR/private/league-registry.json"; fi
chown -R "$U_SYNC:$U_SYNC" "$STATE_DIR/sync"; chmod -R u=rwX,go= "$STATE_DIR/sync"

echo "restored $ARCHIVE"
echo "the data from before is kept in $STATE_DIR/private.before-restore-$stamp (delete it once you are happy)"
echo "starting the league services"
systemctl start fcs-league.target
