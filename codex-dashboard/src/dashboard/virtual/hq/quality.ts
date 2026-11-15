/**
 * What each Virtual quality level means for the headquarters. Quality changes materials, lighting, shadows and effects —
 * never the building: every room, wall, desk, screen and person exists at every level, so the world degrades gracefully
 * instead of collapsing into coloured planes.
 *
 *   LOW     full world; flat-shaded (Lambert) materials, no shadow maps, simple light rig, static screens.
 *   MEDIUM  physically based materials and procedural surface textures, image-based lighting, directional shadows,
 *           contact shadows (AO).
 *   HIGH    + soft shadows, a light per department, bloom on emissives, animated screens.
 *   ULTRA   + highest shadow resolution, reflective floors, light shafts and haze, extra environmental animation and
 *           finer architectural detail (ceiling gantries, cable runs).
 */
import type { Quality } from "../../command/prefs";

export interface HQProfile {
  pbr: boolean;
  physical: boolean;
  textures: number;           // procedural texture resolution (0 = flat colour)
  shadows: false | "basic" | "soft";
  shadowMap: number;
  contactShadows: boolean;
  roomLights: boolean;
  envLight: boolean;
  bloom: boolean;
  animatedScreens: boolean;
  reflections: boolean;
  atmosphere: boolean;
  detail: 0 | 1 | 2;
  dpr: number;
  particles: number;
  antialias: boolean;
}

export const HQ_PROFILE: Readonly<Record<Quality, HQProfile>> = Object.freeze({
  low: { pbr: false, physical: false, textures: 0, shadows: false, shadowMap: 0, contactShadows: false, roomLights: false, envLight: false, bloom: false, animatedScreens: false, reflections: false, atmosphere: false, detail: 0, dpr: 1, particles: 0, antialias: false },
  medium: { pbr: true, physical: false, textures: 256, shadows: "basic", shadowMap: 1024, contactShadows: true, roomLights: false, envLight: true, bloom: false, animatedScreens: false, reflections: false, atmosphere: false, detail: 1, dpr: 1.25, particles: 60, antialias: true },
  high: { pbr: true, physical: false, textures: 512, shadows: "soft", shadowMap: 2048, contactShadows: true, roomLights: true, envLight: true, bloom: true, animatedScreens: true, reflections: false, atmosphere: false, detail: 1, dpr: 1.5, particles: 160, antialias: true },
  ultra: { pbr: true, physical: true, textures: 1024, shadows: "soft", shadowMap: 4096, contactShadows: true, roomLights: true, envLight: true, bloom: true, animatedScreens: true, reflections: true, atmosphere: true, detail: 2, dpr: 2, particles: 360, antialias: true },
});
