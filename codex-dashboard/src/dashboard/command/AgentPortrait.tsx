/**
 * The operative portrait and its health tag — used by the Formal Agents list, agent profiles, Fleet Command and the
 * Virtual Command Centre, so the condition an agent shows is the same everywhere (one band from economics.ts).
 */
import { memo, useMemo } from "react";
import { BAND_TEXT, type AgentHealth, type HealthBand } from "./economics";
import { BAND_FRAME, PORTRAIT_SIZE, portraitPaths } from "./portrait";

export const AgentPortrait = memo(function AgentPortrait({ id, name, band, size = 48 }: { id: string; name: string; band: HealthBand; size?: number }) {
  const paths = useMemo(() => portraitPaths(id, band), [id, band]);
  const S = PORTRAIT_SIZE;
  return <svg viewBox={`-1 -1 ${S + 2} ${S + 2}`} width={size} height={size} shapeRendering="crispEdges" role="img" data-band={band}
    aria-label={`${name} portrait, ${band === "WINNING" ? "profitable" : band.toLowerCase()}`}
    className={band === "UNKNOWN" ? "opacity-70" : undefined}>
    <rect x={-1} y={-1} width={S + 2} height={S + 2} fill="#020617" />
    <rect x={-0.5} y={-0.5} width={S + 1} height={S + 1} fill="none" stroke={BAND_FRAME[band]} strokeWidth={1} />
    {paths.map((p) => <path key={p.fill} fill={p.fill} d={p.d} />)}
  </svg>;
});

/** The text that always accompanies a portrait (state never shown by colour or image alone). */
export function HealthTag({ health }: { health: AgentHealth }) {
  return <span className={`font-mono text-xs tracking-widest ${BAND_TEXT[health.band]}`} title={health.reasons.join(" ")}>
    {health.label}{health.pct !== null ? ` · ${health.pct}%` : ""}
  </span>;
}
