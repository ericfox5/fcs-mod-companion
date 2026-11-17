#!/usr/bin/env bash
# Quick health check on the server. Prints one line per thing; exits 1 if something is wrong.
#   sudo bash /opt/fcs-league/app/deploy/league-server/check.sh
set -uo pipefail

ETC_DIR=${FCS_ETC_DIR:-/etc/fcs-league}
ENV_FILE=$ETC_DIR/league.env
setting() { local v=""; [ -r "$ENV_FILE" ] && v=$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'); printf '%s' "${v:-$2}"; }
bad=0
ok()   { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; bad=1; }

echo "Services"
for s in redirector blaze qos dns sync; do
  if systemctl is-active --quiet "fcs-league-$s.service"; then ok "fcs-league-$s is running"; else fail "fcs-league-$s is NOT running   (journalctl -u fcs-league-$s -n 30)"; fi
done
if systemctl is-active --quiet fcs-league-backup.timer; then ok "daily backup timer is on"; else fail "daily backup timer is off"; fi

echo "Ports"
tcp_open() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }
udp_open() { ss -Hlun "sport = :$1" 2>/dev/null | grep -q .; }
for p in "$(setting NCAA_REDIRECTOR_PORT 42127)" "$(setting NCAA_BLAZE_PORT 33152)" "$(setting NCAA_LOCKER_PORT 17503)" "$(setting NCAA_QOS_PORT 17502)"; do
  if tcp_open "$p"; then ok "tcp/$p is listening"; else fail "tcp/$p is not listening"; fi
done
for p in "$(setting NCAA_QOS_PORT 17502)" "$(setting NCAA_QOS_FW1 17500)" "$(setting NCAA_QOS_FW2 17501)"; do
  if udp_open "$p"; then ok "udp/$p is listening"; else fail "udp/$p is not listening"; fi
done
QOS=$(setting NCAA_QOS_PORT 17502)
if curl -fsS -m 5 "http://127.0.0.1:$QOS/qos/firetype" 2>/dev/null | grep -q '<firetype>'; then ok "QoS answers over HTTP"; else fail "QoS does not answer on http://127.0.0.1:$QOS"; fi

# The services say which profile they started in ("mode: cloud ..." or "mode: local ..."). A public server must be
# in cloud mode: local mode lets anyone who can connect sign in as anyone. Read from this run's own log lines.
echo "Mode"
case "$(setting NCAA_CLOUD "" | tr 'A-Z' 'a-z')" in
  1|on|true|yes) ok "NCAA_CLOUD is on in $ENV_FILE" ;;
  *) fail "NCAA_CLOUD is not on in $ENV_FILE (found: \"$(setting NCAA_CLOUD "")\"). It must be exactly NCAA_CLOUD=1, with nothing after it" ;;
esac
if [ "$(id -u)" -eq 0 ]; then
  for s in blaze redirector qos; do
    inv=$(systemctl show -p InvocationID --value "fcs-league-$s.service" 2>/dev/null)
    line=""
    [ -n "$inv" ] && line=$(journalctl "_SYSTEMD_INVOCATION_ID=$inv" --no-pager -o cat 2>/dev/null | grep -m 1 -E '\] mode: ')
    case "$line" in
      *"mode: cloud"*) ok "fcs-league-$s started in cloud mode" ;;
      *"mode: local"*) fail "fcs-league-$s is running in LOCAL mode: ${line#*] }. Fix NCAA_CLOUD in $ENV_FILE, then: sudo systemctl restart fcs-league.target" ;;
      *) fail "cannot confirm from the log that fcs-league-$s is in cloud mode (no \"mode:\" line since it started)   (journalctl -u fcs-league-$s -n 30)" ;;
    esac
  done
else echo "  (run with sudo to confirm cloud mode from the service logs)"; fi

echo "Settings"
host=$(setting NCAA_PUBLIC_HOST "")
if [ -n "$host" ]; then
  addr=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1 {print $1}')
  if [ -n "$addr" ]; then ok "$host resolves to $addr (must be this server's public IPv4)"; else fail "$host does not resolve to an IPv4 address yet (check the DNS record)"; fi
else fail "NCAA_PUBLIC_HOST is not set in $ENV_FILE"; fi
note() { printf '  note  %s\n' "$*"; }
for f in bridge registry; do
  file=$ETC_DIR/$f.env
  if [ -f "$file" ]; then
    perms=$(stat -c '%a %U' "$file")
    if [ "$perms" = "600 root" ]; then ok "$f token file is root-only"; else fail "$f token file permissions are $perms (want 600 root): sudo chmod 600 $file; sudo chown root:root $file"; fi
    if [ "$(id -u)" -eq 0 ] && grep -Eq 'paste-the-(registry-)?token-here' "$file"; then fail "the $f token has not been filled in ($file)"; fi
  else fail "$file is missing (run provision.sh again)"; fi
done
# Which token the game service holds. Values are compared, never printed.
if [ "$(id -u)" -eq 0 ] && [ -f "$ETC_DIR/registry.env" ] && [ -f "$ETC_DIR/bridge.env" ]; then
  reg=$(sed -n 's/^NCAA_REGISTRY_TOKEN=//p' "$ETC_DIR/registry.env" | tail -n 1)
  full=$(sed -n 's/^NCAA_BRIDGE_TOKEN=//p' "$ETC_DIR/bridge.env" | tail -n 1)
  if grep -q '^NCAA_BRIDGE_TOKEN=' "$ETC_DIR/registry.env"; then note "the game service is also given the full bridge token (registry.env has NCAA_BRIDGE_TOKEN). Only needed for Supersim results or the in-game Dynasty Wire"
  elif [ -n "$reg" ] && [ "$reg" = "$full" ]; then note "the game service uses the full bridge token for the member list. Safer: a REGISTRY_TOKEN on the site (README, \"The two tokens\")"
  elif [ -n "$reg" ]; then ok "the game service has its own read-only registry token"; fi
  unset reg full
fi
# each service runs as its own user
for pair in blaze:fcs-blaze redirector:fcs-redirector qos:fcs-qos dns:fcs-dns sync:fcs-sync; do
  s=${pair%%:*}; want=${pair##*:}; got=$(systemctl show -p User --value "fcs-league-$s.service" 2>/dev/null)
  if [ "$got" = "$want" ]; then ok "fcs-league-$s runs as $want"; else fail "fcs-league-$s runs as \"$got\", expected $want (run provision.sh again)"; fi
done

echo "Registry"
if [ "$(id -u)" -eq 0 ]; then
  line=$(journalctl -u fcs-league-blaze.service -n 400 --no-pager 2>/dev/null | grep -E '\[registry\]' | tail -n 1)
  if [ -n "$line" ]; then
    case "$line" in *"sync failed"*|*"rejected"*|*"WARNING"*) fail "${line#*] }" ;; *) ok "${line#*] }" ;; esac
  else fail "no registry message in the Blaze log yet"; fi
else echo "  (run with sudo to see the registry sync state)"; fi

echo "Storage and backups"
DATA=$(setting NCAA_PRIVATE /var/lib/fcs-league/private)
used=$(df --output=pcent "$DATA" 2>/dev/null | tail -n 1 | tr -dc '0-9')
if [ -n "$used" ]; then
  if [ "$used" -lt 90 ]; then ok "disk is ${used}% full"; else fail "disk is ${used}% full: free space or get a bigger disk (uploads are refused when the league's budget is reached)"; fi
fi
if [ "$(id -u)" -eq 0 ]; then
  # the last day only, so an old message does not stay on this list for ever
  line=$(journalctl -u fcs-league-blaze.service --since "24 hours ago" --no-pager 2>/dev/null | grep -E 'STORAGE FULL|previous good copy' | tail -n 1)
  [ -z "$line" ] || fail "in the last 24 hours: ${line#*] }"
  BK=/var/backups/fcs-league
  newest=$(find "$BK" -maxdepth 1 -type f -name 'fcs-league-*.tar.gz' -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -n 1)
  if [ -z "$newest" ]; then note "no backup yet (the first one is made at 09:15 UTC; or run backup.sh now)"
  else
    age=$(( ( $(date +%s) - ${newest%%.*} ) / 3600 ))
    if [ "$age" -le 49 ]; then ok "newest backup: ${newest#* } (${age} h old)"; else fail "newest backup is ${age} h old: ${newest#* }   (journalctl -u fcs-league-backup -n 30)"; fi
  fi
  if [ -f "$ETC_DIR/offsite.env" ] && grep -Eq '^FCS_OFFSITE=(on|ON|On|1|true|yes)[[:space:]]*$' "$ETC_DIR/offsite.env"; then
    if [ -s "$BK/.offsite-last" ]; then
      when=$(cut -d' ' -f1 "$BK/.offsite-last"); name=$(cut -d' ' -f2 "$BK/.offsite-last")
      age=$(( ( $(date +%s) - $(date -d "$when" +%s 2>/dev/null || echo 0) ) / 3600 ))
      if [ "$age" -le 49 ]; then ok "off-site copy: $name uploaded ${age} h ago"; else fail "off-site copy is on but the last upload was ${age} h ago   (journalctl -u fcs-league-offsite -n 30)"; fi
    else fail "off-site copy is on but nothing has been uploaded yet   (sudo $(dirname "$(readlink -f "$0")")/backup.sh --offsite-check)"; fi
  else note "off-site copy is off: the backups exist only on this server (see \"Off-site backups\" in the README)"; fi
else echo "  (run with sudo to see the backups)"; fi

if [ "$bad" -eq 0 ]; then echo "All good."; else echo "Something needs attention (see FAIL lines)."; fi
exit "$bad"
