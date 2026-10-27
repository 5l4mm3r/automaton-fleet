// Scratch: server-render the new HQ components with production figures (amounts only; no names, keys or addresses).
import fs from "fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const root = process.argv[2], out = process.argv[3];
async function main() {
const { TreasuryPosition, SavedOr } = await import(`${root}/src/dashboard/money/MoneyPanels.tsx`);
const css = fs.readFileSync(`${root}/out/_next/static/css/${fs.readdirSync(`${root}/out/_next/static/css`)[0]}`, "utf8");
const pos = {
  currency: "GBP", paypal: { currency: "GBP", totalMinor: 22, availableMinor: 22, observedAt: "2026-10-26T18:53:58Z", fresh: true },
  reconciliation: { status: "reconciled", differenceMinor: 0, booksCashMinor: 20022, unbackedCapitalMinor: 20000 },
  treasury: { unallocatedMinor: 0, fleetControlReservedMinor: 0, ownerSetAsideMinor: 1079, otherPartitionsMinor: 0, availableMinor: 0 },
  agents: { walletsMinor: 18943, backedAtMostMinor: 0, wallets: [{ agentId: "A1", status: "active", walletMinor: 8943 }, { agentId: "A2", status: "active", walletMinor: 10000 }] },
  owner: { payableMinor: 1081, setAsideMinor: 1079 },
  apiCredit: { currency: "USD", balance: 11523033480, held: 0, free: 11523033480, promotional: 9801033480, purchased: 1722000000 },
};
const name = (id: string) => (id === "A1" ? "Agent-1" : "Agent-2");
const tile = (k: string, v: string, h?: string) => `<div class="rounded border border-slate-700 p-3"><p class="text-xs text-slate-400">${k}</p><p class="font-mono">${v}</p>${h ? `<p class="mt-1 text-xs text-slate-400">${h}</p>` : ""}</div>`;
const before = `<h2 class="mb-2 text-lg font-semibold">BEFORE (HQ 0.26.2, production figures)</h2>
<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 text-sm">${tile("Treasury cash", "£10.79", "Overview / Fleet Command (sum of treasury_cash partitions)")}${tile("Spendable Treasury cash", "£10.79", "Treasury summary")}${tile("Real money held", "£200.22", "Treasury health")}${tile("PayPal", "£0.00 available · 0 unmatched", "newest row of any currency: the USD row")}${tile("Agents' wallets", "£189.43")}${tile("Available — agents / unallocated", "£189.43 / £0.00")}</div>
<p class="mt-3 text-sm text-slate-300">Money &amp; identity · 3: "Each is sealed in this browser to the identity broker's key." — then, with nothing stored, an empty "Seal and upload address" form (no "not saved yet"); once stored: "✓ Address: saved and encrypted … For security it is never shown back."</p>`;
const after = renderToStaticMarkup(<div className="space-y-6">
  <h2 className="text-lg font-semibold">AFTER (HQ 0.27.0 candidate, same production figures)</h2>
  <section className="rounded-xl border border-slate-700 p-4"><h3 className="mb-3 font-semibold">Treasury position (what is real)</h3><TreasuryPosition p={pos} error="" name={name} /></section>
  <section className="rounded-xl border border-slate-700 p-4"><h3 className="mb-3 font-semibold">3 · Bank details and identity facts — the four states of a sealed item</h3>
    <SavedOr saved={true} state="stored" revealTarget="residential_address" what="Address" encrypted form={() => null} />
    <SavedOr saved={false} state="not_stored" what="Bank details" encrypted form={() => <div className="rounded border border-slate-700 p-3 text-xs text-slate-400">[entry form: Seal and upload bank details]</div>} />
    <SavedOr saved={false} state="loading" what="Address" encrypted form={() => null} />
    <SavedOr saved={false} state="unavailable" what="Address" encrypted form={() => null} />
  </section></div>);
const page = (body: string) => `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-slate-950 text-slate-100 p-6" style="width:1180px;background:#020617;color:#f1f5f9;font-family:system-ui,sans-serif">${body}</body></html>`;
fs.writeFileSync(`${out}/before.html`, page(before)); fs.writeFileSync(`${out}/after.html`, page(after));
console.log("written");
}
void main();
