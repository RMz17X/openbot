#!/bin/bash
# Verifies that the headless OpenBot WebUI works end to end and prints one PASS/FAIL line per
# check. The exit code is 0 only when every check passed.
#
# The sign-in check reads the local owner password from the container at the moment of use and
# never prints it. The password is not written to a log, not echoed, and not passed on a command
# line that another process could read.
#
# The Team API rate limit counts 5 sign-in attempts per 15 minutes per source address and user
# name, and it lives in the daemon's memory, so a daemon restart clears it. Three things follow:
#
#   - This script signs in once and never retries the sign-in. A retry would spend an attempt for
#     nothing.
#   - The sign-in goes straight to the Team API with the container's own address as the source,
#     so it has a rate-limit bucket of its own and does not spend the budget a signed-in browser
#     is using.
#   - The session token is cached on the host, so a second run reuses the token and spends no
#     sign-in attempt at all. Without the cache, running this script five times inside fifteen
#     minutes would lock the local owner out.
#
# `set -e` is deliberately not used here. The point of this script is to report every broken check
# in one run, and `set -e` would abort on the first failure instead of naming the rest.
set -uo pipefail

CONTAINER="${OPENBOT_CONTAINER:-openbot-vm}"
HOST_URL="${OPENBOT_URL:-http://100.81.73.83:28420}"

PROTOCOL_VERSION="9"
APP_VERSION="0.68.0"
OWNER_USERNAME="${OPENBOT_OWNER_USERNAME:-rickicode}"
PRESENCE_EMAIL="${OPENBOT_PRESENCE_EMAIL:-rickicode@gmail.com}"

PASSWORD_FILE_IN_CONTAINER="/home/openbot/.config/OpenBot/webui-password"
UPSTREAM_FILE_IN_CONTAINER="/etc/nginx/upstream-openbot-team-api.conf"

# The cached session token. It is mode 0600 and holds a session token, not the password: the
# token only works for the routes the script reads.
TOKEN_CACHE="${OPENBOT_TOKEN_CACHE:-${HOME}/.cache/openbot/verify-webui.token}"

# The address the container sends its own requests from. It keeps the verification sign-in out of
# the bucket a browser uses.
CONTAINER_ADDRESS=""

PASSED=0
FAILED=0
SESSION_TOKEN=""
TEAM_API_PORT=""

pass() { PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$1"; }
info() { printf '      %s\n' "$1"; }

section() { printf '\n== %s\n' "$1"; }

# Runs a command inside the container and prints its output.
in_container() {
  incus exec "${CONTAINER}" -- bash -lc "$1" 2>&1
}

# The port the Team API listens on, as the nginx upstream file names it.
team_api_port() {
  incus exec "${CONTAINER}" -- bash -lc \
    "awk '/^[[:space:]]*server[[:space:]]+127\\.0\\.0\\.1:/ { split(\$0, parts, \":\"); gsub(/;/, \"\", parts[2]); print parts[2]; exit }' '${UPSTREAM_FILE_IN_CONTAINER}'" \
    2>/dev/null | tr -d '[:space:]'
}

# The address of the container on its own network. A request sent from it reaches the daemon
# with that address as its source, which is a rate-limit bucket of its own.
container_address() {
  in_container "ip -4 -o addr show dev eth0 scope global 2>/dev/null | awk '{ split(\$4, part, \"/\"); print part[1]; exit }'" \
    | tr -d '[:space:]'
}

# --- 1. the daemon ----------------------------------------------------------------------------

section "1. openbot.service is active"

if in_container "systemctl is-active --quiet openbot.service"; then
  STATE="$(in_container "systemctl show openbot.service -p SubState --value")"
  pass "openbot.service is active (${STATE})"
else
  fail "openbot.service is not active"
  info "run: incus exec ${CONTAINER} -- systemctl status openbot.service"
fi

# --- 2. nginx ---------------------------------------------------------------------------------

section "2. nginx.service is active"

if in_container "systemctl is-active --quiet nginx.service"; then
  pass "nginx.service is active"
else
  fail "nginx.service is not active"
fi

# --- 3. the Team API port and the compatibility route -------------------------------------------

section "3. the Team API port probe resolves and /v1/compatibility answers"

TEAM_API_PORT="$(team_api_port)"
CONTAINER_ADDRESS="$(container_address)"

if [ -z "${TEAM_API_PORT}" ]; then
  fail "the nginx upstream file names no Team API port"
  info "run: incus exec ${CONTAINER} -- /usr/local/bin/openbot-team-api-port.sh"
else
  # Two paths are checked: the Team API itself, and the reverse proxy the browser uses. A port
  # that answers while the proxy cannot reach it is still a broken WebUI.
  DIRECT_BODY="$(in_container "
    curl -s -m 10 --interface '${CONTAINER_ADDRESS:-127.0.0.1}' \
      -H 'OpenBot-Protocol-Version: ${PROTOCOL_VERSION}' \
      -H 'OpenBot-App-Version: ${APP_VERSION}' \
      'http://127.0.0.1:${TEAM_API_PORT}/v1/compatibility' 2>/dev/null || true")"
  PROXY_BODY="$(curl -s -m 10 \
    -H "OpenBot-Protocol-Version: ${PROTOCOL_VERSION}" \
    -H "OpenBot-App-Version: ${APP_VERSION}" \
    "${HOST_URL}/v1/compatibility" || true)"
  PROXY_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' \
    -H "OpenBot-Protocol-Version: ${PROTOCOL_VERSION}" \
    -H "OpenBot-App-Version: ${APP_VERSION}" \
    "${HOST_URL}/v1/compatibility" || true)"

  if printf '%s' "${DIRECT_BODY}" | grep -q '"appVersion"'; then
    pass "the Team API on 127.0.0.1:${TEAM_API_PORT} answers /v1/compatibility with an appVersion body"
  else
    fail "the Team API on 127.0.0.1:${TEAM_API_PORT} did not answer /v1/compatibility with an appVersion body"
  fi

  if [ "${PROXY_CODE}" = "200" ] && printf '%s' "${PROXY_BODY}" | grep -q '"appVersion"'; then
    pass "the reverse proxy at ${HOST_URL} answers /v1/compatibility with 200"
  else
    fail "the reverse proxy at ${HOST_URL} answered ${PROXY_CODE:-no response} without an appVersion body"
  fi
fi

# --- 4. the sign-in ----------------------------------------------------------------------------

section "4. the local owner signs in"

# A cached token is tried first. It costs no sign-in attempt, so a repeat run of this script
# cannot lock the local owner out. A token that no longer works is dropped and a fresh sign-in
# is made.
if [ -r "${TOKEN_CACHE}" ]; then
  CACHED_TOKEN="$(tr -d '[:space:]' < "${TOKEN_CACHE}")"
  CACHED_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${CACHED_TOKEN}" \
    -H "OpenBot-Protocol-Version: ${PROTOCOL_VERSION}" -H "OpenBot-App-Version: ${APP_VERSION}" \
    "${HOST_URL}/v1/me" || true)"
  if [ "${CACHED_CODE}" = "200" ]; then
    SESSION_TOKEN="${CACHED_TOKEN}"
    pass "the local owner ${OWNER_USERNAME} is signed in with the cached session token"
  else
    rm -f "${TOKEN_CACHE}"
    info "the cached session token no longer works; signing in again"
  fi
fi

# The password is read inside the container and goes straight into the request body. It is never
# printed, never stored in a file on the host, and never passed as a command line argument.
if [ -z "${SESSION_TOKEN}" ]; then
  LOGIN_RESULT="$(in_container "
    set -uo pipefail
    if [ ! -r '${PASSWORD_FILE_IN_CONTAINER}' ]; then
      echo 'NO_PASSWORD_FILE'
      exit 0
    fi
    password=\$(cat '${PASSWORD_FILE_IN_CONTAINER}')
    body=\$(jq -n --arg u '${OWNER_USERNAME}' --arg p \"\$password\" '{username: \$u, password: \$p}')
    unset password
    response=\$(curl -s -m 15 -w '\n%{http_code}' \
      --interface '${CONTAINER_ADDRESS:-127.0.0.1}' \
      -X POST 'http://127.0.0.1:${TEAM_API_PORT}/v1/auth/login' \
      -H 'Content-Type: application/json' \
      -H 'OpenBot-Protocol-Version: ${PROTOCOL_VERSION}' \
      -H 'OpenBot-App-Version: ${APP_VERSION}' \
      --data-binary \"\$body\")
    code=\$(printf '%s' \"\$response\" | tail -n 1)
    json=\$(printf '%s' \"\$response\" | head -n -1)
    token=\$(printf '%s' \"\$json\" | jq -r '.sessionToken // empty' 2>/dev/null || true)
    if [ \"\$code\" = '200' ] && [ -n \"\$token\" ]; then
      echo \"TOKEN:\$token\"
    else
      echo \"LOGIN_FAILED:\$code\"
    fi
  ")"

  case "${LOGIN_RESULT}" in
    TOKEN:*)
      SESSION_TOKEN="${LOGIN_RESULT#TOKEN:}"
      pass "the local owner ${OWNER_USERNAME} signed in and got a session token"
      # The token is cached so the next run spends no sign-in attempt. It is a session token,
      # not the password, and it is written mode 0600.
      mkdir -p "$(dirname "${TOKEN_CACHE}")" 2>/dev/null || true
      ( umask 077 && printf '%s' "${SESSION_TOKEN}" > "${TOKEN_CACHE}" ) 2>/dev/null || true
      ;;
    NO_PASSWORD_FILE)
      fail "the password file ${PASSWORD_FILE_IN_CONTAINER} is missing or unreadable in ${CONTAINER}"
      ;;
    LOGIN_FAILED:429)
      fail "the sign-in was rate limited (429); the limit is 5 attempts per 15 minutes per address and it lives in the daemon's memory"
      info "wait for the window, or restart openbot.service to clear the in-memory counter"
      ;;
    LOGIN_FAILED:*)
      fail "the sign-in failed with HTTP ${LOGIN_RESULT#LOGIN_FAILED:}"
      ;;
    *)
      fail "the sign-in check could not run"
      ;;
  esac
fi

# --- 5. the authenticated routes ----------------------------------------------------------------

section "5. the authenticated Team API routes answer"

if [ -z "${SESSION_TOKEN}" ]; then
  fail "/v1/me was not checked (no session token)"
  fail "/v1/agents was not checked (no session token)"
  fail "/v1/team/members was not checked (no session token)"
else
  # These routes go through the reverse proxy, which is the path a browser takes. Only the
  # sign-in is rate limited, so they are free to repeat.
  AUTH_HEADER="Authorization: Bearer ${SESSION_TOKEN}"

  ME_CODE="$(curl -s -m 10 -o /tmp/openbot-verify-me.json -w '%{http_code}' \
    -H "${AUTH_HEADER}" -H "OpenBot-Protocol-Version: ${PROTOCOL_VERSION}" -H "OpenBot-App-Version: ${APP_VERSION}" \
    "${HOST_URL}/v1/me" || true)"
  if [ "${ME_CODE}" = "200" ]; then
    pass "/v1/me answers 200"
  else
    fail "/v1/me answered ${ME_CODE:-no response}"
  fi

  AGENTS_CODE="$(curl -s -m 15 -o /tmp/openbot-verify-agents.json -w '%{http_code}' \
    -H "${AUTH_HEADER}" -H "OpenBot-Protocol-Version: ${PROTOCOL_VERSION}" -H "OpenBot-App-Version: ${APP_VERSION}" \
    "${HOST_URL}/v1/agents" || true)"
  if [ "${AGENTS_CODE}" = "200" ] && jq -e 'type == "array" and length > 0' /tmp/openbot-verify-agents.json >/dev/null 2>&1; then
    pass "/v1/agents answers 200 with a non-empty agent list ($(jq -r 'length' /tmp/openbot-verify-agents.json) agents)"
  else
    fail "/v1/agents answered ${AGENTS_CODE:-no response} without a non-empty agent list"
  fi

  MEMBERS_CODE="$(curl -s -m 10 -o /tmp/openbot-verify-members.json -w '%{http_code}' \
    -H "${AUTH_HEADER}" -H "OpenBot-Protocol-Version: ${PROTOCOL_VERSION}" -H "OpenBot-App-Version: ${APP_VERSION}" \
    "${HOST_URL}/v1/team/members" || true)"
  if [ "${MEMBERS_CODE}" = "200" ]; then
    pass "/v1/team/members answers 200"
  else
    fail "/v1/team/members answered ${MEMBERS_CODE:-no response}"
  fi
fi

# --- 6. the presence route ---------------------------------------------------------------------

section "6. /v1/team/presence lists the companion account as online"

if [ -z "${SESSION_TOKEN}" ]; then
  fail "/v1/team/presence was not checked (no session token)"
else
  PRESENCE_CODE="$(curl -s -m 10 -o /tmp/openbot-verify-presence.json -w '%{http_code}' \
    -H "Authorization: Bearer ${SESSION_TOKEN}" \
    -H "OpenBot-Protocol-Version: ${PROTOCOL_VERSION}" \
    -H "OpenBot-App-Version: ${APP_VERSION}" \
    "${HOST_URL}/v1/team/presence" || true)"
  if [ "${PRESENCE_CODE}" != "200" ]; then
    fail "/v1/team/presence answered ${PRESENCE_CODE:-no response}"
  elif jq -e --arg email "${PRESENCE_EMAIL}" \
      'any(.members[]?; (.email == $email or .username == $email) and .online == true)' \
      /tmp/openbot-verify-presence.json >/dev/null 2>&1; then
    pass "/v1/team/presence lists ${PRESENCE_EMAIL} as online"
  else
    fail "/v1/team/presence does not list ${PRESENCE_EMAIL} as online"
    info "the Android companion app shows as offline when the daemon's cloud connection is down"
  fi
fi

# --- 7. the outbound cloud connection -----------------------------------------------------------

section "7. the daemon holds its outbound TLS connection to the cloud"

# The connection is checked by the certificate the peer presents, not by the address it comes
# from: the account service sits behind a CDN whose addresses move. A connection to a peer whose
# certificate covers openbot.run is a connection to the cloud.
CLOUD_CHECK="$(in_container "
  set -uo pipefail
  peers=\$(ss -tnpH state established 2>/dev/null | grep -F 'openbot' | awk '{for(i=1;i<=NF;i++) if (\$i ~ /:443\$/) print \$i}' | sed -E 's/^\\[?([0-9a-fA-F:.]+)\\]?:443\$/\\1/' | sort -u)
  if [ -z \"\$peers\" ]; then
    echo 'NO_PEERS'
    exit 0
  fi
  for peer in \$peers; do
    san=\$(timeout 8 openssl s_client -connect \"\$peer:443\" -servername api.openbot.run </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null)
    case \"\$san\" in
      *openbot.run*)
        echo \"CLOUD_CONNECTED:\$peer\"
        exit 0
        ;;
    esac
  done
  echo 'NO_CLOUD_PEER'
")"

case "${CLOUD_CHECK}" in
  CLOUD_CONNECTED:*)
    pass "the daemon holds a TLS connection to the openbot.run cloud (${CLOUD_CHECK#CLOUD_CONNECTED:})"
    ;;
  NO_PEERS)
    fail "the openbot process holds no outbound connection on port 443"
    ;;
  NO_CLOUD_PEER)
    fail "the daemon holds no TLS connection to a peer whose certificate covers openbot.run"
    info "the Android companion app cannot reach the host while this is down"
    ;;
  *)
    fail "the outbound connection check could not run"
    ;;
esac

# --- 8. the static WebUI -----------------------------------------------------------------------

section "8. the static WebUI is served"

INDEX_BODY="$(curl -s -m 10 "${HOST_URL}/" || true)"
INDEX_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${HOST_URL}/" || true)"
if [ "${INDEX_CODE}" != "200" ]; then
  fail "GET / answered ${INDEX_CODE:-no response} at ${HOST_URL}"
else
  # The page names the entry chunk it loads. The bundle is served from the same host, so the
  # asset must be there too.
  ASSET_REF="$(printf '%s' "${INDEX_BODY}" | grep -oE 'assets/[A-Za-z0-9._-]+\.(js|css)' | head -1 || true)"
  if [ -z "${ASSET_REF}" ]; then
    fail "GET / answered 200 but the page names no asset bundle"
  else
    ASSET_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${HOST_URL}/${ASSET_REF}" || true)"
    if [ "${ASSET_CODE}" = "200" ]; then
      pass "GET / answers 200 and the page loads ${ASSET_REF}"
    else
      fail "the page names ${ASSET_REF} but that asset answered ${ASSET_CODE:-no response}"
      info "the served page and the deployed bundle are out of step; run ./deploy/deploy-webui.sh"
    fi
  fi
fi

# --- Result ------------------------------------------------------------------------------------

printf '\n'
if [ "${FAILED}" -eq 0 ]; then
  printf 'RESULT: PASS (%d checks)\n' "${PASSED}"
  printf 'The WebUI is at %s\n' "${HOST_URL}"
  exit 0
fi

printf 'RESULT: FAIL (%d passed, %d failed)\n' "${PASSED}" "${FAILED}"
exit 1
