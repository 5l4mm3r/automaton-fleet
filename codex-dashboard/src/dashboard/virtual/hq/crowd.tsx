"use client";
/**
 * The operators (v3): adult technical-operations staff, about 1.78 m, one per agent. Dark technical uniform with a
 * fitted vest and harness, restrained cyan Fleet piping, a belt, shoulder patches and a role insignia in the colour of
 * the room the agent works in. The FACE is the agent's own painted portrait (portrait.ts) mapped onto the front of the
 * head through a shared face atlas — the 3D person and the portrait are literally the same face, in the same condition;
 * skin, hair style and colour, beard and build come from the same identity.
 *
 * Animation states come from the agent's real state and position, never from decoration (choreo.ts): standing up and
 *   walking (brisk on long moves) along nav-grid paths to the spot its FleetController state puts it · typing, reading
 *   or seated idle at a desk · operating, reading or inspecting at a console · meeting (seated, standing, pointing at
 *   the shared table) with teammates · watching a crowded room's displays · waiting · lying when dead — and reactions to
 *   the agent's own recorded events (confirm as it sends, complete on a delivery, look up as something arrives). Agents
 *   with nothing recent never mime work. Poses blend; Reduce Motion snaps positions and stills the motion.
 *
 * Rendering: each body part is ONE instanced mesh for the whole crowd (≈40 draw calls for 50 people); a reusable rig
 * of joints poses each agent in turn and writes the part matrices. Agents the camera reports as standing between it
 * and the selected agent are faded out of the way (ghostsRef) and come back when the view changes.
 */
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import type { AgentModel } from "../../command/agents";
import { DEPARTMENT } from "../../command/departments";
import { identityColours, portraitFigure, portraitPixels, PORTRAIT_SIZE, seedOf } from "../../command/portrait";
import { pathLength } from "./route";
import { findPath, walkable, type NavGrid } from "./nav";
import { chooseActivity, giveWay, reactionAt, type Activity, type Reaction } from "./choreo";
import { appearanceOf } from "./appearance";
import { birthState, type Point } from "../world";
import type { HQProfile } from "./quality";
import type { WorkSpot } from "./world-build";
import { bakeShade } from "./builder";

type Pose = { hipY: number; lean: number; head: number; headYaw: number; sh: [number, number]; shRoll: [number, number]; el: [number, number]; th: [number, number]; kn: [number, number]; lying: number };
const POSE_KEYS = ["hipY", "lean", "head", "headYaw", "lying"] as const;

export type { Activity } from "./choreo";

/**
 * Per person: where it is, its pose, and its current move. A move goes PLAN (path requested; the person stands up
 * from its seat meanwhile) → DEPART (after the stand-up) → WALK (the nav path) → ARRIVE (slows, turns to the work,
 * sits or starts work).
 */
interface AgentState { pos: Point; yaw: number; phase: number; pose: Pose; activity: Activity; ghost: number; goal: Point | null; path: Point[]; speed: number; fast: boolean;
  /** Waiting for a path (and/or the stand-up) before leaving: the time it may leave (ms). */
  departAt: number; planned: boolean }

const zero = (): Pose => ({ hipY: 0.95, lean: 0, head: 0, headYaw: 0, sh: [0.02, 0.02], shRoll: [0.1, -0.1], el: [0.18, 0.18], th: [0, 0], kn: [0.04, 0.04], lying: 0 });

/** The target pose for an activity at time t (seconds); `i` desynchronises agents. */
function targetPose(a: Activity, t: number, phase: number, i: number, still: boolean): Pose {
  const p = zero(), s = still ? 0 : 1;
  switch (a) {
    case "walk": case "fastWalk": {
      const w = Math.sin(phase), amp = a === "fastWalk" ? 1.25 : 1;
      p.th = [-w * 0.5 * amp, w * 0.5 * amp]; p.kn = [0.1 + Math.max(0, Math.sin(phase + 1.3)) * 0.85 * amp, 0.1 + Math.max(0, Math.sin(phase + 1.3 + Math.PI)) * 0.85 * amp];
      p.sh = [w * 0.38 * amp, -w * 0.38 * amp]; p.el = [0.35, 0.35]; p.hipY = 0.95 + Math.abs(Math.cos(phase)) * 0.02; p.lean = a === "fastWalk" ? 0.09 : 0.04; break;
    }
    case "idle": {
      // Weight shifts and looking around, desynchronised per person (slow cycles; still under Reduce Motion).
      const shift = Math.sin(t * 0.21 + i * 1.9) * s, look = Math.sin(t * 0.13 + i * 2.7) > 0.6 ? 1 : 0;
      p.sh = [0.04 + Math.sin(t * 1.3 + i) * 0.015 * s, 0.04 - Math.sin(t * 1.3 + i) * 0.015 * s]; p.el = [0.25, 0.25 + Math.max(0, shift) * 0.5];
      p.headYaw = (Math.sin(t * 0.35 + i) * 0.22 + look * 0.5 * Math.sign(Math.sin(i * 3.1))) * s; p.hipY = 0.95 + Math.sin(t * 1.6 + i) * 0.004 * s;
      p.th = [shift * 0.04, -shift * 0.04]; p.lean = shift * 0.02; break;
    }
    case "seated":
      p.hipY = 0.5; p.th = [-1.48, -1.48]; p.kn = [1.42, 1.42]; p.lean = 0.12; p.head = 0.16;
      p.sh = [-0.6, -0.6]; p.shRoll = [0.14, -0.14]; p.el = [-1.0 + Math.sin(t * 13 + i) * 0.05 * s, -1.0 + Math.sin(t * 11 + i + 1) * 0.05 * s]; break;
    case "seatedIdle": // nothing recent to work on: leaning back, hands in the lap, looking around now and then (never typing)
      p.hipY = 0.5; p.th = [-1.48, -1.48]; p.kn = [1.42, 1.42]; p.lean = -0.1; p.sh = [-0.18, -0.18]; p.shRoll = [0.12, -0.12]; p.el = [-0.85, -0.85];
      p.headYaw = (Math.sin(t * 0.17 + i * 2.3) > 0.5 ? 0.45 * Math.sign(Math.sin(i * 1.7)) : Math.sin(t * 0.3 + i) * 0.12) * s; p.head = -0.04; break;
    case "seatedRead": // reading the screen: one hand on the mouse, chin forward, slow scrolling
      p.hipY = 0.5; p.th = [-1.48, -1.48]; p.kn = [1.42, 1.42]; p.lean = 0.2; p.head = 0.22;
      p.sh = [-0.7, -0.35]; p.shRoll = [0.16, -0.08]; p.el = [-0.9 + Math.sin(t * 0.8 + i) * 0.03 * s, -1.25]; p.headYaw = Math.sin(t * 0.25 + i) * 0.05 * s; break;
    case "rise": // standing up from the seat before leaving (the hips come up, a lean forward)
      p.lean = 0.16; p.sh = [0.1, 0.1]; p.el = [0.3, 0.3]; p.head = 0.05; break;
    case "terminal": // operating the console (both hands on the controls)
      p.sh = [-0.55 + Math.sin(t * 1.7 + i) * 0.08 * s, -0.48 - Math.sin(t * 1.3 + i) * 0.06 * s]; p.el = [-0.95, -0.9]; p.shRoll = [0.18, -0.18]; p.lean = 0.08; p.head = 0.12; p.headYaw = Math.sin(t * 0.5 + i) * 0.08 * s; break;
    case "inspect": // inspecting the screen: a hand raised to the chin, leaning in
      p.sh = [-1.1, -0.2]; p.el = [-1.9, -0.4]; p.shRoll = [0.35, -0.1]; p.lean = 0.14; p.head = 0.18; p.headYaw = Math.sin(t * 0.4 + i) * 0.12 * s; break;
    case "reading": // reading the terminal: hands on the console edge, head down, scanning
      p.sh = [-0.42, -0.42]; p.el = [-0.55, -0.55]; p.shRoll = [0.22, -0.22]; p.lean = 0.16; p.head = 0.3; p.headYaw = Math.sin(t * 0.9 + i) * 0.1 * s; break;
    case "observe": // watching the room's displays (arms folded, weight on one leg)
      p.sh = [-0.55, -0.55]; p.shRoll = [0.5, -0.5]; p.el = [-1.6, -1.6]; p.head = -0.12; p.headYaw = Math.sin(t * 0.2 + i) * 0.35 * s; p.th = [0.04, -0.03]; break;
    case "waiting": // waiting: hands behind the back, a small sway
      p.sh = [0.25, 0.25]; p.shRoll = [0.05, -0.05]; p.el = [-0.5, -0.5]; p.headYaw = Math.sin(t * 0.25 + i) * 0.25 * s; p.hipY = 0.95 + Math.sin(t * 0.9 + i) * 0.003 * s; break;
    case "pointing": // at the project table: pointing at the shared surface while explaining
      p.sh = [-1.15 + Math.sin(t * 0.7 + i) * 0.08 * s, 0.05]; p.shRoll = [0.1, -0.1]; p.el = [-0.15, -0.35]; p.lean = 0.12; p.head = 0.2; p.headYaw = Math.sin(t * 0.5 + i) * 0.2 * s; break;
    case "meetSeat": // at a team table with teammates (a project record says they work together): talk, gesture, listen
      p.hipY = 0.5; p.th = [-1.48, -1.48]; p.kn = [1.42, 1.42]; p.lean = 0.1 + Math.sin(t * 0.7 + i) * 0.04 * s;
      p.sh = [-0.55 + Math.max(0, Math.sin(t * 0.9 + i * 2)) * 0.35 * s, -0.45]; p.el = [-1.2 + Math.sin(t * 2.1 + i) * 0.15 * s, -1.0]; p.headYaw = Math.sin(t * 0.45 + i * 1.7) * 0.45 * s; p.head = 0.06; break;
    case "meetStand":
      p.sh = [-0.3 + Math.max(0, Math.sin(t * 0.9 + i * 2)) * 0.45 * s, 0.05]; p.el = [-1.1 + Math.sin(t * 2.1 + i) * 0.15 * s, -0.35]; p.headYaw = Math.sin(t * 0.45 + i * 1.7) * 0.4 * s; p.head = 0.08; break;
    case "dead":
      p.lying = 1; p.hipY = 0.14; p.sh = [0, 0]; p.el = [0, 0]; break;
  }
  return p;
}

/** A reaction to one of the agent's own events, layered over its pose (k: 0..1 through the reaction). */
function react(p: Pose, kind: Reaction, k: number, seated: boolean) {
  const w = Math.sin(Math.min(1, k) * Math.PI); // in and out
  if (kind === "confirm") { // a firm tap on the console and a nod: the agent sent this
    p.sh[1] += (-0.9 - p.sh[1]) * w; p.el[1] += (-0.5 - p.el[1]) * w; p.head += 0.25 * w * Math.max(0, Math.sin(k * Math.PI * 3));
  } else if (kind === "complete") { // delivered: sits back / straightens, both fists up briefly
    p.lean += (-0.15 - p.lean) * w; p.sh[0] += (-2.4 - p.sh[0]) * w; p.sh[1] += (-2.4 - p.sh[1]) * w; p.el[0] += (-0.5 - p.el[0]) * w; p.el[1] += (-0.5 - p.el[1]) * w; p.head += (-0.2 - p.head) * w;
  } else { // something arrived for it: looks up at the screen, straightens
    p.head += (-0.15 - p.head) * w; p.lean += ((seated ? 0.02 : -0.02) - p.lean) * w; p.headYaw *= 1 - w;
  }
}

function blend(cur: Pose, to: Pose, k: number) {
  for (const key of POSE_KEYS) cur[key] += (to[key] - cur[key]) * k;
  for (const key of ["sh", "shRoll", "el", "th", "kn"] as const) for (let j = 0; j < 2; j++) cur[key][j] += (to[key][j] - cur[key][j]) * k;
}

/** The joint rig (built once): world matrices of every part for one agent at a time. */
function makeRig() {
  const n = (parent?: THREE.Object3D) => { const o = new THREE.Object3D(); parent?.add(o); return o; };
  const root = n(), lie = n(root), hip = n(lie), torso = n(hip), neck = n(torso), head = n(neck);
  const shL = n(torso), shR = n(torso), elL = n(shL), elR = n(shR), thL = n(hip), thR = n(hip), knL = n(thL), knR = n(thR);
  torso.position.set(0, 0.06, 0); neck.position.set(0, 0.52, 0.0); head.position.set(0, 0.07, 0.01);
  shL.position.set(0.205, 0.46, 0); shR.position.set(-0.205, 0.46, 0); elL.position.set(0, -0.29, 0); elR.position.set(0, -0.29, 0);
  thL.position.set(0.095, -0.03, 0); thR.position.set(-0.095, -0.03, 0); knL.position.set(0, -0.45, 0); knR.position.set(0, -0.45, 0);
  const at = (parent: THREE.Object3D, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => { const o = n(parent); o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.rotation.set(rx, ry, rz); return o; };
  const parts = {
    // Lower body.
    pelvis: at(hip, 0, 0.0, 0, 1, 1, 0.82), belt: at(hip, 0, 0.09, 0), buckle: at(hip, 0, 0.09, 0.118),
    thighL: at(thL, 0, -0.22, 0), thighR: at(thR, 0, -0.22, 0), shinL: at(knL, 0, -0.22, 0), shinR: at(knR, 0, -0.22, 0),
    kneeL: at(knL, 0, 0, 0.045), kneeR: at(knR, 0, 0, 0.045),
    bootL: at(knL, 0, -0.465, 0.045), bootR: at(knR, 0, -0.465, 0.045),
    // Torso: chest (tapered, shoulders wider than waist), vest, harness, piping, collar.
    chest: at(torso, 0, 0.27, 0, 1, 1, 0.62), vest: at(torso, 0, 0.26, 0.004, 1.04, 1, 0.66), strapL: at(torso, 0.075, 0.3, 0.118, 1, 1, 1, 0.12, 0, 0.18), strapR: at(torso, -0.075, 0.3, 0.118, 1, 1, 1, 0.12, 0, -0.18),
    pipeL: at(torso, 0.105, 0.26, 0.127), pipeR: at(torso, -0.105, 0.26, 0.127), collar: at(torso, 0, 0.5, 0, 1, 1, 0.9),
    insignia: at(torso, -0.085, 0.38, 0.128), deltL: at(shL, 0.012, -0.02, 0), deltR: at(shR, -0.012, -0.02, 0),
    // Arms and hands.
    uArmL: at(shL, 0, -0.145, 0), uArmR: at(shR, 0, -0.145, 0), patchL: at(shL, 0.062, -0.07, 0), patchR: at(shR, -0.062, -0.07, 0),
    fArmL: at(elL, 0, -0.13, 0), fArmR: at(elR, 0, -0.13, 0), cuffL: at(elL, 0, -0.235, 0), cuffR: at(elR, 0, -0.235, 0),
    handL: at(elL, 0, -0.3, 0.005), handR: at(elR, 0, -0.3, 0.005), thumbL: at(elL, -0.03, -0.275, 0.03, 1, 1, 1, 0.3, 0, -0.4), thumbR: at(elR, 0.03, -0.275, 0.03, 1, 1, 1, 0.3, 0, 0.4),
    // Neck and head: skull, jaw, ears, the portrait face, nose bridge, hair styles, beard, earpiece.
    neck: at(neck, 0, 0, 0), skull: at(head, 0, 0.125, -0.008, 0.92, 1.12, 1.0), jaw: at(head, 0, 0.06, -0.004, 1, 1, 1),
    earL: at(head, 0.094, 0.115, -0.005), earR: at(head, -0.094, 0.115, -0.005),
    face: at(head, 0, 0.125, -0.008, 0.92, 1.12, 1.0), nose: at(head, 0, 0.1, 0.098),
    hair0: at(head, 0, 0.15, -0.015), hair1: at(head, 0, 0.15, -0.012), hair3: at(head, 0, 0.16, -0.02), hair4: at(head, 0, 0.165, -0.012), hair5: at(head, 0, 0.155, -0.03),
    beard: at(head, 0, 0.055, 0.03, 0.88, 0.8, 0.85), earpiece: at(head, 0.105, 0.11, 0.0),
    // Appearance layers (appearance.ts): plate carrier with pouches, cap, comms headset.
    plate: at(torso, 0, 0.3, 0.13), pouchL: at(torso, 0.085, 0.12, 0.15), pouchC: at(torso, 0, 0.12, 0.15), pouchR: at(torso, -0.085, 0.12, 0.15),
    cap: at(head, 0, 0.17, -0.01, 1.0, 0.9, 1.04), brim: at(head, 0, 0.165, 0.1, 1, 1, 1, -0.15, 0, 0),
    band: at(head, 0, 0.16, -0.005), cupL: at(head, 0.106, 0.11, -0.005), cupR: at(head, -0.106, 0.11, -0.005),
    holo: at(root, 0, 1.2, 0.55, 1, 1, 1, -0.45, 0, 0),
  };
  return { root, lie, hip, torso, head, neck, shL, shR, elL, elR, thL, thR, knL, knR, parts };
}

type PartName = keyof ReturnType<typeof makeRig>["parts"];
/** Segment count at a tessellation level (Low uses fewer segments for round parts; the parts are the same). */
type Seg = (n: number) => number;
const segAt = (lod: number): Seg => (n) => Math.max(3, Math.round(n * lod));
const lathe = (S: Seg, pts: Array<[number, number]>, seg = 14) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), S(seg));
const PART_GEOMETRY: Record<PartName, (S: Seg) => THREE.BufferGeometry> = {
  pelvis: (S) => lathe(S, [[0, -0.1], [0.14, -0.09], [0.165, 0.0], [0.155, 0.1], [0, 0.11]]),
  belt: (S) => new THREE.CylinderGeometry(0.162, 0.165, 0.05, S(18)), buckle: () => new THREE.BoxGeometry(0.05, 0.036, 0.012),
  thighL: (S) => lathe(S, [[0, -0.23], [0.062, -0.22], [0.072, 0.0], [0.082, 0.18], [0.07, 0.24], [0, 0.25]], 12), thighR: (S) => lathe(S, [[0, -0.23], [0.062, -0.22], [0.072, 0.0], [0.082, 0.18], [0.07, 0.24], [0, 0.25]], 12),
  shinL: (S) => lathe(S, [[0, -0.24], [0.048, -0.23], [0.058, 0.0], [0.062, 0.14], [0.055, 0.23], [0, 0.24]], 12), shinR: (S) => lathe(S, [[0, -0.24], [0.048, -0.23], [0.058, 0.0], [0.062, 0.14], [0.055, 0.23], [0, 0.24]], 12),
  kneeL: (S) => new THREE.SphereGeometry(0.05, S(10), S(8)), kneeR: (S) => new THREE.SphereGeometry(0.05, S(10), S(8)),
  bootL: (S) => new THREE.CapsuleGeometry(0.055, 0.15, S(4), S(10)).rotateX(Math.PI / 2).scale(1, 0.85, 1), bootR: (S) => new THREE.CapsuleGeometry(0.055, 0.15, S(4), S(10)).rotateX(Math.PI / 2).scale(1, 0.85, 1),
  chest: (S) => lathe(S, [[0, -0.26], [0.15, -0.25], [0.158, -0.12], [0.185, 0.06], [0.205, 0.17], [0.19, 0.23], [0.11, 0.27], [0, 0.275]], 18),
  vest: (S) => lathe(S, [[0.152, -0.2], [0.162, -0.1], [0.188, 0.06], [0.2, 0.15], [0.17, 0.2]], 18),
  strapL: () => new THREE.BoxGeometry(0.035, 0.34, 0.012), strapR: () => new THREE.BoxGeometry(0.035, 0.34, 0.012),
  pipeL: () => new THREE.BoxGeometry(0.008, 0.3, 0.006), pipeR: () => new THREE.BoxGeometry(0.008, 0.3, 0.006),
  collar: (S) => new THREE.TorusGeometry(0.066, 0.016, S(6), S(18)).rotateX(Math.PI / 2),
  insignia: () => new THREE.BoxGeometry(0.045, 0.03, 0.006), deltL: (S) => new THREE.SphereGeometry(0.068, S(12), S(10)), deltR: (S) => new THREE.SphereGeometry(0.068, S(12), S(10)),
  uArmL: (S) => lathe(S, [[0, -0.16], [0.048, -0.15], [0.056, 0.0], [0.06, 0.12], [0, 0.15]], 10), uArmR: (S) => lathe(S, [[0, -0.16], [0.048, -0.15], [0.056, 0.0], [0.06, 0.12], [0, 0.15]], 10),
  patchL: () => new THREE.BoxGeometry(0.006, 0.05, 0.05), patchR: () => new THREE.BoxGeometry(0.006, 0.05, 0.05),
  fArmL: (S) => lathe(S, [[0, -0.13], [0.036, -0.12], [0.046, 0.06], [0.05, 0.12], [0, 0.14]], 10), fArmR: (S) => lathe(S, [[0, -0.13], [0.036, -0.12], [0.046, 0.06], [0.05, 0.12], [0, 0.14]], 10),
  cuffL: (S) => new THREE.CylinderGeometry(0.04, 0.04, 0.025, S(10)), cuffR: (S) => new THREE.CylinderGeometry(0.04, 0.04, 0.025, S(10)),
  handL: () => new THREE.BoxGeometry(0.055, 0.085, 0.03).translate(0, -0.01, 0), handR: () => new THREE.BoxGeometry(0.055, 0.085, 0.03).translate(0, -0.01, 0),
  thumbL: (S) => new THREE.CapsuleGeometry(0.011, 0.035, S(3), S(6)), thumbR: (S) => new THREE.CapsuleGeometry(0.011, 0.035, S(3), S(6)),
  neck: (S) => new THREE.CylinderGeometry(0.05, 0.058, 0.13, S(12)),
  skull: (S) => new THREE.SphereGeometry(0.1, S(22), S(16)), jaw: (S) => lathe(S, [[0, -0.07], [0.036, -0.066], [0.058, -0.03], [0.07, 0.02], [0.074, 0.06], [0, 0.07]], 16).scale(1, 1, 0.9),
  earL: (S) => new THREE.SphereGeometry(0.022, S(8), S(6)).scale(0.5, 1.3, 1), earR: (S) => new THREE.SphereGeometry(0.022, S(8), S(6)).scale(0.5, 1.3, 1),
  // The portrait face: the front of the head (±70° around, brow to chin), UVs over the portrait's face region.
  face: (S) => new THREE.SphereGeometry(0.1035, S(24), S(18), Math.PI / 2 - 1.22, 2.44, 0.42, 1.95),
  nose: (S) => new THREE.ConeGeometry(0.014, 0.032, S(6)).rotateX(Math.PI / 2 + 0.3),
  hair0: (S) => new THREE.SphereGeometry(0.106, S(20), S(12), 0, Math.PI * 2, 0, Math.PI * 0.5), // crew
  hair1: (S) => new THREE.SphereGeometry(0.103, S(20), S(12), 0, Math.PI * 2, 0, Math.PI * 0.46), // buzz
  hair3: (S) => new THREE.SphereGeometry(0.112, S(20), S(12), 0, Math.PI * 2, 0, Math.PI * 0.52).scale(1, 1.1, 1.12), // swept, fuller
  hair4: (S) => new THREE.SphereGeometry(0.104, S(20), S(12), 0, Math.PI * 2, 0, Math.PI * 0.38).scale(0.9, 1.2, 1), // high fade (top only)
  hair5: (S) => new THREE.SphereGeometry(0.105, S(20), S(12), Math.PI * 0.2, Math.PI * 1.6, Math.PI * 0.2, Math.PI * 0.35), // receding (back and sides)
  beard: (S) => new THREE.SphereGeometry(0.1, S(16), S(10), 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.35),
  earpiece: () => new THREE.BoxGeometry(0.018, 0.04, 0.026),
  plate: () => new THREE.BoxGeometry(0.26, 0.24, 0.035), pouchL: () => new THREE.BoxGeometry(0.07, 0.08, 0.045), pouchC: () => new THREE.BoxGeometry(0.07, 0.08, 0.045), pouchR: () => new THREE.BoxGeometry(0.07, 0.08, 0.045),
  cap: (S) => new THREE.SphereGeometry(0.108, S(18), S(10), 0, Math.PI * 2, 0, Math.PI * 0.42), brim: () => new THREE.BoxGeometry(0.15, 0.012, 0.08),
  band: (S) => new THREE.TorusGeometry(0.108, 0.008, S(6), S(20), Math.PI).rotateY(Math.PI / 2), cupL: (S) => new THREE.CylinderGeometry(0.03, 0.03, 0.025, S(12)).rotateZ(Math.PI / 2), cupR: (S) => new THREE.CylinderGeometry(0.03, 0.03, 0.025, S(12)).rotateZ(Math.PI / 2),
  holo: () => new THREE.PlaneGeometry(0.56, 0.32),
};
/** Fixed colour per part, or a per-agent colour (skin, hair, uniform, the room's accent). */
const PART_COLOUR: Record<PartName, string | "skin" | "hair" | "uniform" | "trousers" | "vest" | "accent" | "face"> = {
  pelvis: "trousers", belt: "#0a0e15", buckle: "#22d3ee", thighL: "trousers", thighR: "trousers", shinL: "trousers", shinR: "trousers", kneeL: "#141b27", kneeR: "#141b27",
  bootL: "#07090d", bootR: "#07090d", chest: "uniform", vest: "vest", strapL: "#0b1018", strapR: "#0b1018", pipeL: "#22d3ee", pipeR: "#22d3ee", collar: "#2b394f",
  insignia: "accent", deltL: "uniform", deltR: "uniform", uArmL: "uniform", uArmR: "uniform", patchL: "#22d3ee", patchR: "#22d3ee", fArmL: "uniform", fArmR: "uniform",
  cuffL: "#0b1018", cuffR: "#0b1018", handL: "skin", handR: "skin", thumbL: "skin", thumbR: "skin", neck: "skin", skull: "skin", jaw: "skin", earL: "skin", earR: "skin",
  face: "face", nose: "skin", hair0: "hair", hair1: "hair", hair3: "hair", hair4: "hair", hair5: "hair", beard: "hair", earpiece: "#0b0f16", holo: "accent",
  plate: "vest", pouchL: "vest", pouchC: "vest", pouchR: "vest", cap: "vest", brim: "#0a0e15", band: "#0b0f16", cupL: "#0b0f16", cupR: "#0b0f16",
};
const GLOW: ReadonlySet<PartName> = new Set(["buckle", "pipeL", "pipeR", "patchL", "patchR", "holo", "insignia"]);
const CLICKABLE: ReadonlySet<PartName> = new Set(["chest", "vest", "pelvis", "skull", "face", "thighL", "thighR"]);
/** Fine details (sub-pixel from the Fleet view): not drawn while the camera is far above the building. */
const DETAIL: ReadonlySet<PartName> = new Set(["pouchL", "pouchC", "pouchR", "brim", "band", "cupL", "cupR", "buckle", "pipeL", "pipeR", "strapL", "strapR", "patchL", "patchR", "insignia", "cuffL", "cuffR", "thumbL", "thumbR", "earL", "earR", "nose", "kneeL", "kneeR", "collar", "earpiece", "deltL", "deltR"]);
const HAIR_PART: Record<number, PartName | null> = { 0: "hair0", 1: "hair1", 2: null, 3: "hair3", 4: "hair4", 5: "hair5" };

// ── The face atlas: every agent's portrait (in its current condition), 8×8 cells of 128 px ─────────────────────────
const CELLS = 8;
function useFaceAtlas(models: readonly AgentModel[]) {
  // One atlas per crowd (state: created once); mutated only through the ref, from effects and frame callbacks.
  const [created] = useState(() => {
    const c = document.createElement("canvas"); c.width = c.height = CELLS * PORTRAIT_SIZE;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return { canvas: c, ctx: c.getContext("2d")!, tex: t, painted: new Map<number, string>() };
  });
  const ref = useRef(created);
  useEffect(() => () => ref.current.tex.dispose(), []);
  // Paint cells progressively (portraits take a few milliseconds each); until then a cell is plain skin.
  const pending = useRef<Array<{ cell: number; key: string; id: string; band: AgentModel["health"]["band"]; skin: string }>>([]);
  useEffect(() => {
    const atlas = ref.current;
    pending.current = [];
    models.forEach((m, i) => {
      if (i >= CELLS * CELLS) return;
      const key = `${m.agent.id}|${m.health.band}`;
      if (atlas.painted.get(i) === key) return;
      const skin = identityColours(m.agent.id).skin;
      const x = (i % CELLS) * PORTRAIT_SIZE, y = Math.floor(i / CELLS) * PORTRAIT_SIZE;
      if (!atlas.painted.has(i)) { atlas.ctx.clearRect(x, y, PORTRAIT_SIZE, PORTRAIT_SIZE); atlas.ctx.fillStyle = skin; atlas.ctx.fillRect(x + 40, y + 40, 48, 56); atlas.tex.needsUpdate = true; }
      pending.current.push({ cell: i, key, id: m.agent.id, band: m.health.band, skin });
    });
  }, [models]);
  useFrame(() => {
    const atlas = ref.current;
    const until = performance.now() + 6;
    let changed = false;
    while (pending.current.length && performance.now() < until) {
      const j = pending.current.shift()!, S = PORTRAIT_SIZE;
      const px = portraitPixels(j.id, j.band), fig = portraitFigure(j.id, j.band), img = atlas.ctx.createImageData(S, S);
      for (let k = 0; k < S * S; k++) { img.data[k * 4] = px[k * 4]; img.data[k * 4 + 1] = px[k * 4 + 1]; img.data[k * 4 + 2] = px[k * 4 + 2]; img.data[k * 4 + 3] = fig[k]; }
      atlas.ctx.putImageData(img, (j.cell % CELLS) * S, Math.floor(j.cell / CELLS) * S);
      atlas.painted.set(j.cell, j.key); changed = true;
    }
    if (changed) atlas.tex.needsUpdate = true;
  });
  return created.tex;
}

/** The face material: the atlas cell of each instance (a per-instance attribute), cropped to the portrait's face. */
function faceMaterial(map: THREE.Texture, pbr: boolean): THREE.Material {
  const m = pbr ? new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: new THREE.Color("#ffffff"), emissiveIntensity: 0.28, roughness: 0.62, metalness: 0, alphaTest: 0.4, transparent: false })
    : new THREE.MeshBasicMaterial({ map, alphaTest: 0.4 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 faceCell;")
      .replace("#include <uv_vertex>", `#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = (faceCell + vec2(0.24, 0.19) + vMapUv * vec2(0.52, 0.66)) / ${CELLS.toFixed(1)};\n#endif\n#ifdef USE_EMISSIVEMAP\n  vEmissiveMapUv = vMapUv;\n#endif`);
  };
  m.customProgramCacheKey = () => `hq-face-${pbr}`;
  return m;
}

/** Seated agents sit a little behind their spot (in the chair), facing the desk. */
const SEAT_BACK = 0.1;

export const Crowd = memo(function Crowd({ models, targets, spots, meetings, births, selected, q, reduceMotion, positionsRef, ghostsRef, onAgent, stations, nav, teams, receivedRef }: {
  models: AgentModel[]; targets: ReadonlyMap<string, Point>; spots: ReadonlyMap<string, WorkSpot>; meetings: ReadonlySet<string>; births: ReadonlyMap<string, number>; selected: string | null; q: HQProfile; reduceMotion: boolean;
  positionsRef: MutableRefObject<Map<string, Point>>; ghostsRef: MutableRefObject<ReadonlySet<string>>; onAgent: (id: string) => void; stations: ReadonlyMap<string, Point>;
  /** The walkable floor (nav.ts), with the Agent Floor's desks. */
  nav: NavGrid;
  /** Agents on an active team project (FleetController's project record): working, even without a recent event. */
  teams: ReadonlyMap<string, string>;
  /** When each agent last sent / completed / received a real event (flow.tsx), for its reactions. */
  receivedRef?: MutableRefObject<Map<string, number>>;
}) {
  const rig = useMemo(() => makeRig(), []);
  const names = useMemo(() => Object.keys(rig.parts) as PartName[], [rig]);
  const meshes = useRef(new Map<PartName, THREE.InstancedMesh>());
  const states = useRef(new Map<string, AgentState>());
  const own = useRef(new Map<string, Point>());
  useEffect(() => { positionsRef.current = own.current; }, [positionsRef]);
  const cap = Math.max(1, models.length);
  const atlas = useFaceAtlas(models);
  // Each person's look (appearance.ts: identity-derived default, skin-ready); visual only.
  const looks = useMemo(() => new Map(models.map((m) => [m.agent.id, appearanceOf(m.agent.id)])), [models]);

  const lod = q.pbr ? (q.detail >= 2 ? 1.25 : 1) : 0.5;
  const geometries = useMemo(() => {
    const S = segAt(lod); // the same parts at every level; only how finely round shapes are tessellated
    return Object.fromEntries(names.map((p) => [p, bakeShade(PART_GEOMETRY[p](S))])) as unknown as Record<PartName, THREE.BufferGeometry>;
  }, [names, lod]);
  const materials = useMemo(() => Object.fromEntries(names.map((p) => {
    if (p === "face") return [p, faceMaterial(atlas, q.pbr)];
    const glow = GLOW.has(p);
    const fabric = PART_COLOUR[p] === "uniform" || PART_COLOUR[p] === "trousers";
    const m = glow ? new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false, transparent: p === "holo", opacity: p === "holo" ? 0.5 : 1, side: p === "holo" ? THREE.DoubleSide : THREE.FrontSide, depthWrite: p !== "holo" })
      : q.physical && fabric ? new THREE.MeshPhysicalMaterial({ color: "#ffffff", roughness: 0.82, metalness: 0, sheen: 0.6, sheenRoughness: 0.6, sheenColor: new THREE.Color("#6b8bb8") })
      : q.pbr ? new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: PART_COLOUR[p] === "skin" ? 0.6 : PART_COLOUR[p] === "hair" ? 0.75 : fabric ? 0.85 : 0.45, metalness: p === "vest" || p === "belt" || p === "earpiece" ? 0.35 : 0.04 })
      : new THREE.MeshBasicMaterial({ color: "#ffffff", vertexColors: true }); // Low: baked shading, unlit
    return [p, m];
  })) as unknown as Record<PartName, THREE.Material>, [names, q.pbr, q.physical, atlas]);
  useEffect(() => () => { for (const g of Object.values(geometries)) g.dispose(); }, [geometries]);
  useEffect(() => () => { for (const m of Object.values(materials)) m.dispose(); }, [materials]);

  // Per-agent colours (identity, room accent) and face atlas cells — written when the crowd or its conditions change.
  // Identity colours per part and person; every part is drawn packed (only people in view, only what shows), so instance j
  // of a part's mesh is person slots[part][j] — colours are copied from here, clicks mapped back through `slots`.
  const condColours = useRef(new Map<PartName, Float32Array>());
  const slots = useRef(new Map<PartName, Int32Array>());
  const colour = useMemo(() => new THREE.Color(), []), deadGrey = useMemo(() => new THREE.Color("#3b4250"), []);
  useEffect(() => {
    const face = meshes.current.get("face");
    if (face) {
      const cells = new Float32Array(cap * 2);
      models.forEach((_, i) => { const c = Math.min(i, CELLS * CELLS - 1); cells[i * 2] = c % CELLS; cells[i * 2 + 1] = CELLS - 1 - Math.floor(c / CELLS); });
      face.geometry.setAttribute("faceCell", new THREE.InstancedBufferAttribute(cells, 2));
    }
    models.forEach((m, i) => {
      const id = identityColours(m.agent.id), dead = m.agent.status === "dead", lift = q.pbr ? 1 : 1.9;
      for (const p of names) {
        const mesh = meshes.current.get(p);
        if (!mesh) continue;
        const kind = PART_COLOUR[p];
        const look = looks.get(m.agent.id)!;
        const c = kind === "skin" ? id.skin : kind === "hair" ? id.hair : kind === "uniform" ? look.colour.uniform : kind === "trousers" ? look.colour.trousers : kind === "vest" ? look.colour.vest
          : kind === "accent" ? DEPARTMENT[m.placement.department].accent : kind === "face" ? "#ffffff" : kind;
        colour.set(c);
        if (!GLOW.has(p) && kind !== "face") colour.multiplyScalar(lift);
        if (dead && !GLOW.has(p) && kind !== "face") colour.lerp(deadGrey, 0.55);
        if (dead && GLOW.has(p)) colour.set("#1e293b");
        const a = condColours.current.get(p) ?? condColours.current.set(p, new Float32Array(cap * 3)).get(p)!;
        a[i * 3] = colour.r; a[i * 3 + 1] = colour.g; a[i * 3 + 2] = colour.b;
      }
    });
    for (const mesh of meshes.current.values()) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [models, names, colour, deadGrey, cap, q.pbr, looks]);

  const m4 = useMemo(() => new THREE.Matrix4(), []), sc = useMemo(() => new THREE.Matrix4(), []);
  const frustum = useMemo(() => new THREE.Frustum(), []), pv = useMemo(() => new THREE.Matrix4(), []), sphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 1.3), []);
  useFrame(({ clock, camera }, dt) => {
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pv);
    const far = camera.position.y > 24; // the Fleet view
    const t = clock.elapsedTime, k = reduceMotion ? 1 : Math.min(1, dt * 6), now = Date.now(), ghosts = ghostsRef.current;
    let budget = 4; // ms of path planning per frame (moves queue up and leave over the next frames)
    const drawn = new Map<PartName, number>();
    models.forEach((m, i) => {
      const id = m.agent.id, target = targets.get(id);
      if (!target) return;
      let st = states.current.get(id);
      const b = birthState(births.get(id), now, reduceMotion);
      if (!st) {
        const start = b.phase !== "settled" ? { x: DEPARTMENT.command.x, z: DEPARTMENT.command.z + 6 } : { ...target };
        st = { pos: start, yaw: Math.PI, phase: 0, pose: zero(), activity: "idle", ghost: 0, goal: null, path: [], speed: 0, fast: false, departAt: 0, planned: true };
        states.current.set(id, st);
      }
      // A new authoritative target: finish the current activity (stand up from the seat), then walk THROUGH the
      // building on the nav grid — around desks and people's chairs, out through the room's doorway, along the
      // corridors, in through the destination's doorway — and approach the work spot. Teleport only if no path exists.
      if (!st.goal || st.goal.x !== target.x || st.goal.z !== target.z) {
        st.goal = { ...target };
        const seatedNow = st.pose.hipY < 0.8;
        st.path = []; st.planned = false; st.departAt = now + (seatedNow && !reduceMotion ? 900 : 200);
      }
      if (!st.planned && (reduceMotion || budget > 0)) {
        st.planned = true;
        if (reduceMotion) st.path = [st.goal];
        else {
          const t0 = performance.now(), path = findPath(nav, st.pos, st.goal);
          budget -= performance.now() - t0;
          if (path) st.path = path; else { st.pos.x = st.goal.x; st.pos.z = st.goal.z; st.path = []; } // fallback only
          st.fast = pathLength([st.pos, ...st.path]) > 12;
        }
      }
      const waiting = !st.planned || now < st.departAt;
      let moving = false, dx = 0, dz = 0;
      if (reduceMotion) { st.pos.x = target.x; st.pos.z = target.z; st.path = []; st.speed = 0; }
      else if (st.path.length && !waiting) {
        const wp = st.path[0]; dx = wp.x - st.pos.x; dz = wp.z - st.pos.z;
        const d = Math.hypot(dx, dz), remaining = d + pathLength(st.path);
        const cruise = st.fast ? 2.1 : 1.35, want = Math.min(cruise, 0.35 + remaining * 0.9); // slow down on arrival
        const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(dx, dz) - st.yaw), Math.cos(Math.atan2(dx, dz) - st.yaw)));
        // Give way to people close ahead (keep right; slow down), never stepping off walkable floor.
        const dir = d > 1e-4 ? { x: dx / d, z: dz / d } : { x: 0, z: 1 };
        const gw = remaining > 0.8 ? giveWay(id, st.pos, dir, own.current) : { push: { x: 0, z: 0 }, slow: 1 };
        st.speed += ((turn > 1.2 ? want * 0.45 : want) * gw.slow - st.speed) * Math.min(1, dt * 3); // accelerate, ease into turns
        const step = st.speed * Math.min(dt, 0.1);
        if (d <= Math.max(step, 0.02)) { st.pos.x = wp.x; st.pos.z = wp.z; st.path.shift(); }
        else { st.pos.x += (dx / d) * step; st.pos.z += (dz / d) * step; }
        const sx = st.pos.x + gw.push.x * Math.min(dt, 0.1), sz = st.pos.z + gw.push.z * Math.min(dt, 0.1);
        if ((gw.push.x || gw.push.z) && walkable(nav, { x: sx, z: sz })) { st.pos.x = sx; st.pos.z = sz; }
        st.phase += (step / (st.fast ? 0.9 : 0.75)) * Math.PI;
        moving = st.path.length > 0 || d > step;
      } else st.speed = 0;
      const fast = st.fast;
      own.current.set(id, { x: st.pos.x, z: st.pos.z });
      const station = stations.get(id), atStation = !!station && Math.hypot(station.x - st.pos.x, station.z - st.pos.z) < 0.05;
      const spot = spots.get(id), atSpot = !!spot && Math.hypot(spot.x - st.pos.x, spot.z - st.pos.z) < 0.05;
      const activity = chooseActivity({ status: m.agent.status, basis: m.placement.basis, department: m.placement.department, moving, fast, rising: waiting && (st.path.length > 0 || !st.planned),
        atStation, atSpot, spotPose: spot?.pose ?? null, meeting: meetings.has(id), team: teams.has(id), seed: seedOf(id), t });
      st.activity = activity;
      // Stationary: face the equipment (the spot's direction; workstations face north).
      const wantYaw = moving && (dx || dz) ? Math.atan2(dx, dz) : atSpot ? spot!.yaw : Math.PI;
      let dy = wantYaw - st.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      st.yaw += dy * (reduceMotion ? 1 : Math.min(1, dt * (moving ? 6 : 4)));
      // Sitting down and standing up take a moment (slower blend while the hips change height).
      const settling = Math.abs(targetPose(activity, t, st.phase, i, true).hipY - st.pose.hipY) > 0.05;
      const want = targetPose(activity, t, st.phase, i, reduceMotion);
      // Reactions to the agent's own real events (not while walking, not when dead; Reduce Motion keeps them still).
      const rec = receivedRef?.current, rx = rec && !moving && activity !== "dead" && !reduceMotion
        ? reactionAt(now, { send: rec.get(`send:${id}`), done: rec.get(`done:${id}`), receive: rec.get(`agent:${id}`) }) : null;
      if (rx) react(want, rx.kind, rx.k, activity.startsWith("seat") || activity === "meetSeat");
      blend(st.pose, want, settling && !reduceMotion ? Math.min(1, dt * 3) : rx ? Math.min(1, dt * 10) : k);
      // Fade out of the camera's line of sight to the selected agent.
      const ghostTarget = ghosts.has(id) && id !== selected ? 1 : 0;
      st.ghost += (ghostTarget - st.ghost) * (reduceMotion ? 1 : Math.min(1, dt * 8));

      // Out of view: state (position, pose) is kept current, but nothing is drawn.
      sphere.center.set(st.pos.x, 1, st.pos.z);
      if (!frustum.intersectsSphere(sphere)) return;
      // Pose the rig.
      const P = st.pose, r = rig, seated = activity === "seated" || activity === "seatedIdle" || activity === "seatedRead" || activity === "meetSeat";
      const back = seated ? SEAT_BACK : 0;
      r.root.position.set(st.pos.x - Math.sin(st.yaw) * back, 0.12, st.pos.z - Math.cos(st.yaw) * back);
      r.root.rotation.set(0, st.yaw, 0);
      const ident = identityColours(id), wide = [0.97, 1, 1.04][ident.width];
      r.root.scale.set(wide, 1, wide);
      r.lie.rotation.set(-P.lying * Math.PI / 2, 0, 0); r.lie.position.set(0, 0, P.lying * 0.9);
      r.hip.position.set(0, P.hipY - P.lying * 0.8, 0);
      r.torso.rotation.set(P.lean, 0, 0);
      r.neck.rotation.set(P.head, P.headYaw, 0);
      r.shL.rotation.set(P.sh[0], 0, P.shRoll[0]); r.shR.rotation.set(P.sh[1], 0, P.shRoll[1]);
      r.elL.rotation.set(P.el[0], 0, 0); r.elR.rotation.set(P.el[1], 0, 0);
      r.thL.rotation.set(P.th[0], 0, 0); r.thR.rotation.set(P.th[1], 0, 0);
      r.knL.rotation.set(P.kn[0], 0, 0); r.knR.rotation.set(P.kn[1], 0, 0);
      r.parts.earpiece.position.x = ident.earpiece < 0 ? 0.105 : -0.105;
      const boot = looks.get(id)!.footwear === "tacticalBoots" ? 1.12 : 1; r.parts.bootL.scale.set(boot, boot, boot); r.parts.bootR.scale.set(boot, boot, boot);
      r.root.updateMatrixWorld(true);
      const hairPart = HAIR_PART[ident.hairStyle], fade = 1 - st.ghost;
      if (fade < 0.999) sc.makeScale(fade, fade, fade);
      for (const p of names) {
        const mesh = meshes.current.get(p);
        if (!mesh) continue;
        const look = looks.get(id)!;
        const show = b.visible && fade > 0.02
          && (p !== "beard" || look.facialHair >= 3)
          && (!p.startsWith("hair") || p === hairPart)
          && (p !== "earpiece" || look.accessories.includes("earpiece"))
          && (p !== "holo" || ((activity === "terminal" || activity === "reading" || activity === "inspect") && look.accessories.includes("holoPanel")))
          && (p !== "vest" || look.armour !== "none")
          && (!(p === "plate" || p.startsWith("pouch")) || look.armour === "plateCarrier")
          && (!(p === "cap" || p === "brim") || look.headgear === "cap")
          && (!(p === "band" || p === "cupL" || p === "cupR") || look.headgear === "headset");
        if (!show || (far && DETAIL.has(p))) continue;
        const j = drawn.get(p) ?? 0;
        drawn.set(p, j + 1);
        const sl = slots.current.get(p) ?? slots.current.set(p, new Int32Array(cap)).get(p)!;
        sl[j] = i;
        const a = condColours.current.get(p); if (a) mesh.setColorAt(j, colour.setRGB(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]));
        if (fade < 0.999) { m4.copy(r.parts[p].matrixWorld); m4.premultiply(new THREE.Matrix4().makeTranslation(-st.pos.x, 0, -st.pos.z)).premultiply(sc).premultiply(new THREE.Matrix4().makeTranslation(st.pos.x, 0, st.pos.z)); mesh.setMatrixAt(j, m4); }
        else mesh.setMatrixAt(j, r.parts[p].matrixWorld);
      }
    });
    for (const p of names) {
      const mesh = meshes.current.get(p);
      if (!mesh) continue;
      mesh.count = drawn.get(p) ?? 0; mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (states.current.size > models.length) for (const id of [...states.current.keys()]) if (!models.some((m) => m.agent.id === id)) { states.current.delete(id); own.current.delete(id); }
  });

  const click = (p: PartName) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = e.instanceId !== undefined ? slots.current.get(p)?.[e.instanceId] : undefined, m = i !== undefined ? models[i] : undefined;
    if (m) onAgent(m.agent.id);
  };
  return <>
    {names.map((p) => <instancedMesh key={`${p}:${cap}`} ref={(m) => { if (m) meshes.current.set(p, m); else meshes.current.delete(p); }}
      args={[geometries[p], materials[p], cap]} frustumCulled={false} castShadow={!!q.shadows && !GLOW.has(p) && p !== "face"} receiveShadow={false}
      onClick={CLICKABLE.has(p) ? click(p) : undefined}
      onPointerOver={CLICKABLE.has(p) ? () => { document.body.style.cursor = "pointer"; } : undefined}
      onPointerOut={CLICKABLE.has(p) ? () => { document.body.style.cursor = ""; } : undefined} />)}
    <SelectionRing selected={selected} positionsRef={own} />
    {q.contactShadows && <ContactShadows models={models} positionsRef={own} />}
  </>;
});

function SelectionRing({ selected, positionsRef }: { selected: string | null; positionsRef: MutableRefObject<Map<string, Point>> }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const p = selected ? positionsRef.current.get(selected) : undefined;
    m.visible = !!p;
    if (p) { m.position.set(p.x, 0.15, p.z); m.rotation.z = clock.elapsedTime * 0.6; }
  });
  return <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} visible={false}><ringGeometry args={[0.45, 0.52, 40]} /><meshBasicMaterial color="#e2e8f0" toneMapped={false} /></mesh>;
}

/** Medium and above: a soft contact shadow (ambient occlusion blob) under each person, so they sit on the floor. */
function ContactShadows({ models, positionsRef }: { models: AgentModel[]; positionsRef: MutableRefObject<Map<string, Point>> }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const { geom, mat } = useMemo(() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d")!, grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(0,0,0,0.75)"); grd.addColorStop(0.55, "rgba(0,0,0,0.35)"); grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const geom = new THREE.PlaneGeometry(0.9, 0.9); geom.rotateX(-Math.PI / 2);
    return { geom, mat: new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }) };
  }, []);
  useEffect(() => () => { geom.dispose(); mat.map?.dispose(); mat.dispose(); }, [geom, mat]);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  useFrame(() => {
    const im = mesh.current; if (!im) return;
    let n = 0;
    for (const m of models) { const p = positionsRef.current.get(m.agent.id); if (!p) continue; m4.makeTranslation(p.x, 0.125, p.z); im.setMatrixAt(n++, m4); }
    im.count = n; im.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[geom, mat, Math.max(1, models.length)]} key={models.length} frustumCulled={false} renderOrder={1} />;
}
