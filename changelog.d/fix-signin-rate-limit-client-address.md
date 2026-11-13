### Fixed

- Count the sign-in rate limit per client address instead of one bucket for every caller. The
  daemon listens on a loopback port, so every request reaches it through the local reverse proxy
  and the socket address was always the proxy. The limit now uses the client address the proxy
  names in `X-Real-IP` or `X-Forwarded-For`, and falls back to the socket address when neither
  header names an IP address. Wrong sign-ins from one place no longer lock out every other place
  for 15 minutes.
