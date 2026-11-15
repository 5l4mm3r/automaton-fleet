"use client";
/**
 * Owner diagnostics (Display → Diagnostics overlay; off by default). For real-browser performance sign-off: what this
 * browser and GPU are, what the scene is doing, and how fast. Facts about the viewer's own device and the scene only:
 * no Fleet secrets, credentials or identities. The probe samples inside the render loop; the overlay repaints twice a
 * second.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { governorLabel } from "./governor";

export interface DiagStats {
  browser: string; renderer: string; webgl: string; dpr: number; quality: string; shadows: string;
  frameMs: number; fps: number; agents: number; transports: number; queued: number; dropped: number; heapMb: number | null; governor: string;
}
export const emptyDiag = (): DiagStats => ({ browser: "", renderer: "", webgl: "", dpr: 1, quality: "", shadows: "", frameMs: 0, fps: 0, agents: 0, transports: 0, queued: 0, dropped: 0, heapMb: null, governor: "" });

/** Inside the canvas: renderer facts once, frame timing every frame (an exponential average). */
export function DiagProbe({ statsRef, quality, shadows, agents }: { statsRef: MutableRefObject<DiagStats>; quality: string; shadows: string; agents: number }) {
  const gl = useThree((s) => s.gl);
  const last = useRef(0);
  useEffect(() => {
    const s = statsRef.current, ctx = gl.getContext();
    const ext = ctx.getExtension("WEBGL_debug_renderer_info");
    s.renderer = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
    s.webgl = gl.capabilities.isWebGL2 ? "WebGL 2" : "WebGL 1";
    const ua = navigator.userAgent, m = /(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/.exec(ua);
    s.browser = m ? `${m[1] === "Edg" ? "Edge" : m[1] === "OPR" ? "Opera" : m[1]} ${m[2]}` : "unknown";
  }, [gl, statsRef]);
  useFrame(() => {
    const s = statsRef.current, now = performance.now();
    if (last.current) { const dt = now - last.current; s.frameMs = s.frameMs ? s.frameMs * 0.92 + dt * 0.08 : dt; s.fps = 1000 / s.frameMs; }
    last.current = now;
    s.dpr = gl.getPixelRatio(); s.governor = governorLabel(s.dpr); s.quality = quality; s.shadows = shadows; s.agents = agents;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    s.heapMb = mem ? mem.usedJSHeapSize / 1048576 : null;
  });
  return null;
}

/** Outside the canvas: the overlay text. */
export function DiagOverlay({ statsRef }: { statsRef: MutableRefObject<DiagStats> }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const id = setInterval(() => {
      const s = statsRef.current;
      setText([`${s.browser} · ${s.webgl}`, s.renderer, `quality ${s.quality} · shadows ${s.shadows} · DPR ${s.dpr.toFixed(2)}${s.governor ? ` · governor ${s.governor}` : ""}`,
        `${s.fps.toFixed(1)} fps · ${s.frameMs.toFixed(1)} ms`, `agents ${s.agents} · transports ${s.transports} active, ${s.queued} queued, ${s.dropped} not animated`,
        s.heapMb === null ? "heap n/a" : `heap ${s.heapMb.toFixed(0)} MB`].join("\n"));
    }, 500);
    return () => clearInterval(id);
  }, [statsRef]);
  return <pre aria-label="Diagnostics" className="pointer-events-none absolute bottom-2 right-2 z-10 max-w-[60%] whitespace-pre-wrap rounded border border-cyan-900 bg-slate-950/85 p-2 font-mono text-[11px] leading-4 text-cyan-200">{text}</pre>;
}
