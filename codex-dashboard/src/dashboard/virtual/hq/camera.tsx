"use client";
/**
 * Hierarchical camera: Fleet View → Department View → Agent View. Fleet and Department frame a rectangle of the
 * headquarters from the south, looking into the cutaway. Agent View is composed for the person (framing.ts): a view of
 * the face from inside the room or its open side, chosen so nobody stands in the way; anyone still on the line of sight
 * is faded (ghostsRef). The chosen angle is kept while the agent stays put, so the view does not jump.
 *
 * Moving between levels is a smooth flight (critically damped, with a lift on long moves so the camera rises over the
 * walls rather than through them). Reduce Motion cuts instead of flying.
 *
 * Fleet and Department framings FIT the actual viewport (viewfit.ts: any aspect ratio, nothing cropped). Over them the
 * user zooms and pans (HQ_NAV): wheel = zoom toward the pointer; drag (left or right button) = pan; touch: one finger
 * pans, two fingers pinch-zoom (and pan with their midpoint). Limits keep the camera on the facility. A drag or pinch
 * never selects a room or agent. Entering a room saves the Fleet framing; Back/Esc restores it; FIT shows the whole HQ.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { focusRect, type Point } from "../world";
import type { Focus } from "../VirtualMap";
import { frameAgent } from "./framing";
import { interact, shotGoal, takeShot, wantShot, type DirectorState } from "./director";
import type { CameraMode } from "../../command/prefs";
import type { TransportDirector } from "./flow";
import type { Occluder, WorkSpot } from "./world-build";
import { DEPARTMENT } from "../../command/departments";
import { applyView, clampView, FACILITY, fitBox, FLEET_PITCH, metresPerPixel, ROOM_PITCH, roomBox, zoomToward, type Framing } from "./viewfit";
import { HQ_NAV, resetNav } from "./nav-state";

const NONE: ReadonlySet<string> = new Set();

export function CameraRig({ focus, positionsRef, reduceMotion, spots, stations, ghostsRef, occluders = [], cameraMode = "off", directorRef }: {
  focus: Focus; positionsRef: MutableRefObject<Map<string, Point>>; reduceMotion: boolean;
  spots: ReadonlyMap<string, WorkSpot>; stations: ReadonlyMap<string, Point>; ghostsRef: MutableRefObject<ReadonlySet<string>>;
  /** Tall furniture the Agent View must not look through (world-build). */
  occluders?: readonly Occluder[];
  /** The event camera mode (off by default) and the handle the transport renderer offers events to. */
  cameraMode?: CameraMode; directorRef?: MutableRefObject<TransportDirector | null>;
}) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3(0, 0, 2));
  const goalPos = useRef(new THREE.Vector3()), goalLook = useRef(new THREE.Vector3());
  const started = useRef(false);
  const held = useRef<{ id: string; az: number; at: Point } | null>(null);
  // The event camera: optional, brief, interruptible. Any user input (pointer, wheel, key) or focus change cancels it.
  const director = useRef<DirectorState>({ mode: cameraMode, shot: null, lastInteraction: 0 }); // set on mount (focus effect)
  const gl = useThree((s) => s.gl);
  useEffect(() => { director.current = { ...director.current, mode: cameraMode, shot: cameraMode !== "off" ? director.current.shot : null }; }, [cameraMode]);
  useEffect(() => { director.current = interact(director.current, Date.now()); }, [focus]);
  useEffect(() => {
    const cancel = () => { director.current = interact(director.current, Date.now()); };
    const el = gl.domElement.parentElement ?? gl.domElement;
    el.addEventListener("pointerdown", cancel); el.addEventListener("wheel", cancel, { passive: true }); window.addEventListener("keydown", cancel);
    return () => { el.removeEventListener("pointerdown", cancel); el.removeEventListener("wheel", cancel); window.removeEventListener("keydown", cancel); };
  }, [gl]);
  useEffect(() => {
    if (!directorRef) return;
    directorRef.current = { offer: (t) => { if (wantShot(director.current, t, Date.now(), { focusLevel: focus.level, reduceMotion })) director.current = takeShot(director.current, t); } };
    return () => { directorRef.current = null; };
  }, [directorRef, focus.level, reduceMotion]);
  // ── User navigation: the level's fitted framing, and gestures over it ──
  const size = useThree((s) => s.size);
  const framingCache = useRef<{ key: string; f: Framing } | null>(null);
  const baseFraming = (): Framing | null => {
    if (focus.level === "agent") return null;
    const persp = camera as THREE.PerspectiveCamera, aspect = size.width / Math.max(1, size.height);
    const key = `${focus.level}:${focus.level === "department" ? focus.id : ""}:${aspect.toFixed(3)}:${persp.fov}`;
    if (framingCache.current?.key !== key) {
      const f = focus.level === "fleet" ? fitBox(FACILITY, aspect, persp.fov, FLEET_PITCH) : fitBox(roomBox(DEPARTMENT[focus.id]), aspect, persp.fov, ROOM_PITCH, 0.04);
      framingCache.current = { key, f };
    }
    return framingCache.current.f;
  };
  const baseRef = useRef(baseFraming);
  useLayoutEffect(() => { baseRef.current = baseFraming; });
  // Level changes: entering a room saves the Fleet framing; returning to the Fleet restores it.
  const prevLevel = useRef<string>("fleet");
  useEffect(() => { resetNav(); }, []);
  useEffect(() => {
    const was = prevLevel.current, now = focus.level;
    if (was === "fleet" && now !== "fleet") { HQ_NAV.saved = HQ_NAV.view; HQ_NAV.view = { zoom: 1, pan: { x: 0, z: 0 } }; }
    else if (now === "fleet") { HQ_NAV.view = HQ_NAV.saved ?? { zoom: 1, pan: { x: 0, z: 0 } }; HQ_NAV.saved = null; }
    else if (now === "department") HQ_NAV.view = { zoom: 1, pan: { x: 0, z: 0 } };
    prevLevel.current = now;
  }, [focus]);
  useEffect(() => {
    // Gestures belong to the whole HQ viewport (the canvas and the plaques/labels drawn over it).
    const el = gl.domElement, area: HTMLElement = el.closest<HTMLElement>("[data-hq-viewport]") ?? el;
    const ray = new THREE.Raycaster(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
    const groundAt = (cx: number, cy: number): Point | null => {
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -(((cy - r.top) / r.height) * 2 - 1)), camera);
      return ray.ray.intersectPlane(ground, hit) ? { x: hit.x, z: hit.z } : null;
    };
    const usable = () => focus.level !== "agent" && !!baseRef.current();
    const apply = (next: { zoom: number; pan: Point }) => {
      const b = baseRef.current(); if (!b) return;
      HQ_NAV.view = clampView(next, { x: b.look.x, z: b.look.z }); HQ_NAV.lastGesture = performance.now();
    };
    const zoomAt = (factor: number, cx: number | null, cy: number | null) => {
      const b = baseRef.current(); if (!b) return;
      apply(zoomToward(HQ_NAV.view, { x: b.look.x, z: b.look.z }, factor, cx === null || cy === null ? null : groundAt(cx, cy)));
    };
    const panBy = (dx: number, dy: number) => {
      const b = baseRef.current(); if (!b) return;
      const persp = camera as THREE.PerspectiveCamera, m = metresPerPixel(b.distance * HQ_NAV.view.zoom, persp.fov, el.clientHeight);
      const pitch = focus.level === "fleet" ? FLEET_PITCH : ROOM_PITCH;
      apply({ zoom: HQ_NAV.view.zoom, pan: { x: HQ_NAV.view.pan.x - dx * m, z: HQ_NAV.view.pan.z - (dy * m) / Math.max(0.3, Math.sin(pitch)) } });
    };
    const onWheel = (e: WheelEvent) => {
      if (!usable()) return;
      e.preventDefault(); // the HQ owns the wheel inside its viewport (the page scrolls elsewhere)
      zoomAt(Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.004), e.clientX, e.clientY);
    };
    // Pointers: one = pan (after a small threshold, so a tap/click still selects); two (touch) = pinch-zoom + pan.
    const pts = new Map<number, { x: number; y: number }>();
    let moved = 0, pinch = 0;
    const onDown = (e: PointerEvent) => {
      if (!usable() || (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId); if (!prev || !usable()) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      if (pts.size === 1) {
        moved += Math.hypot(dx, dy);
        if (moved > 6) { panBy(dx, dy); HQ_NAV.suppressClickUntil = Date.now() + 350; }
      } else if (pts.size === 2) {
        const before = [...pts.values()], mid0 = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (pinch > 0 && d > 0) zoomAt(pinch / d, mid.x, mid.y);
        panBy((mid.x - mid0.x) / 2, (mid.y - mid0.y) / 2);
        pinch = d; HQ_NAV.suppressClickUntil = Date.now() + 500;
        return;
      }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    };
    const onUp = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; };
    const onMenu = (e: MouseEvent) => { if (usable()) e.preventDefault(); }; // right-drag pans
    area.addEventListener("wheel", onWheel, { passive: false });
    area.addEventListener("pointerdown", onDown); window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); window.addEventListener("pointercancel", onUp);
    area.addEventListener("contextmenu", onMenu);
    return () => {
      area.removeEventListener("wheel", onWheel); area.removeEventListener("pointerdown", onDown); window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onUp); area.removeEventListener("contextmenu", onMenu);
    };
  }, [gl, camera, focus]);

  useFrame((_, dt) => {
    const level = focus.level;
    // On-screen controls: [−] [+] zoom about the view's centre; FIT restores the whole facility (the rig's owner has
    // already returned the focus to the Fleet).
    while (HQ_NAV.commands.length) {
      const c = HQ_NAV.commands.shift()!, b = baseRef.current();
      if (c.kind === "fit") { HQ_NAV.view = { zoom: 1, pan: { x: 0, z: 0 } }; HQ_NAV.saved = null; }
      else if (b) HQ_NAV.view = clampView(zoomToward(HQ_NAV.view, { x: b.look.x, z: b.look.z }, c.factor, null), { x: b.look.x, z: b.look.z });
      HQ_NAV.lastGesture = performance.now();
    }
    if (level === "agent" && positionsRef.current.get(focus.id)) {
      const id = focus.id, p = positionsRef.current.get(id)!, spot = spots.get(id), st = stations.get(id);
      const atStation = !!st && Math.hypot(st.x - p.x, st.z - p.z) < 0.1;
      const yaw = spot ? spot.yaw : Math.PI, seated = atStation || spot?.pose === "seat";
      // Keep the chosen angle while the agent is where it was; recompose when it moves or a new agent is selected.
      const h = held.current, keep = h && h.id === id && Math.hypot(h.at.x - p.x, h.at.z - p.z) < 0.3 ? h.az : undefined;
      const f = frameAgent(id, p, yaw, seated, positionsRef.current, keep, occluders);
      held.current = { id, az: f.azimuth, at: { x: p.x, z: p.z } };
      ghostsRef.current = new Set(f.ghosts);
      goalPos.current.set(f.cam.x, f.cam.y, f.cam.z); goalLook.current.set(f.look.x, f.look.y, f.look.z);
    } else {
      held.current = null;
      if (ghostsRef.current.size) ghostsRef.current = NONE;
      const b = baseFraming();
      if (b) { const v = applyView(b, HQ_NAV.view); goalLook.current.copy(v.look); goalPos.current.copy(v.pos); }
      else {
        const r = focusRect(focus, positionsRef.current);
        goalLook.current.set(r.x, 0.8, r.z); goalPos.current.set(r.x, 12, r.z + 8);
      }
    }
    // An event shot (if one is running) frames the event instead of the user's level; it ends by itself or on any input.
    const rc = director.current.shot?.transport.counterpartId, shot = level !== "agent" ? shotGoal(director.current, Date.now(), rc ? positionsRef.current.get(rc) : null) : null;
    if (shot) { goalPos.current.set(shot.pos.x, shot.pos.y, shot.pos.z); goalLook.current.set(shot.look.x, shot.look.y, shot.look.z); }
    if (!started.current || reduceMotion) { camera.position.copy(goalPos.current); look.current.copy(goalLook.current); started.current = true; }
    else {
      // While the user drives (wheel, drag, pinch, controls) the camera follows briskly and without the flight's lift.
      const driving = performance.now() - HQ_NAV.lastGesture < 400;
      const k = 1 - Math.exp(-dt * (driving ? 12 : 3.0));
      const far = camera.position.distanceTo(goalPos.current);
      const lift = driving ? 0 : Math.min(10, far * 0.25);
      const tmp = goalPos.current.clone(); tmp.y += lift * Math.min(1, far / 20);
      camera.position.lerp(tmp, k);
      look.current.lerp(goalLook.current, k);
      // Arrived: settle exactly (no endless sub-millimetre easing that keeps view-dependent passes re-rendering).
      if (camera.position.distanceTo(goalPos.current) < 0.01 && look.current.distanceTo(goalLook.current) < 0.01) { camera.position.copy(goalPos.current); look.current.copy(goalLook.current); }
    }
    camera.lookAt(look.current);
  });
  return null;
}
