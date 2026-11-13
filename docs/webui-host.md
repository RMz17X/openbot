# Web UI Host: Deploy, Verify, Update

This runbook covers the headless OpenBot WebUI that runs in the `openbot-vm` Incus container.
It is the operator's path to the WebUI: what to open, how to ship a new build, how to prove the
stack is healthy, and how to pull in a new official upstream release.

## 1. What the operator opens

Open the WebUI in a browser:

```
http://100.81.73.83:28420/
```

That address is the Incus proxy `webui-proxy` on the host, which forwards to nginx inside
`openbot-vm`. nginx serves the static bundle from `/var/www/openbot-webui` and reverse-proxies
`/v1/` to the Team API.

The daemon also serves the web client itself, on the same port as the Team API. That is the
path the desktop app and the Android app use, and it is why the Team API port can serve the
bundle as well as the API. nginx in front of it is what the browser uses.

### Signing in

The login is the **local owner** `rickicode`.

The password is not written down anywhere in this repository. It lives in two files, both mode
`0600`:

| Where | Path |
|---|---|
| In the container | `/home/openbot/.config/OpenBot/webui-password` (owner `openbot`) |
| On the host | `/home/ricki/.hermes/secrets/openbot-webui-password` (owner `ricki`) |

To read it for a manual sign-in:

```bash
# On the host. The command prints the password into your terminal, so run it only when you
# need to type it.
cat /home/ricki/.hermes/secrets/openbot-webui-password
```

The browser sends the password to `POST /v1/auth/login` and keeps only the returned session
token, in the tab's `sessionStorage` under `openbot.direct.session`. Nothing is written to disk
by the browser.

### The team members

Two members exist in the local team store:

- `rickicode@gmail.com` - the account-service member. The Android app and the desktop app sign
  in with this one. It has no local password and cannot sign in against the Team API directly.
- `rickicode` - the local owner. It has a password hash and is what the WebUI signs in with.

The WebUI shows both. `/v1/team/presence` lists `rickicode@gmail.com` as `online` when the
daemon's cloud connection is alive.

## 2. Deploying a new WebUI build

One command:

```bash
cd /workspaces/openbot-fork
./deploy/deploy-webui.sh
```

What it does, in order:

1. Builds the bundle with the build script that `apps/webui/package.json` names. The script
   name is read from the repository, so the two cannot drift apart.
2. Pushes `apps/webui/dist` into the container with `incus file push -r`, into a staging
   directory.
3. Swaps the staging directory into `/var/www/openbot-webui` with a rename. The old bundle is
   moved aside first and removed after the swap, so the web root is never half-written.
4. Tests the nginx configuration and reloads nginx.
5. Runs the Team API port probe (`deploy/openbot-team-api-port.sh`) so the nginx upstream file
   matches the daemon's current port, and reloads nginx again if the port moved.
6. Prints the final URL and the Team API port.

The script is idempotent. Running it twice in a row succeeds both times and leaves the same
bundle in place.

### Why `incus file push` and not scp or rsync

`/storage` on this host is network storage (an NFS mount). An `mv` or an rsync onto it locks up
the Incus controller for the whole transfer. `incus file push` writes through the instance agent
instead, so the controller stays responsive.

### The `--restart-daemon` flag

By default the script does **not** touch `openbot.service`, and it never touches
`hermes-gateway`.

```bash
./deploy/deploy-webui.sh --restart-daemon
```

This restarts the daemon inside the container. It exists because a daemon restart is the only way
to clear the in-memory sign-in rate limit (see the known limits below). It also drops the agent
sessions, so the operator is signed out of every agent until it signs in again. Use it only when
the rate limit is the thing in the way.

## 3. Verifying

One command:

```bash
cd /workspaces/openbot-fork
./deploy/verify-webui.sh
```

It prints one `PASS` or `FAIL` line per check and exits non-zero if any check failed. The checks:

1. `openbot.service` is active in the container.
2. `nginx.service` is active in the container.
3. The Team API port probe resolves, and `/v1/compatibility` answers `200` with a body that
   carries `appVersion`. Both the Team API itself and the reverse proxy are checked.
4. The local owner signs in and gets a `sessionToken`.
5. With that token, `/v1/me` answers `200`, `/v1/agents` answers `200` with a non-empty agent
   list, and `/v1/team/members` answers `200`.
6. `/v1/team/presence` answers `200` and lists `rickicode@gmail.com` with `online: true`. This is
   the Android companion path, so this is the check that must never regress.
7. The daemon still holds its outbound TLS connection to the cloud. The check looks at the
   certificate the peer presents rather than at its address, because the account service sits
   behind a CDN whose addresses move.
8. `GET /` answers `200` and the page names an asset bundle that is actually served.

The script reads the password from the container file at the moment of use. It never prints it,
never writes it to a file on the host, and never passes it as a command line argument. It signs
in exactly once and never retries, because a retry would spend a rate-limit attempt for nothing.

### The session token is cached

After a successful sign-in, the script writes the session token to:

```
~/.cache/openbot/verify-webui.token
```

mode `0600`. The next run reuses it and spends **no** sign-in attempt at all. Without the cache,
running this script five times inside fifteen minutes would lock the local owner out of its own
WebUI.

The cache holds a session token, not the password. A token that no longer works is dropped and a
fresh sign-in is made, so a stale cache heals itself. To force a fresh sign-in, delete the file:

```bash
rm ~/.cache/openbot/verify-webui.token
```

## 4. Updating to a new official upstream release

The fork lives at `/workspaces/openbot-fork`. `origin` is the official repository
(`nightly-labs/openbot`) and `fork` is this fork's own remote.

The fork carries a small patch set on top of upstream. The patch set is what an upstream update
has to re-apply. As of this writing it touches:

| Area | Files |
|---|---|
| The standalone WebUI package | `apps/webui/**` |
| The plain-HTTP team peer | `packages/team-client/src/http-peer.ts`, `packages/team-client/src/import-meta-env.d.ts` |
| The headless server path | `src/main/webui-gateway.ts`, `src/main/webui-server.ts`, `src/main/webui-static.ts`, `src/main/webui-team-api-proxy.ts`, `src/main/host-service.ts`, `src/main/application-services.ts`, `src/main/index.ts` |
| The deployment files | `deploy/**` |
| The runbook | `docs/webui-host.md` |

### The update procedure

1. Fetch the upstream tag.

   ```bash
   cd /workspaces/openbot-fork
   git fetch origin --tags
   git log --oneline HEAD..origin/main | wc -l   # how far behind the fork is
   ```

2. Work on a branch, not on `main`. Other workers use this working tree.

   ```bash
   git switch -c update/upstream-$(git describe --tags --abbrev=0 origin/main)
   ```

3. Merge or rebase upstream onto the branch. A merge keeps the fork's patch set visible as its
   own commits, which is easier to re-apply by hand than a rebase is.

   ```bash
   git merge origin/main
   ```

4. Resolve the conflicts. Most of them will be in the files listed above: upstream moves the
   renderer and the main process, and the fork's patch set sits right on top of them. Resolve
   each one by keeping **both** sides of the intent:
   - Keep upstream's renderer changes and the fork's headless path side by side.
   - Keep the fork's `apps/webui` package and its `vite.config.ts` direct-host settings.
   - Keep `deploy/` as it is, and re-check it against the upstream build layout.

5. Re-apply anything that was dropped. The build is the check:

   ```bash
   bun install
   bun run build:webui
   ```

   A build that fails names the file that needs the patch set back.

6. Deploy and verify.

   ```bash
   ./deploy/deploy-webui.sh
   ./deploy/verify-webui.sh
   ```

7. Commit locally. No push.

   ```bash
   git add -A
   git commit -m "feat(upstream): update to <tag> and re-apply the headless WebUI patch set"
   ```

### What an upstream update can break

- **The Team API route table.** The fork's WebUI speaks protocol version 9. If upstream raises
  the minimum protocol, the `OpenBot-Protocol-Version` and `OpenBot-App-Version` headers that
  `deploy/openbot-team-api-port.sh` and `deploy/verify-webui.sh` send have to move with it, and
  the Team API answers `426 client_update_required` until they do.
- **The Team API port.** Upstream still binds the Team API on a free loopback port, so
  `deploy/openbot-team-api-port.sh` stays necessary. If upstream ever fixes the port, the
  probe script becomes a no-op and the upstream file can be hardcoded.
- **The sign-in route.** The login body shape (`{"username": ..., "password": ...}`) and the
  `sessionToken` in the reply are the contract `deploy/verify-webui.sh` relies on.
- **The members route.** `/v1/team/members` and the `email` field on each member are what the
  presence check reads.

## 5. Known limits

### The sign-in rate limit is global behind the reverse proxy

The Team API counts sign-in attempts per source address plus user name. The constants are in
`src/main/team-api-server.ts`:

```
RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000
RATE_LIMIT_ATTEMPTS   = 5
```

The daemon listens on a loopback port only, so every request reaches it through the nginx
reverse proxy in the container. nginx forwards to the proxy from `127.0.0.1`, and the daemon
sees `request.socket.remoteAddress` as `127.0.0.1` for every caller. **All sign-ins share one
bucket per user name.**

Six wrong sign-ins from one place lock out every other place for 15 minutes. The counters live
in an in-memory `Map`, so the only way to clear them is a daemon restart.

Three things follow in practice:

- Do not type the password wrong six times. Count.
- `deploy/verify-webui.sh` sends its sign-in straight to the Team API with the container's own
  address as the source, so it has a bucket of its own and does not spend the browser's budget.
- `deploy/verify-webui.sh` also caches its session token, so running it repeatedly costs no
  sign-in attempts at all.
- The upstream fix for this is tracked separately: the daemon should read the client address that
  the local proxy forwards, instead of the socket address.

### The Team API port is random

The daemon binds the Team API on a free loopback port (`port 0`), so the port changes on every
daemon start. nginx cannot be configured with a fixed port, so:

- `deploy/openbot-team-api-port.sh` probes for the port that answers `/v1/compatibility` with an
  `appVersion` body and writes `/etc/nginx/upstream-openbot-team-api.conf`.
- `openbot-team-api-port.timer` runs that probe every two minutes.
- `deploy/deploy-webui.sh` runs it after every deploy.

Between a daemon start and the next probe run there is a window where nginx still points at the
old port and `/v1/` answers `502`. The probe clears it within two minutes.

### The Android app needs the daemon's cloud connection

The Android companion app reaches the host through the Cloudflare account service and Signal.
The daemon holds that connection open, and `/v1/team/presence` only lists a member as `online`
while it is alive.

If the daemon loses its outbound connection to the cloud:

- `rickicode@gmail.com` shows as offline in the WebUI.
- The Android app cannot reach the host.

`deploy/verify-webui.sh` check 7 is the one that catches this. It looks at the certificate the
peer presents rather than at its address, because the account service sits behind a CDN whose
addresses move.

### The daemon is restarted by the memory watchdog

`openbot-watchdog.timer` runs every minute and restarts `openbot.service` when the daemon's
memory passes 5 GB or when it fails three liveness checks in a row. A restart moves the Team API
port (see above) and clears the sign-in rate limit. It also drops the agent sessions.

## Appendix: the layout

| Thing | Where |
|---|---|
| The fork | `/workspaces/openbot-fork` on branch `main` |
| The container | `openbot-vm` (Incus), address `10.32.76.252` |
| The static bundle | `/var/www/openbot-webui` inside the container |
| The nginx upstream file | `/etc/nginx/upstream-openbot-team-api.conf` inside the container |
| The nginx config | `deploy/openbot.conf` in the repository |
| The Team API port probe | `deploy/openbot-team-api-port.sh` in the repository, installed as `/usr/local/bin/openbot-team-api-port.sh` in the container |
| The host proxy | Incus device `webui-proxy`: `0.0.0.0:28420` to `127.0.0.1:80` in the container |
| The password | `/home/ricki/.hermes/secrets/openbot-webui-password` on the host, `/home/openbot/.config/OpenBot/webui-password` in the container |
| The local team store | `/home/openbot/.config/OpenBot/openbot-team-server-v2.json` in the container |
| The deploy script | `deploy/deploy-webui.sh` |
| The verification script | `deploy/verify-webui.sh` |

## Appendix: a generic host install

The runbook above is the operator's path for this deployment. The section below is the
generic one: it installs the daemon as a systemd unit on a host that has no OpenBot yet.
It is kept because `deploy/openbot-server.service` is a template unit with a
`@SERVICE_USER@` placeholder, and the operator path never needed it.

### Install and start the host service

The host process runs in headless server mode (`OPENBOT_SERVER=1`) and listens on `127.0.0.1:28417`.

#### Option A: Install the new unit

1. Copy the systemd unit file from `deploy/`:
   ```bash
   sudo cp deploy/openbot-server.service /etc/systemd/system/openbot-server.service
   ```

2. Edit `/etc/systemd/system/openbot-server.service` and set the service user:
   Replace `@SERVICE_USER@` with your target user (for example `openbot`).

3. Reload the systemd daemon:
   ```bash
   sudo systemctl daemon-reload
   ```

4. Enable and start the service:
   ```bash
   sudo systemctl enable --now openbot-server.service
   ```

5. Check service status:
   ```bash
   systemctl status openbot-server.service
   ```

#### Option B: Update an existing unit

If an `openbot.service` already exists on the host, apply these changes:
- Add `Environment=OPENBOT_SERVER=1` in the `[Service]` section.
- Change `Restart=always` to `Restart=on-failure`.
- Keep `RestartSec=10` (or `RestartSec=10s`).
- Add `StartLimitIntervalSec=300` and `StartLimitBurst=5` in the `[Unit]` section to prevent infinite restart loops.

Reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart openbot.service
```

### Verification with curl

Verify API authentication directly with `curl`:

1. Request a session token through the reverse proxy:
   ```bash
   curl -i -X POST http://localhost/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"owner","password":"<your-password>"}'
   ```

2. Direct request to the loopback Team API:
   ```bash
   curl -i -X POST http://127.0.0.1:28417/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"owner","password":"<your-password>"}'
   ```

Successful authentication returns HTTP status 200 with the session token JSON payload.
