"use client";
/**
 * Hierarchical camera: Fleet View → Department View → Agent View. Fleet and Department frame a rectangle of the
 * headquarters from the south, looking into the cutaway. Agent View is composed for the person (framing.ts): a view of
 * the face from inside the room or its open side, chosen so nobody stands in the way; anyone still on the line of sight
 * is faded (ghostsRef). The chosen angle is kept while the agent stays put, so the view does not jump.
 *
 * Moving between levels is a smooth flight (critically damped, with a lift on long moves so the camera rises over the
 * walls rather than through them). Reduce Motion cuts instead of flying.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { focusRect, type Point } from "../world";
import type { Focus } from "../VirtualMap";
import { frameAgent } from "./framing";
import { interact, shotGoal, takeShot, wantShot, type DirectorState } from "./director";
import type { CameraMode } from "../../command/prefs";
import type { TransportDirector } from "./flow";
import type { Occluder, WorkSpot } from "./world-build";

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
  useFrame((_, dt) => {
    const level = focus.level;
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
      const r = focusRect(focus, positionsRef.current);
      const span = level === "fleet" ? Math.max(r.w * 0.8, r.d) : Math.max(r.w * 0.95, r.d * 1.25);
      const height = level === "fleet" ? span * 0.78 : span * 0.52 + 1.5, back = level === "fleet" ? span * 0.42 : span * 0.6;
      goalLook.current.set(r.x, level === "fleet" ? 0 : 0.8, r.z + (level === "fleet" ? 3 : -1.6));
      goalPos.current.set(r.x, height, r.z + back);
    }
    // An event shot (if one is running) frames the event instead of the user's level; it ends by itself or on any input.
    const rc = director.current.shot?.transport.counterpartId, shot = level !== "agent" ? shotGoal(director.current, Date.now(), rc ? positionsRef.current.get(rc) : null) : null;
    if (shot) { goalPos.current.set(shot.pos.x, shot.pos.y, shot.pos.z); goalLook.current.set(shot.look.x, shot.look.y, shot.look.z); }
    if (!started.current || reduceMotion) { camera.position.copy(goalPos.current); look.current.copy(goalLook.current); started.current = true; }
    else {
      const k = 1 - Math.exp(-dt * 3.0);
      const far = camera.position.distanceTo(goalPos.current);
      const lift = Math.min(10, far * 0.25);
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
