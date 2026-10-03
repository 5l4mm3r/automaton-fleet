/** Shared visual primitives of the Command Deck (moved unchanged from src/app/page.tsx; used by / and /login). */
import type { ReactNode } from "react";

export const button = "rounded-lg border border-slate-600 px-3 py-2 text-sm hover:border-cyan-300 hover:bg-slate-800 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-cyan-300";
export const input = "mt-2 w-full rounded-lg border border-slate-600 bg-slate-950 p-3 text-slate-100";

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-xl border border-slate-700 bg-slate-900/90 p-5"><h3 className="mb-4 text-lg font-semibold">{title}</h3>{children}</section>;
}
