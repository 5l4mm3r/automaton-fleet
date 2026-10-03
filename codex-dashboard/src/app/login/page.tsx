"use client";
/**
 * Owner sign-in (LIVE builds): the Fleet's real passkey (WebAuthn, user verification) + TOTP, through the dashboard
 * gateway of whatever host serves this page. First access uses the one-time enrollment link the Fleet host prints
 * (`fleet:admin hub-dashboard-enroll <origin>` → `<origin>/login/#enroll=<token>`): the token stays in the URL fragment
 * (never sent to a server log) and is removed from the address bar once used. There is no password and no demo code.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Panel, button, input } from "@/dashboard/ui";
import { LiveAuth } from "@/dashboard/api/auth";
import { CATEGORY_TEXT, FleetApiError } from "@/dashboard/api/errors";
import type { AuthState } from "@/dashboard/api/types";
import { liveTools } from "@/dashboard/adapter";

/** Build-time constant (inlined by the bundler). */
const LIVE = process.env.NEXT_PUBLIC_FLEET_MODE === "live";
const describe = (e: unknown) => (e instanceof FleetApiError ? `${CATEGORY_TEXT[e.category]} (${e.code})` : "The step failed. Try again.");

export default function Login() {
  const [auth] = useState(() => (LIVE && liveTools ? liveTools.auth() : null));
  const [st, setSt] = useState<AuthState | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [stage, setStage] = useState<"start" | "enroll-totp" | "totp">("start");
  const [secret, setSecret] = useState<{ totpSecret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [origin, setOrigin] = useState("");

  useEffect(() => {
    if (!auth) return;
    // The enrollment token can arrive after load (the link opened in an already-open sign-in tab changes only the hash).
    const readHash = () => { const t = LiveAuth.enrollTokenFromHash(location.hash); if (t) setToken(t); };
    const t = setTimeout(() => {
      setOrigin(location.origin);
      readHash();
      auth.state().then((s) => { if (s.session === "full") location.replace("/"); else setSt(s); }, (e) => setMessage(describe(e)));
    }, 0);
    window.addEventListener("hashchange", readHash);
    return () => { clearTimeout(t); window.removeEventListener("hashchange", readHash); };
  }, [auth]);

  async function step(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await fn(); } catch (e) { setMessage(describe(e)); } finally { setBusy(false); }
  }
  const enroll = () => step(async () => {
    const r = await auth!.enroll(token!, "owner passkey");
    history.replaceState(null, "", "/login/"); setToken(null);
    if (r.next === "totp" && r.totpSecret && r.otpauth) { setSecret({ totpSecret: r.totpSecret, otpauth: r.otpauth }); setStage("enroll-totp"); }
    else { setStage("start"); setMessage("Passkey registered. Sign in with it."); setSt(await auth!.state()); }
  });
  const confirmTotp = () => step(async () => {
    await auth!.confirmTotp(code.trim()); setSecret(null); setCode(""); setStage("start");
    setMessage("Authenticator confirmed. Sign in with your passkey."); setSt(await auth!.state());
  });
  const passkey = () => step(async () => { await auth!.loginPasskey(); setStage("totp"); });
  const totp = () => step(async () => { await auth!.loginTotp(code.trim()); setCode(""); location.replace("/"); });

  return <main className="min-h-screen w-full bg-slate-950 text-base text-slate-100">
    {LIVE ? <div className="border-b border-emerald-800 bg-emerald-950/60 px-5 py-2 text-center text-xs tracking-widest text-emerald-200">LIVE · OWNER SIGN-IN</div> : <div className="border-b border-amber-800 bg-amber-950/60 px-5 py-2 text-center text-xs tracking-widest text-amber-200">SIMULATION · FICTIONAL DATA · NO MACHINE OR REAL MONEY CONNECTED</div>}
    <div className="mx-auto max-w-xl p-5 sm:p-8">
      <p className="text-xs tracking-[.25em] text-cyan-300">AUTOMATON FLEET</p><h1 className="mt-2 text-xl font-bold">Command Deck</h1><p className="mb-8 mt-1 text-xs text-slate-500">OWNER OPERATIONS / 01</p>
      {!LIVE ? <Panel title="Simulated sign-in"><p className="mb-4 text-amber-200">This is a simulation build: its training sign-in is inside the deck. No real authentication takes place.</p><Link className={button} href="/">Open the simulated deck</Link></Panel>
        : <Panel title={stage === "enroll-totp" ? "Add your authenticator" : token ? "Register your passkey" : "Owner sign-in"}>
          {message && <p role="status" className="mb-4 rounded border border-slate-700 px-4 py-3 text-sm text-cyan-200">{message}</p>}
          {stage === "enroll-totp" && secret ? <>
            <p className="mb-3 text-sm text-slate-300">Add this secret to your authenticator app now. It is shown once and never again.</p>
            <p className="mb-2 break-all rounded border border-dashed border-cyan-500 bg-slate-950 p-4 font-mono">{secret.totpSecret}</p>
            <details className="mb-4 text-sm"><summary className="cursor-pointer text-cyan-300">otpauth link</summary><p className="mt-2 break-all font-mono text-xs text-slate-400">{secret.otpauth}</p></details>
            <label className="text-sm">Code from the authenticator<input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <button className={`${button} mt-4`} disabled={busy || code.trim().length < 6} onClick={confirmTotp}>{busy ? "Checking…" : "Confirm authenticator"}</button>
          </> : token ? <>
            <p className="mb-4 text-sm text-slate-300">This one-time link registers a passkey on this device for the owner of this Fleet.</p>
            <button className={button} disabled={busy} onClick={enroll}>{busy ? "Waiting for the passkey…" : "Register passkey"}</button>
          </> : stage === "totp" ? <>
            <p className="mb-3 text-sm text-slate-300">Passkey verified. Enter the current code from your authenticator.</p>
            <label className="text-sm">Authenticator code<input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <button className={`${button} mt-4`} disabled={busy || code.trim().length < 6} onClick={totp}>{busy ? "Checking…" : "Complete sign-in"}</button>
          </> : !st ? <p className="text-sm text-slate-400">Reading this Fleet&apos;s sign-in state…</p>
            : st.locked ? <p className="text-amber-200">Sign-in is locked after repeated failures. Wait, then try again.</p>
            : !st.enrolled ? <p className="text-sm text-slate-300">This Fleet has no owner passkey yet. On the Fleet host, run <code className="font-mono text-cyan-200">fleet:admin hub-dashboard-enroll {origin}</code> and open the one-time link it prints on this device.</p>
            : <button className={button} disabled={busy} onClick={passkey}>{busy ? "Waiting for the passkey…" : "Sign in with passkey"}</button>}
        </Panel>}
    </div>
  </main>;
}
