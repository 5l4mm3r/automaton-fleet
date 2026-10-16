/**
 * Schema v67 — the business foundation in the shared library, and prompt wake-ups (PostgreSQL; no model, no money):
 *  - one authoritative source: the generated library equals the master document's build; entries are searchable by query
 *    and id; dated status is its own category with dated facts and the unresolved Gumroad decision labelled;
 *  - a full read follows the reading path: every entry, in order, whole (never truncated), in parts of at most 7 000 characters;
 *  - the attention signal's eventsDigest changes on what a hibernating agent must act on (inbound mail, Fleet Control
 *    notices, lesson reviews, card requests), and not on the agent's own outbound mail.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { FOUNDATION_PART_CHARS } from "../../fleet/postgres/migrations-phase67.js";
import { KNOWLEDGE_FOUNDATION_V1 } from "../../fleet/postgres/knowledge-foundation-v1.js";
// v76: the deployed foundation is v2 (v1 unchanged plus the market-facing entries); the live library and reading path follow it.
import { KNOWLEDGE_FOUNDATION_V2 as LIVE_FOUNDATION } from "../../fleet/postgres/knowledge-foundation-v2.js";
import { FOUNDATION_LIBRARY_VERSION, FOUNDER_CHARTER_V6 } from "../../fleet/cognition/types.js";

const PG_BIN = findPgBin();
const ROOT = path.resolve(__dirname, "../../..");

describe.skipIf(!PG_BIN)("v67: business foundation in the library; wake-up signals (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let su: pg.Pool;
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const digest = async () => (await R.one<Record<string, any>>(`fleet.fleet_agent_attention($1)`, [F.id])).eventsDigest as string;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 10_000, simulatedSettlement: false });
    [F] = R.founders;
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
  }, 300_000);
  afterAll(async () => { await su?.end(); await R?.close(); });

  it("migrates to v67 with a clean audit; the generated library is the master document's build; the charter names its version", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(67);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-")), "out.ts");
    execFileSync("node", ["scripts/knowledge-foundation-build.mjs", "docs/knowledge/business-foundation-v1.md", tmp], { cwd: ROOT });
    expect(fs.readFileSync(tmp, "utf8")).toBe(fs.readFileSync(path.join(ROOT, "src/fleet/postgres/knowledge-foundation-v1.ts"), "utf8"));
    execFileSync("node", ["scripts/knowledge-foundation-build.mjs", "docs/knowledge/business-foundation-v2.md", tmp], { cwd: ROOT });
    expect(fs.readFileSync(tmp, "utf8")).toBe(fs.readFileSync(path.join(ROOT, "src/fleet/postgres/knowledge-foundation-v2.ts"), "utf8"));
    // v2 keeps every v1 entry's text (only the dated status is a new version).
    for (const e of KNOWLEDGE_FOUNDATION_V1.entries) if (e.id !== "fleet-capability-status") expect(LIVE_FOUNDATION.entries.find((x) => x.id === e.id)?.body, e.id).toBe(e.body);
    expect(FOUNDATION_LIBRARY_VERSION).toBe(KNOWLEDGE_FOUNDATION_V1.version);
    expect(FOUNDER_CHARTER_V6).toContain(`Business foundation (${KNOWLEDGE_FOUNDATION_V1.version})`);
    const counts = await R.q(`SELECT category, count(*)::int AS n FROM fleet.fleet_knowledge_library WHERE current AND category IN ('business-foundation','fleet-status') GROUP BY 1 ORDER BY 1`);
    expect(counts).toEqual([{ category: "business-foundation", n: LIVE_FOUNDATION.entries.length - 1 }, { category: "fleet-status", n: 1 }]);
    // Worked examples are labelled hypothetical wherever figures illustrate a case.
    for (const e of LIVE_FOUNDATION.entries) if (/EXAMPLE/.test(e.body)) expect(e.body, e.id).toMatch(/HYPOTHETICAL EXAMPLE/);
  });

  it("a full read follows the reading path: every entry, in order, whole, in bounded parts", async () => {
    const seen: string[] = [];
    let part = 1, parts = 0;
    for (;;) {
      const r = await R.econ(F, "knowledge.library", { path: "foundation", part });
      expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
      expect(r.version).toBe(LIVE_FOUNDATION.version);
      parts = r.parts;
      const bodies = (r.entries as Array<{ id: string; body: string }>);
      expect(bodies.reduce((n, e) => n + e.body.length, 0)).toBeLessThanOrEqual(FOUNDATION_PART_CHARS);
      for (const e of bodies) {
        seen.push(e.id);
        expect(e.body).toBe(LIVE_FOUNDATION.entries.find((x) => x.id === e.id)!.body);   // never truncated
      }
      if (part === parts) { expect(r.note).toMatch(/remember_fact/); break; }
      part++;
    }
    expect(seen).toEqual([...LIVE_FOUNDATION.readingPath]);
    expect((await R.econ(F, "knowledge.library", { path: "foundation", part: parts + 1 })).code).toBe("FLEET_NOT_FOUND");
    expect((await R.econ(F, "knowledge.library", { path: "everything" })).code).toBe("FLEET_BAD_REQUEST");
  });

  it("sections are searchable and retrievable by id; dated status carries dated facts and labels the unresolved decision", async () => {
    const s = await R.econ(F, "knowledge.library", { query: "advertising experiment scale campaign", limit: 5 });
    expect((s.entries as Array<{ id: string }>).map((e) => e.id)).toContain("bf-advertising");
    const st = await R.econ(F, "knowledge.library", { id: "fleet-capability-status" });
    expect(st.ok).toBe(true);
    expect(st.entry.category).toBe("fleet-status");
    const facts = st.entry.factsThatChange as Array<{ fact: string; lastChecked: string; stale: boolean }>;
    expect(facts.every((f) => f.lastChecked === "2026-10-16")).toBe(true); // v82: capability status v8
    // v79 (owner, 2026-10-15: channels are the agent's choice): the EU consumer route is a merchant-of-record platform the
    // agent operates where its terms permit — no longer an unresolved owner decision; the £500 rule stays Gumroad's gateway's.
    expect(facts.some((f) => /^EU consumer digital sales — through a merchant-of-record platform/.test(f.fact) && /£500/.test(f.fact))).toBe(true);
    // v82 (owner, 2026-10-16): built, installed, connected, enabled and live-proven are stated separately, and the entry no
    // longer contradicts itself about API connectors or operating Etsy through the browser.
    expect(st.entry.body).toMatch(/BUILT .*INSTALLED .*CONNECTED .*ENABLED .*LIVE-PROVEN/s);
    const fact = (re: RegExp) => facts.filter((f) => re.test(f.fact));
    expect(fact(/^API channels/)).toHaveLength(1);
    expect(fact(/^API channels/)[0].fact).toMatch(/Etsy.*Pinterest.*BUILT, INSTALLED .*NOT CONNECTED .*NOT LIVE-PROVEN/s);
    expect(fact(/^Gumroad/)[0].fact).toMatch(/BUILT, NOT INSTALLED on the host, NOT CONNECTED/);
    expect(fact(/no platform has an API connector apart from Gumroad|Etsy and other marketplaces: no API connector|operate a shop through the browser/i)).toEqual([]);
    expect(fact(/^Production tools/)[0].fact).toMatch(/INSTALLED .*python-pptx/s);
    // v83: a presentation is delivered as a PDF (or zipped with it) until .pptx is a deliverable type.
    expect(fact(/^Production tools/)[0].fact).toMatch(/do not promise a bare \.pptx/);
    expect(fact(/^Choosing channels — your choice, from research; no platform is required and none is excluded/)).toHaveLength(1);
    expect(fact(/^Platform findings/)[0].fact).toMatch(/re-verify at the source.*provisional.*None of these is a ranking or a list of allowed channels/s);
    for (const s of ["Paying out", "Card purchases", "Fleet offer pages"]) expect(fact(new RegExp(`^${s}`))[0].fact, s).toMatch(/NOT ENABLED/);
    expect(facts.some((f) => /^UNRESOLVED/.test(f.fact))).toBe(false);
    expect(st.entry.body).toMatch(/never treat today's onboarding gaps as permanent/);
  });

  it("eventsDigest changes on inbound mail, Fleet Control notices and lesson reviews — not on the agent's own outbound mail", async () => {
    const d0 = await digest();
    expect(d0).toMatch(/^[0-9a-f]{32}$/);
    const mailbox = crypto.randomUUID();
    const mail = (direction: string) => asSuper(`INSERT INTO fleet.fleet_agent_mail (message_id, mailbox_id, agent_id, sender, subject, body, direction, received_at,
      send_status, recipients) VALUES ($1, $2, $3, 'buyer@example.test', 'Question about my order', 'Hello', $4, now(),
      CASE WHEN $4 = 'out' THEN 'queued' END, CASE WHEN $4 = 'out' THEN ARRAY['buyer@example.test'] END)`, [crypto.randomUUID(), mailbox, F.id, direction]);
    await mail("out");
    expect(await digest()).toBe(d0);
    await mail("in");
    const d1 = await digest();
    expect(d1).not.toBe(d0);
    await asSuper(`INSERT INTO fleet.fleet_agent_messages (message_id, agent_id, author, body, status, created_by) VALUES ($1, $2, 'fleet_control', 'Spend review: held', 'delivered', 'fleet_control')`,
      [crypto.randomUUID(), F.id]);
    const d2 = await digest();
    expect(d2).not.toBe(d1);
    const p = (await R.q(`SELECT fleet.api_knowledge_propose($1, $2, 'technique', 'A lesson', 'Repeated evidence across three launches.') AS r`, [F.id, F.token]))[0].r;
    const d3 = await digest();
    expect(d3).not.toBe(d2);
    await asSuper(`UPDATE fleet.fleet_knowledge_proposals SET status = 'rejected', reviewed_by = 'fleet_control', reviewed_at = now() WHERE proposal_id = $1`,
      [p.proposalId ?? p.proposal_id]);
    expect(await digest()).not.toBe(d3);
  });
});
