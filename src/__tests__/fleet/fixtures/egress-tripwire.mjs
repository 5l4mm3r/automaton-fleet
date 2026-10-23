// Test-only egress tripwire (2026-10-23, local-only acceptance). Preloaded with NODE_OPTIONS="--import <this file>":
// any TCP connection or DNS lookup to a non-loopback destination is REFUSED and appended to $FLEET_EGRESS_LOG, so a run can
// prove that no external request was even attempted. (Process-level evidence; the target machine's network-off test is
// the stronger check.)
import fs from "node:fs";
import net from "node:net";
import dns from "node:dns";

const LOG = process.env.FLEET_EGRESS_LOG || "";
const LOOPBACK = (h) => !h || h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h) || h === "0.0.0.0";
const note = (what) => { if (LOG) try { fs.appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${what}\n`); } catch { /* best effort */ } };

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
  if (!o.path && !LOOPBACK(o.host)) {
    note(`REFUSED connect ${o.host}:${o.port}`);
    const err = Object.assign(new Error(`egress tripwire: ${o.host}:${o.port} refused (local-only run)`), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!LOOPBACK(host)) {
    note(`REFUSED dns ${host}`);
    const cb = rest.find((x) => typeof x === "function");
    const err = Object.assign(new Error(`egress tripwire: dns ${host} refused`), { code: "ENOTFOUND" });
    if (cb) process.nextTick(() => cb(err));
    return {};
  }
  return origLookup.call(this, host, ...rest);
};
note("tripwire armed");
