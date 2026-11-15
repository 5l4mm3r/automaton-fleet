/**
 * Owner, 2026-10-18: "I need the reference codes to be titled so we know what the reference code is referring to." Fleet HQ
 * shows a code an agent writes with the title of the record it names (from the agent's own thread); other text unchanged.
 */
import { describe, it, expect } from "vitest";
import { refTitles, withTitles } from "../../../codex-dashboard/src/dashboard/conversation/refs.js";

// Agent-1's real message of 2026-10-18 12:55 and the request it names (title as stored).
const ITEMS = [
  { itemType: "request", requestId: "62cbe1b7-0d0e-4f4a-9c55-8f3c2a1b0e11", title: "Owner request: enrol a Gumroad channel for zero-capex digital products", action: "List the landlord compliance tracker on Gumroad" },
  { itemType: "card_request", requestId: "a1b2c3d4-1111-4222-8333-444455556666", merchant: "fontshop.example", purpose: "a font licence" },
  { itemType: "message", messageId: "m1", author: "agent", body: "x" },
];
const MSG = "My landlord-compliance-tracker product is ready to list, and I'm waiting on the Gumroad channel (request 62cbe1b7). Can you approve or decline 62cbe1b7, or enable another channel?";

describe("reference codes are shown with their titles", () => {
  it("an agent's short code becomes the title with the code in brackets, every time it appears", () => {
    expect(withTitles(MSG, refTitles(ITEMS))).toBe("My landlord-compliance-tracker product is ready to list, and I'm waiting on the Gumroad channel (request “Enrol a Gumroad channel for zero-capex digital products” (62cbe1b7)). Can you approve or decline “Enrol a Gumroad channel for zero-capex digital products” (62cbe1b7), or enable another channel?");
  });
  it("full ids, an ellipsis form and card purchases are titled; unknown codes, amounts and other words are untouched", () => {
    const t = refTitles(ITEMS);
    expect(withTitles("see 62cbe1b7-0d0e-4f4a-9c55-8f3c2a1b0e11 and 62cbe1b7…", t)).toBe("see “Enrol a Gumroad channel for zero-capex digital products” (62cbe1b7) and “Enrol a Gumroad channel for zero-capex digital products” (62cbe1b7)");
    expect(withTitles("card a1b2c3d4 approved", t)).toBe("card “Card purchase at fontshop.example — a font licence” (a1b2c3d4) approved");
    expect(withTitles("ledger deadbeef, £12345678, facade12", t)).toBe("ledger deadbeef, £12345678, facade12");
    expect(withTitles(MSG, new Map())).toBe(MSG);
  });
});
