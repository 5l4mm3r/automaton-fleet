"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

/** A modal on the native <dialog> element (focus trap, Escape and backdrop handled by the browser). */
export function Dialog({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className={cn("m-auto w-full max-w-lg rounded-xl border bg-card p-0 text-foreground shadow-xl", className)}>
      <div className="flex items-center justify-between border-b px-5 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <button aria-label="Close" className="rounded px-2 text-muted-foreground hover:bg-muted" onClick={onClose}>✕</button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
