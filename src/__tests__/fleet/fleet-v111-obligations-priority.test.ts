/**
 * v111 (2026-10-23): open customer requests are listed most urgent first and none is hidden. v100's controller returned the
 * 10 OLDEST, so an 11th — a paid order's new message behind 10 old enquiries — was neither shown nor stopped the agent's sleep.
 * The packet spells out OBLIGATIONS_SHOWN and counts the rest; every unanswered one, shown or counted, blocks sleep.
 */
import { describe, it, expect } from "vitest";
import { obligationLines, parseObligations, OBLIGATIONS_SHOWN } from "../../fleet/founder/obligations.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const t = (h: number) => new Date(Date.parse("2026-10-22T00:00:00Z") + h * 3_600_000).toISOString();

describe("customer obligations beyond the first page", () => {
  it("parses up to 50; shows the first OBLIGATIONS_SHOWN and counts the rest, with how many are unanswered", () => {
    const raw = Array.from({ length: 14 }, (_, i) => ({ kind: i === 0 ? "order" : "enquiry", id: uuid(i), state: i < 12 ? "unanswered" : "acknowledged",
      since: t(i), lastBuyerAt: t(i), buyerMessages: 1, ...(i >= 12 ? { repliedAt: t(i + 1) } : {}) }));
    const list = parseObligations({ customerObligations: raw })!;
    expect(list).toHaveLength(14);                                              // v100's runtime kept 10
    const [line] = obligationLines(list);
    expect(line).toContain(`order ${uuid(0)}`);
    expect(line).not.toContain(uuid(OBLIGATIONS_SHOWN));                       // not spelled out …
    expect(line).toContain("…and 4 more open requests (2 unanswered)");       // … but counted
    expect(line).toContain("you cannot sleep while a buyer waits");
  });
});
