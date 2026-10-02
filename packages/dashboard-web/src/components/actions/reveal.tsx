"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { call } from "@/lib/api";
import { b64, openSealed, revealKeyPair } from "@/lib/sealed";
import { useToast } from "@/components/shell/toast";

/**
 * Admin reveal, end to end: a one-time X25519 key is made in this tab, the broker seals the value to it, this tab opens
 * it. The plaintext lives only in this component's state, is shown for 60 seconds, and is wiped on close or unmount —
 * never persisted, logged or sent anywhere.
 */
export function RevealButton({ kind, target, title, className }: { kind: "agent_credential" | "owner_identity"; target: string; title: string; className?: string }) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [doc, setDoc] = React.useState<{ url: string; type: string } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = React.useCallback(() => {
    setSecret(null);
    setDoc((d) => { if (d) URL.revokeObjectURL(d.url); return null; });
    if (timer.current) clearTimeout(timer.current);
  }, []);
  React.useEffect(() => close, [close]);
  const run = async () => {
    setBusy(true);
    try {
      const { kp, pub } = await revealKeyPair();
      const r = await call<{ requestId: string }>("reveal_request", { kind, target, ephemeralPub: b64.enc(pub) });
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, i < 4 ? 500 : 1500));
        const t = await call<{ ok: boolean; status?: string; sealedB64?: string; code?: string }>("reveal_take", { requestId: r.requestId });
        if (t?.ok === false) throw new Error(t.code ?? "reveal failed");
        if (t?.status === "delivered" && t.sealedB64) {
          const value = await openSealed(kp, pub, b64.dec(t.sealedB64), `reveal:${r.requestId}`);
          let parsed: { contentType?: string; dataB64?: string } | null = null;
          try { parsed = JSON.parse(value); } catch { parsed = null; }
          if (parsed?.contentType && parsed.dataB64) {
            const blob = new Blob([b64.dec(parsed.dataB64) as BlobPart], { type: parsed.contentType });
            setDoc({ url: URL.createObjectURL(blob), type: parsed.contentType });
            setSecret(`[${parsed.contentType} document]`);
          } else setSecret(value);
          timer.current = setTimeout(close, 60_000);
          return;
        }
      }
      throw new Error("the identity broker did not serve the reveal");
    } catch (e) {
      toast(`Reveal failed — ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" className={className} disabled={busy} onClick={run} data-reveal={target}>{busy ? "Revealing…" : "Reveal"}</Button>
      <Dialog open={secret !== null} onClose={close} title={title}>
        <pre id="reveal-value" className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-sm">{secret ?? ""}</pre>
        {doc && doc.type.startsWith("image/") && <img src={doc.url} alt={title} className="mt-3 max-h-96 rounded-md border" />}
        {doc && doc.type === "application/pdf" && <a href={doc.url} download={`${title}.pdf`} className="mt-3 inline-block text-sm text-primary underline">Download the document</a>}
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Shown for 60 seconds; never stored by this page.</p>
          {secret && !doc && <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</Button>}
        </div>
      </Dialog>
    </>
  );
}
