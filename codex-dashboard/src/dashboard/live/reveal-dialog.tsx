"use client";
/**
 * LIVE reveal, in the Command Deck's own dialog style: a fresh passkey step-up, the identity broker seals the secret to a
 * one-time key generated in this tab, it is opened here in memory, shown for 60 seconds, then cleared. Every step is in
 * the Fleet's reveal log. The value is never stored or logged.
 */
import { useEffect, useRef, useState } from "react";
import { reveal, type RevealHandle, type RevealKind } from "../api/reveal";
import { describeError } from "../api/errors";
import { button } from "../ui";
import { liveClient } from "./index";

export function LiveReveal({ kind, target, title, close }: { kind: RevealKind; target: string; title: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const handle = useRef<RevealHandle | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [state, setState] = useState("Confirm with your passkey…");
  // One reveal per opened dialog: the parent's `close` changes identity on every render, so it is read through a ref.
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    let cancelled = false;
    reveal(liveClient(), kind, target, { onClear: () => { setValue(null); closeRef.current(); } })
      .then((h) => { if (cancelled) { h.clear(); return; } handle.current = h; setValue(h.value); setState(""); })
      .catch((e) => setState(describeError(e, "The secure view could not be opened. Nothing was shown.")));
    return () => { cancelled = true; handle.current?.clear(); el?.close(); };
  }, [kind, target]);
  return <dialog ref={ref} onCancel={close} className="fixed inset-0 m-auto w-[min(92vw,520px)] rounded-xl border border-cyan-700 bg-slate-900 p-6 text-white backdrop:bg-black/80">
    <p className="text-xs text-cyan-300">LIVE · SEALED TO THIS BROWSER · CLEARS AFTER 60 SECONDS</p><h2 className="my-4 text-xl">{title}</h2>
    {value !== null ? <div className="my-5 whitespace-pre-wrap break-all rounded border border-dashed border-cyan-500 bg-slate-950 p-6 font-mono">{value}</div> : <p role="status" className="my-5 text-sm text-slate-300">{state}</p>}
    <p className="mb-4 text-sm text-slate-400">Opened in this tab only. The Fleet records the reveal, never the value.</p><button className={button} onClick={() => { handle.current?.clear(); close(); }}>Close and clear</button></dialog>;
}
