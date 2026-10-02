/**
 * F2 Fleet Hub (unit): the static dashboard escapes every value, carries no script or external asset, formats minor
 * units as money and basis points as percentages; the CLI maps commands onto the owner functions with the invoking
 * operator as actor and validates its arguments before touching the database.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { renderHub } from "../../fleet/hub/render.js";
import { HUB_COMMANDS, runHubCommand } from "../../fleet/hub/cli.js";
import type { PgHubAdmin } from "../../fleet/hub/admin.js";

function fakeHub() {
  const calls: Array<[string, unknown[]]> = [];
  const h = new Proxy({}, { get: (_t, name: string) => async (...args: unknown[]) => { calls.push([name, args]); return { ok: true, name }; } }) as unknown as PgHubAdmin;
  return { h, calls };
}

describe("F2 Fleet Hub", () => {
  it("the dashboard is static, escaped and script-free; money and basis points are formatted", () => {
    const html = renderHub({ overview: { treasuryMinor: 123456, rateBp: 2500, note: "<script>alert(1)</script>" },
      agents: [{ agentId: "A", availableMinor: 999, name: "\"><img src=x onerror=alert(1)>" }] }, new Date("2026-10-01T00:00:00Z"));
    // No raw tag from data and no external asset: injected markup survives only as escaped, inert text.
    expect(html).not.toMatch(/<script|<img|<iframe|src=["']?http|href=["']?http/i);
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("£1234.56");
    expect(html).toContain("25.00%");
    expect(html).toContain("£9.99");
    expect(html).toMatch(/not a business approval queue/);
  });

  it("commands map onto owner functions with the operator as actor; arguments are validated first", async () => {
    const { h, calls } = fakeHub();
    const actor = "operator:alice";
    await runHubCommand("hub", ["wallet", "AGENT1"], h, actor);
    await runHubCommand("economy-rail-add", ["paypal", "shared", "receive_payments,refunds", "PayPal treasury@…", "--credential", "c1", "--mode", "sandbox", "Treasury", "PayPal"], h, actor);
    await runHubCommand("economy-wallet-transfer", ["AGENT1", "1500", "operating_pool", "provider", "subscriptions"], h, actor);
    await runHubCommand("economy-breaker-novelty", ["off"], h, actor);
    expect(calls[0]).toEqual(["view", ["wallet", { agentId: "AGENT1" }]]);
    expect(calls[1][0]).toBe("railAdd");
    expect(calls[1][1]).toEqual([{ provider: "paypal", kind: "shared", capabilities: ["receive_payments", "refunds"], accountRef: "PayPal treasury@…", label: "Treasury PayPal",
      entityId: null, credentialId: "c1", mode: "sandbox", dedicatedVentureId: null, maxVentures: null }, actor]);
    expect(calls[2][0]).toBe("walletTransfer");
    expect(calls[2][1].slice(0, 5)).toEqual(["AGENT1", 1500, "operating_pool", "provider subscriptions", actor]);
    expect(calls[3]).toEqual(["breakerNovelty", [null, null, actor]]);
    await expect(runHubCommand("economy-wallet-transfer", ["AGENT1", "15.00", "treasury", "x"], h, actor)).rejects.toThrow(/integer/);
    await expect(runHubCommand("economy-wallet-transfer", ["AGENT1", "100", "owner", "x"], h, actor)).rejects.toThrow(/treasury or operating_pool/);
    await expect(runHubCommand("economy-capital-policy", ["not json"], h, actor)).rejects.toThrow(/JSON object/);
    expect(calls).toHaveLength(4);
    // v34: owner identity vault commands are their own explicit family (owner-identity-*).
    expect([...HUB_COMMANDS].every((c) => c === "hub" || c.startsWith("hub-") || c.startsWith("economy-") || c.startsWith("owner-identity-"))).toBe(true);
  });

  it("hub-render writes one 0600 file with every section and the doctor findings", async () => {
    const { h } = fakeHub();
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hub-")), "hub.html");
    const r = (await runHubCommand("hub-render", [out], h, "operator:alice")) as { sections: string[] };
    expect(r.sections).toEqual(expect.arrayContaining(["overview", "treasury", "rails", "tax", "capital", "profit", "credentials", "audit", "reconcile", "health"]));
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(out, "utf8")).toMatch(/^<!doctype html>/);
  });
});
