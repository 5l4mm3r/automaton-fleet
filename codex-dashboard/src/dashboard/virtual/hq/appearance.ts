/**
 * Character appearance — the skin-ready description of how an operator looks in the Virtual HQ.
 *
 * The renderer (crowd.tsx) draws a person ONLY from an `Appearance`. A default appearance is derived from the agent's
 * identity seed (the same seed as its portrait), and optional cosmetic packs can override any slot. This is the seam
 * for future higher-quality operator/soldier assets and user-chosen skins: a pack registers new looks for slots, the HQ
 * renderer does not change.
 *
 * Cosmetics are VISUAL IDENTITY ONLY. This module deliberately imports nothing from the economy, permissions,
 * placement, health or FleetController state, and an Appearance carries no such field: a cosmetic can never change
 * intelligence, commercial capability, survival economics, project ability, rank, Treasury treatment or permissions.
 * (Enforced by a unit test over this module's imports and the Appearance keys.) There is no store and no payment here.
 */
import { identityColours, seedOf } from "../../command/portrait";

/** The cosmetic slots a look is made of. */
export const COSMETIC_SLOTS = ["family", "uniform", "armour", "footwear", "headgear", "hair", "facialHair", "face", "accessories", "insignia", "colour"] as const;
export type CosmeticSlot = (typeof COSMETIC_SLOTS)[number];

export type BodyFamily = "operator";
export type Armour = "none" | "vest" | "plateCarrier";
export type Footwear = "boots" | "tacticalBoots";
export type Headgear = "none" | "cap" | "headset";
export type Accessory = "earpiece" | "holoPanel";

export interface ColourTreatment { uniform: string; trousers: string; vest: string; trim: string }

export interface Appearance {
  family: BodyFamily;
  uniform: "fleetUtility";
  armour: Armour;
  footwear: Footwear;
  headgear: Headgear;
  /** Hair style index (the portrait's identity), 0–5. */
  hair: number;
  /** Facial hair index (the portrait's identity), 0–4. */
  facialHair: number;
  /** The face is always the agent's own portrait (identity, not a cosmetic choice). */
  face: "portrait";
  accessories: readonly Accessory[];
  /** Insignia follows the room the agent works in (presentation of real placement, never a rank). */
  insignia: "department";
  colour: ColourTreatment;
}

/** The Fleet utility palette, with small per-person variation (fabric batches, wear), never a meaning. */
const UNIFORMS: ColourTreatment[] = [
  { uniform: "#2a3a52", trousers: "#1b2535", vest: "#141c29", trim: "#22d3ee" },
  { uniform: "#27364b", trousers: "#1a2230", vest: "#171d24", trim: "#22d3ee" },
  { uniform: "#2d394a", trousers: "#1e2531", vest: "#1a1f1c", trim: "#22d3ee" },
  { uniform: "#26344a", trousers: "#182131", vest: "#121821", trim: "#22d3ee" },
];

/** The default look for an agent: derived only from its identity seed. */
export function defaultAppearance(id: string): Appearance {
  const s = seedOf(`${id}#look`), ident = identityColours(id);
  const pick = (shift: number, mod: number) => ((s >>> shift) >>> 0) % mod;
  const armour: Armour = (["vest", "plateCarrier", "vest", "plateCarrier", "none"] as const)[pick(0, 5)];
  const headgear: Headgear = ident.hairStyle === 2 ? (pick(4, 3) === 0 ? "cap" : "none") : (["none", "none", "cap", "headset"] as const)[pick(4, 4)];
  return {
    family: "operator", uniform: "fleetUtility", armour, footwear: pick(8, 2) ? "tacticalBoots" : "boots", headgear,
    hair: ident.hairStyle, facialHair: ident.facialHair, face: "portrait",
    accessories: ident.earpiece !== 0 && headgear !== "headset" ? ["earpiece", "holoPanel"] : ["holoPanel"],
    insignia: "department", colour: UNIFORMS[pick(12, UNIFORMS.length)],
  };
}

/** A cosmetic pack: overrides for some slots (validated; unknown slots are refused). */
export interface CosmeticPack { id: string; name: string; overrides: Partial<Omit<Appearance, "face" | "insignia">> }

const REGISTRY = new Map<string, CosmeticPack>();

/** Register a pack (e.g. a future raw-operator asset set). Only known visual slots may be overridden. */
export function registerCosmetic(pack: CosmeticPack): void {
  for (const k of Object.keys(pack.overrides)) if (!(COSMETIC_SLOTS as readonly string[]).includes(k)) throw new Error(`unknown cosmetic slot: ${k}`);
  REGISTRY.set(pack.id, pack);
}

/** An agent's look: its default, with the selected packs applied in order (visual identity only). */
export function appearanceOf(id: string, packs: readonly string[] = []): Appearance {
  let a = defaultAppearance(id);
  for (const p of packs) { const pack = REGISTRY.get(p); if (pack) a = { ...a, ...pack.overrides }; }
  return a;
}
