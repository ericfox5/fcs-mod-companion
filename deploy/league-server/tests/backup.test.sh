#!/usr/bin/env bash
# Self-test for backup.sh and restore.sh's archive rules. Runs on any Linux with bash, tar, gzip and gpg; needs no
# root, no network and no rclone: a stand-in "rclone" that stores into a local folder is put on PATH. Everything
# happens in a temp folder under /tmp.
#   bash deploy/league-server/tests/backup.test.sh
set -euo pipefail

HERE=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
T=$(mktemp -d /tmp/fcs-backup-test.XXXXXX)
trap 'rm -rf "$T"' EXIT
pass=0
ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; exit 1; }
expect_fail() { # expect_fail "what" "text in the output" command...
  local what=$1 text=$2 out; shift 2
  if out=$("$@" 2>&1); then fail "$what: it should have been refused"; fi
  case "$out" in *"$text"*) ok "$what" ;; *) fail "$what: unexpected message: $out" ;; esac
}

# ---- a pretend server --------------------------------------------------------------------------------------------
export FCS_STATE_DIR="$T/state" FCS_ETC_DIR="$T/etc" FCS_BACKUP_DIR="$T/backups" FCS_BACKUP_KEEP=3
mkdir -p "$FCS_STATE_DIR/private/locker/trash" "$FCS_STATE_DIR/private/dynasty-tables/1" "$FCS_ETC_DIR" "$T/bin" "$T/remote"
printf '{ "nextId": 2, "dynasties": { "1": { "id": 1 } } }\n' > "$FCS_STATE_DIR/private/dynasties.json"
cp "$FCS_STATE_DIR/private/dynasties.json" "$FCS_STATE_DIR/private/dynasties.json.bak"
printf 'half' > "$FCS_STATE_DIR/private/dynasties.json.1234.abcd.tmp"
printf 'old' > "$FCS_STATE_DIR/private/dynasties.json.damaged"
head -c 20000 /dev/urandom > "$FCS_STATE_DIR/private/locker/5.bin"
printf 'deleted' > "$FCS_STATE_DIR/private/locker/trash/4.bin"
printf '{"table":"TEAM","rows":[]}' > "$FCS_STATE_DIR/private/dynasty-tables/1/TEAM.json"
printf 'NCAA_CLOUD=1\n' > "$FCS_ETC_DIR/league.env"
printf 'NCAA_BRIDGE_TOKEN=this-must-never-be-in-a-backup\n' > "$FCS_ETC_DIR/bridge.env"
printf 'NCAA_REGISTRY_TOKEN=this-must-never-be-in-a-backup-either\n' > "$FCS_ETC_DIR/registry.env"
# the site sync's progress file lives in its own home (sync/); an upload that was still arriving is a .upload.tmp
mkdir -p "$FCS_STATE_DIR/sync/.ncaa-bridge"; printf '{}' > "$FCS_STATE_DIR/sync/.ncaa-bridge/od-state.json"
printf 'half an upload' > "$FCS_STATE_DIR/private/locker/9.a1b2c3d4e5f6.upload.tmp"

# the stand-in for rclone: "fcsoffsite:bucket/folder/name" is a path under $FAKE_REMOTE
cat > "$T/bin/rclone" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_LOG"
[ "${RCLONE_CONFIG_FCSOFFSITE_TYPE:-}" = s3 ] && [ -n "${RCLONE_CONFIG_FCSOFFSITE_ACCESS_KEY_ID:-}" ] && [ -n "${RCLONE_CONFIG_FCSOFFSITE_SECRET_ACCESS_KEY:-}" ] \
  && [ -n "${RCLONE_CONFIG_FCSOFFSITE_ENDPOINT:-}" ] && [ "${RCLONE_CONFIG_FCSOFFSITE_NO_CHECK_BUCKET:-}" = true ] || { echo "shim: storage settings missing from the environment" >&2; exit 9; }
args=() format="p" include="*" minage=""
while [ $# -gt 0 ]; do
  case "$1" in
    --retries|--low-level-retries|--contimeout|--timeout|--separator) shift 2 ;;
    --format) format=$2; shift 2 ;;
    --include) include=$2; shift 2 ;;
    --min-age) minage=${2%d}; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
loc() { case "$1" in fcsoffsite:*) printf '%s/%s' "$FAKE_REMOTE" "${1#fcsoffsite:}" ;; *) printf '%s' "$1" ;; esac; }
[ -z "${FAKE_FAIL:-}" ] || { echo "shim: simulated storage failure" >&2; exit 5; }
case "${args[0]}" in
  copyto) mkdir -p "$(dirname "$(loc "${args[2]}")")"; cp "$(loc "${args[1]}")" "$(loc "${args[2]}")" ;;
  lsf)
    p=$(loc "${args[1]}")
    if [ -f "$p" ]; then [ "$format" = s ] && stat -c %s "$p" || basename "$p"
    elif [ -d "$p" ]; then for f in "$p"/$include; do [ -f "$f" ] && basename "$f"; done; fi ;;
  delete) p=$(loc "${args[1]}"); [ -d "$p" ] && find "$p" -maxdepth 1 -type f -name "$include" -mtime "+$minage" -delete ;;
  deletefile) rm -f "$(loc "${args[1]}")" ;;
  *) echo "shim: unexpected command ${args[0]}" >&2; exit 8 ;;
esac
SHIM
chmod +x "$T/bin/rclone"
export PATH="$T/bin:$PATH" FAKE_REMOTE="$T/remote" FAKE_LOG="$T/rclone.log" FCS_OFFSITE_ENV="$FCS_ETC_DIR/offsite.env"
: > "$FAKE_LOG"
BACKUP="$HERE/backup.sh"
PASSPHRASE='correct horse battery staple 0123456789'
SECRET_KEY='s3cr3t-key-value-that-must-stay-out-of-argv'
write_env() { # write_env on|off [passphrase]
  rm -f "$FCS_OFFSITE_ENV"
  ( umask 077; cat > "$FCS_OFFSITE_ENV" <<EOF
# test settings
FCS_OFFSITE=$1
FCS_OFFSITE_ENDPOINT=https://example-account.r2.cloudflarestorage.com
FCS_OFFSITE_BUCKET=fcs-league-backups
FCS_OFFSITE_PREFIX=league-server
FCS_OFFSITE_ACCESS_KEY_ID=AKIDEXAMPLE
FCS_OFFSITE_SECRET_ACCESS_KEY=$SECRET_KEY
FCS_OFFSITE_PASSPHRASE=${2:-$PASSPHRASE}
FCS_OFFSITE_KEEP_DAYS=30
EOF
  )
}
REMOTE_DIR="$T/remote/fcs-league-backups/league-server"
newest() { find "$FCS_BACKUP_DIR" -maxdepth 1 -name 'fcs-league-*.tar.gz' -printf '%f\n' | sort -r | head -n 1; }

echo "Local backup (off-site off by default)"
out=$(bash "$BACKUP")
case "$out" in *"off-site copy: off"*) ok "no settings file: local backup only, and it says so" ;; *) fail "expected the off-site copy to be off: $out" ;; esac
[ ! -s "$FAKE_LOG" ] || fail "rclone was called although the off-site copy is off"
a1=$(newest); list=$(tar -tzf "$FCS_BACKUP_DIR/$a1")
for want in private/dynasties.json private/dynasties.json.bak private/locker/5.bin private/dynasty-tables/1/TEAM.json league.env .ncaa-bridge/od-state.json; do
  grep -qx "$want" <<<"$list" || fail "$want is missing from the backup"
done
ok "the archive holds the store, its previous copy, Locker files, tables and league.env"
for never in bridge.env registry.env offsite.env '.tmp' '.damaged' 'locker/trash/4.bin'; do
  if grep -q -- "$never" <<<"$list"; then fail "$never must not be in a backup"; fi
done
ok "no token, no temp files, no trash in the archive"
[ "$(stat -c %a "$FCS_BACKUP_DIR/$a1")" = 600 ] || fail "the archive should be readable by its owner only"
ok "the archive is private (mode 600)"
out=$(bash "$BACKUP" --local-only); case "$out" in *off-site*) fail "--local-only must not mention or touch off-site storage" ;; esac
write_env off
sleep 1; out=$(bash "$BACKUP"); [ ! -s "$FAKE_LOG" ] || fail "FCS_OFFSITE=off must not upload"
ok "FCS_OFFSITE=off and --local-only never touch the network"
sleep 1; bash "$BACKUP" --local-only >/dev/null; sleep 1; bash "$BACKUP" --local-only >/dev/null
[ "$(find "$FCS_BACKUP_DIR" -maxdepth 1 -name 'fcs-league-*.tar.gz' | wc -l)" = 3 ] || fail "rotation should keep 3"
ok "rotation keeps the newest $FCS_BACKUP_KEEP"

echo "Off-site settings are checked before anything is sent"
write_env on; chmod 644 "$FCS_OFFSITE_ENV"
expect_fail "a settings file others can read is refused" "must be readable by root only" bash "$BACKUP" --offsite
write_env on short
expect_fail "a short passphrase is refused" "too short" bash "$BACKUP" --offsite
write_env on 'paste-a-long-passphrase-here'
expect_fail "the example passphrase is refused" "example text" bash "$BACKUP" --offsite
write_env off
expect_fail "--offsite-list says the copy is off" "off-site copy is off" bash "$BACKUP" --offsite-list
[ ! -s "$FAKE_LOG" ] || fail "nothing may be sent with bad settings"
ok "nothing was sent while the settings were wrong"

echo "Encrypted upload"
write_env on
out=$(bash "$BACKUP" --offsite-check); case "$out" in *"off-site check passed"*) ok "--offsite-check round trip" ;; *) fail "$out" ;; esac
[ -z "$(ls -A "$REMOTE_DIR" 2>/dev/null)" ] || fail "the check left its test file behind"
sleep 1; out=$(bash "$BACKUP")
a2=$(newest)
[ -f "$REMOTE_DIR/$a2.gpg" ] || fail "the newest backup was not uploaded: $out"
ok "the newest archive was uploaded as $a2.gpg"
if cmp -s "$REMOTE_DIR/$a2.gpg" "$FCS_BACKUP_DIR/$a2"; then fail "the uploaded file is not encrypted"; fi
if gzip -t "$REMOTE_DIR/$a2.gpg" 2>/dev/null || tar -tzf "$REMOTE_DIR/$a2.gpg" >/dev/null 2>&1; then fail "the uploaded file opens as a plain archive"; fi
if grep -q -a 'dynasties.json' "$REMOTE_DIR/$a2.gpg"; then fail "file names are readable in the uploaded file"; fi
ok "what is in the bucket is not a readable archive"
if grep -q -- "$SECRET_KEY" "$FAKE_LOG" || grep -q -- "$PASSPHRASE" "$FAKE_LOG"; then fail "a secret was passed on a command line"; fi
ok "the storage key and the passphrase never appear on a command line"
[ -z "$(find "$FCS_BACKUP_DIR" -name '.offsite.*')" ] || fail "the staging folder was left behind"
grep -q "$a2.gpg" "$FCS_BACKUP_DIR/.offsite-last" || fail ".offsite-last was not written"
ok "staging folder removed, last upload recorded"
out=$(GNUPGHOME=$(mktemp -d "$T/gh.XXXX") gpg --batch --quiet --no-tty --pinentry-mode loopback --passphrase 'the wrong passphrase 0123456789' --decrypt -o "$T/wrong.out" "$REMOTE_DIR/$a2.gpg" 2>&1) && fail "a wrong passphrase decrypted the backup" || ok "a wrong passphrase cannot open it"
# plain gpg, the way you would on a PC with nothing but the file and the passphrase
GNUPGHOME=$(mktemp -d "$T/gh.XXXX") gpg --batch --quiet --no-tty --pinentry-mode loopback --passphrase "$PASSPHRASE" --decrypt -o "$T/manual.tar.gz" "$REMOTE_DIR/$a2.gpg"
cmp -s "$T/manual.tar.gz" "$FCS_BACKUP_DIR/$a2" || fail "manual gpg decryption gave a different file"
ok "plain gpg + the passphrase gives back the exact archive"

echo "Old copies and failures"
touch -d '40 days ago' "$REMOTE_DIR/fcs-league-20200101T000000Z.tar.gz.gpg"; touch -d '40 days ago' "$REMOTE_DIR/keep-me.txt"
if FAKE_FAIL=1 bash "$BACKUP" --offsite >/dev/null 2>&1; then fail "a failed upload must fail the run"; fi
[ -f "$REMOTE_DIR/fcs-league-20200101T000000Z.tar.gz.gpg" ] || fail "old copies were removed although the upload failed"
ok "a failed upload exits with an error and removes nothing"
bash "$BACKUP" --offsite >/dev/null
[ ! -f "$REMOTE_DIR/fcs-league-20200101T000000Z.tar.gz.gpg" ] || fail "the 40-day-old copy should be gone"
[ -f "$REMOTE_DIR/keep-me.txt" ] && [ -f "$REMOTE_DIR/$a2.gpg" ] || fail "only old backup copies may be removed"
ok "after a good upload, copies older than 30 days are removed and nothing else"

echo "Restore from off-site"
out=$(bash "$BACKUP" --offsite-list); case "$out" in *"$a2.gpg"*) ok "--offsite-list shows the copy" ;; *) fail "$out" ;; esac
rm -f "$FCS_BACKUP_DIR"/fcs-league-*.tar.gz   # the server and its local backups are gone
out=$(bash "$BACKUP" --offsite-fetch latest)
got="$FCS_BACKUP_DIR/restored/$a2"
[ -f "$got" ] || fail "nothing was fetched: $out"
cmp -s "$got" "$T/manual.tar.gz" || fail "the fetched archive differs from the one that was backed up"
case "$out" in *"restore.sh $got"*) ;; *) fail "the fetch should say how to restore: $out" ;; esac
ok "--offsite-fetch latest downloads, decrypts and names the restore command"
mkdir "$T/unpacked"; tar -xzf "$got" -C "$T/unpacked"
cmp -s "$T/unpacked/private/dynasties.json" "$FCS_STATE_DIR/private/dynasties.json" && cmp -s "$T/unpacked/private/locker/5.bin" "$FCS_STATE_DIR/private/locker/5.bin" || fail "restored data differs"
ok "the fetched archive unpacks to the same league data"
# restore.sh only accepts a plain league backup: the same rule it applies before touching anything
if tar -tzf "$got" | grep -Ev '^(\./)?$|^(\./)?(private(/|$)|\.ncaa-bridge(/|$)|league\.env$)' | grep -q .; then fail "restore.sh would refuse this archive"; fi
ok "restore.sh's archive check accepts it"
expect_fail "a name that is not a backup is refused" "not a backup name" bash "$BACKUP" --offsite-fetch '../../etc/passwd'
write_env on 'a different passphrase, also long enough'
expect_fail "the wrong passphrase cannot fetch" "could not decrypt" bash "$BACKUP" --offsite-fetch "$a2"
[ ! -e "$FCS_BACKUP_DIR/restored/$a2.partial" ] || fail "a failed fetch left a partial file"
ok "a failed fetch leaves nothing half-written"

echo "All $pass checks passed."
