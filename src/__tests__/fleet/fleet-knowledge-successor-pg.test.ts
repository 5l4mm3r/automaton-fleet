/**
 * 2026-10-22 (launch handoff §10, "newborn/successor acceptance"): a lesson agent A proposed and Fleet Control promoted is
 * found by a DIFFERENT agent B through the real retrieval path — B's own credential against the controller's
 * api_knowledge_list, through the founder toolbox's read_knowledge with a question — without A's private state.
 * Simulated, non-economic fixtures only: no live birth, no model call, no money.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("successor acceptance: a promoted lesson reaches a fresh agent through read_knowledge (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let A: Founder, B: Founder;
  const propose = async (who: Founder, category: string, title: string, content: string) => {
    const r = (await R.q(`SELECT fleet.api_knowledge_propose($1, $2, $3, $4, $5) AS r`, [who.id, who.token, category, title, content]))[0].r;
    return String(r.proposalId ?? r.proposal_id);
  };
  const promote = async (proposalId: string) => {
    await R.one(`fleet.svc_knowledge_proposals_claim(10, 'fleet-control')`);
    return R.one<Record<string, any>>(`fleet.svc_knowledge_review_record($1, 'fleet-control', $2::jsonb)`,
      [proposalId, JSON.stringify({ decision: "promote", reason: "Repeated evidence across launches supports it." })]);
  };
  /** Agent B's toolbox; its knowledge port reads the controller as B (the client's shape: entries + retired + note). */
  const toolboxOf = (who: Founder) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "succ-"));
    const w = path.join(root, "w"), m = path.join(root, "m");
    fs.mkdirSync(w); fs.mkdirSync(m);
    return new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: w, memoryDir: m, loopGuard: new LoopGuard(), selfGovernance: true, ports: {
      knowledge: async (after = 0) => {
        const r = (await R.q(`SELECT fleet.api_knowledge_list($1, $2, $3, 50) AS r`, [who.id, who.token, after]))[0].r;
        return { entries: r.entries, retired: r.retired, ...(r.note ? { note: r.note } : {}) };
      },
    } as never });
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    [A, B] = R.founders;
    await R.store.grantServiceRole();
    // v96: lesson reviews are Fleet Control calls: a test budget.
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget(100000, 'test budget', $1)`, [OWNER]);
  });
  afterAll(async () => { await R?.close(); });

  it("agent B finds agent A's promoted lesson by its question, ranked above unrelated lessons", async () => {
    const lesson = await promote(await propose(A, "technique", "Ebook pricing: anchor a short practical guide at £7–£12",
      "Across three launches a 40-page practical ebook sold best at £9; £19 drew views but no sales. Validate with a pre-order page first."));
    expect(lesson).toMatchObject({ ok: true, status: "promoted" });
    for (const [t, c] of [["Refunds before delivery", "Issue the refund before delivering when the buyer cancels within the hour."],
      ["Spreadsheet guard formulas", "IF(x=\"\",\"\",…) guards are correct when saved blank."], ["Cold outreach volume", "Ten tailored messages beat a hundred templated ones."]] as const) {
      await promote(await propose(A, "technique", t, c));
    }
    const tb = toolboxOf(B);
    const out = await tb.execute({ id: "k1", name: "read_knowledge", arguments: { query: "how should I price an ebook" } });
    expect(out.ok).toBe(true);
    const r = JSON.parse(out.output);
    expect(r.searched).toBeGreaterThanOrEqual(4);
    expect(r.entries[0].title).toBe("Ebook pricing: anchor a short practical guide at £7–£12");   // B's question, A's lesson first
    expect(r.entries[0].originAgentId).toBe(A.id);                                                // provenance kept
    expect(r.entries.map((e: any) => e.title)).not.toContain("Cold outreach volume");             // unrelated lessons left out
    // Without a question the latest page comes back unchanged (older behaviour).
    const all = JSON.parse((await tb.execute({ id: "k2", name: "read_knowledge", arguments: {} })).output);
    expect(all.entries.length).toBeGreaterThanOrEqual(4);
  });
});
