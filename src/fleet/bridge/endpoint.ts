/**
 * Bridges — Operator API endpoint identity (shared by the SSH-tunnel and
 * direct loopback transports). The endpoint must answer the unauthenticated
 * /healthz and /readyz probes with exactly the Operator API's shapes.
 */

import http from "http";
import { BridgeError } from "./errors.js";

function getJson(port: number, p: string, timeoutMs: number): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: "GET", headers: { host: `127.0.0.1:${port}`, accept: "application/json", connection: "close" } },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => {
          size += d.length;
          if (size > 16 * 1024) req.destroy(new Error("too large"));
          else chunks.push(d);
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            reject(new Error("not JSON"));
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** The endpoint must answer exactly like the Operator API's unauthenticated probes. */
export async function verifyOperatorEndpoint(port: number, timeoutMs = 5000): Promise<{ ready: boolean; state: string }> {
  const notApi = (why: string): never => {
    throw new BridgeError("TUNNEL_NOT_OPERATOR_API", `the tunnel endpoint is not the Operator API (${why})`);
  };
  let h: { status: number; json: unknown };
  let r: { status: number; json: unknown };
  try {
    h = await getJson(port, "/healthz", timeoutMs);
    r = await getJson(port, "/readyz", timeoutMs);
  } catch (err) {
    return notApi(err instanceof Error ? err.message : "no answer");
  }
  const hj = h.json as Record<string, unknown>;
  if (h.status !== 200 || !hj || Object.keys(hj).sort().join(",") !== "ok,status" || hj.ok !== true || hj.status !== "alive") notApi("/healthz shape");
  const rj = r.json as Record<string, unknown>;
  if (!rj || typeof rj !== "object" || Object.keys(rj).sort().join(",") !== "checks,ready,state") notApi("/readyz shape");
  if (typeof rj.ready !== "boolean" || !["ready", "disabled", "not_ready"].includes(rj.state as string)) notApi("/readyz values");
  if (!rj.checks || typeof rj.checks !== "object" || Array.isArray(rj.checks)) notApi("/readyz checks");
  if ((r.status === 200) !== (rj.ready === true) || (r.status !== 200 && r.status !== 503)) notApi("/readyz status");
  return { ready: rj.ready as boolean, state: rj.state as string };
}

