"use client";
/**
 * v62: the owner's conversation with one Agent, and that Agent's Mind panel.
 *
 * The thread holds the owner's messages (with working files), the Agent's replies, the Agent's requests to the owner
 * and its card payments awaiting the owner — in time order, from FleetController (`agent_thread`). Reading and polling
 * are database reads (no AI is used); the Agent reads messages at its next turn and the treasury pays for that AI time.
 * Words in the thread are information or instructions; approvals happen only through the explicit cards below them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { money } from "../model";
import { Panel, button, input } from "../ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway JSON
type Row = Record<string, any>;

/** What the dashboard accepts as a working file (the server enforces the same list and limits). */
export const FILE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "PNG image", "image/jpeg": "JPEG image", "image/webp": "WebP image", "image/gif": "GIF image", "application/pdf": "PDF",
  "text/csv": "CSV", "text/plain": "Text", "text/markdown": "Markdown", "application/json": "JSON",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel workbook", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
});
const MAX_FILES = 5, MAX_FILE_BYTES = 10 * 1024 * 1024, MAX_CHARS = 20000;

/** A likely secret in a draft. "block" = never sent; "warn" = the owner confirms first. Not exhaustive. */
export function secretCheck(text: string): { level: "block" | "warn"; what: string } | null {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return { level: "block", what: "a private key" };
  if (/(sk|rk)_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35}|sk-(ant|proj)-[A-Za-z0-9_-]{20,}/.test(text)) {
    return { level: "block", what: "an API key or access token" };
  }
  for (const m of text.match(/(?:\d[ -]?){12,18}\d/g) ?? []) {
    const d = m.replace(/\D/g, "");
    if (d.length < 13 || d.length > 19) continue;
    let s = 0;
    for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; } s += x; }
    if (s % 10 === 0) return { level: "block", what: "a card number" };
  }
  if (/\b(password|passcode|secret|api[ _-]?key|sort code|iban|cvv|cvc)\b\s*[:=]/i.test(text)) return { level: "warn", what: "a password or account detail" };
  return null;
}

/** Why a message is waiting, in words (the codes FleetController records on it). */
const BLOCK_TEXT: Readonly<Record<string, string>> = Object.freeze({
  COGNITION_PAUSED: "the agent is paused",
  TREASURY_INSUFFICIENT: "the treasury does not have enough money to pay for the reply — add funds to the treasury",
  COGNITION_RATE_LIMITED: "the agent reached its hourly limit of AI turns; it continues when the hour moves on",
  COGNITION_PROVIDER_RATE_LIMITED: "the AI provider asked the Fleet to slow down; it will try again shortly",
  COGNITION_CREDITS_EXHAUSTED: "the AI provider credit is used up — top up the provider account",
  COGNITION_BUSY: "the agent was already thinking; it will read this next",
  COGNITION_DISABLED: "AI is switched off for the Fleet", COGNITION_FOUNDER_DISABLED: "AI is switched off for this agent",
  AGENT_HELD: "the agent is on hold", FX_UNAVAILABLE: "no current exchange rate is recorded", ROUTING_DISABLED: "the agent's AI routing is off",
  TURN_EXPIRED: "the agent's last attempt was interrupted; it will read this again", PROVIDER_UNAVAILABLE: "the AI provider was unavailable",
});
const reason = (code: unknown) => (typeof code === "string" && code ? BLOCK_TEXT[code] ?? code.toLowerCase().replace(/_/g, " ") : "");
const when = (s: unknown) => String(s ?? "").slice(0, 16).replace("T", " ");
const usd = (micro: unknown) => { const n = Number(micro ?? 0) / 1e8; return n > 0 ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : "$0.00"; };
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const b64 = (buf: ArrayBuffer) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

function useThread(client: GatewayClient, op: string, agentId: string, everyMs: number) {
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState("");
  const load = useCallback(() => client.read<Row>(op, { agentId }).then((d) => { setData(d); setError(""); }, (e) => setError(describeError(e))), [client, op, agentId]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), everyMs); return () => clearInterval(t); }, [load, everyMs]);
  return { data, error, load };
}

function StatusChip({ m, agent }: { m: Row; agent: string }) {
  const tone = m.status === "answered" ? "text-emerald-300" : m.status === "failed" ? "text-red-300" : m.status === "read" ? "text-slate-300" : "text-amber-200";
  const text = m.status === "pending" ? `Waiting for ${agent}${m.blockCode ? ` — ${reason(m.blockCode)}` : ""}`
    : m.status === "processing" ? `${agent} is reading this` : m.status === "answered" ? "Answered" : m.status === "read" ? `Read by ${agent} — no reply`
    : m.status === "failed" ? `Could not be processed${m.blockCode ? ` — ${reason(m.blockCode)}` : ""}` : String(m.status);
  return <span className={`text-xs ${tone}`}>{text}</span>;
}

function TurnCost({ t }: { t: Row | undefined }) {
  if (!t || !t.calls) return null;
  return <p className="mt-1 text-xs text-slate-400">AI for this reply: {t.calls} call{t.calls === 1 ? "" : "s"} · {usd(t.providerUsdMicrocents)} provider-reported ·{" "}
    {money(Number(t.chargedCents ?? 0))} charged to the treasury (converted at the recorded USD rate){Number(t.unfundedCents) > 0 ? ` · ${money(Number(t.unfundedCents))} could not be covered by the treasury` : ""}.</p>;
}

/** An agent's request to the owner, answerable in place. The answer records a decision; it never grants or certifies anything. */
function RequestCard({ r, call, agent }: { r: Row; call: (op: string, a: Row) => Promise<void>; agent: string }) {
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  const decide = async (decision: "answered" | "approved" | "declined") => {
    setBusy(true); setMsg("");
    try { await call("owner_request_reply", { requestId: r.requestId, decision, response: text.trim() || null }); setText(""); }
    catch (e) { setMsg(describeError(e)); } finally { setBusy(false); }
  };
  const pending = r.status === "pending";
  return <div className={`my-3 rounded-lg border p-3 text-sm ${pending ? "border-amber-600" : "border-slate-700"}`}>
    <p className="text-xs uppercase tracking-wider text-amber-200">{pending ? `${agent} is awaiting your reply` : `Request · ${r.status === "answered" ? "answered" : r.status}`}</p>
    <p className="mt-1 font-semibold [overflow-wrap:anywhere]">{String(r.title ?? "A request")}</p>
    {r.action && <p className="mt-1 text-slate-300">What it needs from you: {String(r.action)}</p>}
    {r.detail && <details className="mt-1"><summary className="cursor-pointer text-xs text-cyan-300">Details</summary><p className="mt-1 whitespace-pre-wrap text-xs text-slate-300">{String(r.detail)}</p></details>}
    <p className="mt-1 text-xs text-slate-400">Asked {when(r.createdAt ?? r.at)}{r.decidedAt ? ` · you replied ${when(r.decidedAt)}` : ""}</p>
    {r.response && <p className="mt-2 rounded bg-slate-800 p-2 text-slate-200">You: {String(r.response)}</p>}
    {pending && <>
      <textarea className={`${input} mt-2 h-20`} maxLength={2000} placeholder="Your answer (required for Reply; optional for Approve or Decline)" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-2 flex flex-wrap gap-2">
        <button className={`${button} bg-cyan-900`} disabled={busy || !text.trim()} onClick={() => void decide("answered")}>Reply</button>
        <button className={button} disabled={busy} onClick={() => void decide("approved")}>Approve</button>
        <button className={`${button} border-red-700`} disabled={busy} onClick={() => void decide("declined")}>Decline</button>
      </div>
      <p className="mt-2 text-xs text-slate-400">Your answer is recorded for {agent}. It does not open an account, confirm identity checks, set anything up or move money — those happen only through their own steps.</p>
    </>}
    {msg && <p role="alert" className="mt-2 text-sm text-red-300">{msg}</p>}
  </div>;
}

/** A card payment above your threshold: the existing card approval (passkey confirmation), shown where the agent asked. */
function CardCard({ r, call, agent }: { r: Row; call: (op: string, a: Row) => Promise<void>; agent: string }) {
  const [ref, setRef] = useState(""), [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  const open = r.status === "pending_owner" && String(r.expiresAt) > new Date().toISOString();
  const go = async (decision: "approve" | "decline") => {
    setBusy(true); setMsg("");
    try { await call("card_request_decide", { requestId: r.requestId, decision, ...(decision === "approve" ? { reference: ref.trim() } : {}), note: null }); }
    catch (e) { setMsg(describeError(e)); } finally { setBusy(false); }
  };
  return <div className={`my-3 rounded-lg border p-3 text-sm ${open ? "border-red-700" : "border-slate-700"}`}>
    <p className="text-xs uppercase tracking-wider text-red-200">{open ? `${agent} asks to pay by card` : `Card request · ${String(r.status).replace(/_/g, " ")}`}</p>
    <p className="mt-1 font-semibold">{String(r.merchant)} · {money(Number(r.amountMinor))}</p>
    <p className="text-xs text-slate-300">For: {String(r.purpose ?? "")}{open ? ` · expires ${when(r.expiresAt)}` : ""}</p>
    {open && <>
      <p className="mt-2 text-xs text-amber-200">Approving lets {agent} charge the card for this payment only. First move {money(Number(r.amountMinor))} from the treasury PayPal to the card, then enter that transfer’s reference.</p>
      <input className={input} placeholder="Treasury → card transfer reference" value={ref} onChange={(e) => setRef(e.target.value)} />
      <div className="mt-2 flex flex-wrap gap-2">
        <button className={`${button} bg-cyan-900`} disabled={busy || !ref.trim()} onClick={() => void go("approve")}>Approve this card payment</button>
        <button className={`${button} border-red-700`} disabled={busy} onClick={() => void go("decline")}>Decline</button>
      </div>
    </>}
    {msg && <p role="alert" className="mt-2 text-sm text-red-300">{msg}</p>}
  </div>;
}

export function AgentConversation({ client, agentId, agentName }: { client: GatewayClient; agentId: string; agentName: string }) {
  const { data, error, load } = useThread(client, "agent_thread", agentId, 8000);
  const [draft, setDraft] = useState(""), [files, setFiles] = useState<File[]>([]), [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [ack, setAck] = useState(false);
  const key = useRef(crypto.randomUUID());
  const end = useRef<HTMLDivElement>(null);
  const items = useMemo(() => (data?.items ?? []) as Row[], [data]);
  const paused = data?.cognition?.paused === true;
  const waiting = items.filter((i) => i.itemType === "message" && i.author === "owner" && (i.status === "pending" || i.status === "processing")).length;
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [items.length]);
  const call = useCallback(async (op: string, a: Row) => { await client.call(op, a); await load(); }, [client, load]);
  const secret = secretCheck(draft);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const fileProblem = files.length > MAX_FILES ? `Up to ${MAX_FILES} files per message.` : totalBytes > MAX_FILE_BYTES ? "Files can be up to 10 MB in total per message."
    : files.find((f) => !FILE_TYPES[f.type]) ? `${files.find((f) => !FILE_TYPES[f.type])!.name} is not a supported file type.` : "";
  const send = async () => {
    setBusy(true); setMsg("");
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, contentType: f.type, dataB64: b64(await f.arrayBuffer()) })));
      await client.call("agent_message_send", { agentId, body: draft.trim(), files: payload, clientKey: key.current });
      key.current = crypto.randomUUID(); setDraft(""); setFiles([]); setAck(false);
      await load();
    } catch (e) { setMsg(describeError(e)); } finally { setBusy(false); }
  };
  const setPaused = async (p: boolean) => {
    if (!p && !window.confirm(`Resume ${agentName}? Its AI starts again: it reads waiting messages first (paid by the treasury), then continues its own work (paid from its wallet).`)) return;
    setMsg("");
    try { await call("agent_cognition_set", { agentId, paused: p }); } catch (e) { setMsg(describeError(e)); }
  };
  return <Panel title="Conversation">
    <div id="conversation" className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className={paused ? "text-amber-200" : "text-slate-300"}>{data ? (paused ? `${agentName} is paused. Messages wait until you resume it.`
        : waiting ? `${waiting} message${waiting === 1 ? "" : "s"} waiting for ${agentName}. It reads them at its next turn, usually within a minute.`
        : `${agentName} reads new messages at its next turn, usually within a minute.`) : "Reading the conversation…"}</p>
      {data && <button className={button} onClick={() => void setPaused(!paused)}>{paused ? "Resume its AI" : "Pause its AI"}</button>}
    </div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <div className="max-h-[32rem] overflow-y-auto pr-1">
      {data && !items.length && <p className="text-sm text-slate-400">No messages yet. Write to {agentName} below.</p>}
      {items.map((i) => i.itemType === "request" ? <RequestCard key={`r${i.requestId}`} r={i} call={call} agent={agentName} />
        : i.itemType === "card_request" ? <CardCard key={`c${i.requestId}`} r={i} call={call} agent={agentName} />
        : <div key={String(i.messageId)} className={`my-2 flex ${i.author === "owner" ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[85%] rounded-xl p-3 text-sm ${i.author === "owner" ? "bg-cyan-950/70" : "bg-slate-800"}`}>
            <p className="text-xs text-slate-400">{i.author === "owner" ? "You" : agentName} · {when(i.at)}</p>
            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{String(i.body)}</p>
            {(i.files ?? []).length > 0 && <ul className="mt-2 text-xs text-slate-300">{(i.files as Row[]).map((f) => <li key={String(f.fileId)}>📎 {String(f.name)} · {FILE_TYPES[String(f.contentType)] ?? "file"} · {size(Number(f.sizeBytes))}{f.fetchedAt ? ` · opened by ${agentName}` : ""}</li>)}</ul>}
            {i.author === "owner" && <div className="mt-1 flex flex-wrap items-center gap-2"><StatusChip m={i} agent={agentName} />
              {(i.status === "failed" || i.status === "read") && <button className="text-xs text-cyan-300 underline" onClick={() => void call("agent_message_retry", { messageId: i.messageId }).catch((e) => setMsg(describeError(e)))}>Ask again</button>}</div>}
            {i.author === "agent" && <TurnCost t={i.turn} />}
          </div>
        </div>)}
      <div ref={end} />
    </div>
    <div className="mt-4 border-t border-slate-800 pt-3">
      <label className="text-sm">Message to {agentName}
        <textarea className={`${input} h-24`} maxLength={MAX_CHARS} value={draft} onChange={(e) => { setDraft(e.target.value); setAck(false); }} placeholder="Write a message, an update or an instruction" /></label>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <label className="cursor-pointer text-cyan-300 underline">Attach files<input type="file" multiple className="hidden" accept={Object.keys(FILE_TYPES).join(",")}
          onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} /></label>
        {files.map((f, n) => <span key={`${f.name}${n}`} className="rounded border border-slate-700 px-2 py-0.5 text-xs">{f.name} · {size(f.size)} <button aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, k) => k !== n))}>✕</button></span>)}
      </div>
      <p className="mt-2 text-xs text-slate-400">Images, PDF, CSV, text, Markdown, JSON, Excel and Word files — up to {MAX_FILES} files and 10 MB per message. Files go to {agentName} only.
        Reading and replying uses AI time, paid by the treasury. Never paste passwords, card numbers, bank details or keys here — use Money &amp; identity, which keeps them sealed.</p>
      {secret?.level === "block" && <p role="alert" className="mt-2 text-sm text-red-300">This looks like it contains {secret.what}. It will not be sent — chat is not a vault. Use Money &amp; identity instead.</p>}
      {secret?.level === "warn" && <label className="mt-2 flex items-start gap-2 text-sm text-amber-200"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />This may contain {secret.what}. Send it anyway (the agent and the AI provider will see it).</label>}
      {fileProblem && <p role="alert" className="mt-2 text-sm text-red-300">{fileProblem}</p>}
      <button className={`${button} mt-3 bg-cyan-900`} disabled={busy || (!draft.trim() && !files.length) || secret?.level === "block" || (secret?.level === "warn" && !ack) || !!fileProblem}
        onClick={() => void send()}>{busy ? "Sending…" : "Send"}</button>
      {msg && <p role="alert" className="mt-2 text-sm text-red-300">{msg}</p>}
    </div>
  </Panel>;
}

/** The Mind panel: what the agent did, its own stated reasons and the actual AI costs — never its private reasoning. */
export function AgentMind({ client, agentId, agentName }: { client: GatewayClient; agentId: string; agentName: string }) {
  const { data, error } = useThread(client, "agent_mind", agentId, 30000);
  const last = (data?.reports ?? [])[0] as Row | undefined;
  const c = (data?.costs ?? {}) as Row;
  return <Panel title="Mind">
    <p className="text-xs text-slate-400">Recorded actions, {agentName}’s own notes and the actual AI costs. The model’s private reasoning is not stored or shown.</p>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {!data && !error && <p className="text-sm text-slate-400">Reading…</p>}
    {data && <>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-slate-400">Status</dt><dd>{data.cognition?.paused ? "Paused" : data.cognition?.enabled ? "Running" : "Off"}</dd></div>
        <div><dt className="text-xs text-slate-400">Last note</dt><dd className="[overflow-wrap:anywhere]">{last?.outcome ? String(last.outcome) : "—"}</dd></div>
        <div><dt className="text-xs text-slate-400">Waiting for</dt><dd className="[overflow-wrap:anywhere]">{last?.wakeOn ? String(last.wakeOn) : "—"}{last?.reviewAt ? ` · looks again ${when(last.reviewAt)}` : ""}</dd></div>
        <div><dt className="text-xs text-slate-400">AI cost (provider-reported)</dt><dd>{usd(c.todayUsdMicrocents)} today · {usd(c.weekUsdMicrocents)} this week · {usd(c.totalUsdMicrocents)} in total</dd></div>
        <div><dt className="text-xs text-slate-400">Charged in the ledger</dt><dd>{money(Number(c.agentPaidCents ?? 0))} from its wallet · {money(Number(c.treasuryPaidCents ?? 0))} paid by the treasury for your conversations</dd></div>
      </dl>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs">
        <thead className="text-slate-400"><tr>{["When", "Model", "Tokens in / out", "Provider", "Ledger", "Paid by", "What it did"].map((h) => <th key={h} className="p-1.5">{h}</th>)}</tr></thead>
        <tbody>{((data.calls ?? []) as Row[]).map((x, n) => <tr key={n} className="border-t border-slate-800">
          <td className="p-1.5 whitespace-nowrap">{when(x.at)}</td><td className="p-1.5">{String(x.model ?? "")}</td>
          <td className="p-1.5">{Number(x.inputTokens ?? 0).toLocaleString("en-GB")} / {Number(x.outputTokens ?? 0).toLocaleString("en-GB")}</td>
          <td className="p-1.5">{usd(x.providerUsdMicrocents)}</td>
          <td className="p-1.5" title={x.fxRateMicro ? `Converted at ${(Number(x.fxRateMicro) / 1e6).toFixed(4)} ${String(x.currency ?? "")} per USD` : ""}>{money(Number(x.chargedCents ?? 0))}</td>
          <td className="p-1.5">{x.payer === "treasury" ? "Treasury (your conversation)" : "Its wallet"}</td>
          <td className="p-1.5">{x.outcome === "error" ? `Failed${x.errorCode ? ` (${String(x.errorCode).toLowerCase().replace(/_/g, " ")})` : ""}` : ((x.tools ?? []) as string[]).join(", ").replace(/_/g, " ") || "replied"}</td>
        </tr>)}</tbody></table>
        {!(data.calls ?? []).length && <p className="mt-2 text-sm text-slate-400">No AI calls recorded yet.</p>}
        <p className="mt-2 text-xs text-slate-400">Provider-reported USD and the ledger charge are recorded per call. The ledger converts at the recorded rate and rounds to pennies, so totals can differ slightly from your provider’s balance.</p>
      </div>
    </>}
  </Panel>;
}
