/**
 * Group A, 24 Oct 2026: the VPS revision rehearsal failed (4c/4d) because its scripted founder looked for the obligation
 * line's pre-v114 wording and never saw the open order. The harness's detection is tied here to the brief's real output.
 */
import { describe, it, expect } from "vitest";
import { openOrderOf } from "../../fleet/eval/revision-rehearsal-model.js";
import { obligationLines, parseObligations } from "../../fleet/founder/obligations.js";

const ORDER = "8ea5ea20-b955-4cbf-99f5-6bf30707e70b", M = "08ca3a2d-038a-4be9-8743-14728fceffc2", C = "33333333-3333-4333-8333-333333333333";
const at = new Date().toISOString();
const lines = (ob: Record<string, unknown>) => obligationLines(parseObligations({ customerObligations: [{ kind: "order", id: ORDER, since: at, lastBuyerAt: at, repliedAt: at, buyerMessages: 1, ...ob }] })!).join("\n");

describe("the revision rehearsal's scripted founder reads the brief as it is written", () => {
  it("sees an acknowledged, owed correction (v115 wording) as its open order", () => {
    const packet = lines({ state: "acknowledged", revisionOwed: true, work: { classify: [], disputed: [], reviewPending: 0,
      corrections: [{ correctionId: C, sourceMessageId: M, criteria: [{ outcome: "Every renewal date is a real date in the file, shown as a date", kind: "change" }] }] } });
    expect(packet).toContain("still OWED");
    expect(openOrderOf(packet)).toBe(ORDER);
  });
  it("still sees an acknowledged request without owed work (the older wording)", () => {
    expect(openOrderOf(lines({ state: "acknowledged" }))).toBe(ORDER);
  });
  it("sees nothing when nothing is open", () => {
    expect(openOrderOf("No customer obligations.")).toBeNull();
  });
});
