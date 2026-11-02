/**
 * 2026-11-02 (pilot phase V): Agent-1 offered a buyer a full refund that no route could carry out. Every tool description an
 * agent uses to reply to buyers or record a refund carries the same honesty rule, so no reply promises a refund the Fleet
 * cannot carry out.
 */
import { describe, it, expect } from "vitest";
import { FOUNDER_V7_TOOLS, FOUNDER_V8_TOOLS } from "../../fleet/cognition/types.js";

const RULE = "Never tell a buyer that a refund is done, approved or guaranteed until it is recorded as completed; when the owner must decide, say you have passed the request on.";

describe("refund wording (phase V lesson)", () => {
  it("the buyer-reply tool and the external-refund record both carry the rule", () => {
    const desc = (n: string) => [...FOUNDER_V7_TOOLS, ...FOUNDER_V8_TOOLS].find((t) => t.name === n)?.description ?? "";
    expect(desc("customers")).toContain(RULE);
    const business = desc("business");
    expect(business).toContain("refund_external_order");
    expect(business.slice(business.indexOf("refund_external_order"))).toContain(RULE);
  });
});
