/**
 * R36 edge cutover: the admin certificate check (scripts/fleet-edge.sh check-cert, used by `cutover`).
 *
 * Regression for the production failure of 2026-10-03: Certbot issued a valid ECDSA P-256 certificate whose key matched,
 * yet the cutover refused with "admin key/cert mismatch" because it ran `sudo cmp -s <(…) <(…)` — sudo closes descriptors
 * >= 3, so cmp could not open /dev/fd/6x and exited 2. Here `sudo` is a stand-in that closes every descriptor >= 3 before
 * running the command (sudo's closefrom behaviour) and otherwise runs it as the current user.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.resolve(__dirname, "../../../scripts/fleet-edge.sh");
const HOST = "admin.agentfleet.vip";

describe("R36 edge: admin certificate check survives sudo's descriptor closing", () => {
  let root: string;
  let shim: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-edge-cert-"));
    shim = path.join(root, "bin");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "sudo"), [
      "#!/usr/bin/env bash",
      "# test stand-in for sudo: close every descriptor >= 3 (closefrom), then run the command",
      'for fd in /proc/$$/fd/*; do n=${fd##*/}; [[ $n -gt 2 ]] && eval "exec $n>&-" 2>/dev/null; done',
      'while [[ "${1:-}" == -* ]]; do shift; done',
      'exec "$@"',
    ].join("\n"), { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  /** A Certbot-like lineage: fullchain.pem + privkey.pem (0600). */
  function lineage(name: string, opts: { keyType?: "ec" | "rsa"; san?: string; days?: number; otherKey?: "ec" | "rsa" } = {}): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const newkey = (t: "ec" | "rsa") => (t === "ec" ? ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256"] : ["-newkey", "rsa:2048"]);
    execFileSync("openssl", ["req", "-x509", ...newkey(opts.keyType ?? "ec"), "-nodes", "-days", String(opts.days ?? 90), "-subj", `/CN=${opts.san ?? HOST}`,
      "-addext", `subjectAltName=DNS:${opts.san ?? HOST}`, "-keyout", path.join(dir, "privkey.pem"), "-out", path.join(dir, "fullchain.pem")], { stdio: "ignore" });
    if (opts.otherKey) {
      const args = opts.otherKey === "ec" ? ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"] : ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"];
      execFileSync("openssl", [...args, "-out", path.join(dir, "privkey.pem")], { stdio: "ignore" });
    }
    fs.chmodSync(path.join(dir, "privkey.pem"), 0o600);
    return dir;
  }

  const check = (dir: string, host = HOST) => {
    const r = spawnSync("bash", [SCRIPT, "check-cert", dir, host], { encoding: "utf8", env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("reproduces the root cause: under sudo, cmp cannot read process substitutions (exit 2, no comparison made)", () => {
    const r = spawnSync("bash", ["-c", "sudo cmp -s <(echo same) <(echo same)"], { env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
    expect(r.status).toBe(2);
    // The script no longer hands a process substitution to a sudo'ed command (stdin redirects `< <(…)` are opened by the shell).
    const offending = fs.readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("#") && /sudo[^|;]*[^<]\s<\(/.test(l));
    expect(offending).toEqual([]);
  });

  it("accepts a matching ECDSA P-256 lineage (what Certbot issued in production) and a matching RSA one", () => {
    for (const [name, keyType] of [["ec-ok", "ec"], ["rsa-ok", "rsa"]] as const) {
      const r = check(lineage(name, { keyType }));
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`CERT OK ${HOST}`);
      const [, ch, kh] = /certificate public key sha256 ([0-9a-f]{64}); private key's public key sha256 ([0-9a-f]{64})/.exec(r.out)!;
      expect(ch).toBe(kh);
      expect(r.out).not.toMatch(/PRIVATE KEY/);
    }
  });

  it("refuses a genuinely mismatched key (same type, and a different key type)", () => {
    for (const [name, keyType, otherKey] of [["ec-bad", "ec", "ec"], ["rsa-bad", "rsa", "rsa"], ["mixed-bad", "rsa", "ec"]] as const) {
      const r = check(lineage(name, { keyType, otherKey }));
      expect(r.status, r.out).toBe(2);
      expect(r.out).toContain(`EDGE REFUSED: ${HOST} key/cert mismatch`);
    }
  });

  it("refuses a missing key, another hostname (including a look-alike suffix) and a certificate about to expire", () => {
    const missing = lineage("missing");
    fs.rmSync(path.join(missing, "privkey.pem"));
    expect(check(missing).out).toContain("privkey.pem or fullchain.pem missing");
    expect(check(lineage("other", { san: "api.agentfleet.vip" })).out).toContain("lacks the hostname");
    expect(check(lineage("lookalike", { san: `${HOST}.evil.example` })).out).toContain("lacks the hostname");
    expect(check(lineage("short", { days: 10 })).out).toContain("expires within 30 days");
  });
});
