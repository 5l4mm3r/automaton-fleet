"use client";
/**
 * Fleet view: the room under the pointer is outlined in its own accent colour at floor level (a thin architectural
 * edge and a faint wash) — a quiet "this is clickable", no flashing.
 */
import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { DEPARTMENT, type DepartmentId } from "../../command/departments";

export const RoomHighlight = memo(function RoomHighlight({ id }: { id: DepartmentId | null }) {
  const accent = id ? DEPARTMENT[id].accent : "#ffffff";
  const mats = useMemo(() => ({
    edge: new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }),
    wash: new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.07, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }),
  }), [accent]);
  useEffect(() => () => { mats.edge.dispose(); mats.wash.dispose(); }, [mats]);
  if (!id) return null;
  const d = DEPARTMENT[id], t = 0.08, y = 0.16;
  return <group renderOrder={2}>
    {([[d.x, d.z - d.d / 2, d.w, t], [d.x, d.z + d.d / 2, d.w, t], [d.x - d.w / 2, d.z, t, d.d], [d.x + d.w / 2, d.z, t, d.d]] as const).map(([x, z, w, dd], i) =>
      <mesh key={i} position={[x, y, z]} material={mats.edge}><boxGeometry args={[w, 0.02, dd]} /></mesh>)}
    <mesh position={[d.x, y - 0.01, d.z]} rotation={[-Math.PI / 2, 0, 0]} material={mats.wash}><planeGeometry args={[d.w, d.d]} /></mesh>
  </group>;
});
