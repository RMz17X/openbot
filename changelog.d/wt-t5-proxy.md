### Added

- Nginx reverse proxy configuration in `deploy/` to serve the static web client and forward Team API `/v1/*` and `/v2/*` routes.
- systemd unit `deploy/openbot-server.service` with `OPENBOT_SERVER=1`, `Restart=on-failure`, and loop protection.
- Runbook in `docs/webui-host.md` with build, installation, reload, and sign-in instructions.
