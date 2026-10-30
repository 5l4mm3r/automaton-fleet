/** v123 UI 0.28.0: Treasury Watch states its freshness and its movements, and never shows a bare balance without saying why. */
import { describe, it, expect } from "vitest";
import { createElement } from "../../../codex-dashboard/node_modules/react";
import { renderToStaticMarkup } from "../../../codex-dashboard/node_modules/react-dom/server";
import { ProviderSync, TreasuryMovements } from "../../../codex-dashboard/src/dashboard/money/MoneyPanels";

const sync = {
  state: "needs_review", lastTransactionIngestedAt: "2026-10-30T11:07:46Z", needsReview: 1,
  search: { lastOkAt: "2026-10-30T11:07:46Z", ageMinutes: 3, lastHttp: 200, reportedUpTo: "2026-10-30T08:59:59+0000", returned: 1, ingested: 1, dropped: 0, refused: 0, truncated: false },
  balances: { refreshedAt: "2026-10-30T09:00:00Z", lastHttp: 200 }, backfill: { lastOkAt: "2026-10-30T10:00:00Z", lastHttp: 200, horizonDays: 93 },
  webhooks: { receivedEver: 0, configured: true, delivering: false }, unmatchedReceipts: { count: 1, items: [] }, reconciliation: { open: 0, items: [] },
};
const movement = { movementId: "m1", transactionId: "TX1", eventCode: "T0700", direction: "in", amountMinor: 250, feeMinor: 0, currency: "GBP", providerStatus: "S", classification: "top_up",
  accountingStatus: "needs_review", rule: "auto-booking is off", action: "this looks like a top-up but was not booked automatically", initiatedAt: "2026-10-30T08:54:24Z" };

describe("Treasury Watch in HQ", () => {
  it("separates the Fleet's last read from how far PayPal's data reaches, and says configured webhooks are not working", () => {
    const html = renderToStaticMarkup(createElement(ProviderSync, { s: sync }));
    expect(html).toContain("Some treasury movements need a look");
    expect(html).toContain("2026-10-30 11:07 UTC (3 min ago)");
    expect(html).toContain("2026-10-30 08:59 UTC");
    expect(html).toContain("1 returned · 1 taken in · 0 dropped · 0 refused");
    expect(html).toContain("configured is not working");
    expect(html).toContain("older data is not re-read");
  });
  it("an unavailable state is said out loud, not shown as zero", () => {
    expect(renderToStaticMarkup(createElement(ProviderSync, { s: null }))).toContain("unavailable");
  });
  it("every movement shows its type, PayPal status, accounting status and the action", () => {
    const html = renderToStaticMarkup(createElement(TreasuryMovements, { movements: [movement] }));
    for (const t of ["T0700", "top up", "TX1", "needs a look: not booked", "auto-booking is off", "not booked automatically", "£2.50"]) expect(html).toContain(t);
    expect(renderToStaticMarkup(createElement(TreasuryMovements, { movements: [] }))).toContain("No treasury movements reported by PayPal yet");
  });
});
