#!/bin/bash
# Finds the OpenBot Team API port and writes the nginx upstream for it.
#
# The Team API listens on a free loopback port (src/main/listen-loopback.ts uses port 0), so the
# port changes on every daemon start. nginx must follow it. This script probes the openbot
# process for the loopback port that answers /v1/compatibility with 200, then writes the upstream
# file that nginx includes.
#
# Run from the openbot-watchdog timer or after a daemon restart.
set -uo pipefail

OUTPUT=/etc/nginx/upstream-openbot-team-api.conf
PROTOCOL_HEADER="OpenBot-Protocol-Version: 9"
APP_HEADER="OpenBot-App-Version: 0.68.0"

# Only ports owned by the openbot process can be the Team API. Collect them from the process
# table so a second server (opencode, sshd) on the same host cannot be mistaken for the API.
port=""
# The daemon binds the Team API after Electron finishes starting, which takes tens of seconds on
# a cold start. Retry until it appears instead of failing on the first miss.
for attempt in $(seq 1 30); do
  # Match the process name literally. A loose "pid=" match also catches the other servers on the
  # host (nginx on port 80, sshd, postgres), and nginx answering /v1/compatibility through this
  # very proxy makes the daemon look like it owns port 80. The daemon then proxies to itself.
  ports=$(ss -tlnp 2>/dev/null | grep -F '"openbot",pid=' \
    | awk '{print $4}' | sed 's/.*://' | sort -un)
  for p in $ports; do
    body=$(curl -s -m 3 -H "$PROTOCOL_HEADER" -H "$APP_HEADER" \
      "http://127.0.0.1:${p}/v1/compatibility" 2>/dev/null)
    # The Team API answers with a JSON object that carries appVersion and protocol. Anything
    # else (an HTML page, a plain error object) belongs to a different server. The status code
    # alone is not enough: the opencode server serves the WebUI index and returns that whole
    # page with 200 for any path.
    if printf '%s' "$body" | grep -q '"appVersion"'; then
      port="$p"
      break
    fi
  done
  if [ -n "$port" ]; then break; fi
  sleep 3
done

if [ -z "$port" ]; then
  echo "openbot-team-api: no Team API port answered /v1/compatibility with an appVersion body" >&2
  exit 1
fi

cat > "$OUTPUT" <<EOF
# Written by openbot-team-api-port.sh. The Team API listens on a free loopback port, so nginx
# follows it. Do not edit by hand.
upstream openbot_team_api {
    server 127.0.0.1:${port};
}
EOF

# Reload nginx only when the port changed, so a repeat run does not churn the workers.
if ! cmp -s "$OUTPUT" "$OUTPUT.prev"; then
  cp "$OUTPUT" "$OUTPUT.prev"
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "openbot-team-api: nginx now proxies /v1/ to 127.0.0.1:${port}"
  else
    echo "openbot-team-api: nginx config test failed, keeping the old upstream" >&2
    exit 1
  fi
else
  echo "openbot-team-api: upstream unchanged, 127.0.0.1:${port}"
fi
