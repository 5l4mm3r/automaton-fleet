"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { call, SENSITIVE_OPS } from "@/lib/api";
import { useToast } from "@/components/shell/toast";

export type Field =
  | { name: string; label: string; type?: "text" | "number" | "date" | "email"; placeholder?: string; required?: boolean; pence?: boolean }
  | { name: string; label: string; type: "select"; options: string[]; required?: boolean }
  | { name: string; label: string; type: "textarea"; placeholder?: string; required?: boolean }
  | { name: string; label: string; type: "checkbox" }
  | { name: string; label: string; type: "json"; placeholder?: string; required?: boolean };

/**
 * One Admin operation as a form. Amount fields marked `pence` are typed in pounds and sent in pence. Sensitive
 * operations are confirmed by a fresh passkey (step-up) inside `call`.
 */
export function ActionForm({ op, fields, fixed = {}, label, confirm, onDone, variant }: { op: string; fields: Field[]; fixed?: Record<string, unknown>;
  label: string; confirm?: string; onDone?: (result: unknown) => void; variant?: "default" | "destructive" | "outline" }) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const args: Record<string, unknown> = { ...fixed };
    for (const f of fields) {
      const raw = fd.get(f.name);
      if (f.type === "checkbox") { args[f.name] = raw === "on"; continue; }
      const v = typeof raw === "string" ? raw.trim() : "";
      if (v === "") continue;
      if (f.type === "number") args[f.name] = "pence" in f && f.pence ? Math.round(Number(v) * 100) : Number(v);
      else if (f.type === "json") {
        try { args[f.name] = JSON.parse(v); } catch { toast(`${f.label}: not valid JSON`, "bad"); return; }
      } else args[f.name] = v;
    }
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try {
      const r = await call(op, args);
      toast(`${label}: done`, "good");
      e.currentTarget?.reset?.();
      onDone?.(r);
    } catch (err) {
      toast(`${label} failed — ${err instanceof Error ? err.message : String(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-op={op}>
      {fields.map((f) => (
        <div key={f.name} className={f.type === "textarea" || f.type === "json" ? "flex flex-col gap-1 sm:col-span-2 lg:col-span-3" : "flex flex-col gap-1"}>
          <Label htmlFor={`${op}-${f.name}`}>{f.label}</Label>
          {f.type === "select" ? (
            <Select id={`${op}-${f.name}`} name={f.name} required={f.required}>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
          ) : f.type === "textarea" || f.type === "json" ? (
            <Textarea id={`${op}-${f.name}`} name={f.name} placeholder={"placeholder" in f ? f.placeholder : undefined} required={"required" in f ? f.required : undefined} />
          ) : f.type === "checkbox" ? (
            <input id={`${op}-${f.name}`} name={f.name} type="checkbox" className="h-4 w-4" />
          ) : (
            <Input id={`${op}-${f.name}`} name={f.name} type={f.type === "number" ? "number" : f.type ?? "text"} step={f.type === "number" ? "0.01" : undefined}
              placeholder={"placeholder" in f ? f.placeholder : undefined} required={"required" in f ? f.required : undefined} />
          )}
        </div>
      ))}
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={busy} variant={variant}>{busy ? "Working…" : label}</Button>
        {SENSITIVE_OPS.has(op) && <span className="text-xs text-muted-foreground">Confirmed with your passkey</span>}
      </div>
    </form>
  );
}

/** A one-click operation (no fields). */
export function ActionButton({ op, args, label, confirm, onDone, variant = "outline", id }: { op: string; args: Record<string, unknown>; label: string;
  confirm?: string; onDone?: () => void; variant?: "default" | "destructive" | "outline" | "ghost"; id?: string }) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button id={id} size="sm" variant={variant} disabled={busy} onClick={async () => {
      if (confirm && !window.confirm(confirm)) return;
      setBusy(true);
      try { await call(op, args); toast(`${label}: done`, "good"); onDone?.(); }
      catch (err) { toast(`${label} failed — ${err instanceof Error ? err.message : String(err)}`, "bad"); }
      finally { setBusy(false); }
    }}>{label}</Button>
  );
}
