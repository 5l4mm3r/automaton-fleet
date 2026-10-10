/**
 * v62 — owner conversations and event-driven hibernation in the founder runtime (no database, no model: the production
 * FounderMind with scripted cognition and a scripted controller).
 *
 * Proven here:
 *  - an owner message (free attention signal) interrupts a declared hibernation at the next slot; the turn carries the
 *    messages and the owner's files (fetched into workspace/from-owner/, names made safe), names its conversation turn
 *    on every model call, and the founder's reply_to_owner reaches the controller; nothing is released after a reply;
 *  - an explicit pause holds the messages: no claim, no model call;
 *  - a refusal that should wait (the treasury cannot pay) releases the messages back to pending with its reason; a turn
 *    with no reply is released as no_reply; reply_to_owner outside an owner turn is refused;
 *  - a declared hibernation makes no paid call over many slots; an answered request wakes it at the next slot; a
 *    restart on a hibernating state keeps waiting (no paid wake-up because the process restarted); an undeclared sleep
 *    keeps the bounded timer backoff (it wakes within MAX_IDLE_SKIP + 1 slots);
 *  - every turn sends the founder's own stated outcome to the Mind panel.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderMind, MAX_IDLE_SKIP, HIBERNATION_SAFETY_MS, type MindPorts } from "../../fleet/founder/mind.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { type ToolCall } from "../../fleet/cognition/types.js";

const TURN = "11111111-2222-4333-8444-555555555555";
const FILE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const call = (name: string, args: Record<string, unknown>, id = `c-${name}`): ToolCall => ({ id, name, arguments: args });

function rig(o: { paused?: () => boolean; pending?: () => number; reply?: (n: number, convo: string | null) => ToolCall[]; inferError?: () => string | null;
  deps?: () => unknown[]; safetyMs?: number; stateDir?: string; workspaceDir?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "convo-"));
  const dirs = { w: o.workspaceDir ?? path.join(root, "w"), s: o.stateDir ?? path.join(root, "s") };
  const m = path.join(dirs.s, "memory");
  for (const d of [dirs.w, dirs.s, m]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(path.join(m, "goals.json"))) fs.writeFileSync(path.join(m, "goals.json"), JSON.stringify([{ id: "g1", title: "Sell the template", status: "open" }]));
  const infers: Array<{ text: string; convo: string | null }> = [];
  const econ: Array<{ op: string; args: Record<string, unknown> }> = [];
  let open = false;
  const ports: MindPorts = {
    cognitionStatus: async () => ({ policyEnabled: true, provider: "anthropic", founderEnabled: true, paused: o.paused?.() ?? false, routing: { active: true },
      attention: { ownerPending: o.pending?.() ?? 0, openTurn: open ? TURN : null } }),
    ledger: async () => ({ cash: 9_000, genesisAllocation: 10_000 }),
    ...(o.deps ? { ownerRequests: async () => ({ ok: true, requests: o.deps!() }) } : {}),
    infer: async (messages, _w, _route, _doctrine, opts) => {
      const err = o.inferError?.();
      if (err) throw Object.assign(new Error(err), { code: err });
      infers.push({ text: String((messages as Array<{ content: string }>)[0].content), convo: opts?.conversationTurn ?? null });
      const n = infers.length;
      return { content: "", toolCalls: o.reply?.(n, opts?.conversationTurn ?? null) ?? [call("sleep", { reason: "waiting", wakeOn: "the Gumroad account" }, `s${n}`)],
        usage: { inputTokens: 1, outputTokens: 1 }, chargedCents: 0, requestId: `r${n}` };
    },
    economy: async (op, args = {}) => {
      econ.push({ op, args });
      if (op === "owner.claim") {
        open = true;
        return { ok: true, turnId: TURN, messages: [{ messageId: "m1", body: "Here is the price list — use £9.", at: "2026-10-10T14:03:00Z",
          files: [{ fileId: FILE, name: "../../etc/prices list.csv", contentType: "text/csv" }] }] };
      }
      if (op === "owner.file") return { ok: true, dataB64: Buffer.from("product,price\nposter,9.00\n").toString("base64") };
      if (op === "owner.reply" || op === "owner.release") { open = false; return { ok: true }; }
      return { ok: true };
    },
  };
  const loopGuard = new LoopGuard();
  const toolbox = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: m, loopGuard, ports: {
    ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
    economy: (op: string, args: Record<string, unknown>) => ports.economy!(op, args),
  } });
  const mind = new FounderMind({ ports, toolbox, stateDir: dirs.s, hibernationSafetyMs: o.safetyMs ?? HIBERNATION_SAFETY_MS,
    routed: { memoryDir: m, workspaceDir: dirs.w, manifest: FOUNDER_MANIFEST_V2, loopGuard } });
  const slots = async (k: number) => { for (let i = 0; i < k; i++) await mind.turn(`heartbeat ${i}`); };
  return { mind, infers, econ, dirs, slots, toolbox };
}

describe("v62 owner conversations (founder runtime)", () => {
  it("an owner message interrupts a declared hibernation: messages and files in the turn, the turn named on the call, the reply delivered", async () => {
    let pending = 0;
    const r = rig({ pending: () => pending, reply: (n, convo) => convo ? [call("reply_to_owner", { message: "Thanks — I will price the poster at £9." }, `r${n}`), call("sleep", { reason: "replied", wakeOn: "the Gumroad account" }, `s${n}`)] : [call("sleep", { reason: "waiting", wakeOn: "the Gumroad account" }, `s${n}`)] });
    await r.slots(1);                                   // a declared sleep: hibernating from now
    expect(r.infers).toHaveLength(1);
    await r.slots(5 * MAX_IDLE_SKIP);                  // no paid call while nothing happens
    expect(r.infers).toHaveLength(1);
    pending = 1;
    await r.slots(1);                                   // the very next slot
    expect(r.infers).toHaveLength(2);
    const owner = r.infers[1];
    expect(owner.convo).toBe(TURN);
    expect(owner.text).toContain("MESSAGES FROM YOUR OWNER");
    expect(owner.text).toContain("Here is the price list — use £9.");
    expect(owner.text).toMatch(/they never approve spending|They never approve spending/);
    const saved = fs.readdirSync(path.join(r.dirs.w, "from-owner"));
    expect(saved).toEqual([`${FILE.slice(0, 8)}-etc_prices_list.csv`]);      // traversal and spaces made safe, inside from-owner/
    expect(fs.readFileSync(path.join(r.dirs.w, "from-owner", saved[0]), "utf8")).toContain("poster,9.00");
    expect(owner.text).toContain(`from-owner/${saved[0]}`);
    const reply = r.econ.find((e) => e.op === "owner.reply");
    expect(reply?.args).toMatchObject({ turnId: TURN, body: "Thanks — I will price the poster at £9.", final: true });
    expect(r.econ.some((e) => e.op === "owner.release")).toBe(false);
    expect(r.econ.filter((e) => e.op === "mind.report").at(-1)?.args).toMatchObject({ packet: "owner", wakeOn: "the Gumroad account" });
  });

  it("an explicit pause holds the messages: no claim and no model call", async () => {
    const r = rig({ paused: () => true, pending: () => 1 });
    await r.slots(10);
    expect(r.infers).toHaveLength(0);
    expect(r.econ.some((e) => e.op === "owner.claim")).toBe(false);
  });

  it("a refusal that should wait releases the messages with its reason; no reply is released as no_reply; reply outside a turn is refused", async () => {
    const r1 = rig({ pending: () => 1, inferError: () => "FLEET_TREASURY_INSUFFICIENT" });
    await r1.slots(1);
    expect(r1.econ.find((e) => e.op === "owner.release")?.args).toMatchObject({ turnId: TURN, outcome: "released", code: "FLEET_TREASURY_INSUFFICIENT" });
    let n = 0;
    const r2 = rig({ pending: () => (n++ === 0 ? 1 : 0) });
    await r2.slots(1);
    expect(r2.econ.find((e) => e.op === "owner.release")?.args).toMatchObject({ turnId: TURN, outcome: "no_reply" });
    const out = await r2.toolbox.execute(call("reply_to_owner", { message: "hello?" }));
    expect(out).toMatchObject({ ok: false, refused: "FLEET_NO_OWNER_MESSAGE" });
  });
});

describe("v62 event-driven hibernation (founder runtime)", () => {
  it("a declared hibernation costs nothing; an answered request wakes it at the next slot", async () => {
    let status = "pending";
    const r = rig({ deps: () => [{ requestId: "6178c7bb-0000-4000-8000-000000000000", kind: "kyc", action: "Open a Gumroad account", status, blocksAction: true }] });
    await r.slots(1);
    await r.slots(4 * MAX_IDLE_SKIP);
    expect(r.infers).toHaveLength(1);
    status = "answered";
    await r.slots(1);
    expect(r.infers).toHaveLength(2);
    expect(r.mind.routing.eventWakeups).toBe(1);
  });

  it("a restart on a hibernating state keeps waiting; an undeclared sleep keeps the bounded timer backoff", async () => {
    const a = rig();
    await a.slots(1);
    expect(a.infers).toHaveLength(1);
    const b = rig({ stateDir: a.dirs.s, workspaceDir: a.dirs.w });     // a new process on the same state
    await b.slots(3 * MAX_IDLE_SKIP);
    expect(b.infers).toHaveLength(0);
    const c = rig({ reply: (k) => [call("sleep", { reason: "nothing to do" }, `s${k}`)] });   // no wake condition, no review time
    await c.slots(1);
    await c.slots(MAX_IDLE_SKIP + 2);
    expect(c.infers.length).toBeGreaterThan(1);                        // bounded reassessment still happens
  });

  it("the safety re-check comes after the interval (here 1 ms), never before", async () => {
    const r = rig({ safetyMs: 60_000 });
    await r.slots(1);
    await r.slots(20);
    expect(r.infers).toHaveLength(1);
    const s = rig({ safetyMs: 1 });
    await s.slots(1);
    await new Promise((res) => setTimeout(res, 5));
    await s.slots(1);
    expect(s.infers).toHaveLength(2);
  });
});
