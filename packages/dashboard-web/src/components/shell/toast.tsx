"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "good" | "bad" | "info";
const Ctx = React.createContext<(msg: string, tone?: Tone) => void>(() => {});
export const useToast = () => React.useContext(Ctx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Array<{ id: number; msg: string; tone: Tone }>>([]);
  const push = React.useCallback((msg: string, tone: Tone = "info") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { id, msg, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 7000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div id="toasts" role="status" aria-live="polite" className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={cn("rounded-lg border bg-card px-4 py-3 text-sm shadow-lg", t.tone === "bad" && "border-destructive/50 text-destructive",
            t.tone === "good" && "border-success/50")}>{t.msg}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
