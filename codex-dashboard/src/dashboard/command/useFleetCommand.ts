/**
 * Keeps Fleet Command / Virtual data current while either is open — the transport layer.
 *
 * Transport: the gateway has no server push, so this polls efficiently instead of adding a second backend:
 *   · the command view (economics, events, decisions…) when a view opens and every COMMAND_MS while it stays open;
 *   · the pulse (agents + the latest events: two reads) every PULSE_MS while Virtual or Fleet Command is open;
 *   · nothing while the tab is hidden; an immediate refresh when it becomes visible again;
 *   · failures back off (5 s → 10 s → 20 s → 60 s) and show "reconnecting" — the last authoritative data stays on screen
 *     marked with its read time, and nothing is ever replayed (reads only).
 * New events are merged by identity and bounded, so a long session does not grow without limit.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckAdapter } from "../adapter";
import type { Agent } from "../model";
import { mergeEvents } from "./events";
import type { CommandView } from "./view";

export const PULSE_MS = 5_000;
export const COMMAND_MS = 30_000;
const BACKOFF = [5_000, 10_000, 20_000, 60_000];

export type FeedState = "idle" | "connecting" | "live" | "reconnecting";

export function useFleetCommand(adapter: DeckAdapter, opts: { enabled: boolean; fast: boolean; onAgents?: (agents: Agent[]) => void }) {
  const [view, setView] = useState<CommandView | null>(null);
  const [feed, setFeed] = useState<FeedState>("connecting");
  const [lastPulse, setLastPulse] = useState<string>("");
  const failures = useRef(0);
  const onAgents = useRef(opts.onAgents);
  useEffect(() => { onAgents.current = opts.onAgents; }, [opts.onAgents]);

  const loadCommand = useCallback(async () => {
    try {
      const v = await adapter.command();
      // Keep events already seen (the pulse may have read newer ones than this view).
      setView((prev) => (prev ? { ...v, events: mergeEvents(prev.events, v.events) } : v));
      failures.current = 0;
      setFeed("live");
    } catch {
      failures.current++;
      setFeed("reconnecting");
    }
  }, [adapter]);

  const pulse = useCallback(async () => {
    try {
      const p = await adapter.pulse();
      setView((prev) => (prev ? { ...prev, events: mergeEvents(prev.events, p.events) } : prev));
      if (p.agents) onAgents.current?.(p.agents);
      setLastPulse(p.fetchedAt);
      failures.current = 0;
      setFeed("live");
    } catch {
      failures.current++;
      setFeed("reconnecting");
    }
  }, [adapter]);

  useEffect(() => {
    if (!opts.enabled) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, lastCommand = 0;
    const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
    const loop = async () => {
      if (stopped) return;
      if (visible()) {
        if (Date.now() - lastCommand >= COMMAND_MS) { lastCommand = Date.now(); await loadCommand(); }
        else if (opts.fast) await pulse();
      }
      if (stopped) return;
      const wait = failures.current ? BACKOFF[Math.min(failures.current - 1, BACKOFF.length - 1)] : opts.fast ? PULSE_MS : COMMAND_MS;
      timer = setTimeout(() => void loop(), wait);
    };
    timer = setTimeout(() => void loop(), 0);
    const onVisible = () => { if (visible() && !stopped) { if (timer) clearTimeout(timer); timer = setTimeout(() => void loop(), 0); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [opts.enabled, opts.fast, loadCommand, pulse]);

  return { view, feed: opts.enabled ? feed : ("idle" as FeedState), lastPulse, refresh: loadCommand };
}
