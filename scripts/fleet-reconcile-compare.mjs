#!/usr/bin/env node
/**
 * Compare two reconciliation snapshots (scripts/fleet-reconcile-snapshot.sql) taken around a schema migration while
 * every writer was stopped. Prints a JSON report; exit 0 only when every invariant holds:
 *
 *   node scripts/fleet-reconcile-compare.mjs <before.json> <after.json> <fromSchema> <toSchema>
 *
 * Invariants: same Agents (identity, status), population, cap, mode, replication state and birth orders; the ledger
 * head, journals and postings unchanged byte for byte, debits = credits, no unbalanced journal, no orphan posting;
 * every existing account keeps its class and balance, every new account starts at zero; each Agent's economics
 * (realised net profit, contribution, tax, cash …) and computed Treasury sweep unchanged; the Treasury ledger,
 * external transactions, owner distributions, payment orders, custody transfers and capital requests unchanged;
 * existing canonical events and notifications unchanged (v45: routine event copies / diagnostics may only be purged, reported by type) and no
 * event appended except the migrator's role-grant audit records; estates, knowledge, ventures, missions,
 * credentials unchanged; the owner's passkeys, authenticator and password unchanged (digests); no project or sweep
 * record invented.
 */
import fs from "node:fs";

const [bf, af, from, to, allowArg] = process.argv.slice(2);
// R41.1: event types a caller expects to be appended (e.g. a code-only revert re-approves the previous runtime).
const ALLOW_APPENDED = new Set((allowArg ?? "").split(",").map((s) => s.trim()).filter(Boolean));
if (!bf || !af || !from || !to) { console.error("usage: fleet-reconcile-compare.mjs <before.json> <after.json> <fromSchema> <toSchema>"); process.exit(2); }
const B = JSON.parse(fs.readFileSync(bf, "utf8")), A = JSON.parse(fs.readFileSync(af, "utf8"));
const failures = [], notes = [];
const same = (label, x, y) => { if (JSON.stringify(x) !== JSON.stringify(y)) failures.push({ check: label, before: x, after: y }); };
const must = (label, ok, detail) => { if (!ok) failures.push({ check: label, detail }); };

must("schema before", B.schema === Number(from), B.schema);
must("schema after", A.schema === Number(to), A.schema);
const added = (A.migrations ?? []).filter((v) => !(B.migrations ?? []).includes(v));
same("migrations applied", added, Array.from({ length: Number(to) - Number(from) }, (_, i) => Number(from) + 1 + i));
same("fleet state (population, cap, mode)", B.state, A.state);
same("agents", B.agents, A.agents);
same("replication state", B.replication, A.replication);
same("birth orders", B.birthOrders, A.birthOrders);

const L0 = B.ledger, L1 = A.ledger;
same("ledger head", L0.head, L1.head);
for (const k of ["journals", "postings", "maxSeq", "maxPosting", "debitsCents", "creditsCents", "journalDigest", "postingDigest", "kindsByCount"]) same(`ledger ${k}`, L0[k], L1[k]);
must("ledger verify (before)", L0.verifyOk === true, L0.verifyOk);
must("ledger verify (after)", L1.verifyOk === true, L1.verifyOk);
must("debits = credits (after)", L1.debitsCents === L1.creditsCents, { d: L1.debitsCents, c: L1.creditsCents });
must("no unbalanced journal", L1.unbalancedJournals === 0, L1.unbalancedJournals);
must("no orphan posting", L1.orphanPostings === 0, L1.orphanPostings);
same("journals without postings", L0.journalsWithoutPostings, L1.journalsWithoutPostings);
const newAccounts = [];
for (const [id, a] of Object.entries(L0.accounts ?? {})) {
  const b = L1.accounts?.[id];
  if (!b) failures.push({ check: "account disappeared", account: id });
  else if (b.class !== a.class || b.balanceCents !== a.balanceCents) failures.push({ check: "account changed", account: id, before: a, after: b });
}
for (const [id, b] of Object.entries(L1.accounts ?? {})) if (!L0.accounts?.[id]) {
  newAccounts.push({ account: id, class: b.class, balanceCents: b.balanceCents });
  if (b.balanceCents !== 0) failures.push({ check: "new account not neutral", account: id, balanceCents: b.balanceCents });
}

for (const [agent, e0] of Object.entries(B.economics ?? {})) {
  const e1 = A.economics?.[agent];
  if (!e1) { failures.push({ check: "economics missing", agent }); continue; }
  for (const [k, v] of Object.entries(e0)) if (JSON.stringify(e1[k]) !== JSON.stringify(v)) failures.push({ check: "economics changed", agent, key: k, before: v, after: e1[k] });
  for (const k of Object.keys(e1)) if (!(k in e0)) notes.push({ economicsKeyAdded: k, agent, value: e1[k] });
}
for (const [agent, s0] of Object.entries(B.sweepCompute ?? {})) {
  const s1 = A.sweepCompute?.[agent] ?? {};
  for (const k of ["amountMinor", "basisMinor", "rateBp", "enabled"]) if (JSON.stringify(s0[k]) !== JSON.stringify(s1[k])) failures.push({ check: "computed sweep changed", agent, key: k, before: s0[k], after: s1[k] });
}

same("treasury ledger", B.treasuryLedger, A.treasuryLedger);
if (B.adminAuth && A.adminAuth) same("owner sign-in state (passkeys, authenticator, password)", B.adminAuth, A.adminAuth);
for (const k of ["externalTransactions", "ownerDistributions", "paymentOrders", "custodyTransfers", "capitalRequests", "estates", "estateItems",
  "knowledge", "ventures", "missions", "credentialRefs", "providerSecrets"]) same(k, B[k], A[k]);
// v45 purges the routine event copies (session_opened, ledger_journal_posted, role grants, notifications_deleted) and expires
// routine diagnostics: the canonical history must be byte-identical, an expiring type may only shrink, and the purge is
// reported by type (before − after = purged, exactly).
const purged = {};
if (B.events.canonical && A.events.canonical) {
  same("existing canonical events", B.events.canonical, A.events.canonical);
  for (const [t, n] of Object.entries(B.events.expiring ?? {})) {
    const left = A.events.expiring?.[t] ?? 0;
    if (left > n) failures.push({ check: "expiring events grew", type: t, before: n, after: left });
    else if (left < n) purged[t] = n - left;
  }
  for (const t of Object.keys(A.events.expiring ?? {})) if (!(t in (B.events.expiring ?? {}))) failures.push({ check: "expiring events appeared", type: t });
  const total = Object.values(purged).reduce((s, n) => s + n, 0);
  const keptBefore = B.events.count - B.events.canonical.count;
  must("events before = canonical + expiring", Object.values(B.events.expiring ?? {}).reduce((s, n) => s + n, 0) === keptBefore, { count: B.events.count, canonical: B.events.canonical.count });
  if (total) notes.push({ eventsPurged: purged, total, existingBefore: B.events.count, existingAfter: B.events.count - total });
} else {
  same("existing events", { count: B.events.count, maxId: B.events.maxId, digest: B.events.digest }, { count: B.events.count, maxId: B.events.maxId, digest: A.events.digest });
}
// The migrator re-grants each restricted role and audits it (one `<role>_role_granted` event per role): expected.
const appended = Object.entries(A.events.after ?? {});
const expected = (t) => /^[a-z]+_role_granted$/.test(t) || ALLOW_APPENDED.has(t);
const grants = Object.fromEntries(appended.filter(([t]) => expected(t)));
const unexpected = Object.fromEntries(appended.filter(([t]) => !expected(t)));
same("events appended", {}, unexpected);
if (Object.keys(grants).length) notes.push({ roleGrantAuditEvents: grants });
// The owner's inbox (v43 deletion tombstones excluded — v45 removes them) when both snapshots have it.
if (B.inbox && A.inbox) same("notifications (inbox)", B.inbox, A.inbox); else same("notifications", B.notifications, A.notifications);
must("no project invented", (A.projects ?? 0) === 0, A.projects);
must("no sweep record invented", (A.sweepRecords ?? 0) === 0, A.sweepRecords);

const report = { ok: failures.length === 0, from: Number(from), to: Number(to), migrationsApplied: added,
  population: A.state, agents: A.agents.map((a) => ({ agentId: a.agentId, name: a.name, status: a.status })),
  ledger: { head: L1.head, journals: L1.journals, postings: L1.postings, debitsCents: L1.debitsCents, creditsCents: L1.creditsCents },
  newAccounts, events: { existing: B.events.count, purged, preserved: B.events.count - Object.values(purged).reduce((s, n) => s + n, 0), appended: A.events.after, unexpected }, notifications: A.notifications.count, failures, notes };
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
