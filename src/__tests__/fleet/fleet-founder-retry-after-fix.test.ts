/**
 * The measured attempt of 2026-10-18 (17:41Z): Agent-1 reviewed its files and tried to publish. Publishing was refused
 * (FLEET_CAPABILITY_CHECK_REQUIRED), so it ran the capability check; every retry of the publish was then refused by the
 * loop guard as "an identical call already failed and nothing it depends on has changed", because only LOCAL tools counted
 * as changes. An offer edit that broke a database rule also reached it as a bare FLEET_REQUEST_FAILED. Both are fixed:
 *  - any successful call that is not a read changes the guard's state (controller-side changes included);
 *  - a refusal keeps the controller's reason.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FounderToolbox, isReadOnlyCall } from "../../fleet/founder/toolbox.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const c = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });

function rig(economy: (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retry-"));
  const w = path.join(root, "w"), m = path.join(root, "m");
  fs.mkdirSync(w, { recursive: true }); fs.mkdirSync(m);
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: w, memoryDir: m, loopGuard, selfGovernance: true,
    ports: { economy: async (op: string, args?: Record<string, unknown>) => economy(op, args ?? {}) } as never });
  return { toolbox, loopGuard };
}

describe("a retry after the missing condition was fixed (measured attempt, 2026-10-18)", () => {
  it("the publish is retried after a successful controller-side change; an identical retry with nothing done in between is still refused", async () => {
    let checked = false;
    const calls: string[] = [];
    const r = rig(async (op) => {
      calls.push(op);
      if (op === "offer.publish") {
        if (!checked) { const e = Object.assign(new Error("a capability check naming this offer is required first"), { code: "FLEET_CAPABILITY_CHECK_REQUIRED" }); throw e; }
        return { ok: true, status: "published" };
      }
      if (op === "offer.update") { checked = true; return { ok: true }; }
      if (op === "offer.list") return { ok: true, offers: [] };
      return { ok: true };
    });
    const publish = () => c("offer", { op: "publish", args: { offerId: "o1", reviewId: "r1" } });
    const first = await r.toolbox.execute(publish());
    expect(first.ok).toBe(false);
    expect(first.refused).toBe("FLEET_CAPABILITY_CHECK_REQUIRED");
    // Nothing done in between (only a read): the identical retry is still refused by the guard.
    await r.toolbox.execute(c("offer", { op: "list" }));
    const blocked = await r.toolbox.execute(publish());
    expect(blocked.refused).toBe("FLEET_DUPLICATE_FAILED_ACTION");
    // A successful controller-side change (the precondition fixed): the retry runs and succeeds.
    expect((await r.toolbox.execute(c("offer", { op: "update", args: { offerId: "o1", title: "UK Landlord Compliance Tracker" } }))).ok).toBe(true);
    const retried = await r.toolbox.execute(publish());
    expect(retried.ok).toBe(true);
    expect(calls.filter((x) => x === "offer.publish")).toHaveLength(2);
  });

  it("a refusal tells the agent WHY (the controller's reason), not just a code", async () => {
    const r = rig(async () => { throw Object.assign(new Error("a value breaks the rule fleet_offers_title_check (new row for relation \"fleet_offers\" violates check constraint)"), { code: "FLEET_BAD_REQUEST" }); });
    const out = await r.toolbox.execute(c("offer", { op: "update", args: { offerId: "o1", title: "x".repeat(130) } }));
    expect(out.ok).toBe(false);
    expect(out.output).toContain("fleet_offers_title_check");
  });

  it("read-only classification: reads never count as a change; any other successful call does", () => {
    for (const k of [c("read_file", { path: "x" }), c("list_files"), c("web_search", { query: "q" }), c("offer", { op: "list" }), c("storefront", { op: "products" }), c("wallet", { op: "orders" })])
      expect(isReadOnlyCall(k), k.name).toBe(true);
    for (const k of [c("capabilities", { offer: "o1" }), c("offer", { op: "update" }), c("offer", { op: "publish" }), c("deliverable", { op: "review" }), c("business", { op: "no_such_op" }), c("write_file", { path: "x" })])
      expect(isReadOnlyCall(k), k.name).toBe(false);
    // The guard itself: an explicit "changed" lets the failed call run again; "not changed" keeps it refused.
    const g = new LoopGuard();
    const x = c("offer", { op: "publish", args: { offerId: "o1" } });
    g.after(x, { name: "offer", ok: false, refused: "FLEET_CAPABILITY_CHECK_REQUIRED", output: "no" }, false);
    g.after(c("list_files"), { name: "list_files", ok: true, output: "a" }, false);
    expect(g.before(x)?.refused).toBe("FLEET_DUPLICATE_FAILED_ACTION");
    g.after(c("capabilities", { offer: "o1" }), { name: "capabilities", ok: true, output: "ok" }, true);
    expect(g.before(x)).toBeNull();
  });

  it("an unrelated successful write between failing publishes cannot loop: after 3 failures of the identical call it is refused until the approach changes", async () => {
    const publishes: number[] = [];
    const r = rig(async (op) => {
      if (op === "offer.publish") { publishes.push(1); throw Object.assign(new Error("a value breaks the rule fleet_offers_title_check"), { code: "FLEET_BAD_REQUEST" }); }
      return { ok: true };
    });
    const publish = () => c("offer", { op: "publish", args: { offerId: "o1", reviewId: "r1" } });
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) {
      // A different, successful, unrelated write each time (a new file): it changes state, so the guard alone would allow a retry.
      expect((await r.toolbox.execute(c("write_file", { path: `notes/attempt-${i}.md`, content: `note ${i}` }))).ok).toBe(true);
      outcomes.push((await r.toolbox.execute(publish())).refused ?? "ok");
    }
    expect(publishes).toHaveLength(3);                               // executed at most 3 times
    expect(outcomes.slice(0, 3)).toEqual(["FLEET_BAD_REQUEST", "FLEET_BAD_REQUEST", "FLEET_BAD_REQUEST"]);
    expect(new Set(outcomes.slice(3))).toEqual(new Set(["FLEET_REPEATED_FAILURE"]));
    // A changed approach (different arguments, e.g. a fixed title) still runs.
    const fixed = await r.toolbox.execute(c("offer", { op: "publish", args: { offerId: "o1", reviewId: "r2" } }));
    expect(fixed.refused).toBe("FLEET_BAD_REQUEST");                 // ran (the stub always fails), not blocked
    expect(publishes).toHaveLength(4);
  });
});
