/**
 * 2026-10-24 (hourly limit, controller-authoritative): a refused call's Retry-After — FleetController's own time at which
 * the next call is eligible — reaches the caller as retryAfterS (whole seconds, 1..3600); a missing or malformed header
 * gives none, and the founder falls back to its one-minute rest.
 */
import { describe, it, expect } from "vitest";
import { FleetApiClient } from "../../fleet/service/client.js";
import { agentIdFromToken, mintAgentToken } from "../../fleet/postgres/store.js";

const TOKEN = mintAgentToken("01M3F50SH7PNX2E3GST13J52AS");
function client(retryAfter: string | null) {
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith("/v1/session")) return new Response(JSON.stringify({ ok: true, sessionToken: "s".repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() }), { status: 200 });
    return new Response(JSON.stringify({ ok: false, code: "FLEET_COGNITION_RATE_LIMITED", reason: "inference not authorized" }),
      { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } });
  }) as unknown as typeof fetch;
  return new FleetApiClient({ baseUrl: "http://127.0.0.1:9", agentId: agentIdFromToken(TOKEN)!, token: TOKEN, fetchImpl });
}
const refusal = (c: FleetApiClient) => c.infer([{ role: "user", content: "x" }], 10_000).then(() => null, (e) => e as { code?: string; retryAfterS?: number });

describe("Retry-After on a refused call (hourly limit)", () => {
  it("carries the controller's eligibility time", async () => {
    expect(await refusal(client("1187"))).toMatchObject({ code: "FLEET_COGNITION_RATE_LIMITED", retryAfterS: 1187 });
  });
  it("gives none for a missing, malformed or out-of-range header", async () => {
    for (const h of [null, "soon", "0", "7200", "1.5"]) expect((await refusal(client(h)))?.retryAfterS, String(h)).toBeUndefined();
  });
});
