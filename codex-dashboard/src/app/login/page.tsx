"use client";
/**
 * Owner sign-in (LIVE builds), through the dashboard gateway of whatever host serves this page. Two routes, both ending
 * with the authenticator code:
 *   • password + authenticator code (works in any browser; v43 — owner access never depends on one browser's passkey)
 *   • passkey → authenticator code
 * First access and recovery use the one-time enrollment link the Fleet host prints (`fleet:admin hub-dashboard-enroll
 * <origin>` → `<origin>/login/#enroll=<token>`): it registers a passkey or sets the password on this device. The token
 * stays in the URL fragment (never sent to a server log) and is removed from the address bar once used. No demo code.
 */
import { HOME_PATH, LOGIN_PATH } from "@/dashboard/base";
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
  const [reverify, setReverify] = useState(false);
  const [password, setPassword] = useState(""), [password2, setPassword2] = useState("");

  useEffect(() => {
    if (!auth) return;
    // The enrollment token can arrive after load (the link opened in an already-open sign-in tab changes only the hash).
    const readHash = () => { const t = LiveAuth.enrollTokenFromHash(location.hash); if (t) setToken(t); };
    const t = setTimeout(() => {
      setOrigin(location.origin);
      readHash();
      // "#reverify": a signed-in browser verifying THIS tab for changes (the token is per tab) — stay and sign in.
      const reverify = location.hash === "#reverify";
      if (reverify) setReverify(true);
      auth.state().then((s) => { if (s.session === "full" && !reverify) location.replace(HOME_PATH); else setSt(s); }, (e) => setMessage(describe(e)));
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
    history.replaceState(null, "", LOGIN_PATH); setToken(null);
    if (r.next === "totp" && r.totpSecret && r.otpauth) { setSecret({ totpSecret: r.totpSecret, otpauth: r.otpauth }); setStage("enroll-totp"); }
    else { setStage("start"); setMessage("Passkey registered. Sign in with it."); setSt(await auth!.state()); }
  });
  const enrollPassword = () => step(async () => {
    if (password !== password2) { setMessage("The two passwords differ."); return; }
    const r = await auth!.enrollPassword(token!, password);
    history.replaceState(null, "", LOGIN_PATH); setToken(null); setPassword(""); setPassword2("");
    if (r.next === "totp" && r.totpSecret && r.otpauth) { setSecret({ totpSecret: r.totpSecret, otpauth: r.otpauth }); setStage("enroll-totp"); }
    else { setStage("start"); setMessage("Password set. Sign in with it and your authenticator code."); setSt(await auth!.state()); }
  });
  const confirmTotp = () => step(async () => {
    await auth!.confirmTotp(code.trim()); setSecret(null); setCode(""); setStage("start");
    setMessage("Authenticator confirmed. Sign in with your password or passkey and a code."); setSt(await auth!.state());
  });
  const passwordLogin = () => step(async () => {
    await auth!.loginPassword(password, code.trim());
    setPassword(""); setCode(""); location.replace(HOME_PATH);
  });
  const passkey = () => step(async () => { await auth!.loginPasskey(); setStage("totp"); });
  const totp = () => step(async () => { await auth!.loginTotp(code.trim()); setCode(""); location.replace(HOME_PATH); });

  return <main className="min-h-screen w-full bg-slate-950 text-base text-slate-100">
    {LIVE ? <div className="border-b border-emerald-800 bg-emerald-950/60 px-5 py-2 text-center text-xs tracking-widest text-emerald-200">LIVE · OWNER SIGN-IN</div> : <div className="border-b border-amber-800 bg-amber-950/60 px-5 py-2 text-center text-xs tracking-widest text-amber-200">SIMULATION · FICTIONAL DATA · NO MACHINE OR REAL MONEY CONNECTED</div>}
    <div className="mx-auto max-w-xl p-5 sm:p-8">
      <p className="text-xs tracking-[.25em] text-cyan-300">AUTOMATON FLEET</p><h1 className="mt-2 text-xl font-bold">Command Deck</h1><p className="mb-8 mt-1 text-xs text-slate-500">OWNER OPERATIONS / 01</p>
      {!LIVE ? <Panel title="Simulated sign-in"><p className="mb-4 text-amber-200">This is a simulation build: its training sign-in is inside the deck. No real authentication takes place.</p><Link className={button} href="/">Open the simulated deck</Link></Panel>
        : <Panel title={stage === "enroll-totp" ? "Add your authenticator" : token ? "Add a way to sign in" : "Owner sign-in"}>
          {message && <p role="status" className="mb-4 rounded border border-slate-700 px-4 py-3 text-sm text-cyan-200">{message}</p>}
          {stage === "enroll-totp" && secret ? <>
            <p className="mb-3 text-sm text-slate-300">Add this secret to your authenticator app now. It is shown once and never again.</p>
            <p className="mb-2 break-all rounded border border-dashed border-cyan-500 bg-slate-950 p-4 font-mono">{secret.totpSecret}</p>
            <details className="mb-4 text-sm"><summary className="cursor-pointer text-cyan-300">otpauth link</summary><p className="mt-2 break-all font-mono text-xs text-slate-400">{secret.otpauth}</p></details>
            <label className="text-sm">Code from the authenticator<input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <button className={`${button} mt-4`} disabled={busy || code.trim().length < 6} onClick={confirmTotp}>{busy ? "Checking…" : "Confirm authenticator"}</button>
          </> : token ? <>
            <p className="mb-4 text-sm text-slate-300">This one-time link (15 minutes, works once) adds a way in for the owner of this Fleet: register a passkey on this device, or set the sign-in password.</p>
            <button className={button} disabled={busy} onClick={enroll}>{busy ? "Waiting for the passkey…" : "Register passkey"}</button>
            <form className="mt-6 border-t border-slate-700 pt-5" onSubmit={(e) => { e.preventDefault(); void enrollPassword(); }}>
              <h4 className="font-semibold">Or set the sign-in password</h4>
              <p className="mt-1 text-xs text-slate-400">At least 12 characters. It is always used together with your authenticator code.</p>
              <label className="mt-3 block text-sm">New password<input className={input} type="password" autoComplete="new-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <label className="mt-3 block text-sm">Repeat the password<input className={input} type="password" autoComplete="new-password" maxLength={256} value={password2} onChange={(e) => setPassword2(e.target.value)} /></label>
              <button className={`${button} mt-4`} disabled={busy || password.length < 12}>{busy ? "Setting…" : "Set password"}</button>
            </form>
          </> : stage === "totp" ? <>
            <p className="mb-3 text-sm text-slate-300">Passkey verified. Enter the current code from your authenticator.</p>
            <label className="text-sm">Authenticator code<input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <button className={`${button} mt-4`} disabled={busy || code.trim().length < 6} onClick={totp}>{busy ? "Checking…" : "Complete sign-in"}</button>
          </> : !st ? <p className="text-sm text-slate-400">Reading this Fleet&apos;s sign-in state…</p>
            : st.locked ? <p className="text-amber-200">Sign-in is locked after repeated failures. Wait, then try again.</p>
            : !st.enrolled ? <p className="text-sm text-slate-300">This Fleet has no owner sign-in yet. On the Fleet host, run <code className="font-mono text-cyan-200">fleet:admin hub-dashboard-enroll {origin}</code> and open the one-time link it prints on this device to set a password or register a passkey.</p>
            : <>{reverify && <p className="mb-3 text-sm text-slate-300">Verify this tab to make changes from it: the same sign-in (password or passkey, then your authenticator code). Your other tabs stay signed in and receive the new verification.</p>}
              <form aria-label="Sign in with password" onSubmit={(e) => { e.preventDefault(); void passwordLogin(); }}>
                <h4 className="font-semibold">Sign in with password</h4>
                <label className="mt-3 block text-sm">Password<input className={input} type="password" name="password" autoComplete="current-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
                <label className="mt-3 block text-sm">Authenticator code<input className={input} inputMode="numeric" name="code" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
                <button className={`${button} mt-4`} disabled={busy || !password || code.trim().length < 6}>{busy ? "Checking…" : "Sign in"}</button>
              </form>
              <p className="my-5 text-center text-xs tracking-widest text-slate-500">OR</p>
              <button className={button} disabled={busy} onClick={passkey}>{busy ? "Waiting for the passkey…" : "Sign in with passkey"}</button>
              <p className="mt-2 text-xs text-slate-400">A passkey is followed by your authenticator code.</p></>}
        </Panel>}
    </div>
  </main>;
}
