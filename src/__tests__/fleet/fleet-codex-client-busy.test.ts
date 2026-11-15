/**
 * The dashboard client under the edge's request limit (mobile fix, 2026-10-16). A refresh's reads are paced
 * (READ_CONCURRENCY in flight), a read the edge refuses as busy (429 / 503) is retried with backoff a bounded number of
 * times, a write is never retried, and reads queued behind a 401 are not sent.
 */
import { describe, it, expect } from "vitest";
import { GatewayClient, READ_CONCURRENCY, READ_BUSY_RETRIES } from "../../../codex-dashboard/src/dashboard/api/client";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
const busy = (status = 503, retryAfter?: string) => new Response("<html><body>503 Service Temporarily Unavailable</body></html>", { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
const store = () => { let v: string | null = "csrf-token"; return { get: () => v, set: (x: string) => { v = x; }, clear: () => { v = null; } }; };
const client = (f: typeof fetch) => new GatewayClient({ baseUrl: "https://admin.example", fetch: f, csrf: store(), share: null });

describe("dashboard client: reads paced and retried when the edge is busy; writes never retried", () => {
  it(`at most ${READ_CONCURRENCY} reads are in flight, however many a refresh starts`, async () => {
    let inFlight = 0, peak = 0;
    const f = (async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return ok(1); }) as typeof fetch;
    const c = client(f);
    const results = await Promise.all(Array.from({ length: 48 }, (_, i) => c.read("op" + i)));
    expect(results).toHaveLength(48);
    expect(peak).toBe(READ_CONCURRENCY);
  });

  it("a read refused as busy (503 HTML, or 429 with Retry-After) is retried and succeeds", async () => {
    let n = 0;
    const c = client((async () => (++n <= 2 ? busy(503) : ok("fine"))) as typeof fetch);
    expect(await c.read("agents")).toBe("fine");
    expect(n).toBe(3);
    let m = 0;
    const t0 = Date.now();
    const d = client((async () => (++m === 1 ? busy(429, "1") : ok("later"))) as typeof fetch);
    expect(await d.read("agents")).toBe("later");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950); // Retry-After honoured
  });

  it(`a read still busy after ${READ_BUSY_RETRIES} retries fails as FLEET_BUSY (bounded), not as a bad response`, async () => {
    let n = 0;
    const c = client((async () => { n++; return busy(503); }) as typeof fetch);
    const e = await c.read("agents").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FleetApiError);
    expect((e as FleetApiError).code).toBe("FLEET_BUSY");
    expect(n).toBe(READ_BUSY_RETRIES + 1);
  }, 15_000);

  it("a write refused as busy is never retried (its outcome is reported, not repeated)", async () => {
    let n = 0;
    const c = client((async () => { n++; return busy(503); }) as typeof fetch);
    await c.call("notification_ack", { id: "x" }).catch(() => {});
    expect(n).toBe(1);
  });

  it("reads queued behind a 401 are not sent; signing in again lifts that", async () => {
    let sent = 0;
    const f = (async () => { sent++; await new Promise((r) => setTimeout(r, 10)); return new Response(JSON.stringify({ ok: false, code: "FLEET_SESSION_INVALID" }), { status: 401 }); }) as typeof fetch;
    const c = client(f);
    const all = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => c.read("op" + i)));
    expect(all.every((r) => r.status === "rejected")).toBe(true);
    expect(sent).toBe(READ_CONCURRENCY); // the first wave only
    c.adoptToken("new-token");
    await c.read("again").catch(() => {});
    expect(sent).toBe(READ_CONCURRENCY + 1);
  });
});
