/**
 * The wake brief (owner directive 2026-10-23: the compact, evolving workspace — a live task brief at each wake) and the
 * packet evidence: a short view over the founder's own records — why it woke, its objective, what it already did (not to be
 * repeated), its plan, the next calls not run, blockers, open customer requests, money — bounded; and each packet it received
 * kept (bounded) in its state.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { WAKE_BRIEF_MAX, wakeBrief, savePacket, PACKETS_FILE, PACKETS_KEPT, type Carry } from "../../fleet/founder/continuity.js";

const carry: Carry = { at: "2026-10-23T13:05:28.000Z", turn: 5, steps: 8, calls: [], plan: "Add the point-7 date line, re-render, inspect, then deliver the revision with a resend reason.",
  done: [{ sig: "a", name: "wallet", args: "{deliver}", result: "ok" }, { sig: "b", name: "customers", args: "{}", result: "ok" }],
  notRun: [{ name: "deliverable", args: "{}" }], refusals: [{ name: "offer", args: "{}", code: "FLEET_PUBLIC_SITE_SELLER_UNSET", reason: "no seller" }] };

describe("the wake brief", () => {
  it("says why, what for, what is done (not to repeat), the plan, what is next, blockers, customers and money — from the records", () => {
    const b = wakeBrief({ reason: "Heartbeat 12 (thinking slot 12). A buyer replied on order 9648c4ba.", goals: [{ id: "g1", title: "Deliver the gas checklist revision" }, { id: "g2", title: "Publish the offer" }],
      carried: carry, previousOutcome: null, obligations: [{ kind: "order", id: "9648c4ba-5a9b-446a-b01f-aa3c963d51ec", state: "unanswered" }], economics: { cash: 9906, survivalEquity: 9906 } });
    expect(b).toMatch(/^WAKE BRIEF \(from your own records\): why now: Heartbeat 12/);
    expect(b).toContain('objective: g1 "Deliver the gas checklist revision" (+1 more open goal)');
    expect(b).toContain("completed actions: wallet, customers — do not repeat them");
    expect(b).toContain("your plan then: Add the point-7 date line");
    expect(b).toContain("next, not run yet: deliverable");
    expect(b).toContain("blocked by: FLEET_PUBLIC_SITE_SELLER_UNSET");
    expect(b).toContain("customers: 1 open, 1 UNANSWERED (order 9648c4ba)");
    expect(b).toContain("money: cash 9906p, survival equity 9906p");
    expect(b.length).toBeLessThanOrEqual(WAKE_BRIEF_MAX);
  });
  it("with nothing carried and no goal it asks for an assessment, not activity", () => {
    const b = wakeBrief({ reason: "", goals: [], carried: null, previousOutcome: "Slept: nothing changed.", obligations: [], economics: {} });
    expect(b).toContain("why now: a scheduled wake");
    expect(b).toContain("no open goal — assess what is worth doing (or sleep with a wake condition if nothing is)");
    expect(b).toContain("last turn ended: Slept: nothing changed.");
  });
});

describe("the packets a founder received", () => {
  it("are kept newest last, bounded in number, 0600", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
    for (let i = 0; i < PACKETS_KEPT + 5; i++) savePacket(d, { at: `t${i}`, turn: i, kind: "full", chars: 10, text: `packet ${i}` });
    const lines = fs.readFileSync(path.join(d, PACKETS_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(PACKETS_KEPT);
    expect(lines.at(-1)).toMatchObject({ turn: PACKETS_KEPT + 4, text: `packet ${PACKETS_KEPT + 4}` });
    expect((fs.statSync(path.join(d, PACKETS_FILE)).mode & 0o777).toString(8)).toBe("600");
  });
});
