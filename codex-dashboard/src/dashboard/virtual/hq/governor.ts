/**
 * The rendering governor (High/Ultra/Medium): when frames stay slow it lowers RENDER COST in steps, and restores it
 * when they recover. Step 0: full. The DPR is lowered first (AdaptiveResolution); then 1: floor reflections refresh
 * less often; 2: atmospheric dust is hidden. It never removes authoritative content — every agent, room, screen,
 * project and real event stays; only how expensively they are drawn changes. Shared per page (one scene at a time).
 */
export const GOVERNOR = { level: 0 as 0 | 1 | 2 };
export const governorLabel = (dpr: number) => (GOVERNOR.level === 0 ? `full (DPR ${dpr.toFixed(2)})` : GOVERNOR.level === 1 ? "reflections slowed" : "reflections slowed, dust off");
