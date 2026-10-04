"use client";
/**
 * Hierarchical camera: Fleet View → Department View → Agent View. Each level frames a rectangle of the headquarters
 * from the south, looking into the cutaway; moving between levels is a smooth flight (critically damped, with a lift
 * on long moves so the camera rises over the walls rather than through them). Reduce Motion cuts instead of flying.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { DEPARTMENTS } from "../../command/departments";
import { focusRect, type Point } from "../world";
import type { Focus } from "../VirtualMap";

export function CameraRig({ focus, positionsRef, reduceMotion }: { focus: Focus; positionsRef: MutableRefObject<Map<string, Point>>; reduceMotion: boolean }) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3(0, 0, 2));
  const goalPos = useRef(new THREE.Vector3()), goalLook = useRef(new THREE.Vector3());
  const started = useRef(false);
  useFrame((_, dt) => {
    const r = focusRect(focus, positionsRef.current);
    const level = focus.level;
    const span = level === "fleet" ? Math.max(r.w * 0.8, r.d) : Math.max(r.w * 0.85, r.d * 1.2);
    // Fleet: high and steep over the whole complex. Department: into the room over its front parapet. Agent: close.
    const height = level === "fleet" ? span * 0.78 : level === "department" ? span * 0.5 + 1.5 : 3.4;
    const back = level === "fleet" ? span * 0.42 : level === "department" ? span * 0.56 : 4.2;
    const lookY = level === "agent" ? 1.0 : 0;
    goalLook.current.set(r.x, lookY, r.z + (level === "fleet" ? 3 : level === "department" ? -0.8 : 0));
    // Agent View: a raised side view from the room's open side (towards its centre, so no wall is in the way), slightly
    // ahead of the person so their face shows, high enough to look over a neighbour's head.
    if (level === "agent") {
      const room = DEPARTMENTS.find((d) => Math.abs(r.x - d.x) <= d.w / 2 && Math.abs(r.z - d.z) <= d.d / 2);
      const side = room && r.x > room.x ? -1 : 1;
      goalPos.current.set(r.x + side * 3.1, 3.0, r.z - 0.9);
    }
    else goalPos.current.set(r.x, height, r.z + back);
    if (!started.current || reduceMotion) { camera.position.copy(goalPos.current); look.current.copy(goalLook.current); started.current = true; }
    else {
      const k = 1 - Math.exp(-dt * 3.2);
      const far = camera.position.distanceTo(goalPos.current);
      const lift = Math.min(10, far * 0.25);
      const tmp = goalPos.current.clone(); tmp.y += lift * Math.min(1, far / 20);
      camera.position.lerp(tmp, k);
      look.current.lerp(goalLook.current, k);
    }
    camera.lookAt(look.current);
  });
  return null;
}
