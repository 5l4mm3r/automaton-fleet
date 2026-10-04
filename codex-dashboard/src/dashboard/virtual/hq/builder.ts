/**
 * Static-geometry builder for the headquarters: architecture and furniture are added as simple solids (boxes,
 * cylinders, discs) with a material key, then merged into ONE mesh per material — a detailed building for a few dozen
 * draw calls. Geometry never depends on the quality level (quality changes materials, lights and effects only), so Low
 * keeps every wall, desk and screen.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type MatKey =
  | "ground" | "floor" | "floorDark" | "corridor" | "wall" | "wallTrim" | "metal" | "darkMetal" | "desk" | "fabric" | "glass"
  | "screen" | "gold" | "paper" | "rubber" | "concrete"
  // V2.3 material classes: painted structural steel, smoked glass, illuminated acrylic, polished floor inlay, screen
  // glass (bezels over displays), equipment housings, vent grilles and cables.
  | "painted" | "smokedGlass" | "acrylic" | "polished" | "screenGlass" | "equipment" | "grille" | "cable"
  | `accent:${string}` | `glow:${string}`;

const tmp = new THREE.Object3D();
/** Heights (m) a walking person occupies: solids entirely below (floor inlays) or above (door lintels, ceilings) do not block. */
const NAV_BAND = [0.3, 1.9] as const;

/** A merged piece: `chunk|material` (chunks are rooms or the shell, so the renderer can cull what is out of view). */
export const matOf = (key: string): MatKey => key.slice(key.indexOf("|") + 1) as MatKey;

/**
 * Low quality: lighting baked into the geometry once (a vertex colour per face direction — lit tops, darker sides and
 * undersides, from the same key light the other levels use), so Low draws with unlit materials and no per-pixel light.
 */
export function bakeShade(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.getAttribute("normal"), c = new Float32Array(n.count * 3), L = new THREE.Vector3(0.38, 0.8, 0.46).normalize();
  for (let i = 0; i < n.count; i++) {
    const d = n.getX(i) * L.x + n.getY(i) * L.y + n.getZ(i) * L.z, v = 0.5 + 0.5 * Math.max(0, d) + 0.08 * Math.max(0, n.getY(i));
    c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = Math.min(1.05, v);
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return g;
}

export class GeoBuilder {
  private readonly parts = new Map<string, THREE.BufferGeometry[]>();
  /** The chunk new solids belong to (a department id, or "shell"). */
  chunk = "shell";
  /** Floor footprints (axis-aligned bounds) of every solid in the walking band — what people must walk around (nav.ts). */
  readonly footprints: Array<{ x0: number; z0: number; x1: number; z1: number }> = [];

  private add(key: MatKey, g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
    tmp.position.set(x, y, z);
    tmp.rotation.set(rx, ry, rz);
    tmp.scale.set(1, 1, 1);
    tmp.updateMatrix();
    g.applyMatrix4(tmp.matrix);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    if (bb.min.y < NAV_BAND[1] && bb.max.y > NAV_BAND[0]) this.footprints.push({ x0: bb.min.x, z0: bb.min.z, x1: bb.max.x, z1: bb.max.z });
    const k = `${this.chunk}|${key}`;
    const list = this.parts.get(k) ?? this.parts.set(k, []).get(k)!;
    list.push(g); // indexed (every primitive here is), so shared vertices are shaded once
  }

  /** An axis-aligned box centred at (x, y, z), optionally turned about Y. */
  box(key: MatKey, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    this.add(key, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  }
  /** A vertical cylinder (radius top / bottom) whose base sits at y. */
  cyl(key: MatKey, rTop: number, rBottom: number, h: number, x: number, y: number, z: number, segments = 16, rx = 0, rz = 0) {
    this.add(key, new THREE.CylinderGeometry(rTop, rBottom, h, segments), x, y + h / 2, z, rx, 0, rz);
  }
  /** A torus lying flat (axis vertical) at height y. */
  ring(key: MatKey, radius: number, tube: number, x: number, y: number, z: number, segments = 32, rx = Math.PI / 2) {
    this.add(key, new THREE.TorusGeometry(radius, tube, 8, segments), x, y, z, rx);
  }
  /** A flat panel (plane) facing +z, turned by ry. */
  panel(key: MatKey, w: number, h: number, x: number, y: number, z: number, ry = 0, rx = 0) {
    this.add(key, new THREE.PlaneGeometry(w, h), x, y, z, rx, ry);
  }
  /** The upper half of a horizontal open tube along x or z (a conduit cover, a collar), its axis at height y. */
  halfTube(key: MatKey, r: number, len: number, x: number, y: number, z: number, along: "x" | "z", segments = 16) {
    this.add(key, new THREE.CylinderGeometry(r, r, len, segments, 1, true, along === "x" ? 0 : Math.PI / 2, Math.PI), x, y, z, along === "z" ? Math.PI / 2 : 0, 0, along === "x" ? Math.PI / 2 : 0);
  }
  /** A sphere. */
  sphere(key: MatKey, r: number, x: number, y: number, z: number, segments = 16, sy = 1) {
    const g = new THREE.SphereGeometry(r, segments, Math.max(6, segments / 2));
    if (sy !== 1) g.scale(1, sy, 1);
    this.add(key, g, x, y, z);
  }

  /**
   * Merge into one geometry per chunk and material key. Keys in `worldUV` get world-space texture coordinates (metres / tile), so
   * floor tiles and wall panels keep their real size on surfaces of any size.
   */
  /** Callers own (and dispose) the returned geometries; building again returns fresh ones. */
  build(worldUV: ReadonlySet<MatKey> = new Set(), tile = 2, bake = false): Map<string, THREE.BufferGeometry> {
    const out = new Map<string, THREE.BufferGeometry>();
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      if (merged && worldUV.has(matOf(key))) {
        const pos = merged.getAttribute("position"), nor = merged.getAttribute("normal"), uv = merged.getAttribute("uv");
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), ny = Math.abs(nor.getY(i)), nx = Math.abs(nor.getX(i));
          if (ny > 0.5) uv.setXY(i, x / tile, z / tile); else if (nx > 0.5) uv.setXY(i, z / tile, y / tile); else uv.setXY(i, x / tile, y / tile);
        }
        uv.needsUpdate = true;
      }
      if (merged) { if (bake) bakeShade(merged); merged.computeBoundingSphere(); out.set(key, merged); }
    }
    // The parts are kept: every (re)mounted scene — a quality change, a shadow-map fallback — builds its own geometry.
    return out;
  }
}
