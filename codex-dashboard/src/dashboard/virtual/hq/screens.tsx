"use client";
/**
 * The headquarters' live screens and signs. Every number on a screen is FleetController's (HQData, derived from the
 * snapshot and the command view); nothing is invented — a figure the gateway does not supply reads "—". High and Ultra
 * animate a scan line and a soft refresh; Low and Medium draw the same content statically.
 */
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { DEPARTMENT, type DepartmentId } from "../../command/departments";
import type { ScreenSpot } from "./world-build";
import type { HQProfile } from "./quality";

/** Authoritative figures per department, as short display lines (computed by the Command Centre from real data). */
export type HQData = Partial<Record<DepartmentId, Array<[string, string]>>>;

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, spot: ScreenSpot, data: HQData, scan: number) {
  const d = DEPARTMENT[spot.dep];
  ctx.fillStyle = "#020812"; ctx.fillRect(0, 0, w, h);
  if (spot.kind === "sign") {
    ctx.fillStyle = "#06101c"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = d.accent; ctx.fillRect(0, h - 4, w, 4);
    ctx.font = `bold ${Math.round(h * 0.55)}px ui-monospace, monospace`; ctx.textBaseline = "middle"; ctx.fillStyle = "#e2e8f0";
    ctx.fillText(d.name.toUpperCase(), h * 0.4, h * 0.48);
    return;
  }
  // Frame, header, rows of real figures.
  ctx.strokeStyle = d.accent; ctx.globalAlpha = 0.5; ctx.lineWidth = 3; ctx.strokeRect(4, 4, w - 8, h - 8); ctx.globalAlpha = 1;
  const pad = w * 0.05, rowH = Math.min(h * 0.17, w * 0.06);
  ctx.font = `bold ${Math.round(rowH * 0.62)}px ui-monospace, monospace`; ctx.fillStyle = d.accent; ctx.textBaseline = "top";
  ctx.fillText(d.name.toUpperCase(), pad, pad * 0.8);
  const rows = data[spot.dep] ?? [["DATA", "—"]];
  ctx.font = `${Math.round(rowH * 0.5)}px ui-monospace, monospace`;
  rows.slice(0, Math.floor((h - pad * 2 - rowH) / rowH)).forEach(([k, v], i) => {
    const y = pad * 0.8 + rowH * (1.25 + i);
    ctx.fillStyle = "#64748b"; ctx.fillText(k.toUpperCase(), pad, y);
    ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "right"; ctx.fillText(v, w - pad, y); ctx.textAlign = "left";
    ctx.fillStyle = "rgba(148,163,184,0.12)"; ctx.fillRect(pad, y + rowH * 0.78, w - pad * 2, 1);
  });
  if (scan >= 0) { const y = (scan % 1) * h; const grd = ctx.createLinearGradient(0, y - 20, 0, y + 20); grd.addColorStop(0, "rgba(34,211,238,0)"); grd.addColorStop(0.5, "rgba(34,211,238,0.10)"); grd.addColorStop(1, "rgba(34,211,238,0)"); ctx.fillStyle = grd; ctx.fillRect(0, y - 20, w, 40); }
}

const Screen = memo(function Screen({ spot, data, q }: { spot: ScreenSpot; data: HQData; q: HQProfile }) {
  const px = spot.kind === "sign" ? 64 : Math.round(Math.min(1024, (q.textures || 256) * 1.0));
  const w = spot.kind === "sign" ? Math.round(px * spot.w / spot.h) : px, h = spot.kind === "sign" ? px : Math.round(px * spot.h / spot.w);
  const { canvas, tex } = useMemo(() => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return { canvas: c, tex: t };
  }, [w, h]);
  useEffect(() => () => tex.dispose(), [tex]);
  const ctx = useMemo(() => canvas.getContext("2d")!, [canvas]);
  useEffect(() => { draw(ctx, w, h, spot, data, -1); tex.needsUpdate = true; }, [ctx, w, h, spot, data, tex]);
  const last = useRef(0);
  useFrame(({ clock }) => {
    if (!q.animatedScreens || spot.kind === "sign") return;
    if (clock.elapsedTime - last.current < 0.25) return; // 4 redraws a second
    last.current = clock.elapsedTime;
    draw(ctx, w, h, spot, data, clock.elapsedTime * 0.25); tex.needsUpdate = true;
  });
  return <mesh position={[spot.x, spot.y, spot.z]} rotation={[0, spot.ry, 0]}>
    <planeGeometry args={[spot.w, spot.h]} />
    <meshBasicMaterial map={tex} toneMapped={false} />
  </mesh>;
});

export const Screens = memo(function Screens({ spots, data, q }: { spots: ScreenSpot[]; data: HQData; q: HQProfile }) {
  return <>{spots.map((s) => <Screen key={s.id} spot={s} data={data} q={q} />)}</>;
});
