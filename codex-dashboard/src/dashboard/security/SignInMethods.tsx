"use client";
/**
 * Security → Sign-in methods (v43). Owner access must not depend on one browser- or provider-specific passkey:
 *   Password       set / change (a fresh confirmation first); always used with the authenticator code
 *   Authenticator  the second factor of every route; replaced only on the Fleet host (it cannot be removed here)
 *   Passkeys       several devices; add (fresh confirmation, then this device creates it), rename, revoke (confirmed)
 * FleetController refuses any change that would leave no way in. Nothing secret is shown or stored here.
 */
import { useState } from "react";
import type { LiveView } from "../model";
import { describeError } from "../api/errors";
import type { LiveAuth } from "../api/auth";
import { button, input } from "../ui";
import { utcText } from "../notifications/report";

const describe = (e: unknown) => describeError(e, "The change didn’t go through. Nothing was changed.");

export function SignInMethods({ signIn, auth, run, onRevoke, refresh }: {
  signIn: NonNullable<LiveView["signIn"]> | null; auth: LiveAuth; run: (op: string, args: Record<string, string>) => Promise<unknown>;
  onRevoke: (id: string, name: string) => void; refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [pw, setPw] = useState(""), [pw2, setPw2] = useState(""), [showPw, setShowPw] = useState(false);
  const [newKey, setNewKey] = useState(""), [renaming, setRenaming] = useState<string | null>(null), [rename, setRename] = useState("");
  const step = async (fn: () => Promise<void>, done: string) => {
    setBusy(true); setError(""); setMessage("");
    try { await fn(); setMessage(done); await refresh(); } catch (e) { setError(describe(e)); } finally { setBusy(false); }
  };
  if (!signIn) return <p className="text-sm text-slate-400">Sign-in methods are not available from the Fleet gateway.</p>;
  const keys = signIn.passkeys;
  return <div className="space-y-6">
    {message && <p role="status" className="rounded border border-slate-700 px-3 py-2 text-sm text-cyan-200">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <section>
      <h4 className="font-semibold">Password</h4>
      <p className="text-sm text-slate-300">{signIn.password.configured ? `Set${signIn.password.setAt ? ` · ${utcText(signIn.password.setAt)}` : ""}` : "Not set"} · always used with your authenticator code{signIn.method === "password" ? " · this session signed in with it" : ""}</p>
      {!signIn.password.configured && <p className="mt-1 text-sm text-amber-200">Set a password so that you can sign in from any browser, even without this device&apos;s passkey.</p>}
      {!showPw ? <button className={`${button} mt-3`} disabled={busy} onClick={() => setShowPw(true)}>{signIn.password.configured ? "Change password" : "Set password"}</button>
        : <form className="mt-3 max-w-md" onSubmit={(e) => { e.preventDefault(); if (pw !== pw2) { setError("The two passwords differ."); return; }
            void step(async () => { await auth.setPassword(pw); setPw(""); setPw2(""); setShowPw(false); }, "Password saved. Other password sessions were signed out."); }}>
          <label className="block text-sm">New password (at least 12 characters)<input className={input} type="password" autoComplete="new-password" maxLength={256} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <label className="mt-3 block text-sm">Repeat the password<input className={input} type="password" autoComplete="new-password" maxLength={256} value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          <div className="mt-4 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => { setShowPw(false); setPw(""); setPw2(""); }}>Cancel</button>
            <button className={`${button} bg-cyan-900`} disabled={busy || pw.length < 12}>{busy ? "Saving…" : "Confirm and save"}</button></div>
          <p className="mt-2 text-xs text-slate-400">You will be asked for a fresh confirmation (passkey, or current password and code) first.</p>
        </form>}
    </section>
    <section>
      <h4 className="font-semibold">Authenticator</h4>
      <p className="text-sm text-slate-300">{signIn.totp ? "Active" : "Not set"} · the second factor of every sign-in route</p>
      <p className="mt-1 text-xs text-slate-400">It cannot be removed here (that would lock every route). To replace it, on the Fleet host run <code className="font-mono">fleet:admin hub-dashboard-totp-reset</code>, then open a new <code className="font-mono">hub-dashboard-enroll</code> link.</p>
    </section>
    <section>
      <h4 className="font-semibold">Passkeys</h4>
      {keys.length === 0 && <p className="text-sm text-slate-400">No passkeys. You sign in with the password and your authenticator code.</p>}
      <ul className="mt-2 space-y-2">{keys.map((k) => <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-700 p-3 text-sm">
        <div className="min-w-0">{renaming === k.id
          ? <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void step(async () => { await run("passkey_rename", { keyId: k.id, name: rename }); setRenaming(null); }, "Passkey renamed."); }}>
              <input aria-label="Passkey name" className={`${input} mt-0 w-56`} maxLength={80} value={rename} onChange={(e) => setRename(e.target.value)} />
              <button className={button} disabled={busy || !rename.trim()}>Save</button><button type="button" className={button} onClick={() => setRenaming(null)}>Cancel</button></form>
          : <p className="font-medium">{k.name}{k.current ? <span className="ml-2 text-xs text-cyan-300">this session</span> : null}</p>}
          <p className="text-xs text-slate-400">Added {k.createdAt ? utcText(k.createdAt) : "—"} · last used {k.lastUsedAt ? utcText(k.lastUsedAt) : "never"}</p></div>
        <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => { setRenaming(k.id); setRename(k.name); }}>Rename</button>
          <button className={button} disabled={busy} onClick={() => onRevoke(k.id, k.name)}>Revoke</button></div>
      </li>)}</ul>
      <form className="mt-4 flex max-w-md flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void step(async () => { await auth.addPasskey(newKey.trim() || "passkey"); setNewKey(""); }, "Passkey added on this device."); }}>
        <label className="grow text-sm">Name for a new passkey on this device<input className={input} maxLength={80} placeholder="e.g. My Phone" value={newKey} onChange={(e) => setNewKey(e.target.value)} /></label>
        <button className={button} disabled={busy}>{busy ? "Waiting…" : "Add passkey"}</button>
      </form>
      <p className="mt-2 text-xs text-slate-400">FleetController refuses to revoke your last passkey unless a password is set, so you can never remove every way in.</p>
    </section>
  </div>;
}
