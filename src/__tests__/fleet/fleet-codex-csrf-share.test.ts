/**
 * The dashboard client's CSRF handling across tabs (unit; a fake gateway that behaves like dash_call: the token is
 * checked first, a refusal changes nothing). See codex-dashboard/src/dashboard/api/client.ts.
 */
import { describe, it, expect } from "vitest";
import { broadcastTokenShare, GatewayClient, type TokenStore } from "../../../codex-dashboard/src/dashboard/api/client";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";

const store = (v: string | null = null): TokenStore & { v: string | null } => {
  const s = { v, get: () => s.v, set: (x: string) => { s.v = x; }, clear: () => { s.v = null; } };
  return s;
};
const T1 = "a".repeat(43), T2 = "b".repeat(43);

/** A gateway whose session's current token is `current`; records every request and what it applied. */
function gateway(current: { token: string | null; session: boolean }) {
  const seen: Array<{ path: string; csrf: string | null; applied: boolean }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>, csrf = h["X-CSRF"] ?? null, path = String(url).replace(/^https?:\/\/[^/]+/, "");
    let body: Record<string, unknown>;
    if (!current.session) { seen.push({ path, csrf, applied: false }); return new Response(JSON.stringify({ ok: false, code: "FLEET_SESSION_INVALID" }), { status: 401 }); }
    if (csrf !== current.token) { seen.push({ path, csrf, applied: false }); body = { ok: false, code: "FLEET_CSRF" }; return new Response(JSON.stringify(body), { status: 400 }); }
    seen.push({ path, csrf, applied: true });
    return new Response(JSON.stringify({ ok: true, result: { ok: true } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch, seen };
}
const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof FleetApiError ? e.code : String(e)));

describe("dashboard client: CSRF token per tab, handed between this origin's tabs, never weakened", () => {
  it("a tab with its own valid token writes once, with X-CSRF", async () => {
    const g = gateway({ token: T1, session: true });
    const c = new GatewayClient({ baseUrl: "http://x", fetch: g.fetch, csrf: store(T1), share: null });
    expect(await codeOf(c.call("notification_ack", { id: "n1" }))).toBe("OK");
    expect(g.seen).toEqual([{ path: "/api/call", csrf: T1, applied: true }]);
  });

  it("a new tab (no token) takes the token from another open tab (BroadcastChannel, same origin) and writes", async () => {
    const g = gateway({ token: T1, session: true });
    const signedIn = store(T1), fresh = store(null);
    const peer = broadcastTokenShare(signedIn, "test-share-1")!; void peer; // the tab that signed in (answers requests)
    const c = new GatewayClient({ baseUrl: "http://x", fetch: g.fetch, csrf: fresh, share: broadcastTokenShare(fresh, "test-share-1") });
    expect(await codeOf(c.call("notification_ack", { id: "n1" }))).toBe("OK");
    expect(fresh.v).toBe(T1);
    expect(g.seen).toEqual([{ path: "/api/call", csrf: T1, applied: true }]);
  });

  it("no tab can provide a token: the gateway refuses (nothing applied) and the tab must be verified", async () => {
    const g = gateway({ token: T1, session: true });
    const c = new GatewayClient({ baseUrl: "http://x", fetch: g.fetch, csrf: store(null), share: broadcastTokenShare(store(null), "test-share-empty") });
    expect(await codeOf(c.call("notification_ack", { id: "n1" }))).toBe("FLEET_TAB_UNVERIFIED");
    expect(g.seen.every((r) => !r.applied)).toBe(true);
  });

  it("an ended session still answers 401 and returns to sign-in (not 'verify this tab')", async () => {
    const g = gateway({ token: T1, session: false });
    let signedOut = 0;
    const c = new GatewayClient({ baseUrl: "http://x", fetch: g.fetch, csrf: store(null), share: null, onSignedOut: () => { signedOut++; } });
    expect(await codeOf(c.call("notification_ack", { id: "n1" }))).toBe("FLEET_SESSION_INVALID");
    expect(signedOut).toBe(1);
  });

  it("a stale token (the session was replaced by a sign-in elsewhere) is refused, then retried ONCE with the current token", async () => {
    const g = gateway({ token: T2, session: true });
    const stale = store(T1), current = store(T2);
    broadcastTokenShare(current, "test-share-2");
    const c = new GatewayClient({ baseUrl: "http://x", fetch: g.fetch, csrf: stale, share: broadcastTokenShare(stale, "test-share-2") });
    expect(await codeOf(c.call("notification_ack", { id: "n1" }))).toBe("OK");
    expect(g.seen.map((r) => [r.csrf, r.applied])).toEqual([[T1, false], [T2, true]]); // refused (nothing ran), then applied once
  });

  it("no endless retry: a peer offering the same (stale) token, or a second refusal, ends in 'verify this tab'", async () => {
    const g = gateway({ token: T2, session: true });
    const stale = store(T1), alsoStale = store(T1);
    broadcastTokenShare(alsoStale, "test-share-3");
    const c = new GatewayClient({ baseUrl: "http://x", fetch: g.fetch, csrf: stale, share: broadcastTokenShare(stale, "test-share-3") });
    expect(await codeOf(c.call("notification_ack", { id: "n1" }))).toBe("FLEET_TAB_UNVERIFIED");
    expect(g.seen.length).toBe(1);
  });

  it("network failures are never retried (unknown outcome); malformed tokens from a channel are ignored; sign-in announces", async () => {
    let n = 0;
    const c = new GatewayClient({ baseUrl: "http://x", fetch: (async () => { n++; throw new Error("down"); }) as unknown as typeof fetch, csrf: store(T1), share: null });
    expect(await codeOf(c.call("notification_ack", { id: "n1" }))).toBe("FLEET_OUTCOME_UNKNOWN");
    expect(n).toBe(1);
    const a = store(null), b = store(null);
    broadcastTokenShare(a, "test-share-4");
    const bc = new BroadcastChannel("test-share-4");
    bc.postMessage({ kind: "rotated", token: "<script>" }); bc.postMessage({ kind: "rotated", token: 42 });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.v).toBeNull();
    // A tab that signs in announces its token; the other tabs adopt it (the session cookie now belongs to it).
    const signer = new GatewayClient({ baseUrl: "http://x", fetch: (async () => new Response("{}")) as unknown as typeof fetch, csrf: b, share: broadcastTokenShare(b, "test-share-4") });
    signer.adoptToken(T2);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.v).toBe(T2);
    bc.close();
  });
});

describe("the preview on the production backend (schema 41): v42 reads degrade, nothing is invented", () => {
  it("a gateway without the v42 'projects' read: projects are listed as unavailable, every other panel still loads", async () => {
    const { CommandReader } = await import("../../../codex-dashboard/src/dashboard/api/command");
    const agents = [{ agentId: "01AAA", name: "founder-1", status: "active", cashMinor: 10000, valueMinor: 10000, held: false, mode: "NORMAL", createdAt: "2026-09-26T00:00:00Z" }];
    const fetch = (async (url: string) => {
      const u = new URL(String(url), "http://x"), op = u.searchParams.get("op");
      if (op === "projects") return new Response(JSON.stringify({ ok: false, code: "FLEET_UNKNOWN_OP" }), { status: 400 }); // schema 41
      const result = op === "agents" ? agents : op === "settings" ? {} : op === "hub" && u.searchParams.get("args")?.includes("overview") ? { currency: "GBP" } : op === "hub" && u.searchParams.get("args")?.includes("treasury") ? {} : [];
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const view = await new CommandReader(new GatewayClient({ baseUrl: "http://x", fetch, share: null })).load();
    expect(view.unavailable).toContain("projects");
    expect(view.projects).toEqual([]); expect(view.projectSummary).toBeNull();
    expect(view.unavailable).not.toContain("agents"); expect(view.unavailable).not.toContain("events");
  });
});
