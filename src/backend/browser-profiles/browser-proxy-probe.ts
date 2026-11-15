import { connect, type Socket } from "node:net";
import type { BrowserProxyScheme, BrowserProxyTestResult } from "@openbot/contracts/ipc";

export interface ProxyConnectionInfo {
  scheme: BrowserProxyScheme;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface GeoIpResponse {
  ip?: string;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  isp?: string;
  org?: string;
  as?: string;
}

function parseGeoIpJson(raw: string): GeoIpResponse | null {
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    const data = JSON.parse(raw.slice(jsonStart));
    // Check if ip-api.com format
    if (data.status === "success" || data.query) {
      return {
        ip: data.query,
        country: data.country,
        countryCode: data.countryCode,
        regionName: data.regionName,
        city: data.city,
        isp: data.isp,
        org: data.org,
        as: data.as,
      };
    }
    // Check if ipwho.is format
    if (data.success !== false && data.ip) {
      return {
        ip: data.ip,
        country: data.country,
        countryCode: data.country_code,
        regionName: data.region,
        city: data.city,
        isp: data.connection?.isp,
        org: data.connection?.org,
        as: data.connection?.asn ? `AS${data.connection.asn} ${data.connection.org || ""}`.trim() : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Probes a proxy connection by performing a SOCKS5 or HTTP handshake and fetching GeoIP / ISP details.
 */
export async function probeBrowserProxy(
  proxy: ProxyConnectionInfo,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BrowserProxyTestResult> {
  const start = performance.now();
  try {
    let rawBody = "";
    if (proxy.scheme === "socks5") {
      rawBody = await executeSocks5Probe(proxy, timeoutMs);
    } else {
      rawBody = await executeHttpProbe(proxy, timeoutMs);
    }

    const latencyMs = Math.round(performance.now() - start);
    const parsed = parseGeoIpJson(rawBody);

    if (!parsed?.ip) {
      return {
        ok: false,
        latencyMs,
        error: "Proxy responded but IP lookup failed to parse.",
      };
    }

    return {
      ok: true,
      latencyMs,
      ip: parsed.ip,
      country: parsed.country,
      countryCode: parsed.countryCode,
      regionName: parsed.regionName,
      city: parsed.city,
      isp: parsed.isp,
      org: parsed.org,
      as: parsed.as,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      ok: false,
      latencyMs,
      error: error instanceof Error ? error.message : "Connection failed.",
    };
  }
}

function executeHttpProbe(proxy: ProxyConnectionInfo, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host: proxy.host, port: proxy.port });

    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Connection timed out"));
    }, timeoutMs);

    function cleanup() {
      settled = true;
      clearTimeout(timer);
    }

    let authHeader = "";
    if (proxy.username && proxy.password) {
      authHeader = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`;
    }

    socket.on("connect", () => {
      // Send forward proxy GET request for ip-api.com
      const request =
        `GET http://ip-api.com/json HTTP/1.1\r\n` +
        `Host: ip-api.com\r\n` +
        `User-Agent: OpenBot-Probe/1.0\r\n` +
        `Connection: close\r\n` +
        authHeader +
        `\r\n`;
      socket.write(request);
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });

    socket.on("end", () => {
      if (settled) return;
      cleanup();

      const splitIndex = buffer.indexOf("\r\n\r\n");
      if (splitIndex === -1) {
        reject(new Error("Empty response from proxy"));
        return;
      }

      const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
      if (statusLine.includes("407")) {
        reject(new Error("Proxy authentication required"));
        return;
      }
      if (!statusLine.includes("200")) {
        reject(new Error(`Proxy returned ${statusLine.trim()}`));
        return;
      }

      resolve(buffer.slice(splitIndex + 4));
    });

    socket.on("error", (err) => {
      if (settled) return;
      cleanup();
      reject(err);
    });
  });
}

function executeSocks5Probe(proxy: ProxyConnectionInfo, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host: proxy.host, port: proxy.port });

    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("SOCKS5 connection timed out"));
    }, timeoutMs);

    function cleanup() {
      settled = true;
      clearTimeout(timer);
    }

    let state: "greeting" | "auth" | "connect" | "http" = "greeting";
    let dataBuffer = Buffer.alloc(0);

    socket.on("connect", () => {
      // RFC 1928: Send greeting with 0x00 (no auth) and 0x02 (user/pass)
      socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    });

    socket.on("data", (chunk) => {
      dataBuffer = Buffer.concat([dataBuffer, chunk]);

      if (state === "greeting") {
        if (dataBuffer.length < 2) return;
        const ver = dataBuffer[0];
        const method = dataBuffer[1];
        dataBuffer = dataBuffer.subarray(2);

        if (ver !== 0x05) {
          socket.destroy();
          cleanup();
          reject(new Error("Remote server is not a SOCKS5 proxy"));
          return;
        }

        if (method === 0x00) {
          // No auth needed, proceed to connect
          sendConnect(socket);
        } else if (method === 0x02) {
          if (!proxy.username) {
            socket.destroy();
            cleanup();
            reject(new Error("SOCKS5 proxy requires authentication"));
            return;
          }
          state = "auth";
          const uBuf = Buffer.from(proxy.username);
          const pBuf = Buffer.from(proxy.password || "");
          socket.write(Buffer.concat([Buffer.from([0x01, uBuf.length]), uBuf, Buffer.from([pBuf.length]), pBuf]));
        } else {
          socket.destroy();
          cleanup();
          reject(new Error(`SOCKS5 authentication method 0x${(method ?? 0).toString(16)} unsupported`));
          return;
        }
      } else if (state === "auth") {
        if (dataBuffer.length < 2) return;
        const authStatus = dataBuffer[1];
        dataBuffer = dataBuffer.subarray(2);
        if (authStatus !== 0x00) {
          socket.destroy();
          cleanup();
          reject(new Error("SOCKS5 authentication failed"));
          return;
        }
        sendConnect(socket);
      } else if (state === "connect") {
        if (dataBuffer.length < 5) return;
        if (dataBuffer[1] !== 0x00) {
          const errCode = dataBuffer[1];
          socket.destroy();
          cleanup();
          reject(new Error(`SOCKS5 connection refused (code ${errCode})`));
          return;
        }
        const atyp = dataBuffer[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + (dataBuffer[4] ?? 0) : 0;
        const totalHeader = 4 + addrLen + 2;
        if (dataBuffer.length < totalHeader) return;
        dataBuffer = dataBuffer.subarray(totalHeader);

        // Tunnel connected! Send HTTP request
        state = "http";
        socket.write(
          "GET /json HTTP/1.1\r\n" +
            "Host: ip-api.com\r\n" +
            "User-Agent: OpenBot-Probe/1.0\r\n" +
            "Connection: close\r\n\r\n",
        );
      }
    });

    function sendConnect(s: Socket) {
      state = "connect";
      const targetHost = Buffer.from("ip-api.com");
      const targetPort = Buffer.alloc(2);
      targetPort.writeUInt16BE(80);
      s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, targetHost.length]), targetHost, targetPort]));
    }

    socket.on("end", () => {
      if (settled) return;
      cleanup();

      const str = dataBuffer.toString("utf8");
      const idx = str.indexOf("\r\n\r\n");
      if (idx !== -1) {
        resolve(str.slice(idx + 4));
        return;
      }
      reject(new Error("Incomplete HTTP response over SOCKS5 tunnel"));
    });

    socket.on("error", (err) => {
      if (settled) return;
      cleanup();
      reject(err);
    });
  });
}
