"use client";
import * as React from "react";
import { read } from "@/lib/api";

/** A gateway read with loading/error state; `reload()` re-fetches (e.g. after an action). Never cached across sessions. */
export function useRead<T = any>(op: string, args: Record<string, unknown> = {}, opts: { refreshMs?: number; skip?: boolean } = {}) {
  const key = JSON.stringify(args);
  const [state, set] = React.useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const run = React.useCallback(async () => {
    if (opts.skip) return;
    try {
      const data = await read<T>(op, JSON.parse(key));
      set({ data, error: null, loading: false });
    } catch (e) {
      set((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false }));
    }
  }, [op, key, opts.skip]);
  React.useEffect(() => {
    void run();
    if (!opts.refreshMs) return;
    const t = setInterval(() => void run(), opts.refreshMs);
    return () => clearInterval(t);
  }, [run, opts.refreshMs]);
  return { ...state, reload: run };
}
