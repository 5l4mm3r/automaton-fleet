"use client";
/**
 * The headquarters' live screens, boards, signs and the Treasury banner. Every figure and item is FleetController's
 * (HQData / HQBoards / TreasuryBanner, derived from the snapshot and the command view); nothing is invented — a figure
 * the gateway does not supply reads "—", an empty list says it is empty.
 *
 * Motion is presentation only: High and Ultra animate a scan line, the banner's breakdown ticker and a short slide when
 * the Treasury figure really changes (between two real values; no invented intermediate amounts). Low, Medium and
 * Reduce Motion draw the same content statically.
 */
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { DEPARTMENT, type DepartmentId } from "../../command/departments";
import type { ScreenSpot } from "./world-build";
import type { HQProfile } from "./quality";
import type { BoardTone, HQBoards, TreasuryBanner } from "./data";

/** Authoritative figures per department, as short display lines (computed by the Command Centre from real data). */
export type HQData = Partial<Record<DepartmentId, Array<[string, string]>>>;

export interface ScreenFeed { data: HQData; boards: HQBoards; banner: TreasuryBanner }

const FONT = "ui-monospace, 'SFMono-Regular', Menlo, monospace";
const TONE: Record<string, string> = { ok: "#34d399", warn: "#fbbf24", bad: "#f87171", muted: "#64748b" };
const GOLD = "#f5c451", GOLD_DIM = "#8a6a2a";

function frame(ctx: CanvasRenderingContext2D, w: number, h: number, accent: string) {
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#071322"); g.addColorStop(1, "#02070f");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = accent; ctx.globalAlpha = 0.45; ctx.lineWidth = Math.max(2, w / 320); ctx.strokeRect(4, 4, w - 8, h - 8); ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(148,163,184,0.05)"; for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
}

function scanline(ctx: CanvasRenderingContext2D, w: number, h: number, scan: number) {
  if (scan < 0) return;
  const y = (scan % 1) * h, grd = ctx.createLinearGradient(0, y - 24, 0, y + 24);
  grd.addColorStop(0, "rgba(34,211,238,0)"); grd.addColorStop(0.5, "rgba(34,211,238,0.08)"); grd.addColorStop(1, "rgba(34,211,238,0)");
  ctx.fillStyle = grd; ctx.fillRect(0, y - 24, w, 48);
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text; while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function drawStatus(ctx: CanvasRenderingContext2D, w: number, h: number, spot: ScreenSpot, feed: ScreenFeed, scan: number) {
  const d = DEPARTMENT[spot.dep];
  frame(ctx, w, h, d.accent);
  const pad = w * 0.05, rowH = Math.min(h * 0.17, w * 0.06);
  ctx.font = `bold ${Math.round(rowH * 0.62)}px ${FONT}`; ctx.fillStyle = d.accent; ctx.textBaseline = "top";
  ctx.fillText(d.name.toUpperCase(), pad, pad * 0.8);
  const rows = feed.data[spot.dep] ?? [["DATA", "—"]];
  ctx.font = `${Math.round(rowH * 0.5)}px ${FONT}`;
  rows.slice(0, Math.floor((h - pad * 2 - rowH) / rowH)).forEach(([k, v], i) => {
    const y = pad * 0.8 + rowH * (1.25 + i);
    ctx.fillStyle = "#64748b"; ctx.fillText(k.toUpperCase(), pad, y);
    ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "right"; ctx.fillText(v, w - pad, y); ctx.textAlign = "left";
    ctx.fillStyle = "rgba(148,163,184,0.12)"; ctx.fillRect(pad, y + rowH * 0.78, w - pad * 2, 1);
  });
  scanline(ctx, w, h, scan);
}

function drawBoard(ctx: CanvasRenderingContext2D, w: number, h: number, spot: ScreenSpot, feed: ScreenFeed, scan: number) {
  const d = DEPARTMENT[spot.dep], board = feed.boards[spot.board ?? ""];
  frame(ctx, w, h, d.accent);
  const pad = Math.round(w * 0.04), rowH = Math.max(18, Math.min(h / 7.5, w / 18));
  ctx.textBaseline = "top"; ctx.font = `bold ${Math.round(rowH * 0.6)}px ${FONT}`; ctx.fillStyle = d.accent;
  ctx.fillText(fit(ctx, (board?.title ?? "—").toUpperCase(), w - pad * 2), pad, pad * 0.7);
  ctx.fillStyle = d.accent; ctx.globalAlpha = 0.35; ctx.fillRect(pad, pad * 0.7 + rowH * 0.85, w - pad * 2, 2); ctx.globalAlpha = 1;
  const rows = board?.rows ?? [], max = Math.max(1, Math.floor((h - pad * 1.5 - rowH * 1.2) / rowH));
  ctx.font = `${Math.round(rowH * 0.5)}px ${FONT}`;
  if (!rows.length) { ctx.fillStyle = "#64748b"; ctx.fillText(fit(ctx, board?.empty || "—", w - pad * 2), pad, pad * 0.7 + rowH * 1.3); }
  rows.slice(0, max).forEach(([k, v, tone]: [string, string, BoardTone?], i) => {
    const y = pad * 0.7 + rowH * (1.3 + i);
    const c = tone ? TONE[tone] : "#e2e8f0";
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(pad + rowH * 0.18, y + rowH * 0.28, rowH * 0.11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#cbd5e1"; ctx.fillText(fit(ctx, k, w * 0.66 - pad), pad + rowH * 0.45, y);
    ctx.fillStyle = c; ctx.textAlign = "right"; ctx.fillText(fit(ctx, v, w * 0.3), w - pad, y); ctx.textAlign = "left";
  });
  if (rows.length > max) { ctx.fillStyle = "#64748b"; ctx.textAlign = "right"; ctx.fillText(`+${rows.length - max} more`, w - pad, h - pad - rowH * 0.5); ctx.textAlign = "left"; }
  scanline(ctx, w, h, scan);
}

function drawSign(ctx: CanvasRenderingContext2D, w: number, h: number, spot: ScreenSpot) {
  const d = DEPARTMENT[spot.dep];
  ctx.fillStyle = "#06101c"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = d.accent; ctx.fillRect(0, h - 4, w, 4);
  ctx.font = `bold ${Math.round(h * 0.55)}px ${FONT}`; ctx.textBaseline = "middle"; ctx.fillStyle = "#e2e8f0";
  ctx.fillText(d.name.toUpperCase(), h * 0.4, h * 0.48);
}

/**
 * The Treasury banner: FLEET TREASURY and the authoritative cash, large; the real breakdowns on a slow ticker below.
 * `change` (0..1) slides the previous real figure out and the new one in after a real change.
 */
function drawBanner(ctx: CanvasRenderingContext2D, w: number, h: number, banner: TreasuryBanner, prev: string | null, change: number, ticker: number) {
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#120d04"); g.addColorStop(0.6, "#07060a"); g.addColorStop(1, "#030305");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = GOLD_DIM; ctx.lineWidth = 4; ctx.strokeRect(6, 6, w - 12, h - 12);
  ctx.fillStyle = "rgba(245,196,81,0.05)"; for (let x = 0; x < w; x += 6) ctx.fillRect(x, 0, 1, h); // LED pitch
  const tickerH = h * 0.2, main = h - tickerH;
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(main * 0.17)}px ${FONT}`; ctx.fillStyle = GOLD; ctx.globalAlpha = 0.85;
  ctx.fillText("FLEET TREASURY", w * 0.04, main * 0.24); ctx.globalAlpha = 1;
  ctx.font = `bold ${Math.round(main * 0.5)}px ${FONT}`;
  ctx.save(); ctx.beginPath(); ctx.rect(0, main * 0.38, w, main * 0.6); ctx.clip();
  const y = main * 0.68, shift = main * 0.6;
  if (prev !== null && change < 1) {
    const k = change * change * (3 - 2 * change);
    ctx.fillStyle = "#f8e7b0"; ctx.globalAlpha = 1 - k; ctx.fillText(prev, w * 0.04, y - shift * k);
    ctx.globalAlpha = k; ctx.fillStyle = "#fff4cf"; ctx.fillText(banner.cash, w * 0.04, y + shift * (1 - k)); ctx.globalAlpha = 1;
  } else { ctx.fillStyle = "#fff1c2"; ctx.fillText(banner.cash, w * 0.04, y); }
  ctx.restore();
  // The breakdown ticker (static when `ticker` < 0).
  ctx.fillStyle = "rgba(245,196,81,0.12)"; ctx.fillRect(0, main, w, 2);
  ctx.font = `${Math.round(tickerH * 0.42)}px ${FONT}`;
  const items = banner.secondary.map(([k, v]) => `${k.toUpperCase()}  ${v}`), sep = "     ◆     ", line = items.join(sep) + sep;
  const lw = ctx.measureText(line).width;
  ctx.save(); ctx.beginPath(); ctx.rect(8, main + 2, w - 16, tickerH - 8); ctx.clip();
  ctx.fillStyle = "#d9b25a";
  const ty = main + tickerH * 0.5;
  if (ticker < 0) ctx.fillText(fit(ctx, items.join("   ·   "), w - 32), 16, ty);
  else { const off = -((ticker * 60) % lw); for (let x = off; x < w; x += lw) ctx.fillText(line, x + 16, ty); }
  ctx.restore();
}

const Screen = memo(function Screen({ spot, feed, q, reduceMotion }: { spot: ScreenSpot; feed: ScreenFeed; q: HQProfile; reduceMotion: boolean }) {
  const sign = spot.kind === "sign", banner = spot.kind === "banner";
  const px = sign ? 64 : banner ? (q.textures >= 1024 ? 1536 : q.textures >= 512 ? 1024 : 768) : Math.round(Math.min(1024, Math.max(384, (q.textures || 256) * (spot.w > 2.5 ? 1.5 : 1))));
  const w = sign ? Math.round(px * spot.w / spot.h) : px, h = sign ? px : Math.round(px * spot.h / spot.w);
  const { canvas, tex } = useMemo(() => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return { canvas: c, tex: t };
  }, [w, h]);
  useEffect(() => () => tex.dispose(), [tex]);
  const ctx = useMemo(() => canvas.getContext("2d")!, [canvas]);
  const animate = q.animatedScreens && !reduceMotion;
  // The Treasury figure's real changes: remember the previous real value and when it changed.
  const bannerState = useRef<{ shown: string | null; prev: string | null; at: number }>({ shown: null, prev: null, at: 0 });
  useEffect(() => {
    if (!banner) return;
    const s = bannerState.current;
    if (s.shown !== null && s.shown !== feed.banner.cash) { s.prev = s.shown; s.at = performance.now(); }
    s.shown = feed.banner.cash;
  }, [banner, feed.banner.cash]);
  const paint = (t: number) => {
    if (sign) drawSign(ctx, w, h, spot);
    else if (banner) {
      const s = bannerState.current, k = animate && s.prev !== null ? Math.min(1, (performance.now() - s.at) / 1400) : 1;
      drawBanner(ctx, w, h, feed.banner, s.prev, k, animate ? t : -1);
    } else if (spot.kind === "board") drawBoard(ctx, w, h, spot, feed, animate ? t * 0.2 : -1);
    else drawStatus(ctx, w, h, spot, feed, animate ? t * 0.25 : -1);
    tex.needsUpdate = true;
  };
  useEffect(() => { paint(-1); }); // every render (new data) repaints once
  const last = useRef(0);
  useFrame(({ clock }) => {
    if (!animate || sign) return;
    const fps = banner ? 12 : 4;
    if (clock.elapsedTime - last.current < 1 / fps) return;
    last.current = clock.elapsedTime;
    paint(clock.elapsedTime);
  });
  return <mesh position={[spot.x, spot.y, spot.z]} rotation={[spot.rx ?? 0, spot.ry, 0]}>
    <planeGeometry args={[spot.w, spot.h]} />
    <meshBasicMaterial map={tex} toneMapped={false} />
  </mesh>;
});

export const Screens = memo(function Screens({ spots, feed, q, reduceMotion }: { spots: ScreenSpot[]; feed: ScreenFeed; q: HQProfile; reduceMotion: boolean }) {
  return <>{spots.map((s) => <Screen key={s.id} spot={s} feed={feed} q={q} reduceMotion={reduceMotion} />)}</>;
});
