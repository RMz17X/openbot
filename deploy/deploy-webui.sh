#!/bin/bash
# Deploys the static WebUI bundle into the OpenBot container and repoints nginx at it.
#
# The bundle is built from apps/webui and pushed into the container with `incus file push`. The
# push is used on purpose: `/storage` is network storage, and an `mv` onto it locks up the Incus
# controller. `incus file push` writes through the instance agent instead, so the controller stays
# responsive.
#
# The script is idempotent. Running it twice in a row changes nothing the second time: the same
# bundle is pushed, nginx is reloaded, and the Team API upstream is left alone when its port has
# not moved.
#
# It never restarts hermes-gateway, and it never restarts openbot.service unless the operator
# asks for it with --restart-daemon. A daemon restart clears the in-memory sign-in rate limit and
# the agent sessions, so it is never done as a side effect of a deploy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBUI_DIR="${REPO_ROOT}/apps/webui"
DIST_DIR="${WEBUI_DIR}/dist"

CONTAINER="${OPENBOT_CONTAINER:-openbot-vm}"
CONTAINER_WEBROOT="${OPENBOT_WEBROOT:-/var/www/openbot-webui}"
HOST_URL="${OPENBOT_URL:-http://100.81.73.83:28420}"

RESTART_DAEMON=0

log() { printf '[deploy-webui] %s\n' "$*"; }
fail() { printf '[deploy-webui] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./deploy/deploy-webui.sh [--restart-daemon] [--help]

  --restart-daemon  Restart openbot.service inside the container after the deploy. This clears
                    the in-memory sign-in rate limit and the agent sessions, so it is off by
                    default.
  --help            Show this text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --restart-daemon) RESTART_DAEMON=1 ;;
    --help | -h) usage; exit 0 ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# --- Preflight -------------------------------------------------------------------------------

command -v incus >/dev/null 2>&1 || fail "incus is not installed on this host"
command -v bun >/dev/null 2>&1 || fail "bun is not installed on this host"

incus info "${CONTAINER}" >/dev/null 2>&1 || fail "the container ${CONTAINER} does not exist"
[ -f "${WEBUI_DIR}/package.json" ] || fail "apps/webui/package.json is missing; wrong repository"

# The build command comes from the repository, not from this script, so the two cannot drift.
# The script name is read from apps/webui/package.json: `bun run` takes a script name, not the
# command the script holds.
BUILD_SCRIPT_NAME="$(bun -e '
  const pkg = require(process.argv[1]);
  const scripts = pkg.scripts || {};
  const names = Object.keys(scripts).filter((name) => scripts[name]);
  const name = names.includes("build") ? "build" : names[0];
  if (!name) {
    process.stderr.write("apps/webui/package.json has no build script\n");
    process.exit(1);
  }
  process.stdout.write(name);
' "${WEBUI_DIR}/package.json")" || fail "cannot read the build script from apps/webui/package.json"

# --- Build -----------------------------------------------------------------------------------

log "building the web client: bun run --cwd apps/webui ${BUILD_SCRIPT_NAME}"
bun run --cwd apps/webui "${BUILD_SCRIPT_NAME}" || fail "the web client build failed"
[ -f "${DIST_DIR}/index.html" ] || fail "the build produced no ${DIST_DIR}/index.html"

# --- Push ------------------------------------------------------------------------------------

# The bundle is pushed into a fresh directory and the old one is moved aside afterwards. A
# half-written bundle in the web root would serve a broken page to the operator.
STAGE_DIR="/var/tmp/openbot-webui-stage.$$"
log "pushing the bundle into ${CONTAINER}:${STAGE_DIR}"

incus exec "${CONTAINER}" -- mkdir -p "${STAGE_DIR}" || fail "cannot create ${STAGE_DIR} in ${CONTAINER}"

# The bundle has a few top-level entries (assets/, index.html, _headers). Each is pushed on its
# own so the stage directory holds the bundle itself and not a nested copy of its parent.
push_failed=0
for entry in "${DIST_DIR}"/*; do
  [ -e "${entry}" ] || continue
  incus file push -r "${entry}" "${CONTAINER}${STAGE_DIR}" || push_failed=1
done
[ "${push_failed}" -eq 0 ] || fail "the bundle push into ${CONTAINER} failed"

# The swap runs inside the container, so the old bundle and the new one are on the same filesystem
# and the move is a rename rather than a copy.
incus exec "${CONTAINER}" -- bash -s -- "${STAGE_DIR}" "${CONTAINER_WEBROOT}" <<'SWAP' || fail "the bundle swap in ${CONTAINER} failed"
set -euo pipefail
stage="$1"
root="$2"

# The web root is a directory. A symlink into the shared workspace is replaced by a real
# directory, so the push cannot write through it into the workspace.
if [ -L "${root}" ]; then
  rm -f "${root}"
fi

# The old bundle is moved aside, not deleted, so a failed swap can be undone by hand. The root
# has to be out of the way before the stage moves into its place: a rename into an existing
# directory would nest the stage inside it instead of replacing it.
previous="${root}.previous"
rm -rf "${previous}"
if [ -d "${root}" ]; then
  mv "${root}" "${previous}"
fi
mv "${stage}" "${root}"

chmod 0755 "${root}"
chmod -R a+rX "${root}"
rm -rf "${previous}"
SWAP

# --- nginx -----------------------------------------------------------------------------------

log "reloading nginx in ${CONTAINER}"
incus exec "${CONTAINER}" -- nginx -t || fail "the nginx configuration in ${CONTAINER} is not valid"
incus exec "${CONTAINER}" -- systemctl reload nginx || fail "the nginx reload in ${CONTAINER} failed"

# --- Team API upstream -----------------------------------------------------------------------

# The daemon binds the Team API on a free loopback port, so nginx has to follow it. The probe
# script writes the upstream file and reloads nginx itself when the port moved.
log "probing the Team API port"

upstream_port() {
  # The upstream file names the port in a `server 127.0.0.1:<port>;` line.
  incus exec "${CONTAINER}" -- bash -lc \
    "awk '/^[[:space:]]*server[[:space:]]+127\\.0\\.0\\.1:/ { split(\$0, parts, \":\"); gsub(/;/, \"\", parts[2]); print parts[2]; exit }' /etc/nginx/upstream-openbot-team-api.conf" \
    2>/dev/null | tr -d '[:space:]'
}

UPSTREAM_BEFORE="$(upstream_port)"

incus exec "${CONTAINER}" -- /usr/local/bin/openbot-team-api-port.sh \
  || fail "the Team API port probe failed; the daemon may not be up yet"

UPSTREAM_AFTER="$(upstream_port)"
[ -n "${UPSTREAM_AFTER}" ] || fail "the Team API upstream file names no port"

if [ "${UPSTREAM_BEFORE}" != "${UPSTREAM_AFTER}" ]; then
  log "the Team API port moved from ${UPSTREAM_BEFORE:-none} to ${UPSTREAM_AFTER}; nginx was reloaded"
else
  log "the Team API upstream is unchanged at ${UPSTREAM_AFTER}"
fi

# --- Optional daemon restart -----------------------------------------------------------------

if [ "${RESTART_DAEMON}" -eq 1 ]; then
  log "restarting openbot.service in ${CONTAINER} (--restart-daemon)"
  incus exec "${CONTAINER}" -- systemctl restart openbot.service || fail "the daemon restart failed"
  log "waiting for the daemon to bind the Team API again"
  sleep 20
  incus exec "${CONTAINER}" -- /usr/local/bin/openbot-team-api-port.sh \
    || fail "the Team API port probe failed after the daemon restart"
  incus exec "${CONTAINER}" -- nginx -t || fail "the nginx configuration in ${CONTAINER} is not valid"
  incus exec "${CONTAINER}" -- systemctl reload nginx || fail "the nginx reload in ${CONTAINER} failed"
  UPSTREAM_AFTER="$(upstream_port)"
fi

# --- Result ----------------------------------------------------------------------------------

log "web UI:  ${HOST_URL}"
log "Team API port: ${UPSTREAM_AFTER}"
log "done. Verify with: ./deploy/verify-webui.sh"
