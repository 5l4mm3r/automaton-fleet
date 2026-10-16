"use client";
/**
 * Owner sign-in recovery (v82), in plain language. Every route needs TWO things the owner has, and none of them signs in
 * by itself — afterwards the owner signs in the normal way:
 *   Forgot password      authenticator code + one recovery code → choose a new password
 *                        (or: passkey + authenticator code sign-in, then Security → Change password)
 *   Lost authenticator   password (or this device's passkey) + one recovery code → a new authenticator, confirmed with a code
 *   Lost everything      recovery on the Fleet host (the documented enrollment link)
 * Recovery codes are created in Security → Sign-in methods and shown once. Each works once. Every recovery signs out all
 * sessions and emails a security alert.
 */
import { useEffect, useState } from "react";
import type { LiveAuth } from "../api/auth";
import { describeError } from "../api/errors";
import { button, input } from "../ui";

const describe = (e: unknown) => describeError(e, "That step didn’t work. Please try again.");
const REFUSED = "Those details were not accepted. Check the authenticator code (it changes every 30 seconds) and the recovery code, then try again.";
const said = (e: unknown) => (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "FLEET_RECOVERY_INVALID" ? REFUSED : describe(e));

function HostRecovery({ origin, authenticator }: { origin: string; authenticator?: boolean }) {
  return <details className="mt-6 rounded border border-slate-700 p-3 text-sm">
    <summary className="cursor-pointer text-cyan-300">No recovery code either?</summary>
    <p className="mt-2 text-slate-300">Then recovery happens on the Fleet server itself, from your own terminal (nothing is emailed, and nobody else can do it for you):</p>
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-300">
      {authenticator && <li>Remove the lost authenticator: <code className="font-mono text-cyan-200">fleet:admin hub-dashboard-totp-reset</code></li>}
      <li>Create a one-time link: <code className="font-mono text-cyan-200">fleet:admin hub-dashboard-enroll {origin || "<this site>"}</code></li>
      <li>Open the link on this device within 15 minutes, then set a password or register a passkey{authenticator ? ", and add the new authenticator it shows" : ""}.</li>
    </ol>
    <p className="mt-2 text-xs text-slate-400">The link is a key to your Fleet: never paste it into a chat or an email.</p>
  </details>;
}

/** "Forgot password?" on the sign-in page. */
export function ForgotPassword({ auth, origin, onBack, onDone, onPasskey }: {
  auth: LiveAuth; origin: string; onBack: () => void; onDone: (message: string) => void; onPasskey: () => void;
}) {
  const [code, setCode] = useState(""), [recovery, setRecovery] = useState(""), [pw, setPw] = useState(""), [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async () => {
    if (pw !== pw2) { setError("The two passwords differ."); return; }
    setBusy(true); setError("");
    try {
      const r = await auth.recoverPassword(code.trim(), recovery.trim(), pw);
      onDone(`Your new password is set and every open session was signed out. Sign in now with the new password and a NEW code from your authenticator.${r.codesLeft !== null ? ` You have ${r.codesLeft} recovery code${r.codesLeft === 1 ? "" : "s"} left${r.codesLeft <= 3 ? " — create a new set in Security soon" : ""}.` : ""}`);
    } catch (e) { setError(said(e)); } finally { setBusy(false); }
  };
  return <div>
    <h4 className="font-semibold">Forgot your password?</h4>
    <p className="mt-1 text-sm text-slate-300">Pick whichever applies. Either way you need two things, so nobody can take over with just one.</p>
    <section className="mt-4 rounded border border-slate-700 p-3">
      <h5 className="font-semibold">I have my passkey on this device</h5>
      <p className="mt-1 text-sm text-slate-300">Sign in with the passkey and your authenticator code, then open <strong>Security → Sign-in methods → Change password</strong>.</p>
      <button className={`${button} mt-3`} onClick={onPasskey}>Sign in with passkey</button>
    </section>
    <form className="mt-4 rounded border border-slate-700 p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h5 className="font-semibold">I have my authenticator app and a recovery code</h5>
      <p className="mt-1 text-sm text-slate-300">Recovery codes are the ten codes you saved from Security. Each one works once.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      <label className="mt-3 block text-sm">Authenticator code<input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
      <label className="mt-3 block text-sm">Recovery code<input className={input} autoComplete="off" spellCheck={false} maxLength={40} placeholder="XXXX-XXXX-XXXX-XXXX" value={recovery} onChange={(e) => setRecovery(e.target.value)} /></label>
      <label className="mt-3 block text-sm">New password (at least 12 characters)<input className={input} type="password" autoComplete="new-password" maxLength={256} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      <label className="mt-3 block text-sm">Repeat the new password<input className={input} type="password" autoComplete="new-password" maxLength={256} value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
      <p className="mt-3 text-xs text-slate-400">This signs out every open session and emails you a security alert. It does not sign you in: you sign in afterwards with the new password.</p>
      <button className={`${button} mt-3`} disabled={busy || code.trim().length < 6 || recovery.trim().length < 16 || pw.length < 12}>{busy ? "Checking…" : "Set new password"}</button>
    </form>
    <HostRecovery origin={origin} />
    <button className={`${button} mt-5`} onClick={onBack}>Back to sign-in</button>
  </div>;
}

/** "Lost your authenticator?" on the sign-in page. */
export function LostAuthenticator({ auth, origin, onBack, onDone }: { auth: LiveAuth; origin: string; onBack: () => void; onDone: (message: string) => void }) {
  const [recovery, setRecovery] = useState(""), [pw, setPw] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [fresh, setFresh] = useState<{ ticket: string; totpSecret: string; otpauth: string; codesLeft: number | null } | null>(null);
  const begin = async (withPasskey: boolean) => {
    setBusy(true); setError("");
    try { setFresh(await auth.recoverAuthenticator(recovery.trim(), withPasskey ? null : pw)); setPw(""); setRecovery(""); }
    catch (e) { setError(e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "FLEET_RECOVERY_INVALID"
      ? "Those details were not accepted. Check the password (or use this device's passkey) and the recovery code, then try again." : describe(e)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!fresh) return;
    setBusy(true); setError("");
    try {
      await auth.confirmRecoveredAuthenticator(fresh.ticket, code.trim());
      onDone("Your new authenticator is active and the old one no longer works. Every open session was signed out. Sign in now with a code from the new authenticator.");
    } catch (e) { setError(said(e)); } finally { setBusy(false); }
  };
  if (fresh) return <div>
    <h4 className="font-semibold">Add your new authenticator</h4>
    <p className="mt-1 text-sm text-slate-300">Add this secret to your authenticator app now. It is shown once. Your old authenticator keeps working until you confirm a code from the new one below.</p>
    <p className="mt-3 break-all rounded border border-dashed border-cyan-500 bg-slate-950 p-4 font-mono">{fresh.totpSecret}</p>
    <details className="mb-2 mt-2 text-sm"><summary className="cursor-pointer text-cyan-300">otpauth link</summary><p className="mt-2 break-all font-mono text-xs text-slate-400">{fresh.otpauth}</p></details>
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    <label className="mt-3 block text-sm">Code from the NEW authenticator<input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
    <button className={`${button} mt-4`} disabled={busy || code.trim().length < 6} onClick={() => void confirm()}>{busy ? "Checking…" : "Confirm new authenticator"}</button>
    <p className="mt-3 text-xs text-slate-400">The recovery code you used is spent{fresh.codesLeft !== null ? ` (${fresh.codesLeft} left)` : ""}. If you leave now, start again with another code within 15 minutes.</p>
  </div>;
  return <div>
    <h4 className="font-semibold">Lost your authenticator?</h4>
    <p className="mt-1 text-sm text-slate-300">You need two things: your password (or this device&apos;s passkey) and one recovery code. Then you add a new authenticator and confirm it with a code. Nothing changes until that confirmation.</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    <label className="mt-3 block text-sm">Recovery code<input className={input} autoComplete="off" spellCheck={false} maxLength={40} placeholder="XXXX-XXXX-XXXX-XXXX" value={recovery} onChange={(e) => setRecovery(e.target.value)} /></label>
    <form className="mt-3" onSubmit={(e) => { e.preventDefault(); void begin(false); }}>
      <label className="block text-sm">Password<input className={input} type="password" autoComplete="current-password" maxLength={256} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      <button className={`${button} mt-3`} disabled={busy || !pw || recovery.trim().length < 16}>{busy ? "Checking…" : "Continue with password"}</button>
    </form>
    <p className="my-3 text-center text-xs tracking-widest text-slate-500">OR</p>
    <button className={button} disabled={busy || recovery.trim().length < 16} onClick={() => void begin(true)}>{busy ? "Waiting for the passkey…" : "Continue with this device's passkey"}</button>
    <p className="mt-3 text-xs text-slate-400">Afterwards every open session is signed out and you get a security alert by email.</p>
    <HostRecovery origin={origin} authenticator />
    <button className={`${button} mt-5`} onClick={onBack}>Back to sign-in</button>
  </div>;
}

/** Security → Sign-in methods → Recovery codes. */
export function RecoveryCodes({ auth }: { auth: LiveAuth }) {
  const [state, setState] = useState<{ remaining: number; issuedAt: string | null } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [unavailable, setUnavailable] = useState(false);
  const load = () => auth.recoveryState().then((s) => { setState(s); setUnavailable(false); }, () => setUnavailable(true));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const issue = async () => {
    setBusy(true); setError("");
    try { setCodes(await auth.issueRecoveryCodes()); await load(); } catch (e) { setError(describe(e)); } finally { setBusy(false); }
  };
  const download = () => {
    if (!codes) return;
    const text = `Automaton Fleet — owner recovery codes (${new Date().toISOString().slice(0, 10)})\nEach code works once. Keep them somewhere safe and offline, away from your phone.\n\n${codes.join("\n")}\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "automaton-fleet-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
  };
  return <section>
    <h4 className="font-semibold">Recovery codes</h4>
    <p className="text-sm text-slate-300">For the day you forget your password or lose your authenticator. Each code works once, and always together with something else you have, so a code alone never gets anyone in.</p>
    {unavailable ? <p className="mt-1 text-sm text-slate-400">The recovery-code count is not available from the Fleet gateway.</p>
      : state && <p className="mt-1 text-sm text-slate-300">{state.remaining > 0 ? `${state.remaining} unused code${state.remaining === 1 ? "" : "s"} left` : "No recovery codes yet"}{state.issuedAt ? ` · created ${state.issuedAt.slice(0, 10)}` : ""}</p>}
    {state && state.remaining <= 3 && !codes && <p className="mt-1 text-sm text-amber-200">{state.remaining === 0 ? "Create a set now, while you can still sign in." : "Few codes left: create a new set."}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    {codes ? <div className="mt-3 rounded border border-dashed border-cyan-500 bg-slate-950 p-4">
        <p className="text-sm text-slate-200">Save these now — they are shown once. Store them offline (printed, or in a password manager), not on the phone that holds your authenticator.</p>
        <ol className="mt-3 grid grid-cols-1 gap-1 font-mono text-sm sm:grid-cols-2">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
        <div className="mt-3 flex flex-wrap gap-2"><button className={button} onClick={download}>Download as a text file</button>
          <button className={button} onClick={() => setCodes(null)}>I have saved them</button></div>
      </div>
      : <><button className={`${button} mt-3`} disabled={busy || unavailable} onClick={() => void issue()}>{busy ? "Waiting for confirmation…" : state && state.remaining > 0 ? "Replace recovery codes" : "Create recovery codes"}</button>
        <p className="mt-2 text-xs text-slate-400">You confirm it is you first (passkey, or password and code). Creating a new set makes any unused old codes stop working.</p></>}
  </section>;
}
