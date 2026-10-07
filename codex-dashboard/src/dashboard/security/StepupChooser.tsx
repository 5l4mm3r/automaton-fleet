"use client";
/**
 * The owner's confirmation for a sensitive operation (v43): the passkey on this device, OR the password and a current
 * authenticator code — so a change never depends on one browser's passkey. Registered once per tab on the gateway
 * client; the gateway binds the confirmation to the exact operation and arguments and accepts it once.
 */
import { useEffect, useRef, useState } from "react";
import type { StepupChoice } from "../api/client";
import { FleetApiError } from "../api/errors";
import { button, input } from "../ui";

type Pending = { op: string; resolve: (c: StepupChoice) => void; reject: (e: unknown) => void };

export function StepupChooser({ register, passwordConfigured }: { register: (fn: ((op: string) => Promise<StepupChoice>) | null) => void;
  /** Offer the password route only when a password exists (false: passkey only, with a pointer to Security). */
  passwordConfigured: boolean }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState(""), [code, setCode] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    register((op) => new Promise<StepupChoice>((resolve, reject) => setPending({ op, resolve, reject })));
    return () => register(null);
  }, [register]);
  useEffect(() => { if (pending) ref.current?.showModal(); else ref.current?.close(); }, [pending]);
  const finish = (c: StepupChoice | null) => {
    if (!pending) return;
    if (c) pending.resolve(c); else pending.reject(new FleetApiError("FLEET_STEPUP_CANCELLED"));
    setPending(null); setPassword(""); setCode("");
  };
  return <dialog ref={ref} aria-label="Confirm it is you" onCancel={(e) => { e.preventDefault(); finish(null); }}
    className="fixed inset-0 m-auto w-[min(92vw,460px)] rounded-2xl border border-amber-600 bg-slate-900 p-6 text-white backdrop:bg-black/80">
    <p className="text-xs tracking-widest text-amber-300">CONFIRM IT IS YOU</p>
    <h2 className="my-3 text-xl">Fresh confirmation for “{pending?.op.replace(/_/g, " ")}”</h2>
    <button className={`${button} w-full bg-cyan-900`} onClick={() => finish({ method: "passkey" })}>Use my passkey</button>
    {!passwordConfigured ? <p className="mt-4 text-xs text-slate-400">No sign-in password is set yet, so the passkey is the only way to confirm. You can set a password under Security → Sign-in methods.</p>
      : <><p className="my-4 text-center text-xs tracking-widest text-slate-500">OR</p>
    <form onSubmit={(e) => { e.preventDefault(); finish({ method: "password", password, code: code.trim() }); }}>
      <label className="block text-sm">Password<input className={input} type="password" autoComplete="current-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <label className="mt-3 block text-sm">Authenticator code<input className={input} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} /></label>
      <div className="mt-5 flex flex-wrap gap-2"><button type="button" className={button} onClick={() => finish(null)}>Cancel</button>
        <button className={button} disabled={!password || code.trim().length < 6}>Confirm with password</button></div>
    </form></>}
    {!passwordConfigured && <div className="mt-5"><button type="button" className={button} onClick={() => finish(null)}>Cancel</button></div>}
  </dialog>;
}
