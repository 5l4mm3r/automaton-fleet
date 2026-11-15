# Virtual HQ — remaining art treatment (brief for the designer)

Owner direction, 14 October 2026. **The layout and behaviour are done; this is an art pass only.** It must not change the
layout, the data, or any behaviour, and it must not delay the Fleet's operational launch.

## What the owner's reference pictures were for

They showed the **layout and liveliness**, not an art style:

- agents move about even when idle, so the view is never a still image;
- agents walk the corridors between departments in real time, according to what they actually do;
- a side panel lists the agents with their level and current activity; clicking one zooms in on that agent.

All of this is built. **Do not pixelate anything or copy the pictures' art.** The cyberpunk look stays.

## Fixed: do not change

- The floor plan: Fleet Command at the centre, the twelve rooms, the corridors, and ceiling pipes that show only while
  data travels (`command/departments.ts`, `virtual/hq/route.ts`).
- What drives every figure: the live reading only. Placement, sleep, levels, timings and the Hall of Survivors stay as
  they are (`command/departments.ts`, `command/rest.ts`, `command/survival.ts`).
- Levels are display only. Idle wandering is cosmetic and stays inside the agent's room.
- Owner pause (amber ⏸, "PAUSED BY OWNER") and reported hibernation (indigo ☾, "HIBERNATING") must stay clearly
  different. Hibernation "unknown" must never look like hibernating.
- Accessibility (labels, names, Reduce Motion) and the strict CSP: no inline styles and no external assets at runtime.
- Performance at 50 agents on Low.

## Open for the art pass

1. **Whole-fleet view.** It currently reads as a dark schematic. Give it more warmth and contrast within the cyberpunk
   palette, so the rooms read at a glance: floor materials, accent lighting per department, wall caps.
2. **Fleet Command.** Its glowing core is its only figure. Consider a stronger landmark (console ring, overhead
   display) that still leaves the hub's corridors and pipes visible.
3. **Quarters.** The bunks are plain boxes. Add bedding, lockers and soft lamp light. Keep the bunk geometry
   (`world.ts` bed sizes) or update the camera obstacles in `hq/framing.ts` to match.
4. **Agents.** Small polish only: silhouettes readable at fleet zoom, and a clearer lying pose for sleepers.
5. **Room plaques and labels.** Typography only. Agent labels are laid out to avoid the plaques; keep the plaques' size
   roughly the same.

## How to work

- Use the private design repository `5l4mm3r/agent-fleet-design` with the fictional-data preview. You never need, and
  must not be given, access to the VPS, HQ or MCP.
- Preview: run `previews/virtual-central-command/serve.sh` in the project, then open
  `http://127.0.0.1:8799/#Virtual`. It is a simulation build with fictional data only.
- Deliver changes as a branch or patch. The owner reviews a preview before anything is released.
