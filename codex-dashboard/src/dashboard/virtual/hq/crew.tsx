"use client";
/**
 * The specialist crew in 3D (owner, 2026-10-16): each specialist has its own assigned workstation (crew-layout.ts) with
 * a nameplate (role + seat). By default it is ASLEEP at its desk — slumped forward on its arms, screen dark, a small
 * "z z" above it — and it WAKES only while a real helper job of its role is on the desk (command/helpers.ts crewOf):
 * upright, typing, screen lit in the role's colour, its visor glowing. A finished job keeps the desk lit for the short
 * display linger the panel states. Nothing here polls or runs anything: it draws what the `helpers` read reported.
 *
 * Specialists are NOT agents and look different: shorter, a pale coverall with the role's colour band, a plain helmet
 * with a visor — no portrait face (agents' faces are their identity), not clickable as agents, never counted.
 *
 * Rendering: every desk part and every body part is ONE instanced mesh (≈25 draw calls for all 24 desks); the nameplates
 * are one merged mesh over one canvas atlas. Reduce Motion: no typing, no breathing, no bobbing "z" — the state still
 * shows. Low quality: baked-shade unlit materials, like the rest of the HQ.
 */
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { HELPER_ROLES, ROLE_COLOUR, ROLE_NAME, type HelperRole } from "../../command/helpers";
import { CREW_DESK, deskLocal, shownBays, yawOf, type Bay, type PlacedDesk } from "./crew-layout";
import type { HQProfile } from "./quality";
import { bakeShade } from "./builder";

const D = CREW_DESK;
/** Desk furniture, in the desk's local frame (q = 0: monitor towards −z, the chair at +z). */
const DESK = {
  top: { g: () => new THREE.BoxGeometry(D.deskW, 0.05, D.deskZ1 - D.deskZ0), off: [0, 0.74, (D.deskZ0 + D.deskZ1) / 2], col: "#2a3446" },
  panel: { g: () => new THREE.BoxGeometry(D.deskW - 0.1, 0.56, 0.04), off: [0, 0.4, D.deskZ0 + 0.04], col: "#151c28" },
  legL: { g: () => new THREE.BoxGeometry(0.05, 0.72, D.deskZ1 - D.deskZ0 - 0.06), off: [D.deskW / 2 - 0.04, 0.36, (D.deskZ0 + D.deskZ1) / 2], col: "#151c28" },
  legR: { g: () => new THREE.BoxGeometry(0.05, 0.72, D.deskZ1 - D.deskZ0 - 0.06), off: [-D.deskW / 2 + 0.04, 0.36, (D.deskZ0 + D.deskZ1) / 2], col: "#151c28" },
  monitor: { g: () => new THREE.BoxGeometry(0.5, 0.32, 0.035), off: [0, 1.0, D.deskZ0 + 0.12], col: "#0e131c" },
  stand: { g: () => new THREE.BoxGeometry(0.05, 0.16, 0.05), off: [0, 0.84, D.deskZ0 + 0.1], col: "#151c28" },
  keyboard: { g: () => new THREE.BoxGeometry(0.4, 0.02, 0.12), off: [0, 0.775, -0.16], col: "#0e131c" },
  seat: { g: () => new THREE.BoxGeometry(D.chairW, 0.07, 0.44), off: [0, 0.5, D.seatZ], col: "#273246" },
  back: { g: () => new THREE.BoxGeometry(0.44, 0.38, 0.06), off: [0, 0.76, D.chairZ1 - 0.03], col: "#273246" },
  post: { g: () => new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), off: [0, 0.25, D.seatZ], col: "#151c28" },
} as const;
type DeskPart = keyof typeof DESK;

/** The specialist's body parts; colour "suit" (pale coverall), "helmet", "role" (the stripe) or "visor". */
const BODY = ["pelvis", "thighL", "thighR", "shinL", "shinR", "torso", "stripe", "helmet", "visor", "uArmL", "uArmR", "fArmL", "fArmR"] as const;
type BodyPart = typeof BODY[number];
const BODY_GEO: Record<BodyPart, () => THREE.BufferGeometry> = {
  pelvis: () => new THREE.BoxGeometry(0.28, 0.13, 0.2), thighL: () => new THREE.BoxGeometry(0.11, 0.11, 0.38), thighR: () => new THREE.BoxGeometry(0.11, 0.11, 0.38),
  shinL: () => new THREE.BoxGeometry(0.09, 0.46, 0.09), shinR: () => new THREE.BoxGeometry(0.09, 0.46, 0.09),
  torso: () => new THREE.BoxGeometry(0.3, 0.46, 0.18), stripe: () => new THREE.BoxGeometry(0.31, 0.05, 0.186),
  helmet: () => new THREE.SphereGeometry(0.115, 14, 10), visor: () => new THREE.BoxGeometry(0.17, 0.06, 0.04),
  uArmL: () => new THREE.BoxGeometry(0.08, 0.27, 0.08), uArmR: () => new THREE.BoxGeometry(0.08, 0.27, 0.08),
  fArmL: () => new THREE.BoxGeometry(0.07, 0.26, 0.07), fArmR: () => new THREE.BoxGeometry(0.07, 0.26, 0.07),
};
const BODY_COL: Record<BodyPart, "suit" | "helmet" | "role" | "visor" | "boot"> = {
  pelvis: "suit", thighL: "suit", thighR: "suit", shinL: "boot", shinR: "boot", torso: "suit", stripe: "role", helmet: "helmet", visor: "visor",
  uArmL: "suit", uArmR: "suit", fArmL: "suit", fArmR: "suit",
};

/** The seated rig (built once; the figure faces +z, towards its desk). */
function makeRig() {
  const n = (parent?: THREE.Object3D, x = 0, y = 0, z = 0) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent?.add(o); return o; };
  const root = n(), hip = n(root, 0, 0.6, 0), torso = n(hip, 0, 0.06, 0), head = n(torso, 0, 0.48, 0);
  const shL = n(torso, 0.19, 0.42, 0), shR = n(torso, -0.19, 0.42, 0), elL = n(shL, 0, -0.27, 0), elR = n(shR, 0, -0.27, 0);
  const knL = n(hip, 0.08, 0, 0.38), knR = n(hip, -0.08, 0, 0.38);
  const parts: Record<BodyPart, THREE.Object3D> = {
    pelvis: n(hip), thighL: n(hip, 0.08, 0, 0.19), thighR: n(hip, -0.08, 0, 0.19), shinL: n(knL, 0, -0.23, 0), shinR: n(knR, 0, -0.23, 0),
    torso: n(torso, 0, 0.23, 0), stripe: n(torso, 0, 0.36, 0), helmet: n(head, 0, 0.12, 0), visor: n(head, 0, 0.12, 0.1),
    uArmL: n(shL, 0, -0.135, 0), uArmR: n(shR, 0, -0.135, 0), fArmL: n(elL, 0, -0.13, 0), fArmR: n(elR, 0, -0.13, 0),
  };
  return { root, torso, head, shL, shR, elL, elR, parts };
}

/** One canvas atlas row per desk: "RESEARCHER 1" in the role's colour. */
type Plate = { role: HelperRole; seat: number; bay: Bay };
function plateAtlas(desks: readonly Plate[]) {
  const c = document.createElement("canvas"), rows = Math.max(1, desks.length); c.width = 256; c.height = 32 * rows;
  const g = c.getContext("2d")!;
  desks.forEach((d, i) => {
    g.fillStyle = "#0b1220"; g.fillRect(0, i * 32, 256, 32);
    g.fillStyle = ROLE_COLOUR[d.role]; g.fillRect(0, i * 32, 6, 32);
    g.font = "bold 17px ui-monospace, monospace"; g.textBaseline = "middle"; g.fillStyle = "#e2e8f0";
    g.fillText(`${ROLE_NAME[d.role].toUpperCase()} ${d.seat}`, 14, i * 32 + 16, 236);
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** The nameplates as one merged mesh: a small plate standing on each desk's near corner, facing the chair side. */
function plateGeometry(desks: readonly Plate[]) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [], o = new THREE.Object3D(), v = new THREE.Vector3(), rows = Math.max(1, desks.length);
  desks.forEach((d, i) => {
    const at = deskLocal(d.bay, 0.33, -0.08);
    o.position.set(at.x, 0.12 + 0.84, at.z); o.rotation.set(0, 0, 0); o.rotateY(yawOf(d.bay)); o.rotateX(-0.35); o.updateMatrix();
    const w = 0.34, h = 0.085, base = i * 4;
    for (const [x, y, u, vv] of [[-w / 2, -h / 2, 0, 1 - (i + 1) / rows], [w / 2, -h / 2, 1, 1 - (i + 1) / rows], [w / 2, h / 2, 1, 1 - i / rows], [-w / 2, h / 2, 0, 1 - i / rows]]) {
      v.set(x, y, 0).applyMatrix4(o.matrix); pos.push(v.x, v.y, v.z); uv.push(u, vv);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  return g;
}

/** A "z Z" sprite texture (the asleep cue). */
function zzzTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#cbd5e1"; g.font = "bold 22px ui-monospace, monospace"; g.fillText("z", 8, 52); g.font = "bold 30px ui-monospace, monospace"; g.fillText("Z", 30, 30);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const material = (pbr: boolean, glow = false): THREE.Material => (glow ? new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false })
  : pbr ? new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.6, metalness: 0.2 }) : new THREE.MeshBasicMaterial({ color: "#ffffff", vertexColors: true }));

export const CrewDesks = memo(function CrewDesks({ desks, q, reduceMotion }: { desks: readonly PlacedDesk[]; q: HQProfile; reduceMotion: boolean }) {
  const cap = Math.max(1, desks.length);
  const lift = q.pbr ? 1 : 1.9;
  const deskGeo = useMemo(() => Object.fromEntries((Object.keys(DESK) as DeskPart[]).map((k) => [k, bakeShade(DESK[k].g())])) as Record<DeskPart, THREE.BufferGeometry>, []);
  const bodyGeo = useMemo(() => Object.fromEntries(BODY.map((k) => [k, bakeShade(BODY_GEO[k]())])) as Record<BodyPart, THREE.BufferGeometry>, []);
  const screenGeo = useMemo(() => new THREE.PlaneGeometry(0.45, 0.27), []);
  const zGeo = useMemo(() => new THREE.PlaneGeometry(0.34, 0.34), []);
  // Materials follow the quality level (lit PBR, or baked-shade unlit on Low).
  const mats = useMemo(() => ({ desk: material(q.pbr), body: material(q.pbr), glow: material(q.pbr, true), zzz: new THREE.MeshBasicMaterial({ map: zzzTexture(), transparent: true, depthWrite: false, toneMapped: false }) }), [q.pbr]);
  // Nameplates change only with the number of desks per role (not with every job).
  const perRole = Math.round(desks.length / HELPER_ROLES.length);
  const plates = useMemo(() => { const ps = shownBays(perRole); return { geo: plateGeometry(ps), mat: new THREE.MeshBasicMaterial({ map: plateAtlas(ps), toneMapped: false, side: THREE.DoubleSide }) }; }, [perRole]);
  useEffect(() => () => { for (const g of [...Object.values(deskGeo), ...Object.values(bodyGeo), screenGeo, zGeo]) g.dispose(); }, [deskGeo, bodyGeo, screenGeo, zGeo]);
  useEffect(() => () => { mats.zzz.map?.dispose(); for (const m of Object.values(mats)) m.dispose(); }, [mats]);
  useEffect(() => () => { plates.geo.dispose(); plates.mat.map?.dispose(); plates.mat.dispose(); }, [plates]);

  const deskMeshes = useRef(new Map<DeskPart, THREE.InstancedMesh>());
  const bodyMeshes = useRef(new Map<BodyPart, THREE.InstancedMesh>());
  const screen = useRef<THREE.InstancedMesh>(null), zzz = useRef<THREE.InstancedMesh>(null), plateMesh = useRef<THREE.Mesh>(null);
  const rig = useMemo(() => makeRig(), []);
  /** How awake each desk's specialist is (0 asleep … 1 working), eased per frame. */
  const awake = useRef(new Map<string, number>());

  // Static furniture and colours: written when the desks (or their jobs) change.
  useEffect(() => {
    const o = new THREE.Object3D(), c = new THREE.Color();
    desks.forEach((d, i) => {
      for (const k of Object.keys(DESK) as DeskPart[]) {
        const m = deskMeshes.current.get(k); if (!m) continue;
        const [x, y, z] = DESK[k].off, p = deskLocal(d.bay, x, z);
        o.position.set(p.x, y + 0.12, p.z); o.rotation.set(0, yawOf(d.bay), 0); o.updateMatrix(); m.setMatrixAt(i, o.matrix);
        m.setColorAt(i, c.set(DESK[k].col).multiplyScalar(lift));
      }
      const s = screen.current;
      if (s) {
        const p = deskLocal(d.bay, 0, D.deskZ0 + 0.14);
        o.position.set(p.x, 1.0 + 0.12, p.z); o.rotation.set(0, yawOf(d.bay), 0); o.updateMatrix(); s.setMatrixAt(i, o.matrix);
        // Lit in the role's colour while a real job is on the desk; dark (a faint standby) while the specialist sleeps.
        s.setColorAt(i, d.desk.job ? c.set(ROLE_COLOUR[d.desk.role]) : c.set("#0d1624"));
      }
      for (const k of BODY) {
        const m = bodyMeshes.current.get(k); if (!m) continue;
        const kind = BODY_COL[k];
        c.set(kind === "suit" ? "#a3afbf" : kind === "helmet" ? "#e5e9f0" : kind === "boot" ? "#2b3442" : kind === "role" ? ROLE_COLOUR[d.desk.role] : d.desk.job ? ROLE_COLOUR[d.desk.role] : "#111827");
        if (kind !== "role" && kind !== "visor") c.multiplyScalar(lift);
        m.setColorAt(i, c);
      }
    });
    for (const m of [...deskMeshes.current.values(), ...bodyMeshes.current.values(), screen.current]) {
      if (!m) continue;
      m.count = desks.length; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.computeBoundingSphere();
    }
  }, [desks, lift]);

  const m4 = useMemo(() => new THREE.Matrix4(), []), o3 = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock, camera }, dt) => {
    const t = clock.elapsedTime, far = camera.position.y > 24, k = reduceMotion ? 1 : Math.min(1, dt * 2.5), still = reduceMotion ? 0 : 1;
    if (plateMesh.current) plateMesh.current.visible = !far;
    let zn = 0;
    desks.forEach((d, i) => {
      const want = d.desk.job ? 1 : 0, a0 = awake.current.get(d.desk.key) ?? want, a = a0 + (want - a0) * k;
      awake.current.set(d.desk.key, a);
      // Asleep: slumped on folded arms, slow breathing. Awake: upright, hands on the keyboard, typing.
      const breathe = Math.sin(t * 0.9 + i) * 0.012 * still, type = (s: number) => Math.sin(t * 11 + i * 1.7 + s) * 0.06 * still;
      const mix = (sleep: number, work: number) => sleep + (work - sleep) * a;
      rig.torso.rotation.set(mix(0.85 + breathe, 0.08), 0, 0);
      rig.head.rotation.set(mix(0.6, 0.06), mix(0.25, Math.sin(t * 0.4 + i) * 0.08 * still), 0);
      rig.shL.rotation.set(mix(-1.9, -0.45), 0, mix(0.25, 0.08)); rig.shR.rotation.set(mix(-1.9, -0.45), 0, mix(-0.25, -0.08));
      rig.elL.rotation.set(mix(-0.3, -1.05 + type(0)), 0, 0); rig.elR.rotation.set(mix(-0.3, -1.05 + type(2)), 0, 0);
      const seat = d.seat;
      rig.root.position.set(seat.x, 0.12, seat.z); rig.root.rotation.set(0, yawOf(d.bay) + Math.PI, 0);
      rig.root.updateMatrixWorld(true);
      for (const p of BODY) bodyMeshes.current.get(p)?.setMatrixAt(i, rig.parts[p].matrixWorld);
      // The asleep cue above the head (billboarded; a gentle drift unless motion is reduced).
      if (zzz.current && a < 0.5 && !far) {
        rig.parts.helmet.getWorldPosition(o3.position);
        o3.position.y += 0.32 + (reduceMotion ? 0 : (Math.sin(t * 1.4 + i) * 0.5 + 0.5) * 0.08); o3.position.x += 0.1;
        o3.quaternion.copy(camera.quaternion); o3.scale.setScalar(1); o3.updateMatrix(); m4.copy(o3.matrix);
        zzz.current.setMatrixAt(zn++, m4);
      }
    });
    for (const m of bodyMeshes.current.values()) m.instanceMatrix.needsUpdate = true;
    if (zzz.current) { zzz.current.count = zn; zzz.current.instanceMatrix.needsUpdate = true; }
  });

  return <group userData={{ crew: true }}>
    {(Object.keys(DESK) as DeskPart[]).map((k) => <instancedMesh key={`d-${k}:${cap}`} ref={(m) => { if (m) deskMeshes.current.set(k, m); else deskMeshes.current.delete(k); }}
      args={[deskGeo[k], mats.desk, cap]} castShadow={!!q.shadows} receiveShadow={!!q.shadows} />)}
    {BODY.map((k) => <instancedMesh key={`b-${k}:${cap}`} ref={(m) => { if (m) bodyMeshes.current.set(k, m); else bodyMeshes.current.delete(k); }}
      args={[bodyGeo[k], k === "visor" ? mats.glow : mats.body, cap]} frustumCulled={false} castShadow={!!q.shadows && k !== "visor"} />)}
    <instancedMesh key={`screen:${cap}`} ref={screen} args={[screenGeo, mats.glow, cap]} />
    <instancedMesh key={`zzz:${cap}`} ref={zzz} args={[zGeo, mats.zzz, cap]} frustumCulled={false} renderOrder={2} />
    <mesh ref={plateMesh} geometry={plates.geo} material={plates.mat} />
  </group>;
});
