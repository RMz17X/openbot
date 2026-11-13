#!/bin/bash
# Verifies the sign-in rate limit on the running daemon in openbot-vm.
#
# The Team API counts sign-in attempts per client address and user name, five attempts per 15
# minutes. The daemon listens on a loopback port, so the client address is the one the reverse
# proxy names in X-Real-IP or X-Forwarded-For. This script sends the wrong sign-ins with its own
# X-Real-IP, so it never spends the budget of a real browser, and it checks that a different
# client address is not blocked by them.
#
# The password is read inside the container at the moment of use. It is never printed and never
# passed on a command line.
#
# What this script does not cover: the address the public tunnel and the LAN address share. The
# Incus proxy device that publishes the container connects from inside the container, so nginx
# sees 127.0.0.1 as the client for every caller. X-Real-IP and the last entry of X-Forwarded-For
# are therefore 127.0.0.1 on every path, and those two paths share one bucket. Separating them
# needs the proxy chain to name the real client, which is a change to the proxy, not to the
# daemon. See the comment in src/main/team-api/request-helpers.ts.
set -uo pipefail

CONTAINER="${OPENBOT_CONTAINER:-openbot-vm}"
PASSWORD_FILE_IN_CONTAINER="/home/openbot/.config/OpenBot/webui-password"
OWNER_USERNAME="${OPENBOT_OWNER_USERNAME:-rickicode}"
PROTOCOL_VERSION="9"
APP_VERSION="0.68.0"

# A throwaway user name. The attempts below are wrong ones, so this member never has to exist:
# the rate limit counts the attempt before the password is checked.
PROBE_USER="ratelimit-probe-$$"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$1"; }
info() { printf '      %s\n' "$1"; }

in_container() { incus exec "${CONTAINER}" -- bash -lc "$1" 2>&1; }

team_api_port() {
  in_container "awk '/^[[:space:]]*server[[:space:]]+127\\.0\\.0\\.1:/ { split(\$0, parts, \":\"); gsub(/;/, \"\", parts[2]); print parts[2]; exit }' /etc/nginx/upstream-openbot-team-api.conf" \
    | tr -d '[:space:]'
}

printf '== 1. the Team API port and a correct sign-in\n'
TEAM_API_PORT="$(team_api_port)"
if [ -z "${TEAM_API_PORT}" ]; then
  fail "the nginx upstream file names no Team API port"
  exit 1
fi
info "the Team API is on 127.0.0.1:${TEAM_API_PORT}"

# A daemon that just restarted needs a moment before the Team API binds its port. The wait is
# here, before the first sign-in, because a sign-in must not be retried: a retry would spend an
# attempt of the rate-limit budget. The compatibility route costs no attempt.
WAIT_TRIES=0
while [ "${WAIT_TRIES}" -lt 12 ]; do
  READY="$(in_container "
    curl -s -m 5 \
      -H 'OpenBot-Protocol-Version: ${PROTOCOL_VERSION}' \
      -H 'OpenBot-App-Version: ${APP_VERSION}' \
      'http://127.0.0.1:${TEAM_API_PORT}/v1/compatibility' 2>/dev/null || true")"
  if printf '%s' "${READY}" | grep -q '"appVersion"'; then
    break
  fi
  WAIT_TRIES=$((WAIT_TRIES + 1))
  sleep 5
done
if [ "${WAIT_TRIES}" -ge 12 ]; then
  fail "the Team API did not answer within 60 seconds"
  exit 1
fi

# The sign-in goes straight to the Team API on the loopback port, with the client address in
# X-Real-IP. The proxy is bypassed on purpose: the proxy adds a header of its own, and this
# script needs to name the client address itself.
login() {
  # $1 is the client address, $2 is the user name, $3 is the password, $4 is the header name.
  in_container "
    set -uo pipefail
    password=\$(cat '${PASSWORD_FILE_IN_CONTAINER}' 2>/dev/null || echo '')
    body=\$(jq -n --arg u '$2' --arg p '$3' '{username: \$u, password: \$p}')
    response=\$(curl -s -m 15 -w '\n%{http_code}' \
      -X POST 'http://127.0.0.1:${TEAM_API_PORT}/v1/auth/login' \
      -H 'Content-Type: application/json' \
      -H 'OpenBot-Protocol-Version: ${PROTOCOL_VERSION}' \
      -H 'OpenBot-App-Version: ${APP_VERSION}' \
      -H \"$4: $1\" \
      --data-binary \"\$body\")
    unset password
    printf '%s' \"\$response\" | tail -n 1
  "
}

# A correct sign-in with the real owner password. The password never leaves the container.
OWNER_LOGIN="$(in_container "
  set -uo pipefail
  if [ ! -r '${PASSWORD_FILE_IN_CONTAINER}' ]; then echo 'NO_PASSWORD_FILE'; exit 0; fi
  password=\$(cat '${PASSWORD_FILE_IN_CONTAINER}')
  body=\$(jq -n --arg u '${OWNER_USERNAME}' --arg p \"\$password\" '{username: \$u, password: \$p}')
  unset password
  response=\$(curl -s -m 15 -w '\n%{http_code}' \
    -X POST 'http://127.0.0.1:${TEAM_API_PORT}/v1/auth/login' \
    -H 'Content-Type: application/json' \
    -H 'OpenBot-Protocol-Version: ${PROTOCOL_VERSION}' \
    -H 'OpenBot-App-Version: ${APP_VERSION}' \
    -H 'X-Real-IP: 198.51.100.10' \
    --data-binary \"\$body\")
  code=\$(printf '%s' \"\$response\" | tail -n 1)
  json=\$(printf '%s' \"\$response\" | head -n -1)
  token=\$(printf '%s' \"\$json\" | jq -r '.sessionToken // empty' 2>/dev/null || true)
  if [ \"\$code\" = '200' ] && [ -n \"\$token\" ]; then echo \"OK:\$token\"; else echo \"FAIL:\$code\"; fi
")"

case "${OWNER_LOGIN}" in
  OK:*)
    SESSION_TOKEN="${OWNER_LOGIN#OK:}"
    pass "the local owner ${OWNER_USERNAME} signed in and got a session token"
    ;;
  NO_PASSWORD_FILE)
    fail "the password file ${PASSWORD_FILE_IN_CONTAINER} is missing or unreadable in ${CONTAINER}"
    exit 1
    ;;
  *)
    fail "the sign-in failed with HTTP ${OWNER_LOGIN#FAIL:}"
    exit 1
    ;;
esac

printf '\n== 2. /v1/me answers with the same token\n'
ME_CODE="$(in_container "curl -s -m 15 -o /dev/null -w '%{http_code}' \
  -H 'OpenBot-Protocol-Version: ${PROTOCOL_VERSION}' \
  -H 'OpenBot-App-Version: ${APP_VERSION}' \
  -H 'Authorization: Bearer ${SESSION_TOKEN}' \
  'http://127.0.0.1:${TEAM_API_PORT}/v1/me'")"
if [ "${ME_CODE}" = "200" ]; then
  pass "/v1/me answers 200 with the session token"
else
  fail "/v1/me answered ${ME_CODE}"
fi

printf '\n== 3. six wrong sign-ins from one client address\n'
WRONG_ADDRESS="198.51.100.20"
WRONG_CODES=""
for attempt in 1 2 3 4 5 6; do
  code="$(login "${WRONG_ADDRESS}" "${PROBE_USER}" "wrong-password-for-the-probe" "X-Real-IP")"
  WRONG_CODES="${WRONG_CODES}${code} "
done
info "wrong sign-ins from ${WRONG_ADDRESS}: ${WRONG_CODES}"
if [ "$(printf '%s' "${WRONG_CODES}" | tr ' ' '\n' | grep -c '^400$')" = "5" ] \
  && [ "$(printf '%s' "${WRONG_CODES}" | tr ' ' '\n' | grep -c '^429$')" = "1" ]; then
  pass "the first five wrong sign-ins give 400 and the sixth gives 429"
else
  fail "the wrong sign-ins did not give five 400 and one 429"
fi

printf '\n== 4. a correct sign-in from another client address\n'
# The password is read inside the container, so the correct sign-in is run there as well.
OTHER_CODE="$(in_container "
  set -uo pipefail
  password=\$(cat '${PASSWORD_FILE_IN_CONTAINER}')
  body=\$(jq -n --arg u '${OWNER_USERNAME}' --arg p \"\$password\" '{username: \$u, password: \$p}')
  unset password
  curl -s -m 15 -o /dev/null -w '%{http_code}' \
    -X POST 'http://127.0.0.1:${TEAM_API_PORT}/v1/auth/login' \
    -H 'Content-Type: application/json' \
    -H 'OpenBot-Protocol-Version: ${PROTOCOL_VERSION}' \
    -H 'OpenBot-App-Version: ${APP_VERSION}' \
    -H 'X-Real-IP: 198.51.100.21' \
    --data-binary \"\$body\"
")"
if [ "${OTHER_CODE}" = "200" ]; then
  pass "a correct sign-in from 198.51.100.21 answers 200, not 429"
else
  fail "a correct sign-in from 198.51.100.21 answered ${OTHER_CODE}, not 200"
fi

printf '\n== 5. the blocked address is still blocked\n'
BLOCKED_CODE="$(login "${WRONG_ADDRESS}" "${PROBE_USER}" "wrong-password-for-the-probe" "X-Real-IP")"
if [ "${BLOCKED_CODE}" = "429" ]; then
  pass "the address that spent the budget is still blocked"
else
  fail "the address that spent the budget answered ${BLOCKED_CODE}, not 429"
fi

printf '\nRESULT: %s (%d passed, %d failed)\n' \
  "$([ "${FAILED}" -eq 0 ] && echo PASS || echo FAIL)" "${PASSED}" "${FAILED}"
[ "${FAILED}" -eq 0 ]
