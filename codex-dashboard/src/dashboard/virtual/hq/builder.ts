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
  | `accent:${string}` | `glow:${string}`;

const tmp = new THREE.Object3D();

export class GeoBuilder {
  private readonly parts = new Map<MatKey, THREE.BufferGeometry[]>();

  private add(key: MatKey, g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
    tmp.position.set(x, y, z);
    tmp.rotation.set(rx, ry, rz);
    tmp.scale.set(1, 1, 1);
    tmp.updateMatrix();
    g.applyMatrix4(tmp.matrix);
    const list = this.parts.get(key) ?? this.parts.set(key, []).get(key)!;
    list.push(g.index ? g.toNonIndexed() : g);
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
  /** A sphere. */
  sphere(key: MatKey, r: number, x: number, y: number, z: number, segments = 16, sy = 1) {
    const g = new THREE.SphereGeometry(r, segments, Math.max(6, segments / 2));
    if (sy !== 1) g.scale(1, sy, 1);
    this.add(key, g, x, y, z);
  }

  /**
   * Merge into one geometry per material key. Keys in `worldUV` get world-space texture coordinates (metres / tile), so
   * floor tiles and wall panels keep their real size on surfaces of any size.
   */
  /** Callers own (and dispose) the returned geometries; building again returns fresh ones. */
  build(worldUV: ReadonlySet<MatKey> = new Set(), tile = 2): Map<MatKey, THREE.BufferGeometry> {
    const out = new Map<MatKey, THREE.BufferGeometry>();
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      if (merged && worldUV.has(key)) {
        const pos = merged.getAttribute("position"), nor = merged.getAttribute("normal"), uv = merged.getAttribute("uv");
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), ny = Math.abs(nor.getY(i)), nx = Math.abs(nor.getX(i));
          if (ny > 0.5) uv.setXY(i, x / tile, z / tile); else if (nx > 0.5) uv.setXY(i, z / tile, y / tile); else uv.setXY(i, x / tile, y / tile);
        }
        uv.needsUpdate = true;
      }
      if (merged) { merged.computeBoundingSphere(); out.set(key, merged); }
    }
    // The parts are kept: every (re)mounted scene — a quality change, a shadow-map fallback — builds its own geometry.
    return out;
  }
}
