/**
 * The operative portrait and its health tag — used by the Formal Agents list, agent profiles, Fleet Command and the
 * Virtual Command Centre, so the condition an agent shows is the same everywhere (one band from economics.ts).
 * Portraits are 128×128 painted bitmaps (portrait.ts); compact places show them at 64 px or less, profiles at 128 px.
 */
import { memo, useEffect, useState } from "react";
import { BAND_TEXT, type AgentHealth, type HealthBand } from "./economics";
import { BAND_FRAME, cachedPortrait, requestPortrait } from "./portrait";

/** The portrait's data URL: immediately when already painted, otherwise once an idle slice has painted it. */
export function usePortraitUrl(id: string, band: HealthBand): string | null {
  const [state, setState] = useState<{ key: string; url: string | null }>(() => ({ key: `${id}|${band}`, url: cachedPortrait(id, band) }));
  const key = `${id}|${band}`;
  useEffect(() => requestPortrait(id, band, (url) => setState({ key: `${id}|${band}`, url })), [id, band]);
  return state.key === key ? state.url : cachedPortrait(id, band);
}

export const AgentPortrait = memo(function AgentPortrait({ id, name, band, size = 48 }: { id: string; name: string; band: HealthBand; size?: number }) {
  const url = usePortraitUrl(id, band);
  const label = `${name} portrait, ${band === "WINNING" ? "profitable" : band.toLowerCase()}`;
  const frame = `rounded-sm border-2 ${FRAME_CLASS[band]} ${band === "UNKNOWN" ? "opacity-70" : ""}`;
  // Until painted: an empty frame of the same size (the state is always also in text next to it).
  // A plain <img>: a static export with a data: URL (next/image adds nothing here).
  return url
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={url} width={size} height={size} alt={label} role="img" data-band={band} className={`${frame} bg-slate-950`} />
    : <span role="img" aria-label={label} data-band={band} className={`inline-block bg-slate-950 ${frame} ${SIZE_CLASS(size)}`} />;
});

/** Tailwind classes for the band frame (BAND_FRAME colours; no inline styles under the CSP). */
const FRAME_CLASS: Readonly<Record<HealthBand, string>> = {
  HEALTHY: "border-[#22d3ee]", WINNING: "border-[#34d399]", WOUNDED: "border-[#f59e0b]", CRITICAL: "border-[#ef4444]", DEAD: "border-[#475569]", UNKNOWN: "border-[#64748b]",
};
void BAND_FRAME;
const SIZE_CLASS = (n: number) => (n >= 128 ? "h-32 w-32" : n >= 96 ? "h-24 w-24" : n >= 64 ? "h-16 w-16" : n >= 48 ? "h-12 w-12" : n >= 40 ? "h-10 w-10" : n >= 32 ? "h-8 w-8" : "h-6 w-6");

/** The text that always accompanies a portrait (state never shown by colour or image alone). */
export function HealthTag({ health }: { health: AgentHealth }) {
  return <span className={`font-mono text-xs tracking-widest ${BAND_TEXT[health.band]}`} title={health.reasons.join(" ")}>
    {health.label}{health.pct !== null ? ` · ${health.pct}%` : ""}
  </span>;
}
