/**
 * v89 units: the strict patch applier (exact context; no unsafe paths, binaries, renames or modes), the build egress
 * proxy (HTTPS CONNECT to allow-listed registries on 443 only, a real tunnel test on loopback), the GitHub App JWT, the
 * gateway's branch rule, and the services' fail-closed startup.
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import net from "net";
import { applyFile, parsePatch } from "../../fleet/code/patch.js";
import { allowedTarget, parseAllow, startEgressProxy } from "../../fleet/build/egress-proxy.js";
import { appJwt, GitHubApp } from "../../fleet/code/github.js";
import { codeEnvProblems } from "../../fleet/code/main.js";
import { buildEnvProblems } from "../../fleet/build/main.js";

const diff = (body: string[]) => body.join("\n") + "\n";

describe("v89 code maintenance units", () => {
  it("applies a patch only where its context matches exactly; creates and deletes whole files", () => {
    const [ch] = parsePatch(diff(["--- a/x.py", "+++ b/x.py", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"]));
    expect(applyFile(ch, "a\nb\nc\n")).toBe("a\nB\nc\n");
    expect(() => applyFile(ch, "a\nX\nc\n")).toThrow(/does not match/);
    const [cr] = parsePatch(diff(["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+one", "+two"]));
    expect(applyFile(cr, null)).toBe("one\ntwo\n");
    expect(() => applyFile(cr, "exists")).toThrow(/already exists/);
    const [dl] = parsePatch(diff(["--- a/old.txt", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-gone"]));
    expect(applyFile(dl, "gone\n")).toBeNull();
  });

  it("refuses unsafe paths, binaries, renames, mode changes, symlinks and empty patches", () => {
    for (const p of ["../etc/passwd", ".git/config", "/abs/path", "a/../../b"]) {
      expect(() => parsePatch(diff([`--- a/${p}`, `+++ b/${p}`, "@@ -1 +1 @@", "-x", "+y"])), p).toThrow(/unsafe path/);
    }
    expect(() => parsePatch(diff(["diff --git a/i.png b/i.png", "GIT binary patch", "literal 1"]))).toThrow(/binary/);
    expect(() => parsePatch(diff(["diff --git a/a b/b", "similarity index 90%", "rename from a", "rename to b"]))).toThrow(/renames/);
    expect(() => parsePatch(diff(["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"]))).toThrow(/mode/);
    expect(() => parsePatch(diff(["diff --git a/l b/l", "new file mode 120000", "--- /dev/null", "+++ b/l", "@@ -0,0 +1 @@", "+target"]))).toThrow(/regular files/);
    expect(() => parsePatch("")).toThrow(/no file/);
  });

  it("the egress proxy tunnels only to allow-listed registries on 443; plain HTTP and everything else are refused", async () => {
    const allow = parseAllow(undefined);
    expect(allowedTarget("registry.npmjs.org:443", allow)).toEqual({ host: "registry.npmjs.org", port: 443 });
    for (const t of ["registry.npmjs.org:80", "evil.example.com:443", "140.82.112.3:443", "registry.npmjs.org.evil.com:443", "pypi.org", "[::1]:443"]) expect(allowedTarget(t, allow), t).toBeNull();
    expect(() => parseAllow("ok.example.com,not a host")).toThrow(/not a host/);
    // A real tunnel on loopback: the "registry" is a local echo server reached through the proxy's injected connector.
    const sockets: net.Socket[] = [];
    const echo = net.createServer((s) => { sockets.push(s); s.on("data", (d) => s.write(d)); });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const echoPort = (echo.address() as net.AddressInfo).port;
    const seen: string[] = [];
    const proxy = await startEgressProxy({ port: 0, allow: ["registry.npmjs.org"], connect: (_p, h) => { seen.push(h); return net.connect(echoPort, "127.0.0.1"); } });
    const port = (proxy.address() as net.AddressInfo).port;
    const talk = (target: string) => new Promise<string>((resolve) => {
      const c = net.connect(port, "127.0.0.1", () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let buf = "";
      c.on("data", (d) => { buf += d.toString(); if (buf.includes("\r\n\r\n") && !buf.includes("ping")) c.write("ping"); if (buf.includes("ping") || buf.startsWith("HTTP/1.1 403")) { c.end(); resolve(buf); } });
      c.on("close", () => resolve(buf));
    });
    expect(await talk("registry.npmjs.org:443")).toMatch(/^HTTP\/1.1 200 Connection Established[\s\S]*ping$/);
    expect(await talk("evil.example.com:443")).toMatch(/^HTTP\/1.1 403/);
    expect(seen).toEqual(["registry.npmjs.org"]);
    const plain = await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: "registry.npmjs.org" } });
    expect(plain.status).toBe(403);
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    for (const x of sockets) x.destroy();
    await new Promise((r) => echo.close(r));
  });

  it("the app JWT is RS256 for 9 minutes; a proposal never targets anything but a new fleet/ branch", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt("42", privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1_000_000);
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "42" });
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    const calls: string[] = [];
    const app = new GitHubApp({ appId: "42", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      http: async (url) => { calls.push(url); return { status: 500, headers: { get: () => null }, json: async () => ({}), bytes: async () => Buffer.alloc(0) }; } });
    const base = { installationId: 1, repo: "acme/calc", baseBranch: "main", baseSha: "a".repeat(40), patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", title: "t", body: "b" };
    for (const branch of ["main", "feature/x", "fleet/../main", "fleet/UPPER"]) await expect(app.propose({ ...base, branch }), branch).rejects.toThrow(/fleet\/ branches/);
    expect(calls).toEqual([]); // refused before any call
  });

  it("the code gateway and the build environment refuse unsafe starts; the build environment holds no credential at all", () => {
    const u = { uid: 1000, username: "u" };
    expect(codeEnvProblems({ FLEET_CODE_DATABASE_URL: "postgresql://x", CREDENTIALS_DIRECTORY: "/run/credentials/c" }, u)).toEqual([]);
    expect(codeEnvProblems({ FLEET_CODE_DATABASE_URL: "postgresql://x", FLEET_CUSTODY_DATABASE_URL: "y" }, u).join()).toMatch(/FLEET_CUSTODY_DATABASE_URL/);
    expect(codeEnvProblems({ FLEET_CODE_DATABASE_URL: "postgresql://x" }, { uid: 0, username: "root" }).join()).toMatch(/root/);
    expect(buildEnvProblems({ FLEET_BUILD_DATABASE_URL: "postgresql://x" }, u)).toEqual([]);
    for (const k of ["CREDENTIALS_DIRECTORY", "GITHUB_TOKEN", "NPM_TOKEN", "FLEET_CODE_DATABASE_URL"]) {
      expect(buildEnvProblems({ FLEET_BUILD_DATABASE_URL: "postgresql://x", [k]: "v" }, u).join(), k).toMatch(new RegExp(k));
    }
    expect(buildEnvProblems({ FLEET_BUILD_DATABASE_URL: "postgresql://x", REAL_PAYMENTS_ENABLED: "true" }, u).join()).toMatch(/REAL_PAYMENTS_ENABLED/);
  });

  it("the code, build and proxy units hide the whole configuration directory and the Fleet's state; the build environment reaches loopback only", async () => {
    const fs = await import("fs");
    for (const unit of ["automaton-fleet-code.service", "automaton-fleet-build.service", "automaton-fleet-build-proxy.service"]) {
      const t = fs.readFileSync(`deploy/systemd/${unit}`, "utf8");
      expect(t, unit).toMatch(/^InaccessiblePaths=-\/etc\/automaton-fleet$/m); // every env file and key, including ones added later
      expect(t, unit).toMatch(/^InaccessiblePaths=-\/home .*-\/var\/lib\/automaton-fleet-custody /m);
      expect(t, unit).toMatch(/^ProtectProc=invisible$/m);
      expect(t, unit).toMatch(/^NoNewPrivileges=true$/m);
    }
    const b = fs.readFileSync("deploy/systemd/automaton-fleet-build.service", "utf8");
    expect(b).toMatch(/^IPAddressDeny=any$/m);
    expect(b).toMatch(/^IPAddressAllow=localhost$/m);
    expect(b).not.toMatch(/^(LoadCredential|SetCredential)=/m);
  });

  it("every unit that denies loopback but calls the internet can still resolve names — through the resolver stub only", async () => {
    // Found on the production host 2026-10-17: the host's resolver is systemd-resolved at 127.0.0.53; a unit denying
    // 127.0.0.0/8 without this exception cannot resolve any name ("fetch failed"). Only the stub is allowed — nothing else local.
    const fs = await import("fs");
    for (const name of fs.readdirSync("deploy/systemd").filter((f) => f.endsWith(".service"))) {
      const t = fs.readFileSync(`deploy/systemd/${name}`, "utf8");
      if (!/^IPAddressDeny=.*(127\.0\.0\.0\/8|localhost)/m.test(t) || /^IPAddressDeny=any$/m.test(t)) continue; // loopback-only units need no DNS
      // The research fetcher queries its own public DNS servers by design (it validates and pins every address itself).
      if (name === "automaton-fleet-fetcher.service") { expect(t).toMatch(/resolves \(its own public DNS/); expect(t).not.toMatch(/^IPAddressAllow=/m); continue; }
      expect(t, name).toMatch(/^IPAddressAllow=127\.0\.0\.53\/32 127\.0\.0\.54\/32$/m);
      expect([...t.matchAll(/^IPAddressAllow=(.*)$/gm)].map((m) => m[1]), name).toEqual(["127.0.0.53/32 127.0.0.54/32"]);
    }
  });
});
