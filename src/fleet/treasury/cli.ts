/**
 * FleetAdmin treasury commands (Phase 5), dispatched from `pnpm fleet:admin`.
 * All require the admin credential. Nothing here moves money.
 *
 *   treasury-policy [runwayDays=N] [contingencyPct=X] [minContingencyCents=N] [matureFleetRate=X] [maxSweepRate=X]
 *                   [reserveTargetMonths=X] [maturityAgeDays=N] [treasuryAddress=0x..] [ownerWithdrawalAddress=0x..]
 *   treasury-position
 *   treasury-record <kind> <cents> [agentId]           observed treasury movement (sweep_in, infrastructure, …)
 *   ledger <agentId> <kind> <cents> [reference]         agent ledger entry (revenue, direct_cost, owner_funding, …)
 *   balance <agentId> <cents>                           observed agent cash
 *   obligation <agentId> <cents> <dueInDays> <description…>
 *   capital-list [agentId]
 *   capital-approve <allocationId> <cents> <days> <reason…> [--override]
 *   capital-reject <allocationId> <reason…>
 *   capital-change <allocationId> [cents=N] [expiryDays=N] <reason…>
 *   capital-complete <allocationId> <actualReturnCents>
 *   sweep-reduce <agentId> <pct 0..1> <days> <reason…>
 *   sweep-plan <agentId> [cashCents]
 *   spending-freeze <agentId> <reason…> | spending-unfreeze <agentId> <reason…> | spending-limit <agentId> <cents>
 *   custody-transfer <fromAgentId> <treasury|agentId> <cents> <policy> <reason…>
 *   owner-distribute <cents>
 *   profile <agentId>                                   internal capital-performance profile
 *   rescue-advice <agentId> [cashCents]
 */

import type { AgentLedgerKind, TreasuryKind } from "./engine.js";
import type { PgTreasuryStore, TreasuryPolicyRecord } from "./store.js";

export const TREASURY_COMMANDS = new Set([
  "treasury-policy", "treasury-position", "treasury-record", "ledger", "balance", "obligation",
  "capital-list", "capital-approve", "capital-reject", "capital-change", "capital-complete",
  "sweep-reduce", "sweep-plan", "spending-freeze", "spending-unfreeze", "spending-limit",
  "custody-transfer", "owner-distribute", "profile", "rescue-advice",
]);

const DAY = 86_400_000;

function int(v: string | undefined, name: string): number {
  if (!v || !/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
}

function kv(args: string[]): { pairs: Record<string, string>; rest: string[] } {
  const pairs: Record<string, string> = {};
  const rest: string[] = [];
  for (const a of args) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(a);
    if (m) pairs[m[1]] = m[2];
    else rest.push(a);
  }
  return { pairs, rest };
}

export async function runTreasuryCommand(cmd: string, a: string[], ts: PgTreasuryStore, actor: string): Promise<unknown> {
  switch (cmd) {
    case "treasury-policy": {
      const { pairs } = kv(a);
      if (!Object.keys(pairs).length) return ts.getPolicy();
      const patch: Partial<TreasuryPolicyRecord> = {};
      for (const [k, v] of Object.entries(pairs)) {
        if (k === "treasuryAddress" || k === "ownerWithdrawalAddress") (patch as Record<string, unknown>)[k] = v || null;
        else if (["runwayDays", "contingencyPct", "minContingencyCents", "matureFleetRate", "maxSweepRate", "reserveTargetMonths", "maturityAgeDays"].includes(k)) {
          (patch as Record<string, unknown>)[k] = Number(v);
        } else throw new Error(`unknown policy key ${k}`);
      }
      return ts.setPolicy(patch, actor);
    }
    case "treasury-position":
      return ts.treasuryPosition();
    case "treasury-record":
      await ts.recordTreasury({ kind: a[0] as TreasuryKind, amountCents: int(a[1], "cents"), agentId: a[2] }, actor);
      return ts.treasuryPosition();
    case "ledger":
      await ts.recordAgentLedger({ agentId: a[0], kind: a[1] as AgentLedgerKind, amountCents: int(a[2], "cents"), reference: a[3] }, actor);
      return { recorded: true };
    case "balance":
      await ts.recordBalance(a[0], int(a[1], "cents"), "operator");
      return { recorded: true };
    case "obligation":
      return {
        obligationId: await ts.addObligation(
          { agentId: a[0], amountCents: int(a[1], "cents"), dueAt: new Date(Date.now() + int(a[2], "dueInDays") * DAY), description: a.slice(3).join(" ") },
          actor,
        ),
      };
    case "capital-list":
      return ts.listAllocations(a[0]);
    case "capital-approve": {
      const override = a.includes("--override");
      const args = a.filter((x) => x !== "--override");
      const start = new Date();
      await ts.approveAllocation(
        args[0],
        { approvedCents: int(args[1], "cents"), startDate: start, expiryDate: new Date(start.getTime() + int(args[2], "days") * DAY), reason: args.slice(3).join(" ") || "approved", override },
        actor,
      );
      return ts.listAllocations().then((l) => l.find((x) => x.allocationId === args[0]));
    }
    case "capital-reject":
      await ts.rejectAllocation(a[0], a.slice(1).join(" ") || "rejected", actor);
      return { rejected: a[0] };
    case "capital-change": {
      const { pairs, rest } = kv(a.slice(1));
      await ts.changeAllocation(
        a[0],
        {
          approvedCents: pairs.cents !== undefined ? int(pairs.cents, "cents") : undefined,
          expiryDate: pairs.expiryDays !== undefined ? new Date(Date.now() + int(pairs.expiryDays, "expiryDays") * DAY) : undefined,
          reason: rest.join(" ") || "changed",
        },
        actor,
      );
      return { changed: a[0] };
    }
    case "capital-complete":
      await ts.completeAllocation(a[0], int(a[1], "actualReturnCents"), actor);
      return { completed: a[0] };
    case "sweep-reduce": {
      const pct = Number(a[1]);
      return {
        reductionId: await ts.reduceSweep(
          { agentId: a[0], reductionPct: pct, expiresAt: new Date(Date.now() + int(a[2], "days") * DAY), reason: a.slice(3).join(" ") },
          actor,
        ),
      };
    }
    case "sweep-plan":
      return ts.planSweep(a[0], actor, { cashCents: a[1] !== undefined ? int(a[1], "cashCents") : undefined });
    case "spending-freeze":
    case "spending-unfreeze":
      await ts.freezeSpending(a[0], cmd === "spending-freeze", a.slice(1).join(" ") || cmd, actor);
      return { agentId: a[0], frozen: cmd === "spending-freeze" };
    case "spending-limit":
      await ts.setDailySpendLimit(a[0], int(a[1], "cents"), actor);
      return { agentId: a[0], dailyLimitCents: Number(a[1]) };
    case "custody-transfer": {
      const toTreasury = a[1] === "treasury";
      return {
        transferId: await ts.planCustodyTransfer(
          {
            fromAgentId: a[0],
            destination: toTreasury ? "fleet_treasury" : "agent",
            toAgentId: toTreasury ? undefined : a[1],
            amountCents: int(a[2], "cents"),
            policy: a[3] as "quarantine_recovery" | "death_recovery" | "rebalance" | "sweep",
            reason: a.slice(4).join(" "),
          },
          actor,
        ),
        executed: false,
      };
    }
    case "owner-distribute":
      return ts.planOwnerDistribution(int(a[0], "cents"), actor);
    case "profile":
      return ts.performanceProfile(a[0]);
    case "rescue-advice":
      return ts.rescueAdvice(a[0], a[1] !== undefined ? int(a[1], "cashCents") : undefined);
    default:
      throw new Error(`unknown treasury command ${cmd}`);
  }
}
