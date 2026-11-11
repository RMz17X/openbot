# PRD — OpenBot WebUI Fork

Status: draft for operator review
Date: 2026-11-12
Repo: `/workspaces/openbot-fork` (fork of `nightly-labs/openbot`, upstream `origin`, our fork `fork`)
Board: `openbot-webui`

## 1. Problem

OpenBot is a desktop product. Its host process is a headless server, but the only browser
client cannot reach a host that the user owns without the Cloudflare account service, Signal
and TURN. A single user who wants one browser tab against one self-hosted host must run three
extra network services that the project does not support as a local-only setup.

## 2. Goal

One URL on the host. The browser opens it, signs in, and drives the agents. No account
service, no Signal, no TURN, no Electron, no Cloudflare.

The host keeps every capability it has today, including Computer Use.

## 3. Non-goals

- No change to the meaning of a released Team API protocol.
- No multi-user, multi-host, or hosted-server product.
- No billing, marketplace, mobile app, or chat-bot bridges in the fork.
- No rewrite of the web client. The existing `src/renderer/src/features/web-client/` is reused.
- No production deploy from this repository without operator approval.

## 4. Facts that shape the design

All verified by reading the code in this repository.

- The host already speaks plain HTTP. The Team API lives in `src/main/team-api-server.ts` with
  the route table in `packages/contracts/src/team-api-routes.ts`. It binds `127.0.0.1` only
  (`src/main/listen-loopback.ts`, lines 29-44).
- Host auth is a bearer session token. `POST /v1/auth/login` with `{username, password}`
  returns it. The check is in `team-api-server.ts`, lines 1054-1058. The local server owner
  username is `owner` (`LOCAL_SERVER_OWNER_USERNAME`, `src/main/local-server-child.ts`
  line 41).
- Events are already an SSE route. `GET /v1/events` is implemented by
  `src/main/team-api/route-events.ts`. The event path does not need WebRTC.
- The browser client uses six peer methods only: `execute`, `cancelUpload`, `setWaitForHost`,
  `setTyping`, `sendHostStreamData`, `dispose`. `execute` carries
  `{type: "request", method, path, body}`. The peer factory is already injected in
  `src/renderer/src/features/web-client/web-runtime.ts` (declared line 515, passed line 553).
- The web client is served today by a Cloudflare Worker at `/app`
  (`apps/auth-api/src/routes/app.tsx` and `app.lazy.tsx`).
- Computer Use is not Electron-bound. `src/main/cua-driver-runtime.ts` spawns a native daemon
  over a Unix socket and exposes an MCP entry. Only the visual highlight
  (`src/main/computer-use-highlight-window.ts`, `src/main/computer-use-permission-help-window.ts`)
  imports Electron, and it already sits behind a narrow port interface.
- `scripts/install-server.sh` does not ship the `cua-driver` artifact. That is a gap.
- Upstream `docs/self-hosting.md` states that the browser client does not work with a
  self-hosted service. That statement becomes false with this fork.

## 5. Options considered

### Option A — Replace the transport only (recommended)

Keep the whole upstream product. Add a plain-HTTP peer next to the WebRTC peer, add a static
web app, and put a reverse proxy in front of both. The desktop app keeps its own path.

Pros: smallest diff, lowest risk, the desktop product stays intact, every upstream fix can
still be merged.
Cons: the fork keeps the code it does not use, so the repository stays large.

### Option B — Replace the transport, then strip

Same as A, then delete the desktop, phone, chat-bot, billing and telemetry parts.

Pros: a much smaller repository and a much smaller dependency tree, so builds are faster.
Cons: merging upstream becomes manual. The upstream project is active, with 1703 open issues
and commits every hour. A long-lived fork that removes 40 percent of the tree drifts.

### Option C — Keep WebRTC, self-host Signal and TURN

Run the upstream `remote/` stack (Signal, TURN, the account Worker) on the host.

Pros: no code change at all in the client.
Cons: it needs Cloudflare Workers, D1, R2, SMTP and a public IP with three DNS names. It is
the same operating burden the change was meant to remove. It also keeps the browser client
dependent on an account service, so it is not a local-only product.

## 6. Recommendation

**Option A first, then Option B as a separate, later pass.**

The transport swap is the whole feature and it is a small, verifiable change. The strip is
mostly deletion and can be done after the fork proves it works, one area at a time, with the
option to stop at any point. Doing both at once makes a failure hard to place.

This is a change of two things at most: the transport and the serving path.

## 7. Architecture

```
Browser
  |
  |  HTTPS
  v
nginx on the host
  |-- /            -> static files of apps/webui/dist
  |-- /v1/*        -> 127.0.0.1:28417   (Team API)
  |-- /v2/*        -> 127.0.0.1:28417   (Team API)
```

- The browser sends `Authorization: Bearer <sessionToken>` on every API call.
- The token comes from `POST /v1/auth/login` with the local owner credentials.
- The token never enters a URL and never enters a logged storage key.
- Events arrive over `GET /v1/events` as SSE.

Two components:

- `packages/team-client/src/http-peer.ts` — the same returned object as
  `createRemoteTeamPeer`, implemented over HTTP and SSE. The old file stays untouched.
- `apps/webui/` — a plain Vite app that mounts `WebApp` from `@openbot/renderer-web`. It
  imports no Electron preload bridge and no Worker code.

The selection between the two peers is a build-time flag, `VITE_OPENBOT_DIRECT_HOST`. The
desktop build keeps the flag off, so the desktop product is not touched.

## 8. Work plan

The five cards already on board `openbot-webui` map to the phases below.

### Phase 1 — transport (card `t_a1288cd8`)

Build `packages/team-client/src/http-peer.ts`. Same six methods. Same error surface
(`code` and `reference`), because the consumer branches on them. SSE for `onTeamEvent`.
A file that passes 700 lines splits into `http-peer.ts` plus `http-peer-events.ts`.

Done when: the typecheck passes, the web client builds with the flag on and off, and one
request plus one live event work against the running host in `openbot-vm`.

### Phase 2 — serving (card `t_ac236039`)

Build `apps/webui/` as a static Vite bundle. Reuse the alias mapping, the Solid plugin, the
Tailwind plugin, `lazyLanguageCatalogs()`, the `optimizeDeps.exclude` and the `resolve.dedupe`
settings from the renderer section of `electron.vite.config.ts`.

Done when: `apps/webui/dist/index.html` and its assets exist, and the bundle has no reference
to the Electron preload global.

### Phase 3 — Computer Use on a server (card `t_2f29acee`)

Prove the driver path has no Electron dependency. Ship the `cua-driver` artifact in the
server build, the way `scripts/install-cua-driver.ts` does for the Electron build. Replace the
Electron highlight window with a no-op that satisfies the same port on a server, and keep the
real window for the desktop build. Keep the `computerUse` host setting real.

Done when: the driver starts on a headless host, the MCP entry answers, and the host settings
route still returns the real value.

### Phase 4 — deploy shape (card `t_0950920b`)

An nginx config in `deploy/` that serves the static files and forwards `/v1` and `/v2`, with
CORS, the preflight answer, and the same security headers the Worker sets on the app page.
A systemd unit with `OPENBOT_SERVER=1` and `Restart=on-failure` with a delay. A runbook in
`docs/webui-host.md`.

Done when: the nginx config parses, the unit passes `systemd-analyze verify`, and the runbook
gives every command a reader needs. Installing on the host needs operator approval.

### Phase 5 — strip (card `t_b8782cfa`)

Only after phases 1 to 4 work. Remove `apps/mobile`, `apps/mobile-updates`, `apps/slack-app`,
`apps/discord-app`, `apps/telegram-app`, `apps/status`, `apps/site-router`, the Stripe
scripts, the marketplace scripts, and `packages/telemetry` — each one only after the keep
list is proven not to import it. Update `package.json`, the lockfile, and the CI workflows
that name the removed paths.

Done when: `bun install` succeeds, the typecheck passes with no new errors, and the web
build still works.

### Phase 6 — run it (after phase 4)

Install the proxy and the unit on the host with operator approval, point the browser at it,
and exercise the full loop: sign in, list the agents, send a message, receive the live
event, run a Computer Use turn.

## 9. Definition of done

- One URL opens the browser client and reaches the host.
- The browser signs in with the local owner credentials and keeps a bearer session.
- A message reaches an agent and its reply comes back as a live event.
- Computer Use works on the headless host, with the driver shipped by the server build.
- The desktop build still works with the flag off.
- The typecheck passes and the web build passes.
- `packages/contracts/` and `packages/team-client/remote-peer.ts` are unchanged.
- No new test files.
- Every commit is local, with the author `ErNor <rickiar@hijitoko.com>`.

## 10. Risks

- **Event loss.** A transport that answers requests but never delivers events looks healthy
  in a smoke test and is useless. The acceptance test must include one live event from a
  live producer.
- **Capability regression.** The host reports capabilities to the client. A dropped capability
  string makes the UI hide features that still work. The HTTP peer must report the same list.
- **Merge drift.** Upstream commits every hour. The fork needs a regular merge pass, and the
  strip makes that pass manual.
- **Token leakage.** A bearer token in a query string ends up in access logs. It stays in the
  header.
- **Stripping too early.** Removing packages before the swap builds makes failures hard to
  place. The swap comes first.
- **Secret rotation.** The host owner password is a real secret. It must not land in the
  repository or in a shell history.

## 11. Open questions for the operator

1. The host owner password for `POST /v1/auth/login`. Where does it live in the fork?
2. Should the browser be allowed to reach the host from outside the tailnet, or only from
   inside it?
3. Does the fork keep the WhatsApp connector? The host registers it, so the strip may have to
   keep `packages/whatsapp`.
4. The upstream licence is PolyForm Noncommercial. The fork stays noncommercial.
