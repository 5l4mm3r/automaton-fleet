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
  let A: Founder, B: Founder, C: Founder, D: Founder;
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
  const toolboxOf = (who: Founder, economy?: (op: string, args?: Record<string, unknown>) => Promise<unknown>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "succ-"));
    const w = path.join(root, "w"), m = path.join(root, "m");
    fs.mkdirSync(w); fs.mkdirSync(m);
    return new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: w, memoryDir: m, loopGuard: new LoopGuard(), selfGovernance: true, ports: {
      ...(economy ? { economy } : {}),
      // As the client: a search goes to the controller's search across all lessons (v111); otherwise the latest page.
      knowledge: async (after = 0, search?: { query: string; category?: string; limit?: number }) => {
        if (search) {
          const r = (await R.q(`SELECT fleet.api_knowledge_search($1, $2, $3, $4, $5) AS r`, [who.id, who.token, search.query, search.category ?? null, search.limit ?? 8]))[0].r;
          return { entries: r.entries, retired: r.retired, note: r.note, searched: r.searched, matched: r.matched, query: search.query };
        }
        const r = (await R.q(`SELECT fleet.api_knowledge_list($1, $2, $3, 50) AS r`, [who.id, who.token, after]))[0].r;
        return { entries: r.entries, retired: r.retired, ...(r.note ? { note: r.note } : {}) };
      },
    } as never });
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 4, allocationCents: 10_000, treasuryCents: 100_000, simulatedSettlement: false });
    [A, B, C, D] = R.founders;
    await R.store.grantServiceRole();
    // v96: lesson reviews are Fleet Control calls: a test budget.
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget(100000, 'test budget', $1)`, [OWNER]);
  }, 300_000);
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

  it("v111: an OLD relevant lesson behind 55 newer distractors (outside the latest page of 50) is found; a question nothing answers finds nothing", async () => {
    // Newer distractors from three proposers (each within the 20-a-day proposal limit).
    for (let i = 0; i < 55; i++) {
      const who = i < 15 ? A : i < 35 ? C : D;
      await promote(await propose(who, "market", `Seasonal demand note ${i}`, `Footfall observation number ${i} for high-street cafés in winter.`));
    }
    const tb = toolboxOf(B);
    // The old whole-page read cannot see it (and 50 lessons overflow the tool output: the model gets a cut page).
    const latest = (await tb.execute({ id: "k3", name: "read_knowledge", arguments: {} })).output;
    expect(latest).not.toContain("Ebook pricing: anchor a short practical guide");
    const r = JSON.parse((await tb.execute({ id: "k4", name: "read_knowledge", arguments: { query: "ebook pricing for a practical guide" } })).output);
    expect(r.searched).toBeGreaterThanOrEqual(59);
    expect(r.entries[0].title).toBe("Ebook pricing: anchor a short practical guide at £7–£12");
    const none = JSON.parse((await tb.execute({ id: "k5", name: "read_knowledge", arguments: { query: "quantum chromodynamics lattice" } })).output);
    expect(none).toMatchObject({ matched: 0, entries: [] });
  });

  it("v111: the proposer sees its lesson's status, age and why it waits (an unset review budget keeps it waiting, never approves it)", async () => {
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget_clear('test: unset', $1)`, [OWNER]);
    const id = await propose(B, "technique", "Answer refunds within the hour", "Refund questions answered within an hour avoided every dispute across two launches.");
    const waiting = (await R.econ(B, "knowledge.proposals", {})).proposals.find((p: any) => p.proposalId === id);
    expect(waiting).toMatchObject({ status: "proposed" });
    expect(waiting.waiting).toMatch(/review budget is not set/);
    expect(typeof waiting.ageHours).toBe("number");
    await R.one(`fleet.fleet_admin_fleet_control_ai_budget(100000, 'test budget', $1)`, [OWNER]);
    expect((await R.econ(B, "knowledge.proposals", {})).proposals.find((p: any) => p.proposalId === id).waiting).toMatch(/queued/);
    await promote(id);
    const done = (await R.econ(B, "knowledge.proposals", {})).proposals.find((p: any) => p.proposalId === id);
    expect(done).toMatchObject({ status: "promoted", waiting: null });
    expect(done.entryId).toBeTruthy();
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("v111: a lesson marked for the Fleet is kept on the controller when written (scrubbed, unreviewed) — it outlives the agent, never served unreviewed", async () => {
    let down = false;
    const tb = toolboxOf(B, async (op, args) => { if (down) throw new Error("controller unreachable"); return R.econ(B, op, args ?? {}); });
    const memory = (tb as unknown as { memory: string }).memory;
    const add = (lesson: string) => tb.execute({ id: `j-${lesson.length}`, name: "field_journal", arguments: { op: "add", entry: {
      observation: "Buyers who got a sample page first converted at 3 of 5; none of 4 without one (contact rae@example.com, 07700 900123).",
      lesson, evidence: "two offer pages over 10 days", confidence: "medium", reusability: "candidate_fleet" } } });
    const r1 = await add("Show a one-page sample before the price for document products.");
    expect(r1.output).toContain("kept on record (unreviewed");
    await add("Show a one-page sample before the price for document products.");              // a replay keeps one row
    down = true;
    const r3 = await add("Quote turnaround in working days, not days.");
    expect(r3.output).toContain("queued locally");
    expect(fs.existsSync(path.join(memory, "candidate-outbox.jsonl"))).toBe(true);
    down = false;
    await tb.execute({ id: "j-plain", name: "field_journal", arguments: { op: "add", entry: { observation: "a plain note, not for the Fleet" } } });   // flushes the outbox
    expect(fs.existsSync(path.join(memory, "candidate-outbox.jsonl"))).toBe(false);
    await R.one(`fleet.fleet_mark_dead($1, 'test: ended', $2, 'killed')`, [B.id, OWNER]);
    const kept = (await R.one<any>(`fleet.fleet_admin_knowledge_candidates($1)`, [B.id])).candidates;
    expect(kept.map((c: any) => c.lesson).sort()).toEqual(["Quote turnaround in working days, not days.", "Show a one-page sample before the price for document products."]);
    expect(kept[0]).toMatchObject({ status: "unreviewed", agentStatus: "dead" });
    expect(JSON.stringify(kept)).not.toMatch(/rae@example\.com|07700 900123/);              // personal data scrubbed before keeping
    const served = await R.q(`SELECT fleet.api_knowledge_search($1, $2, 'sample page before the price', NULL, 20) AS r`, [A.id, A.token]);
    expect(JSON.stringify(served[0].r.entries)).not.toContain("one-page sample before the price");   // unreviewed: never served to others
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
