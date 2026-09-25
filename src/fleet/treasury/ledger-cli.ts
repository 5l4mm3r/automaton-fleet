/**
 * FleetAdmin ledger commands (Phase E, schema v10), dispatched from
 * `pnpm fleet:admin`. All require the admin credential. Nothing here moves
 * money: recording commands book external facts that already happened;
 * instructions reserve funds in the ledger and stay unexecuted (custody
 * execution is constitutionally disabled in v10).
 *
 *   ledger-model | ledger-verify | ledger-balances | ledger-journal [N] | ledger-legacy
 *   ledger-economics <agentId>                    survival equity, protected principal, LFC
 *   ledger-lfc                                     Lifetime Fleet Contribution
 *   ledger-orders [status] [agentId]
 *   ledger-record-funding <cents> <externalRef>    owner capital already received into custody
 *   ledger-record-credits <cents> <externalRef>    schema v14: prepaid inference credits the owner bought (provider invoice/receipt id)
 *   ledger-record-revenue <agentId> <cents> <externalRef> [refund|gain|loss]   counterparty reference on stdin (hashed)
 *   ledger-reverse <journalId> <reason…>
 *   ledger-capital <agentId> <cents> grant|principal [--ack] [reason…]
 *   ledger-spend-decision <orderId> approve|reject [--ack] [note…]
 *   ledger-withdraw <cents> <destinationId> [--ack] [reason…]   (above the strong threshold: prints a one-time code)
 *   ledger-confirm <instructionId>                 reads the one-time code from stdin
 *   ledger-contribute <agentId> <cents>            realized, uncontributed net profit -> LFC
 *   ledger-destination-enroll <owner|payee> <rail> <label> [agentId] [--hint X]
 *                                                  reads the destination reference from stdin (hashed, never stored);
 *                                                  prints the one-time activation code ONCE
 *   ledger-destination-activate <destinationId>    reads the activation code from stdin (after the cooldown)
 *   ledger-destination-revoke <destinationId> <reason…>
 *   ledger-estate-open <agentId> | ledger-estate-settle <agentId> | ledger-estate-attention
 *
 * Secrets never go on the command line: destination references and one-time
 * codes are read from stdin.
 */

import type { DestinationKind, DestinationRail, PgLedgerAdmin } from "./ledger.js";

export const LEDGER_COMMANDS = new Set([
  "ledger-model", "ledger-verify", "ledger-balances", "ledger-journal", "ledger-legacy", "ledger-economics", "ledger-lfc",
  "ledger-orders", "ledger-record-funding", "ledger-record-credits", "ledger-record-revenue", "ledger-reverse", "ledger-capital",
  "ledger-spend-decision", "ledger-withdraw", "ledger-confirm", "ledger-contribute",
  "ledger-destination-enroll", "ledger-destination-activate", "ledger-destination-revoke",
  "ledger-estate-open", "ledger-estate-settle", "ledger-estate-attention",
]);

const RAILS = new Set(["evm_usdc", "bank_transfer", "conway_credits", "provider_account"]);

function cents(v: string | undefined): number {
  if (!v || !/^[1-9]\d{0,13}$/.test(v)) throw new Error("cents must be a positive integer");
  return Number(v);
}

function need(v: string | undefined, usage: string): string {
  if (!v) throw new Error(`usage: ${usage}`);
  return v;
}

/** Read one line from stdin (secrets never go on argv). */
export async function readStdinLine(stdin: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i >= 0) done(buf.slice(0, i));
    };
    const done = (v: string) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", reject);
      (stdin as NodeJS.ReadStream).pause?.();
      resolve(v.replace(/\r$/, "").trim());
    };
    const onEnd = () => done(buf);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", reject);
  });
}

export async function runLedgerCommand(
  cmd: string,
  a: string[],
  l: PgLedgerAdmin,
  actor: string,
  readSecret: () => Promise<string> = () => readStdinLine(),
): Promise<unknown> {
  const ack = a.includes("--ack");
  const args = a.filter((x) => x !== "--ack");
  switch (cmd) {
    case "ledger-model":
      return l.model();
    case "ledger-verify":
      return l.verify();
    case "ledger-balances":
      return (await l.balances()).filter((b) => b.balanceCents !== 0 || b.agentId === null);
    case "ledger-journal":
      return l.journal(args[0] ? Number(args[0]) : 50);
    case "ledger-legacy":
      return l.legacyDigests();
    case "ledger-economics":
      return l.economics(need(args[0], "ledger-economics <agentId>"));
    case "ledger-lfc":
      return { lifetimeFleetContributionCents: await l.lifetimeFleetContribution() };
    case "ledger-orders":
      return l.orders({ status: args[0] || undefined, agentId: args[1] || undefined });
    case "ledger-record-funding":
      return { journalId: await l.recordOwnerFunding(cents(args[0]), need(args[1], "ledger-record-funding <cents> <externalRef>"), actor) };
    case "ledger-record-credits":
      return { journalId: await l.recordCreditsPurchase(cents(args[0]), need(args[1], "ledger-record-credits <cents> <externalRef>"), actor) };
    case "ledger-record-revenue": {
      const usage = "ledger-record-revenue <agentId> <cents> <externalRef> [revenue|refund|gain|loss]  (external counterparty reference on stdin)";
      const kinds = { revenue: "external_revenue", refund: "external_refund", gain: "investment_realized_gain", loss: "investment_realized_loss" } as const;
      const which = (args[3] ?? "revenue") as keyof typeof kinds;
      if (!Object.prototype.hasOwnProperty.call(kinds, which)) throw new Error(`usage: ${usage}`);
      const kind = kinds[which];
      const counterparty = await readSecret();
      return { journalId: await l.recordExternal(kind, need(args[0], usage), cents(args[1]), need(args[2], usage), counterparty, actor) };
    }
    case "ledger-reverse":
      return { journalId: await l.reverse(need(args[0], "ledger-reverse <journalId> <reason…>"), need(args.slice(1).join(" "), "ledger-reverse <journalId> <reason…>"), actor) };
    case "ledger-capital": {
      const mode = args[2];
      if (mode !== "grant" && mode !== "principal") throw new Error("usage: ledger-capital <agentId> <cents> grant|principal [--ack] [reason…]");
      return l.agentCapital({ agentId: args[0], amountCents: cents(args[1]), mode, actor, reason: args.slice(3).join(" ") || undefined, acknowledgeWarnings: ack });
    }
    case "ledger-spend-decision": {
      const d = args[1];
      if (d !== "approve" && d !== "reject") throw new Error("usage: ledger-spend-decision <orderId> approve|reject [--ack] [note…]");
      return l.spendDecision(args[0], d, actor, { note: args.slice(2).join(" ") || undefined, acknowledgeWarnings: ack });
    }
    case "ledger-withdraw": {
      const r = await l.ownerWithdrawal({
        amountCents: cents(args[0]),
        destinationId: need(args[1], "ledger-withdraw <cents> <destinationId> [--ack] [reason…]"),
        actor,
        reason: args.slice(2).join(" ") || undefined,
        acknowledgeWarnings: ack,
      });
      if (r.confirmationCode) {
        return { ...r, confirmationCode: undefined, note: "strong authorization: run ledger-confirm <instructionId> and type this one-time code", oneTimeCode: r.confirmationCode };
      }
      return r;
    }
    case "ledger-confirm":
      return l.confirm(need(args[0], "ledger-confirm <instructionId>"), await readSecret(), actor);
    case "ledger-contribute":
      return { journalId: await l.contribute(need(args[0], "ledger-contribute <agentId> <cents>"), cents(args[1]), actor) };
    case "ledger-destination-enroll": {
      const usage = "ledger-destination-enroll <owner|payee> <rail> <label> [agentId] [--hint X]  (reference on stdin)";
      const hintAt = args.indexOf("--hint");
      const hint = hintAt >= 0 ? args[hintAt + 1] : undefined;
      const pos = hintAt >= 0 ? args.filter((_, i) => i !== hintAt && i !== hintAt + 1) : args;
      const kind = pos[0];
      const rail = pos[1];
      if ((kind !== "owner" && kind !== "payee") || !rail || !RAILS.has(rail) || !pos[2]) throw new Error(`usage: ${usage}`);
      const reference = await readSecret();
      if (!reference) throw new Error("no destination reference on stdin");
      const r = await l.enrollDestination({ kind: kind as DestinationKind, rail: rail as DestinationRail, label: pos[2], reference, hint, agentId: pos[3] ?? null, actor });
      return { ...r, activationCode: undefined, oneTimeActivationCode: r.activationCode, note: "shown once; activate after the cooldown with ledger-destination-activate" };
    }
    case "ledger-destination-activate":
      return l.activateDestination(need(args[0], "ledger-destination-activate <destinationId>"), await readSecret(), actor);
    case "ledger-destination-revoke":
      return l.revokeDestination(need(args[0], "ledger-destination-revoke <destinationId> <reason…>"), need(args.slice(1).join(" "), "reason required"), actor);
    case "ledger-estate-open":
      return l.estateOpen(need(args[0], "ledger-estate-open <agentId>"), actor);
    case "ledger-estate-settle":
      return l.estateSettle(need(args[0], "ledger-estate-settle <agentId>"), actor);
    case "ledger-estate-attention":
      return l.estateAttention();
    default:
      throw new Error(`unknown ledger command ${cmd}`);
  }
}
