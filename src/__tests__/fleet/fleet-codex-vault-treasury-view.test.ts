/**
 * HQ 0.27.0 — sealed information and treasury figures (owner, 2026-10-26).
 *  - a sealed item is "stored", "not stored", "loading" or "unavailable": an entry form only for "not stored";
 *  - an incomplete address, bank details or a blank fact is refused before anything is sealed (it would replace the stored one);
 *  - the available treasury is a backed figure or says why it is unknown — never 0 for unknown, never the ledger partition sum.
 */
import { describe, it, expect } from "vitest";
import { addressProblem, availableTreasuryText, bankProblem, factProblem, knownMoney, vaultItemState } from "../../../codex-dashboard/src/dashboard/money/vault-view";

const money = (n: number) => `£${(n / 100).toFixed(2)}`;

describe("HQ sealed information and treasury view", () => {
  it("a sealed item's state: never an entry form while unknown", () => {
    expect(vaultItemState({ data: null, error: "" }, false)).toBe("loading");
    expect(vaultItemState({ data: null, error: "FLEET_UNAVAILABLE" }, false)).toBe("unavailable");
    expect(vaultItemState({ data: { configured: {} }, error: "boom" }, true)).toBe("unavailable");
    expect(vaultItemState({ data: { configured: {} }, error: "" }, false)).toBe("not_stored");
    expect(vaultItemState({ data: { configured: {} }, error: "" }, true)).toBe("stored");
  });

  it("blank or incomplete values are refused (a sealed upload replaces the stored value)", () => {
    expect(addressProblem({ line1: "", line2: "", city: "", postcode: "", country: "United Kingdom" })).toMatch(/line 1, town \/ city, postcode/);
    expect(addressProblem({ line1: "  ", line2: "", city: "London", postcode: "W1S 4JL", country: "United Kingdom" })).toMatch(/line 1/);
    expect(addressProblem({ line1: "3rd floor, 45 Example Street", line2: "", city: "London", postcode: "W1S 4JL", country: "United Kingdom" })).toBeNull();
    expect(bankProblem({ holder: "J Smith", sortCode: "", accountNumber: "12345678", bank: "Bank" })).toMatch(/sort code/);
    expect(bankProblem({ holder: "J Smith", sortCode: "12-34-56", accountNumber: "12345678", bank: "Bank" })).toBeNull();
    expect(factProblem({ cls: "legal_name", value: "   " })).toMatch(/blank/);
    expect(factProblem({ cls: "legal_name", value: "Jane Smith" })).toBeNull();
  });

  it("available treasury: a backed figure, or why it is unknown", () => {
    expect(availableTreasuryText({ availableTreasury: 0, reconciliation: "reconciled", actualCash: 22 }, money)).toBe("£0.00");
    expect(availableTreasuryText({ availableTreasury: 455, reconciliation: "reconciled" }, money)).toBe("£4.55");
    expect(availableTreasuryText({ availableTreasury: null, reconciliation: "unresolved" }, money)).toBe("unknown — reconciliation unresolved");
    expect(availableTreasuryText({ availableTreasury: null, reconciliation: "unavailable" }, money)).toBe("unknown — no provider balance");
    expect(availableTreasuryText(null, money)).toBe("unknown — no provider balance");
    expect(knownMoney(null, money)).toBe("—");
    expect(knownMoney(22, money)).toBe("£0.22");
  });
});
