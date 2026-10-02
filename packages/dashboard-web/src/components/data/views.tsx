"use client";
import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** Registry values are untrusted text (agent-written names, mail, notes): rendered as React text nodes only. */
export function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>;
  if (typeof value === "boolean") return <span>{value ? "yes" : "no"}</span>;
  if (typeof value === "object") return <pre className="max-w-xl whitespace-pre-wrap font-mono text-xs">{JSON.stringify(value, null, 1)}</pre>;
  return <span>{String(value)}</span>;
}

export function KeyValue({ data, labels = {}, format = {} }: { data: Record<string, unknown> | null | undefined; labels?: Record<string, string>;
  format?: Record<string, (v: unknown) => React.ReactNode> }) {
  if (!data) return <Empty />;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[minmax(10rem,max-content)_1fr]">
      {Object.entries(data).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-sm text-muted-foreground">{labels[k] ?? k}</dt>
          <dd className="text-sm">{format[k] ? format[k](v) : <Cell value={v} />}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export type Column<T> = { key: string; label: string; render?: (row: T) => React.ReactNode; className?: string };

export function DataTable<T extends Record<string, any>>({ rows, columns, empty = "Nothing here yet.", rowKey }: { rows: T[] | null | undefined; columns?: Column<T>[];
  empty?: string; rowKey?: (r: T, i: number) => string }) {
  if (!rows || rows.length === 0) return <Empty text={empty} />;
  const cols: Column<T>[] = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 10).map((k) => ({ key: k, label: k }));
  return (
    <Table>
      <THead><TR>{cols.map((c) => <TH key={c.key} className={c.className}>{c.label}</TH>)}</TR></THead>
      <TBody>
        {rows.map((r, i) => (
          <TR key={rowKey ? rowKey(r, i) : i}>
            {cols.map((c) => <TD key={c.key} className={c.className}>{c.render ? c.render(r) : <Cell value={r[c.key]} />}</TD>)}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function Empty({ text = "Nothing here yet." }: { text?: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
}

export function Section({ title, description, actions, children, className }: { title: string; description?: string; actions?: React.ReactNode;
  children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1"><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "good" | "warn" | "bad" }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "good" && "text-success", tone === "warn" && "text-warning", tone === "bad" && "text-destructive")}>{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-xl font-semibold">{title}</h1>{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}</div>
      {actions}
    </div>
  );
}

export function Loading({ loading, error, children }: { loading: boolean; error: string | null; children: React.ReactNode }) {
  if (error) return <ErrorBox error={error} />;
  if (loading) return <p className="py-6 text-sm text-muted-foreground">Loading…</p>;
  return <>{children}</>;
}
