"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionButton, ActionForm } from "@/components/actions/action-form";
import { RevealButton } from "@/components/actions/reveal";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { call } from "@/lib/api";
import { b64, sealTo } from "@/lib/sealed";
import { when } from "@/lib/format";
import { useToast } from "@/components/shell/toast";

const CLASSES = ["legal_name", "date_of_birth", "residential_address", "contact_email", "contact_phone", "passport", "driving_licence", "id_document",
  "proof_of_address", "tax_identifier", "bank_account_owner", "other_fact"];

export default function OwnerVault() {
  const id = useRead<any>("identity");
  const comms = useRead<any>("comms");
  const key = useRead<any>("broker_key");
  const vault = id.data?.ownerVault;
  return (
    <>
      <PageHeader title="Owner identity vault" description="Sealed in this browser to the identity broker's key. Agents never receive these values; the broker releases only what a provider needs, under your standing consent." />
      <div className="flex flex-col gap-4">
        <Upload brokerPub={key.data?.ownerPub} fingerprint={key.data?.fingerprint} onDone={() => { void comms.reload(); void id.reload(); }} />
        <Section title="Classes in the vault"><Loading loading={comms.loading} error={comms.error}>
          <DataTable rows={comms.data?.ownerVault} rowKey={(c) => c.class_key} columns={[{ key: "class_key", label: "Class" }, { key: "status", label: "Status" },
            { key: "expires_at", label: "Expires", render: (c) => when(c.expires_at) },
            { key: "reveal", label: "", render: (c) => <span className="reveal-owner" data-class={c.class_key}><RevealButton kind="owner_identity" target={c.class_key} title={c.class_key} /></span> }]} />
        </Loading></Section>
        <Section title="Standing consent" description="Purpose- and provider-scoped; revocable at any time.">
          <Loading loading={id.loading} error={id.error}>
            <DataTable rows={vault?.consents} rowKey={(c) => c.consentId} columns={[{ key: "purposes", label: "Purposes" }, { key: "providers", label: "Providers" },
              { key: "classes", label: "Classes" }, { key: "statement", label: "Statement" }, { key: "active", label: "Active" },
              { key: "revoke", label: "", render: (c) => c.active ? <ActionButton op="owner_identity_consent_revoke" args={{ consentId: c.consentId }} label="Revoke" onDone={() => void id.reload()} /> : null }]} />
          </Loading>
          <div className="mt-4"><ActionForm op="owner_identity_consent_set" label="Grant consent" onDone={() => void id.reload()} fields={[
            { name: "purposes", label: "Purposes (JSON array)", type: "json", required: true, placeholder: '["account_verification","seller_verification"]' },
            { name: "classes", label: "Classes (JSON array)", type: "json", required: true, placeholder: '["legal_name","date_of_birth"]' },
            { name: "statement", label: "Statement", type: "textarea", required: true }]} /></div>
        </Section>
        <Section title="Release history" description="Who, which venture, which provider and account, why, which classes, when, and the result — never the values.">
          <Loading loading={id.loading} error={id.error}><DataTable rows={vault?.releases} /></Loading>
        </Section>
        <Section title="Uploads"><Loading loading={comms.loading} error={comms.error}><DataTable rows={comms.data?.uploads} /></Loading></Section>
      </div>
    </>
  );
}

function Upload({ brokerPub, fingerprint, onDone }: { brokerPub?: string | null; fingerprint?: string; onDone: () => void }) {
  const toast = useToast();
  const [cls, setCls] = React.useState("legal_name");
  const [text, setText] = React.useState("");
  const [expires, setExpires] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const file = React.useRef<HTMLInputElement>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!brokerPub) { toast("The identity broker has not published its key (is it running?)", "bad"); return; }
    setBusy(true);
    try {
      let value = text, contentType = "text/plain";
      const f = file.current?.files?.[0];
      if (f) { contentType = f.type; value = JSON.stringify({ contentType, dataB64: b64.enc(new Uint8Array(await f.arrayBuffer())) }); }
      if (!value) throw new Error("nothing to upload");
      const sealed = await sealTo(b64.dec(brokerPub), value, `owner:${cls}`);
      setText(""); if (file.current) file.current.value = "";
      await call("owner_vault_upload", { class: cls, sealedB64: b64.enc(sealed), contentType, expiresAt: expires || null });
      toast("Upload: done", "good");
      onDone();
    } catch (err) { toast(`Upload failed — ${err instanceof Error ? err.message : err}`, "bad"); } finally { setBusy(false); }
  };
  return (
    <Section title="Add to the vault" description="Encrypted here before it leaves this browser.">
      <p className="mb-3 text-sm">Broker key fingerprint: <code id="broker-fp" className="break-all font-mono text-xs">{fingerprint ?? "not published"}</code></p>
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1"><Label htmlFor="up-class">Class</Label>
          <Select id="up-class" value={cls} onChange={(e) => setCls(e.target.value)}>{CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></div>
        <div className="flex flex-col gap-1"><Label htmlFor="up-expires">Expires</Label><Input id="up-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
        <div className="flex flex-col gap-1"><Label htmlFor="up-text">Text value</Label><Input id="up-text" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" /></div>
        <div className="flex flex-col gap-1"><Label htmlFor="up-file">or a document</Label><Input id="up-file" ref={file} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" /></div>
        <div><Button id="up-btn" type="submit" disabled={busy}>{busy ? "Encrypting…" : "Encrypt & upload"}</Button></div>
      </form>
    </Section>
  );
}
