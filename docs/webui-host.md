# Web UI Host Setup and Operation

This document provides instructions to build, deploy, and operate the OpenBot Web UI and host API on a single Linux host.

## Overview

The setup serves:
- The static web client from `/` and `/assets/*`.
- The Team API from `/v1/*` and `/v2/*` forwarded to `http://127.0.0.1:28417`.

## Prerequisites

Verify that the host has:
- Bun runtime (`bun --version`)
- Nginx web server (`nginx -v`)
- systemd init system (`systemctl --version`)

## 1. Build the Static Web Client

The static web client package is located in `apps/webui`.

1. Go to the web client package directory:
   ```bash
   cd apps/webui
   ```

2. Install dependencies:
   ```bash
   bun install --frozen-lockfile
   ```

3. Build the production bundle:
   ```bash
   VITE_OPENBOT_DIRECT_HOST=1 bun run build
   ```

Vite writes the build output to `apps/webui/dist/`.

## 2. Install the Static Files

1. Create the destination web directory:
   ```bash
   sudo mkdir -p /var/www/openbot-webui
   ```

2. Copy the build output:
   ```bash
   sudo cp -r apps/webui/dist/* /var/www/openbot-webui/
   ```

3. Set file ownership:
   ```bash
   sudo chown -R www-data:www-data /var/www/openbot-webui
   ```
   *(Note: On distributions that use the `http` user, such as Arch Linux, use `sudo chown -R http:http /var/www/openbot-webui`)*.

## 3. Install and Reload Nginx

Versioned proxy configuration files are located in `deploy/`.

1. Copy the reverse proxy configuration:
   ```bash
   sudo cp deploy/openbot.conf /etc/nginx/conf.d/openbot.conf
   ```
   *(On Debian or Ubuntu systems with `sites-available`, you can copy to `/etc/nginx/sites-available/openbot.conf` and create a symbolic link in `/etc/nginx/sites-enabled/`)*.

2. Test the Nginx configuration syntax:
   ```bash
   sudo nginx -t
   ```

3. Reload Nginx to apply changes:
   ```bash
   sudo systemctl reload nginx
   ```

## 4. Install and Start the Host Service

The host process runs in headless server mode (`OPENBOT_SERVER=1`) and listens on `127.0.0.1:28417`.

### Option A: Install the New Unit

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

### Option B: Update an Existing Unit

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

## 5. Sign In to the Web Client

1. Open a web browser and navigate to:
   ```
   http://<host-ip-or-domain>/
   ```

2. The login screen displays.

3. Enter the local server credentials:
   - **Username**: `owner`
   - **Password**: Your configured local owner password.

4. Submit the form. The web client sends `POST /v1/auth/login` to the host API.

5. The host answers with a bearer session token. The client stores the token in session storage.

6. The client connects to `/v1/events` for real-time WebSocket events and displays the workspace.

## 6. Verification with curl

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
