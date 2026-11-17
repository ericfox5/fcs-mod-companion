#!/usr/bin/env bash
# Daily backup of the league data, with rotation, and an optional encrypted copy in off-site storage.
# Run by fcs-league-backup.timer as root; fine to run by hand:
#   sudo /opt/fcs-league/app/deploy/league-server/backup.sh
#
# What is saved: the league data folder (dynasties, uploaded saves, tables, cached registry), the site sync's state,
#   and league.env. NOT saved: the tokens (bridge.env, registry.env), the off-site settings (offsite.env), debug
#   captures, trash.
# Where: /var/backups/fcs-league/fcs-league-<UTC time>.tar.gz (root only). The newest KEEP files are kept (default 14).
# These backups are on the same disk as the server. The off-site copy is what survives losing the server.
#
# Off-site copy (OFF unless /etc/fcs-league/offsite.env exists and says FCS_OFFSITE=on; see offsite.env.example):
#   the newest archive is encrypted with gpg (AES-256, your passphrase) and uploaded with rclone to S3-compatible
#   storage such as a Cloudflare R2 bucket. Only the encrypted file ever leaves the server.
#
#   backup.sh                          make a backup; then upload it if the off-site copy is on
#   backup.sh --local-only             make a backup, never touch the network (what the daily timer runs)
#   backup.sh --offsite                upload the newest existing backup (what runs right after the daily backup)
#   backup.sh --offsite-check          prove the settings work: upload, download and decrypt a small test file
#   backup.sh --offsite-list           list the backups in off-site storage
#   backup.sh --offsite-fetch NAME     download and decrypt one of them (NAME from the list, or "latest") into
#                                      /var/backups/fcs-league/restored/, ready for restore.sh
set -euo pipefail

STATE_DIR=${FCS_STATE_DIR:-/var/lib/fcs-league}
ETC_DIR=${FCS_ETC_DIR:-/etc/fcs-league}
BACKUP_DIR=${FCS_BACKUP_DIR:-/var/backups/fcs-league}
KEEP=${FCS_BACKUP_KEEP:-14}
OFFSITE_ENV=${FCS_OFFSITE_ENV:-$ETC_DIR/offsite.env}
REMOTE=fcsoffsite
NAME_RE='^fcs-league-[0-9]{8}T[0-9]{6}Z\.tar\.gz$'

MODE=backup
FETCH_NAME=""
case "${1:-}" in
  "")               MODE=backup ;;
  --local-only)     MODE=local ;;
  --offsite)        MODE=offsite ;;
  --offsite-check)  MODE=check ;;
  --offsite-list)   MODE=list ;;
  --offsite-fetch)  MODE=fetch; FETCH_NAME=${2:-}; [ -n "$FETCH_NAME" ] || { echo "usage: backup.sh --offsite-fetch NAME|latest" >&2; exit 1; } ;;
  -h|--help)        sed -n '2,21p' "$0"; exit 0 ;;
  *)                echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
esac

case "$KEEP" in ''|*[!0-9]*) echo "FCS_BACKUP_KEEP must be a number" >&2; exit 1 ;; esac
[ "$KEEP" -ge 1 ] || { echo "FCS_BACKUP_KEEP must be at least 1" >&2; exit 1; }
umask 077

WORK=""
cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    [ -d "$WORK/gnupg" ] && gpgconf --homedir "$WORK/gnupg" --kill gpg-agent >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  [ -n "${tmp:-}" ] && rm -f "$tmp"
  return 0
}
trap cleanup EXIT

# ---- the local backup ----------------------------------------------------------------------------------------------
make_backup() {
  [ -d "$STATE_DIR/private" ] || { echo "no league data at $STATE_DIR/private" >&2; exit 1; }
  mkdir -p "$BACKUP_DIR"
  local stamp out items status last need have
  # Do not fill the disk the server writes to: a backup needs about as much room as the last one took.
  last=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fcs-league-*.tar.gz' -printf '%T@ %s
' | sort -rn | head -n 1 | cut -d' ' -f2)
  need=$(( ${last:-0} + ${last:-0} / 4 + 67108864 ))
  have=$(df --output=avail -B1 "$BACKUP_DIR" | tail -n 1 | tr -d ' ')
  [ "$have" -ge "$need" ] || { echo "backup NOT made: only $((have / 1048576)) MB free in $BACKUP_DIR, about $((need / 1048576)) MB needed. Free space (older backups can be deleted) or use a bigger disk." >&2; exit 1; }
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  out="$BACKUP_DIR/fcs-league-$stamp.tar.gz"
  tmp="$out.partial"

  items=(-C "$STATE_DIR" private)
  # the site sync's progress file: in its own home (sync/), or beside the data on an older install
  if [ -d "$STATE_DIR/sync/.ncaa-bridge" ]; then items+=(-C "$STATE_DIR/sync" .ncaa-bridge)
  elif [ -d "$STATE_DIR/.ncaa-bridge" ]; then items+=(-C "$STATE_DIR" .ncaa-bridge); fi
  [ -f "$ETC_DIR/league.env" ] && items+=(-C "$ETC_DIR" league.env)

  # The server keeps running, so a file can change while it is read: tar reports that with exit status 1, which is
  # fine (the server writes each file in one step: temp file, then rename). Anything above 1 is a real failure.
  set +e
  tar -czf "$tmp" \
    --exclude='private/capture-*.jsonl' --exclude='private/locker/trash' --exclude='private/xms/raw' \
    --exclude='*.tmp' --exclude='*.damaged' \
    --warning=no-file-changed --warning=no-file-removed \
    "${items[@]}"
  status=$?
  set -e
  [ "$status" -le 1 ] || { echo "backup failed (tar exit $status)" >&2; exit "$status"; }
  gzip -t "$tmp"
  mv "$tmp" "$out"
  tmp=""
  echo "backup written: $out ($(du -h "$out" | cut -f1))"

  # rotation: keep the newest $KEEP
  local all old
  mapfile -t all < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fcs-league-*.tar.gz' -printf '%f\n' | sort -r)
  if [ "${#all[@]}" -gt "$KEEP" ]; then
    for old in "${all[@]:$KEEP}"; do
      rm -f -- "$BACKUP_DIR/$old"
      echo "removed old backup: $old"
    done
  fi
}

# ---- off-site settings ---------------------------------------------------------------------------------------------
# Read from the root-only file, never from the command line. Only the names below are taken; the file is not run.
OFFSITE=off ENDPOINT="" BUCKET="" PREFIX="league-server" KEY_ID="" SECRET="" REGION="auto" PROVIDER="Cloudflare" PASSPHRASE="" KEEP_DAYS=30
load_offsite() {
  [ -f "$OFFSITE_ENV" ] || return 0
  local perms line name value
  # owned by whoever runs this (root on the server) and closed to everyone else
  perms=$(stat -c '%a %u' "$OFFSITE_ENV")
  case "$perms" in
    "600 $(id -u)"|"400 $(id -u)") ;;
    *) echo "$OFFSITE_ENV must be readable by root only (it holds the storage key and the passphrase). Fix it with:" >&2
       echo "  sudo chown root:root $OFFSITE_ENV && sudo chmod 600 $OFFSITE_ENV" >&2; exit 1 ;;
  esac
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in ''|'#'*) continue ;; esac
    name=${line%%=*}; value=${line#*=}
    [ "$name" != "$line" ] || continue
    case "$value" in \"*\") value=${value#\"}; value=${value%\"} ;; \'*\') value=${value#\'}; value=${value%\'} ;; esac
    case "$name" in
      FCS_OFFSITE)                    OFFSITE=$value ;;
      FCS_OFFSITE_ENDPOINT)           ENDPOINT=$value ;;
      FCS_OFFSITE_BUCKET)             BUCKET=$value ;;
      FCS_OFFSITE_PREFIX)             PREFIX=$value ;;
      FCS_OFFSITE_ACCESS_KEY_ID)      KEY_ID=$value ;;
      FCS_OFFSITE_SECRET_ACCESS_KEY)  SECRET=$value ;;
      FCS_OFFSITE_REGION)             REGION=$value ;;
      FCS_OFFSITE_PROVIDER)           PROVIDER=$value ;;
      FCS_OFFSITE_PASSPHRASE)         PASSPHRASE=$value ;;
      FCS_OFFSITE_KEEP_DAYS)          KEEP_DAYS=$value ;;
    esac
  done < "$OFFSITE_ENV"
}
offsite_on() { case "$OFFSITE" in on|ON|On|1|true|yes) return 0 ;; *) return 1 ;; esac; }

need_offsite() {
  offsite_on || { echo "the off-site copy is off. To turn it on, see \"Off-site backups\" in the README ($OFFSITE_ENV, FCS_OFFSITE=on)." >&2; exit 1; }
  local missing=""
  [ -n "$ENDPOINT" ] || missing="$missing FCS_OFFSITE_ENDPOINT"
  [ -n "$BUCKET" ] || missing="$missing FCS_OFFSITE_BUCKET"
  [ -n "$KEY_ID" ] || missing="$missing FCS_OFFSITE_ACCESS_KEY_ID"
  [ -n "$SECRET" ] || missing="$missing FCS_OFFSITE_SECRET_ACCESS_KEY"
  [ -n "$PASSPHRASE" ] || missing="$missing FCS_OFFSITE_PASSPHRASE"
  [ -z "$missing" ] || { echo "off-site copy: these settings are empty in $OFFSITE_ENV:$missing" >&2; exit 1; }
  case "$ENDPOINT" in https://*) ;; *) echo "off-site copy: FCS_OFFSITE_ENDPOINT must start with https://" >&2; exit 1 ;; esac
  case "$BUCKET" in *[!a-z0-9.-]*) echo "off-site copy: FCS_OFFSITE_BUCKET has unexpected characters (lowercase letters, digits, - and . only)" >&2; exit 1 ;; esac
  case "$PREFIX" in ""|/*|*/|*..*|*[!A-Za-z0-9._/-]*) echo "off-site copy: FCS_OFFSITE_PREFIX must be a plain folder name such as league-server" >&2; exit 1 ;; esac
  case "$KEEP_DAYS" in ''|*[!0-9]*) echo "off-site copy: FCS_OFFSITE_KEEP_DAYS must be a number (0 = never delete)" >&2; exit 1 ;; esac
  [ "${#PASSPHRASE}" -ge 20 ] || { echo "off-site copy: FCS_OFFSITE_PASSPHRASE is too short (use at least 20 characters; openssl rand -base64 32 makes a good one)" >&2; exit 1; }
  case "$PASSPHRASE$ENDPOINT$KEY_ID$SECRET" in *paste-*) echo "off-site copy: $OFFSITE_ENV still has example text (paste-...) in it; fill in the real values" >&2; exit 1 ;; esac
  command -v gpg >/dev/null 2>&1 || { echo "off-site copy: gpg is not installed (sudo apt-get install -y gnupg)" >&2; exit 1; }
  command -v rclone >/dev/null 2>&1 || { echo "off-site copy: rclone is not installed (sudo apt-get install -y rclone)" >&2; exit 1; }
  mkdir -p "$BACKUP_DIR"
  WORK=$(mktemp -d "$BACKUP_DIR/.offsite.XXXXXX")
  mkdir -m 700 "$WORK/gnupg"
  # rclone takes the storage account from the environment: no config file, nothing on a command line
  export RCLONE_CONFIG="$WORK/rclone.conf"
  export RCLONE_CONFIG_FCSOFFSITE_TYPE=s3
  export RCLONE_CONFIG_FCSOFFSITE_PROVIDER="$PROVIDER"
  export RCLONE_CONFIG_FCSOFFSITE_ENDPOINT="$ENDPOINT"
  export RCLONE_CONFIG_FCSOFFSITE_REGION="$REGION"
  export RCLONE_CONFIG_FCSOFFSITE_ACCESS_KEY_ID="$KEY_ID"
  export RCLONE_CONFIG_FCSOFFSITE_SECRET_ACCESS_KEY="$SECRET"
  export RCLONE_CONFIG_FCSOFFSITE_ACL=private
  export RCLONE_CONFIG_FCSOFFSITE_NO_CHECK_BUCKET=true
  : > "$RCLONE_CONFIG"
}
remote_path() { printf '%s:%s/%s' "$REMOTE" "$BUCKET" "$PREFIX"; }
rc() { rclone --retries 3 --low-level-retries 5 --contimeout 30s --timeout 5m "$@"; }

# The passphrase reaches gpg through a pipe (file descriptor 3): not a command-line argument, not a file on disk.
encrypt() { # encrypt IN OUT
  gpg --homedir "$WORK/gnupg" --batch --yes --quiet --no-tty --pinentry-mode loopback --passphrase-fd 3 \
    --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none \
    -o "$2" "$1" 3< <(printf '%s' "$PASSPHRASE")
}
decrypt() { # decrypt IN OUT  (OUT may be - for standard output)
  gpg --homedir "$WORK/gnupg" --batch --yes --quiet --no-tty --pinentry-mode loopback --passphrase-fd 3 \
    --decrypt -o "$2" "$1" 3< <(printf '%s' "$PASSPHRASE")
}
sha() { sha256sum | cut -d' ' -f1; }

offsite_upload() {
  local newest name enc size have need remote_size
  newest=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fcs-league-*.tar.gz' -printf '%f\n' | sort -r | head -n 1)
  [ -n "$newest" ] || { echo "off-site copy: there is no backup in $BACKUP_DIR to upload" >&2; exit 1; }
  [[ "$newest" =~ $NAME_RE ]] || { echo "off-site copy: unexpected backup name $newest" >&2; exit 1; }
  size=$(stat -c %s "$BACKUP_DIR/$newest")
  have=$(df --output=avail -B1 "$BACKUP_DIR" | tail -n 1 | tr -d ' ')
  need=$((size + size / 10 + 16777216))
  [ "$have" -ge "$need" ] || { echo "off-site copy: not enough free disk to encrypt $newest ($size bytes needed, $have free)" >&2; exit 1; }

  name="$newest.gpg"; enc="$WORK/$name"
  encrypt "$BACKUP_DIR/$newest" "$enc"
  # prove it can be read back with this passphrase before trusting it as a backup
  [ "$(decrypt "$enc" - | sha)" = "$(sha < "$BACKUP_DIR/$newest")" ] || { echo "off-site copy: the encrypted file does not decrypt back to the backup; nothing uploaded" >&2; exit 1; }

  rc copyto "$enc" "$(remote_path)/$name"
  remote_size=$(rc lsf --format s "$(remote_path)/$name" | head -n 1 | tr -d ' ')
  [ "$remote_size" = "$(stat -c %s "$enc")" ] || { echo "off-site copy: the uploaded file has the wrong size (${remote_size:-missing}); treat this upload as failed" >&2; exit 1; }
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$name" "$remote_size" > "$BACKUP_DIR/.offsite-last"
  echo "off-site copy: uploaded $name ($(du -h "$enc" | cut -f1), encrypted) to bucket $BUCKET, folder $PREFIX"

  # old copies are removed only after a good upload, so a broken upload never leaves the bucket empty
  if [ "$KEEP_DAYS" -gt 0 ]; then
    rc delete --min-age "${KEEP_DAYS}d" --include 'fcs-league-*.tar.gz.gpg' "$(remote_path)" \
      && echo "off-site copy: copies older than $KEEP_DAYS days removed" \
      || echo "off-site copy: could not remove old copies (the upload itself is fine)" >&2
  fi
}

offsite_check() {
  local probe="$WORK/probe.txt" name back
  name="offsite-check-$(date -u +%Y%m%dT%H%M%SZ).gpg"
  head -c 4096 /dev/urandom | base64 > "$probe"
  encrypt "$probe" "$WORK/$name"
  rc copyto "$WORK/$name" "$(remote_path)/$name"
  back="$WORK/back.gpg"
  rc copyto "$(remote_path)/$name" "$back"
  [ "$(decrypt "$back" - | sha)" = "$(sha < "$probe")" ] || { echo "off-site check FAILED: the file came back different" >&2; exit 1; }
  rc deletefile "$(remote_path)/$name" || echo "note: the test file $name could not be deleted (the key may not be allowed to delete); remove it by hand" >&2
  echo "off-site check passed: encrypted, uploaded to bucket $BUCKET (folder $PREFIX), downloaded and decrypted a test file."
  echo "Keep a copy of the passphrase somewhere that is NOT this server. Without it the off-site backups cannot be opened."
}

offsite_list() {
  echo "backups in bucket $BUCKET, folder $PREFIX (newest last):"
  rc lsf --format pst --separator '  ' --include 'fcs-league-*.tar.gz.gpg' "$(remote_path)" | sort
}

offsite_fetch() {
  local want=$1 dest="$BACKUP_DIR/restored" plain
  if [ "$want" = "latest" ]; then
    want=$(rc lsf --include 'fcs-league-*.tar.gz.gpg' "$(remote_path)" | sort -r | head -n 1)
    [ -n "$want" ] || { echo "there are no backups in bucket $BUCKET, folder $PREFIX" >&2; exit 1; }
  fi
  want=${want%.gpg}
  [[ "$want" =~ $NAME_RE ]] || { echo "that is not a backup name (expected something like fcs-league-20261115T091500Z.tar.gz)" >&2; exit 1; }
  mkdir -p "$dest"
  rc copyto "$(remote_path)/$want.gpg" "$WORK/$want.gpg"
  plain="$dest/$want"
  decrypt "$WORK/$want.gpg" "$plain.partial" || { rm -f "$plain.partial"; echo "could not decrypt $want.gpg: wrong passphrase, or a damaged file" >&2; exit 1; }
  gzip -t "$plain.partial" || { rm -f "$plain.partial"; echo "$want decrypted but is not a valid archive" >&2; exit 1; }
  mv "$plain.partial" "$plain"
  echo "downloaded and decrypted: $plain ($(du -h "$plain" | cut -f1))"
  echo "put it back with:  sudo bash $(dirname "$(readlink -f "$0")")/restore.sh $plain"
}

# ---- main ----------------------------------------------------------------------------------------------------------
case "$MODE" in
  local)
    make_backup ;;
  backup)
    make_backup
    load_offsite
    if offsite_on; then need_offsite; offsite_upload; else echo "off-site copy: off (this backup exists only on this server)"; fi ;;
  offsite)
    load_offsite
    if offsite_on; then need_offsite; offsite_upload; else echo "off-site copy: off, nothing to do"; fi ;;
  check) load_offsite; need_offsite; offsite_check ;;
  list)  load_offsite; need_offsite; offsite_list ;;
  fetch) load_offsite; need_offsite; offsite_fetch "$FETCH_NAME" ;;
esac
