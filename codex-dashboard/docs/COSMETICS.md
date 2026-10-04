# Virtual HQ character appearance and cosmetic skins (interface)

Status: interface in place (UI 0.6.0). There is no store, no payment logic and no user-facing skin selection yet.

## Principle

A cosmetic is visual identity only. It can never change:
- an agent's intelligence or commercial capability;
- survival economics, Treasury treatment or rank;
- project ability or permissions.

The appearance module (`src/dashboard/virtual/hq/appearance.ts`) imports nothing but the identity-seed helpers, and an
`Appearance` carries only visual slots. A unit test enforces both.

## Slots

`family`, `uniform`, `armour`, `footwear`, `headgear`, `hair`, `facialHair`, `face`, `accessories`, `insignia`,
`colour`.

| Slot | Default | Overridable |
|---|---|---|
| `face` | The agent's own portrait (128×128, `portrait.ts`), mapped onto the head through the face atlas | No |
| `insignia` | The colour of the room the agent works in (presentation of real placement, never a rank) | No |
| All other slots | Derived from the agent's identity seed (`defaultAppearance`) | Yes |

## Installing a pack

```ts
import { registerCosmetic, appearanceOf } from "./appearance";
registerCosmetic({ id: "raw-operator-01", name: "Raw operator", overrides: { armour: "plateCarrier", headgear: "headset", colour: { uniform: "#2b2f2a", trousers: "#1f221d", vest: "#151713", trim: "#22d3ee" } } });
appearanceOf(agentId, ["raw-operator-01"]);
```

- **Validation:** unknown slots are refused.
- **Renderer:** `crowd.tsx` draws each person only from their `Appearance`. Each slot value maps to instanced part
  geometry plus a colour treatment.
- **Adding a value:** a new slot value (for example a helmet, or a different body family) needs only:
  - its part geometry in `PART_GEOMETRY`;
  - its anchor on the rig;
  - its visibility rule in the per-frame show test.
- **What stays the same:** the HQ, camera, flow and data layers do not change.

## Higher-quality assets later

The rig joints are hip, torso, neck, head, shoulders, elbows, hips and knees, with anchors per part. A skinned glTF
operator could replace the instanced primitive parts behind the same `Appearance` → draw seam:
- Keep the identity face: either project the portrait atlas cell onto the asset's face UVs, or use the portrait as
  the identity reference.
- Keep the poses (`targetPose`) as retargetable joint rotations.
