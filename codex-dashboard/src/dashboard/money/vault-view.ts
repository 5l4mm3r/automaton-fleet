/**
 * 0.27.0 (owner, 2026-10-26: "when any information is stored and sealed, it should show the information sealed and not request
 * it to be inputted again"). Pure helpers for the sealed-information screens and the treasury figures, kept apart from the
 * React panels so they are tested directly.
 */

/** What a sealed item's screen shows: stored, not stored, or not known yet (never an entry form while unknown). */
export type VaultItemState = "stored" | "not_stored" | "loading" | "unavailable";

export function vaultItemState(read: { data: unknown; error: string }, stored: boolean): VaultItemState {
  if (read.error) return "unavailable";
  if (read.data == null) return "loading";
  return stored ? "stored" : "not_stored";
}

const blank = (v: unknown) => typeof v !== "string" || v.trim() === "";

/** A sealed upload replaces what is stored: refuse an address that would replace it with blanks. */
export function addressProblem(v: Record<string, string>): string | null {
  const missing = [["line1", "line 1"], ["city", "town / city"], ["postcode", "postcode"], ["country", "country"]].filter(([k]) => blank(v[k])).map(([, l]) => l);
  return missing.length ? `Enter the ${missing.join(", ")}: an incomplete address is never saved over the one stored.` : null;
}

export function bankProblem(v: Record<string, string>): string | null {
  const missing = [["holder", "account holder"], ["sortCode", "sort code"], ["accountNumber", "account number"], ["bank", "bank"]].filter(([k]) => blank(v[k])).map(([, l]) => l);
  return missing.length ? `Enter the ${missing.join(", ")}: incomplete bank details are never saved over the ones stored.` : null;
}

export function factProblem(v: Record<string, string>): string | null {
  return blank(v.value) ? "Enter a value: a blank value is never saved over the one stored." : null;
}

type Wealth = { availableTreasury?: number | null; reconciliation?: string | null; actualCash?: number | null } | null | undefined;

/** Available backed treasury, or why it is unknown (never 0 for unknown, never the ledger partition sum). */
export function availableTreasuryText(w: Wealth, money: (n: number) => string): string {
  if (w?.availableTreasury != null) return money(w.availableTreasury);
  return w?.reconciliation === "unresolved" ? "unknown — reconciliation unresolved" : "unknown — no provider balance";
}

/** A provider amount, or "—" when unknown. */
export const knownMoney = (v: number | null | undefined, money: (n: number) => string) => (v == null ? "—" : money(v));
