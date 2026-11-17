#!/usr/bin/env bash
# Firewall for the FCS league server: deny everything coming in except SSH and the ports the game uses.
# Run as root. Safe to run again. provision.sh runs it for you.
#
#   22/tcp        SSH (rate limited)
#   42127/tcp     redirector: the first address a console asks
#   33152/tcp     Blaze: logins and dynasties
#   17503/tcp     Locker: dynasty and team file upload/download
#   17502/tcp     QoS over HTTP
#   17502/udp     QoS ping/bandwidth probes
#   17500/udp     QoS firewall probe 1
#   17501/udp     QoS firewall probe 2
#   53/udp        name service for real consoles (a PS3 set to use this server as its DNS), unless NCAA_DNS=off
#   17504/tcp     in-game Dynasty Wire (Sports World), unless NCAA_EASW=off in /etc/fcs-league/league.env
#                 (on, 1, true or yes: the same words the server takes; anything that is not on or off is an error
#                 here and in the server, never a silent "off")
#
# Your cloud provider usually has its own firewall ("security group", "firewall rules") in front of the VM.
# Open the same ports there.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo bash firewall.sh" >&2; exit 1; }
command -v ufw >/dev/null 2>&1 || { echo "ufw is not installed (apt-get install ufw)" >&2; exit 1; }

ENV_FILE=/etc/fcs-league/league.env
setting() { # setting NAME DEFAULT: the value in league.env, or the default
  local v=""
  [ -r "$ENV_FILE" ] && v=$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r')
  printf '%s' "${v:-$2}"
}
REDIRECTOR=$(setting NCAA_REDIRECTOR_PORT 42127)
BLAZE=$(setting NCAA_BLAZE_PORT 33152)
LOCKER=$(setting NCAA_LOCKER_PORT 17503)
EASW_PORT=$(setting NCAA_EASW_PORT 17504)
QOS=$(setting NCAA_QOS_PORT 17502)
FW1=$(setting NCAA_QOS_FW1 17500)
FW2=$(setting NCAA_QOS_FW2 17501)
EASW=$(setting NCAA_EASW on)
DNS_PORT=$(setting NCAA_DNS_PORT 53)
DNS=$(setting NCAA_DNS on)
for p in "$REDIRECTOR" "$BLAZE" "$LOCKER" "$EASW_PORT" "$QOS" "$FW1" "$FW2" "$DNS_PORT"; do
  case "$p" in ''|*[!0-9]*) echo "bad port number in $ENV_FILE: $p" >&2; exit 1 ;; esac
done

# on/off exactly as the server reads it (cloud-config.mjs parseSwitch), so the port and the service always agree
case "$(printf '%s' "$EASW" | tr 'A-Z' 'a-z' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" in
  on|1|true|yes) EASW_ON=1 ;;
  off|0|false|no|'') EASW_ON=0 ;;
  *) echo "NCAA_EASW in $ENV_FILE must be on or off, found: $EASW (nothing may follow the value, not even a comment)" >&2; exit 1 ;;
esac

ufw default deny incoming
ufw default allow outgoing
# the port sshd really listens on (22 unless you changed it), so turning the firewall on cannot lock you out
# awk reads to the end: leaving early would kill sshd -T with SIGPIPE, which pipefail turns into a failed script
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port / && !p {p=$2} END {print p}' || true)
case "${SSH_PORT:-}" in ''|*[!0-9]*) SSH_PORT=22 ;; esac
ufw limit "$SSH_PORT/tcp" comment 'SSH'
ufw allow "$REDIRECTOR/tcp" comment 'FCS league redirector'
ufw allow "$BLAZE/tcp" comment 'FCS league Blaze'
ufw allow "$LOCKER/tcp" comment 'FCS league Locker'
ufw allow "$QOS/tcp" comment 'FCS league QoS http'
ufw allow "$QOS/udp" comment 'FCS league QoS probes'
ufw allow "$FW1/udp" comment 'FCS league QoS firewall probe 1'
ufw allow "$FW2/udp" comment 'FCS league QoS firewall probe 2'
if [ "$EASW_ON" -eq 1 ]; then
  ufw allow "$EASW_PORT/tcp" comment 'FCS league Dynasty Wire'
else
  ufw delete allow "$EASW_PORT/tcp" >/dev/null 2>&1 || true
fi
case "$(printf '%s' "$DNS" | tr 'A-Z' 'a-z' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" in
  on|1|true|yes) ufw allow "$DNS_PORT/udp" comment 'FCS league console name service' ;;
  off|0|false|no|'') ufw delete allow "$DNS_PORT/udp" >/dev/null 2>&1 || true ;;
  *) echo "NCAA_DNS in $ENV_FILE must be on or off, found: $DNS" >&2; exit 1 ;;
esac
ufw --force enable
ufw status verbose
