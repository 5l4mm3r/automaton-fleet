/**
 * Data-transport skins — how a transport LOOKS, separated from what it IS. The transport model (transport.ts) decides
 * which real event travels, when, where and in which phase; a skin only decides its appearance. A future cosmetic
 * (fibre pulse, electrical rail, bioluminescent vein, holographic beam, data capsule, delivery drone…) is a new skin;
 * FleetController event semantics never change. No store or payment logic lives here.
 */
export interface TransportSkin {
  id: string;
  name: string;
  /** The travelling body: radius (m), halo scale, trail length (segments), and whether it rides inside the conduit tube. */
  orb: { radius: number; halo: number; trail: number; inTube: boolean };
  /** Light moving with the orb (High/Ultra) and a glow a little ahead of it. */
  light: { intensity: number; distance: number; ahead: boolean };
  /** The lit route: width of the illumination and how bright the not-yet-reached part is. */
  route: { width: number; preview: number };
  /** Source activation and destination receiver: a column of light and a ring. */
  ends: { column: boolean; ring: boolean };
}

const SKINS = new Map<string, TransportSkin>();
export function registerTransportSkin(s: TransportSkin) { SKINS.set(s.id, s); }
export const transportSkin = (id = "tube-orb"): TransportSkin => SKINS.get(id) ?? SKINS.get("tube-orb")!;

/** Default: a glowing orb inside the HQ's protected glass conduits, light travelling with it, a receiver ring at each end. */
registerTransportSkin({ id: "tube-orb", name: "Conduit orb", orb: { radius: 0.09, halo: 3.2, trail: 7, inTube: true }, light: { intensity: 6, distance: 6, ahead: true }, route: { width: 1, preview: 0.18 }, ends: { column: true, ring: true } });
/** Example alternative (proves the seam): a fast fibre pulse — thin, long trail, no light. */
registerTransportSkin({ id: "fibre-pulse", name: "Fibre pulse", orb: { radius: 0.08, halo: 1.8, trail: 14, inTube: true }, light: { intensity: 0, distance: 0, ahead: false }, route: { width: 1, preview: 0.1 }, ends: { column: false, ring: true } });
