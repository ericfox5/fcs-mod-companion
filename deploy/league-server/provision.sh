#!/usr/bin/env bash
# One-shot setup of the FCS league server on a fresh Ubuntu LTS VM (24.04 or 26.04). Run as root:
#
#   sudo bash provision.sh --tarball fcs-league.tar.gz --public-host play.fcs-mod.online --site https://fcs-mod.online
#   sudo bash provision.sh --git https://github.com/OWNER/REPO.git --public-host ... --site ...
#
# It installs Node.js, creates one locked-down user per service, installs the app under /opt/fcs-league/app, writes
# the settings in /etc/fcs-league, opens only the needed ports (ufw), and enables the services and the daily backup.
# Safe to run again: it updates the app and keeps your settings, your tokens and your league data. An install made
# by an older version of this script (one "fcsleague" user for everything) is moved to the new layout.
#
# Options
#   --tarball FILE        app archive made on your PC by make-tarball.sh
#   --git URL             or: clone/update the app from a git repository (--ref BRANCH_OR_TAG, default main)
#   --public-host NAME    public hostname or IPv4 of this server (first install; later edits go in league.env)
#   --site URL            the companion site, https (first install)
#   --token-file FILE     file holding the bridge token on one line; it is copied into /etc/fcs-league/bridge.env and
#                         the file is then yours to delete. Without it you are asked to type the token (not echoed).
#                         Only the site sync service gets this token.
#   --registry-token-file FILE
#                         file holding the registry token on one line (REGISTRY_TOKEN on the site: it can read the
#                         member list and nothing else). It goes into /etc/fcs-league/registry.env, for the game
#                         service. Without it you are asked; an empty answer uses the bridge token for now.
#   --certs DIR           folder with gosredirector_mod.crt and gosredirector.key.pem to install (default: the ones in
#                         the tarball if it has them, else new ones are generated here)
#   --no-firewall         do not touch ufw
#   --no-start            install everything but do not start the services
set -euo pipefail

APP_ROOT=/opt/fcs-league
APP_DIR=$APP_ROOT/app
ETC_DIR=/etc/fcs-league
STATE_DIR=/var/lib/fcs-league
BACKUP_DIR=/var/backups/fcs-league
# One user per service, so one service cannot read another's environment (where its token is) or memory.
# The data group is shared by the two services that touch the league data: Blaze writes it, the site sync reads it.
U_BLAZE=fcs-blaze
U_REDIRECTOR=fcs-redirector
U_QOS=fcs-qos
U_DNS=fcs-dns
U_SYNC=fcs-sync
DATA_GROUP=fcsleague
MIN_NODE_MAJOR=22
NODESOURCE_MAJOR=24

TARBALL="" GIT_URL="" GIT_REF="main" PUBLIC_HOST="" SITE_URL="" TOKEN_FILE="" REGISTRY_TOKEN_FILE="" CERTS_FROM="" FIREWALL=1 START=1

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball)      TARBALL=${2:?--tarball needs a file}; shift 2 ;;
    --git)          GIT_URL=${2:?--git needs a URL}; shift 2 ;;
    --ref)          GIT_REF=${2:?--ref needs a branch or tag}; shift 2 ;;
    --public-host)  PUBLIC_HOST=${2:?--public-host needs a name}; shift 2 ;;
    --site)         SITE_URL=${2:?--site needs a URL}; shift 2 ;;
    --token-file)   TOKEN_FILE=${2:?--token-file needs a file}; shift 2 ;;
    --registry-token-file) REGISTRY_TOKEN_FILE=${2:?--registry-token-file needs a file}; shift 2 ;;
    --certs)        CERTS_FROM=${2:?--certs needs a folder}; shift 2 ;;
    --no-firewall)  FIREWALL=0; shift ;;
    --no-start)     START=0; shift ;;
    -h|--help)      sed -n '2,30p' "$0"; exit 0 ;;
    *)              die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash provision.sh ..."
[ -r /etc/os-release ] || die "this script is for Ubuntu"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "this script is for Ubuntu LTS (found: ${PRETTY_NAME:-unknown})"
if [ -n "$TARBALL" ] && [ -n "$GIT_URL" ]; then die "use --tarball or --git, not both"; fi
if [ -z "$TARBALL" ] && [ -z "$GIT_URL" ] && [ ! -d "$APP_DIR" ]; then die "first install needs --tarball FILE or --git URL"; fi
if [ -n "$TARBALL" ] && [ ! -r "$TARBALL" ]; then die "cannot read $TARBALL"; fi
if [ -n "$TOKEN_FILE" ] && [ ! -r "$TOKEN_FILE" ]; then die "cannot read $TOKEN_FILE"; fi
if [ -n "$REGISTRY_TOKEN_FILE" ] && [ ! -r "$REGISTRY_TOKEN_FILE" ]; then die "cannot read $REGISTRY_TOKEN_FILE"; fi
case "$SITE_URL" in ""|https://*) ;; *) die "--site must start with https://" ;; esac
case "$PUBLIC_HOST" in *[!A-Za-z0-9.-]*) die "--public-host must be a hostname or an IPv4 address" ;; esac

export DEBIAN_FRONTEND=noninteractive

# ---- 1. packages and Node.js --------------------------------------------------------------------------------------
say "Installing system packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg tar openssl ufw git

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
install_nodesource() {
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODESOURCE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
}
if [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
  candidate=$(apt-cache policy nodejs | awk '/Candidate:/ {print $2}' | cut -d. -f1 | tr -cd '0-9')
  if [ "${candidate:-0}" -ge "$MIN_NODE_MAJOR" ]; then
    say "Installing Node.js from Ubuntu"
    # Ubuntu's npm is several hundred small packages. A cloud mirror that is mid-update answers 404 for some of them
    # (seen on a fresh 26.04 VM), so fall back to NodeSource, whose one package carries npm.
    if ! apt-get install -y -q --no-install-recommends nodejs npm; then
      say "Ubuntu's packages could not all be fetched: installing Node.js $NODESOURCE_MAJOR from NodeSource instead"
      install_nodesource
    fi
  else
    say "Installing Node.js $NODESOURCE_MAJOR from NodeSource (Ubuntu's own is older than $MIN_NODE_MAJOR)"
    install_nodesource
  fi
fi
[ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || die "Node.js $MIN_NODE_MAJOR or newer is needed, found $(node -v 2>/dev/null || echo none)"
command -v npm >/dev/null 2>&1 || die "npm is missing (apt-get install npm)"
[ -x /usr/bin/node ] || ln -sf "$(command -v node)" /usr/bin/node
note "node $(node -v), npm $(npm -v)"

# ---- 2. service user and folders ---------------------------------------------------------------------------------
say "Creating the service users and folders"
getent group "$DATA_GROUP" >/dev/null 2>&1 || groupadd --system "$DATA_GROUP"
for u in "$U_BLAZE" "$U_REDIRECTOR" "$U_QOS" "$U_DNS" "$U_SYNC"; do
  id "$u" >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$u"
done
usermod -a -G "$DATA_GROUP" "$U_BLAZE"
usermod -a -G "$DATA_GROUP" "$U_SYNC"
# An install from the older one-user layout: stop the services before their files change owner.
if id fcsleague >/dev/null 2>&1 && [ -d "$STATE_DIR/private" ] && [ "$(stat -c '%U' "$STATE_DIR/private")" = "fcsleague" ]; then
  note "moving the one-user install to one user per service"
  systemctl stop fcs-league.target fcs-league-redirector.service fcs-league-blaze.service fcs-league-qos.service fcs-league-sync.service 2>/dev/null || true
fi
install -d -m 0755 -o root -g root "$APP_ROOT"
#   /var/lib/fcs-league             root, the data group may look inside
#   /var/lib/fcs-league/private     Blaze writes; the data group (the site sync) reads; nobody else
#   .../private/web-edits           the site sync writes (edits made on the site, for consoles); Blaze reads
#   /var/lib/fcs-league/sync        the site sync's own home (its progress file); nobody else
# The "2" in 2750 makes new files keep the data group, whoever writes them.
install -d -m 0750 -o root -g "$DATA_GROUP" "$STATE_DIR"
install -d -m 2750 -o "$U_BLAZE" -g "$DATA_GROUP" "$STATE_DIR/private"
install -d -m 2750 -o "$U_SYNC" -g "$DATA_GROUP" "$STATE_DIR/private/web-edits"
install -d -m 0700 -o "$U_SYNC" -g "$U_SYNC" "$STATE_DIR/sync"
if [ -d "$STATE_DIR/.ncaa-bridge" ] && [ ! -e "$STATE_DIR/sync/.ncaa-bridge" ]; then mv "$STATE_DIR/.ncaa-bridge" "$STATE_DIR/sync/.ncaa-bridge"; fi
install -d -m 0755 -o root -g root "$ETC_DIR"
install -d -m 0750 -o root -g "$U_REDIRECTOR" "$ETC_DIR/certs"
install -d -m 0700 -o root -g root "$BACKUP_DIR"
# an empty league, so the site sync has a store to read before the first dynasty exists (never overwrites one)
if [ ! -e "$STATE_DIR/private/dynasties.json" ]; then
  printf '{ "nextId": 1, "dynasties": {} }\n' > "$STATE_DIR/private/dynasties.json"
fi
# Owners and permissions of everything already there (a fresh install, an older layout, or files put back by hand).
fix_ownership() {
  chown -R "$U_BLAZE:$DATA_GROUP" "$STATE_DIR/private"
  chown -R "$U_SYNC:$DATA_GROUP" "$STATE_DIR/private/web-edits"
  chmod -R u=rwX,g=rX,o= "$STATE_DIR/private"
  find "$STATE_DIR/private" -type d -exec chmod g+s {} +
  # the cached member list holds credential hashes: the game service only
  if [ -f "$STATE_DIR/private/league-registry.json" ]; then chmod 0600 "$STATE_DIR/private/league-registry.json"; fi
  chown -R "$U_SYNC:$U_SYNC" "$STATE_DIR/sync"; chmod -R u=rwX,go= "$STATE_DIR/sync"
  # A PC's bridge config (it holds the token and PC paths) has no place here. The two settings the owner makes on the
  # server stay: the start year of new dynasties and the recruit overhaul tool (README "Start year and Fang's Recruit
  # Overhaul"). Until 2026-11-17 the whole file was deleted, which switched both off at every re-run of this script.
  SYNC_CFG="$STATE_DIR/sync/.ncaa-bridge/config.json"
  if [ -f "$SYNC_CFG" ]; then
    if node -e 'const fs=require("fs"),f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));const o={};if(typeof c.startYear==="number")o.startYear=c.startYear;if(typeof c.overhaulExe==="string"&&c.overhaulExe.startsWith("/var/lib/fcs-league/sync/"))o.overhaulExe=c.overhaulExe;if(Object.keys(o).length)fs.writeFileSync(f,JSON.stringify(o,null,2)+"\n");else fs.unlinkSync(f);' "$SYNC_CFG" 2>/dev/null; then
      [ -f "$SYNC_CFG" ] && { chown "$U_SYNC:$U_SYNC" "$SYNC_CFG"; chmod 0600 "$SYNC_CFG"; }
    else
      rm -f "$SYNC_CFG"
    fi
  fi
}
fix_ownership

# ---- 3. the app --------------------------------------------------------------------------------------------------
if [ -n "$TARBALL" ] || [ -n "$GIT_URL" ]; then
  say "Installing the app into $APP_DIR"
  NEW=$(mktemp -d "$APP_ROOT/app.new.XXXXXX")
  trap 'rm -rf "$NEW"' EXIT
  if [ -n "$TARBALL" ]; then
    # no owner from the archive, no absolute paths, nothing outside the folder
    tar -xzf "$TARBALL" -C "$NEW" --no-same-owner --no-same-permissions
  else
    git clone --depth 1 --branch "$GIT_REF" "$GIT_URL" "$NEW"
    rm -rf "$NEW/.git"
  fi
  [ -f "$NEW/spike/blaze/server/blaze.mjs" ] && [ -f "$NEW/package-lock.json" ] && [ -f "$NEW/bridge/src/cli.ts" ] \
    || die "that archive is not the league server (spike/blaze/server/blaze.mjs, bridge/, package-lock.json expected)"

  say "Installing dependencies (exact versions from package-lock.json, no install scripts)"
  ( cd "$NEW" && npm ci --ignore-scripts --no-audit --no-fund \
      --workspace bridge --workspace packages/tdb --workspace packages/ncaa14 --include-workspace-root )
  say "Building the save-file codec the server uses"
  # --force and no leftover *.tsbuildinfo: a stale build record makes tsc skip files it believes are already built
  find "$NEW/packages" "$NEW/bridge" -maxdepth 2 -name '*.tsbuildinfo' -delete 2>/dev/null || true
  ( cd "$NEW" && npx --no-install tsc -b --force packages/tdb )
  for f in index table reader writer; do
    [ -f "$NEW/packages/tdb/dist/$f.js" ] || die "packages/tdb/dist/$f.js was not built"
  done
  [ -f "$NEW/node_modules/tsx/dist/cli.mjs" ] || die "tsx is missing after npm ci"

  # certificates shipped inside the tarball are moved out of the app folder
  if [ -z "$CERTS_FROM" ] && [ -f "$NEW/deploy/league-server/certs/gosredirector_mod.crt" ]; then
    CERTS_STAGE=$(mktemp -d); cp "$NEW"/deploy/league-server/certs/gosredirector* "$CERTS_STAGE"/; CERTS_FROM=$CERTS_STAGE
  fi
  rm -rf "$NEW/deploy/league-server/certs" "$NEW/spike/blaze/private" "$NEW/spike/blaze/server/certs"

  chown -R root:root "$NEW"
  chmod -R u=rwX,go=rX "$NEW"
  chmod 0755 "$NEW"/deploy/league-server/*.sh
  if [ -d "$APP_DIR" ]; then rm -rf "$APP_ROOT/app.old"; mv "$APP_DIR" "$APP_ROOT/app.old"; fi
  mv "$NEW" "$APP_DIR"
  trap - EXIT
  note "installed (the previous version, if any, is kept in $APP_ROOT/app.old)"
fi
DEPLOY=$APP_DIR/deploy/league-server
[ -d "$DEPLOY" ] || die "$DEPLOY is missing"

# ---- 4. settings -------------------------------------------------------------------------------------------------
say "Writing settings in $ETC_DIR"
if [ ! -f "$ETC_DIR/league.env" ]; then
  [ -n "$PUBLIC_HOST" ] || die "first install needs --public-host (for example play.fcs-mod.online)"
  [ -n "$SITE_URL" ] || die "first install needs --site (for example https://fcs-mod.online)"
  sed -e "s|^NCAA_PUBLIC_HOST=.*|NCAA_PUBLIC_HOST=$PUBLIC_HOST|" -e "s|^NCAA_WORKER_URL=.*|NCAA_WORKER_URL=${SITE_URL%/}|" \
    "$DEPLOY/league.env.example" > "$ETC_DIR/league.env"
  note "created league.env"
else
  note "kept the existing league.env (edit it by hand to change settings)"
fi
chown root:root "$ETC_DIR/league.env"; chmod 0644 "$ETC_DIR/league.env"

# Two secrets, each in its own root-only file, each handed to ONE service by systemd:
#   bridge.env    NCAA_BRIDGE_TOKEN    the full site token (it can write to the site)   -> the site sync only
#   registry.env  NCAA_REGISTRY_TOKEN  can only read the member list                    -> the game service (Blaze)
# Never printed, never passed on a command line, never written anywhere else.
write_secret() { # write_secret FILE NAME VALUE WHAT
  local file=$1 name=$2 token=$3 what=$4
  token=$(printf '%s' "$token" | tr -d '\r\n\t ')
  [ -n "$token" ] || die "the $what is empty"
  case "$token" in *[!A-Za-z0-9._~+/=-]*) die "the $what has unexpected characters (paste only the token itself)" ;; esac
  ( umask 077; printf '%s=%s\n' "$name" "$token" > "$file.tmp" )
  mv "$file.tmp" "$file"
}
write_token() { write_secret "$ETC_DIR/bridge.env" NCAA_BRIDGE_TOKEN "$1" "bridge token"; }
if [ -n "$TOKEN_FILE" ]; then
  write_token "$(sed -n '1p' "$TOKEN_FILE" | sed -e 's/^NCAA_BRIDGE_TOKEN=//')"
  note "bridge token installed from $TOKEN_FILE (delete that file now: rm $TOKEN_FILE)"
elif [ ! -f "$ETC_DIR/bridge.env" ] || grep -q 'paste-the-token-here' "$ETC_DIR/bridge.env"; then
  if [ -t 0 ]; then
    printf '\nPaste the bridge token (it will not be shown), then press Enter: '
    IFS= read -r -s TOKEN_INPUT; printf '\n'
    write_token "$TOKEN_INPUT"; unset TOKEN_INPUT
    note "bridge token saved"
  else
    ( umask 077; cp "$DEPLOY/bridge.env.example" "$ETC_DIR/bridge.env" )
    note "NO TOKEN YET: put it in $ETC_DIR/bridge.env (sudo nano $ETC_DIR/bridge.env), then run this script again"
    START=0
  fi
else
  note "kept the existing bridge token"
fi
chown root:root "$ETC_DIR/bridge.env"; chmod 0600 "$ETC_DIR/bridge.env"

# The registry token, for the game service. If there is none yet, the bridge token is used for the member list too:
# everything works, but the service that faces the internet then holds the full token. check.sh keeps saying so.
bridge_token_value() { sed -n 's/^NCAA_BRIDGE_TOKEN=//p' "$ETC_DIR/bridge.env" | tail -n 1; }
reuse_bridge_token() {
  if grep -q 'paste-the-token-here' "$ETC_DIR/bridge.env"; then
    ( umask 077; cp "$DEPLOY/registry.env.example" "$ETC_DIR/registry.env" )
    note "NO REGISTRY TOKEN YET: put it in $ETC_DIR/registry.env (sudo nano $ETC_DIR/registry.env), then run this script again"
    START=0
  else
    write_secret "$ETC_DIR/registry.env" NCAA_REGISTRY_TOKEN "$(bridge_token_value)" "registry token"
    note "no registry token given: the game service uses the BRIDGE token for the member list for now."
    note "Better: set REGISTRY_TOKEN on the site, then put the same value in $ETC_DIR/registry.env (see the README)."
  fi
}
if [ -n "$REGISTRY_TOKEN_FILE" ]; then
  write_secret "$ETC_DIR/registry.env" NCAA_REGISTRY_TOKEN "$(sed -n '1p' "$REGISTRY_TOKEN_FILE" | sed -e 's/^NCAA_REGISTRY_TOKEN=//')" "registry token"
  note "registry token installed from $REGISTRY_TOKEN_FILE (delete that file now: rm $REGISTRY_TOKEN_FILE)"
elif [ ! -f "$ETC_DIR/registry.env" ] || grep -q 'paste-the-registry-token-here' "$ETC_DIR/registry.env"; then
  if [ -t 0 ] && ! grep -q 'paste-the-token-here' "$ETC_DIR/bridge.env"; then
    printf '\nPaste the REGISTRY token (it will not be shown), then press Enter.\nNo registry token on the site yet? Press Enter alone to use the bridge token for now: '
    IFS= read -r -s REG_INPUT; printf '\n'
    if [ -n "$REG_INPUT" ]; then write_secret "$ETC_DIR/registry.env" NCAA_REGISTRY_TOKEN "$REG_INPUT" "registry token"; note "registry token saved"; else reuse_bridge_token; fi
    unset REG_INPUT
  else
    reuse_bridge_token
  fi
else
  note "kept the existing registry token"
fi
chown root:root "$ETC_DIR/registry.env"; chmod 0600 "$ETC_DIR/registry.env"

# ---- 5. redirector certificate -----------------------------------------------------------------------------------
say "Redirector certificate"
if [ -n "$CERTS_FROM" ]; then
  [ -f "$CERTS_FROM/gosredirector_mod.crt" ] && [ -f "$CERTS_FROM/gosredirector.key.pem" ] || die "$CERTS_FROM needs gosredirector_mod.crt and gosredirector.key.pem"
  install -m 0644 -o root -g root "$CERTS_FROM/gosredirector_mod.crt" "$ETC_DIR/certs/gosredirector_mod.crt"
  install -m 0640 -o root -g "$U_REDIRECTOR" "$CERTS_FROM/gosredirector.key.pem" "$ETC_DIR/certs/gosredirector.key.pem"
  [ -n "${CERTS_STAGE:-}" ] && rm -rf "$CERTS_STAGE"
  note "installed the certificate you supplied"
elif [ ! -f "$ETC_DIR/certs/gosredirector_mod.crt" ]; then
  GEN=$(mktemp -d)
  NCAA_CERT_DIR=$GEN node "$APP_DIR/spike/blaze/server/gen-cert.mjs" >/dev/null
  install -m 0644 -o root -g root "$GEN/gosredirector_mod.crt" "$ETC_DIR/certs/gosredirector_mod.crt"
  install -m 0640 -o root -g "$U_REDIRECTOR" "$GEN/gosredirector.key.pem" "$ETC_DIR/certs/gosredirector.key.pem"
  rm -rf "$GEN"
  note "generated a new certificate (see the README: the one from your PC is the proven one)"
else
  note "kept the existing certificate"
fi
# the key is for the redirector's user only (an older install gave it to the shared user)
if [ -f "$ETC_DIR/certs/gosredirector.key.pem" ]; then chown root:"$U_REDIRECTOR" "$ETC_DIR/certs/gosredirector.key.pem"; chmod 0640 "$ETC_DIR/certs/gosredirector.key.pem"; fi

# ---- 6. firewall -------------------------------------------------------------------------------------------------
if [ "$FIREWALL" -eq 1 ]; then
  say "Firewall (ufw): only SSH and the game ports"
  bash "$DEPLOY/firewall.sh"
else
  note "firewall left alone (--no-firewall)"
fi

# ---- 7. services -------------------------------------------------------------------------------------------------
say "Installing the services"
install -m 0644 -o root -g root "$DEPLOY"/systemd/fcs-league*.service "$DEPLOY"/systemd/fcs-league*.timer "$DEPLOY"/systemd/fcs-league.target /etc/systemd/system/
systemctl daemon-reload
systemctl enable fcs-league.target fcs-league-redirector.service fcs-league-blaze.service fcs-league-qos.service fcs-league-dns.service fcs-league-sync.service fcs-league-backup.timer >/dev/null
systemctl start fcs-league-backup.timer
if [ "$START" -eq 1 ]; then
  systemctl restart fcs-league.target fcs-league-redirector.service fcs-league-blaze.service fcs-league-qos.service fcs-league-dns.service fcs-league-sync.service
  sleep 4
  say "Status"
  bash "$DEPLOY/check.sh" || true
else
  note "services installed but not started. Start them with: sudo systemctl start fcs-league.target"
fi

say "Done"
note "settings:  $ETC_DIR/league.env   (tokens: $ETC_DIR/registry.env and bridge.env, root only)"
note "data:      $STATE_DIR/private    backups: $BACKUP_DIR (daily, 14 kept)"
note "logs:      journalctl -u 'fcs-league-*' -f"
note "check:     sudo bash $DEPLOY/check.sh"
