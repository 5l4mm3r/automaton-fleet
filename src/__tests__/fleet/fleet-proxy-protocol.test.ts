/**
 * R36: PROXY protocol v1 on the controller's public listener behind the host's nginx.
 *
 * Parser and configuration rules (no database). The listener's behaviour with real founders, rate limits and
 * /readyz is exercised against PostgreSQL in fleet-cognition.test.ts ("R36 PROXY-protocol listener").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PROXY_V1_MAX, parseProxyV1, readProxyV1 } from "../../fleet/service/proxy-protocol.js";
import { loadRemoteConfig } from "../../fleet/service/main.js";
import { FleetService } from "../../fleet/service/server.js";

const b = (s: string) => Buffer.from(s, "latin1");

describe("R36 PROXY protocol v1 parser (fail-closed)", () => {
  it("accepts one well-formed TCP4 / TCP6 line and returns the bytes after it untouched", () => {
    const tlsStart = Buffer.from([0x16, 0x03, 0x01, 0x00, 0xc8]);
    const r = readProxyV1(Buffer.concat([b("PROXY TCP4 203.0.113.7 51.195.148.111 52144 443\r\n"), tlsStart]));
    expect(r).toEqual({ status: "ok", peer: { family: "TCP4", sourceAddress: "203.0.113.7", sourcePort: 52144 }, rest: tlsStart });
    expect(parseProxyV1("PROXY TCP6 2001:db8::7 2001:db8::1 1 65535")).toEqual({ family: "TCP6", sourceAddress: "2001:db8::7", sourcePort: 1 });
  });

  it("waits for a header split across packets, but never past the specification's 107 bytes", () => {
    expect(readProxyV1(b("PRO"))).toEqual({ status: "incomplete" });
    expect(readProxyV1(b("PROXY TCP4 203.0.113.7 10.0.0.1 1"))).toEqual({ status: "incomplete" });
    expect(readProxyV1(b(`PROXY TCP4 ${"1".repeat(PROXY_V1_MAX)}`))).toEqual({ status: "invalid" });
  });

  it("refuses everything else: no header, a direct TLS handshake, UNKNOWN, v2, bad addresses, ports or spacing", () => {
    const bad = [
      Buffer.from([0x16, 0x03, 0x01]), // a client speaking TLS directly (no nginx in front)
      b("GET / HTTP/1.1\r\n"),
      b("PROXY UNKNOWN\r\n"),
      b("PROXY UNKNOWN 203.0.113.7 10.0.0.1 1 2\r\n"),
      Buffer.concat([Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]), b("\x21\x11\x00\x0c")]), // v2 signature
      b("proxy TCP4 203.0.113.7 10.0.0.1 1 2\r\n"),
      b("PROXY TCP4 203.0.113.7 10.0.0.1 1 2 extra\r\n"),
      b("PROXY TCP4  203.0.113.7 10.0.0.1 1 2\r\n"),
      b("PROXY TCP4 2001:db8::7 10.0.0.1 1 2\r\n"), // family mismatch
      b("PROXY TCP6 203.0.113.7 2001:db8::1 1 2\r\n"),
      b("PROXY TCP4 203.0.113.256 10.0.0.1 1 2\r\n"),
      b("PROXY TCP4 203.0.113.7 10.0.0.1 65536 2\r\n"),
      b("PROXY TCP4 203.0.113.7 10.0.0.1 0443 2\r\n"),
      b("PROXY TCP4 203.0.113.7 10.0.0.1 -1 2\r\n"),
      b("PROXY TCP4 203.0.113.7 10.0.0.1 1 2\n"),
      b("PROXY TCP4 203.0.113.7\x00 10.0.0.1 1 2\r\n"),
      b("PROXY TCP4 localhost 10.0.0.1 1 2\r\n"),
    ];
    for (const x of bad) {
      const r = readProxyV1(x);
      // "PROXY TCP4 … 2\n" has no CRLF yet: it is still short, so the listener waits — and times out (no header).
      if (r.status === "incomplete") expect(x.toString("latin1")).toMatch(/\n$/);
      else expect(r.status, JSON.stringify(x.toString("latin1"))).toBe("invalid");
    }
  });
});

describe("R36 PROXY-protocol configuration", () => {
  let dir: string;
  let tls: { cert: Buffer; key: Buffer };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-proxy-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(dir, "k"), "-out", path.join(dir, "c")], { stdio: "ignore" });
    tls = { cert: fs.readFileSync(path.join(dir, "c")), key: fs.readFileSync(path.join(dir, "k")) };
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { FLEET_REMOTE_LISTEN_ENABLED: "true", FLEET_PUBLIC_HOSTNAME: "localhost" };

  it("is off unless asked for; the R35 configuration (0.0.0.0:443, no PROXY) is unchanged", () => {
    expect(loadRemoteConfig({ ...base, FLEET_PUBLIC_LISTEN: "0.0.0.0:443" }, tls)).toMatchObject({ publicListen: { host: "0.0.0.0", port: 443 }, proxyProtocol: false });
    expect(loadRemoteConfig({ ...base, FLEET_PUBLIC_LISTEN: "0.0.0.0:443", FLEET_PUBLIC_PROXY_PROTOCOL: "false" }, tls)).toMatchObject({ proxyProtocol: false });
  });

  it("requires remote listening, an explicit public listener, and a LOOPBACK bind (no forgeable header from the network)", () => {
    expect(loadRemoteConfig({ ...base, FLEET_PUBLIC_LISTEN: "127.0.0.1:8443", FLEET_PUBLIC_PROXY_PROTOCOL: "true" }, tls)).toMatchObject({
      publicListen: { host: "127.0.0.1", port: 8443 }, proxyProtocol: true,
    });
    expect(() => loadRemoteConfig({ FLEET_PUBLIC_PROXY_PROTOCOL: "true" }, tls)).toThrow(/requires FLEET_REMOTE_LISTEN_ENABLED/);
    expect(() => loadRemoteConfig({ ...base, FLEET_PUBLIC_PROXY_PROTOCOL: "true" }, tls)).toThrow(/requires FLEET_PUBLIC_LISTEN/);
    for (const listen of ["0.0.0.0:8443", "51.195.148.111:8443", "[::]:8443"]) {
      expect(() => loadRemoteConfig({ ...base, FLEET_PUBLIC_LISTEN: listen, FLEET_PUBLIC_PROXY_PROTOCOL: "true" }, tls)).toThrow(/loopback FLEET_PUBLIC_LISTEN/);
    }
    expect(() => loadRemoteConfig({ ...base, FLEET_PUBLIC_LISTEN: "127.0.0.1:8443", FLEET_PUBLIC_PROXY_PROTOCOL: "yes" }, tls)).toThrow(/true or false/);
  });

  it("the listener itself refuses a non-loopback bind and plain HTTP", async () => {
    const opts = { admin: {} as never, agent: {} as never, realReplicationEnabled: false, reaperIntervalMs: 0, audit: () => {} };
    await expect(new FleetService({ ...opts, tls }).listenProxied(0, "0.0.0.0")).rejects.toThrow(/must bind to loopback/);
    await expect(new FleetService({ ...opts, tls }).listenProxied(0, "::")).rejects.toThrow(/must bind to loopback/);
    await expect(new FleetService(opts).listenProxied(0, "127.0.0.1")).rejects.toThrow(/HTTPS only/);
  });
});
