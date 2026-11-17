#!/usr/bin/env bash
# Tests the part of check.sh that confirms cloud mode from the service logs, and its token and user checks.
# systemctl, journalctl and friends are stand-ins: nothing on this machine is touched.
#   bash deploy/league-server/tests/check.test.sh
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CHECK="$HERE/../check.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; exit 1; }

mkdir -p "$T/bin" "$T/etc"
export FCS_ETC_DIR="$T/etc" FAKE="$T/fake"
mkdir -p "$FAKE"
# stand-ins. "id -u" says root so the log checks run; each service's log is the file $FAKE/<service>.log
cat > "$T/bin/id" <<'SHIM'
#!/usr/bin/env bash
if [ "${1:-}" = "-u" ]; then echo 0; else /usr/bin/id "$@"; fi
SHIM
cat > "$T/bin/systemctl" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  is-active) exit 0 ;;
  show)
    unit=${!#}; name=${unit#fcs-league-}; name=${name%.service}
    case "$*" in
      *InvocationID*) echo "inv-$name" ;;
      *User*) cat "$FAKE/$name.user" 2>/dev/null ;;
    esac ;;
esac
SHIM
cat > "$T/bin/journalctl" <<'SHIM'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in _SYSTEMD_INVOCATION_ID=inv-*) cat "$FAKE/${a#_SYSTEMD_INVOCATION_ID=inv-}.log" 2>/dev/null; exit 0 ;; esac; done
cat "$FAKE/blaze.log" 2>/dev/null
SHIM
for tool in ss curl getent df find; do printf '#!/usr/bin/env bash\nexit 1\n' > "$T/bin/$tool"; done
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

setup() { # setup CLOUD_LINE: a healthy server, with league.env's NCAA_CLOUD line as given
  printf '%s\nNCAA_PUBLIC_HOST=play.example.org\n' "$1" > "$FCS_ETC_DIR/league.env"
  printf 'NCAA_BRIDGE_TOKEN=full-secret-value\n' > "$FCS_ETC_DIR/bridge.env"
  printf 'NCAA_REGISTRY_TOKEN=registry-secret-value\n' > "$FCS_ETC_DIR/registry.env"
  chmod 600 "$FCS_ETC_DIR/bridge.env" "$FCS_ETC_DIR/registry.env"
  for s in blaze redirector qos; do printf '2026-11-15T00:00:00.000Z [%s] capture file: (off)\n2026-11-15T00:00:00.001Z [%s] mode: cloud (member list required, limits on)\n' "$s" "$s" > "$FAKE/$s.log"; done
  printf '2026-11-15T00:00:01.000Z [registry] registry updated from the site: 3 player(s), 0 disabled\n' >> "$FAKE/blaze.log"
  for pair in blaze:fcs-blaze redirector:fcs-redirector qos:fcs-qos dns:fcs-dns sync:fcs-sync; do printf '%s\n' "${pair##*:}" > "$FAKE/${pair%%:*}.user"; done
}
run() { out=$(bash "$CHECK" 2>&1); }
has() { grep -qF -- "$1" <<<"$out"; }

echo "Cloud mode is confirmed from the log"
setup 'NCAA_CLOUD=1'; run
has "ok    NCAA_CLOUD is on in" || fail "the setting was not accepted: $out"
for s in blaze redirector qos; do has "ok    fcs-league-$s started in cloud mode" || fail "no cloud-mode confirmation for $s: $out"; done
ok "three services report cloud mode"
has "ok    the game service has its own read-only registry token" || fail "registry token line missing: $out"
for u in fcs-blaze fcs-redirector fcs-qos fcs-dns fcs-sync; do has "runs as $u" || fail "no user line for $u: $out"; done
ok "each service runs as its own user, and the game service has the registry token"
if grep -q -- 'secret-value' <<<"$out"; then fail "a token value was printed"; fi
ok "no token value is ever printed"

echo "A server that started in local mode is reported"
setup 'NCAA_CLOUD=1 # public server'
printf '2026-11-15T00:00:00.001Z [blaze] mode: local (no member list: anyone who can connect can sign in)\n' > "$FAKE/blaze.log"
run
has "FAIL  NCAA_CLOUD is not on" || fail "a value with a note after it was accepted: $out"
has "FAIL  fcs-league-blaze is running in LOCAL mode" || fail "local mode was not reported: $out"
has "Something needs attention" || fail "the summary did not flag it: $out"
ok "a trailing note on NCAA_CLOUD and a local-mode start are both FAIL lines"

echo "No mode line at all"
setup 'NCAA_CLOUD=1'; printf '2026-11-15T00:00:00.000Z [qos] something else\n' > "$FAKE/qos.log"; run
has "FAIL  cannot confirm from the log that fcs-league-qos is in cloud mode" || fail "a missing mode line was not reported: $out"
has "ok    fcs-league-blaze started in cloud mode" || fail "the other services should still be confirmed: $out"
ok "a service with no mode line since it started is a FAIL line"

echo "Tokens and users"
setup 'NCAA_CLOUD=1'; printf 'NCAA_REGISTRY_TOKEN=full-secret-value\n' > "$FCS_ETC_DIR/registry.env"; chmod 600 "$FCS_ETC_DIR/registry.env"; run
has "note  the game service uses the full bridge token for the member list" || fail "reusing the bridge token was not pointed out: $out"
setup 'NCAA_CLOUD=1'; printf 'NCAA_BRIDGE_TOKEN=full-secret-value\n' >> "$FCS_ETC_DIR/registry.env"; run
has "note  the game service is also given the full bridge token" || fail "the full token in registry.env was not pointed out: $out"
setup 'NCAA_CLOUD=1'; chmod 644 "$FCS_ETC_DIR/registry.env"; run
has "FAIL  registry token file permissions are 644" || fail "a readable token file was not reported: $out"
setup 'NCAA_CLOUD=1'; printf 'fcsleague\n' > "$FAKE/qos.user"; run
has 'FAIL  fcs-league-qos runs as "fcsleague", expected fcs-qos' || fail "a shared service user was not reported: $out"
setup 'NCAA_CLOUD=1'; printf '2026-11-15T06:00:00.000Z [registry] WARNING: the member list has not been confirmed with the site for 7 hours\n' >> "$FAKE/blaze.log"; run
has "FAIL  WARNING: the member list has not been confirmed" || fail "an old member list was not reported: $out"
ok "token reuse, a readable token file, a shared user and an old member list are all reported"

echo "All $pass checks passed."
