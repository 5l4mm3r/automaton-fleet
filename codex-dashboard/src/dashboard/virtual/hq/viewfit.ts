/**
 * Camera framing and user navigation for the HQ (pure; unit-tested). Presentation only.
 *
 *  - FIT: the camera distance at which a box (the whole facility, or one room) fits the ACTUAL viewport — any aspect
 *    ratio, the real vertical field of view — looking at the box's centre from the south at a fixed pitch. Computed by
 *    projecting the box's corners, so a tall banner or a wide building is never cropped.
 *  - NAVIGATION: the user's zoom (a multiplier on the fitted distance) and pan (an offset of the look-at point on the
 *    ground), with limits so the camera never gets lost far outside the facility; zoom toward a ground point keeps
 *    that point under the pointer/pinch centre.
 */
import * as THREE from "three";
import { WORLD, type Point } from "../world";

export interface Box { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }
export interface Framing { look: THREE.Vector3; pos: THREE.Vector3; distance: number }
export interface NavView { zoom: number; pan: Point }

/** The whole facility, including the perimeter, facade and the Treasury banner's height. */
export const FACILITY: Box = Object.freeze({ x0: WORLD.minX - 3.5, x1: WORLD.maxX + 3.5, z0: WORLD.minZ - 3.5, z1: WORLD.maxZ + 3.5, y0: 0, y1: 5.8 });
/** Fleet view looks down at ~60°; a room at ~42° (into the cutaway). */
export const FLEET_PITCH = 1.05, ROOM_PITCH = 0.74;
export const ZOOM_MIN = 0.3, ZOOM_MAX = 1.35;

const corners = (b: Box) => [b.x0, b.x1].flatMap((x) => [b.y0, b.y1].flatMap((y) => [b.z0, b.z1].map((z) => new THREE.Vector3(x, y, z))));

/**
 * The framing at which `box` fits a viewport of `aspect` (width / height) with a vertical field of view `fovDeg`,
 * looking at the box's centre from the south at `pitch` (radians below horizontal), leaving `margin` (fraction of
 * the half-viewport) free on every side.
 */
export function fitBox(box: Box, aspect: number, fovDeg: number, pitch: number, margin = 0.06): Framing {
  const look = new THREE.Vector3((box.x0 + box.x1) / 2, (box.y0 + box.y1) * 0.15, (box.z0 + box.z1) / 2);
  const dir = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch)); // from the look-at point toward the camera
  const cam = new THREE.PerspectiveCamera(fovDeg, Math.max(0.2, aspect), 0.1, 2000);
  const pts = corners(box), lim = 1 - margin;
  const fits = (dist: number) => {
    cam.position.copy(look).addScaledVector(dir, dist); cam.lookAt(look); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    return pts.every((p) => { const v = p.clone().project(cam); return v.z < 1 && Math.abs(v.x) <= lim && Math.abs(v.y) <= lim; });
  };
  let lo = 1, hi = 1000;
  while (!fits(hi) && hi < 64000) hi *= 2;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  return { look, pos: look.clone().addScaledVector(dir, hi), distance: hi };
}

/** The room box for a department (its walls, a little margin). */
export const roomBox = (d: { x: number; z: number; w: number; d: number }): Box => ({ x0: d.x - d.w / 2 - 1, x1: d.x + d.w / 2 + 1, z0: d.z - d.d / 2 - 1, z1: d.z + d.d / 2 + 1.5, y0: 0, y1: 4 });

/** Keep the user's view sensible: zoom within limits, the look-at point inside the facility. */
export function clampView(v: NavView, base: Point, box: Box = FACILITY): NavView {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom));
  const x = Math.min(box.x1 - base.x, Math.max(box.x0 - base.x, v.pan.x)), z = Math.min(box.z1 - base.z, Math.max(box.z0 - base.z, v.pan.z));
  return { zoom, pan: { x, z } };
}

/**
 * Zoom by `factor` (<1 = closer) toward the ground point `at`, keeping `at` where it is on screen: the look-at point
 * moves toward `at` by the fraction the distance shrinks.
 */
export function zoomToward(v: NavView, base: Point, factor: number, at: Point | null): NavView {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor)), k = 1 - zoom / v.zoom;
  if (!at) return { zoom, pan: v.pan };
  const lx = base.x + v.pan.x, lz = base.z + v.pan.z;
  return { zoom, pan: { x: v.pan.x + (at.x - lx) * k, z: v.pan.z + (at.z - lz) * k } };
}

/** The camera for a framing with the user's view applied (pan shifts look and camera together; zoom scales distance). */
export function applyView(f: Framing, v: NavView): { look: THREE.Vector3; pos: THREE.Vector3 } {
  const look = f.look.clone().add(new THREE.Vector3(v.pan.x, 0, v.pan.z));
  const dir = f.pos.clone().sub(f.look).normalize();
  return { look, pos: look.clone().addScaledVector(dir, f.distance * v.zoom) };
}

/** World metres per screen pixel at the look-at depth (for panning by drag). */
export const metresPerPixel = (distance: number, fovDeg: number, viewportH: number) => (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportH);
